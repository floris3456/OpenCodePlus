import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import type { SnapshotDomain } from "@opencode/plugin/effect/snapshot"
import { Hash } from "@opencode/util/hash"
import { Effect, Exit, Scope } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import plus from "../../src/index.js"
import { teamsDataDir } from "../../src/instructions/paths.js"
import {
  isTeamWorktree,
  removeLeftoverSnapshotStores,
  removeSnapshotStores,
  snapshotRoot,
} from "../../src/teams/snapshots.js"
import { git } from "../../src/teams/git.js"
import { gc } from "../../src/teams/lifecycle.js"
import { create, remove } from "../../src/teams/worktree.js"
import { context, fullContext, toolHarness } from "../harness.js"

let scratch = ""

beforeAll(async () => {
  scratch = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "plus-snapshot-"))
})

afterAll(async () => {
  await fs.rm(scratch, { recursive: true, force: true })
})

// A snapshot store as core leaves it: `git --git-dir <store> --work-tree <worktree> init`.
async function store(root: string, project: string, worktree: string): Promise<string> {
  const dir = path.join(root, project, Hash.fast(worktree))
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, "config"), `[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tworktree = ${worktree}\n`)
  return dir
}

const exists = (target: string) => fs.lstat(target).then(() => true, () => false)

describe("removeSnapshotStores", () => {
  test("removes the store whose config names the worktree and keeps every other store", async () => {
    const root = path.join(scratch, "remove")
    const worktree = path.join(scratch, "run-a")
    const other = path.join(scratch, "run-b")
    const mine = await store(root, "project-one", worktree)
    // Same hash path in another project, but it belongs to a different worktree.
    const samePath = path.join(root, "project-two", Hash.fast(worktree))
    await fs.mkdir(samePath, { recursive: true })
    await fs.writeFile(path.join(samePath, "config"), `[core]\n\tworktree = ${other}\n`)
    const unrelated = await store(root, "project-three", other)

    expect(await removeSnapshotStores(worktree, root)).toEqual([mine])
    expect(await exists(mine)).toBe(false)
    expect(await exists(samePath)).toBe(true)
    expect(await exists(unrelated)).toBe(true)
  })

  test("skips a store with no config and returns [] for a missing root", async () => {
    const root = path.join(scratch, "missing-config")
    const worktree = path.join(scratch, "run-c")
    const bare = path.join(root, "project", Hash.fast(worktree))
    await fs.mkdir(bare, { recursive: true })

    expect(await removeSnapshotStores(worktree, root)).toEqual([])
    expect(await exists(bare)).toBe(true)
    expect(await removeSnapshotStores(worktree, path.join(scratch, "no-such-root"))).toEqual([])
  })
})

describe("removeLeftoverSnapshotStores", () => {
  test("removes stores of absent team worktrees and keeps live or outside ones", async () => {
    const root = path.join(scratch, "leftover")
    const teamsRoot = path.join(scratch, "teams")
    const area = path.join(teamsRoot, "worktrees")
    const live = path.join(area, "repo", "implementer", "live-20260101-0000")
    const gone = path.join(area, "repo", "implementer", "gone-20260101-0000")
    const outside = path.join(scratch, "checkout")
    await fs.mkdir(live, { recursive: true })

    const liveStore = await store(root, "project", live)
    const goneStore = await store(root, "project", gone)
    const outsideStore = await store(root, "project", outside)

    expect(await removeLeftoverSnapshotStores(teamsRoot, root)).toEqual([goneStore])
    expect(await exists(goneStore)).toBe(false)
    expect(await exists(liveStore)).toBe(true)
    expect(await exists(outsideStore)).toBe(true)
    expect(await removeLeftoverSnapshotStores(teamsRoot, path.join(scratch, "no-such-root"))).toEqual([])
  })
})

describe("with the worktree", () => {
  test("removeLocked deletes the removed worktree's snapshot store", async () => {
    const scratchRepo = path.join(scratch, "remove-call")
    const repo = path.join(scratchRepo, "repo")
    const root = path.join(scratchRepo, "state")
    await fs.mkdir(repo, { recursive: true })
    await git(repo, ["init", "-b", "main"])
    await git(repo, ["config", "user.email", "snapshots@test.local"])
    await git(repo, ["config", "user.name", "snapshots"])
    await fs.writeFile(path.join(repo, "README.md"), "fixture\n")
    await git(repo, ["add", "README.md"])
    await git(repo, ["commit", "-m", "chore: fixture"])
    const created = await create(root, {
      repoRoot: repo,
      repoKey: "repo",
      role: "implementer",
      name: "gone",
      base: await git(repo, ["rev-parse", "HEAD"]),
      workspaceRoot: path.join(scratchRepo, "teams"),
    })
    const stored = await store(snapshotRoot(), "project", created.dir)

    await remove(root, created.dir, { repoRoot: repo, repoKey: "repo" })

    expect(await exists(created.dir)).toBe(false)
    expect(await exists(stored)).toBe(false)
  })

  test("gc sweeps the stores of absent team worktrees", async () => {
    const teamsRoot = path.join(scratch, "gc-teams")
    const area = path.join(teamsRoot, "worktrees", "repo", "implementer")
    const live = path.join(area, "live-20260101-0000")
    const gone = path.join(area, "gone-20260101-0000")
    await fs.mkdir(live, { recursive: true })
    const liveStore = await store(snapshotRoot(), "project", live)
    const goneStore = await store(snapshotRoot(), "project", gone)

    await gc(teamsRoot)

    expect(await exists(goneStore)).toBe(false)
    expect(await exists(liveStore)).toBe(true)
  })
})

describe("isTeamWorktree", () => {
  test("tells worktrees under the team area from everything else", async () => {
    const teamsRoot = path.join(scratch, "is-team")
    const worktree = path.join(teamsRoot, "worktrees", "repo", "implementer", "run-20260101-0000")
    await fs.mkdir(worktree, { recursive: true })

    expect(await isTeamWorktree(worktree, teamsRoot)).toBe(true)
    expect(await isTeamWorktree(teamsRoot, teamsRoot)).toBe(false)
    expect(await isTeamWorktree(path.join(teamsRoot, "runs"), teamsRoot)).toBe(false)
    expect(await isTeamWorktree(path.join(scratch, "elsewhere"), teamsRoot)).toBe(false)
  })

  test("follows a symlinked teams root", async () => {
    const real = path.join(scratch, "linked-teams")
    const link = path.join(scratch, "linked-teams-link")
    const worktree = path.join(real, "worktrees", "repo", "reviewer", "run-20260101-0000")
    await fs.mkdir(worktree, { recursive: true })
    await fs.symlink(real, link, "dir")

    expect(await isTeamWorktree(path.join(link, "worktrees", "repo", "reviewer", "run-20260101-0000"), link)).toBe(true)
    expect(await isTeamWorktree(worktree, link)).toBe(true)
  })
})

describe("the Plus plugin", () => {
  const priorDataHome = process.env.XDG_DATA_HOME
  const priorConfigDir = process.env.OPENCODE_CONFIG_DIR

  afterEach(() => {
    if (priorDataHome === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = priorDataHome
    if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
  })

  test("turns snapshots off for a Location in the team worktree area and leaves others alone", async () => {
    const data = path.join(scratch, "plugin-data")
    process.env.XDG_DATA_HOME = data
    process.env.OPENCODE_CONFIG_DIR = path.join(scratch, "plugin-config")
    const worktree = path.join(teamsDataDir(), "worktrees", "repo", "implementer", "run-20260101-0000")
    const outside = path.join(scratch, "plugin-project")
    await fs.mkdir(worktree, { recursive: true })
    await fs.mkdir(outside, { recursive: true })
    const calls: string[] = []
    const snapshot: SnapshotDomain = {
      transform: (callback) =>
        Effect.sync(() => {
          callback({ configure: (enabled) => calls.push(`${String(enabled)}`) })
          return { dispose: Effect.void }
        }),
    }
    const tools = toolHarness()

    const run = async (directory: string) => {
      const ctx = context({
        ...fullContext({ directory, hooks: { current: 0 } }),
        snapshot,
        tool: {
          ...tools.domain,
          hook: () => Effect.succeed({ dispose: Effect.void }),
        },
        rpc: Object.assign(
          () => {
            throw new Error("unused rpc.client")
          },
          { register: () => Effect.succeed({ events: { emit: () => Effect.void } }) },
        ) as never,
        storage: {
          get: () => Effect.succeed(undefined),
          set: () => Effect.void,
          remove: () => Effect.void,
          scan: () => Effect.succeed({ entries: [] }) as never,
        },
      })
      const scope = await Effect.runPromise(Scope.make())
      try {
        await Effect.runPromise(plus.effect(ctx).pipe(Scope.provide(scope)))
      } finally {
        await Effect.runPromise(Scope.close(scope, Exit.void))
      }
    }

    await run(worktree)
    expect(calls).toEqual(["false"])
    await run(outside)
    expect(calls).toEqual(["false"])
  })
})
