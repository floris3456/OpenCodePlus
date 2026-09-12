import { expect, test } from "bun:test"
import type { AgentEditor } from "@opencode/plugin/effect/agent"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Session } from "@opencode/schema/session"
import { Effect, type Types } from "effect"
import { apply } from "../src/instructions/apply.js"
import { fingerprint, type Item, type Snapshot } from "../src/instructions/model.js"
import { context } from "./harness.js"

const UPDATED = "2026-01-01T00:00:00.000Z"

function item(overrides: Partial<Item> & { id: string; kind: Item["kind"]; owner: string }): Item {
  const text = overrides.text ?? "upstream"
  return {
    title: overrides.owner,
    text,
    agents: [],
    fingerprint: fingerprint(text),
    available: true,
    ...overrides,
    id: overrides.id,
    kind: overrides.kind,
    owner: overrides.owner,
  }
}

function snapshot(items: Item[], customizations: Snapshot["customizations"] = []): Snapshot {
  return { revision: 1, items, customizations }
}

function agent(id: string, system: string): Types.DeepMutable<Agent.Info> {
  return {
    id: Agent.ID.make(id),
    name: Agent.Name.make(id),
    request: { settings: {}, headers: {}, body: {} },
    system,
    mode: "primary",
    hidden: false,
    permissions: [],
  }
}

function agentState(ids: { id: string; system: string }[]): Map<string, Types.DeepMutable<Agent.Info>> {
  return new Map(ids.map((entry) => [entry.id, agent(entry.id, entry.system)]))
}

function agentEditor(state: Map<string, Types.DeepMutable<Agent.Info>>): AgentEditor {
  return {
    list: () => Array.from(state.values()),
    get: (id) => state.get(id),
    default: () => undefined,
    update: (id, update) => {
      const current = state.get(id)
      if (current) update(current)
    },
    remove: (id) => {
      state.delete(id)
    },
  }
}

function sessionEvent(agentID: string, tools: SessionHooks["context"]["tools"]): SessionHooks["context"] {
  return {
    sessionID: Session.ID.make("ses_test_event"),
    agent: Agent.ID.make(agentID),
    model: Model.Ref.make({ providerID: Provider.ID.make("test"), id: Model.ID.make("test") }),
    system: [{ type: "text", text: "base" }],
    messages: [],
    options: {},
    tools,
  }
}

test("a saved prompt override reaches agent.transform and sets system", async () => {
  const state = agentState([{ id: "alpha", system: "upstream" }])
  const prompts = [item({ id: "prompt:alpha", kind: "prompt", owner: "alpha", text: "upstream" })]
  const customizations = [
    { item: "prompt:alpha", agent: "alpha", text: "custom", state: "inherit" as const, basedOn: prompts[0].fingerprint, updated: UPDATED },
  ]
  let reloaded = 0
  const ctx = context({
    agent: {
      list: () => Effect.die("unused agent.list"),
      get: () => Effect.die("unused agent.get"),
      transform: (callback) =>
        Effect.sync(() => {
          callback(agentEditor(state))
          return { dispose: Effect.void }
        }),
      reload: () =>
        Effect.sync(() => {
          reloaded++
        }),
    },
    session: {
      hook: () => Effect.die("unused session.hook"),
    },
  })

  const applied = await apply(ctx, snapshot(prompts), customizations)
  expect(applied.registrations).toHaveLength(1)
  expect(state.get("alpha")?.system).toBe("custom")
  expect(reloaded).toBe(1)
})

test("a disabled skill denies that agent only", async () => {
  const state = agentState([
    { id: "alpha", system: "upstream" },
    { id: "beta", system: "upstream" },
  ])
  const items = [
    item({ id: "prompt:alpha", kind: "prompt", owner: "alpha", text: "upstream", agents: ["alpha"] }),
    item({ id: "prompt:beta", kind: "prompt", owner: "beta", text: "upstream", agents: ["beta"] }),
    item({ id: "skill:notes", kind: "skill", owner: "notes", title: "notes", text: "skill body" }),
  ]
  const customizations = [
    {
      item: "skill:notes",
      agent: "alpha",
      state: "disabled" as const,
      basedOn: items[2].fingerprint,
      updated: UPDATED,
    },
  ]
  const ctx = context({
    agent: {
      list: () => Effect.die("unused agent.list"),
      get: () => Effect.die("unused agent.get"),
      transform: (callback) =>
        Effect.sync(() => {
          callback(agentEditor(state))
          return { dispose: Effect.void }
        }),
      reload: () => Effect.void,
    },
    session: {
      hook: () => Effect.die("unused session.hook"),
    },
  })

  await apply(ctx, snapshot(items), customizations)
  expect(state.get("alpha")?.permissions).toEqual([{ action: "skill", resource: "notes", effect: "deny" }])
  // The negative case is asserted: the other agent keeps its original permissions.
  expect(state.get("beta")?.permissions).toEqual([])
})

test("a tool description override reaches the target agent and not another agent", async () => {
  const prompts = [
    item({ id: "prompt:alpha", kind: "prompt", owner: "alpha", text: "upstream", agents: ["alpha"] }),
    item({ id: "prompt:beta", kind: "prompt", owner: "beta", text: "upstream", agents: ["beta"] }),
  ]
  const tools = [item({ id: "tool:reader", kind: "tool", owner: "reader", title: "reader", text: "read things" })]
  const all = [...prompts, ...tools]
  const customizations = [
    {
      item: "tool:reader",
      agent: "alpha",
      text: "custom description",
      state: "inherit" as const,
      basedOn: tools[0].fingerprint,
      updated: UPDATED,
    },
  ]
  const callbacks: ((event: SessionHooks["context"]) => Effect.Effect<void>)[] = []
  const ctx = context({
    agent: {
      list: () => Effect.die("unused agent.list"),
      get: () => Effect.die("unused agent.get"),
      transform: () => Effect.die("unused agent.transform"),
      reload: () => Effect.die("unused agent.reload"),
    },
    session: {
      hook: (name, callback) => {
        if (name === "context") callbacks.push(callback as (event: SessionHooks["context"]) => Effect.Effect<void>)
        return Effect.succeed({ dispose: Effect.void })
      },
    },
  })

  const applied = await apply(ctx, snapshot(all), customizations)
  expect(applied.registrations).toHaveLength(1)
  expect(callbacks).toHaveLength(1)
  const run = callbacks[0]
  if (!run) throw new Error("missing context hook")
  const alpha = sessionEvent("alpha", { reader: { description: "read things", input: { type: "object" } } })
  const beta = sessionEvent("beta", { reader: { description: "read things", input: { type: "object" } } })
  await Effect.runPromise(run(alpha))
  await Effect.runPromise(run(beta))
  expect(alpha.tools.reader?.description).toBe("custom description")
  // The negative case is asserted: a different agent keeps the upstream description.
  expect(beta.tools.reader?.description).toBe("read things")
})
