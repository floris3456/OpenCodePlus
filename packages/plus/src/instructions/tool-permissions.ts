// Curated tool permission rules plus the one shared keyword derivation.
//
// This module holds view-time data and persists nothing. Rule rows are these
// shipped rules, subagent rules from the discovered agent ids, and the user's
// own rules; nothing is generated from prompt text (mined-legacy.ts).
//
// This module must not import from core: plus depends only on
// @opencode/plugin and @opencode/schema.

export interface CuratedRule {
  readonly tool: string
  readonly id: string
  readonly label: string
  readonly patterns: readonly string[]
  readonly keywords: readonly string[]
  /**
   * Short refusal text installs onto the core deny so the model reads why.
   * Shipped curated rules always carry one; subagent rules do not and keep
   * the generic refusal.
   */
  readonly message?: string
}

// THE ONE shared function deriving scrub keywords from a pattern. Both the
// curated defaults below and a user rule saved without keywords come from
// here; nothing else may derive keywords. Head word plus subcommand words,
// stopping at the first wildcard or flag: "git push *" -> ["git push"], not
// ["git"]. A pattern with no literal leading word (globs, URLs) falls back to
// its first meaningful segment: "**/.git/**" -> [".git"].
export function keywordsForPattern(pattern: string): string[] {
  const trimmed = pattern.trim()
  const tokens = trimmed.split(/\s+/).filter((token) => token.length > 0)
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
  /** Required: every shipped curated rule tells the model why it refused. */
  readonly message: string
}

// Raw curated entries: label plus patterns grouped by tool action. Keywords
// are derived once at module load through keywordsForPattern, never written
// by hand. For shell the permission resource is the PARSED COMMAND TEXT, so a
// head-only rule carries both the bare head and the `*` pattern: `git *`
// matches `git push`, and the bare `git` pins the exact head. Messages are
// one line each and name the subject the rule answers for (the pattern), not
// one call.
const rawRules: readonly RawRule[] = [
  { tool: "shell", id: "git", label: "Git", patterns: ["git", "git *"], message: "git commands are not allowed here" },
  { tool: "shell", id: "git-push", label: "Git push", patterns: ["git push *"], message: "pushing is not allowed here" },
  { tool: "shell", id: "git-commit", label: "Git commit", patterns: ["git commit *"], message: "committing is not allowed here" },
  {
    tool: "shell",
    id: "git-rewrite",
    label: "Git history rewrites",
    patterns: ["git reset *", "git checkout *", "git rebase *"],
    message: "git history rewrites are not allowed here",
  },
  { tool: "shell", id: "rm", label: "Remove files", patterns: ["rm", "rm *"], message: "removing files is not allowed here" },
  { tool: "shell", id: "rm-rf", label: "Recursive force remove", patterns: ["rm -rf *"], message: "recursive force removal is not allowed here" },
  { tool: "shell", id: "sudo", label: "Sudo", patterns: ["sudo", "sudo *"], message: "sudo is not allowed here" },
  {
    tool: "shell",
    id: "chmod-chown",
    label: "Change permissions or ownership",
    patterns: ["chmod *", "chown *"],
    message: "changing permissions or ownership is not allowed here",
  },
  {
    tool: "shell",
    id: "curl-wget",
    label: "Download with curl or wget",
    patterns: ["curl *", "wget *"],
    message: "downloading with curl or wget is not allowed here",
  },
  { tool: "shell", id: "ssh-scp", label: "SSH or SCP", patterns: ["ssh *", "scp *"], message: "ssh and scp are not allowed here" },
  { tool: "shell", id: "docker", label: "Docker", patterns: ["docker", "docker *"], message: "docker is not allowed here" },
  { tool: "shell", id: "kubectl", label: "Kubectl", patterns: ["kubectl", "kubectl *"], message: "kubectl is not allowed here" },
  {
    tool: "shell",
    id: "js-install",
    label: "JavaScript package install",
    patterns: ["npm install *", "pnpm install *", "yarn install *", "bun install *"],
    message: "installing JavaScript packages is not allowed here",
  },
  { tool: "shell", id: "npm-publish", label: "npm publish", patterns: ["npm publish *"], message: "publishing packages is not allowed here" },
  { tool: "shell", id: "pip-install", label: "pip install", patterns: ["pip install *"], message: "installing python packages is not allowed here" },
  { tool: "shell", id: "kill", label: "Kill processes", patterns: ["kill *", "pkill *"], message: "killing processes is not allowed here" },
  {
    tool: "shell",
    id: "disk-destructive",
    label: "Disk destructive",
    patterns: ["dd *", "mkfs *"],
    message: "disk-destructive commands are not allowed here",
  },
  {
    tool: "shell",
    id: "env",
    label: "Environment inspection",
    patterns: ["env", "env *", "printenv", "printenv *", "export", "export *"],
    message: "environment inspection is not allowed here",
  },
  {
    tool: "shell",
    id: "package-scripts",
    label: "Package scripts",
    patterns: ["npm run *", "npm test *", "pnpm run *", "yarn run *", "bun run *", "bun test *"],
    message: "package scripts are not allowed here",
  },
  { tool: "edit", id: "env", label: ".env files", patterns: ["*.env*"], message: ".env files cannot be edited here" },
  { tool: "edit", id: "lock", label: "Lockfiles", patterns: ["*.lock", "**/*.lock"], message: "lockfiles cannot be edited here" },
  { tool: "edit", id: "package-json", label: "package.json", patterns: ["package.json", "*/package.json"], message: "package.json cannot be edited here" },
  { tool: "edit", id: "git", label: "Git internals", patterns: [".git/*", "**/.git/**"], message: "git internals cannot be edited here" },
  { tool: "edit", id: "ssh", label: "SSH keys", patterns: ["*/.ssh/*", "*/.ssh", ".ssh/*", ".ssh"], message: "ssh keys cannot be edited here" },
  { tool: "write", id: "env", label: ".env files", patterns: ["*.env*"], message: ".env files cannot be written here" },
  { tool: "write", id: "lock", label: "Lockfiles", patterns: ["*.lock", "**/*.lock"], message: "lockfiles cannot be written here" },
  { tool: "write", id: "package-json", label: "package.json", patterns: ["package.json", "*/package.json"], message: "package.json cannot be written here" },
  { tool: "write", id: "git", label: "Git internals", patterns: [".git/*", "**/.git/**"], message: "git internals cannot be written here" },
  { tool: "write", id: "ssh", label: "SSH keys", patterns: ["*/.ssh/*", "*/.ssh", ".ssh/*", ".ssh"], message: "ssh keys cannot be written here" },
  { tool: "read", id: "env", label: ".env files", patterns: ["*.env*"], message: ".env files cannot be read here" },
  { tool: "read", id: "lock", label: "Lockfiles", patterns: ["*.lock", "**/*.lock"], message: "lockfiles cannot be read here" },
  { tool: "read", id: "package-json", label: "package.json", patterns: ["package.json", "*/package.json"], message: "package.json cannot be read here" },
  { tool: "read", id: "git", label: "Git internals", patterns: [".git/*", "**/.git/**"], message: "git internals cannot be read here" },
  { tool: "read", id: "ssh", label: "SSH keys", patterns: ["*/.ssh/*", "*/.ssh", ".ssh/*", ".ssh"], message: "ssh keys cannot be read here" },
  { tool: "webfetch", id: "http", label: "Plain HTTP", patterns: ["http://*"], message: "plain HTTP fetches are not allowed here" },
  { tool: "webfetch", id: "github", label: "GitHub", patterns: ["*github.com*"], message: "github.com fetches are not allowed here" },
  { tool: "webfetch", id: "localhost", label: "Localhost", patterns: ["*localhost*"], message: "localhost fetches are not allowed here" },
  // Glob/grep permission resources are the user's search pattern, NOT the
  // search path (core/src/tool/plugin/grep.ts and glob.ts assert
  // `resources: [input.pattern]`). PATH-scoped restriction is therefore NOT
  // expressible through core's permission resource for these tools: a deny
  // can only match search text mentioning a string, never a directory walk.
  // The rows below are honest search-pattern denys.
  {
    tool: "glob",
    id: "node-modules",
    label: "Search pattern matching node_modules",
    patterns: ["*node_modules*"],
    message: "search patterns matching node_modules are not allowed here",
  },
  { tool: "glob", id: "git", label: "Search pattern matching .git", patterns: ["*.git*"], message: "search patterns matching .git are not allowed here" },
  {
    tool: "grep",
    id: "node-modules",
    label: "Search pattern matching node_modules",
    patterns: ["*node_modules*"],
    message: "search patterns matching node_modules are not allowed here",
  },
  { tool: "grep", id: "git", label: "Search pattern matching .git", patterns: ["*.git*"], message: "search patterns matching .git are not allowed here" },
]

export const curatedRules: readonly CuratedRule[] = rawRules.map((rule) => ({
  tool: rule.tool,
  id: rule.id,
  label: rule.label,
  patterns: [...rule.patterns],
  keywords: [...new Set(rule.patterns.flatMap(keywordsForPattern))],
  message: rule.message,
}))

// Subagent rules populate from the discovered agents at discovery time, so
// names are never hardcoded: one rule per id matching exactly that id.
export function idRules(tool: string, ids: readonly string[]): CuratedRule[] {
  return ids.map((id) => ({
    tool,
    id,
    label: id,
    patterns: [id],
    keywords: keywordsForPattern(id),
  }))
}

// The refusal text a curated rule ships, by its `(tool, ruleId)` identity.
// `apply.ts` and the tools/TUI readers use this for a row with no user
// `RuleRecord` behind it; a user record's own message takes precedence there.
export function curatedRuleMessage(tool: string, ruleId: string): string | undefined {
  return curatedRules.find((rule) => rule.tool === tool && rule.id === ruleId)?.message
}

// Core permission action for a Plus tool id. Discovery carries the tool's own
// `options.permission` on perm items when the registry provides one (edit,
// write, and patch all register `permission: "edit"`); this map is the
// fallback for items that predate that seam and for tools without one. Edit,
// write, and patch share core's `edit` action (core/src/tool/plugin/edit.ts,
// write.ts, and patch.ts assert `action: "edit"`). Every other tool asserts
// its own id.
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
    if (active.some((keyword) => containsWholeWord(line, keyword))) {
      dropped.push(line)
      continue
    }
    kept.push(line)
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

// Validate a user-supplied rule before persisting it as a RuleRecord.
// Patterns are core wildcards (not regex); at least one non-empty pattern is
// required. Keywords default through keywordsForPattern when omitted.
export function validateRuleInput(input: {
  readonly tool: string
  readonly id: string
  readonly label: string
  readonly patterns: readonly string[]
  readonly keywords?: readonly string[]
  readonly message?: string
}): { ok: true; tool: string; id: string; label: string; patterns: string[]; keywords: string[]; message?: string } | { ok: false; reason: string } {
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
  // A blank or whitespace-only message means the generic refusal, the same
  // as omitting the field: the dialog's blank prompt clears it.
  const message = input.message === undefined ? undefined : input.message.trim()
  return {
    ok: true,
    tool,
    id,
    label,
    patterns,
    keywords,
    ...(message === undefined || message.length === 0 ? {} : { message }),
  }
}
