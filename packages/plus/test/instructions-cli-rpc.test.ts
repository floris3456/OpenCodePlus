// Real-boundary tests for the `instructions.ops` / `instructions.run` RPC
// (B18): the handlers enumerate the live instruction tools and run one through
// the same implementation the model calls. The fixture is a full plugin
// activation over the stateful harness, not a mock of the tool registry or the
// store, so a broken registration or actor seam fails here.

import { afterEach, expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"
import { InstructionsClipboardOutput } from "../src/rpc.js"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { activate, createHandlers, createPlusApi, createState, deactivate, type PlusState } from "../src/index.js"
import { agentInfo, fullContext, skillInfo } from "./harness.js"

const roots: string[] = []
const priorConfigDir = process.env.OPENCODE_CONFIG_DIR

afterEach(async () => {
  if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function tempProject(): Promise<string> {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-cli-rpc-"))
  roots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  return path.join(root, "project")
}

function fixtureContext(project: string): Context {
  return fullContext({
    directory: project,
    agents: [agentInfo("alpha", "upstream role"), agentInfo("build", "build role")],
    tools: [
      { id: "reader", description: "read things", options: { codemode: false } },
      { id: "skill", description: "Load a skill", options: { codemode: false } },
    ],
    skills: [skillInfo("notes", "skill body")],
    session: { hook: () => Effect.succeed({ dispose: Effect.void }) },
  })
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

function toolContext(): Tool.Context {
  return {
    sessionID: Session.ID.make("ses_cli_test"),
    agent: Agent.ID.make("alpha"),
    messageID: SessionMessage.ID.make("msg_cli_test"),
    id: Tool.CallID.make("call_cli_test"),
    progress: () => Effect.void,
  }
}

interface Fixture {
  readonly ctx: Context
  readonly api: ReturnType<typeof createPlusApi>
  readonly handlers: ReturnType<typeof createHandlers>
  readonly state: PlusState
}

async function activatedFixture(): Promise<Fixture> {
  const ctx = fixtureContext(await tempProject())
  const state = createState()
  await Effect.runPromise(activate(ctx, state))
  return { ctx, api: createPlusApi(ctx, state), handlers: createHandlers(ctx, state), state }
}

async function invoke<Name extends keyof ReturnType<typeof createHandlers>>(
  handlers: Fixture["handlers"],
  name: Name,
  input: unknown,
): Promise<unknown> {
  const captured: { current?: CapturedError } = {}
  return Effect.runPromise(
    (handlers[name] as (input: unknown, context: unknown) => Effect.Effect<unknown, unknown>)(
      input,
      throwingContext(captured),
    ),
  )
}

async function directTool(ctx: Context, id: string, input: unknown): Promise<unknown> {
  const tool = (await Effect.runPromise(ctx.tool.list())).find((candidate) => candidate.id === id)
  if (tool === undefined) throw new Error(`missing tool ${id}`)
  const result = await Effect.runPromise(tool.execute(input, toolContext()))
  return (result as { readonly output?: unknown }).output
}

test("ops are enumerated from the live instruction tools with their schemas", async () => {
  const fixture = await activatedFixture()
  try {
    const output = (await invoke(fixture.handlers, "instructions.ops", undefined)) as {
      ops: Array<{ op: string; description: string; input: Record<string, unknown> }>
    }
    const names = output.ops.map((op) => op.op)
    expect(names).toEqual([...names].toSorted((a, b) => a.localeCompare(b)))
    for (const expected of ["list", "show", "set", "move", "reset", "split", "create", "delete", "log"]) {
      expect(names).toContain(expected)
    }
    const show = output.ops.find((op) => op.op === "show")!
    const properties = (show.input as { properties?: Record<string, unknown> }).properties
    expect(properties?.id).toBeDefined()
    expect(show.description.length).toBeGreaterThan(0)
  } finally {
    await Effect.runPromise(deactivate(fixture.state))
  }
})

test("run returns the same result as the tool implementation for a read op", async () => {
  const fixture = await activatedFixture()
  try {
    const input = { limit: 5 }
    const direct = await directTool(fixture.ctx, "instructions_list", input)
    const viaRpc = await invoke(fixture.handlers, "instructions.run", { op: "list", input })
    expect(viaRpc).toEqual(direct)
  } finally {
    await Effect.runPromise(deactivate(fixture.state))
  }
})

test("show by id matches the tool operation", async () => {
  const fixture = await activatedFixture()
  try {
    const listed = (await directTool(fixture.ctx, "instructions_list", { limit: 6082 })) as {
      rows?: Array<{ id: string }>
    }
    const id = listed.rows?.find((row) => row.id.includes("tool:reader"))?.id
    if (id === undefined) throw new Error("fixture listed no rows")
    const direct = await directTool(fixture.ctx, "instructions_show", { id, view: "resolved" })
    const viaRpc = await invoke(fixture.handlers, "instructions.run", { op: "show", input: { id, view: "resolved" } })
    expect(viaRpc).toEqual(direct)
  } finally {
    await Effect.runPromise(deactivate(fixture.state))
  }
})

test("a write through the RPC records the actor as cli", async () => {
  const fixture = await activatedFixture()
  try {
    const listed = (await directTool(fixture.ctx, "instructions_list", { limit: 6082 })) as {
      rows?: Array<{ id: string }>
    }
    const id = listed.rows?.find((row) => row.id.includes("tool:reader"))?.id
    if (id === undefined) throw new Error("fixture has no tool:reader row")
    const result = (await invoke(fixture.handlers, "instructions.run", {
      op: "set",
      input: { id },
    })) as { status?: string }
    expect(typeof result.status).toBe("string")
    const log = await fixture.api.log({ where: "actor:cli" })
    expect(log.value.entries.length).toBeGreaterThan(0)
    expect(log.value.entries[0]!.actor).toEqual({ type: "cli" })
  } finally {
    await Effect.runPromise(deactivate(fixture.state))
  }
})

test("a reflected write through the TUI command runner retains its human actor", async () => {
  const project = await tempProject()
  await Bun.write(path.join(project, ".opencodeplus", "project.json"), JSON.stringify({ version: 1, protectedAgents: ["alpha"] }))
  const ctx = fixtureContext(project)
  const state = createState()
  await Effect.runPromise(activate(ctx, state))
  const fixture = { ctx, state, handlers: createHandlers(ctx, state), api: createPlusApi(ctx, state) }
  try {
    const id = "item:defaults:alpha:tool:reader"
    const refused = await invoke(fixture.handlers, "instructions.run", {
      op: "batch", input: { op: "set", id, selected: [id], input: { text: "CLI edit" } },
    })
    expect(refused).toMatchObject({ applied: [], failed: [{ id, reason: expect.stringContaining("protected") }] })
    const result = await invoke(fixture.handlers, "instructions.run", {
      op: "batch", actor: { type: "tui" },
      input: { op: "set", id, selected: [id], input: { text: "Human edit" } },
    })
    expect(result).toEqual({ applied: [id], skipped: [], failed: [] })
    const log = await fixture.api.log({ where: "actor:tui" })
    expect(log.value.entries.some((entry) => entry.actor.type === "tui" && entry.target.includes("reader"))).toBe(true)
    const cli = await fixture.api.log({ where: "actor:cli" })
    expect(cli.value.entries).toEqual([])
  } finally {
    await Effect.runPromise(deactivate(fixture.state))
  }
})

test("an unknown op refuses by value, naming the known ops", async () => {
  const fixture = await activatedFixture()
  try {
    const result = (await invoke(fixture.handlers, "instructions.run", { op: "nope", input: {} })) as {
      error: { message: string; usage?: boolean }
    }
    expect(result.error.message).toContain('op.unknown: unknown op "nope"')
    expect(result.error.message).toContain("known: ")
    expect(result.error.usage).toBeUndefined()
  } finally {
    await Effect.runPromise(deactivate(fixture.state))
  }
})

test("clipboard RPC copies frozen configuration and failed or cancelled cuts leave the store unchanged", async () => {
  const fixture = await activatedFixture()
  try {
    const id = "item:defaults:alpha:tool:reader"
    await invoke(fixture.handlers, "instructions.run", { op: "set", input: { id, text: "Captured description" } })
    const copy = Schema.decodeUnknownSync(InstructionsClipboardOutput)(await invoke(fixture.handlers, "instructions.run", {
      op: "clipboard", input: { action: "copy", ids: [id] },
    }))
    await invoke(fixture.handlers, "instructions.run", { op: "set", input: { id, text: "Later source description" } })
    const pasted = await invoke(fixture.handlers, "instructions.run", { op: "clipboard", input: { action: "paste", clipboard: copy.clipboard, into: "group:project:build:tools" } })
    expect(pasted).toMatchObject({ consumed: false, rows: ["item:project:build:tool:reader"] })
    const saved = (await fixture.api.snapshot()).value
    expect(saved.records).toContainEqual(expect.objectContaining({ type: "customization", level: "project", agent: "build", item: "tool:reader", text: "Captured description" }))
    expect(saved.records).toContainEqual(expect.objectContaining({ type: "customization", level: "defaults", agent: "alpha", item: "tool:reader", text: "Later source description" }))
    const cut = Schema.decodeUnknownSync(InstructionsClipboardOutput)(await invoke(fixture.handlers, "instructions.run", { op: "clipboard", input: { action: "cut", ids: [id] } }))
    const failed = await invoke(fixture.handlers, "instructions.run", { op: "clipboard", input: { action: "paste", clipboard: cut.clipboard, into: "group:project:build:system" } })
    expect(failed).toHaveProperty("error")
    expect((await fixture.api.snapshot()).value.records).toEqual(saved.records)
    await invoke(fixture.handlers, "instructions.run", { op: "clipboard", input: { action: "clear", clipboard: cut.clipboard } })
    expect((await fixture.api.snapshot()).value.records).toEqual(saved.records)
    expect(await invoke(fixture.handlers, "instructions.run", { op: "clipboard", input: { action: "paste", clipboard: cut.clipboard, into: "group:project:build:tools" } })).toHaveProperty("error")
    const moving = Schema.decodeUnknownSync(InstructionsClipboardOutput)(await invoke(fixture.handlers, "instructions.run", { op: "clipboard", input: { action: "cut", ids: [id] } }))
    const moved = await invoke(fixture.handlers, "instructions.run", { op: "clipboard", input: { action: "paste", clipboard: moving.clipboard, into: "group:project:build:tools" } })
    expect(moved).toMatchObject({ consumed: true })
    const after = (await fixture.api.snapshot()).value
    expect(after.records).toContainEqual(expect.objectContaining({ type: "customization", level: "defaults", agent: "alpha", item: "tool:reader", state: "off" }))
    expect(after.records).toContainEqual(expect.objectContaining({ type: "customization", level: "project", agent: "build", item: "tool:reader", text: "Later source description" }))
    const record = after.records.find((record) => record.type === "customization" && record.item === "tool:reader")
    if (record?.type !== "customization") throw new Error("missing transferred configuration")
    const invalid = await fixture.api.layoutWrite({
      expectedProjectRevision: after.revision, expectedGlobalRevision: after.globalRevision,
      folders: [], orders: [], target: "invalid-transfer", status: "Invalid transfer",
      changes: { upsert: [{ ...record, item: "toolmode:reader", state: undefined, text: "invalid-mode" }], remove: [] },
    })
    expect(invalid.ok).toBe(false)
    expect((await fixture.api.snapshot()).value.records).toEqual(after.records)
    expect((await fixture.api.snapshot()).value.orders).toEqual(after.orders)
  } finally {
    await Effect.runPromise(deactivate(fixture.state))
  }
})

test("batch creation keeps the new resource id and rebases owner and tool fields", async () => {
  const fixture = await activatedFixture()
  try {
    const rows = ["item:defaults:alpha:tool:reader", "item:project:build:tool:reader"]
    const created = await invoke(fixture.handlers, "instructions.run", {
      op: "batch", actor: { type: "tui" },
      input: { op: "create", id: rows[0], selected: rows, input: { kind: "rule", id: "shared-name", label: "Selected rule", patterns: ["*.txt"] } },
    })
    expect(created).toEqual({ applied: rows, skipped: [], failed: [] })
    const snapshot = (await fixture.api.snapshot()).value
    expect(snapshot.records.filter((record) => record.type === "rule" && record.id === "shared-name")).toEqual(expect.arrayContaining([
      expect.objectContaining({ agent: "alpha", level: "defaults", tool: "reader" }),
      expect.objectContaining({ agent: "build", level: "project", tool: "reader" }),
    ]))
    expect(snapshot.records.filter((record) => record.type === "rule" && record.id.includes("item:"))).toEqual([])
  } finally {
    await Effect.runPromise(deactivate(fixture.state))
  }
})

test("a schema-invalid input is a usage refusal", async () => {
  const fixture = await activatedFixture()
  try {
    const result = (await invoke(fixture.handlers, "instructions.run", { op: "show", input: {} })) as {
      error: { message: string; usage?: boolean }
    }
    expect(result.error.usage).toBe(true)
    expect(result.error.message).toContain("Invalid arguments")
  } finally {
    await Effect.runPromise(deactivate(fixture.state))
  }
})

test("an operation refusal is not a usage error", async () => {
  const fixture = await activatedFixture()
  try {
    const result = (await invoke(fixture.handlers, "instructions.run", {
      op: "set",
      input: { id: "item:project:alpha:missing:section:none", state: "off" },
    })) as { error: { message: string; usage?: boolean } }
    expect(result.error.message).toContain("row.unknown")
    expect(result.error.usage).toBeUndefined()
  } finally {
    await Effect.runPromise(deactivate(fixture.state))
  }
})
