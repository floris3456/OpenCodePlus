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
 * parent: PTY allocation is not routed through the Environment seam, and the executable-plugin
 * loading path that resolves host filesystem targets is a second reported finding. Both are named
 * in the test bodies and in the report, with the operational gate each one needs.
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
import { Git } from "../../../core/src/git.js"
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
import { context } from "../harness.js"
import { createState } from "../../src/index.js"
import { createTeamApi } from "../../src/teams/api.js"
import { execute } from "../../src/teams/checks.js"
import { git } from "../../src/teams/git.js"
import { drain, enqueue } from "../../src/teams/merge.js"
import { type RunRecord } from "../../src/teams/run.js"
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

  const plantHook = async (directory: string, name: string, sentinel: string): Promise<void> => {
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, name), `#!/bin/sh\necho ran > ${JSON.stringify(sentinel)}\n`, { mode: 0o755 })
  }

  const initRepo = async (path: string): Promise<void> => {
    await mkdir(path, { recursive: true })
    await git(path, ["init", "-b", "main"])
    await git(path, ["config", "user.email", "canary@test.local"])
    await git(path, ["config", "user.name", "canary"])
    await writeFile(join(path, "README.md"), "fixture\n")
    await git(path, ["add", "README.md"])
    await git(path, ["commit", "-m", "chore: fixture commit"])
  }

  const initHostileRepo = async (path: string, sentinel: string): Promise<void> => {
    await initRepo(path)
    const hooks = join(path, ".git", "hooks")
    for (const name of ["pre-commit", "prepare-commit-msg", "post-commit", "post-checkout"]) {
      await plantHook(hooks, name, sentinel)
    }
    // Repo-local config so an ambient global core.hooksPath cannot mask the planted hook.
    await git(path, ["config", "core.hooksPath", hooks])
  }

  // The hooks the integrate path can reach: `worktree add` runs post-checkout,
  // `rebase` runs pre-rebase/post-rewrite (and post-checkout through the merge
  // backend's checkout), and `merge --ff-only` runs post-merge.
  const INTEGRATE_HOOKS = ["post-checkout", "pre-rebase", "post-rewrite", "post-merge"]

  const plantIntegrateHooks = async (hooks: string, label: string): Promise<Record<string, string>> => {
    const sentinels: Record<string, string> = {}
    for (const name of INTEGRATE_HOOKS) {
      const sentinel = join(scratch, `integrate-${label}-${name}-${SENTINEL_NAME}`)
      await plantHook(hooks, name, sentinel)
      sentinels[name] = sentinel
    }
    return sentinels
  }

  const firedHooks = async (sentinels: Record<string, string>): Promise<Record<string, boolean>> => {
    const fired: Record<string, boolean> = {}
    for (const [name, sentinel] of Object.entries(sentinels)) fired[name] = await Bun.file(sentinel).exists()
    return fired
  }

  interface IntegrateFixture {
    repo: string
    state: string
    workspace: string
    parent: string
    parentHead: string
    childBranch: string
    childHead: string
    sentinels: Record<string, string>
  }

  /**
   * A hostile fixture for the integrate path. The parent worktree is a commit
   * ahead of the child, so the child genuinely replays onto a new base and a
   * no-op rebase cannot mask a missing post-rewrite hook. `redirect` plants the
   * hooks in an external directory named by the repository-local
   * `core.hooksPath` instead of `.git/hooks`.
   */
  const integrateFixture = async (label: string, redirect: boolean): Promise<IntegrateFixture> => {
    const repo = join(scratch, `integrate-${label}`)
    await initRepo(repo)
    const start = await git(repo, ["rev-parse", "HEAD"])
    const parent = join(scratch, `integrate-${label}-parent`)
    await git(repo, ["worktree", "add", "-b", `${label}-parent`, parent, start])
    const child = join(scratch, `integrate-${label}-child`)
    await git(repo, ["worktree", "add", "-b", `${label}-child`, child, start])
    await writeFile(join(child, "child.txt"), "child\n")
    await git(child, ["add", "child.txt"])
    await git(child, ["commit", "-m", "feat: child commit"])
    const childHead = await git(child, ["rev-parse", "HEAD"])
    // Advance the parent so the rebase has a commit to replay.
    await writeFile(join(parent, "parent.txt"), "parent\n")
    await git(parent, ["add", "parent.txt"])
    await git(parent, ["commit", "-m", "feat: parent advance"])
    const hooks = redirect ? join(scratch, `integrate-${label}-hooks`) : join(repo, ".git", "hooks")
    const sentinels = await plantIntegrateHooks(hooks, label)
    if (redirect) await git(repo, ["config", "core.hooksPath", hooks])
    return {
      repo,
      state: join(scratch, `integrate-${label}-state`),
      workspace: join(scratch, `integrate-${label}-ws`),
      parent,
      parentHead: await git(parent, ["rev-parse", "HEAD"]),
      childBranch: `${label}-child`,
      childHead,
      sentinels,
    }
  }

  /** The integrate path's three host-plane commands, run with no neutralization. */
  const runRawIntegrate = async (fx: IntegrateFixture, temp: string): Promise<void> => {
    await git(fx.repo, ["worktree", "add", "--detach", temp, fx.childHead])
    await git(temp, ["rebase", fx.parentHead])
    const tip = await git(temp, ["rev-parse", "HEAD"])
    await git(fx.parent, ["merge", "--ff-only", tip])
  }

  /** The real integrate path: enqueue the child, then drain the queue. */
  const runIntegrate = async (fx: IntegrateFixture, parentRun: string, childRun: string) => {
    const repoKey = `canary-${parentRun}`
    await mkdir(join(fx.workspace, "worktrees", repoKey, "merge"), { recursive: true })
    await enqueue(fx.state, {
      parentRun,
      parentWorktree: fx.parent,
      childRun,
      childBranch: fx.childBranch,
      childHead: fx.childHead,
      expectedParentHead: fx.parentHead,
    })
    const result = await drain(fx.state, parentRun, {
      repoRoot: fx.repo,
      repoKey,
      workspaceRoot: fx.workspace,
      parentWorktree: fx.parent,
      checks: [],
    })
    return result.processed[0]
  }

  /**
   * Canary body for both integrate variants. The control runs the three
   * host-plane commands unneutralized, proving every planted hook really fires
   * there; the same fixture shape then goes through the real queue. Absent
   * sentinels therefore mean the hook was neutralized, not that the integrate
   * silently skipped the operations — the landed assertions pin the positive.
   */
  const assertIntegrateNeutralizesHooks = async (label: string, redirect: boolean): Promise<void> => {
    const control = await integrateFixture(`${label}-control`, redirect)
    await runRawIntegrate(control, join(scratch, `integrate-${label}-control-temp`))
    expect(await firedHooks(control.sentinels)).toEqual({
      "post-checkout": true,
      "pre-rebase": true,
      "post-rewrite": true,
      "post-merge": true,
    })
    expect(await Bun.file(join(control.parent, "child.txt")).exists()).toBe(true)
    expect(await git(control.parent, ["rev-parse", "HEAD"])).not.toBe(control.parentHead)

    const fixture = await integrateFixture(label, redirect)
    const landed = await runIntegrate(fixture, `w-canary-${label}-parent`, `w-canary-${label}-child`)
    expect(landed.state).toBe("landed")
    expect(landed.landedHead).toBe(await git(fixture.parent, ["rev-parse", "HEAD"]))
    expect(landed.landedHead).not.toBe(fixture.parentHead)
    expect(await Bun.file(join(fixture.parent, "child.txt")).exists()).toBe(true)
    expect(await firedHooks(fixture.sentinels)).toEqual({
      "post-checkout": false,
      "pre-rebase": false,
      "post-rewrite": false,
      "post-merge": false,
    })
  }

  // The checkpoint handler resolves its state root from XDG_DATA_HOME, like the
  // real host: a per-test root keeps its locks and run records out of the real
  // teams data directory.
  const withTeamsRoot = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
    const prior = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = join(scratch, `teams-${label}`)
    try {
      return await fn()
    } finally {
      if (prior === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = prior
    }
  }

  const checkpointRun = (repo: string, head: string, id: string): RunRecord => {
    const at = new Date(0).toISOString()
    return {
      id,
      role: "muse-implementer",
      kind: "w",
      repo: "opencode",
      repoKey: "canary-repo",
      directory: repo,
      paths: ["notes/*"],
      branch: "team/canary/hooks",
      base: head,
      head,
      state: "working",
      attempts: [],
      task: null,
      parent: null,
      children: [],
      briefSha: "canary",
      bundle: "canary",
      budget: {},
      createdAt: at,
      lastUsed: at,
      sessionID: "ses_canary_hooks",
      configDigest: null,
      history: [],
    }
  }

  /** A real checkpoint through the team API for a run whose directory is the hostile repo. */
  const checkpoint = async (repo: string, record: RunRecord, label: string) => {
    await mkdir(join(repo, "notes"), { recursive: true })
    await writeFile(join(repo, "notes", "canary.md"), "# canary\n")
    return withTeamsRoot(label, async () => {
      const result = await createTeamApi(context(), createState()).checkpoint(
        { expectedHead: record.head, files: ["notes/canary.md"], message: "test: canary checkpoint" },
        { sessionID: "ses_canary_hooks", agent: "muse-implementer", run: record },
      )
      if (!result.ok) throw new Error(`checkpoint failed: ${result.error.code} ${result.error.message}`)
      return result.value
    })
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
   * Canary: a task executor can write the shared repository's `.git/hooks`, and the next
   * host-plane provisioning must not execute that script. The assertion is the positive
   * property — the worktree is checked out and no sentinel appears — so this fails if the
   * hook neutralization or the `-c core.hooksPath` precedence it relies on is ever removed.
   */
  test("worktree provisioning runs no planted post-checkout hook", async () => {
    const repo = join(scratch, "hooks-worktree-repo")
    const sentinel = join(scratch, `worktree-${SENTINEL_NAME}`)
    await initHostileRepo(repo, sentinel)

    const created = await create(join(scratch, "worktree-state"), {
      repoRoot: repo,
      repoKey: "canary-repo",
      role: "muse-implementer",
      name: "hook",
      base: "HEAD",
      workspaceRoot: join(scratch, "worktree-workspace"),
    })

    // The checkout really happened, so an unneutralized post-checkout would have run.
    expect(await Bun.file(join(created.dir, "README.md")).exists()).toBe(true)
    expect(await Bun.file(sentinel).exists()).toBe(false)
  })

  /**
   * Canary: the core Git seam is the same exposure — `Git.worktree.create`
   * provisions a linked worktree in the shared repository. The checkout must
   * happen without running the planted post-checkout hook.
   */
  test("the core Git worktree seam runs no planted post-checkout hook", async () => {
    const repo = join(scratch, "hooks-core-repo")
    const sentinel = join(scratch, `core-${SENTINEL_NAME}`)
    const linked = join(scratch, "hooks-core-linked")
    await initHostileRepo(repo, sentinel)

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* Git.Service
          const repository = yield* service.repo.discover(AbsolutePath.make(repo))
          if (repository === undefined) throw new Error("the hostile repository did not discover")
          yield* service.worktree.create({ repository, directory: AbsolutePath.make(linked) })
        }),
      ).pipe(Effect.provide(LayerNode.compile(Git.node))),
    )

    expect(await Bun.file(join(linked, "README.md")).exists()).toBe(true)
    expect(await Bun.file(sentinel).exists()).toBe(false)
  })

  /**
   * Canary: the commit path, including the hooks `--no-verify` does not cover
   * (`post-commit`) and the ones it does (`pre-commit`, `prepare-commit-msg`).
   * The control proves the planted hooks run and that `--no-verify` alone is not
   * a complete fix; the checkpoint then commits through the real handler.
   */
  test("checkpoint runs no planted commit hook", async () => {
    const repo = join(scratch, "hooks-commit-repo")
    const sentinel = join(scratch, `commit-${SENTINEL_NAME}`)
    await initHostileRepo(repo, sentinel)

    await git(repo, ["commit", "--no-verify", "--allow-empty", "-m", "chore: hook control"])
    expect(await Bun.file(sentinel).exists()).toBe(true)
    await rm(sentinel, { force: true })

    const head = await git(repo, ["rev-parse", "HEAD"])
    const value = await checkpoint(repo, checkpointRun(repo, head, "w-ca9a9a9a9a9a9a9a"), "commit")
    expect(value).toMatchObject({ committed: true })
    expect(await Bun.file(sentinel).exists()).toBe(false)
  })

  /**
   * Canary: a repository-local `core.hooksPath` pointing at an attacker-controlled
   * directory, with no hook under `.git/hooks`. `--no-verify` cannot see this
   * redirection, so only neutralized hook discovery keeps the commit clean.
   */
  test("a repository-local core.hooksPath cannot redirect a checkpoint's hooks", async () => {
    const repo = join(scratch, "hooks-redirect-repo")
    const attackerHooks = join(scratch, "attacker-hooks")
    const sentinel = join(scratch, `redirect-${SENTINEL_NAME}`)
    await initRepo(repo)
    for (const name of ["pre-commit", "prepare-commit-msg", "post-commit"]) {
      await plantHook(attackerHooks, name, sentinel)
    }
    await git(repo, ["config", "core.hooksPath", attackerHooks])

    await git(repo, ["commit", "--no-verify", "--allow-empty", "-m", "chore: redirect control"])
    expect(await Bun.file(sentinel).exists()).toBe(true)
    await rm(sentinel, { force: true })

    const head = await git(repo, ["rev-parse", "HEAD"])
    const value = await checkpoint(repo, checkpointRun(repo, head, "w-dbdbdbdbdbdbdbdb"), "redirect")
    expect(value).toMatchObject({ committed: true })
    expect(await Bun.file(sentinel).exists()).toBe(false)
  })

  /**
   * Canary: the integrate path runs `worktree add`, `rebase` and `merge
   * --ff-only` against the shared repository, so an executor-planted hook must
   * not run as the host. The child's commit must still land in the parent.
   */
  test("the integrate path runs no planted hook", () => assertIntegrateNeutralizesHooks("merge", false))

  /**
   * Canary: the same path under a repository-local `core.hooksPath` pointing at
   * an executor-controlled directory — the bypass a hooks-directory-only fix
   * would miss; only command-line `-c core.hooksPath` outranks it.
   */
  test("a repository-local core.hooksPath cannot redirect the integrate path's hooks", () =>
    assertIntegrateNeutralizesHooks("merge-redirect", true))

  /**
   * The merge path's removal tail (`removeTemp`) runs `git worktree remove
   * --force` with `prune` as its fallback — both unneutralized. Git runs no
   * hook for either, so this canary pins the absence itself: the control proves
   * the planted post-checkout hook fires on an add, and the plain remove and
   * prune then produce no sentinel.
   */
  test("worktree removal and prune run no planted hook", async () => {
    const repo = join(scratch, "hooks-remove-repo")
    const sentinel = join(scratch, `remove-${SENTINEL_NAME}`)
    await initHostileRepo(repo, sentinel)

    const control = join(scratch, "hooks-remove-control")
    await git(repo, ["worktree", "add", "--detach", control, "HEAD"])
    expect(await Bun.file(sentinel).exists()).toBe(true)
    await rm(sentinel, { force: true })

    // An unneutralized remove fires nothing, and the worktree is really gone.
    await git(repo, ["worktree", "remove", "--force", control])
    expect(await Bun.file(join(control, "README.md")).exists()).toBe(false)
    expect(await Bun.file(sentinel).exists()).toBe(false)

    // Prune of a manually deleted worktree likewise.
    const stale = join(scratch, "hooks-remove-stale")
    await git(repo, ["worktree", "add", "--detach", stale, "HEAD"])
    await rm(sentinel, { force: true })
    await rm(stale, { recursive: true, force: true })
    await git(repo, ["worktree", "prune"])
    expect(await git(repo, ["worktree", "list", "--porcelain"])).not.toContain(stale)
    expect(await Bun.file(sentinel).exists()).toBe(false)
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