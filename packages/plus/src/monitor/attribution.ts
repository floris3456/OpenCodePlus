// How a step's tokens become per-tool numbers, and what a call is "about".
//
// Providers bill per step (one LLM call), never per tool, so every per-tool
// figure is an attribution:
//   call   — the share of the step's visible output tokens spent writing the
//            call's input, split by size across the step's text and calls;
//   result — the tokens the result added to the next prompt, measured as the
//            next step's prompt growth over this step's (minus this step's own
//            output) and split across the step's results by size; estimated
//            from the result's length when no clean next step exists;
//   carried — the result re-read by every later step until the next
//            compaction, derived at query time (never stored).
import path from "node:path"
import { sha256 } from "./fingerprint.js"

// Measured prompt growth over result characters on real sessions of this
// workspace (7 804 clean tool steps, 2026-09-29): median 1.58 tokens per four
// characters, so a result costs about one token per 2.5 characters. Used only
// when a measurement is impossible, and marked as an estimate.
export const CHARS_PER_TOKEN = 2.5

export function estimateTokens(chars: number): number {
  return chars <= 0 ? 0 : Math.ceil(chars / CHARS_PER_TOKEN)
}

/** Split `total` across `weights` proportionally, in whole tokens that sum to `total`. */
export function split(total: number, weights: readonly number[]): number[] {
  if (weights.length === 0 || total <= 0) return weights.map(() => 0)
  const sum = weights.reduce((acc, weight) => acc + Math.max(0, weight), 0)
  const shares =
    sum === 0 ? weights.map(() => total / weights.length) : weights.map((weight) => (total * Math.max(0, weight)) / sum)
  const floors = shares.map(Math.floor)
  const remainder = total - floors.reduce((acc, value) => acc + value, 0)
  // Largest remainders take the leftover tokens, so the parts sum exactly.
  const order = shares
    .map((share, index) => ({ index, frac: share - Math.floor(share) }))
    .sort((a, b) => b.frac - a.frac || a.index - b.index)
  return floors.map((value, index) => value + (order.findIndex((entry) => entry.index === index) < remainder ? 1 : 0))
}

/** The prompt a step sent: fresh input plus cache reads and writes. */
export function promptTokens(usage: {
  readonly input: number
  readonly cacheRead: number
  readonly cacheWrite: number
}): number {
  return usage.input + usage.cacheRead + usage.cacheWrite
}

const MAX_TARGET = 80
// Web tools, by their current ids and the ids calls were recorded under before (tool-renames.ts).
const pageTools = new Set(["webfetch", "web_opencode_fetch", "web_chatgpt_fetch", "web_chatgpt_open"])
const searchTools = new Set(["websearch", "web_opencode_search", "web_chatgpt_search", "web_tavily_search", "web_exa_code_search"])

/**
 * A short, secret-free description of what a call touched: a shell command's
 * program and recognized subcommand, a file path, a glob pattern, a host, or a
 * recognized identifier. A content search (grep pattern, websearch query) is
 * reduced to a stable hash plus its size; the text itself never persists.
 */
export function targetOf(
  tool: string,
  input: Readonly<Record<string, unknown>>,
  directory?: string,
): string | undefined {
  const text = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : undefined)
  const file = text("path") ?? text("filePath") ?? text("file_path")
  if (tool === "shell" || tool === "bash") return commandHead(text("command"))
  if (
    file !== undefined &&
    (tool === "read" || tool === "edit" || tool === "write" || tool.endsWith("_read") || tool.endsWith("_write"))
  )
    return clip(relative(file, directory), "left")
  if (tool === "patch") return patchFiles(text("patchText"))
  // A glob names files (path semantics); a grep pattern names content.
  if (tool === "glob") return clip(text("pattern"), "right")
  if (tool === "grep") return contentSummary(text("pattern"))
  if (pageTools.has(tool)) return hostOf(text("url"))
  if (searchTools.has(tool)) return contentSummary(text("query"))
  if (tool === "subagent") return text("agent")
  if (tool === "skill") return text("id") ?? text("name")
  if (tool === "team_delegate") return text("role")
  if (tool === "team_followup" || tool === "team_stop" || tool === "team_integrate") return text("run")
  return undefined
}

// "cd packages/plus && FOO=1 bun test x.ts | tail" → "bun test". The first
// segment that is not a cd, without variable assignments. A second word is
// kept only when it is one of the program's recognized subcommands, so
// `git diff` and `bun test` survive while `echo <text>`, `curl <payload>`, an
// arbitrary lower-case word, or `git <fictional-payload>` do not. The
// allowlist holds actual subcommand names only; an unrecognized argument falls
// back to the bare program.
const RECOGNIZED_SUBCOMMANDS: Readonly<Record<string, ReadonlySet<string>>> = {
  git: new Set(["add", "branch", "checkout", "cherry-pick", "commit", "config", "diff", "fetch", "log", "merge", "mv", "pull", "push", "rebase", "remote", "reset", "restore", "revert", "rm", "show", "stash", "status", "switch", "tag", "worktree"]),
  bun: new Set(["add", "build", "install", "link", "remove", "run", "test", "update", "x"]),
  npm: new Set(["ci", "exec", "init", "install", "link", "publish", "run", "test", "uninstall", "update", "view"]),
  pnpm: new Set(["add", "dlx", "exec", "install", "link", "publish", "remove", "run", "test", "update"]),
  yarn: new Set(["add", "dlx", "install", "link", "publish", "remove", "run", "test", "upgrade"]),
  docker: new Set(["build", "builder", "compose", "container", "exec", "image", "logs", "network", "ps", "pull", "push", "rm", "run", "stop", "volume"]),
  kubectl: new Set(["apply", "config", "delete", "describe", "exec", "get", "kustomize", "logs", "rollout", "scale"]),
  cargo: new Set(["add", "build", "check", "clippy", "fmt", "install", "publish", "remove", "run", "test", "update"]),
  go: new Set(["build", "env", "generate", "get", "install", "mod", "run", "test", "vet", "work"]),
  gh: new Set(["api", "auth", "issue", "pr", "release", "repo", "run", "workflow"]),
  terraform: new Set(["apply", "destroy", "fmt", "init", "output", "plan", "state", "validate", "workspace"]),
}

export function commandHead(command: string | undefined): string | undefined {
  if (command === undefined) return undefined
  const segment = command
    .split(/&&|\|\||;|\||\n/)
    .map((part) => part.trim())
    .find((part) => part.length > 0 && !/^cd(\s|$)/.test(part))
  if (segment === undefined) return undefined
  const words = segment.split(/\s+/).filter((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word))
  const program = words[0]?.split("/").pop()
  if (program === undefined || program.length === 0) return undefined
  const sub = words[1]
  return sub !== undefined && /^[a-z][a-z0-9:_-]*$/.test(sub) && RECOGNIZED_SUBCOMMANDS[program]?.has(sub)
    ? clip(`${program} ${sub}`, "right")
    : clip(program, "right")
}

/** Stable content-free stand-in for a search term: its hash and its size. */
function contentSummary(text: string | undefined): string | undefined {
  if (text === undefined || text.length === 0) return undefined
  return `${sha256(text)} ${text.length}c`
}

function patchFiles(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  const files = [...text.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((match) => match[1]?.trim() ?? "")
  if (files.length === 0) return undefined
  const first = files[0] ?? ""
  return clip(files.length === 1 ? first : `${first} +${files.length - 1}`, "left")
}

function hostOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined
  return URL.canParse(url) ? new URL(url).hostname : undefined
}

function relative(file: string, directory: string | undefined): string {
  if (directory === undefined || !path.isAbsolute(file)) return file
  const rel = path.relative(directory, file)
  return rel.startsWith("..") ? file : rel
}

function clip(value: string | undefined, side: "left" | "right"): string | undefined {
  if (value === undefined) return undefined
  const single = value.replace(/\s+/g, " ").trim()
  if (single.length <= MAX_TARGET) return single
  return side === "left" ? `…${single.slice(single.length - MAX_TARGET + 1)}` : `${single.slice(0, MAX_TARGET - 1)}…`
}
