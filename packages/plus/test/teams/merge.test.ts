import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { drain, enqueue, pending, queue } from "../../src/teams/merge.js"
import type { MergeContext } from "../../src/teams/merge.js"
import { create, load } from "../../src/teams/tasks.js"
import { git } from "../../src/teams/git.js"
import { list as listWorktrees } from "../../src/teams/worktree.js"
import { saveRun, type RunRecord } from "../../src/teams/run.js"
import { atomicJson } from "../../src/teams/store.js"
import { execute, lastReceipt, stale } from "../../src/teams/checks.js"

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
  await create(stateDir, planRun, [
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

function baseRun(overrides: Partial<RunRecord> & { id: string }): RunRecord {
  const now = new Date().toISOString()
  return {
    role: "muse-implementer",
    kind: "w",
    repo: "opencode",
    repoKey: "opencode",
    directory: scratch,
    paths: [],
    branch: "test",
    base: mainHead,
    head: mainHead,
    state: "idle",
    attempts: [],
    task: null,
    parent: null,
    children: [],
    briefSha: "abc",
    bundle: "test",
    budget: {},
    createdAt: now,
    lastUsed: now,
    sessionID: null,
    configDigest: null,
    history: [],
    ...overrides,
  }
}

function ctxFor(parentDir: string, checks: MergeContext["checks"] = []): MergeContext {
  return { repoRoot, repoKey: "opencode", workspaceRoot: wsRoot, parentWorktree: parentDir, checks }
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
  test.each([false, true])("landing also reuses matching proof in the parent's receipts (legacy: %s)", async (legacy) => {
    const name = `parent-proof-${legacy}`
    const parentRun = `${name}-parent`
    const childRun = `${name}-child`
    const parent = await makeParent(name)
    const child = await makeChild(name, parent.head, { "child.txt": "checked content\n" }, "feat: child content")
    const counter = join(scratch, `${name}.log`)
    const check = { id: "count", argv: ["bun", "-e", `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(counter)}, 'run\\n')`] }
    await atomicJson(join(stateDir, "runs", childRun, "checks.json"), [check])
    const receipt = await execute(stateDir, { runID: parentRun, check, worktree: child.dir })
    expect(receipt.passed).toBe(true)
    if (legacy) {
      delete receipt.measuredTree
      await atomicJson(join(stateDir, "runs", parentRun, "receipts", `count-${child.head.slice(0, 7)}.json`), receipt)
    }
    await enqueue(stateDir, { parentRun, parentWorktree: parent.dir, childRun, childBranch: child.branch, childHead: child.head })
    const result = await drain(stateDir, parentRun, ctxFor(parent.dir, [check, { ...check, id: "alias" }]))
    expect(result.processed[0]).toMatchObject({ state: "landed", reusedChecks: [{ id: check.id, reused: true, at: receipt.at }] })
    expect(await Bun.file(counter).text()).toBe("run\n")
    expect(await stale(stateDir, [check, { ...check, id: "alias" }], parentRun, child.head)).toEqual([])
    expect(await lastReceipt(stateDir, parentRun, "alias", child.head)).toMatchObject({ passed: true, reused: true, at: receipt.at })
  })

  test("a child's own check passing at its tip but red in combination always blocks", async () => {
    const parent = await makeParent("own-check")
    const childRun = "own-check-child"
    const parentRun = "own-check-parent"
    const child = await makeChild("own-check", parent.head, {
      "own.test.ts": 'import { test, expect } from "bun:test"\ntest("parent contract", async () => expect(await Bun.file("README.md").text()).toBe("fixture\\n"))\n',
    }, "test: parent contract")
    const check = { id: "own", argv: ["bun", "test", "own.test.ts"] }
    await atomicJson(join(stateDir, "runs", childRun, "checks.json"), [check])
    expect((await execute(stateDir, { runID: childRun, check, worktree: child.dir })).passed).toBe(true)
    const parentHead = await commitFile(parent.dir, "README.md", "new contract\n", "feat: change contract")
    await create(stateDir, childRun, [{ id: childRun, title: "Own check", dependsOn: [], role: "implementer", effort: "small", deliverable: { kind: "commit" }, paths: ["own.test.ts"], checks: [check] }])
    await enqueue(stateDir, { parentRun, parentWorktree: parent.dir, childRun, childBranch: child.branch, childHead: child.head })
    // The command is also assigned to the parent: deduplication must retain
    // child ownership, even though this test is missing at the parent's HEAD.
    const result = await drain(stateDir, parentRun, ctxFor(parent.dir, [{ ...check, id: "parent-alias" }]))
    expect(result.processed[0]).toMatchObject({ state: "red", redChecks: ["parent-alias"] })
    expect(result.processed[0].stillRed).toBeUndefined()
    expect(await headOf(parent.dir)).toBe(parentHead)
  })

  test("landings derive earlier children's checks, allow pre-existing red and block new red", async () => {
    const parent = await makeParent("automatic")
    const parentRun = "automatic-parent"
    const firstRun = "automatic-first"
    const secondRun = "automatic-second"
    const baseline = await commitFile(parent.dir, "gate.test.ts", 'import { test, expect } from "bun:test"\ntest("gate", async () => expect(await Bun.file("README.md").text()).toBe("fixture\\n"))\n', "test: gate")
    const first = await makeChild("automatic-first", baseline, { "first.txt": "first\n" }, "feat: first")
    const second = await makeChild("automatic-second", baseline, { "README.md": "broken\n" }, "feat: second")
    const check = { id: "unit", argv: ["bun", "test", "gate.test.ts"] }
    await atomicJson(join(stateDir, "runs", firstRun, "checks.json"), [check])
    await create(stateDir, secondRun, [{ id: secondRun, title: "Second", dependsOn: [], role: "implementer", effort: "small", deliverable: { kind: "commit" }, paths: ["README.md"], checks: [] }])
    for (const [childRun, child] of [[firstRun, first], [secondRun, second]] as const)
      await enqueue(stateDir, { parentRun, parentWorktree: parent.dir, childRun, childBranch: child.branch, childHead: child.head })
    const result = await drain(stateDir, parentRun, ctxFor(parent.dir, [{ id: "pending-test", argv: ["bun", "test", "not-landed.test.ts"] }]))
    expect(result.processed[0]).toMatchObject({ state: "landed", stillRed: ["pending-test"] })
    expect(result.processed[1]).toMatchObject({ state: "red", redChecks: ["unit"], stillRed: ["pending-test"] })
    expect(await headOf(parent.dir)).toBe(result.processed[0].landedHead!)
    expect(await lastReceipt(stateDir, parentRun, "pending-test", result.processed[0].landedHead)).toMatchObject({ passed: false })
  })

  test("commands deduplicate across owners and aliases without losing parent finish receipts", async () => {
    const parent = await makeParent("aliases")
    const parentRun = "aliases-parent"
    const childRun = "aliases-child"
    const baseline = await commitFile(parent.dir, "gate.test.ts", 'import { test, expect } from "bun:test"\ntest("gate", () => expect(1).toBe(1))\n', "test: gate")
    const child = await makeChild("aliases", baseline, { "other.test.ts": 'import { test, expect } from "bun:test"\ntest("other", () => expect(2).toBe(2))\n' }, "test: other")
    const checks = [{ id: "unit", argv: ["bun", "test", "gate.test.ts"] }, { id: "alias", argv: ["bun", "test", "gate.test.ts"] }]
    await atomicJson(join(stateDir, "runs", childRun, "checks.json"), [{ id: "same-command", argv: checks[0].argv }, { id: "unit", argv: ["bun", "test", "other.test.ts"] }])
    const checked = await execute(stateDir, { runID: childRun, check: { id: "same-command", argv: checks[0].argv }, worktree: child.dir })
    expect(checked.passed).toBe(true)
    await enqueue(stateDir, { parentRun, parentWorktree: parent.dir, childRun, childBranch: child.branch, childHead: child.head })
    const result = await drain(stateDir, parentRun, ctxFor(parent.dir, checks))
    expect(result.processed[0].state).toBe("landed")
    expect(result.processed[0].reusedChecks).toEqual([{ id: "unit", reused: true, at: checked.at }])
    const head = await headOf(parent.dir)
    expect(await stale(stateDir, checks, parentRun, head)).toEqual([])
    expect(await lastReceipt(stateDir, parentRun, "unit", head)).toMatchObject({ argv: checks[0].argv, dirty: false })
    expect(await lastReceipt(stateDir, childRun, "unit", head)).toMatchObject({ argv: ["bun", "test", "other.test.ts"], passed: true })
    const audit = (await Bun.file(join(stateDir, "audit.log")).text()).trim().split("\n").map((line) => JSON.parse(line) as { head: string; kind: string })
    expect(audit.filter((line) => line.kind === "receipt.written" && line.head === head)).toHaveLength(2)
  })

  test("a clean child lands and the temp worktree is gone", async () => {
    const parentRun = "w-0000000000000001"
    const childRun = "w-0000000000000002"
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
    const result = await drain(stateDir, parentRun, ctxFor(parent.dir))
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
    await saveRun(
      stateDir,
      baseRun({
        id: childRun,
        parent: parentRun,
        directory: child.dir,
        branch: child.branch,
        base: p0,
        head: child.head,
        task: "T1",
      }),
    )
    const before = await listWorktrees(repoRoot)
    const result = await drain(stateDir, parentRun, ctxFor(parent.dir, [{ id: "unlanded", argv: ["bun", "test", "unlanded.test.ts"] }]))
    expect(result.processed[0].state).toBe("conflict")
    const all = await queue(stateDir, parentRun)
    expect(all[0].conflictFiles ?? []).toContain("base.txt")
    expect(all[0].reworkTask).toBe("T1.rework.1")
    const graph = await load(stateDir, planRun)
    expect(graph.tasks["T1.rework.1"].paths).toContain("base.txt")
    expect(graph.tasks["T1.rework.1"].checks).toEqual([])
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
    expect(stale?.message).toBe(`Your HEAD is ${p}; pass it as expectedParentHead or omit it (never the child's commit).`)
    // A short commit, HEAD, or none expect the HEAD the parent has; the entry
    // records the full commit.
    for (const [n, expected] of [["51", p.slice(0, 7)], ["52", "HEAD"], ["53", undefined]] as const) {
      const entry = await enqueue(stateDir, {
        parentRun: `w-00000000000000${n}`,
        parentWorktree: parent.dir,
        childRun: `w-00000000000001${n}`,
        childBranch: `child-${n}`,
        childHead: p,
        ...(expected === undefined ? {} : { expectedParentHead: expected }),
      })
      expect(entry.expectedParentHead).toBe(p)
    }
    const wrongShort = await enqueue(stateDir, {
      parentRun: "w-0000000000000054",
      parentWorktree: parent.dir,
      childRun: "w-0000000000000154",
      childBranch: "child-54",
      childHead: p,
      expectedParentHead: p.startsWith("0000000") ? "1111111" : "0000000",
    }).then(
      () => null,
      (e) => asErr(e),
    )
    expect(wrongShort?.code).toBe("E_STALE_PARENT")
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
