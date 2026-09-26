// DESIGN §5 at the server: create flows name a preset, Defaults entries and
// user presets are created and deleted over RPC, links are set and refused,
// and a team tool row that is off refuses the call at core.
import { afterEach, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { apply } from "../src/instructions/apply.js"
import { fingerprint, presetKey, type Item, type LinkRecord } from "../src/instructions/model.js"
import { projectTeamsPath } from "../src/instructions/paths.js"
import { chainContext, plusAgentPresets } from "../src/instructions/presets.js"
import { badgeLabels } from "../src/instructions/from-label.js"
import { toggle } from "../src/instructions/ops.js"
import { memoInputOf } from "../src/instructions/snapshot.js"
import { linkedProjects, load, save, updateGated, type StoredRecord } from "../src/instructions/store.js"
import { expandedTree } from "../src/instructions/tree.js"
import { createHandlers, createState } from "../src/index.js"
import { disable, enable } from "../src/project.js"
import { agentHarness, agentInfo, context, fullContext } from "./harness.js"

const roots: string[] = []
const priorConfigDir = process.env.OPENCODE_CONFIG_DIR
const priorXdgDataHome = process.env.XDG_DATA_HOME
const UPDATED = "2026-09-25T00:00:00.000Z"

afterEach(async () => {
  if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
  if (priorXdgDataHome === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = priorXdgDataHome
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

interface CapturedError {
  type: string
  message: string
  data?: unknown
}

function throwingContext(captured: { current?: CapturedError } = {}) {
  return {
    error: (type: string, message: string, data?: unknown): never => {
      const failure: CapturedError = data === undefined ? { type, message } : { type, message, data }
      captured.current = failure
      throw failure
    },
  }
}

async function setup(options: { protectedAgents?: string[] } = {}) {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-presets-rpc-"))
  roots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  process.env.XDG_DATA_HOME = path.join(root, "share")
  const project = path.join(root, "project")
  await disable(project)
  await enable(project)
  if (options.protectedAgents !== undefined)
    await Bun.write(
      path.join(project, ".opencodeplus", "project.json"),
      JSON.stringify({ version: 1, protectedAgents: options.protectedAgents }),
    )
  const build = { ...agentInfo("build", "Build the thing."), description: "The default agent.", mode: "primary" as const }
  const ctx = fullContext({ directory: project, agents: [build] })
  const handlers = createHandlers(ctx, createState(), { builtins: [] })
  return { project, ctx, handlers }
}

// The handler's declared error, through the same side channel the other RPC
// suites use (the test double throws what `context.error` is given).
async function declared(run: (context: ReturnType<typeof throwingContext>) => Effect.Effect<unknown, unknown>): Promise<CapturedError> {
  const captured: { current?: CapturedError } = {}
  const exit = await Effect.runPromiseExit(Effect.suspend(() => run(throwingContext(captured))))
  expect(Exit.isFailure(exit)).toBe(true)
  if (captured.current === undefined) throw new Error("expected a declared error")
  return captured.current
}

async function stored(project: string) {
  return (await load(project)).records
}

function linksOf(records: Awaited<ReturnType<typeof stored>>): LinkRecord[] {
  return records.filter((record): record is LinkRecord => record.type === "link")
}

const orchestrator = plusAgentPresets.find((preset) => preset.id === "orchestrator")

test("agent.create from a preset copies mode and description, keeps the body empty and links; a team preset is refused", async () => {
  const { project, handlers } = await setup()
  const created = await Effect.runPromise(
    handlers["agent.create"]({ scope: "project", id: "alice", preset: { kind: "agent", id: "orchestrator" } }, throwingContext()),
  )
  const text = await Bun.file(created.path).text()
  expect(text).toContain(`description: "${orchestrator?.description}"`)
  expect(text).toContain("mode: primary")
  expect(text.endsWith("---\n")).toBe(true)
  expect(linksOf(await stored(project))).toEqual([
    expect.objectContaining({ level: "project", agent: "alice", preset: { kind: "agent", id: "orchestrator" } }),
  ])
  // A member preset works the same way.
  await Effect.runPromise(
    handlers["agent.create"]({ scope: "global", id: "carol", preset: { kind: "member", team: "review", id: "editor" } }, throwingContext()),
  )
  expect(linksOf(await stored(project))).toContainEqual(
    expect.objectContaining({ level: "global", agent: "carol", preset: { kind: "member", team: "review", id: "editor" } }),
  )
  const team = await declared((context) =>
    handlers["agent.create"]({ scope: "project", id: "dave", preset: { kind: "team", id: "starter" } }, context),
  )
  expect(team.type).toBe("preset.invalid")
  expect(await Bun.file(path.join(project, ".opencode", "agent", "dave.md")).exists()).toBe(false)
})

// Core skips an empty agent file (config/plugin/agent.ts loadEntry decodes
// only a file with content), so "None — everything off" must still write a
// file core decodes: its default mode, `primary`, in frontmatter.
test("agent.create with no preset writes a file the host registers, mixed-case id included", async () => {
  const { project, handlers } = await setup()
  const created = await Effect.runPromise(
    handlers["agent.create"]({ scope: "project", id: "Opus-Orchestrator-Max" }, throwingContext()),
  )
  expect(created.path).toBe(path.join(project, ".opencode", "agent", "Opus-Orchestrator-Max.md"))
  expect(await Bun.file(created.path).text()).toBe("---\nmode: primary\n---\n")
  expect(linksOf(await stored(project))).toEqual([])
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext()))
  expect(snapshot.agents).toContainEqual(expect.objectContaining({ id: "Opus-Orchestrator-Max", scope: "project", fileBacked: true }))
  // A member created with no preset registers the same way.
  await Effect.runPromise(handlers["team.create"]({ level: "project", team: "crew" }, throwingContext()))
  const member = await Effect.runPromise(handlers["team.addAgent"]({ level: "project", team: "crew", id: "Ocp-Bob" }, throwingContext()))
  expect(await Bun.file(member.path).text()).toBe("---\nmode: primary\n---\n")
})

test("team.create from a team preset creates its members linked to the member presets and links the team", async () => {
  const { project, handlers } = await setup()
  await Effect.runPromise(handlers["team.create"]({ level: "project", team: "crew", preset: "starter" }, throwingContext()))
  const dir = path.join(projectTeamsPath(project), "crew")
  expect((await fs.readdir(dir)).toSorted()).toEqual(["helper.md", "planner.md"])
  expect(await Bun.file(path.join(dir, "planner.md")).text()).toContain("mode: primary")
  const links = linksOf(await stored(project))
  expect(links).toContainEqual(expect.objectContaining({ agent: null, team: { level: "project", team: "crew" }, preset: { kind: "team", id: "starter" } }))
  expect(links).toContainEqual(
    expect.objectContaining({ agent: "planner", team: { level: "project", team: "crew" }, preset: { kind: "member", team: "starter", id: "planner" } }),
  )
  expect(links).toContainEqual(
    expect.objectContaining({ agent: "helper", team: { level: "project", team: "crew" }, preset: { kind: "member", team: "starter", id: "helper" } }),
  )
})

test("team.addAgent links a member to its preset; at defaults it creates a member entry", async () => {
  const { project, handlers } = await setup()
  await Effect.runPromise(handlers["team.create"]({ level: "project", team: "crew" }, throwingContext()))
  await Effect.runPromise(
    handlers["team.addAgent"]({ level: "project", team: "crew", id: "ocp-alice", preset: { kind: "agent", id: "implementer" } }, throwingContext()),
  )
  expect(linksOf(await stored(project))).toContainEqual(
    expect.objectContaining({ level: "project", agent: "ocp-alice", team: { level: "project", team: "crew" }, preset: { kind: "agent", id: "implementer" } }),
  )
  const entry = await Effect.runPromise(
    handlers["team.addAgent"]({ level: "defaults", team: "crew*", id: "*impl*", preset: { kind: "agent", id: "implementer" } }, throwingContext()),
  )
  expect(entry).toEqual({ id: "*impl*", path: "team:defaults:crew*:*impl*" })
  const records = await stored(project)
  expect(records.filter((record) => record.type === "entry")).toEqual([
    expect.objectContaining({ catalogue: "teams", team: "crew*", name: "*impl*" }),
  ])
})

test("entry.create, entry.delete and entry.rename: duplicates, bad names, a native agent's own row, records follow", async () => {
  const { project, handlers } = await setup()
  const created = await Effect.runPromise(
    handlers["entry.create"]({ catalogue: "agents", name: "*orchestrator*", preset: { kind: "agent", id: "orchestrator" } }, throwingContext()),
  )
  expect(created).toEqual({ id: "agent:defaults:*orchestrator*", catalogue: "agents", name: "*orchestrator*" })
  expect(linksOf(await stored(project))).toEqual([
    expect.objectContaining({ level: "defaults", agent: "*orchestrator*", preset: { kind: "agent", id: "orchestrator" } }),
  ])
  expect((await declared((context) => handlers["entry.create"]({ catalogue: "agents", name: " *orchestrator* " }, context))).type).toBe("entry.exists")
  expect((await declared((context) => handlers["entry.create"]({ catalogue: "agents", name: "build" }, context))).type).toBe("entry.exists")
  expect((await declared((context) => handlers["entry.create"]({ catalogue: "agents", name: "a:b" }, context))).type).toBe("entry.invalid")
  expect((await declared((context) => handlers["entry.create"]({ catalogue: "agents", name: "  " }, context))).type).toBe("entry.invalid")
  expect((await declared((context) => handlers["entry.create"]({ catalogue: "agents", name: "crew/" }, context))).type).toBe("entry.invalid")
  await Effect.runPromise(handlers["entry.create"]({ catalogue: "agents", name: "crew/*" }, throwingContext()))
  await Effect.runPromise(handlers["entry.delete"]({ catalogue: "agents", name: "crew/*" }, throwingContext()))
  expect((await declared((context) => handlers["entry.create"]({ catalogue: "agents", name: "x", team: "crew" }, context))).type).toBe("entry.invalid")
  expect(
    (await declared((context) => handlers["entry.create"]({ catalogue: "agents", name: "y", preset: { kind: "agent", id: "ghost" } }, context))).type,
  ).toBe("preset.invalid")

  // A Teams entry without a team pattern matches every team (`*`).
  const member = await Effect.runPromise(handlers["entry.create"]({ catalogue: "teams", name: "scout" }, throwingContext()))
  expect(member).toEqual({ id: "team:defaults:*:scout", catalogue: "teams", team: "*", name: "scout" })
  await Effect.runPromise(handlers["entry.create"]({ catalogue: "teams", team: "*", name: "helper" }, throwingContext()))
  expect((await declared((context) => handlers["entry.create"]({ catalogue: "teams", name: "special" }, context))).type).toBe("entry.invalid")

  // Rename moves the entry's link with it.
  const renamed = await Effect.runPromise(
    handlers["entry.rename"]({ catalogue: "agents", name: "*orchestrator*", to: "*Orchestrator-%" }, throwingContext()),
  )
  expect(renamed).toMatchObject({ id: "agent:defaults:*Orchestrator-%", name: "*Orchestrator-%" })
  expect(linksOf(await stored(project))).toEqual([expect.objectContaining({ agent: "*Orchestrator-%" })])
  expect((await declared((context) => handlers["entry.rename"]({ catalogue: "agents", name: "ghost", to: "x" }, context))).type).toBe("entry.missing")

  // Deleting an entry drops its link; a team pattern without a name drops every member entry.
  const deleted = await Effect.runPromise(handlers["entry.delete"]({ catalogue: "agents", name: "*Orchestrator-%" }, throwingContext()))
  expect(deleted).toMatchObject({ removed: 1 })
  expect(linksOf(await stored(project))).toEqual([])
  const team = await Effect.runPromise(handlers["entry.delete"]({ catalogue: "teams", team: "*" }, throwingContext()))
  expect(team).toMatchObject({ id: "team:defaults:*", removed: 2 })
  expect((await stored(project)).filter((record) => record.type === "entry")).toEqual([])
  expect((await declared((context) => handlers["entry.delete"]({ catalogue: "agents", name: "gone" }, context))).type).toBe("entry.missing")
})

test("preset.create, preset.addMember and preset.delete: copies, collisions, read-only shipped presets, in-use refusal", async () => {
  const { project, handlers } = await setup()
  const mine = await Effect.runPromise(
    handlers["preset.create"]({ kind: "agent", id: "mine", from: { kind: "agent", id: "orchestrator" } }, throwingContext()),
  )
  expect(mine).toEqual({ id: "agent:preset:mine", ref: { kind: "agent", id: "mine" } })
  const records = await stored(project)
  expect(records.filter((record) => record.type === "preset")).toEqual([
    expect.objectContaining({ kind: "agent", id: "mine", fields: { mode: "primary", description: orchestrator?.description } }),
  ])
  expect(linksOf(records)).toEqual([expect.objectContaining({ level: "preset", agent: "mine", preset: { kind: "agent", id: "orchestrator" } })])
  expect((await declared((context) => handlers["preset.create"]({ kind: "agent", id: "orchestrator" }, context))).type).toBe("preset.exists")
  expect((await declared((context) => handlers["preset.create"]({ kind: "agent", id: "build" }, context))).type).toBe("preset.exists")
  expect((await declared((context) => handlers["preset.create"]({ kind: "agent", id: "x", from: { kind: "team", id: "starter" } }, context))).type).toBe(
    "preset.invalid",
  )

  // A team preset from a team preset copies the member list, each linked to its source.
  const crew = await Effect.runPromise(handlers["preset.create"]({ kind: "team", id: "crew", from: "starter" }, throwingContext()))
  expect(crew).toEqual({ id: "team:preset:crew", ref: { kind: "team", id: "crew" } })
  const teamLinks = linksOf(await stored(project))
  expect(teamLinks).toContainEqual(expect.objectContaining({ agent: null, team: { level: "preset", team: "crew" }, preset: { kind: "team", id: "starter" } }))
  expect(teamLinks).toContainEqual(
    expect.objectContaining({ agent: "planner", team: { level: "preset", team: "crew" }, preset: { kind: "member", team: "starter", id: "planner" } }),
  )
  const lead = await Effect.runPromise(
    handlers["preset.addMember"]({ team: "crew", id: "lead", from: { kind: "agent", id: "mine" } }, throwingContext()),
  )
  expect(lead).toEqual({ id: "team:preset:crew:lead", ref: { kind: "member", team: "crew", id: "lead" } })
  expect((await declared((context) => handlers["preset.addMember"]({ team: "crew", id: "lead" }, context))).type).toBe("preset.exists")
  expect((await declared((context) => handlers["preset.addMember"]({ team: "starter", id: "x" }, context))).type).toBe("preset.readonly")
  expect((await declared((context) => handlers["preset.addMember"]({ team: "ghost", id: "x" }, context))).type).toBe("preset.invalid")

  // In use: an agent and a member preset link to `mine`; the refusal names both.
  await Effect.runPromise(handlers["agent.create"]({ scope: "project", id: "alice", preset: { kind: "agent", id: "mine" } }, throwingContext()))
  const inUse = await declared((context) => handlers["preset.delete"]({ ref: { kind: "agent", id: "mine" } }, context))
  expect(inUse.type).toBe("preset.inUse")
  expect((inUse.data as { users: string[] }).users.toSorted()).toEqual(["agent:project:alice", "team:preset:crew:lead"])
  expect((await declared((context) => handlers["preset.delete"]({ ref: { kind: "agent", id: "orchestrator" } }, context))).type).toBe("preset.readonly")
  expect((await declared((context) => handlers["preset.delete"]({ ref: { kind: "team", id: "starter" } }, context))).type).toBe("preset.readonly")

  // Deleting the team preset takes its members and their links; then `mine` is free.
  await Effect.runPromise(handlers["preset.delete"]({ ref: { kind: "team", id: "crew" } }, throwingContext()))
  await Effect.runPromise(handlers["link.set"]({ level: "project", agent: "alice", preset: null }, throwingContext()))
  await Effect.runPromise(handlers["preset.delete"]({ ref: { kind: "agent", id: "mine" } }, throwingContext()))
  const after = await stored(project)
  expect(after.filter((record) => record.type === "preset")).toEqual([])
  expect(linksOf(after)).toEqual([])
})

// A User preset lives in the global store, but a project link lives in that
// project's store. The global index of linked projects lets a delete from one
// project see another's links; a stale entry never blocks; `confirm` deletes
// over them and the link left behind reads as a missing preset.
test("preset.delete sees links other projects hold; confirm deletes over them and the dangling link is visible", async () => {
  const { project, handlers } = await setup()
  const other = path.join(path.dirname(project), "other")
  const gone = path.join(path.dirname(project), "gone")
  await enable(other)
  await enable(gone)
  const handlersIn = (directory: string) =>
    createHandlers(fullContext({ directory, agents: [agentInfo("build", "Build the thing.")] }), createState(), { builtins: [] })
  const fromOther = handlersIn(other)
  const ref = { kind: "agent" as const, id: "mine" }
  await Effect.runPromise(handlers["preset.create"]({ kind: "agent", id: "mine" }, throwingContext()))
  await Effect.runPromise(handlers["agent.create"]({ scope: "project", id: "alice", preset: ref }, throwingContext()))
  // A project that linked to it and was then deleted stays listed but never answers.
  await Effect.runPromise(handlersIn(gone)["agent.create"]({ scope: "project", id: "carol", preset: ref }, throwingContext()))
  expect((await linkedProjects()).toSorted()).toEqual([gone, project].toSorted())
  await fs.rm(gone, { recursive: true, force: true })

  const refused = await declared((context) => fromOther["preset.delete"]({ ref }, context))
  expect(refused.type).toBe("preset.inUse")
  expect(refused.data).toEqual({
    ref,
    users: [`${project} › agent:project:alice`],
    elsewhere: [{ directory: project, users: ["agent:project:alice"] }],
  })
  expect(await linkedProjects()).toEqual([project])
  // Links here refuse even with confirm: they are relinked here first.
  const local = await declared((context) => handlers["preset.delete"]({ ref, confirm: true }, context))
  expect(local.type).toBe("preset.inUse")
  expect(local.data).toEqual({ ref, users: ["agent:project:alice"] })

  await Effect.runPromise(fromOther["preset.delete"]({ ref, confirm: true }, throwingContext()))
  expect((await stored(other)).filter((record) => record.type === "preset")).toEqual([])
  // The project that linked to it keeps its link, marked missing; its rows fall through.
  expect(linksOf(await stored(project))).toEqual([expect.objectContaining({ agent: "alice", preset: ref })])
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext()))
  const nodes = expandedTree(memoInputOf(snapshot))
  const alice = nodes.find((node) => node.id === "agent:project:alice")
  expect(alice?.owner).toMatchObject({ link: ref, linkMissing: true })
  expect(alice === undefined ? [] : badgeLabels(alice)).toContain("missing preset")
  const execute = nodes.find((node) => node.id === "item:project:alice:tool:execute")
  expect(execute?.badges).toMatchObject({ state: "off", fromLabel: "off by default" })
})

// The reference check and the deletion commit under one write gate: a link
// another project commits while the delete is on its way (after the point a
// check outside the gate would have scanned, before the delete's commit) is
// seen and refuses the delete.
test("preset.delete re-checks references under the write gate: a link committed meanwhile refuses it", async () => {
  const { project, handlers } = await setup()
  const other = path.join(path.dirname(project), "other")
  await enable(other)
  const fromOther = createHandlers(fullContext({ directory: other, agents: [agentInfo("build", "Build the thing.")] }), createState(), {
    builtins: [],
  })
  const ref = { kind: "agent" as const, id: "mine" }
  await Effect.runPromise(handlers["preset.create"]({ kind: "agent", id: "mine" }, throwingContext()))
  await Effect.runPromise(handlers["agent.create"]({ scope: "project", id: "alice" }, throwingContext()))
  expect(await linkedProjects()).toEqual([])
  // `project` commits alice's link under the gate, held until released.
  const release = Promise.withResolvers<void>()
  const commit = updateGated(project, async (loaded) => {
    await release.promise
    return { result: undefined, records: [...loaded.records, { type: "link", level: "project", agent: "alice", preset: ref, updated: UPDATED } satisfies StoredRecord] }
  })
  const captured: { current?: CapturedError } = {}
  const deletion = Effect.runPromiseExit(Effect.suspend(() => fromOther["preset.delete"]({ ref }, throwingContext(captured))))
  await Bun.sleep(200)
  release.resolve()
  expect((await commit).saved?.ok).toBe(true)
  expect(Exit.isFailure(await deletion)).toBe(true)
  expect(captured.current).toMatchObject({ type: "preset.inUse", data: { users: [`${project} › agent:project:alice`] } })
  expect((await stored(other)).filter((record) => record.type === "preset")).toEqual([
    expect.objectContaining({ kind: "agent", id: "mine" }),
  ])
})

test("link.set relinks, unlinks, refuses cycles, wrong kinds, read-only presets and unknown owners", async () => {
  const { project, handlers } = await setup()
  await Effect.runPromise(handlers["team.create"]({ level: "project", team: "crew" }, throwingContext()))
  await Effect.runPromise(handlers["team.addAgent"]({ level: "project", team: "crew", id: "bob" }, throwingContext()))
  await Effect.runPromise(handlers["agent.create"]({ scope: "project", id: "alice" }, throwingContext()))
  expect(linksOf(await stored(project))).toEqual([])

  const linked = await Effect.runPromise(
    handlers["link.set"]({ level: "project", agent: "alice", preset: { kind: "member", team: "review", id: "editor" } }, throwingContext()),
  )
  expect(linked).toEqual({ level: "project", agent: "alice", preset: { kind: "member", team: "review", id: "editor" } })
  await Effect.runPromise(
    handlers["link.set"]({ level: "project", agent: "alice", preset: { kind: "agent", id: "planner" } }, throwingContext()),
  )
  expect(linksOf(await stored(project))).toEqual([expect.objectContaining({ agent: "alice", preset: { kind: "agent", id: "planner" } })])
  // A member's link is team-scoped; a team links to a team preset.
  await Effect.runPromise(
    handlers["link.set"]({ level: "project", agent: "bob", team: { level: "project", team: "crew" }, preset: { kind: "agent", id: "scout" } }, throwingContext()),
  )
  await Effect.runPromise(
    handlers["link.set"]({ level: "project", agent: null, team: { level: "project", team: "crew" }, preset: { kind: "team", id: "review" } }, throwingContext()),
  )
  expect(
    (await declared((context) =>
      handlers["link.set"]({ level: "project", agent: null, team: { level: "project", team: "crew" }, preset: { kind: "agent", id: "scout" } }, context),
    )).type,
  ).toBe("preset.invalid")
  expect(
    (await declared((context) => handlers["link.set"]({ level: "project", agent: "alice", preset: { kind: "team", id: "review" } }, context))).type,
  ).toBe("preset.invalid")
  expect((await declared((context) => handlers["link.set"]({ level: "project", agent: "ghost", preset: null }, context))).type).toBe("link.invalid")
  expect(
    (await declared((context) => handlers["link.set"]({ level: "preset", agent: "orchestrator", preset: { kind: "agent", id: "planner" } }, context))).type,
  ).toBe("preset.readonly")

  // User presets: a → b is fine, b → a comes back to b: a cycle; a → a too.
  await Effect.runPromise(handlers["preset.create"]({ kind: "agent", id: "a" }, throwingContext()))
  await Effect.runPromise(handlers["preset.create"]({ kind: "agent", id: "b", from: { kind: "agent", id: "a" } }, throwingContext()))
  const cycle = await declared((context) => handlers["link.set"]({ level: "preset", agent: "a", preset: { kind: "agent", id: "b" } }, context))
  expect(cycle.type).toBe("link.cycle")
  expect(cycle.data).toEqual({ preset: { kind: "agent", id: "b" }, through: ["agent:b", "agent:a"] })
  expect((await declared((context) => handlers["link.set"]({ level: "preset", agent: "a", preset: { kind: "agent", id: "a" } }, context))).type).toBe(
    "link.cycle",
  )

  // Unlinking drops the one link the owner had.
  await Effect.runPromise(handlers["link.set"]({ level: "project", agent: "alice", preset: null }, throwingContext()))
  expect(linksOf(await stored(project)).some((link) => link.agent === "alice")).toBe(false)
})

// A team's link names the team preset its members come from. Relinking the
// team to team preset TP relinks every member with a counterpart in TP to
// `TP › member` and reports them; members without one keep their link.
// Unlinking the team touches no member.
test("relinking a team relinks the members TP has; unlinking a team leaves its members linked", async () => {
  const { project, handlers } = await setup()
  const crew = { level: "project" as const, team: "crew" }
  await Effect.runPromise(handlers["preset.create"]({ kind: "team", id: "mine", from: "starter" }, throwingContext()))
  await Effect.runPromise(handlers["team.create"]({ level: "project", team: "crew", preset: "starter" }, throwingContext()))
  await Effect.runPromise(handlers["team.addAgent"]({ level: "project", team: "crew", id: "bob", preset: { kind: "agent", id: "scout" } }, throwingContext()))
  await Effect.runPromise(handlers["team.addAgent"]({ level: "project", team: "crew", id: "extra" }, throwingContext()))
  const memberLinks = async () =>
    Object.fromEntries(
      linksOf(await stored(project))
        .filter((link) => link.team?.team === "crew")
        .map((link) => [link.agent ?? "(team)", presetKey(link.preset)]),
    )

  const relinked = await Effect.runPromise(
    handlers["link.set"]({ level: "project", agent: null, team: crew, preset: { kind: "team", id: "mine" } }, throwingContext()),
  )
  expect(relinked).toEqual({
    level: "project",
    agent: null,
    team: crew,
    preset: { kind: "team", id: "mine" },
    members: [
      { agent: "helper", preset: { kind: "member", team: "mine", id: "helper" } },
      { agent: "planner", preset: { kind: "member", team: "mine", id: "planner" } },
    ],
  })
  expect(await memberLinks()).toEqual({
    "(team)": "team:mine",
    planner: "member:mine/planner",
    helper: "member:mine/helper",
    bob: "agent:scout",
  })

  // Unlinking the team keeps every member's link.
  const unlinked = await Effect.runPromise(handlers["link.set"]({ level: "project", agent: null, team: crew, preset: null }, throwingContext()))
  expect(unlinked).toEqual({ level: "project", agent: null, team: crew, preset: null, members: [] })
  expect(await memberLinks()).toEqual({ planner: "member:mine/planner", helper: "member:mine/helper", bob: "agent:scout" })

  // A user team preset relinks its member presets the same way, and a member
  // link that would come back to itself refuses the whole relink.
  await Effect.runPromise(handlers["preset.create"]({ kind: "team", id: "other" }, throwingContext()))
  await Effect.runPromise(
    handlers["preset.addMember"]({ team: "other", id: "planner", from: { kind: "member", team: "mine", id: "planner" } }, throwingContext()),
  )
  const cycle = await declared((context) =>
    handlers["link.set"]({ level: "preset", agent: null, team: { level: "preset", team: "mine" }, preset: { kind: "team", id: "other" } }, context),
  )
  expect(cycle.type).toBe("link.cycle")
  expect(linksOf(await stored(project)).find((link) => link.level === "preset" && link.agent === null && link.team?.team === "mine")?.preset).toEqual({
    kind: "team",
    id: "starter",
  })
})

// A team relink writes several member links at once; each is checked against
// the graph with the others applied. Y/a → X/b and Y/b → X/a are fine alone,
// but relinking X to Y adds X/a → Y/a and X/b → Y/b: X/a → Y/a → X/b → Y/b → X/a.
test("relinking a team preset refuses a cycle its member relinks close between them", async () => {
  const { project, handlers } = await setup()
  await Effect.runPromise(handlers["preset.create"]({ kind: "team", id: "x" }, throwingContext()))
  await Effect.runPromise(handlers["preset.addMember"]({ team: "x", id: "a" }, throwingContext()))
  await Effect.runPromise(handlers["preset.addMember"]({ team: "x", id: "b" }, throwingContext()))
  await Effect.runPromise(handlers["preset.create"]({ kind: "team", id: "y" }, throwingContext()))
  await Effect.runPromise(handlers["preset.addMember"]({ team: "y", id: "a", from: { kind: "member", team: "x", id: "b" } }, throwingContext()))
  await Effect.runPromise(handlers["preset.addMember"]({ team: "y", id: "b", from: { kind: "member", team: "x", id: "a" } }, throwingContext()))
  const before = linksOf(await stored(project))
  const cycle = await declared((context) =>
    handlers["link.set"]({ level: "preset", agent: null, team: { level: "preset", team: "x" }, preset: { kind: "team", id: "y" } }, context),
  )
  expect(cycle.type).toBe("link.cycle")
  expect(linksOf(await stored(project))).toEqual(before)
})

// Renaming an agent renames what it is: its link and its own records (row
// edits, splits, models, rules) move with the file. Records of the same id in
// a team, or at another level, are not the agent's and stay.
test("agent.rename moves the agent's link and its own records to the new id", async () => {
  const { project, handlers } = await setup()
  await Effect.runPromise(handlers["agent.create"]({ scope: "project", id: "alice", preset: { kind: "agent", id: "orchestrator" } }, throwingContext()))
  const loaded = await load(project)
  const own = { level: "project" as const, agent: "alice" }
  const crew = { level: "project" as const, team: "crew" }
  const extra: StoredRecord[] = [
    { type: "customization", ...own, item: "tool:shell", section: null, state: "off", basedOn: "", updated: UPDATED },
    { type: "split", ...own, item: "system:role", boundaries: [{ id: "a", name: "A", start: 0 }], updated: UPDATED },
    { type: "model", ...own, providerID: "acme", modelID: "nova", updated: UPDATED },
    { type: "rule", ...own, tool: "shell", id: "mine", label: "Mine", patterns: ["mine *"], keywords: ["mine"], updated: UPDATED },
    // Not alice's own: a member of the same id, and alice at Global.
    { type: "customization", ...own, team: crew, item: "tool:shell", section: null, state: "on", basedOn: "", updated: UPDATED },
    { type: "customization", level: "global", agent: "alice", item: "tool:shell", section: null, state: "on", basedOn: "", updated: UPDATED },
    // A link a deleted agent of the new id left behind gives way.
    { type: "link", level: "project", agent: "Alice-2", preset: { kind: "agent", id: "scout" }, updated: UPDATED },
  ]
  const saved = await save(project, {
    expectedProjectRevision: loaded.projectRevision,
    expectedGlobalRevision: loaded.globalRevision,
    records: [...loaded.records, ...extra],
  })
  expect(saved.ok).toBe(true)

  await Effect.runPromise(handlers["agent.rename"]({ scope: "project", from: "alice", to: "Alice-2" }, throwingContext()))
  const records = await stored(project)
  const owners = records
    .filter((record) => record.type !== "team" && record.type !== "entry" && record.type !== "preset")
    .map((record) => `${record.type} ${record.level}/${record.agent}${record.team === undefined ? "" : `@${record.team.team}`}`)
    .toSorted()
  expect(owners).toEqual(
    [
      "customization global/alice",
      "customization project/Alice-2",
      "customization project/alice@crew",
      "link project/Alice-2",
      "model project/Alice-2",
      "rule project/Alice-2",
      "split project/Alice-2",
    ].toSorted(),
  )
  expect(linksOf(records)).toEqual([expect.objectContaining({ agent: "Alice-2", preset: { kind: "agent", id: "orchestrator" } })])
})

// DESIGN §3.3: an item the agent owns — its own user rule — falls back to its
// upstream value, not off. The rule row must say whose it is.
test("an unlinked agent's own user rule falls back to upstream; another agent's copy stays off", async () => {
  const { project } = await setup()
  const agents = [agentInfo("build", "Build the thing."), agentInfo("alice", ""), agentInfo("bob", "")]
  const ctx = fullContext({
    directory: project,
    agents,
    tools: [{ id: "shell", description: "Run shell commands." }],
    session: { hook: () => Effect.succeed({ dispose: Effect.void }) },
  })
  const handlers = createHandlers(ctx, createState(), { builtins: [] })
  await Effect.runPromise(handlers["agent.create"]({ scope: "project", id: "alice" }, throwingContext()))
  await Effect.runPromise(handlers["agent.create"]({ scope: "project", id: "bob" }, throwingContext()))
  await Effect.runPromise(
    handlers["rule.add"]({ level: "project", agent: "alice", tool: "shell", id: "mine", label: "Mine", patterns: ["mine *"] }, throwingContext()),
  )
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext()))
  const nodes = expandedTree(memoInputOf(snapshot))
  const shown = (id: string) => nodes.find((node) => node.id === id)?.badges
  expect(shown("item:project:alice:perm:shell:mine")).toMatchObject({ state: "on", fromLabel: "upstream" })
  expect(shown("item:project:bob:perm:shell:mine")).toMatchObject({ state: "off", fromLabel: "off by default" })
  // What runs agrees: alice's own rule installs no deny, bob's does.
  const listed = await Effect.runPromise(ctx.agent.list())
  const denies = (id: string) =>
    listed.data.find((agent) => String(agent.id) === id)?.permissions.some((rule) => rule.action === "shell" && rule.resource === "mine *" && rule.effect === "deny")
  expect(denies("alice")).toBe(false)
  expect(denies("bob")).toBe(true)

  // Turning her own rule off records the ON above it (its upstream), so the
  // override is not "to review" the moment it is written.
  const input = memoInputOf(snapshot)
  const toggled = toggle(input, "item:project:alice:perm:shell:mine")
  if ("refusal" in toggled) throw new Error(toggled.refusal)
  const record = toggled.records.find((entry) => entry.agent === "alice" && entry.item === "perm:shell:mine")
  expect(record).toMatchObject({ state: "off", basedOnState: "on" })
  const after = expandedTree({ ...input, records: [...input.records.filter((entry) => entry.type !== "customization"), ...toggled.records] })
  const row = after.find((node) => node.id === "item:project:alice:perm:shell:mine")
  expect(row?.badges).toMatchObject({ state: "off" })
  expect(row?.badges?.review ?? false).toBe(false)
})

test("a tool actor may not relink a protected agent; presets and entries are not agents", async () => {
  const { project, handlers } = await setup({ protectedAgents: ["alice", "mine"] })
  await Effect.runPromise(handlers["agent.create"]({ scope: "project", id: "alice" }, throwingContext()))
  const tool = { type: "tool" as const }
  const refusal = await declared((context) =>
    handlers["link.set"]({ level: "project", agent: "alice", preset: { kind: "agent", id: "planner" }, actor: tool }, context),
  )
  expect(refusal.type).toBe("agent.protected")
  expect(linksOf(await stored(project))).toEqual([])
  // The TUI may.
  await Effect.runPromise(handlers["link.set"]({ level: "project", agent: "alice", preset: { kind: "agent", id: "planner" } }, throwingContext()))
  // A preset named like a protected agent is still a preset.
  await Effect.runPromise(handlers["preset.create"]({ kind: "agent", id: "mine", actor: tool }, throwingContext()))
  await Effect.runPromise(
    handlers["link.set"]({ level: "preset", agent: "mine", preset: { kind: "agent", id: "scout" }, actor: tool }, throwingContext()),
  )
  await Effect.runPromise(handlers["entry.create"]({ catalogue: "agents", name: "*ali*", actor: tool }, throwingContext()))
  expect(linksOf(await stored(project)).map((link) => link.agent).toSorted()).toEqual(["alice", "mine"])
  // A tool's row edit on that preset goes through the mutate; the agent's own does not.
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext()))
  const edit = (level: "preset" | "project") => ({
    type: "customization" as const,
    level,
    agent: level === "preset" ? "mine" : "alice",
    item: "tool:shell",
    section: null,
    state: "on" as const,
    basedOn: "",
    updated: UPDATED,
  })
  const mutated = await Effect.runPromise(
    handlers["instructions.mutate"](
      { expectedRevision: snapshot.revision, expectedGlobalRevision: snapshot.globalRevision, records: [edit("preset")], actor: tool },
      throwingContext(),
    ),
  )
  expect(mutated.ok).toBe(true)
  const fresh = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext()))
  const agentEdit = await declared((context) =>
    handlers["instructions.mutate"](
      { expectedRevision: fresh.revision, expectedGlobalRevision: fresh.globalRevision, records: [...fresh.records, edit("project")], actor: tool },
      context,
    ),
  )
  expect(agentEdit.type).toBe("agent.protected")
})

// Relinking a team rewrites its members' links, so a protected member is
// changed indirectly: a tool may not do it; the TUI may.
test("a tool actor may not relink a team whose relinked members include a protected agent", async () => {
  const { project, handlers } = await setup({ protectedAgents: ["planner"] })
  const crew = { level: "project" as const, team: "crew" }
  const tool = { type: "tool" as const }
  await Effect.runPromise(handlers["preset.create"]({ kind: "team", id: "mine", from: "starter" }, throwingContext()))
  await Effect.runPromise(handlers["team.create"]({ level: "project", team: "crew", preset: "starter" }, throwingContext()))
  const before = linksOf(await stored(project))
  const refusal = await declared((context) =>
    handlers["link.set"]({ level: "project", agent: null, team: crew, preset: { kind: "team", id: "mine" }, actor: tool }, context),
  )
  expect(refusal.type).toBe("agent.protected")
  expect(refusal.message).toContain('"planner"')
  expect(linksOf(await stored(project))).toEqual(before)
  const relinked = await Effect.runPromise(
    handlers["link.set"]({ level: "project", agent: null, team: crew, preset: { kind: "team", id: "mine" } }, throwingContext()),
  )
  expect(relinked.members?.map((member) => member.agent)).toEqual(["helper", "planner"])
})

// DESIGN §6: a `tool:team_<tool>` row that is off refuses the call itself —
// one core deny on the tool's own permission `team.<tool>` — for direct and
// Code Mode team tools alike, as the old per-kind ceiling did.
test("a team tool row that is off installs a core team.<tool> deny for direct and Code Mode team tools", async () => {
  const teamTool = (name: string, codemode: boolean): Item => ({
    id: `tool:team_${name}`,
    kind: "tool",
    group: "plus",
    title: name,
    text: `team ${name}`,
    enabled: true,
    fingerprint: fingerprint(`team ${name}`),
    namespace: "team",
    codemode,
  })
  const items = [teamTool("delegate", false), teamTool("integrate", true), teamTool("status", true)]
  const run = async (preset: string | undefined, member: boolean) => {
    const agents = agentHarness([agentInfo("ocp-alice", "")])
    const team = { level: "project" as const, team: "crew" }
    const links: LinkRecord[] =
      preset === undefined ? [] : [{ type: "link", level: "project", agent: "ocp-alice", team, preset: { kind: "agent", id: preset }, updated: UPDATED }]
    await apply(context({ agent: agents.domain, session: { hook: () => Effect.succeed({ dispose: Effect.void }) } }), {
      items,
      agents: [{ id: "ocp-alice", level: "project", ...(member ? { team } : {}) }],
      records: [],
      splits: [],
      scopes: chainContext({ agents: [{ id: "ocp-alice", scope: "project", origin: "user" }], items, links }),
      teamAgents: member ? ["ocp-alice"] : [],
    })
    return (agents.state.get("ocp-alice")?.permissions ?? []).map((rule) => `${rule.effect} ${rule.action} ${rule.resource}`)
  }
  // Plus implementer: team_delegate and team_integrate off, team_status on.
  const implementer = await run("implementer", true)
  expect(implementer).toContain("deny team.delegate *")
  expect(implementer).toContain("deny team.integrate *")
  expect(implementer).not.toContain("deny team.status *")
  // No preset: every team tool falls back to off and refuses.
  const bare = await run(undefined, true)
  expect(bare).toEqual(expect.arrayContaining(["deny team.delegate *", "deny team.integrate *", "deny team.status *"]))
  // A non-member has the whole namespace denied, and nothing per tool.
  const outsider = await run(undefined, false)
  expect(outsider).toContain("deny team.* *")
  expect(outsider.some((rule) => /^deny team\.(delegate|integrate|status) /.test(rule))).toBe(false)
})

