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
    if (match === undefined) return { ...entry }
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
