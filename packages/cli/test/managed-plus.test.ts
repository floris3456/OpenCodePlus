import { NodeFileSystem, NodeServices } from "@effect/platform-node"
import { expect, test } from "bun:test"
import { Effect } from "effect"
import { Global } from "@opencode/util/global"
import { AppProcess } from "@opencode/util/process"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Updater } from "../src/services/updater"
import { ServiceConfig } from "../src/services/service-config"
import { Product } from "@opencode/util/product"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test("Plus product identity updates only through its own installer and never replaces the service automatically", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-plus-managed-"))
  const previous = process.env.OPENCODE_PRODUCT
  // No release is published on this site, so every lookup finds nothing.
  const site = Bun.serve({ port: 0, fetch: () => new Response("Not Found", { status: 404 }) })
  const previousSite = process.env.OPENCODEPLUS_RELEASE_SITE
  try {
    process.env.OPENCODE_PRODUCT = "opencodeplus"
    process.env.OPENCODEPLUS_RELEASE_SITE = `http://127.0.0.1:${site.port}`

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
        const failure = <A>(effect: Effect.Effect<A, Error>) =>
          effect.pipe(
            Effect.flip,
            Effect.map((error) => error.message),
          )

        // This test process runs from source and is not an install.sh install:
        // nothing is offered, and updating explains how to install one that can.
        expect(yield* updater.check()).toEqual({
          type: "unavailable",
          message: "This build runs from a source checkout. Use an installed OpenCodePlus release to check for updates.",
        })
        expect(yield* updater.run()).toBeUndefined()
        expect(yield* updater.method()).toBeUndefined()
        const notInstalled = yield* failure(updater.apply("2.0.18-plus-1.0.1"))
        expect(notInstalled).toContain("was not installed by its installer")
        expect(notInstalled).toContain("https://github.com/floris3456/OpenCodePlus/releases/latest/download/install.sh")

        // A package manager never installs OpenCodePlus.
        expect(yield* failure(updater.upgrade("npm", "2.0.18-plus-1.0.1"))).toContain(
          "updates only through its own installer",
        )
        expect(yield* failure(updater.latest())).toContain("No OpenCodePlus release is available yet")
        // A malformed version is refused before anything is looked up or run.
        for (const version of ["", "latest", "2.0.18-plus-1.0", "2.0.18-plus-1.0.1; echo unsafe", "0.0.0-plus-r5.4"])
          expect(yield* failure(updater.upgrade("opencodeplus", version))).toBe(`Invalid version: ${version}`)

        // removal returns undefined
        const removal = updater.removal("npm")
        expect(removal).toBeUndefined()

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
    site.stop(true)
    if (previous === undefined) delete process.env.OPENCODE_PRODUCT
    else process.env.OPENCODE_PRODUCT = previous
    if (previousSite === undefined) delete process.env.OPENCODEPLUS_RELEASE_SITE
    else process.env.OPENCODEPLUS_RELEASE_SITE = previousSite
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
