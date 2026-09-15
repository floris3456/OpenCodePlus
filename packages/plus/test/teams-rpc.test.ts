import { afterEach, expect, test } from "bun:test"
import { Effect, Exit, Schema } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { formatMarkdown } from "../src/agents/files.js"
import { createHandlers, createState } from "../src/index.js"
import { fingerprint } from "../src/instructions/model.js"
import { globalTeamsPath, projectTeamsPath } from "../src/instructions/paths.js"
import { load, type StoredRecord } from "../src/instructions/store.js"
import { enable } from "../src/project.js"
import { Plus } from "../src/rpc.js"
import { fullContext } from "./harness.js"

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
  const root = await fs.mkdtemp(path.join(parent, "plus-teams-rpc-"))
  roots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  return { project: path.join(root, "project") }
}

async function writeTeamAgent(teamDir: string, id: string, body = "role"): Promise<string> {
  const target = path.join(teamDir, `${id}.md`)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await Bun.write(target, formatMarkdown({ description: `${path.basename(teamDir)}/${id}` }, body))
  return target
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

const RpcBody = Schema.toCodecJson(Schema.Struct({ output: Schema.optionalKey(Schema.Unknown) }))

function expectRpcBody(value: unknown) {
  expect(() => Schema.encodeUnknownSync(RpcBody)({ output: value })).not.toThrow()
}

test("snapshot lists a disk team as disabled with member ids when no record exists", async () => {
  const { project } = await tempRoot()
  await enable(project)
  await writeTeamAgent(path.join(projectTeamsPath(project), "crew"), "alpha")
  await writeTeamAgent(path.join(projectTeamsPath(project), "crew"), "nested/beta")
  const handlers = createHandlers(fullContext({ directory: project }), createState())
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  expect(snapshot.teams).toEqual([{ level: "project", team: "crew", enabled: false, agents: ["alpha", "nested/beta"] }])
  expect(snapshot.records).toEqual([])
  expectRpcBody(snapshot)
})

test("team.create at project scope creates the directory and the next snapshot lists it disabled", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const handlers = createHandlers(fullContext({ directory: project }), createState())
  const created = await Effect.runPromise(handlers["team.create"]({ level: "project", team: "crew" }, throwingContext({})))
  expect(created).toEqual({ level: "project", team: "crew", enabled: false })
  expectRpcBody(created)
  const stat = await fs.stat(path.join(projectTeamsPath(project), "crew"))
  expect(stat.isDirectory()).toBe(true)
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  expect(snapshot.teams).toEqual([{ level: "project", team: "crew", enabled: false, agents: [] }])
  expect(snapshot.records).toEqual([])
})

test("team.create at global scope creates the directory under the global teams root as disabled", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const handlers = createHandlers(fullContext({ directory: project }), createState())
  const created = await Effect.runPromise(handlers["team.create"]({ level: "global", team: "ops" }, throwingContext({})))
  expect(created).toEqual({ level: "global", team: "ops", enabled: false })
  expectRpcBody(created)
  const stat = await fs.stat(path.join(globalTeamsPath(), "ops"))
  expect(stat.isDirectory()).toBe(true)
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  expect(snapshot.teams).toEqual([{ level: "global", team: "ops", enabled: false, agents: [] }])
  expect(snapshot.records).toEqual([])
})

test("a created team can then be enabled and its member agents apply", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const ctx = fullContext({ directory: project })
  const handlers = createHandlers(ctx, createState())
  await Effect.runPromise(handlers["team.create"]({ level: "project", team: "crew" }, throwingContext({})))
  await writeTeamAgent(path.join(projectTeamsPath(project), "crew"), "alpha", "crew alpha body")
  const toggled = await Effect.runPromise(
    handlers["team.setEnabled"]({ level: "project", team: "crew", enabled: true }, throwingContext({})),
  )
  expect(toggled).toEqual({ level: "project", team: "crew", enabled: true })
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  expect(snapshot.teams).toEqual([{ level: "project", team: "crew", enabled: true, agents: ["alpha"] }])
  const listed = await Effect.runPromise(ctx.agent.list())
  expect(listed.data.find((entry) => String(entry.id) === "alpha")?.system).toBe("crew alpha body")
})

test("team.create raises every declared error through a real call", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const handlers = createHandlers(fullContext({ directory: project }), createState())
  const invalid: { current?: CapturedError } = {}
  await expectDeclaredError(
    handlers["team.create"]({ level: "project", team: "../evil" }, throwingContext(invalid)),
    invalid,
    "team.invalid",
  )
  await Effect.runPromise(handlers["team.create"]({ level: "project", team: "crew" }, throwingContext({})))
  const duplicate: { current?: CapturedError } = {}
  await expectDeclaredError(
    handlers["team.create"]({ level: "project", team: "crew" }, throwingContext(duplicate)),
    duplicate,
    "team.exists",
  )
  expect(duplicate.current?.data).toEqual({ level: "project", team: "crew" })
  const failed: { current?: CapturedError } = {}
  await expectDeclaredError(
    handlers["team.create"]({ level: "project", team: "a".repeat(300) }, throwingContext(failed)),
    failed,
    "team.create",
  )
  expect((await load(project)).records).toEqual([])
  const gated = await tempRoot()
  const gatedHandlers = createHandlers(fullContext({ directory: gated.project }), createState())
  const disabled: { current?: CapturedError } = {}
  await expectDeclaredError(
    gatedHandlers["team.create"]({ level: "project", team: "crew" }, throwingContext(disabled)),
    disabled,
    "project.disabled",
  )
})

test("team.create does not disturb existing records and moves no revision", async () => {
  const { project } = await tempRoot()
  await enable(project)
  await writeTeamAgent(path.join(projectTeamsPath(project), "vets"), "alpha")
  const handlers = createHandlers(fullContext({ directory: project }), createState())
  const before = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const customization: Plus.SnapshotCustomizationRecord = {
    type: "customization",
    level: "project",
    agent: "alpha",
    item: "tool:reader",
    section: null,
    text: "project text",
    basedOn: fingerprint("upstream"),
    updated: UPDATED,
  }
  const split: Plus.SnapshotSplitRecord = {
    type: "split",
    level: "project",
    agent: "alpha",
    item: "tool:reader",
    boundaries: [{ id: "a", name: "A", start: 0 }],
    updated: UPDATED,
  }
  const mutated = await Effect.runPromise(
    handlers["instructions.mutate"](
      { expectedRevision: before.revision, expectedGlobalRevision: before.globalRevision, records: [customization, split] },
      throwingContext({}),
    ),
  )
  expect(mutated.ok).toBe(true)
  if (!mutated.ok) throw new Error("expected mutate to succeed")
  await Effect.runPromise(handlers["team.setEnabled"]({ level: "project", team: "vets", enabled: true }, throwingContext({})))
  const storedBefore = await load(project)
  await Effect.runPromise(handlers["team.create"]({ level: "project", team: "crew" }, throwingContext({})))
  const storedAfter = await load(project)
  expect(storedAfter.projectRevision).toBe(storedBefore.projectRevision)
  expect(storedAfter.globalRevision).toBe(storedBefore.globalRevision)
  expect(storedAfter.records).toEqual(storedBefore.records)
  await Effect.runPromise(handlers["team.create"]({ level: "global", team: "ops" }, throwingContext({})))
  const storedGlobal = await load(project)
  expect(storedGlobal.projectRevision).toBe(storedBefore.projectRevision)
  expect(storedGlobal.globalRevision).toBe(storedBefore.globalRevision)
  expect(storedGlobal.records).toEqual(storedBefore.records)
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  expect(snapshot.records).toHaveLength(2)
  expect(snapshot.teams?.find((team) => team.team === "vets")).toEqual({
    level: "project",
    team: "vets",
    enabled: true,
    agents: ["alpha"],
  })
  expect(snapshot.teams?.find((team) => team.team === "crew")).toEqual({
    level: "project",
    team: "crew",
    enabled: false,
    agents: [],
  })
  expect(snapshot.teams?.find((team) => team.team === "ops")).toEqual({
    level: "global",
    team: "ops",
    enabled: false,
    agents: [],
  })
})

test("team.create through the RPC handler logs with actor tui", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const handlers = createHandlers(fullContext({ directory: project }), createState())
  await Effect.runPromise(handlers["team.create"]({ level: "project", team: "crew" }, throwingContext({})))
  const logged = await Effect.runPromise(handlers["instructions.log"]({}, throwingContext({})))
  const entry = logged.entries.find((candidate) => candidate.op === "team.create")
  if (entry === undefined) throw new Error("missing team.create log entry")
  expect(entry.actor).toEqual({ type: "tui" })
  expect(entry.target).toBe("team:project:crew")
})

test("toggling a team on writes a real TeamRecord and the next snapshot reports it enabled", async () => {
  const { project } = await tempRoot()
  await enable(project)
  await writeTeamAgent(path.join(projectTeamsPath(project), "crew"), "alpha", "crew alpha body")
  const ctx = fullContext({ directory: project })
  const handlers = createHandlers(ctx, createState())
  const toggled = await Effect.runPromise(
    handlers["team.setEnabled"]({ level: "project", team: "crew", enabled: true }, throwingContext({})),
  )
  expect(toggled).toEqual({ level: "project", team: "crew", enabled: true })
  expectRpcBody(toggled)
  const stored = await load(project)
  expect(stored.records).toHaveLength(1)
  expect(stored.records[0]).toMatchObject({ type: "team", level: "project", team: "crew", enabled: true })
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  expect(snapshot.teams).toEqual([{ level: "project", team: "crew", enabled: true, agents: ["alpha"] }])
  // Team records stay out of `records`.
  expect(snapshot.records).toEqual([])
  // The toggle has host effect, not just a record and a badge: the member's
  // markdown body is visible in the host agent registry.
  const listed = await Effect.runPromise(ctx.agent.list())
  expect(listed.data.find((entry) => String(entry.id) === "alpha")?.system).toBe("crew alpha body")
  // Toggling back off removes the member from the host registry.
  await Effect.runPromise(handlers["team.setEnabled"]({ level: "project", team: "crew", enabled: false }, throwingContext({})))
  const reloaded = await Effect.runPromise(ctx.agent.list())
  expect(reloaded.data.some((entry) => String(entry.id) === "alpha")).toBe(false)
})

test("toggling an unknown team name raises team.unknown and an invalid name raises team.invalid", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const handlers = createHandlers(fullContext({ directory: project }), createState())
  const unknown: { current?: CapturedError } = {}
  await expectDeclaredError(
    handlers["team.setEnabled"]({ level: "project", team: "ghost", enabled: true }, throwingContext(unknown)),
    unknown,
    "team.unknown",
  )
  expect(unknown.current?.type).toBe("team.unknown")
  const invalid: { current?: CapturedError } = {}
  await expectDeclaredError(
    handlers["team.setEnabled"]({ level: "project", team: "../evil", enabled: true }, throwingContext(invalid)),
    invalid,
    "team.invalid",
  )
  expect((await load(project)).records).toEqual([])
})

test("team.setEnabled is gated on project mode with project.disabled", async () => {
  const { project } = await tempRoot()
  const handlers = createHandlers(fullContext({ directory: project }), createState())
  const captured: { current?: CapturedError } = {}
  await expectDeclaredError(
    handlers["team.setEnabled"]({ level: "project", team: "crew", enabled: true }, throwingContext(captured)),
    captured,
    "project.disabled",
  )
})

test("a toggle does not disturb existing customization or split records", async () => {
  const { project } = await tempRoot()
  await enable(project)
  await writeTeamAgent(path.join(projectTeamsPath(project), "crew"), "alpha")
  const handlers = createHandlers(fullContext({ directory: project }), createState())
  const before = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const customization: Plus.SnapshotCustomizationRecord = {
    type: "customization",
    level: "project",
    agent: "alpha",
    item: "tool:reader",
    section: null,
    text: "project text",
    basedOn: fingerprint("upstream"),
    updated: UPDATED,
  }
  const split: Plus.SnapshotSplitRecord = {
    type: "split",
    level: "project",
    agent: "alpha",
    item: "tool:reader",
    boundaries: [{ id: "a", name: "A", start: 0 }],
    updated: UPDATED,
  }
  const mutated = await Effect.runPromise(
    handlers["instructions.mutate"](
      { expectedRevision: before.revision, expectedGlobalRevision: before.globalRevision, records: [customization, split] },
      throwingContext({}),
    ),
  )
  expect(mutated.ok).toBe(true)
  if (!mutated.ok) throw new Error("expected mutate to succeed")
  const toggled = await Effect.runPromise(
    handlers["team.setEnabled"]({ level: "project", team: "crew", enabled: true }, throwingContext({})),
  )
  expect(toggled.enabled).toBe(true)
  const stored = await load(project)
  const kept = stored.records.filter((record): record is Extract<StoredRecord, { type: "customization" | "split" }> =>
    record.type !== "team",
  )
  expect(kept).toHaveLength(2)
  expect(stored.records.filter((record) => record.type === "team")).toHaveLength(1)
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  expect(snapshot.records).toHaveLength(2)
  expect(snapshot.teams?.find((team) => team.team === "crew")?.enabled).toBe(true)
  // Toggling back off keeps both non-team records in place.
  await Effect.runPromise(handlers["team.setEnabled"]({ level: "project", team: "crew", enabled: false }, throwingContext({})))
  const after = await load(project)
  expect(after.records.filter((record) => record.type !== "team")).toHaveLength(2)
  expect(after.records.find((record) => record.type === "team")).toMatchObject({ team: "crew", enabled: false })
})

test("an unchanged toggle stays a no-op without moving revisions", async () => {
  const { project } = await tempRoot()
  await enable(project)
  await writeTeamAgent(path.join(projectTeamsPath(project), "crew"), "alpha")
  const handlers = createHandlers(fullContext({ directory: project }), createState())
  await Effect.runPromise(handlers["team.setEnabled"]({ level: "project", team: "crew", enabled: true }, throwingContext({})))
  const stored = await load(project)
  const toggled = await Effect.runPromise(
    handlers["team.setEnabled"]({ level: "project", team: "crew", enabled: true }, throwingContext({})),
  )
  expect(toggled).toEqual({ level: "project", team: "crew", enabled: true })
  const reread = await load(project)
  expect(reread.projectRevision).toBe(stored.projectRevision)
  expect(reread.globalRevision).toBe(stored.globalRevision)
  expect(reread.records).toEqual(stored.records)
})

test("a normal instructions.mutate round-trip does not delete team records", async () => {
  const { project } = await tempRoot()
  await enable(project)
  await writeTeamAgent(path.join(projectTeamsPath(project), "crew"), "alpha")
  const handlers = createHandlers(fullContext({ directory: project }), createState())
  await Effect.runPromise(handlers["team.setEnabled"]({ level: "project", team: "crew", enabled: true }, throwingContext({})))
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  expect(snapshot.records.some((record) => (record as { type: string }).type === "team")).toBe(false)
  const mutated = await Effect.runPromise(
    handlers["instructions.mutate"](
      { expectedRevision: snapshot.revision, expectedGlobalRevision: snapshot.globalRevision, records: [...(snapshot.records ?? [])] },
      throwingContext({}),
    ),
  )
  expect(mutated.ok).toBe(true)
  if (!mutated.ok) throw new Error("expected mutate to succeed")
  // Preserved teams keep an otherwise unchanged save a no-op.
  expect(mutated.revision).toBe(snapshot.revision)
  expect(mutated.globalRevision).toBe(snapshot.globalRevision)
  const stored = await load(project)
  expect(stored.records.find((record) => record.type === "team")).toMatchObject({ team: "crew", enabled: true })
  const resnapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  expect(resnapshot.teams?.find((team) => team.team === "crew")?.enabled).toBe(true)
})
