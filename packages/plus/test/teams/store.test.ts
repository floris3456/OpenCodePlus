import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { atomicJson, lock, readJson, sanitizeLockKey, stateRoot, ulid } from "../../src/teams/store.js"
import { teamsDataDir } from "../../src/instructions/paths.js"

let dir = ""

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "teams-store-"))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function caught(fn: () => unknown): Promise<unknown> {
  return Promise.resolve().then(fn).then(
    () => undefined,
    (error: unknown) => error,
  )
}

describe("ulid", () => {
  test("1000 calls are strictly increasing, 26 chars, Crockford", () => {
    const ids: string[] = []
    for (let i = 0; i < 1000; i++) ids.push(ulid())
    for (const id of ids) {
      expect(id.length).toBe(26)
      expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    }
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i] > ids[i - 1]).toBe(true)
    }
  })
})

describe("atomicJson/readJson", () => {
  test("round-trips, leaves no .tmp behind, and lands mode 0600", async () => {
    const target = join(dir, "sub", "dir", "data.json")
    const value = { a: 1, b: [1, 2, 3], c: { d: "x" } }
    await atomicJson(target, value)
    const back = await readJson<typeof value>(target)
    expect(back).toEqual(value)
    const entries = await readdir(join(dir, "sub", "dir"))
    expect(entries).toEqual(["data.json"])
    expect(entries.some((e) => e.endsWith(".tmp"))).toBe(false)
    expect((await stat(target)).mode & 0o777).toBe(0o600)
  })

  test("readJson returns undefined on ENOENT", async () => {
    expect(await readJson(join(dir, "missing.json"))).toBeUndefined()
  })
})

describe("lock", () => {
  test("two concurrent acquires serialize", async () => {
    const intervals: Array<{ enter: number; exit: number }> = []
    const run = (): Promise<void> =>
      lock(dir, "wt", "serial-key", async () => {
        const enter = Date.now()
        await sleep(100)
        const exit = Date.now()
        intervals.push({ enter, exit })
      })
    await Promise.all([run(), run()])
    expect(intervals.length).toBe(2)
    const [a, b] = [...intervals].sort((x, y) => x.enter - y.enter)
    expect(a.exit <= b.enter).toBe(true)
  })

  test("lock with dead pid is broken and callback fires", async () => {
    const key = "my-repo"
    const lockDir = join(dir, "locks", "repo")
    await mkdir(lockDir, { recursive: true })
    await writeFile(
      join(lockDir, `${key}.lock`),
      JSON.stringify({ pid: 99999999, at: new Date().toISOString(), op: "stale" }),
    )
    let broke = false
    const out = await lock(dir, "repo", key, async () => "ok", {
      onBreak: () => {
        broke = true
      },
    })
    expect(out).toBe("ok")
    expect(broke).toBe(true)
  })

  test("lock timeout throws E_LOCKED with numeric retryAfterMs", async () => {
    const holder = lock(dir, "wt", "contended", async () => {
      await sleep(1000)
      return "held"
    })
    await sleep(50)
    const error = await caught(() => lock(dir, "wt", "contended", async () => "never", { timeoutMs: 200 }))
    expect(error).toBeDefined()
    expect((error as { code?: unknown }).code).toBe("E_LOCKED")
    expect(typeof (error as { retryAfterMs?: unknown }).retryAfterMs).toBe("number")
    await holder
  })

  test("sanitizeLockKey matches the reference mapping", () => {
    expect(sanitizeLockKey("a/b:c")).toBe("a_b_c")
    expect(sanitizeLockKey("")).toBe("_")
  })
})

describe("stateRoot", () => {
  test("resolves to teamsDataDir for the top-level caller", () => {
    expect(stateRoot()).toBe(teamsDataDir())
  })
})
