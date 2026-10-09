import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { MonitorReport } from "../src/rpc.js"
import { FINGERPRINT_POLICY_VERSION, FINGERPRINT_VERSION, fingerprintWireBody, sha256 } from "../src/monitor/fingerprint.js"
import { prefixDiff } from "../src/monitor/cache.js"
import { queryMonitor } from "../src/monitor/query.js"
import type { Ledger } from "../src/monitor/ledger.js"
import { createLedger } from "../src/monitor/ledger.js"
import { cleanupLedgers, collect, ledger } from "./monitor-fixture.js"
import { inferRunTeam, loadRun, saveRun, type RunRecord } from "../src/teams/run.js"
import { projectTeamsPath } from "../src/instructions/paths.js"
import { monitorQuery } from "../src/monitor/plugin.js"
import { context } from "./harness.js"

const priorConfig = process.env.XDG_CONFIG_HOME

test("Responses linked continuation reuses full predecessor prompt; unknown and changed previous ids name the change", async () => {
  const db = await ledger()
  const make = (id: string, at: number, wire: object, responseId: string) => {
    db.session({ id: "continuation" }, at)
    db.requestStarted({ id, sessionID: "continuation", kind: "step", started: at, provider: "openai", model: "gpt-4o" })
    db.requestEnded(id, { ended: at + 1, status: "completed", usage: { input: 4000, cacheRead: 0, cacheWrite: 0, output: 100, reasoning: 0, cost: 0 } })
    db.requestFingerprint({ requestID: id, sessionID: "continuation", ...fingerprintWireBody(wire, { protocol: "openai-responses" }), responseId: sha256(responseId) })
    return db.getFingerprint(id)!
  }
  const a = make("a", 100, { input: [{ role: "user", content: "prompt" }] }, "response-a")
  make("title-between", 150, { input: [{ role: "user", content: "title" }] }, "response-title")
  db.requestStarted({ id: "title-between", sessionID: "continuation", kind: "title", isTitle: true, started: 150 })
  const b = make("b", 200, { previous_response_id: "response-a", input: [{ role: "user", content: "next" }] }, "response-b")
  expect(prefixDiff(a, b).append).toBe(true)
  const report = queryMonitor(db, { scope: "session", sessionID: "continuation", view: "cache", id: "b" }, { now: 1000 })
  // Continuation identity is observable; legacy accounting is not a measured anchor.
  expect(report.detail?.request.expected).toBeUndefined()
  expect(report.detail?.request.measurement?.state).toBe("legacy-unknown")
  expect(report.detail?.previous?.id).toBe("a")
  const c = make("c", 300, { previous_response_id: "response-b", input: [{ role: "user", content: "last" }] }, "response-c")
  expect(prefixDiff(b, c).append).toBe(true)
  const unknown = { ...c, previousResponseId: sha256("unknown") }
  expect(prefixDiff(b, unknown)).toMatchObject({ append: false, common: 0, changes: [{ name: "previous_response_id" }] })
  expect(prefixDiff(b, { ...c, previousResponseId: a.responseId })).toMatchObject({ append: false, common: 0, changes: [{ name: "previous_response_id" }] })
  expect(prefixDiff(b, { ...c, previousResponseId: undefined })).toMatchObject({ append: false, common: 0, changes: [{ name: "previous_response_id", change: "removed" }] })
})
afterEach(() => {
  if (priorConfig === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = priorConfig
  cleanupLedgers()
})

const body = (change: { system?: string; tool?: string; message?: string; append?: boolean } = {}) => ({
  model: "gpt-4o",
  messages: [
    { role: "system", content: "base".repeat(1600) },
    { role: "system", content: change.system ?? "rules" },
    { role: "user", content: change.message ?? "Hello" },
    ...(change.append ? [{ role: "assistant", content: "answer" }] : []),
  ],
  tools: [
    {
      type: "function",
      function: { name: "shell", description: change.tool ?? "run a shell", parameters: { type: "object" } },
    },
  ],
})

function request(
  db: Ledger,
  session: string,
  id: string,
  at: number,
  options: {
    wire?: ReturnType<typeof body>
    provider?: string
    model?: string
    agent?: string
    read?: number
    write?: number
    input?: number
    kind?: string
    error?: string
  } = {},
) {
  const clock = { now: at }
  const collector = collect(db, clock)
  db.session({ id: session, agent: options.agent ?? "build", directory: "/project" }, at)
  db.requestStarted({
    id,
    sessionID: session,
    messageID: id,
    started: at,
    kind: options.kind ?? "step",
    isTitle: options.kind === "title",
    provider: options.provider ?? "openai",
    model: options.model ?? "gpt-4o",
    agent: options.agent ?? "build",
  })
  db.requestFingerprint({
    requestID: id,
    sessionID: session,
    created: at,
    ...fingerprintWireBody(options.wire ?? body(), {
      namedSystemParts: [
        { name: "base", text: "base".repeat(1600) },
        { name: "AGENTS.md", text: options.wire?.messages[1]?.content ?? "rules" },
      ],
    }),
  })
  if (options.kind && options.kind !== "step") {
    db.requestEnded(id, {
      ended: at + 1,
      status: options.error ? "error" : "completed",
      ...(options.error ? { error: options.error } : {}),
      usage: {
        input: options.input ?? 3000,
        cacheRead: options.read ?? 0,
        cacheWrite: options.write ?? 1000,
        output: 100,
        reasoning: 10,
        cost: 0.01,
      },
    })
    return
  }
  collector.observe({
    type: "session.step.started",
    data: {
      sessionID: session,
      assistantMessageID: id,
      started: at,
      agent: options.agent ?? "build",
      model: { providerID: options.provider ?? "openai", id: options.model ?? "gpt-4o" },
    },
  })
  clock.now = at + 1
  collector.observe({
    type: "session.step.ended",
    data: {
      sessionID: session,
      assistantMessageID: id,
      finish: "stop",
      cost: 0.01,
      tokens: {
        input: options.input ?? 3000,
        output: 100,
        reasoning: 10,
        cache: { read: options.read ?? 0, write: options.write ?? 1000 },
      },
    },
  })
}

test("local changes remain observable independently of unknown legacy cache diagnoses", async () => {
  const db = await ledger()
  const cases = [
    {
      session: "model",
      options: { model: "gpt-5" },
      cause: "model-switch",
      evidence: "Model / variant",
    },
    {
      session: "agent",
      options: { agent: "review" },
      cause: "agent-switch",
      evidence: "Agent switched",
    },
    {
      session: "system",
      options: { wire: body({ system: "new rules" }) },
      cause: "prefix-changed",
      evidence: "system wire changed",
    },
    {
      session: "tool",
      options: { wire: body({ tool: "different tool description" }) },
      cause: "prefix-changed",
      evidence: "tool shell description changed",
    },
    { session: "expired", options: {}, cause: "unknown", evidence: "Provider cause unavailable" },
    {
      session: "account",
      options: {},
      cause: "account-changed",
      evidence: "Provider account changed",
    },
    {
      session: "unknown",
      options: {},
      cause: "unknown",
      evidence: "Provider cause unavailable",
    },
    { session: "compacted", options: {}, cause: "compacted", evidence: "Compaction occurred" },
  ] as const
  for (const c of cases) {
    request(db, c.session, `${c.session}-1`, 1000)
    if (c.session === "expired")
      db.contextFact({ sessionID: c.session, at: 1500, kind: "warming", detail: { state: "off" } })
    if (c.session === "account")
      db.contextFact({
        sessionID: c.session,
        at: 1500,
        kind: "account_switch",
        detail: { previous: "account-a", alias: "account-b" },
      })
    if (c.session === "compacted") db.contextFact({ sessionID: c.session, at: 1500, kind: "compaction" })
    if (c.session === "system") {
      db.contextFact({ sessionID: c.session, at: 1500, kind: "instruction_update", detail: { keys: ["AGENTS.md"] } })
      db.contextFact({ sessionID: c.session, at: 1600, kind: "revert" })
    }
    request(db, c.session, `${c.session}-2`, c.session === "expired" ? 400_000 : 2000, c.options)
    const report = queryMonitor(
      db,
      { scope: "session", sessionID: c.session, view: "cache", id: `${c.session}-2` },
      { now: 500_000 },
    )
    expect(report.detail?.request).toMatchObject({ verdict: "none", missTokens: 0, measurement: { state: "legacy-unknown" } })
    expect(report.detail?.request.expected).toBeUndefined()
    expect(report.detail?.request.cause).toBe(c.cause)
    expect(report.detail?.request.evidence).toContain(c.evidence)
    expect(report.detail?.request.confidence).toBe("unknown")
    expect(report.detail?.request.messageID).toBe(`${c.session}-2`)
    expect(report.detail?.lines.join(" ")).toContain(c.session)
    expect(Schema.decodeUnknownSync(MonitorReport)(report)).toEqual(report)
    if (c.session === "system") {
      expect(report.detail?.instructions[0]?.keys).toEqual(["AGENTS.md"])
      expect(report.detail?.reverts).toEqual([{ at: 1600 }])
      expect(report.detail?.firstDivergence).toBe("system wire")
    }
    if (c.session === "account")
      expect(report.detail?.accounts[0]).toMatchObject({ from: "account-a", to: "account-b" })
  }
})

test("legacy append and changed prefixes never invent token estimates from stored accounting", async () => {
  const db = await ledger()
  for (const [name, read] of [
    ["below-old-threshold", 1999],
    ["at-old-threshold", 2000],
    ["above-old-threshold", 3600],
  ] as const) {
    request(db, name, `${name}-a`, 1000)
    request(db, name, `${name}-b`, 2000, { wire: body({ append: true }), read })
    const report = queryMonitor(db, { scope: "session", sessionID: name, view: "cache" }, { now: 3000 })
    expect(report.requests?.[1]).toMatchObject({
      cacheRead: read,
      cacheWrite: 1000,
      verdict: "none",
      measurement: { state: "legacy-unknown" },
      missTokens: 0,
    })
    expect(report.requests?.[1]?.expected).toBeUndefined()
    expect(report.totals.hitRate).toBeUndefined()
  }
  request(db, "changed", "changed-a", 1000)
  request(db, "changed", "changed-b", 2000, { wire: body({ system: "changed" }) })
  const changed = queryMonitor(db, { scope: "session", sessionID: "changed", view: "cache" }, { now: 3000 })
  expect(changed.requests?.[1]?.expected).toBeUndefined()
  expect(changed.requests?.[1]?.cause).toBe("prefix-changed")
  request(db, "none", "none-a", 1000, { read: 0, write: 0 })
  request(db, "none", "none-b", 2000, { read: 0, write: 0 })
  expect(
    queryMonitor(db, { scope: "session", sessionID: "none", view: "cache" }, { now: 3000 }).requests?.[1]?.verdict,
  ).toBe("none")
})

test("signals: named changes, legacy pings without hit claims, marked unread writes and compaction context", async () => {
  const db = await ledger()
  for (let i = 0; i < 4; i++)
    request(db, "unstable", `unstable-${i}`, 1000 + i * 1000, { wire: body({ system: `time-${i}` }) })
  request(db, "ping", "real-a", 1000)
  request(db, "ping", "ping-a", 2000, { kind: "ping", read: 4000, write: 0, input: 10 })
  request(db, "ping", "real-b", 3000, { read: 4010, write: 0 })
  db.contextFact({ sessionID: "ping", at: 2500, kind: "compaction" })
  request(db, "ping", "real-c", 4000, { read: 7000, write: 0 })
  request(db, "unread", "unread-a", 1000, { provider: "anthropic", model: "claude-3-7" })
  // This control has a requested retention marker; ordinary OpenAI-compatible
  // fixtures intentionally do not establish a lifetime from the model name.
  db.requestFingerprint({
    requestID: "unread-a", sessionID: "unread", created: 1000,
    ...fingerprintWireBody({
      system: [{ type: "text", text: "base", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "Hello" }],
    }, { protocol: "anthropic-messages" }),
  })
  request(db, "effective", "effective-a", 1000)
  request(db, "effective", "effective-ping", 2000, { kind: "ping", read: 4000, write: 0, input: 10 })
  request(db, "effective", "effective-b", 3000, { read: 4010, write: 0 })
  request(db, "ineffective", "ineffective-a", 1000)
  request(db, "ineffective", "ineffective-ping", 2000, { kind: "ping", read: 4000, write: 0, input: 10 })
  request(db, "ineffective", "ineffective-b", 3000)
  const report = queryMonitor(db, { scope: "all", view: "overview" }, { now: 400_000 })
  expect(report.unstable).toContainEqual({ sessionID: "unstable", segment: "system wire", streak: 3 })
  expect(report.pings).toMatchObject({ sent: 3, cost: 0.03, followedByHit: 0, followedByMiss: 0 })
  expect(report.unread).toBeGreaterThanOrEqual(1000)
  expect(report.context?.find((c) => c.sessionID === "ping")).toEqual({
    sessionID: "ping",
    now: 10000,
    atCompaction: 7010,
  })
  expect(report.totals.missTokens).toBe(0)
  expect(report.topMisses).toEqual([])
  expect(report.agents?.[0]?.lastActive).toBe(4000)
})

test("legacy pricing cannot manufacture losses; failed pings and account facts remain visible", async () => {
  const db = await ledger()
  request(db, "priced", "priced-a", 1000)
  db.contextFact({
    sessionID: "priced",
    at: 1500,
    kind: "pricing",
    detail: { provider: "openai", model: "gpt-4o", rates: [{ input: 2, output: 5, cache: { read: 0.1, write: 3 } }] },
  })
  request(db, "priced", "priced-b", 2000)
  const priced = queryMonitor(
    db,
    { scope: "session", sessionID: "priced", view: "cache", id: "priced-b" },
    { now: 3000 },
  )
  expect(priced.detail?.request).toMatchObject({ missTokens: 0, pricing: { state: "unknown-shortfall" }, measurement: { state: "legacy-unknown" } })
  expect(priced.detail?.request.missCost).toBeUndefined()
  expect(priced.totals.missCost).toBeUndefined()
  request(db, "failed", "failed-a", 1000)
  request(db, "failed", "failed-ping", 390_000, { kind: "ping", error: "failed", input: 0, read: 0, write: 0 })
  db.contextFact({ sessionID: "failed", at: 390_001, kind: "account_switch" })
  request(db, "failed", "failed-b", 400_000)
  const failed = queryMonitor(
    db,
    { scope: "session", sessionID: "failed", view: "cache", id: "failed-b" },
    { now: 500_000 },
  )
  expect(failed.detail?.request.cause).toBe("account-changed")
  expect(failed.detail?.timing).toMatchObject({ gapMs: 398_999, warming: "failed", lastPingAt: 390_000 })
  expect(failed.detail?.accounts.length).toBe(1)
  expect(JSON.parse(failed.detail!.pings[0]!.error!)).toEqual({ type: "Error", hash: sha256("failed"), chars: 6 })
})

test("scopes, title exclusion, per-session compaction windows and detail refusal outside scope", async () => {
  const db = await ledger()
  request(db, "root", "root-a", 1000)
  request(db, "child", "child-a", 1000)
  request(db, "sibling", "sibling-a", 1000)
  request(db, "other", "other-a", 1000)
  db.session({ id: "root", team: "Blue" }, 1000)
  db.session({ id: "child", parentID: "root", team: "Blue" }, 1000)
  db.session({ id: "sibling", parentID: "root", team: "Blue" }, 1000)
  request(db, "child", "child-b", 3000)
  request(db, "child", "title", 4000, { kind: "title" })
  db.contextFact({ sessionID: "child", at: 2000, kind: "compaction" })
  const tree = queryMonitor(
    db,
    { scope: "tree", sessionID: "child", view: "sessions", sinceCompaction: true },
    { now: 5000 },
  )
  expect(tree.sessions?.map((s) => s.sessionID)).toEqual(["root", "child", "sibling"])
  expect(tree.totals.requests).toBe(3)
  const team = queryMonitor(db, { scope: "team", team: "Blue", view: "cache", titles: true }, { now: 5000 })
  expect(team.requests?.length).toBe(5)
  expect(team.teams).toEqual(["Blue"])
  expect(
    queryMonitor(db, { scope: "session", sessionID: "other", view: "cache", id: "child-b" }, { now: 5000 }).detail,
  ).toBeUndefined()
  expect(
    queryMonitor(db, { scope: "session", sessionID: "child", missesOnly: true }, { now: 5000 }).requests?.map(
      (r) => r.id,
    ),
  ).toEqual([])
})

test("new runs persist team identity; historic membership inference refuses ambiguity", async () => {
  const db = await ledger()
  const directory = path.dirname(db.path)
  process.env.XDG_CONFIG_HOME = path.join(directory, "config")
  const team = (name: string) => path.join(projectTeamsPath(directory), name)
  await fs.mkdir(team("Blue"), { recursive: true })
  await Bun.write(path.join(team("Blue"), "worker.md"), "Worker instructions")
  const run: RunRecord = {
    id: "w-0123456789abcdef",
    role: "worker",
    kind: "w",
    repo: "repo",
    repoKey: "repo",
    directory,
    paths: [],
    branch: "test",
    base: "a".repeat(40),
    head: "a".repeat(40),
    state: "working",
    attempts: [],
    task: null,
    parent: null,
    children: [],
    briefSha: "",
    bundle: "test",
    budget: {},
    createdAt: new Date().toISOString(),
    lastUsed: new Date().toISOString(),
    sessionID: "session",
    configDigest: null,
    history: [],
  }
  expect(await inferRunTeam(run)).toBe("Blue")
  db.session({ id: "historic", role: "worker", directory }, 1000)
  db.session({ id: "host-child", parentID: "historic", directory }, 1000)
  expect(
    (await monitorQuery(context(), { scope: "team", team: "Blue", view: "sessions" }, db)).sessions?.map(
      (s) => s.sessionID,
    ),
  ).toEqual(["historic", "host-child"])
  await saveRun(path.join(directory, "teams"), run)
  expect((await loadRun(path.join(directory, "teams"), run.id))?.team).toBe("Blue")
  await fs.mkdir(team("Green"), { recursive: true })
  await Bun.write(path.join(team("Green"), "worker.md"), "Other worker instructions")
  expect(await inferRunTeam(run)).toBeUndefined()
  expect(await inferRunTeam({ ...run, team: "Blue" })).toBe("Blue")
  await saveRun(path.join(directory, "teams"), run)
  expect((await loadRun(path.join(directory, "teams"), run.id))?.team).toBe("Blue")
})

test("mixed v1 steps and recorded requests keep legacy usage without double-counting logical steps", async () => {
  const db = await ledger()
  db.stepStarted({ sessionID: "migrated", messageID: "legacy", kind: "step", idx: 0, epoch: 0, started: 1000 })
  db.stepEnded("migrated", "legacy", 1100, "stop", {
    input: 100,
    cacheRead: 900,
    cacheWrite: 0,
    output: 20,
    reasoning: 0,
    cost: 0.5,
  })
  request(db, "migrated", "new", 2000)
  const report = queryMonitor(db, { scope: "session", sessionID: "migrated" }, { now: 3000 })
  expect(report.totals).toMatchObject({ steps: 2, requests: 1, input: 3100, cacheRead: 900, output: 120, cost: 0.51 })
})

test("a completion written by a second handle invalidates the first handle's cache", async () => {
  const db = await ledger()
  // A second connection (the shared ledger serves every Plus instance, and any
  // other process pointed at the same file), opened before the baseline read.
  const other = createLedger(db.path)
  const named = [
    { name: "base", text: "base".repeat(1600) },
    { name: "AGENTS.md", text: "rules" },
  ]
  request(db, "two", "warm", 1000)
  db.requestStarted({
    id: "open",
    sessionID: "two",
    messageID: "open",
    started: 2000,
    kind: "step",
    provider: "openai",
    model: "gpt-4o",
    agent: "build",
  })
  db.requestFingerprint({
    requestID: "open",
    sessionID: "two",
    created: 2000,
    ...fingerprintWireBody(body({ append: true }), { namedSystemParts: named }),
  })

  const read = () => queryMonitor(db, { scope: "session", sessionID: "two", view: "cache", id: "open" }, { now: 3000 })
  const openRow = read().requests?.find((r) => r.id === "open")
  // #28: a running request has no usage yet, so it is not judged a miss.
  expect(openRow).toMatchObject({ input: 0, cacheRead: 0, verdict: "none", missTokens: 0, evidence: "Request still running; no usage reported yet" })
  expect(read().totals.misses).toBe(0)

  // The other handle/process completes the existing row: the first handle's
  // own total_changes never moves, so only data_version can reveal it.
  other.requestEnded("open", {
    ended: 2100,
    status: "completed",
    usage: { input: 400, output: 100, reasoning: 10, cacheRead: 3600, cacheWrite: 0, cost: 0.01 },
  })

  const done = read()
  expect(done.requests?.find((r) => r.id === "open")).toMatchObject({ input: 400, cacheRead: 3600, verdict: "none", measurement: { state: "legacy-unknown" } })
  expect(done.requests?.find((r) => r.id === "open")).not.toEqual(openRow)
  expect(done.requests?.length).toBe(2)
  expect(db.getContextFacts("two").length).toBe(0)
  other.close()
})

test("a direct database update invalidates the cached analysis with row and fact counts unchanged", async () => {
  const db = await ledger()
  request(db, "direct", "real", 1000)
  request(db, "direct", "g", 2000, { kind: "generate", read: 0, write: 1000 })

  const read = () => queryMonitor(db, { scope: "session", sessionID: "direct", view: "cache" }, { now: 3000 })
  const before = read()
  expect(before.requests?.find((r) => r.id === "g")?.kind).toBe("generate")
  expect(before.pings?.sent).toBe(0)

  db.db.query("update request set kind = 'ping' where id = 'g'").run()

  const after = read()
  expect(after.requests?.find((r) => r.id === "g")?.kind).toBe("ping")
  expect(after.pings?.sent).toBe(1)
  expect(after.requests?.length).toBe(2)
  expect(db.getContextFacts("direct").length).toBe(0)
})

// Issue #3: an in-place update of an existing request row (completion, a
// corrected final wire fingerprint, a kind relabel) keeps the row id and the
// fact timestamps, so the analysis cache must key on the ledger write revision.
test("in-place request completion invalidates the cached query-time analysis", async () => {
  const db = await ledger()
  const named = [
    { name: "base", text: "base".repeat(1600) },
    { name: "AGENTS.md", text: "rules" },
  ]
  request(db, "completion", "warm", 1000)
  db.requestStarted({
    id: "open",
    sessionID: "completion",
    messageID: "open",
    started: 2000,
    kind: "step",
    provider: "openai",
    model: "gpt-4o",
    agent: "build",
  })
  db.requestFingerprint({
    requestID: "open",
    sessionID: "completion",
    created: 2000,
    ...fingerprintWireBody(body({ append: true }), { namedSystemParts: named }),
  })

  const read = () =>
    queryMonitor(db, { scope: "session", sessionID: "completion", view: "cache", id: "open" }, { now: 3000 })
  const openRow = read().requests?.find((r) => r.id === "open")
  // #28: a running request has no usage yet, so it is not judged a miss.
  expect(openRow).toMatchObject({ input: 0, cacheRead: 0, verdict: "none", missTokens: 0, evidence: "Request still running; no usage reported yet" })
  expect(read().totals.misses).toBe(0)
  // A second poll with no write still reads the cached analysis.
  expect(read().requests?.find((r) => r.id === "open")).toEqual(openRow)

  db.requestEnded("open", {
    ended: 2100,
    status: "completed",
    usage: { input: 400, output: 100, reasoning: 10, cacheRead: 3600, cacheWrite: 0, cost: 0.01 },
  })

  const done = read()
  expect(done.requests?.find((r) => r.id === "open")).toMatchObject({ input: 400, cacheRead: 3600, verdict: "none", measurement: { state: "legacy-unknown" } })
  expect(done.requests?.find((r) => r.id === "open")).not.toEqual(openRow)
  expect(done.totals).toMatchObject({ requests: 2, input: 3400, cacheRead: 3600 })
})

test("a corrected final wire fingerprint changes evidence without changing the request or fact count", async () => {
  const db = await ledger()
  request(db, "final", "a", 1000)
  db.requestStarted({
    id: "b",
    sessionID: "final",
    messageID: "b",
    started: 2000,
    kind: "step",
    provider: "openai",
    model: "gpt-4o",
    agent: "build",
  })
  db.requestFingerprint({
    requestID: "b",
    sessionID: "final",
    created: 2000,
    ...fingerprintWireBody(body({ system: "first rules" })),
  })
  db.requestEnded("b", {
    ended: 2100,
    status: "completed",
    usage: { input: 3000, output: 100, reasoning: 10, cacheRead: 2000, cacheWrite: 1000, cost: 0.01 },
  })

  const read = () => queryMonitor(db, { scope: "session", sessionID: "final", view: "cache", id: "b" }, { now: 3000 })
  const before = read().requests?.find((r) => r.id === "b")
  expect(before?.cause).toBe("prefix-changed")

  // The final wire body corrects the earlier draft: the prefix is unchanged.
  db.requestFingerprint({
    requestID: "b",
    sessionID: "final",
    created: 2000,
    ...fingerprintWireBody(body({ append: true }), {
      namedSystemParts: [
        { name: "base", text: "base".repeat(1600) },
        { name: "AGENTS.md", text: "rules" },
      ],
    }),
  })

  const after = read()
  const afterRow = after.requests?.find((r) => r.id === "b")
  expect(after.requests?.length).toBe(2)
  expect(db.getContextFacts("final").length).toBe(0)
  expect(afterRow?.cause).not.toBe("prefix-changed")
  expect(afterRow?.evidence).not.toBe(before?.evidence)
  expect(afterRow).toMatchObject({ verdict: "none", missTokens: 0, measurement: { state: "legacy-unknown" } })
  expect(afterRow?.expected).toBeUndefined()
})

test("relabelling a generate request to ping invalidates its kind and the ping counts", async () => {
  const db = await ledger()
  request(db, "relabel", "real", 1000)
  request(db, "relabel", "g", 2000, { kind: "generate", read: 0, write: 1000 })

  const before = queryMonitor(db, { scope: "session", sessionID: "relabel", view: "cache" }, { now: 3000 })
  expect(before.requests?.find((r) => r.id === "g")?.kind).toBe("generate")
  expect(before.pings?.sent).toBe(0)

  db.relabelLatestRequest("relabel", "generate", "ping")

  const after = queryMonitor(db, { scope: "session", sessionID: "relabel", view: "cache" }, { now: 3000 })
  expect(after.requests?.find((r) => r.id === "g")?.kind).toBe("ping")
  expect(after.pings?.sent).toBe(1)
  expect(after.totals.requests).toBe(2)
})

test("synthetic ledger benchmark: 200 sessions × 200 requests × 200 message prefixes", async () => {
  const db = await ledger()
  const rawDb = db.db

  const SESSIONS = 200
  const REQUESTS = 200
  const PREFIXES = 200

  const sessions: Array<{ id: string; parentId: string | null; rootId: string }> = []
  for (let s = 0; s < SESSIONS; s++) {
    const treeIdx = Math.floor(s / 10)
    const inTreeIdx = s % 10
    const rootId = `ses_tree_${treeIdx}_root`
    const id = inTreeIdx === 0 ? rootId : `ses_tree_${treeIdx}_child_${inTreeIdx}`
    const parentId = inTreeIdx === 0 ? null : inTreeIdx === 1 ? rootId : `ses_tree_${treeIdx}_child_${inTreeIdx - 1}`
    sessions.push({ id, parentId, rootId })
  }

  const messagePrefixesJson = JSON.stringify(
    Array.from({ length: PREFIXES }, (_, i) => ({
      idx: i,
      role: i % 2 === 0 ? "user" : "assistant",
      chars: 40,
      estimatedTokens: 10,
      prefixHash: `hash_p_${i}`,
      contentHash: `hash_c_${i}`,
    })),
  )
  const systemPartsJson = JSON.stringify([
    { source: "base", hash: "hash_base", chars: 1600, estimatedTokens: 400 },
    { source: "AGENTS.md", hash: "hash_agents", chars: 200, estimatedTokens: 50 },
  ])

  const startBuild = performance.now()
  rawDb.exec("BEGIN TRANSACTION")

  const insertSession = rawDb.prepare(
    "insert into session (id, parent_id, directory, title, agent, first_seen, last_seen) values (?, ?, ?, ?, ?, ?, ?)",
  )
  const insertRequest = rawDb.prepare(
    "insert into request (id, session_id, message_id, kind, is_title, agent, provider, model, started, ended, duration, status, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, cost, created) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
  const insertFp = rawDb.prepare(
    // Keep the expiry/count gates on explicitly requested retention, not the
    // former undocumented universal five-minute lifetime.
    "insert into request_fingerprint (request_id, session_id, protocol, system_parts, tools, options_hash, options_keys, message_prefixes, body_hash, created, cache_control, fingerprint_version, policy_version, system_hash) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[{\"target\":\"system[0]\",\"type\":\"ephemeral\"}]', ?, ?, 'system-wire')",
  )
  const insertFact = rawDb.prepare("insert into context_fact (session_id, at, kind, detail) values (?, ?, ?, ?)")

  const baseTime = 1_000_000

  for (let s = 0; s < SESSIONS; s++) {
    const sess = sessions[s]!
    insertSession.run(
      sess.id,
      sess.parentId,
      "/project",
      `Session ${sess.id}`,
      "build",
      baseTime,
      baseTime + REQUESTS * 1000,
    )
    insertFact.run(sess.id, baseTime + 50_000, "warming", JSON.stringify({ state: "on", until: baseTime + 200_000 }))

    for (let r = 0; r < REQUESTS; r++) {
      const reqId = `req_${sess.id}_${r}`
      const msgId = `msg_${sess.id}_${r}`
      const started = baseTime + r * 1000
      const isPing = r % 20 === 19
      const kind = isPing ? "ping" : "step"
      const cacheRead = r === 0 ? 0 : 2500
      const cacheWrite = r === 0 ? 3000 : 500
      const input = r === 0 ? 3000 : 500

      insertRequest.run(
        reqId,
        sess.id,
        msgId,
        kind,
        0,
        "build",
        "anthropic",
        "claude-3-7",
        started,
        started + 500,
        500,
        "completed",
        input,
        150,
        20,
        cacheRead,
        cacheWrite,
        0.01,
        started,
      )

      insertFp.run(
        reqId,
        sess.id,
        "anthropic-messages",
        systemPartsJson,
        "[]",
        "",
        "{}",
        messagePrefixesJson,
        `body_${reqId}`,
        started,
        FINGERPRINT_VERSION,
        FINGERPRINT_POLICY_VERSION,
      )
    }
  }

  rawDb.exec("COMMIT")
  console.log(`Build took: ${performance.now() - startBuild}ms`)

  const testSessionID = sessions[0]!.id

  const cases = [
    {
      name: "session overview",
      input: { scope: "session" as const, sessionID: testSessionID, view: "overview" as const },
    },
    { name: "session cache", input: { scope: "session" as const, sessionID: testSessionID, view: "cache" as const } },
    { name: "tree overview", input: { scope: "tree" as const, sessionID: testSessionID, view: "overview" as const } },
    { name: "tree cache", input: { scope: "tree" as const, sessionID: testSessionID, view: "cache" as const } },
    { name: "all overview", input: { scope: "all" as const, view: "overview" as const } },
    { name: "all cache", input: { scope: "all" as const, view: "cache" as const } },
  ]

  // Warmup / First call
  const firstTimes: Record<string, number> = {}
  for (const c of cases) {
    const t0 = performance.now()
    console.log(`Starting first ${c.name}...`)
    const res = queryMonitor(db, c.input, { directory: "/project" })
    const elapsed = performance.now() - t0
    console.log(`Done first ${c.name}: ${elapsed}ms`)
    firstTimes[c.name] = elapsed
    expect(res.totals.requests).toBeGreaterThan(0)
  }

  // Repeat polling (TUI polling interval 1-5s)
  const repeatTimes: Record<string, number> = {}
  for (const c of cases) {
    const t0 = performance.now()
    const res = queryMonitor(db, c.input, { directory: "/project" })
    const elapsed = performance.now() - t0
    repeatTimes[c.name] = elapsed
    expect(res.totals.requests).toBeGreaterThan(0)
  }

  console.log("SYNTHETIC BENCHMARK RESULTS (first query):", JSON.stringify(firstTimes, null, 2))
  console.log("SYNTHETIC BENCHMARK RESULTS (repeat poll):", JSON.stringify(repeatTimes, null, 2))

  // Assert retained performance across repeat queries (repairing #22: previously 8155–8206ms)
  expect(repeatTimes["all overview"]!).toBeLessThan(1000)
  expect(repeatTimes["all cache"]!).toBeLessThan(1000)

  // Advancing-clock repeat polls on the 200×200 ledger: prove cold+3 repeat polls cheap
  const advancingPolls = [baseTime + 310_000, baseTime + 330_000, baseTime + 360_000]
  const advancingTimes: number[] = []
  const advancingUnread: number[] = []
  for (const now of advancingPolls) {
    const t0 = performance.now()
    const res = queryMonitor(db, { scope: "all", view: "overview" }, { directory: "/project", now })
    const elapsed = performance.now() - t0
    advancingTimes.push(elapsed)
    advancingUnread.push(res.unread ?? 0)
    expect(res.totals.requests).toBe(40000)
  }
  console.log("SYNTHETIC BENCHMARK ADVANCING POLLS:", { advancingTimes, advancingUnread })
  for (const t of advancingTimes) {
    expect(t).toBeLessThan(1000)
  }
  expect(advancingUnread).toEqual([1_100_000, 3_100_000, 6_100_000])
}, 30_000)
