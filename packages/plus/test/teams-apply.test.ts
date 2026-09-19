import { afterEach, expect, test } from "bun:test"
import type { AgentEditor } from "@opencode/plugin/effect/agent"
import { Agent } from "@opencode/schema/agent"
import { Effect, type Types } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { formatMarkdown } from "../src/agents/files.js"
import { createHandlers, createState, deactivate } from "../src/index.js"
import { fingerprint } from "../src/instructions/model.js"
import { projectTeamsPath } from "../src/instructions/paths.js"
import { enable } from "../src/project.js"
import { Plus } from "../src/rpc.js"
import { agentHarness, agentInfo, context, fullContext, skillHarness, toolHarness } from "./harness.js"

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
  const root = await fs.mkdtemp(path.join(parent, "plus-teams-apply-"))
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

async function hostSystem(ctx: ReturnType<typeof fullContext>, id: string): Promise<string | undefined> {
  const listed = await Effect.runPromise(ctx.agent.list())
  return listed.data.find((entry) => String(entry.id) === id)?.system
}

test("enabling a team installs its agents in the host registry with their real markdown bodies", async () => {
  const { project } = await tempRoot()
  await enable(project)
  await writeTeamAgent(path.join(projectTeamsPath(project), "crew"), "alpha", "crew alpha body")
  const ctx = fullContext({ directory: project })
  const handlers = createHandlers(ctx, createState())
  await Effect.runPromise(handlers["team.setEnabled"]({ level: "project", team: "crew", enabled: true }, throwingContext({})))
  expect(await hostSystem(ctx, "alpha")).toBe("crew alpha body")
})

test("disabling a team removes its agents from the host registry", async () => {
  const { project } = await tempRoot()
  await enable(project)
  await writeTeamAgent(path.join(projectTeamsPath(project), "crew"), "alpha", "crew alpha body")
  const ctx = fullContext({ directory: project })
  const handlers = createHandlers(ctx, createState())
  await Effect.runPromise(handlers["team.setEnabled"]({ level: "project", team: "crew", enabled: true }, throwingContext({})))
  expect(await hostSystem(ctx, "alpha")).toBe("crew alpha body")
  await Effect.runPromise(handlers["team.setEnabled"]({ level: "project", team: "crew", enabled: false }, throwingContext({})))
  const listed = await Effect.runPromise(ctx.agent.list())
  expect(listed.data.some((entry) => String(entry.id) === "alpha")).toBe(false)
})

test("a team member colliding with an authored agent keeps the authored text", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const authored = path.join(project, ".opencode", "agent", "alpha.md")
  await fs.mkdir(path.dirname(authored), { recursive: true })
  await Bun.write(authored, "authored body\n")
  await writeTeamAgent(path.join(projectTeamsPath(project), "crew"), "alpha", "team body")
  // The host shows the authored project agent, mirroring core's file registry.
  const ctx = fullContext({ directory: project, agents: [agentInfo("alpha", "authored body")] })
  const handlers = createHandlers(ctx, createState())
  await Effect.runPromise(handlers["team.setEnabled"]({ level: "project", team: "crew", enabled: true }, throwingContext({})))
  // Ties favour the established non-team identity: nothing is installed for alpha.
  expect(await hostSystem(ctx, "alpha")).toBe("authored body")
})

function fixtureBuiltins() {
  return [{ name: "ship", members: [{ id: "shared", body: "ship body" }] }]
}

function fixtureWithFields() {
  return [
    {
      name: "ship",
      members: [
        {
          id: "fielded",
          body: "fielded body",
          fields: {
            description: "Fielded agent",
            mode: "subagent" as const,
            permissions: [{ action: "team.delegate", resource: "*", effect: "deny" as const }],
          },
        },
      ],
    },
  ]
}

test("a built-in member loses to a project team with the same id", async () => {
  const { project } = await tempRoot()
  await enable(project)
  await writeTeamAgent(path.join(projectTeamsPath(project), "crew"), "shared", "crew body")
  const ctx = fullContext({ directory: project })
  const handlers = createHandlers(ctx, createState(), { builtins: fixtureBuiltins() })
  await Effect.runPromise(handlers["team.setEnabled"]({ level: "project", team: "crew", enabled: true }, throwingContext({})))
  await Effect.runPromise(handlers["team.setEnabled"]({ level: "defaults", team: "ship", enabled: true }, throwingContext({})))
  expect(await hostSystem(ctx, "shared")).toBe("crew body")
})

test("a built-in member loses to an authored agent with the same id", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const authored = path.join(project, ".opencode", "agent", "shared.md")
  await fs.mkdir(path.dirname(authored), { recursive: true })
  await Bun.write(authored, "authored body\n")
  const ctx = fullContext({ directory: project, agents: [agentInfo("shared", "authored body")] })
  const handlers = createHandlers(ctx, createState(), { builtins: fixtureBuiltins() })
  await Effect.runPromise(handlers["team.setEnabled"]({ level: "defaults", team: "ship", enabled: true }, throwingContext({})))
  expect(await hostSystem(ctx, "shared")).toBe("authored body")
})

test("a failure mid-install unwinds the agents installed earlier in the pass", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const teamDir = path.join(projectTeamsPath(project), "crew")
  await writeTeamAgent(teamDir, "one", "one body")
  await writeTeamAgent(teamDir, "two", "two body")
  const base = fullContext({ directory: project })
  let calls = 0
  const ctx = {
    ...base,
    agent: {
      ...base.agent,
      transform: (callback: (editor: AgentEditor) => void) => {
        calls++
        if (calls === 2) return Effect.die(new Error("team install failed"))
        return base.agent.transform(callback)
      },
    },
  }
  const handlers = createHandlers(ctx, createState())
  await expect(
    Effect.runPromise(handlers["team.setEnabled"]({ level: "project", team: "crew", enabled: true }, throwingContext({}))),
  ).rejects.toThrow("team install failed")
  expect(calls).toBe(2)
  const listed = await Effect.runPromise(ctx.agent.list())
  expect(listed.data.some((entry) => String(entry.id) === "one")).toBe(false)
  expect(listed.data.some((entry) => String(entry.id) === "two")).toBe(false)
})

test("one agent id at two scopes applies once with the project text", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const projectFile = path.join(project, ".opencode", "agent", "alpha.md")
  await fs.mkdir(path.dirname(projectFile), { recursive: true })
  await Bun.write(projectFile, "project body\n")
  const globalFile = path.join(process.env.OPENCODE_CONFIG_DIR ?? "", "agent", "alpha.md")
  await fs.mkdir(path.dirname(globalFile), { recursive: true })
  await Bun.write(globalFile, "global body\n")
  // The host registry is keyed by id, so it shows the project winner.
  const listed = { current: 0 }
  const base = fullContext({ directory: project, agents: [agentInfo("alpha", "project body")] })
  // The counting wrapper observes every editor.update targeting "alpha" —
  // roles, skill rules, and team installs each run through it — so the role
  // pass is isolated by callback order (roles install first) and one entry is
  // recorded per callback run: the agent harness rebuilds on every install,
  // replaying installed callbacks, so the role callback itself runs again
  // when the skill-rules transform installs.
  const roleRuns: string[][] = []
  const ctx = {
    ...base,
    agent: {
      ...base.agent,
      transform: (callback: (editor: AgentEditor) => void) => {
        const slot = listed.current++
        // The publish installs its agent.transform callbacks in order — roles
        // first, then skill rules. Only the first (role) callback is recorded.
        if (slot !== 0) return base.agent.transform(callback)
        return base.agent.transform((editor) => {
          const seen: string[] = []
          callback({
            ...editor,
            update: (id: string, update: (agent: Types.DeepMutable<Agent.Info>) => void) => {
              editor.update(id, (agent) => {
                update(agent)
                if (id === "alpha") seen.push(agent.system ?? "")
              })
            },
          })
          roleRuns.push(seen)
        })
      },
    },
  }
  const handlers = createHandlers(ctx, createState())
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const records: Plus.SnapshotCustomizationRecord[] = [
    {
      type: "customization",
      level: "project",
      agent: "alpha",
      item: "system:role",
      section: null,
      text: "project text",
      basedOn: fingerprint("project body"),
      updated: UPDATED,
    },
    {
      type: "customization",
      level: "global",
      agent: "alpha",
      item: "system:role",
      section: null,
      text: "global text",
      basedOn: fingerprint("project body"),
      updated: UPDATED,
    },
  ]
  const mutated = await Effect.runPromise(
    handlers["instructions.mutate"](
      { expectedRevision: snapshot.revision, expectedGlobalRevision: snapshot.globalRevision, records },
      throwingContext({}),
    ),
  )
  expect(mutated.ok).toBe(true)
  // The shadowed global identity must not overwrite the effective project
  // text, and the role pass must see exactly one alpha identity writing the
  // project text on every one of its runs.
  expect(await hostSystem(ctx, "alpha")).toBe("project text")
  expect(roleRuns.length).toBeGreaterThan(0)
  for (const run of roleRuns) expect(run).toEqual(["project text"])
})

test("a built-in member with fields installs through the shared applyTeamAgent surface", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const ctx = fullContext({ directory: project })
  const handlers = createHandlers(ctx, createState(), { builtins: fixtureWithFields() })
  await Effect.runPromise(handlers["team.setEnabled"]({ level: "defaults", team: "ship", enabled: true }, throwingContext({})))
  expect(await hostSystem(ctx, "fielded")).toBe("fielded body")
  const listed = await Effect.runPromise(ctx.agent.list())
  const agent = listed.data.find((entry) => String(entry.id) === "fielded")
  expect(agent?.description).toBe("Fielded agent")
  expect(agent?.mode).toBe("subagent")
  expect(
    agent?.permissions.some((rule) => rule.action === "team.delegate" && rule.resource === "*" && rule.effect === "deny"),
  ).toBe(true)
})

test("a customized team member role survives publication while an uncustomized sibling keeps its shipped body", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const teamDir = path.join(projectTeamsPath(project), "crew")
  await writeTeamAgent(teamDir, "alpha", "crew alpha body")
  await writeTeamAgent(teamDir, "beta", "crew beta body")
  const ctx = fullContext({ directory: project })
  const handlers = createHandlers(ctx, createState())
  await Effect.runPromise(handlers["team.setEnabled"]({ level: "project", team: "crew", enabled: true }, throwingContext({})))
  expect(await hostSystem(ctx, "alpha")).toBe("crew alpha body")
  expect(await hostSystem(ctx, "beta")).toBe("crew beta body")
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const role = snapshot.items.find((item) => item.id === "system:role" && item.agents?.includes("alpha"))
  if (!role) throw new Error("expected system:role for alpha")
  const records: Plus.SnapshotCustomizationRecord[] = [
    {
      type: "customization",
      level: "project",
      agent: "alpha",
      item: "system:role",
      section: null,
      text: "edited alpha role",
      basedOn: role.fingerprint,
      updated: UPDATED,
    },
  ]
  const mutated = await Effect.runPromise(
    handlers["instructions.mutate"](
      { expectedRevision: snapshot.revision, expectedGlobalRevision: snapshot.globalRevision, records },
      throwingContext({}),
    ),
  )
  expect(mutated.ok).toBe(true)
  const alphaSystem = await hostSystem(ctx, "alpha")
  expect(alphaSystem).toBe("edited alpha role")
  expect(alphaSystem).not.toContain("crew alpha body")
  expect(await hostSystem(ctx, "beta")).toBe("crew beta body")
  if (!mutated.ok) throw new Error("expected mutate to succeed")
  const betaRole = mutated.snapshot.items.find((item) => item.id === "system:role" && item.agents?.includes("beta"))
  if (!betaRole) throw new Error("expected system:role for beta")
  const secondRecords: Plus.SnapshotCustomizationRecord[] = [
    {
      type: "customization",
      level: "project",
      agent: "alpha",
      item: "system:role",
      section: null,
      text: "edited alpha role",
      basedOn: role.fingerprint,
      updated: UPDATED,
    },
    {
      type: "customization",
      level: "project",
      agent: "beta",
      item: "system:role",
      section: null,
      text: "edited beta role",
      basedOn: betaRole.fingerprint,
      updated: UPDATED,
    },
  ]
  const second = await Effect.runPromise(
    handlers["instructions.mutate"](
      { expectedRevision: mutated.revision, expectedGlobalRevision: mutated.globalRevision, records: secondRecords },
      throwingContext({}),
    ),
  )
  expect(second.ok).toBe(true)
  expect(await hostSystem(ctx, "alpha")).toBe("edited alpha role")
  expect(await hostSystem(ctx, "beta")).toBe("edited beta role")
})

test("a state-only section exclusion on a Defaults team member does not reinstall on unchanged refresh", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const shipped = "# Alpha\n\nfirst part\n\n# Beta\n\nsecond part\n"
  const builtins = [{ name: "ship", members: [{ id: "mate", body: shipped }] }]
  const agents = agentHarness([], project)
  const base = fullContext({ directory: project })
  const skillState = skillHarness([])
  const tools = toolHarness([])
  const ctx = context({
    location: base.location,
    agent: agents.domain,
    skill: { ...skillState.domain, list: () => Effect.succeed({ location: base.location, data: Array.from(skillState.state.values()) }) },
    tool: tools.domain,
    mcp: base.mcp,
  })
  const state = createState()
  const handlers = createHandlers(ctx, state, { builtins })
  await Effect.runPromise(handlers["team.setEnabled"]({ level: "defaults", team: "ship", enabled: true }, throwingContext({})))
  expect(await hostSystem(ctx, "mate")).toContain("first part")
  expect(await hostSystem(ctx, "mate")).toContain("second part")
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const role = snapshot.items.find((item) => item.id === "system:role" && item.agents?.includes("mate"))
  if (!role) throw new Error("expected system:role for mate")
  const records: Plus.SnapshotCustomizationRecord[] = [
    {
      type: "customization",
      level: "defaults",
      agent: "mate",
      item: "system:role",
      section: "beta",
      state: "off",
      basedOn: role.fingerprint,
      updated: UPDATED,
    },
  ]
  const mutated = await Effect.runPromise(
    handlers["instructions.mutate"](
      { expectedRevision: snapshot.revision, expectedGlobalRevision: snapshot.globalRevision, records },
      throwingContext({}),
    ),
  )
  expect(mutated.ok).toBe(true)
  if (!mutated.ok) throw new Error("expected mutate to succeed")
  const shortened = await hostSystem(ctx, "mate")
  expect(shortened).toContain("first part")
  expect(shortened).not.toContain("second part")
  const fingerprintAfter = state.fingerprint
  const installs = agents.transforms
  const disposes = agents.disposes
  await Effect.runPromise(handlers["instructions.refresh"](undefined, throwingContext({})))
  expect(state.fingerprint).toBe(fingerprintAfter)
  expect(agents.transforms).toBe(installs)
  expect(agents.disposes).toBe(disposes)
  expect(await hostSystem(ctx, "mate")).toBe(shortened)
  const resnapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  expect(resnapshot.teams?.find((team) => team.team === "ship")?.enabled).toBe(true)
  expect(resnapshot.teams?.find((team) => team.team === "ship")?.agents).toContain("mate")
})

test("a non-file-backed authored agent keeps its identity against a same-id Defaults team with an inapplicable project record", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const authored = "authored body"
  const shipped = "ship body"
  const builtins = [{ name: "ship", members: [{ id: "shared", body: shipped }] }]
  const ctx = fullContext({ directory: project, agents: [agentInfo("shared", authored)] })
  const state = createState()
  const handlers = createHandlers(ctx, state, { builtins })
  await Effect.runPromise(handlers["team.setEnabled"]({ level: "defaults", team: "ship", enabled: true }, throwingContext({})))
  expect(await hostSystem(ctx, "shared")).toBe(authored)
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const role = snapshot.items.find((item) => item.id === "system:role" && item.agents?.includes("shared"))
  if (!role) throw new Error("expected system:role for shared")
  const records: Plus.SnapshotCustomizationRecord[] = [
    {
      type: "customization",
      level: "project",
      agent: "shared",
      item: "system:role",
      section: null,
      text: "project edit that must not apply at defaults",
      basedOn: role.fingerprint,
      updated: UPDATED,
    },
  ]
  const mutated = await Effect.runPromise(
    handlers["instructions.mutate"](
      { expectedRevision: snapshot.revision, expectedGlobalRevision: snapshot.globalRevision, records },
      throwingContext({}),
    ),
  )
  expect(mutated.ok).toBe(true)
  expect(await hostSystem(ctx, "shared")).toBe(authored)
  const after = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const entry = after.agents.find((agent) => agent.id === "shared")
  expect(entry?.origin).not.toBe("plus")
  expect(entry?.fileBacked).toBe(false)
})

test("a Defaults team-only member survives S to A to B with a stable refresh", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const shipped = "ship body S"
  const builtins = [{ name: "ship", members: [{ id: "mate", body: shipped }] }]
  const agents = agentHarness([], project)
  const base = fullContext({ directory: project })
  const skillState = skillHarness([])
  const tools = toolHarness([])
  const ctx = context({
    location: base.location,
    agent: agents.domain,
    skill: { ...skillState.domain, list: () => Effect.succeed({ location: base.location, data: Array.from(skillState.state.values()) }) },
    tool: tools.domain,
    mcp: base.mcp,
  })
  const state = createState()
  const handlers = createHandlers(ctx, state, { builtins })
  await Effect.runPromise(handlers["team.setEnabled"]({ level: "defaults", team: "ship", enabled: true }, throwingContext({})))
  expect(await hostSystem(ctx, "mate")).toBe(shipped)
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const role = snapshot.items.find((item) => item.id === "system:role" && item.agents?.includes("mate"))
  if (!role) throw new Error("expected system:role for mate")
  const firstRecords: Plus.SnapshotCustomizationRecord[] = [
    {
      type: "customization",
      level: "defaults",
      agent: "mate",
      item: "system:role",
      section: null,
      text: "custom A",
      basedOn: role.fingerprint,
      updated: UPDATED,
    },
  ]
  const first = await Effect.runPromise(
    handlers["instructions.mutate"](
      { expectedRevision: snapshot.revision, expectedGlobalRevision: snapshot.globalRevision, records: firstRecords },
      throwingContext({}),
    ),
  )
  expect(first.ok).toBe(true)
  expect(await hostSystem(ctx, "mate")).toBe("custom A")
  if (!first.ok) throw new Error("expected first mutate to succeed")
  const secondRecords: Plus.SnapshotCustomizationRecord[] = [
    {
      type: "customization",
      level: "defaults",
      agent: "mate",
      item: "system:role",
      section: null,
      text: "custom B",
      basedOn: role.fingerprint,
      updated: UPDATED,
    },
  ]
  const second = await Effect.runPromise(
    handlers["instructions.mutate"](
      { expectedRevision: first.revision, expectedGlobalRevision: first.globalRevision, records: secondRecords },
      throwingContext({}),
    ),
  )
  expect(second.ok).toBe(true)
  expect(await hostSystem(ctx, "mate")).toBe("custom B")
  const fingerprintAfter = state.fingerprint
  const installs = agents.transforms
  const disposes = agents.disposes
  await Effect.runPromise(handlers["instructions.refresh"](undefined, throwingContext({})))
  expect(state.fingerprint).toBe(fingerprintAfter)
  expect(agents.transforms).toBe(installs)
  expect(agents.disposes).toBe(disposes)
  expect(await hostSystem(ctx, "mate")).toBe("custom B")
})

test("removing a state-only section exclusion restores the full shipped body", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const shipped = "# Alpha\n\nfirst part\n\n# Beta\n\nsecond part\n"
  const builtins = [{ name: "ship", members: [{ id: "mate", body: shipped }] }]
  const agents = agentHarness([], project)
  const base = fullContext({ directory: project })
  const skillState = skillHarness([])
  const tools = toolHarness([])
  const ctx = context({
    location: base.location,
    agent: agents.domain,
    skill: { ...skillState.domain, list: () => Effect.succeed({ location: base.location, data: Array.from(skillState.state.values()) }) },
    tool: tools.domain,
    mcp: base.mcp,
  })
  const state = createState()
  const handlers = createHandlers(ctx, state, { builtins })
  await Effect.runPromise(handlers["team.setEnabled"]({ level: "defaults", team: "ship", enabled: true }, throwingContext({})))
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const role = snapshot.items.find((item) => item.id === "system:role" && item.agents?.includes("mate"))
  if (!role) throw new Error("expected system:role for mate")
  const excluded: Plus.SnapshotCustomizationRecord[] = [
    {
      type: "customization",
      level: "defaults",
      agent: "mate",
      item: "system:role",
      section: "beta",
      state: "off",
      basedOn: role.fingerprint,
      updated: UPDATED,
    },
  ]
  const mutated = await Effect.runPromise(
    handlers["instructions.mutate"](
      { expectedRevision: snapshot.revision, expectedGlobalRevision: snapshot.globalRevision, records: excluded },
      throwingContext({}),
    ),
  )
  expect(mutated.ok).toBe(true)
  if (!mutated.ok) throw new Error("expected mutate to succeed")
  const shortened = await hostSystem(ctx, "mate")
  expect(shortened).toContain("first part")
  expect(shortened).not.toContain("second part")
  const cleared = await Effect.runPromise(
    handlers["instructions.mutate"](
      { expectedRevision: mutated.revision, expectedGlobalRevision: mutated.globalRevision, records: [] },
      throwingContext({}),
    ),
  )
  expect(cleared.ok).toBe(true)
  const restored = await hostSystem(ctx, "mate")
  expect(restored).toContain("first part")
  expect(restored).toContain("second part")
})

test("a project-level role edit wins over the shipped body for a project team sharing a built-in id", async () => {
  const { project } = await tempRoot()
  await enable(project)
  await writeTeamAgent(path.join(projectTeamsPath(project), "crew"), "shared", "crew body")
  const ctx = fullContext({ directory: project })
  const handlers = createHandlers(ctx, createState(), { builtins: fixtureBuiltins() })
  await Effect.runPromise(handlers["team.setEnabled"]({ level: "project", team: "crew", enabled: true }, throwingContext({})))
  await Effect.runPromise(handlers["team.setEnabled"]({ level: "defaults", team: "ship", enabled: true }, throwingContext({})))
  expect(await hostSystem(ctx, "shared")).toBe("crew body")
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const role = snapshot.items.find((item) => item.id === "system:role" && item.agents?.includes("shared"))
  if (!role) throw new Error("expected system:role for shared")
  const records: Plus.SnapshotCustomizationRecord[] = [
    {
      type: "customization",
      level: "project",
      agent: "shared",
      item: "system:role",
      section: null,
      text: "project edit",
      basedOn: role.fingerprint,
      updated: UPDATED,
    },
  ]
  const mutated = await Effect.runPromise(
    handlers["instructions.mutate"](
      { expectedRevision: snapshot.revision, expectedGlobalRevision: snapshot.globalRevision, records },
      throwingContext({}),
    ),
  )
  expect(mutated.ok).toBe(true)
  expect(await hostSystem(ctx, "shared")).toBe("project edit")
})

test("a non-file-backed authored agent keeps its identity against a same-id Defaults team with an applicable defaults record", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const authored = "authored body"
  const shipped = "ship body"
  const builtins = [{ name: "ship", members: [{ id: "shared", body: shipped }] }]
  const ctx = fullContext({ directory: project, agents: [agentInfo("shared", authored)] })
  const state = createState()
  const handlers = createHandlers(ctx, state, { builtins })
  await Effect.runPromise(handlers["team.setEnabled"]({ level: "defaults", team: "ship", enabled: true }, throwingContext({})))
  expect(await hostSystem(ctx, "shared")).toBe(authored)
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const entry = snapshot.agents.find((agent) => agent.id === "shared")
  expect(entry?.origin).not.toBe("plus")
  const role = snapshot.items.find((item) => item.id === "system:role" && item.agents?.includes("shared"))
  if (!role) throw new Error("expected system:role for shared")
  const records: Plus.SnapshotCustomizationRecord[] = [
    {
      type: "customization",
      level: "defaults",
      agent: "shared",
      item: "system:role",
      section: null,
      text: "defaults edit",
      basedOn: role.fingerprint,
      updated: UPDATED,
    },
  ]
  const mutated = await Effect.runPromise(
    handlers["instructions.mutate"](
      { expectedRevision: snapshot.revision, expectedGlobalRevision: snapshot.globalRevision, records },
      throwingContext({}),
    ),
  )
  expect(mutated.ok).toBe(true)
  expect(await hostSystem(ctx, "shared")).toBe("defaults edit")
  const after = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const kept = after.agents.find((agent) => agent.id === "shared")
  expect(kept?.origin).not.toBe("plus")
  expect(kept?.fileBacked).toBe(false)
  await Effect.runPromise(handlers["instructions.refresh"](undefined, throwingContext({})))
  expect(await hostSystem(ctx, "shared")).toBe("defaults edit")
  const reread = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  expect(reread.agents.find((agent) => agent.id === "shared")?.origin).not.toBe("plus")
})

test("disable then enable retains a Defaults team role edit", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const shipped = "ship body S"
  const builtins = [{ name: "ship", members: [{ id: "mate", body: shipped }] }]
  const agents = agentHarness([], project)
  const base = fullContext({ directory: project })
  const skillState = skillHarness([])
  const tools = toolHarness([])
  const ctx = context({
    location: base.location,
    agent: agents.domain,
    skill: { ...skillState.domain, list: () => Effect.succeed({ location: base.location, data: Array.from(skillState.state.values()) }) },
    tool: tools.domain,
    mcp: base.mcp,
  })
  const state = createState()
  const handlers = createHandlers(ctx, state, { builtins })
  await Effect.runPromise(handlers["team.setEnabled"]({ level: "defaults", team: "ship", enabled: true }, throwingContext({})))
  expect(await hostSystem(ctx, "mate")).toBe(shipped)
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const role = snapshot.items.find((item) => item.id === "system:role" && item.agents?.includes("mate"))
  if (!role) throw new Error("expected system:role for mate")
  const records: Plus.SnapshotCustomizationRecord[] = [
    {
      type: "customization",
      level: "defaults",
      agent: "mate",
      item: "system:role",
      section: null,
      text: "custom B",
      basedOn: role.fingerprint,
      updated: UPDATED,
    },
  ]
  const mutated = await Effect.runPromise(
    handlers["instructions.mutate"](
      { expectedRevision: snapshot.revision, expectedGlobalRevision: snapshot.globalRevision, records },
      throwingContext({}),
    ),
  )
  expect(mutated.ok).toBe(true)
  expect(await hostSystem(ctx, "mate")).toBe("custom B")
  await Effect.runPromise(handlers["team.setEnabled"]({ level: "defaults", team: "ship", enabled: false }, throwingContext({})))
  const listed = await Effect.runPromise(ctx.agent.list())
  expect(listed.data.some((entry) => String(entry.id) === "mate")).toBe(false)
  await Effect.runPromise(handlers["team.setEnabled"]({ level: "defaults", team: "ship", enabled: true }, throwingContext({})))
  expect(await hostSystem(ctx, "mate")).toBe("custom B")
  const fingerprintAfter = state.fingerprint
  const installs = agents.transforms
  const disposes = agents.disposes
  await Effect.runPromise(handlers["instructions.refresh"](undefined, throwingContext({})))
  expect(state.fingerprint).toBe(fingerprintAfter)
  expect(agents.transforms).toBe(installs)
  expect(agents.disposes).toBe(disposes)
  expect(await hostSystem(ctx, "mate")).toBe("custom B")
})

test("fresh activation installs a Defaults team role edit", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const shipped = "ship body S"
  const builtins = [{ name: "ship", members: [{ id: "mate", body: shipped }] }]
  const agents = agentHarness([], project)
  const base = fullContext({ directory: project })
  const skillState = skillHarness([])
  const tools = toolHarness([])
  const ctx = context({
    location: base.location,
    agent: agents.domain,
    skill: { ...skillState.domain, list: () => Effect.succeed({ location: base.location, data: Array.from(skillState.state.values()) }) },
    tool: tools.domain,
    mcp: base.mcp,
  })
  const state = createState()
  const handlers = createHandlers(ctx, state, { builtins })
  await Effect.runPromise(handlers["team.setEnabled"]({ level: "defaults", team: "ship", enabled: true }, throwingContext({})))
  expect(await hostSystem(ctx, "mate")).toBe(shipped)
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const role = snapshot.items.find((item) => item.id === "system:role" && item.agents?.includes("mate"))
  if (!role) throw new Error("expected system:role for mate")
  const records: Plus.SnapshotCustomizationRecord[] = [
    {
      type: "customization",
      level: "defaults",
      agent: "mate",
      item: "system:role",
      section: null,
      text: "custom B",
      basedOn: role.fingerprint,
      updated: UPDATED,
    },
  ]
  const mutated = await Effect.runPromise(
    handlers["instructions.mutate"](
      { expectedRevision: snapshot.revision, expectedGlobalRevision: snapshot.globalRevision, records },
      throwingContext({}),
    ),
  )
  expect(mutated.ok).toBe(true)
  expect(await hostSystem(ctx, "mate")).toBe("custom B")
  await Effect.runPromise(deactivate(state))
  const fresh = createState()
  const freshHandlers = createHandlers(ctx, fresh, { builtins })
  await Effect.runPromise(freshHandlers["instructions.refresh"](undefined, throwingContext({})))
  expect(await hostSystem(ctx, "mate")).toBe("custom B")
})

test("ownership does not transfer between teams sharing an id", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const regular = "regular body U"
  const projectBody = "project body P"
  const shipped = "ship body S"
  const builtins = [{ name: "ship", members: [{ id: "shared", body: shipped }] }]
  const agents = agentHarness([agentInfo("shared", regular)], project)
  const base = fullContext({ directory: project })
  const skillState = skillHarness([])
  const tools = toolHarness([])
  const ctx = context({
    location: base.location,
    agent: agents.domain,
    skill: { ...skillState.domain, list: () => Effect.succeed({ location: base.location, data: Array.from(skillState.state.values()) }) },
    tool: tools.domain,
    mcp: base.mcp,
  })
  await writeTeamAgent(path.join(projectTeamsPath(project), "crew"), "shared", projectBody)
  const state = createState()
  const handlers = createHandlers(ctx, state, { builtins })
  await Effect.runPromise(handlers["team.setEnabled"]({ level: "project", team: "crew", enabled: true }, throwingContext({})))
  expect(await hostSystem(ctx, "shared")).toBe(projectBody)
  await Effect.runPromise(handlers["team.setEnabled"]({ level: "defaults", team: "ship", enabled: true }, throwingContext({})))
  expect(await hostSystem(ctx, "shared")).toBe(projectBody)
  await Effect.runPromise(handlers["team.setEnabled"]({ level: "project", team: "crew", enabled: false }, throwingContext({})))
  expect(await hostSystem(ctx, "shared")).toBe(regular)
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const entry = snapshot.agents.find((agent) => agent.id === "shared")
  expect(entry?.origin).not.toBe("plus")
  const fingerprintAfter = state.fingerprint
  const installs = agents.transforms
  const disposes = agents.disposes
  await Effect.runPromise(handlers["instructions.refresh"](undefined, throwingContext({})))
  expect(state.fingerprint).toBe(fingerprintAfter)
  expect(agents.transforms).toBe(installs)
  expect(agents.disposes).toBe(disposes)
  expect(await hostSystem(ctx, "shared")).toBe(regular)
})
