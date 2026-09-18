import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execute, lastReceipt, receiptsAt, run, stale } from "../../src/teams/checks.js"
import { git } from "../../src/teams/git.js"

let scratch = ""
let stateDir = ""
let repoA = ""
let repoMut = ""

async function initRepo(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
  await git(path, ["init", "-b", "main"])
  await git(path, ["config", "user.email", "teams@test.local"])
  await git(path, ["config", "user.name", "teams"])
  await writeFile(join(path, "README.md"), "fixture\n")
  await git(path, ["add", "README.md"])
  await git(path, ["commit", "-m", "chore: fixture commit"])
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "teams-checks-"))
  stateDir = join(scratch, "state")
  repoA = join(scratch, "repoA")
  repoMut = join(scratch, "repoMut")
  await initRepo(repoA)
  await initRepo(repoMut)
  await writeFile(join(repoA, "ok.ts"), `console.log("ok");\n`)
  await writeFile(join(repoA, "fail.ts"), `console.error("boom");\nprocess.exit(1);\n`)
  await writeFile(
    join(repoA, "loud.ts"),
    `for (let i = 0; i < 3000; i++) console.log(\`line \${String(i).padStart(5, "0")} \` + "x".repeat(20));\n`,
  )
  await writeFile(
    join(repoMut, "commit.ts"),
    `import { execSync } from "node:child_process";\n` +
      `execSync('git commit --allow-empty -m "test: sneaky"', { stdio: "ignore" });\n`,
  )
  await git(repoMut, ["config", "user.email", "teams@test.local"])
  await git(repoMut, ["config", "user.name", "teams"])
})

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe("check executor receipts", () => {
  test("a failing check yields passed:false with a non-zero exit", async () => {
    const res = await execute(stateDir, {
      runID: "w-eeeeeeeeeeeeeeee",
      check: { id: "fail", argv: ["bun", "run", "fail.ts"] },
      worktree: repoA,
    })
    expect(res.passed).toBe(false)
    expect(res.exitCode).not.toBe(0)
    expect(res.code).toBeUndefined()
  })

  test("a check that runs git commit yields E_CHECK_MUTATED", async () => {
    const runID = "w-dddddddddddddddd"
    const res = await execute(stateDir, {
      runID,
      check: { id: "mut", argv: ["bun", "run", "commit.ts"] },
      worktree: repoMut,
    })
    expect(res.exitCode).toBe(0)
    expect(res.passed).toBe(false)
    expect(res.code).toBe("E_CHECK_MUTATED")
    expect(res.message).toContain("HEAD")
    const receipt = await lastReceipt(stateDir, runID, "mut")
    expect(receipt?.passed).toBe(false)
    expect(receipt?.code).toBe("E_CHECK_MUTATED")
  })

  test("passing check writes .json + .log, output is the 8KB tail, stale tracks HEAD", async () => {
    const runID = "w-ffffffffffffffff"
    const check = { id: "loud", argv: ["bun", "run", "loud.ts"] }
    const head = await git(repoA, ["rev-parse", "HEAD"])
    const res = await execute(stateDir, { runID, check, worktree: repoA })
    expect(res.passed).toBe(true)
    expect(res.exitCode).toBe(0)

    const dir = join(stateDir, "runs", runID, "receipts")
    const stem = `loud-${head.slice(0, 7)}`
    await stat(join(dir, `${stem}.json`))
    await stat(join(dir, `${stem}.log`))
    expect(res.outputPath).toBe(join(dir, `${stem}.log`))

    const log = await readFile(join(dir, `${stem}.log`), "utf8")
    expect(log).toContain("line 00000")
    expect(Buffer.byteLength(res.output, "utf8") <= 8192).toBe(true)
    expect(log.endsWith(res.output)).toBe(true)
    expect(res.output).not.toContain("line 00000")
    expect(res.output).toContain("line 02999")

    const last = await lastReceipt(stateDir, runID, "loud")
    expect(last?.head).toBe(head)
    expect(last?.passed).toBe(true)
    const at = await receiptsAt(stateDir, runID, head)
    expect(at.map((r) => r.id)).toContain("loud")

    expect(await stale(stateDir, [check], runID, head)).toEqual([])
    expect(await stale(stateDir, [check], runID, "f".repeat(40))).toEqual([check])
  })

  test("same-worktree checks serialize through the wt lock", async () => {
    await writeFile(join(repoA, "marks.log"), "")
    const mk = (id: string) => ({ id, argv: ["bun", "run", "mark.ts"] })
    await writeFile(
      join(repoA, "mark.ts"),
      `import { appendFileSync } from "node:fs";\n` +
        `appendFileSync("marks.log", \`start \${Date.now()}\\n\`);\n` +
        `await new Promise((r) => setTimeout(r, 200));\n` +
        `appendFileSync("marks.log", \`end \${Date.now()}\\n\`);\n`,
    )
    const runID = "w-aaaaaaaaaaaaaaaa"
    const results = await Promise.all([
      execute(stateDir, { runID, check: mk("seq-a"), worktree: repoA }),
      execute(stateDir, { runID, check: mk("seq-b"), worktree: repoA }),
    ])
    for (const r of results) expect(r.passed).toBe(true)
    const lines = (await readFile(join(repoA, "marks.log"), "utf8")).trim().split("\n")
    expect(lines.length).toBe(4)
    const kinds = lines.map((l) => l.split(" ")[0])
    expect(kinds).toEqual(["start", "end", "start", "end"])
    await rm(join(repoA, "marks.log"), { force: true })
    await rm(join(repoA, "mark.ts"), { force: true })
  })
})

describe("check tool entry point", () => {
  test("run() with an unknown id throws E_UNKNOWN_CHECK", async () => {
    const assigned = [
      { id: "a", argv: ["bun", "test", "a.test.ts"] },
      { id: "b", argv: ["bun", "test", "b.test.ts"] },
    ]
    const err = await run(stateDir, "w-1111111111111111", "nope", assigned, repoA).then(
      () => null,
      (e) => e as { code?: string; message?: string; accepted?: unknown },
    )
    expect(err?.code).toBe("E_UNKNOWN_CHECK")
    expect(err?.message).toContain("nope")
    expect(err?.accepted).toBeDefined()
  })

  test("run() with a known id executes and returns the receipt path", async () => {
    const out = await run(stateDir, "w-2222222222222222", "okcheck", [{ id: "okcheck", argv: ["bun", "run", "ok.ts"] }], repoA)
    expect(out.passed).toBe(true)
    expect(out.id).toBe("okcheck")
    expect(out.receipt.endsWith(".log")).toBe(true)
    expect(out.output).toContain("ok")
  })
})
