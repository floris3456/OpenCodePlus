import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { drain, enqueue, pending, queue } from "../../src/teams/merge.js"
import type { MergeContext } from "../../src/teams/merge.js"
import { create, load } from "../../src/teams/tasks.js"
import { git } from "../../src/teams/git.js"
import { list as listWorktrees } from "../../src/teams/worktree.js"
import { saveRun, type RunRecord } from "../../src/teams/run.js"
import { atomicJson } from "../../src/teams/store.js"
import { execute, lastReceipt, stale } from "../../src/teams/checks.js"
import { writeProjectChecks } from "../../src/teams/project-checks.js"

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

/** Commit files in the fixture's main checkout, so a child's merge base is `main`. */
async function commitMain(files: Record<string, string>, message: string): Promise<string> {
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(dirname(join(repoRoot, rel)), { recursive: true })
    await writeFile(join(repoRoot, rel), content)
    await git(repoRoot, ["add", rel])
  }
  await git(repoRoot, ["commit", "-m", message])
  return headOf(repoRoot)
}

/** A parent worktree on `base`, holding its own branch (the base a child forks from). */
async function parentAt(name: string, base: string): Promise<{ dir: string; head: string }> {
  const dir = join(scratch, `parent-${name}`)
  await git(repoRoot, ["worktree", "add", "-b", `parent-${name}`, dir, base])
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

  test("an entry overlapping the parent's uncommitted file pauses the queue there", async () => {
    const parentRun = "paused-overlap-parent"
    const parent = await makeParent("paused-overlap")
    const unrelated = await makeChild("paused-overlap-a", parent.head, { "a.txt": "a\n" }, "feat: a")
    const overlapping = await makeChild("paused-overlap-b", parent.head, { "README.md": "child\n" }, "docs: child README")
    await enqueue(stateDir, { parentRun, parentWorktree: parent.dir, childRun: "paused-overlap-a-run", childBranch: unrelated.branch, childHead: unrelated.head })
    await enqueue(stateDir, { parentRun, parentWorktree: parent.dir, childRun: "paused-overlap-b-run", childBranch: overlapping.branch, childHead: overlapping.head })
    await writeFile(join(parent.dir, "README.md"), "parent's own\n")
    const result = await drain(stateDir, parentRun, ctxFor(parent.dir))
    expect(result.paused).toBe(true)
    expect(result.processed).toHaveLength(1)
    expect(result.processed[0]).toMatchObject({ childRun: "paused-overlap-a-run", state: "landed" })
    expect((await pending(stateDir, parentRun)).map((entry) => entry.childRun)).toEqual(["paused-overlap-b-run"])
    expect(await readFile(join(parent.dir, "README.md"), "utf8")).toBe("parent's own\n")
  })

  test("a dirty path with a space is named unquoted in E_DIRTY", async () => {
    const parent = await makeParent("spaced-dirty")
    const base = await commitFile(parent.dir, "sp ace.txt", "parent\n", "chore: spaced file")
    const child = await makeChild("spaced-dirty-1", base, { "sp ace.txt": "child\n" }, "feat: child spaced file")
    await writeFile(join(parent.dir, "sp ace.txt"), "parent uncommitted\n")
    const dirty = await enqueue(stateDir, {
      parentRun: "spaced-dirty-parent",
      parentWorktree: parent.dir,
      childRun: "spaced-dirty-child",
      childBranch: child.branch,
      childHead: child.head,
      expectedParentHead: base,
    }).then(
      () => null,
      (e) => asErr(e),
    )
    expect(dirty?.code).toBe("E_DIRTY")
    expect(dirty?.message).toBe(
      "Your worktree has uncommitted changes to [sp ace.txt], which spaced-dirty-child's commits also change; commit or discard them, then integrate again. Your other uncommitted files stay as they are.",
    )
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

  // Live b6-s5: a planner attached its uncommitted plan; the child saved it,
  // committed it and then corrected it, and git refused the landing over the
  // planner's untracked copy (E_INTERNAL with git's own words).
  test("an untracked copy the child's commits hold is replaced at landing; another version refuses E_DIRTY", async () => {
    const parent = await makeParent("untracked")
    const plan = "# Plan\n\nfirst version\n"
    const child = await makeChild("untracked-1", parent.head, { "plan.md": plan }, "docs: plan as attached")
    const corrected = await commitFile(child.dir, "plan.md", "# Plan\n\ncorrected\n", "docs: correct the plan")
    await writeFile(join(parent.dir, "plan.md"), plan)
    await enqueue(stateDir, { parentRun: "untracked-parent", parentWorktree: parent.dir, childRun: "untracked-child", childBranch: child.branch, childHead: corrected })
    const result = await drain(stateDir, "untracked-parent", ctxFor(parent.dir))
    expect(result.processed[0]?.state).toBe("landed")
    expect(await headOf(parent.dir)).toBe(corrected)
    expect(await readFile(join(parent.dir, "plan.md"), "utf8")).toBe("# Plan\n\ncorrected\n")
    expect(await statusOf(parent.dir)).toBe("")

    const other = await makeParent("untracked-other")
    const second = await makeChild("untracked-2", other.head, { "notes.md": "child notes\n" }, "docs: notes")
    await writeFile(join(other.dir, "notes.md"), "the parent's own notes\n")
    const refused = await enqueue(stateDir, { parentRun: "untracked-other-parent", parentWorktree: other.dir, childRun: "untracked-other-child", childBranch: second.branch, childHead: second.head }).then(
      () => null,
      (e) => asErr(e),
    )
    expect(refused?.code).toBe("E_DIRTY")
    expect(String(refused?.message)).toContain("Untracked [notes.md] in your worktree would be overwritten: untracked-other-child's commits add another version.")
    expect(await readFile(join(other.dir, "notes.md"), "utf8")).toBe("the parent's own notes\n")
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

  test("a landing never runs another run's change-scoped check; its own still judges it", async () => {
    // The gate judges the change a run made: files changed since the fork from
    // main. A later child's landing must not inherit an earlier child's gate.
    const gate = `import { spawnSync } from "node:child_process"
const out = (...args: string[]) => spawnSync("git", args, { encoding: "utf8" }).stdout.trim()
const base = out("merge-base", "HEAD", "main")
const changed = out("diff", "--name-only", "--no-renames", base, "HEAD").split("\\n").filter(Boolean)
if (changed.length > 1) {
  console.error("gate-small: " + changed.length + " files changed since " + base.slice(0, 7) + ": " + changed.join(", "))
  process.exit(1)
}
`
    const behaviour = 'import { test, expect } from "bun:test"\ntest("parent contract", async () => expect(await Bun.file("README.md").text()).toBe("fixture\\n"))\n'
    const base = await commitMain(
      { "tools/teamgate/gate.ts": gate, "ok.test.ts": behaviour, ".gitignore": ".opencodeplus/\n" },
      "test: change gate and behaviour check",
    )
    const size = { id: "size", argv: ["bun", "tools/teamgate/gate.ts"] }
    const ok = { id: "ok", argv: ["bun", "test", "ok.test.ts"] }
    await writeProjectChecks(repoRoot, {
      version: 1,
      checks: {
        size: { argv: size.argv, description: "at most 1 file", scope: "change" },
        ok: { argv: ok.argv, description: "parent contract" },
      },
    })

    const parent = await parentAt("scoped", base)
    const parentRun = "scoped-parent"
    const firstRun = "scoped-first"
    const secondRun = "scoped-second"
    // A run stores its resolved commands, without the scope.
    const first = await makeChild("scoped-first", base, { "first.txt": "first\n" }, "feat: first")
    const second = await makeChild("scoped-second", base, { "second.txt": "second\n" }, "feat: second")
    await commitFile(second.dir, "third.txt", "third\n", "feat: second again")
    const secondHead = await headOf(second.dir)
    await atomicJson(join(stateDir, "runs", firstRun, "checks.json"), [size, ok])
    await atomicJson(join(stateDir, "runs", secondRun, "checks.json"), [ok])
    await create(stateDir, secondRun, [{ id: secondRun, title: "Second", dependsOn: [], role: "implementer", effort: "small", deliverable: { kind: "commit" }, paths: ["second.txt"], checks: [ok] }])
    for (const [childRun, child, head] of [[firstRun, first, first.head], [secondRun, second, secondHead]] as const)
      await enqueue(stateDir, { parentRun, parentWorktree: parent.dir, childRun, childBranch: child.branch, childHead: head })

    const result = await drain(stateDir, parentRun, ctxFor(parent.dir))
    expect(result.processed[0]).toMatchObject({ childRun: firstRun, state: "landed" })
    expect(result.processed[0].skippedChecks).toBeUndefined()
    // Before the fix this landing went red on the earlier child's size gate.
    expect(result.processed[1]).toMatchObject({ childRun: secondRun, state: "landed", skippedChecks: [{ id: "size", runID: firstRun }] })
    expect(result.processed[1].redChecks).toBeUndefined()
    const landedHead = result.processed[1].landedHead!
    expect(await lastReceipt(stateDir, secondRun, "ok", landedHead)).toMatchObject({ passed: true })
    // The skipped gate left no receipt of its own for this child.
    expect(await lastReceipt(stateDir, secondRun, "size")).toBeUndefined()
    expect(await headOf(parent.dir)).toBe(landedHead)
  })

  test("the landing child's own change-scoped check still judges its change", async () => {
    const gate = `import { spawnSync } from "node:child_process"
const out = (...args: string[]) => spawnSync("git", args, { encoding: "utf8" }).stdout.trim()
const base = out("merge-base", "HEAD", "main")
const changed = out("diff", "--name-only", "--no-renames", base, "HEAD").split("\\n").filter(Boolean)
if (changed.length > 1) process.exit(1)
`
    const base = await commitMain({ "tools/teamgate/own-gate.ts": gate }, "test: own change gate")
    const size = { id: "size", argv: ["bun", "tools/teamgate/own-gate.ts"] }
    await writeProjectChecks(repoRoot, { version: 1, checks: { size: { argv: size.argv, scope: "change" } } })
    const parent = await parentAt("own-scope", base)
    const parentRun = "own-scope-parent"
    const childRun = "own-scope-child"
    // Two files: the child's own gate must fail on its own change.
    const child = await makeChild("own-scope", base, { "one.txt": "one\n" }, "feat: one")
    await commitFile(child.dir, "two.txt", "two\n", "feat: two")
    const childHead = await headOf(child.dir)
    await atomicJson(join(stateDir, "runs", childRun, "checks.json"), [size])
    await create(stateDir, childRun, [{ id: childRun, title: "Own", dependsOn: [], role: "implementer", effort: "small", deliverable: { kind: "commit" }, paths: ["one.txt"], checks: [size] }])
    await enqueue(stateDir, { parentRun, parentWorktree: parent.dir, childRun, childBranch: child.branch, childHead })
    const result = await drain(stateDir, parentRun, ctxFor(parent.dir))
    expect(result.processed[0]).toMatchObject({ state: "red", redChecks: ["size"] })
    expect(result.processed[0].skippedChecks).toBeUndefined()
  })

  test("an earlier child's behaviour check that a later child breaks still blocks it", async () => {
    const behaviour = 'import { test, expect } from "bun:test"\ntest("parent contract", async () => expect(await Bun.file("README.md").text()).toBe("fixture\\n"))\n'
    const base = await commitMain({ "contract.test.ts": behaviour }, "test: behaviour check")
    const parent = await parentAt("behaviour", base)
    const parentRun = "behaviour-parent"
    const firstRun = "behaviour-first"
    const secondRun = "behaviour-second"
    const check = { id: "contract", argv: ["bun", "test", "contract.test.ts"] }
    const first = await makeChild("behaviour-first", base, { "first.txt": "first\n" }, "feat: first")
    const second = await makeChild("behaviour-second", base, { "README.md": "broken\n" }, "docs: second breaks contract")
    await atomicJson(join(stateDir, "runs", firstRun, "checks.json"), [check])
    await atomicJson(join(stateDir, "runs", secondRun, "checks.json"), [])
    await create(stateDir, secondRun, [{ id: secondRun, title: "Second", dependsOn: [], role: "implementer", effort: "small", deliverable: { kind: "commit" }, paths: ["README.md"], checks: [] }])
    for (const [childRun, child] of [[firstRun, first], [secondRun, second]] as const)
      await enqueue(stateDir, { parentRun, parentWorktree: parent.dir, childRun, childBranch: child.branch, childHead: child.head })
    const result = await drain(stateDir, parentRun, ctxFor(parent.dir))
    expect(result.processed[0]).toMatchObject({ state: "landed" })
    expect(result.processed[1]).toMatchObject({ state: "red", redChecks: ["contract"] })
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
    // A dirty parent refuses only where the child's own commits change the
    // same path: README.md here is the parent's, and the child adds child.txt.
    await writeFile(join(parent.dir, "README.md"), "fixture modified\n")
    const elsewhere = await makeChild("guards-elsewhere", p, { "child.txt": "child\n" }, "feat: child file")
    const allowed = await enqueue(stateDir, {
      parentRun: "w-0000000000000041",
      parentWorktree: parent.dir,
      childRun: "w-0000000000000042",
      childBranch: elsewhere.branch,
      childHead: elsewhere.head,
      expectedParentHead: p,
    })
    expect(allowed.state).toBe("pending")
    const overlapping = await makeChild("guards-overlap", p, { "README.md": "child README\n" }, "docs: child edits README")
    const dirty = await enqueue(stateDir, {
      parentRun: "w-0000000000000043",
      parentWorktree: parent.dir,
      childRun: "w-0000000000000044",
      childBranch: overlapping.branch,
      childHead: overlapping.head,
      expectedParentHead: p,
    }).then(
      () => null,
      (e) => asErr(e),
    )
    expect(dirty?.code).toBe("E_DIRTY")
    expect(dirty?.message).toBe(
      "Your worktree has uncommitted changes to [README.md], which w-0000000000000044's commits also change; commit or discard them, then integrate again. Your other uncommitted files stay as they are.",
    )
    await git(parent.dir, ["checkout", "--", "README.md"])
  })
})
