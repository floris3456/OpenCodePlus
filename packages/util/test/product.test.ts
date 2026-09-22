import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { pathToFileURL } from "url"
import { Context, Effect, Layer } from "effect"
import { Product } from "../src/product.js"
import { Global } from "../src/global.js"

const productModule = pathToFileURL(path.join(import.meta.dir, "../src/product.ts")).href
const globalModule = pathToFileURL(path.join(import.meta.dir, "../src/global.ts")).href
const layerNodeModule = pathToFileURL(path.join(import.meta.dir, "../src/effect/layer-node.ts")).href

describe("product identity", () => {
  test("both identities resolve explicitly", () => {
    const upstream = Product.resolve("opencode")
    expect(upstream).toEqual({
      namespace: "opencode",
      channel: "latest",
      displayName: "OpenCode",
      binaryName: "opencode2",
    })

    const plus = Product.resolve("opencodeplus")
    expect(plus).toEqual({
      namespace: "opencodeplus",
      channel: "plus",
      displayName: "OpenCodePlus",
      binaryName: "opencodeplus",
    })

    const plusByChannel = Product.resolve("plus")
    expect(plusByChannel).toEqual(plus)
  })

  test("default environment resolves upstream identity", () => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "-e",
        `
          const { Product } = await import(${JSON.stringify(productModule)})
          console.log(JSON.stringify(Product.resolve()))
        `,
      ],
      env: {
        ...process.env,
        OPENCODE_PRODUCT: "",
        OPENCODE_CHANNEL: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    })

    expect(result.exitCode, result.stderr.toString()).toBe(0)
    const resolved = JSON.parse(result.stdout.toString())
    expect(resolved).toEqual({
      namespace: "opencode",
      channel: "latest",
      displayName: "OpenCode",
      binaryName: "opencode2",
    })
  })

  test("OPENCODE_PRODUCT=opencodeplus resolves Plus identity", () => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "-e",
        `
          const { Product } = await import(${JSON.stringify(productModule)})
          console.log(JSON.stringify({
            namespace: Product.namespace,
            channel: Product.channel,
            displayName: Product.displayName,
            binaryName: Product.binaryName,
            resolved: Product.resolve(),
          }))
        `,
      ],
      env: {
        ...process.env,
        OPENCODE_PRODUCT: "opencodeplus",
      },
      stdout: "pipe",
      stderr: "pipe",
    })

    expect(result.exitCode, result.stderr.toString()).toBe(0)
    const data = JSON.parse(result.stdout.toString())
    expect(data.namespace).toBe("opencodeplus")
    expect(data.channel).toBe("plus")
    expect(data.displayName).toBe("OpenCodePlus")
    expect(data.binaryName).toBe("opencodeplus")
    expect(data.resolved).toEqual({
      namespace: "opencodeplus",
      channel: "plus",
      displayName: "OpenCodePlus",
      binaryName: "opencodeplus",
    })
  })

  test("roots are isolated per namespace", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "product-roots-isolation-"))
    const baseEnv = {
      XDG_DATA_HOME: path.join(root, "share"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_STATE_HOME: path.join(root, "state"),
      TMPDIR: path.join(root, "tmp"),
    }

    const runWithProduct = (productEnv: string) => {
      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          "-e",
          `
            const { Global } = await import(${JSON.stringify(globalModule)})
            console.log(JSON.stringify({
              data: Global.Path.data,
              cache: Global.Path.cache,
              config: Global.Path.config,
              state: Global.Path.state,
              tmp: Global.Path.tmp,
              bin: Global.Path.bin,
              log: Global.Path.log,
              repos: Global.Path.repos,
            }))
          `,
        ],
        env: {
          ...process.env,
          ...baseEnv,
          OPENCODE_PRODUCT: productEnv,
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(result.exitCode, result.stderr.toString()).toBe(0)
      return JSON.parse(result.stdout.toString())
    }

    const upstreamPaths = runWithProduct("opencode")
    const plusPaths = runWithProduct("opencodeplus")

    expect(upstreamPaths.data).toBe(path.join(baseEnv.XDG_DATA_HOME, "opencode"))
    expect(upstreamPaths.config).toBe(path.join(baseEnv.XDG_CONFIG_HOME, "opencode"))
    expect(upstreamPaths.cache).toBe(path.join(baseEnv.XDG_CACHE_HOME, "opencode"))
    expect(upstreamPaths.state).toBe(path.join(baseEnv.XDG_STATE_HOME, "opencode"))
    expect(upstreamPaths.log).toBe(path.join(baseEnv.XDG_DATA_HOME, "opencode", "log"))

    expect(plusPaths.data).toBe(path.join(baseEnv.XDG_DATA_HOME, "opencodeplus"))
    expect(plusPaths.config).toBe(path.join(baseEnv.XDG_CONFIG_HOME, "opencodeplus"))
    expect(plusPaths.cache).toBe(path.join(baseEnv.XDG_CACHE_HOME, "opencodeplus"))
    expect(plusPaths.state).toBe(path.join(baseEnv.XDG_STATE_HOME, "opencodeplus"))
    expect(plusPaths.log).toBe(path.join(baseEnv.XDG_DATA_HOME, "opencodeplus", "log"))

    // Roots must be strictly disjoint between namespaces
    for (const key of Object.keys(upstreamPaths) as Array<keyof typeof upstreamPaths>) {
      expect(upstreamPaths[key]).not.toBe(plusPaths[key])
    }

    fs.rmSync(root, { recursive: true, force: true })
  })

  test("explicit environment overrides still win", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "product-env-overrides-"))
    const explicitConfig = path.join(root, "custom-config-dir")
    const explicitHome = path.join(root, "custom-home-dir")

    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "-e",
        `
          import { Context, Effect, Layer } from "effect"
          const { LayerNode } = await import(${JSON.stringify(layerNodeModule)})
          const { Global } = await import(${JSON.stringify(globalModule)})
          const context = await Effect.runPromise(Effect.scoped(Layer.build(LayerNode.compile(Global.node))))
          const service = Context.get(context, Global.Service)
          console.log(JSON.stringify({
            home: Global.Path.home,
            serviceConfig: service.config,
          }))
        `,
      ],
      cwd: path.join(import.meta.dir, ".."),
      env: {
        ...process.env,
        OPENCODE_PRODUCT: "opencodeplus",
        OPENCODE_TEST_HOME: explicitHome,
        OPENCODE_CONFIG_DIR: explicitConfig,
      },
      stdout: "pipe",
      stderr: "pipe",
    })

    expect(result.exitCode, result.stderr.toString()).toBe(0)
    const data = JSON.parse(result.stdout.toString())
    expect(data.home).toBe(explicitHome)
    expect(data.serviceConfig).toBe(explicitConfig)

    fs.rmSync(root, { recursive: true, force: true })
  })
})
