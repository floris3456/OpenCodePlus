import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, isAbsolute, join } from "node:path"
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
      projectDirectory: repoRoot,
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
        projectDirectory: repoRoot,
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
        { repoRoot, repoKey: "opencode", role: "implementer", name: nm, base, workspaceRoot: wsRoot, projectDirectory: repoRoot },
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
        projectDirectory: repoRoot,
      }),
      create(stateDir, {
        repoRoot,
        repoKey: "opencode",
        role: "implementer",
        name: slug("beta", "w-bbbb0002"),
        base,
        workspaceRoot: wsRoot,
        projectDirectory: repoRoot,
      }),
    ])
    expect(a.dir).not.toBe(b.dir)
    await remove(stateDir, a.dir, { repoRoot, repoKey: "opencode" })
    await remove(stateDir, b.dir, { repoRoot, repoKey: "opencode" })
  })
})

describe("worktree plus project", () => {
  test("create inherits protectedAgents and keeps git status clean", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "teams-wt-proj-"))
    try {
      const repo = join(tmp, "repo")
      const ws = join(tmp, "ws")
      const st = join(tmp, "state")
      await mkdir(repo, { recursive: true })
      await git(repo, ["init", "-b", "main"])
      await git(repo, ["config", "user.email", "teams@test.local"])
      await git(repo, ["config", "user.name", "teams"])
      await writeFile(join(repo, "README.md"), "fixture\n")
      await git(repo, ["add", "README.md"])
      await git(repo, ["commit", "-m", "chore: fixture commit"])
      const head = await git(repo, ["rev-parse", "HEAD"])
      const protectedAgents = ["muse-implementer", "scout"]
      await mkdir(join(repo, ".opencodeplus"), { recursive: true })
      await writeFile(join(repo, ".opencodeplus", "project.json"), `${JSON.stringify({ version: 1, protectedAgents }, null, 2)}\n`)
      const c = await create(st, {
        repoRoot: repo,
        repoKey: "opencode",
        role: "implementer",
        name: slug("inherit", "w-aaaa1111"),
        base: head,
        workspaceRoot: ws,
        projectDirectory: repo,
      })
      const raw = await Bun.file(join(c.dir, ".opencodeplus", "project.json")).text()
      const parsed = JSON.parse(raw) as { version: number; protectedAgents: string[] }
      expect(parsed).toEqual({ version: 1, protectedAgents })
      expect(await git(c.dir, ["status", "--porcelain"])).toBe("")
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  test("create with no parent config writes the default and keeps git status clean", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "teams-wt-def-"))
    try {
      const repo = join(tmp, "repo")
      const ws = join(tmp, "ws")
      const st = join(tmp, "state")
      await mkdir(repo, { recursive: true })
      await git(repo, ["init", "-b", "main"])
      await git(repo, ["config", "user.email", "teams@test.local"])
      await git(repo, ["config", "user.name", "teams"])
      await writeFile(join(repo, "README.md"), "fixture\n")
      await git(repo, ["add", "README.md"])
      await git(repo, ["commit", "-m", "chore: fixture commit"])
      const head = await git(repo, ["rev-parse", "HEAD"])
      const c = await create(st, {
        repoRoot: repo,
        repoKey: "opencode",
        role: "implementer",
        name: slug("default", "w-bbbb2222"),
        base: head,
        workspaceRoot: ws,
        projectDirectory: repo,
      })
      const raw = await Bun.file(join(c.dir, ".opencodeplus", "project.json")).text()
      expect(JSON.parse(raw)).toEqual({ version: 1, protectedAgents: [] })
      expect(await git(c.dir, ["status", "--porcelain"])).toBe("")
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  test("create leaves a tracked project.json unmodified and keeps the tree clean", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "teams-wt-track-"))
    try {
      const repo = join(tmp, "repo")
      const ws = join(tmp, "ws")
      const st = join(tmp, "state")
      await mkdir(repo, { recursive: true })
      await git(repo, ["init", "-b", "main"])
      await git(repo, ["config", "user.email", "teams@test.local"])
      await git(repo, ["config", "user.name", "teams"])
      await writeFile(join(repo, "README.md"), "fixture\n")
      await mkdir(join(repo, ".opencodeplus"), { recursive: true })
      await writeFile(join(repo, ".opencodeplus", "project.json"), `${JSON.stringify({ version: 1, protectedAgents: ["orig-agent"] }, null, 2)}\n`)
      await git(repo, ["add", "README.md", ".opencodeplus/project.json"])
      await git(repo, ["commit", "-m", "chore: track project config"])
      const head = await git(repo, ["rev-parse", "HEAD"])
      await writeFile(join(repo, ".opencodeplus", "project.json"), `${JSON.stringify({ version: 1, protectedAgents: ["modified-agent"] }, null, 2)}\n`)
      const c = await create(st, {
        repoRoot: repo,
        repoKey: "opencode",
        role: "implementer",
        name: slug("tracked", "w-cccc3333"),
        base: head,
        workspaceRoot: ws,
        projectDirectory: repo,
      })
      const raw = await Bun.file(join(c.dir, ".opencodeplus", "project.json")).text()
      expect(JSON.parse(raw)).toEqual({ version: 1, protectedAgents: ["orig-agent"] })
      expect(await git(c.dir, ["status", "--porcelain"])).toBe("")
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  test("per-worktree exclude line is written once across two worktrees", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "teams-wt-excl-"))
    try {
      const repo = join(tmp, "repo")
      const ws = join(tmp, "ws")
      const st = join(tmp, "state")
      await mkdir(repo, { recursive: true })
      await git(repo, ["init", "-b", "main"])
      await git(repo, ["config", "user.email", "teams@test.local"])
      await git(repo, ["config", "user.name", "teams"])
      await writeFile(join(repo, "README.md"), "fixture\n")
      await git(repo, ["add", "README.md"])
      await git(repo, ["commit", "-m", "chore: fixture commit"])
      const head = await git(repo, ["rev-parse", "HEAD"])
      const a = await create(st, {
        repoRoot: repo,
        repoKey: "opencode",
        role: "implementer",
        name: slug("excla", "w-dddd4444"),
        base: head,
        workspaceRoot: ws,
        projectDirectory: repo,
      })
      const b = await create(st, {
        repoRoot: repo,
        repoKey: "opencode",
        role: "implementer",
        name: slug("exclb", "w-eeee5555"),
        base: head,
        workspaceRoot: ws,
        projectDirectory: repo,
      })
      const countIn = async (dir: string): Promise<number> => {
        const gitDirRaw = await git(dir, ["rev-parse", "--git-dir"])
        const gitDir = isAbsolute(gitDirRaw) ? gitDirRaw : join(dir, gitDirRaw)
        const text = await Bun.file(join(gitDir, "info", "exclude")).text()
        return text.split("\n").filter((line) => line === "/.opencodeplus/").length
      }
      expect(await countIn(a.dir)).toBe(1)
      expect(await countIn(b.dir)).toBe(1)
      const mainGitDirRaw = await git(repo, ["rev-parse", "--git-dir"])
      const mainGitDir = isAbsolute(mainGitDirRaw) ? mainGitDirRaw : join(repo, mainGitDirRaw)
      const mainExcludeExists = await Bun.file(join(mainGitDir, "info", "exclude")).exists()
      if (mainExcludeExists) {
        const mainText = await Bun.file(join(mainGitDir, "info", "exclude")).text()
        expect(mainText.split("\n").filter((line) => line === "/.opencodeplus/")).toEqual([])
      }
      const gitignoreExists = await Bun.file(join(repo, ".gitignore")).exists()
      if (gitignoreExists) {
        const ignored = await Bun.file(join(repo, ".gitignore")).text()
        expect(ignored).not.toContain(".opencodeplus")
      }
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })
})
