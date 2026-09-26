import { afterEach, expect, test } from "bun:test"
import { Effect, Exit, Schema } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { loadRun, saveRun, type RunRecord } from "../src/teams/run.js"
import { formatMarkdown } from "../src/agents/files.js"
import { agentBody } from "../src/instructions/discover.js"
import { parseTeamFields } from "../src/instructions/teams-apply.js"
import { createHandlers, createState } from "../src/index.js"
import { fingerprint } from "../src/instructions/model.js"
import { globalTeamsPath, projectTeamsPath, teamsDataDir } from "../src/instructions/paths.js"
import { plusTeamPresets } from "../src/instructions/presets.js"
import { memoInputOf } from "../src/instructions/snapshot.js"
import { discoverBuiltinTeams } from "../src/instructions/teams.js"
import { expandedTree } from "../src/instructions/tree.js"
import { load, save, type StoredRecord } from "../src/instructions/store.js"
import { disable, enable } from "../src/project.js"
import { Plus } from "../src/rpc.js"
import { agentInfo, fullContext, modelInfo } from "./harness.js"

const UPDATED = "2026-01-01T00:00:00.000Z"

const roots: string[] = []
const priorConfigDir = process.env.OPENCODE_CONFIG_DIR
const priorXdgDataHome = process.env.XDG_DATA_HOME

afterEach(async () => {
  if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
  if (priorXdgDataHome === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = priorXdgDataHome
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function tempRoot(): Promise<{ project: string }> {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-teams-rpc-"))
  roots.push(root)
  process.env.XDG_DATA_HOME = path.join(root, "share")
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  const project = path.join(root, "project")
  // Project mode resolves upward, so an ancestor of TMPDIR can be enabled
  // (the development workspace is). The fixture writes its own explicit
  // disabled marker; tests that need project mode call enable(project).
  await disable(project)
  return { project }
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

// Writes a team enablement straight through the store (bypassing
// team.setEnabled's one-team-at-a-time rule) and republishes the host.
async function coEnableTeam(
  project: string,
  handlers: ReturnType<typeof createHandlers>,
  level: "project" | "global" | "defaults",
  team: string,
): Promise<void> {
  const loaded = await load(project)
  const saved = await save(project, {
    expectedProjectRevision: loaded.projectRevision,
    expectedGlobalRevision: loaded.globalRevision,
    records: [
      ...loaded.records.filter((record) => !(record.type === "team" && record.level === level && record.team === team)),
      { type: "team", level, team, enabled: true, updated: UPDATED },
    ],
  })
  if (!saved.ok) throw new Error("coEnableTeam: stale save")
  await Effect.runPromise(handlers["instructions.refresh"](undefined, throwingContext({})))
}

function expectRpcBody(value: unknown) {
  expect(() => Schema.encodeUnknownSync(RpcBody)({ output: value })).not.toThrow()
}

test("snapshot lists a disk team as disabled with member ids when no record exists", async () => {
  const { project } = await tempRoot()
  await enable(project)
  await writeTeamAgent(path.join(projectTeamsPath(project), "crew"), "alpha")
  await writeTeamAgent(path.join(projectTeamsPath(project), "crew"), "nested/beta")
  const handlers = createHandlers(fullContext({ directory: project }), createState(), { builtins: [] })
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  expect(snapshot.teams).toEqual([{ level: "project", team: "crew", enabled: false, agents: ["alpha", "nested/beta"] }])
  expect(snapshot.records).toEqual([])
  expectRpcBody(snapshot)
})

test("team.create at project scope creates the directory and the next snapshot lists it disabled", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const handlers = createHandlers(fullContext({ directory: project }), createState(), { builtins: [] })
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
  const handlers = createHandlers(fullContext({ directory: project }), createState(), { builtins: [] })
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
  const handlers = createHandlers(ctx, createState(), { builtins: [] })
  await Effect.runPromise(handlers["team.create"]({ level: "project", team: "crew" }, throwingContext({})))
  await writeTeamAgent(path.join(projectTeamsPath(project), "crew"), "alpha", "crew alpha body")
  const toggled = await Effect.runPromise(
    handlers["team.setEnabled"]({ level: "project", team: "crew", enabled: true }, throwingContext({})),
  )
  expect(toggled).toEqual({ level: "project", team: "crew", enabled: true, exclusive: true, disabledTeams: [] })
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  expect(snapshot.teams).toEqual([{ level: "project", team: "crew", enabled: true, agents: ["alpha"] }])
  const listed = await Effect.runPromise(ctx.agent.list())
  expect(listed.data.find((entry) => String(entry.id) === "alpha")?.system).toBe("crew alpha body")
})

test("team.create raises every declared error through a real call", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const handlers = createHandlers(fullContext({ directory: project }), createState(), { builtins: [] })
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
  const gatedHandlers = createHandlers(fullContext({ directory: gated.project }), createState(), { builtins: [] })
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
  const handlers = createHandlers(fullContext({ directory: project }), createState(), { builtins: [] })
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
  const handlers = createHandlers(fullContext({ directory: project }), createState(), { builtins: [] })
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
  const handlers = createHandlers(ctx, createState(), { builtins: [] })
  const toggled = await Effect.runPromise(
    handlers["team.setEnabled"]({ level: "project", team: "crew", enabled: true }, throwingContext({})),
  )
  expect(toggled).toEqual({ level: "project", team: "crew", enabled: true, exclusive: true, disabledTeams: [] })
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

test("enabling a team disables every other enabled team across levels in one save", async () => {
  const { project } = await tempRoot()
  await enable(project)
  await writeTeamAgent(path.join(projectTeamsPath(project), "crew"), "alpha", "crew alpha body")
  await writeTeamAgent(path.join(projectTeamsPath(project), "band"), "beta", "band beta body")
  await writeTeamAgent(path.join(globalTeamsPath(), "orbit"), "gamma", "orbit gamma body")
  const ctx = fullContext({ directory: project })
  const handlers = createHandlers(ctx, createState(), { builtins: [] })
  const enabledOf = async () => {
    const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
    return (snapshot.teams ?? []).filter((team) => team.enabled).map((team) => `${team.level}:${team.team}`)
  }
  await Effect.runPromise(handlers["team.setEnabled"]({ level: "project", team: "crew", enabled: true }, throwingContext({})))
  expect(await enabledOf()).toEqual(["project:crew"])
  // A second project team takes over: crew flips off in the same save.
  const band = await Effect.runPromise(handlers["team.setEnabled"]({ level: "project", team: "band", enabled: true }, throwingContext({})))
  expect(band.disabledTeams).toEqual([{ level: "project", team: "crew" }])
  expect(await enabledOf()).toEqual(["project:band"])
  const listed = await Effect.runPromise(ctx.agent.list())
  expect(listed.data.some((entry) => String(entry.id) === "alpha")).toBe(false)
  expect(listed.data.find((entry) => String(entry.id) === "beta")?.system).toBe("band beta body")
  // A global team takes over from a project team, and vice versa.
  const orbit = await Effect.runPromise(handlers["team.setEnabled"]({ level: "global", team: "orbit", enabled: true }, throwingContext({})))
  expect(orbit.disabledTeams).toEqual([{ level: "project", team: "band" }])
  expect(await enabledOf()).toEqual(["global:orbit"])
  await Effect.runPromise(handlers["team.setEnabled"]({ level: "project", team: "crew", enabled: true }, throwingContext({})))
  expect(await enabledOf()).toEqual(["project:crew"])
  const stored = await load(project)
  const teamRecords = stored.records.filter((record): record is Extract<StoredRecord, { type: "team" }> => record.type === "team")
  expect(teamRecords.map((record) => [record.level, record.team, record.enabled]).toSorted()).toEqual([
    ["global", "orbit", false],
    ["project", "band", false],
    ["project", "crew", true],
  ])
  // Disabling never touches the others.
  await Effect.runPromise(handlers["team.setEnabled"]({ level: "project", team: "crew", enabled: false }, throwingContext({})))
  expect(await enabledOf()).toEqual([])
})

test("toggling an unknown team name raises team.unknown and an invalid name raises team.invalid", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const handlers = createHandlers(fullContext({ directory: project }), createState(), { builtins: [] })
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
  const handlers = createHandlers(fullContext({ directory: project }), createState(), { builtins: [] })
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
  const handlers = createHandlers(fullContext({ directory: project }), createState(), { builtins: [] })
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
  const handlers = createHandlers(fullContext({ directory: project }), createState(), { builtins: [] })
  await Effect.runPromise(handlers["team.setEnabled"]({ level: "project", team: "crew", enabled: true }, throwingContext({})))
  const stored = await load(project)
  const toggled = await Effect.runPromise(
    handlers["team.setEnabled"]({ level: "project", team: "crew", enabled: true }, throwingContext({})),
  )
  expect(toggled).toEqual({ level: "project", team: "crew", enabled: true, exclusive: true, disabledTeams: [] })
  const reread = await load(project)
  expect(reread.projectRevision).toBe(stored.projectRevision)
  expect(reread.globalRevision).toBe(stored.globalRevision)
  expect(reread.records).toEqual(stored.records)
})

test("a normal instructions.mutate round-trip does not delete team records", async () => {
  const { project } = await tempRoot()
  await enable(project)
  await writeTeamAgent(path.join(projectTeamsPath(project), "crew"), "alpha")
  const handlers = createHandlers(fullContext({ directory: project }), createState(), { builtins: [] })
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

function fixtureBuiltins() {
  return [
    { name: "ship", members: [{ id: "mate", body: "ship mate body" }] },
    { name: "other", members: [{ id: "solo", body: "solo body" }] },
  ]
}

test("built-ins appear as defaults-tier teams in a real snapshot", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const handlers = createHandlers(fullContext({ directory: project }), createState(), { builtins: fixtureBuiltins() })
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  expect(snapshot.teams).toEqual([
    { level: "defaults", team: "other", enabled: false, agents: ["solo"] },
    { level: "defaults", team: "ship", enabled: false, agents: ["mate"] },
  ])
  expectRpcBody(snapshot)
})

test("enabling a built-in installs its members and disabling removes them", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const ctx = fullContext({ directory: project })
  const handlers = createHandlers(ctx, createState(), { builtins: fixtureBuiltins() })
  const toggled = await Effect.runPromise(
    handlers["team.setEnabled"]({ level: "defaults", team: "ship", enabled: true }, throwingContext({})),
  )
  expect(toggled).toEqual({ level: "defaults", team: "ship", enabled: true, exclusive: true, disabledTeams: [] })
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  expect(snapshot.teams?.find((team) => team.team === "ship")).toEqual({
    level: "defaults",
    team: "ship",
    enabled: true,
    agents: ["mate"],
  })
  const listed = await Effect.runPromise(ctx.agent.list())
  expect(listed.data.find((entry) => String(entry.id) === "mate")?.system).toBe("ship mate body")
  await Effect.runPromise(handlers["team.setEnabled"]({ level: "defaults", team: "ship", enabled: false }, throwingContext({})))
  const reloaded = await Effect.runPromise(ctx.agent.list())
  expect(reloaded.data.some((entry) => String(entry.id) === "mate")).toBe(false)
})

test("a built-in enablement record lands in the global store", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const handlers = createHandlers(fullContext({ directory: project }), createState(), { builtins: fixtureBuiltins() })
  await Effect.runPromise(handlers["team.setEnabled"]({ level: "defaults", team: "ship", enabled: true }, throwingContext({})))
  const stored = await load(project)
  expect(stored.records).toHaveLength(1)
  expect(stored.records[0]).toMatchObject({ type: "team", level: "defaults", team: "ship", enabled: true })
})

test("team.create refuses defaults with team.invalid", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const handlers = createHandlers(fullContext({ directory: project }), createState(), { builtins: fixtureBuiltins() })
  const refused: { current?: CapturedError } = {}
  await expectDeclaredError(
    handlers["team.create"](
      { level: "defaults", team: "ship" } as unknown as { level: "project"; team: string },
      throwingContext(refused),
    ),
    refused,
    "team.invalid",
  )
  expect((await load(project)).records).toEqual([])
})

// DESIGN §5: `template` names a team preset (Plus or User), no longer a
// Defaults template. Each member file carries only the preset's mode and
// description with an empty body; links make the member follow its member
// preset and the team its team preset.
test("team.create from a team preset writes linked member files", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const handlers = createHandlers(fullContext({ directory: project }), createState(), { builtins: [] })
  const created = await Effect.runPromise(
    handlers["team.create"]({ level: "project", team: "mine", preset: "review" }, throwingContext({})),
  )
  expect(created).toEqual({ level: "project", team: "mine", enabled: false })
  expectRpcBody(created)
  const teamDir = path.join(projectTeamsPath(project), "mine")
  for (const id of ["editor", "reviewer"]) {
    const text = await fs.readFile(path.join(teamDir, `${id}.md`), "utf8")
    expect(agentBody(text)).toBe("")
    expect(parseTeamFields(text).mode).toBe("primary")
    expect((parseTeamFields(text).description ?? "").length).toBeGreaterThan(0)
  }
  const links = (await load(project)).records.filter((record) => record.type === "link")
  const owner = { level: "project", team: "mine" }
  expect(links).toHaveLength(3)
  expect(links).toContainEqual(expect.objectContaining({ level: "project", agent: null, team: owner, preset: { kind: "team", id: "review" } }))
  expect(links).toContainEqual(
    expect.objectContaining({ level: "project", agent: "editor", team: owner, preset: { kind: "member", team: "review", id: "editor" } }),
  )
  expect(links).toContainEqual(
    expect.objectContaining({ level: "project", agent: "reviewer", team: owner, preset: { kind: "member", team: "review", id: "reviewer" } }),
  )
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  expect(snapshot.teams?.find((team) => team.team === "mine")).toEqual({
    level: "project",
    team: "mine",
    enabled: false,
    agents: ["editor", "reviewer"],
  })
  expect(snapshot.links).toHaveLength(3)
  const unknown: { current?: CapturedError } = {}
  await expectDeclaredError(
    handlers["team.create"]({ level: "project", team: "other", preset: "ghost" }, throwingContext(unknown)),
    unknown,
    "team.invalid",
  )
  expect(unknown.current?.data).toEqual({ team: "other", reason: "Unknown team preset ghost" })
})

test("team.addAgent on a project team writes the member file and the next snapshot lists it", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const ctx = fullContext({ directory: project })
  const handlers = createHandlers(ctx, createState(), { builtins: [] })
  await Effect.runPromise(handlers["team.create"]({ level: "project", team: "crew" }, throwingContext({})))
  await Effect.runPromise(
    handlers["team.setEnabled"]({ level: "project", team: "crew", enabled: true }, throwingContext({})),
  )
  // DESIGN §5: the member file carries the preset's mode and description
  // with an empty body; its role text follows the member preset live.
  const added = await Effect.runPromise(
    handlers["team.addAgent"](
      { level: "project", team: "crew", id: "newbie", preset: { kind: "member", team: "review", id: "editor" } },
      throwingContext({}),
    ),
  )
  const teamDir = path.join(projectTeamsPath(project), "crew")
  expect(added).toEqual({ id: "newbie", path: path.join(teamDir, "newbie.md") })
  expectRpcBody(added)
  const written = await Bun.file(path.join(teamDir, "newbie.md")).text()
  expect(written).toStartWith("---\n")
  expect(written).toEndWith("---\n")
  expect(written).toContain("mode: primary")
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  expect(snapshot.teams?.find((team) => team.team === "crew")).toEqual({
    level: "project",
    team: "crew",
    enabled: true,
    agents: ["newbie"],
  })
  const listed = await Effect.runPromise(ctx.agent.list())
  const editor = plusTeamPresets.find((team) => team.id === "review")?.members.find((member) => member.id === "editor")
  expect(listed.data.find((entry) => String(entry.id) === "newbie")?.system).toBe(editor?.role)
})

// DESIGN §2/§4: the Defaults teams overlay directory is no longer read, so a
// file left there is no member; team.addAgent at defaults adds a member
// ENTRY instead, and never writes a file.
test("team.addAgent on a fixture defaults team adds a member entry and an overlay file is not read", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const registry = [{ name: "ship", members: [{ id: "mate", body: "ship mate body" }] }]
  const handlers = createHandlers(fullContext({ directory: project }), createState(), { builtins: registry })
  const added = await Effect.runPromise(handlers["team.addAgent"]({ level: "defaults", team: "ship", id: "rookie" }, throwingContext({})))
  expect(added).toEqual({ id: "rookie", path: "team:defaults:ship:rookie" })
  const overlayFile = path.join(process.env.OPENCODE_CONFIG_DIR ?? "", "opencodeplus", "teams-defaults", "ship", "rookie.md")
  expect(await Bun.file(overlayFile).exists()).toBe(false)
  await fs.mkdir(path.dirname(overlayFile), { recursive: true })
  await Bun.write(overlayFile, "rookie role")
  expect(discoverBuiltinTeams(registry).find((team) => team.team === "ship")?.agents.map((agent) => agent.id)).toEqual(["mate"])
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  expect(snapshot.teams?.find((team) => team.team === "ship")).toEqual({
    level: "defaults",
    team: "ship",
    enabled: false,
    agents: ["mate"],
  })
  expect(snapshot.entries).toEqual([expect.objectContaining({ catalogue: "teams", team: "ship", name: "rookie" })])
})

test("team.addAgent refuses a duplicate member id with agent.exists", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const handlers = createHandlers(fullContext({ directory: project }), createState(), { builtins: [] })
  await Effect.runPromise(handlers["team.create"]({ level: "project", team: "crew" }, throwingContext({})))
  await Effect.runPromise(
    handlers["team.addAgent"]({ level: "project", team: "crew", id: "alpha" }, throwingContext({})),
  )
  const duplicate: { current?: CapturedError } = {}
  await expectDeclaredError(
    handlers["team.addAgent"]({ level: "project", team: "crew", id: "alpha" }, throwingContext(duplicate)),
    duplicate,
    "agent.exists",
  )
  expect(typeof (duplicate.current?.data as { path?: unknown } | undefined)?.path).toBe("string")
})

test("a model activated on a project team member sets agent.model on the host and disabling the team clears it", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const hostAgent = agentInfo("m", "upstream m")
  const ctx = fullContext({
    directory: project,
    agents: [hostAgent],
    models: [modelInfo("acme", "nova-2")],
    classifications: { "": "general", "nova-2": "general" },
  })
  const state = createState()
  const handlers = createHandlers(ctx, state, { builtins: [] })

  await Effect.runPromise(handlers["team.create"]({ level: "project", team: "crew" }, throwingContext({})))
  await writeTeamAgent(path.join(projectTeamsPath(project), "crew"), "m", "crew m body")
  await Effect.runPromise(
    handlers["team.setEnabled"]({ level: "project", team: "crew", enabled: true }, throwingContext({})),
  )

  await Effect.runPromise(
    handlers["model.add"]({ level: "project", agent: "m", providerID: "acme", modelID: "nova-2" }, throwingContext({})),
  )

  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const activeRecord: Plus.SnapshotModelRecord = {
    type: "model",
    level: "project",
    agent: "m",
    providerID: "acme",
    modelID: "nova-2",
    active: true,
    updated: UPDATED,
  }
  const mutated = await Effect.runPromise(
    handlers["instructions.mutate"](
      {
        expectedRevision: snapshot.revision,
        expectedGlobalRevision: snapshot.globalRevision,
        records: [activeRecord],
      },
      throwingContext({}),
    ),
  )
  expect(mutated.ok).toBe(true)

  const listed = await Effect.runPromise(ctx.agent.list())
  const agent = listed.data.find((entry) => String(entry.id) === "m")
  expect(agent?.model).toMatchObject({ providerID: "acme", id: "nova-2" })
  expect(state.activeModels.get("m")).toMatchObject({ providerID: "acme", modelID: "nova-2" })

  await Effect.runPromise(
    handlers["team.setEnabled"]({ level: "project", team: "crew", enabled: false }, throwingContext({})),
  )
  const listedAfterDisable = await Effect.runPromise(ctx.agent.list())
  const agentAfterDisable = listedAfterDisable.data.find((entry) => String(entry.id) === "m")
  expect(agentAfterDisable?.model).toBeUndefined()
  expect(state.activeModels.get("m")).toBeUndefined()
})

test("a model activated on a global team member sets agent.model on the host and disabling the team clears it", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const hostAgent = agentInfo("m", "upstream m")
  const ctx = fullContext({
    directory: project,
    agents: [hostAgent],
    models: [modelInfo("acme", "nova-2")],
    classifications: { "": "general", "nova-2": "general" },
  })
  const state = createState()
  const handlers = createHandlers(ctx, state, { builtins: [] })

  await Effect.runPromise(handlers["team.create"]({ level: "global", team: "globalcrew" }, throwingContext({})))
  await writeTeamAgent(path.join(globalTeamsPath(), "globalcrew"), "m", "globalcrew m body")
  await Effect.runPromise(
    handlers["team.setEnabled"]({ level: "global", team: "globalcrew", enabled: true }, throwingContext({})),
  )

  await Effect.runPromise(
    handlers["model.add"]({ level: "global", agent: "m", providerID: "acme", modelID: "nova-2" }, throwingContext({})),
  )

  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const activeRecord: Plus.SnapshotModelRecord = {
    type: "model",
    level: "global",
    agent: "m",
    providerID: "acme",
    modelID: "nova-2",
    active: true,
    updated: UPDATED,
  }
  const mutated = await Effect.runPromise(
    handlers["instructions.mutate"](
      {
        expectedRevision: snapshot.revision,
        expectedGlobalRevision: snapshot.globalRevision,
        records: [activeRecord],
      },
      throwingContext({}),
    ),
  )
  expect(mutated.ok).toBe(true)

  const listed = await Effect.runPromise(ctx.agent.list())
  const agent = listed.data.find((entry) => String(entry.id) === "m")
  expect(agent?.model).toMatchObject({ providerID: "acme", id: "nova-2" })
  expect(state.activeModels.get("m")).toMatchObject({ providerID: "acme", modelID: "nova-2" })

  await Effect.runPromise(
    handlers["team.setEnabled"]({ level: "global", team: "globalcrew", enabled: false }, throwingContext({})),
  )
  const listedAfterDisable = await Effect.runPromise(ctx.agent.list())
  const agentAfterDisable = listedAfterDisable.data.find((entry) => String(entry.id) === "m")
  expect(agentAfterDisable?.model).toBeUndefined()
  expect(state.activeModels.get("m")).toBeUndefined()
})

test("a model activated on a team-only member sets agent.model and disabling the team removes the agent", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const ctx = fullContext({
    directory: project,
    models: [modelInfo("acme", "nova-2")],
    classifications: { "": "general", "nova-2": "general" },
  })
  const state = createState()
  const handlers = createHandlers(ctx, state, { builtins: [] })

  await Effect.runPromise(handlers["team.create"]({ level: "project", team: "crew" }, throwingContext({})))
  await writeTeamAgent(path.join(projectTeamsPath(project), "crew"), "teamonly", "teamonly body")
  await Effect.runPromise(
    handlers["team.setEnabled"]({ level: "project", team: "crew", enabled: true }, throwingContext({})),
  )

  await Effect.runPromise(
    handlers["model.add"]({ level: "project", agent: "teamonly", providerID: "acme", modelID: "nova-2" }, throwingContext({})),
  )

  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const activeRecord: Plus.SnapshotModelRecord = {
    type: "model",
    level: "project",
    agent: "teamonly",
    providerID: "acme",
    modelID: "nova-2",
    active: true,
    updated: UPDATED,
  }
  const mutated = await Effect.runPromise(
    handlers["instructions.mutate"](
      {
        expectedRevision: snapshot.revision,
        expectedGlobalRevision: snapshot.globalRevision,
        records: [activeRecord],
      },
      throwingContext({}),
    ),
  )
  expect(mutated.ok).toBe(true)

  const listed = await Effect.runPromise(ctx.agent.list())
  const agent = listed.data.find((entry) => String(entry.id) === "teamonly")
  expect(agent?.model).toMatchObject({ providerID: "acme", id: "nova-2" })
  expect(state.activeModels.get("teamonly")).toMatchObject({ providerID: "acme", modelID: "nova-2" })

  await Effect.runPromise(
    handlers["team.setEnabled"]({ level: "project", team: "crew", enabled: false }, throwingContext({})),
  )
  const listedAfterDisable = await Effect.runPromise(ctx.agent.list())
  const agentAfterDisable = listedAfterDisable.data.find((entry) => String(entry.id) === "teamonly")
  expect(agentAfterDisable).toBeUndefined()
  expect(state.activeModels.get("teamonly")).toBeUndefined()
})

test("a team member inherits a defaults-level model when no team-level model is set and overrides it when set", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const hostAgent = agentInfo("m", "upstream m")
  const ctx = fullContext({
    directory: project,
    agents: [hostAgent],
    models: [modelInfo("acme", "nova-1"), modelInfo("acme", "nova-2")],
    classifications: { "": "general", "nova-1": "general", "nova-2": "general" },
  })
  const state = createState()
  const handlers = createHandlers(ctx, state, { builtins: [] })

  // Add defaults model nova-1 for agent m and activate it
  await Effect.runPromise(
    handlers["model.add"]({ level: "defaults", agent: "m", providerID: "acme", modelID: "nova-1" }, throwingContext({})),
  )
  const snap1 = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  await Effect.runPromise(
    handlers["instructions.mutate"](
      {
        expectedRevision: snap1.revision,
        expectedGlobalRevision: snap1.globalRevision,
        records: [
          {
            type: "model",
            level: "defaults",
            agent: "m",
            providerID: "acme",
            modelID: "nova-1",
            active: true,
            updated: UPDATED,
          },
        ],
      },
      throwingContext({}),
    ),
  )

  // Host agent m now has nova-1
  const listed1 = await Effect.runPromise(ctx.agent.list())
  expect(listed1.data.find((entry) => String(entry.id) === "m")?.model).toMatchObject({ providerID: "acme", id: "nova-1" })

  // Enable project team with m as a member
  await Effect.runPromise(handlers["team.create"]({ level: "project", team: "crew" }, throwingContext({})))
  await writeTeamAgent(path.join(projectTeamsPath(project), "crew"), "m", "crew m body")
  await Effect.runPromise(
    handlers["team.setEnabled"]({ level: "project", team: "crew", enabled: true }, throwingContext({})),
  )

  // With team enabled and no project model record, m still resolves nova-1 from defaults
  const listed2 = await Effect.runPromise(ctx.agent.list())
  expect(listed2.data.find((entry) => String(entry.id) === "m")?.model).toMatchObject({ providerID: "acme", id: "nova-1" })
  expect(state.activeModels.get("m")).toMatchObject({ providerID: "acme", modelID: "nova-1" })

  // Add project model nova-2 for m and activate it
  await Effect.runPromise(
    handlers["model.add"]({ level: "project", agent: "m", providerID: "acme", modelID: "nova-2" }, throwingContext({})),
  )
  const snap2 = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  await Effect.runPromise(
    handlers["instructions.mutate"](
      {
        expectedRevision: snap2.revision,
        expectedGlobalRevision: snap2.globalRevision,
        records: [
          {
            type: "model",
            level: "defaults",
            agent: "m",
            providerID: "acme",
            modelID: "nova-1",
            active: true,
            updated: UPDATED,
          },
          {
            type: "model",
            level: "project",
            agent: "m",
            providerID: "acme",
            modelID: "nova-2",
            active: true,
            updated: UPDATED,
          },
        ],
      },
      throwingContext({}),
    ),
  )

  // Project model nova-2 wins
  const listed3 = await Effect.runPromise(ctx.agent.list())
  expect(listed3.data.find((entry) => String(entry.id) === "m")?.model).toMatchObject({ providerID: "acme", id: "nova-2" })
  expect(state.activeModels.get("m")).toMatchObject({ providerID: "acme", modelID: "nova-2" })

  // Disable project team: m reverts to defaults nova-1
  await Effect.runPromise(
    handlers["team.setEnabled"]({ level: "project", team: "crew", enabled: false }, throwingContext({})),
  )
  const listed4 = await Effect.runPromise(ctx.agent.list())
  expect(listed4.data.find((entry) => String(entry.id) === "m")?.model).toMatchObject({ providerID: "acme", id: "nova-1" })
  expect(state.activeModels.get("m")).toMatchObject({ providerID: "acme", modelID: "nova-1" })
})

test("team.removeAgent on a project team unlinks the file and on an enabled team unregisters from host", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const ctx = fullContext({ directory: project })
  const handlers = createHandlers(ctx, createState(), { builtins: [] })
  await Effect.runPromise(handlers["team.create"]({ level: "project", team: "crew" }, throwingContext({})))
  await Effect.runPromise(
    handlers["team.setEnabled"]({ level: "project", team: "crew", enabled: true }, throwingContext({})),
  )
  await Effect.runPromise(
    handlers["team.addAgent"]({ level: "project", team: "crew", id: "newbie" }, throwingContext({})),
  )
  const teamDir = path.join(projectTeamsPath(project), "crew")
  expect(await Bun.file(path.join(teamDir, "newbie.md")).exists()).toBe(true)
  const listedBefore = await Effect.runPromise(ctx.agent.list())
  expect(listedBefore.data.find((entry) => String(entry.id) === "newbie")).toBeDefined()

  const removed = await Effect.runPromise(
    handlers["team.removeAgent"]({ level: "project", team: "crew", id: "newbie" }, throwingContext({})),
  )
  expect(removed).toEqual({ id: "newbie", path: path.join(teamDir, "newbie.md") })
  expectRpcBody(removed)
  expect(await Bun.file(path.join(teamDir, "newbie.md")).exists()).toBe(false)
  // Removing the last member leaves an empty team directory
  expect(await fs.stat(teamDir).then((s) => s.isDirectory())).toBe(true)

  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  expect(snapshot.teams?.find((team) => team.team === "crew")).toEqual({
    level: "project",
    team: "crew",
    enabled: true,
    agents: [],
  })

  const listedAfter = await Effect.runPromise(ctx.agent.list())
  expect(listedAfter.data.find((entry) => String(entry.id) === "newbie")).toBeUndefined()
})

test("team.removeAgent on a shipped built-in member raises team.invalid", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const registry = [{ name: "ship", members: [{ id: "mate", body: "ship mate body" }] }]
  const handlers = createHandlers(fullContext({ directory: project }), createState(), { builtins: registry })
  const captured: { current?: CapturedError } = {}
  await expectDeclaredError(
    handlers["team.removeAgent"]({ level: "defaults", team: "ship", id: "mate" }, throwingContext(captured)),
    captured,
    "team.invalid",
  )
  expect(captured.current?.message).toContain('"mate" cannot be deleted: shipped member of built-in team "ship"')
})

// DESIGN §2: an overlay file is no member any more, so there is nothing to remove.
test("team.removeAgent does not know a file left in the old overlay directory", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const registry = [{ name: "ship", members: [{ id: "mate", body: "ship mate body" }] }]
  const handlers = createHandlers(fullContext({ directory: project }), createState(), { builtins: registry })
  const overlayFile = path.join(process.env.OPENCODE_CONFIG_DIR ?? "", "opencodeplus", "teams-defaults", "ship", "rookie.md")
  await fs.mkdir(path.dirname(overlayFile), { recursive: true })
  await Bun.write(overlayFile, "rookie role")
  const captured: { current?: CapturedError } = {}
  await expectDeclaredError(
    handlers["team.removeAgent"]({ level: "defaults", team: "ship", id: "rookie" }, throwingContext(captured)),
    captured,
    "agent.invalid",
  )
  expect(await Bun.file(overlayFile).exists()).toBe(true)
})

test("team.delete on a project team unlinks directory, drops record, updates snapshot, and logs actor tui", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const ctx = fullContext({ directory: project })
  const handlers = createHandlers(ctx, createState(), { builtins: [] })

  await Effect.runPromise(handlers["team.create"]({ level: "project", team: "crew" }, throwingContext({})))
  await Effect.runPromise(
    handlers["team.addAgent"]({ level: "project", team: "crew", id: "alpha" }, throwingContext({})),
  )
  await Effect.runPromise(
    handlers["team.setEnabled"]({ level: "project", team: "crew", enabled: true }, throwingContext({})),
  )

  const teamDir = path.join(projectTeamsPath(project), "crew")
  expect(await Bun.file(path.join(teamDir, "alpha.md")).exists()).toBe(true)
  const loadedBefore = await load(project)
  expect(loadedBefore.records.some((r) => r.type === "team" && r.team === "crew")).toBe(true)

  const deleted = await Effect.runPromise(
    handlers["team.delete"]({ level: "project", team: "crew" }, throwingContext({})),
  )
  expect(deleted).toEqual({ level: "project", team: "crew", removedMembers: 1 })
  expectRpcBody(deleted)

  // Directory is gone
  expect(await fs.stat(teamDir).then(() => true, () => false)).toBe(false)

  // Record is gone from store
  const loadedAfter = await load(project)
  expect(loadedAfter.records.some((r) => r.type === "team" && r.team === "crew")).toBe(false)

  // Snapshot has no crew team
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  expect(snapshot.teams?.find((team) => team.team === "crew")).toBeUndefined()

  // Log line has op team.delete, actor tui, target team:project:crew
  const logged = await Effect.runPromise(handlers["instructions.log"]({}, throwingContext({})))
  const entry = logged.entries.find((candidate) => candidate.op === "team.delete")
  if (entry === undefined) throw new Error("missing team.delete log entry")
  expect(entry.actor).toEqual({ type: "tui" })
  expect(entry.target).toBe("team:project:crew")
})

test("team.delete on an enabled team unregisters member agents from host", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const ctx = fullContext({ directory: project })
  const handlers = createHandlers(ctx, createState(), { builtins: [] })

  await Effect.runPromise(handlers["team.create"]({ level: "project", team: "crew" }, throwingContext({})))
  await Effect.runPromise(
    handlers["team.addAgent"]({ level: "project", team: "crew", id: "alpha" }, throwingContext({})),
  )
  await Effect.runPromise(
    handlers["team.setEnabled"]({ level: "project", team: "crew", enabled: true }, throwingContext({})),
  )

  const listedBefore = await Effect.runPromise(ctx.agent.list())
  expect(listedBefore.data.find((entry) => String(entry.id) === "alpha")).toBeDefined()

  await Effect.runPromise(
    handlers["team.delete"]({ level: "project", team: "crew" }, throwingContext({})),
  )

  const listedAfter = await Effect.runPromise(ctx.agent.list())
  expect(listedAfter.data.find((entry) => String(entry.id) === "alpha")).toBeUndefined()
})

test("team.delete on a global team removes the directory under global teams root", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const ctx = fullContext({ directory: project })
  const handlers = createHandlers(ctx, createState(), { builtins: [] })

  await Effect.runPromise(handlers["team.create"]({ level: "global", team: "globalcrew" }, throwingContext({})))
  await Effect.runPromise(
    handlers["team.addAgent"]({ level: "global", team: "globalcrew", id: "beta" }, throwingContext({})),
  )

  const globalTeamDir = path.join(globalTeamsPath(), "globalcrew")
  expect(await fs.stat(globalTeamDir).then(() => true, () => false)).toBe(true)

  const deleted = await Effect.runPromise(
    handlers["team.delete"]({ level: "global", team: "globalcrew" }, throwingContext({})),
  )
  expect(deleted).toEqual({ level: "global", team: "globalcrew", removedMembers: 1 })
  expectRpcBody(deleted)
  expect(await fs.stat(globalTeamDir).then(() => true, () => false)).toBe(false)
})

test("team.delete raises every declared error through a real call", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const handlers = createHandlers(fullContext({ directory: project }), createState(), { builtins: [] })

  const unknown: { current?: CapturedError } = {}
  await expectDeclaredError(
    handlers["team.delete"]({ level: "project", team: "ghost" }, throwingContext(unknown)),
    unknown,
    "team.unknown",
  )

  const invalid: { current?: CapturedError } = {}
  await expectDeclaredError(
    handlers["team.delete"]({ level: "project", team: "../bad" }, throwingContext(invalid)),
    invalid,
    "team.invalid",
  )

  const defaultsRefusal: { current?: CapturedError } = {}
  await expectDeclaredError(
    handlers["team.delete"]({ level: "defaults", team: "starter" }, throwingContext(defaultsRefusal)),
    defaultsRefusal,
    "team.invalid",
  )
  expect(defaultsRefusal.current?.message).toContain("built-in teams cannot be deleted")

  const disabledProject = (await tempRoot()).project
  const disabledHandlers = createHandlers(fullContext({ directory: disabledProject }), createState(), { builtins: [] })
  const disabled: { current?: CapturedError } = {}
  await expectDeclaredError(
    disabledHandlers["team.delete"]({ level: "project", team: "crew" }, throwingContext(disabled)),
    disabled,
    "project.disabled",
  )
})

test("team.list returns discovered teams, enabled state, and member modes without a snapshot", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const teamDir = path.join(projectTeamsPath(project), "alpha")
  await writeTeamAgent(teamDir, "member1", "member1 role")
  const subPath = path.join(teamDir, "member2.md")
  await Bun.write(subPath, formatMarkdown({ mode: "subagent", description: "sub" }, "sub role"))

  const state = createState()
  const emitted: string[] = []
  state.registration = {
    dispose: Effect.void,
    events: {
      emit: (name: string) =>
        Effect.sync(() => {
          emitted.push(name)
        }).pipe(Effect.asVoid),
    },
  } as any

  const ctx = fullContext({ directory: project })
  const handlers = createHandlers(ctx, state, { builtins: [] })

  const initial = await Effect.runPromise(handlers["team.list"](undefined, throwingContext({})))
  expect(initial.teams).toHaveLength(1)
  expect(initial.teams[0]).toMatchObject({
    level: "project",
    team: "alpha",
    enabled: false,
  })
  expect(initial.teams[0]?.members).toEqual([
    { id: "member1", mode: "primary" },
    { id: "member2", mode: "subagent" },
  ])

  await Effect.runPromise(
    handlers["team.setEnabled"]({ level: "project", team: "alpha", enabled: true }, throwingContext({})),
  )
  expect(emitted).toContain("teams.changed")

  const after = await Effect.runPromise(handlers["team.list"](undefined, throwingContext({})))
  expect(after.teams[0]?.enabled).toBe(true)

  const disabledProject = (await tempRoot()).project
  const disabledHandlers = createHandlers(fullContext({ directory: disabledProject }), createState(), { builtins: [] })
  const disabled: { current?: CapturedError } = {}
  await expectDeclaredError(
    disabledHandlers["team.list"](undefined, throwingContext(disabled)),
    disabled,
    "project.disabled",
  )
})

test("team.addAgent refuses member id special with team.invalid", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const handlers = createHandlers(fullContext({ directory: project }), createState(), { builtins: [] })
  await Effect.runPromise(handlers["team.create"]({ level: "project", team: "crew" }, throwingContext({})))
  const captured: { current?: CapturedError } = {}
  await expectDeclaredError(
    handlers["team.addAgent"]({ level: "project", team: "crew", id: "special" }, throwingContext(captured)),
    captured,
    "team.invalid",
  )
  expect(captured.current?.message).toContain('Member id "special" is reserved')
})

test("enable team with special override reaches host agent.system and agent.model, disable restores, project team beats global for same team name", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const specialAgent = { ...agentInfo("title", "upstream title text"), origin: "special" as const }
  const ctx = fullContext({
    directory: project,
    agents: [specialAgent],
    models: [modelInfo("acme", "nova-project"), modelInfo("acme", "nova-global")],
    classifications: { "": "general", "nova-project": "general", "nova-global": "general" },
  })
  const state = createState()
  const handlers = createHandlers(ctx, state, { builtins: [] })

  // 1. Create global team crew
  await Effect.runPromise(handlers["team.create"]({ level: "global", team: "crew" }, throwingContext({})))
  // 2. Create project team crew
  await Effect.runPromise(handlers["team.create"]({ level: "project", team: "crew" }, throwingContext({})))

  const snap1 = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))

  const records: Plus.SnapshotRecord[] = [
    {
      type: "customization",
      level: "global",
      agent: "title",
      item: "system:role",
      section: null,
      team: { level: "global", team: "crew" },
      text: "global title text",
      basedOn: "fp",
      updated: UPDATED,
    },
    {
      type: "model",
      level: "global",
      agent: "title",
      team: { level: "global", team: "crew" },
      providerID: "acme",
      modelID: "nova-global",
      active: true,
      updated: UPDATED,
    },
    {
      type: "customization",
      level: "project",
      agent: "title",
      item: "system:role",
      section: null,
      team: { level: "project", team: "crew" },
      text: "project title text",
      basedOn: "fp",
      updated: UPDATED,
    },
    {
      type: "model",
      level: "project",
      agent: "title",
      team: { level: "project", team: "crew" },
      providerID: "acme",
      modelID: "nova-project",
      active: true,
      updated: UPDATED,
    },
  ]
  await Effect.runPromise(
    handlers["instructions.mutate"](
      {
        expectedRevision: snap1.revision,
        expectedGlobalRevision: snap1.globalRevision,
        records,
      },
      throwingContext({}),
    ),
  )

  // Case A: Enable only global team "crew"
  await Effect.runPromise(handlers["team.setEnabled"]({ level: "global", team: "crew", enabled: true }, throwingContext({})))
  const listedGlobal = await Effect.runPromise(ctx.agent.list())
  const titleGlobal = listedGlobal.data.find((e) => String(e.id) === "title")
  expect(titleGlobal?.system).toBe("global title text")
  expect(titleGlobal?.model).toMatchObject({ providerID: "acme", id: "nova-global" })
  expect(state.activeModels.get("title")).toMatchObject({ providerID: "acme", modelID: "nova-global" })

  // Case B: Enable project team "crew" as well -> project beats global for
  // same team name. team.setEnabled keeps one team enabled, so the second
  // enablement goes straight through the store to have both on at once.
  await coEnableTeam(project, handlers, "project", "crew")
  const listedProject = await Effect.runPromise(ctx.agent.list())
  const titleProject = listedProject.data.find((e) => String(e.id) === "title")
  expect(titleProject?.system).toBe("project title text")
  expect(titleProject?.model).toMatchObject({ providerID: "acme", id: "nova-project" })
  expect(state.activeModels.get("title")).toMatchObject({ providerID: "acme", modelID: "nova-project" })

  // Case C: Disable project team "crew" -> global team "crew" is still enabled, so global wins!
  await Effect.runPromise(handlers["team.setEnabled"]({ level: "project", team: "crew", enabled: false }, throwingContext({})))
  const listedBackToGlobal = await Effect.runPromise(ctx.agent.list())
  const titleBackToGlobal = listedBackToGlobal.data.find((e) => String(e.id) === "title")
  expect(titleBackToGlobal?.system).toBe("global title text")
  expect(titleBackToGlobal?.model).toMatchObject({ providerID: "acme", id: "nova-global" })
  expect(state.activeModels.get("title")).toMatchObject({ providerID: "acme", modelID: "nova-global" })

  // Case D: Disable global team "crew" -> all disabled, restored to non-team state!
  await Effect.runPromise(handlers["team.setEnabled"]({ level: "global", team: "crew", enabled: false }, throwingContext({})))
  const listedRestored = await Effect.runPromise(ctx.agent.list())
  const titleRestored = listedRestored.data.find((e) => String(e.id) === "title")
  expect(titleRestored?.system).toBe("upstream title text")
  expect(titleRestored?.model).toBeUndefined()
  expect(state.activeModels.get("title")).toBeUndefined()
})

// A Special agent under an enabled team resolves with the team's chain even
// when that team sets no active model for it: its tool row turned off under
// Teams → crew → Special → summary is what apply enforces.
test("a Special agent's tool row turned off under the enabled team is enforced without a team-scoped model", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const summary = { ...agentInfo("summary", "upstream summary text"), origin: "special" as const }
  const ctx = fullContext({
    directory: project,
    agents: [summary, ...["general", "explore"].map((id) => ({ ...agentInfo(id, `${id} prompt`), hidden: true }))],
    tools: [{ id: "shell", description: "Execute shell commands.", options: { codemode: false } }],
    hooks: { current: 0 },
  })
  const state = createState()
  const handlers = createHandlers(ctx, state, { builtins: [] })
  await Effect.runPromise(handlers["team.create"]({ level: "project", team: "crew" }, throwingContext({})))
  await Effect.runPromise(handlers["team.setEnabled"]({ level: "project", team: "crew", enabled: true }, throwingContext({})))
  const before = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const records: Plus.SnapshotRecord[] = [
    {
      type: "customization",
      level: "project",
      agent: "summary",
      item: "tool:shell",
      section: null,
      team: { level: "project", team: "crew" },
      state: "off",
      basedOn: "fp",
      updated: UPDATED,
    },
    // Old team-scoped records must not make ordinary hidden agents Special.
    ...["general", "explore"].map((agent) => ({
      type: "customization" as const,
      level: "project" as const,
      agent,
      item: "tool:shell",
      section: null,
      team: { level: "project" as const, team: "crew" },
      state: "off" as const,
      basedOn: "fp",
      updated: UPDATED,
    })),
  ]
  await Effect.runPromise(
    handlers["instructions.mutate"](
      { expectedRevision: before.revision, expectedGlobalRevision: before.globalRevision, records },
      throwingContext({}),
    ),
  )
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const shown = expandedTree(memoInputOf(snapshot)).find((node) => node.id === "item:project:crew/:special:summary:tool:shell")
  expect(shown?.badges.state).toBe("off")
  expect(state.installedTools).toContainEqual(expect.objectContaining({ agent: "summary", tool: "shell", enabled: false }))
  for (const id of ["general", "explore"]) {
    expect(snapshot.agents.find((agent) => agent.id === id)?.origin).toBe("native")
    const nodes = expandedTree(memoInputOf(snapshot))
    expect(nodes.some((node) => node.id === `team:project:crew:special:${id}`)).toBe(false)
    expect(nodes.find((node) => node.id === `item:project:${id}:tool:shell`)?.badges.state).toBe("on")
    expect(state.installedTools).not.toContainEqual(expect.objectContaining({ agent: id, tool: "shell", enabled: false }))
  }
})

function makeRunRecord(overrides: Partial<RunRecord> & { id: string }): RunRecord {
  const now = new Date().toISOString()
  return {
    role: "gemini-implementer",
    kind: "w",
    repo: "opencode",
    repoKey: "opencode",
    directory: "/tmp/wt-rpc-test",
    paths: [],
    branch: "team/test",
    base: "0123456789abcdef0123456789abcdef01234567",
    head: "0123456789abcdef0123456789abcdef01234567",
    state: "idle",
    attempts: [],
    task: null,
    parent: null,
    children: [],
    briefSha: "abc",
    bundle: "test",
    budget: {},
    createdAt: now,
    lastUsed: now,
    sessionID: null,
    configDigest: null,
    history: [],
    ...overrides,
  }
}

test("team.runs.list returns namespace runs, sorted lastUsed desc, with all 9 fields, and all:false hides superseded/reaped", async () => {
  const { project } = await tempRoot()
  const teamsRoot = teamsDataDir()
  const ctx = fullContext({ directory: project })
  const handlers = createHandlers(ctx, createState(), { builtins: [] })

  const run1 = makeRunRecord({
    id: "main-01",
    role: "opus-orchestrator",
    state: "working",
    task: "T1",
    lastUsed: "2026-09-10T10:00:00.000Z",
    sessionID: "ses_main_01",
    parent: null,
  })
  const run2 = makeRunRecord({
    id: "w-child-01",
    role: "gemini-implementer",
    state: "idle",
    task: "T2",
    lastUsed: "2026-09-10T12:00:00.000Z",
    sessionID: "ses_child_01",
    parent: "main-01",
  })
  const run3 = makeRunRecord({
    id: "w-child-02",
    role: "deepseek-implementer",
    state: "superseded",
    task: null,
    lastUsed: "2026-09-10T11:00:00.000Z",
    sessionID: null,
    parent: "main-01",
  })

  await saveRun(teamsRoot, run1)
  await saveRun(teamsRoot, run2)
  await saveRun(teamsRoot, run3)

  // 1. Default (all: false) hides superseded run3; sorted lastUsed desc (run2 then run1)
  const defaultList = await Effect.runPromise(handlers["team.runs.list"]({ all: false }, throwingContext({})))
  expect(defaultList.runs).toHaveLength(2)
  expect(defaultList.runs.map((r) => r.id)).toEqual(["w-child-01", "main-01"])

  // Check all 9 fields for run2
  const entry2 = defaultList.runs[0]
  expect(entry2).toEqual({
    id: "w-child-01",
    role: "gemini-implementer",
    state: "idle",
    task: "T2",
    head: run2.head,
    worktree: "present",
    lastUsed: "2026-09-10T12:00:00.000Z",
    sessionID: "ses_child_01",
    parent: "main-01",
  })
  expectRpcBody(defaultList)

  // 2. all: true includes superseded run3, sorted lastUsed desc: run2 (12:00), run3 (11:00), run1 (10:00)
  const allList = await Effect.runPromise(handlers["team.runs.list"]({ all: true }, throwingContext({})))
  expect(allList.runs).toHaveLength(3)
  expect(allList.runs.map((r) => r.id)).toEqual(["w-child-01", "w-child-02", "main-01"])
})

test("team.runs.stop stops any run in the namespace without owner check, reconciles dead, preserves terminal, and fails E_BUSY when working", async () => {
  const { project } = await tempRoot()
  const teamsRoot = teamsDataDir()
  const ctx = fullContext({
    directory: project,
    session: { interrupt: () => Effect.succeed({ interrupted: true }) },
  })
  const handlers = createHandlers(ctx, createState(), { builtins: [] })

  const runIdle = makeRunRecord({
    id: "w-idle-01",
    state: "idle",
    sessionID: "ses_idle_01",
    parent: "someone-else",
  })
  const runDead = makeRunRecord({
    id: "w-dead-01",
    state: "dead",
    sessionID: "ses_dead_01",
    parent: "someone-else",
  })
  const runWorking = makeRunRecord({
    id: "w-working-01",
    state: "working",
    sessionID: "ses_working_01",
    parent: "someone-else",
  })
  const runSuperseded = makeRunRecord({
    id: "w-sup-01",
    state: "superseded",
    sessionID: null,
    parent: "someone-else",
  })

  await saveRun(teamsRoot, runIdle)
  await saveRun(teamsRoot, runDead)
  await saveRun(teamsRoot, runWorking)
  await saveRun(teamsRoot, runSuperseded)

  // 1. Stop idle run (even though caller is not its parent) -> stopped
  const stopIdle = await Effect.runPromise(handlers["team.runs.stop"]({ run: "w-idle-01" }, throwingContext({})))
  expect(stopIdle).toEqual({ run: "w-idle-01", state: "stopped" })
  expect((await loadRun(teamsRoot, "w-idle-01"))?.state).toBe("stopped")
  expectRpcBody(stopIdle)

  // 2. Stop dead run -> reconciled to stopped
  const stopDead = await Effect.runPromise(handlers["team.runs.stop"]({ run: "w-dead-01" }, throwingContext({})))
  expect(stopDead).toEqual({ run: "w-dead-01", state: "stopped" })
  expect((await loadRun(teamsRoot, "w-dead-01"))?.state).toBe("stopped")

  // 3. Stop superseded run -> preserves terminal state without error
  const stopSup = await Effect.runPromise(handlers["team.runs.stop"]({ run: "w-sup-01" }, throwingContext({})))
  expect(stopSup).toEqual({ run: "w-sup-01", state: "superseded" })
  expect((await loadRun(teamsRoot, "w-sup-01"))?.state).toBe("superseded")

  // 4. Stop working run -> fails with E_BUSY
  const busy: { current?: CapturedError } = {}
  await expectDeclaredError(
    handlers["team.runs.stop"]({ run: "w-working-01" }, throwingContext(busy)),
    busy,
    "E_BUSY",
  )
  expect(busy.current?.message).toContain("working")

  // 5. Stop unknown run -> fails with run.unknown
  const unknown: { current?: CapturedError } = {}
  await expectDeclaredError(
    handlers["team.runs.stop"]({ run: "w-nonexistent" }, throwingContext(unknown)),
    unknown,
    "run.unknown",
  )
  expect(unknown.current?.message).toContain("not found")
})

test("team.addAgent and team.removeAgent refuse a tool actor on a protected member and allow the TUI", async () => {
  const { project } = await tempRoot()
  await enable(project)
  await Bun.write(
    path.join(project, ".opencodeplus", "project.json"),
    JSON.stringify({ version: 1, protectedAgents: ["alpha"] }),
  )
  const handlers = createHandlers(fullContext({ directory: project }), createState(), { builtins: [] })
  await Effect.runPromise(handlers["team.create"]({ level: "project", team: "crew" }, throwingContext({})))
  const memberFile = path.join(projectTeamsPath(project), "crew", "alpha.md")

  const addRefused: { current?: CapturedError } = {}
  await expectDeclaredError(
    handlers["team.addAgent"]({ level: "project", team: "crew", id: "alpha", actor: { type: "tool" } }, throwingContext(addRefused)),
    addRefused,
    "agent.protected",
  )
  expect(addRefused.current?.message).toContain('protected agent "alpha"')
  expect(await Bun.file(memberFile).exists()).toBe(false)

  const added = await Effect.runPromise(
    handlers["team.addAgent"]({ level: "project", team: "crew", id: "alpha" }, throwingContext({})),
  )
  expect(added.id).toBe("alpha")
  expect(await Bun.file(memberFile).exists()).toBe(true)

  const removeRefused: { current?: CapturedError } = {}
  await expectDeclaredError(
    handlers["team.removeAgent"]({ level: "project", team: "crew", id: "alpha", actor: { type: "tool" } }, throwingContext(removeRefused)),
    removeRefused,
    "agent.protected",
  )
  expect(await Bun.file(memberFile).exists()).toBe(true)

  const removed = await Effect.runPromise(
    handlers["team.removeAgent"]({ level: "project", team: "crew", id: "alpha" }, throwingContext({})),
  )
  expect(removed.id).toBe("alpha")
  expect(await Bun.file(memberFile).exists()).toBe(false)
})

test("team.delete refuses a tool actor when the team contains a protected member and deletes for the TUI", async () => {
  const { project } = await tempRoot()
  await enable(project)
  await Bun.write(
    path.join(project, ".opencodeplus", "project.json"),
    JSON.stringify({ version: 1, protectedAgents: ["alpha"] }),
  )
  const handlers = createHandlers(fullContext({ directory: project }), createState(), { builtins: [] })
  await Effect.runPromise(handlers["team.create"]({ level: "project", team: "crew" }, throwingContext({})))
  await Effect.runPromise(
    handlers["team.addAgent"]({ level: "project", team: "crew", id: "alpha" }, throwingContext({})),
  )
  const teamDir = path.join(projectTeamsPath(project), "crew")

  const refused: { current?: CapturedError } = {}
  await expectDeclaredError(
    handlers["team.delete"]({ level: "project", team: "crew", actor: { type: "tool" } }, throwingContext(refused)),
    refused,
    "agent.protected",
  )
  expect(refused.current?.message).toContain('protected agent "alpha"')
  expect(await Bun.file(path.join(teamDir, "alpha.md")).exists()).toBe(true)

  const deleted = await Effect.runPromise(
    handlers["team.delete"]({ level: "project", team: "crew" }, throwingContext({})),
  )
  expect(deleted).toEqual({ level: "project", team: "crew", removedMembers: 1 })
  expect(await Bun.file(path.join(teamDir, "alpha.md")).exists()).toBe(false)
})

// The template is a team preset now (DESIGN §5): the Plus `review` preset's
// members are reviewer and editor, and a tool actor may not create a
// protected one.
test("team.create with a template refuses a tool actor cloning a protected member and seeds for the TUI", async () => {
  const { project } = await tempRoot()
  await enable(project)
  await Bun.write(
    path.join(project, ".opencodeplus", "project.json"),
    JSON.stringify({ version: 1, protectedAgents: ["reviewer"] }),
  )
  const handlers = createHandlers(fullContext({ directory: project }), createState(), { builtins: [] })
  const teamDir = path.join(projectTeamsPath(project), "mine")

  const refused: { current?: CapturedError } = {}
  await expectDeclaredError(
    handlers["team.create"]({ level: "project", team: "mine", preset: "review", actor: { type: "tool" } }, throwingContext(refused)),
    refused,
    "agent.protected",
  )
  expect(refused.current?.message).toContain('protected agent "reviewer"')
  expect(await Bun.file(path.join(teamDir, "reviewer.md")).exists()).toBe(false)
  expect(await Bun.file(path.join(teamDir, "editor.md")).exists()).toBe(false)

  const created = await Effect.runPromise(
    handlers["team.create"]({ level: "project", team: "mine", preset: "review" }, throwingContext({})),
  )
  expect(created).toEqual({ level: "project", team: "mine", enabled: false })
  expect(await Bun.file(path.join(teamDir, "reviewer.md")).exists()).toBe(true)
  expect(await Bun.file(path.join(teamDir, "editor.md")).exists()).toBe(true)
})
