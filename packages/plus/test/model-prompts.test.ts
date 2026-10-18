import { afterEach, expect, test } from "bun:test"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Session } from "@opencode/schema/session"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { Effect, Exit } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createSystemRow } from "../src/agents/system.js"
import { createHandlers, createState } from "../src/index.js"
import { apply, applyPublishParts, type ApplyInput } from "../src/instructions/apply.js"
import { computeChangeNote, createPlanSet, sessionPins, type SessionPin } from "../src/instructions/cache-safe.js"
import { discover } from "../src/instructions/discover.js"
import { groupScope } from "../src/instructions/folders.js"
import type { CustomizationRecord, Item, Level } from "../src/instructions/model.js"
import { matchesModel, parseModelPatterns } from "../src/instructions/model-patterns.js"
import { planRowMove, planSystemMove } from "../src/instructions/ops.js"
import { modelPromptDir } from "../src/instructions/paths.js"
import { chainContext } from "../src/instructions/presets.js"
import { modelPromptMoveRefusal } from "../src/instructions/system-order.js"
import { expandedTree, type TreeNode } from "../src/instructions/tree.js"
import { startMove } from "../src/tui/instructions/move.js"
import { agentHarness, agentInfo, context, fullContext, modelInfo, modelRef } from "./harness.js"

// Model prompts: user System rows (`system:model/<id>`) sent right after the
// base prompt, only to a request whose model one of their patterns names.

const UPDATED = "2026-01-01T00:00:00.000Z"
const roots: string[] = []
const priorConfigDir = process.env.OPENCODE_CONFIG_DIR
const priorTestHome = process.env.OPENCODE_TEST_HOME

afterEach(async () => {
  if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
  if (priorTestHome === undefined) delete process.env.OPENCODE_TEST_HOME
  else process.env.OPENCODE_TEST_HOME = priorTestHome
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "plus-model-prompts-"))
  roots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  // The AGENTS.md walk stops at home: keep it inside the fixture.
  process.env.OPENCODE_TEST_HOME = root
  return path.join(root, "project")
}

type Captured = { current?: { type: string; message: string; data?: unknown } }

function throwingContext(captured: Captured): { error: (type: string, message: string, data?: unknown) => never } {
  return {
    error: (type, message, data) => {
      const failure = data === undefined ? { type, message } : { type, message, data }
      captured.current = failure
      throw failure
    },
  }
}

test("a pattern names a model by provider/model, its id or its name; * or % stands for any text", () => {
  const opus = { providerID: "cliproxyapi", id: "claude-opus-5-5", name: "Claude Opus 5.5" }
  expect(matchesModel(["claude-opus-5-5"], opus)).toBe(true)
  expect(matchesModel(["cliproxyapi/claude-opus-5-5"], opus)).toBe(true)
  expect(matchesModel(["anthropic/claude-opus-5-5"], opus)).toBe(false)
  expect(matchesModel(["*opus-5-5*"], { ...opus, providerID: "anthropic" })).toBe(true)
  expect(matchesModel(["%OPUS 5.5%"], opus)).toBe(true)
  // The whole text must match, and a dot is a dot.
  expect(matchesModel(["opus"], opus)).toBe(false)
  expect(matchesModel(["claude-opus-5.5"], opus)).toBe(false)
  expect(matchesModel(["*sonnet*", "*opus*"], opus)).toBe(true)
  expect(matchesModel([], opus)).toBe(false)
  expect(parseModelPatterns(" *opus-5-5*, %qwen%,*opus-5-5* ,\nClaude Opus 5.5")).toEqual(["*opus-5-5*", "%qwen%", "Claude Opus 5.5"])
})

test("system.create with models makes a model prompt in its own folder; system.models replaces its models; delete removes it", async () => {
  const project = await tempRoot()
  const handlers = createHandlers(fullContext({ directory: project, agents: [agentInfo("alpha", "upstream")] }), createState())
  const created = await Effect.runPromise(
    handlers["system.create"]({ id: "opus", title: "Opus 5.5", text: "Check twice.", models: ["*opus-5-5*"] }, throwingContext({})),
  )
  expect(created).toEqual({ id: "model/opus" })
  expect(await Bun.file(path.join(modelPromptDir(), "opus.md")).text()).toBe("Check twice.")
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  expect(snapshot.items.find((item) => item.id === "system:model/opus")).toMatchObject({ kind: "system", title: "Opus 5.5", userSystem: true, models: ["*opus-5-5*"] })
  // It is not a System row of its own.
  expect(snapshot.items.some((item) => item.id === "system:opus")).toBe(false)

  expect(await Effect.runPromise(handlers["system.models"]({ id: "model/opus", models: ["*opus-5-5*", "%opus 5.5%"] }, throwingContext({})))).toEqual({ id: "model/opus" })
  const changed = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  expect(changed.items.find((item) => item.id === "system:model/opus")?.models).toEqual(["*opus-5-5*", "%opus 5.5%"])

  const refusals: readonly (readonly [(into: Captured) => Effect.Effect<unknown, unknown>, string])[] = [
    [(into) => handlers["system.models"]({ id: "model/opus", models: [" ", ","] }, throwingContext(into)), "system.invalid"],
    [(into) => handlers["system.models"]({ id: "model/nope", models: ["*"] }, throwingContext(into)), "system.missing"],
    [(into) => handlers["system.create"]({ id: "empty", title: "Empty", text: "x", models: [] }, throwingContext(into)), "system.invalid"],
    [(into) => handlers["system.create"]({ id: "opus", title: "Again", text: "x", models: ["*"] }, throwingContext(into)), "system.exists"],
  ]
  for (const [run, type] of refusals) {
    const seen: Captured = {}
    expect(Exit.isFailure(await Effect.runPromiseExit(run(seen)))).toBe(true)
    expect(seen.current?.type).toBe(type)
  }

  expect(await Effect.runPromise(handlers["system.delete"]({ id: "model/opus" }, throwingContext({})))).toEqual({ id: "model/opus" })
  const after = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  expect(after.items.some((item) => item.id === "system:model/opus")).toBe(false)
  expect(await Bun.file(path.join(modelPromptDir(), "models.json")).json()).toEqual({})
})

function sessionEvent(agentID: string, modelID: string, system: SessionHooks["context"]["system"]): SessionHooks["context"] {
  return {
    sessionID: Session.ID.make("ses_model_prompts"),
    agent: Agent.ID.make(agentID),
    model: Model.Ref.make({ providerID: Provider.ID.make("cliproxyapi"), id: Model.ID.make(modelID) }),
    system,
    messages: [],
    options: {},
    tools: {},
  }
}

function input(items: readonly Item[], records: readonly CustomizationRecord[], agents: readonly string[]): ApplyInput {
  const sources = agents.map((id) => ({ id, scope: "project" as const, origin: "user" as const }))
  return {
    items,
    records,
    splits: [],
    agents: agents.map((id) => ({ id, level: "project" as Level })),
    scopes: chainContext({
      agents: sources,
      items,
      links: agents.map((agent) => ({ type: "link", level: "project", agent, preset: { kind: "agent", id: "build" }, updated: UPDATED })),
    }),
  }
}

// The base prompt and a few of OpenCode's parts, as core hands them to Plus.
function requestSystem(): SessionHooks["context"]["system"] {
  return [
    { type: "text", text: "base" },
    { type: "text", text: "identity", metadata: { instruction: { key: "core/identity" } } },
    { type: "text", text: "date", metadata: { instruction: { key: "core/date" } } },
  ]
}

async function request(agent: string, modelID: string, records: readonly CustomizationRecord[], orders?: ApplyInput["orders"]): Promise<string[]> {
  const callbacks: ((event: SessionHooks["context"]) => Effect.Effect<void>)[] = []
  const ctx = context({
    agent: agentHarness([agentInfo("alpha", "upstream"), agentInfo("beta", "upstream")]).domain,
    session: {
      hook: (name, callback) => {
        if (name === "context") callbacks.push(callback as (event: SessionHooks["context"]) => Effect.Effect<void>)
        return Effect.succeed({ dispose: Effect.void })
      },
    },
  })
  const discovered = await discover({ ctx, records: [], baseTemplates: [], activeBase: () => undefined })
  await apply(ctx, { ...input(discovered.items, records, ["alpha", "beta"]), ...(orders === undefined ? {} : { orders }) })
  const event = sessionEvent(agent, modelID, requestSystem())
  await Effect.runPromise(Effect.forEach(callbacks, (run) => run(event), { discard: true }))
  return event.system.map((part) => part.text)
}

test("a model prompt is sent right after the base prompt, only to a request whose model it names, and switches per agent", async () => {
  await tempRoot()
  await createSystemRow("opus", "Opus 5.5", "Check twice.", ["*opus-5-5*"])
  await createSystemRow("qwen", "Qwen", "Use the tools.", ["%qwen%"])
  const off: CustomizationRecord = { type: "customization", level: "project", agent: "beta", item: "system:model/opus", section: null, state: "off", basedOn: "", updated: UPDATED }
  expect(await request("alpha", "claude-opus-5-5", [off])).toEqual(["base", "Check twice.", "identity", "date"])
  expect(await request("alpha", "Qwen3.6-35B", [off])).toEqual(["base", "Use the tools.", "identity", "date"])
  expect(await request("alpha", "gpt-6", [off])).toEqual(["base", "identity", "date"])
  // Switched off for beta: its Opus requests carry none.
  expect(await request("beta", "claude-opus-5-5", [off])).toEqual(["base", "identity", "date"])
  // A stored System order moves them as one part.
  const orders = [{ type: "order" as const, level: "global" as const, scope: groupScope("group:defaults::system"), items: ["first", "core/identity", "core/date", "model-prompts"], updated: UPDATED }]
  expect(await request("alpha", "claude-opus-5-5", [off], orders)).toEqual(["base", "identity", "date", "Check twice."])
})

// The path a publish installs (with session pins), as the service runs it.
test("the publish path keeps a model prompt's models: a chat on another model gets none", async () => {
  await tempRoot()
  await createSystemRow("opus", "Opus 5.5", "Check twice.", ["*opus-5-5*"])
  sessionPins.clear()
  const callbacks: ((event: SessionHooks["context"]) => Effect.Effect<void>)[] = []
  const ctx = context({
    agent: agentHarness([agentInfo("alpha", "upstream")]).domain,
    session: {
      hook: (name, callback) => {
        if (name === "context") callbacks.push(callback as (event: SessionHooks["context"]) => Effect.Effect<void>)
        return Effect.succeed({ dispose: Effect.void })
      },
    },
  })
  const discovered = await discover({ ctx, records: [], baseTemplates: [], activeBase: () => undefined })
  await applyPublishParts(ctx, { appliedParts: new Map() }, { applyInput: input(discovered.items, [], ["alpha"]) })
  const chat = async (session: string, modelID: string) => {
    const event = { ...sessionEvent("alpha", modelID, requestSystem()), sessionID: Session.ID.make(session) }
    await Effect.runPromise(Effect.forEach(callbacks, (run) => run(event), { discard: true }))
    return event.system.map((part) => part.text)
  }
  expect(await chat("ses_opus", "claude-opus-5-5")).toEqual(["base", "Check twice.", "identity", "date"])
  expect(await chat("ses_qwen", "qwen3.6")).toEqual(["base", "identity", "date"])
  sessionPins.clear()
})

// The direct rows of one tree group, in list order.
function childrenOf(nodes: readonly TreeNode[], groupId: string): TreeNode[] {
  const at = nodes.findIndex((node) => node.id === groupId)
  const depth = nodes[at]!.depth
  const rest = nodes.slice(at + 1)
  const end = rest.findIndex((node) => node.depth <= depth)
  return rest.slice(0, end === -1 ? undefined : end).filter((node) => node.depth === depth + 1)
}

test("System lists Model prompts right after Base; each row says which models it is for and whether this agent's model is one", async () => {
  const project = await tempRoot()
  await createSystemRow("opus", "Opus 5.5", "Check twice.", ["*opus-5-5*"])
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("alpha", "upstream", modelRef("cliproxyapi", "claude-opus-5-5")), agentInfo("beta", "upstream", modelRef("cliproxyapi", "qwen3.6"))],
    models: [modelInfo("cliproxyapi", "claude-opus-5-5", "Claude Opus 5.5"), modelInfo("cliproxyapi", "qwen3.6")],
  })
  const discovered = await discover({ ctx, records: [], baseTemplates: [], activeBase: () => undefined })
  const memo = { agents: discovered.agents, items: discovered.items, records: [], teams: [], hostModels: discovered.hostModels }
  const nodes = expandedTree(memo)
  const list = childrenOf(nodes, "group:defaults:alpha:system")
  expect(list.map((node) => node.label).slice(0, 4)).toEqual(["Tools", "Role/persona", "Base", "Model prompts"])
  expect(list[3]?.add).toBe("modelprompt")
  const alpha = childrenOf(nodes, "group:defaults:alpha:model-prompts")
  expect(alpha.map((node) => [node.label, node.badges.models, node.badges.slotNote])).toEqual([["Opus 5.5", ["*opus-5-5*"], "sent with Claude Opus 5.5"]])
  expect(alpha[0]?.actions).toMatchObject({ toggle: true, edit: true, remove: true, requires: true })
  expect(childrenOf(nodes, "group:defaults:beta:model-prompts").map((node) => node.badges.slotNote)).toEqual(["not sent: model is qwen3.6"])
  // Defaults for every agent has no model of its own to check.
  expect(childrenOf(nodes, "group:defaults::model-prompts").map((node) => node.badges.slotNote)).toEqual([undefined])

  const empty = { folders: [], orders: [] }
  expect(startMove(alpha[0]!, empty)).toEqual({ refusal: modelPromptMoveRefusal })
  expect(planRowMove(memo, empty, alpha[0]!.id, { after: "item:defaults:alpha:system:opencode/date" }, UPDATED)).toEqual({ refusal: modelPromptMoveRefusal })
  const moved = planSystemMove(memo, empty, "group:defaults:alpha:model-prompts", { after: "item:defaults:alpha:system:opencode/date" }, UPDATED)
  if ("refusal" in moved) throw new Error(moved.refusal)
  const items = moved.layout.orders[0]?.items ?? []
  expect(items.indexOf("model-prompts")).toBe(items.indexOf("core/date") + 1)
  expect(moved.status).toBe(`Moved "Model prompts" after "Date": the model receives it there`)
})

test("a running chat's change note names a model prompt only for the chat's own model", () => {
  const plan = (models: readonly string[]) => ({ agent: "alpha", path: path.join(os.tmpdir(), "x.md"), text: "Check twice.", enabled: true, models })
  const planSet = (instructions: ReturnType<typeof plan>[]) =>
    createPlanSet({ roles: new Map(), base: [], native: [], instructions, scrubByAgent: new Map(), needsNarrowing: false, permissions: { rows: [] } as never, customByAgent: new Set(), orders: new Map() })
  const pin = { planSet: planSet([]), model: { providerID: "cliproxyapi", id: "qwen3.6" } } as unknown as SessionPin
  expect(computeChangeNote(pin, planSet([plan(["*opus*"])]), "alpha")).toBeUndefined()
  expect(computeChangeNote(pin, planSet([plan(["*qwen*"])]), "alpha")?.noteText).toContain("Check twice.")
})
