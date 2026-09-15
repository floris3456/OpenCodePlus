import { afterEach, expect, test } from "bun:test"
import { Effect, Exit, Schema } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { formatMarkdown } from "../src/agents/files.js"
import { userBaseFile } from "../src/agents/base.js"
import { createHandlers, createPlusApi, createState } from "../src/index.js"
import { fingerprint } from "../src/instructions/model.js"
import { memoInputOf } from "../src/instructions/snapshot.js"
import { resolveReview, saveText } from "../src/instructions/ops.js"
import { expandedTree } from "../src/instructions/tree.js"
import { append, read } from "../src/instructions/log.js"
import { globalLogPath, projectLogPath, projectTeamsPath } from "../src/instructions/paths.js"
import { load } from "../src/instructions/store.js"
import { enable } from "../src/project.js"
import { Plus } from "../src/rpc.js"
import { agentInfo, fullContext, skillInfo } from "./harness.js"

const UPDATED = "2026-01-01T00:00:00.000Z"

const roots: string[] = []
const priorConfigDir = process.env.OPENCODE_CONFIG_DIR

afterEach(async () => {
  if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function tempRoot(): Promise<{ project: string }> {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-log-"))
  roots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  return { project: path.join(root, "project") }
}

interface CapturedError {
  type: string
  message: string
  data?: unknown
}

function throwingContext(captured: { current?: CapturedError }): {
  error: (type: string, message: string, data?: unknown) => never
} {
  return {
    error: (type, message, data) => {
      const failure: CapturedError = data === undefined ? { type, message } : { type, message, data }
      captured.current = failure
      throw failure
    },
  }
}

async function expectDeclaredError(
  effect: Effect.Effect<unknown, unknown>,
  captured: { current?: CapturedError },
  type: string,
): Promise<void> {
  const exit = await Effect.runPromiseExit(effect)
  expect(Exit.isFailure(exit)).toBe(true)
  expect(captured.current?.type).toBe(type)
}

// Core serves RPC results as JSON through HttpApi, whose success schema is
// the canonical JSON codec of RpcOutput. Unknown encodes to Json on that
// path, so a present-but-undefined key fails with "Expected JSON value".
const RpcBody = Schema.toCodecJson(Schema.Struct({ output: Schema.optionalKey(Schema.Unknown) }))

function expectRpcBody(value: unknown) {
  expect(() => Schema.encodeUnknownSync(RpcBody)({ output: value })).not.toThrow()
}

function record(item: string, overrides?: Partial<Plus.SnapshotCustomizationRecord>): Plus.SnapshotCustomizationRecord {
  return {
    type: "customization",
    level: "project",
    agent: "alpha",
    item,
    section: null,
    basedOn: fingerprint("upstream"),
    updated: UPDATED,
    ...overrides,
  }
}

async function linesOf(target: string): Promise<string[]> {
  const file = Bun.file(target)
  if (!(await file.exists())) return []
  return (await file.text()).split("\n").filter((line) => line.length > 0)
}

function projectLines(project: string): Promise<string[]> {
  return linesOf(projectLogPath(project))
}

function globalLines(): Promise<string[]> {
  return linesOf(globalLogPath())
}

async function writeTeamAgent(teamDir: string, id: string, body = "role"): Promise<void> {
  const target = path.join(teamDir, `${id}.md`)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await Bun.write(target, formatMarkdown({ description: id }, body))
}

test("mutate appends one line with actor tui by default and tool when provided", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const handlers = createHandlers(fullContext({ directory: project }), createState())
  const first = await Effect.runPromise(
    handlers["instructions.mutate"]({ expectedRevision: 0, expectedGlobalRevision: 0, records: [record("tool:a", { text: "first" })] }, throwingContext({})),
  )
  expect(first.ok).toBe(true)
  if (!first.ok) throw new Error("expected mutate to succeed")
  expect(await projectLines(project)).toHaveLength(1)
  const tui = JSON.parse((await projectLines(project))[0] ?? "")
  expect(tui.actor).toEqual({ type: "tui" })
  expect(tui.op).toBe("mutate")
  expect(tui.target).toBe("item:project:alpha:tool:a")
  expect(typeof tui.ts).toBe("string")
  expect(Number.isNaN(Date.parse(tui.ts))).toBe(false)
  expect(tui.revision).toBe(1)
  expect(tui.summary.length).toBeLessThanOrEqual(200)

  const second = await Effect.runPromise(
    handlers["instructions.mutate"]({
      expectedRevision: 1,
      expectedGlobalRevision: 0,
      records: [record("tool:a", { text: "second" })],
      actor: { type: "tool", agent: "alpha", sessionID: "ses_1", messageID: "msg_1" },
    }, throwingContext({})),
  )
  expect(second.ok).toBe(true)
  if (!second.ok) throw new Error("expected mutate to succeed")
  expect(await projectLines(project)).toHaveLength(2)
  const tool = JSON.parse((await projectLines(project))[1] ?? "")
  expect(tool.actor).toEqual({ type: "tool", agent: "alpha", sessionID: "ses_1", messageID: "msg_1" })
  expectRpcBody(second)
})

test("a mutation changing both stores logs one line per store; a project-only change logs only the project store", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const handlers = createHandlers(fullContext({ directory: project }), createState())
  const both = await Effect.runPromise(
    handlers["instructions.mutate"]({
      expectedRevision: 0,
      expectedGlobalRevision: 0,
      records: [record("tool:a", { text: "p" }), record("tool:g", { level: "global", agent: "beta", text: "g" })],
    }, throwingContext({})),
  )
  expect(both.ok).toBe(true)
  if (!both.ok) throw new Error("expected mutate to succeed")
  expect(await projectLines(project)).toHaveLength(1)
  expect(await globalLines()).toHaveLength(1)
  expect(JSON.parse((await projectLines(project))[0] ?? "").revision).toBe(1)
  expect(JSON.parse((await globalLines())[0] ?? "").revision).toBe(1)
  expect(JSON.parse((await globalLines())[0] ?? "").target).toBe("item:global:beta:tool:g")

  const projectOnly = await Effect.runPromise(
    handlers["instructions.mutate"]({
      expectedRevision: 1,
      expectedGlobalRevision: 1,
      records: [
        record("tool:a", { text: "p2" }),
        record("tool:g", { level: "global", agent: "beta", text: "g" }),
      ],
    }, throwingContext({})),
  )
  expect(projectOnly.ok).toBe(true)
  if (!projectOnly.ok) throw new Error("expected mutate to succeed")
  expect(await projectLines(project)).toHaveLength(2)
  expect(await globalLines()).toHaveLength(1)
  expect(JSON.parse((await projectLines(project))[1] ?? "").revision).toBe(2)
})

test("an unchanged save appends nothing and an empty log reads as empty", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const handlers = createHandlers(fullContext({ directory: project }), createState())
  const empty = await Effect.runPromise(handlers["instructions.log"]({}, throwingContext({})))
  expect(empty).toEqual({ entries: [], total: 0 })
  expect(await Bun.file(globalLogPath()).exists()).toBe(false)

  const first = await Effect.runPromise(
    handlers["instructions.mutate"]({ expectedRevision: 0, expectedGlobalRevision: 0, records: [record("tool:a", { text: "v" })] }, throwingContext({})),
  )
  expect(first.ok).toBe(true)
  if (!first.ok) throw new Error("expected mutate to succeed")
  const replay = await Effect.runPromise(
    handlers["instructions.mutate"]({
      expectedRevision: first.revision,
      expectedGlobalRevision: first.globalRevision,
      records: [...first.snapshot.records],
    }, throwingContext({})),
  )
  expect(replay.ok).toBe(true)
  if (!replay.ok) throw new Error("expected replay to succeed")
  expect(replay.revision).toBe(first.revision)
  expect(replay.globalRevision).toBe(first.globalRevision)
  expect(await projectLines(project)).toHaveLength(1)
  expect(await Bun.file(globalLogPath()).exists()).toBe(false)
})

test("an unchanged op-level save writes nothing and logs nothing", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("alpha", "upstream role")],
    tools: [{ id: "reader", description: "read things", options: { codemode: false } }],
    skills: [skillInfo("notes", "skill body")],
    session: { hook: () => Effect.succeed({ dispose: Effect.void }) },
  })
  const api = createPlusApi(ctx, createState())
  const snapshot = await api.snapshot()
  if (!snapshot.ok) throw new Error(`snapshot failed: ${snapshot.error.message}`)
  const row = expandedTree(memoInputOf(snapshot.value)).find((candidate) => candidate.address?.item === "tool:reader")
  if (row === undefined) throw new Error("missing reader row")
  const firstOp = saveText(memoInputOf(snapshot.value), row.id, "same text")
  if ("refusal" in firstOp) throw new Error(`expected save: ${firstOp.refusal}`)
  const first = await api.mutate({
    expectedRevision: snapshot.value.revision,
    expectedGlobalRevision: snapshot.value.globalRevision,
    records: [...firstOp.records, ...firstOp.splits] as unknown as Plus.SnapshotRecord[],
    actor: { type: "tui" },
  })
  if (!first.ok || !first.value.ok) throw new Error("expected first mutate to succeed")
  const loggedAfterFirst = await api.log({})
  if (!loggedAfterFirst.ok) throw new Error("log failed")
  expect(loggedAfterFirst.value.total).toBe(1)
  const fresh = await api.snapshot()
  if (!fresh.ok) throw new Error("fresh snapshot failed")
  const secondOp = saveText(memoInputOf(fresh.value), row.id, "same text")
  if ("refusal" in secondOp) throw new Error(`expected second save: ${secondOp.refusal}`)
  expect(secondOp.records).toEqual(fresh.value.records.filter((entry) => entry.type === "customization"))
  const second = await api.mutate({
    expectedRevision: fresh.value.revision,
    expectedGlobalRevision: fresh.value.globalRevision,
    records: [...secondOp.records, ...secondOp.splits] as unknown as Plus.SnapshotRecord[],
    actor: { type: "tui" },
  })
  if (!second.ok || !second.value.ok) throw new Error("expected second mutate to succeed")
  expect(second.value.revision).toBe(first.value.revision)
  expect(second.value.globalRevision).toBe(first.value.globalRevision)
  const loggedAfterSecond = await api.log({})
  if (!loggedAfterSecond.ok) throw new Error("log failed")
  expect(loggedAfterSecond.value.total).toBe(1)
})

test("a repeated identical resolve keep and edit writes no second line and moves no revision", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("alpha", "upstream role")],
    tools: [{ id: "reader", description: "read things", options: { codemode: false } }],
    skills: [skillInfo("notes", "skill body")],
    session: { hook: () => Effect.succeed({ dispose: Effect.void }) },
  })
  const api = createPlusApi(ctx, createState())
  const rowOf = (snapshot: Plus.Snapshot): string => {
    const node = expandedTree(memoInputOf(snapshot)).find((candidate) => candidate.address?.item === "tool:reader")
    if (node === undefined) throw new Error("missing reader row")
    return node.id
  }
  const waitForNextTick = async (after: string): Promise<void> => {
    const start = Date.now()
    while (new Date().toISOString() <= after) {
      if (Date.now() - start > 2000) throw new Error("clock did not advance past prior updated")
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
  }
  const snapshot0 = await api.snapshot()
  if (!snapshot0.ok) throw new Error(`snapshot failed: ${snapshot0.error.message}`)
  const rowId = rowOf(snapshot0.value)
  const seedOp = saveText(memoInputOf(snapshot0.value), rowId, "mine text")
  if ("refusal" in seedOp) throw new Error(`expected seed save: ${seedOp.refusal}`)
  const seeded = await api.mutate({
    expectedRevision: snapshot0.value.revision,
    expectedGlobalRevision: snapshot0.value.globalRevision,
    records: [...seedOp.records, ...seedOp.splits] as unknown as Plus.SnapshotRecord[],
    actor: { type: "tui" },
  })
  if (!seeded.ok || !seeded.value.ok) throw new Error("expected seed mutate to succeed")
  const freshKeep1 = await api.snapshot()
  if (!freshKeep1.ok) throw new Error("fresh snapshot failed")
  const keep1 = resolveReview(memoInputOf(freshKeep1.value), rowOf(freshKeep1.value), "keep")
  if ("refusal" in keep1) throw new Error(`expected first keep: ${keep1.refusal}`)
  const kept1 = await api.mutate({
    expectedRevision: freshKeep1.value.revision,
    expectedGlobalRevision: freshKeep1.value.globalRevision,
    records: [...keep1.records, ...keep1.splits] as unknown as Plus.SnapshotRecord[],
    actor: { type: "tui" },
  })
  if (!kept1.ok || !kept1.value.ok) throw new Error("expected first keep mutate to succeed")
  const loggedAfterKeep1 = await api.log({})
  if (!loggedAfterKeep1.ok) throw new Error("log failed")
  const keepUpdated = kept1.value.snapshot.records.find(
    (entry) => entry.type === "customization" && entry.item === "tool:reader",
  )?.updated
  if (keepUpdated === undefined) throw new Error("expected kept record")
  await waitForNextTick(keepUpdated)
  const freshKeep2 = await api.snapshot()
  if (!freshKeep2.ok) throw new Error("fresh snapshot failed")
  const keep2 = resolveReview(memoInputOf(freshKeep2.value), rowOf(freshKeep2.value), "keep")
  if ("refusal" in keep2) throw new Error(`expected second keep: ${keep2.refusal}`)
  const kept2 = await api.mutate({
    expectedRevision: freshKeep2.value.revision,
    expectedGlobalRevision: freshKeep2.value.globalRevision,
    records: [...keep2.records, ...keep2.splits] as unknown as Plus.SnapshotRecord[],
    actor: { type: "tui" },
  })
  if (!kept2.ok || !kept2.value.ok) throw new Error("expected second keep mutate to succeed")
  expect(kept2.value.revision).toBe(kept1.value.revision)
  expect(kept2.value.globalRevision).toBe(kept1.value.globalRevision)
  const loggedAfterKeep2 = await api.log({})
  if (!loggedAfterKeep2.ok) throw new Error("log failed")
  expect(loggedAfterKeep2.value.total).toBe(loggedAfterKeep1.value.total)
  const freshEdit1 = await api.snapshot()
  if (!freshEdit1.ok) throw new Error("fresh snapshot failed")
  const edit1 = resolveReview(memoInputOf(freshEdit1.value), rowOf(freshEdit1.value), "edit", "merged text")
  if ("refusal" in edit1) throw new Error(`expected first edit: ${edit1.refusal}`)
  const edited1 = await api.mutate({
    expectedRevision: freshEdit1.value.revision,
    expectedGlobalRevision: freshEdit1.value.globalRevision,
    records: [...edit1.records, ...edit1.splits] as unknown as Plus.SnapshotRecord[],
    actor: { type: "tui" },
  })
  if (!edited1.ok || !edited1.value.ok) throw new Error("expected first edit mutate to succeed")
  const loggedAfterEdit1 = await api.log({})
  if (!loggedAfterEdit1.ok) throw new Error("log failed")
  expect(loggedAfterEdit1.value.total).toBe(loggedAfterKeep2.value.total + 1)
  const editUpdated = edited1.value.snapshot.records.find(
    (entry) => entry.type === "customization" && entry.item === "tool:reader",
  )?.updated
  if (editUpdated === undefined) throw new Error("expected edited record")
  await waitForNextTick(editUpdated)
  const freshEdit2 = await api.snapshot()
  if (!freshEdit2.ok) throw new Error("fresh snapshot failed")
  const edit2 = resolveReview(memoInputOf(freshEdit2.value), rowOf(freshEdit2.value), "edit", "merged text")
  if ("refusal" in edit2) throw new Error(`expected second edit: ${edit2.refusal}`)
  const edited2 = await api.mutate({
    expectedRevision: freshEdit2.value.revision,
    expectedGlobalRevision: freshEdit2.value.globalRevision,
    records: [...edit2.records, ...edit2.splits] as unknown as Plus.SnapshotRecord[],
    actor: { type: "tui" },
  })
  if (!edited2.ok || !edited2.value.ok) throw new Error("expected second edit mutate to succeed")
  expect(edited2.value.revision).toBe(edited1.value.revision)
  expect(edited2.value.globalRevision).toBe(edited1.value.globalRevision)
  const loggedAfterEdit2 = await api.log({})
  if (!loggedAfterEdit2.ok) throw new Error("log failed")
  expect(loggedAfterEdit2.value.total).toBe(loggedAfterEdit1.value.total)
})

test("logging moves neither revisions nor the publish fingerprint", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const state = createState()
  const handlers = createHandlers(fullContext({ directory: project }), state)
  const mutated = await Effect.runPromise(
    handlers["instructions.mutate"]({ expectedRevision: 0, expectedGlobalRevision: 0, records: [record("tool:a", { text: "v" })] }, throwingContext({})),
  )
  expect(mutated.ok).toBe(true)
  if (!mutated.ok) throw new Error("expected mutate to succeed")
  const fingerprintBefore = state.fingerprint
  expect(fingerprintBefore).toBeDefined()
  const logged = await Effect.runPromise(handlers["instructions.log"]({}, throwingContext({})))
  expect(logged.total).toBe(1)
  expectRpcBody(logged)
  expect(state.fingerprint).toBe(fingerprintBefore)
  // The line itself consumed no revision: the stored revision still matches.
  const stored = await load(project)
  expect(stored.projectRevision).toBe(mutated.revision)
  expect(stored.globalRevision).toBe(mutated.globalRevision)
  const first = logged.entries[0]
  if (!first) throw new Error("expected one log entry")
  expect(first.revision).toBe(mutated.revision)
})

test("a stale save writes no line and the successful retry writes exactly one", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const handlers = createHandlers(fullContext({ directory: project }), createState())
  const seeded = await Effect.runPromise(
    handlers["instructions.mutate"]({ expectedRevision: 0, expectedGlobalRevision: 0, records: [record("tool:a", { text: "v1" })] }, throwingContext({})),
  )
  expect(seeded.ok).toBe(true)
  if (!seeded.ok) throw new Error("expected seed to succeed")
  expect(await projectLines(project)).toHaveLength(1)

  const stale = await Effect.runPromise(
    handlers["instructions.mutate"]({ expectedRevision: 0, expectedGlobalRevision: 0, records: [record("tool:a", { text: "v2" })] }, throwingContext({})),
  )
  expect(stale.ok).toBe(false)
  if (stale.ok) throw new Error("expected stale conflict")
  expect(stale.store).toBe("project")
  expect(await projectLines(project)).toHaveLength(1)

  const retry = await Effect.runPromise(
    handlers["instructions.mutate"]({
      expectedRevision: stale.snapshot.revision,
      expectedGlobalRevision: stale.snapshot.globalRevision,
      records: [record("tool:a", { text: "v2" })],
    }, throwingContext({})),
  )
  expect(retry.ok).toBe(true)
  if (!retry.ok) throw new Error("expected retry to succeed")
  expect(await projectLines(project)).toHaveLength(2)
})

test("file operations log to the owning store, team toggles log their level, failures log nothing", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const handlers = createHandlers(fullContext({ directory: project }), createState())
  const created = await Effect.runPromise(
    handlers["agent.create"]({ scope: "project", id: "router", prompt: "Be helpful." }, throwingContext({})),
  )
  expect(await projectLines(project)).toHaveLength(1)
  expect(JSON.parse((await projectLines(project))[0] ?? "")).toMatchObject({ op: "agent.create", target: created.path })
  expect(await globalLines()).toHaveLength(0)

  await Effect.runPromise(handlers["skill.create"]({ name: "routerskill", body: "Take notes." }, throwingContext({})))
  await Effect.runPromise(handlers["instruction.create"]({ name: "AGENTS.md", text: "Follow the guide." }, throwingContext({})))
  await Effect.runPromise(
    handlers["mcp.add"]({ name: "routerserver", config: { type: "remote", url: "https://example.test" } }, throwingContext({})),
  )
  expect(await projectLines(project)).toHaveLength(4)
  const mcp = JSON.parse((await projectLines(project))[3] ?? "")
  expect(mcp.op).toBe("mcp.add")
  expect(mcp.target.endsWith(path.join(".opencode", "opencode.json"))).toBe(true)

  await Effect.runPromise(handlers["base.create"]({ id: "routerbase", title: "Router.txt", text: "router base" }, throwingContext({})))
  expect(await globalLines()).toHaveLength(1)
  expect(JSON.parse((await globalLines())[0] ?? "")).toMatchObject({ op: "base.create", target: userBaseFile("routerbase") })
  expect(await projectLines(project)).toHaveLength(4)

  await Effect.runPromise(handlers["agent.delete"]({ scope: "project", id: "router" }, throwingContext({})))
  await Effect.runPromise(handlers["instruction.delete"]({ name: "AGENTS.md" }, throwingContext({})))
  expect(await projectLines(project)).toHaveLength(6)
  expect(JSON.parse((await projectLines(project))[4] ?? "").op).toBe("agent.delete")
  expect(JSON.parse((await projectLines(project))[5] ?? "").op).toBe("instruction.delete")

  await writeTeamAgent(path.join(projectTeamsPath(project), "crew"), "alpha")
  const toggled = await Effect.runPromise(
    handlers["team.setEnabled"]({ level: "project", team: "crew", enabled: true }, throwingContext({})),
  )
  expect(toggled).toEqual({ level: "project", team: "crew", enabled: true })
  expect(await projectLines(project)).toHaveLength(7)
  expect(JSON.parse((await projectLines(project))[6] ?? "")).toMatchObject({ op: "team.setEnabled", target: "team:project:crew" })
  // An unchanged toggle is a no-op and logs nothing.
  await Effect.runPromise(handlers["team.setEnabled"]({ level: "project", team: "crew", enabled: true }, throwingContext({})))
  expect(await projectLines(project)).toHaveLength(7)
  // Failures and refusals log nothing.
  await Effect.runPromise(handlers["agent.create"]({ scope: "project", id: "dup", prompt: "x" }, throwingContext({})))
  expect(await projectLines(project)).toHaveLength(8)
  const duplicate: { current?: CapturedError } = {}
  await expectDeclaredError(
    handlers["agent.create"]({ scope: "project", id: "dup", prompt: "y" }, throwingContext(duplicate)),
    duplicate,
    "agent.exists",
  )
  expect(await projectLines(project)).toHaveLength(8)
})

test("instructions.log returns entries newest-first and honours where, limit, and offset", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const handlers = createHandlers(fullContext({ directory: project }), createState())
  await Effect.runPromise(
    handlers["instructions.mutate"]({ expectedRevision: 0, expectedGlobalRevision: 0, records: [record("tool:a", { text: "v1" })] }, throwingContext({})),
  )
  await Effect.runPromise(handlers["agent.create"]({ scope: "project", id: "first", prompt: "First." }, throwingContext({})))
  await Effect.runPromise(handlers["agent.create"]({ scope: "project", id: "second", prompt: "Second." }, throwingContext({})))
  await Effect.runPromise(
    handlers["instructions.mutate"]({
      expectedRevision: 1,
      expectedGlobalRevision: 0,
      records: [record("tool:a", { text: "v2" })],
      actor: { type: "tool", agent: "alpha", sessionID: "ses_9", messageID: "msg_9" },
    }, throwingContext({})),
  )

  const all = await Effect.runPromise(handlers["instructions.log"]({}, throwingContext({})))
  expect(all.total).toBe(4)
  expect(all.entries.map((entry) => entry.op)).toEqual(["mutate", "agent.create", "agent.create", "mutate"])
  expect(all.entries.map((entry) => entry.revision)).toEqual([2, 1, 1, 1])
  expect(all.entries[1]?.target).toContain("second")
  expect(all.entries[2]?.target).toContain("first")
  expectRpcBody(all)

  const bare = await Effect.runPromise(handlers["instructions.log"]({ where: "second" }, throwingContext({})))
  expect(bare.total).toBe(1)
  expect(bare.entries[0]?.target).toContain("second")

  const byOp = await Effect.runPromise(handlers["instructions.log"]({ where: "op:agent.create" }, throwingContext({})))
  expect(byOp.total).toBe(2)

  const byTarget = await Effect.runPromise(
    handlers["instructions.log"]({ where: `target:${project}/.opencode` }, throwingContext({})),
  )
  expect(byTarget.total).toBe(2)

  const byActor = await Effect.runPromise(handlers["instructions.log"]({ where: "actor:tool" }, throwingContext({})))
  expect(byActor.total).toBe(1)
  expect(byActor.entries[0]?.actor).toEqual({ type: "tool", agent: "alpha", sessionID: "ses_9", messageID: "msg_9" })
  const tuiOnly = await Effect.runPromise(handlers["instructions.log"]({ where: "actor:tui" }, throwingContext({})))
  expect(tuiOnly.total).toBe(3)

  const byAgent = await Effect.runPromise(handlers["instructions.log"]({ where: "agent:alpha" }, throwingContext({})))
  expect(byAgent.total).toBe(1)

  const bySession = await Effect.runPromise(handlers["instructions.log"]({ where: "session:ses_9" }, throwingContext({})))
  expect(bySession.total).toBe(1)

  const recent = await Effect.runPromise(handlers["instructions.log"]({ where: "since:7d" }, throwingContext({})))
  expect(recent.total).toBe(4)
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString()
  const future = await Effect.runPromise(handlers["instructions.log"]({ where: `since:${tomorrow}` }, throwingContext({})))
  expect(future).toEqual({ entries: [], total: 0 })
  const past = await Effect.runPromise(handlers["instructions.log"]({ where: `before:${tomorrow}` }, throwingContext({})))
  expect(past.total).toBe(4)

  const negated = await Effect.runPromise(handlers["instructions.log"]({ where: "!op:mutate" }, throwingContext({})))
  expect(negated.total).toBe(2)
  expect(negated.entries.map((entry) => entry.op)).toEqual(["agent.create", "agent.create"])

  const limited = await Effect.runPromise(handlers["instructions.log"]({ limit: 1 }, throwingContext({})))
  expect(limited.total).toBe(4)
  expect(limited.entries).toHaveLength(1)
  expect(limited.entries[0]?.target).toBe(all.entries[0]?.target)

  const offset = await Effect.runPromise(handlers["instructions.log"]({ offset: 2 }, throwingContext({})))
  expect(offset.total).toBe(4)
  expect(offset.entries.map((entry) => entry.target)).toEqual(all.entries.slice(2).map((entry) => entry.target))

  const page = await Effect.runPromise(
    handlers["instructions.log"]({ where: "op:agent.create", limit: 1, offset: 1 }, throwingContext({})),
  )
  expect(page.total).toBe(2)
  expect(page.entries).toHaveLength(1)
  expect(page.entries[0]?.target).toBe(byOp.entries[1]?.target)
})

test("a corrupt line in log.jsonl is skipped rather than failing the read", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const handlers = createHandlers(fullContext({ directory: project }), createState())
  await Effect.runPromise(
    handlers["instructions.mutate"]({ expectedRevision: 0, expectedGlobalRevision: 0, records: [record("tool:a", { text: "v" })] }, throwingContext({})),
  )
  await fs.appendFile(projectLogPath(project), "{corrupt\n[1,2,3\n")
  const logged = await Effect.runPromise(handlers["instructions.log"]({}, throwingContext({})))
  expect(logged.total).toBe(1)
  expect(logged.entries).toHaveLength(1)
  expect(logged.entries[0]?.op).toBe("mutate")
  const direct = await read(projectLogPath(project), {})
  expect(direct.total).toBe(1)
})

test("append caps the summary at 200 chars on a single line", async () => {
  const { project } = await tempRoot()
  const target = projectLogPath(project)
  await append(target, {
    ts: new Date().toISOString(),
    actor: { type: "tui" },
    op: "mutate",
    target: "records",
    summary: `${"y".repeat(500)}\nwith newline`,
    revision: 0,
  })
  const stored = await linesOf(target)
  expect(stored).toHaveLength(1)
  const { entries, total } = await read(target, {})
  expect(total).toBe(1)
  const first = entries[0]
  if (!first) throw new Error("expected one entry")
  expect(first.summary.length).toBeLessThanOrEqual(200)
  expect(first.summary).not.toContain("\n")
})

test("a mutate with many unchanged records logs exactly the edited row", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const handlers = createHandlers(fullContext({ directory: project }), createState())
  const seeded = await Effect.runPromise(
    handlers["instructions.mutate"]({
      expectedRevision: 0,
      expectedGlobalRevision: 0,
      records: [
        record("tool:a", { text: "a" }),
        record("tool:b", { text: "b" }),
        record("tool:c", { level: "global", agent: "beta", text: "c" }),
      ],
    }, throwingContext({})),
  )
  expect(seeded.ok).toBe(true)
  if (!seeded.ok) throw new Error("expected seed to succeed")
  const edited = await Effect.runPromise(
    handlers["instructions.mutate"]({
      expectedRevision: seeded.revision,
      expectedGlobalRevision: seeded.globalRevision,
      records: [
        record("tool:a", { text: "a" }),
        record("tool:b", { text: "b-edited" }),
        record("tool:c", { level: "global", agent: "beta", text: "c" }),
      ],
    }, throwingContext({})),
  )
  expect(edited.ok).toBe(true)
  if (!edited.ok) throw new Error("expected edit to succeed")
  expect(await projectLines(project)).toHaveLength(2)
  expect(await globalLines()).toHaveLength(1)
  const line = JSON.parse((await projectLines(project))[1] ?? "")
  expect(line.target).toBe("item:project:alpha:tool:b")
  expect(line.summary).toBe("mutate item:project:alpha:tool:b")
  expect(line.revision).toBe(2)
})

test("a mutate changing two rows in one store names both ids in canonical order", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const handlers = createHandlers(fullContext({ directory: project }), createState())
  const seeded = await Effect.runPromise(
    handlers["instructions.mutate"]({
      expectedRevision: 0,
      expectedGlobalRevision: 0,
      records: [record("tool:b", { text: "b" }), record("tool:a", { text: "a" })],
    }, throwingContext({})),
  )
  expect(seeded.ok).toBe(true)
  if (!seeded.ok) throw new Error("expected seed to succeed")
  const edited = await Effect.runPromise(
    handlers["instructions.mutate"]({
      expectedRevision: seeded.revision,
      expectedGlobalRevision: seeded.globalRevision,
      records: [record("tool:b", { text: "b2" }), record("tool:a", { text: "a2" })],
    }, throwingContext({})),
  )
  expect(edited.ok).toBe(true)
  if (!edited.ok) throw new Error("expected edit to succeed")
  const lines = await projectLines(project)
  expect(lines).toHaveLength(2)
  const line = JSON.parse(lines[1] ?? "")
  expect(line.target).toBe("item:project:alpha:tool:a")
  expect(line.summary).toBe("mutate 2 rows (project): item:project:alpha:tool:a, item:project:alpha:tool:b")
})

test("one changed row per store logs the correct per-store target in each file", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const handlers = createHandlers(fullContext({ directory: project }), createState())
  const seeded = await Effect.runPromise(
    handlers["instructions.mutate"]({
      expectedRevision: 0,
      expectedGlobalRevision: 0,
      records: [record("tool:p", { text: "p" }), record("tool:g", { level: "global", agent: "beta", text: "g" })],
    }, throwingContext({})),
  )
  expect(seeded.ok).toBe(true)
  if (!seeded.ok) throw new Error("expected seed to succeed")
  const edited = await Effect.runPromise(
    handlers["instructions.mutate"]({
      expectedRevision: seeded.revision,
      expectedGlobalRevision: seeded.globalRevision,
      records: [record("tool:p", { text: "p2" }), record("tool:g", { level: "global", agent: "beta", text: "g2" })],
    }, throwingContext({})),
  )
  expect(edited.ok).toBe(true)
  if (!edited.ok) throw new Error("expected edit to succeed")
  const projectEntry = JSON.parse((await projectLines(project))[1] ?? "")
  expect(projectEntry.target).toBe("item:project:alpha:tool:p")
  expect(projectEntry.summary).toBe("mutate item:project:alpha:tool:p")
  const globalEntry = JSON.parse((await globalLines())[1] ?? "")
  expect(globalEntry.target).toBe("item:global:beta:tool:g")
  expect(globalEntry.summary).toBe("mutate item:global:beta:tool:g")
})
