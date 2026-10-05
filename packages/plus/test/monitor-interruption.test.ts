// #24 actual-boundary regressions: a request row's status and end timing must
// come from observed host facts, never from a schema default.
//
// A physical LLM attempt that completed and was then followed by an interrupted
// tool/orchestration keeps its honest known end; an attempt whose terminal
// event never reached this Location stays honestly open instead of inheriting
// the ledger's fabricated `completed` default. The hooks, collector and ledger
// under test are the real ones; only the host event stream is scripted.
import { afterEach, expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Session } from "@opencode/schema/session"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { Effect, Stream } from "effect"
import { monitorQuery, watchMonitor } from "../src/monitor/plugin.js"
import { queryMonitor } from "../src/monitor/query.js"
import { cleanupLedgers, collect, ledger, usage } from "./monitor-fixture.js"
import { context } from "./harness.js"

afterEach(cleanupLedgers)

const modelRef = (p: string, m: string) =>
  Model.Ref.make({ providerID: Provider.ID.make(p), id: Model.ID.make(m) })

type HookCallbackMap = {
  [K in keyof SessionHooks]?: Array<(event: SessionHooks[K]) => Effect.Effect<void, never, never>>
}

function makeHookRegistry() {
  const hooks: HookCallbackMap = {}
  const hookFn = <K extends keyof SessionHooks>(
    name: K,
    cb: (event: SessionHooks[K]) => Effect.Effect<void, never, never>,
  ) => {
    const list = (hooks[name] ?? []) as Array<(event: SessionHooks[K]) => Effect.Effect<void, never, never>>
    list.push(cb)
    hooks[name] = list as never
    return Effect.sync(() => ({ dispose: Effect.sync(() => void 0) }))
  }
  return { hooks, hookFn }
}

// The real hooks a live Location runs, sharing one ledger handle. `session.get`
// answers only for the sessions view fallback and never invents an outcome.
function monitoring(db: Awaited<ReturnType<typeof ledger>>, getSession: Context["session"]["get"] = () => Effect.succeed({ id: Session.ID.make("ses_24") } as never)) {
  const { hooks, hookFn } = makeHookRegistry()
  const ctx = context({
    event: { subscribe: () => Stream.empty as never },
    session: { hook: hookFn as never, get: getSession },
  })
  return { hooks, ctx, db }
}

// Runs `body` with the real watchMonitor installed over a fresh ledger.
async function withMonitor(body: (env: { db: Awaited<ReturnType<typeof ledger>>; hooks: HookCallbackMap; ctx: Context }) => Promise<void>) {
  const db = await ledger()
  const { hooks, ctx } = monitoring(db)
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* watchMonitor(ctx, () => undefined, () => db)
        yield* Effect.promise(() => body({ db, hooks, ctx }))
      }),
    ),
  )
}

const httpRequest = (requestID: string, started: number) =>
  new Request("https://example.test/v1/messages", { method: "POST", body: `{"input":"${requestID}"}` })

const common = {
  sessionID: Session.ID.make("ses_24"),
  agent: Agent.ID.make("build"),
  model: modelRef("cliproxyapi", "claude-opus-5-5"),
}

const fireRequest = async (hooks: HookCallbackMap, requestID: string, started: number, kind: SessionHooks["http.request"]["kind"] = "primary") => {
  const request = httpRequest(requestID, started)
  for (const cb of hooks["http.request"] ?? []) {
    await Effect.runPromise(cb({ ...common, kind, requestID, started, request }))
  }
  return request
}

// The real host outage that leaves an open wire row: the attempt's terminal
// event was never delivered to this Location, so the collector sees only the
// interrupted execution boundary.
test("#24: an interrupted attempt with no observed terminal step event stays honestly open, never fabricated completed", async () => {
  await withMonitor(async ({ db, hooks, ctx }) => {
    const id = "fd3b78ac-7641-4faf-ba96-9a73b626a436"
    await fireRequest(hooks, id, 4_000)
    const collector = collect(db, { now: 5_000 })
    // The runner dispatched the step, then the user interrupted the
    // orchestration; this Location never observes step.ended or step.failed.
    collector.observe({ type: "session.step.started", created: 4_000, data: { sessionID: String(common.sessionID), assistantMessageID: "msg_24", started: 4_000 } })
    collector.observe({ type: "session.execution.interrupted", created: 4_500, data: { sessionID: String(common.sessionID), reason: "user" } })

    const row = db.getRequest(id)
    expect(row?.ended).toBeUndefined()
    // The open row must not claim a terminal outcome. Before the fix it read
    // `completed` from the column default while ended stayed NULL.
    expect(row?.status).toBe("running")
    expect(row?.error).toBeUndefined()
    expect(row?.duration).toBeUndefined()
    expect(row?.finish).toBeUndefined()

    // The page shows the honest unknown, not an invented duration.
    const report = queryMonitor(db, { scope: "session", sessionID: String(common.sessionID), view: "cache" }, { now: 5_000 })
    const request = report.requests?.find((entry) => entry.id === id)
    expect(request?.durationMs).toBeUndefined()
    expect(request?.finish).toBeUndefined()

    // The session-level state fallback also reads the open request honestly.
    const sessions = await monitorQuery(ctx, { scope: "session", sessionID: String(common.sessionID), view: "sessions" }, db)
    const state = sessions.sessions?.find((s) => s.sessionID === String(common.sessionID))?.state
    expect(state === undefined || state === "running").toBe(true)
  })
})

// A physical LLM attempt that completed before the step was interrupted keeps
// its real end; the later interruption boundary changes nothing.
test("#24: a completed physical attempt keeps its known end when tool/orchestration is interrupted afterwards", async () => {
  await withMonitor(async ({ db, hooks }) => {
    const id = "req_completed_then_interrupted"
    await fireRequest(hooks, id, 4_000)
    const collector = collect(db, { now: 5_000 })
    collector.observe({ type: "session.step.started", created: 4_000, data: { sessionID: String(common.sessionID), assistantMessageID: "msg_done", started: 4_000 } })
    collector.observe({ type: "session.step.ended", created: 4_100, data: { sessionID: String(common.sessionID), assistantMessageID: "msg_done", finish: "tool-calls", tokens: usage(3_200, 120, 2_800) } })
    const settled = db.getRequest(id)
    expect(settled?.status).toBe("completed")
    expect(settled?.ended).toBe(4_100)
    expect(settled?.duration).toBe(100)
    expect(settled?.finish).toBe("tool-calls")
    expect(settled?.inputTokens).toBe(3_200)

    // The interrupted execution boundary must not reopen or rewrite it.
    collector.observe({ type: "session.execution.interrupted", created: 4_500, data: { sessionID: String(common.sessionID), reason: "user" } })
    expect(db.getRequest(id)).toEqual(settled)
    const report = queryMonitor(db, { scope: "session", sessionID: String(common.sessionID), view: "cache" }, { now: 5_000 })
    const request = report.requests?.find((entry) => entry.id === id)
    expect(request?.durationMs).toBe(100)
    expect(request?.finish).toBe("tool-calls")
  })
})

// A pre-output interruption is the host's own terminal failure; the collector
// must render it as an error with its end, never as a completed attempt.
test("#24: a host-published pre-output interruption ends the request as an error, not a completed claim", async () => {
  await withMonitor(async ({ db, hooks }) => {
    const id = "req_pre_output"
    await fireRequest(hooks, id, 4_000)
    const collector = collect(db, { now: 5_000 })
    collector.observe({ type: "session.step.started", created: 4_000, data: { sessionID: String(common.sessionID), assistantMessageID: "msg_pre", started: 4_000 } })
    collector.observe({
      type: "session.step.failed",
      created: 4_050,
      data: { sessionID: String(common.sessionID), assistantMessageID: "msg_pre", error: { type: "aborted", message: "Step interrupted" } },
    })
    const row = db.getRequest(id)
    expect(row?.status).toBe("error")
    expect(row?.ended).toBe(4_050)
    expect(row?.error).toBeDefined()
    expect(JSON.parse(row!.error!)).toMatchObject({ type: "aborted" })
  })
})

// One interrupted request must never blanket-close another request that is
// still genuinely in flight: a warming ping in the same session and an
// unrelated chat's request both stay open when one step settles.
test("#24: an interruption leaves a simultaneous unrelated request untouched", async () => {
  await withMonitor(async ({ db, hooks }) => {
    await fireRequest(hooks, "req_first", 4_000)
    await fireRequest(hooks, "req_ping", 4_050, "generate")
    // A request for another Location's session, resolved through its own wire
    // identity only.
    const other = { ...common, sessionID: Session.ID.make("ses_other") }
    const otherRequest = httpRequest("req_other", 4_060)
    for (const cb of hooks["http.request"] ?? []) {
      await Effect.runPromise(cb({ ...other, kind: "primary", requestID: "req_other", started: 4_060, request: otherRequest }))
    }
    const collector = collect(db, { now: 5_000 })
    collector.observe({ type: "session.step.started", created: 4_000, data: { sessionID: String(common.sessionID), assistantMessageID: "msg_first", started: 4_000 } })
    collector.observe({ type: "session.step.ended", created: 4_100, data: { sessionID: String(common.sessionID), assistantMessageID: "msg_first", finish: "stop", tokens: usage(100, 10) } })
    collector.observe({ type: "session.execution.interrupted", created: 4_200, data: { sessionID: String(common.sessionID), reason: "user" } })

    expect(db.getRequest("req_first")?.status).toBe("completed")
    expect(db.getRequest("req_first")?.ended).toBe(4_100)
    // The ping was never a step candidate and the other chat is out of scope.
    expect(db.getRequest("req_ping")?.status).toBe("running")
    expect(db.getRequest("req_ping")?.ended).toBeUndefined()
    expect(db.getRequest("req_other")?.status).toBe("running")
    expect(db.getRequest("req_other")?.ended).toBeUndefined()
  })
})

// Replaying the same host facts across two Plus instances on one Location is
// inert: the open row keeps one honest status, and a later terminal settles it.
test("#24: replay across two monitors is idempotent and cannot fabricate a terminal", async () => {
  const db = await ledger()
  const { hooks, ctx } = monitoring(db)
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* watchMonitor(ctx, () => undefined, () => db)
        yield* watchMonitor(ctx, () => undefined, () => db)
        const id = "req_replay"
        for (let replay = 0; replay < 3; replay++) {
          for (const cb of hooks["http.request"] ?? []) yield* cb({ ...common, kind: "primary", requestID: id, started: 4_000, request: httpRequest(id, 4_000) })
        }
        expect(db.getRequests(String(common.sessionID))).toHaveLength(1)
        expect(db.getRequest(id)?.status).toBe("running")
        expect(db.getRequest(id)?.ended).toBeUndefined()

        const collector = collect(db, { now: 5_000 })
        for (let replay = 0; replay < 2; replay++) {
          collector.observe({ type: "session.step.started", created: 4_000, data: { sessionID: String(common.sessionID), assistantMessageID: "msg_replay", started: 4_000 } })
          collector.observe({ type: "session.step.ended", created: 4_100, data: { sessionID: String(common.sessionID), assistantMessageID: "msg_replay", finish: "stop", tokens: usage(100, 10) } })
        }
        expect(db.getRequests(String(common.sessionID))).toHaveLength(1)
        expect(db.getRequest(id)?.status).toBe("completed")
        expect(db.getRequest(id)?.ended).toBe(4_100)
      }),
    ),
  )
})

// A failed provider response keeps its error status; the interruption fix must
// not turn a real provider failure into an open or completed row.
test("#24: a failed provider response remains errored", async () => {
  await withMonitor(async ({ db, hooks }) => {
    const id = "req_provider_failed"
    const request = await fireRequest(hooks, id, 4_000)
    for (const cb of hooks["http.response"] ?? []) {
      await Effect.runPromise(cb({ ...common, kind: "primary", request, response: new Response("", { status: 400 }) }))
    }
    const row = db.getRequest(id)
    expect(row?.status).toBe("error")
    expect(row?.error).toBeDefined()
    expect(JSON.parse(row!.error!)).toMatchObject({ type: "HttpError", status: 400 })
  })
})

// The auxiliary generate/ping path is unchanged: its own outcome settles it and
// the warming relabel only changes the kind, never the honest terminal status.
test("#24: completed generate and ping rows are unaffected", async () => {
  await withMonitor(async ({ db, hooks }) => {
    const id = "req_generate"
    await fireRequest(hooks, id, 4_000, "generate")
    for (const cb of hooks.generated ?? []) {
      await Effect.runPromise(cb({ ...common, kind: "generate", started: 4_000, ended: 4_200, usage: usage(80, 12, 500), cost: 0.001 }))
    }
    expect(db.getRequest(id)).toMatchObject({ kind: "generate", status: "completed", ended: 4_200, cacheReadTokens: 500 })
    for (const cb of hooks.warming ?? []) {
      await Effect.runPromise(cb({ ...common, phase: "warmed", now: 4_300, since: 4_000, settings: undefined }))
    }
    expect(db.getRequest(id)).toMatchObject({ kind: "ping", status: "completed", ended: 4_200 })
  })
})
