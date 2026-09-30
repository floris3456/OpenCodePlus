export * as PlusUpdate from "./plus-update"

// How an OpenCodePlus install finds, stages and switches to a newer release.
//
// Releases are GitHub releases of floris3456/OpenCodePlus. The release marked
// Latest is read from releases/latest/download/release.json, which GitHub serves
// from its file host instead of the rate-limited API. Test releases (prereleases)
// are listed through the API, only for installs that opted in with
// `update_test_releases`. Every release is then read from its own fixed-version
// address, so a Latest change in between cannot mix two releases.
//
// Only a person starts a switch, through /update in the TUI or `opencodeplus
// upgrade`; there is no server route and no tool for it. It waits until no chat
// is running, stops the background service, copies the database, moves the
// install pointer, starts the new release and checks it answers with its version.
// Any failure after the service stopped puts the previous release and database
// back.

import { Service, ServiceRefusalError, type Info } from "@opencode/client/effect/service"
import { Global } from "@opencode/util/global"
import { PlusVersion } from "@opencode/util/plus-version"
import { AppProcess } from "@opencode/util/process"
import { ReleaseManifest, type ReleaseTarget } from "@opencode/schema/release"
import { Effect, FileSystem, Option, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { parse, type ParseError } from "jsonc-parser"
import { createHash } from "node:crypto"
import path from "node:path"
import { databasePath } from "../database-path"
import { ServiceConfig } from "./service-config"

const BINARY = "opencodeplus"
const CHECK_INTERVAL = 10 * 60_000
const KEPT_BACKUPS = 3
const INSTALLED = new RegExp(`^(.+)/releases/([^/]+)/bin/${BINARY}$`)
const POINTER = new RegExp(`^\\.\\./releases/([^/]+)/bin/${BINARY}$`)

export class UpdateError extends Error {
  override readonly name = "UpdateError"
}

/** An install made by install.sh: `<prefix>/bin/opencodeplus -> ../releases/<version>/bin/opencodeplus`. */
export interface Install {
  readonly prefix: string
  /** The release this process runs. */
  readonly running: string
  /** The release the install pointer names: what a new process starts. */
  readonly active: string
}

export interface Newest {
  readonly version: string
  readonly info: PlusVersion.Info
}

export type Progress = (message: string) => void

export const site = () => process.env.OPENCODEPLUS_RELEASE_SITE || "https://github.com/floris3456/OpenCodePlus"
export const api = () => process.env.OPENCODEPLUS_RELEASE_API || "https://api.github.com/repos/floris3456/OpenCodePlus"

const decodeManifest = Schema.decodeUnknownOption(Schema.fromJsonString(ReleaseManifest))
const decodeReleases = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ tag_name: Schema.String, draft: Schema.Boolean }))),
)
const decodeCache = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      checkedAt: Schema.Number,
      test: Schema.Boolean,
      source: Schema.String,
      version: Schema.NullOr(Schema.String),
    }),
  ),
)
const decodeActive = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ data: Schema.Record(Schema.String, Schema.Unknown) })),
)
const decodeHealth = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ version: Schema.String, pid: Schema.Number })),
)
const decodeRegistration = Schema.decodeUnknownOption(Schema.fromJsonString(Service.Info))

/** The `update_test_releases` setting: whether this install is also offered test releases. */
export function decodeTestReleases(text: string): boolean | undefined {
  const errors: ParseError[] = []
  const input: unknown = parse(text, errors, { allowTrailingComma: true })
  if (errors.length || typeof input !== "object" || input === null || !("update_test_releases" in input)) return
  return input.update_test_releases === true
}

/** "OpenCodePlus 1.0.1 (opencode 2.0.18)", or `v<version>` outside the scheme. */
export function describe(version: string) {
  const info = PlusVersion.parse(version)
  return info ? PlusVersion.display(info) : `v${version}`
}

/** Whether `candidate` is a newer release than `current`. Versions outside the scheme are never offered. */
export function newer(candidate: string, current: string) {
  const next = PlusVersion.parse(candidate)
  if (!next) return false
  const previous = PlusVersion.parse(current)
  // A release from before the scheme (0.0.0-plus-rN.M) is older than every release in it.
  if (!previous) return true
  return PlusVersion.compare(next, previous) > 0
}

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const global = yield* Global.Service
  const appProcess = yield* AppProcess.Service
  const cacheFile = path.join(global.cache, "update-check.json")
  let switching: Promise<void> | undefined

  const detect = Effect.fnUntraced(function* (execPath: string = process.execPath) {
    const executable = yield* fs.realPath(execPath).pipe(Effect.orElseSucceed(() => execPath))
    const installed = INSTALLED.exec(executable)
    if (!installed) return undefined
    const pointer = yield* fs.readLink(path.join(installed[1], "bin", BINARY)).pipe(Effect.option)
    const active = Option.isSome(pointer) ? POINTER.exec(pointer.value) : null
    if (!active) return undefined
    return { prefix: installed[1], running: installed[2], active: active[1] } satisfies Install
  })

  const readTestReleases = Effect.fnUntraced(function* () {
    const values = yield* Effect.forEach(["config.json", "opencode.json", "opencode.jsonc"], (name) =>
      fs.readFileString(path.join(global.config, name)).pipe(
        Effect.map(decodeTestReleases),
        Effect.orElseSucceed(() => undefined),
      ),
    )
    return values.findLast((value) => value !== undefined) ?? false
  })

  /** The newest release this install is offered; every TUI of an install shares one answer for ten minutes. */
  const newest = Effect.fnUntraced(function* (input: { readonly fresh?: boolean } = {}) {
    const test = yield* readTestReleases()
    const source = test ? api() : site()
    const cached = yield* fs.readFileString(cacheFile).pipe(Effect.map(decodeCache), Effect.orElseSucceed(Option.none))
    const reusable = Option.filter(
      cached,
      (value) =>
        !input.fresh && value.test === test && value.source === source && Date.now() - value.checkedAt < CHECK_INTERVAL,
    )
    const version = Option.isSome(reusable)
      ? reusable.value.version
      : ((yield* test ? newestTest() : newestLatest()) ?? null)
    if (Option.isNone(reusable))
      yield* fs.makeDirectory(global.cache, { recursive: true }).pipe(
        Effect.andThen(fs.writeFileString(cacheFile, JSON.stringify({ checkedAt: Date.now(), test, source, version }))),
        Effect.ignore,
      )
    const info = version === null ? undefined : PlusVersion.parse(version)
    return version !== null && info ? ({ version, info } satisfies Newest) : undefined
  })

  const newestLatest = Effect.fnUntraced(function* () {
    const url = `${site()}/releases/latest/download/release.json`
    const response = yield* request(url)
    // No release is marked Latest yet.
    if (response.status === 404) return undefined
    return (yield* manifest(yield* body(response, url))).release.version
  })

  const newestTest = Effect.fnUntraced(function* () {
    const url = `${api()}/releases?per_page=30`
    const listed = decodeReleases(new TextDecoder().decode(yield* download(url)))
    if (Option.isNone(listed)) return yield* Effect.fail(new UpdateError(`The release list from ${url} is not readable`))
    const newest = listed.value
      .filter((release) => !release.draft)
      .flatMap((release) => {
        const info = PlusVersion.fromTag(release.tag_name)
        return info ? [info] : []
      })
      .toSorted(PlusVersion.compare)
      .at(-1)
    if (!newest) return undefined
    const version = PlusVersion.format(newest)
    // The listing only names it; its own manifest must agree before it is offered.
    yield* manifest(yield* download(assetURL(version, "release.json")), version)
    return version
  })

  /**
   * Downloads one release, checks every file against its manifest and SHA256SUMS,
   * and has that release's own install.sh stage it beside the incumbent. The
   * pointer does not move; the result is `<prefix>/releases/<version>`.
   */
  const stage = Effect.fnUntraced(function* (install: Install, version: string, progress: Progress = () => {}) {
    const target = yield* releaseTarget()
    progress(`Downloading ${describe(version)}…`)
    const manifestBytes = yield* download(assetURL(version, "release.json"))
    const release = yield* manifest(manifestBytes, version)
    const artifact = release.artifacts.find((item) => item.target === target)
    if (!artifact) return yield* Effect.fail(new UpdateError(`${describe(version)} has no build for ${target}`))
    const files: Record<string, Uint8Array> = {
      "release.json": manifestBytes,
      SHA256SUMS: yield* download(assetURL(version, "SHA256SUMS")),
      "install.sh": yield* download(assetURL(version, "install.sh")),
      [artifact.archiveName]: yield* download(assetURL(version, artifact.archiveName)),
    }
    const sums = new Map(
      new TextDecoder()
        .decode(files.SHA256SUMS)
        .split("\n")
        .flatMap((line) => {
          const match = /^([a-f0-9]{64}) {2}(\S+)$/.exec(line.trim())
          return match ? [[match[2], match[1]] as const] : []
        }),
    )
    // Each file must match both records: release.json (the installer and archive)
    // and SHA256SUMS (all three).
    const expected: Record<string, string | undefined> = {
      "release.json": sums.get("release.json"),
      "install.sh": release.installerSha256,
      [artifact.archiveName]: artifact.archiveSha256,
    }
    const mismatch = Object.entries(expected).find(
      ([name, sha]) => sha === undefined || sha256(files[name]) !== sha || sums.get(name) !== sha,
    )
    if (mismatch)
      return yield* Effect.fail(
        new UpdateError(`${mismatch[0]} of ${describe(version)} does not match its recorded SHA-256; nothing was installed`),
      )

    yield* fs.makeDirectory(global.cache, { recursive: true })
    const executable = path.join(install.prefix, "releases", version, "bin", BINARY)
    yield* Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* fs.makeTempDirectoryScoped({ directory: global.cache, prefix: "plus-update-" })
        yield* Effect.forEach(Object.entries(files), ([name, bytes]) => fs.writeFile(path.join(directory, name), bytes))
        progress(`Installing ${describe(version)}…`)
        const result = yield* run("bash", [
          path.join(directory, "install.sh"),
          "--manifest",
          path.join(directory, "release.json"),
          "--archive",
          path.join(directory, artifact.archiveName),
          "--prefix",
          install.prefix,
          "--version",
          `v${version}`,
          "--stage",
          "--no-modify-path",
        ])
        if (result.exitCode !== 0)
          return yield* Effect.fail(new UpdateError(`install.sh of ${describe(version)} refused to install: ${result.stderr}`))
      }),
    )
    if (sha256(yield* fs.readFile(executable)) !== artifact.binarySha256)
      return yield* Effect.fail(new UpdateError(`${executable} does not match the binary ${describe(version)} records`))
    // A binary that cannot start on this machine is refused before anything stops.
    const started = yield* run(executable, ["--version"])
    if (started.exitCode !== 0 || !started.stdout.includes(version))
      return yield* Effect.fail(new UpdateError(`${describe(version)} does not start on this machine: ${started.stderr}`))
    return executable
  })

  /**
   * Switches this install to a staged release: waits until no chat runs, stops the
   * service, copies the database, moves the pointer and starts the new release.
   * After the stop, any failure restores the previous release and database.
   */
  const switchTo = Effect.fnUntraced(function* (install: Install, version: string, progress: Progress = () => {}) {
    const previous = install.active
    const options = yield* ServiceConfig.options()
    const incumbent = yield* registration(options.file)
    if (!incumbent || !alive(incumbent.pid)) {
      // No background service: the next one to start runs the new release.
      yield* pointTo(install, version)
      return
    }

    yield* waitIdle(incumbent, progress)
    progress("Stopping the background service…")
    yield* Service.stop({ file: options.file, pty: "handoff" })
    if (alive(incumbent.pid))
      return yield* Effect.fail(new UpdateError(`The background service (pid ${incumbent.pid}) did not stop; nothing was changed`))

    const start = (release: string) =>
      startService(options.file, options.env, path.join(install.prefix, "releases", release, "bin", BINARY), release)
    progress("Saving a copy of the database…")
    const backup = yield* backupDatabase(previous, version).pipe(
      Effect.catch((error) =>
        start(previous).pipe(
          Effect.ignore,
          Effect.andThen(Effect.fail(new UpdateError(`Could not copy the database (${message(error)}); nothing was changed`))),
        ),
      ),
    )

    const forward = Effect.gen(function* () {
      yield* pointTo(install, version)
      progress(`Starting ${describe(version)}…`)
      yield* start(version)
    })
    const back = Effect.gen(function* () {
      yield* Service.stop({ file: options.file, pty: "handoff" }).pipe(Effect.ignore)
      yield* restoreDatabase(backup)
      yield* pointTo(install, previous)
      yield* start(previous)
    })
    yield* forward.pipe(
      Effect.catch((error) =>
        back.pipe(
          Effect.matchEffect({
            onFailure: (rollback) =>
              Effect.fail(
                new UpdateError(
                  `${describe(version)} did not start (${message(error)}), and returning to ${describe(previous)} also failed (${message(rollback)}). The database copy is in ${backup.directory}.`,
                ),
              ),
            onSuccess: () =>
              Effect.fail(
                new UpdateError(`${describe(version)} did not start (${message(error)}); OpenCodePlus is back on ${describe(previous)}.`),
              ),
          }),
        ),
      ),
    )
  })

  /** Stages and switches to `version`; one update at a time in this process. */
  const update = (install: Install, version: string, progress: Progress = () => {}) =>
    Effect.gen(function* () {
      if (switching) return yield* Effect.fail(new UpdateError("An update is already running"))
      yield* stage(install, version, progress)
      const settle = Promise.withResolvers<void>()
      switching = settle.promise
      yield* switchTo(install, version, progress).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            switching = undefined
            settle.resolve()
          }),
        ),
      )
    })

  const request = (url: string) =>
    Effect.tryPromise({
      try: (signal) =>
        fetch(url, {
          headers: url.startsWith(api()) ? { accept: "application/vnd.github+json" } : undefined,
          signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
        }),
      catch: (cause) => new UpdateError(`Could not reach ${url}`, { cause }),
    })

  const body = Effect.fnUntraced(function* (response: Response, url: string) {
    if (!response.ok) return yield* Effect.fail(new UpdateError(`HTTP ${response.status} from ${url}`))
    const buffer = yield* Effect.tryPromise({
      try: () => response.arrayBuffer(),
      catch: (cause) => new UpdateError(`Could not read ${url}`, { cause }),
    })
    return new Uint8Array(buffer)
  })

  const download = (url: string) => request(url).pipe(Effect.flatMap((response) => body(response, url)))

  /** One release's manifest, checked for this product and, when given, the version it must name. */
  const manifest = Effect.fnUntraced(function* (bytes: Uint8Array, version?: string) {
    const decoded = decodeManifest(new TextDecoder().decode(bytes))
    if (Option.isNone(decoded)) return yield* Effect.fail(new UpdateError("The release manifest is not a valid release.json"))
    const release = decoded.value
    if (!PlusVersion.parse(release.release.version))
      return yield* Effect.fail(new UpdateError(`Release ${release.release.version} is not a version /update understands`))
    if (version !== undefined && release.release.version !== version)
      return yield* Effect.fail(new UpdateError(`The manifest of v${version} names version ${release.release.version}`))
    return release
  })

  const run = (command: string, args: string[]) =>
    appProcess
      .run(ChildProcess.make(command, args), { timeout: "5 minutes", maxOutputBytes: 100_000, maxErrorBytes: 100_000 })
      .pipe(
        Effect.map((result) => ({
          exitCode: result.exitCode,
          stdout: result.stdout.toString("utf8"),
          stderr: result.stderr.toString("utf8").trim(),
        })),
        Effect.mapError((cause) => new UpdateError(`${path.basename(command)} could not run`, { cause })),
      )

  const releaseTarget = Effect.fnUntraced(function* () {
    const os = process.platform === "darwin" || process.platform === "linux" ? process.platform : undefined
    if (!os) return yield* Effect.fail(new UpdateError(`OpenCodePlus releases are not built for ${process.platform}`))
    // install.sh installs the arm64 build on an Apple Silicon Mac even under Rosetta; stage what it expects.
    const translated =
      os === "darwin" && process.arch === "x64"
        ? (yield* run("sysctl", ["-n", "sysctl.proc_translated"]).pipe(
            Effect.map((result) => result.stdout.trim()),
            Effect.orElseSucceed(() => ""),
          )) === "1"
        : false
    const arch = process.arch === "arm64" || translated ? "arm64" : process.arch === "x64" ? "x64" : undefined
    if (!arch) return yield* Effect.fail(new UpdateError(`OpenCodePlus releases are not built for ${process.arch}`))
    return `${os}-${arch}` as ReleaseTarget
  })

  const registration = Effect.fnUntraced(function* (file: string) {
    const text = yield* fs.readFileString(file).pipe(Effect.option)
    return Option.isSome(text) ? Option.getOrUndefined(decodeRegistration(text.value)) : undefined
  })

  const call = (info: Info, route: string) =>
    Effect.tryPromise({
      try: () =>
        fetch(new URL(route, info.url), {
          headers: info.password === undefined ? undefined : { authorization: `Basic ${btoa(`opencode:${info.password}`)}` },
          signal: AbortSignal.timeout(10_000),
        }).then(async (response) => ({ status: response.status, text: await response.text() })),
      catch: (cause) => new UpdateError(`The background service did not answer ${route}`, { cause }),
    })

  const waitIdle = Effect.fnUntraced(function* (incumbent: Info, progress: Progress) {
    while (true) {
      const answer = yield* call(incumbent, "/api/session/active")
      const active = answer.status === 200 ? decodeActive(answer.text) : Option.none()
      if (Option.isNone(active))
        return yield* Effect.fail(new UpdateError("Could not read which chats are running; nothing was changed"))
      const running = Object.keys(active.value.data).length
      if (running === 0) return
      progress(`Waiting for ${running} running chat${running === 1 ? "" : "s"} to finish…`)
      yield* Effect.sleep("2 seconds")
    }
  })

  const pointTo = Effect.fnUntraced(function* (install: Install, version: string) {
    const pointer = path.join(install.prefix, "bin", BINARY)
    const staging = `${pointer}.update-${process.pid}`
    yield* fs.remove(staging, { force: true })
    yield* fs.symlink(`../releases/${version}/bin/${BINARY}`, staging)
    yield* fs.rename(staging, pointer)
  })

  const startService = Effect.fnUntraced(function* (
    file: string,
    env: Readonly<Record<string, string>> | undefined,
    executable: string,
    version: string,
  ) {
    // Another TUI that lost its connection may restart its own (old) release in the
    // moment the service is down; stop that one and start this release again.
    yield* Service.ensure({
      file,
      env,
      directory: path.dirname(executable),
      command: [executable, "serve", "--service"],
      version,
      replace: false,
    }).pipe(
      Effect.tapError((error) =>
        error instanceof ServiceRefusalError ? Service.stop({ file, pty: "handoff" }).pipe(Effect.ignore) : Effect.void,
      ),
      Effect.retry({ times: 3 }),
    )
    const info = yield* registration(file)
    if (!info) return yield* Effect.fail(new UpdateError(`${describe(version)} did not register a background service`))
    const answer = yield* call(info, "/api/info")
    const health = answer.status === 200 ? Option.getOrUndefined(decodeHealth(answer.text)) : undefined
    if (health?.version !== version || health.pid !== info.pid || !alive(info.pid))
      return yield* Effect.fail(
        new UpdateError(`the background service answers as ${health?.version ?? "nothing"}, not ${version}`),
      )
  })

  const backupDatabase = Effect.fnUntraced(function* (from: string, to: string) {
    const database = databasePath(global.data)
    const root = path.join(global.data, "update-backups")
    const directory = path.join(root, `${new Date().toISOString().replace(/[:.]/g, "-")}_${from}_to_${to}`)
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 })
    const suffixes = yield* Effect.forEach(["", "-wal", "-shm"], (suffix) =>
      fs.exists(`${database}${suffix}`).pipe(
        Effect.flatMap((exists) =>
          exists
            ? fs
                .copyFile(`${database}${suffix}`, path.join(directory, `${path.basename(database)}${suffix}`))
                .pipe(Effect.as([suffix]))
            : Effect.succeed([]),
        ),
      ),
    )
    // Each copy is a whole database: keep the newest few.
    const names = (yield* fs.readDirectory(root)).toSorted().toReversed()
    yield* Effect.forEach(names.slice(KEPT_BACKUPS), (name) => fs.remove(path.join(root, name), { recursive: true }))
    return { directory, database, suffixes: suffixes.flat() }
  })

  const restoreDatabase = (backup: { readonly directory: string; readonly database: string; readonly suffixes: string[] }) =>
    Effect.forEach(["", "-wal", "-shm"], (suffix) =>
      backup.suffixes.includes(suffix)
        ? fs.copyFile(path.join(backup.directory, `${path.basename(backup.database)}${suffix}`), `${backup.database}${suffix}`)
        : fs.remove(`${backup.database}${suffix}`, { force: true }),
    )

  // The service operations read the registration and config through these.
  const provide = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Global.Service>) =>
    effect.pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.provideService(Global.Service, global))

  return {
    detect,
    newest,
    stage,
    switchTo: (install: Install, version: string, progress?: Progress) => provide(switchTo(install, version, progress)),
    update: (install: Install, version: string, progress?: Progress) => provide(update(install, version, progress)),
    readTestReleases,
    /** Resolves once no switch runs, so a reconnecting TUI finds the new service instead of restarting the old one. */
    settled: () => switching ?? Promise.resolve(),
  }
})

export type Interface = Effect.Success<typeof make>

const assetURL = (version: string, name: string) => `${site()}/releases/download/v${version}/${name}`

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: it exists, owned by someone else.
    return error instanceof Error && "code" in error && error.code === "EPERM"
  }
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
