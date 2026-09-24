import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execute, lastReceipt, receiptsAt, run, stale } from "../../src/teams/checks.js"
import { verify } from "../../src/teams/audit.js"
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
  // Commit fixtures so the tree is clean: clean-tree receipts are the only
  // ones receiptsAt/stale accept, and the passing-check test asserts that.
  await git(repoA, ["add", "ok.ts", "fail.ts", "loud.ts"])
  await git(repoA, ["commit", "-m", "chore: check fixtures"])
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

  test("a check run on a dirty tree writes a receipt that receiptsAt/stale do not accept", async () => {
    const dir = join(scratch, "repoDirty")
    await initRepo(dir)
    await writeFile(join(dir, "pass.ts"), `console.log("hi");\n`)
    await git(dir, ["add", "pass.ts"])
    await git(dir, ["commit", "-m", "chore: pass fixture"])
    const runID = "w-bbbbbbbbbbbbbbbb"
    const check = { id: "pass", argv: ["bun", "run", "pass.ts"] }
    const head = await git(dir, ["rev-parse", "HEAD"])
    const clean = await execute(stateDir, { runID, check, worktree: dir })
    expect(clean.passed).toBe(true)
    expect(clean.dirty).toBe(false)
    expect(typeof clean.tree).toBe("string")
    expect((await receiptsAt(stateDir, runID, head)).map((r) => r.id)).toContain("pass")
    expect(await stale(stateDir, [check], runID, head)).toEqual([])

    await writeFile(join(dir, "uncommitted.txt"), "dirty\n")
    const res = await execute(stateDir, { runID, check, worktree: dir })
    expect(res.passed).toBe(true)
    expect(res.dirty).toBe(true)
    expect(res.porcelain?.length ?? 0).toBeGreaterThan(0)
    // The dirty receipt overwrote the same HEAD file but must never read
    // as present at HEAD, so finish re-runs instead of trusting it.
    expect(await receiptsAt(stateDir, runID, head)).toEqual([])
    expect(await stale(stateDir, [check], runID, head)).toEqual([check])
  })

  test("a passing check in a worktree whose only untracked content is .opencodeplus/project.json writes a receipt with dirty: false", async () => {
    const dir = join(scratch, "repoPlusOnly")
    await initRepo(dir)
    await writeFile(join(dir, "pass.ts"), `console.log("ok");\n`)
    await git(dir, ["add", "pass.ts"])
    await git(dir, ["commit", "-m", "chore: pass fixture"])
    await mkdir(join(dir, ".opencodeplus"), { recursive: true })
    await writeFile(join(dir, ".opencodeplus", "project.json"), `{"version":1,"protectedAgents":[]}\n`)

    const runID = "w-1111222233334444"
    const check = { id: "pass", argv: ["bun", "run", "pass.ts"] }
    const head = await git(dir, ["rev-parse", "HEAD"])
    const res = await execute(stateDir, { runID, check, worktree: dir })

    expect(res.passed).toBe(true)
    expect(res.dirty).toBe(false)
    expect(res.porcelain).toBeUndefined()
    expect(typeof res.tree).toBe("string")
    expect((await receiptsAt(stateDir, runID, head)).map((r) => r.id)).toContain("pass")
    expect(await stale(stateDir, [check], runID, head)).toEqual([])
  })

  test("a passing check in a worktree that also has an unrelated untracked or modified file writes dirty: true", async () => {
    const dir = join(scratch, "repoPlusDirty")
    await initRepo(dir)
    await writeFile(join(dir, "pass.ts"), `console.log("ok");\n`)
    await git(dir, ["add", "pass.ts"])
    await git(dir, ["commit", "-m", "chore: pass fixture"])
    await mkdir(join(dir, ".opencodeplus"), { recursive: true })
    await writeFile(join(dir, ".opencodeplus", "project.json"), `{"version":1,"protectedAgents":[]}\n`)

    // Unrelated untracked file
    await writeFile(join(dir, "extra.txt"), "hello\n")
    const runID = "w-5555666677778888"
    const check = { id: "pass", argv: ["bun", "run", "pass.ts"] }
    const head = await git(dir, ["rev-parse", "HEAD"])
    const resUntracked = await execute(stateDir, { runID, check, worktree: dir })

    expect(resUntracked.passed).toBe(true)
    expect(resUntracked.dirty).toBe(true)
    expect(resUntracked.porcelain?.length ?? 0).toBeGreaterThan(0)
    expect(await receiptsAt(stateDir, runID, head)).toEqual([])
    expect(await stale(stateDir, [check], runID, head)).toEqual([check])

    // Clean up untracked file, now modify a tracked file
    await rm(join(dir, "extra.txt"))
    await writeFile(join(dir, "pass.ts"), `console.log("modified");\n`)
    const resModified = await execute(stateDir, { runID, check, worktree: dir })
    expect(resModified.passed).toBe(true)
    expect(resModified.dirty).toBe(true)
    expect(resModified.porcelain?.length ?? 0).toBeGreaterThan(0)
    expect(await receiptsAt(stateDir, runID, head)).toEqual([])
    expect(await stale(stateDir, [check], runID, head)).toEqual([check])
  })

  test("a mutating check yields E_CHECK_MUTATED when untracked .opencodeplus/project.json is present", async () => {
    const dir = join(scratch, "repoPlusMut")
    await initRepo(dir)
    await writeFile(
      join(dir, "mut.ts"),
      `import { writeFileSync } from "node:fs";\nwriteFileSync("created.txt", "mutation\\n");\n`,
    )
    await git(dir, ["add", "mut.ts"])
    await git(dir, ["commit", "-m", "chore: mut fixture"])
    await mkdir(join(dir, ".opencodeplus"), { recursive: true })
    await writeFile(join(dir, ".opencodeplus", "project.json"), `{"version":1,"protectedAgents":[]}\n`)

    const runID = "w-9999888877776666"
    const check = { id: "mut", argv: ["bun", "run", "mut.ts"] }
    const res = await execute(stateDir, { runID, check, worktree: dir })

    expect(res.passed).toBe(false)
    expect(res.code).toBe("E_CHECK_MUTATED")
    expect(res.message).toContain("git status changed")
  })

  test("old receipts without the dirty flag fail closed", async () => {
    const runID = "w-c001c001c001c001"
    const head = await git(repoA, ["rev-parse", "HEAD"])
    const check = { id: "oldcheck", argv: ["bun", "run", "ok.ts"] }
    const dir = join(stateDir, "runs", runID, "receipts")
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, `oldcheck-${head.slice(0, 7)}.json`),
      JSON.stringify({
        id: "oldcheck",
        argv: ["bun", "run", "ok.ts"],
        cwd: "",
        head,
        exitCode: 0,
        passed: true,
        at: Date.now(),
        durationMs: 1,
        outputPath: join(dir, `oldcheck-${head.slice(0, 7)}.log`),
      }),
      "utf8",
    )
    expect(await receiptsAt(stateDir, runID, head)).toEqual([])
    expect(await stale(stateDir, [check], runID, head)).toEqual([check])
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

  test("running a check writes receipt.written naming check and head, chain verifies", async () => {
    const runID = "w-a9a9a9a9a9a9a9a9"
    const check = { id: "audit-check", argv: ["bun", "run", "ok.ts"] }
    const head = await git(repoA, ["rev-parse", "HEAD"])
    const res = await execute(stateDir, { runID, check, worktree: repoA })
    expect(res.passed).toBe(true)
    const content = await readFile(join(stateDir, "audit.log"), "utf8")
    const parsed = content
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const matches = parsed.filter((line) => line.kind === "receipt.written" && line.check === "audit-check" && line.run === runID)
    expect(matches.length).toBeGreaterThan(0)
    const line = matches[matches.length - 1] as Record<string, unknown>
    expect(line.head).toBe(head)
    expect(line.passed).toBe(true)
    expect(typeof line.dirty).toBe("boolean")
    const v = await verify(stateDir)
    expect(v.ok).toBe(true)
  })
})

// A delegated worktree is a fresh `git worktree add` with no node_modules, so checks in a
// repository that installs its packages from a Bun lockfile could not import anything.
// The fixtures here are workspace-only, so the frozen install runs offline.
describe("check dependency provisioning", () => {
  async function initWorkspaceRepo(dir: string, lock?: string): Promise<void> {
    await initRepo(dir)
    await mkdir(join(dir, "pkg-a"), { recursive: true })
    await writeFile(join(dir, "package.json"), `{"name":"fixture","private":true,"workspaces":["pkg-a"]}\n`)
    await writeFile(join(dir, "pkg-a", "package.json"), `{"name":"pkg-a","version":"1.0.0"}\n`)
    await writeFile(join(dir, ".gitignore"), "node_modules\n")
    await writeFile(join(dir, "pass.ts"), `console.log("CHECK RAN");\n`)
    if (lock === undefined) {
      const install = Bun.spawnSync(["bun", "install"], { cwd: dir, stdout: "pipe", stderr: "pipe" })
      if (install.exitCode !== 0) throw new Error(`fixture install failed: ${install.stderr.toString()}`)
      await rm(join(dir, "node_modules"), { recursive: true, force: true })
    } else {
      await writeFile(join(dir, "bun.lock"), lock)
    }
    await git(dir, ["add", "-A"])
    await git(dir, ["commit", "-m", "chore: workspace fixture"])
  }

  test("a worktree with a Bun lockfile and no node_modules is installed before its first check", async () => {
    const dir = join(scratch, "repoDeps")
    await initWorkspaceRepo(dir)
    const check = { id: "pass", argv: ["bun", "run", "pass.ts"] }

    const first = await execute(stateDir, { runID: "w-1111222233334444", check, worktree: dir })
    expect(first.passed).toBe(true)
    expect(first.dirty).toBe(false)
    expect(first.code).toBeUndefined()
    const log = await readFile(first.outputPath, "utf8")
    expect(log.startsWith("$ bun install --frozen-lockfile --ignore-scripts\n")).toBe(true)
    expect(log).toContain("CHECK RAN")
    expect((await stat(join(dir, "node_modules"))).isDirectory()).toBe(true)

    // Installed once: a later check in the same worktree does not reinstall.
    const second = await execute(stateDir, { runID: "w-1111222233334444", check, worktree: dir })
    expect(second.passed).toBe(true)
    expect(await readFile(second.outputPath, "utf8")).not.toContain("bun install")
  })

  test("a failed install fails the check without running it", async () => {
    const dir = join(scratch, "repoBadLock")
    await initWorkspaceRepo(dir, "not a lockfile {")
    const res = await execute(stateDir, {
      runID: "w-5555666677778888",
      check: { id: "pass", argv: ["bun", "run", "pass.ts"] },
      worktree: dir,
    })
    expect(res.passed).toBe(false)
    expect(res.code).toBe("E_CHECK_DEPENDENCIES")
    const log = await readFile(res.outputPath, "utf8")
    expect(log).toContain("$ bun install --frozen-lockfile --ignore-scripts")
    expect(log).not.toContain("CHECK RAN")
  })

  test("a worktree without a Bun lockfile runs its check with no install", async () => {
    const res = await execute(stateDir, {
      runID: "w-9999aaaabbbbcccc",
      check: { id: "ok", argv: ["bun", "run", "ok.ts"] },
      worktree: repoA,
    })
    expect(res.passed).toBe(true)
    expect(await readFile(res.outputPath, "utf8")).not.toContain("bun install")
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
