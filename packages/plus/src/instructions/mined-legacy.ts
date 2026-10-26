import { curatedRules, keywordsForPattern } from "./tool-permissions.js"
import { parsePermItemId, type CustomizationRecord, type Item, type RuleRecord } from "./model.js"

// Up to plus-1.3.26 Plus generated rule rows from the commands, paths and
// sites the prompts mention, listed under "Mentioned in instructions". It no
// longer does: most were examples, rows that could never match or copies of
// shipped rules. What is left of that generator is kept here, frozen, for one
// job: a generated rule someone switched off becomes their own rule with the
// patterns it had, so it keeps refusing what it refused.

/**
 * The rules to store for switched-off generated rows: one per `off` record on
 * a `perm:` row discovery no longer lists, whose rule the old generator still
 * finds in these texts, at the record's own level and owner. Reads the texts
 * only when such a record exists.
 */
export function switchedOffMinedRules(input: {
  readonly records: readonly CustomizationRecord[]
  /** Every perm row discovery lists: a record on one of them needs nothing. */
  readonly rows: readonly Item[]
  /** The tools rows were generated for: native and Plus tools outside Code Mode. */
  readonly tools: ReadonlySet<string>
  /** The texts the generator read: tools, base prompts, skills, roles, AGENTS.md files, user System rows and OpenCodePlus. */
  readonly texts: readonly string[]
}): Omit<RuleRecord, "updated">[] {
  const listed = new Set(input.rows.map((row) => row.id))
  const orphans = input.records.filter(
    (record) =>
      record.state === "off" &&
      record.section === null &&
      !listed.has(record.item) &&
      input.tools.has(parsePermItemId(record.item)?.tool ?? ""),
  )
  if (orphans.length === 0) return []
  const generated = generatedRules(input.texts)
  return orphans.flatMap((record): Omit<RuleRecord, "updated">[] => {
    const perm = parsePermItemId(record.item)
    const rule = perm === undefined ? undefined : generated.get(`${perm.tool}\n${perm.ruleId}`)
    if (perm === undefined || rule === undefined) return []
    return [
      {
        type: "rule",
        level: record.level,
        agent: record.agent,
        ...(record.team === undefined ? {} : { team: record.team }),
        ...(record.catalogue === undefined ? {} : { catalogue: record.catalogue }),
        tool: perm.tool,
        id: perm.ruleId,
        label: rule.label,
        patterns: [...rule.patterns],
        keywords: [...rule.keywords],
      },
    ]
  })
}

interface Generated {
  readonly tool: string
  readonly id: string
  readonly label: string
  readonly patterns: readonly string[]
}

// The rows the generator listed that were not a shipped rule, by
// "<tool>\n<rule id>". Like the old discovery: one candidate per tool and
// pattern set, most-mentioned first (ties by id), a set equal to a shipped
// rule's is that rule, and the first candidate with an id wins.
function generatedRules(texts: readonly string[]): Map<string, Generated & { readonly keywords: readonly string[] }> {
  const candidates = new Map<string, { rule: Generated; mentions: number }>()
  for (const text of texts) {
    if (text.length === 0) continue
    const found = [...mineCommands(text), ...minePaths(text), ...mineSites(text)]
    const once = new Map(found.map((rule) => [`${rule.tool}\n${[...rule.patterns].toSorted().join("\n")}`, rule]))
    for (const [key, rule] of once) {
      const existing = candidates.get(key)
      if (existing === undefined) candidates.set(key, { rule, mentions: 1 })
      else existing.mentions++
    }
  }
  const shipped = new Set(curatedRules.map((rule) => `${rule.tool}\n${[...rule.patterns].toSorted().join("\n")}`))
  const ranked = [...candidates.entries()]
    .filter(([key]) => !shipped.has(key))
    .map(([, entry]) => entry)
    .toSorted((left, right) => {
      if (left.rule.tool !== right.rule.tool) return left.rule.tool < right.rule.tool ? -1 : 1
      if (left.mentions !== right.mentions) return right.mentions - left.mentions
      return left.rule.id < right.rule.id ? -1 : left.rule.id > right.rule.id ? 1 : 0
    })
  const out = new Map<string, Generated & { readonly keywords: readonly string[] }>()
  for (const entry of ranked) {
    const key = `${entry.rule.tool}\n${entry.rule.id}`
    if (out.has(key)) continue
    out.set(key, { ...entry.rule, keywords: [...new Set(entry.rule.patterns.flatMap(keywordsForPattern))] })
  }
  return out
}

// How many words of each known command the generator kept: `git rebase *`
// (2), `rm *` (1).
const commandHeads: Record<string, number> = {
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

// A known command head plus as many subcommand words as it takes, and its
// first flag: "git rebase -i main" -> `git rebase -i *`.
function mineCommands(text: string): Generated[] {
  const out: Generated[] = []
  const seen = new Set<string>()
  const pushLine = (line: string) => {
    const cleaned = line
      .trim()
      .replace(/^[$>\s\-*`'"]+/, "")
      .replace(/[`'"]+$/, "")
      .trim()
    if (cleaned.length === 0) return
    const tokens = cleaned.split(/\s+/).filter((token) => token.length > 0)
    const head = (tokens[0] ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+$/g, "")
      .replace(/^[^a-z0-9]+/g, "")
    const depth = commandHeads[head]
    if (depth === undefined) return
    const rest = tokens.slice(1).map((token) => token.replace(/[`'";,]+$/g, ""))
    const flag = rest.find((token) => token.startsWith("-") && token.length > 1)?.replace(/[`'";,]+$/g, "")
    const words = rest
      .map((token) => token.replace(/^[^A-Za-z0-9._/-]+|[^A-Za-z0-9._/-]+$/g, ""))
      .filter((token) => token.length > 0 && !token.startsWith("-") && token !== "|" && token !== "&&" && token !== ";")
    const chosen = [head, ...words.slice(0, depth - 1)]
    const label = (flag === undefined ? chosen : [...chosen, flag]).join(" ")
    const pattern = `${label} *`
    if (seen.has(pattern.toLowerCase())) return
    seen.add(pattern.toLowerCase())
    out.push({ tool: "shell", id: slugify(label), label, patterns: [pattern] })
  }
  for (const line of text.split("\n")) pushLine(line)
  for (const span of codeSpans(text)) {
    for (const line of span.split("\n")) pushLine(line)
  }
  return out
}

function codeSpans(text: string): string[] {
  const fenced = (text.match(/```[\s\S]*?```/g) ?? []).map((block) =>
    block.replace(/^```[^\n]*\n/, "").replace(/```$/g, ""),
  )
  const inline = (text.match(/`[^`\n]+`/g) ?? []).map((code) => code.slice(1, -1))
  return [...fenced, ...inline]
}

// Paths and globs for the edit tool. Names a shipped rule covers (.env,
// lockfiles, package.json, .git, .ssh, node_modules) were that rule.
function minePaths(text: string): Generated[] {
  const found = new Set<string>()
  for (const raw of text.split(/[\s`"'<>()[\]{}]+/).filter((token) => token.length > 0)) {
    let token = raw.replace(/^[`'"]+/, "")
    while (true) {
      const next = token.replace(/[.,;:`'"]+$/, "").replace(/:\d+(?::\d+)?$/, "")
      if (next === token) break
      token = next
    }
    if (token.length < 3 || token.length > 100) continue
    if (token.startsWith("http://") || token.startsWith("https://")) continue
    if (!token.includes("/") && !token.startsWith("~") && !token.startsWith("*.") && !token.startsWith("**")) continue
    const lower = token.toLowerCase()
    if ([".env", ".lock", "package.json", ".git", ".ssh", "node_modules"].some((name) => lower.includes(name))) continue
    if (!/[A-Za-z0-9]/.test(token)) continue
    if (!isPath(token)) continue
    found.add(token)
  }
  return [...found]
    .toSorted()
    .slice(0, 20)
    .map((pattern) => ({ tool: "edit", id: slugify(pattern), label: pattern, patterns: [pattern] }))
}

// A glob with a "/" or an extension, or a path whose last segment has an
// extension: drops "and/or", "4xx/5xx" and "/api/config".
function isPath(token: string): boolean {
  const extension = /\.[A-Za-z0-9]{1,10}(?![A-Za-z0-9])/
  if (token.includes("*") || token.includes("?")) return token.includes("/") || extension.test(token)
  return extension.test(token.split("/").pop() ?? token)
}

// One `*<host>*` rule per site; plain HTTP, GitHub and localhost were shipped rules.
function mineSites(text: string): Generated[] {
  const hosts = new Set<string>()
  for (const raw of text.match(/https?:\/\/[^\s`"'<>]+/g) ?? []) {
    const host =
      raw
        .replace(/[.,)\]]+$/g, "")
        .replace(/^https?:\/\//, "")
        .split("/")[0]
        ?.split(":")[0]
        ?.split("?")[0]
        ?.toLowerCase() ?? ""
    if (!host.includes(".") || host.includes("github.com") || host === "127.0.0.1") continue
    hosts.add(host)
  }
  return [...hosts].map((host) => ({ tool: "web_opencode_fetch", id: slugify(host), label: host, patterns: [`*${host}*`] }))
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug.length > 0 ? slug : "rule"
}
