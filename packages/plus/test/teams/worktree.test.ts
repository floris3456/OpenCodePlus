import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { create, list, orphans, remove, slug, stamp } from "../../src/teams/worktree.js"
import { git } from "../../src/teams/git.js"

let scratch = ""
let stateDir = ""
let repoRoot = ""
let wsRoot = ""
let base = ""

async function exists(p: string): Promise<boolean> {
  return Bun.file(p).exists().then((hit) => {
    if (hit) return true
    return stat(p)
      .then(() => true)
      .catch(() => false)
  })
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "teams-wt-"))
  stateDir = join(scratch, "state")
  repoRoot = join(scratch, "repo")
  wsRoot = join(scratch, "ws")
  await mkdir(repoRoot, { recursive: true })
  await git(repoRoot, ["init", "-b", "main"])
  await git(repoRoot, ["config", "user.email", "teams@test.local"])
  await git(repoRoot, ["config", "user.name", "teams"])
  await writeFile(join(repoRoot, "README.md"), "fixture\n")
  await git(repoRoot, ["add", "README.md"])
  await git(repoRoot, ["commit", "-m", "chore: fixture commit"])
  base = await git(repoRoot, ["rev-parse", "HEAD"])
})

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe("slug and stamp", () => {
  test("slug is lowercase alphanumerics, hint plus run hex", () => {
    expect(slug("T1-probe task!", "w-3f2a9c11")).toBe("t1prob3f2a")
    expect(slug("!!!", "w-abcdef12")).toBe("runabcd")
    expect(slug("probe", "w-1111aaaa")).toBe("probe1111")
    expect(slug("averylonghint", "w-00000000")).toHaveLength(10)
    for (const s of [slug("T1-probe task!", "w-3f2a9c11"), slug("!!!", "xyz"), slug("a", "w-1")])
      expect(s).toMatch(/^[a-z0-9]{3,10}$/)
  })

  test("stamp is YYYYMMDD-HHMM in local time", () => {
    expect(stamp(new Date(2026, 8, 17, 15, 12))).toBe("20260917-1512")
    expect(stamp()).toMatch(/^[0-9]{8}-[0-9]{4}$/)
  })
})

describe("worktree manager", () => {
  test("create / list / orphans / remove round trip", async () => {
    const name = slug("probe", "w-1111aaaa2222bbbb")
    const before = await list(repoRoot)
    const c = await create(stateDir, {
      repoRoot,
      repoKey: "opencode",
      role: "implementer",
      name,
      base,
      workspaceRoot: wsRoot,
    })
    expect(c.dir).toMatch(/worktrees\/opencode\/implementer\/[a-z0-9]{3,10}-[0-9]{8}-[0-9]{4}$/)
    const suffix = basename(c.dir)
    expect(c.branch).toBe(`team/implementer/${suffix}`)
    expect(c.head).toBe(base)
    expect(await git(repoRoot, ["rev-parse", `${c.branch}^{commit}`])).toBe(base)
    const after = await list(repoRoot)
    expect(after.length).toBe(before.length + 1)
    expect(after.map((e) => e.path)).toContain(c.dir)
    expect(await orphans(repoRoot, [])).toContain(c.dir)
    expect(await orphans(repoRoot, [c.dir])).not.toContain(c.dir)
    await remove(stateDir, c.dir, { repoRoot, repoKey: "opencode" })
    expect(await exists(c.dir)).toBe(false)
    const gone = await list(repoRoot)
    expect(gone.length).toBe(before.length)
    expect(gone.map((e) => e.path)).not.toContain(c.dir)
  })

  test("create with an unknown base throws E_BASE", async () => {
    const err = await create(
      stateDir,
      {
        repoRoot,
        repoKey: "opencode",
        role: "implementer",
        name: slug("badbase", "w-dddd0004"),
        base: "no-such-branch",
        workspaceRoot: wsRoot,
      },
    ).then(
      () => null,
      (e) => e as { code?: string; accepted?: string },
    )
    expect(err?.code).toBe("E_BASE")
    expect(err?.accepted).toBe("ocp-main")
  })

  test("create refuses when the directory already exists", async () => {
    const nm = slug("clash", "w-cccc0003")
    const dir = join(wsRoot, "worktrees", "opencode", "implementer", `${nm}-${stamp()}`)
    await mkdir(dir, { recursive: true })
    try {
      const err = await create(
        stateDir,
        { repoRoot, repoKey: "opencode", role: "implementer", name: nm, base, workspaceRoot: wsRoot },
      ).then(
        () => null,
        (e) => e as { code?: string },
      )
      expect(err?.code).toBe("E_WT_EXISTS")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("remove of a missing directory succeeds silently", async () => {
    await remove(stateDir, join(wsRoot, "does-not-exist"), { repoRoot, repoKey: "opencode" })
  })

  test("concurrent creates under the repository lock both succeed", async () => {
    const [a, b] = await Promise.all([
      create(stateDir, {
        repoRoot,
        repoKey: "opencode",
        role: "implementer",
        name: slug("alpha", "w-aaaa0001"),
        base,
        workspaceRoot: wsRoot,
      }),
      create(stateDir, {
        repoRoot,
        repoKey: "opencode",
        role: "implementer",
        name: slug("beta", "w-bbbb0002"),
        base,
        workspaceRoot: wsRoot,
      }),
    ])
    expect(a.dir).not.toBe(b.dir)
    await remove(stateDir, a.dir, { repoRoot, repoKey: "opencode" })
    await remove(stateDir, b.dir, { repoRoot, repoKey: "opencode" })
  })
})
