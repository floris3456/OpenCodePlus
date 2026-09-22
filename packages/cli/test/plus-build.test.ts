import { describe, expect, test } from "bun:test"
import { Script } from "@opencode/script"
import { resolveBuildConfig } from "../script/build"
import { resolvePlusBuildConfig } from "../script/build-plus"
import { getBuildInfo } from "../src/commands/handlers/build-info"

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
})
