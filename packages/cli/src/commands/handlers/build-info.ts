import { EOL } from "node:os"
import { Effect } from "effect"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"

declare const OPENCODE_PRODUCT: string | null | undefined
declare const OPENCODE_CHANNEL: string | null | undefined
declare const OPENCODE_VERSION: string | null | undefined
declare const OPENCODE_SOURCE_SHA: string | null | undefined
declare const OPENCODE_RECIPE_DIGEST: string | null | undefined
declare const OPENCODE_TOOLCHAIN_DIGEST: string | null | undefined
declare const OPENCODE_TARGET: string | null | undefined

export interface BuildInfo {
  product: string | null
  channel: string | null
  version: string | null
  sourceSha: string | null
  recipeDigest: string | null
  toolchainDigest: string | null
  target: string | null
}

export function getBuildInfo(): BuildInfo {
  return {
    product: typeof OPENCODE_PRODUCT !== "undefined" && OPENCODE_PRODUCT !== null ? OPENCODE_PRODUCT : null,
    channel: typeof OPENCODE_CHANNEL !== "undefined" && OPENCODE_CHANNEL !== null ? OPENCODE_CHANNEL : null,
    version: typeof OPENCODE_VERSION !== "undefined" && OPENCODE_VERSION !== null ? OPENCODE_VERSION : null,
    sourceSha: typeof OPENCODE_SOURCE_SHA !== "undefined" && OPENCODE_SOURCE_SHA !== null ? OPENCODE_SOURCE_SHA : null,
    recipeDigest:
      typeof OPENCODE_RECIPE_DIGEST !== "undefined" && OPENCODE_RECIPE_DIGEST !== null ? OPENCODE_RECIPE_DIGEST : null,
    toolchainDigest:
      typeof OPENCODE_TOOLCHAIN_DIGEST !== "undefined" && OPENCODE_TOOLCHAIN_DIGEST !== null
        ? OPENCODE_TOOLCHAIN_DIGEST
        : null,
    target: typeof OPENCODE_TARGET !== "undefined" && OPENCODE_TARGET !== null ? OPENCODE_TARGET : null,
  }
}

export default Runtime.handler(
  Commands.commands["build-info"]!,
  Effect.fn("cli.buildInfo")(function* (input) {
    const info = getBuildInfo()
    if (input.json) {
      process.stdout.write(JSON.stringify(info, null, 2) + EOL)
      return
    }
    const lines = [
      `Product: ${info.product ?? "unknown"}`,
      `Channel: ${info.channel ?? "unknown"}`,
      `Version: ${info.version ?? "unknown"}`,
      `Source SHA: ${info.sourceSha ?? "none"}`,
      `Recipe digest: ${info.recipeDigest ?? "none"}`,
      `Toolchain digest: ${info.toolchainDigest ?? "none"}`,
      `Target: ${info.target ?? "unknown"}`,
    ]
    process.stdout.write(lines.join(EOL) + EOL)
  }),
)
