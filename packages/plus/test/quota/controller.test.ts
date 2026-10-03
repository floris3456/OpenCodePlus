import { afterEach, expect, test } from "bun:test"
import type { SessionCompactionDecision } from "@opencode/plugin/compaction-decision"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Session } from "@opencode/schema/session"
import { QuotaController, UNENROLLED_BACKOFF } from "../../src/quota/controller.js"
import type { Snapshot, Stored } from "../../src/quota/protocol.js"
import { portableMessages } from "../../src/quota/portable.js"

const servers: ReturnType<typeof Bun.serve>[] = []
afterEach(() => {
  servers.splice(0).forEach((server) => server.stop(true))
})
function fixture(compactionModel?: string) {
  const state = {
    known: false,
    status: 200,
    reads: 0,
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
    fetch(request) {
      state.reads++
      state.routes.push(new URL(request.url).searchParams.get("model") ?? "")
      if (!request.headers.has("Authorization")) return Response.json({ protocol: 1, mode: state.snapshot.mode })
      if (!state.known) return new Response(null, { status: 401 })
      return Response.json(state.snapshot, { status: state.status })
    },
  })
  servers.push(server)
  const store = new Map<string, Stored>()
  const notices = new Map<string, { session: string; text: string }>()
  const controller = new QuotaController(
    { routes: { proxy: server.url.href, other: server.url.href }, ...(compactionModel ? { compactionModel } : {}) },
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
  return { state, controller, event, server, store, notices }
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
  const controller = new QuotaController({ routes: { proxy: f.server.url.href } }, "installation", {
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
      text: "Continuing on Large after compacting with proxy/cheap-model#high.",
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
    { routes: { proxy: f.server.url.href }, compactionModel: "proxy/cheap-model" },
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
