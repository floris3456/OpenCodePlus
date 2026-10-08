// An agent switch returns to the chat's last model for that agent, read from
// the chat's own history, else the agent's active model. Real store, a ctx
// with session.get/switchModel/context fakes, no globalThis mocks.
import { afterEach, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { applySessionModel, createState } from "../src/index.js"
import type { Model } from "@opencode/schema/model"
import { agentInfo, context, defaultHostTemplates, fullContext, modelHarness, modelInfo, promptHarness } from "./harness.js"

interface Switch {
  readonly sessionID: unknown
  readonly model: { providerID: unknown; id: unknown; variant?: unknown }
}

const roots: string[] = []
const priorConfigDir = process.env.OPENCODE_CONFIG_DIR
const priorDataHome = process.env.XDG_DATA_HOME

afterEach(async () => {
  if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
  if (priorDataHome === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = priorDataHome
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function tempProject(): Promise<string> {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-session-model-"))
  roots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  process.env.XDG_DATA_HOME = path.join(root, "share")
  return path.join(root, "project")
}

function modelWith(providerID: string, id: string, variants: string[] = []): Model.Info {
  const base = modelInfo(providerID, id)
  return { ...base, variants: variants.map((variant) => ({ id: variant }) as Model.Info["variants"][number]) }
}

function assistant(agent: string, providerID: string, id: string, variant?: string) {
  return {
    type: "assistant",
    agent,
    model: { providerID, id, ...(variant === undefined ? {} : { variant }) },
  }
}

// A context whose session domain reports the session's current model, serves
// the chat's history, and records every switchModel call.
function sessionFixture(
  project: string,
  models: Model.Info[],
  current: { providerID: string; id: string; variant?: string },
  history: readonly unknown[],
) {
  const switches: Switch[] = []
  const classifications: Record<string, string> = { "": "general" }
  for (const model of models) classifications[String(model.id)] = "general"
  const base = fullContext({
    directory: project,
    agents: [agentInfo("build", "Build.")],
    models,
    classifications,
  })
  const ctx = context({
    location: base.location,
    agent: base.agent,
    model: modelHarness(models),
    prompt: promptHarness(defaultHostTemplates, classifications),
    session: {
      get: () => Effect.succeed({ model: current } as never),
      context: () => Effect.succeed(history as never),
      switchModel: (input: { sessionID: unknown; model: { providerID: unknown; id: unknown; variant?: unknown } }) =>
        Effect.sync(() => {
          switches.push({ sessionID: input.sessionID, model: input.model })
        }),
    },
  })
  return { ctx, switches }
}

function stateWithActive() {
  const state = createState()
  state.activeModels = new Map([["build", { providerID: "acme", modelID: "nova-2" }]])
  return state
}

test("session.agent.selected returns to the chat's last model for that agent", async () => {
  const project = await tempProject()
  const models = [modelWith("acme", "nova-2"), modelWith("acme", "nova-3", ["high"])]
  const { ctx, switches } = sessionFixture(project, models, { providerID: "acme", id: "nova-2" }, [
    assistant("plan", "acme", "nova-1"),
    assistant("build", "acme", "nova-2"),
    assistant("build", "acme", "nova-3", "high"),
  ])
  const state = stateWithActive()
  await Effect.runPromise(
    applySessionModel(ctx, state, { type: "session.agent.selected", properties: { sessionID: "ses_history", agent: "build" } }),
  )
  expect(switches).toHaveLength(1)
  expect(String(switches[0]?.model.id)).toBe("nova-3")
  expect(switches[0]?.model.variant).toBe("high")
})

test("session.agent.selected falls back to the active model with no history for the agent", async () => {
  const project = await tempProject()
  const models = [modelWith("acme", "nova-2"), modelWith("acme", "nova-3", ["high"])]
  const { ctx, switches } = sessionFixture(project, models, { providerID: "acme", id: "nova-1" }, [
    assistant("plan", "acme", "nova-1"),
  ])
  const state = stateWithActive()
  await Effect.runPromise(
    applySessionModel(ctx, state, { type: "session.agent.selected", properties: { sessionID: "ses_fallback", agent: "build" } }),
  )
  expect(switches).toHaveLength(1)
  expect(String(switches[0]?.model.id)).toBe("nova-2")
})

test("session.agent.selected does not switch when the history model is current", async () => {
  const project = await tempProject()
  const models = [modelWith("acme", "nova-2"), modelWith("acme", "nova-3", ["high"])]
  const { ctx, switches } = sessionFixture(project, models, { providerID: "acme", id: "nova-3", variant: "high" }, [
    assistant("build", "acme", "nova-3", "high"),
  ])
  const state = stateWithActive()
  await Effect.runPromise(
    applySessionModel(ctx, state, { type: "session.agent.selected", properties: { sessionID: "ses_same", agent: "build" } }),
  )
  expect(switches).toHaveLength(0)
})

test("session.created ignores history and uses the active model", async () => {
  const project = await tempProject()
  const models = [modelWith("acme", "nova-1"), modelWith("acme", "nova-2"), modelWith("acme", "nova-3", ["high"])]
  const { ctx, switches } = sessionFixture(project, models, { providerID: "acme", id: "nova-1" }, [
    assistant("build", "acme", "nova-3", "high"),
  ])
  const state = stateWithActive()
  await Effect.runPromise(
    applySessionModel(ctx, state, { type: "session.created", properties: { sessionID: "ses_created", agent: "build" } }),
  )
  expect(switches).toHaveLength(1)
  expect(String(switches[0]?.model.id)).toBe("nova-2")
})
