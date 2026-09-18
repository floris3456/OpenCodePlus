import { afterEach, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { applySessionModel, createHandlers, createState } from "../../src/index.js"
import { load, save, type StoredRecord } from "../../src/instructions/store.js"
import { enable } from "../../src/project.js"
import {
  agentHarness,
  catalogHarness,
  context,
  defaultHostTemplates,
  fullContext,
  promptHarness,
  skillHarness,
  toolHarness,
} from "../harness.js"

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
  const root = await fs.mkdtemp(path.join(parent, "plus-teams-models-"))
  roots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  return { project: path.join(root, "project") }
}

function throwingContext(captured: { current?: unknown }): {
  error: (type: string, message: string, data?: unknown) => never
} {
  return {
    error: (type, message, data) => {
      captured.current = data === undefined ? { type, message } : { type, message, data }
      throw captured.current
    },
  }
}

const ORCHESTRATOR = { providerID: "cliproxyapi", modelID: "claude-opus-5", variant: "high" } as const
const IMPLEMENTER = { providerID: "acme", modelID: "nova-2" } as const
const IMPLEMENTER_DESCRIPTION = "Muse implementer: executes the brief inside scope and finishes"

function teamRecord(): StoredRecord {
  return { type: "team", level: "defaults", team: "opencodeplus-team", enabled: true, updated: UPDATED }
}

function modelRecord(agent: string, ref: { providerID: string; modelID: string; variant?: string }): StoredRecord {
  return {
    type: "model",
    level: "defaults",
    agent,
    providerID: ref.providerID,
    modelID: ref.modelID,
    ...(ref.variant === undefined ? {} : { variant: ref.variant }),
    active: true,
    updated: UPDATED,
  }
}

interface Switch {
  readonly sessionID: unknown
  readonly model: { providerID: unknown; id: unknown; variant?: unknown }
}

// One publish with the team enablement and the model pins already stored, so
// discovery has never seen the team-only ids: the first publish after enable
// or restart. Saving through the store (instead of team.setEnabled followed
// by mutate) matters: the intermediate publish would install the team agents
// into the host and hide the bug from the second publish.
async function publishOnce(project: string, records: readonly StoredRecord[]): Promise<{ ctx: ReturnType<typeof context>; state: ReturnType<typeof createState>; switches: Switch[] }> {
  const agents = agentHarness([])
  const location = fullContext({ directory: project }).location
  const skillState = skillHarness([])
  const skill = { ...skillState.domain, list: () => Effect.succeed({ location, data: Array.from(skillState.state.values()) }) }
  const tools = toolHarness([])
  const switches: Switch[] = []
  const ctx = context({
    location,
    agent: agents.domain,
    catalog: catalogHarness([]),
    prompt: promptHarness(defaultHostTemplates),
    skill,
    tool: tools.domain,
    mcp: fullContext({ directory: project }).mcp,
    session: {
      get: () => Effect.succeed({ model: { providerID: "stale", id: "stale" } } as never),
      switchModel: (input: { sessionID: unknown; model: { providerID: unknown; id: unknown; variant?: unknown } }) =>
        Effect.sync(() => {
          switches.push({ sessionID: input.sessionID, model: input.model })
        }),
    },
  })
  const state = createState()
  const handlers = createHandlers(ctx, state)
  const stored = await load(project)
  await save(project, {
    expectedProjectRevision: stored.projectRevision,
    expectedGlobalRevision: stored.globalRevision,
    records: [...stored.records, ...records],
  })
  await Effect.runPromise(handlers["instructions.refresh"](undefined, throwingContext({})))
  return { ctx, state, switches }
}

test("a defaults model pin for a built-in team member lands in activeModels on the first publish", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const { state } = await publishOnce(project, [teamRecord(), modelRecord("muse-implementer", IMPLEMENTER)])
  expect(state.activeModels.get("muse-implementer")).toMatchObject({ providerID: "acme", modelID: "nova-2" })
  expect("variant" in (state.activeModels.get("muse-implementer") ?? {})).toBe(false)
  expect(state.cachedAgents.some((agent) => agent.id === "muse-implementer")).toBe(true)
  expect(state.cachedScopes.defaults.has("muse-implementer")).toBe(true)
})

test("session.created switches a team session to its pinned model", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const { ctx, state, switches } = await publishOnce(project, [teamRecord(), modelRecord("muse-implementer", IMPLEMENTER)])
  await Effect.runPromise(
    applySessionModel(ctx, state, { type: "session.created", properties: { sessionID: "ses_1", agent: "muse-implementer" } }),
  )
  expect(switches).toHaveLength(1)
  expect(String(switches[0]?.model.providerID)).toBe("acme")
  expect(String(switches[0]?.model.id)).toBe("nova-2")
  expect("variant" in (switches[0]?.model ?? {})).toBe(false)
})

test("session.agent.selected switches through the switchAgent path with the variant", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const { ctx, state, switches } = await publishOnce(project, [teamRecord(), modelRecord("opus-orchestrator", ORCHESTRATOR)])
  await Effect.runPromise(
    applySessionModel(ctx, state, { type: "session.agent.selected", properties: { sessionID: "ses_1", agent: "opus-orchestrator" } }),
  )
  expect(switches).toHaveLength(1)
  expect(String(switches[0]?.model.providerID)).toBe("cliproxyapi")
  expect(String(switches[0]?.model.id)).toBe("claude-opus-5")
  expect(String(switches[0]?.model.variant)).toBe("high")
})

test("two roles pinned to two models each keep their own ref", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const { state } = await publishOnce(project, [
    teamRecord(),
    modelRecord("opus-orchestrator", ORCHESTRATOR),
    modelRecord("muse-implementer", IMPLEMENTER),
  ])
  expect(state.activeModels.get("opus-orchestrator")).toMatchObject({
    providerID: "cliproxyapi",
    modelID: "claude-opus-5",
    variant: "high",
  })
  expect(state.activeModels.get("muse-implementer")).toMatchObject({ providerID: "acme", modelID: "nova-2" })
})

test("a role with no model record never switches", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const { ctx, state, switches } = await publishOnce(project, [teamRecord(), modelRecord("muse-implementer", IMPLEMENTER)])
  await Effect.runPromise(
    applySessionModel(ctx, state, { type: "session.created", properties: { sessionID: "ses_1", agent: "scout" } }),
  )
  expect(switches).toHaveLength(0)
})

test("the built-in role description survives the model pin", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const { ctx } = await publishOnce(project, [teamRecord(), modelRecord("muse-implementer", IMPLEMENTER)])
  const listed = await Effect.runPromise(ctx.agent.list())
  const agent = listed.data.find((entry) => String(entry.id) === "muse-implementer")
  expect(agent).toBeDefined()
  if (agent === undefined) return
  expect(agent.description).toBe(IMPLEMENTER_DESCRIPTION)
})
