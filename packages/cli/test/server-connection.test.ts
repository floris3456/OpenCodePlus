import { NodeFileSystem } from "@effect/platform-node"
import { Global } from "@opencode/util/global"
import { OPENCODE_VERSION } from "../src/version"
import { expect, test } from "bun:test"
import { Effect, FileSystem, Scope } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ServerConnection } from "../src/services/server-connection"
import { ServiceConfig } from "../src/services/service-config"

test("resolution groups Effect-native lifecycle operations only for the managed service", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-server-resolution-"))
  const id = "server-resolution-test"
  const server = Bun.serve({
    port: 0,
    fetch() {
      return Response.json({
        version: OPENCODE_VERSION,
        pid: process.pid,
        urls: [],
      })
    },
  })
  const registration = path.join(root, "state", ServiceConfig.filename())
  const layer = Global.layerWith({ config: path.join(root, "config"), state: path.join(root, "state") })
  const runPromise = <A, E>(effect: Effect.Effect<A, E, Global.Service | FileSystem.FileSystem | Scope.Scope>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.provide(NodeFileSystem.layer), Effect.scoped))

  try {
    await fs.mkdir(path.dirname(registration), { recursive: true })
    await fs.writeFile(
      registration,
      JSON.stringify({
        id,
        version: OPENCODE_VERSION,
        url: server.url.toString(),
        pid: process.pid,
      }),
    )
    const resolved = await runPromise(ServerConnection.resolve())

    expect(resolved.endpoint.url).toBe(server.url.toString())
    expect(resolved.service).toBeDefined()
    if (!resolved.service) throw new Error("Expected managed service capabilities")
    expect(Effect.isEffect(resolved.service.reconnect())).toBe(true)
    expect(Effect.isEffect(resolved.service.restart())).toBe(true)
    expect(await runPromise(resolved.service.reconnect())).toEqual(resolved.endpoint)

    const explicit = await runPromise(ServerConnection.resolve({ server: server.url.toString() }))
    expect(explicit.endpoint.url).toBe(server.url.toString())
    expect(explicit.service).toBeUndefined()
  } finally {
    await server.stop(true)
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("mismatched Plus service warns once and keeps the incumbent for other commands", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-service-warn-"))
  const previous = process.env.OPENCODE_PRODUCT
  const holder = Bun.spawn(["sleep", "300"], { stdout: "ignore", stderr: "ignore" })
  const running = "2.0.18-plus-1.1.12"
  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/api/info")
        return Response.json({ version: running, pid: holder.pid, urls: [server.url.toString()] })
      return new Response(null, { status: 404 })
    },
  })
  const layer = Global.layerWith({ config: path.join(root, "config"), state: path.join(root, "state") })
  const runPromise = <A, E>(effect: Effect.Effect<A, E, Global.Service | FileSystem.FileSystem | Scope.Scope>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.provide(NodeFileSystem.layer), Effect.scoped))
  const lines: string[] = []
  const write = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: unknown) => {
    lines.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  try {
    process.env.OPENCODE_PRODUCT = "opencodeplus"
    await fs.mkdir(path.join(root, "state"), { recursive: true })
    await fs.writeFile(
      path.join(root, "state", ServiceConfig.filename()),
      JSON.stringify({ id: "warn-test", version: running, url: server.url.toString(), pid: holder.pid }),
    )
    const resolved = await runPromise(ServerConnection.resolve({}))
    expect(resolved.endpoint.url).toBe(server.url.toString())
    expect(lines).toEqual([
      `Warning: Background service has version ${running}; this client is ${OPENCODE_VERSION}. Continuing anyway.\n`,
    ])
  } finally {
    process.stderr.write = write
    if (previous === undefined) delete process.env.OPENCODE_PRODUCT
    else process.env.OPENCODE_PRODUCT = previous
    try {
      holder.kill("SIGTERM")
      await holder.exited
    } catch {}
    await server.stop(true)
    await fs.rm(root, { recursive: true, force: true })
  }
})
test("service options only require a matching version when requested", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-service-options-"))
  const layer = Global.layerWith({ config: path.join(root, "config"), state: path.join(root, "state") })
  const runPromise = <A, E>(effect: Effect.Effect<A, E, Global.Service | FileSystem.FileSystem | Scope.Scope>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.provide(NodeFileSystem.layer), Effect.scoped))

  try {
    expect((await runPromise(ServiceConfig.options())).version).toBeUndefined()
    expect((await runPromise(ServiceConfig.options({ checkVersion: true }))).version).toBe(OPENCODE_VERSION)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
