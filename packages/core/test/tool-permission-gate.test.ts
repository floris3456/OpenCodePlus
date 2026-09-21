import { describe, expect } from "bun:test"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Image } from "@opencode/core/image"
import { Location } from "@opencode/core/location"
import { Permission } from "@opencode/core/permission"
import { PermissionSaved } from "@opencode/core/permission/saved"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { Tool } from "@opencode/core/tool"
import type { Info } from "@opencode/schema/tool"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Cause, Deferred, Effect, Fiber, Layer, Schema } from "effect"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { imagePassthrough } from "./lib/image"

const current = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Tool.node,
      Database.node,
      Bus.node,
      SessionStore.node,
      PermissionSaved.node,
      Agent.node,
      Permission.node,
    ]),
    [Location.node.replace(current), Image.node.replace(imagePassthrough)],
  ),
)
// The registry still builds without a Location, so a runtime can hold tools and no permissions.
const unauthorized = testEffect(
  AppNodeBuilder.build(LayerNode.group([Tool.node]), [Image.node.replace(imagePassthrough)]),
)

const sessionID = Session.ID.make("ses_gate")
const agent = Agent.ID.make("gate")
const messageID = SessionMessage.ID.make("msg_gate")

const call = (name: string, id: string): Parameters<Tool.Snapshot["execute"]>[0] => ({
  sessionID,
  agent,
  messageID,
  call: { type: "tool-call", id, name, input: {} },
})

function setup(rules: Permission.Ruleset) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "gate",
        directory: "/project",
        title: "gate",
        version: "test",
        agent,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    const agents = yield* Agent.Service
    yield* agents.transform((editor) =>
      editor.update(agent, (current) => {
        current.permissions = [...rules]
      }),
    )
  })
}

/** A Plus-style plugin registration: a declared action, and no executor of its own to authorize the call. */
const pluginTool = (executed: string[]): Info => ({
  name: "deploy",
  description: "Deploy the service",
  input: Schema.Struct({}),
  output: Schema.String,
  options: { permission: "x.y", codemode: false },
  origin: { type: "plugin", name: "plus" },
  execute: () => Effect.sync(() => executed.push("deploy")).pipe(Effect.as({ output: "deployed" })),
})

/**
 * A tool shaped like the built-in `read`: its own leaf assert, the way `FileAccess.authorizeRead`
 * asserts for the real tool. MCP registrations assert the same way (`tool/mcp.ts`), so `origin`
 * selects the MCP variant of one leaf.
 */
const leafTool = (permission: Permission.Interface, origin: Info["origin"], executed: string[]): Info => ({
  name: origin === undefined ? "read" : "demo_search",
  description: "Read a resource",
  input: Schema.Struct({}),
  output: Schema.String,
  options: { codemode: false },
  ...(origin === undefined ? {} : { origin }),
  execute: (_, context) =>
    permission
      .assert({
        action: origin === undefined ? "read" : "demo_search",
        resources: ["src/index.ts"],
        save: ["*"],
        sessionID: context.sessionID,
        agent: context.agent,
        source: { type: "tool", messageID: context.messageID, id: context.id },
      })
      .pipe(
        Effect.andThen(Effect.sync(() => executed.push("leaf"))),
        Effect.as({ output: "contents" }),
        Effect.mapError((error) => new Tool.Error({ message: error.message, error })),
      ),
})

/** Resolves with the first request a call produces, and records every request it produces. */
const asked = (id: string) =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const requests: Permission.Request[] = []
    const first = yield* Deferred.make<Permission.Request>()
    const unsubscribe = yield* bus.listen((event) => {
      if (event.type !== Permission.Event.Asked.type) return Effect.void
      const request = event.data as Permission.Request
      if (request.source?.id !== id) return Effect.void
      requests.push(request)
      return Deferred.succeed(first, request).pipe(Effect.asVoid)
    })
    yield* Effect.addFinalizer(() => unsubscribe)
    return { requests, first: Deferred.await(first) }
  })

const register = (tool: Info) =>
  Effect.gen(function* () {
    const tools = yield* Tool.Service
    yield* tools.transform((editor) => editor.add(tool))
    return yield* tools.snapshot()
  })

describe("Tool permission gate", () => {
  it.effect("asks for a plugin tool, runs it on allow, and saves the action on always", () =>
    Effect.gen(function* () {
      const executed: string[] = []
      yield* setup([{ action: "x.y", resource: "*", effect: "ask" }])
      const snapshot = yield* register(pluginTool(executed))
      const service = yield* Permission.Service
      const pending = yield* asked("call_allow")

      const fiber = yield* snapshot.execute(call("deploy", "call_allow")).pipe(Effect.forkScoped)
      const request = yield* pending.first
      expect(request.action).toBe("x.y")
      expect(request.resources).toEqual(["*"])
      expect(request.save).toEqual(["*"])
      expect(request.source).toEqual({ type: "tool", messageID, id: "call_allow" })
      expect(executed).toEqual([])
      expect(yield* service.list()).toEqual([request])

      yield* service.reply({ requestID: request.id, reply: "always" })
      expect((yield* Fiber.join(fiber)).content).toEqual([{ type: "text", text: "deployed" }])
      expect(executed).toEqual(["deploy"])
      expect(yield* service.list()).toEqual([])

      const saved = yield* PermissionSaved.Service
      expect(yield* saved.list({ projectID: Project.ID.global })).toMatchObject([{ action: "x.y", resource: "*" }])
      const second = yield* asked("call_saved")
      expect((yield* snapshot.execute(call("deploy", "call_saved"))).content).toEqual([
        { type: "text", text: "deployed" },
      ])
      expect(second.requests).toEqual([])
      expect(executed).toEqual(["deploy", "deploy"])
    }),
  )

  it.effect("keeps a declined plugin tool unexecuted and gives the model the reviewer's feedback", () =>
    Effect.gen(function* () {
      const executed: string[] = []
      yield* setup([{ action: "x.y", resource: "*", effect: "ask" }])
      const snapshot = yield* register(pluginTool(executed))
      const service = yield* Permission.Service

      const declined = yield* asked("call_declined")
      const fiber = yield* snapshot.execute(call("deploy", "call_declined")).pipe(Effect.forkScoped)
      yield* service.reply({ requestID: (yield* declined.first).id, reply: "reject" })
      const exit = yield* Fiber.await(fiber)

      // A decline without feedback stays a defect so no tool can turn a "no" into model output.
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure")
        expect(
          exit.cause.reasons.some(
            (reason) => Cause.isDieReason(reason) && reason.defect instanceof Permission.DeclinedError,
          ),
        ).toBe(true)
      expect(executed).toEqual([])

      const corrected = yield* asked("call_corrected")
      const next = yield* snapshot.execute(call("deploy", "call_corrected")).pipe(Effect.forkScoped)
      yield* service.reply({
        requestID: (yield* corrected.first).id,
        reply: "reject",
        message: "deploy from CI instead",
      })
      const failure = yield* Fiber.join(next).pipe(Effect.flip)
      expect(failure).toBeInstanceOf(Tool.Error)
      expect(failure.message).toBe("deploy from CI instead")
      expect(executed).toEqual([])
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("refuses a denied plugin tool at call time while it is still in the catalog", () =>
    Effect.gen(function* () {
      const executed: string[] = []
      yield* setup([{ action: "x.*", resource: "*", effect: "deny" }])
      const snapshot = yield* register(pluginTool(executed))
      const service = yield* Permission.Service
      const pending = yield* asked("call_denied")

      expect(snapshot.definitions.map((tool) => tool.name)).toContain("deploy")
      const failure = yield* snapshot.execute(call("deploy", "call_denied")).pipe(Effect.flip)
      expect(failure).toBeInstanceOf(Tool.Error)
      expect(failure.message).toBe("Permission denied: x.y")
      expect(failure.error).toBeInstanceOf(Permission.BlockedError)
      expect(executed).toEqual([])
      expect(pending.requests).toEqual([])
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("runs an allowed plugin tool without asking", () =>
    Effect.gen(function* () {
      const executed: string[] = []
      yield* setup([{ action: "x.y", resource: "*", effect: "allow" }])
      const snapshot = yield* register(pluginTool(executed))
      const pending = yield* asked("call_allowed")

      expect((yield* snapshot.execute(call("deploy", "call_allowed"))).content).toEqual([
        { type: "text", text: "deployed" },
      ])
      expect(executed).toEqual(["deploy"])
      expect(pending.requests).toEqual([])
    }),
  )

  it.effect("asserts the tool name when a plugin tool declares no action", () =>
    Effect.gen(function* () {
      const executed: string[] = []
      yield* setup([{ action: "deploy", resource: "*", effect: "deny" }])
      const snapshot = yield* register({ ...pluginTool(executed), options: { codemode: false } })

      expect((yield* snapshot.execute(call("deploy", "call_named")).pipe(Effect.flip)).message).toBe(
        "Permission denied: deploy",
      )
      expect(executed).toEqual([])
    }),
  )

  it.effect("gates a plugin tool reached through Code Mode", () =>
    Effect.gen(function* () {
      const executed: string[] = []
      const code = (id: string): Parameters<Tool.Snapshot["execute"]>[0] => ({
        sessionID,
        agent,
        messageID,
        call: { type: "tool-call", id, name: "execute", input: { code: "return await tools.deploy({})" } },
      })
      yield* setup([{ action: "x.y", resource: "*", effect: "deny" }])
      const tools = yield* Tool.Service
      yield* tools.transform((editor) =>
        editor.add({ ...pluginTool(executed), options: { permission: "x.y", codemode: true } }),
      )

      const denied = yield* (yield* tools.snapshot()).execute(code("call_codemode_denied"))
      expect(denied.metadata).toEqual({ toolCalls: [{ tool: "deploy", status: "error" }], error: true })
      expect(denied.content).toEqual([{ type: "text", text: expect.stringContaining("Permission denied: x.y") }])
      expect(executed).toEqual([])

      yield* setup([{ action: "x.y", resource: "*", effect: "allow" }])
      const allowed = yield* (yield* tools.snapshot()).execute(code("call_codemode_allowed"))
      expect(allowed.metadata).toEqual({ toolCalls: [{ tool: "deploy", status: "completed" }] })
      expect(executed).toEqual(["deploy"])
    }),
  )

  for (const origin of [undefined, { type: "mcp" as const, name: "demo" }]) {
    it.effect(`leaves a ${origin === undefined ? "built-in" : "MCP"} tool to its own single assert`, () =>
      Effect.gen(function* () {
        const executed: string[] = []
        const action = origin === undefined ? "read" : "demo_search"
        yield* setup([{ action, resource: "*", effect: "ask" }])
        const service = yield* Permission.Service
        const snapshot = yield* register(leafTool(service, origin, executed))
        const pending = yield* asked("call_leaf")

        const fiber = yield* snapshot.execute(call(action, "call_leaf")).pipe(Effect.forkScoped)
        const request = yield* pending.first
        // The leaf's own resources, not the gate's wildcard: nothing widened or duplicated them.
        expect(request.action).toBe(action)
        expect(request.resources).toEqual(["src/index.ts"])
        expect(executed).toEqual([])

        yield* service.reply({ requestID: request.id, reply: "once" })
        expect((yield* Fiber.join(fiber)).content).toEqual([{ type: "text", text: "contents" }])
        expect(executed).toEqual(["leaf"])
        expect(pending.requests).toEqual([request])
      }),
    )
  }

  unauthorized.effect("refuses a plugin tool when the calling context has no permission service", () =>
    Effect.gen(function* () {
      const executed: string[] = []
      const snapshot = yield* register(pluginTool(executed))

      expect((yield* snapshot.execute(call("deploy", "call_unauthorized")).pipe(Effect.flip)).message).toBe(
        "Cannot authorize x.y: no permission service in this context",
      )
      expect(executed).toEqual([])
    }),
  )

  unauthorized.effect("leaves tools without a plugin origin runnable where no permission service exists", () =>
    Effect.gen(function* () {
      const executed: string[] = []
      const snapshot = yield* register({
        ...pluginTool(executed),
        origin: { type: "mcp", name: "demo" },
      })

      expect((yield* snapshot.execute(call("deploy", "call_unauthorized_mcp"))).content).toEqual([
        { type: "text", text: "deployed" },
      ])
      expect(executed).toEqual(["deploy"])
    }),
  )
})
