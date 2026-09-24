#!/usr/bin/env bun

import { $ } from "bun"
import { mkdir, rm } from "fs/promises"
import path from "path"
import { Script } from "@opencode/script"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import type { BunPlugin } from "bun"
import pkg from "../package.json"
import { buildAppArchive } from "./app-assets"
import { verifyArtifact, verifySimulationGraph } from "./verify-artifact"
import { resolveOpencodePty } from "./opencode-pty"

export const allTargets: {
  os: string
  arch: "arm64" | "x64"
  abi?: "musl"
  avx2?: false
}[] = [
  { os: "linux", arch: "arm64" },
  { os: "linux", arch: "x64" },
  { os: "linux", arch: "x64", avx2: false },
  { os: "linux", arch: "arm64", abi: "musl" },
  { os: "linux", arch: "x64", abi: "musl" },
  { os: "linux", arch: "x64", abi: "musl", avx2: false },
  { os: "darwin", arch: "arm64" },
  { os: "darwin", arch: "x64" },
  { os: "darwin", arch: "x64", avx2: false },
  { os: "win32", arch: "arm64" },
  { os: "win32", arch: "x64" },
  { os: "win32", arch: "x64", avx2: false },
]

export function targetName(item: (typeof allTargets)[number], binary = "opencode2") {
  return [
    binary,
    item.os === "win32" ? "windows" : item.os,
    item.arch,
    item.avx2 === false ? "baseline" : undefined,
    item.abi,
  ]
    .filter(Boolean)
    .join("-")
}

export interface BuildIdentity {
  product?: string | null
  channel?: string | null
  version?: string | null
  sourceSha?: string | null
  recipeDigest?: string | null
  toolchainDigest?: string | null
  target?: string | null
}

export interface BuildOptions {
  binary?: string
  channel?: string
  version?: string
  entrypoints?: string[]
  identity?: BuildIdentity
  outdir?: string
  single?: boolean
  baseline?: boolean
  target?: string | null
  skipInstall?: boolean
  skipWebUi?: boolean
  define?: Record<string, string>
}

export interface ResolvedBuildConfig {
  binary: string
  channel: string
  version: string
  entrypoints: string[]
  identity: {
    product: string | null
    channel: string | null
    version: string | null
    sourceSha: string | null
    recipeDigest: string | null
    toolchainDigest: string | null
    target: string | null
  }
  define: Record<string, string>
}

export function resolveBuildConfig(options: BuildOptions = {}): ResolvedBuildConfig {
  const binary = options.binary ?? "opencode2"
  const channel = options.channel ?? options.identity?.channel ?? Script.channel
  const version = options.version ?? options.identity?.version ?? Script.version
  const entrypoints = options.entrypoints ?? ["./src/index.ts"]
  const identity = {
    product: options.identity?.product ?? null,
    channel: options.identity?.channel ?? (options.channel ? channel : null),
    version: options.identity?.version ?? (options.version ? version : null),
    sourceSha: options.identity?.sourceSha ?? null,
    recipeDigest: options.identity?.recipeDigest ?? null,
    toolchainDigest: options.identity?.toolchainDigest ?? null,
    target: options.identity?.target ?? null,
  }

  const define: Record<string, string> = {
    OPENCODE_VERSION: JSON.stringify(version),
    OPENCODE_CLI_NAME: JSON.stringify(binary),
    OPENCODE_CHANNEL: JSON.stringify(channel),
    OPENCODE_ARTIFACT: JSON.stringify("cli"),
    OPENCODE_PRODUCT: JSON.stringify(identity.product),
    OPENCODE_SOURCE_SHA: JSON.stringify(identity.sourceSha),
    OPENCODE_RECIPE_DIGEST: JSON.stringify(identity.recipeDigest),
    OPENCODE_TOOLCHAIN_DIGEST: JSON.stringify(identity.toolchainDigest),
    OPENCODE_TARGET: JSON.stringify(identity.target),
    ...options.define,
  }

  return {
    binary,
    channel,
    version,
    entrypoints,
    identity,
    define,
  }
}

export async function build(options: BuildOptions = {}) {
  const config = resolveBuildConfig(options)
  const dir = path.resolve(import.meta.dirname, "..")
  const outdir = path.resolve(
    dir,
    options.outdir ??
      process.argv.find((arg) => arg.startsWith("--outdir="))?.slice("--outdir=".length) ??
      "dist",
  )
  if (outdir === dir) throw new Error("--outdir must not be the package directory")
  process.chdir(dir)

  await rm(outdir, { recursive: true, force: true })

  const singleFlag = options.single ?? process.argv.includes("--single")
  const baselineFlag = options.baseline ?? process.argv.includes("--baseline")
  const requestedTarget =
    options.target ??
    process.argv.find((arg) => arg.startsWith("--target="))?.slice("--target=".length)
  const skipInstall = options.skipInstall ?? process.argv.includes("--skip-install")
  const skipWebUi = options.skipWebUi ?? process.argv.includes("--skip-web-ui")
  const solidPlugin = createSolidTransformPlugin()

  const targets =
    requestedTarget !== undefined
      ? allTargets.filter((item) => targetName(item, config.binary) === requestedTarget)
      : singleFlag
        ? allTargets.filter((item) => {
            if (item.os !== process.platform || item.arch !== process.arch) return false
            if (item.avx2 === false) return baselineFlag
            return item.abi === undefined
          })
        : allTargets
  if (!targets.length) throw new Error(`Unknown build target: ${requestedTarget}`)

  if (!skipInstall)
    await $`bun install --os="*" --cpu="*" @opentui/core@${pkg.dependencies["@opentui/core"]} @opencode-ai/pty@${pkg.dependencies["@opencode-ai/pty"]}`
  const appArchive = await buildAppArchive(config.channel, { skipBuild: skipWebUi })
  const appAssetsPlugin: BunPlugin = {
    name: "opencode-app-assets",
    setup(build) {
      build.onResolve({ filter: /^virtual:opencode-app-assets$/ }, () => ({
        path: "opencode-app-assets",
        namespace: "opencode",
      }))
      build.onLoad({ filter: /^opencode-app-assets$/, namespace: "opencode" }, () => ({
        loader: "js",
        contents: `export default ${JSON.stringify(appArchive)}`,
      }))
    },
  }

  for (const item of targets) {
    const opencodePty = await resolveOpencodePty({
      platform: item.os,
      arch: item.arch,
      ...(item.os === "linux" ? { libc: item.abi ?? "glibc" } : {}),
    })
    const opencodePtyPlugin: BunPlugin = {
      name: "opencode-pty-binary",
      setup(build) {
        build.onLoad({ filter: /persistent-pty[/\\]pty-binding\.ts$/ }, () => ({
          loader: "js",
          contents: opencodePty
            ? `import file from ${JSON.stringify(opencodePty.source)} with { type: "file" }
export default { path: file, version: ${JSON.stringify(opencodePty.version)}, sha256: ${JSON.stringify(opencodePty.sha256)} }`
            : "export default undefined",
        }))
      },
    }
    const simulationInputs = new Set<string>()
    const simulationGraphPlugin: BunPlugin = {
      name: "opencode-simulation-graph",
      setup(build) {
        build.onLoad(
          { filter: /packages[/\\]simulation[/\\]src[/\\](frontend[/\\](simulation|server)|control-server)\.ts$/ },
          (args) => void simulationInputs.add(args.path),
        )
      },
    }
    const parcelWatcherPackage = `@parcel/watcher-${item.os}-${item.arch}${item.os === "linux" ? `-${item.abi ?? "glibc"}` : ""}`
    const parcelWatcherPlugin: BunPlugin = {
      name: "parcel-watcher-binding",
      setup(build) {
        build.onLoad({ filter: /filesystem[/\\]watcher-binding\.ts$/ }, () => ({
          contents: `export default () => require(${JSON.stringify(parcelWatcherPackage)})`,
          loader: "js",
        }))
      },
    }
    const target = targetName(item, config.binary)
    const name = target.replace(config.binary, "cli")
    const executablePath = await compileExecutable(item, outdir)
    console.log(`building ${name}`)
    const result = await Bun.build({
      entrypoints: config.entrypoints,
      tsconfig: "./tsconfig.json",
      plugins: [appAssetsPlugin, solidPlugin, parcelWatcherPlugin, opencodePtyPlugin, simulationGraphPlugin],
      external: ["node-gyp"],
      format: "esm",
      minify: true,
      bytecode: true,
      sourcemap: config.channel === "dev" || config.channel === "local" ? "inline" : "none",
      splitting: true,
      compile: {
        autoloadBunfig: false,
        autoloadDotenv: false,
        autoloadTsconfig: true,
        autoloadPackageJson: true,
        target: target.replace(config.binary, "bun") as Bun.Build.CompileTarget,
        ...(executablePath ? { executablePath } : {}),
        outfile: path.join(outdir, name, "bin", config.binary),
        execArgv: [
          `--user-agent=opencode/${config.channel}/${config.version}/cli`,
          "--use-system-ca",
          "--no-warnings",
          "--",
        ],
        windows: {},
      },
      define: {
        ...config.define,
        OPENCODE_LIBC: item.os === "linux" ? `'${item.abi ?? "glibc"}'` : "undefined",
        FFF_LIBC: item.os === "linux" ? `'${item.abi ?? "gnu"}'` : "undefined",
        ...(item.os === "linux" ? { "process.env.OPENTUI_LIBC": JSON.stringify(item.abi ?? "glibc") } : {}),
      },
    })

    if (!result.success) {
      for (const log of result.logs) console.error(log)
      process.exit(1)
    }
    verifySimulationGraph(simulationInputs)

    await Bun.write(
      path.join(outdir, name, "package.json"),
      JSON.stringify(
        {
          name: `@opencode/${name}`,
          version: config.version,
          license: "MIT",
          repository: { type: "git", url: "git+https://github.com/anomalyco/opencode.git" },
          os: [item.os],
          cpu: [item.arch],
        },
        null,
        2,
      ),
    )
    await verifyArtifact(path.join(outdir, name))
  }
}

async function compileExecutable(item: (typeof allTargets)[number], outdir: string) {
  const release = process.env.BUN_COMPILE_RELEASE
  if (!release) return

  const platform = item.os === "win32" ? "windows" : item.os
  const name = [
    "bun",
    platform,
    item.arch === "arm64" ? "aarch64" : item.arch,
    item.abi,
    item.avx2 === false ? "baseline" : undefined,
  ]
    .filter(Boolean)
    .join("-")
  const cache = path.join(outdir, ".bun", release)
  const executable = path.join(cache, name, item.os === "win32" ? "bun.exe" : "bun")
  if (await Bun.file(executable).exists()) return executable

  await mkdir(cache, { recursive: true })
  const archive = path.join(cache, `${name}.zip`)
  // The release's public download URL, not the REST API: unauthenticated API calls share a
  // per-IP rate limit that hosted runners exhaust (HTTP 403), and downloads are not limited.
  const url = `https://github.com/oven-sh/bun/releases/download/${release}/${name}.zip`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Failed to download ${name} from Bun release ${release}: ${response.status}`)
  // Stream to disk instead of `Bun.write(archive, response)`: passing the Response object
  // hangs forever if it gets GC'd mid-download (https://github.com/oven-sh/bun/issues/40278).
  const sink = Bun.file(archive).writer()
  for await (const chunk of response.body!) await sink.write(chunk)
  await sink.end()
  await $`unzip -oq ${archive} -d ${cache}`
  await rm(archive)
  return executable
}

if (import.meta.main) {
  await build()
}
