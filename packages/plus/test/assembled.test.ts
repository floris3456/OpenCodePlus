import { afterEach, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHandlers, createState } from "../src/index.js"
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
  return { handlers, skillState }
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
