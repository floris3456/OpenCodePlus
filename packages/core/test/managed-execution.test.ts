import path from "path"
import { describe, expect } from "bun:test"
import { Document } from "@opencode/schema/config"
import { Config } from "@opencode/core/config"
import { Credential } from "@opencode/core/credential"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { EnvironmentService } from "@opencode/core/environment/environment"
import { Environment } from "@opencode/core/environment/index"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { InstructionDiscovery } from "@opencode/core/instruction-discovery"
import { Integration } from "@opencode/core/integration"
import { KV } from "@opencode/core/kv"
import { Location } from "@opencode/core/location"
import { Mcp } from "@opencode/core/mcp/index"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { AbsolutePath } from "@opencode/core/schema"
import { Shell } from "@opencode/core/shell"
import { WellKnown } from "@opencode/core/wellknown"
import { Workspace } from "@opencode/core/workspace"
import { WorkspaceDriver } from "@opencode/core/workspace/driver"
import { Worktree } from "@opencode/core/worktree"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { Cause, Effect, Exit, Layer } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { emptyCredentialNode, emptyWellknownNode } from "./fixture/config-nodes"
import { tempGlobalLayer } from "./fixture/global"
import { location } from "./fixture/location"
import { emptyMcpLayer } from "./fixture/mcp"
import { tmpdirScoped } from "./fixture/tmpdir"
import { it, testEffect } from "./lib/effect"
import { PluginTestLayer } from "./plugin/fixture"

/**
 * Managed placement, driven through the real location services rather than stubs of them: a
 * location carrying a `workspaceID` must never reach the host machine, and a placed location whose
 * workspace cannot be bound must refuse work instead of degrading to the host.
 */
const workspaceID = Workspace.ID.make("wrk_managed_execution")
// A real host directory, so "the host can see it, the workspace cannot" is an honest contrast.
const directory = AbsolutePath.make(import.meta.dir)
const hostRef = Location.Ref.make({ directory })
const placedRef = Location.Ref.make({ directory, workspaceID })

const unreachable: Workspace.Interface["connect"] = () =>
  Effect.fail(new WorkspaceDriver.Error({ message: "workspace unreachable" }))

const reachable =
  (driver: Environment.Driver): Workspace.Interface["connect"] =>
  () =>
    Effect.succeed(driver)

const locationLayer = (ref: Location.Ref) => Layer.succeed(Location.Service, Location.Service.of(location(ref)))

const workspaceLayer = (connect: Workspace.Interface["connect"]) =>
  Layer.succeed(
    Workspace.Service,
    Workspace.Service.of({
      connect,
      create: () => Effect.die("unused Workspace.create"),
      provision: () => Effect.die("unused Workspace.provision"),
      destroy: () => Effect.die("unused Workspace.destroy"),
    }),
  )

const environmentLayer = (ref: Location.Ref, connect: Workspace.Interface["connect"]) =>
  LayerNode.compile(Environment.node, {
    replacements: [Location.node.replace(locationLayer(ref)), Workspace.node.replace(workspaceLayer(connect))],
  })

// Config owns filesystem watches; a test only needs its parse and placement behavior.
const inertWatcher = Watcher.nativeNode.replace(
  Layer.succeed(Watcher.Native, Watcher.Native.of({ subscribe: () => Effect.succeed(undefined) })),
)

/** The defect a fail-closed service died with, or its value when it did not die. */
const outcome = <A>(effect: Effect.Effect<A>) =>
  effect.pipe(Effect.exit, Effect.map((exit) => (Exit.isFailure(exit) ? Cause.squash(exit.cause) : exit.value)))

const placedReplacements = (ref: Location.Ref, connect: Workspace.Interface["connect"]): LayerNode.Replacements => [
  Location.node.replace(locationLayer(ref)),
  Workspace.node.replace(workspaceLayer(connect)),
  Global.node.replace(tempGlobalLayer),
  Credential.node.replace(emptyCredentialNode),
  WellKnown.node.replace(emptyWellknownNode),
  Config.node.replace(Config.configured({ global: false })),
  inertWatcher,
]

describe("Environment placement", () => {
  it.effect("binds an unplaced location to the host", () =>
    Effect.gen(function* () {
      const environment = yield* Environment.Service
      expect(environment.placement).toEqual({ kind: "host" })
      expect((yield* environment.files.stat(directory)).type).toBe("directory")
    }).pipe(Effect.provide(environmentLayer(hostRef, unreachable))),
  )

  it.effect("routes a placed location through its workspace driver", () =>
    Effect.gen(function* () {
      const environment = yield* Environment.Service
      expect(environment.placement).toEqual({ kind: "workspace", workspaceID })
      expect(yield* environment.files.stat(directory).pipe(Effect.flip)).toBeInstanceOf(Environment.NotFound)

      yield* environment.files.write("/managed.txt", new TextEncoder().encode("placed"))
      expect(new TextDecoder().decode((yield* environment.files.read("/managed.txt")).bytes)).toBe("placed")
    }).pipe(Effect.provide(environmentLayer(placedRef, reachable(Environment.makeMemoryDriver())))),
  )

  it.effect("fails every file operation and spawn when the workspace cannot be bound", () =>
    Effect.gen(function* () {
      const environment = yield* Environment.Service
      if (environment.placement.kind !== "unplaceable")
        throw new Error(`expected an unplaceable placement, got ${environment.placement.kind}`)
      const error = environment.placement.error
      expect(error).toBeInstanceOf(EnvironmentService.UnplaceableError)
      expect(environment.placement.workspaceID).toBe(workspaceID)
      expect(error.workspaceID).toBe(workspaceID)
      expect(error.cause).toBeInstanceOf(WorkspaceDriver.Error)

      const files = environment.files
      const operations: ReadonlyArray<
        readonly [string, Effect.Effect<unknown, Environment.NotFound | Environment.WrongKind | Environment.Failed>]
      > = [
        ["read", files.read("/probe")],
        ["write", files.write("/probe", new TextEncoder().encode("leak"))],
        ["stat", files.stat("/probe")],
        ["list", files.list("/probe")],
        ["remove", files.remove("/probe")],
        ["move", files.move("/probe", "/probe-moved")],
        ["mkdir", files.mkdir("/probe")],
      ]
      expect(
        yield* Effect.forEach(operations, ([name, operation]) =>
          operation.pipe(
            Effect.flip,
            Effect.map(
              (failure) =>
                [name, failure._tag, failure._tag === "Environment.Failed" && failure.cause === error] as const,
            ),
          ),
        ),
      ).toEqual([
        ["read", "Environment.Failed", true],
        ["write", "Environment.Failed", true],
        ["stat", "Environment.Failed", true],
        ["list", "Environment.Failed", true],
        ["remove", "Environment.Failed", true],
        ["move", "Environment.Failed", true],
        ["mkdir", "Environment.Failed", true],
      ])

      const spawned = yield* environment.spawner.spawn(ChildProcess.make("printenv", [])).pipe(Effect.flip)
      expect(spawned._tag).toBe("PlatformError")
      expect(spawned.message).toContain(error.message)
    }).pipe(Effect.provide(environmentLayer(placedRef, unreachable))),
  )
})

describe("Config placement", () => {
  // Environment before Config mirrors the instance graph, where earlier location services are
  // visible to later ones.
  const graph = LayerNode.group([Environment.node, Config.node])

  it.live("dies instead of serving host config to an unbound workspace", () =>
    Effect.gen(function* () {
      const config = yield* Config.Service
      expect(yield* outcome(config.entries())).toBeInstanceOf(EnvironmentService.UnplaceableError)
    }).pipe(Effect.provide(LayerNode.compile(graph, { replacements: placedReplacements(placedRef, unreachable) }))),
  )

  it.live("serves config for a bound workspace placement", () =>
    Effect.gen(function* () {
      const config = yield* Config.Service
      // The workspace filesystem holds no config documents, and no host document leaks in.
      expect((yield* config.entries()).filter((entry) => entry.type === "document")).toEqual([])
    }).pipe(
      Effect.provide(
        LayerNode.compile(graph, {
          replacements: placedReplacements(placedRef, reachable(Environment.makeMemoryDriver())),
        }),
      ),
    ),
  )

  const placedEntries = (driver: Environment.Driver) =>
    Effect.gen(function* () {
      const config = yield* Config.Service
      return yield* config.entries()
    }).pipe(
      Effect.provide(LayerNode.compile(graph, { replacements: placedReplacements(placedRef, reachable(driver)) })),
    )

  const hostCredential = Effect.fnUntraced(function* () {
    const tmp = yield* tmpdirScoped()
    const filepath = path.join(tmp.path, "credential.txt")
    const secret = "host-only-credential-value"
    yield* Effect.promise(() => Bun.write(filepath, secret))
    // The negative assertions below only mean something while this really is readable host state.
    expect(yield* Effect.promise(() => Bun.file(filepath).text())).toBe(secret)
    return { filepath, secret }
  })

  // Both files here are agent-writable in a managed placement, so this is the workspace naming a
  // host path: the token a workspace file's content contributes is data, not a second reference to
  // resolve. Resolving it would read that host path into the placed document.
  it.live("leaves a host path named by workspace file content unresolved", () =>
    Effect.gen(function* () {
      const host = yield* hostCredential()
      const driver = Environment.makeMemoryDriver()
      const files = Environment.makeFiles(driver)
      const encoder = new TextEncoder()
      yield* files.write(path.join(directory, "token.txt"), encoder.encode(`{file:${host.filepath}}`))
      yield* files.write(
        path.join(directory, "opencode.jsonc"),
        encoder.encode(`{
          // Ignored reference: {file:./absent.txt}
          "shell": "shell-{env:PATH}",
          "username": "{file:./token.txt}"
        }`),
      )

      const documents = (yield* placedEntries(driver)).filter((entry): entry is Document => entry.type === "document")
      expect(documents.length).toBe(1)
      // The workspace reference resolved, and the host path its content names stayed literal text.
      // The commented-out reference stayed verbatim too, as it does on the host: resolving it would
      // have failed the document on its absent target.
      expect(documents[0].info.username).toBe(`{file:${host.filepath}}`)
      expect(documents[0].info.username).not.toContain(host.secret)
      // A placed document reads no host environment either.
      expect(process.env.PATH).toBeTruthy()
      expect(documents[0].info.shell).toBe("shell-")
    }),
  )

  it.live("refuses a placed config that references a host path", () =>
    Effect.gen(function* () {
      const host = yield* hostCredential()
      const driver = Environment.makeMemoryDriver()
      yield* Environment.makeFiles(driver).write(
        path.join(directory, "opencode.json"),
        new TextEncoder().encode(JSON.stringify({ username: `{file:${host.filepath}}` })),
      )

      const exit = yield* Effect.exit(placedEntries(driver))
      if (!Exit.isFailure(exit)) throw new Error("a placed config resolved a host file reference")
      // The workspace has no such path, and an unreadable reference fails the document rather than
      // substituting an empty value.
      expect(Cause.squash(exit.cause)).toMatchObject({
        name: "ConfigInvalidError",
        data: {
          message: `bad file reference: "{file:${host.filepath}}" ${host.filepath} does not exist`,
        },
      })
    }),
  )
})

describe("InstructionDiscovery placement", () => {
  const graph = LayerNode.group([Environment.node, InstructionDiscovery.node])

  it.effect("dies instead of serving host instructions to an unbound workspace", () =>
    Effect.gen(function* () {
      const discovery = yield* InstructionDiscovery.Service
      expect(yield* outcome(discovery.list())).toBeInstanceOf(EnvironmentService.UnplaceableError)
      expect(yield* outcome(discovery.load())).toBeInstanceOf(EnvironmentService.UnplaceableError)
    }).pipe(Effect.provide(LayerNode.compile(graph, { replacements: placedReplacements(placedRef, unreachable) }))),
  )

  it.effect("serves instructions for a bound workspace placement", () =>
    Effect.gen(function* () {
      const discovery = yield* InstructionDiscovery.Service
      expect(yield* discovery.list()).toEqual([])
    }).pipe(
      Effect.provide(
        LayerNode.compile(graph, {
          replacements: placedReplacements(placedRef, reachable(Environment.makeMemoryDriver())),
        }),
      ),
    ),
  )
})

describe("Shell placement", () => {
  const shellLayer = (ref: Location.Ref, connect: Workspace.Interface["connect"]) =>
    AppNodeBuilder.build(Shell.node, [
      Location.node.replace(locationLayer(ref)),
      Global.node.replace(tempGlobalLayer),
      Config.node.replace(Config.testLayer()),
      Environment.node.replace(environmentLayer(ref, connect)),
    ])

  // Stop the command once its environment is resolved: the assembled env is the subject, and
  // failing in `before` keeps the test from spawning anything.
  const resolvedEnv = Effect.fnUntraced(function* () {
    const shell = yield* Shell.Service
    let resolved: Record<string, string | undefined> | undefined
    const halted = yield* shell
      .create({ command: "printenv", timeout: 0 }, (invocation) =>
        Effect.sync(() => {
          resolved = invocation.env
        }).pipe(Effect.andThen(Effect.fail("halt" as const))),
      )
      .pipe(Effect.flip)
    expect(halted).toBe("halt")
    return resolved
  })

  it.live("never inherits this process's environment when placed", () =>
    Effect.gen(function* () {
      expect(yield* resolvedEnv()).toEqual({ TERM: "xterm-256color", OPENCODE_TERMINAL: "1" })
    }).pipe(Effect.provide(shellLayer(placedRef, reachable(Environment.makeMemoryDriver())))),
  )

  it.live("inherits this process's environment when unplaced", () =>
    Effect.gen(function* () {
      const inherited = Object.keys(process.env).find((key) => key !== "TERM" && key !== "OPENCODE_TERMINAL")
      if (inherited === undefined) throw new Error("this process exposes no environment variable to inherit")
      expect((yield* resolvedEnv())?.[inherited]).toBe(process.env[inherited])
    }).pipe(Effect.provide(shellLayer(hostRef, unreachable))),
  )

  it.live("refuses to run at all while its workspace is unbound", () =>
    Effect.gen(function* () {
      const shell = yield* Shell.Service
      const failure = yield* shell.create({ command: "printenv", timeout: 0 }).pipe(Effect.flip)
      expect(failure._tag).toBe("AppProcessError")
      expect(failure.cause).toBeInstanceOf(EnvironmentService.UnplaceableError)
    }).pipe(Effect.provide(shellLayer(placedRef, unreachable))),
  )
})

const pluginIt = testEffect(PluginTestLayer)

// The real plugin loader, placed. `Plugin.Service.activate` is the only path a production plugin's
// storage ever comes from, so per-workspace namespacing has to be proved through it.
const placedPluginIt = testEffect(
  AppNodeBuilder.build(LayerNode.group([Plugin.node, KV.node]), [
    ...placedReplacements(placedRef, reachable(Environment.makeMemoryDriver())),
    Mcp.node.replace(emptyMcpLayer),
  ]),
)

describe("placed plugin host", () => {
  const placedHost = Effect.fnUntraced(function* () {
    const plugins = yield* Plugin.Service
    return yield* PluginHost.make(plugins).pipe(
      Effect.provideService(Location.Service, Location.Service.of(location(placedRef))),
    )
  })

  pluginIt.live("refuses host credential store access", () =>
    Effect.gen(function* () {
      const host = yield* placedHost()
      expect(
        yield* host.integration.connect
          .key({ integrationID: Integration.ID.make("probe"), key: "secret" })
          .pipe(Effect.flip),
      ).toBeInstanceOf(PluginHost.PlacedHostAccessError)
      expect(
        yield* host.integration.connection
          .resolve({ type: "credential", id: "cred_probe", label: "probe" })
          .pipe(Effect.flip),
      ).toBeInstanceOf(PluginHost.PlacedHostAccessError)
    }),
  )

  pluginIt.live("refuses to create an unplaced host session", () =>
    Effect.gen(function* () {
      const host = yield* placedHost()
      expect(yield* host.session.create({ location: hostRef }).pipe(Effect.flip)).toBeInstanceOf(
        PluginHost.PlacedHostAccessError,
      )
    }),
  )

  pluginIt.live("keeps placed plugin storage out of the host namespace", () =>
    Effect.gen(function* () {
      const kv = yield* KV.Service
      const placed = PluginHost.storage(kv, "probe", workspaceID)
      const host = PluginHost.storage(kv, "probe")

      yield* placed.set("token", "placed")
      yield* host.set("token", "host")

      expect(yield* placed.get("token")).toBe("placed")
      expect(yield* host.get("token")).toBe("host")
      expect((yield* placed.scan({ prefix: "" })).entries).toEqual([{ key: "token", value: "placed" }])
      expect((yield* host.scan({ prefix: "" })).entries).toEqual([{ key: "token", value: "host" }])

      yield* placed.remove("token")
      expect(yield* placed.get("token")).toBeUndefined()
      expect(yield* host.get("token")).toBe("host")
    }),
  )

  placedPluginIt.live("namespaces a loaded plugin's storage by workspace", () =>
    Effect.gen(function* () {
      const kv = yield* KV.Service
      const plugins = yield* Plugin.Service
      yield* plugins.activate([
        { id: "probe", revision: "1", effect: (context) => context.storage.set("token", "placed") },
      ])
      yield* plugins.awaitActivation

      expect((yield* PluginHost.storage(kv, "probe", workspaceID).scan({ prefix: "" })).entries).toEqual([
        { key: "token", value: "placed" },
      ])
      expect(yield* PluginHost.storage(kv, "probe").get("token")).toBeUndefined()
    }),
  )

  pluginIt.live("routes a plugin call to the placement it names, not the ambient one", () =>
    Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      const host = yield* PluginHost.make(plugins)
      const hostDirectory = host.location.directory

      // This host carries no workspace, so a request naming one must refuse rather than
      // quietly answer from the host's own worktrees. Both spellings of the placement route
      // the same way: the wire shape, and the `Location.Ref` every response hands back.
      const named = Location.Ref.make({ directory: hostDirectory, workspaceID })
      expect(yield* host.worktree.list({ location: named }).pipe(Effect.flip)).toBeInstanceOf(
        Worktree.UnsupportedLocationError,
      )
      expect(
        yield* host.worktree.list({ location: { directory: hostDirectory, workspace: workspaceID } }).pipe(Effect.flip),
      ).toBeInstanceOf(Worktree.UnsupportedLocationError)
      expect(yield* host.worktree.list({ location: { directory: hostDirectory } })).toEqual([])
    }),
  )
})
