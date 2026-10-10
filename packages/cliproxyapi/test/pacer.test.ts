import { afterEach, expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { SessionHttpResponse, SessionModelRequest } from "@opencode/plugin/effect/session"
import type { Plugin } from "@opencode/plugin/tui"
import { Effect } from "effect"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Session } from "@opencode/schema/session"
import { Agent } from "@opencode/schema/agent"
import { applyCatalogue, parseDetails, withCataloguePrices } from "../src/catalog.js"
import type { ProviderEditor } from "@opencode/plugin/effect/provider"
import { prices } from "../src/pacer/cpa.js"
import { decodeQuota } from "../src/pacer/protocol.js"
import { probeCPA } from "../src/quota/probe.js"
import { pacerRequest, pacerResponse, registerPacer } from "../src/quota/pacer.js"
import { createUsageStore } from "../src/quota/usage-store.js"
import { readUsage } from "../src/quota/usage.js"

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach((fn) => fn()))
const window = {
  scope: "all",
  seconds: 18000,
  left: 61,
  reset_ms: 104000000,
  read_ms: 100000000,
  state: "current",
  applies: true,
}
const reply = {
  v: 1,
  provider: "claude",
  auth: "fixture-account",
  alias: "Fixture",
  at_ms: 100000000,
  windows: [window],
}
const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")

function fixture() {
  const seen: { url: string; auth: string | null; client: string | null }[] = []
  const state = { discovery: true, redirect: false, header: encoded(reply) }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      seen.push({
        url: request.url,
        auth: request.headers.get("Authorization"),
        client: request.headers.get("X-Pacer-Client"),
      })
      if (state.redirect) return Response.redirect("http://127.0.0.1:1/not-allowed")
      if (url.pathname === "/v0/resource/plugins/quota-handoff/events") return Response.json({ protocol: 1 })
      if (!url.search && url.pathname.endsWith("/pacer/events"))
        return Response.json(
          state.discovery
            ? {
                pacer: true,
                client: {
                  version: 1,
                  request_header: "X-Pacer-Client",
                  quota_header: "X-Pacer-Quota",
                  caps: ["quota"],
                  views: ["usage", "prices"],
                },
              }
            : { pacer: true, client: { version: 2 } },
        )
      if (url.searchParams.get("view") === "usage")
        return Response.json({
          view: "usage",
          now: 99999,
          credentials: [
            {
              id: reply.auth,
              alias: reply.alias,
              provider: reply.provider,
              shared_with: [],
              windows: [{ ...window, left: 12, read_ms: 99999000 }],
            },
            {
              id: "other-account",
              alias: "Other",
              provider: "codex",
              shared_with: [],
              windows: [{ ...window, left: 92 }],
            },
          ],
        })
      if (url.searchParams.get("view") === "prices")
        return Response.json({
          view: "prices",
          unit: "usd_per_million_tokens",
          models: {
            sonnet: {
              input: 3,
              output: 15,
              cache_read: 0.3,
              cache_write: 3.75,
              source: "manual",
              context_tiers: [{ above_tokens: 200000, price: { input: 6, output: 22.5 } }],
              fast: { input: 6, output: 30, cache_read: 0.6 },
            },
            invalid: { input: -1, output: 1 },
          },
        })
      return new Response("stream-not-consumed", { headers: { "X-Pacer-Quota": state.header } })
    },
  })
  cleanup.push(() => server.stop(true))
  const config = { routes: { proxy: server.url.origin }, pacer: ["proxy"] }
  const request: SessionModelRequest = {
    sessionID: Session.ID.make("ses_pacer"),
    agent: Agent.ID.make("build"),
    model: { providerID: Provider.ID.make("proxy"), id: Model.ID.make("sonnet") },
    kind: "primary",
    baseURL: `${server.url.origin}/v1`,
    headers: { "X-Quota-Handoff": "existing-handoff" },
  }
  const values = new Map<string, unknown>()
  const io = {
    read: async (key: string) => values.get(key),
    write: async (key: string, value: string) => {
      values.set(key, value)
    },
  }
  return { server, state, seen, config, request, values, io }
}

test("Pacer-first discovery is anonymous; unknown client protocol falls back to legacy", async () => {
  const f = fixture()
  expect(await probeCPA(f.server.url.origin, { fetch })).toEqual({ quota: true, pacer: true })
  expect(f.seen).toHaveLength(1)
  expect(f.seen[0]!.auth).toBeNull()
  f.state.discovery = false
  f.seen.length = 0
  expect(await probeCPA(f.server.url.origin, { fetch })).toEqual({ quota: true, pacer: false })
  expect(f.seen.map((r) => new URL(r.url).pathname)).toEqual([
    "/v0/resource/plugins/pacer/events",
    "/v0/resource/plugins/quota-handoff/events",
  ])
  f.state.redirect = true
  expect(await probeCPA(f.server.url.origin, { fetch })).toEqual({ quota: false, pacer: false })
})

test("registered HTTP hooks feed response quota through the Usage RPC into the sidebar store", async () => {
  const f = fixture()
  const hooks = new Map<string, (event: never) => Effect.Effect<void>>()
  const ctx = {
    session: {
      hook: (name: string, hook: (event: never) => Effect.Effect<void>) => {
        hooks.set(name, hook)
        return Effect.succeed({ dispose: Effect.void })
      },
    },
    storage: {
      get: (key: string) => Effect.promise(() => f.io.read(key)),
      set: (key: string, value: string) => Effect.promise(() => f.io.write(key, value)),
    },
  } as unknown as Context
  await Effect.runPromise(registerPacer(ctx, () => f.config).pipe(Effect.scoped))
  await Effect.runPromise(hooks.get("model.request")!(f.request as never))
  expect(f.request.headers).toEqual({ "X-Quota-Handoff": "existing-handoff", "X-Pacer-Client": "v=1; caps=quota" })
  const request = new Request(`${f.server.url.origin}/v1/messages`, { headers: f.request.headers })
  const response = await fetch(request)
  await Effect.runPromise(hooks.get("http.response")!({ ...f.request, request, response } as never))
  expect(response.bodyUsed).toBe(false)
  expect(f.seen[0]!.client).toBe("v=1; caps=quota")
  const input = { sessionID: "ses_pacer", providerID: "proxy", modelID: "sonnet", all: false }
  const read = () => readUsage(f.config, { ...f.io, fetch, key: async () => "fixture-key" }, input)
  const result = await read()
  expect(result.snapshot?.current).toBe(reply.auth)
  // Newer response quota wins over an older usage-view reading of the same account.
  expect(result.snapshot?.credentials[0]!.windows[0]!.remaining).toBe(61)
  expect(result.snapshot?.credentials).toHaveLength(1)
  const usageRequest = f.seen.find((r) => new URL(r.url).searchParams.get("view") === "usage")!
  expect(usageRequest.auth).toBe("Bearer fixture-key")
  expect(Object.fromEntries(new URL(usageRequest.url).searchParams)).toEqual({
    view: "usage",
    auth: "api-key",
    all: "true",
    v: "1",
  })
  const store = createUsageStore(
    {
      client: { rpc: () => ({ read }) },
      ui: {
        model: { current: () => ({ providerID: "proxy", modelID: "sonnet" }) },
        router: { current: () => ({ type: "session", sessionID: "ses_pacer" }) },
      },
    } as unknown as Plugin.Context,
    { interval: 10000 },
  )
  cleanup.push(store.dispose)
  const unmount = store.view()
  cleanup.push(unmount)
  await Bun.sleep(30)
  expect(store.reading()?.snapshot?.current).toBe(reply.auth)
  expect(store.reading()?.snapshot?.credentials[0]!.windows[0]!.remaining).toBe(61)
})

test("origin, malformed header, old response and redirect controls leave usage state unchanged", async () => {
  const f = fixture()
  for (const baseURL of [undefined, "https://elsewhere.example/v1", "not a url"]) {
    const event = { ...f.request, headers: { ...f.request.headers }, baseURL }
    pacerRequest(f.config, event)
    expect(event.headers).toEqual(f.request.headers)
  }
  const responseEvent = (header: string, url = `${f.server.url.origin}/v1/messages`): SessionHttpResponse => ({
    ...f.request,
    request: new Request(url),
    response: new Response("body", { headers: { "X-Pacer-Quota": header } }),
  })
  await pacerResponse(f.config, responseEvent(encoded(reply)), f.io)
  const before = JSON.stringify([...f.values])
  for (const header of [
    "not base64!!",
    encoded({ ...reply, v: 2 }),
    encoded({ ...reply, at_ms: 1 }),
    "x".repeat(16385),
  ]) {
    await pacerResponse(f.config, responseEvent(header), f.io)
    expect(JSON.stringify([...f.values])).toBe(before)
  }
  await pacerResponse(
    f.config,
    responseEvent(encoded({ ...reply, at_ms: reply.at_ms + 1 }), "https://elsewhere.example/v1/messages"),
    f.io,
  )
  expect(JSON.stringify([...f.values])).toBe(before)
  expect(decodeQuota(encoded({ ...reply, windows: [{ ...window, left: 101 }] }))?.windows).toEqual([])
  f.state.redirect = true
  expect(
    (
      await readUsage(
        f.config,
        { ...f.io, fetch, key: async () => "fixture-key" },
        {
          providerID: "proxy",
          modelID: "sonnet",
          all: true,
        },
      )
    ).status,
  ).toBe("unavailable")
  expect(JSON.stringify([...f.values])).toBe(before)
  const seen = f.seen.length
  expect(
    (
      await readUsage(
        { routes: {}, pacer: ["proxy"] },
        { ...f.io, fetch },
        {
          providerID: "proxy",
          modelID: "sonnet",
          all: true,
        },
      )
    ).status,
  ).toBe("disabled")
  expect(f.seen).toHaveLength(seen)
})

test("authenticated Pacer prices reach real catalogue models with V2 tiers and Fast costs", async () => {
  const f = fixture()
  const pricing = await prices(fetch, { baseURL: `${f.server.url.origin}/v1`, key: "fixture-price-key" })
  expect(pricing.invalid).toBeUndefined()
  expect(f.seen[0]!.auth).toBe("Bearer fixture-price-key")
  const catalogue = parseDetails({
    schema: "cliproxyapi.model-details/1",
    hash: "models-hash",
    data: [{ id: "sonnet", service_tiers: ["priority"] }, { id: "unpriced" }],
  })!
  const enriched = withCataloguePrices(catalogue, pricing)
  expect(enriched.hash).not.toBe(catalogue.hash)
  expect(withCataloguePrices(catalogue, { ...pricing, sonnet: { ...pricing.sonnet!, input: 4 } }).hash).not.toBe(
    enriched.hash,
  )
  const models = new Map<string, Model.Info>()
  const editor = {
    update: () => {},
    models: {
      update: (providerID: string, id: string, fn: (model: Model.Info) => void) => {
        const model = Model.Info.default(Provider.ID.make(providerID), Model.ID.make(id))
        fn(model)
        models.set(id, model)
      },
    },
  } as unknown as ProviderEditor
  applyCatalogue(editor, "proxy", enriched, undefined)
  expect(models.get("sonnet")!.cost as unknown).toEqual([
    { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
    { input: 6, output: 22.5, cache: { read: 0, write: 0 }, tier: { type: "context", size: 200000 } },
  ])
  expect(models.get("sonnet-fast")!.cost as unknown).toEqual([{ input: 6, output: 30, cache: { read: 0.6, write: 0 } }])
  expect(models.get("unpriced")!.cost).toEqual([])
})
