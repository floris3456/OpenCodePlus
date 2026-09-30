import { NodeServices } from "@effect/platform-node"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Global } from "@opencode/util/global"
import { AppProcess } from "@opencode/util/process"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { PlusUpdate } from "../src/services/plus-update"

// A release site shaped like GitHub's: releases/latest/download/<asset>,
// releases/download/v<version>/<asset>, and the API's release list. Its releases
// are built here with the real install.sh, so staging runs the real installer.

const repoRoot = path.join(import.meta.dir, "../../..")
const target = `${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")

type Site = {
  releases: Map<string, Map<string, Uint8Array>>
  listed: { tag_name: string; draft: boolean }[]
  latest?: string
  requests: string[]
}

let root: string
let site: Site
let server: ReturnType<typeof Bun.serve>

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      site.requests.push(url.pathname)
      if (url.pathname === "/api/releases") return Response.json(site.listed)
      const latest = /^\/site\/releases\/latest\/download\/(.+)$/.exec(url.pathname)
      const fixed = /^\/site\/releases\/download\/v([^/]+)\/(.+)$/.exec(url.pathname)
      const [version, name] = latest ? [site.latest, latest[1]] : fixed ? [fixed[1], fixed[2]] : []
      const bytes = version && name ? site.releases.get(version)?.get(name) : undefined
      return bytes ? new Response(new Blob([Buffer.from(bytes)])) : new Response("Not Found", { status: 404 })
    },
  })
  process.env.OPENCODEPLUS_RELEASE_SITE = `http://127.0.0.1:${server.port}/site`
  process.env.OPENCODEPLUS_RELEASE_API = `http://127.0.0.1:${server.port}/api`
})

afterAll(() => {
  server.stop(true)
  delete process.env.OPENCODEPLUS_RELEASE_SITE
  delete process.env.OPENCODEPLUS_RELEASE_API
})

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "plus-update-"))
  site = { releases: new Map(), listed: [], requests: [] }
})

afterEach(async () => {
  await Bun.$`chmod -R u+w ${root}`.quiet().nothrow()
  await fs.rm(root, { recursive: true, force: true })
})

/** A release whose binary answers --version, published on the site. */
async function publish(version: string, options: { starts?: boolean; draft?: boolean } = {}) {
  const dir = await fs.mkdtemp(path.join(root, "build-"))
  await fs.mkdir(path.join(dir, "bin"))
  const binary = `#!/bin/sh\nif [ "$1" = "--version" ]; then ${options.starts === false ? "exit 3" : `echo "opencodeplus v${version}"`}; fi\n`
  await fs.writeFile(path.join(dir, "bin/opencodeplus"), binary, { mode: 0o755 })
  await fs.writeFile(path.join(dir, "metadata.json"), JSON.stringify({ version }))
  await fs.writeFile(path.join(dir, "LICENSE"), "license\n")
  await fs.writeFile(path.join(dir, "NOTICE"), "notice\n")
  const archiveName = `opencodeplus-${target}.tar.gz`
  await Bun.$`tar -czf ${path.join(dir, archiveName)} -C ${dir} bin/opencodeplus metadata.json LICENSE NOTICE`.quiet()
  const archive = new Uint8Array(await Bun.file(path.join(dir, archiveName)).arrayBuffer())
  const installer = new Uint8Array(await Bun.file(path.join(repoRoot, "install.sh")).arrayBuffer())
  const manifest = JSON.stringify({
    contractVersion: 1,
    release: {
      product: "opencodeplus",
      channel: "plus",
      version,
      sourceSha: "0".repeat(40),
      recipeDigest: "1".repeat(64),
      toolchainDigest: "2".repeat(64),
    },
    artifacts: [
      { target, archiveName, archiveSha256: sha256(archive), binarySha256: sha256(binary), bytes: archive.byteLength },
    ],
    unqualifiedTargets: [],
    installerSha256: sha256(installer),
    generatedAt: new Date(0).toISOString(),
  })
  const sums = [
    `${sha256(archive)}  ${archiveName}`,
    `${sha256(installer)}  install.sh`,
    `${sha256(manifest)}  release.json`,
    "",
  ].join("\n")
  site.releases.set(
    version,
    new Map<string, Uint8Array>([
      ["release.json", new TextEncoder().encode(manifest)],
      ["SHA256SUMS", new TextEncoder().encode(sums)],
      ["install.sh", installer],
      [archiveName, archive],
    ]),
  )
  site.listed.push({ tag_name: `v${version}`, draft: options.draft ?? false })
  return { archiveName, binary }
}

/** An install as install.sh leaves it: `<prefix>/bin/opencodeplus -> ../releases/<version>/bin/opencodeplus`. */
async function installed(version: string) {
  const prefix = path.join(root, "prefix")
  await fs.mkdir(path.join(prefix, "releases", version, "bin"), { recursive: true })
  await fs.writeFile(path.join(prefix, "releases", version, "bin/opencodeplus"), `#!/bin/sh\necho v${version}\n`, {
    mode: 0o755,
  })
  await fs.mkdir(path.join(prefix, "bin"), { recursive: true })
  await fs.symlink(`../releases/${version}/bin/opencodeplus`, path.join(prefix, "bin/opencodeplus"))
  return { prefix, executable: path.join(prefix, "bin/opencodeplus") }
}

const pointer = (prefix: string) => fs.readlink(path.join(prefix, "bin/opencodeplus"))

function run<A, E>(use: (updater: PlusUpdate.Interface) => Effect.Effect<A, E, never>) {
  return Effect.runPromise(
    Effect.gen(function* () {
      return yield* use(yield* PlusUpdate.make)
    }).pipe(
      Effect.provide(LayerNode.compile(AppProcess.node)),
      Effect.provide(
        Global.layerWith({
          config: path.join(root, "config"),
          state: path.join(root, "state"),
          cache: path.join(root, "cache"),
          data: path.join(root, "data"),
        }),
      ),
      Effect.provide(NodeServices.layer),
    ),
  )
}

async function failure<A>(use: (updater: PlusUpdate.Interface) => Effect.Effect<A, unknown, never>) {
  return run((updater) =>
    use(updater).pipe(
      Effect.flip,
      Effect.map((error) => (error instanceof Error ? error.message : String(error))),
    ),
  )
}

describe("PlusUpdate", () => {
  test("recognises only an install made by install.sh", async () => {
    const install = await installed("2.0.18-plus-1.0.0")
    expect(await run((updater) => updater.detect(install.executable))).toEqual({
      prefix: install.prefix,
      running: "2.0.18-plus-1.0.0",
      active: "2.0.18-plus-1.0.0",
    })
    // A source run, or a binary outside a release directory.
    expect(await run((updater) => updater.detect(process.execPath))).toBeUndefined()
    await fs.rm(path.join(install.prefix, "bin/opencodeplus"))
    expect(
      await run((updater) => updater.detect(path.join(install.prefix, "releases/2.0.18-plus-1.0.0/bin/opencodeplus"))),
    ).toBeUndefined()
  })

  test("offers the release marked Latest, and nothing while no release is Latest", async () => {
    await publish("2.0.18-plus-1.0.0")
    await publish("2.0.18-plus-1.0.1")
    expect(await run((updater) => updater.newest())).toBeUndefined()
    site.latest = "2.0.18-plus-1.0.0"
    expect((await run((updater) => updater.newest({ fresh: true })))?.version).toBe("2.0.18-plus-1.0.0")
    // The test release 1.0.1 is not offered without the setting.
    expect(site.requests).not.toContain("/api/releases")
  })

  test("offers the newest test release when update_test_releases is on, ignoring drafts and old tags", async () => {
    await fs.mkdir(path.join(root, "config"), { recursive: true })
    await fs.writeFile(path.join(root, "config/opencode.json"), JSON.stringify({ update_test_releases: true }))
    await publish("2.0.18-plus-1.0.9")
    await publish("2.0.18-plus-1.0.10")
    await publish("2.0.18-plus-1.1.0", { draft: true })
    site.listed.push({ tag_name: "v0.0.0-plus-r5.3", draft: false })
    site.latest = "2.0.18-plus-1.0.9"
    expect((await run((updater) => updater.newest()))?.version).toBe("2.0.18-plus-1.0.10")
  })

  test("shares one answer for five minutes unless asked for a fresh one", async () => {
    await publish("2.0.18-plus-1.0.0")
    site.latest = "2.0.18-plus-1.0.0"
    await run((updater) => updater.newest())
    await run((updater) => updater.newest())
    expect(site.requests.filter((request) => request.includes("/latest/"))).toHaveLength(1)
    await publish("2.0.18-plus-1.0.1")
    site.latest = "2.0.18-plus-1.0.1"
    expect((await run((updater) => updater.newest()))?.version).toBe("2.0.18-plus-1.0.0")
    expect((await run((updater) => updater.newest({ fresh: true })))?.version).toBe("2.0.18-plus-1.0.1")
  })

  test("stages with the release's own installer and switches the pointer when no service runs", async () => {
    const install = await installed("2.0.18-plus-1.0.0")
    const { binary } = await publish("2.0.18-plus-1.0.1")
    const steps: string[] = []
    await run((updater) =>
      Effect.gen(function* () {
        const found = yield* updater.detect(install.executable)
        if (!found) return yield* Effect.die("not detected")
        yield* updater.update(found, "2.0.18-plus-1.0.1", (message) => steps.push(message))
      }),
    )
    expect(await pointer(install.prefix)).toBe("../releases/2.0.18-plus-1.0.1/bin/opencodeplus")
    const staged = path.join(install.prefix, "releases/2.0.18-plus-1.0.1/bin/opencodeplus")
    expect(sha256(await fs.readFile(staged))).toBe(sha256(binary))
    // install.sh leaves releases read-only.
    expect((await fs.stat(path.join(install.prefix, "releases/2.0.18-plus-1.0.1"))).mode & 0o222).toBe(0)
    expect(steps).toEqual([
      "Downloading OpenCodePlus 1.0.1 (opencode 2.0.18)…",
      "Installing OpenCodePlus 1.0.1 (opencode 2.0.18)…",
    ])
  })

  test("refuses a release whose files do not match their records, installing nothing", async () => {
    const cases: Array<[string, (files: Map<string, Uint8Array>, archiveName: string) => void, string]> = [
      [
        "archive",
        (files, archiveName) => files.set(archiveName, new Uint8Array([...files.get(archiveName)!, 0])),
        "opencodeplus-",
      ],
      ["installer", (files) => files.set("install.sh", new TextEncoder().encode("#!/bin/sh\nexit 0\n")), "install.sh of"],
      ["checksum list", (files) => files.set("SHA256SUMS", new TextEncoder().encode("")), "release.json of"],
    ]
    for (const [label, corrupt, expected] of cases) {
      const install = await installed("2.0.18-plus-1.0.0")
      const { archiveName } = await publish("2.0.18-plus-1.0.1")
      corrupt(site.releases.get("2.0.18-plus-1.0.1")!, archiveName)
      const message = await failure((updater) =>
        Effect.gen(function* () {
          const found = yield* updater.detect(install.executable)
          if (!found) return yield* Effect.die("not detected")
          yield* updater.update(found, "2.0.18-plus-1.0.1")
        }),
      )
      expect({ label, message: message.includes(expected) && message.includes("nothing was installed") }).toEqual({
        label,
        message: true,
      })
      expect(await pointer(install.prefix)).toBe("../releases/2.0.18-plus-1.0.0/bin/opencodeplus")
      expect(await Bun.file(path.join(install.prefix, "releases/2.0.18-plus-1.0.1/bin/opencodeplus")).exists()).toBe(false)
      await Bun.$`chmod -R u+w ${install.prefix}`.quiet().nothrow()
      await fs.rm(install.prefix, { recursive: true, force: true })
    }
  })

  test("refuses a manifest naming another version, and a binary that does not start, keeping the pointer", async () => {
    const install = await installed("2.0.18-plus-1.0.0")
    await publish("2.0.18-plus-1.0.2")
    site.releases.set("2.0.18-plus-1.0.1", site.releases.get("2.0.18-plus-1.0.2")!)
    const update = (version: string) =>
      failure((updater) =>
        Effect.gen(function* () {
          const found = yield* updater.detect(install.executable)
          if (!found) return yield* Effect.die("not detected")
          yield* updater.update(found, version)
        }),
      )
    expect(await update("2.0.18-plus-1.0.1")).toBe("The manifest of v2.0.18-plus-1.0.1 names version 2.0.18-plus-1.0.2")

    await publish("2.0.18-plus-1.0.3", { starts: false })
    expect(await update("2.0.18-plus-1.0.3")).toContain("OpenCodePlus 1.0.3 (opencode 2.0.18) does not start on this machine")
    expect(await pointer(install.prefix)).toBe("../releases/2.0.18-plus-1.0.0/bin/opencodeplus")
  })

  test("orders and names versions for people", () => {
    expect(PlusUpdate.newer("2.0.18-plus-1.0.10", "2.0.18-plus-1.0.9")).toBe(true)
    expect(PlusUpdate.newer("2.0.18-plus-1.0.9", "2.0.18-plus-1.0.9")).toBe(false)
    // Every release of the scheme is newer than the releases before it, and nothing outside it is offered.
    expect(PlusUpdate.newer("2.0.18-plus-1.0.0", "0.0.0-plus-r5.3")).toBe(true)
    expect(PlusUpdate.newer("0.0.0-plus-r5.4", "2.0.18-plus-1.0.0")).toBe(false)
    expect(PlusUpdate.describe("2.0.20-plus-1.1.0")).toBe("OpenCodePlus 1.1.0 (opencode 2.0.20)")
    expect(PlusUpdate.decodeTestReleases('{ "update_test_releases": true, }')).toBe(true)
    expect(PlusUpdate.decodeTestReleases('{ "update": "notify" }')).toBeUndefined()
  })
})
