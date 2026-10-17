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
import { apply, type ApplyInput } from "../src/instructions/apply.js"
import { discover } from "../src/instructions/discover.js"
import { fingerprint, type CustomizationRecord, type Item, type Level } from "../src/instructions/model.js"
import { userSystemFile } from "../src/instructions/paths.js"
import { chainContext } from "../src/instructions/presets.js"
import { expandedTree } from "../src/instructions/tree.js"
import { agentHarness, agentInfo, context, fullContext, toolHarness } from "./harness.js"

// User-created System rows: a global file per row that every level and
// catalogue lists and Plus plans per agent like the Tools and rules row.

const UPDATED = "2026-01-01T00:00:00.000Z"
const roots: string[] = []
const priorConfigDir = process.env.OPENCODE_CONFIG_DIR

afterEach(async () => {
  if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "plus-system-rows-"))
  roots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  return path.join(root, "project")
}

function throwingContext(captured: { current?: { type: string; message: string; data?: unknown } }): {
  error: (type: string, message: string, data?: unknown) => never
} {
  return {
    error: (type, message, data) => {
      const failure = data === undefined ? { type, message } : { type, message, data }
      captured.current = failure
      throw failure
    },
  }
}

test("system.create adds a deletable System row; ids are slugs and built-in ids are refused", async () => {
  const project = await tempRoot()
  const handlers = createHandlers(fullContext({ directory: project, agents: [agentInfo("alpha", "upstream")] }), createState())
  const created = await Effect.runPromise(
    handlers["system.create"]({ id: "working-rules", title: "Working rules", text: "# Working rules\n\nSay what you checked." }, throwingContext({})),
  )
  expect(created).toEqual({ id: "working-rules" })
  expect(await Bun.file(userSystemFile("working-rules")).text()).toBe("# Working rules\n\nSay what you checked.")

  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const row = snapshot.items.find((item) => item.id === "system:working-rules")
  expect(row).toMatchObject({ kind: "system", group: "none", title: "Working rules", enabled: true, userSystem: true })
  expect(row?.fingerprint).toBe(fingerprint("# Working rules\n\nSay what you checked."))

  for (const [input, type] of [
    [{ id: "working-rules", title: "Again", text: "x" }, "system.exists"],
    [{ id: "tools-and-rules", title: "Shadow", text: "x" }, "system.invalid"],
    [{ id: "Working Rules", title: "Spaces", text: "x" }, "system.invalid"],
    [{ id: "../escape", title: "Escape", text: "x" }, "system.invalid"],
  ] as const) {
    const captured: { current?: { type: string; message: string; data?: unknown } } = {}
    const exit = await Effect.runPromiseExit(handlers["system.create"](input, throwingContext(captured)))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(captured.current?.type).toBe(type)
  }

  expect(await Effect.runPromise(handlers["system.delete"]({ id: "working-rules" }, throwingContext({})))).toEqual({ id: "working-rules" })
  const after = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  expect(after.items.some((item) => item.id === "system:working-rules")).toBe(false)
  const missing: { current?: { type: string; message: string; data?: unknown } } = {}
  const exit = await Effect.runPromiseExit(handlers["system.delete"]({ id: "working-rules" }, throwingContext(missing)))
  expect(Exit.isFailure(exit)).toBe(true)
  expect(missing.current?.type).toBe("system.missing")
})

function sessionEvent(agentID: string): SessionHooks["context"] {
  return {
    sessionID: Session.ID.make("ses_system_rows"),
    agent: Agent.ID.make(agentID),
    model: Model.Ref.make({ providerID: Provider.ID.make("test"), id: Model.ID.make("test") }),
    system: [],
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

function off(agent: string, item: string): CustomizationRecord {
  return { type: "customization", level: "project", agent, item, section: null, state: "off", basedOn: "", updated: UPDATED }
}

const rulesText = `# Working rules

## Honest work
Say what you checked.

## Teams
<!-- requires: tool:team_check -->
Never claim approval you cannot quote.
`

test("a System row reaches each agent that has it on, keyed by its file, with its conditions applied", async () => {
  await tempRoot()
  await createSystemRow("working-rules", "Working rules", rulesText)
  const callbacks: ((event: SessionHooks["context"]) => Effect.Effect<void>)[] = []
  const ctx = context({
    agent: agentHarness([agentInfo("alpha", "upstream"), agentInfo("beta", "upstream"), agentInfo("gamma", "upstream")]).domain,
    tool: toolHarness([{ id: "team_check", description: "Run a check", options: { codemode: false } }]).domain,
    session: {
      hook: (name, callback) => {
        if (name === "context") callbacks.push(callback as (event: SessionHooks["context"]) => Effect.Effect<void>)
        return Effect.succeed({ dispose: Effect.void })
      },
    },
  })
  const discovered = await discover({ ctx, records: [], baseTemplates: [], activeBase: () => undefined })
  const row = discovered.items.find((item) => item.id === "system:working-rules")
  expect(row).toMatchObject({ kind: "system", title: "Working rules", text: rulesText, userSystem: true })

  const records = [off("beta", "system:working-rules"), off("gamma", "tool:team_check")]
  await apply(ctx, input(discovered.items, records, ["alpha", "beta", "gamma"]))
  const run = callbacks[0]
  if (run === undefined) throw new Error("missing context hook")
  const events = { alpha: sessionEvent("alpha"), beta: sessionEvent("beta"), gamma: sessionEvent("gamma") }
  await Effect.runPromise(run(events.alpha))
  await Effect.runPromise(run(events.beta))
  await Effect.runPromise(run(events.gamma))
  const partOf = (event: SessionHooks["context"]) =>
    event.system.find((entry) => (entry.metadata as { instruction?: { path?: string } } | undefined)?.instruction?.path === userSystemFile("working-rules"))

  expect(partOf(events.alpha)?.text).toBe("# Working rules\n\n## Honest work\nSay what you checked.\n\n## Teams\nNever claim approval you cannot quote.")
  // Switched off for beta: no part at all.
  expect(partOf(events.beta)).toBeUndefined()
  // gamma has team_check off, so the section that requires it is left out.
  expect(partOf(events.gamma)?.text).toBe("# Working rules\n\n## Honest work\nSay what you checked.")
})

test("the tree offers System rows from the Instructions group and lets the user row be deleted", async () => {
  await tempRoot()
  await createSystemRow("working-rules", "Working rules", rulesText)
  const ctx = context({ agent: agentHarness([agentInfo("alpha", "upstream")]).domain })
  const discovered = await discover({ ctx, records: [], baseTemplates: [], activeBase: () => undefined })
  const nodes = expandedTree({
    agents: discovered.agents,
    items: discovered.items,
    records: [],
    teams: [],
  })
  const row = nodes.find((node) => node.id === "item:defaults::system:working-rules")
  expect(row?.label).toBe("Working rules")
  expect(row?.actions?.remove).toBe(true)
  expect(nodes.find((node) => node.id === "group:defaults::system:instructions")?.add).toBe("system")
})
