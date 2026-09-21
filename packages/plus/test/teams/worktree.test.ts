import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { create, list, orphans, ownedRoot, remove, slug, stamp } from "../../src/teams/worktree.js"
import { git, gitRaw } from "../../src/teams/git.js"

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
  // The first `delegate` in a brand-new data root hands the host a worktree
  // location: core resolves it with `FileSystem.realPath(location.directory)`,
  // which fails with NotFound when the path does not exist as given. `create`
  // must therefore return an absolute, canonical directory whose parents exist,
  // not the joined string it happened to compute.
  test("the first create in a brand-new root returns the real directory", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "teams-wt-fresh-"))
    try {
      const repo = join(tmp, "repo")
      await mkdir(repo, { recursive: true })
      await git(repo, ["init", "-b", "main"])
      await git(repo, ["config", "user.email", "teams@test.local"])
      await git(repo, ["config", "user.name", "teams"])
      await writeFile(join(repo, "README.md"), "fixture\n")
      await git(repo, ["add", "README.md"])
      await git(repo, ["commit", "-m", "chore: fixture commit"])
      const head = await git(repo, ["rev-parse", "HEAD"])
      // A data root reached through a symlink, as a system temp dir or a lab
      // home can be; nothing under it exists yet, not even worktrees/.
      const realData = join(tmp, "data")
      await mkdir(realData, { recursive: true })
      const linkedData = join(tmp, "link")
      await symlink(realData, linkedData)
      const ws = join(linkedData, "ws")
      const st = join(tmp, "state")
      const name = slug("first", "w-1a2b3c4d")
      const c = await create(st, {
        repoRoot: repo,
        repoKey: "opencode",
        role: "implementer",
        name,
        base: head,
        workspaceRoot: ws,
      })
      expect(await exists(c.dir)).toBe(true)
      // This is the first-delegate failure in one assertion: a directory the
      // caller cannot realpath is a directory the host cannot open a session in.
      expect(c.dir).toBe(await realpath(c.dir))
      expect(c.dir).toBe(join(await realpath(ws), "worktrees", "opencode", "implementer", basename(c.dir)))
      expect(await git(repo, ["rev-parse", `${c.branch}^{commit}`])).toBe(head)
      await remove(st, c.dir, { repoRoot: repo, repoKey: "opencode" })
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

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
    expect(await orphans(repoRoot, ownedRoot(wsRoot, "opencode"), [])).toContain(c.dir)
    expect(await orphans(repoRoot, ownedRoot(wsRoot, "opencode"), [c.dir])).not.toContain(c.dir)
    await remove(stateDir, c.dir, { repoRoot, repoKey: "opencode" })
    expect(await exists(c.dir)).toBe(false)
    const gone = await list(repoRoot)
    expect(gone.length).toBe(before.length)
    expect(gone.map((e) => e.path)).not.toContain(c.dir)
  })

  // GC force-removes every path orphans() reports, so a checkout of the same
  // repository that the team did not create must never be reported.
  test("orphans never reports a worktree outside the team's own root", async () => {
    const mine = await create(stateDir, {
      repoRoot,
      repoKey: "opencode",
      role: "implementer",
      name: slug("bounds", "w-eeee0005"),
      base,
      workspaceRoot: wsRoot,
    })
    const outside = join(scratch, "dev-checkout")
    await git(repoRoot, ["worktree", "add", "-b", "dev/own-work", outside, base])
    await writeFile(join(outside, "uncommitted.txt"), "work in progress\n")
    try {
      const found = await orphans(repoRoot, ownedRoot(wsRoot, "opencode"), [])
      // The unclaimed team worktree is still an orphan; the developer's is not.
      expect(found).toContain(mine.dir)
      expect(found).not.toContain(outside)
      expect(await exists(join(outside, "uncommitted.txt"))).toBe(true)
      // Nor does a team root that happens to be a path prefix of it.
      expect(await orphans(repoRoot, join(scratch, "dev"), [])).toEqual([])
    } finally {
      await git(repoRoot, ["worktree", "remove", "--force", outside])
      await remove(stateDir, mine.dir, { repoRoot, repoKey: "opencode" })
    }
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

describe("worktree plus project", () => {
  test("create leaves no project config in the child worktree", async () => {
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
      })
      // The child is not a Plus project of its own: activation for its session
      // reads the parent directory the run records, so nothing is copied here.
      expect(await exists(join(c.dir, ".opencodeplus"))).toBe(false)
      expect(await git(c.dir, ["status", "--porcelain"])).toBe("")
      // The parent's own config still decides the parent's project mode.
      expect(JSON.parse(await Bun.file(join(repo, ".opencodeplus", "project.json")).text())).toEqual({ version: 1, protectedAgents })
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  test("a parent without a project config still hands the child no file", async () => {
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
      })
      // No default is written either: there is no copy, so no invented config.
      expect(await exists(join(c.dir, ".opencodeplus"))).toBe(false)
      expect(await git(c.dir, ["status", "--porcelain"])).toBe("")
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  // `remove` is a plain `git worktree remove`: nothing Plus wrote has to be
  // deleted first, and a tracked project.json is part of the checkout itself.
  test("remove is a plain git worktree remove with no config special case", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "teams-wt-remove-"))
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
      // The working tree diverges from HEAD; the tracked copy in the child is
      // the committed one and must not block a non-force removal.
      await writeFile(join(repo, ".opencodeplus", "project.json"), `${JSON.stringify({ version: 1, protectedAgents: ["modified-agent"] }, null, 2)}\n`)
      const c = await create(st, {
        repoRoot: repo,
        repoKey: "opencode",
        role: "implementer",
        name: slug("tracked", "w-cccc3333"),
        base: head,
        workspaceRoot: ws,
      })
      expect(JSON.parse(await Bun.file(join(c.dir, ".opencodeplus", "project.json")).text())).toEqual({
        version: 1,
        protectedAgents: ["orig-agent"],
      })
      expect(await git(c.dir, ["status", "--porcelain"])).toBe("")
      await remove(st, c.dir, { repoRoot: repo, repoKey: "opencode" })
      expect(await exists(c.dir)).toBe(false)
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  test("create leaves repository config untouched and keeps inherited ignores", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "teams-wt-cfg-"))
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
      const excludeFile = join(tmp, "custom-exclude")
      await writeFile(excludeFile, "ignored.log\n")
      await git(repo, ["config", "core.excludesFile", excludeFile])
      await writeFile(join(repo, "ignored.log"), "ignored\n")
      const beforeExcludes = await git(repo, ["config", "--get", "core.excludesFile"])
      const beforeWorktree = await gitRaw(repo, ["config", "--get", "extensions.worktreeConfig"])
      expect(beforeWorktree.code).not.toBe(0)
      const c = await create(st, {
        repoRoot: repo,
        repoKey: "opencode",
        role: "implementer",
        name: slug("cfg", "w-ffff6666"),
        base: head,
        workspaceRoot: ws,
      })
      const afterWorktree = await gitRaw(repo, ["config", "--get", "extensions.worktreeConfig"])
      expect(afterWorktree.code).not.toBe(0)
      expect(await git(repo, ["config", "--get", "core.excludesFile"])).toBe(beforeExcludes)
      await writeFile(join(c.dir, "ignored.log"), "ignored\n")
      const check = await gitRaw(c.dir, ["check-ignore", "-q", "ignored.log"])
      expect(check.code).toBe(0)
      expect(await git(c.dir, ["status", "--porcelain"])).not.toContain("ignored.log")
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })
})
