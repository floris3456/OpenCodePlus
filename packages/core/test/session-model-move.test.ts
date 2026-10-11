import { expect } from "bun:test"
import path from "node:path"
import { mkdir } from "node:fs/promises"
import { Context, Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Plugin } from "@opencode/core/plugin"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { AbsolutePath } from "@opencode/core/schema"
import { Agent } from "@opencode/core/agent"
import { Model } from "@opencode/schema/model"
import { Global } from "@opencode/util/global"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { load, save, type StoredRecord } from "../../plus/src/instructions/store.js"
import { tmpdirScoped } from "./fixture/tmpdir"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)
const setup = Effect.fnUntraced(function* (execute = true) {
  const tmp = yield* tmpdirScoped()
  yield* Effect.acquireRelease(Effect.sync(() => {
    const previous = { config: process.env.OPENCODE_CONFIG_DIR, data: process.env.XDG_DATA_HOME }
    process.env.OPENCODE_CONFIG_DIR = path.join(tmp.path, "config")
    process.env.XDG_DATA_HOME = path.join(tmp.path, "data")
    return previous
  }), (previous) => Effect.sync(() => {
    if (previous.config === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = previous.config
    if (previous.data === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = previous.data
  }))
  const source = AbsolutePath.make(path.join(tmp.path, "source"))
  const destination = AbsolutePath.make(path.join(tmp.path, "destination"))
  yield* Effect.promise(() => mkdir(source))
  for (const args of [
    ["init", source],
    ["-C", source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture"],
    ["-C", source, "worktree", "add", "-b", "moved", destination],
  ]) {
    const exit = yield* Effect.promise(() => Bun.spawn(["git", ...args], { stdout: "ignore", stderr: "ignore" }).exited)
    expect(exit).toBe(0)
  }
  const runtime = yield* Layer.build(AppNodeBuilder.build(LayerNode.group([Session.node, SessionExecution.node, LocationServiceMap.node]), [
    Global.node.replace(tempGlobalLayer), offlineModels,
    ...(execute ? [] : [SessionExecution.node.replace(SessionExecution.noopLayer)]),
  ]))
  const sessions = Context.get(runtime, Session.Service)
  const execution = Context.get(runtime, SessionExecution.Service)
  const locations = Context.get(runtime, LocationServiceMap.Service)
  const model = Model.Ref.parse("openai/gpt-5.4-mini#medium")
  const session = yield* sessions.create({ location: { directory: source }, agent: Agent.defaultID, model })
  const effective = Effect.gen(function* () {
    const context = yield* locations.contextEffect({ directory: destination })
    const plugins = Context.get(context, Plugin.Service)
    const hooks = Context.get(context, PluginHooks.Service)
    const agents = Context.get(context, Agent.Service)
    yield* plugins.awaitActivation
    const decision = yield* hooks.trigger("session", "compaction.decide", {
      sessionID: session.id, agent: Agent.defaultID, model, reason: "auto", auto: true, due: false,
      boundary: { fresh: true, portable: true },
    })
    return { decision, agent: yield* agents.get(Agent.defaultID) }
  })
  const write = (directory: string, records: readonly StoredRecord[]) => Effect.promise(async () => {
    const loaded = await load(directory)
    expect((await save(directory, { expectedProjectRevision: loaded.projectRevision, expectedGlobalRevision: loaded.globalRevision, records })).ok).toBe(true)
  })
  const row = { type: "model" as const, level: "project" as const, agent: "build", providerID: model.providerID, modelID: model.id, variant: model.variant, compactionStrategy: "local" as const, warming: "30m", prompt: "fixture keepalive", active: true, updated: "fixture" }
  return { sessions, execution, source, destination, effective, session, model, row, write }
})

it.live("committed worktree moves copy and activate project settings before destination execution, preserving independence and conflicts", () => Effect.gen(function* () {
  const f = yield* setup()
  yield* f.write(f.source, [f.row, { ...f.row, modelID: "unrelated", active: false }])
  yield* f.write(f.destination, [{ ...f.row, modelID: "destination-active", compactionStrategy: "remote" }])
  yield* f.sessions.move({ sessionID: f.session.id, directory: f.destination, delivery: "queue" })
  yield* f.execution.awaitIdle(f.session.id)
  const moved = yield* f.sessions.get(f.session.id)
  expect(moved.projectID).toBe(f.session.projectID)
  expect(moved.location.directory).toBe(f.destination)
  expect(moved.model).toEqual(f.model)
  const destination = yield* Effect.promise(() => load(f.destination))
  expect(destination.records.filter((row) => row.type === "model" && row.modelID === f.model.id)).toEqual([f.row])
  expect(destination.records.some((row) => row.type === "model" && row.modelID === "unrelated")).toBe(false)
  expect(destination.records.find((row) => row.type === "model" && row.modelID === "destination-active")).not.toHaveProperty("active")
  expect((yield* f.effective).agent?.model).toEqual(f.model)
  expect((yield* f.effective).decision).toMatchObject({ strategy: "local", explanation: { strategy: { source: "project" } } })
  // Editing the destination is independent, and wins on repeated movement into it.
  yield* f.write(f.destination, [{ ...f.row, compactionStrategy: "remote", warming: "off" }])
  expect((yield* Effect.promise(() => load(f.source))).records).toContainEqual(f.row)
  yield* f.sessions.move({ sessionID: f.session.id, directory: f.source })
  yield* f.execution.awaitIdle(f.session.id)
  yield* f.sessions.move({ sessionID: f.session.id, directory: f.destination })
  yield* f.execution.awaitIdle(f.session.id)
  const repeated = yield* Effect.promise(() => load(f.destination))
  expect(repeated.records.filter((row) => row.type === "model")).toEqual([{ ...f.row, compactionStrategy: "remote", warming: "off" }])
  expect((yield* f.effective).decision.strategy).toBe("remote")
  // Folder movement activates the matching row even when it was previously hidden.
  yield* f.sessions.move({ sessionID: f.session.id, directory: f.source })
  yield* f.execution.awaitIdle(f.session.id)
  yield* f.write(f.destination, [{ ...f.row, compactionStrategy: "remote", removed: true, active: false }])
  yield* f.sessions.move({ sessionID: f.session.id, directory: f.destination })
  yield* f.execution.awaitIdle(f.session.id)
  expect((yield* Effect.promise(() => load(f.destination))).records).toEqual([{ ...f.row, compactionStrategy: "remote" }])
  expect((yield* f.effective).agent?.model).toEqual(f.model)
}), { timeout: 20000 })

it.live("failed and cancelled moves do not transfer settings", () => Effect.gen(function* () {
  const f = yield* setup(false)
  yield* f.write(f.source, [f.row])
  expect((yield* Effect.exit(f.sessions.move({ sessionID: f.session.id, directory: AbsolutePath.make(path.join(f.destination, "missing")) })))._tag).toBe("Failure")
  yield* f.sessions.move({ sessionID: f.session.id, directory: f.destination, delivery: "queue" })
  const pending = (yield* f.sessions.inbox(f.session.id))[0]
  if (!pending) return yield* Effect.die("Missing queued move")
  yield* f.sessions.cancelInbox({ sessionID: f.session.id, inboxID: pending.id })
  expect((yield* f.sessions.get(f.session.id)).location.directory).toBe(f.source)
  expect((yield* Effect.promise(() => load(f.destination))).records).toEqual([])
}), { timeout: 20000 })

it.live("an empty destination receives a project row, while a Global-only model creates no project row", () => Effect.gen(function* () {
  const f = yield* setup()
  yield* f.write(f.source, [{ ...f.row, level: "global" }])
  yield* f.sessions.move({ sessionID: f.session.id, directory: f.destination })
  yield* f.execution.awaitIdle(f.session.id)
  expect((yield* Effect.promise(() => load(f.destination))).records.filter((row) => row.level === "project")).toEqual([])
  yield* f.sessions.move({ sessionID: f.session.id, directory: f.source })
  yield* f.execution.awaitIdle(f.session.id)
  yield* f.write(f.source, [f.row])
  yield* f.sessions.move({ sessionID: f.session.id, directory: f.destination })
  yield* f.execution.awaitIdle(f.session.id)
  expect((yield* Effect.promise(() => load(f.destination))).records).toEqual([f.row])
  expect((yield* f.effective).decision.strategy).toBe("local")
}), { timeout: 20000 })
