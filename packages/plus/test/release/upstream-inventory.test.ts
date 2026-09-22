import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  upstreamInventory,
  MissingRefError,
  InventoryError,
  getPackageForFile,
  groupFilesByPackage,
} from "../../script/upstream-inventory.js"

let scratchDir = ""
let repoDir = ""
let baseCommitSha = ""
let forkHeadSha = ""
let upstreamHeadSha = ""

async function runGit(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${stderr || stdout}`)
  }
  return stdout.trim()
}

beforeAll(async () => {
  scratchDir = await mkdtemp(join(tmpdir(), "upstream-inventory-test-"))
  repoDir = join(scratchDir, "repo")
  await mkdir(repoDir, { recursive: true })

  await runGit(repoDir, ["init", "-b", "main"])
  await runGit(repoDir, ["config", "user.name", "Test User"])
  await runGit(repoDir, ["config", "user.email", "test@example.com"])
  await runGit(repoDir, ["config", "commit.gpgsign", "false"])

  await mkdir(join(repoDir, "packages", "core", "src"), { recursive: true })
  await mkdir(join(repoDir, "packages", "plus", "src"), { recursive: true })
  await writeFile(join(repoDir, "packages", "core", "src", "index.ts"), "export const core = 1\n")
  await writeFile(join(repoDir, "packages", "plus", "src", "index.ts"), "export const plus = 1\n")
  await writeFile(join(repoDir, "README.md"), "# Test Project\n")

  await runGit(repoDir, ["add", "-A"])
  await runGit(repoDir, ["commit", "-m", "chore: base commit"])
  baseCommitSha = await runGit(repoDir, ["rev-parse", "HEAD"])

  await runGit(repoDir, ["checkout", "-b", "fork"])
  await mkdir(join(repoDir, "packages", "cli", "src"), { recursive: true })
  await writeFile(join(repoDir, "packages", "core", "src", "index.ts"), "export const core = 2\n")
  await writeFile(join(repoDir, "packages", "cli", "src", "main.ts"), "export const cli = 1\n")
  await runGit(repoDir, ["add", "-A"])
  await runGit(repoDir, ["commit", "-m", "feat(fork): modify core and add cli"])

  await writeFile(join(repoDir, "README.md"), "# Test Project (Fork)\n")
  await runGit(repoDir, ["add", "README.md"])
  await runGit(repoDir, ["commit", "-m", "docs(fork): update readme"])
  forkHeadSha = await runGit(repoDir, ["rev-parse", "HEAD"])

  await runGit(repoDir, ["checkout", "main"])
  await mkdir(join(repoDir, "packages", "server", "src"), { recursive: true })
  await writeFile(join(repoDir, "packages", "core", "src", "index.ts"), "export const core = 3\n")
  await writeFile(join(repoDir, "packages", "server", "src", "server.ts"), "export const server = 1\n")
  await runGit(repoDir, ["add", "-A"])
  await runGit(repoDir, ["commit", "-m", "feat(upstream): modify core and add server"])

  await writeFile(join(repoDir, "packages", "plus", "src", "index.ts"), "export const plus = 2\n")
  await runGit(repoDir, ["add", "-A"])
  await runGit(repoDir, ["commit", "-m", "feat(upstream): update plus"])
  upstreamHeadSha = await runGit(repoDir, ["rev-parse", "HEAD"])
})

afterAll(async () => {
  await rm(scratchDir, { recursive: true, force: true })
})

describe("upstreamInventory", () => {
  test("computes merge-base, ahead/behind counts, changed files, package grouping, and core-touch", async () => {
    const report = await upstreamInventory({
      repoDir,
      baseRef: "main",
      compareRef: "fork",
    })

    expect(report.mergeBase).toBe(baseCommitSha)
    expect(report.ahead).toBe(2)
    expect(report.behind).toBe(2)
    expect(report.commitCounts.ahead).toBe(2)
    expect(report.commitCounts.behind).toBe(2)

    expect(report.forkFiles).toEqual([
      "README.md",
      "packages/cli/src/main.ts",
      "packages/core/src/index.ts",
    ])

    expect(report.coreTouch).toEqual([
      "packages/core/src/index.ts",
    ])

    expect(report.groupedByPackage["root"]).toEqual(["README.md"])
    expect(report.groupedByPackage["packages/cli"]).toEqual(["packages/cli/src/main.ts"])
    expect(report.groupedByPackage["packages/core"]).toEqual(["packages/core/src/index.ts"])

    expect(report.upstreamFiles).toContain("packages/core/src/index.ts")
    expect(report.upstreamFiles).toContain("packages/plus/src/index.ts")
    expect(report.upstreamFiles).toContain("packages/server/src/server.ts")
  })

  test("writes report to explicit outputPath when requested", async () => {
    const outputPath = join(scratchDir, "inventory-out.json")
    const report = await upstreamInventory({
      repoDir,
      baseRef: "main",
      compareRef: "fork",
      outputPath,
    })

    const written = await Bun.file(outputPath).json()
    expect(written.mergeBase).toBe(report.mergeBase)
    expect(written.ahead).toBe(report.ahead)
    expect(written.behind).toBe(report.behind)
    expect(written.coreTouch).toEqual(report.coreTouch)
    expect(written.groupedByPackage).toEqual(report.groupedByPackage)
  })

  test("strictly maintains repository read-only state across inventory runs", async () => {
    const canaryFile = join(repoDir, "canary-untracked.txt")
    await writeFile(canaryFile, "untracked work in progress\n")

    const headBefore = await runGit(repoDir, ["rev-parse", "HEAD"])
    const refsBefore = await runGit(repoDir, ["show-ref"])
    const statusBefore = await runGit(repoDir, ["status", "--porcelain=v1"])

    const report = await upstreamInventory({
      repoDir,
      baseRef: "main",
      compareRef: "fork",
    })

    const headAfter = await runGit(repoDir, ["rev-parse", "HEAD"])
    const refsAfter = await runGit(repoDir, ["show-ref"])
    const statusAfter = await runGit(repoDir, ["status", "--porcelain=v1"])

    await rm(canaryFile, { force: true })

    expect(headAfter).toBe(headBefore)
    expect(refsAfter).toBe(refsBefore)
    expect(statusAfter).toBe(statusBefore)
    expect(report.ahead).toBe(2)
  })

  test("throws typed MissingRefError when refs are missing or invalid", async () => {
    let emptyBaseErr: unknown
    try {
      await upstreamInventory({ repoDir, baseRef: "", compareRef: "fork" })
    } catch (e) {
      emptyBaseErr = e
    }
    expect(emptyBaseErr).toBeInstanceOf(MissingRefError)

    let emptyCompareErr: unknown
    try {
      await upstreamInventory({ repoDir, baseRef: "main", compareRef: "" })
    } catch (e) {
      emptyCompareErr = e
    }
    expect(emptyCompareErr).toBeInstanceOf(MissingRefError)

    let invalidBaseErr: unknown
    try {
      await upstreamInventory({ repoDir, baseRef: "refs/heads/nonexistent-base", compareRef: "fork" })
    } catch (e) {
      invalidBaseErr = e
    }
    expect(invalidBaseErr).toBeInstanceOf(MissingRefError)
    expect((invalidBaseErr as MissingRefError).ref).toBe("refs/heads/nonexistent-base")

    let invalidCompareErr: unknown
    try {
      await upstreamInventory({ repoDir, baseRef: "main", compareRef: "refs/heads/nonexistent-compare" })
    } catch (e) {
      invalidCompareErr = e
    }
    expect(invalidCompareErr).toBeInstanceOf(MissingRefError)
    expect((invalidCompareErr as MissingRefError).ref).toBe("refs/heads/nonexistent-compare")
  })

  test("correctly handles ancestor ref comparison with zero behind count", async () => {
    const report = await upstreamInventory({
      repoDir,
      baseRef: baseCommitSha,
      compareRef: "fork",
    })

    expect(report.mergeBase).toBe(baseCommitSha)
    expect(report.ahead).toBe(2)
    expect(report.behind).toBe(0)
    expect(report.coreTouch).toEqual([])
  })

  test("correctly classifies packages and handles package groupings", () => {
    expect(getPackageForFile("packages/core/src/index.ts")).toBe("packages/core")
    expect(getPackageForFile("packages/console/core/src/model.ts")).toBe("packages/console/core")
    expect(getPackageForFile("packages/stats/app/src/index.ts")).toBe("packages/stats/app")
    expect(getPackageForFile("services/www/src/index.ts")).toBe("services/www")
    expect(getPackageForFile("README.md")).toBe("root")
    expect(getPackageForFile("package.json")).toBe("root")
    expect(getPackageForFile(".github/workflows/ci.yml")).toBe("root")
    expect(getPackageForFile("script/release.ts")).toBe("root")

    const grouped = groupFilesByPackage([
      "README.md",
      "packages/core/src/a.ts",
      "packages/core/src/b.ts",
      "packages/cli/src/c.ts",
    ])

    expect(grouped["root"]).toEqual(["README.md"])
    expect(grouped["packages/core"]).toEqual(["packages/core/src/a.ts", "packages/core/src/b.ts"])
    expect(grouped["packages/cli"]).toEqual(["packages/cli/src/c.ts"])
  })

  test("CLI supports flags and positional arguments", async () => {
    const scriptPath = join(import.meta.dir, "../../script/upstream-inventory.ts")

    const helpProc = Bun.spawn(["bun", scriptPath, "--help"], { stdout: "pipe", stderr: "pipe" })
    const [helpOut, , helpCode] = await Promise.all([
      new Response(helpProc.stdout).text(),
      new Response(helpProc.stderr).text(),
      helpProc.exited,
    ])
    expect(helpCode).toBe(0)
    expect(helpOut).toContain("Usage: bun upstream-inventory.ts")

    const cliProc = Bun.spawn(
      ["bun", scriptPath, "--base", "main", "--compare", "fork", "--repo", repoDir],
      { stdout: "pipe", stderr: "pipe" },
    )
    const [cliOut, , cliCode] = await Promise.all([
      new Response(cliProc.stdout).text(),
      new Response(cliProc.stderr).text(),
      cliProc.exited,
    ])
    expect(cliCode).toBe(0)
    const cliReport = JSON.parse(cliOut)
    expect(cliReport.ahead).toBe(2)
    expect(cliReport.behind).toBe(2)
    expect(cliReport.coreTouch).toEqual(["packages/core/src/index.ts"])

    const posProc = Bun.spawn(["bun", scriptPath, "main", "fork", repoDir], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [posOut, , posCode] = await Promise.all([
      new Response(posProc.stdout).text(),
      new Response(posProc.stderr).text(),
      posProc.exited,
    ])
    expect(posCode).toBe(0)
    const posReport = JSON.parse(posOut)
    expect(posReport.ahead).toBe(2)
    expect(posReport.mergeBase).toBe(baseCommitSha)
  })
})
