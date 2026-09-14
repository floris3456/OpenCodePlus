import { afterEach, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHandlers, createState, deactivate } from "../src/index.js"
import { save } from "../src/instructions/store.js"
import { enable } from "../src/project.js"
import { Plus } from "../src/rpc.js"
import { agentHarness, agentInfo, context, fullContext, skillHarness, skillInfo, toolHarness } from "./harness.js"

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
  const root = await fs.mkdtemp(path.join(parent, "plus-assembled-"))
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

// End-to-end through the real path: handlers run real discovery against the
// shared harness registry, mutate publishes (real apply installs the private
// copy through the transform seam), and assembled reads the host back.
// Skill bodies carry no headings on purpose: headed text derives sections and
// assemble/skillCustomized would treat section output as customized, which
// would mask what these tests pin.
async function setup() {
  const { project } = await tempRoot()
  await enable(project)
  for (const id of ["alpha", "beta"]) {
    const agentPath = path.join(project, ".opencode", "agent", `${id}.md`)
    await fs.mkdir(path.dirname(agentPath), { recursive: true })
    await Bun.write(agentPath, "upstream role")
  }
  const agents = agentHarness([agentInfo("alpha", "upstream role"), agentInfo("beta", "upstream role")])
  const location = fullContext({ directory: project }).location
  const skillState = skillHarness([skillInfo("notes", "upstream body")])
  const tools = toolHarness([])
  const skill = {
    ...skillState.domain,
    list: () => Effect.succeed({ location, data: Array.from(skillState.state.values()) }),
  }
  const ctx = context({
    location,
    agent: agents.domain,
    skill,
    tool: tools.domain,
    mcp: fullContext({ directory: project }).mcp,
  })
  const state = createState()
  const handlers = createHandlers(ctx, state)
  return { handlers, skillState, agents }
}

function customization(item: Plus.SnapshotItem, text: string): Plus.SnapshotCustomizationRecord {
  return {
    type: "customization",
    level: "project",
    agent: "alpha",
    item: item.id,
    section: null,
    text,
    basedOn: item.fingerprint,
    updated: UPDATED,
  }
}

async function snapshotSkill(handlers: Awaited<ReturnType<typeof setup>>["handlers"]) {
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const item = snapshot.items.find((entry) => entry.id === "skill:notes")
  if (!item) throw new Error("expected skill:notes")
  return { snapshot, item }
}

test("reports the registry original when no customization exists", async () => {
  const { handlers } = await setup()
  const assembled = await Effect.runPromise(handlers["instructions.assembled"]({ agent: "alpha" }, throwingContext({})))
  expect(assembled.skills.find((entry) => entry.id === "notes")?.content).toBe("upstream body")
})

test("reports the installed private copy for the owning agent only", async () => {
  const { handlers, skillState } = await setup()
  const { snapshot, item } = await snapshotSkill(handlers)
  const mutated = await Effect.runPromise(
    handlers["instructions.mutate"](
      { expectedRevision: snapshot.revision, expectedGlobalRevision: snapshot.globalRevision, records: [customization(item, "custom body")] },
      throwingContext({}),
    ),
  )
  expect(mutated.ok).toBe(true)
  if (!mutated.ok) throw new Error("expected mutate to succeed")
  expect(skillState.added.map((entry) => String(entry.id))).toEqual(["plus/alpha/notes"])
  const forAlpha = await Effect.runPromise(handlers["instructions.assembled"]({ agent: "alpha" }, throwingContext({})))
  expect(forAlpha.skills.find((entry) => entry.id === "notes")?.content).toBe("custom body")
  const forBeta = await Effect.runPromise(handlers["instructions.assembled"]({ agent: "beta" }, throwingContext({})))
  expect(forBeta.skills.find((entry) => entry.id === "notes")?.content).toBe("upstream body")
})

test("reports the registry original when a customization exists but no copy is installed", async () => {
  const { handlers, skillState } = await setup()
  const { snapshot, item } = await snapshotSkill(handlers)
  const mutated = await Effect.runPromise(
    handlers["instructions.mutate"](
      { expectedRevision: snapshot.revision, expectedGlobalRevision: snapshot.globalRevision, records: [customization(item, "custom body")] },
      throwingContext({}),
    ),
  )
  expect(mutated.ok).toBe(true)
  if (!mutated.ok) throw new Error("expected mutate to succeed")
  // The record persists but the host holds no copy: apply never ran, failed,
  // or was unwound. Assembled must report what the host holds (the original),
  // not the locally resolved projection.
  skillState.state.delete("plus/alpha/notes")
  const forAlpha = await Effect.runPromise(handlers["instructions.assembled"]({ agent: "alpha" }, throwingContext({})))
  expect(forAlpha.skills.find((entry) => entry.id === "notes")?.content).toBe("upstream body")
})

test("discovery excludes installed copies while the readback still observes them", async () => {
  const { handlers, skillState } = await setup()
  const { snapshot, item } = await snapshotSkill(handlers)
  const mutated = await Effect.runPromise(
    handlers["instructions.mutate"](
      { expectedRevision: snapshot.revision, expectedGlobalRevision: snapshot.globalRevision, records: [customization(item, "custom body")] },
      throwingContext({}),
    ),
  )
  expect(mutated.ok).toBe(true)
  if (!mutated.ok) throw new Error("expected mutate to succeed")
  // Discovery filters plus/ copies out of inventory (discover.ts skillItems),
  // but the host registry still holds the installed copy and the assembled
  // readback observes it via skill.list directly.
  expect(skillState.state.get("plus/alpha/notes")?.content).toBe("custom body")
  const fresh = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  expect(fresh.items.some((entry) => entry.id.includes("plus/"))).toBe(false)
  const forAlpha = await Effect.runPromise(handlers["instructions.assembled"]({ agent: "alpha" }, throwingContext({})))
  expect(forAlpha.skills.find((entry) => entry.id === "notes")?.content).toBe("custom body")
})

function offRecord(item: Plus.SnapshotItem): Plus.SnapshotCustomizationRecord {
  return {
    type: "customization",
    level: "project",
    agent: "alpha",
    item: item.id,
    section: null,
    state: "off",
    basedOn: item.fingerprint,
    updated: UPDATED,
  }
}

test("reports a code mode tool as present when a stored off was never applied", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const agentPath = path.join(project, ".opencode", "agent", "alpha.md")
  await fs.mkdir(path.dirname(agentPath), { recursive: true })
  await Bun.write(agentPath, "upstream role")
  const agents = agentHarness([agentInfo("alpha", "upstream role")])
  const location = fullContext({ directory: project }).location
  const skillState = skillHarness([])
  const skill = {
    ...skillState.domain,
    list: () => Effect.succeed({ location, data: Array.from(skillState.state.values()) }),
  }
  // No options means Code Mode by default (codemode defaults true).
  const tools = toolHarness([{ id: "coder", description: "code mode tool" }])
  const ctx = context({
    location,
    agent: agents.domain,
    skill,
    tool: tools.domain,
    mcp: fullContext({ directory: project }).mcp,
  })
  const state = createState()
  const handlers = createHandlers(ctx, state)
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const item = snapshot.items.find((entry) => entry.id === "tool:coder")
  if (!item) throw new Error("expected tool:coder")
  expect(item.codemode).toBe(true)
  const mutated = await Effect.runPromise(
    handlers["instructions.mutate"](
      { expectedRevision: snapshot.revision, expectedGlobalRevision: snapshot.globalRevision, records: [offRecord(item)] },
      throwingContext({}),
    ),
  )
  expect(mutated.ok).toBe(true)
  if (!mutated.ok) throw new Error("expected mutate to succeed")
  // Apply filters Code Mode tool plans out entirely, so the host still holds
  // the tool. Assembled must report host-effective membership (present), not
  // the stored off.
  const forAlpha = await Effect.runPromise(handlers["instructions.assembled"]({ agent: "alpha" }, throwingContext({})))
  expect(forAlpha.tools.map((entry) => entry.id)).toContain("coder")
})

test("reports a natively denied tool as absent once the denial is installed", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const agentPath = path.join(project, ".opencode", "agent", "alpha.md")
  await fs.mkdir(path.dirname(agentPath), { recursive: true })
  await Bun.write(agentPath, "upstream role")
  const agents = agentHarness([agentInfo("alpha", "upstream role")])
  const location = fullContext({ directory: project }).location
  const skillState = skillHarness([])
  const skill = {
    ...skillState.domain,
    list: () => Effect.succeed({ location, data: Array.from(skillState.state.values()) }),
  }
  const tools = toolHarness([{ id: "reader", description: "native tool", options: { codemode: false } }])
  const hooks = { current: 0 }
  const ctx = context({
    location,
    agent: agents.domain,
    skill,
    tool: tools.domain,
    session: {
      hook: () =>
        Effect.sync(() => {
          hooks.current++
          return { dispose: Effect.sync(() => { hooks.current-- }) }
        }),
    },
    mcp: fullContext({ directory: project }).mcp,
  })
  const state = createState()
  const handlers = createHandlers(ctx, state)
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const item = snapshot.items.find((entry) => entry.id === "tool:reader")
  if (!item) throw new Error("expected tool:reader")
  const mutated = await Effect.runPromise(
    handlers["instructions.mutate"](
      { expectedRevision: snapshot.revision, expectedGlobalRevision: snapshot.globalRevision, records: [offRecord(item)] },
      throwingContext({}),
    ),
  )
  expect(mutated.ok).toBe(true)
  if (!mutated.ok) throw new Error("expected mutate to succeed")
  // The native denial installs through the session context hook, which the
  // registry seam cannot observe per agent: apply publishes the installed
  // tool plans to state, and assembled observes that installed plan set.
  expect(hooks.current).toBe(1)
  const forAlpha = await Effect.runPromise(handlers["instructions.assembled"]({ agent: "alpha" }, throwingContext({})))
  expect(forAlpha.tools.map((entry) => entry.id)).not.toContain("reader")
})

test("reports a stored native-tool off that was never published as present", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const agentPath = path.join(project, ".opencode", "agent", "alpha.md")
  await fs.mkdir(path.dirname(agentPath), { recursive: true })
  await Bun.write(agentPath, "upstream role")
  const agents = agentHarness([agentInfo("alpha", "upstream role")])
  const location = fullContext({ directory: project }).location
  const skillState = skillHarness([])
  const skill = {
    ...skillState.domain,
    list: () => Effect.succeed({ location, data: Array.from(skillState.state.values()) }),
  }
  const tools = toolHarness([{ id: "reader", description: "native tool", options: { codemode: false } }])
  const ctx = context({
    location,
    agent: agents.domain,
    skill,
    tool: tools.domain,
    mcp: fullContext({ directory: project }).mcp,
  })
  // Write the stored off record directly to the store without publishing it through handlers
  await save(project, {
    expectedProjectRevision: 0,
    expectedGlobalRevision: 0,
    records: [
      {
        type: "customization",
        level: "project",
        agent: "alpha",
        item: "tool:reader",
        section: null,
        state: "off",
        basedOn: "any",
        updated: UPDATED,
      },
    ],
  })
  const state = createState()
  const handlers = createHandlers(ctx, state)
  const forAlpha = await Effect.runPromise(handlers["instructions.assembled"]({ agent: "alpha" }, throwingContext({})))
  expect(forAlpha.tools.map((entry) => entry.id)).toContain("reader")
})

test("disposal clears the installed set, so after teardown a stale record cannot hide a tool", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const agentPath = path.join(project, ".opencode", "agent", "alpha.md")
  await fs.mkdir(path.dirname(agentPath), { recursive: true })
  await Bun.write(agentPath, "upstream role")
  const agents = agentHarness([agentInfo("alpha", "upstream role")])
  const location = fullContext({ directory: project }).location
  const skillState = skillHarness([])
  const skill = {
    ...skillState.domain,
    list: () => Effect.succeed({ location, data: Array.from(skillState.state.values()) }),
  }
  const tools = toolHarness([{ id: "reader", description: "native tool", options: { codemode: false } }])
  const hooks = { current: 0 }
  const ctx = context({
    location,
    agent: agents.domain,
    skill,
    tool: tools.domain,
    session: {
      hook: () =>
        Effect.sync(() => {
          hooks.current++
          return { dispose: Effect.sync(() => { hooks.current-- }) }
        }),
    },
    mcp: fullContext({ directory: project }).mcp,
  })
  const state = createState()
  const handlers = createHandlers(ctx, state)
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const item = snapshot.items.find((entry) => entry.id === "tool:reader")
  if (!item) throw new Error("expected tool:reader")
  const mutated = await Effect.runPromise(
    handlers["instructions.mutate"](
      { expectedRevision: snapshot.revision, expectedGlobalRevision: snapshot.globalRevision, records: [offRecord(item)] },
      throwingContext({}),
    ),
  )
  expect(mutated.ok).toBe(true)
  expect(hooks.current).toBe(1)
  expect(state.installedTools).toEqual([
    { agent: "alpha", tool: "reader", enabled: false, text: "native tool" },
  ])
  const forAlpha = await Effect.runPromise(handlers["instructions.assembled"]({ agent: "alpha" }, throwingContext({})))
  expect(forAlpha.tools.map((entry) => entry.id)).not.toContain("reader")

  // Teardown / deactivate: disposes applied registrations and clears installed tool plans
  await Effect.runPromise(deactivate(state))
  expect(hooks.current).toBe(0)
  expect(state.installedTools).toEqual([])

  // The record remains stored on disk, but after teardown the host serves the tool
  // and assembled must report it present instead of letting the stale record hide it
  const afterTeardown = await Effect.runPromise(handlers["instructions.assembled"]({ agent: "alpha" }, throwingContext({})))
  expect(afterTeardown.tools.map((entry) => entry.id)).toContain("reader")
})

test("reports a stored-but-unpublished skill off as present", async () => {
  const { handlers, agents } = await setup()
  const { snapshot, item } = await snapshotSkill(handlers)
  const mutated = await Effect.runPromise(
    handlers["instructions.mutate"](
      { expectedRevision: snapshot.revision, expectedGlobalRevision: snapshot.globalRevision, records: [offRecord(item)] },
      throwingContext({}),
    ),
  )
  expect(mutated.ok).toBe(true)
  if (!mutated.ok) throw new Error("expected mutate to succeed")
  // The record persists but no denial was ever installed: unwind apply's
  // agent transform so the host holds the original with no deny rule.
  agents.state.get("alpha")?.permissions.splice(0)
  const forAlpha = await Effect.runPromise(handlers["instructions.assembled"]({ agent: "alpha" }, throwingContext({})))
  expect(forAlpha.skills.map((entry) => entry.id)).toContain("notes")
  expect(forAlpha.skills.find((entry) => entry.id === "notes")?.content).toBe("upstream body")
})

test("reports a stored skill off with an installed denial as absent", async () => {
  const { handlers, agents } = await setup()
  const { snapshot, item } = await snapshotSkill(handlers)
  const mutated = await Effect.runPromise(
    handlers["instructions.mutate"](
      { expectedRevision: snapshot.revision, expectedGlobalRevision: snapshot.globalRevision, records: [offRecord(item)] },
      throwingContext({}),
    ),
  )
  expect(mutated.ok).toBe(true)
  if (!mutated.ok) throw new Error("expected mutate to succeed")
  // Apply installed the deny rule and no copy (a whole-item off installs no
  // copy): the host denies the original with no replacement, so absent.
  expect(agents.state.get("alpha")?.permissions.slice(-1)).toEqual([
    { action: "skill", resource: "notes", effect: "deny" },
  ])
  const forAlpha = await Effect.runPromise(handlers["instructions.assembled"]({ agent: "alpha" }, throwingContext({})))
  expect(forAlpha.skills.map((entry) => entry.id)).not.toContain("notes")
})
