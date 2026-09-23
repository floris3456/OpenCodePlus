#!/usr/bin/env bun

import { build, resolveBuildConfig, type ResolvedBuildConfig } from "./build"

const BINARY = "opencodeplus"

export interface PlusBuildOptions {
  version?: string
  sourceSha?: string | null
  recipeDigest?: string | null
  toolchainDigest?: string | null
  target?: string | null
  outdir?: string
  single?: boolean
  baseline?: boolean
  skipInstall?: boolean
  skipWebUi?: boolean
  define?: Record<string, string>
}

export function resolvePlusBuildConfig(options: PlusBuildOptions = {}): ResolvedBuildConfig {
  const version =
    options.version ??
    process.argv.find((arg) => arg.startsWith("--version="))?.slice("--version=".length) ??
    process.env.OPENCODE_VERSION

  if (!version) {
    throw new Error("Plus build requires an explicit version input (OPENCODE_VERSION or --version)")
  }

  const sourceSha =
    options.sourceSha !== undefined
      ? options.sourceSha
      : (process.argv.find((arg) => arg.startsWith("--source-sha="))?.slice("--source-sha=".length) ??
        process.env.OPENCODE_SOURCE_SHA ??
        null)

  const recipeDigest =
    options.recipeDigest !== undefined
      ? options.recipeDigest
      : (process.argv.find((arg) => arg.startsWith("--recipe-digest="))?.slice("--recipe-digest=".length) ??
        process.env.OPENCODE_RECIPE_DIGEST ??
        null)

  const toolchainDigest =
    options.toolchainDigest !== undefined
      ? options.toolchainDigest
      : (process.argv.find((arg) => arg.startsWith("--toolchain-digest="))?.slice("--toolchain-digest=".length) ??
        process.env.OPENCODE_TOOLCHAIN_DIGEST ??
        null)

  const target = platformTarget(
    options.target !== undefined ? options.target : (argvTarget() ?? process.env.OPENCODE_TARGET ?? null),
  )

  return resolveBuildConfig({
    binary: BINARY,
    channel: "plus",
    version,
    entrypoints: ["./src/plus.ts"],
    identity: {
      product: "opencodeplus",
      channel: "plus",
      version,
      sourceSha,
      recipeDigest,
      toolchainDigest,
      target,
    },
    ...options,
  })
}

export async function buildPlus(options: PlusBuildOptions = {}) {
  const config = resolvePlusBuildConfig(options)
  // Only an explicit request (option or --target=) selects what to build. The
  // environment's OPENCODE_TARGET labels identity alone, so CI's --single still
  // confines a runner to producing its own native target.
  const requested = options.target !== undefined ? options.target : argvTarget()
  return await build({
    binary: config.binary,
    channel: config.channel,
    version: config.version,
    entrypoints: config.entrypoints,
    identity: config.identity,
    outdir: options.outdir,
    single: options.single,
    baseline: options.baseline,
    target: requested ? `${BINARY}-${platformTarget(requested)}` : undefined,
    skipInstall: options.skipInstall,
    skipWebUi: options.skipWebUi,
    define: options.define,
  })
}

function argvTarget() {
  return process.argv.find((arg) => arg.startsWith("--target="))?.slice("--target=".length)
}

// build.ts names a build target "<binary>-<platform>" (opencodeplus-linux-x64),
// while the identity records the platform alone (linux-x64), as the native CI
// build does. Either spelling selects the same build and records the platform,
// so a cross-build can carry exactly the identity its native build carries.
function platformTarget(target: string | null) {
  return target?.startsWith(`${BINARY}-`) ? target.slice(BINARY.length + 1) : target
}

if (import.meta.main) {
  await buildPlus()
}
