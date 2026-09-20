import { afterEach, expect, test } from "bun:test"
import type { Rpc } from "@opencode/schema/rpc"
import { Schema } from "effect"
import { Effect, Exit } from "effect"
import fsSync from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { applySessionModel, createHandlers, createState, type PlusState } from "../src/index.js"
import { itemOf, recordOf } from "../src/instructions/snapshot.js"
import { fingerprint, resolve, scopesOf, type CustomizationRecord, type SplitRecord } from "../src/instructions/model.js"
import { globalRecordsPath } from "../src/instructions/paths.js"
import { load } from "../src/instructions/store.js"
import { expandedTree } from "../src/instructions/tree.js"
import { enable } from "../src/project.js"
import { Plus } from "../src/rpc.js"
import { agentHarness, agentInfo, catalogHarness, context, defaultHostTemplates, fullContext, mcpHarness, modelInfo, modelRef, promptHarness, skillHarness, skillInfo, toolHarness } from "./harness.js"

test("definition id, methods, and events contract", () => {
  expect(Plus.Definition.id).toBe("opencode.plus")
  expect("project.status" in Plus.Definition.methods).toBe(true)
  expect("project.enable" in Plus.Definition.methods).toBe(true)
  expect("project.disable" in Plus.Definition.methods).toBe(true)
  expect("project.changed" in Plus.Definition.events).toBe(true)
})

test("instructions and agent methods and the instructions.changed event are present", () => {
  expect("instructions.snapshot" in Plus.Definition.methods).toBe(true)
  expect("instructions.mutate" in Plus.Definition.methods).toBe(true)
  expect("instructions.refresh" in Plus.Definition.methods).toBe(true)
  expect("instructions.assembled" in Plus.Definition.methods).toBe(true)
  expect("agent.create" in Plus.Definition.methods).toBe(true)
  expect("agent.rename" in Plus.Definition.methods).toBe(true)
  expect("agent.delete" in Plus.Definition.methods).toBe(true)
  expect("skill.create" in Plus.Definition.methods).toBe(true)
  expect("skill.import" in Plus.Definition.methods).toBe(true)
  expect("skill.delete" in Plus.Definition.methods).toBe(true)
  expect("base.create" in Plus.Definition.methods).toBe(true)
  expect("base.delete" in Plus.Definition.methods).toBe(true)
  expect("instruction.create" in Plus.Definition.methods).toBe(true)
  expect("instruction.delete" in Plus.Definition.methods).toBe(true)
  expect("mcp.add" in Plus.Definition.methods).toBe(true)
  expect("mcp.remove" in Plus.Definition.methods).toBe(true)
  expect("team.create" in Plus.Definition.methods).toBe(true)
  expect("team.setEnabled" in Plus.Definition.methods).toBe(true)
  expect("instructions.changed" in Plus.Definition.events).toBe(true)
})

// Compile-time guard: the TUI promise client only accepts PortableDefinition,
// so this assignment fails typecheck if any schema below is left unwrapped.
const portable: Rpc.PortableDefinition = Plus.Definition

test("definition satisfies the portable client contract", () => {
  expect(portable.id).toBe("opencode.plus")
})

test("every method input, output, declared error, and event schema is portable", () => {
  for (const [name, method] of Object.entries(Plus.Definition.methods)) {
    expect("~standard" in method.input, `${name} input`).toBe(true)
    expect("~standard" in method.output, `${name} output`).toBe(true)
    if ("errors" in method) {
      for (const [error, schema] of Object.entries(method.errors)) {
        expect("~standard" in schema, `${name} error ${error}`).toBe(true)
      }
    }
  }
  for (const [name, event] of Object.entries(Plus.Definition.events)) {
    expect("~standard" in event.schema, `${name} event`).toBe(true)
  }
})

const UPDATED = "2026-01-01T00:00:00.000Z"

const roots: string[] = []
const priorConfigDir = process.env.OPENCODE_CONFIG_DIR

afterEach(async () => {
  if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function tempRoot(): Promise<{ project: string; config: string }> {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-rpc-"))
  roots.push(root)
  const config = path.join(root, "config")
  process.env.OPENCODE_CONFIG_DIR = config
  return { project: path.join(root, "project"), config }
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

// The production host returns a DeclaredError from context.error, which the
// handler fails with; the test double throws instead, so the side channel is
// the proof of which declared error the handler selected.
async function expectDeclaredError(
  effect: Effect.Effect<unknown, unknown>,
  captured: { current?: CapturedError },
  type: string,
): Promise<void> {
  const exit = await Effect.runPromiseExit(effect)
  expect(Exit.isFailure(exit)).toBe(true)
  expect(captured.current?.type).toBe(type)
}

function captureEmits(state: PlusState): Array<{ name: string; data: unknown }> {
  const emitted: Array<{ name: string; data: unknown }> = []
  state.registration = {
    dispose: Effect.void,
    events: {
      emit: (...args: Rpc.EventInput<typeof Plus.Definition>) =>
        Effect.sync(() => {
          emitted.push({ name: args[0], data: args[1] })
        }).pipe(Effect.asVoid),
    },
  }
  return emitted
}

// Core serves RPC results as JSON through HttpApi, whose success schema is
// the canonical JSON codec of RpcOutput. Unknown encodes to Json on that
// path, so a present-but-undefined key fails with "Expected JSON value".
const RpcBody = Schema.toCodecJson(Schema.Struct({ output: Schema.optionalKey(Schema.Unknown) }))

function expectRpcBody(value: unknown) {
  expect(() => Schema.encodeUnknownSync(RpcBody)({ output: value })).not.toThrow()
}

function record(item: string, overrides?: Partial<Plus.SnapshotCustomizationRecord>): Plus.SnapshotCustomizationRecord {
  return {
    type: "customization",
    level: "project",
    agent: "alpha",
    item,
    section: null,
    basedOn: fingerprint("upstream"),
    updated: UPDATED,
    ...overrides,
  }
}

function show(snapshot: Plus.Snapshot, input: { id: string; view?: "resolved" }): { text: string } {
  const nodes = expandedTree({
    items: snapshot.items.map(itemOf),
    records: snapshot.records.map(recordOf),
    agents: snapshot.agents,
  })
  const row = nodes.find((node) => node.id === input.id || node.address?.item === input.id)
  if (row?.address === undefined) throw new Error(`missing row address for ${input.id}`)
  const item = snapshot.items.find((candidate) => candidate.id === row.address?.item)
  if (item === undefined) throw new Error(`missing item for ${input.id}`)
  const customizations = snapshot.records
    .filter((r): r is Plus.SnapshotCustomizationRecord => r.type === "customization")
    .map((r) => recordOf(r) as CustomizationRecord)
  const splits = snapshot.records
    .filter((r): r is Plus.SnapshotSplitRecord => r.type === "split")
    .map((r) => recordOf(r) as SplitRecord)
  const scopes = scopesOf(snapshot.agents)
  const resolved = resolve({ upstream: item, records: customizations, splits, scopes, address: row.address })
  return { text: resolved.text }
}

function readProjectMcp(project: string): [string, { type: "remote"; url: string; disabled?: boolean }][] {
  const target = path.join(project, ".opencode", "opencode.json")
  if (!fsSync.existsSync(target)) return []
  const text = fsSync.readFileSync(target, "utf8")
  if (text.trim().length === 0) return []
  const doc = JSON.parse(text)
  const servers = doc?.mcp?.servers ?? {}
  return Object.entries(servers) as [string, { type: "remote"; url: string; disabled?: boolean }][]
}

test("gated methods fail with project.disabled when project mode is off", async () => {
  const { project } = await tempRoot()
  const handlers = createHandlers(fullContext({ directory: project }), createState())
  const captured: { current?: CapturedError } = {}
  await expectDeclaredError(handlers["instructions.snapshot"](undefined, throwingContext(captured)), captured, "project.disabled")
  await expectDeclaredError(handlers["instructions.refresh"](undefined, throwingContext(captured)), captured, "project.disabled")
  await expectDeclaredError(
    handlers["instructions.mutate"]({ expectedRevision: 0, expectedGlobalRevision: 0, records: [] }, throwingContext(captured)),
    captured,
    "project.disabled",
  )
  await expectDeclaredError(handlers["instructions.assembled"]({ agent: "alpha" }, throwingContext(captured)), captured, "project.disabled")
  await expectDeclaredError(handlers["agent.create"]({ scope: "project", id: "alpha", prompt: "hi" }, throwingContext(captured)), captured, "project.disabled")
  await expectDeclaredError(handlers["agent.rename"]({ scope: "project", from: "a", to: "b" }, throwingContext(captured)), captured, "project.disabled")
  await expectDeclaredError(handlers["agent.delete"]({ scope: "project", id: "a" }, throwingContext(captured)), captured, "project.disabled")
  await expectDeclaredError(handlers["skill.create"]({ name: "x", body: "y" }, throwingContext(captured)), captured, "project.disabled")
  await expectDeclaredError(handlers["skill.import"]({ path: "/tmp/x.md" }, throwingContext(captured)), captured, "project.disabled")
  await expectDeclaredError(handlers["skill.delete"]({ id: "x" }, throwingContext(captured)), captured, "project.disabled")
  await expectDeclaredError(handlers["base.create"]({ id: "x", title: "X", text: "y" }, throwingContext(captured)), captured, "project.disabled")
  await expectDeclaredError(handlers["base.delete"]({ id: "x" }, throwingContext(captured)), captured, "project.disabled")
  await expectDeclaredError(handlers["instruction.create"]({ name: "x", text: "y" }, throwingContext(captured)), captured, "project.disabled")
  await expectDeclaredError(handlers["instruction.delete"]({ name: "x" }, throwingContext(captured)), captured, "project.disabled")
  await expectDeclaredError(handlers["mcp.add"]({ name: "x", config: { type: "remote", url: "https://x.test" } }, throwingContext(captured)), captured, "project.disabled")
  await expectDeclaredError(handlers["mcp.remove"]({ name: "x" }, throwingContext(captured)), captured, "project.disabled")
  await expectDeclaredError(handlers["team.create"]({ level: "project", team: "x" }, throwingContext(captured)), captured, "project.disabled")
  await expectDeclaredError(handlers["team.setEnabled"]({ level: "project", team: "x", enabled: true }, throwingContext(captured)), captured, "project.disabled")
  const status = await Effect.runPromise(handlers["project.status"](undefined, throwingContext(captured)))
  expect(status).toEqual({ enabled: false, directory: project })
})

test("snapshot shape carries both revisions, agents, items, records, servers, and protectedAgents", async () => {
  const { project } = await tempRoot()
  await enable(project)
  // Empty built-in registry: this test pins the disk-only snapshot shape, not
  // the shipped roster (covered by the dedicated well-formedness test).
  const handlers = createHandlers(fullContext({ directory: project, agents: [agentInfo("alpha", "upstream")] }), createState(), {
    builtins: [],
  })
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  expect(snapshot.revision).toBe(0)
  expect(snapshot.globalRevision).toBe(0)
  expect(snapshot.agents.map((agent) => agent.id)).toContain("alpha")
  expect(snapshot.items.length).toBeGreaterThan(0)
  expect(snapshot.records).toEqual([])
  expect(snapshot.teams).toEqual([])
  expect(snapshot.servers).toEqual([])
  expect(snapshot.protectedAgents).toEqual([])
  expectRpcBody(snapshot)
})

test("snapshot carries userBase and codemode flags on the right items", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const coder = { id: "coder", description: "code mode tool" }
  const ctx = fullContext({ directory: project, tools: [coder, { id: "reader", description: "native tool", options: { codemode: false } }] })
  const state = createState()
  const handlers = createHandlers(ctx, state)
  await Effect.runPromise(handlers["base.create"]({ id: "custom", title: "Custom.txt", text: "custom base" }, throwingContext({})))
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const custom = snapshot.items.find((item) => item.id === "base:custom")
  expect(custom?.userBase).toBe(true)
  const coderItem = snapshot.items.find((item) => item.id === "tool:coder")
  expect(coderItem?.codemode).toBe(true)
  const reader = snapshot.items.find((item) => item.id === "tool:reader")
  expect(reader?.codemode).toBeUndefined()
  const builtin = snapshot.items.find((item) => item.kind === "base" && item.userBase !== true)
  expect(builtin).toBeDefined()
  expect(builtin?.userBase).toBeUndefined()
  expectRpcBody(snapshot)
})

test("snapshot carries code mode namespace, pinned, execute, and pin across the boundary", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const ctx = fullContext({
    directory: project,
    tools: [{ id: "coder", description: "code mode tool", options: { namespace: "ns", pinned: true } }],
  })
  const handlers = createHandlers(ctx, createState())
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  // Discovery → toSnapshot keeps the Code Mode tool fields.
  const coder = snapshot.items.find((item) => item.namespace === "ns")
  if (!coder) throw new Error("expected namespaced coder tool")
  expect(coder.pinned).toBe(true)
  expect(coder.codemode).toBe(true)
  expectRpcBody(snapshot)
  // The client-side model conversion keeps them too (no silent drop).
  const converted = itemOf(coder)
  expect(converted.namespace).toBe("ns")
  expect(converted.pinned).toBe(true)
  expect(converted.codemode).toBe(true)
  // The synthetic host-owned execute row survives the same path.
  const execute = snapshot.items.find((item) => item.id === "tool:execute")
  if (!execute) throw new Error("expected tool:execute")
  expect(execute.execute).toBe(true)
  expect(itemOf(execute).execute).toBe(true)
  // A stored pin record survives mutate → snapshot → recordOf.
  const mutated = await Effect.runPromise(
    handlers["instructions.mutate"]({
      expectedRevision: snapshot.revision,
      expectedGlobalRevision: snapshot.globalRevision,
      records: [record(coder.id, { pin: true, basedOn: coder.fingerprint })],
    }, throwingContext({})),
  )
  expect(mutated.ok).toBe(true)
  if (!mutated.ok) throw new Error("expected mutate to succeed")
  expectRpcBody(mutated)
  const stored = mutated.snapshot.records.find((entry) => entry.type === "customization" && entry.item === coder.id)
  if (stored?.type !== "customization") throw new Error("expected customization record")
  expect(stored.pin).toBe(true)
  const back = recordOf(stored)
  if (back.type !== "customization") throw new Error("expected customization record")
  expect(back.pin).toBe(true)
})

test("mutate routes project records to the project store and global/defaults records to the global store", async () => {
  const { project, config } = await tempRoot()
  await enable(project)
  const handlers = createHandlers(fullContext({ directory: project }), createState())
  const records: Plus.SnapshotRecord[] = [
    record("tool:reader", { agent: "alpha", level: "project", text: "project text" }),
    record("tool:reader", { agent: "beta", level: "global", text: "global text" }),
    record("tool:reader", { agent: null, level: "defaults", text: "shared text" }),
  ]
  const result = await Effect.runPromise(
    handlers["instructions.mutate"]({ expectedRevision: 0, expectedGlobalRevision: 0, records }, throwingContext({})),
  )
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error("expected mutate to succeed")
  expectRpcBody(result)
  const { load } = await import("../src/instructions/store.js")
  const stored = await load(project)
  expect(stored.records.filter((entry) => entry.level === "project")).toHaveLength(1)
  expect(stored.records.filter((entry) => entry.level !== "project")).toHaveLength(2)
  const { projectRecordsPath, globalRecordsPath } = await import("../src/instructions/paths.js")
  const projectText = await Bun.file(projectRecordsPath(project)).text()
  expect(projectText).toContain(`"level":"project"`)
  expect(projectText).not.toContain(`"level":"global"`)
  const globalText = await Bun.file(globalRecordsPath(config)).text()
  expect(globalText).toContain(`"level":"global"`)
  expect(globalText).toContain(`"level":"defaults"`)
})

test("mutate stale on either revision returns the fresh snapshot without writing", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const handlers = createHandlers(fullContext({ directory: project }), createState())
  const seeded = await Effect.runPromise(
    handlers["instructions.mutate"]({ expectedRevision: 0, expectedGlobalRevision: 0, records: [record("tool:a", { text: "first" }), record("tool:b", { level: "global", agent: "beta", text: "g" })] }, throwingContext({})),
  )
  expect(seeded.ok).toBe(true)
  if (!seeded.ok) throw new Error("expected seed to succeed")
  const staleProject = await Effect.runPromise(
    handlers["instructions.mutate"]({ expectedRevision: 0, expectedGlobalRevision: seeded.globalRevision, records: [record("tool:a", { text: "second" })] }, throwingContext({})),
  )
  expect(staleProject.ok).toBe(false)
  if (staleProject.ok) throw new Error("expected stale conflict")
  expect(staleProject.reason).toBe("stale")
  expect(staleProject.store).toBe("project")
  expectRpcBody(staleProject)
  const staleGlobal = await Effect.runPromise(
    handlers["instructions.mutate"]({ expectedRevision: seeded.revision, expectedGlobalRevision: 0, records: [record("tool:a", { text: "second" })] }, throwingContext({})),
  )
  expect(staleGlobal.ok).toBe(false)
  if (staleGlobal.ok) throw new Error("expected stale conflict")
  expect(staleGlobal.store).toBe("global")
  expectRpcBody(staleGlobal)
})

test("successful mutate persists, republishes, and emits instructions.changed with both revisions", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const state = createState()
  const emitted = captureEmits(state)
  const handlers = createHandlers(fullContext({ directory: project }), state)
  const result = await Effect.runPromise(
    handlers["instructions.mutate"]({ expectedRevision: 0, expectedGlobalRevision: 0, records: [record("tool:a", { text: "first" })] }, throwingContext({})),
  )
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error("expected mutate to succeed")
  expect(emitted).toEqual([{ name: "instructions.changed", data: { revision: result.revision, globalRevision: result.globalRevision } }])
  expectRpcBody(result)
})

test("instructions.assembled reads the host after application and reflects an excluded section's absence", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const text = "# One\n\na\n\n# Two\n\nb\n"
  const alphaPath = path.join(project, ".opencode", "agent", "alpha.md")
  await fs.mkdir(path.dirname(alphaPath), { recursive: true })
  await Bun.write(alphaPath, text)
  const agents = agentHarness([agentInfo("alpha", text)])
  const tools = toolHarness([{ id: "reader", description: "read things", options: { codemode: false } }])
  const location = fullContext({ directory: project }).location
  const skillState = skillHarness([skillInfo("notes", "skill body")])
  const ctx = context({
    location,
    agent: agents.domain,
    skill: { ...skillState.domain, list: () => Effect.succeed({ location, data: Array.from(skillState.state.values()) }) },
    tool: tools.domain,
    mcp: fullContext({ directory: project }).mcp,
  })
  const state = createState()
  const handlers = createHandlers(ctx, state)
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  expect(snapshot.items.some((item) => item.id === "system:role")).toBe(true)
  const role = snapshot.items.find((item) => item.id === "system:role")
  if (!role) throw new Error("expected system:role")
  const mutated = await Effect.runPromise(
    handlers["instructions.mutate"]({
      expectedRevision: snapshot.revision,
      expectedGlobalRevision: snapshot.globalRevision,
      records: [{
        type: "customization",
        level: "project",
        agent: "alpha",
        item: "system:role",
        section: "two",
        state: "off",
        basedOn: role.fingerprint,
        updated: UPDATED,
      }],
    }, throwingContext({})),
  )
  expect(mutated.ok).toBe(true)
  if (!mutated.ok) throw new Error("expected mutate to succeed")
  const assembled = await Effect.runPromise(handlers["instructions.assembled"]({ agent: "alpha" }, throwingContext({})))
  expect(assembled.agent).toBe("alpha")
  expect(assembled.system.join("\n")).toContain("a")
  expect(assembled.system.join("\n")).not.toContain("b")
  expect(assembled.tools.map((tool) => tool.id)).toContain("reader")
  expect(assembled.skills.map((skill) => skill.id)).toContain("notes")
  expectRpcBody(assembled)
  const unknown: { current?: CapturedError } = {}
  await expectDeclaredError(handlers["instructions.assembled"]({ agent: "ghost" }, throwingContext(unknown)), unknown, "agent.unknown")
})

test("a records-only mutate re-applies to the host", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const upstream = "upstream role"
  const alphaPath = path.join(project, ".opencode", "agent", "alpha.md")
  await fs.mkdir(path.dirname(alphaPath), { recursive: true })
  await Bun.write(alphaPath, upstream)
  const agents = agentHarness([agentInfo("alpha", upstream)])
  const tools = toolHarness([{ id: "reader", description: "read things", options: { codemode: false } }])
  const location = fullContext({ directory: project }).location
  const skillState = skillHarness([])
  const skill = { ...skillState.domain, list: () => Effect.succeed({ location, data: Array.from(skillState.state.values()) }) }
  const ctx = context({ location, agent: agents.domain, skill, tool: tools.domain, mcp: fullContext({ directory: project }).mcp })
  const state = createState()
  const handlers = createHandlers(ctx, state)
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const role = snapshot.items.find((item) => item.id === "system:role")
  if (!role) throw new Error("expected system:role")
  // Warm the publish fingerprint the way activation does: an initial publish
  // with zero records installs nothing and remembers upstream.
  await Effect.runPromise(handlers["instructions.refresh"](undefined, throwingContext({})))
  const override: Plus.SnapshotCustomizationRecord = {
    type: "customization",
    level: "project",
    agent: "alpha",
    item: "system:role",
    section: null,
    text: "ROLE OVERRIDE: you are the walkthrough agent.",
    basedOn: role.fingerprint,
    updated: UPDATED,
  }
  const mutated = await Effect.runPromise(
    handlers["instructions.mutate"]({
      expectedRevision: snapshot.revision,
      expectedGlobalRevision: snapshot.globalRevision,
      records: [override],
    }, throwingContext({})),
  )
  expect(mutated.ok).toBe(true)
  if (!mutated.ok) throw new Error("expected mutate to succeed")
  expect(agents.state.get("alpha")?.system).toBe("ROLE OVERRIDE: you are the walkthrough agent.")
  const assembled = await Effect.runPromise(handlers["instructions.assembled"]({ agent: "alpha" }, throwingContext({})))
  expect(assembled.system).toEqual(["ROLE OVERRIDE: you are the walkthrough agent."])
  const cleared = await Effect.runPromise(
    handlers["instructions.mutate"]({
      expectedRevision: mutated.revision,
      expectedGlobalRevision: mutated.globalRevision,
      records: [],
    }, throwingContext({})),
  )
  expect(cleared.ok).toBe(true)
  if (!cleared.ok) throw new Error("expected reset to succeed")
  expect(agents.state.get("alpha")?.system).toBe(upstream)
  const restored = await Effect.runPromise(handlers["instructions.assembled"]({ agent: "alpha" }, throwingContext({})))
  expect(restored.system).toEqual([upstream])
})

test("an unchanged republish does not reinstall", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const upstream = "upstream role"
  const alphaPath = path.join(project, ".opencode", "agent", "alpha.md")
  await fs.mkdir(path.dirname(alphaPath), { recursive: true })
  await Bun.write(alphaPath, upstream)
  const agents = agentHarness([agentInfo("alpha", upstream)])
  const location = fullContext({ directory: project }).location
  const skillState = skillHarness([])
  const skill = { ...skillState.domain, list: () => Effect.succeed({ location, data: Array.from(skillState.state.values()) }) }
  const tools = toolHarness([])
  const ctx = context({ location, agent: agents.domain, skill, tool: tools.domain, mcp: fullContext({ directory: project }).mcp })
  const state = createState()
  const handlers = createHandlers(ctx, state)
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const role = snapshot.items.find((item) => item.id === "system:role")
  if (!role) throw new Error("expected system:role")
  const records: Plus.SnapshotCustomizationRecord[] = [{
    type: "customization",
    level: "project",
    agent: "alpha",
    item: "system:role",
    section: null,
    text: "custom role",
    basedOn: role.fingerprint,
    updated: UPDATED,
  }]
  const first = await Effect.runPromise(
    handlers["instructions.mutate"]({
      expectedRevision: snapshot.revision,
      expectedGlobalRevision: snapshot.globalRevision,
      records,
    }, throwingContext({})),
  )
  expect(first.ok).toBe(true)
  if (!first.ok) throw new Error("expected mutate to succeed")
  const installs = agents.transforms
  const disposes = agents.disposes
  // Same records, same upstream: the publish fingerprint is unchanged, so no
  // reinstall happens.
  await Effect.runPromise(handlers["instructions.refresh"](undefined, throwingContext({})))
  expect(agents.transforms).toBe(installs)
  expect(agents.disposes).toBe(disposes)
})

test("two publishes after a Code Mode text edit keep an identical fingerprint and do not reinstall", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const upstream = "upstream role"
  const alphaPath = path.join(project, ".opencode", "agent", "alpha.md")
  await fs.mkdir(path.dirname(alphaPath), { recursive: true })
  await Bun.write(alphaPath, upstream)
  const agents = agentHarness([agentInfo("alpha", upstream)])
  const location = fullContext({ directory: project }).location
  const skillState = skillHarness([])
  const skill = { ...skillState.domain, list: () => Effect.succeed({ location, data: Array.from(skillState.state.values()) }) }
  const tools = toolHarness([{ id: "coder", description: "code mode tool" }])
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
  const item = snapshot.items.find((entry) => entry.id === "tool:coder")
  if (!item) throw new Error("expected tool:coder")
  const records: Plus.SnapshotCustomizationRecord[] = [{
    type: "customization",
    level: "project",
    agent: "alpha",
    item: "tool:coder",
    section: null,
    text: "custom coder",
    basedOn: item.fingerprint,
    updated: UPDATED,
  }]
  const first = await Effect.runPromise(
    handlers["instructions.mutate"]({
      expectedRevision: snapshot.revision,
      expectedGlobalRevision: snapshot.globalRevision,
      records,
    }, throwingContext({})),
  )
  expect(first.ok).toBe(true)
  if (!first.ok) throw new Error("expected mutate to succeed")
  // The catalog hook rewrites the per-agent catalog text without touching the
  // shared tool registry: the registry still holds upstream, so the next
  // discovery unmasks nothing and the publish fingerprint stays stable.
  expect(tools.tools.get("coder")?.description).toBe("code mode tool")
  expect(hooks.current).toBe(1)
  const installs = agents.transforms
  const disposes = agents.disposes
  const fingerprintAfterMutate = state.fingerprint
  await Effect.runPromise(handlers["instructions.refresh"](undefined, throwingContext({})))
  expect(agents.transforms).toBe(installs)
  expect(agents.disposes).toBe(disposes)
  expect(hooks.current).toBe(1)
  expect(state.fingerprint).toBe(fingerprintAfterMutate)
  await Effect.runPromise(handlers["instructions.refresh"](undefined, throwingContext({})))
  expect(agents.transforms).toBe(installs)
  expect(agents.disposes).toBe(disposes)
  expect(hooks.current).toBe(1)
  expect(state.fingerprint).toBe(fingerprintAfterMutate)
})

test("two publishes with an active model keep an identical fingerprint and do not reinstall", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const upstream = "upstream role"
  const alphaPath = path.join(project, ".opencode", "agent", "alpha.md")
  await fs.mkdir(path.dirname(alphaPath), { recursive: true })
  await Bun.write(alphaPath, upstream)
  const models = [modelInfo("acme", "nova-1"), modelInfo("acme", "nova-2")]
  const agents = agentHarness([agentInfo("alpha", upstream)])
  const location = fullContext({ directory: project }).location
  const skillState = skillHarness([])
  const skill = { ...skillState.domain, list: () => Effect.succeed({ location, data: Array.from(skillState.state.values()) }) }
  const tools = toolHarness([])
  const ctx = context({
    location,
    agent: agents.domain,
    catalog: catalogHarness(models),
    prompt: promptHarness(defaultHostTemplates, { "nova-1": "general", "nova-2": "general" }),
    skill,
    tool: tools.domain,
    mcp: fullContext({ directory: project }).mcp,
  })
  const state = createState()
  const handlers = createHandlers(ctx, state)
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const added = await Effect.runPromise(
    handlers["model.add"](
      { level: "project", agent: "alpha", providerID: "acme", modelID: "nova-2" },
      throwingContext({}),
    ),
  )
  void added
  const afterAdd = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const modelRow = afterAdd.items.find((entry) => entry.id === "model:acme/nova-2")
  if (!modelRow) throw new Error("expected model:acme/nova-2")
  const active: Plus.SnapshotModelRecord = {
    type: "model",
    level: "project",
    agent: "alpha",
    providerID: "acme",
    modelID: "nova-2",
    active: true,
    updated: UPDATED,
  }
  const first = await Effect.runPromise(
    handlers["instructions.mutate"]({
      expectedRevision: afterAdd.revision,
      expectedGlobalRevision: afterAdd.globalRevision,
      records: [active],
    }, throwingContext({})),
  )
  expect(first.ok).toBe(true)
  if (!first.ok) throw new Error("expected mutate to succeed")
  expect(snapshot.revision).toBeDefined()
  const installs = agents.transforms
  const disposes = agents.disposes
  const fingerprintAfterMutate = state.fingerprint
  await Effect.runPromise(handlers["instructions.refresh"](undefined, throwingContext({})))
  expect(agents.transforms).toBe(installs)
  expect(agents.disposes).toBe(disposes)
  expect(state.fingerprint).toBe(fingerprintAfterMutate)
  await Effect.runPromise(handlers["instructions.refresh"](undefined, throwingContext({})))
  expect(agents.transforms).toBe(installs)
  expect(agents.disposes).toBe(disposes)
  expect(state.fingerprint).toBe(fingerprintAfterMutate)
})

test("two publishes with discovered perm candidates keep an identical fingerprint and do not reinstall", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const upstream = "upstream role"
  const alphaPath = path.join(project, ".opencode", "agent", "alpha.md")
  await fs.mkdir(path.dirname(alphaPath), { recursive: true })
  await Bun.write(alphaPath, upstream)
  const agents = agentHarness([agentInfo("alpha", upstream)])
  const location = fullContext({ directory: project }).location
  const skillState = skillHarness([])
  const skill = { ...skillState.domain, list: () => Effect.succeed({ location, data: Array.from(skillState.state.values()) }) }
  // Texts mention shell commands, file paths, and URLs, so discovery mines
  // perm candidates (view-time, not persisted). The publish fingerprint must
  // exclude them, or reporting Plus's own output as upstream would storm.
  const tools = toolHarness([
    { id: "shell", description: "Run `git push --force origin` and `bun run test`. See package.json and https://github.com/acme/repo.", options: { codemode: false } },
    { id: "reader", description: "read things", options: { codemode: false } },
  ])
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
  // Mined perm rows are present as view-time items but create no records.
  expect(snapshot.items.some((entry) => entry.id === "perm:shell:git-push")).toBe(true)
  expect(snapshot.records).toEqual([])
  const role = snapshot.items.find((entry) => entry.id === "system:role")
  if (!role) throw new Error("expected system:role")
  const records: Plus.SnapshotCustomizationRecord[] = [{
    type: "customization",
    level: "project",
    agent: "alpha",
    item: "system:role",
    section: null,
    text: "custom role",
    basedOn: role.fingerprint,
    updated: UPDATED,
  }]
  const first = await Effect.runPromise(
    handlers["instructions.mutate"]({
      expectedRevision: snapshot.revision,
      expectedGlobalRevision: snapshot.globalRevision,
      records,
    }, throwingContext({})),
  )
  expect(first.ok).toBe(true)
  if (!first.ok) throw new Error("expected mutate to succeed")
  const installs = agents.transforms
  const disposes = agents.disposes
  const fingerprintAfterMutate = state.fingerprint
  await Effect.runPromise(handlers["instructions.refresh"](undefined, throwingContext({})))
  expect(agents.transforms).toBe(installs)
  expect(agents.disposes).toBe(disposes)
  expect(state.fingerprint).toBe(fingerprintAfterMutate)
  await Effect.runPromise(handlers["instructions.refresh"](undefined, throwingContext({})))
  expect(agents.transforms).toBe(installs)
  expect(agents.disposes).toBe(disposes)
  expect(state.fingerprint).toBe(fingerprintAfterMutate)
})

test("instructions.assembled reports the registry tool description for a per-agent override", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const agents = agentHarness([agentInfo("alpha", "upstream role")])
  const tools = toolHarness([{ id: "reader", description: "read things", options: { codemode: false } }])
  const location = fullContext({ directory: project }).location
  const skillState = skillHarness([])
  const skill = { ...skillState.domain, list: () => Effect.succeed({ location, data: Array.from(skillState.state.values()) }) }
  const ctx = context({ location, agent: agents.domain, skill, tool: tools.domain, mcp: fullContext({ directory: project }).mcp })
  const state = createState()
  const handlers = createHandlers(ctx, state)
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const tool = snapshot.items.find((item) => item.id === "tool:reader")
  if (!tool) throw new Error("expected tool:reader")
  const mutated = await Effect.runPromise(
    handlers["instructions.mutate"]({
      expectedRevision: snapshot.revision,
      expectedGlobalRevision: snapshot.globalRevision,
      records: [{
        type: "customization",
        level: "project",
        agent: "alpha",
        item: "tool:reader",
        section: null,
        text: "custom description",
        basedOn: tool.fingerprint,
        updated: UPDATED,
      }],
    }, throwingContext({})),
  )
  expect(mutated.ok).toBe(true)
  if (!mutated.ok) throw new Error("expected mutate to succeed")
  const assembled = await Effect.runPromise(handlers["instructions.assembled"]({ agent: "alpha" }, throwingContext({})))
  const reader = assembled.tools.find((entry) => entry.id === "reader")
  if (!reader) throw new Error("expected reader in assembled tools")
  expect(reader.description).toBe("read things")
})

test("instructions.assembled prefers the agent's private skill copy over the original", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const agents = agentHarness([agentInfo("alpha", "upstream role"), agentInfo("beta", "upstream role")])
  for (const id of ["alpha", "beta"]) {
    const agentPath = path.join(project, ".opencode", "agent", `${id}.md`)
    await fs.mkdir(path.dirname(agentPath), { recursive: true })
    await Bun.write(agentPath, "upstream role")
  }
  const location = fullContext({ directory: project }).location
  const skillState = skillHarness([skillInfo("notes", "upstream body")])
  const tools = toolHarness([])
  // The harness registry is shared between discovery, apply, and the
  // assembled readback, exactly like core's registry: discovery filters
  // plus/ copies out of inventory itself, apply installs through the
  // transform seam, and assembled observes the full registry including any
  // installed private copies. The pre-mutate assembled check below pins the
  // data flow: discovery reports upstream, assembled reports upstream.
  // NOTE: skill content here carries no headings on purpose. Headed text
  // derives sections, and skillCustomized treats an assembled body that
  // differs beyond whitespace normalization as customized — which is exactly
  // what the section-exclusion test covers.
  // (A trailing newline alone would also make the copy body differ from the
  // record text after assemble trims, masking what this test pins.)
  const skill = { ...skillState.domain, list: () => Effect.succeed({ location, data: Array.from(skillState.state.values()) }) }
  const ctx = context({ location, agent: agents.domain, skill, tool: tools.domain, mcp: fullContext({ directory: project }).mcp })
  const state = createState()
  const handlers = createHandlers(ctx, state)
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const item = snapshot.items.find((entry) => entry.id === "skill:notes")
  if (!item) throw new Error("expected skill:notes")
  expect(item.text).toBe("upstream body")
  const fingerprintOf = (text: string) => fingerprint(text)
  expect(item.fingerprint).toBe(fingerprintOf("upstream body"))
  expect(fingerprintOf("custom body")).not.toBe(item.fingerprint)
  expect(skillState.added).toEqual([])
  const before = await Effect.runPromise(handlers["instructions.assembled"]({ agent: "alpha" }, throwingContext({})))
  expect(before.skills.find((entry) => entry.id === "notes")?.content).toBe("upstream body")
  const mutated = await Effect.runPromise(
    handlers["instructions.mutate"]({
      expectedRevision: snapshot.revision,
      expectedGlobalRevision: snapshot.globalRevision,
      records: [{
        type: "customization",
        level: "project",
        agent: "alpha",
        item: "skill:notes",
        section: null,
        text: "custom body",
        basedOn: item.fingerprint,
        updated: UPDATED,
      }],
    }, throwingContext({})),
  )
  expect(mutated.ok).toBe(true)
  if (!mutated.ok) throw new Error("expected mutate to succeed")
  expect(mutated.snapshot.records).toHaveLength(1)
  expect(skillState.added.map((entry) => String(entry.id))).toEqual(["plus/alpha/notes"])
  const forAlpha = await Effect.runPromise(handlers["instructions.assembled"]({ agent: "alpha" }, throwingContext({})))
  expect(forAlpha.skills.find((entry) => entry.id === "notes")?.content).toBe("custom body")
  const forBeta = await Effect.runPromise(handlers["instructions.assembled"]({ agent: "beta" }, throwingContext({})))
  expect(forBeta.skills.find((entry) => entry.id === "notes")?.content).toBe("upstream body")
  expectRpcBody(forAlpha)
})

test("agent.create from a non-file-backed Defaults template seeds prompt and fields without copying records", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const template = {
    ...agentInfo("build", "Build the thing."),
    description: "The default agent.",
    mode: "primary" as const,
  }
  const agents = agentHarness([template])
  const skillState = skillHarness([])
  const location = fullContext({ directory: project }).location
  const skill = { ...skillState.domain, list: () => Effect.succeed({ location, data: Array.from(skillState.state.values()) }) }
  const tools = toolHarness([])
  const ctx = context({ location, agent: agents.domain, skill, tool: tools.domain, mcp: fullContext({ directory: project }).mcp })
  const state = createState()
  const handlers = createHandlers(ctx, state)
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const entry = snapshot.agents.find((agent) => agent.id === "build")
  expect(entry?.scope).toBe("defaults")
  expect(entry?.fileBacked).toBe(false)
  const created = await Effect.runPromise(
    handlers["agent.create"]({ scope: "project", id: "from-defaults", template: "build", prompt: "ignored" }, throwingContext({})),
  )
  expect(created).toEqual({ id: "from-defaults", path: path.join(project, ".opencode", "agent", "from-defaults.md") })
  const written = await Bun.file(created.path).text()
  expect(written).toContain("Build the thing.")
  expect(written).toContain("The default agent.")
  expectRpcBody(created)
  const after = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  expect(after.records).toEqual([])
})

test("snapshot reports built-in agents with defaults scope once without project or global duplication", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const builtinInfos = [
    agentInfo("build", "build agent"),
    agentInfo("plan", "plan agent"),
    agentInfo("general", "general agent"),
    agentInfo("explore", "explore agent"),
    agentInfo("compaction", "compaction agent"),
    agentInfo("title", "title agent"),
    agentInfo("summary", "summary agent"),
  ]
  const handlers = createHandlers(fullContext({ directory: project, agents: builtinInfos }), createState())
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const buildEntries = snapshot.agents.filter((agent) => agent.id === "build")
  expect(buildEntries).toEqual([
    { id: "build", scope: "defaults", origin: "native", base: "general", fileBacked: false },
  ])
  const planEntries = snapshot.agents.filter((agent) => agent.id === "plan")
  expect(planEntries).toEqual([
    { id: "plan", scope: "defaults", origin: "native", base: "general", fileBacked: false },
  ])
  const specialIds = ["general", "explore", "compaction", "title", "summary"]
  for (const id of specialIds) {
    const entries = snapshot.agents.filter((agent) => agent.id === id)
    expect(entries).toEqual([
      { id, scope: "defaults", origin: "special", base: "general", fileBacked: false },
    ])
  }
})

test("agent create/rename/delete work at both scopes and create accepts a template seed", async () => {
  const { project, config } = await tempRoot()
  await enable(project)
  const handlers = createHandlers(fullContext({ directory: project }), createState())
  const createdProject = await Effect.runPromise(
    handlers["agent.create"]({ scope: "project", id: "alpha", prompt: "Be helpful." }, throwingContext({})),
  )
  expect(createdProject).toEqual({ id: "alpha", path: path.join(project, ".opencode", "agent", "alpha.md") })
  expect(await Bun.file(createdProject.path).text()).toContain("Be helpful.")
  const createdGlobal = await Effect.runPromise(
    handlers["agent.create"]({ scope: "global", id: "beta", prompt: "Global prompt." }, throwingContext({})),
  )
  expect(createdGlobal).toEqual({ id: "beta", path: path.join(config, "agent", "beta.md") })
  const seeded = await Effect.runPromise(
    handlers["agent.create"]({ scope: "project", id: "gamma", template: "alpha", prompt: "ignored" }, throwingContext({})),
  )
  expect(await Bun.file(seeded.path).text()).toContain("Be helpful.")
  const renamed = await Effect.runPromise(handlers["agent.rename"]({ scope: "project", from: "alpha", to: "alpha2" }, throwingContext({})))
  expect(renamed).toEqual({ from: "alpha", to: "alpha2", path: path.join(project, ".opencode", "agent", "alpha2.md") })
  const deleted = await Effect.runPromise(handlers["agent.delete"]({ scope: "global", id: "beta" }, throwingContext({})))
  expect(deleted).toEqual({ id: "beta", path: createdGlobal.path })
  expectRpcBody(deleted)
})

test("agent methods raise every declared error", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const handlers = createHandlers(fullContext({ directory: project }), createState())
  await Effect.runPromise(handlers["agent.create"]({ scope: "project", id: "alpha", prompt: "x" }, throwingContext({})))
  const exists: { current?: CapturedError } = {}
  await expectDeclaredError(handlers["agent.create"]({ scope: "project", id: "alpha", prompt: "y" }, throwingContext(exists)), exists, "agent.exists")
  const invalid: { current?: CapturedError } = {}
  await expectDeclaredError(handlers["agent.create"]({ scope: "project", id: "../../x", prompt: "y" }, throwingContext(invalid)), invalid, "agent.invalid")
  const missing: { current?: CapturedError } = {}
  await expectDeclaredError(handlers["agent.rename"]({ scope: "project", from: "ghost", to: "b" }, throwingContext(missing)), missing, "agent.missing")
  const missingDelete: { current?: CapturedError } = {}
  await expectDeclaredError(handlers["agent.delete"]({ scope: "project", id: "ghost" }, throwingContext(missingDelete)), missingDelete, "agent.missing")
})

test("skill create and import write SKILL.md and raise declared errors", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const handlers = createHandlers(fullContext({ directory: project }), createState())
  const created = await Effect.runPromise(handlers["skill.create"]({ name: "notes", body: "Take notes." }, throwingContext({})))
  expect(created).toEqual({ id: "notes", path: path.join(project, ".opencode", "skill", "notes", "SKILL.md") })
  expect(await Bun.file(created.path).text()).toContain("Take notes.")
  expectRpcBody(created)
  const duplicate: { current?: CapturedError } = {}
  await expectDeclaredError(handlers["skill.create"]({ name: "notes", body: "again" }, throwingContext(duplicate)), duplicate, "skill.exists")
  const invalid: { current?: CapturedError } = {}
  await expectDeclaredError(handlers["skill.create"]({ name: "../evil", body: "x" }, throwingContext(invalid)), invalid, "skill.invalid")
  const source = path.join(project, "external", "SKILL.md")
  await fs.mkdir(path.dirname(source), { recursive: true })
  await Bun.write(source, "---\nname: imported\ndescription: imported skill\n---\nImported body.\n")
  const imported = await Effect.runPromise(handlers["skill.import"]({ path: source }, throwingContext({})))
  expect(imported.id).toBe("imported")
  expectRpcBody(imported)
  const bad = path.join(project, "bad", "SKILL.md")
  await fs.mkdir(path.dirname(bad), { recursive: true })
  await Bun.write(bad, "no frontmatter here\n")
  const badImport: { current?: CapturedError } = {}
  await expectDeclaredError(handlers["skill.import"]({ path: bad }, throwingContext(badImport)), badImport, "skill.invalid")
})

test("skill delete removes the project SKILL.md directory and raises declared errors", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const handlers = createHandlers(fullContext({ directory: project }), createState())
  const created = await Effect.runPromise(handlers["skill.create"]({ name: "notes", body: "Take notes." }, throwingContext({})))
  const deleted = await Effect.runPromise(handlers["skill.delete"]({ id: "notes" }, throwingContext({})))
  expect(deleted).toEqual({ id: "notes", path: created.path })
  expect(await Bun.file(created.path).exists()).toBe(false)
  expectRpcBody(deleted)
  const missing: { current?: CapturedError } = {}
  await expectDeclaredError(handlers["skill.delete"]({ id: "ghost" }, throwingContext(missing)), missing, "skill.missing")
  const invalid: { current?: CapturedError } = {}
  await expectDeclaredError(handlers["skill.delete"]({ id: "../evil" }, throwingContext(invalid)), invalid, "skill.invalid")
})

test("rule remove drops customizations so re-adding the rule reads enabled:true", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const handlers = createHandlers(
    fullContext({
      directory: project,
      tools: [{ id: "shell", description: "Run shell.", options: { codemode: false } }],
    }),
    createState(),
  )

  await Effect.runPromise(
    handlers["rule.add"](
      { level: "project", agent: null, tool: "shell", id: "custom", label: "Custom rule", patterns: ["danger *"] },
      throwingContext({}),
    ),
  )

  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const permItem = snapshot.items.find((item) => item.id === "perm:shell:custom")
  expect(permItem).toBeDefined()

  const mutated = await Effect.runPromise(
    handlers["instructions.mutate"](
      {
        expectedRevision: snapshot.revision,
        expectedGlobalRevision: snapshot.globalRevision,
        records: [
          ...snapshot.records,
          record("perm:shell:custom", {
            state: "off",
            basedOn: permItem!.fingerprint,
          }),
        ],
      },
      throwingContext({}),
    ),
  )
  expect(mutated.ok).toBe(true)
  expect(mutated.snapshot.records.some((r) => r.type === "customization" && r.item === "perm:shell:custom")).toBe(true)

  await Effect.runPromise(
    handlers["rule.remove"](
      { level: "project", agent: null, tool: "shell", id: "custom" },
      throwingContext({}),
    ),
  )

  const snapshotAfterRemove = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  expect(
    snapshotAfterRemove.records.some(
      (r) => (r.type === "customization" || r.type === "split") && r.item === "perm:shell:custom",
    ),
  ).toBe(false)

  await Effect.runPromise(
    handlers["rule.add"](
      { level: "project", agent: null, tool: "shell", id: "custom", label: "Custom rule", patterns: ["danger *"] },
      throwingContext({}),
    ),
  )

  const snapshotAfterReAdd = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  expect(
    snapshotAfterReAdd.records.some(
      (r) => (r.type === "customization" || r.type === "split") && r.item === "perm:shell:custom",
    ),
  ).toBe(false)
  const readdedItem = snapshotAfterReAdd.items.find((item) => item.id === "perm:shell:custom")
  expect(readdedItem).toBeDefined()
  expect(readdedItem?.enabled).toBe(true)

  const row = expandedTree({
    items: snapshotAfterReAdd.items.map(itemOf),
    records: snapshotAfterReAdd.records.map(recordOf),
    agents: snapshotAfterReAdd.agents,
  }).find((node) => node.address?.item === "perm:shell:custom")
  expect(row).toBeDefined()
  expect(row?.badges.state).toBe("on")
})

test("skill delete drops item-addressed customizations so re-created skill resolves new body", async () => {
  const { project } = await tempRoot()
  await enable(project)

  const agentPath = path.join(project, ".opencode", "agent", "alpha.md")
  await fs.mkdir(path.dirname(agentPath), { recursive: true })
  await Bun.write(agentPath, "upstream role")

  const location = fullContext({ directory: project }).location
  const agents = agentHarness([agentInfo("alpha", "upstream role")])
  const tools = toolHarness([])
  const testSkills = new Map<string, ReturnType<typeof skillInfo>>()
  const skillState = skillHarness([])

  const skill = {
    ...skillState.domain,
    list: () =>
      Effect.succeed({
        location,
        data: Array.from(new Map([...testSkills, ...skillState.state]).values()),
      }),
    transform: (callback: Parameters<typeof skillState.domain.transform>[0]) =>
      skillState.domain.transform((editor) => {
        callback({
          ...editor,
          get: (id) => editor.get(id) ?? testSkills.get(id),
        })
      }),
  }
  const ctx = context({
    location,
    agent: agents.domain,
    skill,
    tool: tools.domain,
    mcp: fullContext({ directory: project }).mcp,
  })
  const handlers = createHandlers(ctx, createState())

  const created = await Effect.runPromise(
    handlers["skill.create"]({ name: "notes", body: "Original body." }, throwingContext({})),
  )
  testSkills.set("notes", skillInfo("notes", "Original body.", created.path))

  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const skillItem = snapshot.items.find((item) => item.id === "skill:notes")
  expect(skillItem).toBeDefined()
  expect(skillItem?.text).toBe("Original body.")

  const mutated = await Effect.runPromise(
    handlers["instructions.mutate"](
      {
        expectedRevision: snapshot.revision,
        expectedGlobalRevision: snapshot.globalRevision,
        records: [
          record("skill:notes", {
            text: "Overridden body.",
            basedOn: skillItem!.fingerprint,
          }),
        ],
      },
      throwingContext({}),
    ),
  )
  expect(mutated.ok).toBe(true)
  expect(
    mutated.snapshot.records.some(
      (r) => (r.type === "customization" || r.type === "split") && r.item === "skill:notes",
    ),
  ).toBe(true)

  const forAlpha = await Effect.runPromise(handlers["instructions.assembled"]({ agent: "alpha" }, throwingContext({})))
  expect(forAlpha.skills.find((s) => s.id === "notes")?.content).toBe("Overridden body.")

  await Effect.runPromise(handlers["skill.delete"]({ id: "notes" }, throwingContext({})))
  testSkills.delete("notes")

  const snapshotAfterDelete = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  expect(
    snapshotAfterDelete.records.some(
      (r) => (r.type === "customization" || r.type === "split") && r.item === "skill:notes",
    ),
  ).toBe(false)
  expect(snapshotAfterDelete.items.some((item) => item.id === "skill:notes")).toBe(false)

  const recreated = await Effect.runPromise(
    handlers["skill.create"]({ name: "notes", body: "Different brand new body." }, throwingContext({})),
  )
  testSkills.set("notes", skillInfo("notes", "Different brand new body.", recreated.path))

  const forAlphaAfter = await Effect.runPromise(handlers["instructions.assembled"]({ agent: "alpha" }, throwingContext({})))
  expect(forAlphaAfter.skills.find((s) => s.id === "notes")?.content).toBe("Different brand new body.")

  const snapshotAfterRecreate = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  expect(
    snapshotAfterRecreate.records.some(
      (r) => (r.type === "customization" || r.type === "split") && r.item === "skill:notes",
    ),
  ).toBe(false)
  const recreatedItem = snapshotAfterRecreate.items.find((item) => item.id === "skill:notes")
  expect(recreatedItem).toBeDefined()
  expect(recreatedItem?.text).toBe("Different brand new body.")
})

test("base create refuses a builtin id so user templates can never shadow the host", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const handlers = createHandlers(fullContext({ directory: project }), createState())
  const builtin: { current?: CapturedError } = {}
  await expectDeclaredError(
    handlers["base.create"]({ id: "gpt", title: "gpt.txt", text: "shadow" }, throwingContext(builtin)),
    builtin,
    "base.invalid",
  )
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  expect(snapshot.items.some((item) => item.id === "base:gpt" && item.userBase === true)).toBe(false)
})

test("base delete removes a legacy builtin-id shadow file to restore the host template", async () => {
  // Migration path for shadows created before the creation refusal: the user
  // file exists on disk, so base.delete removes it instead of refusing as
  // builtin. Deleting the shadow restores the host template in the snapshot.
  const { project } = await tempRoot()
  await enable(project)
  const handlers = createHandlers(fullContext({ directory: project }), createState())
  const { userBaseFile } = await import("../src/agents/base.js")
  await fs.mkdir(path.dirname(userBaseFile("gpt")), { recursive: true })
  await Bun.write(userBaseFile("gpt"), "shadow base")
  const before = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  expect(before.items.find((item) => item.id === "base:gpt")?.userBase).toBe(true)
  expect(before.items.find((item) => item.id === "base:gpt")?.text).toBe("shadow base")
  const deleted = await Effect.runPromise(handlers["base.delete"]({ id: "gpt" }, throwingContext({})))
  expect(deleted).toEqual({ id: "gpt" })
  expect(await Bun.file(userBaseFile("gpt")).exists()).toBe(false)
  const after = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  expect(after.items.find((item) => item.id === "base:gpt")?.userBase).toBeUndefined()
  expect(after.items.find((item) => item.id === "base:gpt")?.text).toBe("gpt base prompt")
})

test("base create stores a user template and raises declared errors", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const handlers = createHandlers(fullContext({ directory: project }), createState())
  const created = await Effect.runPromise(handlers["base.create"]({ id: "custom", title: "Custom.txt", text: "custom base" }, throwingContext({})))
  expect(created).toEqual({ id: "custom" })
  expectRpcBody(created)
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  expect(snapshot.items.some((item) => item.id === "base:custom")).toBe(true)
  expect(snapshot.items.find((item) => item.id === "base:custom")?.text).toBe("custom base")
  const duplicate: { current?: CapturedError } = {}
  await expectDeclaredError(handlers["base.create"]({ id: "custom", title: "X", text: "y" }, throwingContext(duplicate)), duplicate, "base.exists")
  const invalid: { current?: CapturedError } = {}
  await expectDeclaredError(handlers["base.create"]({ id: "", title: "X", text: "y" }, throwingContext(invalid)), invalid, "base.invalid")
})

test("base delete removes a user template, refuses missing, and refuses builtins without a shadow", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const handlers = createHandlers(fullContext({ directory: project }), createState())
  await Effect.runPromise(handlers["base.create"]({ id: "custom", title: "Custom.txt", text: "custom base" }, throwingContext({})))
  const deleted = await Effect.runPromise(handlers["base.delete"]({ id: "custom" }, throwingContext({})))
  expect(deleted).toEqual({ id: "custom" })
  expectRpcBody(deleted)
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  expect(snapshot.items.some((item) => item.id === "base:custom")).toBe(false)
  const missing: { current?: CapturedError } = {}
  await expectDeclaredError(handlers["base.delete"]({ id: "ghost" }, throwingContext(missing)), missing, "base.missing")
  // No user shadow file on disk: the host template itself cannot be deleted.
  const builtin: { current?: CapturedError } = {}
  await expectDeclaredError(handlers["base.delete"]({ id: "gpt" }, throwingContext(builtin)), builtin, "base.invalid")
})

test("instruction create writes a project file core discovery picks up and raises declared errors", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const handlers = createHandlers(fullContext({ directory: project }), createState())
  const created = await Effect.runPromise(handlers["instruction.create"]({ name: "AGENTS.md", text: "Follow the guide." }, throwingContext({})))
  expect(created.path).toBe(path.join(project, "AGENTS.md"))
  expect(await Bun.file(created.path).text()).toContain("Follow the guide.")
  expectRpcBody(created)
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  expect(snapshot.items.some((item) => item.id === "system:AGENTS.md")).toBe(true)
  const duplicate: { current?: CapturedError } = {}
  await expectDeclaredError(handlers["instruction.create"]({ name: "AGENTS.md", text: "again" }, throwingContext(duplicate)), duplicate, "instruction.exists")
  const invalid: { current?: CapturedError } = {}
  await expectDeclaredError(handlers["instruction.create"]({ name: "../evil", text: "x" }, throwingContext(invalid)), invalid, "instruction.invalid")
})

test("instruction delete removes the project file, refuses traversal, and raises declared errors", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const handlers = createHandlers(fullContext({ directory: project }), createState())
  const created = await Effect.runPromise(handlers["instruction.create"]({ name: "AGENTS.md", text: "Follow the guide." }, throwingContext({})))
  const deleted = await Effect.runPromise(handlers["instruction.delete"]({ name: "AGENTS.md" }, throwingContext({})))
  expect(deleted).toEqual({ id: "system:AGENTS.md", path: created.path })
  expect(await Bun.file(created.path).exists()).toBe(false)
  expectRpcBody(deleted)
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  expect(snapshot.items.some((item) => item.id === "system:AGENTS.md")).toBe(false)
  const missing: { current?: CapturedError } = {}
  await expectDeclaredError(handlers["instruction.delete"]({ name: "ghost.md" }, throwingContext(missing)), missing, "instruction.missing")
  const invalid: { current?: CapturedError } = {}
  await expectDeclaredError(handlers["instruction.delete"]({ name: "../evil" }, throwingContext(invalid)), invalid, "instruction.invalid")
})

test("mcp add and remove edit the project config and raise declared errors", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const handlers = createHandlers(fullContext({ directory: project }), createState())
  const added = await Effect.runPromise(
    handlers["mcp.add"]({ name: "search", config: { type: "remote", url: "https://example.test" } }, throwingContext({})),
  )
  expect(added).toEqual({ name: "search" })
  expectRpcBody(added)
  // The project's own config file carries the new server; the fake MCP host
  // cannot reread config files, so the file itself is the assertion.
  const configText = await Bun.file(path.join(project, ".opencode", "opencode.json")).text()
  expect(configText).toContain(`"search"`)
  expect(configText).toContain(`https://example.test`)
  const duplicate: { current?: CapturedError } = {}
  await expectDeclaredError(
    handlers["mcp.add"]({ name: "search", config: { type: "remote", url: "https://example.test" } }, throwingContext(duplicate)),
    duplicate,
    "mcp.exists",
  )
  const invalid: { current?: CapturedError } = {}
  await expectDeclaredError(handlers["mcp.add"]({ name: "", config: { type: "remote", url: "https://x.test" } }, throwingContext(invalid)), invalid, "mcp.invalid")
  const removed = await Effect.runPromise(handlers["mcp.remove"]({ name: "search" }, throwingContext({})))
  expect(removed).toEqual({ name: "search" })
  expect(await Bun.file(path.join(project, ".opencode", "opencode.json")).text()).not.toContain(`"search"`)
  const missing: { current?: CapturedError } = {}
  await expectDeclaredError(handlers["mcp.remove"]({ name: "ghost" }, throwingContext(missing)), missing, "mcp.missing")
  const invalidRemove: { current?: CapturedError } = {}
  await expectDeclaredError(handlers["mcp.remove"]({ name: "" }, throwingContext(invalidRemove)), invalidRemove, "mcp.invalid")
})

test("mcp methods refuse to destroy an unparseable project config", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const target = path.join(project, ".opencode", "opencode.json")
  await fs.mkdir(path.dirname(target), { recursive: true })
  await Bun.write(target, "{not json\n")
  const handlers = createHandlers(fullContext({ directory: project }), createState())
  const addBad: { current?: CapturedError } = {}
  await expectDeclaredError(
    handlers["mcp.add"]({ name: "search", config: { type: "remote", url: "https://example.test" } }, throwingContext(addBad)),
    addBad,
    "mcp.invalid",
  )
  const removeBad: { current?: CapturedError } = {}
  await expectDeclaredError(handlers["mcp.remove"]({ name: "search" }, throwingContext(removeBad)), removeBad, "mcp.invalid")
  expect(await Bun.file(target).text()).toBe("{not json\n")
})

test("session.created uses the cached active model without rediscovery", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const upstream = "upstream role"
  const alphaPath = path.join(project, ".opencode", "agent", "alpha.md")
  await fs.mkdir(path.dirname(alphaPath), { recursive: true })
  await Bun.write(alphaPath, upstream)
  const models = [modelInfo("acme", "nova-1"), modelInfo("acme", "nova-2")]
  const agents = agentHarness([agentInfo("alpha", upstream)])
  const location = fullContext({ directory: project }).location
  const skillState = skillHarness([])
  const skill = { ...skillState.domain, list: () => Effect.succeed({ location, data: Array.from(skillState.state.values()) }) }
  const tools = toolHarness([])
  const counts = { agentLists: 0, skillLists: 0 }
  const switches: Array<{ sessionID: unknown; model: { providerID: unknown; id: unknown; variant?: unknown } }> = []
  const countingAgent = {
    ...agents.domain,
    list: () => {
      counts.agentLists++
      return agents.domain.list()
    },
  }
  const countingSkill = {
    ...skill,
    list: () => {
      counts.skillLists++
      return skill.list()
    },
  }
  const ctx = context({
    location,
    agent: countingAgent,
    catalog: catalogHarness(models),
    prompt: promptHarness(defaultHostTemplates, { "nova-1": "general", "nova-2": "general" }),
    skill: countingSkill,
    tool: tools.domain,
    mcp: fullContext({ directory: project }).mcp,
    session: {
      get: () => Effect.succeed({ agent: "alpha", model: { providerID: "acme", id: "nova-1" } } as never),
      switchModel: (input: { sessionID: unknown; model: { providerID: unknown; id: unknown; variant?: unknown } }) =>
        Effect.sync(() => {
          switches.push({ sessionID: input.sessionID, model: input.model })
        }),
    },
  })
  const state = createState()
  const handlers = createHandlers(ctx, state)
  await Effect.runPromise(
    handlers["model.add"]({ level: "project", agent: "alpha", providerID: "acme", modelID: "nova-2" }, throwingContext({})),
  )
  const afterAdd = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const active: Plus.SnapshotModelRecord = {
    type: "model",
    level: "project",
    agent: "alpha",
    providerID: "acme",
    modelID: "nova-2",
    active: true,
    updated: UPDATED,
  }
  const mutated = await Effect.runPromise(
    handlers["instructions.mutate"]({
      expectedRevision: afterAdd.revision,
      expectedGlobalRevision: afterAdd.globalRevision,
      records: [active],
    }, throwingContext({})),
  )
  expect(mutated.ok).toBe(true)
  if (!mutated.ok) throw new Error("expected mutate to succeed")
  expect(state.activeModels.get("alpha")).toMatchObject({ providerID: "acme", modelID: "nova-2" })
  counts.agentLists = 0
  counts.skillLists = 0
  switches.length = 0
  await Effect.runPromise(
    applySessionModel(ctx, state, { type: "session.created", properties: { sessionID: "ses_1", agent: "alpha" } }),
  )
  expect(switches).toHaveLength(1)
  expect(String(switches[0]?.model.providerID)).toBe("acme")
  expect(String(switches[0]?.model.id)).toBe("nova-2")
  expect(counts.agentLists).toBe(0)
  expect(counts.skillLists).toBe(0)
  const { load, save } = await import("../src/instructions/store.js")
  const stored = await load(project)
  await save(project, {
    expectedProjectRevision: stored.projectRevision,
    expectedGlobalRevision: stored.globalRevision,
    records: [],
  })
  // The store moved underneath the cache (as a shared Global/Defaults change
  // from another Location would): the next session event must invalidate the
  // cache cheaply and NOT switch to the stale model.
  switches.length = 0
  counts.agentLists = 0
  counts.skillLists = 0
  await Effect.runPromise(
    applySessionModel(ctx, state, { type: "session.created", properties: { sessionID: "ses_2", agent: "alpha" } }),
  )
  expect(switches).toHaveLength(0)
  expect(counts.agentLists).toBe(0)
  expect(counts.skillLists).toBe(0)
})

test("two publishes with a host-owned agent and absent upstream keep an identical fingerprint", async () => {
  const { project } = await tempRoot()
  await enable(project)
  // No agent file: host-owned built-in with no configured model (upstream absent).
  const models = [modelInfo("acme", "nova-1"), modelInfo("acme", "nova-2")]
  const agents = agentHarness([agentInfo("ghost", "ghost role")])
  const location = fullContext({ directory: project }).location
  const skillState = skillHarness([])
  const skill = { ...skillState.domain, list: () => Effect.succeed({ location, data: Array.from(skillState.state.values()) }) }
  const tools = toolHarness([])
  const ctx = context({
    location,
    agent: agents.domain,
    catalog: catalogHarness(models),
    prompt: promptHarness(defaultHostTemplates, { "nova-1": "general", "nova-2": "general" }),
    skill,
    tool: tools.domain,
    mcp: fullContext({ directory: project }).mcp,
  })
  const state = createState()
  const handlers = createHandlers(ctx, state)
  await Effect.runPromise(
    handlers["model.add"]({ level: "project", agent: "ghost", providerID: "acme", modelID: "nova-2" }, throwingContext({})),
  )
  const afterAdd = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const active: Plus.SnapshotModelRecord = {
    type: "model",
    level: "project",
    agent: "ghost",
    providerID: "acme",
    modelID: "nova-2",
    active: true,
    updated: UPDATED,
  }
  const first = await Effect.runPromise(
    handlers["instructions.mutate"]({
      expectedRevision: afterAdd.revision,
      expectedGlobalRevision: afterAdd.globalRevision,
      records: [active],
    }, throwingContext({})),
  )
  expect(first.ok).toBe(true)
  if (!first.ok) throw new Error("expected mutate to succeed")
  const installs = agents.transforms
  const disposes = agents.disposes
  const fingerprintAfterMutate = state.fingerprint
  await Effect.runPromise(handlers["instructions.refresh"](undefined, throwingContext({})))
  expect(agents.transforms).toBe(installs)
  expect(agents.disposes).toBe(disposes)
  expect(state.fingerprint).toBe(fingerprintAfterMutate)
  await Effect.runPromise(handlers["instructions.refresh"](undefined, throwingContext({})))
  expect(agents.transforms).toBe(installs)
  expect(agents.disposes).toBe(disposes)
  expect(state.fingerprint).toBe(fingerprintAfterMutate)
})

test("two publishes with a family-changing activation keep an identical fingerprint", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const upstream = "upstream role"
  const alphaPath = path.join(project, ".opencode", "agent", "alpha.md")
  await fs.mkdir(path.dirname(alphaPath), { recursive: true })
  await Bun.write(alphaPath, upstream)
  const models = [modelInfo("acme", "nova-1"), modelInfo("acme", "nova-2")]
  const agents = agentHarness([agentInfo("alpha", upstream)])
  const location = fullContext({ directory: project }).location
  const skillState = skillHarness([])
  const skill = { ...skillState.domain, list: () => Effect.succeed({ location, data: Array.from(skillState.state.values()) }) }
  const tools = toolHarness([])
  const ctx = context({
    location,
    agent: agents.domain,
    catalog: catalogHarness(models),
    prompt: promptHarness(defaultHostTemplates, { "nova-1": "general", "nova-2": "gpt" }),
    skill,
    tool: tools.domain,
    mcp: fullContext({ directory: project }).mcp,
  })
  const state = createState()
  const handlers = createHandlers(ctx, state)
  await Effect.runPromise(
    handlers["model.add"]({ level: "project", agent: "alpha", providerID: "acme", modelID: "nova-2" }, throwingContext({})),
  )
  const afterAdd = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const active: Plus.SnapshotModelRecord = {
    type: "model",
    level: "project",
    agent: "alpha",
    providerID: "acme",
    modelID: "nova-2",
    active: true,
    updated: UPDATED,
  }
  const first = await Effect.runPromise(
    handlers["instructions.mutate"]({
      expectedRevision: afterAdd.revision,
      expectedGlobalRevision: afterAdd.globalRevision,
      records: [active],
    }, throwingContext({})),
  )
  expect(first.ok).toBe(true)
  if (!first.ok) throw new Error("expected mutate to succeed")
  const installs = agents.transforms
  const disposes = agents.disposes
  const fingerprintAfterMutate = state.fingerprint
  await Effect.runPromise(handlers["instructions.refresh"](undefined, throwingContext({})))
  expect(agents.transforms).toBe(installs)
  expect(agents.disposes).toBe(disposes)
  expect(state.fingerprint).toBe(fingerprintAfterMutate)
  await Effect.runPromise(handlers["instructions.refresh"](undefined, throwingContext({})))
  expect(agents.transforms).toBe(installs)
  expect(agents.disposes).toBe(disposes)
  expect(state.fingerprint).toBe(fingerprintAfterMutate)
})

test("session.created without an agent adopts the default agent's model", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const upstream = "upstream role"
  const alphaPath = path.join(project, ".opencode", "agent", "alpha.md")
  await fs.mkdir(path.dirname(alphaPath), { recursive: true })
  await Bun.write(alphaPath, upstream)
  const models = [modelInfo("acme", "nova-1"), modelInfo("acme", "nova-2")]
  const agents = agentHarness([agentInfo("alpha", upstream), agentInfo("beta", "beta role")])
  const location = fullContext({ directory: project }).location
  const skillState = skillHarness([])
  const skill = { ...skillState.domain, list: () => Effect.succeed({ location, data: Array.from(skillState.state.values()) }) }
  const tools = toolHarness([])
  const switches: Array<{ sessionID: unknown; model: { providerID: unknown; id: unknown; variant?: unknown } }> = []
  const ctx = context({
    location,
    agent: agents.domain,
    catalog: catalogHarness(models),
    prompt: promptHarness(defaultHostTemplates, { "nova-1": "general", "nova-2": "general" }),
    skill,
    tool: tools.domain,
    mcp: fullContext({ directory: project }).mcp,
    session: {
      get: () => Effect.succeed({} as never),
      switchModel: (input: { sessionID: unknown; model: { providerID: unknown; id: unknown; variant?: unknown } }) =>
        Effect.sync(() => {
          switches.push({ sessionID: input.sessionID, model: input.model })
        }),
    },
  })
  const state = createState()
  const handlers = createHandlers(ctx, state)
  await Effect.runPromise(
    handlers["model.add"]({ level: "project", agent: "alpha", providerID: "acme", modelID: "nova-2" }, throwingContext({})),
  )
  const afterAdd = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const active: Plus.SnapshotModelRecord = {
    type: "model",
    level: "project",
    agent: "alpha",
    providerID: "acme",
    modelID: "nova-2",
    active: true,
    updated: UPDATED,
  }
  const mutated = await Effect.runPromise(
    handlers["instructions.mutate"]({
      expectedRevision: afterAdd.revision,
      expectedGlobalRevision: afterAdd.globalRevision,
      records: [active],
    }, throwingContext({})),
  )
  expect(mutated.ok).toBe(true)
  if (!mutated.ok) throw new Error("expected mutate to succeed")
  // No agent on the event and none on the session: core would resolve the
  // default (first in list, alpha here), so Plus must switch to alpha's model.
  await Effect.runPromise(
    applySessionModel(ctx, state, { type: "session.created", properties: { sessionID: "ses_1" } }),
  )
  expect(switches).toHaveLength(1)
  expect(String(switches[0]?.model.id)).toBe("nova-2")
})

test("a shared change from another Location reaches this Location without discovery", async () => {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-rpc-shared-"))
  roots.push(root)
  const config = path.join(root, "config")
  process.env.OPENCODE_CONFIG_DIR = config
  const projectA = path.join(root, "a")
  const projectB = path.join(root, "b")
  await enable(projectA)
  await enable(projectB)
  const models = [modelInfo("acme", "nova-1"), modelInfo("acme", "nova-9")]
  const makeCtx = (directory: string, agentState: ReturnType<typeof agentHarness>) => {
    const location = fullContext({ directory }).location
    const skillState = skillHarness([])
    const skill = { ...skillState.domain, list: () => Effect.succeed({ location, data: Array.from(skillState.state.values()) }) }
    const tools = toolHarness([])
    return { location, skill, tools, agentState }
  }
  const agentsA = agentHarness([agentInfo("alpha", "upstream role")])
  const partsA = makeCtx(projectA, agentsA)
  const switches: Array<{ sessionID: unknown; model: { providerID: unknown; id: unknown; variant?: unknown } }> = []
  const ctxA = context({
    location: partsA.location,
    agent: agentsA.domain,
    catalog: catalogHarness(models),
    prompt: promptHarness(defaultHostTemplates, { "nova-1": "general", "nova-9": "general" }),
    skill: partsA.skill,
    tool: partsA.tools.domain,
    mcp: fullContext({ directory: projectA }).mcp,
    session: {
      get: () => Effect.succeed({ agent: "alpha", model: { providerID: "acme", id: "nova-1" } } as never),
      switchModel: (input: { sessionID: unknown; model: { providerID: unknown; id: unknown; variant?: unknown } }) =>
        Effect.sync(() => {
          switches.push({ sessionID: input.sessionID, model: input.model })
        }),
    },
  })
  const stateA = createState()
  const handlersA = createHandlers(ctxA, stateA)
  await Effect.runPromise(handlersA["instructions.refresh"](undefined, throwingContext({})))
  // Instance B publishes a shared Defaults model while A is live elsewhere.
  const agentsB = agentHarness([agentInfo("alpha", "upstream role")])
  const partsB = makeCtx(projectB, agentsB)
  const ctxB = context({
    location: partsB.location,
    agent: agentsB.domain,
    catalog: catalogHarness(models),
    prompt: promptHarness(defaultHostTemplates, { "nova-1": "general", "nova-9": "general" }),
    skill: partsB.skill,
    tool: partsB.tools.domain,
    mcp: fullContext({ directory: projectB }).mcp,
  })
  const stateB = createState()
  const handlersB = createHandlers(ctxB, stateB)
  await Effect.runPromise(
    handlersB["model.add"]({ level: "defaults", agent: null, providerID: "acme", modelID: "nova-9" }, throwingContext({})),
  )
  const snapB = await Effect.runPromise(handlersB["instructions.snapshot"](undefined, throwingContext({})))
  const shared: Plus.SnapshotModelRecord = {
    type: "model",
    level: "defaults",
    agent: null,
    providerID: "acme",
    modelID: "nova-9",
    active: true,
    updated: UPDATED,
  }
  const mutatedB = await Effect.runPromise(
    handlersB["instructions.mutate"]({
      expectedRevision: snapB.revision,
      expectedGlobalRevision: snapB.globalRevision,
      records: [shared],
    }, throwingContext({})),
  )
  expect(mutatedB.ok).toBe(true)
  if (!mutatedB.ok) throw new Error("expected B mutate to succeed")
  // A never sees B's publish (Location-filtered Bus): its next session event
  // must still pick up the shared model via cheap store invalidation.
  await Effect.runPromise(
    applySessionModel(ctxA, stateA, { type: "session.created", properties: { sessionID: "ses_shared", agent: "alpha" } }),
  )
  expect(switches).toHaveLength(1)
  expect(String(switches[0]?.model.id)).toBe("nova-9")
})

test("snapshot reports the Plus-active base for a file-backed agent", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const fPath = path.join(project, ".opencode", "agent", "f.md")
  await fs.mkdir(path.dirname(fPath), { recursive: true })
  await Bun.write(fPath, "f body\n")
  const fableCatalog = {
    ...modelInfo("cliproxyapi", "claude-fable-5"),
    variants: [{ id: "max" as never }],
  }
  const models = [modelInfo("acme", "nova-1"), fableCatalog]
  const agents = agentHarness([agentInfo("f", "f upstream", modelRef("acme", "nova-1"))])
  const location = fullContext({ directory: project }).location
  const skillState = skillHarness([])
  const skill = { ...skillState.domain, list: () => Effect.succeed({ location, data: Array.from(skillState.state.values()) }) }
  const tools = toolHarness([])
  const ctx = context({
    location,
    agent: agents.domain,
    catalog: catalogHarness(models),
    prompt: promptHarness(defaultHostTemplates, { "nova-1": "general", "claude-fable-5": "claude" }),
    skill,
    tool: tools.domain,
    mcp: fullContext({ directory: project }).mcp,
  })
  const state = createState()
  const handlers = createHandlers(ctx, state)
  await Effect.runPromise(
    handlers["model.add"](
      { level: "project", agent: "f", providerID: "cliproxyapi", modelID: "claude-fable-5", variant: "max" },
      throwingContext({}),
    ),
  )
  const afterAdd = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const active: Plus.SnapshotModelRecord = {
    type: "model",
    level: "project",
    agent: "f",
    providerID: "cliproxyapi",
    modelID: "claude-fable-5",
    variant: "max",
    active: true,
    updated: UPDATED,
  }
  const mutated = await Effect.runPromise(
    handlers["instructions.mutate"]({
      expectedRevision: afterAdd.revision,
      expectedGlobalRevision: afterAdd.globalRevision,
      records: [active],
    }, throwingContext({})),
  )
  expect(mutated.ok).toBe(true)
  if (!mutated.ok) throw new Error("expected mutate to succeed")
  expect(mutated.snapshot.agents.find((entry) => entry.id === "f")?.base).toBe("claude")
})

test("enabling a fixture team marks its non-file-backed member as plus origin", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const registry = [{ name: "ship", members: [{ id: "mate", body: "ship mate body" }] }]
  const ctx = fullContext({ directory: project })
  const handlers = createHandlers(ctx, createState(), { builtins: registry })
  await Effect.runPromise(handlers["team.setEnabled"]({ level: "defaults", team: "ship", enabled: true }, throwingContext({})))
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const mate = snapshot.agents.find((entry) => entry.id === "mate")
  expect(mate).toBeDefined()
  expect(mate?.scope).toBe("defaults")
  expect(mate?.fileBacked).toBe(false)
  expect(mate?.origin).toBe("plus")
  expectRpcBody(snapshot)
})

test("snapshot reports ancestor-backed agent with ancestor: true and omits the key for local agent", async () => {
  const { project: baseProject } = await tempRoot()
  const parent = path.join(baseProject, "workspace")
  const project = path.join(parent, "project")
  const ancPath = path.join(parent, ".opencode", "agent", "anc.md")
  await fs.mkdir(path.dirname(ancPath), { recursive: true })
  await Bun.write(ancPath, "# ancestor agent\n")

  const localPath = path.join(project, ".opencode", "agent", "local.md")
  await fs.mkdir(path.dirname(localPath), { recursive: true })
  await Bun.write(localPath, "# local agent\n")

  await enable(project)
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("anc", "anc prompt"), agentInfo("local", "local prompt")],
  })
  const handlers = createHandlers(ctx, createState(), { builtins: [] })
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))

  const ancEntry = snapshot.agents.find((entry) => entry.id === "anc")
  expect(ancEntry).toBeDefined()
  expect(ancEntry?.scope).toBe("project")
  expect(ancEntry?.fileBacked).toBe(true)
  expect(ancEntry?.ancestor).toBe(true)

  const localEntry = snapshot.agents.find((entry) => entry.id === "local")
  expect(localEntry).toBeDefined()
  expect(localEntry?.scope).toBe("project")
  expect(localEntry?.fileBacked).toBe(true)
  expect("ancestor" in (localEntry ?? {})).toBe(false)

  expectRpcBody(snapshot)
})

test("agent delete removes customization records so re-created agent does not inherit override", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const handlers = createHandlers(fullContext({ directory: project }), createState())

  await Effect.runPromise(
    handlers["agent.create"]({ scope: "project", id: "alpha", prompt: "First prompt." }, throwingContext({})),
  )

  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const role = snapshot.items.find((item) => item.id === "system:role")
  if (!role) throw new Error("expected system:role")

  const override: Plus.SnapshotCustomizationRecord = {
    type: "customization",
    level: "project",
    agent: "alpha",
    item: "system:role",
    section: null,
    text: "Override prompt.",
    basedOn: role.fingerprint,
    updated: UPDATED,
  }
  const mutated = await Effect.runPromise(
    handlers["instructions.mutate"]({
      expectedRevision: snapshot.revision,
      expectedGlobalRevision: snapshot.globalRevision,
      records: [override],
    }, throwingContext({})),
  )
  expect(mutated.ok).toBe(true)

  const assembledBefore = await Effect.runPromise(handlers["instructions.assembled"]({ agent: "alpha" }, throwingContext({})))
  expect(assembledBefore.system).toEqual(["Override prompt."])

  const deleted = await Effect.runPromise(handlers["agent.delete"]({ scope: "project", id: "alpha" }, throwingContext({})))
  expect(deleted.id).toBe("alpha")
  expectRpcBody(deleted)

  const { load } = await import("../src/instructions/store.js")
  const stored = await load(project)
  const remainingProjectRecords = stored.records.filter(
    (r) => (r.type === "customization" || r.type === "split") && r.agent === "alpha" && r.level === "project",
  )
  expect(remainingProjectRecords).toHaveLength(0)

  const snapshotAfterDelete = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const remainingSnapshotRecords = snapshotAfterDelete.records.filter((r) => r.agent === "alpha" && r.level === "project")
  expect(remainingSnapshotRecords).toHaveLength(0)

  await Effect.runPromise(
    handlers["agent.create"]({ scope: "project", id: "alpha", prompt: "Different second prompt." }, throwingContext({})),
  )

  const assembledAfter = await Effect.runPromise(handlers["instructions.assembled"]({ agent: "alpha" }, throwingContext({})))
  expect(assembledAfter.system).toEqual(["Different second prompt."])
  expectRpcBody(assembledAfter)
})

test("agent delete shadowing guard keeps global records when project agent is deleted", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const handlers = createHandlers(fullContext({ directory: project }), createState())

  await Effect.runPromise(
    handlers["agent.create"]({ scope: "global", id: "alpha", prompt: "Global prompt." }, throwingContext({})),
  )
  await Effect.runPromise(
    handlers["agent.create"]({ scope: "project", id: "alpha", prompt: "Project prompt." }, throwingContext({})),
  )

  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const role = snapshot.items.find((item) => item.id === "system:role")
  if (!role) throw new Error("expected system:role")

  const globalOverride: Plus.SnapshotCustomizationRecord = {
    type: "customization",
    level: "global",
    agent: "alpha",
    item: "system:role",
    section: null,
    text: "Global override.",
    basedOn: role.fingerprint,
    updated: UPDATED,
  }
  const projectOverride: Plus.SnapshotCustomizationRecord = {
    type: "customization",
    level: "project",
    agent: "alpha",
    item: "system:role",
    section: null,
    text: "Project override.",
    basedOn: role.fingerprint,
    updated: UPDATED,
  }
  const mutated = await Effect.runPromise(
    handlers["instructions.mutate"]({
      expectedRevision: snapshot.revision,
      expectedGlobalRevision: snapshot.globalRevision,
      records: [globalOverride, projectOverride],
    }, throwingContext({})),
  )
  expect(mutated.ok).toBe(true)

  const deleted = await Effect.runPromise(handlers["agent.delete"]({ scope: "project", id: "alpha" }, throwingContext({})))
  expect(deleted.id).toBe("alpha")
  expectRpcBody(deleted)

  const { load } = await import("../src/instructions/store.js")
  const stored = await load(project)
  const projectRecords = stored.records.filter(
    (r) => (r.type === "customization" || r.type === "split") && r.agent === "alpha" && r.level === "project",
  )
  expect(projectRecords).toHaveLength(0)

  const globalRecords = stored.records.filter(
    (r) => (r.type === "customization" || r.type === "split") && r.agent === "alpha" && r.level === "global",
  )
  expect(globalRecords).toHaveLength(1)
  expect(globalRecords[0].type).toBe("customization")
  if (globalRecords[0].type === "customization") {
    expect(globalRecords[0].text).toBe("Global override.")
  }

  const snapshotAfter = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const snapshotProjectRecords = snapshotAfter.records.filter((r) => r.agent === "alpha" && r.level === "project")
  expect(snapshotProjectRecords).toHaveLength(0)

  const snapshotGlobalRecords = snapshotAfter.records.filter((r) => r.agent === "alpha" && r.level === "global")
  expect(snapshotGlobalRecords).toHaveLength(1)
  expect(snapshotGlobalRecords[0].type).toBe("customization")
  if (snapshotGlobalRecords[0].type === "customization") {
    expect(snapshotGlobalRecords[0].text).toBe("Global override.")
  }
})

test("base delete drops customizations so re-created base resolves new body", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const handlers = createHandlers(fullContext({ directory: project }), createState())

  await Effect.runPromise(
    handlers["base.create"]({ id: "custom", title: "Custom Base", text: "Original base." }, throwingContext({})),
  )

  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const baseItem = snapshot.items.find((item) => item.id === "base:custom")
  expect(baseItem).toBeDefined()
  expect(baseItem?.text).toBe("Original base.")

  const mutated = await Effect.runPromise(
    handlers["instructions.mutate"](
      {
        expectedRevision: snapshot.revision,
        expectedGlobalRevision: snapshot.globalRevision,
        records: [
          record("base:custom", {
            level: "defaults",
            agent: null,
            text: "RESURRECTED BASE",
            basedOn: baseItem!.fingerprint,
          }),
        ],
      },
      throwingContext({}),
    ),
  )
  expect(mutated.ok).toBe(true)
  expect(
    mutated.snapshot.records.some(
      (r) => (r.type === "customization" || r.type === "split") && r.item === "base:custom",
    ),
  ).toBe(true)

  const shownBefore = show(mutated.snapshot, { id: "base:custom", view: "resolved" })
  expect(shownBefore.text).toBe("RESURRECTED BASE")

  const deleted = await Effect.runPromise(handlers["base.delete"]({ id: "custom" }, throwingContext({})))
  expect(deleted).toEqual({ id: "custom" })
  expectRpcBody(deleted)

  const stored = await load(project)
  const remainingStored = stored.records.filter(
    (r) => (r.type === "customization" || r.type === "split") && r.item === "base:custom",
  )
  expect(remainingStored).toHaveLength(0)

  const snapshotAfterDelete = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const remainingSnapshot = snapshotAfterDelete.records.filter(
    (r) => (r.type === "customization" || r.type === "split") && r.item === "base:custom",
  )
  expect(remainingSnapshot).toHaveLength(0)
  expect(snapshotAfterDelete.items.some((item) => item.id === "base:custom")).toBe(false)

  await Effect.runPromise(
    handlers["base.create"]({ id: "custom", title: "Custom Base", text: "Brand new second base." }, throwingContext({})),
  )

  const snapshotAfterRecreate = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  expect(
    snapshotAfterRecreate.records.some(
      (r) => (r.type === "customization" || r.type === "split") && r.item === "base:custom",
    ),
  ).toBe(false)

  const shownAfter = show(snapshotAfterRecreate, { id: "base:custom", view: "resolved" })
  expect(shownAfter.text).toBe("Brand new second base.")
  expect(shownAfter.text).not.toBe("RESURRECTED BASE")
})

test("instruction delete drops customizations so re-created instruction resolves new body", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const handlers = createHandlers(fullContext({ directory: project }), createState())

  const created = await Effect.runPromise(
    handlers["instruction.create"]({ name: "AGENTS.md", text: "Original instruction." }, throwingContext({})),
  )
  expect(created.id).toBe("system:AGENTS.md")

  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const instrItem = snapshot.items.find((item) => item.id === "system:AGENTS.md")
  expect(instrItem).toBeDefined()
  expect(instrItem?.text).toBe("Original instruction.\n")

  const mutated = await Effect.runPromise(
    handlers["instructions.mutate"](
      {
        expectedRevision: snapshot.revision,
        expectedGlobalRevision: snapshot.globalRevision,
        records: [
          record("system:AGENTS.md", {
            level: "defaults",
            agent: null,
            text: "RESURRECTED INSTR",
            basedOn: instrItem!.fingerprint,
          }),
        ],
      },
      throwingContext({}),
    ),
  )
  expect(mutated.ok).toBe(true)
  expect(
    mutated.snapshot.records.some(
      (r) => (r.type === "customization" || r.type === "split") && r.item === "system:AGENTS.md",
    ),
  ).toBe(true)

  const shownBefore = show(mutated.snapshot, { id: "system:AGENTS.md", view: "resolved" })
  expect(shownBefore.text).toBe("RESURRECTED INSTR")

  const deleted = await Effect.runPromise(handlers["instruction.delete"]({ name: "AGENTS.md" }, throwingContext({})))
  expect(deleted.id).toBe("system:AGENTS.md")
  expectRpcBody(deleted)

  const stored = await load(project)
  const remainingStored = stored.records.filter(
    (r) => (r.type === "customization" || r.type === "split") && r.item === "system:AGENTS.md",
  )
  expect(remainingStored).toHaveLength(0)

  const snapshotAfterDelete = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const remainingSnapshot = snapshotAfterDelete.records.filter(
    (r) => (r.type === "customization" || r.type === "split") && r.item === "system:AGENTS.md",
  )
  expect(remainingSnapshot).toHaveLength(0)
  expect(snapshotAfterDelete.items.some((item) => item.id === "system:AGENTS.md")).toBe(false)

  await Effect.runPromise(
    handlers["instruction.create"]({ name: "AGENTS.md", text: "Brand new second instruction." }, throwingContext({})),
  )

  const snapshotAfterRecreate = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  expect(
    snapshotAfterRecreate.records.some(
      (r) => (r.type === "customization" || r.type === "split") && r.item === "system:AGENTS.md",
    ),
  ).toBe(false)

  const shownAfter = show(snapshotAfterRecreate, { id: "system:AGENTS.md", view: "resolved" })
  expect(shownAfter.text).toBe("Brand new second instruction.\n")
  expect(shownAfter.text).not.toBe("RESURRECTED INSTR")
})

test("mcp remove drops customizations from global store so re-created mcp resolves new body", async () => {
  const { project } = await tempRoot()
  await enable(project)

  const baseMcp = mcpHarness([])
  const mcp = {
    ...baseMcp.domain,
    transform: (callback: Parameters<typeof baseMcp.domain.transform>[0]) =>
      baseMcp.domain.transform((editor) => {
        const servers = new Map(readProjectMcp(project))
        callback({
          ...editor,
          list: () => Array.from(servers.entries()),
          get: (name: string) => servers.get(name),
        })
      }),
  }
  const ctx = context({
    location: fullContext({ directory: project }).location,
    agent: agentHarness([]).domain,
    skill: skillHarness([]).domain,
    tool: toolHarness([]).domain,
    mcp,
  })
  const handlers = createHandlers(ctx, createState())

  const added = await Effect.runPromise(
    handlers["mcp.add"](
      { name: "fetch", config: { type: "remote", url: "https://example.com/mcp" } },
      throwingContext({}),
    ),
  )
  expect(added).toEqual({ name: "fetch" })

  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const mcpItem = snapshot.items.find((item) => item.id === "mcp:fetch")
  expect(mcpItem).toBeDefined()
  expect(mcpItem?.text).toBe(JSON.stringify({ type: "remote", url: "https://example.com/mcp" }))

  const mutated = await Effect.runPromise(
    handlers["instructions.mutate"](
      {
        expectedRevision: snapshot.revision,
        expectedGlobalRevision: snapshot.globalRevision,
        records: [
          record("mcp:fetch", {
            level: "defaults",
            agent: null,
            text: "RESURRECTED MCP",
            basedOn: mcpItem!.fingerprint,
          }),
        ],
      },
      throwingContext({}),
    ),
  )
  expect(mutated.ok).toBe(true)
  expect(
    mutated.snapshot.records.some(
      (r) => (r.type === "customization" || r.type === "split") && r.item === "mcp:fetch" && r.level === "defaults",
    ),
  ).toBe(true)

  const shownBefore = show(mutated.snapshot, { id: "mcp:fetch", view: "resolved" })
  expect(shownBefore.text).toBe("RESURRECTED MCP")

  const removed = await Effect.runPromise(handlers["mcp.remove"]({ name: "fetch" }, throwingContext({})))
  expect(removed).toEqual({ name: "fetch" })
  expectRpcBody(removed)

  const stored = await load(project)
  const remainingGlobalRecords = stored.records.filter(
    (r) => (r.type === "customization" || r.type === "split") && r.item === "mcp:fetch" && r.level === "defaults",
  )
  expect(remainingGlobalRecords).toHaveLength(0)

  const globalText = await Bun.file(globalRecordsPath()).text()
  expect(globalText).not.toContain("mcp:fetch")

  const snapshotAfterRemove = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const remainingSnapshot = snapshotAfterRemove.records.filter(
    (r) => (r.type === "customization" || r.type === "split") && r.item === "mcp:fetch",
  )
  expect(remainingSnapshot).toHaveLength(0)
  expect(snapshotAfterRemove.items.some((item) => item.id === "mcp:fetch")).toBe(false)

  await Effect.runPromise(
    handlers["mcp.add"](
      { name: "fetch", config: { type: "remote", url: "https://different.example.com/mcp" } },
      throwingContext({}),
    ),
  )

  const snapshotAfterRecreate = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  expect(
    snapshotAfterRecreate.records.some(
      (r) => (r.type === "customization" || r.type === "split") && r.item === "mcp:fetch",
    ),
  ).toBe(false)

  const shownAfter = show(snapshotAfterRecreate, { id: "mcp:fetch", view: "resolved" })
  const expectedNewText = JSON.stringify({ type: "remote", url: "https://different.example.com/mcp" })
  expect(shownAfter.text).toBe(expectedNewText)
  expect(shownAfter.text).not.toBe("RESURRECTED MCP")
})
