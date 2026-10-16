#!/usr/bin/env bun
/**
 * The full test suite a public release runs: `bun run check` at the root, then every package's
 * own `test` script, one package at a time. Each script already runs its files in parallel on
 * every core; running packages side by side would overload the machine and make
 * timing-sensitive tests flaky.
 *
 *   bun packages/plus/script/release/suite.ts --out <dir> [--baseline <previous suite.json>]
 *
 * Writes one log per step and <dir>/suite.json. With --baseline, a failure that the previous
 * release's suite.json also lists is marked "already failing". Exits 1 when anything failed:
 * a public release then stops and the owner decides.
 */
import { mkdir, readdir } from "node:fs/promises"
import path from "node:path"
import { parseArgs } from "node:util"

const LIMIT = 30 * 60_000

if (import.meta.main) await main()

async function main() {
  const args = parseArgs({ options: { out: { type: "string" }, baseline: { type: "string" } } }).values
  if (!args.out) throw new Error("usage: suite.ts --out <dir> [--baseline <suite.json>]")
  const out = path.resolve(args.out)
  await mkdir(out, { recursive: true })
  const repoRoot = path.resolve(import.meta.dir, "../../../..")
  const known = new Set<string>(
    args.baseline ? ((await Bun.file(args.baseline).json()) as Suite).steps.flatMap((step) => step.failures.map((name) => `${step.name}: ${name}`)) : [],
  )
  const packages = (
    await Promise.all(
      (await readdir(path.join(repoRoot, "packages"))).map(async (name) => {
        const file = Bun.file(path.join(repoRoot, "packages", name, "package.json"))
        if (!(await file.exists())) return []
        return (await file.json()).scripts?.test ? [name] : []
      }),
    )
  ).flat()
  const plan = [
    { name: "check", cwd: repoRoot, argv: ["bun", "run", "check"] },
    ...packages.map((name) => ({ name, cwd: path.join(repoRoot, "packages", name), argv: ["bun", "run", "test"] })),
  ]

  const steps: Step[] = []
  for (const item of plan) {
    const started = Date.now()
    process.stdout.write(`· ${item.name}… `)
    const result = Bun.spawnSync(item.argv, { cwd: item.cwd, timeout: LIMIT, stdout: "pipe", stderr: "pipe" })
    const output = `${result.stdout.toString()}${result.stderr.toString()}`
    await Bun.write(path.join(out, `${item.name}.log`), output)
    const failures = [...new Set(output.split("\n").flatMap((line) => /^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/.exec(line.trim())?.[1] ?? []))]
    const step = {
      name: item.name,
      exitCode: result.exitCode ?? -1,
      seconds: Math.round((Date.now() - started) / 1000),
      failures,
      timedOut: result.exitCode === null,
    }
    steps.push(step)
    console.log(step.exitCode === 0 ? `ok (${step.seconds} s)` : `FAILED exit ${step.exitCode} (${step.seconds} s)`)
  }

  const suite: Suite = { steps }
  await Bun.write(path.join(out, "suite.json"), JSON.stringify(suite, null, 2) + "\n")
  const failed = steps.filter((step) => step.exitCode !== 0)
  if (failed.length === 0) {
    console.log(`\nAll ${steps.length} steps passed.`)
    return
  }
  console.log(`\n${failed.length} of ${steps.length} steps failed (logs in ${out}):`)
  failed.forEach((step) => {
    console.log(`- ${step.name}${step.timedOut ? " (timed out)" : ""}`)
    if (step.failures.length === 0) console.log("    no failing test named; see the log")
    step.failures.forEach((name) =>
      console.log(`    ${known.has(`${step.name}: ${name}`) ? "already failing" : "NEW"}  ${name}`),
    )
  })
  process.exit(1)
}

interface Step {
  readonly name: string
  readonly exitCode: number
  readonly seconds: number
  readonly failures: readonly string[]
  readonly timedOut: boolean
}

interface Suite {
  readonly steps: readonly Step[]
}
