import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execute, verifyReceipt, computePolicyDigest } from "../../src/teams/checks.js"
import { git } from "../../src/teams/git.js"

let scratch = ""
let stateDir = ""
let repoDir = ""
let repoMut = ""

async function initRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  await git(dir, ["init", "-b", "main"])
  await git(dir, ["config", "user.email", "teams@test.local"])
  await git(dir, ["config", "user.name", "teams"])
  await writeFile(join(dir, "README.md"), "# test repo\n")
  await git(dir, ["add", "README.md"])
  await git(dir, ["commit", "-m", "chore: initial commit"])
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "check-binding-test-"))
  stateDir = join(scratch, "state")
  repoDir = join(scratch, "repo")
  repoMut = join(scratch, "repoMut")
  await initRepo(repoDir)
  await initRepo(repoMut)

  await writeFile(join(repoDir, "test.ts"), `console.log("clean check passed");\n`)
  await git(repoDir, ["add", "test.ts"])
  await git(repoDir, ["commit", "-m", "chore: add test script"])

  await writeFile(
    join(repoMut, "mutate.ts"),
    `import { writeFileSync } from "node:fs";\nwriteFileSync("mutated.txt", "mutation\\n");\n`,
  )
  await git(repoMut, ["add", "mutate.ts"])
  await git(repoMut, ["commit", "-m", "chore: add mutating script"])
})

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe("check-definition binding and verification", () => {
  test("accepts a clean receipt when definition, head, and tree match exactly", async () => {
    const runID = "w-cleanrun0000001"
    const check = { id: "unit", argv: ["bun", "run", "test.ts"], cwd: "" }
    const head = await git(repoDir, ["rev-parse", "HEAD"])
    const tree = await git(repoDir, ["rev-parse", "HEAD^{tree}"])

    const receipt = await execute(stateDir, { runID, check, worktree: repoDir })
    expect(receipt.passed).toBe(true)
    expect(receipt.dirty).toBe(false)
    expect(receipt.head).toBe(head)
    expect(receipt.tree).toBe(tree)
    expect(receipt.policyDigest).toBe(computePolicyDigest(check))

    const result = verifyReceipt(receipt, check, { head, tree })
    expect(result.ok).toBe(true)
    expect(result.accepted).toBe(true)
  })

  test("rejects with changed_definition when a single argv element changes", async () => {
    const runID = "w-argvrun00000001"
    const check = { id: "unit", argv: ["bun", "run", "test.ts"], cwd: "" }
    const head = await git(repoDir, ["rev-parse", "HEAD"])
    const tree = await git(repoDir, ["rev-parse", "HEAD^{tree}"])

    const receipt = await execute(stateDir, { runID, check, worktree: repoDir })

    const modifiedCheck = { id: "unit", argv: ["bun", "run", "test.ts", "--verbose"], cwd: "" }
    const result = verifyReceipt(receipt, modifiedCheck, { head, tree })
    expect(result.ok).toBe(false)
    expect(result.accepted).toBe(false)
    expect(result.reason).toBe("changed_definition")
    expect(result.message).toContain("Check definition changed")
  })

  test("rejects with changed_definition when cwd changes", async () => {
    const runID = "w-cwdrun000000001"
    const check = { id: "unit", argv: ["bun", "run", "test.ts"], cwd: "" }
    const head = await git(repoDir, ["rev-parse", "HEAD"])
    const tree = await git(repoDir, ["rev-parse", "HEAD^{tree}"])

    const receipt = await execute(stateDir, { runID, check, worktree: repoDir })

    const modifiedCheck = { id: "unit", argv: ["bun", "run", "test.ts"], cwd: "packages/sub" }
    const result = verifyReceipt(receipt, modifiedCheck, { head, tree })
    expect(result.ok).toBe(false)
    expect(result.accepted).toBe(false)
    expect(result.reason).toBe("changed_definition")
    expect(result.message).toContain("Check definition changed")
  })

  test("rejects with changed_definition when id changes", async () => {
    const runID = "w-idrun0000000001"
    const check = { id: "unit", argv: ["bun", "run", "test.ts"], cwd: "" }
    const head = await git(repoDir, ["rev-parse", "HEAD"])
    const tree = await git(repoDir, ["rev-parse", "HEAD^{tree}"])

    const receipt = await execute(stateDir, { runID, check, worktree: repoDir })

    const modifiedCheck = { id: "integration", argv: ["bun", "run", "test.ts"], cwd: "" }
    const result = verifyReceipt(receipt, modifiedCheck, { head, tree })
    expect(result.ok).toBe(false)
    expect(result.accepted).toBe(false)
    expect(result.reason).toBe("changed_definition")
    expect(result.message).toContain("Check definition changed")
  })

  test("rejects with different_head when head differs", async () => {
    const runID = "w-headrun00000001"
    const check = { id: "unit", argv: ["bun", "run", "test.ts"], cwd: "" }
    const head = await git(repoDir, ["rev-parse", "HEAD"])
    const tree = await git(repoDir, ["rev-parse", "HEAD^{tree}"])

    const receipt = await execute(stateDir, { runID, check, worktree: repoDir })

    const differentHead = "0123456789abcdef0123456789abcdef01234567"
    const result = verifyReceipt(receipt, check, { head: differentHead, tree })
    expect(result.ok).toBe(false)
    expect(result.accepted).toBe(false)
    expect(result.reason).toBe("different_head")
    expect(result.message).toContain("Receipt HEAD")
  })

  test("rejects with different_tree when tree differs", async () => {
    const runID = "w-treerun00000001"
    const check = { id: "unit", argv: ["bun", "run", "test.ts"], cwd: "" }
    const head = await git(repoDir, ["rev-parse", "HEAD"])
    const tree = await git(repoDir, ["rev-parse", "HEAD^{tree}"])

    const receipt = await execute(stateDir, { runID, check, worktree: repoDir })

    const differentTree = "fedcba9876543210fedcba9876543210fedcba98"
    const result = verifyReceipt(receipt, check, { head, tree: differentTree })
    expect(result.ok).toBe(false)
    expect(result.accepted).toBe(false)
    expect(result.reason).toBe("different_tree")
    expect(result.message).toContain("Receipt tree")
  })

  test("rejects with dirty_tree when tree was dirty at check execution time", async () => {
    const runID = "w-dirtyrun0000002"
    const check = { id: "unit", argv: ["bun", "run", "test.ts"], cwd: "" }
    const head = await git(repoDir, ["rev-parse", "HEAD"])
    const tree = await git(repoDir, ["rev-parse", "HEAD^{tree}"])

    await writeFile(join(repoDir, "uncommitted.txt"), "dirty worktree\n")
    const receipt = await execute(stateDir, { runID, check, worktree: repoDir })
    await rm(join(repoDir, "uncommitted.txt"), { force: true })

    expect(receipt.dirty).toBe(true)
    const result = verifyReceipt(receipt, check, { head, tree })
    expect(result.ok).toBe(false)
    expect(result.accepted).toBe(false)
    expect(result.reason).toBe("dirty_tree")
    expect(result.message).toContain("dirty tree")
  })

  test("rejects with missing_dirty_flag when dirty flag is absent from legacy receipt", async () => {
    const runID = "w-legacyflagrun01"
    const check = { id: "unit", argv: ["bun", "run", "test.ts"], cwd: "" }
    const head = await git(repoDir, ["rev-parse", "HEAD"])
    const tree = await git(repoDir, ["rev-parse", "HEAD^{tree}"])

    const receipt = await execute(stateDir, { runID, check, worktree: repoDir })
    const legacyReceipt = { ...receipt, dirty: undefined }

    const result = verifyReceipt(legacyReceipt, check, { head, tree })
    expect(result.ok).toBe(false)
    expect(result.accepted).toBe(false)
    expect(result.reason).toBe("missing_dirty_flag")
    expect(result.message).toContain("missing the dirty flag")
  })

  test("rejects with mutated_source when check mutates the worktree during execution", async () => {
    const runID = "w-mutaterun000001"
    const check = { id: "mut", argv: ["bun", "run", "mutate.ts"], cwd: "" }
    const head = await git(repoMut, ["rev-parse", "HEAD"])
    const tree = await git(repoMut, ["rev-parse", "HEAD^{tree}"])

    const receipt = await execute(stateDir, { runID, check, worktree: repoMut })
    expect(receipt.passed).toBe(false)
    expect(receipt.code).toBe("E_CHECK_MUTATED")

    const result = verifyReceipt(receipt, check, { head, tree })
    expect(result.ok).toBe(false)
    expect(result.accepted).toBe(false)
    expect(result.reason).toBe("mutated_source")
    expect(result.message).toContain("mutating the worktree")
  })
})
