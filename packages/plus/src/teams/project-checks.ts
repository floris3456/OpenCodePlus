// Project checks: the commands a team run may be given as checks, named by the
// project's people in `.opencodeplus/checks.json` in the main checkout.
//
// Checks run unattended and without approval, so what runs must be a command
// a person put in the repository, never one a model made up. Before, that was
// enforced by allowing only `bun test FILE` and `bun run SCRIPT` (the test
// file and the package script are the repository's own); a project without
// Bun could have no checks at all. The registry generalises the same rule: any
// command, as long as the project named it. `bun test`/`bun run` stay as a
// built-in for Bun projects.
//
// The file is read from the MAIN checkout (git's common directory), never from
// a run's worktree: a child cannot commit a new command for itself, and
// `.opencodeplus` is protected state no run may checkpoint.
import fs from "node:fs/promises"
import path from "node:path"
import { Option, Schema } from "effect"
import { gitRaw } from "./git.js"
import { checkViolation, toolError, type Check, type CheckSpec } from "./schema.js"

export const PROJECT_CHECKS_FILE = path.join(".opencodeplus", "checks.json")

/** The one placeholder an entry may carry: a repository-relative file or directory the delegator names. */
export const PATH_TOKEN = "{path}"

const Command = Schema.Struct({
  argv: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
  cwd: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
})

export const ProjectChecksFile = Schema.Struct({
  version: Schema.Literal(1),
  /** Run once in a fresh worktree before its first check (dependencies). Replaces the built-in Bun install. */
  setup: Schema.optionalKey(Command),
  checks: Schema.Record(Schema.String, Command),
}).annotate({ identifier: "Plus.ProjectChecksFile" })
export type ProjectChecksFile = typeof ProjectChecksFile.Type

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(ProjectChecksFile))

export interface ProjectCheck {
  readonly id: string
  readonly argv: readonly string[]
  readonly cwd?: string
  readonly description?: string
}

export interface ProjectChecks {
  /** The main checkout the file belongs to. */
  readonly root: string
  readonly checks: readonly ProjectCheck[]
  readonly setup?: { readonly argv: readonly string[]; readonly cwd?: string }
  /** Why the file was ignored, when it exists but is not valid. */
  readonly invalid?: string
}

const ID = /^[a-z0-9][a-z0-9-]{0,47}$/

/** The main checkout of the repository `directory` is in (a linked worktree resolves to its main one). */
export async function mainCheckout(directory: string): Promise<string | undefined> {
  // A directory that is gone (a removed worktree) cannot even start git: that
  // is "no repository here", not an error for the caller.
  const run = (args: string[]) => gitRaw(directory, args).catch(() => ({ code: 1, out: "", err: "" }))
  const common = await run(["rev-parse", "--path-format=absolute", "--git-common-dir"])
  if (common.code !== 0 || common.out.length === 0) return undefined
  if (path.basename(common.out) === ".git") return path.dirname(common.out)
  const top = await run(["rev-parse", "--show-toplevel"])
  return top.code === 0 && top.out.length > 0 ? top.out : undefined
}

// A command's own rules, whatever wrote it: a check id and paths that stay in
// the checkout; at most one {path}, as a whole argument.
function entryProblem(id: string, command: { readonly argv: readonly string[]; readonly cwd?: string }): string | undefined {
  if (!ID.test(id)) return `check id "${id}" must be short kebab-case (a-z, 0-9, -)`
  if (command.argv.some((arg) => arg.includes("\0"))) return `check "${id}" has an invalid argument`
  if (command.argv.filter((arg) => arg.includes(PATH_TOKEN)).length > 1 || command.argv.some((arg) => arg.includes(PATH_TOKEN) && arg !== PATH_TOKEN))
    return `check "${id}" may use ${PATH_TOKEN} once, as a whole argument`
  if (command.argv[0] === PATH_TOKEN) return `check "${id}" cannot run ${PATH_TOKEN} itself`
  if (command.cwd !== undefined && !insideRelative(command.cwd)) return `check "${id}" cwd must stay inside the checkout`
  return undefined
}

function insideRelative(value: string): boolean {
  return value.length > 0 && !path.isAbsolute(value) && !value.split(/[\\/]/).includes("..") && !value.includes("\0")
}

/** Why `value` cannot fill {path}: it must be a plain repository-relative file or directory. */
export function pathProblem(value: string): string | undefined {
  if (!insideRelative(value)) return `"${value}" must be a repository-relative path inside the checkout`
  if (value.startsWith("-")) return `"${value}" cannot start with "-"`
  if (/[*?[\]{}\\]/.test(value)) return `"${value}" cannot contain glob characters`
  return undefined
}

function parse(text: string): { readonly file?: ProjectChecksFile; readonly invalid?: string } {
  const decoded = Option.getOrUndefined(decode(text))
  if (decoded === undefined) return { invalid: `${PROJECT_CHECKS_FILE} is not valid (expected {"version":1,"checks":{"<id>":{"argv":[...]}}})` }
  for (const [id, command] of Object.entries(decoded.checks)) {
    const problem = entryProblem(id, command)
    if (problem !== undefined) return { invalid: `${PROJECT_CHECKS_FILE}: ${problem}` }
  }
  if (decoded.setup !== undefined) {
    if (decoded.setup.argv.some((arg) => arg.includes(PATH_TOKEN))) return { invalid: `${PROJECT_CHECKS_FILE}: setup cannot use ${PATH_TOKEN}` }
    if (decoded.setup.cwd !== undefined && !insideRelative(decoded.setup.cwd)) return { invalid: `${PROJECT_CHECKS_FILE}: setup cwd must stay inside the checkout` }
  }
  return { file: decoded }
}

const cache = new Map<string, { readonly mtimeMs: number; readonly value: ProjectChecks }>()

/** The project's checks for any directory inside the repository (a worktree included); undefined without a file. */
export async function readProjectChecks(directory: string): Promise<ProjectChecks | undefined> {
  const root = await mainCheckout(directory)
  if (root === undefined) return undefined
  const file = path.join(root, PROJECT_CHECKS_FILE)
  const stat = await fs.stat(file).catch(() => undefined)
  if (stat === undefined) return undefined
  const hit = cache.get(file)
  if (hit !== undefined && hit.mtimeMs === stat.mtimeMs) return hit.value
  const parsed = parse(await fs.readFile(file, "utf8"))
  const value: ProjectChecks =
    parsed.file === undefined
      ? { root, checks: [], ...(parsed.invalid === undefined ? {} : { invalid: parsed.invalid }) }
      : {
          root,
          checks: Object.entries(parsed.file.checks)
            .map(([id, command]) => ({
              id,
              argv: [...command.argv],
              ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
              ...(command.description === undefined ? {} : { description: command.description }),
            }))
            .toSorted((left, right) => left.id.localeCompare(right.id)),
          ...(parsed.file.setup === undefined
            ? {}
            : { setup: { argv: [...parsed.file.setup.argv], ...(parsed.file.setup.cwd === undefined ? {} : { cwd: parsed.file.setup.cwd }) } }),
        }
  cache.set(file, { mtimeMs: stat.mtimeMs, value })
  return value
}

/** Write the file (the TUI's confirm step). Every entry is checked first; nothing is written on a problem. */
export async function writeProjectChecks(root: string, file: ProjectChecksFile): Promise<{ readonly ok: true; readonly path: string } | { readonly ok: false; readonly reason: string }> {
  const parsed = parse(JSON.stringify(file))
  if (parsed.file === undefined) return { ok: false, reason: parsed.invalid ?? "invalid" }
  const target = path.join(root, PROJECT_CHECKS_FILE)
  await fs.mkdir(path.dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}.tmp`
  await fs.writeFile(temp, JSON.stringify(file, null, 2) + "\n")
  await fs.rename(temp, target)
  cache.delete(target)
  return { ok: true, path: target }
}

/** One line per check for a tool description or an error: `id (description)`, with `path` noted. */
export function checkList(checks: readonly ProjectCheck[]): string {
  return checks
    .map((check) => {
      const takesPath = check.argv.includes(PATH_TOKEN) ? " — needs path" : ""
      return `${check.id}${check.description === undefined ? "" : ` (${check.description})`}${takesPath}`
    })
    .join("; ")
}

// ── resolving what a delegator wrote ───────────────────────────────────────

const MAX_CHECKS = 12

function refuse(message: string, project: ProjectChecks | undefined): never {
  const listed = project === undefined || project.checks.length === 0 ? undefined : project.checks[0]!
  const accepted =
    listed === undefined
      ? { id: "unit", argv: ["bun", "test", "test/unit.test.ts"] }
      : { id: listed.id, ...(listed.argv.includes(PATH_TOKEN) ? { path: "<file or dir>" } : {}) }
  throw toolError("E_CHECKS", message, accepted)
}

function available(project: ProjectChecks | undefined): string {
  if (project?.invalid !== undefined) return ` ${project.invalid}; fix it in the main checkout. Until then only bun test/bun run commands run.`
  if (project === undefined || project.checks.length === 0)
    return ` This project names no checks (${PROJECT_CHECKS_FILE}; the Project checks command in the TUI suggests them), so only bun test FILE and bun run SCRIPT run.`
  return ` Project checks: ${checkList(project.checks)}.`
}

/**
 * The checks a delegator wrote, resolved to the commands a run stores: a
 * project check by name (`{id}` or `{id, use}`, plus `path` when it needs one),
 * or a Bun command (`argv`). Throws E_CHECKS naming what is available.
 */
export function resolveChecks(inputs: readonly CheckSpec[], project: ProjectChecks | undefined): Check[] {
  if (inputs.length > MAX_CHECKS) refuse(`Use at most ${MAX_CHECKS} focused checks.`, project)
  const out: Check[] = []
  for (const input of inputs) {
    if (!ID.test(input.id)) refuse(`Check id "${input.id}" must be short kebab-case (a-z, 0-9, -).`, project)
    if (out.some((check) => check.id === input.id)) refuse(`Checks need distinct ids; "${input.id}" is used twice (give one an id of your own and use).`, project)
    if (input.argv !== undefined) {
      if (input.use !== undefined || input.path !== undefined) refuse(`Check "${input.id}": give either argv or a project check (use/path), not both.`, project)
      const check: Check = { id: input.id, argv: [...input.argv], ...(input.cwd === undefined ? {} : { cwd: input.cwd }) }
      const violation = checkViolation(check)
      if (violation !== undefined) refuse(`Check "${input.id}": ${violation}${available(project)}`, project)
      out.push(check)
      continue
    }
    const name = input.use ?? input.id
    const named = project?.checks.find((check) => check.id === name)
    if (named === undefined) refuse(`Check "${name}" is not a project check.${available(project)}`, project)
    if (input.cwd !== undefined) refuse(`Check "${input.id}": cwd comes from the project check "${name}"; omit it.`, project)
    const takesPath = named.argv.includes(PATH_TOKEN)
    if (takesPath && input.path === undefined) refuse(`Check "${input.id}": project check "${name}" needs path (a file or directory).`, project)
    if (!takesPath && input.path !== undefined) refuse(`Check "${input.id}": project check "${name}" takes no path.`, project)
    if (input.path !== undefined) {
      const problem = pathProblem(input.path)
      if (problem !== undefined) refuse(`Check "${input.id}": ${problem}.`, project)
    }
    out.push({
      id: input.id,
      argv: named.argv.map((arg) => (arg === PATH_TOKEN ? input.path! : arg)),
      ...(named.cwd === undefined ? {} : { cwd: named.cwd }),
    })
  }
  return out
}

// ── telling the delegator ─────────────────────────────────────────────────

type JsonNode = { description?: string; anyOf?: JsonNode[]; properties?: Record<string, JsonNode> }

/** The line a checks field gains: what this project lets a run be given. */
export function checksNote(project: ProjectChecks | undefined): string {
  if (project?.invalid !== undefined) return `${project.invalid}; until it is fixed only argv bun test/bun run checks run.`
  if (project === undefined || project.checks.length === 0)
    return `This project names no checks (${PROJECT_CHECKS_FILE}): only argv bun test FILE / bun run SCRIPT run.`
  return `Project checks: ${checkList(project.checks)}.`
}

/**
 * Append the project's check list to the checks field of the tools that take
 * checks, so a delegator names a real check the first time. A defaulted
 * field's description sits in its non-null branch, which is where it goes.
 */
export function describeProjectChecks(tools: Record<string, { input: unknown }>, project: ProjectChecks | undefined): void {
  const note = checksNote(project)
  for (const name of ["team_delegate", "team_set_checks"]) {
    const definition = tools[name]
    if (definition === undefined) continue
    const schema = structuredClone(definition.input) as JsonNode
    const field = schema.properties?.checks
    if (field === undefined) continue
    const target = field.description !== undefined ? field : field.anyOf?.find((branch) => branch.description !== undefined) ?? field
    target.description = target.description === undefined ? note : `${target.description} ${note}`
    definition.input = schema
  }
}

// ── suggestions ─────────────────────────────────────────────────────────────

export interface Suggestion extends ProjectCheck {
  /** Where it was found, e.g. "package.json script". */
  readonly source: string
}

export interface Suggestions {
  readonly checks: readonly Suggestion[]
  readonly setup?: ProjectCheck & { readonly source: string }
}

async function exists(file: string): Promise<boolean> {
  return fs.stat(file).then(
    () => true,
    () => false,
  )
}

async function readText(file: string): Promise<string | undefined> {
  return fs.readFile(file, "utf8").catch(() => undefined)
}

const WANTED = ["test", "lint", "typecheck", "check", "build"] as const

function kebab(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
}

/**
 * What a project's own manifests already name: package.json scripts (run with
 * the package manager its lockfile shows), Makefile and justfile targets,
 * pytest, cargo and go. Nothing is written: the person confirms.
 */
export async function suggestChecks(root: string): Promise<Suggestions> {
  const out: Suggestion[] = []
  let setup: Suggestions["setup"]
  const add = (suggestion: Suggestion) => {
    let id = suggestion.id
    for (let n = 2; out.some((entry) => entry.id === id); n++) id = `${suggestion.id}-${n}`
    out.push({ ...suggestion, id })
  }

  const pkg = await readText(path.join(root, "package.json"))
  if (pkg !== undefined) {
    const scripts = (() => {
      try {
        const parsed = JSON.parse(pkg) as { scripts?: Record<string, unknown> }
        return Object.keys(parsed.scripts ?? {})
      } catch {
        return []
      }
    })()
    const manager = (await exists(path.join(root, "bun.lock"))) || (await exists(path.join(root, "bun.lockb")))
      ? "bun"
      : (await exists(path.join(root, "pnpm-lock.yaml")))
        ? "pnpm"
        : (await exists(path.join(root, "yarn.lock")))
          ? "yarn"
          : "npm"
    for (const script of scripts) {
      const wanted = WANTED.some((name) => script === name || script.startsWith(`${name}:`))
      if (!wanted) continue
      add({ id: kebab(script), argv: [manager, "run", script], description: `${script} script`, source: `package.json script (${manager})` })
    }
    if (manager === "bun")
      add({ id: "test-file", argv: ["bun", "test", PATH_TOKEN], description: "one test file or directory", source: "bun test" })
    const install: Record<string, readonly string[]> = {
      bun: ["bun", "install", "--frozen-lockfile", "--ignore-scripts"],
      pnpm: ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts"],
      yarn: ["yarn", "install", "--frozen-lockfile", "--ignore-scripts"],
      npm: ["npm", "ci", "--ignore-scripts"],
    }
    setup = { id: "setup", argv: [...install[manager]!], description: `${manager} dependencies`, source: `${manager} lockfile` }
  }

  if ((await exists(path.join(root, "pyproject.toml"))) || (await exists(path.join(root, "pytest.ini"))) || (await exists(path.join(root, "setup.cfg")))) {
    const uv = await exists(path.join(root, "uv.lock"))
    const poetry = !uv && (await exists(path.join(root, "poetry.lock")))
    const runner = uv ? ["uv", "run", "pytest"] : poetry ? ["poetry", "run", "pytest"] : ["python", "-m", "pytest"]
    add({ id: "pytest", argv: runner, description: "all tests", source: "pytest" })
    add({ id: "pytest-file", argv: [...runner, PATH_TOKEN], description: "one test file or directory", source: "pytest" })
    if (setup === undefined && uv) setup = { id: "setup", argv: ["uv", "sync", "--frozen"], description: "uv dependencies", source: "uv.lock" }
    if (setup === undefined && poetry) setup = { id: "setup", argv: ["poetry", "install", "--no-interaction"], description: "poetry dependencies", source: "poetry.lock" }
  }

  if (await exists(path.join(root, "Cargo.toml"))) {
    add({ id: "cargo-test", argv: ["cargo", "test"], description: "all tests", source: "Cargo.toml" })
    add({ id: "cargo-check", argv: ["cargo", "check", "--all-targets"], description: "type check", source: "Cargo.toml" })
  }

  if (await exists(path.join(root, "go.mod"))) {
    add({ id: "go-test", argv: ["go", "test", "./..."], description: "all tests", source: "go.mod" })
    add({ id: "go-test-pkg", argv: ["go", "test", PATH_TOKEN], description: "one package, e.g. ./pkg/x", source: "go.mod" })
    add({ id: "go-vet", argv: ["go", "vet", "./..."], description: "vet", source: "go.mod" })
  }

  for (const [file, tool] of [
    ["Makefile", "make"],
    ["justfile", "just"],
    ["Justfile", "just"],
  ] as const) {
    const text = await readText(path.join(root, file))
    if (text === undefined) continue
    const targets = new Set(
      [...text.matchAll(tool === "make" ? /^([A-Za-z0-9_.-]+)\s*:(?!=)/gm : /^@?([A-Za-z0-9_-]+)[^\n:=]*:(?!=)/gm)].map((match) => match[1]!),
    )
    for (const name of WANTED)
      if (targets.has(name)) add({ id: `${tool}-${name}`, argv: [tool, name], description: `${file} ${name}`, source: file })
  }

  return { checks: out, ...(setup === undefined ? {} : { setup }) }
}
