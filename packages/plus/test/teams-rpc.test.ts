import { afterEach, expect, test } from "bun:test"
import { Effect, Exit, Schema } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { formatMarkdown, parseFrontmatter } from "../src/agents/files.js"
import { agentBody } from "../src/instructions/discover.js"
import { parseTeamFields } from "../src/instructions/teams-apply.js"
import { createHandlers, createState } from "../src/index.js"
import { fingerprint } from "../src/instructions/model.js"
import { globalTeamsPath, projectTeamsPath } from "../src/instructions/paths.js"
import { discoverBuiltinTeams, globalDefaultsTeamsPath } from "../src/instructions/teams.js"
import { load, type StoredRecord } from "../src/instructions/store.js"
import { enable } from "../src/project.js"
import { Plus } from "../src/rpc.js"
import { agentInfo, fullContext, modelInfo } from "./harness.js"

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
  expect(toggled).toEqual({ level: "project", team: "crew", enabled: true })
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
  expect(toggled).toEqual({ level: "defaults", team: "ship", enabled: true })
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

test("team.create with a Defaults template seeds member files from the registry", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const registry = [
    {
      name: "review",
      members: [
        {
          id: "editor",
          body: "You are an editor. Tighten the wording without changing the meaning.",
          fields: { description: "editor desc", mode: "primary" as const, permissions: [] },
        },
        { id: "reviewer", body: "You are a reviewer. Check the change for correctness and list issues first." },
      ],
    },
  ]
  const handlers = createHandlers(fullContext({ directory: project }), createState(), { builtins: registry })
  const created = await Effect.runPromise(
    handlers["team.create"]({ level: "project", team: "mine", template: "review" }, throwingContext({})),
  )
  expect(created).toEqual({ level: "project", team: "mine", enabled: false })
  expectRpcBody(created)
  const teamDir = path.join(projectTeamsPath(project), "mine")
  const editorText = await fs.readFile(path.join(teamDir, "editor.md"), "utf8")
  const reviewerText = await fs.readFile(path.join(teamDir, "reviewer.md"), "utf8")
  const [editorMember, reviewerMember] = registry[0]!.members
  expect(editorText).toBe(formatMarkdown(editorMember!.fields as never, editorMember!.body))
  expect(agentBody(editorText)).toBe(editorMember!.body)
  expect(parseTeamFields(editorText)).toEqual(editorMember!.fields!)
  expect(reviewerText).toBe(formatMarkdown(undefined, reviewerMember!.body))
  expect(agentBody(reviewerText)).toBe(reviewerMember!.body)
  expect(parseFrontmatter(reviewerText)).toBeUndefined()
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  expect(snapshot.teams?.find((team) => team.team === "mine")).toEqual({
    level: "project",
    team: "mine",
    enabled: false,
    agents: ["editor", "reviewer"],
  })
  const unknown: { current?: CapturedError } = {}
  await expectDeclaredError(
    handlers["team.create"]({ level: "project", team: "other", template: "ghost" }, throwingContext(unknown)),
    unknown,
    "team.invalid",
  )
  expect(unknown.current?.data).toEqual({ team: "other", reason: "Unknown team template ghost" })
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
  const added = await Effect.runPromise(
    handlers["team.addAgent"]({ level: "project", team: "crew", id: "newbie", prompt: "newbie role" }, throwingContext({})),
  )
  const teamDir = path.join(projectTeamsPath(project), "crew")
  expect(added).toEqual({ id: "newbie", path: path.join(teamDir, "newbie.md") })
  expectRpcBody(added)
  expect(await Bun.file(path.join(teamDir, "newbie.md")).text()).toContain("newbie role")
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  expect(snapshot.teams?.find((team) => team.team === "crew")).toEqual({
    level: "project",
    team: "crew",
    enabled: true,
    agents: ["newbie"],
  })
  const listed = await Effect.runPromise(ctx.agent.list())
  expect(listed.data.find((entry) => String(entry.id) === "newbie")?.system).toBe("newbie role")
})

test("team.addAgent on a fixture defaults team writes the overlay and discover lists it with path", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const registry = [{ name: "ship", members: [{ id: "mate", body: "ship mate body" }] }]
  const handlers = createHandlers(fullContext({ directory: project }), createState(), { builtins: registry })
  const added = await Effect.runPromise(
    handlers["team.addAgent"]({ level: "defaults", team: "ship", id: "rookie", prompt: "rookie role" }, throwingContext({})),
  )
  const overlayDir = path.join(globalDefaultsTeamsPath(), "ship")
  expect(added).toEqual({ id: "rookie", path: path.join(overlayDir, "rookie.md") })
  expectRpcBody(added)
  expect(await Bun.file(path.join(overlayDir, "rookie.md")).text()).toContain("rookie role")
  const discovered = discoverBuiltinTeams(registry)
  const ship = discovered.find((team) => team.team === "ship")
  expect(ship?.level).toBe("defaults")
  expect(ship?.agents.map((agent) => agent.id).toSorted()).toEqual(["mate", "rookie"])
  expect(ship?.agents.find((agent) => agent.id === "rookie")?.path).toBe(path.join(overlayDir, "rookie.md"))
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  expect(snapshot.teams?.find((team) => team.team === "ship")).toEqual({
    level: "defaults",
    team: "ship",
    enabled: false,
    agents: ["mate", "rookie"],
    overlay: ["rookie"],
  })
})

test("team.addAgent refuses a duplicate member id with agent.exists", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const handlers = createHandlers(fullContext({ directory: project }), createState(), { builtins: [] })
  await Effect.runPromise(handlers["team.create"]({ level: "project", team: "crew" }, throwingContext({})))
  await Effect.runPromise(
    handlers["team.addAgent"]({ level: "project", team: "crew", id: "alpha", prompt: "alpha role" }, throwingContext({})),
  )
  const duplicate: { current?: CapturedError } = {}
  await expectDeclaredError(
    handlers["team.addAgent"]({ level: "project", team: "crew", id: "alpha", prompt: "again" }, throwingContext(duplicate)),
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
    handlers["team.addAgent"]({ level: "project", team: "crew", id: "newbie", prompt: "newbie role" }, throwingContext({})),
  )
  const teamDir = path.join(projectTeamsPath(project), "crew")
  expect(await Bun.file(path.join(teamDir, "newbie.md")).exists()).toBe(true)
  const listedBefore = await Effect.runPromise(ctx.agent.list())
  expect(listedBefore.data.find((entry) => String(entry.id) === "newbie")?.system).toBe("newbie role")

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

test("team.removeAgent on an overlay member unlinks the overlay file", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const registry = [{ name: "ship", members: [{ id: "mate", body: "ship mate body" }] }]
  const handlers = createHandlers(fullContext({ directory: project }), createState(), { builtins: registry })
  await Effect.runPromise(
    handlers["team.addAgent"]({ level: "defaults", team: "ship", id: "rookie", prompt: "rookie role" }, throwingContext({})),
  )
  const overlayFile = path.join(globalDefaultsTeamsPath(), "ship", "rookie.md")
  expect(await Bun.file(overlayFile).exists()).toBe(true)

  const removed = await Effect.runPromise(
    handlers["team.removeAgent"]({ level: "defaults", team: "ship", id: "rookie" }, throwingContext({})),
  )
  expect(removed).toEqual({ id: "rookie", path: overlayFile })
  expectRpcBody(removed)
  expect(await Bun.file(overlayFile).exists()).toBe(false)

  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  expect(snapshot.teams?.find((team) => team.team === "ship")).toEqual({
    level: "defaults",
    team: "ship",
    enabled: false,
    agents: ["mate"],
  })
})

test("team.delete on a project team unlinks directory, drops record, updates snapshot, and logs actor tui", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const ctx = fullContext({ directory: project })
  const handlers = createHandlers(ctx, createState(), { builtins: [] })

  await Effect.runPromise(handlers["team.create"]({ level: "project", team: "crew" }, throwingContext({})))
  await Effect.runPromise(
    handlers["team.addAgent"]({ level: "project", team: "crew", id: "alpha", prompt: "alpha role" }, throwingContext({})),
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
    handlers["team.addAgent"]({ level: "project", team: "crew", id: "alpha", prompt: "alpha role" }, throwingContext({})),
  )
  await Effect.runPromise(
    handlers["team.setEnabled"]({ level: "project", team: "crew", enabled: true }, throwingContext({})),
  )

  const listedBefore = await Effect.runPromise(ctx.agent.list())
  expect(listedBefore.data.find((entry) => String(entry.id) === "alpha")?.system).toBe("alpha role")

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
    handlers["team.addAgent"]({ level: "global", team: "globalcrew", id: "beta", prompt: "beta role" }, throwingContext({})),
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
