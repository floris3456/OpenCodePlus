// The files a run's checks run. A check judges a run only while the run cannot
// rewrite what the check runs, so a member whose team_checkpoint row
// "Files its checks run stay unchanged" is on (a Basic implementer) commits
// none of them: its delegator wrote them, and only naming one in the Brief's
// scope.paths hands it over (api.ts checkpointHandler).
//
// A check's files, read from its stored argv against the run's base commit:
// - every file a `bun test` check names, even one the base does not hold yet,
//   and every file the base holds under a directory it names;
// - the package.json a `<manager> run SCRIPT` check reads (in the check's cwd);
// - any other argument that names a path (it has a "/" or a ".") and the base
//   holds as a file, or as a directory with files under it.
// New files under a named directory stay free: they add tests, never weaken
// the ones the check already ran. The repository root itself is never one.
import path from "node:path"
import { git } from "./git.js"
import type { Check } from "./schema.js"
import { NO_REPOSITORY_PROGRAMS } from "./worktree.js"

const MANAGERS = new Set(["bun", "npm", "pnpm", "yarn"])

// A repository-relative path for `arg` run in `cwd`, or undefined when it
// leaves the checkout or is the checkout itself.
function inside(cwd: string, arg: string): string | undefined {
  if (arg.startsWith("-") || path.posix.isAbsolute(arg)) return undefined
  const joined = path.posix.normalize(path.posix.join(cwd, arg)).replace(/\/+$/, "")
  if (joined === "" || joined === "." || joined === ".." || joined.startsWith("../")) return undefined
  return joined
}

export async function checkFiles(directory: string, base: string, checks: readonly Check[]): Promise<Set<string>> {
  // Paths a check names as files whether or not the base holds them yet.
  const named = new Set<string>()
  const candidates = new Set<string>()
  for (const check of checks) {
    const cwd = check.cwd ?? ""
    const [program, verb, ...rest] = check.argv
    if (program === "bun" && verb === "test") {
      for (const file of rest.flatMap((arg) => inside(cwd, arg) ?? [])) {
        named.add(file)
        candidates.add(file)
      }
      continue
    }
    if (program !== undefined && MANAGERS.has(program) && verb === "run") named.add(inside(cwd, "package.json") ?? "package.json")
    for (const file of check.argv.filter((arg) => arg.includes("/") || arg.includes(".")).flatMap((arg) => inside(cwd, arg) ?? []))
      candidates.add(file)
  }
  if (candidates.size === 0) return named
  const held = (await git(directory, [...NO_REPOSITORY_PROGRAMS, "--literal-pathspecs", "ls-tree", "-r", "--name-only", "-z", base, "--", ...candidates]))
    .split("\0")
    .filter(Boolean)
  // A named path the base holds as a directory is its files, not itself.
  const directories = [...named].filter((file) => held.some((entry) => entry.startsWith(`${file}/`)))
  return new Set([...[...named].filter((file) => !directories.includes(file)), ...held])
}
