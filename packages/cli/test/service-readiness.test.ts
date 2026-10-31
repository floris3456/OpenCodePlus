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
    const home = await serviceHome("opencode-service-readiness-")
    const root = home.root
    const port = await availablePort()
    const registration = path.join(root, "state", "opencode", "service-local.json")
    await fs.mkdir(path.join(root, "config", "opencode"), { recursive: true })
    await fs.writeFile(path.join(root, "config", "opencode", "service-local.json"), JSON.stringify({ port }))
    const child = Bun.spawn(
      [process.execPath, home.entry, "service", "start"],
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
      const response = await fetch(new URL("/api/info", info.url), {
        headers: { authorization: "Basic " + btoa(`opencode:${info.password}`) },
        signal: AbortSignal.timeout(10_000),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ version: OPENCODE_VERSION, pid: info.pid })
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
      await removeHome(home)
    }
  },
  20_000,
)

test(
  "service start recovers from a stale registration through the production start path",
  async () => {
    const home = await serviceHome("opencode-service-readiness-stale-")
    const root = home.root
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
      [process.execPath, home.entry, "service", "start"],
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
      await removeHome(home)
    }
  },
  20_000,
)

test(
  "service start fails fast with a clear error when the port is occupied",
  async () => {
    const home = await serviceHome("opencode-service-readiness-occupied-")
    const root = home.root
    using listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("unrelated") })
    const port = listener.port
    const registration = path.join(root, "state", "opencode", "service-local.json")
    await fs.mkdir(path.join(root, "config", "opencode"), { recursive: true })
    await fs.writeFile(path.join(root, "config", "opencode", "service-local.json"), JSON.stringify({ port }))
    const child = Bun.spawn(
      [process.execPath, home.entry, "service", "start"],
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
      await removeHome(home)
    }
  },
  20_000,
)

// `service start` and every server it spawns run this home's entry, so their command lines name
// it. Under load `service start` spawns a second contender while the first is slow to register;
// that one retries the port for 15 s and takes it once the test stops the registered server, which
// `Service.stop` cannot see. Removing the home stops every process started through its entry.
async function serviceHome(prefix: string) {
  // Bun resolves symlinks in the entry path, so process command lines carry the real directory.
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)))
  const entry = path.join(root, "opencode.ts")
  await fs.writeFile(entry, `import ${JSON.stringify(path.join(import.meta.dir, "../src/index.ts"))}\n`)
  return { root, entry }
}

async function removeHome(home: { readonly root: string; readonly entry: string }) {
  const pids = (await Bun.$`pgrep -f ${home.entry}`.nothrow().quiet().text()).split("\n").filter(Boolean).map(Number)
  pids.forEach((pid) => signal(pid, "SIGKILL"))
  await Promise.all(pids.map(exited))
  await fs.rm(home.root, { recursive: true, force: true })
}

async function exited(pid: number) {
  const deadline = Date.now() + 10_000
  while (signal(pid, 0)) {
    if (Date.now() >= deadline) throw new Error(`Process ${pid} did not exit`)
    await Bun.sleep(25)
  }
}

function signal(pid: number, value: NodeJS.Signals | 0) {
  try {
    process.kill(pid, value)
    return true
  } catch {
    return false
  }
}

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
