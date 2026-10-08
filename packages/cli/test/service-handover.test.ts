import { NodeFileSystem } from "@effect/platform-node"
import { expect, test } from "bun:test"
import { Effect, FileSystem } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { OPENCODE_VERSION } from "../src/version"
import { ServiceHandover } from "../src/services/service-handover"

const OLD_VERSION = "2.0.18-plus-1.1.12"
const stub = path.join(import.meta.dir, "fixture/service-handover-stub.ts")

type OldService = {
  readonly url: string
  readonly registration: string
  readonly holder: Bun.Subprocess
  readonly server: ReturnType<typeof Bun.serve>
  readonly active: (sessions: Record<string, unknown>) => void
}

/** A fake old-version service: in-test HTTP answers, a disposable pid in the registration. */
async function oldService(root: string, sessions: Record<string, unknown>, version = OLD_VERSION) {
  let active = sessions
  const holder = Bun.spawn(["sleep", "300"], { stdout: "ignore", stderr: "ignore" })
  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname
      if (pathname === "/api/info")
        return Response.json({
          version,
          pid: holder.pid,
          urls: [server.url.toString()],
          paths: { tmp: "/tmp/opencode" },
        })
      if (pathname === "/api/session/active") return Response.json({ data: active })
      return new Response(null, { status: 404 })
    },
  })
  const registration = path.join(root, "service.json")
  await fs.writeFile(
    registration,
    JSON.stringify({ id: "handover-old", version, url: server.url.toString(), pid: holder.pid }),
  )
  return {
    url: server.url.toString(),
    registration,
    holder,
    server,
    active: (sessions: Record<string, unknown>) => {
      active = sessions
    },
  } satisfies OldService
}

function optionsFor(registration: string) {
  return {
    file: registration,
    version: OPENCODE_VERSION,
    command: [process.execPath, stub, registration, OPENCODE_VERSION],
    directory: path.dirname(registration),
  }
}

function run<A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) {
  return Effect.runPromise(effect.pipe(Effect.provide(NodeFileSystem.layer)))
}

async function cleanup(root: string, services: Array<{ holder?: Bun.Subprocess; server?: { stop: (close: boolean) => void } }>) {
  for (const service of services) {
    try {
      service.holder?.kill("SIGTERM")
      await service.holder?.exited
    } catch {}
    service.server?.stop(true)
  }
  // Replacement stubs re-register; stop whatever owns the file now.
  const registration = path.join(root, "service.json")
  const info = await Bun.file(registration)
    .json()
    .catch(() => undefined)
  if (info !== undefined && typeof info.pid === "number" && info.pid !== process.pid) {
    try {
      process.kill(info.pid, "SIGTERM")
    } catch {}
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        process.kill(info.pid, 0)
      } catch {
        break
      }
      await Bun.sleep(5)
    }
  }
  await fs.rm(root, { recursive: true, force: true })
}

function holderAlive(holder: Bun.Subprocess) {
  try {
    process.kill(holder.pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitDead(holder: Bun.Subprocess) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (!holderAlive(holder)) return
    await Bun.sleep(25)
  }
  throw new Error(`holder ${holder.pid} is still running`)
}

test("decide replaces idle, asks when busy with a terminal, and refuses busy without one", () => {
  expect(ServiceHandover.decide({ active: 0, tty: false })).toBe("replace")
  expect(ServiceHandover.decide({ active: 0, tty: true })).toBe("replace")
  expect(ServiceHandover.decide({ active: 2, tty: true })).toBe("ask")
  expect(ServiceHandover.decide({ active: 1, tty: false })).toBe("busy-without-terminal")
})

test("idle service is replaced with a one-line notice", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "handover-idle-"))
  const old = await oldService(root, {})
  const notices: string[] = []
  try {
    const endpoint = await run(
      ServiceHandover.resolveTui(optionsFor(old.registration), {
        ask: () => Effect.succeed("existing" as const),
        tty: false,
        notice: (message) => notices.push(message),
      }),
    )
    expect(notices).toEqual([`Replaced the service ${OLD_VERSION} with ${OPENCODE_VERSION} (no chats were running).`])
    expect(endpoint.url).not.toBe(old.url)
    expect(await Bun.file(old.registration).json()).toMatchObject({ version: OPENCODE_VERSION })
    await waitDead(old.holder)
  } finally {
    await cleanup(root, [old])
  }
})

test("busy service answered replace is replaced with a notice naming the chats", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "handover-replace-"))
  const old = await oldService(root, { a: { type: "running" }, b: { type: "running" } })
  const notices: string[] = []
  let asked = 0
  try {
    const endpoint = await run(
      ServiceHandover.resolveTui(optionsFor(old.registration), {
        ask: (info) => {
          asked += 1
          expect(info).toEqual({ version: OLD_VERSION, active: 2 })
          return Effect.succeed("replace" as const)
        },
        tty: true,
        notice: (message) => notices.push(message),
      }),
    )
    expect(asked).toBe(1)
    expect(notices).toEqual([
      `Replaced the service ${OLD_VERSION} with ${OPENCODE_VERSION} (2 chats pause and resume after the restart).`,
    ])
    expect(endpoint.url).not.toBe(old.url)
    await waitDead(old.holder)
  } finally {
    await cleanup(root, [old])
  }
})

test("busy service answered use-old connects with a warning and keeps the incumbent", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "handover-existing-"))
  const old = await oldService(root, { a: { type: "running" } })
  const notices: string[] = []
  try {
    const endpoint = await run(
      ServiceHandover.resolveTui(optionsFor(old.registration), {
        ask: () => Effect.succeed("existing" as const),
        tty: true,
        notice: (message) => notices.push(message),
      }),
    )
    expect(endpoint.url).toBe(old.url)
    expect(notices).toEqual([
      `Warning: Background service has version ${OLD_VERSION}; this client is ${OPENCODE_VERSION}. Continuing anyway.`,
    ])
    expect(await Bun.file(old.registration).json()).toMatchObject({ version: OLD_VERSION })
    expect(holderAlive(old.holder)).toBe(true)
  } finally {
    await cleanup(root, [old])
  }
})

test("busy service answered quit fails so the caller exits 0", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "handover-quit-"))
  const old = await oldService(root, { a: { type: "running" } })
  const notices: string[] = []
  try {
    const failure = await run(
      ServiceHandover.resolveTui(optionsFor(old.registration), {
        ask: () => Effect.succeed("quit" as const),
        tty: true,
        notice: (message) => notices.push(message),
      }),
    ).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ServiceHandover.HandoverQuit)
    expect(notices).toEqual([])
    expect(holderAlive(old.holder)).toBe(true)
  } finally {
    await cleanup(root, [old])
  }
})

test("busy service without a terminal is never replaced", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "handover-notty-"))
  const old = await oldService(root, { a: { type: "running" } })
  let asked = 0
  try {
    const failure = await run(
      ServiceHandover.resolveTui(optionsFor(old.registration), {
        ask: () => {
          asked += 1
          return Effect.succeed("replace" as const)
        },
        tty: false,
      }),
    ).catch((error: unknown) => error)
    expect(asked).toBe(0)
    expect(String(failure)).toContain(OLD_VERSION)
    expect(String(failure)).toContain("without a terminal")
    expect(holderAlive(old.holder)).toBe(true)
  } finally {
    await cleanup(root, [old])
  }
})

test("no service starts a new one without asking or noticing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "handover-start-"))
  const registration = path.join(root, "service.json")
  const notices: string[] = []
  let asked = 0
  try {
    const endpoint = await run(
      ServiceHandover.resolveTui(optionsFor(registration), {
        ask: () => {
          asked += 1
          return Effect.succeed("quit" as const)
        },
        tty: true,
        notice: (message) => notices.push(message),
      }),
    )
    expect(asked).toBe(0)
    expect(notices).toEqual([])
    expect(endpoint.url).toBe((await Bun.file(registration).json()).url)
  } finally {
    await cleanup(root, [])
  }
})

test("matching service resolves without asking or replacing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "handover-matching-"))
  const old = await oldService(root, {}, OPENCODE_VERSION)
  const notices: string[] = []
  let asked = 0
  try {
    const endpoint = await run(
      ServiceHandover.resolveTui(optionsFor(old.registration), {
        ask: () => {
          asked += 1
          return Effect.succeed("quit" as const)
        },
        tty: true,
        notice: (message) => notices.push(message),
      }),
    )
    expect(endpoint.url).toBe(old.url)
    expect(asked).toBe(0)
    expect(notices).toEqual([])
    expect(holderAlive(old.holder)).toBe(true)
  } finally {
    await cleanup(root, [old])
  }
})
