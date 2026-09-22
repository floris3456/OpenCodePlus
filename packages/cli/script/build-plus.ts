#!/usr/bin/env bun

import { build, resolveBuildConfig, type ResolvedBuildConfig } from "./build"

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

  const target =
    options.target !== undefined
      ? options.target
      : (process.argv.find((arg) => arg.startsWith("--target="))?.slice("--target=".length) ??
        process.env.OPENCODE_TARGET ??
        null)

  return resolveBuildConfig({
    binary: "opencodeplus",
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
  return await build({
    binary: config.binary,
    channel: config.channel,
    version: config.version,
    entrypoints: config.entrypoints,
    identity: config.identity,
    outdir: options.outdir,
    single: options.single,
    baseline: options.baseline,
    target: options.target ?? undefined,
    skipInstall: options.skipInstall,
    skipWebUi: options.skipWebUi,
    define: options.define,
  })
}

if (import.meta.main) {
  await buildPlus()
}
