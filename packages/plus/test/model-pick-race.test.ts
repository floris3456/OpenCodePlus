// Part 4 (9): a `model.pick` in flight must be awaited before applySessionModel
// reads the active-model cache, so a session created right after the pick is
// not reverted to the previous active row. Real store, real discovery, no mocks.
import { afterEach, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { applySessionModel, createHandlers, createState } from "../src/index.js"
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
  const root = await fs.mkdtemp(path.join(parent, "plus-model-pick-race-"))
  roots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  process.env.XDG_DATA_HOME = path.join(root, "share")
  return path.join(root, "project")
}

function modelWith(providerID: string, id: string): Model.Info {
  const base = modelInfo(providerID, id)
  return { ...base, variants: [] }
}

function throwingContext(): { error: (type: string, message: string, data?: unknown) => never } {
  return {
    error: (type, message, data) => {
      throw { type, message, data }
    },
  }
}

// A context whose session domain reports the session's current model and records
// every switchModel call.
function sessionFixture(project: string, models: Model.Info[], current: { providerID: string; id: string; variant?: string }) {
  const switches: Switch[] = []
  const base = fullContext({
    directory: project,
    agents: [agentInfo("build", "Build.")],
    models,
    classifications: { "": "general", "nova-2": "general", "nova-3": "general" },
  })
  const ctx = context({
    location: base.location,
    agent: base.agent,
    model: modelHarness(models),
    prompt: promptHarness(defaultHostTemplates, { "": "general", "nova-2": "general", "nova-3": "general" }),
    session: {
      get: () => Effect.succeed({ model: current } as never),
      switchModel: (input: { sessionID: unknown; model: { providerID: unknown; id: unknown; variant?: unknown } }) =>
        Effect.sync(() => {
          switches.push({ sessionID: input.sessionID, model: input.model })
        }),
    },
  })
  return { ctx, switches }
}

test("(9) a pick still in flight is awaited before applySessionModel reads the cache", async () => {
  const project = await tempProject()
  const models = [modelWith("acme", "nova-2"), modelWith("acme", "nova-3")]
  // A completed first pick makes nova-2 the store's active row; the session
  // runs nova-2, so once the compare reads the cache nothing switches.
  const { ctx, switches } = sessionFixture(project, models, { providerID: "acme", id: "nova-2" })
  const state = createState()
  const handlers = createHandlers(ctx, state)
  await Effect.runPromise(
    handlers["model.pick"]({ agent: "build", providerID: "acme", modelID: "nova-2" }, throwingContext()),
  )
  // Record when the cache is actually read.
  const reads: string[] = []
  const cache = new Map(state.activeModels)
  cache.get = (key: string) => {
    reads.push(`read ${key}`)
    return Map.prototype.get.call(cache, key)
  }
  state.activeModels = cache
  // A second pick is in flight and has not settled.
  let settleGate!: () => void
  state.pendingPick = new Promise<void>((resolve) => {
    settleGate = resolve
  })
  const running = Effect.runPromise(
    applySessionModel(ctx, state, { type: "session.created", properties: { sessionID: "ses_pick", agent: "build" } }),
  )
  await Bun.sleep(30)
  // The fix holds the compare behind the in-flight pick: no read yet.
  expect(reads).toEqual([])
  expect(switches).toHaveLength(0)
  settleGate()
  await running
  // The compare now reads the cache; the wanted model matches the session, so
  // nothing switches.
  expect(reads).toEqual(["read build"])
  expect(switches).toHaveLength(0)

  // Control: with the cache at nova-3 and the session on nova-2, a session event
  // still switches (the await does not disable the mechanism).
  state.pendingPick = undefined
  state.activeModels = new Map([["build", { providerID: "acme", modelID: "nova-3" }]])
  await Effect.runPromise(
    applySessionModel(ctx, state, { type: "session.created", properties: { sessionID: "ses_pick", agent: "build" } }),
  )
  expect(switches).toHaveLength(1)
  expect(String(switches[0]?.model.id)).toBe("nova-3")
})
