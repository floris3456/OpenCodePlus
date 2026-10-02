import { afterEach, expect, test } from "bun:test"
import { readUsage, type UsageInput, type UsageSnapshot } from "../../src/quota/usage.js"
import type { Stored } from "../../src/quota/protocol.js"

const servers: ReturnType<typeof Bun.serve>[] = []
afterEach(() => servers.splice(0).forEach((server) => server.stop(true)))

function usageSnapshot(): UsageSnapshot {
  return {
    protocol: 1,
    view: "usage",
    now: 100000,
    max_age_seconds: 90,
    all: false,
    provider: "claude",
    model: "claude-sonnet",
    current: "dummy-b",
    active: ["dummy-b"],
    last_used: 99999,
    credentials: [
      {
        id: "dummy-b",
        alias: "Claude B",
        provider: "claude",
        shared_with: ["dummy-b-copy"],
        windows: [
          { scope: "all", seconds: 18000, remaining: 61, reset: 103600, observed: 99999, held: false },
          { scope: "all", seconds: 604800, remaining: 12.5, reset: 200000, observed: 99000, held: false },
        ],
      },
    ],
  }
}

function fixture() {
  const state = {
    status: 200,
    snapshot: usageSnapshot() as unknown,
    requests: [] as { url: string; method: string; authorization: string | null }[],
    redirect: "",
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      state.requests.push({
        url: request.url,
        method: request.method,
        authorization: request.headers.get("Authorization"),
      })
      if (state.redirect) return Response.redirect(state.redirect)
      return Response.json(state.snapshot, { status: state.status })
    },
  })
  servers.push(server)
  const config = { routes: { proxy: server.url.href } }
  const input: UsageInput = { sessionID: "ses_usage", providerID: "proxy", modelID: "claude-sonnet", all: false }
  const value: Stored = {
    capability: "dummy-capability-".repeat(4),
    cursor: 8,
    generation: 2,
    retryIntent: "",
    replay: false,
  }
  const store = new Map<string, unknown>([["quota/ses_usage/proxy/claude-sonnet", value]])
  const read = (next = input) => readUsage(config, { fetch, read: async (key) => store.get(key) }, next)
  return { state, server, input, config, store, read, value }
}

test("usage reads the selected chat/model capability over HTTP without enrollment or writes", async () => {
  const f = fixture()
  const before = JSON.stringify([...f.store])
  const result = await f.read()
  expect(result).toEqual({ status: "ready", snapshot: usageSnapshot() })
  const request = f.state.requests[0]!
  const url = new URL(request.url)
  expect(request.method).toBe("GET")
  expect(url.pathname).toBe("/v0/resource/plugins/quota-handoff/events")
  expect(Object.fromEntries(url.searchParams)).toEqual({ view: "usage", model: "proxy/claude-sonnet", all: "false" })
  expect(request.authorization).toBe(`Bearer ${f.value.capability}`)
  expect(JSON.stringify(result)).not.toContain(f.value.capability)
  expect(JSON.stringify([...f.store])).toBe(before)
  f.state.snapshot = { ...usageSnapshot(), all: true }
  expect((await f.read({ ...f.input, all: true })).snapshot?.all).toBe(true)
  expect(new URL(f.state.requests[1]!.url).searchParams.get("all")).toBe("true")
})

test("unconfigured providers and new chats make no request and never create a binding", async () => {
  const f = fixture()
  expect((await readUsage(undefined, { fetch, read: async () => undefined }, f.input)).status).toBe("disabled")
  expect((await f.read({ ...f.input, providerID: "other" })).status).toBe("disabled")
  expect((await f.read({ ...f.input, sessionID: undefined })).status).toBe("unenrolled")
  expect((await f.read({ ...f.input, sessionID: "ses_other" })).status).toBe("unenrolled")
  expect((await f.read({ ...f.input, modelID: "claude-opus" })).status).toBe("unenrolled")
  expect(f.state.requests).toHaveLength(0)
  expect(f.store.size).toBe(1)
})

test("authorization, old plugins, malformed state and HTTP failures have explicit results", async () => {
  const f = fixture()
  f.state.status = 401
  expect((await f.read()).status).toBe("unenrolled")
  f.state.status = 503
  expect((await f.read()).status).toBe("unavailable")
  f.state.status = 200
  f.state.snapshot = { protocol: 1, mode: "shadow" }
  expect(await f.read()).toMatchObject({ status: "unsupported", message: expect.stringContaining("0.1.2") })
  f.state.snapshot = usageSnapshot()
  expect((await f.read({ ...f.input, all: true })).status).toBe("unsupported")
  f.store.set("quota/ses_usage/proxy/claude-sonnet", { capability: 1 })
  const count = f.state.requests.length
  expect((await f.read()).status).toBe("unavailable")
  expect(f.state.requests).toHaveLength(count)
})

test("usage refuses redirects instead of forwarding the session capability", async () => {
  const f = fixture()
  const trap = fixture()
  f.state.redirect = trap.server.url.href
  expect((await f.read()).status).toBe("unavailable")
  expect(trap.state.requests).toHaveLength(0)
})
