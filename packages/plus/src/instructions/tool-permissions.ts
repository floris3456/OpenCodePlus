// Curated tool permission rules plus the one shared keyword derivation.
//
// Phase-1 foundation only: this module holds view-time data. It persists
// nothing and is not reachable from the publish fingerprint. Phase 3 mines
// user-added rules from history and populates subagent/skill entries from
// discovery; both flow through keywordsForPattern and mergeRules here.
//
// This module must not import from core: plus depends only on
// @opencode/plugin and @opencode/schema. Core's shell ARITY table
// (packages/core/src/shell/parse.ts) is not exported, so the command-head
// depths below are Plus's own table.

export interface CuratedRule {
  readonly tool: string
  readonly id: string
  readonly label: string
  readonly patterns: readonly string[]
  readonly keywords: readonly string[]
}

export interface DiscoveredRule {
  readonly id: string
  readonly label: string
  readonly patterns: readonly string[]
  readonly keywords: readonly string[]
  // Which items mentioned it; most-mentioned sorts first in mergeRules.
  readonly provenance: readonly string[]
  /** Phase-3 miner sets the parent tool id (e.g. "shell", "edit"); absent in phase-1 fixtures. */
  readonly tool?: string
}

export interface MergedRule {
  readonly id: string
  readonly label: string
  readonly patterns: readonly string[]
  readonly keywords: readonly string[]
  readonly provenance: readonly string[]
}

// How deep each known command head's subcommands go, so phase 3's miner can
// build patterns like `git rebase *` (depth 2) or `rm *` (depth 1).
export const commandHeads: Record<string, number> = {
  git: 2,
  rm: 1,
  sudo: 1,
  chmod: 1,
  chown: 1,
  curl: 1,
  wget: 1,
  ssh: 1,
  scp: 1,
  docker: 2,
  kubectl: 2,
  npm: 2,
  pnpm: 2,
  yarn: 2,
  bun: 2,
  pip: 2,
  kill: 1,
  pkill: 1,
  dd: 1,
  mkfs: 1,
  env: 1,
  printenv: 1,
  export: 1,
}

// THE ONE shared function deriving scrub keywords from a pattern. Both the
// curated defaults below and phase 3's user-added-rule defaults come from
// here; nothing else may derive keywords. Head word plus subcommand words,
// stopping at the first wildcard or flag: "git push *" -> ["git push"], not
// ["git"]. A pattern with no literal leading word (globs, URLs) falls back to
// its first meaningful segment: "**/.git/**" -> [".git"].
export function keywordsForPattern(pattern: string): string[] {
  const tokens = pattern.trim().split(/\s+/).filter((token) => token.length > 0)
  const stop = tokens.findIndex((token) => token.includes("*") || token.includes("?") || token.startsWith("-"))
  const words = stop === -1 ? tokens : tokens.slice(0, stop)
  if (words.length > 0) return [words.join(" ")]
  const segments = pattern.split(/[^A-Za-z0-9._-]+/).filter((segment) => segment.length > 0)
  const first = segments[0]
  if (first === undefined) return []
  return [first]
}

interface RawRule {
  readonly tool: string
  readonly id: string
  readonly label: string
  readonly patterns: readonly string[]
}

// Raw curated entries: label plus patterns grouped by tool action. Keywords
// are derived once at module load through keywordsForPattern, never written
// by hand. For shell the permission resource is the PARSED COMMAND TEXT, so a
// head-only rule carries both the bare head and the `*` pattern: `git *`
// matches `git push`, and the bare `git` pins the exact head.
const rawRules: readonly RawRule[] = [
  { tool: "shell", id: "git", label: "Git", patterns: ["git", "git *"] },
  { tool: "shell", id: "git-push", label: "Git push", patterns: ["git push *"] },
  { tool: "shell", id: "git-commit", label: "Git commit", patterns: ["git commit *"] },
  {
    tool: "shell",
    id: "git-rewrite",
    label: "Git history rewrites",
    patterns: ["git reset *", "git checkout *", "git rebase *"],
  },
  { tool: "shell", id: "rm", label: "Remove files", patterns: ["rm", "rm *"] },
  { tool: "shell", id: "rm-rf", label: "Recursive force remove", patterns: ["rm -rf *"] },
  { tool: "shell", id: "sudo", label: "Sudo", patterns: ["sudo", "sudo *"] },
  { tool: "shell", id: "chmod-chown", label: "Change permissions or ownership", patterns: ["chmod *", "chown *"] },
  { tool: "shell", id: "curl-wget", label: "Download with curl or wget", patterns: ["curl *", "wget *"] },
  { tool: "shell", id: "ssh-scp", label: "SSH or SCP", patterns: ["ssh *", "scp *"] },
  { tool: "shell", id: "docker", label: "Docker", patterns: ["docker", "docker *"] },
  { tool: "shell", id: "kubectl", label: "Kubectl", patterns: ["kubectl", "kubectl *"] },
  {
    tool: "shell",
    id: "js-install",
    label: "JavaScript package install",
    patterns: ["npm install *", "pnpm install *", "yarn install *", "bun install *"],
  },
  { tool: "shell", id: "npm-publish", label: "npm publish", patterns: ["npm publish *"] },
  { tool: "shell", id: "pip-install", label: "pip install", patterns: ["pip install *"] },
  { tool: "shell", id: "kill", label: "Kill processes", patterns: ["kill *", "pkill *"] },
  { tool: "shell", id: "disk-destructive", label: "Disk destructive", patterns: ["dd *", "mkfs *"] },
  {
    tool: "shell",
    id: "env",
    label: "Environment inspection",
    patterns: ["env", "env *", "printenv", "printenv *", "export", "export *"],
  },
  {
    tool: "shell",
    id: "package-scripts",
    label: "Package scripts",
    patterns: ["npm run *", "npm test *", "pnpm run *", "yarn run *", "bun run *", "bun test *"],
  },
  { tool: "edit", id: "env", label: ".env files", patterns: ["*.env*"] },
  { tool: "edit", id: "lock", label: "Lockfiles", patterns: ["**/*.lock"] },
  { tool: "edit", id: "package-json", label: "package.json", patterns: ["package.json"] },
  { tool: "edit", id: "git", label: "Git internals", patterns: ["**/.git/**"] },
  { tool: "edit", id: "ssh", label: "SSH keys", patterns: ["~/.ssh/**"] },
  { tool: "write", id: "env", label: ".env files", patterns: ["*.env*"] },
  { tool: "write", id: "lock", label: "Lockfiles", patterns: ["**/*.lock"] },
  { tool: "write", id: "package-json", label: "package.json", patterns: ["package.json"] },
  { tool: "write", id: "git", label: "Git internals", patterns: ["**/.git/**"] },
  { tool: "write", id: "ssh", label: "SSH keys", patterns: ["~/.ssh/**"] },
  { tool: "read", id: "env", label: ".env files", patterns: ["*.env*"] },
  { tool: "read", id: "lock", label: "Lockfiles", patterns: ["**/*.lock"] },
  { tool: "read", id: "package-json", label: "package.json", patterns: ["package.json"] },
  { tool: "read", id: "git", label: "Git internals", patterns: ["**/.git/**"] },
  { tool: "read", id: "ssh", label: "SSH keys", patterns: ["~/.ssh/**"] },
  { tool: "webfetch", id: "http", label: "Plain HTTP", patterns: ["http://*"] },
  { tool: "webfetch", id: "github", label: "GitHub", patterns: ["*github.com*"] },
  { tool: "webfetch", id: "localhost", label: "Localhost", patterns: ["*localhost*"] },
  { tool: "glob", id: "node-modules", label: "node_modules", patterns: ["**/node_modules/**"] },
  { tool: "glob", id: "git", label: "Git internals", patterns: ["**/.git/**"] },
  { tool: "grep", id: "node-modules", label: "node_modules", patterns: ["**/node_modules/**"] },
  { tool: "grep", id: "git", label: "Git internals", patterns: ["**/.git/**"] },
]

export const curatedRules: readonly CuratedRule[] = rawRules.map((rule) => ({
  tool: rule.tool,
  id: rule.id,
  label: rule.label,
  patterns: [...rule.patterns],
  keywords: [...new Set(rule.patterns.flatMap(keywordsForPattern))],
}))

// Subagent and skill rules populate from discovered agents/skills at
// discovery time (phase 3), so names are never hardcoded: one rule per id
// matching exactly that id.
export function idRules(tool: string, ids: readonly string[]): CuratedRule[] {
  return ids.map((id) => ({
    tool,
    id,
    label: id,
    patterns: [id],
    keywords: keywordsForPattern(id),
  }))
}

// Merge curated defaults with mined discoveries by pattern set. The CURATED
// LABEL (plus id and keywords) WINS on a collision; the discovered
// provenance stays. Order: most-mentioned discovered first, then the curated
// generics nobody mentioned.
export function mergeRules(curated: readonly CuratedRule[], discovered: readonly DiscoveredRule[]): MergedRule[] {
  const byPatterns = new Map(curated.map((rule) => [patternKey(rule.patterns), rule]))
  const consumed = new Set<string>()
  const ranked = [...discovered].toSorted((left, right) => right.provenance.length - left.provenance.length)
  const merged = ranked.map((entry) => {
    const key = patternKey(entry.patterns)
    const match = byPatterns.get(key)
    if (match === undefined) return { id: entry.id, label: entry.label, patterns: [...entry.patterns], keywords: [...entry.keywords], provenance: [...entry.provenance] }
    consumed.add(key)
    return {
      id: match.id,
      label: match.label,
      patterns: [...match.patterns],
      keywords: [...match.keywords],
      provenance: [...entry.provenance],
    }
  })
  const generics = curated
    .filter((rule) => !consumed.has(patternKey(rule.patterns)))
    .map((rule) => ({ id: rule.id, label: rule.label, patterns: [...rule.patterns], keywords: [...rule.keywords], provenance: [] }))
  return [...merged, ...generics]
}

function patternKey(patterns: readonly string[]): string {
  return [...patterns].toSorted().join("\n")
}

// Core permission action for a Plus tool id. Edit, write, and patch share
// core's `edit` action (core/src/tool/plugin/edit.ts, write.ts, patch.ts all
// assert `action: "edit"`); every other tool asserts its own id. Plus rows
// are keyed by tool id, so write/patch rules install as `edit` to actually
// match core's evaluation.
export function actionForToolId(toolId: string): string {
  if (toolId === "write" || toolId === "patch" || toolId === "edit") return "edit"
  return toolId
}

// Line-level whole-word scrub: drop every line containing any keyword as a
// whole word/phrase (case-insensitive), keeping the rest in order. Whole-word
// means the match is not part of a larger alphanumeric word: "git" does not
// scrub "gitpush", but "git push" scrubs "run git push origin". Keywords come
// only from keywordsForPattern (head plus subcommands), so "git push *"
// scrubs "git push" lines, not every "git" line.
export function scrubLines(text: string, keywords: readonly string[]): { text: string; hidden: number; preview: readonly string[] } {
  const active = keywords.filter((keyword) => keyword.length > 0)
  if (active.length === 0) return { text, hidden: 0, preview: [] }
  const lines = text.split("\n")
  const kept: string[] = []
  const dropped: string[] = []
  for (const line of lines) {
    if (active.some((keyword) => containsWholeWord(line, keyword))) dropped.push(line)
    else kept.push(line)
  }
  return { text: kept.join("\n"), hidden: dropped.length, preview: dropped.slice(0, 3) }
}

export function containsWholeWord(line: string, keyword: string): boolean {
  const hay = line.toLowerCase()
  const needle = keyword.toLowerCase()
  if (needle.length === 0) return false
  let from = 0
  while (true) {
    const at = hay.indexOf(needle, from)
    if (at === -1) return false
    if (isWordBoundary(hay, at, at + needle.length)) return true
    from = at + 1
  }
}

function isWordBoundary(hay: string, start: number, end: number): boolean {
  const before = start === 0 ? undefined : hay[start - 1]
  const after = end >= hay.length ? undefined : hay[end]
  return !isWordChar(before) && !isWordChar(after)
}

function isWordChar(char: string | undefined): boolean {
  if (char === undefined) return false
  const code = char.charCodeAt(0)
  if (code >= 48 && code <= 57) return true
  if (code >= 65 && code <= 90) return true
  if (code >= 97 && code <= 122) return true
  return char === "_"
}

// Mine view-time permission candidates from text Plus already holds. Inputs
// are `{ item, text }` pairs where `item` is the inventory item id (e.g.
// "tool:shell", "base:gpt", "skill:notes") used as provenance. Agents and
// skills feed subagent/skill idRules provenance: a known id mentioned as a
// whole word becomes a discovered candidate for that tool, so the curated
// idRule (empty provenance) merges into a ranked row with provenance.
export function mineDiscoveredRules(input: {
  readonly texts: readonly { readonly item: string; readonly text: string }[]
  readonly agents?: readonly string[]
  readonly skills?: readonly string[]
}): DiscoveredRule[] {
  const byKey = new Map<string, { tool: string; id: string; label: string; patterns: string[]; keywords: string[]; provenance: Set<string> }>()
  const add = (tool: string, id: string, label: string, patterns: readonly string[], item: string) => {
    const key = `${tool}\n${[...patterns].toSorted().join("\n")}`
    const existing = byKey.get(key)
    const keywords = [...new Set(patterns.flatMap(keywordsForPattern))]
    if (existing === undefined) {
      byKey.set(key, { tool, id, label, patterns: [...patterns], keywords, provenance: new Set([item]) })
      return
    }
    existing.provenance.add(item)
  }
  for (const entry of input.texts) {
    const text = entry.text
    if (text.length === 0) continue
    for (const mined of mineCommands(text)) add("shell", mined.id, mined.label, mined.patterns, entry.item)
    for (const mined of mineFiles(text)) add(mined.tool, mined.id, mined.label, mined.patterns, entry.item)
    for (const mined of mineUrls(text)) add(mined.tool, mined.id, mined.label, mined.patterns, entry.item)
  }
  const agents = input.agents ?? []
  const skills = input.skills ?? []
  if (agents.length > 0 || skills.length > 0) {
    for (const entry of input.texts) {
      for (const id of agents) {
        if (containsWholeWord(entry.text, id)) add("subagent", id, id, [id], entry.item)
      }
      for (const id of skills) {
        if (containsWholeWord(entry.text, id)) add("skill", id, id, [id], entry.item)
      }
    }
  }
  return [...byKey.values()]
    .map((entry) => ({ id: entry.id, label: entry.label, patterns: entry.patterns, keywords: entry.keywords, provenance: [...entry.provenance].toSorted(), tool: entry.tool }))
    .toSorted((left, right) => {
      if (left.tool !== right.tool) return left.tool < right.tool ? -1 : 1
      if (left.id !== right.id) return left.id < right.id ? -1 : 1
      return 0
    })
}

interface MinedCommand {
  readonly id: string
  readonly label: string
  readonly patterns: readonly string[]
}

function mineCommands(text: string): MinedCommand[] {
  const out: MinedCommand[] = []
  const seen = new Set<string>()
  const pushLine = (line: string) => {
    const cleaned = line.trim().replace(/^[$>\s\-*`'"]+/, "").replace(/[`'"]+$/, "").trim()
    if (cleaned.length === 0) return
    const tokens = cleaned.split(/\s+/).filter((token) => token.length > 0)
    const rawHead = tokens[0] ?? ""
    const head = rawHead.toLowerCase().replace(/[^a-z0-9]+$/g, "").replace(/^[^a-z0-9]+/g, "")
    const depth = commandHeads[head]
    if (depth === undefined) return
    const rest = tokens.slice(1).map((token) => token.replace(/[`'";,]+$/g, ""))
    const flags = rest.filter((token) => token.startsWith("-") && token.length > 1)
    const words = rest
      .map((token) => token.replace(/^[^A-Za-z0-9._/-]+|[^A-Za-z0-9._/-]+$/g, ""))
      .filter((token) => token.length > 0 && !token.startsWith("-") && token !== "|" && token !== "&&" && token !== ";")
    const chosen = [head, ...words.slice(0, depth - 1)]
    const flag = flags[0]?.replace(/[`'";,]+$/g, "")
    const patternWords = flag === undefined ? chosen : [...chosen, flag]
    if (patternWords.length === 0) return
    const label = patternWords.join(" ")
    const pattern = `${label} *`
    const key = pattern.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push({ id: slugify(label), label, patterns: [pattern] })
  }
  for (const line of text.split("\n")) pushLine(line)
  for (const span of codeSpans(text)) {
    for (const line of span.split("\n")) pushLine(line)
  }
  return out
}

function codeSpans(text: string): string[] {
  const spans: string[] = []
  const fenced = text.match(/```[\s\S]*?```/g) ?? []
  for (const block of fenced) {
    const inner = block.replace(/^```[^\n]*\n/, "").replace(/```$/g, "")
    spans.push(inner)
  }
  const inline = text.match(/`[^`\n]+`/g) ?? []
  for (const code of inline) spans.push(code.slice(1, -1))
  return spans
}

interface MinedFile {
  readonly tool: string
  readonly id: string
  readonly label: string
  readonly patterns: readonly string[]
}

function mineFiles(text: string): MinedFile[] {
  const out: MinedFile[] = []
  const lower = text.toLowerCase()
  const has = (needle: string) => lower.includes(needle)
  if (has(".env")) {
    for (const tool of ["edit", "write", "read"]) out.push({ tool, id: "env", label: ".env files", patterns: ["*.env*"] })
  }
  if (has(".lock") || has("package-lock") || has("bun.lock") || has("yarn.lock") || has("pnpm-lock")) {
    for (const tool of ["edit", "write", "read"]) out.push({ tool, id: "lock", label: "Lockfiles", patterns: ["**/*.lock"] })
  }
  if (has("package.json")) {
    for (const tool of ["edit", "write", "read"]) out.push({ tool, id: "package-json", label: "package.json", patterns: ["package.json"] })
  }
  if (has(".git")) {
    for (const tool of ["edit", "write", "read", "glob", "grep"]) out.push({ tool, id: "git", label: "Git internals", patterns: ["**/.git/**"] })
  }
  if (has(".ssh") || has("~/.ssh")) {
    for (const tool of ["edit", "write", "read"]) out.push({ tool, id: "ssh", label: "SSH keys", patterns: ["~/.ssh/**"] })
  }
  if (has("node_modules")) {
    for (const tool of ["glob", "grep"]) out.push({ tool, id: "node-modules", label: "node_modules", patterns: ["**/node_modules/**"] })
  }
  const generic = mineGenericPaths(text)
  for (const pattern of generic) out.push({ tool: "edit", id: slugify(pattern), label: pattern, patterns: [pattern] })
  return out
}

function mineGenericPaths(text: string): string[] {
  const found = new Set<string>()
  const tokens = text.split(/[\s`"'<>()[\]{}]+/).filter((token) => token.length > 0)
  for (const raw of tokens) {
    const token = raw.replace(/^[`'"]+|[`'";:,]+$/g, "")
    if (token.length < 3 || token.length > 100) continue
    if (token.startsWith("http://") || token.startsWith("https://")) continue
    if (!token.includes("/") && !token.startsWith("~") && !token.startsWith("*.") && !token.startsWith("**")) continue
    const lower = token.toLowerCase()
    if (lower.includes(".env") || lower.includes(".lock") || lower.includes("package.json") || lower.includes(".git") || lower.includes(".ssh") || lower.includes("node_modules")) continue
    if (!/[A-Za-z0-9]/.test(token)) continue
    found.add(token)
  }
  return [...found].toSorted().slice(0, 20)
}

interface MinedUrl {
  readonly tool: string
  readonly id: string
  readonly label: string
  readonly patterns: readonly string[]
}

function mineUrls(text: string): MinedUrl[] {
  const out: MinedUrl[] = []
  const seen = new Set<string>()
  const matches = text.match(/https?:\/\/[^\s`"'<>]+/g) ?? []
  for (const raw of matches) {
    const cleaned = raw.replace(/[.,)\]]+$/g, "")
    if (cleaned.startsWith("http://")) {
      const key = "http://*"
      if (!seen.has(`webfetch\n${key}`)) {
        seen.add(`webfetch\n${key}`)
        out.push({ tool: "webfetch", id: "http", label: "Plain HTTP", patterns: ["http://*"] })
      }
    }
    const host = hostOf(cleaned)
    if (host === undefined) continue
    if (host.includes("github.com")) {
      const key = "*github.com*"
      if (!seen.has(`webfetch\n${key}`)) {
        seen.add(`webfetch\n${key}`)
        out.push({ tool: "webfetch", id: "github", label: "GitHub", patterns: ["*github.com*"] })
      }
      continue
    }
    if (host === "localhost" || host === "127.0.0.1") {
      const key = "*localhost*"
      if (!seen.has(`webfetch\n${key}`)) {
        seen.add(`webfetch\n${key}`)
        out.push({ tool: "webfetch", id: "localhost", label: "Localhost", patterns: ["*localhost*"] })
      }
      continue
    }
    const key = `*${host}*`
    if (seen.has(`webfetch\n${key}`)) continue
    seen.add(`webfetch\n${key}`)
    out.push({ tool: "webfetch", id: slugify(host), label: host, patterns: [key] })
  }
  return out
}

function hostOf(url: string): string | undefined {
  const withoutScheme = url.replace(/^https?:\/\//, "")
  const host = withoutScheme.split("/")[0]?.split(":")[0]?.split("?")[0]?.toLowerCase() ?? ""
  if (host.length === 0) return undefined
  if (!host.includes(".")) return undefined
  return host
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug.length > 0 ? slug : "rule"
}

// Validate a user-supplied rule before persisting it as a RuleRecord.
// Patterns are core wildcards (not regex); at least one non-empty pattern is
// required. Keywords default through keywordsForPattern when omitted.
export function validateRuleInput(input: {
  readonly tool: string
  readonly id: string
  readonly label: string
  readonly patterns: readonly string[]
  readonly keywords?: readonly string[]
}): { ok: true; tool: string; id: string; label: string; patterns: string[]; keywords: string[] } | { ok: false; reason: string } {
  const tool = input.tool.trim()
  const id = input.id.trim()
  const label = input.label.trim()
  if (tool.length === 0) return { ok: false, reason: "Rule tool cannot be empty" }
  if (tool.includes(":") || tool.includes("/") || tool.includes(" ") || tool.includes("*") || tool.includes("?"))
    return { ok: false, reason: `Invalid rule tool "${input.tool}"` }
  if (id.length === 0) return { ok: false, reason: "Rule id cannot be empty" }
  if (id.includes("\n") || id.includes("\0")) return { ok: false, reason: `Invalid rule id "${input.id}"` }
  if (label.length === 0) return { ok: false, reason: "Rule label cannot be empty" }
  const patterns = input.patterns.map((pattern) => pattern.trim()).filter((pattern) => pattern.length > 0)
  if (patterns.length === 0) return { ok: false, reason: "Rule patterns cannot be empty" }
  const keywords =
    input.keywords === undefined
      ? [...new Set(patterns.flatMap(keywordsForPattern))].filter((keyword) => keyword.length > 0)
      : input.keywords.map((keyword) => keyword.trim()).filter((keyword) => keyword.length > 0)
  if (keywords.length === 0) return { ok: false, reason: "Rule keywords cannot be empty" }
  return { ok: true, tool, id, label, patterns, keywords }
}
