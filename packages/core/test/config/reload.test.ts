import path from "path"
import fs from "fs/promises"
import { describe, expect } from "bun:test"
import { Document, Event, Info } from "@opencode/schema/config"
import { Agent } from "@opencode/core/agent"
import { Command } from "@opencode/core/command"
import { Config } from "@opencode/core/config"
import { ConfigAgentPlugin } from "@opencode/core/config/plugin/agent"
import { ConfigCommandPlugin } from "@opencode/core/config/plugin/command"
import { ConfigProviderPlugin } from "@opencode/core/config/plugin/provider"
import { ConfigReferencePlugin } from "@opencode/core/config/plugin/reference"
import { ConfigCompatibilityPlugin } from "@opencode/core/config/plugin/compatibility"
import { ConfigSkillPlugin } from "@opencode/core/config/plugin/skill"
import { Bus } from "@opencode/core/bus"
import { Integration } from "@opencode/core/integration"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Provider } from "@opencode/core/provider"
import { Reference } from "@opencode/core/reference"
import { Skill } from "@opencode/core/skill"
import { ShellSelect } from "@opencode/core/shell/select"
import { Job } from "@opencode/core/job"
import { Global } from "@opencode/util/global"
import { Location } from "@opencode/core/location"
import { Credential } from "@opencode/core/credential"
import { WellKnown } from "@opencode/core/wellknown"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { AppProcess } from "@opencode/util/process"
import { Effect, Layer, Schema } from "effect"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { AbsolutePath } from "@opencode/core/schema"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "../plugin/fixture"
import { emptyCredentialNode, emptyWellknownNode } from "../fixture/config-nodes"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"

const it = testEffect(
  Layer.merge(PluginTestLayer, AppNodeBuilder.build(LayerNode.group([AppProcess.node, ShellSelect.node, Job.node]))),
)
const decode = Schema.decodeUnknownSync(Info)
const document = path.join(import.meta.dir, "opencode.json")

describe("config plugin reloads", () => {
  for (const input of [
    { root: ".agents", global: false },
    { root: "../.claude", global: false },
    { root: "home/.agents", global: true },
    { root: "home/.claude", global: true },
  ]) {
    it.live(`loads skills when ${input.root} appears after startup`, () =>
      Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
        Effect.flatMap((tmp) =>
          Effect.gen(function* () {
            const project = path.join(tmp.path, "project")
            const root = path.resolve(project, input.root)
            const file = path.join(project, "opencode.json")
            yield* Effect.promise(async () => {
              await fs.mkdir(path.join(project, "home"), { recursive: true })
              await fs.mkdir(path.join(project, "global"))
              await Bun.write(file, JSON.stringify({ shell: "initial" }))
            })
            return yield* Effect.gen(function* () {
              const config = yield* Config.Service
              const plugins = yield* Plugin.Service
              const skills = yield* Skill.Service
              const host = yield* PluginHost.make(plugins)
              yield* ConfigCompatibilityPlugin.Plugin.effect(host)
              expect(yield* skills.list()).toEqual([])

              const skill = path.join(root, "skills", "probe", "SKILL.md")
              yield* Effect.promise(() =>
                Bun.write(skill, "---\nname: probe\ndescription: Hot reload\n---\nTest skill"),
              )
              if (input.global) {
                // A service-wide source stays watched: the skill appears
                // without an explicit reload.
                yield* waitUntil(skills.list().pipe(Effect.map((items) => items.some((item) => item.id === "probe"))))
              } else {
                // Item 4.6: a skill file inside a project folder is not
                // watched. It applies on an explicit reload (the /refresh
                // path, which forces a rescan) instead of through a
                // per-folder file watcher.
                yield* config.reload({ force: true })
                yield* waitUntil(skills.list().pipe(Effect.map((items) => items.some((item) => item.id === "probe"))))
              }
              expect((yield* skills.list())[0]?.path).toBe(AbsolutePath.make(skill))
              yield* Effect.promise(() => fs.rm(root, { recursive: true }))
              yield* config.reload({ force: true })
              yield* waitUntil(skills.list().pipe(Effect.map((items) => items.length === 0)))
              yield* Effect.promise(() => Bun.write(skill, "---\nname: probe\ndescription: Recreated\n---\nTest skill"))
              yield* config.reload({ force: true })
              yield* waitUntil(skills.list().pipe(Effect.map((items) => items[0]?.description === "Recreated")))
            }).pipe(Effect.provide(liveConfig(project, undefined, { global: input.global })))
          }),
        ),
      ),
    )
  }

  // Item 4.6 removed the per-folder watch-startup races the two tests below
  // used to cover ("retains readiness signalled synchronously during initial
  // config startup" and "loads the first config written while a new directory
  // watch is starting"): a project's files are never watched, so no watch
  // ever starts for them. The kept service-wide watches are covered by the
  // global skills cases above and the watch-plan tests.

  for (const input of [
    { file: "opencode.json", empty: false },
    { file: "../opencode.jsonc", empty: false },
    { file: ".opencode/opencode.json", empty: false },
    { file: "../.opencode/opencode.jsonc", empty: true },
  ]) {
    it.live(`loads references when ${input.file} is first created and applies edits on reload`, () =>
      Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
        Effect.flatMap((tmp) =>
          Effect.gen(function* () {
            const project = path.join(tmp.path, "project")
            const target = path.resolve(project, input.file)
            yield* Effect.promise(() => fs.mkdir(project))
            return yield* Effect.gen(function* () {
              const plugins = yield* Plugin.Service
              const references = yield* Reference.Service
              const host = yield* PluginHost.make(plugins)
              yield* ConfigReferencePlugin.Plugin.effect(host)
              expect(yield* references.list()).toEqual([])

              // Item 4.6: a project opencode.json is not watched. Each change
              // below applies on an explicit reload (the /refresh path)
              // instead of through a per-folder file watcher.
              const config = yield* Config.Service
              if (input.empty) {
                yield* Effect.promise(() => fs.mkdir(path.dirname(target), { recursive: true }))
                yield* config.reload()
              }
              yield* Effect.promise(async () => {
                await fs.mkdir(path.dirname(target), { recursive: true })
                await fs.writeFile(target, JSON.stringify({ references: { docs: "./docs" } }))
              })
              yield* config.reload()
              yield* waitUntil(
                references.list().pipe(Effect.map((items) => items.some((item) => item.name === "docs"))),
              )
              expect((yield* references.list())[0]?.path).toBe(
                AbsolutePath.make(path.join(path.dirname(target), "docs")),
              )
              yield* Effect.promise(() => fs.writeFile(target, JSON.stringify({ references: { next: "./next" } })))
              yield* config.reload()
              yield* waitUntil(
                references.list().pipe(Effect.map((items) => items.length === 1 && items[0]?.name === "next")),
              )

              yield* Effect.promise(() =>
                fs.rm(input.file.includes(".opencode/") ? path.dirname(target) : target, { recursive: true }),
              )
              yield* config.reload()
              yield* waitUntil(references.list().pipe(Effect.map((items) => items.length === 0)))
              yield* Effect.promise(async () => {
                await fs.mkdir(path.dirname(target), { recursive: true })
                await fs.writeFile(target, JSON.stringify({ references: { docs: "./docs" } }))
              })
              yield* config.reload()
              yield* waitUntil(
                references.list().pipe(Effect.map((items) => items.length === 1 && items[0]?.name === "docs")),
              )
              yield* Effect.promise(() => fs.writeFile(target, JSON.stringify({ references: { next: "./next" } })))
              yield* config.reload()
              yield* waitUntil(
                references.list().pipe(Effect.map((items) => items.length === 1 && items[0]?.name === "next")),
              )
            }).pipe(Effect.provide(liveConfig(project)))
          }),
        ),
      ),
    )
  }

  it.effect("preserves reference precedence and insertion order across documents", () =>
    Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      const references = yield* Reference.Service
      const host = yield* PluginHost.make(plugins)
      yield* references.transform((editor) =>
        editor.add(
          "external",
          Reference.LocalSource.make({ type: "local", path: AbsolutePath.make("/references/external") }),
        ),
      )
      yield* ConfigReferencePlugin.Plugin.effect(host)

      const result = yield* references.list()
      expect(result.map((reference) => reference.name)).toEqual(["external", "shared", "first", "second"])
      expect(result.find((reference) => reference.name === "shared")?.path).toBe(
        AbsolutePath.make(path.resolve("/config/second/shared")),
      )
    }).pipe(
      Effect.provide(
        Config.testLayer([
          referenceConfig("/config/first/opencode.json", {
            shared: "./shared",
            first: "./first",
          }),
          referenceConfig("/config/second/opencode.json", {
            shared: "./shared",
            second: "./second",
          }),
        ]),
      ),
      Effect.provideService(Global.Service, Global.Service.of(Global.make())),
    ),
  )

  it.live("reloads config-backed domains without reloading external plugins", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const providers = yield* Provider.Service
      const commands = yield* Command.Service
      const integrations = yield* Integration.Service
      const bus = yield* Bus.Service
      const plugins = yield* Plugin.Service
      const references = yield* Reference.Service
      const skills = yield* Skill.Service
      const host = yield* PluginHost.make(plugins)
      const test = yield* Config.Test

      yield* ConfigAgentPlugin.Plugin.effect(host)
      yield* ConfigCommandPlugin.Plugin.effect(host)
      yield* ConfigSkillPlugin.Plugin.effect(host)
      yield* ConfigReferencePlugin.Plugin.effect(host)
      yield* ConfigProviderPlugin.Plugin.effect(host)

      expect((yield* agents.get(Agent.ID.make("first")))?.description).toBe("First agent")
      expect((yield* commands.get("first"))?.description).toBe("First command")
      expect(yield* integrations.get(Integration.ID.make("first"))).toBeDefined()
      expect((yield* skills.list()).some((skill) => skill.id === "first")).toBe(true)
      expect((yield* references.list()).map((reference) => reference.name)).toEqual(["first"])
      expect(yield* providers.get(Provider.ID.make("first"))).toBeDefined()

      yield* test.setEntries([config("second")])
      yield* Effect.yieldNow
      yield* bus.publish(Event.Updated, {})
      yield* waitUntil(
        Effect.gen(function* () {
          return (
            (yield* agents.get(Agent.ID.make("first"))) === undefined &&
            (yield* agents.get(Agent.ID.make("second")))?.description === "Second agent" &&
            (yield* commands.get("first")) === undefined &&
            (yield* commands.get("second"))?.description === "Second command" &&
            (yield* integrations.get(Integration.ID.make("first"))) === undefined &&
            (yield* integrations.get(Integration.ID.make("second"))) !== undefined &&
            (yield* references.list()).some((reference) => reference.name === "second") &&
            (yield* providers.get(Provider.ID.make("first"))) === undefined &&
            (yield* providers.get(Provider.ID.make("second"))) !== undefined
          )
        }),
      )

      expect((yield* skills.list()).some((skill) => skill.id === "first")).toBe(false)
      expect((yield* skills.list()).some((skill) => skill.id === "second")).toBe(true)
    }).pipe(
      Effect.provide(Config.testLayer([config("first")])),
      Effect.provideService(Global.Service, Global.Service.of(Global.make())),
    ),
  )
})

function liveConfig(directory: string, native?: Watcher.NativeInterface, options: Config.Options = { global: false }) {
  return AppNodeBuilder.build(LayerNode.group([Config.node, Bus.node, Reference.node, Global.node, Location.node]), [
    Config.node.replace(Config.configured(options)),
    Location.node.replace(
      Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
    ),
    Global.node.replace(
      Global.layerWith({ config: path.join(directory, "global"), home: path.join(directory, "home") }),
    ),
    Credential.node.replace(emptyCredentialNode),
    WellKnown.node.replace(emptyWellknownNode),
    ...(native
      ? [Watcher.node.replace(Watcher.layer().pipe(Layer.provide(Layer.succeed(Watcher.Native, native))))]
      : []),
  ])
}

function config(name: string) {
  return new Document({
    type: "document",
    path: AbsolutePath.make(document),
    info: decode({
      agents: { [name]: { description: `${title(name)} agent`, mode: "subagent" } },
      commands: { [name]: { template: `${title(name)} command`, description: `${title(name)} command` } },
      skills: [path.join(import.meta.dir, "fixture", "skills", `${name}-source`)],
      references: { [name]: `/references/${name}` },
      providers: { [name]: { models: { chat: { name: `${title(name)} model` } } } },
    }),
  })
}

function referenceConfig(file: string, references: Record<string, string>) {
  return new Document({
    type: "document",
    path: AbsolutePath.make(file),
    info: decode({ references }),
  })
}

function title(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

const waitUntil = Effect.fnUntraced(function* (condition: Effect.Effect<boolean>) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (yield* condition) return
    yield* Effect.sleep("10 millis")
  }
  return yield* Effect.die("Timed out waiting for config plugin reloads")
})
