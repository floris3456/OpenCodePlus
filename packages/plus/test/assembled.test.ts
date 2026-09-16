import { afterEach, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHandlers, createState, deactivate } from "../src/index.js"
import { assembled } from "../src/instructions/assembled.js"
import { fingerprint } from "../src/instructions/model.js"
import { scrubLines } from "../src/instructions/tool-permissions.js"
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

test("reports a code mode tool as absent once its deny is installed", async () => {
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
  // Apply installs a per-id deny rule for the Code Mode tool, so the host no
  // longer serves it to this agent. Assembled reports host-effective
  // membership (absent), not registry presence.
  const forAlpha = await Effect.runPromise(handlers["instructions.assembled"]({ agent: "alpha" }, throwingContext({})))
  expect(forAlpha.tools.map((entry) => entry.id)).not.toContain("coder")
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

async function setupTools(options: {
  agents: string[]
  tools: Parameters<typeof toolHarness>[0]
}) {
  const { project } = await tempRoot()
  await enable(project)
  for (const id of options.agents) {
    const agentPath = path.join(project, ".opencode", "agent", `${id}.md`)
    await fs.mkdir(path.dirname(agentPath), { recursive: true })
    await Bun.write(agentPath, "upstream role")
  }
  const agents = agentHarness(options.agents.map((id) => agentInfo(id, "upstream role")))
  const location = fullContext({ directory: project }).location
  const skillState = skillHarness([])
  const skill = {
    ...skillState.domain,
    list: () => Effect.succeed({ location, data: Array.from(skillState.state.values()) }),
  }
  const tools = toolHarness(options.tools)
  const ctx = context({
    location,
    agent: agents.domain,
    skill,
    tool: tools.domain,
    session: {
      hook: () => Effect.succeed({ dispose: Effect.void }),
    },
    mcp: fullContext({ directory: project }).mcp,
  })
  const state = createState()
  const handlers = createHandlers(ctx, state)
  return { project, handlers, agents, state }
}

function toolOff(item: Plus.SnapshotItem, overrides?: Partial<Plus.SnapshotCustomizationRecord>): Plus.SnapshotCustomizationRecord {
  return {
    type: "customization",
    level: "project",
    agent: "alpha",
    item: item.id,
    section: null,
    state: "off",
    basedOn: item.fingerprint,
    updated: UPDATED,
    ...overrides,
  }
}

test("a Code Mode off installs a deny for one agent while the other keeps the tool", async () => {
  const { handlers, agents } = await setupTools({ agents: ["alpha", "beta"], tools: [{ id: "coder", description: "code mode tool" }] })
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const item = snapshot.items.find((entry) => entry.id === "tool:coder")
  if (!item) throw new Error("expected tool:coder")
  const mutated = await Effect.runPromise(
    handlers["instructions.mutate"](
      { expectedRevision: snapshot.revision, expectedGlobalRevision: snapshot.globalRevision, records: [toolOff(item)] },
      throwingContext({}),
    ),
  )
  expect(mutated.ok).toBe(true)
  if (!mutated.ok) throw new Error("expected mutate to succeed")
  expect(agents.state.get("alpha")?.permissions.slice(-1)).toEqual([{ action: "coder", resource: "*", effect: "deny" }])
  expect(agents.state.get("beta")?.permissions.some((rule) => rule.action === "coder")).toBe(false)
  const forAlpha = await Effect.runPromise(handlers["instructions.assembled"]({ agent: "alpha" }, throwingContext({})))
  expect(forAlpha.tools.map((entry) => entry.id)).not.toContain("coder")
  const forBeta = await Effect.runPromise(handlers["instructions.assembled"]({ agent: "beta" }, throwingContext({})))
  expect(forBeta.tools.map((entry) => entry.id)).toContain("coder")
  expect(forBeta.tools.find((entry) => entry.id === "coder")?.codemode).toBe(true)
})

test("a Defaults-level Code Mode off cascades to inheriting agents", async () => {
  const { handlers, agents } = await setupTools({ agents: ["alpha", "beta"], tools: [{ id: "coder", description: "code mode tool" }] })
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const item = snapshot.items.find((entry) => entry.id === "tool:coder")
  if (!item) throw new Error("expected tool:coder")
  const shared: Plus.SnapshotCustomizationRecord = {
    type: "customization",
    level: "defaults",
    agent: null,
    item: item.id,
    section: null,
    state: "off",
    basedOn: item.fingerprint,
    updated: UPDATED,
  }
  const mutated = await Effect.runPromise(
    handlers["instructions.mutate"](
      { expectedRevision: snapshot.revision, expectedGlobalRevision: snapshot.globalRevision, records: [shared] },
      throwingContext({}),
    ),
  )
  expect(mutated.ok).toBe(true)
  if (!mutated.ok) throw new Error("expected mutate to succeed")
  expect(agents.state.get("alpha")?.permissions.slice(-1)).toEqual([{ action: "coder", resource: "*", effect: "deny" }])
  expect(agents.state.get("beta")?.permissions.slice(-1)).toEqual([{ action: "coder", resource: "*", effect: "deny" }])
  const forAlpha = await Effect.runPromise(handlers["instructions.assembled"]({ agent: "alpha" }, throwingContext({})))
  expect(forAlpha.tools.map((entry) => entry.id)).not.toContain("coder")
  const forBeta = await Effect.runPromise(handlers["instructions.assembled"]({ agent: "beta" }, throwingContext({})))
  expect(forBeta.tools.map((entry) => entry.id)).not.toContain("coder")
})

test("the execute entry is present unless denied", async () => {
  const { handlers } = await setupTools({ agents: ["alpha", "beta"], tools: [{ id: "coder", description: "code mode tool" }] })
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const execute = snapshot.items.find((entry) => entry.id === "tool:execute")
  if (!execute) throw new Error("expected tool:execute")
  const before = await Effect.runPromise(handlers["instructions.assembled"]({ agent: "alpha" }, throwingContext({})))
  expect(before.tools.map((entry) => entry.id)).toContain("execute")
  const mutated = await Effect.runPromise(
    handlers["instructions.mutate"](
      { expectedRevision: snapshot.revision, expectedGlobalRevision: snapshot.globalRevision, records: [toolOff(execute)] },
      throwingContext({}),
    ),
  )
  expect(mutated.ok).toBe(true)
  if (!mutated.ok) throw new Error("expected mutate to succeed")
  const forAlpha = await Effect.runPromise(handlers["instructions.assembled"]({ agent: "alpha" }, throwingContext({})))
  expect(forAlpha.tools.map((entry) => entry.id)).not.toContain("execute")
  const forBeta = await Effect.runPromise(handlers["instructions.assembled"]({ agent: "beta" }, throwingContext({})))
  expect(forBeta.tools.map((entry) => entry.id)).toContain("execute")
})

test("a Code Mode text and pin reports the installed catalog plan for the owning agent only", async () => {
  const { handlers } = await setupTools({ agents: ["alpha", "beta"], tools: [{ id: "coder", description: "code mode tool" }] })
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const item = snapshot.items.find((entry) => entry.id === "tool:coder")
  if (!item) throw new Error("expected tool:coder")
  const edit: Plus.SnapshotCustomizationRecord = {
    type: "customization",
    level: "project",
    agent: "alpha",
    item: item.id,
    section: null,
    text: "custom coder",
    pin: true,
    basedOn: item.fingerprint,
    updated: UPDATED,
  }
  const mutated = await Effect.runPromise(
    handlers["instructions.mutate"](
      { expectedRevision: snapshot.revision, expectedGlobalRevision: snapshot.globalRevision, records: [edit] },
      throwingContext({}),
    ),
  )
  expect(mutated.ok).toBe(true)
  if (!mutated.ok) throw new Error("expected mutate to succeed")
  const forAlpha = await Effect.runPromise(handlers["instructions.assembled"]({ agent: "alpha" }, throwingContext({})))
  const alphaCoder = forAlpha.tools.find((entry) => entry.id === "coder")
  if (!alphaCoder) throw new Error("expected coder for alpha")
  expect(alphaCoder.description).toBe("custom coder")
  expect(alphaCoder.codemode).toBe(true)
  expect(alphaCoder.pinned).toBe(true)
  const forBeta = await Effect.runPromise(handlers["instructions.assembled"]({ agent: "beta" }, throwingContext({})))
  const betaCoder = forBeta.tools.find((entry) => entry.id === "coder")
  if (!betaCoder) throw new Error("expected coder for beta")
  expect(betaCoder.description).toBe("code mode tool")
  expect(betaCoder.codemode).toBe(true)
  expect(betaCoder.pinned).toBe(false)
  // Optional keys are never undefined: native rows omit them entirely.
  const native = forAlpha.tools.find((entry) => entry.id === "execute")
  if (native !== undefined) {
    expect("codemode" in native).toBe(false)
    expect("pinned" in native).toBe(false)
  }
})

test("a stored-but-unpublished Code Mode off stays present", async () => {
  const { project, handlers } = await setupTools({ agents: ["alpha"], tools: [{ id: "coder", description: "code mode tool" }] })
  await save(project, {
    expectedProjectRevision: 0,
    expectedGlobalRevision: 0,
    records: [
      {
        type: "customization",
        level: "project",
        agent: "alpha",
        item: "tool:coder",
        section: null,
        state: "off",
        basedOn: "any",
        updated: UPDATED,
      },
    ],
  })
  const forAlpha = await Effect.runPromise(handlers["instructions.assembled"]({ agent: "alpha" }, throwingContext({})))
  expect(forAlpha.tools.map((entry) => entry.id)).toContain("coder")
})

test("a permission-group deny excludes the Code Mode tool sharing that group", async () => {
  const { handlers, agents } = await setupTools({
    agents: ["alpha", "beta"],
    tools: [{ id: "coder", description: "code mode tool", options: { permission: "shared-group" } }],
  })
  await Effect.runPromise(
    Effect.scoped(
      agents.domain.transform((editor) => {
        editor.update("alpha", (agent) => {
          agent.permissions.push({ action: "shared-group", resource: "*", effect: "deny" })
        })
      }),
    ),
  )
  const forAlpha = await Effect.runPromise(handlers["instructions.assembled"]({ agent: "alpha" }, throwingContext({})))
  expect(forAlpha.tools.map((entry) => entry.id)).not.toContain("coder")
  const forBeta = await Effect.runPromise(handlers["instructions.assembled"]({ agent: "beta" }, throwingContext({})))
  expect(forBeta.tools.map((entry) => entry.id)).toContain("coder")
})

test("a pin-only record reaches assembled as pinned for that agent", async () => {
  const { handlers, state } = await setupTools({ agents: ["alpha", "beta"], tools: [{ id: "coder", description: "code mode tool" }] })
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const item = snapshot.items.find((entry) => entry.id === "tool:coder")
  if (!item) throw new Error("expected tool:coder")
  const pin: Plus.SnapshotCustomizationRecord = {
    type: "customization",
    level: "project",
    agent: "alpha",
    item: item.id,
    section: null,
    pin: true,
    basedOn: item.fingerprint,
    updated: UPDATED,
  }
  const mutated = await Effect.runPromise(
    handlers["instructions.mutate"](
      { expectedRevision: snapshot.revision, expectedGlobalRevision: snapshot.globalRevision, records: [pin] },
      throwingContext({}),
    ),
  )
  expect(mutated.ok).toBe(true)
  if (!mutated.ok) throw new Error("expected mutate to succeed")
  // The pin-only record installs a catalog plan even though text and
  // enablement are untouched.
  expect(state.installedTools).toEqual([
    { agent: "alpha", tool: "coder", enabled: true, text: "code mode tool", codemode: true, catalogPath: "coder", pinned: true },
  ])
  const forAlpha = await Effect.runPromise(handlers["instructions.assembled"]({ agent: "alpha" }, throwingContext({})))
  const alphaCoder = forAlpha.tools.find((entry) => entry.id === "coder")
  if (!alphaCoder) throw new Error("expected coder for alpha")
  expect(alphaCoder.description).toBe("code mode tool")
  expect(alphaCoder.codemode).toBe(true)
  expect(alphaCoder.pinned).toBe(true)
  const forBeta = await Effect.runPromise(handlers["instructions.assembled"]({ agent: "beta" }, throwingContext({})))
  const betaCoder = forBeta.tools.find((entry) => entry.id === "coder")
  if (!betaCoder) throw new Error("expected coder for beta")
  expect(betaCoder.description).toBe("code mode tool")
  expect(betaCoder.pinned).toBe(false)
})

test("a group deny plus a later id allow still reads as absent in both orders", async () => {
  const { handlers, agents } = await setupTools({
    agents: ["alpha", "beta"],
    tools: [{ id: "coder", description: "code mode tool", options: { permission: "shared-group" } }],
  })
  await Effect.runPromise(
    Effect.scoped(
      agents.domain.transform((editor) => {
        editor.update("alpha", (agent) => {
          agent.permissions.push({ action: "shared-group", resource: "*", effect: "deny" })
          agent.permissions.push({ action: "coder", resource: "*", effect: "allow" })
        })
        editor.update("beta", (agent) => {
          agent.permissions.push({ action: "coder", resource: "*", effect: "deny" })
          agent.permissions.push({ action: "shared-group", resource: "*", effect: "allow" })
        })
      }),
    ),
  )
  // Core evaluates group and id as two independent last-match checks and ORs
  // them, so a deny on either side survives a later allow on the other.
  const forAlpha = await Effect.runPromise(handlers["instructions.assembled"]({ agent: "alpha" }, throwingContext({})))
  expect(forAlpha.tools.map((entry) => entry.id)).not.toContain("coder")
  const forBeta = await Effect.runPromise(handlers["instructions.assembled"]({ agent: "beta" }, throwingContext({})))
  expect(forBeta.tools.map((entry) => entry.id)).not.toContain("coder")
})

test("denying execute hides other Code Mode tools too", async () => {
  const { handlers } = await setupTools({ agents: ["alpha", "beta"], tools: [{ id: "coder", description: "code mode tool" }] })
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const execute = snapshot.items.find((entry) => entry.id === "tool:execute")
  if (!execute) throw new Error("expected tool:execute")
  const before = await Effect.runPromise(handlers["instructions.assembled"]({ agent: "alpha" }, throwingContext({})))
  expect(before.tools.map((entry) => entry.id)).toContain("execute")
  expect(before.tools.map((entry) => entry.id)).toContain("coder")
  const mutated = await Effect.runPromise(
    handlers["instructions.mutate"](
      { expectedRevision: snapshot.revision, expectedGlobalRevision: snapshot.globalRevision, records: [toolOff(execute)] },
      throwingContext({}),
    ),
  )
  expect(mutated.ok).toBe(true)
  if (!mutated.ok) throw new Error("expected mutate to succeed")
  // Core builds neither the Code Mode executor nor the catalog once execute
  // is denied, so none of that agent's Code Mode tools are reachable.
  const forAlpha = await Effect.runPromise(handlers["instructions.assembled"]({ agent: "alpha" }, throwingContext({})))
  expect(forAlpha.tools.map((entry) => entry.id)).not.toContain("execute")
  expect(forAlpha.tools.map((entry) => entry.id)).not.toContain("coder")
  const forBeta = await Effect.runPromise(handlers["instructions.assembled"]({ agent: "beta" }, throwingContext({})))
  expect(forBeta.tools.map((entry) => entry.id)).toContain("execute")
  expect(forBeta.tools.map((entry) => entry.id)).toContain("coder")
})

test("a stored-but-unpublished pin reports the registry default", async () => {
  const { project, handlers } = await setupTools({ agents: ["alpha"], tools: [{ id: "coder", description: "code mode tool" }] })
  await save(project, {
    expectedProjectRevision: 0,
    expectedGlobalRevision: 0,
    records: [
      {
        type: "customization",
        level: "project",
        agent: "alpha",
        item: "tool:coder",
        section: null,
        pin: true,
        basedOn: "any",
        updated: UPDATED,
      },
    ],
  })
  // The pin was saved but never published, so the host still serves the
  // registry default and assembled must report it.
  const forAlpha = await Effect.runPromise(handlers["instructions.assembled"]({ agent: "alpha" }, throwingContext({})))
  const coder = forAlpha.tools.find((entry) => entry.id === "coder")
  if (!coder) throw new Error("expected coder for alpha")
  expect(coder.pinned).toBe(false)
})

test("disposal clears the installed pin, so a stale pin record falls back to default", async () => {
  const { handlers, state } = await setupTools({ agents: ["alpha"], tools: [{ id: "coder", description: "code mode tool" }] })
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const item = snapshot.items.find((entry) => entry.id === "tool:coder")
  if (!item) throw new Error("expected tool:coder")
  const pin: Plus.SnapshotCustomizationRecord = {
    type: "customization",
    level: "project",
    agent: "alpha",
    item: item.id,
    section: null,
    pin: true,
    basedOn: item.fingerprint,
    updated: UPDATED,
  }
  const mutated = await Effect.runPromise(
    handlers["instructions.mutate"](
      { expectedRevision: snapshot.revision, expectedGlobalRevision: snapshot.globalRevision, records: [pin] },
      throwingContext({}),
    ),
  )
  expect(mutated.ok).toBe(true)
  if (!mutated.ok) throw new Error("expected mutate to succeed")
  expect(state.installedTools).toEqual([
    { agent: "alpha", tool: "coder", enabled: true, text: "code mode tool", codemode: true, catalogPath: "coder", pinned: true },
  ])
  const forAlpha = await Effect.runPromise(handlers["instructions.assembled"]({ agent: "alpha" }, throwingContext({})))
  expect(forAlpha.tools.find((entry) => entry.id === "coder")?.pinned).toBe(true)
  await Effect.runPromise(deactivate(state))
  expect(state.installedTools).toEqual([])
  // The record remains stored on disk, but after teardown the host serves the
  // registry default and assembled must report it.
  const afterTeardown = await Effect.runPromise(handlers["instructions.assembled"]({ agent: "alpha" }, throwingContext({})))
  const coder = afterTeardown.tools.find((entry) => entry.id === "coder")
  if (!coder) throw new Error("expected coder after teardown")
  expect(coder.pinned).toBe(false)
})

test("an all-matching scrub preserves the original in assembled, matching the live request", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const agents = agentHarness([agentInfo("alpha", "git push")])
  const location = fullContext({ directory: project }).location
  const skillState = skillHarness([])
  const skill = {
    ...skillState.domain,
    list: () => Effect.succeed({ location, data: Array.from(skillState.state.values()) }),
  }
  const tools = toolHarness([{ id: "shell", description: "git push", options: { codemode: false } }])
  const ctx = context({ location, agent: agents.domain, skill, tool: tools.domain, mcp: fullContext({ directory: project }).mcp })
  const permText = "Git push\ngit push *"
  const items = [
    {
      id: "tool:shell",
      kind: "tool" as const,
      group: "native" as const,
      title: "shell",
      text: "shell tool",
      enabled: true,
      fingerprint: fingerprint("shell tool"),
    },
    {
      id: "perm:shell:git-push",
      kind: "perm" as const,
      group: "none" as const,
      title: "Git push",
      text: permText,
      enabled: true,
      fingerprint: fingerprint(permText),
      permTool: "shell",
      ruleId: "git-push",
      patterns: ["git push *"],
      keywords: ["git push"],
      provenance: [] as string[],
    },
  ]
  const records = [
    {
      type: "customization" as const,
      level: "project" as const,
      agent: "alpha",
      item: "perm:shell:git-push",
      section: null,
      state: "off" as const,
      basedOn: fingerprint(permText),
      updated: UPDATED,
    },
  ]
  const result = await assembled({
    ctx,
    agent: "alpha",
    items,
    agents: [{ id: "alpha", level: "project" as const }],
    records,
    splits: [],
    scopes: { global: new Set<string>(), defaults: new Set<string>() },
  })
  if ("ok" in result) throw new Error("expected assembled result")
  // The raw scrub empties the text; the live request keeps the original
  // (apply.ts preservation), so the readback must agree.
  expect(scrubLines("git push", ["git push"]).text).toBe("")
  expect(result.system).toEqual(["git push"])
  expect(result.tools.find((entry) => entry.id === "shell")?.description).toBe("git push")
})
