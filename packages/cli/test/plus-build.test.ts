import { describe, expect, test } from "bun:test"
import path from "path"
import { Script } from "@opencode/script"
import { resolveBuildConfig } from "../script/build"
import { resolvePlusBuildConfig } from "../script/build-plus"
import { getBuildInfo } from "../src/commands/handlers/build-info"
import { Commands } from "../src/commands/commands"
import { Runtime } from "../src/framework/runtime"
import { type Spec } from "../src/framework/spec"
import { upstreamHandlers } from "../src/index"
import { plusHandlers } from "../src/plus"

describe("plus build configuration", () => {
  test("uses binary name opencodeplus and channel plus", () => {
    const config = resolvePlusBuildConfig({ version: "1.0.0" })
    expect(config.binary).toBe("opencodeplus")
    expect(config.channel).toBe("plus")
    expect(config.entrypoints).toEqual(["./src/plus.ts"])
    expect(config.define.OPENCODE_CLI_NAME).toBe(JSON.stringify("opencodeplus"))
    expect(config.define.OPENCODE_CHANNEL).toBe(JSON.stringify("plus"))
    expect(config.define.OPENCODE_PRODUCT).toBe(JSON.stringify("opencodeplus"))
  })

  test("missing version input is a hard error", () => {
    const origEnv = process.env.OPENCODE_VERSION
    delete process.env.OPENCODE_VERSION
    try {
      expect(() => resolvePlusBuildConfig({ version: "" })).toThrow(/explicit version input/)
      expect(() => resolvePlusBuildConfig({ version: undefined })).toThrow(/explicit version input/)
      expect(() => resolvePlusBuildConfig({})).toThrow(/explicit version input/)
    } finally {
      if (origEnv !== undefined) process.env.OPENCODE_VERSION = origEnv
      else delete process.env.OPENCODE_VERSION
    }
  })

  test("supplied identity values reach the defines unchanged", () => {
    const sha = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"
    const recipe = "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
    const toolchain = "fedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321"
    const target = "linux-x64"

    const config = resolvePlusBuildConfig({
      version: "2.5.0-plus.1",
      sourceSha: sha,
      recipeDigest: recipe,
      toolchainDigest: toolchain,
      target,
    })

    expect(config.identity.product).toBe("opencodeplus")
    expect(config.identity.channel).toBe("plus")
    expect(config.identity.version).toBe("2.5.0-plus.1")
    expect(config.identity.sourceSha).toBe(sha)
    expect(config.identity.recipeDigest).toBe(recipe)
    expect(config.identity.toolchainDigest).toBe(toolchain)
    expect(config.identity.target).toBe(target)

    expect(config.define.OPENCODE_PRODUCT).toBe(JSON.stringify("opencodeplus"))
    expect(config.define.OPENCODE_CHANNEL).toBe(JSON.stringify("plus"))
    expect(config.define.OPENCODE_VERSION).toBe(JSON.stringify("2.5.0-plus.1"))
    expect(config.define.OPENCODE_SOURCE_SHA).toBe(JSON.stringify(sha))
    expect(config.define.OPENCODE_RECIPE_DIGEST).toBe(JSON.stringify(recipe))
    expect(config.define.OPENCODE_TOOLCHAIN_DIGEST).toBe(JSON.stringify(toolchain))
    expect(config.define.OPENCODE_TARGET).toBe(JSON.stringify(target))
  })

  test("a build-target spelling records the platform alone as the identity target", () => {
    // build.ts names the cross-build target opencodeplus-linux-x64; the native CI
    // build of the same target embeds linux-x64, so the identity must too.
    const config = resolvePlusBuildConfig({ version: "1.0.0", target: "opencodeplus-linux-x64" })
    expect(config.identity.target).toBe("linux-x64")
    expect(config.define.OPENCODE_TARGET).toBe(JSON.stringify("linux-x64"))
  })

  test("the web app build runs vite under Bun even where Node is installed", async () => {
    // vite embeds helpers through Function.prototype.toString, which Node and Bun render
    // differently; without --bun, `bun run` hands vite's node-shebang bin to Node when
    // Node is installed, and a builder with Node produced different web assets.
    const source = await Bun.file(path.resolve(import.meta.dirname, "../script/app-assets.ts")).text()
    expect(source).toContain("await $`bun run --bun build`")
    expect(source).not.toContain("await $`bun run build`")
  })

  test("every .wasm module is bundled with the file loader", async () => {
    // tree-sitter.wasm is imported `with { type: "file" }` and also reached through the
    // default .wasm loader; without one configured loader the bundler records whichever
    // reference it parses first, so two builds of one commit could differ.
    const source = await Bun.file(path.resolve(import.meta.dirname, "../script/build.ts")).text()
    expect(source).toContain(`loader: { ".wasm": "file" },`)
  })

  test("unsupplied identity values are null", () => {
    const config = resolvePlusBuildConfig({
      version: "1.0.0",
      sourceSha: null,
      recipeDigest: null,
      toolchainDigest: null,
      target: null,
    })

    expect(config.identity.sourceSha).toBeNull()
    expect(config.identity.recipeDigest).toBeNull()
    expect(config.identity.toolchainDigest).toBeNull()
    expect(config.identity.target).toBeNull()

    expect(config.define.OPENCODE_SOURCE_SHA).toBe(JSON.stringify(null))
    expect(config.define.OPENCODE_RECIPE_DIGEST).toBe(JSON.stringify(null))
    expect(config.define.OPENCODE_TOOLCHAIN_DIGEST).toBe(JSON.stringify(null))
    expect(config.define.OPENCODE_TARGET).toBe(JSON.stringify(null))
  })

  test("upstream build configuration is unchanged", () => {
    const config = resolveBuildConfig()
    expect(config.binary).toBe("opencode2")
    expect(config.channel).toBe(Script.channel)
    expect(config.version).toBe(Script.version)
    expect(config.entrypoints).toEqual(["./src/index.ts"])
    expect(config.define.OPENCODE_CLI_NAME).toBe(JSON.stringify("opencode2"))
    expect(config.define.OPENCODE_CHANNEL).toBe(JSON.stringify(Script.channel))
    expect(config.define.OPENCODE_VERSION).toBe(JSON.stringify(Script.version))
    expect(config.define.OPENCODE_PRODUCT).toBe(JSON.stringify(null))
    expect(config.define.OPENCODE_SOURCE_SHA).toBe(JSON.stringify(null))
    expect(config.define.OPENCODE_RECIPE_DIGEST).toBe(JSON.stringify(null))
    expect(config.define.OPENCODE_TOOLCHAIN_DIGEST).toBe(JSON.stringify(null))
    expect(config.define.OPENCODE_TARGET).toBe(JSON.stringify(null))
  })

  test("build-info returns exact key set", () => {
    const info = getBuildInfo()
    const keys = Object.keys(info)
    expect(keys.sort()).toEqual([
      "channel",
      "product",
      "recipeDigest",
      "sourceSha",
      "target",
      "toolchainDigest",
      "version",
    ])
  })

  test("every command node in Commands has a handler in upstream index.ts", () => {
    expect(typeof upstreamHandlers.$).toBe("function")
    expect(findMissingHandlers(Commands, upstreamHandlers)).toEqual([])
    expect(() => Runtime.handlers(Commands, upstreamHandlers)).not.toThrow()
  })

  test("every command node in Commands has a handler in plus.ts", () => {
    expect(typeof plusHandlers.$).toBe("function")
    expect(findMissingHandlers(Commands, plusHandlers)).toEqual([])
    expect(() => Runtime.handlers(Commands, plusHandlers)).not.toThrow()
  })

  test("package.json dependency keys follow bun canonical order", async () => {
    const pkg = await Bun.file(path.resolve(import.meta.dirname, "../package.json")).json()
    const blocks = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const

    expect(pkg.dependencies).toBeDefined()
    expect(pkg.devDependencies).toBeDefined()

    for (const block of blocks) {
      const record = pkg[block]
      if (!record) continue
      const keys = Object.keys(record)
      expect(keys).toEqual([...keys].sort())
    }
  })
})

function findMissingHandlers(node: Spec.Any, map: unknown, path = ""): string[] {
  if (!map) return [path || node.name]
  if (typeof map === "function") return []
  if (typeof map !== "object") return [path || node.name]
  const record = map as Record<string, unknown>
  const missing: string[] = []
  if (Object.keys(node.commands).length === 0) {
    if (typeof record.$ !== "function") {
      missing.push(path || node.name)
    }
    return missing
  }
  for (const [name, child] of Object.entries(node.commands)) {
    const childPath = path ? `${path}.${name}` : name
    if (!(name in record) || record[name] === undefined) {
      missing.push(childPath)
      continue
    }
    missing.push(...findMissingHandlers(child, record[name], childPath))
  }
  return missing
}
