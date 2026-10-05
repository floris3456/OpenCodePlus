import { afterEach, expect, test } from "bun:test"
import { commandHead, split, targetOf } from "../src/monitor/attribution.js"
import { errorFingerprint, sha256 } from "../src/monitor/fingerprint.js"
import type { Ledger, SessionFacts } from "../src/monitor/ledger.js"
import { queryMonitor } from "../src/monitor/query.js"
import { parseDuration } from "../src/monitor/tools.js"
import { cleanupLedgers, collect, ledger, script, usage } from "./monitor-fixture.js"

afterEach(cleanupLedgers)

function call(target: Ledger, callID: string) {
  return target.db.query<Record<string, unknown>, [string]>("select * from call where call_id = ?").get(callID)
}

test("a tool step's output is split by size and its results are measured from the next prompt", async () => {
  const db = await ledger()
  const clock = { now: 1_000 }
  const s = script("ses_a", clock)
  s.created({ agent: "build" })
  s.step("m1")
  s.text("m1", "x".repeat(100))
  s.call("m1", "c1", "read", { path: "/work/project/src/a.ts" })
  s.call("m1", "c2", "shell", {
    command: "cd packages/plus && TOKEN=secret bun test test/a.test.ts --flag",
    workdir: "/work/project",
  })
  s.at(5)
  s.ok("m1", "c1", "a".repeat(3000))
  s.at(20)
  s.ok("m1", "c2", "b".repeat(1000))
  // 200 visible output tokens; the prompt was 10 000.
  s.end("m1", "tool-calls", usage(1_000, 200, 9_000))
  s.step("m2")
  // Next prompt: 10 000 + 200 (m1's output) + 1 600 (the two results).
  s.end("m2", "stop", usage(1_000, 50, 10_800))
  const collector = collect(db, clock)
  s.events.forEach((event) => collector.observe(event))

  const read = call(db, "c1")
  const shell = call(db, "c2")
  // Results: 1 600 tokens split 3:1 by result size, measured.
  expect(read?.result_tokens).toBe(1_200)
  expect(shell?.result_tokens).toBe(400)
  expect(read?.measured).toBe(1)
  // Output: split across text (100 chars) and each call's input size; whole tokens summing to 200.
  const inputs = [
    100,
    JSON.stringify({ path: "/work/project/src/a.ts" }).length,
    JSON.stringify({
      command: "cd packages/plus && TOKEN=secret bun test test/a.test.ts --flag",
      workdir: "/work/project",
    }).length,
  ]
  expect([read?.call_tokens, shell?.call_tokens]).toEqual(split(200, inputs).slice(1))
  // Targets say what was touched, never the full command or its secrets.
  expect(read?.target).toBe("src/a.ts")
  expect(shell?.target).toBe("bun test")
  expect(JSON.stringify(db.db.query("select * from call").all())).not.toContain("secret")
  expect(read?.ended).toBe(1_005)
  expect(shell?.status).toBe("completed")

  const report = queryMonitor(db, { scope: "all", feed: 5 }, { now: clock.now })
  expect(report.totals).toMatchObject({
    steps: 2,
    calls: 2,
    errors: 0,
    running: 0,
    input: 2_000,
    output: 250,
    cacheRead: 19_800,
    callTokens: 200 - split(200, inputs)[0]!,
    resultTokens: 1_600,
  })
  // One later step re-read both results.
  expect(report.totals.carried).toBe(1_600)
  expect(report.groups.map((group) => [group.key, group.calls, group.resultTokens, group.estimated])).toEqual([
    ["read", 1, 1_200, 0],
    ["shell", 1, 400, 0],
  ])
  expect(report.feed.map((entry) => entry.callID)).toEqual(["c2", "c1"])
})

test("results are estimated, not measured, when a user message, a compaction or no next step intervenes", async () => {
  const db = await ledger()
  const clock = { now: 1 }
  const s = script("ses_b", clock)
  s.step("m1")
  s.call("m1", "c1", "grep", { pattern: "needle" })
  s.ok("m1", "c1", "r".repeat(250))
  s.end("m1", "tool-calls", usage(100, 10, 1_000))
  s.user()
  s.step("m2")
  s.end("m2", "tool-calls", usage(100, 10, 9_000))
  const collector = collect(db, clock)
  s.events.forEach((event) => collector.observe(event))
  // 250 chars at 2.5 chars per token, and not measured against the inflated prompt.
  expect(call(db, "c1")).toMatchObject({ result_tokens: 100, measured: 0 })

  const t = script("ses_b", clock)
  t.step("m3")
  t.call("m3", "c3", "grep", { pattern: "x" })
  t.ok("m3", "c3", "r".repeat(25))
  t.end("m3", "tool-calls", usage(100, 10, 1_000))
  t.compact(usage(5_000, 300))
  t.step("m4")
  t.end("m4", "stop", usage(100, 10, 2_000))
  t.events.forEach((event) => collector.observe(event))
  expect(call(db, "c3")).toMatchObject({ result_tokens: 10, measured: 0 })
  // The compaction is a step of its own, in a new epoch.
  const steps = db.db
    .query<{ kind: string; idx: number; epoch: number }, []>("select kind, idx, epoch from step order by idx")
    .all()
  expect(steps).toEqual([
    { kind: "step", idx: 0, epoch: 0 },
    { kind: "step", idx: 1, epoch: 0 },
    { kind: "step", idx: 2, epoch: 0 },
    { kind: "compaction", idx: 3, epoch: 1 },
    { kind: "step", idx: 4, epoch: 1 },
  ])
  // Carried stops at the compaction: c3's step (idx 2) is the last of its epoch.
  const report = queryMonitor(db, { scope: "all", feed: 10 }, { now: clock.now })
  expect(report.feed.find((entry) => entry.callID === "c3")?.carried).toBe(0)
  // c1 (idx 0) was re-read by steps 1 and 2.
  expect(report.feed.find((entry) => entry.callID === "c1")?.carried).toBe(200)
  expect(report.totals.steps).toBe(5)
  expect(report.totals.input).toBe(5_400)
})

test("observing every event twice writes the same ledger", async () => {
  const once = await ledger()
  const twice = await ledger()
  const build = () => {
    const clock = { now: 10 }
    const s = script("ses_c", clock)
    s.step("m1")
    s.call("m1", "c1", "read", { path: "a" })
    s.ok("m1", "c1", "z".repeat(400))
    s.end("m1", "tool-calls", usage(10, 20, 100))
    s.step("m2")
    s.end("m2", "stop", usage(10, 5, 300))
    return { clock, events: s.events }
  }
  const a = build()
  const first = collect(once, a.clock)
  a.events.forEach((event) => first.observe(event))
  const b = build()
  const second = collect(twice, b.clock)
  const third = collect(twice, b.clock)
  b.events.forEach((event) => {
    second.observe(event)
    third.observe(event)
  })
  const rows = (target: Ledger) => ({
    calls: target.db
      .query(
        "select session_id, call_id, tool, status, call_tokens, result_tokens, measured, idx, epoch from call order by call_id",
      )
      .all(),
    steps: target.db
      .query("select session_id, message_id, idx, epoch, input, output, cache_read from step order by idx")
      .all(),
  })
  expect(rows(twice)).toEqual(rows(once))
})

test("a restarted collector continues the session's step order", async () => {
  const db = await ledger()
  const clock = { now: 1 }
  const s = script("ses_d", clock)
  s.step("m1")
  s.end("m1", "stop", usage(1, 1))
  collect(db, clock).observe(s.events[0]!)
  collect(db, clock).observe(s.events[1]!)
  const t = script("ses_d", clock)
  t.step("m2")
  t.end("m2", "stop", usage(1, 1))
  const restarted = collect(db, clock)
  t.events.forEach((event) => restarted.observe(event))
  expect(db.db.query("select message_id, idx from step order by idx").all()).toEqual([
    { message_id: "m1", idx: 0 },
    { message_id: "m2", idx: 1 },
  ])
})

test("Code Mode calls are listed under their execute call, which carries the tokens", async () => {
  const db = await ledger()
  const clock = { now: 1 }
  const s = script("ses_e", clock)
  s.step("m1", "release")
  s.call("m1", "c1", "execute", { code: "await tools.instructions.list({})" })
  s.ok("m1", "c1", "x".repeat(500), {
    toolCalls: [
      { tool: "instructions.list", status: "completed", input: { where: "kind:agent" } },
      { tool: "instructions.delete", status: "error", input: { id: "agent:preset:x", confirm: true } },
      { tool: "instructions.delete", status: "error", input: { id: "agent:preset:y" } },
    ],
  })
  s.end("m1", "stop", usage(10, 40))
  const collector = collect(db, clock)
  s.events.forEach((event) => collector.observe(event))
  expect(call(db, "c1")?.target).toBe("instructions.list, instructions.delete")
  const report = queryMonitor(db, { scope: "all" }, { now: clock.now })
  expect(report.totals.calls).toBe(1)
  expect(report.totals.errors).toBe(0)
  const byTool = Object.fromEntries(report.groups.map((group) => [group.key, group]))
  expect(byTool["execute"]).toMatchObject({ calls: 1, inner: 0, callTokens: 40 })
  expect(byTool["instructions.delete"]).toMatchObject({ calls: 0, inner: 2, errors: 2, callTokens: 0 })
  // Filtering by an inner tool finds who used it.
  const deletes = queryMonitor(
    db,
    { scope: "all", tools: ["instructions.delete"], group: "target" },
    { now: clock.now },
  )
  expect(deletes.groups.map((group) => group.key)).toEqual([
    "instructions.delete agent:preset:x",
    "instructions.delete agent:preset:y",
  ])
})

test("a malformed call that fails without being called is still recorded", async () => {
  const db = await ledger()
  const clock = { now: 1 }
  const s = script("ses_f", clock)
  s.step("m1")
  s.events.push({
    type: "session.tool.input.started",
    data: { sessionID: "ses_f", assistantMessageID: "m1", id: "c1", name: "edit" },
    created: clock.now,
  })
  s.fail("m1", "c1", "Invalid input for tool edit")
  s.end("m1", "tool-calls", usage(1, 3))
  const collector = collect(db, clock)
  s.events.forEach((event) => collector.observe(event))
  const recorded = call(db, "c1")
  expect(recorded).toMatchObject({ tool: "edit", status: "error" })
  // The error is hashed at the ledger boundary: size and hash, never its text.
  expect(JSON.parse(String(recorded?.error))).toEqual(JSON.parse(errorFingerprint({ type: "tool", message: "Invalid input for tool edit" })))
  expect(String(recorded?.error)).not.toContain("Invalid input")
})

test("every stored call column refuses content sentinels while useful names remain", async () => {
  const db = await ledger()
  const clock = { now: 1 }
  const collector = collect(db, clock)
  const s = script("ses_privacy", clock)
  s.created({ agent: "build" })
  s.step("m1", "build")
  // Known file, known host and known program controls.
  s.call("m1", "c_read", "read", { path: "/work/project/src/a.ts" })
  s.ok("m1", "c_read", "ok")
  s.call("m1", "c_fetch", "webfetch", { url: "https://known.example.com/doc" })
  s.ok("m1", "c_fetch", "ok")
  s.call("m1", "c_shell", "shell", { command: "cd /work && git diff --cached" })
  s.ok("m1", "c_shell", "ok")
  // An unknown lower-case second word to a recognized 2-word program is a
  // payload, not a subcommand: later commits may hold a fictional secret there.
  s.call("m1", "c_gitsub", "shell", { command: "git fictional_private_payload_sentinel" })
  s.ok("m1", "c_gitsub", "ok")
  s.call("m1", "c_echosub", "shell", { command: "echo fictional_lowercase_payload_sentinel" })
  s.ok("m1", "c_echosub", "ok")
  // A failed tool whose message carries a fictional sentinel.
  s.call("m1", "c_fail", "shell", { command: "echo FICTIONAL_SHELL_PAYLOAD_SENTINEL" })
  s.fail("m1", "c_fail", "FICTIONAL_PRIVATE_ERROR_SENTINEL")
  // A grep pattern and a websearch query are content searches.
  s.call("m1", "c_grep", "grep", { pattern: "FICTIONAL_SEARCH_SENTINEL" })
  s.ok("m1", "c_grep", "ok")
  s.call("m1", "c_web", "websearch", { query: "FICTIONAL_QUERY_SENTINEL" })
  s.ok("m1", "c_web", "ok")
  // An unknown Code Mode tool whose first argument is a secret-ish payload.
  s.call("m1", "c_exec", "execute", { code: "await tools.mystery.send({ payload: 'FICTIONAL_PAYLOAD_SENTINEL' })" })
  s.ok("m1", "c_exec", "ok", {
    toolCalls: [
      { tool: "mystery.send", status: "completed", input: { payload: "FICTIONAL_PAYLOAD_SENTINEL" } },
      // Known instructions/team identifiers may be named explicitly.
      { tool: "instructions.delete", status: "error", input: { id: "agent:project:known-row" } },
    ],
  })
  s.end("m1", "stop", usage(10, 40))
  s.events.forEach((event) => collector.observe(event))

  const all = (table: string) => JSON.stringify(db.db.query(`select * from ${table}`).all())
  const stored = ["session", "step", "call", "call_hour", "epoch", "mark", "meta", "request", "request_fingerprint", "context_fact"]
    .map((table) => all(table))
    .join("\n")
  for (const sentinel of [
    "FICTIONAL_PRIVATE_ERROR_SENTINEL",
    "FICTIONAL_SHELL_PAYLOAD_SENTINEL",
    "FICTIONAL_SEARCH_SENTINEL",
    "FICTIONAL_QUERY_SENTINEL",
    "FICTIONAL_PAYLOAD_SENTINEL",
    "fictional_private_payload_sentinel",
    "fictional_lowercase_payload_sentinel",
  ])
    expect(stored).not.toContain(sentinel)

  // Controls: useful names, paths, hosts, programs and known ids remain.
  expect(call(db, "c_read")?.target).toBe("src/a.ts")
  expect(call(db, "c_fetch")?.target).toBe("known.example.com")
  expect(call(db, "c_shell")?.target).toBe("git diff")
  expect(call(db, "c_gitsub")?.target).toBe("git")
  expect(call(db, "c_echosub")?.target).toBe("echo")
  expect(call(db, "c_fail")?.target).toBe("echo")
  expect(call(db, "c_grep")?.target).toBe(
    `${sha256("FICTIONAL_SEARCH_SENTINEL")} ${"FICTIONAL_SEARCH_SENTINEL".length}c`,
  )
  expect(call(db, "c_web")?.target).toBe(`${sha256("FICTIONAL_QUERY_SENTINEL")} ${"FICTIONAL_QUERY_SENTINEL".length}c`)
  // The failed call's error is stored as a hash and size, not its text.
  const failedError = JSON.parse(String(call(db, "c_fail")?.error))
  expect(failedError).toEqual(JSON.parse(errorFingerprint({ type: "tool", message: "FICTIONAL_PRIVATE_ERROR_SENTINEL" })))
  expect(String(call(db, "c_fail")?.error)).not.toContain("FICTIONAL")
  // The unknown inner tool is omitted; the known instructions id is named.
  const inner = db.db
    .query<{ call_id: string; tool: string; target: string | null }, []>(
      "select call_id, tool, target from call where parent_call = 'c_exec' order by call_id",
    )
    .all()
  expect(inner).toEqual([
    { call_id: "c_exec#0", tool: "mystery.send", target: null },
    { call_id: "c_exec#1", tool: "instructions.delete", target: "agent:project:known-row" },
  ])
  // Totals and attribution are unchanged by the hashing.
  const report = queryMonitor(db, { scope: "all", feed: 20 }, { now: clock.now })
  expect(report.totals).toMatchObject({ steps: 1, calls: 9, errors: 1 })
})

test("callEnded hashes an error at the ledger boundary so alternate callers cannot leak text", async () => {
  const db = await ledger()
  const collector = collect(db, { now: 1 })
  const s = script("ses_boundary", { now: 1 })
  s.created({ agent: "build" })
  s.step("m1")
  s.call("m1", "c1", "read", { path: "a" })
  s.ok("m1", "c1", "ok")
  s.end("m1", "stop", usage(1, 1))
  s.events.forEach((event) => collector.observe(event))
  // A caller writing straight through the ledger must still be refused raw text.
  db.callEnded({ sessionID: "ses_boundary", callID: "c1", status: "error", error: "RAW_PRIVATE_BOUNDARY_SENTINEL", ended: 2, resultChars: 0, resultTokens: 0 })
  const row = call(db, "c1")
  expect(JSON.parse(String(row?.error))).toEqual(JSON.parse(errorFingerprint("RAW_PRIVATE_BOUNDARY_SENTINEL")))
  expect(JSON.stringify(db.db.query("select * from call").all())).not.toContain("RAW_PRIVATE_BOUNDARY_SENTINEL")
})

test("session scope is only the chat; tree reaches the topmost root and all descendants", async () => {
  const db = await ledger()
  const clock = { now: 1 }
  // A team run is created without a host parent; the resolver names its delegating session.
  const resolve = async (id: string): Promise<SessionFacts | undefined> =>
    id === "ses_run" ? { id, parentID: "ses_child", runID: "run_1", role: "implementer" } : undefined
  const collector = collect(db, clock, { resolve })
  const root = script("ses_root", clock)
  root.created({ agent: "build" })
  root.step("r1")
  root.call("r1", "c_root", "subagent", { agent: "general" })
  root.ok("r1", "c_root", "done")
  root.end("r1", "stop", usage(1, 1))
  const child = script("ses_child", clock)
  child.created({ agent: "general", parentID: "ses_root" })
  child.step("k1", "general")
  child.call("k1", "c_child", "read", { path: "x" })
  child.ok("k1", "c_child", "y")
  child.end("k1", "stop", usage(1, 1))
  const run = script("ses_run", clock)
  run.created({ agent: "implementer", location: { directory: "/work/worktree" } })
  run.step("w1", "implementer")
  run.call("w1", "c_run", "edit", { path: "z" })
  run.ok("w1", "c_run", "ok")
  run.end("w1", "stop", usage(1, 1))
  const other = script("ses_other", clock)
  other.created({ agent: "plan" })
  other.step("o1", "plan")
  other.call("o1", "c_other", "grep", { pattern: "p" })
  other.ok("o1", "c_other", "q")
  other.end("o1", "stop", usage(1, 1))
  ;[...root.events, ...child.events, ...run.events, ...other.events].forEach((event) => collector.observe(event))
  await collector.settle()
  const ids = (report: ReturnType<typeof queryMonitor>) => report.feed.map((entry) => entry.callID).sort()
  expect(ids(queryMonitor(db, { scope: "session", sessionID: "ses_root", feed: 20 }, { now: clock.now }))).toEqual([
    "c_root",
  ])
  expect(ids(queryMonitor(db, { scope: "session", sessionID: "ses_child", feed: 20 }, { now: clock.now }))).toEqual([
    "c_child",
  ])
  expect(ids(queryMonitor(db, { scope: "tree", sessionID: "ses_run", feed: 20 }, { now: clock.now }))).toEqual(["c_child", "c_root", "c_run"])
  expect(ids(queryMonitor(db, { scope: "project", feed: 20 }, { directory: "/work/project", now: clock.now }))).toEqual(
    ["c_child", "c_other", "c_root", "c_run"],
  )
  // A session scope without a session reads nothing, never everything.
  expect(ids(queryMonitor(db, { scope: "session", feed: 20 }, { now: clock.now }))).toEqual([])
  expect(db.db.query("select run_id, role, parent_id from session where id = 'ses_run'").get()).toEqual({
    run_id: "run_1",
    role: "implementer",
    parent_id: "ses_child",
  })
})

test("filters narrow calls and steps, facets ignore them, and a comparison reads another window", async () => {
  const db = await ledger()
  const clock = { now: 1_000 }
  const collector = collect(db, clock, { config: "cfg-a" })
  const a = script("ses_g", clock)
  a.step("m1", "build")
  a.call("m1", "c1", "read", { path: "a" })
  a.ok("m1", "c1", "x".repeat(25))
  a.call("m1", "c2", "shell", { command: "git status" })
  a.fail("m1", "c2", "exit 1")
  a.end("m1", "stop", usage(10, 10))
  a.events.forEach((event) => collector.observe(event))
  clock.now = 5_000
  const later = collect(db, clock, { config: "cfg-b" })
  const b = script("ses_g", clock)
  b.step("m2", "explore", { id: "m2", providerID: "q" })
  b.call("m2", "c3", "read", { path: "b" })
  b.ok("m2", "c3", "x".repeat(50))
  b.end("m2", "stop", usage(20, 20))
  b.events.forEach((event) => later.observe(event))

  const explore = queryMonitor(db, { scope: "all", agents: ["explore"] }, { now: clock.now })
  expect(explore.totals).toMatchObject({ calls: 1, steps: 1, input: 20 })
  expect([...explore.facets.agents].sort()).toEqual(["build", "explore"])
  const errors = queryMonitor(db, { scope: "all", errors: true, feed: 10 }, { now: clock.now })
  expect(errors.feed.map((entry) => [entry.callID, JSON.parse(String(entry.error))])).toEqual([
    ["c2", JSON.parse(errorFingerprint({ type: "tool", message: "exit 1" }))],
  ])
  expect(errors.feed[0]?.error).not.toContain("exit 1")
  const models = queryMonitor(db, { scope: "all", models: ["q/m2"] }, { now: clock.now })
  expect(models.totals).toMatchObject({ calls: 1, steps: 1 })
  const byConfig = queryMonitor(db, { scope: "all", group: "config" }, { now: clock.now })
  expect(byConfig.groups.map((group) => [group.key, group.calls]).sort()).toEqual([
    ["cfg-a", 2],
    ["cfg-b", 1],
  ])
  const compared = queryMonitor(
    db,
    { scope: "all", since: 4_000, compare: { since: 0, until: 4_000 } },
    { now: clock.now },
  )
  expect(compared.totals.calls).toBe(1)
  expect(compared.compare?.totals.calls).toBe(2)
  expect(compared.compare?.groups.map((group) => group.key).sort()).toEqual(["read", "shell"])
})

test("marks are recorded and listed; retention drops old rows only", async () => {
  const db = await ledger()
  const clock = { now: 100 }
  const collector = collect(db, clock)
  const s = script("ses_h", clock)
  s.step("m1")
  s.call("m1", "c1", "read", { path: "a" })
  s.ok("m1", "c1", "a")
  s.end("m1", "stop", usage(1, 1))
  s.events.forEach((event) => collector.observe(event))
  clock.now = 10_000
  const t = script("ses_h", clock)
  t.step("m2")
  t.call("m2", "c2", "read", { path: "b" })
  t.ok("m2", "c2", "b")
  t.end("m2", "stop", usage(1, 1))
  t.events.forEach((event) => collector.observe(event))
  db.mark("before prompt change", 50)
  db.mark("after", 9_000)
  db.prune(1_000)
  const report = queryMonitor(db, { scope: "all", feed: 10 }, { now: clock.now })
  expect(report.feed.map((entry) => entry.callID)).toEqual(["c2"])
  expect(report.marks.map((mark) => mark.label)).toEqual(["after"])
})

test("targets name what a call touched without contents or secrets", () => {
  expect(commandHead("cd /x && FOO=bar git push origin main")).toBe("git push")
  expect(commandHead("grep -n secret file")).toBe("grep")
  expect(commandHead("/usr/bin/python3 script.py")).toBe("python3")
  expect(commandHead("curl -H 'Authorization: Bearer abc' https://x")).toBe("curl")
  expect(commandHead("cd only")).toBeUndefined()
  // Only a program's recognized subcommand is kept; a payload word is not.
  expect(commandHead("git diff HEAD")).toBe("git diff")
  expect(commandHead("cd /x && git push origin main")).toBe("git push")
  expect(commandHead("bun test test/a.ts")).toBe("bun test")
  expect(commandHead("echo FICTIONAL_SHELL_PAYLOAD_SENTINEL")).toBe("echo")
  expect(commandHead("echo fictional_lowercase_payload_sentinel")).toBe("echo")
  // A recognized 2-word program still refuses an unknown lower-case argument.
  expect(commandHead("git fictional_private_payload_sentinel")).toBe("git")
  expect(commandHead("bun fictional_private_payload_sentinel")).toBe("bun")
  expect(commandHead("curl https://x/FICTIONAL_TOKEN_SENTINEL")).toBe("curl")
  expect(commandHead("curl -H 'Authorization: Bearer abc' https://x")).toBe("curl")
  expect(commandHead("mysterytool subcommand")).toBe("mysterytool")
  expect(targetOf("webfetch", { url: "https://example.com/path?token=abc" })).toBe("example.com")
  // A glob names files; a grep pattern names content and becomes a hash + size.
  expect(targetOf("glob", { pattern: "src/**/*.ts" })).toBe("src/**/*.ts")
  expect(targetOf("grep", { pattern: "FICTIONAL_SEARCH_SENTINEL" })).toBe(
    `${sha256("FICTIONAL_SEARCH_SENTINEL")} ${"FICTIONAL_SEARCH_SENTINEL".length}c`,
  )
  expect(
    targetOf("patch", { patchText: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n*** Add File: src/b.ts\n" }),
  ).toBe("src/a.ts +1")
  expect(targetOf("write", { path: "/elsewhere/file.ts", content: "secret" }, "/work")).toBe("/elsewhere/file.ts")
  expect(targetOf("read", { path: `/work/${"d/".repeat(60)}f.ts` }, "/work")?.length).toBe(80)
  expect(targetOf("question", { questions: [] })).toBeUndefined()
})

test("split keeps whole tokens that sum to the total", () => {
  expect(split(10, [1, 1, 1])).toEqual([4, 3, 3])
  expect(split(7, [0, 0])).toEqual([4, 3])
  expect(split(0, [5])).toEqual([0])
  expect(split(100, [])).toEqual([])
  expect(split(1_000, [3, 1]).reduce((a, b) => a + b, 0)).toBe(1_000)
})

test("durations parse strictly", () => {
  expect(parseDuration("30m")).toBe(1_800_000)
  expect(parseDuration("1h30m")).toBe(5_400_000)
  expect(parseDuration("7d")).toBe(604_800_000)
  expect(parseDuration("soon")).toBeUndefined()
  expect(parseDuration("5 minutes")).toBeUndefined()
})

test("the hourly rollup answers exactly what the raw calls answer, through updates and pruning", async () => {
  const db = await ledger()
  const hour = 3_600_000
  const start = 1_000 * hour + 1_234
  const clock = { now: start }
  const collector = collect(db, clock)
  const tools = ["read", "shell", "grep", "edit"]
  // Deterministic pseudo-random sessions over three days, with compactions and failures.
  let seed = 7
  const next = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
    return seed / 2_147_483_648
  }
  for (let session = 0; session < 12; session++) {
    clock.now = start + Math.floor(next() * 60 * hour)
    const s = script(`ses_${session}`, clock)
    let prompt = 1_000
    for (let step = 0; step < 25; step++) {
      s.at(Math.floor(next() * 20 * 60_000))
      s.step(`m${step}`, session % 3 === 0 ? "explore" : "build")
      const calls = 1 + Math.floor(next() * 3)
      for (let index = 0; index < calls; index++) {
        const id = `c${step}_${index}`
        s.call(`m${step}`, id, tools[Math.floor(next() * tools.length)]!, { path: `f${index}` })
        s.at(Math.floor(next() * 5_000))
        if (next() < 0.1) s.fail(`m${step}`, id, "boom")
        else s.ok(`m${step}`, id, "r".repeat(Math.floor(next() * 3_000)))
      }
      prompt += 200 + Math.floor(next() * 2_000)
      s.end(`m${step}`, "tool-calls", usage(100, 50, prompt))
      if (step === 12 && session % 4 === 0) s.compact(usage(10, 10))
    }
    s.events.forEach((event) => collector.observe(event))
  }
  const now = start + 80 * hour
  const check = (since: number, until: number) => {
    const query = { scope: "all" as const, since, until, top: 500 }
    const byTool = queryMonitor(db, { ...query, group: "tool" }, { now })
    // Grouping by target always reads raw calls; summed per tool it must match the rollup's answer.
    const byTarget = queryMonitor(db, { ...query, group: "target" }, { now })
    const fold = new Map<string, number[]>()
    byTarget.groups.forEach((group) => {
      const tool = group.key.split(" ")[0]!
      const sum = fold.get(tool) ?? [0, 0, 0, 0, 0, 0]
      ;[group.calls, group.errors, group.callTokens, group.resultTokens, group.carried, group.estimated].forEach(
        (value, index) => {
          sum[index]! += value
        },
      )
      fold.set(tool, sum)
    })
    expect(
      Object.fromEntries(
        byTool.groups.map((group) => [
          group.key,
          [group.calls, group.errors, group.callTokens, group.resultTokens, group.carried, group.estimated],
        ]),
      ),
    ).toEqual(Object.fromEntries(fold))
    // Totals agree with the groups they summarise.
    expect(byTool.totals.calls).toBe(byTool.groups.reduce((sum, group) => sum + group.calls, 0))
    expect(byTool.totals.carried).toBe(byTool.groups.reduce((sum, group) => sum + group.carried, 0))
    return byTool.totals.calls
  }
  // Odd edges inside hours, whole days, and everything.
  expect(check(start + 5 * hour + 17_000, start + 41 * hour + 3_000)).toBeGreaterThan(0)
  expect(check(start, start + 24 * hour)).toBeGreaterThan(0)
  expect(check(0, now)).toBeGreaterThan(200)
  db.prune(start + 30 * hour)
  expect(check(0, now)).toBeGreaterThan(0)
  const rolled = db.db.query<{ calls: number }, []>("select sum(calls) as calls from call_hour").get()?.calls
  const raw = db.db
    .query<{ calls: number }, []>("select count(*) as calls from call where parent_call is null")
    .get()?.calls
  expect(rolled).toBe(raw)
})
