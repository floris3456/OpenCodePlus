import { afterEach, expect, test } from "bun:test"
import { Agent } from "@opencode/schema/agent"
import { Location } from "@opencode/schema/location"
import { Project } from "@opencode/schema/project"
import type { Rpc } from "@opencode/schema/rpc"
import { AbsolutePath } from "@opencode/schema/schema"
import type { Tool } from "@opencode/schema/tool"
import { Effect, Exit, Schema } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHandlers, createState, type PlusState } from "../src/index.js"
import { effective, fingerprint, type Customization, type Item } from "../src/instructions/model.js"
import { load } from "../src/instructions/store.js"
import { enable } from "../src/project.js"
import { Plus } from "../src/rpc.js"
import { agentHarness, context, mcpHarness } from "./harness.js"

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

function staticToolHost(
  directory: string,
  tools: readonly (Tool.Info & { readonly id: string })[],
) {
  const location = testLocation(directory)
  return context({
    location,
    agent: {
      get: () => Effect.die("unused agent.get"),
      list: () => Effect.succeed({ location, data: [] }),
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
            list: () => tools,
            get: (id) => tools.find((tool) => tool.id === id),
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

function toolHost(
  directory: string,
  tools: readonly (Tool.Info & { readonly id: string })[],
  hooks: { current: number },
) {
  const location = testLocation(directory)
  const current = { tools }
  const host = context({
    location,
    agent: {
      get: () => Effect.die("unused agent.get"),
      list: () => Effect.succeed({ location, data: [{ ...Agent.Info.default(Agent.ID.make("alpha")), system: "upstream" }] }),
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
            list: () => current.tools,
            get: (id) => current.tools.find((tool) => tool.id === id),
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
    session: {
      hook: () =>
        Effect.sync(() => {
          hooks.current++
          return { dispose: Effect.sync(() => { hooks.current-- }) }
        }),
    },
  })
  return {
    ctx: host,
    setTools(next: readonly (Tool.Info & { readonly id: string })[]): void {
      current.tools = next
    },
  }
}

function hostTool(id: string, description: string, options?: Tool.Info["options"]): Tool.Info & { readonly id: string } {
  return {
    id,
    name: id,
    description,
    input: Schema.Void,
    ...(options === undefined ? {} : { options }),
    execute: () => Effect.die("unused tool.execute"),
  }
}

function liveAgentHost(directory: string, agents: ReturnType<typeof agentHarness>, mcp?: ReturnType<typeof mcpHarness>) {
  const location = testLocation(directory)
  return context({
    location,
    agent: {
      get: agents.domain.get,
      list: () => agents.domain.list(),
      transform: agents.domain.transform,
      reload: agents.domain.reload,
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
    mcp:
      mcp === undefined
        ? {
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
          }
        : {
            list: mcp.domain.list,
            transform: mcp.domain.transform,
            reload: mcp.domain.reload,
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

type RpcSnapshot = Effect.Success<ReturnType<ReturnType<typeof createHandlers>["instructions.refresh"]>>

function snapshotOf(snapshot: RpcSnapshot): { revision: number; items: Item[]; customizations: Customization[] } {
  return {
    revision: snapshot.revision,
    items: snapshot.items.map(itemOf),
    customizations: snapshot.customizations.map((record: RpcSnapshot["customizations"][number]) => ({ ...record })),
  }
}

function itemOf(item: RpcSnapshot["items"][number]): Item {
  return { ...item, agents: [...item.agents] }
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

  const missingRename: { current?: CapturedError } = {}
  await expectDeclaredError(
    handlers["agent.rename"](
      { scope: "project", from: "ghost", to: "beta" },
      throwingContext(missingRename),
    ),
    missingRename,
    "agent.missing",
  )

  const missingDelete: { current?: CapturedError } = {}
  await expectDeclaredError(
    handlers["agent.delete"]({ scope: "project", id: "ghost" }, throwingContext(missingDelete)),
    missingDelete,
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
  expectRpcBody(deleted)

  const missingDeletedAgain: { current?: CapturedError } = {}
  await expectDeclaredError(
    handlers["agent.delete"]({ scope: "project", id: "beta" }, throwingContext(missingDeletedAgain)),
    missingDeletedAgain,
    "agent.missing",
  )
})

test("agent.delete fails with declared agent.missing when agent does not exist and succeeds when present", async () => {
  const directory = await tempDir()
  await enable(directory)
  const handlers = createHandlers(emptyHost(directory), createState())

  const missing: { current?: CapturedError } = {}
  await expectDeclaredError(
    handlers["agent.delete"]({ scope: "project", id: "non-existent" }, throwingContext(missing)),
    missing,
    "agent.missing",
  )

  const created = await Effect.runPromise(
    handlers["agent.create"]({ scope: "project", id: "present", prompt: "Present prompt" }, throwingContext({})),
  )
  expect(await Bun.file(created.path).exists()).toBe(true)

  const deleted = await Effect.runPromise(
    handlers["agent.delete"]({ scope: "project", id: "present" }, throwingContext({})),
  )
  expect(deleted).toEqual({ id: "present", path: created.path })
  expect(await Bun.file(created.path).exists()).toBe(false)
  expectRpcBody(deleted)

  const missingAgain: { current?: CapturedError } = {}
  await expectDeclaredError(
    handlers["agent.delete"]({ scope: "project", id: "present" }, throwingContext(missingAgain)),
    missingAgain,
    "agent.missing",
  )
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

test("snapshots carry tool native flags from the live inventory across snapshot, refresh, and mutate results", async () => {
  const directory = await tempDir()
  await enable(directory)
  const tools = [hostTool("reader", "read things", { codemode: false }), hostTool("helper", "help things")]
  const expected = [
    { id: "reader", native: true },
    { id: "helper", native: false },
  ]
  const handlers = createHandlers(staticToolHost(directory, tools), createState())

  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  expect(snapshot.tools).toEqual(expected)
  expectRpcBody(snapshot)

  const refreshed = await Effect.runPromise(handlers["instructions.refresh"](undefined, throwingContext({})))
  expect(refreshed.tools).toEqual(expected)
  expectRpcBody(refreshed)

  const success = await Effect.runPromise(
    handlers["instructions.mutate"](
      { expectedRevision: 0, customizations: [customization("item-1")] },
      throwingContext({}),
    ),
  )
  expect(success.ok).toBe(true)
  if (!success.ok) throw new Error("expected mutate to succeed")
  expect(success.snapshot.tools).toEqual(expected)
  expectRpcBody(success)

  const conflict = await Effect.runPromise(
    handlers["instructions.mutate"](
      { expectedRevision: 0, customizations: [customization("item-1", { text: "stale" })] },
      throwingContext({}),
    ),
  )
  expect(conflict.ok).toBe(false)
  if (conflict.ok) throw new Error("expected stale conflict")
  expect(conflict.snapshot.tools).toEqual(expected)
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

test("a prompt customization converges: repeated refreshes are no-ops and keep the override applied", async () => {
  const directory = await tempDir()
  await enable(directory)
  const alphaPath = path.join(directory, ".opencode", "agent", "alpha.md")
  await fs.mkdir(path.dirname(alphaPath), { recursive: true })
  await Bun.write(alphaPath, "upstream\n")
  const agents = agentHarness([{ ...Agent.Info.default(Agent.ID.make("alpha")), system: "upstream" }])
  const state = createState()
  const emitted = captureEmits(state)
  const handlers = createHandlers(liveAgentHost(directory, agents), state)

  const before = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const item = before.items.find((entry) => entry.id === "prompt:alpha")
  if (!item) throw new Error("expected prompt:alpha in snapshot")
  expect(item.text).toBe("upstream")

  const mutated = await Effect.runPromise(
    handlers["instructions.mutate"](
      {
        expectedRevision: 0,
        customizations: [
          {
            item: "prompt:alpha",
            agent: "alpha",
            text: "custom",
            state: "inherit",
            basedOn: fingerprint("upstream"),
            updated: UPDATED,
          },
        ],
      },
      throwingContext({}),
    ),
  )
  expect(mutated.ok).toBe(true)
  if (!mutated.ok) throw new Error("expected mutate to succeed")
  expectRpcBody(mutated)
  // The override really reached the host: list observes the applied text.
  expect(agents.state.get("alpha")?.system).toBe("custom")
  const afterApply = { transforms: agents.transforms, disposes: agents.disposes, reloads: agents.reloads }
  expect(afterApply.transforms).toBe(1)
  expect(afterApply.reloads).toBe(1)
  const emittedAfterApply = emitted.length

  // Drive the refresh cycle the way agent.updated would, twice: each pass
  // must short-circuit on the unchanged fingerprint instead of disposing
  // and reinstalling registrations.
  for (let pass = 0; pass < 2; pass++) {
    const refreshed = await Effect.runPromise(handlers["instructions.refresh"](undefined, throwingContext({})))
    expectRpcBody(refreshed)
    expect(refreshed.items.find((entry) => entry.id === "prompt:alpha")?.text).toBe("upstream")
    expect(agents.transforms).toBe(afterApply.transforms)
    expect(agents.disposes).toBe(afterApply.disposes)
    expect(agents.reloads).toBe(afterApply.reloads)
    expect(agents.state.get("alpha")?.system).toBe("custom")
  }
  expect(emitted).toHaveLength(emittedAfterApply)
})

test("a genuine upstream prompt edit while a customization is active is discovered and needs review", async () => {
  const directory = await tempDir()
  await enable(directory)
  const alphaPath = path.join(directory, ".opencode", "agent", "alpha.md")
  await fs.mkdir(path.dirname(alphaPath), { recursive: true })
  await Bun.write(alphaPath, "upstream\n")
  const agents = agentHarness([{ ...Agent.Info.default(Agent.ID.make("alpha")), system: "upstream" }])
  const state = createState()
  const handlers = createHandlers(liveAgentHost(directory, agents), state)

  const mutated = await Effect.runPromise(
    handlers["instructions.mutate"](
      {
        expectedRevision: 0,
        customizations: [
          {
            item: "prompt:alpha",
            agent: "alpha",
            text: "custom",
            state: "inherit",
            basedOn: fingerprint("upstream"),
            updated: UPDATED,
          },
        ],
      },
      throwingContext({}),
    ),
  )
  expect(mutated.ok).toBe(true)
  if (!mutated.ok) throw new Error("expected mutate to succeed")

  // A host edit outside Plus replaces the upstream text underneath the
  // installed override. The customization stays active, yet discovery rereads
  // the file-backed prompt so the genuine edit surfaces and the "needs review"
  // badge fires.
  await Bun.write(alphaPath, "upstream revised\n")
  agents.setUpstream("alpha", "upstream revised")
  expect(agents.upstream("alpha")).toBe("upstream revised")
  const refreshed = await Effect.runPromise(handlers["instructions.refresh"](undefined, throwingContext({})))
  expectRpcBody(refreshed)
  const item = refreshed.items.find((entry) => entry.id === "prompt:alpha")
  expect(item?.text).toBe("upstream revised")
  expect(item?.fingerprint).toBe(fingerprint("upstream revised"))
  if (!item) throw new Error("expected prompt:alpha in refreshed snapshot")
  const record = refreshed.customizations.find((entry) => entry.item === item.id && entry.agent === "alpha")
  if (!record) throw new Error("expected prompt:alpha customization in refreshed snapshot")
  expect(record.basedOn).toBe(fingerprint("upstream"))
  expect(record.basedOn).not.toBe(item.fingerprint)
  expect(effective(snapshotOf(refreshed), itemOf(item), "alpha").review).toBe(true)
  expect(agents.state.get("alpha")?.system).toBe("custom")

  // The edit changes the publish fingerprint once, so discovery settles after
  // one dispose/reinstall instead of storming on every pass.
  const afterEdit = { transforms: agents.transforms, disposes: agents.disposes, reloads: agents.reloads }
  const settled = await Effect.runPromise(handlers["instructions.refresh"](undefined, throwingContext({})))
  expectRpcBody(settled)
  expect(settled.items.find((entry) => entry.id === "prompt:alpha")?.text).toBe("upstream revised")
  expect(agents.transforms).toBe(afterEdit.transforms)
  expect(agents.disposes).toBe(afterEdit.disposes)
  expect(agents.reloads).toBe(afterEdit.reloads)
  expect(agents.state.get("alpha")?.system).toBe("custom")
})

test("a flags-only tool partition transition rebuilds the applied plan in both directions", async () => {
  const directory = await tempDir()
  await enable(directory)
  const native = hostTool("reader", "read things", { codemode: false })
  const codeMode = hostTool("reader", "read things")
  const hooks = { current: 0 }
  const host = toolHost(directory, [codeMode], hooks)
  const state = createState()
  const handlers = createHandlers(host.ctx, state)

  const mutated = await Effect.runPromise(
    handlers["instructions.mutate"](
      {
        expectedRevision: 0,
        customizations: [
          {
            item: "tool:reader",
            agent: "alpha",
            text: "custom description",
            state: "inherit",
            basedOn: fingerprint("read things"),
            updated: UPDATED,
          },
        ],
      },
      throwingContext({}),
    ),
  )
  expect(mutated.ok).toBe(true)
  if (!mutated.ok) throw new Error("expected mutate to succeed")
  expectRpcBody(mutated)
  expect(mutated.snapshot.tools).toEqual([{ id: "reader", native: false }])
  expect(hooks.current).toBe(0)

  // Only the partition flag changes; id, name, and description stay identical,
  // so the tool item text and agents are unchanged. The plan must still
  // install because the native flag decides whether applyTools applies at all.
  host.setTools([native])
  const refreshed = await Effect.runPromise(handlers["instructions.refresh"](undefined, throwingContext({})))
  expectRpcBody(refreshed)
  expect(refreshed.tools).toEqual([{ id: "reader", native: true }])
  expect(refreshed.items.find((entry) => entry.id === "tool:reader")?.text).toBe("read things")
  expect(hooks.current).toBe(1)

  // The reverse transition uninstalls the now-inapplicable plan instead of
  // leaving it installed for a Code Mode tool.
  host.setTools([codeMode])
  const reverted = await Effect.runPromise(handlers["instructions.refresh"](undefined, throwingContext({})))
  expectRpcBody(reverted)
  expect(reverted.tools).toEqual([{ id: "reader", native: false }])
  expect(reverted.items.find((entry) => entry.id === "tool:reader")?.text).toBe("read things")
  expect(hooks.current).toBe(0)
})

test("a builtin agent gaining a backing file re-establishes ownership while the customization stays active", async () => {
  const directory = await tempDir()
  await enable(directory)
  const agents = agentHarness([{ ...Agent.Info.default(Agent.ID.make("ghost")), system: "builtin upstream" }])
  const state = createState()
  const handlers = createHandlers(liveAgentHost(directory, agents), state)

  const mutated = await Effect.runPromise(
    handlers["instructions.mutate"](
      {
        expectedRevision: 0,
        customizations: [
          {
            item: "prompt:ghost",
            agent: "ghost",
            text: "custom",
            state: "inherit",
            basedOn: fingerprint("builtin upstream"),
            updated: UPDATED,
          },
        ],
      },
      throwingContext({}),
    ),
  )
  expect(mutated.ok).toBe(true)
  if (!mutated.ok) throw new Error("expected mutate to succeed")

  // A markdown file appears for the same id. Core decodes it as the new
  // upstream prompt, but the host view still shows Plus's override, so the
  // source transition must re-derive ownership from the file instead of
  // pinning the stale builtin text forever.
  const ghostPath = path.join(directory, ".opencode", "agent", "ghost.md")
  await fs.mkdir(path.dirname(ghostPath), { recursive: true })
  await Bun.write(ghostPath, "file upstream\n")
  agents.setUpstream("ghost", "file upstream")
  const refreshed = await Effect.runPromise(handlers["instructions.refresh"](undefined, throwingContext({})))
  expectRpcBody(refreshed)
  expect(refreshed.agents.find((entry) => entry.id === "ghost")?.fileBacked).toBe(true)
  const item = refreshed.items.find((entry) => entry.id === "prompt:ghost")
  expect(item?.text).toBe("file upstream")
  expect(item?.fingerprint).toBe(fingerprint("file upstream"))
  if (!item) throw new Error("expected prompt:ghost in refreshed snapshot")
  const record = refreshed.customizations.find((entry) => entry.item === item.id && entry.agent === "ghost")
  if (!record) throw new Error("expected prompt:ghost customization in refreshed snapshot")
  expect(record.basedOn).toBe(fingerprint("builtin upstream"))
  expect(record.basedOn).not.toBe(item.fingerprint)
  expect(effective(snapshotOf(refreshed), itemOf(item), "ghost").review).toBe(true)
  expect(agents.state.get("ghost")?.system).toBe("custom")

  const afterTransition = { transforms: agents.transforms, disposes: agents.disposes, reloads: agents.reloads }
  const settled = await Effect.runPromise(handlers["instructions.refresh"](undefined, throwingContext({})))
  expectRpcBody(settled)
  expect(settled.items.find((entry) => entry.id === "prompt:ghost")?.text).toBe("file upstream")
  expect(agents.transforms).toBe(afterTransition.transforms)
  expect(agents.disposes).toBe(afterTransition.disposes)
  expect(agents.reloads).toBe(afterTransition.reloads)
  expect(agents.state.get("ghost")?.system).toBe("custom")
})

test("deleting and recreating a backing file re-establishes ownership while the customization stays active", async () => {
  const directory = await tempDir()
  await enable(directory)
  const betaPath = path.join(directory, ".opencode", "agent", "beta.md")
  await fs.mkdir(path.dirname(betaPath), { recursive: true })
  await Bun.write(betaPath, "file upstream\n")
  const agents = agentHarness([{ ...Agent.Info.default(Agent.ID.make("beta")), system: "file upstream" }])
  const state = createState()
  const handlers = createHandlers(liveAgentHost(directory, agents), state)

  const mutated = await Effect.runPromise(
    handlers["instructions.mutate"](
      {
        expectedRevision: 0,
        customizations: [
          {
            item: "prompt:beta",
            agent: "beta",
            text: "custom",
            state: "inherit",
            basedOn: fingerprint("file upstream"),
            updated: UPDATED,
          },
        ],
      },
      throwingContext({}),
    ),
  )
  expect(mutated.ok).toBe(true)
  if (!mutated.ok) throw new Error("expected mutate to succeed")

  // The file disappears: the builtin prompt underneath owns the id again, but
  // the host still shows Plus's override, so discovery keeps reporting the
  // retained file text rather than inventing an upstream it cannot observe.
  await fs.rm(betaPath)
  agents.setUpstream("beta", "builtin upstream")
  const deleted = await Effect.runPromise(handlers["instructions.refresh"](undefined, throwingContext({})))
  expectRpcBody(deleted)
  expect(deleted.agents.find((entry) => entry.id === "beta")?.fileBacked).toBe(false)
  expect(deleted.items.find((entry) => entry.id === "prompt:beta")?.text).toBe("file upstream")
  expect(agents.state.get("beta")?.system).toBe("custom")

  // Recreating the file is another source transition: the new body becomes
  // upstream again instead of being rejected against the stale retained value.
  await Bun.write(betaPath, "file upstream revised\n")
  agents.setUpstream("beta", "file upstream revised")
  const refreshed = await Effect.runPromise(handlers["instructions.refresh"](undefined, throwingContext({})))
  expectRpcBody(refreshed)
  expect(refreshed.agents.find((entry) => entry.id === "beta")?.fileBacked).toBe(true)
  const item = refreshed.items.find((entry) => entry.id === "prompt:beta")
  expect(item?.text).toBe("file upstream revised")
  expect(item?.fingerprint).toBe(fingerprint("file upstream revised"))
  if (!item) throw new Error("expected prompt:beta in refreshed snapshot")
  const record = refreshed.customizations.find((entry) => entry.item === item.id && entry.agent === "beta")
  if (!record) throw new Error("expected prompt:beta customization in refreshed snapshot")
  expect(record.basedOn).toBe(fingerprint("file upstream"))
  expect(record.basedOn).not.toBe(item.fingerprint)
  expect(effective(snapshotOf(refreshed), itemOf(item), "beta").review).toBe(true)
  expect(agents.state.get("beta")?.system).toBe("custom")
})

test("a disabled MCP server stays continuously disabled across replacement publishes", async () => {
  const directory = await tempDir()
  await enable(directory)
  const alphaPath = path.join(directory, ".opencode", "agent", "alpha.md")
  await fs.mkdir(path.dirname(alphaPath), { recursive: true })
  await Bun.write(alphaPath, "upstream\n")
  const agents = agentHarness([{ ...Agent.Info.default(Agent.ID.make("alpha")), system: "upstream" }])
  const mcp = mcpHarness([["search", { type: "remote", url: "https://example.test" }]])
  const state = createState()
  const handlers = createHandlers(liveAgentHost(directory, agents, mcp), state)
  const upstreamText = JSON.stringify({ type: "remote", url: "https://example.test" })

  const mutated = await Effect.runPromise(
    handlers["instructions.mutate"](
      {
        expectedRevision: 0,
        customizations: [
          {
            item: "mcp:search",
            agent: "*",
            state: "disabled",
            basedOn: fingerprint(upstreamText),
            updated: UPDATED,
          },
        ],
      },
      throwingContext({}),
    ),
  )
  expect(mutated.ok).toBe(true)
  if (!mutated.ok) throw new Error("expected mutate to succeed")
  expectRpcBody(mutated)
  expect(mcp.disabled("search")).toBe(true)
  const settled = mcp.starts

  // An unrelated prompt edit forces a changed publish that disposes and
  // reinstalls every registration. The replacement must install before the
  // superseded disable is disposed, so the editor never observes the upstream
  // enabled config and the server never starts in between.
  await Bun.write(alphaPath, "upstream revised\n")
  agents.setUpstream("alpha", "upstream revised")
  const refreshed = await Effect.runPromise(handlers["instructions.refresh"](undefined, throwingContext({})))
  expectRpcBody(refreshed)
  expect(refreshed.items.find((entry) => entry.id === "prompt:alpha")?.text).toBe("upstream revised")
  expect(mcp.disabled("search")).toBe(true)
  expect(mcp.starts).toBe(settled)

  // A second unrelated mutation republishes again while the disable stays in
  // force; it must not start the server either.
  const second = await Effect.runPromise(
    handlers["instructions.mutate"](
      {
        expectedRevision: 1,
        customizations: [
          {
            item: "mcp:search",
            agent: "*",
            state: "disabled",
            basedOn: fingerprint(upstreamText),
            updated: UPDATED,
          },
          {
            item: "prompt:alpha",
            agent: "alpha",
            text: "custom",
            state: "inherit",
            basedOn: fingerprint("upstream revised"),
            updated: UPDATED,
          },
        ],
      },
      throwingContext({}),
    ),
  )
  expect(second.ok).toBe(true)
  if (!second.ok) throw new Error("expected second mutate to succeed")
  expectRpcBody(second)
  expect(mcp.disabled("search")).toBe(true)
  expect(agents.state.get("alpha")?.system).toBe("custom")
  expect(mcp.starts).toBe(settled)
})

test("through the real snapshot -> mutate -> apply path, an upstream disabled: true server is discovered unavailable and enabling it clears disabled in the config core sees", async () => {
  const directory = await tempDir()
  await enable(directory)
  const agents = agentHarness([{ ...Agent.Info.default(Agent.ID.make("alpha")), system: "upstream" }])
  const mcp = mcpHarness([["search", { type: "remote", url: "https://example.test", disabled: true }]])
  const state = createState()
  const handlers = createHandlers(liveAgentHost(directory, agents, mcp), state)

  const initial = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  expectRpcBody(initial)
  const serverItem = initial.items.find((entry) => entry.id === "mcp:search")
  expect(serverItem).toBeDefined()
  expect(serverItem?.available).toBe(false)

  const mutated = await Effect.runPromise(
    handlers["instructions.mutate"](
      {
        expectedRevision: initial.revision,
        customizations: [
          {
            item: "mcp:search",
            agent: "*",
            state: "enabled",
            basedOn: serverItem!.fingerprint,
            updated: UPDATED,
          },
        ],
      },
      throwingContext({}),
    ),
  )
  expect(mutated.ok).toBe(true)
  if (!mutated.ok) throw new Error("expected mutate to succeed")
  expectRpcBody(mutated)
  expect(mcp.disabled("search")).toBeUndefined()
})

test("through the real snapshot -> mutate -> apply handler path, enabling an upstream disabled server clears disabled in config and reports effective enabled true in refreshed snapshot", async () => {
  const directory = await tempDir()
  await enable(directory)
  const agents = agentHarness([{ ...Agent.Info.default(Agent.ID.make("alpha")), system: "upstream" }])
  const mcp = mcpHarness([["search", { type: "remote", url: "https://example.test", disabled: true }]])
  const state = createState()
  const handlers = createHandlers(liveAgentHost(directory, agents, mcp), state)

  const initial = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  expectRpcBody(initial)
  const serverItem = initial.items.find((entry) => entry.id === "mcp:search")
  expect(serverItem).toBeDefined()
  expect(serverItem?.available).toBe(false)

  const mutated = await Effect.runPromise(
    handlers["instructions.mutate"](
      {
        expectedRevision: initial.revision,
        customizations: [
          {
            item: "mcp:search",
            agent: "*",
            state: "enabled",
            basedOn: serverItem!.fingerprint,
            updated: UPDATED,
          },
        ],
      },
      throwingContext({}),
    ),
  )
  expect(mutated.ok).toBe(true)
  if (!mutated.ok) throw new Error("expected mutate to succeed")
  expectRpcBody(mutated)
  expect(mcp.disabled("search")).toBeUndefined()

  const refreshed = await Effect.runPromise(handlers["instructions.refresh"](undefined, throwingContext({})))
  expectRpcBody(refreshed)
  const refreshedItem = refreshed.items.find((entry) => entry.id === "mcp:search")
  if (!refreshedItem) throw new Error("expected mcp:search item on refresh")
  const eff = effective(snapshotOf(refreshed), itemOf(refreshedItem), "*")
  expect(eff.enabled).toBe(true)
})

test("disable, then refresh twice, asserting effective().review === false and an unchanged fingerprint on both passes", async () => {
  const directory = await tempDir()
  await enable(directory)
  const agents = agentHarness([{ ...Agent.Info.default(Agent.ID.make("alpha")), system: "upstream" }])
  const mcp = mcpHarness([["search", { type: "remote", url: "https://example.test" }]])
  const state = createState()
  const handlers = createHandlers(liveAgentHost(directory, agents, mcp), state)

  const initial = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  expectRpcBody(initial)
  const initialItem = initial.items.find((entry) => entry.id === "mcp:search")
  if (!initialItem) throw new Error("expected mcp:search item")
  const initialFingerprint = initialItem.fingerprint

  const mutated = await Effect.runPromise(
    handlers["instructions.mutate"](
      {
        expectedRevision: initial.revision,
        customizations: [
          {
            item: "mcp:search",
            agent: "*",
            state: "disabled",
            basedOn: initialFingerprint,
            updated: UPDATED,
          },
        ],
      },
      throwingContext({}),
    ),
  )
  expect(mutated.ok).toBe(true)
  if (!mutated.ok) throw new Error("expected mutate to succeed")
  expectRpcBody(mutated)

  for (let pass = 1; pass <= 2; pass++) {
    const refreshed = await Effect.runPromise(handlers["instructions.refresh"](undefined, throwingContext({})))
    expectRpcBody(refreshed)
    const item = refreshed.items.find((entry) => entry.id === "mcp:search")
    if (!item) throw new Error("expected mcp:search item on refresh")
    expect(item.fingerprint).toBe(initialFingerprint)
    const eff = effective(snapshotOf(refreshed), itemOf(item), "*")
    expect(eff.review).toBe(false)
  }
})
