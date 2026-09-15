import { afterEach, expect, test } from "bun:test"
import type { Rpc } from "@opencode/schema/rpc"
import { Schema } from "effect"
import { Effect, Exit } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHandlers, createState, type PlusState } from "../src/index.js"
import { fingerprint } from "../src/instructions/model.js"
import { enable } from "../src/project.js"
import { Plus } from "../src/rpc.js"
import { agentHarness, agentInfo, context, fullContext, skillHarness, skillInfo, toolHarness } from "./harness.js"

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
  const handlers = createHandlers(fullContext({ directory: project, agents: [agentInfo("alpha", "upstream")] }), createState())
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
