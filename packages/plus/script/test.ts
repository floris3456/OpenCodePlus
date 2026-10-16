// The Plus test run. Every file runs in parallel workers, slowest first
// (test/timings.json); then the files that time themselves or wait on a real
// clock run in a quiet second phase, so their budgets measure the code rather
// than the other workers. With arguments it is plain `bun test <arguments>`.
//
//   bun run test                 both phases
//   bun run test test/foo.test.ts
//   bun run test:timings         refresh test/timings.json from a parallel run

const QUIET = [
  "test/monitor-cache.test.ts",
  "test/perf.test.ts",
  "test/write-path-bench.test.ts",
  "test/instructions-windowing.test.tsx",
  "test/monitor-snapshot.test.ts",
  "test/teams/store.test.ts",
  "test/workspace-route.test.tsx",
  "test/tool-registry-refresh.test.ts",
]

const args = process.argv.slice(2)
if (args.length > 0) process.exit(await run(args))

const busy = await run(["--parallel", "--timings=test/timings.json", ...QUIET.map((file) => `--path-ignore-patterns=${file}`)])
const quiet = await run(["--parallel=3", ...QUIET])
process.exitCode = busy || quiet

function run(argv: string[]) {
  return Bun.spawn({ cmd: [process.execPath, "test", ...argv], stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exited
}
