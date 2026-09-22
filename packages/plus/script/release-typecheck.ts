import { resolve } from "node:path"

const repoRoot = resolve(import.meta.dir, "../../..")

const packages = [
  "cli",
  "client",
  "core",
  "util",
  "tui",
  "plus",
  "server",
  "protocol",
  "schema",
]

const results = []

for (const pkg of packages) {
  const pkgDir = resolve(repoRoot, "packages", pkg)
  console.log(`\n=== Running typecheck for ${pkg} in ${pkgDir} ===`)
  const proc = Bun.spawn(["bun", "run", "typecheck"], {
    cwd: pkgDir,
    stdout: "inherit",
    stderr: "inherit",
  })
  const exitCode = await proc.exited
  console.log(`Package ${pkg} finished with exit code ${exitCode}`)
  results.push({ pkg, exitCode })
}

console.log("\n=== Typecheck Summary ===")
for (const { pkg, exitCode } of results) {
  console.log(`${pkg}: ${exitCode === 0 ? "PASSED (0)" : `FAILED (${exitCode})`}`)
}

const failed = results.filter((result) => result.exitCode !== 0)
if (failed.length > 0) {
  process.exit(1)
}
