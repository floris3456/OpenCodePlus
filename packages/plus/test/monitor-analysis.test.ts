// #8/#13 boundary regressions at the real Monitor boundaries: ledger aggregation,
// windowed/as-of signals, real session state, and the reusable marked cache
// prefix of the Anthropic warming-ping wire shape. No mocks of the code under
// test; every case is driven through analyzeSession/requestReport/monitorQuery or
// the real watchMonitor hooks.
import { afterEach, expect, test } from "bun:test"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Session } from "@opencode/schema/session"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { Effect, Stream } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { FINGERPRINT_POLICY_VERSION, FINGERPRINT_VERSION, fingerprintWireBody } from "../src/monitor/fingerprint.js"
import { analyzeSession, windowedSessionSignals } from "../src/monitor/cache.js"
import { createLedger, defaultLedgerPath, ledgerAt, type Ledger } from "../src/monitor/ledger.js"
import { monitorQuery, watchMonitor } from "../src/monitor/plugin.js"
import { queryMonitor } from "../src/monitor/query.js"
import { cleanupLedgers, ledger } from "./monitor-fixture.js"
import { context } from "./harness.js"

const priorData = process.env.XDG_DATA_HOME
const priorConfig = process.env.XDG_CONFIG_HOME
const roots: string[] = []
const opened: string[] = []

afterEach(async () => {
  cleanupLedgers()
  opened.splice(0).forEach((file) => ledgerAt(file).close())
  if (priorData === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = priorData
  if (priorConfig === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = priorConfig
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

const modelRef = (p: string, m: string, variant?: string) =>
  Model.Ref.make({
    providerID: Provider.ID.make(p),
    id: Model.ID.make(m),
    ...(variant === undefined ? {} : { variant: Model.VariantID.make(variant) }),
  })

interface RequestOptions {
  readonly session: string
  readonly id: string
  readonly at: number
  readonly provider?: string
  readonly model?: string
  readonly variant?: string
  readonly agent?: string
  readonly kind?: string
  readonly wire?: object
  readonly protocol?: "openai-chat" | "openai-responses" | "anthropic-messages"
  readonly read?: number
  readonly write?: number
  readonly input?: number
  readonly output?: number
  readonly reasoning?: number
  readonly cost?: number
  readonly status?: "completed" | "error"
  readonly error?: string
  readonly messageID?: string
}

function step(db: Ledger, options: RequestOptions): void {
  db.session({ id: options.session, agent: options.agent ?? "build", directory: "/project" }, options.at)
  db.requestStarted({
    id: options.id,
    sessionID: options.session,
    messageID: options.messageID ?? options.id,
    started: options.at,
    kind: options.kind ?? "step",
    isTitle: options.kind === "title",
    provider: options.provider ?? "openai",
    model: options.model ?? "gpt-4o",
    ...(options.variant === undefined ? {} : { variant: options.variant }),
    agent: options.agent ?? "build",
  })
  if (options.wire !== undefined)
    db.requestFingerprint({
      requestID: options.id,
      sessionID: options.session,
      created: options.at,
      ...fingerprintWireBody(options.wire, { protocol: options.protocol ?? "openai-chat" }),
    })
  db.requestEnded(options.id, {
    ended: options.at + 1,
    status: options.status ?? "completed",
    ...(options.error === undefined ? {} : { error: options.error }),
    usage: {
      input: options.input ?? 3000,
      output: options.output ?? 100,
      reasoning: options.reasoning ?? 10,
      cacheRead: options.read ?? 0,
      cacheWrite: options.write ?? 1000,
      cost: options.cost ?? 0,
    },
  })
}

const openaiBody = (options: { system?: string; append?: { assistant: string; user: string } } = {}) => ({
  model: "gpt-4o",
  messages: [
    { role: "system", content: "base".repeat(1600) },
    { role: "system", content: options.system ?? "rules" },
    { role: "user", content: "Hello" },
    ...(options.append === undefined
      ? []
      : [
          { role: "assistant", content: options.append.assistant },
          { role: "user", content: options.append.user },
        ]),
  ],
  tools: [
    { type: "function", function: { name: "shell", description: "run a shell", parameters: { type: "object" } } },
  ],
})

// The real #13 wire shape: long unchanged system + user history with an
// assistant cache marker, then the ping's private final user prompt. The next
// primary keeps that marked prefix and replaces the uncached tail.
const anthropicHistory = [
  { role: "user", content: [{ type: "text", text: "u0" }] },
  { role: "assistant", content: [{ type: "text", text: "a1" }] },
  { role: "user", content: [{ type: "text", text: "u2" }] },
  { role: "assistant", content: [{ type: "text", text: "a3", cache_control: { type: "ephemeral" } }] },
]
const anthropicBody = (tail: string, system = "sys".repeat(4000), markerTtl?: string) => ({
  model: "claude-3-7-sonnet",
  system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
  messages: [
    ...anthropicHistory.slice(0, 3),
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "a3",
          cache_control: { type: "ephemeral", ...(markerTtl === undefined ? {} : { ttl: markerTtl }) },
        },
      ],
    },
    { role: "user", content: [{ type: "text", text: tail }] },
  ],
  max_tokens: 1000,
})

const WINDOW = { since: 0, until: 1_000_000 }

test("#8: adding pricing cannot convert legacy accounting into a supported miss", async () => {
  const db = await ledger()
  step(db, { session: "priced", id: "priced-a", at: 1000, wire: openaiBody(), read: 4000, write: 0 })
  step(db, { session: "priced", id: "priced-b", at: 2000, wire: openaiBody({ system: "changed" }), read: 0, write: 0 })
  const unknown = queryMonitor(db, { scope: "session", sessionID: "priced", view: "cache" }, { now: 3000 })
  const unknownRequest = unknown.requests?.find((r) => r.id === "priced-b")
  expect(unknownRequest).toMatchObject({ verdict: "none", cause: "prefix-changed", confidence: "unknown", missTokens: 0, measurement: { state: "legacy-unknown" } })
  expect(unknownRequest?.expected).toBeUndefined()
  expect(unknown.totals.misses).toBe(0)
  expect(unknown.totals.missTokens).toBe(0)

  db.contextFact({
    sessionID: "priced",
    at: 1500,
    kind: "pricing",
    detail: { provider: "openai", model: "gpt-4o", rates: [{ input: 2, output: 5, cache: { read: 0.1, write: 3 } }] },
  })
  const known = queryMonitor(db, { scope: "session", sessionID: "priced", view: "cache" }, { now: 3000 })
  const knownRequest = known.requests?.find((r) => r.id === "priced-b")
  expect(knownRequest).toEqual(unknownRequest)
  expect(known.totals.missCost).toBe(0)
  expect(known.totals.cost).toBe(unknown.totals.cost)
})

test("#8: legacy v1 steps and recorded requests both surface in agents and sessions without double counting", async () => {
  const db = await ledger()
  db.session({ id: "legacy", agent: "old-agent", directory: "/project" }, 1000)
  db.stepStarted({
    sessionID: "legacy",
    messageID: "v1",
    kind: "step",
    idx: 0,
    epoch: 0,
    agent: "old-agent",
    provider: "openai",
    model: "gpt-4o",
    started: 1000,
  })
  db.stepEnded("legacy", "v1", 1100, "stop", {
    input: 100,
    output: 20,
    reasoning: 5,
    cacheRead: 900,
    cacheWrite: 0,
    cost: 0.5,
  })
  // The same session also records a v2 request for a different message: only
  // the request row counts for that step.
  step(db, { session: "legacy", id: "new", at: 2000, reasoning: 7, read: 50, write: 0, cost: 0.01 })

  const overview = queryMonitor(db, { scope: "session", sessionID: "legacy", view: "overview" }, { now: 3000 })
  const legacyAgent = overview.agents?.find((a) => a.agent === "old-agent")
  expect(legacyAgent).toMatchObject({ steps: 1, tokens: 100 + 900 + 20 + 5, cost: 0.5 })
  // Reasoning is part of the agent's token total too.
  const buildAgent = overview.agents?.find((a) => a.agent === "build")
  expect(buildAgent?.tokens).toBe(3000 + 50 + 0 + 100 + 7)

  const sessions = queryMonitor(db, { scope: "session", sessionID: "legacy", view: "sessions" }, { now: 3000 })
  const row = sessions.sessions?.find((s) => s.sessionID === "legacy")
  expect(row).toMatchObject({
    requests: 1,
    steps: 2,
    input: 100 + 3000,
    cacheRead: 900 + 50,
    output: 20 + 100,
    reasoning: 5 + 7,
    cost: 0.51,
  })
})

test("#8: real session state comes from the host active set and the last execution outcome", async () => {
  const db = await ledger()
  for (const [id, at] of [
    ["ses_run", 1000],
    ["ses_done", 2000],
    ["ses_fail", 3000],
    ["ses_int", 4000],
    ["ses_idle", 5000],
  ] as const) {
    step(db, { session: id, id: `${id}-a`, at })
  }
  // ses_run has an open request: the ledger's own fallback must still call it running.
  db.requestStarted({ id: "ses_run-open", sessionID: "ses_run", messageID: "open", kind: "step", started: 9000 })
  // ses_busy has both an open request and a completed outcome: running must win.
  step(db, { session: "ses_busy", id: "ses_busy-a", at: 6000 })
  db.requestStarted({ id: "ses_busy-open", sessionID: "ses_busy", messageID: "open", kind: "step", started: 9500 })

  const ctx = context({
    session: {
      get: (input: { sessionID: string }) =>
        Effect.succeed({
          id: input.sessionID,
          ...(String(input.sessionID) === "ses_done"
            ? { outcome: "succeeded" }
            : String(input.sessionID) === "ses_fail"
              ? { outcome: "failed" }
              : String(input.sessionID) === "ses_int"
                ? { outcome: "interrupted" }
                : String(input.sessionID) === "ses_busy"
                  ? { outcome: "succeeded" }
                  : {}),
        } as never),
    },
  })
  // A host that exposes the live active set: the future capability is optional.
  ;(ctx.session as { active?: unknown }).active = () => Effect.succeed({ ses_run: { type: "running" } })

  const report = await monitorQuery(ctx, { scope: "all", view: "sessions" }, db)
  const state = (id: string) => report.sessions?.find((s) => s.sessionID === id)?.state
  expect(state("ses_run")).toBe("running")
  expect(state("ses_done")).toBe("completed")
  expect(state("ses_fail")).toBe("error")
  expect(state("ses_int")).toBe("interrupted")
  expect(state("ses_busy")).toBe("running")
  // No recorded execution outcome and no open request: honest omission, never "—" invented.
  expect(state("ses_idle")).toBeUndefined()
})

test("#8: title and generate outcomes never rewrite the chat's shown primary agent", async () => {
  const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "plus-monitor-analysis-"))
  roots.push(root)
  process.env.XDG_DATA_HOME = path.join(root, "data")
  opened.push(defaultLedgerPath())
  const { hooks, hookFn } = makeHookRegistry()
  const ctx = context({ event: { subscribe: () => Stream.empty as never }, session: { hook: hookFn as never } })
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* watchMonitor(ctx, () => undefined)
        const sessionID = Session.ID.make("ses_agent")
        const model = modelRef("openai", "gpt-4o")
        const body = JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] })
        for (const [kind, agent] of [
          ["primary", "build"],
          ["title", "title-agent"],
          ["generate", "warm-agent"],
        ] as const) {
          const request = new Request("https://example.test/chat/completions", { method: "POST", body })
          for (const cb of hooks["http.request"] ?? [])
            yield* cb({
              sessionID,
              agent: Agent.ID.make(agent),
              model,
              kind,
              started: 1000,
              requestID: `req-${kind}`,
              request,
            })
        }
        for (const cb of hooks.generated ?? [])
          yield* cb({
            sessionID,
            agent: Agent.ID.make("warm-agent"),
            model,
            kind: "generate",
            started: 2000,
            ended: 2001,
            usage: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
          })
        yield* Effect.promise(() => Effect.runPromise(Effect.void))
      }),
    ),
  )
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(ledgerAt().db.query("select agent from session where id = 'ses_agent'").get()).toEqual({ agent: "build" })
  // The host remains the authority for the shown agent even if a ledger write
  // were wrong or from an older release.
  const hostCtx = context({
    session: {
      hook: hookFn as never,
      get: () => Effect.succeed({ id: "ses_agent", agent: "host-agent" } as never),
    },
  })
  const report = await monitorQuery(hostCtx, { scope: "all", view: "sessions" }, ledgerAt())
  expect(report.sessions?.find((s) => s.sessionID === "ses_agent")?.agent).toBe("host-agent")
})

test("#8: windowed pings and their next-request signal exclude out-of-window next requests", async () => {
  const db = await ledger()
  step(db, { session: "win", id: "real-a", at: 1000 })
  step(db, { session: "win", id: "ping-a", at: 2000, kind: "ping", read: 4000, write: 0, input: 10, cost: 0.01 })
  step(db, { session: "win", id: "real-b", at: 5000, read: 4000, write: 0, input: 10 })

  const windowed = queryMonitor(db, { scope: "session", sessionID: "win", view: "cache", until: 3000 }, { now: 9000 })
  // The next real request is out of this window: it cannot describe the ping here.
  expect(windowed.pings).toMatchObject({ sent: 1, followedByHit: 0, followedByMiss: 0 })
  expect(windowed.totals.pings).toBe(1)

  const whole = queryMonitor(db, { scope: "session", sessionID: "win", view: "cache" }, { now: 9000 })
  expect(whole.pings).toMatchObject({ sent: 1, followedByHit: 0, followedByMiss: 0 })
  expect(whole.totals.cacheRead).toBeGreaterThan(windowed.totals.cacheRead)

  // A ping before the selection is not counted at all.
  const later = queryMonitor(db, { scope: "session", sessionID: "win", view: "cache", since: 3000 }, { now: 9000 })
  expect(later.pings).toMatchObject({ sent: 0, cost: 0, followedByHit: 0 })
})

test("#8: unstable and unread honor the selection and the as-of cutoff, and expiry evolves without writes", async () => {
  const db = await ledger()
  // Four consecutive changed system parts: unstable only once the third change lands.
  for (let i = 0; i < 4; i++)
    step(db, { session: "unstable", id: `u-${i}`, at: 1000 + i * 1000, wire: openaiBody({ system: `time-${i}` }) })
  const early = queryMonitor(db, { scope: "session", sessionID: "unstable", view: "overview", until: 3000 }, { now: 9000 })
  expect(early.unstable?.some((u) => u.sessionID === "unstable")).toBe(false)
  const late = queryMonitor(db, { scope: "session", sessionID: "unstable", view: "overview" }, { now: 9000 })
  expect(late.unstable).toContainEqual({ sessionID: "unstable", segment: "system wire", streak: 3 })
  const selected = queryMonitor(
    db,
    { scope: "session", sessionID: "unstable", view: "overview", since: 2500 },
    { now: 9000 },
  )
  expect(selected.unstable).toContainEqual({ sessionID: "unstable", segment: "system wire", streak: 3 })
  // A later cutoff sees a change at 4000 as future; no write is needed for the
  // answer to evolve because the cutoff is applied at report time.
  const cutoff = queryMonitor(
    db,
    { scope: "session", sessionID: "unstable", view: "overview", until: 4000 },
    { now: 9000 },
  )
  expect(cutoff.unstable?.some((u) => u.sessionID === "unstable")).toBe(false)

  // Unread: a write counts only after its expiry passes by the as-of cutoff,
  // and a future read at or after the cutoff cannot retroactively reduce a
  // historical report. Neither depends on a write, so the as-of cutoff is part
  // of the analysis key.
  const w = await ledger()
  step(w, { session: "unread", id: "w1", at: 1000, provider: "anthropic", model: "claude-3-7", write: 1000, read: 0 })
  // Failure control: provider/model identity alone cannot supply a lifetime.
  const unknownRetention = queryMonitor(w, { scope: "session", sessionID: "unread", view: "cache", id: "w1", until: 400_000 }, { now: 2_000_000 })
  expect(unknownRetention.unread).toBe(0)
  expect(unknownRetention.totals.cacheWrite).toBe(1000)
  expect(unknownRetention.detail?.timing.lifetimeMs).toBeUndefined()
  // Explicit requested retention enables the existing expiry/count control.
  w.requestFingerprint({ requestID: "w1", sessionID: "unread", created: 1000, ...fingerprintWireBody(anthropicBody("x"), { protocol: "anthropic-messages" }) })
  // Before the write's 300s expiry: not yet countable.
  const beforeExpiry = queryMonitor(w, { scope: "session", sessionID: "unread", view: "cache", until: 200_000 }, { now: 2_000_000 })
  expect(beforeExpiry.unread).toBe(0)
  // After the expiry: counted; no read ever re-read it.
  const afterExpiry = queryMonitor(w, { scope: "session", sessionID: "unread", view: "cache", until: 400_000 }, { now: 2_000_000 })
  expect(afterExpiry.unread).toBe(1000)

  // A re-read inside the lifetime before the cutoff clears it.
  const cleared = await ledger()
  step(cleared, { session: "cleared", id: "c1", at: 1000, provider: "anthropic", model: "claude-3-7", wire: anthropicBody("x"), protocol: "anthropic-messages", write: 1000, read: 0 })
  step(cleared, { session: "cleared", id: "c2", at: 200_000, provider: "anthropic", model: "claude-3-7", wire: anthropicBody("y"), protocol: "anthropic-messages", read: 1500 })
  expect(
    queryMonitor(cleared, { scope: "session", sessionID: "cleared", view: "cache", until: 400_000 }, { now: 2_000_000 }).unread,
  ).toBe(0)

  // A read that arrives after the write's expiry (a future request to the
  // historical report) cannot un-count the write, and no write is needed for
  // the answer to be stable across queries.
  const w2 = await ledger()
  step(w2, { session: "u2", id: "w2", at: 1000, provider: "anthropic", model: "claude-3-7", wire: anthropicBody("x"), protocol: "anthropic-messages", write: 1000, read: 0 })
  step(w2, { session: "u2", id: "future", at: 900_000, provider: "anthropic", model: "claude-3-7", wire: anthropicBody("z"), protocol: "anthropic-messages", read: 10_000 })
  const historical = queryMonitor(w2, { scope: "session", sessionID: "u2", view: "cache", until: 400_000 }, { now: 2_000_000 })
  expect(historical.unread).toBe(1000)
  const historicalAgain = queryMonitor(
    w2,
    { scope: "session", sessionID: "u2", view: "cache", until: 400_000 },
    { now: 2_000_000 },
  )
  expect(historicalAgain.unread).toBe(1000)
  expect(historicalAgain.totals).toEqual(historical.totals)
})

test("#8: unstable prefix retains per-request streak and identity across historical cutoffs and future writes", async () => {
  const db = await ledger()
  // Four system changes at 1000..4000: streak reaches 3 on the 4th change at 4000.
  for (let i = 0; i < 4; i++)
    step(db, {
      session: "hist-unstable",
      id: `hu-${i}`,
      at: 1000 + i * 1000,
      agent: "build",
      provider: "openai",
      model: "gpt-4o",
      wire: openaiBody({ system: `time-${i}` }),
    })

  // Historical query until 4500: reports streak 3.
  const beforeFuture = queryMonitor(
    db,
    { scope: "session", sessionID: "hist-unstable", view: "overview", until: 4500 },
    { now: 9000 },
  )
  expect(beforeFuture.unstable).toEqual([
    { sessionID: "hist-unstable", segment: "system wire", streak: 3 },
  ])

  // Future 5th change at 5000:
  step(db, {
    session: "hist-unstable",
    id: "hu-4",
    at: 5000,
    agent: "build",
    provider: "openai",
    model: "gpt-4o",
    wire: openaiBody({ system: "time-4" }),
  })

  // Identical historical query until 4500 after the future write:
  const afterFuture = queryMonitor(
    db,
    { scope: "session", sessionID: "hist-unstable", view: "overview", until: 4500 },
    { now: 9000 },
  )
  // Before-future-write and after-future-write equality:
  expect(afterFuture.unstable).toEqual(beforeFuture.unstable)
  expect(afterFuture.unstable).toEqual([
    { sessionID: "hist-unstable", segment: "system wire", streak: 3 },
  ])

  // A later window sees the 5th change with streak 4:
  const late = queryMonitor(
    db,
    { scope: "session", sessionID: "hist-unstable", view: "overview", until: 6000 },
    { now: 9000 },
  )
  expect(late.unstable).toEqual([
    { sessionID: "hist-unstable", segment: "system wire", streak: 4 },
  ])

  // Identity correctness: agent and model filters select matching identity and exclude mismatching identity
  const matchingAgent = queryMonitor(
    db,
    { scope: "session", sessionID: "hist-unstable", view: "overview", until: 4500, agents: ["build"] },
    { now: 9000 },
  )
  expect(matchingAgent.unstable).toEqual([
    { sessionID: "hist-unstable", segment: "system wire", streak: 3 },
  ])

  const otherAgent = queryMonitor(
    db,
    { scope: "session", sessionID: "hist-unstable", view: "overview", until: 4500, agents: ["other-agent"] },
    { now: 9000 },
  )
  expect(otherAgent.unstable).toEqual([])

  const matchingModel = queryMonitor(
    db,
    { scope: "session", sessionID: "hist-unstable", view: "overview", until: 4500, models: ["openai/gpt-4o"] },
    { now: 9000 },
  )
  expect(matchingModel.unstable).toEqual([
    { sessionID: "hist-unstable", segment: "system wire", streak: 3 },
  ])

  const otherModel = queryMonitor(
    db,
    { scope: "session", sessionID: "hist-unstable", view: "overview", until: 4500, models: ["openai/other-model"] },
    { now: 9000 },
  )
  expect(otherModel.unstable).toEqual([])
})

test("#8: the cutoff changes only windowed signals; the cached analysis stays window-independent", async () => {
  const db = await ledger()
  step(db, { session: "cut", id: "w1", at: 1000, provider: "anthropic", model: "claude-3-7", wire: anthropicBody("x"), protocol: "anthropic-messages", write: 1000, read: 0, output: 10 })
  step(db, { session: "cut", id: "p1", at: 390_000, provider: "anthropic", model: "claude-3-7", wire: anthropicBody("y"), protocol: "anthropic-messages", kind: "ping", read: 9000, write: 0, input: 10 })
  step(db, { session: "cut", id: "w2", at: 400_000, provider: "anthropic", model: "claude-3-7", wire: anthropicBody("z"), protocol: "anthropic-messages", read: 0, write: 0, input: 9000 })
  const rows = db.getRequests("cut")
  const facts = db.getContextFacts("cut")
  const analysis = analyzeSession(db, rows, facts)
  // Two folds are identical: the analysis is a pure function of the facts.
  expect(analyzeSession(db, rows, facts).details).toEqual(analysis.details)
  // The same analysis answers three cutoffs differently without any recompute.
  const early = windowedSessionSignals(analysis, { since: 0, until: 2000 })
  expect(early.unread).toBe(0)
  expect(early.pings).toMatchObject({ sent: 0 })
  const late = windowedSessionSignals(analysis, { since: 0, until: 500_000 })
  expect(late.unread).toBe(1000)
  expect(late.pings.sent).toBe(1)
  const aroundPing = windowedSessionSignals(analysis, { since: 200_000, until: 500_000 })
  expect(aroundPing.pings.sent).toBe(1)
})

test("#8: totals include reasoning, cache read and cache write", async () => {
  const db = await ledger()
  step(db, {
    session: "totals",
    id: "t-a",
    at: 1000,
    input: 11,
    output: 22,
    reasoning: 33,
    read: 44,
    write: 55,
    cost: 0.1,
  })
  const report = queryMonitor(db, { scope: "session", sessionID: "totals", view: "overview" }, { now: 2000 })
  expect(report.totals).toMatchObject({ input: 11, output: 22, reasoning: 33, cacheRead: 44, cacheWrite: 55, cost: 0.1 })
  const agent = report.agents?.[0]
  expect(agent?.tokens).toBe(11 + 44 + 55 + 22 + 33)
})

test("#8: advancing-now polls reuse the analysis fold and still evolve windowed signals", async () => {
  const db = await ledger()
  const raw = db.db
  const SESSIONS = 40
  const REQUESTS = 40
  const prefixes = JSON.stringify(
    Array.from({ length: 60 }, (_, i) => ({ idx: i, role: i % 2 ? "assistant" : "user", chars: 40, estimatedTokens: 10, prefixHash: `h${i}`, contentHash: `c${i}` })),
  )
  const systemParts = JSON.stringify([{ source: "base", hash: "hb", chars: 1600, estimatedTokens: 400 }])
  raw.exec("BEGIN")
  const insertSession = raw.prepare("insert into session (id, directory, title, agent, first_seen, last_seen) values (?, ?, ?, ?, ?, ?)")
  const insertRequest = raw.prepare(
    "insert into request (id, session_id, message_id, kind, is_title, agent, provider, model, started, ended, duration, status, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, cost, created) values (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?)",
  )
  const insertFp = raw.prepare(
    // Explicit ephemeral markers retain the advancing-expiry work gate without
    // guessing retention from an OpenAI-compatible model name.
    "insert into request_fingerprint (request_id, session_id, protocol, system_parts, tools, options_hash, options_keys, message_prefixes, body_hash, created, cache_control, fingerprint_version, policy_version, system_hash) values (?, ?, 'anthropic-messages', ?, '[]', '', '{}', ?, ?, ?, '[{\"target\":\"system[0]\",\"type\":\"ephemeral\"}]', ?, ?, 'system-wire')",
  )
  const base = 1_000_000
  for (let s = 0; s < SESSIONS; s++) {
    const id = `ses_${s}`
    insertSession.run(id, "/project", id, "build", base, base + REQUESTS * 1000)
    for (let r = 0; r < REQUESTS; r++) {
      const at = base + r * 1000
      insertRequest.run(`req_${s}_${r}`, id, `m_${s}_${r}`, "step", "build", "anthropic", "claude-3-7", at, at + 500, 500, 500, 150, 20, r === 0 ? 0 : 2500, 500, 0.01, at)
      insertFp.run(`req_${s}_${r}`, id, systemParts, prefixes, `b_${s}_${r}`, at, FINGERPRINT_VERSION, FINGERPRINT_POLICY_VERSION)
    }
  }
  raw.exec("COMMIT")

  const input = { scope: "all" as const, view: "cache" as const, top: 20, feed: 10 }
  // The first query folds every session; later polls with an advancing `now`
  // cross no write, so the expensive analysis fold is reused while expiry and
  // windowed unread signals evolve with the advancing clock.
  const firstStart = performance.now()
  const first = queryMonitor(db, input, { now: base + REQUESTS * 1000 + 1000 })
  const firstMs = performance.now() - firstStart

  const repeatPolls = [base + 310_000, base + 320_000, base + 350_000]
  const repeatTimes: number[] = []
  const unreadLevels: number[] = [first.unread ?? 0]
  let last = first
  for (const now of repeatPolls) {
    const start = performance.now()
    last = queryMonitor(db, input, { now })
    repeatTimes.push(performance.now() - start)
    unreadLevels.push(last.unread ?? 0)
  }
  console.log("ADVANCING-NOW first(ms)", Math.round(firstMs), "repeat(ms)", repeatTimes.map((t) => Math.round(t)), "unread", unreadLevels)
  expect(first.totals.requests).toBeGreaterThan(0)
  expect(last.totals.requests).toBe(first.totals.requests)
  expect(unreadLevels).toEqual([0, 200_000, 400_000, 780_000])
  // Repeat polls are strictly cheaper than the cold fold on a fixture this size.
  const repeatMax = Math.max(...repeatTimes)
  expect(repeatMax).toBeLessThan(firstMs)
}, 60_000)

// --- Real host boundary: an active chat with a prior outcome stays running. ---
test("#8: host active wins over a prior succeeded/failed outcome and the open-request fallback", async () => {
  const db = await ledger()
  for (const id of ["ses_active_ok", "ses_active_fail", "ses_open_only"] as const)
    step(db, { session: id, id: `${id}-a`, at: 1000 })
  // An open request on a session the host does not report active.
  db.requestStarted({ id: "ses_open_only-open", sessionID: "ses_open_only", messageID: "open", kind: "step", started: 9000 })
  const ctx = context({
    session: {
      get: (input: { sessionID: string }) =>
        Effect.succeed({
          id: input.sessionID,
          outcome: String(input.sessionID) === "ses_active_fail" ? "failed" : "succeeded",
        } as never),
    },
  })
  ;(ctx.session as { active?: unknown }).active = () =>
    Effect.succeed({ ses_active_ok: { type: "running" }, ses_active_fail: { type: "running" } })
  const report = await monitorQuery(ctx, { scope: "all", view: "sessions" }, db)
  const state = (id: string) => report.sessions?.find((s) => s.sessionID === id)?.state
  expect(state("ses_active_ok")).toBe("running")
  expect(state("ses_active_fail")).toBe("running")
  expect(state("ses_open_only")).toBe("running")
})

test("#13: a reusable marked prefix survives the ping's private tail replacement without a prefix change", async () => {
  const db = await ledger()
  const provider = "anthropic"
  const model = "claude-3-7-sonnet"
  const realBody = anthropicBody("real user input")
  const pingBody = anthropicBody("private ping prompt")
  const primaryBody = anthropicBody("next real user input")
  step(db, { session: "wire", id: "real-a", at: 1000, provider, model, wire: realBody, protocol: "anthropic-messages", read: 9000 })
  step(db, {
    session: "wire",
    id: "ping",
    at: 390_000,
    provider,
    model,
    wire: pingBody,
    protocol: "anthropic-messages",
    kind: "ping",
    read: 9193,
    write: 0,
    input: 10,
  })
  step(db, {
    session: "wire",
    id: "primary",
    at: 400_000,
    provider,
    model,
    wire: primaryBody,
    protocol: "anthropic-messages",
    read: 0,
    write: 0,
    input: 9193,
  })

  const report = queryMonitor(
    db,
    { scope: "session", sessionID: "wire", view: "cache", id: "primary" },
    { now: 500_000 },
  )
  const detail = report.detail!
  // The reusable marked prefix is unchanged; the private tail replacement is
  // not named as a certain change.
  expect(detail.segments).toEqual([])
  expect(detail.firstDivergence).toBeUndefined()
  expect(detail.previous?.id).toBe("ping")
  expect(detail.request.expected).toBeUndefined()
  expect(detail.request).toMatchObject({ verdict: "none", missTokens: 0, measurement: { state: "legacy-unknown" } })
  expect(detail.request.cause).toBe("unknown")
  expect(detail.request.confidence).toBe("unknown")
  expect(detail.request.evidence).toContain("Provider cause unavailable")
  // Timing is measured from completion; it is not proof of renewed cache warmth.
  expect(detail.timing).toMatchObject({ gapMs: 9_999, lifetimeMs: 300_000 })
  // The wire hashes stay honest: the ping and primary bodies really differ, and
  // the fingerprint keeps the exact final-wire hash.
  expect(fingerprintWireBody(pingBody, { protocol: "anthropic-messages" }).bodyHash).toBe(
    db.getFingerprint("ping")!.bodyHash,
  )
  expect(db.getFingerprint("ping")!.bodyHash).not.toBe(db.getFingerprint("primary")!.bodyHash)
})

test("#13: a genuinely changed marked part is a prefix change; a changed tail beyond the marker alone is not", async () => {
  const db = await ledger()
  const provider = "anthropic"
  const model = "claude-3-7-sonnet"
  step(db, { session: "changed", id: "a", at: 1000, provider, model, wire: anthropicBody("ping"), protocol: "anthropic-messages", read: 9000 })
  step(db, {
    session: "changed",
    id: "b",
    at: 2000,
    provider,
    model,
    wire: anthropicBody("primary", "CHANGED SYSTEM RULES"),
    protocol: "anthropic-messages",
    read: 0,
    write: 0,
    input: 9193,
  })
  const detail = queryMonitor(
    db,
    { scope: "session", sessionID: "changed", view: "cache", id: "b" },
    { now: 3000 },
  ).detail!
  expect(detail.request.cause).toBe("prefix-changed")
  expect(detail.request.confidence).toBe("unknown")
  expect(detail.request.measurement?.state).toBe("legacy-unknown")
  // The changed part sits inside the marked reusable prefix, so it is named.
  expect(detail.segments.map((s) => s.name)).toContain("system wire")
  expect(detail.firstDivergence).toBe("system wire")
})

test("#13: failed and incompatible legacy pings cannot supply a reusable-token estimate", async () => {
  const provider = "anthropic"
  const model = "claude-3-7-sonnet"
  const cases = [
    {
      name: "failed",
      ping: (db: Ledger) =>
        step(db, {
          session: "p",
          id: "ping",
          at: 390_000,
          provider,
          model,
          wire: anthropicBody("ping"),
          protocol: "anthropic-messages",
          kind: "ping",
          read: 9193,
          write: 0,
          status: "error",
          error: "provider refused",
        }),
    },
    {
      name: "different-model",
      ping: (db: Ledger) =>
        step(db, {
          session: "p",
          id: "ping",
          at: 390_000,
          provider,
          model: "claude-other",
          wire: anthropicBody("ping"),
          protocol: "anthropic-messages",
          kind: "ping",
          read: 9193,
          write: 0,
        }),
    },
    {
      name: "different-variant",
      ping: (db: Ledger) =>
        step(db, {
          session: "p",
          id: "ping",
          at: 390_000,
          provider,
          model,
          variant: "other",
          wire: anthropicBody("ping"),
          protocol: "anthropic-messages",
          kind: "ping",
          read: 9193,
          write: 0,
        }),
    },
  ] as const
  for (const c of cases) {
    const db = await ledger()
    step(db, {
      session: "p",
      id: "real-a",
      at: 1000,
      provider,
      model,
      wire: anthropicBody("real"),
      protocol: "anthropic-messages",
      read: 4000,
    })
    c.ping(db)
    step(db, {
      session: "p",
      id: "primary",
      at: 400_000,
      provider,
      model,
      wire: anthropicBody("next"),
      protocol: "anthropic-messages",
      read: 0,
      write: 0,
      input: 9193,
    })
    const detail = queryMonitor(
      db,
      { scope: "session", sessionID: "p", view: "cache", id: "primary" },
      { now: 500_000 },
    ).detail!
    expect(detail.request).toMatchObject({ verdict: "none", missTokens: 0, measurement: { state: "legacy-unknown" } })
    expect(detail.request.cause).not.toBe("cache-expired")
    // Failed / different-model pings cannot become the comparable predecessor.
    // Variant incompatibility is checked for size even when chronology selects it.
    expect(detail.previous?.id).toBe(c.name === "different-variant" ? "ping" : "real-a")
    expect(detail.request.expected).toBeUndefined()
    expect(detail.timing.gapMs).toBe(c.name === "different-variant" ? 9_999 : 398_999)
  }
})

test("#13: a changed reusable cache marker is a prefix change even with a replaced tail", async () => {
  const provider = "anthropic"
  const model = "claude-3-7-sonnet"
  for (const changed of ["ttl", "system-marker"] as const) {
    const db = await ledger()
    const before = anthropicBody("ping")
    step(db, { session: "marker", id: "a", at: 1000, provider, model, wire: before, protocol: "anthropic-messages", read: 9000 })
    const after =
      changed === "ttl"
        ? anthropicBody("next", undefined, "1h")
        : (() => {
            const body = anthropicBody("next")
            return { ...body, system: [{ type: "text", text: "sys".repeat(4000), cache_control: { type: "ephemeral", ttl: "1h" } }] }
          })()
    step(db, { session: "marker", id: "b", at: 2000, provider, model, wire: after, protocol: "anthropic-messages", read: 0, write: 0, input: 9193 })
    const detail = queryMonitor(
      db,
      { scope: "session", sessionID: "marker", view: "cache", id: "b" },
      { now: 3000 },
    ).detail!
    // The tail is also replaced, so only the marker comparison can catch this.
    expect(`${changed}: ${detail.request.cause}`).toBe(`${changed}: prefix-changed`)
    expect(detail.segments.map((s) => s.name)).toContain("cache markers")
  }
  // Control: identical markers with a replaced tail stay unknown.
  const db = await ledger()
  step(db, { session: "same", id: "a", at: 1000, provider, model, wire: anthropicBody("ping"), protocol: "anthropic-messages", read: 9000 })
  step(db, { session: "same", id: "b", at: 2000, provider, model, wire: anthropicBody("next"), protocol: "anthropic-messages", read: 0, write: 0, input: 9193 })
  const control = queryMonitor(db, { scope: "session", sessionID: "same", view: "cache", id: "b" }, { now: 3000 }).detail!
  expect(control.request.cause).toBe("unknown")
})

test("#13: only a completed same-identity ping becomes the timing predecessor, without proving warmth", async () => {
  const provider = "anthropic"
  const model = "claude-3-7-sonnet"
  // An unfinished (no ended) same-identity ping cannot become the completed
  // comparison or timing predecessor.
  const unfinished = await ledger()
  step(unfinished, { session: "u", id: "real", at: 1000, provider, model, wire: anthropicBody("real"), protocol: "anthropic-messages", read: 4000 })
  unfinished.requestStarted({ id: "ping-open", sessionID: "u", messageID: "ping-open", kind: "ping", started: 390_000, provider, model, agent: "build" })
  unfinished.requestFingerprint({ requestID: "ping-open", sessionID: "u", created: 390_000, ...fingerprintWireBody(anthropicBody("ping"), { protocol: "anthropic-messages" }) })
  step(unfinished, { session: "u", id: "primary", at: 400_000, provider, model, wire: anthropicBody("next"), protocol: "anthropic-messages", read: 0, write: 0, input: 9193 })
  const openDetail = queryMonitor(unfinished, { scope: "session", sessionID: "u", view: "cache", id: "primary" }, { now: 500_000 }).detail!
  expect(openDetail.request).toMatchObject({ verdict: "none", cause: "unknown", measurement: { state: "legacy-unknown" } })
  expect(openDetail.previous?.id).toBe("real")
  expect(openDetail.timing.gapMs).toBe(398_999)

  // Completion changes the observed predecessor and gap, not proof of warmth.
  unfinished.requestEnded("ping-open", {
    ended: 390_100,
    status: "completed",
    usage: { input: 10, output: 5, reasoning: 0, cacheRead: 9193, cacheWrite: 0, cost: 0 },
  })
  const doneDetail = queryMonitor(unfinished, { scope: "session", sessionID: "u", view: "cache", id: "primary" }, { now: 500_000 }).detail!
  expect(doneDetail.request.cause).toBe("unknown")
  expect(doneDetail.previous?.id).toBe("ping-open")
  expect(doneDetail.timing.gapMs).toBe(9_900)
  expect(doneDetail.request).toMatchObject({ verdict: "none", missTokens: 0, measurement: { state: "legacy-unknown" } })
})

test("#8: agent/model selection filters pings, follow stats, unread and instability", async () => {
  const db = await ledger()
  const provider = "anthropic"
  const model = "claude-3-7-sonnet"
  // Agent A: 4 system changes (unstable streak 3), a ping then positive reads;
  // Agent B: a ping then legacy zero and an unread marked write.
  for (let i = 0; i < 4; i++)
    step(db, {
      session: "f",
      id: `a-u-${i}`,
      at: 100 + i * 100,
      provider,
      model,
      agent: "A",
      wire: openaiBody({ system: `u-${i}` }),
      write: 0,
    })
  step(db, { session: "f", id: "a-real", at: 1000, provider, model, agent: "A", wire: anthropicBody("a"), protocol: "anthropic-messages", read: 0, write: 1000 })
  step(db, { session: "f", id: "a-ping", at: 2000, provider, model, agent: "A", wire: anthropicBody("ap"), protocol: "anthropic-messages", kind: "ping", read: 4000, write: 0, input: 10, cost: 0.01 })
  step(db, { session: "f", id: "a-next", at: 3000, provider, model, agent: "A", wire: anthropicBody("an"), protocol: "anthropic-messages", read: 4000, write: 0, input: 10 })
  step(db, { session: "f", id: "b-real", at: 4000, provider, model, agent: "B", wire: anthropicBody("b"), protocol: "anthropic-messages", write: 1000, read: 0 })
  step(db, { session: "f", id: "b-ping", at: 5000, provider, model, agent: "B", wire: anthropicBody("bp"), protocol: "anthropic-messages", kind: "ping", read: 0, write: 0, input: 10, cost: 0.02 })
  step(db, { session: "f", id: "b-next", at: 6_000_000, provider, model, agent: "B", wire: anthropicBody("bn"), protocol: "anthropic-messages", read: 0, write: 0, input: 10 })

  const a = queryMonitor(db, { scope: "session", sessionID: "f", view: "cache", agents: ["A"] }, { now: 7_000_000 })
  expect(a.pings).toMatchObject({ sent: 1, cost: 0.01, followedByHit: 0, followedByMiss: 0 })
  expect(a.requests?.every((request) => request.agent === "A")).toBe(true)
  expect(a.totals.cacheRead).toBe(8000)
  // Agent B's write is outside A's selection; Agent A's instability is in A.
  expect(a.unread).toBe(0)
  expect(a.unstable).toContainEqual({ sessionID: "f", segment: "system wire", streak: 3 })
  const b = queryMonitor(db, { scope: "session", sessionID: "f", view: "cache", agents: ["B"] }, { now: 7_000_000 })
  // Neither legacy follow-up is measurable; A's ping and instability are not in B.
  expect(b.pings).toMatchObject({ sent: 1, cost: 0.02, followedByHit: 0, followedByMiss: 0 })
  expect(b.requests?.every((request) => request.agent === "B")).toBe(true)
  expect(b.totals.cacheRead).toBe(0)
  expect(b.unread).toBe(1000)
  expect(b.unstable).toEqual([])
  const none = queryMonitor(db, { scope: "session", sessionID: "f", view: "cache" }, { now: 7_000_000 })
  expect(none.pings).toMatchObject({ sent: 2, cost: 0.03, followedByHit: 0, followedByMiss: 0 })
  expect(none.unread).toBe(1000)
  expect(none.unstable).toContainEqual({ sessionID: "f", segment: "system wire", streak: 3 })
  // The model filter narrows the same way.
  const wrongModel = queryMonitor(db, { scope: "session", sessionID: "f", view: "cache", models: ["anthropic/other"] }, { now: 7_000_000 })
  expect(wrongModel.pings).toMatchObject({ sent: 0, cost: 0 })
  expect(wrongModel.unread).toBe(0)
  expect(wrongModel.unstable).toEqual([])
})

test("#8: excluded title auxiliaries do not inject unread or follow signals by default", async () => {
  const provider = "anthropic"
  const model = "claude-3-7-sonnet"
  const db = await ledger()
  // A title writes cache and is never read; by default it must not count unread.
  step(db, { session: "t", id: "real", at: 1000, provider, model, agent: "A", wire: anthropicBody("a"), protocol: "anthropic-messages", read: 0, write: 0 })
  step(db, { session: "t", id: "title", at: 2000, provider, model, agent: "A", kind: "title", wire: anthropicBody("t"), protocol: "anthropic-messages", write: 500, read: 0 })
  step(db, { session: "t", id: "next", at: 3_000_000, provider, model, agent: "A", wire: anthropicBody("n"), protocol: "anthropic-messages", read: 100, write: 0 })
  const excluded = queryMonitor(db, { scope: "session", sessionID: "t", view: "cache" }, { now: 4_000_000 })
  expect(excluded.unread).toBe(0)
  // With titles included, the title's write is honestly unread.
  const included = queryMonitor(db, { scope: "session", sessionID: "t", view: "cache", titles: true }, { now: 4_000_000 })
  expect(included.unread).toBe(500)
})

// --- Real hook registry, as monitor-requests uses it. ---
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
    return Effect.sync(() => ({
      dispose: Effect.sync(() => {
        const l = hooks[name]
        if (l) {
          const idx = l.indexOf(cb as never)
          if (idx !== -1) l.splice(idx, 1)
        }
      }),
    }))
  }
  return { hooks, hookFn }
}
