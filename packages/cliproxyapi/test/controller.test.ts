import { afterEach, expect, test } from "bun:test"
import type { SessionCompactionDecision } from "@opencode/plugin/compaction-decision"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Session } from "@opencode/schema/session"
import { QuotaController, UNANSWERED, UNENROLLED_BACKOFF, type QuotaIO } from "../src/quota/controller.js"
import type { Snapshot, Stored } from "../src/quota/protocol.js"
import { portableMessages } from "../src/quota/portable.js"

const servers: ReturnType<typeof Bun.serve>[] = []
afterEach(() => {
  servers.splice(0).forEach((server) => server.stop(true))
})
function fixture(compactionModel?: string, compactionFallback?: string) {
  const state = {
    known: false,
    status: 200,
    reads: 0,
    /** Requests that stall for a second before answering, as during a server freeze. */
    stalls: 0,
    routes: [] as string[],
    snapshot: {
      protocol: 1,
      primary_used: true,
      consumed: "",
      cursor: 0,
      generation: 1,
      alias: "Small",
      intent: "",
      available: true,
      windows: [],
      events: [],
    } as Snapshot,
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      state.reads++
      state.routes.push(new URL(request.url).searchParams.get("model") ?? "")
      if (state.stalls > 0) {
        state.stalls--
        await Bun.sleep(1000)
      }
      if (!request.headers.has("Authorization")) return Response.json({ protocol: 1, mode: state.snapshot.mode })
      if (!state.known) return new Response(null, { status: 401 })
      return Response.json(state.snapshot, { status: state.status })
    },
  })
  servers.push(server)
  const store = new Map<string, Stored>()
  const notices = new Map<string, { session: string; text: string }>()
  // The plugin's current quota routes; a test may change them while the controller runs.
  const live: { routes: Record<string, string> } = { routes: { proxy: server.url.href, other: server.url.href } }
  const controller = new QuotaController(
    () => ({
      routes: live.routes,
      ...(compactionModel ? { compactionModel } : {}),
      ...(compactionFallback ? { compactionFallback } : {}),
    }),
    "installation",
    {
      read: async (key) => store.get(key),
      write: async (key, value) => {
        store.set(key, value)
      },
      notify: async (session, id, text) => {
        notices.set(id, { session, text })
      },
      fetch,
      now: Date.now,
    },
  )
  const event = (auto = true): SessionCompactionDecision => ({
    sessionID: Session.ID.make("ses_test"),
    agent: Agent.ID.make("build"),
    model: Model.Ref.make({ id: Model.ID.make("model"), providerID: Provider.ID.make("proxy") }),
    reason: "auto",
    auto,
    due: false,
    boundary: { fresh: false, portable: true },
  })
  return { state, controller, event, server, store, notices, live }
}
test("shadow enrollment and reminders never request compaction or a checkpoint", async () => {
  const f = fixture()
  f.state.snapshot = { ...f.state.snapshot, mode: "shadow", primary_used: false, available: false }
  const opaque = { ...f.event(), boundary: { fresh: false, portable: false } }
  await f.controller.decide(opaque)
  expect(opaque.compact).toBeUndefined()
  expect(opaque.refusal).toBeUndefined()
  f.state.known = true
  f.state.snapshot = {
    ...f.state.snapshot,
    cursor: 1,
    events: [
      { cursor: 1, id: "manual-reminder", kind: "reminder", text: "Compact or start a new chat now", generation: 1 },
    ],
  }
  await f.controller.decide(opaque)
  expect(opaque.compact).toBeUndefined()
  expect(opaque.refusal).toBeUndefined()
  expect(f.notices.size).toBe(1)
  expect([...f.notices.values()][0]?.text).toContain("new chat now")
})
test("shared budget waits retry through Core without compacting or changing a binding", async () => {
  const f = fixture()
  f.state.known = true
  await f.controller.decide(f.event())
  const refusal = () => Response.json({ error: { code: "quota_budget_wait" } }, { status: 409 })
  for (let i = 0; i < 2; i++) {
    await f.controller.response("ses_test", "proxy", "model", refusal())
    expect(await f.controller.retry("ses_test", "proxy", "model")).toBe(500)
  }
  const event = f.event()
  await f.controller.decide(event)
  expect(event.compact).toBeUndefined()
  expect(event.refusal).toBeUndefined()
  expect(f.notices.size).toBe(1)
  expect([...f.store.values()][0]?.generation).toBe(1)
  // A later real handoff still follows the persisted-checkpoint path.
  f.state.snapshot = { ...f.state.snapshot, intent: "drain-after-settlement" }
  await f.controller.decide(event)
  expect(event.compact).toBe(true)
})
test("threshold requires compaction only when enabled, with committed checkpoint completion", async () => {
  const f = fixture()
  await f.controller.decide(f.event())
  f.state.known = true
  f.state.snapshot = { ...f.state.snapshot, intent: "intent-1" }
  const before = f.event()
  await f.controller.decide(before)
  expect(before.compact).toBe(true)
  expect(before.portable).toBe(true)
  const finished = { ...f.event(), boundary: { fresh: false, portable: true, checkpoint: "committed" } }
  await f.controller.decide(finished)
  expect(finished.compact).toBeUndefined()
  const off = f.event(false)
  await f.controller.decide(off)
  expect(off.compact).toBeUndefined()
  const headers = await f.controller.headers("ses_test", "proxy", "model", "primary", f.server.url.href)
  const claim = JSON.parse(Buffer.from(headers["X-Quota-Handoff"], "base64url").toString())
  expect(claim).toMatchObject({ auto: false, intent: "intent-1", generation: 1 })
  expect(JSON.stringify(headers)).not.toContain([...f.store.values()][0]!.capability)
})
test("a consumed checkpoint cannot authorize another handoff", async () => {
  const f = fixture()
  f.state.known = true
  f.state.snapshot = { ...f.state.snapshot, intent: "intent-2", consumed: "old" }
  const event = { ...f.event(), boundary: { fresh: false, portable: true, checkpoint: "old" } }
  await f.controller.decide(event)
  expect(event.compact).toBe(true)
})
test("no capacity and auto-off opaque checkpoints refuse generation", async () => {
  const f = fixture()
  f.state.known = true
  f.state.snapshot = { ...f.state.snapshot, intent: "intent", available: false }
  const event = f.event()
  await f.controller.decide(event)
  expect(event.refusal?.type).toBe("quota.no-capacity")
  expect(f.notices.size).toBe(1)
  f.state.snapshot = { ...f.state.snapshot, available: true }
  const opaque = { ...f.event(false), boundary: { fresh: false, portable: false } }
  await f.controller.decide(opaque)
  expect(opaque.refusal?.type).toBe("quota.context-unavailable")
})
test("notice replay deduplicates and polling does not wake an unrelated chat", async () => {
  const f = fixture()
  f.state.known = true
  f.state.snapshot = {
    ...f.state.snapshot,
    cursor: 1,
    events: [{ cursor: 1, id: "notice", kind: "warning", text: "20% remaining", generation: 1 }],
  }
  await f.controller.decide(f.event())
  await f.controller.decide(f.event())
  expect(f.notices.size).toBe(1)
  expect([...f.notices.values()][0]?.session).toBe("ses_test")
  expect(await f.controller.status("unrelated")).toEqual([])
})
test("a pre-admission race gets one retry per persisted intent", async () => {
  const f = fixture()
  f.state.known = true
  f.state.snapshot = { ...f.state.snapshot, intent: "race" }
  await f.controller.decide(f.event())
  const error = () =>
    Response.json(
      {
        error: {
          code: "internal_server_error",
          message: "quota_checkpoint_required: A portable checkpoint is required",
        },
      },
      { status: 500 },
    )
  await f.controller.response("ses_test", "proxy", "model", error())
  expect(await f.controller.retry("ses_test", "proxy", "model")).toBe(true)
  await f.controller.response("ses_test", "proxy", "model", error())
  expect(await f.controller.retry("ses_test", "proxy", "model")).toBe(false)
  expect([...f.store.values()][0]?.retryIntent).toBe("1/race")
})
test("missing binding acknowledgement and unavailable polling fail closed", async () => {
  const f = fixture()
  f.state.known = true
  await f.controller.decide(f.event())
  await expect(f.controller.response("ses_test", "proxy", "model", new Response("ok"))).rejects.toThrow("acknowledge")
  f.state.status = 503
  const event = f.event()
  await f.controller.decide(event)
  expect(event.refusal?.type).toBe("quota.unavailable")
  await expect(f.controller.headers("ses_test", "proxy", "model", "primary", "https://other.invalid")).rejects.toThrow(
    "endpoint",
  )
})
test("portable context retains readable history and tool pairs without account proof", () => {
  const result = portableMessages([
    {
      role: "assistant",
      providerMetadata: { test: { secret: "old-account" } },
      content: [
        { type: "reasoning", text: "Reason", providerMetadata: { test: { encrypted: "old" } } },
        { type: "text", text: "Answer" },
      ],
    },
  ])
  expect(result[0]?.content).toEqual([
    { type: "text", text: "Reason" },
    { type: "text", text: "Answer", providerMetadata: undefined },
  ])
  expect(JSON.stringify(result)).not.toContain("old-account")
})

test("no capacity is not retried and unrelated native retries retain their decision", async () => {
  const f = fixture()
  f.state.known = true
  await f.controller.decide(f.event())
  await f.controller.response(
    "ses_test",
    "proxy",
    "model",
    Response.json(
      { error: { message: "quota_no_capacity: All windows held", code: "internal_server_error" } },
      { status: 500 },
    ),
  )
  expect(await f.controller.retry("ses_test", "proxy", "model")).toBe(false)
  await f.controller.response(
    "ses_test",
    "proxy",
    "model",
    Response.json({ error: { message: "Transient provider failure", code: "internal_server_error" } }, { status: 500 }),
  )
  expect(await f.controller.retry("ses_test", "proxy", "model")).toBeUndefined()
})
test("healthy native checkpoints stay bound; auto-off handoff keeps replay portable", async () => {
  const f = fixture()
  f.state.known = true
  const native = { ...f.event(), boundary: { fresh: false, portable: false } }
  await f.controller.decide(native)
  expect(native.compact).toBeUndefined()
  expect(await f.controller.requiresPortable("ses_test", "proxy", "model", "context")).toBe(false)
  f.state.snapshot = { ...f.state.snapshot, intent: "handoff" }
  await f.controller.decide(f.event(false))
  expect(await f.controller.requiresPortable("ses_test", "proxy", "model", "context")).toBe(true)
  f.state.snapshot = { ...f.state.snapshot, intent: "", generation: 2 }
  await f.controller.decide(f.event(false))
  expect(await f.controller.requiresPortable("ses_test", "proxy", "model", "context")).toBe(true)
})

test("provider aliases sharing one model have distinct routes and capabilities", async () => {
  const f = fixture()
  const primary = await f.controller.headers("ses_test", "proxy", "model", "title", f.server.url.href)
  const alias = await f.controller.headers("ses_test", "other", "model", "title", f.server.url.href)
  const decode = (header: string) => JSON.parse(Buffer.from(header, "base64url").toString())
  expect(decode(primary["X-Quota-Handoff"]).route).toBe("proxy/model")
  expect(decode(alias["X-Quota-Handoff"]).route).toBe("other/model")
  expect(decode(primary["X-Quota-Handoff"]).capability).not.toBe(decode(alias["X-Quota-Handoff"]).capability)
  expect(f.state.routes).toContain("proxy/model")
  expect(f.state.routes).toContain("other/model")
})

test("auxiliary enrollment still requires portable first primary context", async () => {
  const f = fixture()
  f.state.known = true
  f.state.snapshot = { ...f.state.snapshot, primary_used: false }
  const opaque = { ...f.event(), boundary: { fresh: false, portable: false } }
  await f.controller.decide(opaque)
  expect(opaque.compact).toBe(true)
  expect(opaque.portable).toBe(true)
  const off = { ...f.event(false), boundary: { fresh: false, portable: false } }
  await f.controller.decide(off)
  expect(off.refusal?.type).toBe("quota.context-unavailable")
  expect(off.compact).toBeUndefined()
})

test("an unenrolled chat recovers from a transient bridge failure and backs off background polls", async () => {
  const f = fixture()
  f.state.snapshot = { ...f.state.snapshot, mode: "shadow" }
  let clock = 1_000_000
  const controller = new QuotaController(() => ({ routes: { proxy: f.server.url.href } }), "installation", {
    read: async (key) => f.store.get(key),
    write: async (key, value) => {
      f.store.set(key, value)
    },
    notify: async () => {},
    fetch: Object.assign(async (request: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
      // A plugin reload or proxy restart: the bridge is briefly unreachable.
      if (down) return new Response(null, { status: 502 })
      return fetch(request, options)
    }, fetch),
    now: () => clock,
  })
  let down = false
  const first = f.event()
  await controller.decide(first)
  expect(first.refusal).toBeUndefined()
  await controller.activity("ses_test", true)
  down = true
  clock += UNENROLLED_BACKOFF
  await controller.tick()
  expect((await controller.status("ses_test"))[0]?.kind).toBe("paused")
  down = false
  // Before the fix the unenrolled (401) path never cleared the refusal: the chat stayed paused.
  const next = f.event()
  await controller.decide(next)
  expect(next.refusal).toBeUndefined()
  expect(await controller.status("ses_test")).toEqual([])
  await expect(controller.headers("ses_test", "proxy", "model", "primary", f.server.url.href)).resolves.toBeDefined()
  // While CPA has no binding, background ticks do not poll every second.
  const reads = f.state.reads
  await controller.tick()
  await controller.tick()
  expect(f.state.reads).toBe(reads)
  clock += UNENROLLED_BACKOFF
  await controller.tick()
  expect(f.state.reads).toBeGreaterThan(reads)
  // Once bound, every tick polls again.
  f.state.known = true
  await controller.response("ses_test", "proxy", "model", ackResponse())
  const bound = f.state.reads
  await controller.tick()
  expect(f.state.reads).toBeGreaterThan(bound)
})

function ackResponse(generation = 1, alias = "Small") {
  const binding = Buffer.from(JSON.stringify({ protocol: 1, generation, alias })).toString("base64url")
  return new Response("ok", { headers: { "X-Quota-Protocol": "1", "X-Quota-Binding": binding } })
}

const claimOf = (headers: Record<string, string>) =>
  JSON.parse(Buffer.from(headers["X-Quota-Handoff"]!, "base64url").toString()) as Record<string, unknown>
// CPA's after-auth refusal when it would move a chat to another account (direct interceptor body).
const switchRefusal = () =>
  Response.json(
    {
      error: {
        code: "quota_compact_required",
        message: "Small is used up; this chat compacts before it continues on Large.",
        type: "quota_handoff",
      },
    },
    { status: 409, headers: { "X-Quota-Protocol": "1" } },
  )

test("an account-switch refusal compacts once with the configured model, then the step continues", async () => {
  const f = fixture("proxy/cheap-model#high")
  f.state.known = true
  f.state.snapshot = { ...f.state.snapshot, mode: "shadow" }
  const before = f.event()
  await f.controller.decide(before)
  expect(before.compact).toBeUndefined()
  const sent = claimOf(await f.controller.headers("ses_test", "proxy", "model", "primary", f.server.url.href))
  expect(sent).toMatchObject({ compact_on_switch: true, checkpoint: "" })
  await f.controller.response("ses_test", "proxy", "model", switchRefusal(), "primary")
  expect(await f.controller.retry("ses_test", "proxy", "model")).toBe(true)
  expect(await f.controller.status("ses_test")).toEqual([
    {
      sessionID: "ses_test",
      kind: "switching",
      text: "Small is used up; this chat compacts before it continues on Large. Compacting with proxy/cheap-model#high first.",
    },
  ])
  expect(await f.controller.warming("ses_test")).toBe(false)
  // Core's decision before the rebuilt request asks for a portable summary by the configured model.
  const retried = f.event()
  await f.controller.decide(retried)
  expect(retried).toMatchObject({ compact: true, portable: true, metadata: { "quota.switch": true } })
  expect(retried.compactionModel).toEqual(Model.Ref.parse("proxy/cheap-model#high"))
  // The completed checkpoint needs no second compaction and is what CPA receives next.
  const compacted = { ...f.event(), boundary: { fresh: false, portable: true, checkpoint: "cmp_new" } }
  await f.controller.decide(compacted)
  expect(compacted.compact).toBeUndefined()
  expect(compacted.compactionModel).toBeUndefined()
  const next = claimOf(await f.controller.headers("ses_test", "proxy", "model", "primary", f.server.url.href))
  expect(next).toMatchObject({ checkpoint: "cmp_new", compact_on_switch: true })
  // An auxiliary answer does not complete the switch; the admitted primary request does.
  await f.controller.response("ses_test", "proxy", "model", ackResponse(1, "Small"), "title")
  expect([...f.store.values()][0]?.switching).toBe("")
  await f.controller.response("ses_test", "proxy", "model", ackResponse(2, "Large"), "primary")
  expect([...f.store.values()][0]?.switching).toBeUndefined()
  expect(await f.controller.status("ses_test")).toEqual([
    {
      sessionID: "ses_test",
      kind: "switched",
      text: "Continuing on Large after compacting.",
    },
  ])
  expect(await f.controller.warming("ses_test")).toBe(true)
  // Nothing entered the model's context; the next run clears the notice.
  expect(f.notices.size).toBe(0)
  await f.controller.activity("ses_test", true)
  expect(await f.controller.status("ses_test")).toEqual([])
  const later = f.event()
  await f.controller.decide(later)
  expect(later.compact).toBeUndefined()
})

test("a switch refused again after its compaction surfaces instead of compacting in a loop", async () => {
  const f = fixture("proxy/cheap-model")
  f.state.known = true
  f.state.snapshot = { ...f.state.snapshot, mode: "shadow" }
  await f.controller.decide(f.event())
  await f.controller.response("ses_test", "proxy", "model", switchRefusal())
  expect(await f.controller.retry("ses_test", "proxy", "model")).toBe(true)
  await f.controller.decide(f.event())
  await f.controller.decide({ ...f.event(), boundary: { fresh: false, portable: true, checkpoint: "cmp_new" } })
  await f.controller.response("ses_test", "proxy", "model", switchRefusal())
  expect(await f.controller.retry("ses_test", "proxy", "model")).toBe(false)
  expect([...f.store.values()][0]?.switching).toBeUndefined()
  // Repeated refusals without a new checkpoint (a compaction that never ran) are bounded too.
  const g = fixture("proxy/cheap-model")
  g.state.known = true
  await g.controller.decide(g.event())
  const results = []
  for (let i = 0; i < 5; i++) {
    await g.controller.response("ses_test", "proxy", "model", switchRefusal())
    results.push(await g.controller.retry("ses_test", "proxy", "model"))
  }
  expect(results).toEqual([true, true, true, false, true])
})

test("a pending switch survives a restart and still compacts before the next request", async () => {
  const f = fixture("proxy/cheap-model")
  f.state.known = true
  f.state.snapshot = { ...f.state.snapshot, mode: "shadow" }
  await f.controller.decide(f.event())
  await f.controller.response("ses_test", "proxy", "model", switchRefusal())
  expect(await f.controller.retry("ses_test", "proxy", "model")).toBe(true)
  const restarted = new QuotaController(
    () => ({ routes: { proxy: f.server.url.href }, compactionModel: "proxy/cheap-model" }),
    "installation",
    {
      read: async (key) => f.store.get(key),
      write: async (key, value) => {
        f.store.set(key, value)
      },
      notify: async () => {},
      fetch,
      now: Date.now,
    },
  )
  const event = f.event()
  await restarted.decide(event)
  expect(event).toMatchObject({ compact: true, portable: true })
  expect(event.compactionModel).toEqual(Model.Ref.parse("proxy/cheap-model"))
})

test("without a usable compactionModel the agent's own compaction model writes the summary", async () => {
  for (const configured of [undefined, "not-a-model-reference"]) {
    const f = fixture(configured)
    f.state.known = true
    await f.controller.decide(f.event())
    await f.controller.response("ses_test", "proxy", "model", switchRefusal())
    expect(await f.controller.retry("ses_test", "proxy", "model")).toBe(true)
    const event = f.event()
    await f.controller.decide(event)
    expect(event).toMatchObject({ compact: true, portable: true })
    expect(event.compactionModel).toBeUndefined()
    const [notice] = await f.controller.status("ses_test")
    expect(notice?.text).toContain("Compacting with the agent's compaction model first.")
    if (configured) expect(notice?.text).toContain('compactionModel "not-a-model-reference" is not provider/model')
  }
})

test("the account-switch decision carries the fallback model; a malformed one is reported and skipped", async () => {
  const f = fixture("proxy/cheap-model", "proxy/wide-model")
  f.state.known = true
  await f.controller.decide(f.event())
  await f.controller.response("ses_test", "proxy", "model", switchRefusal())
  expect(await f.controller.retry("ses_test", "proxy", "model")).toBe(true)
  const event = f.event()
  await f.controller.decide(event)
  expect(event.compactionModel).toEqual(Model.Ref.parse("proxy/cheap-model"))
  expect(event.compactionFallback).toEqual(Model.Ref.parse("proxy/wide-model"))
  expect((await f.controller.status("ses_test"))[0]?.text).toEndWith(
    "Compacting with proxy/cheap-model (fallback proxy/wide-model) first.",
  )
  // Outside a pending switch no model is chosen: ordinary compactions keep the agent's settings.
  const g = fixture("proxy/cheap-model", "not a model")
  g.state.known = true
  const ordinary = g.event()
  await g.controller.decide(ordinary)
  expect(ordinary.compactionModel).toBeUndefined()
  expect(ordinary.compactionFallback).toBeUndefined()
  await g.controller.response("ses_test", "proxy", "model", switchRefusal())
  expect(await g.controller.retry("ses_test", "proxy", "model")).toBe(true)
  const malformed = g.event()
  await g.controller.decide(malformed)
  expect(malformed.compactionModel).toEqual(Model.Ref.parse("proxy/cheap-model"))
  expect(malformed.compactionFallback).toBeUndefined()
  expect((await g.controller.status("ses_test"))[0]?.text).toContain(
    'compactionFallback "not a model" is not provider/model; Compacting with proxy/cheap-model first.',
  )
})

test("the compaction start notice names the models the final decision armed, not CPA's list", async () => {
  const f = fixture("proxy/cpa-model")
  f.state.known = true
  f.state.snapshot = { ...f.state.snapshot, mode: "shadow" }
  await f.controller.decide(f.event())
  await f.controller.response("ses_test", "proxy", "model", switchRefusal())
  expect(await f.controller.retry("ses_test", "proxy", "model")).toBe(true)
  // The retry notice still names CPA's configured model.
  expect((await f.controller.status("ses_test"))[0]?.text).toContain("Compacting with proxy/cpa-model first.")
  // CPA's decide arms its own models and marks the switch; the same event object is what Plus's
  // decide sees afterwards and mutates (Plus runs in the `post` plugin list, CPA in `pre`).
  const switched = f.event()
  await f.controller.decide(switched)
  expect(switched.metadata).toMatchObject({ "quota.switch": true })
  // Plus replaces CPA's models with the chat model's cold list (empty fallbacks dropped).
  switched.compactionModel = Model.Ref.parse("proxy/plus-one#high")
  switched.compactionFallbacks = [Model.Ref.parse("proxy/plus-two")]
  delete switched.compactionFallback
  await f.controller.compacting("ses_test", "proxy", "model")
  expect((await f.controller.status("ses_test"))[0]?.text).toBe(
    "Small is used up; this chat compacts before it continues on Large. Compacting with proxy/plus-one#high (fallback proxy/plus-two) first.",
  )
})

test("with an empty chat-model list the start notice keeps CPA's own models", async () => {
  const f = fixture("proxy/cpa-model", "proxy/cpa-fallback")
  f.state.known = true
  f.state.snapshot = { ...f.state.snapshot, mode: "shadow" }
  await f.controller.decide(f.event())
  await f.controller.response("ses_test", "proxy", "model", switchRefusal())
  expect(await f.controller.retry("ses_test", "proxy", "model")).toBe(true)
  const switched = f.event()
  await f.controller.decide(switched)
  // Plus had no list: it left CPA's models in place. The notice names them.
  await f.controller.compacting("ses_test", "proxy", "model")
  expect((await f.controller.status("ses_test"))[0]?.text).toContain(
    "Compacting with proxy/cpa-model (fallback proxy/cpa-fallback) first.",
  )
})

test("quota follows the current routes: a provider that loses its route is neither polled nor shown", async () => {
  const f = fixture()
  f.state.known = true
  await f.controller.decide(f.event())
  await f.controller.activity("ses_test", true)
  f.state.status = 503
  await f.controller.tick()
  expect(f.controller.enabled("proxy")).toBe(true)
  expect((await f.controller.status("ses_test")).map((notice) => notice.kind)).toEqual(["paused"])

  // CPA's quota-handoff went away: the probe dropped the route.
  const routes = f.live.routes
  f.live.routes = { other: routes.other! }
  const reads = f.state.reads
  await f.controller.tick()
  expect(f.controller.enabled("proxy")).toBe(false)
  expect(f.state.reads).toBe(reads)
  expect(await f.controller.status("ses_test")).toEqual([])

  // It came back: the same chat is coordinated again without a restart.
  f.live.routes = routes
  f.state.status = 200
  await f.controller.tick()
  expect(f.controller.enabled("proxy")).toBe(true)
  expect(f.state.reads).toBeGreaterThan(reads)
})

/** A controller on the fixture's endpoint and store, with its own clock, fetch or poll timeout. */
function controllerFor(f: ReturnType<typeof fixture>, io: Partial<QuotaIO>) {
  return new QuotaController(() => ({ routes: f.live.routes }), "installation", {
    read: async (key) => f.store.get(key),
    write: async (key, value) => {
      f.store.set(key, value)
    },
    notify: async (session, id, text) => {
      f.notices.set(id, { session, text })
    },
    fetch,
    now: Date.now,
    ...io,
  })
}

test("a poll that stalls past its timeout once pauses the chat only until the next ping asks again", async () => {
  const f = fixture()
  f.state.known = true
  const controller = controllerFor(f, { pollTimeout: 100 })
  await controller.decide(f.event())
  // The server freezes while a background poll is in flight; CPA answers only after the timeout.
  f.state.stalls = 1
  await controller.tick()
  expect(await controller.status("ses_test")).toEqual([{ sessionID: "ses_test", kind: "paused", text: UNANSWERED }])
  // The refusal does not end the warming window: the ping itself asks again.
  expect(await controller.warming("ses_test")).toBe(true)
  // Still frozen at the ping: it polls again and is refused from that poll, before reaching the provider.
  f.state.stalls = 1
  const before = f.state.reads
  await expect(controller.headers("ses_test", "proxy", "model", "generate", f.server.url.href)).rejects.toThrow(
    UNANSWERED,
  )
  expect(f.state.reads).toBe(before + 1)
  // The next ping polls again, CPA answers, and the ping goes through with a normal claim.
  const claim = claimOf(await controller.headers("ses_test", "proxy", "model", "generate", f.server.url.href))
  expect(f.state.reads).toBe(before + 2)
  expect(claim).toMatchObject({ kind: "generate", generation: 1, route: "proxy/model" })
  expect(await controller.status("ses_test")).toEqual([])
})

test("a quota service down for two minutes pauses the chat, which resumes on its own while idle", async () => {
  const f = fixture()
  f.state.known = true
  // A port nothing listens on: every poll during the outage is a real refused connection.
  const gone = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) })
  const unreachable = gone.url.href
  gone.stop(true)
  let clock = 1_000_000
  let down = false
  const polls: { at: number; down: boolean }[] = []
  const controller = controllerFor(f, {
    now: () => clock,
    fetch: Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      polls.push({ at: clock, down })
      return fetch(down ? unreachable : input, init)
    }, fetch),
  })
  await controller.decide(f.event())
  await controller.activity("ses_test", true)
  clock += 10_000
  const start = clock
  polls.splice(0)
  down = true
  // A running turn: the background poll fails, then the next request asks again and is refused.
  await controller.tick()
  expect(await controller.status("ses_test")).toEqual([{ sessionID: "ses_test", kind: "paused", text: UNANSWERED }])
  await expect(controller.headers("ses_test", "proxy", "model", "primary", f.server.url.href)).rejects.toThrow(
    UNANSWERED,
  )
  // The turn ended with that error; nobody sends another message.
  await controller.activity("ses_test", false)
  while (clock < start + 180_000) {
    clock += 1000
    if (clock >= start + 120_000) down = false
    await controller.tick()
  }
  // Two failed polls at the start (5 s, then 10 s), then 20 s, 40 s and the 60 s cap; the first poll after
  // the service came back at 120 s succeeds, and the idle chat is not polled after that.
  expect(polls.map((poll) => ({ at: (poll.at - start) / 1000, down: poll.down }))).toEqual([
    { at: 0, down: true },
    { at: 0, down: true },
    { at: 10, down: true },
    { at: 30, down: true },
    { at: 70, down: true },
    { at: 130, down: false },
  ])
  expect(await controller.status("ses_test")).toEqual([])
  const event = f.event()
  await controller.decide(event)
  expect(event.refusal).toBeUndefined()
  await expect(controller.headers("ses_test", "proxy", "model", "primary", f.server.url.href)).resolves.toBeDefined()
})
