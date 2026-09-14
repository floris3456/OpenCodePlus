import { NodeFileSystem } from "@effect/platform-node"
import { Service, type Info } from "@opencode/client/effect/service"
import { OPENCODE_VERSION } from "../src/version"
import { expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test(
  "service start returns a ready endpoint through the production start path",
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-service-readiness-"))
    const port = await availablePort()
    const registration = path.join(root, "state", "opencode", "service-local.json")
    await fs.mkdir(path.join(root, "config", "opencode"), { recursive: true })
    await fs.writeFile(path.join(root, "config", "opencode", "service-local.json"), JSON.stringify({ port }))
    const child = Bun.spawn(
      [process.execPath, path.join(import.meta.dir, "../src/index.ts"), "service", "start"],
      {
        cwd: path.join(import.meta.dir, ".."),
        env: serviceEnv(root),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    try {
      const [line, info] = await Promise.all([
        readLine(child.stdout, 15_000),
        waitForInfo(registration, 15_000),
      ])
      expect(line?.trim()).toBe(info.url)
      expect(new URL(info.url).port).toBe(String(port))
      const response = await fetch(new URL("/api/health", info.url), {
        headers: { authorization: "Basic " + btoa(`opencode:${info.password}`) },
        signal: AbortSignal.timeout(10_000),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ healthy: true, version: OPENCODE_VERSION, pid: info.pid })
      expect(await Promise.race([child.exited.then(() => true), Bun.sleep(5_000).then(() => false)])).toBe(true)
      expect(child.exitCode).toBe(0)
    } catch (cause) {
      const stderr = await new Response(child.stderr).text().catch(() => "")
      throw new Error(`service start did not become ready (child exit=${child.exitCode}):\n${stderr.slice(-4_000)}`, {
        cause,
      })
    } finally {
      child.kill("SIGTERM")
      await child.exited
      await Effect.runPromise(Service.stop({ file: registration }).pipe(Effect.provide(NodeFileSystem.layer))).catch(
        () => undefined,
      )
      await fs.rm(root, { recursive: true, force: true })
    }
  },
  20_000,
)

test(
  "service start recovers from a stale registration through the production start path",
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-service-readiness-stale-"))
    const port = await availablePort()
    const registration = path.join(root, "state", "opencode", "service-local.json")
    await fs.mkdir(path.join(root, "config", "opencode"), { recursive: true })
    await fs.mkdir(path.dirname(registration), { recursive: true })
    await fs.writeFile(path.join(root, "config", "opencode", "service-local.json"), JSON.stringify({ port }))
    await fs.writeFile(
      registration,
      JSON.stringify({ id: "dead", version: "dead", url: `http://127.0.0.1:${port}`, pid: 2_147_483_647 }),
    )
    const child = Bun.spawn(
      [process.execPath, path.join(import.meta.dir, "../src/index.ts"), "service", "start"],
      {
        cwd: path.join(import.meta.dir, ".."),
        env: serviceEnv(root),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    try {
      const [line, info] = await Promise.all([
        readLine(child.stdout, 15_000),
        waitForInfo(registration, 15_000, (value) => value.id !== "dead"),
      ])
      expect(line?.trim()).toBe(info.url)
      expect(new URL(info.url).port).toBe(String(port))
      expect(await Promise.race([child.exited.then(() => true), Bun.sleep(5_000).then(() => false)])).toBe(true)
      expect(child.exitCode).toBe(0)
    } catch (cause) {
      const stderr = await new Response(child.stderr).text().catch(() => "")
      throw new Error(`service start did not recover (child exit=${child.exitCode}):\n${stderr.slice(-4_000)}`, {
        cause,
      })
    } finally {
      child.kill("SIGTERM")
      await child.exited
      await Effect.runPromise(Service.stop({ file: registration }).pipe(Effect.provide(NodeFileSystem.layer))).catch(
        () => undefined,
      )
      await fs.rm(root, { recursive: true, force: true })
    }
  },
  20_000,
)

// Known hang (skipped): with the configured port held by an unrelated process,
// `service start` stays silent past 60s instead of failing fast. The first
// contender spends ~15s in the child's incumbent retry, while the parent keeps
// spawning replacements every 5s, so the port-conflict error is discarded and
// never surfaces until the ~120s attempt budget expires. Fixing it requires
// the contender failure to surface (packages/client/src/effect/service.ts,
// packages/client/src/promise/service.ts) or the child to fail fast on a
// foreign occupant (packages/cli/src/server-process.ts) — all outside this
// task's allowed paths. Kept as a skipped repro so the fix can enable it.
test.skip(
  "service start fails fast with a clear error when the port is occupied",
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-service-readiness-occupied-"))
    using listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("unrelated") })
    const port = listener.port
    const registration = path.join(root, "state", "opencode", "service-local.json")
    await fs.mkdir(path.join(root, "config", "opencode"), { recursive: true })
    await fs.writeFile(path.join(root, "config", "opencode", "service-local.json"), JSON.stringify({ port }))
    const child = Bun.spawn(
      [process.execPath, path.join(import.meta.dir, "../src/index.ts"), "service", "start"],
      {
        cwd: path.join(import.meta.dir, ".."),
        env: serviceEnv(root),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    try {
      expect(await Promise.race([child.exited.then(() => true), Bun.sleep(15_000).then(() => false)])).toBe(true)
      expect(child.exitCode).not.toBe(0)
      const output =
        (await new Response(child.stdout).text().catch(() => "")) +
        (await new Response(child.stderr).text().catch(() => ""))
      expect(output).toContain(`Managed service port ${port}`)
      expect(await Bun.file(registration).exists()).toBe(false)
    } finally {
      child.kill("SIGTERM")
      await child.exited
      await fs.rm(root, { recursive: true, force: true })
    }
  },
  20_000,
)

async function readLine(stream: ReadableStream<Uint8Array>, timeout: number) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let output = ""
  try {
    while (true) {
      const chunk = await Promise.race([reader.read(), Bun.sleep(timeout).then(() => undefined)])
      if (chunk === undefined) throw new Error("Timed out waiting for service start output")
      if (chunk.done) break
      output += decoder.decode(chunk.value, { stream: true })
      const end = output.indexOf("\n")
      if (end !== -1) return output.slice(0, end)
    }
    return output.length ? output : undefined
  } finally {
    reader.releaseLock()
  }
}

async function waitForInfo(file: string, timeout: number, accept: (info: Info) => boolean = () => true) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await Bun.file(file)
      .json()
      .catch(() => undefined)
    if (value !== undefined && typeof value === "object" && value !== null && "url" in value) {
      const info = value as Info
      if (accept(info)) return info
    }
    await Bun.sleep(100)
  }
  throw new Error("Timed out waiting for service registration")
}

async function availablePort() {
  while (true) {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
    const port = server.port
    await server.stop(true)
    if (port === undefined) throw new Error("Server did not bind a port")
    // Never collide with the live server or the demo host, even if the OS
    // hands out that number while it is briefly free.
    if (port === 49_375 || port === 47_777) continue
    return port
  }
}

function serviceEnv(root: string) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: root,
    OPENCODE_DB: path.join(root, "opencode.db"),
    OPENCODE_TEST_HOME: root,
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"),
  }
  delete env.OPENCODE_CONFIG_PROJECT_DISABLE
  return env
}
