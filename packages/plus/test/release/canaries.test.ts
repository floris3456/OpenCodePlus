/**
 * Separation canaries for round-4 outcome 5.
 *
 * Each block asserts one thing a task executor must not be able to do, from the placement/executor
 * point of view: file, shell, PTY, environment, config substitutions, executable plugins/tools/MCP,
 * Git hooks, plus the one positive property — reviewed safety instructions still reach a session
 * under placement. A canary is a test that fails loudly if the boundary regresses, so every
 * assertion here drives a real implementation rather than a copy of its logic.
 *
 * Several blocks deliberately lean on existing coverage rather than re-deriving it:
 *   - `packages/core/test/managed-execution.test.ts` proves Environment placement, unplaceable
 *     refusal, placed config reads, placed Shell environment, and placed plugin-host namespacing.
 *   - `packages/core/test/environment.test.ts` proves the no-execution-plane spawner refusal.
 *   - `packages/core/test/mcp.test.ts` proves MCP stdio spawns through the location Environment.
 *   - `packages/core/test/tool-permission-gate.test.ts` proves the registry's plugin-tool gate.
 *   - `packages/plus/test/teams/checks.test.ts` proves the check executor and its receipts.
 *   - `packages/plus/test/teams/roles.test.ts` proves built-in role ceilings (shell only for
 *     orchestrators).
 *
 * Two dimensions cannot be fully proven from an in-process unit seat and are reported to the
 * parent: PTY allocation is not routed through the Environment seam, and the product's git
 * operations do not neutralize planted hooks. The executable-plugin loading path that resolves
 * host filesystem targets is a third reported finding. All three are named in the test bodies and
 * in the report, with the operational gate each one needs.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Agent } from "@opencode/schema/agent"
import { Document, type Entry } from "@opencode/schema/config"
import { Project } from "@opencode/schema/project"
import { AbsolutePath } from "@opencode/schema/schema"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { Global } from "@opencode/util/global"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Cause, Context, Effect, Exit, Layer, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { AppNodeBuilder } from "../../../core/src/effect/app-node-builder.js"
import { Config } from "../../../core/src/config.js"
import { ConfigVariable } from "../../../core/src/config/variable.js"
import { Credential } from "../../../core/src/credential.js"
import { Environment } from "../../../core/src/environment/index.js"
import { EnvironmentService } from "../../../core/src/environment/environment.js"
import { EnvironmentUnavailable } from "../../../core/src/environment/unavailable.js"
import { InstructionDiscovery } from "../../../core/src/instruction-discovery.js"
import { Instructions } from "../../../core/src/instructions/index.js"
import { Location } from "../../../core/src/location.js"
import { Mcp } from "../../../core/src/mcp/index.js"
import { make } from "../../../core/src/mcp/stdio.js"
import { PluginHost } from "../../../core/src/plugin/host.js"
import { ReleaseRequestStore } from "../../../core/src/release/request.js"
import { Shell } from "../../../core/src/shell.js"
import { assertToolPermission } from "../../../core/src/tool/permission-gate.js"
import { Watcher } from "../../../core/src/filesystem/watcher.js"
import { WellKnown } from "../../../core/src/wellknown.js"
import { Workspace } from "../../../core/src/workspace.js"
import { WorkspaceDriver } from "../../../core/src/workspace/driver.js"
import { PtyEnvironment } from "../../../server/src/pty-environment.js"
import { spawn } from "../../../core/src/pty/pty.workerd.js"
import { execute } from "../../src/teams/checks.js"
import { git } from "../../src/teams/git.js"
import { create } from "../../src/teams/worktree.js"

const repoRoot = join(import.meta.dirname, "../../../..")
const WORKSPACE_ID = Workspace.ID.make("wrk_canary_separation")
const encoder = new TextEncoder()
const decoder = new TextDecoder()

// Values planted by this process, not real credentials: the point is that a host-readable marker
// must not cross the placement seam.
const HOST_SECRET_CONTENT = `{"api_key":"canary-host-secret-value"}`
const HOST_SECRET_KEY = "OPENCODE_CANARY_HOST_SECRET"
const HOST_SECRET_VALUE = "canary-host-secret-value"
const LIVE_URL_KEY = "OPENCODE_CANARY_LIVE_URL"
const LIVE_URL_VALUE = "https://127.0.0.1:1/canary-live"

// The real refusal text emitted by packages/core/src/environment/unavailable.ts. Assertions below
// compare against this emitted text, never against a copy that lives only in this test.
const NO_EXECUTION_PLANE =
  "This location has no execution plane: no workspace is attached and the host cannot spawn processes"

let scratch = ""
let hostDirectory = ""
let secretPath = ""

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "separation-canaries-"))
  hostDirectory = join(scratch, "host")
  const stateRoot = join(scratch, "product-state")
  secretPath = join(stateRoot, "config", "opencode", "auth.json")
  await mkdir(hostDirectory, { recursive: true })
  await mkdir(join(scratch, "global", "data"), { recursive: true })
  await mkdir(join(scratch, "global", "cache"), { recursive: true })
  await mkdir(join(scratch, "global", "config"), { recursive: true })
  await mkdir(join(scratch, "global", "state"), { recursive: true })
  await mkdir(join(scratch, "global", "tmp"), { recursive: true })
  await mkdir(join(stateRoot, "config", "opencode"), { recursive: true })
  await writeFile(secretPath, HOST_SECRET_CONTENT)
  process.env[HOST_SECRET_KEY] = HOST_SECRET_VALUE
  process.env[LIVE_URL_KEY] = LIVE_URL_VALUE
})

afterAll(async () => {
  delete process.env[HOST_SECRET_KEY]
  delete process.env[LIVE_URL_KEY]
  await rm(scratch, { recursive: true, force: true })
})

const unreachable: Workspace.Interface["connect"] = () =>
  Effect.fail(new WorkspaceDriver.Error({ message: "canary workspace unreachable" }))

const reachable =
  (driver: Environment.Driver): Workspace.Interface["connect"] =>
  () =>
    Effect.succeed(driver)

const hostRef = (directory: string) => Location.Ref.make({ directory: AbsolutePath.make(directory) })
const placedRef = (directory: string) =>
  Location.Ref.make({ directory: AbsolutePath.make(directory), workspaceID: WORKSPACE_ID })

const locationLayer = (ref: Location.Ref) =>
  Layer.succeed(
    Location.Service,
    Location.Service.of({
      directory: ref.directory,
      workspaceID: ref.workspaceID,
      project: { id: Project.ID.global, directory: ref.directory, canonical: ref.directory },
    }),
  )

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

/** The real Environment node, bound to a test Location and a test Workspace. */
const environmentLayer = (ref: Location.Ref, connect: Workspace.Interface["connect"]) =>
  LayerNode.compile(Environment.node, {
    replacements: [Location.node.replace(locationLayer(ref)), Workspace.node.replace(workspaceLayer(connect))],
  })

/** An isolated Global root: config/data/state/cache never touch this machine's real roots. */
const globalLayer = () => {
  const root = join(scratch, "global")
  return Layer.succeed(
    Global.Service,
    Global.Service.of(
      Global.make({
        home: root,
        data: join(root, "data"),
        cache: join(root, "cache"),
        config: join(root, "config"),
        state: join(root, "state"),
        tmp: join(root, "tmp"),
        bin: join(root, "cache", "bin"),
        log: join(root, "data", "log"),
        repos: join(root, "data", "repos"),
      }),
    ),
  )
}

// Periphery for the config/host graphs, modelled on packages/core/test/fixture/config-nodes.ts and
// packages/core/test/fixture/mcp.ts: they are not the subject of any canary and must not be reached.
const emptyCredentialLayer = Layer.succeed(
  Credential.Service,
  Credential.Service.of({
    all: () => Effect.succeed([]),
    list: () => Effect.succeed([]),
    get: () => Effect.undefined,
    create: () => Effect.die("unused Credential.create"),
    activate: () => Effect.die("unused Credential.activate"),
    update: () => Effect.die("unused Credential.update"),
    remove: () => Effect.die("unused Credential.remove"),
  }),
)

const emptyWellKnownLayer = Layer.succeed(
  WellKnown.Service,
  WellKnown.Service.of({
    entries: () => Effect.succeed([]),
    snapshot: () => [],
    refresh: () => Effect.succeed(false),
    add: () => Effect.die("unused WellKnown.add"),
    remove: () => Effect.die("unused WellKnown.remove"),
    resolve: () => Effect.die("unused WellKnown.resolve"),
  }),
)

const emptyMcpLayer = Layer.succeed(
  Mcp.Service,
  Mcp.Service.of({
    transform: () => Effect.die("unused mcp.transform"),
    reload: () => Effect.die("unused mcp.reload"),
    servers: () => Effect.succeed([]),
    add: () => Effect.die("unused mcp.add"),
    connect: () => Effect.die("unused mcp.connect"),
    disconnect: () => Effect.die("unused mcp.disconnect"),
    remove: () => Effect.die("unused mcp.remove"),
    tools: () => Effect.succeed([]),
    callTool: () => Effect.die("unused mcp.callTool"),
    instructions: () => Effect.succeed([]),
    prompts: () => Effect.succeed([]),
    prompt: () => Effect.undefined,
    resourceCatalog: () => Effect.succeed(Mcp.ResourceCatalog.make({ resources: [], templates: [] })),
    readResource: () => Effect.undefined,
  }),
)

// Config owns filesystem watches; these canaries only need its parse and placement behavior.
const inertWatcher = Watcher.nativeNode.replace(
  Layer.succeed(Watcher.Native, Watcher.Native.of({ subscribe: () => Effect.succeed(undefined) })),
)

const sharedReplacements = (ref: Location.Ref, connect: Workspace.Interface["connect"]): LayerNode.Replacements => [
  Location.node.replace(locationLayer(ref)),
  Workspace.node.replace(workspaceLayer(connect)),
  Global.node.replace(globalLayer()),
  Credential.node.replace(emptyCredentialLayer),
  WellKnown.node.replace(emptyWellKnownLayer),
  Config.node.replace(Config.configured({ global: false })),
  inertWatcher,
]

const configLayer = (ref: Location.Ref, connect: Workspace.Interface["connect"]) =>
  LayerNode.compile(LayerNode.group([Environment.node, Config.node]), {
    replacements: sharedReplacements(ref, connect),
  })

const shellLayer = (ref: Location.Ref, connect: Workspace.Interface["connect"]) =>
  AppNodeBuilder.build(Shell.node, [
    Location.node.replace(locationLayer(ref)),
    Global.node.replace(globalLayer()),
    Config.node.replace(Config.testLayer()),
    Environment.node.replace(environmentLayer(ref, connect)),
  ])

/**
 * The full plugin-host graph the production instance assembles, at a test placement. The durable
 * ReleaseRequestStore is part of `PluginHost.requirements`, so it is present here by construction:
 * that is exactly the requirement the canary below removes from the runtime context.
 */
const pluginHostLayer = (ref: Location.Ref, connect: Workspace.Interface["connect"]) =>
  AppNodeBuilder.build(PluginHost.requirements, [
    ...sharedReplacements(ref, connect),
    Mcp.node.replace(emptyMcpLayer),
  ])

const documentAt = (entries: Entry[], path: string): Document | undefined =>
  entries.find((entry): entry is Document => entry.type === "document" && entry.path === path)

/**
 * Erase an Effect's service requirements for a canary that removes a service from the runtime
 * context on purpose. The built context is a superset except for the omitted key, so this only
 * discards the type-level witness that the host itself must still prove at runtime.
 */
const eraseRequirements = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, never> =>
  effect as Effect.Effect<A, E, never>

/** Resolve the environment a Shell command would start with, halting before any process spawns. */
const resolveShellEnv = async (ref: Location.Ref, connect: Workspace.Interface["connect"]) => {
  const resolved = await Effect.runPromise(
    Effect.gen(function* () {
      const shell = yield* Shell.Service
      let invocationEnv: Readonly<Record<string, string | undefined>> | undefined
      const halted = yield* shell
        .create({ command: "printenv", timeout: 0 }, (invocation) =>
          Effect.sync(() => {
            invocationEnv = invocation.env
          }).pipe(Effect.andThen(Effect.fail("halt" as const))),
        )
        .pipe(Effect.flip)
      if (halted !== "halt") throw new Error(`shell did not halt before spawning: ${String(halted)}`)
      return invocationEnv
    }).pipe(Effect.provide(shellLayer(ref, connect))),
  )
  if (resolved === undefined) throw new Error("shell did not resolve an invocation environment")
  return resolved
}

// The memory driver is a real workspace filesystem: operations against it either reach the
// workspace or fail there. Nothing on this machine can be reached through it.
const memoryFiles = (driver: Environment.Driver) => Environment.makeFiles(driver)

describe("file: an executor-placed filesystem operation cannot reach host state", () => {
  test("the control reads the planted state on the host; the placed read cannot", async () => {
    const control = await Effect.runPromise(
      Effect.gen(function* () {
        const environment = yield* Environment.Service
        expect(environment.placement.kind).toBe("host")
        return yield* environment.files.read(secretPath)
      }).pipe(Effect.provide(environmentLayer(hostRef(hostDirectory), unreachable))),
    )
    expect(decoder.decode(control.bytes)).toBe(HOST_SECRET_CONTENT)

    const placed = await Effect.runPromise(
      Effect.gen(function* () {
        const environment = yield* Environment.Service
        expect(environment.placement).toEqual({ kind: "workspace", workspaceID: WORKSPACE_ID })
        return yield* environment.files.read(secretPath).pipe(Effect.exit)
      }).pipe(
        Effect.provide(environmentLayer(placedRef(hostDirectory), reachable(Environment.makeMemoryDriver()))),
      ),
    )
    expect(Exit.isFailure(placed)).toBe(true)
    if (!Exit.isFailure(placed)) throw new Error("a placed read reached the host secret")
    const failure = Cause.squash(placed.cause)
    expect(failure).toBeInstanceOf(Environment.NotFound)
    expect(String(failure)).not.toContain(HOST_SECRET_CONTENT)
  })

  test("traversal and symlink shapes stay inside the placed filesystem", async () => {
    const driver = Environment.makeMemoryDriver()
    const files = memoryFiles(driver)
    await Effect.runPromise(files.write("/work/inside.txt", encoder.encode("inside")))
    await Effect.runPromise(driver.symlink(secretPath, "/escape"))

    // Traversal normalizes inside the workspace root rather than against the host path it names.
    for (const path of [
      secretPath,
      join(hostDirectory, "..", "..", "product-state", "config", "opencode", "auth.json"),
      `/work/../../../product-state/config/opencode/auth.json`,
      join("/work", "..", "..", "..", "etc", "hostname"),
      "/escape",
    ]) {
      const exit = await Effect.runPromise(files.read(path).pipe(Effect.exit))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(String(Cause.squash(exit.cause))).not.toContain(HOST_SECRET_CONTENT)
    }

    // A placed write lands in the workspace plane and leaves the real host file byte-identical.
    await Effect.runPromise(files.write(secretPath, encoder.encode("workspace-copy")))
    expect(decoder.decode((await Effect.runPromise(files.read(secretPath))).bytes)).toBe("workspace-copy")
    expect(await Bun.file(secretPath).text()).toBe(HOST_SECRET_CONTENT)
  })

  test("an unbound workspace refuses every operation instead of falling back to the host", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const environment = yield* Environment.Service
        if (environment.placement.kind !== "unplaceable")
          throw new Error(`expected unplaceable, got ${environment.placement.kind}`)
        const files = environment.files
        const operations: ReadonlyArray<readonly [string, Effect.Effect<unknown, unknown>]> = [
          ["read", files.read(secretPath)],
          ["write", files.write(secretPath, encoder.encode("leak"))],
          ["stat", files.stat(secretPath)],
          ["list", files.list(secretPath)],
          ["remove", files.remove(secretPath)],
          ["move", files.move(secretPath, `${secretPath}.moved`)],
          ["mkdir", files.mkdir(secretPath)],
        ]
        const outcomes = yield* Effect.forEach(operations, ([name, operation]) =>
          operation.pipe(Effect.exit, Effect.map((exit) => [name, exit] as const)),
        )
        return { error: environment.placement.error, outcomes, spawner: environment.spawner }
      }).pipe(Effect.provide(environmentLayer(placedRef(hostDirectory), unreachable))),
    )

    for (const [name, exit] of result.outcomes) {
      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) continue
      const failure = Cause.squash(exit.cause)
      expect(`${name}:${failure instanceof Environment.Failed}`).toBe(`${name}:true`)
      if (failure instanceof Environment.Failed) expect(failure.cause).toBe(result.error)
    }

    const spawned = await Effect.runPromise(
      Effect.scoped(result.spawner.spawn(ChildProcess.make("echo", ["host"])).pipe(Effect.flip)),
    )
    expect(spawned._tag).toBe("PlatformError")
    expect(spawned.message).toContain(result.error.message)
  })
})

describe("shell: a placed command runs on the executor plane or refuses", () => {
  test("the no-execution-plane refusal is the real message from core", async () => {
    const failure = await Effect.runPromise(
      Effect.scoped(EnvironmentUnavailable.spawner.spawn(ChildProcess.make("echo", ["hello"])).pipe(Effect.flip)),
    )
    expect(failure._tag).toBe("PlatformError")
    expect(failure.message).toContain(NO_EXECUTION_PLANE)
    expect(failure.reason.module).toBe("Environment")
    expect(failure.reason.method).toBe("spawn")
  })

  test("a placed spawn reaches the workspace driver and never runs on the host", async () => {
    const host = await Effect.runPromise(
      Effect.gen(function* () {
        const environment = yield* Environment.Service
        return yield* Effect.scoped(
          environment.spawner.spawn(ChildProcess.make("echo", ["host-plane"])).pipe(Effect.as(true)),
        )
      }).pipe(Effect.provide(environmentLayer(hostRef(hostDirectory), unreachable))),
    )
    expect(host).toBe(true)

    const placed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const environment = yield* Environment.Service
          return yield* environment.spawner.spawn(ChildProcess.make("printenv", [])).pipe(Effect.flip)
        }),
      ).pipe(
        Effect.provide(environmentLayer(placedRef(hostDirectory), reachable(Environment.makeMemoryDriver()))),
      ),
    )
    expect(placed._tag).toBe("PlatformError")
    // The refusal comes from the workspace driver itself: a host fallback would have exited 0 above.
    expect(placed.reason.module).toBe("EnvironmentMemory")
    expect("pathOrDescriptor" in placed.reason ? placed.reason.pathOrDescriptor : undefined).toBe("printenv")
  })

  test("the Shell service refuses at an unbound placement with the placement cause", async () => {
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const shell = yield* Shell.Service
        return yield* shell.create({ command: "printenv", timeout: 0 }).pipe(Effect.flip)
      }).pipe(Effect.provide(shellLayer(placedRef(hostDirectory), unreachable))),
    )
    expect(failure._tag).toBe("AppProcessError")
    expect(failure.cause).toBeInstanceOf(EnvironmentService.UnplaceableError)
  })
})

/**
 * Coverage here is partial by design. Core `Pty` (packages/core/src/pty.ts) spawns through the
 * host PTY binding with `process.env` and never asks `Environment`; `PersistentPty` is a host
 * daemon process. A workspace-backed placement therefore has no PTY plane of its own yet, so the
 * canaries below pin the two refusal paths that do exist — the runtime with no PTY binding and the
 * location's PTY allocation environment seam — and the report names the container-level gate that
 * must still prove a placed PTY cannot allocate on the host.
 */
describe("pty: allocation refuses when no PTY plane exists", () => {
  test("the workerd PTY binding refuses instead of silently degrading", () => {
    expect(() => spawn()).toThrow("Pseudo-terminals are unavailable on the workerd runtime")
  })

  test("the PTY allocation environment seam carries no host environment", async () => {
    const environment = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* PtyEnvironment.Service
        return yield* service.get({ directory: hostDirectory, cwd: hostDirectory })
      }).pipe(Effect.provide(PtyEnvironment.layer)),
    )
    expect(environment).toEqual({})
    expect(environment[HOST_SECRET_KEY]).toBeUndefined()
    expect(environment[LIVE_URL_KEY]).toBeUndefined()
  })
})

describe("environment: a placed executor environment carries no host credentials", () => {
  test("a placed shell starts from exactly TERM and OPENCODE_TERMINAL", async () => {
    const resolved = await resolveShellEnv(
      placedRef(hostDirectory),
      reachable(Environment.makeMemoryDriver()),
    )
    // The positive shape: the variables a command needs to function are present.
    expect(resolved.TERM).toBe("xterm-256color")
    expect(resolved.OPENCODE_TERMINAL).toBe("1")
    expect(Object.keys(resolved)).toEqual(["TERM", "OPENCODE_TERMINAL"])
    for (const key of Object.keys(resolved)) {
      expect(/KEY|TOKEN|SECRET|PASSWORD|URL/i.test(key)).toBe(false)
    }
  })

  test("the same markers do cross an unplaced shell, so placement is the boundary", async () => {
    const resolved = await resolveShellEnv(hostRef(hostDirectory), unreachable)
    expect(resolved[HOST_SECRET_KEY]).toBe(process.env[HOST_SECRET_KEY])
    expect(resolved[LIVE_URL_KEY]).toBe(process.env[LIVE_URL_KEY])
  })
})

describe("config substitutions: a substitution cannot expand a secret into an executor-visible value", () => {
  test("a placed document renders {env:} sources empty, including nested and array fields", async () => {
    const directory = join(scratch, "config-env")
    await mkdir(directory, { recursive: true })
    const driver = Environment.makeMemoryDriver()
    await Effect.runPromise(
      memoryFiles(driver).write(
        join(directory, "opencode.json"),
        encoder.encode(
          JSON.stringify({
            shell: `shell-{env:${HOST_SECRET_KEY}}`,
            username: `{env:${HOST_SECRET_KEY}}`,
            instructions: [`{env:${HOST_SECRET_KEY}}`, "literal"],
            agents: { probe: { description: `{env:${HOST_SECRET_KEY}}` } },
          }),
        ),
      ),
    )

    // The marker really is a live process variable: substitution's documented fallback expands it
    // when no placement-supplied environment shadows it.
    const direct = await Effect.runPromise(
      ConfigVariable.substitute({
        type: "virtual",
        source: "canary",
        dir: directory,
        text: JSON.stringify({ shell: `shell-{env:${HOST_SECRET_KEY}}` }),
        reader: { read: () => Effect.fail({ missing: true, cause: undefined }) },
      }),
    )
    expect(direct).toContain(HOST_SECRET_VALUE)

    const entries = await Effect.runPromise(
      Effect.gen(function* () {
        const config = yield* Config.Service
        return yield* config.entries()
      }).pipe(Effect.provide(configLayer(placedRef(directory), reachable(driver)))),
    )
    const document = documentAt(entries, join(directory, "opencode.json"))
    expect(document).toBeDefined()
    // A substitution anywhere in the document, nested or in an array, resolves to nothing for a
    // placed location: config.ts hands substitution a placement environment that answers "".
    expect(document?.info.shell).toBe("shell-")
    expect(document?.info.username).toBe("")
    expect(document?.info.instructions).toEqual(["", "literal"])
    expect(document?.info.agents?.probe?.description).toBe("")
    expect(JSON.stringify(entries)).not.toContain(HOST_SECRET_VALUE)
  })

  test("a substitution result is never rescanned into a second reference", async () => {
    const directory = join(scratch, "config-indirect")
    await mkdir(directory, { recursive: true })
    const driver = Environment.makeMemoryDriver()
    const files = memoryFiles(driver)
    // The indirect shapes: a file whose content is an env reference, and a file whose content is a
    // second file reference. Substitution resolves the original text once; inserted content is data.
    await Effect.runPromise(files.write(join(directory, "token.txt"), encoder.encode(`{env:${HOST_SECRET_KEY}}`)))
    await Effect.runPromise(files.write(join(directory, "second.txt"), encoder.encode("{file:./third.txt}")))
    await Effect.runPromise(files.write(join(directory, "third.txt"), encoder.encode("deep-value")))
    await Effect.runPromise(
      files.write(
        join(directory, "opencode.json"),
        encoder.encode(JSON.stringify({ username: "{file:./token.txt}", shell: "{file:./second.txt}" })),
      ),
    )

    const entries = await Effect.runPromise(
      Effect.gen(function* () {
        const config = yield* Config.Service
        return yield* config.entries()
      }).pipe(Effect.provide(configLayer(placedRef(directory), reachable(driver)))),
    )
    const document = documentAt(entries, join(directory, "opencode.json"))
    expect(document).toBeDefined()
    expect(document?.info.username).toBe(`{env:${HOST_SECRET_KEY}}`)
    expect(document?.info.shell).toBe("{file:./third.txt}")
    expect(JSON.stringify(entries)).not.toContain(HOST_SECRET_VALUE)
    expect(JSON.stringify(entries)).not.toContain("deep-value")
  })

  test("an unresolved reference fails the document and leaks no bytes", async () => {
    const directory = join(scratch, "config-unresolved")
    await mkdir(directory, { recursive: true })
    const driver = Environment.makeMemoryDriver()
    await Effect.runPromise(
      memoryFiles(driver).write(
        join(directory, "opencode.json"),
        encoder.encode(JSON.stringify({ username: `{file:${secretPath}}` })),
      ),
    )

    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const config = yield* Config.Service
        return yield* config.entries()
      }).pipe(
        Effect.provide(configLayer(placedRef(directory), reachable(driver))),
        Effect.exit,
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (!Exit.isFailure(exit)) throw new Error("a placed document resolved a host file reference")
    const failure = Cause.squash(exit.cause)
    expect(failure).toMatchObject({ name: "ConfigInvalidError" })
    const text = JSON.stringify(failure)
    expect(text).toContain(secretPath)
    expect(text).toContain("bad file reference")
    expect(text).not.toContain(HOST_SECRET_CONTENT)
  })
})

describe("executable plugins, tools, and MCP: placement does not load host code", () => {
  test("a placed stdio MCP server is refused by the workspace plane, never spawned on the host", async () => {
    const sentinel = join(scratch, "mcp-host-sentinel")
    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const transport = yield* make({
            server: "canary",
            command: process.execPath,
            args: ["-e", `await Bun.write(${JSON.stringify(sentinel)}, "host-spawned")`],
            cwd: scratch,
            environment: {},
          })
          return yield* Effect.exit(Effect.tryPromise({ try: () => transport.start(), catch: (cause) => cause }))
        }),
      ).pipe(
        Effect.provide(environmentLayer(placedRef(hostDirectory), reachable(Environment.makeMemoryDriver()))),
      ),
    )
    expect(await Bun.file(sentinel).exists()).toBe(false)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failure = Cause.squash(exit.cause)
      if (!(failure instanceof Error)) throw new Error(`expected an Error, got ${String(failure)}`)
      expect(failure.message).toContain("EnvironmentMemory")
    }
  })

  test("a plugin tool cannot execute without an authorizing permission service", async () => {
    const executed: string[] = []
    const tool: Tool.Info = {
      name: "deploy",
      description: "Deploy the service",
      input: Schema.Void,
      output: Schema.String,
      options: { codemode: false },
      origin: { type: "plugin", name: "canary" },
      execute: () => Effect.sync(() => executed.push("deploy")).pipe(Effect.as({ output: "deployed" })),
    }
    const failure = await Effect.runPromise(
      assertToolPermission(tool, "deploy", {
        sessionID: Session.ID.make("ses_canary_gate"),
        agent: Agent.ID.make("canary"),
        messageID: SessionMessage.ID.make("msg_canary_gate"),
        id: Tool.CallID.make("call_canary_gate"),
        progress: () => Effect.void,
      }).pipe(Effect.flip),
    )
    expect(failure._tag).toBe("Tool.Error")
    expect(failure.message).toContain("no permission service in this context")
    expect(executed).toEqual([])
  })

  test("the plugin host cannot be assembled without the durable release store", async () => {
    const context = await Effect.runPromise(
      Effect.scoped(Layer.build(pluginHostLayer(placedRef(hostDirectory), reachable(Environment.makeMemoryDriver())))),
    )
    const host = PluginHost.make({ list: () => Effect.succeed([]) })

    const complete = await Effect.runPromise(Effect.exit(Effect.provide(host, context)))
    expect(Exit.isSuccess(complete)).toBe(true)

    // The durable store is a runtime requirement, not an option. Remove exactly it from the built
    // context: if PluginHost.make ever relaxes `yield* ReleaseRequestStore.Service` to a
    // serviceOption, this build starts succeeding and the canary fails.
    const withoutStore = Context.omit(ReleaseRequestStore.Service)(context)
    const missing = await Effect.runPromise(Effect.exit(Effect.provide(eraseRequirements(host), withoutStore)))
    expect(Exit.isFailure(missing)).toBe(true)
    if (Exit.isFailure(missing)) expect(Cause.pretty(missing.cause)).toContain("ReleaseRequestStore")
  })
})

describe("git hooks: repository operations on an executor worktree", () => {
  const SENTINEL_NAME = "hook-sentinel"

  const initHostileRepo = async (path: string, sentinel: string): Promise<void> => {
    await mkdir(path, { recursive: true })
    await git(path, ["init", "-b", "main"])
    await git(path, ["config", "user.email", "canary@test.local"])
    await git(path, ["config", "user.name", "canary"])
    await writeFile(join(path, "README.md"), "fixture\n")
    await git(path, ["add", "README.md"])
    await git(path, ["commit", "-m", "chore: fixture commit"])
    const hooks = join(path, ".git", "hooks")
    await mkdir(hooks, { recursive: true })
    for (const name of ["pre-commit", "post-checkout"]) {
      await writeFile(join(hooks, name), `#!/bin/sh\necho ran > ${JSON.stringify(sentinel)}\n`, { mode: 0o755 })
    }
    // Repo-local config so an ambient global core.hooksPath cannot mask the planted hook.
    await git(path, ["config", "core.hooksPath", hooks])
  }

  test("the check executor's own repository inspection runs no planted hook", async () => {
    const repo = join(scratch, "hooks-check-repo")
    const sentinel = join(scratch, `check-${SENTINEL_NAME}`)
    await initHostileRepo(repo, sentinel)

    const res = await execute(join(scratch, "check-state"), {
      runID: "w-ca9a9a9a9a9a9a9a",
      check: { id: "hookless", argv: [process.execPath, "-e", "process.exit(0)"] },
      worktree: repo,
    })

    expect(res.passed).toBe(true)
    expect(await Bun.file(sentinel).exists()).toBe(false)
  })

  /**
   * Finding, reported to the parent: the product's worktree provisioning runs `git worktree add`
   * with no hook neutralization (packages/plus/src/teams/worktree.ts createLocked), and git runs
   * the repository's `post-checkout` hook for worktree add. An executor that can write the shared
   * repository's hook files (or its repo-local core.hooksPath) therefore runs code in the host
   * plane during the next provisioning. This test documents the open escape: when the host adds
   * neutralization (for example `-c core.hooksPath=<empty>` or `--no-checkout` plus an explicit
   * checkout), flip the assertion to `false`. The operational gate must prove the property on the
   * real host with a real shared repository.
   */
  test("finding: worktree provisioning still runs a planted post-checkout hook", async () => {
    const repo = join(scratch, "hooks-worktree-repo")
    const sentinel = join(scratch, `worktree-${SENTINEL_NAME}`)
    await initHostileRepo(repo, sentinel)

    await create(join(scratch, "worktree-state"), {
      repoRoot: repo,
      repoKey: "canary-repo",
      role: "muse-implementer",
      name: "hook",
      base: "HEAD",
      workspaceRoot: join(scratch, "worktree-workspace"),
    })

    expect(await Bun.file(sentinel).exists()).toBe(true)
  })
})

describe("instructions reachability: reviewed instructions still reach a placed session", () => {
  test("a placed plugin instructions row reaches the session instruction list", async () => {
    const reviewed = await readFile(join(repoRoot, "AGENTS.md"), "utf8")
    const reviewedRule = "- Avoid using the `any` type"
    expect(reviewed).toContain(reviewedRule)

    const path = AbsolutePath.make(join(hostDirectory, "AGENTS.md"))
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* PluginHost.make({ list: () => Effect.succeed([]) })
          const discovery = yield* InstructionDiscovery.Service
          yield* host.instruction.transform((editor) => {
            editor.add({ path, content: reviewed })
          })
          const sources = yield* discovery.load()
          const source = sources.find((entry) => entry.path === path)
          if (source === undefined) throw new Error("the placed instructions row did not reach discovery")
          const observed = yield* Instructions.read([source])
          const observedValue = observed[0].value
          if (observedValue === Instructions.unavailable || observedValue === Instructions.removed)
            throw new Error("the placed instruction source read as a non-value")
          return { observedValue, initial: source.initial(observedValue) }
        }),
      ).pipe(
        Effect.provide(pluginHostLayer(placedRef(hostDirectory), reachable(Environment.makeMemoryDriver()))),
      ),
    )

    expect(result.observedValue).toMatchObject({ path, content: reviewed })
    expect(result.initial).toContain(reviewedRule)
    expect(result.initial).toContain(`Instructions from: ${path}`)
  })
})