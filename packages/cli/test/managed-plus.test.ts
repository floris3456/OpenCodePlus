import { NodeFileSystem, NodeServices } from "@effect/platform-node"
import { expect, test } from "bun:test"
import { Effect, Layer, Queue } from "effect"
import { Global } from "@opencode/util/global"
import { AppProcess } from "@opencode/util/process"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Updater } from "../src/services/updater"
import { ServiceConfig } from "../src/services/service-config"
import { Product } from "@opencode/util/product"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test("Plus product identity disables self-update and automatic service replacement", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-plus-managed-"))
  const previous = process.env.OPENCODE_PRODUCT
  try {
    process.env.OPENCODE_PRODUCT = "opencodeplus"

    expect(Product.namespace).toBe("opencodeplus")
    expect(Product.channel).toBe("plus")

    const globalLayer = Global.layerWith({
      config: path.join(root, "config"),
      state: path.join(root, "state"),
      cache: path.join(root, "cache"),
      data: path.join(root, "data"),
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const updater = yield* Updater.Service

        // check returns unavailable
        const check = yield* updater.check()
        expect(check).toEqual({
          type: "unavailable",
          message: "Updates are disabled for OpenCodePlus.",
        })

        // run returns undefined without checking or installing
        const run = yield* updater.run()
        expect(run).toBeUndefined()

        // apply fails with disabled error
        const applyError = yield* updater.apply("2.0.0").pipe(
          Effect.flip,
          Effect.map((error) => error.message),
        )
        expect(applyError).toContain("Self-update is disabled for OpenCodePlus")

        // upgrade fails with disabled error
        const upgradeError = yield* updater.upgrade("npm", "2.0.0").pipe(
          Effect.flip,
          Effect.map((error) => error.message),
        )
        expect(upgradeError).toContain("Self-update is disabled for OpenCodePlus")

        // latest fails with disabled error
        const latestError = yield* updater.latest().pipe(
          Effect.flip,
          Effect.map((error) => error.message),
        )
        expect(latestError).toContain("Self-update is disabled for OpenCodePlus")

        // method returns undefined
        const method = yield* updater.method()
        expect(method).toBeUndefined()

        // removal returns undefined
        const removal = updater.removal("npm")
        expect(removal).toBeUndefined()

        // pollUpdates completes immediately
        const checks = yield* Queue.unbounded<void>()
        yield* Updater.pollUpdates({ check: Queue.offer(checks, undefined).pipe(Effect.asVoid) })
        expect(yield* Queue.size(checks)).toBe(0)

        // service config options disable replacement
        const options = yield* ServiceConfig.options()
        expect(options.replace).toBe(false)

        // legacy config migration is skipped
        expect(ServiceConfig.legacyFilename()).toBeUndefined()
        expect(ServiceConfig.legacyFilename("beta")).toBeUndefined()
      }).pipe(
        Effect.provide(Updater.layer),
        Effect.provide(LayerNode.compile(AppProcess.node)),
        Effect.provide(globalLayer),
        Effect.provide(NodeServices.layer),
      ),
    )
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_PRODUCT
    else process.env.OPENCODE_PRODUCT = previous
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("Upstream product identity preserves default self-update behavior and filenames", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-upstream-managed-"))
  const previous = process.env.OPENCODE_PRODUCT
  try {
    delete process.env.OPENCODE_PRODUCT

    expect(Product.namespace).toBe("opencode")
    expect(Product.displayName).toBe("OpenCode")

    const globalLayer = Global.layerWith({
      config: path.join(root, "config"),
      state: path.join(root, "state"),
      cache: path.join(root, "cache"),
      data: path.join(root, "data"),
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const options = yield* ServiceConfig.options()
        expect(options.replace).toBeUndefined()

        expect(ServiceConfig.legacyFilename("beta")).toBeDefined()
        expect(ServiceConfig.filename("beta")).toBe("service.json")
      }).pipe(
        Effect.provide(globalLayer),
        Effect.provide(NodeServices.layer),
      ),
    )
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_PRODUCT
    else process.env.OPENCODE_PRODUCT = previous
    await fs.rm(root, { recursive: true, force: true })
  }
})
