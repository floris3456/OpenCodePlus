import { afterEach, expect, test } from "bun:test"
import { Agent } from "@opencode/schema/agent"
import { Location } from "@opencode/schema/location"
import { Project } from "@opencode/schema/project"
import type { Rpc } from "@opencode/schema/rpc"
import { AbsolutePath } from "@opencode/schema/schema"
import { Effect, Exit, Schema } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHandlers, createState, type PlusState } from "../src/index.js"
import { load } from "../src/instructions/store.js"
import { enable } from "../src/project.js"
import { Plus } from "../src/rpc.js"
import { context } from "./harness.js"

test("definition id, methods, and events contract", () => {
  expect(Plus.Definition.id).toBe("opencode.plus")
  expect("project.status" in Plus.Definition.methods).toBe(true)
  expect("project.enable" in Plus.Definition.methods).toBe(true)
  expect("project.disable" in Plus.Definition.methods).toBe(true)
  expect("project.changed" in Plus.Definition.events).toBe(true)
})

test("status schema round-trip", () => {
  const status = { enabled: true, directory: "/path/to/project" }
  const encoded = Schema.encodeSync(Plus.Status)(status)
  const decoded = Schema.decodeUnknownSync(Plus.Status)(encoded)
  expect(decoded).toEqual(status)

  const disabledStatus = { enabled: false, directory: "/another/dir" }
  const encodedDisabled = Schema.encodeSync(Plus.Status)(disabledStatus)
  const decodedDisabled = Schema.decodeUnknownSync(Plus.Status)(encodedDisabled)
  expect(decodedDisabled).toEqual(disabledStatus)
})

test("instructions and agent methods and the instructions.changed event are present", () => {
  expect("instructions.snapshot" in Plus.Definition.methods).toBe(true)
  expect("instructions.mutate" in Plus.Definition.methods).toBe(true)
  expect("instructions.refresh" in Plus.Definition.methods).toBe(true)
  expect("agent.create" in Plus.Definition.methods).toBe(true)
  expect("agent.rename" in Plus.Definition.methods).toBe(true)
  expect("agent.delete" in Plus.Definition.methods).toBe(true)
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

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-rpc-"))
  roots.push(root)
  return root
}

function testLocation(directory: string): Location.Info {
  const absolute = AbsolutePath.make(directory)
  return new Location.Info({
    directory: absolute,
    project: { id: Project.ID.global, directory: absolute, canonical: absolute },
  })
}

function emptyHost(directory: string, agents: Agent.Info[] = []) {
  const location = testLocation(directory)
  return context({
    location,
    agent: {
      get: () => Effect.die("unused agent.get"),
      list: () => Effect.succeed({ location, data: agents }),
      transform: () => Effect.die("unused agent.transform"),
      reload: () => Effect.die("unused agent.reload"),
    },
    skill: {
      list: () => Effect.succeed({ location, data: [] }),
      transform: () => Effect.die("unused skill.transform"),
      reload: () => Effect.die("unused skill.reload"),
    },
    tool: {
      transform: (callback) =>
        Effect.sync(() => {
          callback({
            list: () => [],
            get: () => undefined,
            namespace: () => undefined,
            add: () => undefined,
            update: () => undefined,
            remove: () => undefined,
          })
          return { dispose: Effect.void }
        }),
      reload: () => Effect.die("unused tool.reload"),
      hook: () => Effect.die("unused tool.hook"),
    },
    mcp: {
      list: () => Effect.die("unused mcp.list"),
      transform: (callback) =>
        Effect.sync(() => {
          callback({
            list: () => [],
            get: () => undefined,
            set: () => undefined,
            update: () => undefined,
            remove: () => undefined,
          })
          return { dispose: Effect.void }
        }),
      reload: () => Effect.die("unused mcp.reload"),
    },
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

function customization(item: string, overrides?: { text?: string; agent?: string }) {
  return {
    item,
    agent: overrides?.agent ?? "*",
    ...(overrides?.text === undefined ? {} : { text: overrides.text }),
    state: "inherit" as const,
    basedOn: "fingerprint-1",
    updated: UPDATED,
  }
}

// Core serves RPC results as JSON through HttpApi, whose success schema is
// the canonical JSON codec of RpcOutput. Unknown encodes to Json on that
// path, so a present-but-undefined key fails with "Expected JSON value".
const RpcBody = Schema.toCodecJson(Schema.Struct({ output: Schema.optionalKey(Schema.Unknown) }))

function expectRpcBody(value: unknown) {
  expect(() => Schema.encodeUnknownSync(RpcBody)({ output: value })).not.toThrow()
}

test("gated methods fail with project.disabled when project mode is off", async () => {
  const directory = await tempDir()
  const handlers = createHandlers(emptyHost(directory), createState())
  const captured: { current?: CapturedError } = {}
  await expectDeclaredError(
    handlers["instructions.snapshot"](undefined, throwingContext(captured)),
    captured,
    "project.disabled",
  )
  await expectDeclaredError(
    handlers["instructions.mutate"]({ expectedRevision: 0, customizations: [] }, throwingContext(captured)),
    captured,
    "project.disabled",
  )
  await expectDeclaredError(
    handlers["instructions.refresh"](undefined, throwingContext(captured)),
    captured,
    "project.disabled",
  )
  await expectDeclaredError(
    handlers["agent.create"]({ scope: "project", id: "alpha", prompt: "hello" }, throwingContext(captured)),
    captured,
    "project.disabled",
  )
  await expectDeclaredError(
    handlers["agent.rename"]({ scope: "project", from: "alpha", to: "beta" }, throwingContext(captured)),
    captured,
    "project.disabled",
  )
  await expectDeclaredError(
    handlers["agent.delete"]({ scope: "project", id: "alpha" }, throwingContext(captured)),
    captured,
    "project.disabled",
  )
  const status = await Effect.runPromise(handlers["project.status"](undefined, throwingContext(captured)))
  expect(status).toEqual({ enabled: false, directory })
})

test("stale mutate returns a conflict without discarding stored data", async () => {
  const directory = await tempDir()
  await enable(directory)
  const handlers = createHandlers(emptyHost(directory), createState())
  const seeded = await Effect.runPromise(
    handlers["instructions.mutate"](
      { expectedRevision: 0, customizations: [customization("item-1", { text: "first" })] },
      throwingContext({}),
    ),
  )
  expect(seeded.ok).toBe(true)
  if (!seeded.ok) throw new Error("expected seed to succeed")

  const stale = await Effect.runPromise(
    handlers["instructions.mutate"](
      { expectedRevision: 0, customizations: [customization("item-1", { text: "second" })] },
      throwingContext({}),
    ),
  )
  expect(stale.ok).toBe(false)
  if (stale.ok) throw new Error("expected stale conflict")
  expect(stale.reason).toBe("stale")
  expect(stale.snapshot.revision).toBe(1)
  expect(stale.snapshot.customizations).toEqual(seeded.snapshot.customizations)
  expect(await load(directory)).toEqual({ revision: 1, customizations: [...seeded.snapshot.customizations] })
})

test("successful mutate persists, emits instructions.changed, and skips no-op emits", async () => {
  const directory = await tempDir()
  await enable(directory)
  const state = createState()
  const emitted = captureEmits(state)
  const handlers = createHandlers(emptyHost(directory), state)

  const first = await Effect.runPromise(
    handlers["instructions.mutate"](
      { expectedRevision: 0, customizations: [customization("item-1", { text: "first" })] },
      throwingContext({}),
    ),
  )
  expect(first.ok).toBe(true)
  if (!first.ok) throw new Error("expected mutate to succeed")
  expect(first.revision).toBe(1)
  expect(await load(directory)).toEqual({ revision: 1, customizations: [...first.snapshot.customizations] })
  expect(emitted).toEqual([{ name: "instructions.changed", data: { revision: 1 } }])

  const noop = await Effect.runPromise(
    handlers["instructions.mutate"](
      { expectedRevision: 1, customizations: [customization("item-1", { text: "first" })] },
      throwingContext({}),
    ),
  )
  expect(noop.ok).toBe(true)
  if (!noop.ok) throw new Error("expected no-op mutate to succeed")
  expect(noop.revision).toBe(1)
  expect(emitted).toHaveLength(1)
})

test("agent.create writes the file and the snapshot marks it file-backed", async () => {
  const directory = await tempDir()
  await enable(directory)
  const state = createState()
  const emitted = captureEmits(state)
  const hostAgents = [Agent.Info.default(Agent.ID.make("alpha"))]
  const handlers = createHandlers(emptyHost(directory, hostAgents), state)

  const created = await Effect.runPromise(
    handlers["agent.create"](
      { scope: "project", id: "alpha", fields: { description: "test agent" }, prompt: "Be helpful." },
      throwingContext({}),
    ),
  )
  expect(created).toEqual({ id: "alpha", path: path.join(directory, ".opencode", "agent", "alpha.md") })
  expect(await Bun.file(created.path).text()).toContain("Be helpful.")
  expect(emitted).toEqual([{ name: "instructions.changed", data: { revision: 0 } }])

  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  expect(snapshot.revision).toBe(0)
  expect(snapshot.agents).toEqual([
    { id: "alpha", scope: "project", path: created.path, fileBacked: true },
  ])

  const refreshed = await Effect.runPromise(handlers["instructions.refresh"](undefined, throwingContext({})))
  expect(refreshed).toEqual(snapshot)
  expect(emitted).toHaveLength(1)
})

test("agent file conflicts surface as declared errors", async () => {
  const directory = await tempDir()
  await enable(directory)
  const handlers = createHandlers(emptyHost(directory), createState())

  await Effect.runPromise(
    handlers["agent.create"]({ scope: "project", id: "alpha", prompt: "first" }, throwingContext({})),
  )
  const duplicate: { current?: CapturedError } = {}
  await expectDeclaredError(
    handlers["agent.create"]({ scope: "project", id: "alpha", prompt: "second" }, throwingContext(duplicate)),
    duplicate,
    "agent.exists",
  )

  const missing: { current?: CapturedError } = {}
  await expectDeclaredError(
    handlers["agent.rename"](
      { scope: "project", from: "ghost", to: "beta" },
      throwingContext(missing),
    ),
    missing,
    "agent.missing",
  )

  const renamed = await Effect.runPromise(
    handlers["agent.rename"]({ scope: "project", from: "alpha", to: "beta" }, throwingContext({})),
  )
  expect(renamed).toEqual({
    from: "alpha",
    to: "beta",
    path: path.join(directory, ".opencode", "agent", "beta.md"),
  })
  expect(await Bun.file(renamed.path).exists()).toBe(true)

  const deleted = await Effect.runPromise(
    handlers["agent.delete"]({ scope: "project", id: "beta" }, throwingContext({})),
  )
  expect(deleted).toEqual({ id: "beta", path: path.join(directory, ".opencode", "agent", "beta.md") })
  expect(await Bun.file(deleted.path).exists()).toBe(false)
})

test("snapshot with a builtin agent omits path and survives core's rpc body check", async () => {
  const directory = await tempDir()
  await enable(directory)
  const hostAgents = [Agent.Info.default(Agent.ID.make("ghost"))]
  const handlers = createHandlers(emptyHost(directory, hostAgents), createState())

  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  expect(snapshot.agents).toEqual([{ id: "ghost", scope: "builtin", fileBacked: false }])
  expect("path" in snapshot.agents[0]).toBe(false)
  expectRpcBody(snapshot)

  const refreshed = await Effect.runPromise(handlers["instructions.refresh"](undefined, throwingContext({})))
  expect(refreshed).toEqual(snapshot)
  expectRpcBody(refreshed)
})

test("mutate returning a customization without text or reviewed survives core's rpc body check", async () => {
  const directory = await tempDir()
  await enable(directory)
  const hostAgents = [Agent.Info.default(Agent.ID.make("ghost"))]
  const handlers = createHandlers(emptyHost(directory, hostAgents), createState())

  const result = await Effect.runPromise(
    handlers["instructions.mutate"](
      { expectedRevision: 0, customizations: [customization("item-1")] },
      throwingContext({}),
    ),
  )
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error("expected mutate to succeed")
  expect(result.snapshot.customizations).toHaveLength(1)
  expect("text" in result.snapshot.customizations[0]).toBe(false)
  expect("reviewed" in result.snapshot.customizations[0]).toBe(false)
  expectRpcBody(result)
})

test("snapshots carry protectedAgents from the project config across snapshot, refresh, and mutate results", async () => {
  const directory = await tempDir()
  await enable(directory)
  await Bun.write(
    path.join(directory, ".opencodeplus", "project.json"),
    JSON.stringify({ version: 1, protectedAgents: ["builder"] }) + "\n",
  )
  const handlers = createHandlers(emptyHost(directory), createState())

  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  expect(snapshot.protectedAgents).toEqual(["builder"])
  expectRpcBody(snapshot)

  const refreshed = await Effect.runPromise(handlers["instructions.refresh"](undefined, throwingContext({})))
  expect(refreshed.protectedAgents).toEqual(["builder"])
  expectRpcBody(refreshed)

  const success = await Effect.runPromise(
    handlers["instructions.mutate"](
      { expectedRevision: 0, customizations: [customization("item-1")] },
      throwingContext({}),
    ),
  )
  expect(success.ok).toBe(true)
  if (!success.ok) throw new Error("expected mutate to succeed")
  expect(success.snapshot.protectedAgents).toEqual(["builder"])
  expectRpcBody(success)

  const conflict = await Effect.runPromise(
    handlers["instructions.mutate"](
      { expectedRevision: 0, customizations: [customization("item-1", { text: "stale" })] },
      throwingContext({}),
    ),
  )
  expect(conflict.ok).toBe(false)
  if (conflict.ok) throw new Error("expected stale conflict")
  expect(conflict.snapshot.protectedAgents).toEqual(["builder"])
  expectRpcBody(conflict)
})

test("agent methods reject traversal ids with agent.invalid and leave the filesystem untouched", async () => {
  const directory = await tempDir()
  await enable(directory)
  const outside = path.join(directory, ".opencode", "AGENTS.md")
  await Bun.write(outside, "keep me\n")
  const handlers = createHandlers(emptyHost(directory), createState())

  const created: { current?: CapturedError } = {}
  await expectDeclaredError(
    handlers["agent.create"]({ scope: "project", id: "../../AGENTS", prompt: "evil" }, throwingContext(created)),
    created,
    "agent.invalid",
  )
  const renamed: { current?: CapturedError } = {}
  await expectDeclaredError(
    handlers["agent.rename"]({ scope: "project", from: "../../AGENTS", to: "beta" }, throwingContext(renamed)),
    renamed,
    "agent.invalid",
  )
  const renamedTo: { current?: CapturedError } = {}
  await expectDeclaredError(
    handlers["agent.rename"]({ scope: "project", from: "alpha", to: "../../AGENTS" }, throwingContext(renamedTo)),
    renamedTo,
    "agent.invalid",
  )
  const deleted: { current?: CapturedError } = {}
  await expectDeclaredError(
    handlers["agent.delete"]({ scope: "project", id: "../../AGENTS" }, throwingContext(deleted)),
    deleted,
    "agent.invalid",
  )
  expect(await Bun.file(outside).exists()).toBe(true)
  expect(await Bun.file(outside).text()).toBe("keep me\n")
})
