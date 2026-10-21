// The files a run's checks run. A check judges a run only while the run cannot
// rewrite what the check runs, so a member whose team_checkpoint row
// "Files its checks run stay unchanged" is on (a Basic implementer) commits
// none of the existing ones: its delegator wrote them, and only naming one in
// the Brief's scope.paths hands it over (api.ts checkpointHandler). A missing
// assigned test inside scope is the child's to create.
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
  const named = namedTestFiles(checks)
  const candidates = new Set<string>(named)
  for (const check of checks) {
    const cwd = check.cwd ?? ""
    const [program, verb] = check.argv
    if (program !== undefined && MANAGERS.has(program) && verb === "run") named.add(inside(cwd, "package.json") ?? "package.json")
    for (const file of check.argv.filter((arg) => arg.includes("/") || arg.includes(".")).flatMap((arg) => inside(cwd, arg) ?? []))
      candidates.add(file)
  }
  if (candidates.size === 0) return named
  const held = await lsTree(directory, base, [...candidates])
  // A named path the base holds as a directory is its files, not itself.
  const directories = [...named].filter((file) => held.some((entry) => entry.startsWith(`${file}/`)))
  return new Set([...[...named].filter((file) => !directories.includes(file)), ...held])
}

/** The repository-relative `bun test` files and directories a check names, in check order. */
function namedTestFiles(checks: readonly Check[]): Set<string> {
  const named = new Set<string>()
  for (const check of checks) {
    const [program, verb, ...rest] = check.argv
    if (program !== "bun" || verb !== "test") continue
    for (const file of rest.flatMap((arg) => inside(check.cwd ?? "", arg) ?? [])) named.add(file)
  }
  return named
}

/**
 * Every `bun test` file or directory a check names that the base commit does
 * not hold. A missing one outside writable scope refuses the delegation: a
 * check that can never pass judges nothing. A named directory the base holds
 * with files under it counts as present (new files under it are free).
 */
export async function missingCheckFiles(directory: string, base: string, checks: readonly Check[]): Promise<{ id: string; file: string }[]> {
  const missing: { id: string; file: string }[] = []
  for (const check of checks) {
    const [program, verb, ...rest] = check.argv
    if (program !== "bun" || verb !== "test") continue
    const named = [...new Set(rest.flatMap((arg) => inside(check.cwd ?? "", arg) ?? []))]
    if (named.length === 0) continue
    const held = await lsTree(directory, base, named)
    for (const file of named) {
      if (held.includes(file) || held.some((entry) => entry.startsWith(`${file}/`))) continue
      missing.push({ id: check.id, file })
    }
  }
  return missing
}

/**
 * The scope paths (as written) that name a file or directory the base commit
 * does not hold, for the Brief to mark new: implementers spent a call reading
 * a test file their Brief named that they were to create. Patterns are left
 * out; they name no one file.
 */
export async function pathsNotAt(directory: string, base: string, paths: readonly string[]): Promise<string[]> {
  const literal = paths.flatMap((entry) => {
    if (/[*?[]/.test(entry)) return []
    const file = inside("", entry)
    return file === undefined ? [] : [{ entry, file }]
  })
  const held = await lsTree(directory, base, literal.map((item) => item.file)).catch(() => undefined)
  if (held === undefined) return []
  return literal.filter((item) => !held.some((found) => found === item.file || found.startsWith(`${item.file}/`))).map((item) => item.entry)
}

async function lsTree(directory: string, base: string, candidates: readonly string[]): Promise<string[]> {
  if (candidates.length === 0) return []
  return (await git(directory, [...NO_REPOSITORY_PROGRAMS, "--literal-pathspecs", "ls-tree", "-r", "--name-only", "-z", base, "--", ...candidates]))
    .split("\0")
    .filter(Boolean)
}
