import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { drain, enqueue, pending, queue } from "../../src/teams/merge.js"
import type { MergeContext } from "../../src/teams/merge.js"
import { create as createTasks, load as loadTasks } from "../../src/teams/tasks.js"
import { git } from "../../src/teams/git.js"
import { list as listWorktrees } from "../../src/teams/worktree.js"

let scratch = ""
let stateDir = ""
let repoRoot = ""
let wsRoot = ""
let mainHead = ""

async function headOf(dir: string): Promise<string> {
  return git(dir, ["rev-parse", "HEAD"])
}

async function statusOf(dir: string): Promise<string> {
  return git(dir, ["status", "--porcelain"])
}

async function commitFile(dir: string, rel: string, content: string, message: string): Promise<string> {
  await writeFile(join(dir, rel), content)
  await git(dir, ["add", rel])
  await git(dir, ["commit", "-m", message])
  return headOf(dir)
}

async function makeParent(name: string): Promise<{ dir: string; head: string }> {
  const dir = join(scratch, `parent-${name}`)
  const branch = `parent-${name}`
  await git(repoRoot, ["worktree", "add", "-b", branch, dir, mainHead])
  return { dir, head: await headOf(dir) }
}

async function makeChild(
  name: string,
  baseHead: string,
  files: Record<string, string>,
  message: string,
): Promise<{ dir: string; branch: string; head: string }> {
  const dir = join(scratch, `child-${name}`)
  const branch = `child-${name}`
  await git(repoRoot, ["worktree", "add", "-b", branch, dir, baseHead])
  for (const [rel, content] of Object.entries(files)) await writeFile(join(dir, rel), content)
  await git(dir, ["add", "-A"])
  await git(dir, ["commit", "-m", message])
  return { dir, branch, head: await headOf(dir) }
}

async function createPlan(planRun: string): Promise<void> {
  await createTasks(stateDir, planRun, [
    {
      id: "T1",
      title: "Task T1",
      dependsOn: [],
      role: "muse-implementer",
      effort: "small",
      deliverable: { kind: "commit" },
      paths: ["src/a.ts"],
      checks: [],
    },
  ])
}

function ctxFor(parentDir: string, planRun: string, checks: MergeContext["checks"] = []): MergeContext {
  return { repoRoot, repoKey: "opencode", workspaceRoot: wsRoot, parentWorktree: parentDir, checks, planRun, taskID: "T1" }
}

function asErr(e: unknown): { code?: unknown; message?: unknown } {
  if (typeof e === "object" && e !== null) {
    const o = e as { code?: unknown; message?: unknown }
    return { code: o.code, message: o.message }
  }
  return {}
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "teams-merge-"))
  stateDir = join(scratch, "state")
  repoRoot = join(scratch, "repo")
  wsRoot = join(scratch, "ws")
  await git(scratch, ["init", "-b", "main", "repo"])
  await git(repoRoot, ["config", "user.email", "teams@test.local"])
  await git(repoRoot, ["config", "user.name", "teams"])
  await writeFile(join(repoRoot, "README.md"), "fixture\n")
  await git(repoRoot, ["add", "README.md"])
  await git(repoRoot, ["commit", "-m", "chore: fixture commit"])
  mainHead = await headOf(repoRoot)
})

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe("merge queue", () => {
  test("a clean child lands and the temp worktree is gone", async () => {
    const parentRun = "w-0000000000000001"
    const childRun = "w-0000000000000002"
    const planRun = "plan-clean"
    await createPlan(planRun)
    const parent = await makeParent("clean")
    const child = await makeChild("clean-1", parent.head, { "child.txt": "hello\n" }, "feat: add child file")
    const entry = await enqueue(stateDir, {
      parentRun,
      parentWorktree: parent.dir,
      childRun,
      childBranch: child.branch,
      childHead: child.head,
      expectedParentHead: parent.head,
    })
    expect(entry.state).toBe("pending")
    expect((await pending(stateDir, parentRun)).map((e) => e.id)).toContain(entry.id)
    const before = await listWorktrees(repoRoot)
    const result = await drain(stateDir, parentRun, ctxFor(parent.dir, planRun))
    expect(result.paused).toBe(false)
    expect(result.processed.length).toBe(1)
    expect(result.processed[0].state).toBe("landed")
    const all = await queue(stateDir, parentRun)
    expect(all[0].state).toBe("landed")
    expect(await headOf(parent.dir)).toBe(child.head)
    expect(await readFile(join(parent.dir, "child.txt"), "utf8")).toBe("hello\n")
    const after = await listWorktrees(repoRoot)
    expect(after.length).toBe(before.length)
  })

  test("a conflicting child ends conflict with a rework task and parent untouched", async () => {
    const parentRun = "w-0000000000000011"
    const childRun = "w-0000000000000012"
    const planRun = "plan-conflict"
    await createPlan(planRun)
    const parent = await makeParent("conflict")
    await commitFile(parent.dir, "base.txt", "base\n", "chore: base file")
    const p0 = await headOf(parent.dir)
    const child = await makeChild("conflict-1", p0, { "base.txt": "child\n" }, "feat: child edit")
    await commitFile(parent.dir, "base.txt", "parent\n", "feat: parent edit")
    const p1 = await headOf(parent.dir)
    await enqueue(stateDir, {
      parentRun,
      parentWorktree: parent.dir,
      childRun,
      childBranch: child.branch,
      childHead: child.head,
      expectedParentHead: p1,
    })
    const before = await listWorktrees(repoRoot)
    const result = await drain(stateDir, parentRun, ctxFor(parent.dir, planRun))
    expect(result.processed[0].state).toBe("conflict")
    const all = await queue(stateDir, parentRun)
    expect(all[0].conflictFiles ?? []).toContain("base.txt")
    expect(all[0].reworkTask).toBe("T1.rework.1")
    const graph = await loadTasks(stateDir, planRun)
    expect(graph.tasks["T1.rework.1"].paths).toContain("base.txt")
    expect(graph.tasks["T1"].state).toBe("rework")
    expect(await headOf(parent.dir)).toBe(p1)
    expect(await statusOf(parent.dir)).toBe("")
    const after = await listWorktrees(repoRoot)
    expect(after.length).toBe(before.length)
  })

  test("enqueue guards: stale head, dirty parent, already landed", async () => {
    const parent = await makeParent("guards")
    const p = await headOf(parent.dir)
    const stale = await enqueue(
      stateDir,
      {
        parentRun: "w-0000000000000031",
        parentWorktree: parent.dir,
        childRun: "w-0000000000000032",
        childBranch: "child-stale",
        childHead: p,
        expectedParentHead: "0".repeat(40),
      },
    ).then(
      () => null,
      (e) => asErr(e),
    )
    expect(stale?.code).toBe("E_STALE_PARENT")
    expect(stale?.message).toBe(`Your HEAD is ${p}; pass it as expectedParentHead (never the child's commit).`)
    await writeFile(join(parent.dir, "README.md"), "fixture modified\n")
    const dirty = await enqueue(
      stateDir,
      {
        parentRun: "w-0000000000000041",
        parentWorktree: parent.dir,
        childRun: "w-0000000000000042",
        childBranch: "child-dirty",
        childHead: p,
        expectedParentHead: p,
      },
    ).then(
      () => null,
      (e) => asErr(e),
    )
    expect(dirty?.code).toBe("E_DIRTY")
    await git(parent.dir, ["checkout", "--", "README.md"])
  })
})
