// Enforcement of the per-tool permission rows that core rules cannot express.
//
// Rule rows (paths, commands, URLs, agent and skill ids) compile to core
// permission rules in apply.ts. Every other kind is answered here, from the
// same resolved rows, through the plugin seams the host already offers:
//
// - tool.execute.before sees every call (direct tools, Code Mode inner calls
//   and MCP tools) with its full input before core authorizes it. Input,
//   value, param and limit rows refuse or clamp there.
// - permission.evaluate runs when core authorizes that call. An approval row
//   turns the call into a question for the human there; the call is matched to
//   its execute.before by session, message and call id.
// - tool.execute.after filters what grep returns and masks secrets in
//   instructions results.
// - shell.create.before strips environment variables. It carries no agent, so
//   the command is matched to the shell call that announced it.
// - session.context narrows each direct tool's schema per agent: a parameter
//   or literal that is off disappears, and team_delegate's `role` lists
//   exactly the members this agent may delegate to.
//
// Team rows are read by the team tools themselves through the same table.
import type { Context } from "@opencode/plugin/effect/plugin"
import type { Registration } from "@opencode/plugin/effect/registration"
import type { SessionContext } from "@opencode/plugin/effect/session"
import { Permission } from "@opencode/schema/permission"
import { Tool } from "@opencode/schema/tool"
import { Effect, Exit, Scope, Stream } from "effect"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { applies, type Item } from "./model.js"
import { catalogFor, categoryLabel, limitOf, valuesAt, wildcardMatch } from "./permission-catalog.js"

export interface PermRow {
  readonly item: Item
  readonly on: boolean
  readonly text: string
}

export interface PermissionTable {
  /** Every non-rule row that applies to the agent, resolved for it. */
  readonly rows: (agent: string) => readonly PermRow[]
  /** The agent's rows listed under one tool, its own and the ones it shares. */
  readonly toolRows: (agent: string, tool: string) => readonly PermRow[]
  /** Ids of every member of an enabled team. */
  readonly teamMembers: ReadonlySet<string>
}

const enforced = new Set(["input", "value", "param", "limit", "approval", "env", "team"])

// The table resolves lazily and remembers per agent: most agents (title,
// summary, compaction) never call a tool, so a publish pays only for the
// agents that do.
export function permissionTable(input: {
  readonly items: readonly Item[]
  readonly teamMembers: readonly string[]
  readonly resolve: (item: Item, agent: string) => { readonly enabled: boolean; readonly text: string }
}): PermissionTable {
  const rows = input.items.filter((item) => item.kind === "perm" && item.permKind !== undefined && enforced.has(item.permKind))
  const byAgent = new Map<string, readonly PermRow[]>()
  const byTool = new Map<string, readonly PermRow[]>()
  const agentRows = (agent: string): readonly PermRow[] => {
    const cached = byAgent.get(agent)
    if (cached !== undefined) return cached
    const resolved = rows
      .filter((item) => applies(item, agent))
      .map((item) => {
        const state = input.resolve(item, agent)
        return { item, on: state.enabled, text: state.text }
      })
    byAgent.set(agent, resolved)
    return resolved
  }
  return {
    rows: agentRows,
    toolRows: (agent, tool) => {
      const key = `${agent}\u0000${tool}`
      const cached = byTool.get(key)
      if (cached !== undefined) return cached
      const found = agentRows(agent).filter((row) => row.item.permTool === tool || (row.item.alsoUnder ?? []).includes(tool))
      byTool.set(key, found)
      return found
    },
    teamMembers: new Set(input.teamMembers),
  }
}

// The row with this id for the agent; undefined when there is no table or the
// agent has no such row.
export function rowState(table: PermissionTable | undefined, agent: string, tool: string, ruleId: string): PermRow | undefined {
  return table?.toolRows(agent, tool).find((row) => row.item.ruleId === ruleId && row.item.permTool === tool)
}

// A team bound: the row's number while it is on, undefined (no bound) while
// it is off. A missing row (no table, or an agent the table does not know)
// reads as off, like every setting nothing sets (DESIGN §3.3, §6).
export function teamLimit(table: PermissionTable | undefined, agent: string, tool: string, ruleId: string): number | undefined {
  const row = rowState(table, agent, tool, ruleId)
  if (row === undefined || !row.on) return undefined
  return limitOf(row.text)
}

// Whether a team row is on for the agent; a missing row reads as off.
export function teamAllows(table: PermissionTable | undefined, agent: string, tool: string, ruleId: string): boolean {
  return rowState(table, agent, tool, ruleId)?.on ?? false
}

// ── call decisions (pure) ─────────────────────────────────────────────────

export interface Call {
  readonly tool: string
  readonly input: unknown
  readonly sessionID: string
  /** The calling agent: an instructions change may not address its own rows when "targets.self" is off. */
  readonly agent?: string
  /** The Location directory: relative paths resolve here, and "outside this checkout" means outside it. */
  readonly directory: string
  readonly teamMembers: ReadonlySet<string>
  readonly exists?: (file: string) => boolean
  /** A browser tab's current page, as the browser tools last reported it. */
  readonly tabUrl?: (tabID: string) => string | undefined
}

export interface Decision {
  /** Refusal text; the call does not run. */
  readonly refuse?: string
  /** A rewritten input (clamped limits). */
  readonly input?: unknown
  /** The call needs the human's approval first: the permission action core checks it under. */
  readonly approval?: string
  /** A delegated-run-only refusal (question in a run nobody watches). */
  readonly headlessRefusal?: string
  /** Environment variable name patterns a shell command must not inherit. */
  readonly stripEnv?: readonly string[]
}

export function decide(rows: readonly PermRow[], call: Call): Decision {
  if (rows.length === 0) return {}
  // One check per category and kind: a rule category's fallback is an input
  // row beside its rule rows (core answers those).
  const categories = new Map<string, PermRow[]>()
  for (const row of rows) {
    const key = `${row.item.category ?? ""}\u0000${row.item.permKind ?? "rule"}`
    categories.set(key, [...(categories.get(key) ?? []), row])
  }
  let input = call.input
  let approval: string | undefined
  let headlessRefusal: string | undefined
  const stripEnv: string[] = []
  for (const [key, group] of categories) {
    const category = key.slice(0, key.indexOf("\u0000"))
    const kind = group[0]?.item.permKind
    if (kind === "input") {
      const refusal = inputRefusal(category, group, { ...call, input })
      if (refusal !== undefined) return { refuse: refusal }
      continue
    }
    if (kind === "value") {
      const refusal = valueRefusal(group, input, category)
      if (refusal !== undefined) return { refuse: refusal }
      continue
    }
    if (kind === "param") {
      const refusal = paramRefusal(group, { ...call, input })
      if (refusal !== undefined) return { refuse: refusal }
      continue
    }
    if (kind === "limit") {
      const limited = applyLimits(group, input, call.tool)
      if (limited.refuse !== undefined) return { refuse: limited.refuse }
      input = limited.input
      continue
    }
    if (kind === "approval") {
      for (const row of group) {
        if (row.item.ruleId === "when.delegated") {
          if (!row.on) headlessRefusal = denied(row.item.message ?? "this call is not allowed in a delegated run")
          continue
        }
        if (row.on) approval = row.item.permAction ?? call.tool
      }
      continue
    }
    if (kind === "env") {
      for (const row of group) if (!row.on) stripEnv.push(...(row.item.patterns ?? []))
    }
  }
  return {
    ...(input === call.input ? {} : { input }),
    ...(approval === undefined ? {} : { approval }),
    ...(headlessRefusal === undefined ? {} : { headlessRefusal }),
    ...(stripEnv.length === 0 ? {} : { stripEnv }),
  }
}

function denied(message: string): string {
  return `Permission denied: ${message}`
}

function messageOf(row: PermRow, fallback: string): string {
  return denied(row.item.message ?? fallback)
}

// A string for every value a field holds: arrays of words (a check's argv)
// join with spaces, everything else is its string form.
function stringsAt(input: unknown, field: string): string[] {
  return valuesAt(input, field).flatMap((value) => {
    if (value === null || value === undefined) return []
    if (Array.isArray(value)) return [value.map(String).join(" ")]
    if (typeof value === "object") return []
    return [String(value)]
  })
}

function inputRefusal(category: string, group: readonly PermRow[], call: Call): string | undefined {
  const special = specialRefusal(category, group, call)
  if (special !== "none") return special
  const fallback = group.find((row) => row.item.fallback === true)
  const others = group.filter((row) => row.item.fallback !== true)
  const fields = [...new Set(group.map((row) => row.item.field ?? ""))].filter((field) => field.length > 0 && field !== "*")
  for (const field of fields) {
    const rows = others.filter((row) => row.item.field === field)
    for (const value of stringsAt(call.input, field)) {
      const matches = rows.filter((row) => rowMatches(row, value, call))
      const deny = matches.find((row) => !row.on && row.item.allow !== true)
      if (deny !== undefined) return messageOf(deny, `${deny.item.title} is not allowed here`)
      if (fallback !== undefined && !fallback.on && fallback.item.field === field && rowMatches(fallback, value, call)) {
        const opened = matches.some((row) => row.on && row.item.allow === true)
        if (!opened) return messageOf(fallback, `${categoryLabel(call.tool, category)}: "${value}" is not allowed here`)
      }
    }
  }
  return undefined
}

// Rows whose meaning is not a pattern over one field. "none" means the
// category has no special rule and takes the generic path.
function specialRefusal(category: string, group: readonly PermRow[], call: Call): string | undefined | "none" {
  if (call.tool === "write" && category === "operations") {
    const file = stringsAt(call.input, "path")[0]
    if (file === undefined) return undefined
    const exists = call.exists?.(path.resolve(call.directory, expandHome(file))) ?? false
    const row = group.find((entry) => entry.item.ruleId === (exists ? "operations.overwrite" : "operations.create"))
    if (row !== undefined && !row.on) return messageOf(row, `${row.item.title} is not allowed here`)
    return undefined
  }
  if (call.tool === "patch" && category === "operations") {
    const text = stringsAt(call.input, "patchText")[0] ?? ""
    const used = {
      "operations.add": /^\*\*\* Add File:/m.test(text),
      "operations.delete": /^\*\*\* Delete File:/m.test(text),
      "operations.move": /^\*\*\* Move to:/m.test(text),
    } as Record<string, boolean>
    const row = group.find((entry) => used[entry.item.ruleId ?? ""] === true && !entry.on)
    if (row !== undefined) return messageOf(row, `${row.item.title} is not allowed here`)
    return undefined
  }
  if (call.tool === "subagent" && category === "team-members") {
    const agent = stringsAt(call.input, "agent")[0]
    const row = group[0]
    if (agent === undefined || row === undefined || row.on) return undefined
    return call.teamMembers.has(agent) ? messageOf(row, "team members start through team_delegate") : undefined
  }
  if (call.tool.startsWith("instructions_") && category === "targets") {
    const id = stringsAt(call.input, "id")[0]
    if (id === undefined) return undefined
    const self = group.find((row) => row.item.ruleId === "targets.self")
    if (self !== undefined && !self.on && addressesAgent(id, call.agent ?? "")) return messageOf(self, "an agent may not change its own rows here")
    return "none"
  }
  // Where: a path outside this checkout needs the category open, or an
  // allow row on for its absolute path. Paths inside never ask this row.
  if (category === "where") {
    const fallback = group.find((row) => row.item.fallback === true)
    if (fallback === undefined || fallback.on) return undefined
    const paths = call.tool === "patch" ? patchPaths(stringsAt(call.input, "patchText")[0] ?? "") : stringsAt(call.input, "path")
    for (const file of paths) {
      if (!isOutside(file, call.directory)) continue
      const absolute = path.resolve(call.directory, expandHome(file))
      const opened = group.some(
        (row) => row.on && row.item.allow === true && (row.item.patterns ?? []).some((pattern) => wildcardMatch(absolute, pattern)),
      )
      if (!opened) return messageOf(fallback, "this path is outside this checkout")
    }
    return undefined
  }
  // Files it may change: while the category is closed, every path edit,
  // write or patch touches needs an allow row on that matches it, as given or
  // relative to the checkout.
  if (category === "allowed") {
    const fallback = group.find((row) => row.item.fallback === true)
    if (fallback === undefined || fallback.on) return undefined
    const paths = call.tool === "patch" ? patchPaths(stringsAt(call.input, "patchText")[0] ?? "") : stringsAt(call.input, "path")
    for (const file of paths) {
      const relative = path.relative(call.directory, path.resolve(call.directory, expandHome(file)))
      const opened = group.some(
        (row) =>
          row.on &&
          row.item.allow === true &&
          (row.item.patterns ?? []).some((pattern) => wildcardMatch(file, pattern) || wildcardMatch(relative, pattern)),
      )
      if (!opened) return messageOf(fallback, "this file may not be changed here")
    }
    return undefined
  }
  if (call.tool.startsWith("instructions_") && category === "secrets") return undefined
  // A tool's "Use" switch: off refuses every call.
  if (category === "use") {
    const off = group.find((row) => !row.on)
    return off === undefined ? undefined : messageOf(off, `${call.tool} is not allowed here`)
  }
  // A tab-scoped browser tool acts on its tab's current page.
  if (call.tool.startsWith("browser_") && category === "sites" && group.some((row) => row.item.field === "tabID")) {
    const fallback = group.find((row) => row.item.fallback === true)
    for (const tab of stringsAt(call.input, "tabID")) {
      const url = call.tabUrl?.(tab)
      if (url === undefined) {
        if (fallback !== undefined && !fallback.on)
          return denied(`the page of tab ${tab} is not known yet; open it with browser.tabs.open or browser.navigate first`)
        continue
      }
      const refusal = inputRefusal("sites", group.map((row) => ({ ...row, item: { ...row.item, field: "url" } })), { ...call, input: { url } })
      if (refusal !== undefined) return refusal
    }
    return undefined
  }
  return "none"
}

// Whether an instructions row id addresses the agent's own rows: its owner
// segment is the agent (Agents catalogue), a team member path ending in it
// (Teams catalogue), or the agent or member row itself.
export function addressesAgent(id: string, agent: string): boolean {
  if (agent.length === 0) return false
  const parts = id.split(":")
  const kind = parts[0]
  if (kind === "agent") return parts.slice(2).join(":") === agent
  if (kind === "team") return parts[3] === agent
  // A team member's owner is `<team>/:<member>`, which the split cuts in
  // two: the member is the part after the one ending in `/`.
  const owner = parts[2] ?? ""
  if (owner === agent) return true
  return owner.endsWith("/") && parts[3] === agent
}

function rowMatches(row: PermRow, value: string, call: Call): boolean {
  if (row.item.ruleId?.endsWith(".outside") === true) return isOutside(value, call.directory)
  return (row.item.patterns ?? []).some((pattern) => wildcardMatch(value, pattern))
}

// Every file a patch names: added, updated, deleted and moved-to paths.
export function patchPaths(text: string): string[] {
  return text
    .split("\n")
    .flatMap((line) => {
      const match = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/.exec(line.trim())
      return match === null ? [] : [match[1]?.trim() ?? ""]
    })
    .filter((file) => file.length > 0)
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir()
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2))
  return value
}

export function isOutside(value: string, directory: string): boolean {
  const target = path.resolve(directory, expandHome(value))
  const relative = path.relative(directory, target)
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
}

// A value row that is off refuses its literal, supplied or not: a call that
// omits the field gets the tool's default, which the category names.
function valueRefusal(group: readonly PermRow[], input: unknown, category: string): string | undefined {
  for (const row of group) {
    if (row.on || row.item.field === undefined) continue
    const supplied = valuesAt(input, row.item.field)
    if (supplied.some((value) => value === row.item.value))
      return denied(`${row.item.field} "${String(row.item.value)}" (${row.item.title}) is not allowed here`)
    const fallback = catalogFor(row.item.permTool ?? "").find((entry) => entry.id === category)?.default
    if (supplied.length === 0 && !row.item.field.includes("[]") && fallback !== undefined && fallback === row.item.value)
      return denied(`${row.item.field} defaults to "${String(fallback)}", which is not allowed here; pass another ${row.item.field} explicitly`)
  }
  return undefined
}

function paramRefusal(group: readonly PermRow[], call: Call): string | undefined {
  for (const row of group) {
    if (row.on || row.item.field === undefined) continue
    if (!paramUsed(row, call)) continue
    const used = "value" in row.item ? `${row.item.field}: ${JSON.stringify(row.item.value)}` : row.item.field
    return messageOf(row, `${row.item.title} (${used}) is not allowed here`)
  }
  return undefined
}

function paramUsed(row: PermRow, call: Call): boolean {
  const field = row.item.field ?? ""
  const present = valuesAt(call.input, field)
  if (row.item.ruleId === "sessions.other") return present.some((value) => typeof value === "string" && value !== call.sessionID)
  if (!("value" in row.item)) return present.some((value) => value !== null && value !== false)
  return present.some((value) => value === row.item.value)
}

function applyLimits(group: readonly PermRow[], input: unknown, tool: string): { refuse?: string; input: unknown } {
  let next = input
  for (const row of group) {
    if (!row.on || row.item.field === undefined) continue
    const limit = limitOf(row.text)
    if (limit === undefined) continue
    if (tool === "execute") continue
    const measure = row.item.measure ?? "value"
    if (measure === "count") {
      const count =
        tool === "patch"
          ? (stringsAt(next, row.item.field)[0] ?? "").split("\n").filter((line) => /^\*\*\* (Add|Update|Delete) File:/.test(line)).length
          : valuesAt(next, row.item.field).reduce<number>((sum, value) => sum + (Array.isArray(value) ? value.length : 1), 0)
      if (count > limit) return { refuse: denied(`${row.item.title} is ${limit}; this call has ${count}`), input: next }
      continue
    }
    if (measure === "length") {
      const longest = Math.max(0, ...stringsAt(next, row.item.field).map((value) => value.length))
      if (longest > limit) return { refuse: denied(`${row.item.title} is ${limit}; this call has ${longest}`), input: next }
      continue
    }
    const numbers = valuesAt(next, row.item.field).filter((value): value is number => typeof value === "number")
    if (row.item.mode === "refuse") {
      const high = numbers.find((value) => value > limit)
      if (high !== undefined) return { refuse: denied(`${row.item.title} is ${limit}; this call asks for ${high}`), input: next }
      continue
    }
    // Clamp one top-level field. An omitted field takes the cap when the
    // tool's own default is higher, so a lower cap holds for calls that rely
    // on the default.
    if (row.item.field.includes(".") || next === null || typeof next !== "object") continue
    const current = (next as Record<string, unknown>)[row.item.field]
    const toolDefault = typeof row.item.value === "number" ? row.item.value : undefined
    if (typeof current === "number" && current > limit) next = { ...(next as object), [row.item.field]: limit }
    if (current === undefined && toolDefault !== undefined && toolDefault > limit) next = { ...(next as object), [row.item.field]: limit }
  }
  return { input: next }
}

// ── result filters (pure) ─────────────────────────────────────────────────

interface GrepMatch {
  readonly entry: { readonly path: string }
  readonly line: number
  readonly text: string
}

// The files grep may not return: every off row of its Files category, and
// everything but the allowed rows while the category fallback is off.
export function grepHidden(rows: readonly PermRow[]): (file: string) => boolean {
  const files = rows.filter((row) => row.item.category === "files" && row.item.permKind === "input")
  const fallback = files.find((row) => row.item.fallback === true)
  const denies = files.filter((row) => row.item.fallback !== true && !row.on && row.item.allow !== true)
  const opens = files.filter((row) => row.item.fallback !== true && row.on && row.item.allow === true)
  const match = (row: PermRow, file: string) => (row.item.patterns ?? []).some((pattern) => wildcardMatch(file, pattern))
  return (file) => {
    if (denies.some((row) => match(row, file))) return true
    if (fallback !== undefined && !fallback.on) return !opens.some((row) => match(row, file))
    return false
  }
}

// Drop hidden files from a grep result, keeping core's text exactly
// (core/src/tool/plugin/grep.ts toModelContent): absolute paths, and the
// truncation notice when core's search hit its limit.
export function filterGrep(
  output: unknown,
  hidden: (file: string) => boolean,
  context: { readonly directory: string; readonly truncated?: boolean } = { directory: "/" },
): { output: GrepMatch[]; text: string } | undefined {
  if (!Array.isArray(output)) return undefined
  const matches = output as GrepMatch[]
  const kept = matches.filter((match) => !hidden(match.entry.path))
  if (kept.length === matches.length) return undefined
  const lines = kept.length === 0 ? ["No matches found"] : [`Found ${kept.length} matches`]
  let current = ""
  for (const match of kept) {
    const shown = path.resolve(context.directory, match.entry.path)
    if (current !== shown) {
      if (current) lines.push("")
      current = shown
      lines.push(`${shown}:`)
    }
    lines.push(`  Line ${match.line}: ${match.text}`)
  }
  if (context.truncated === true)
    lines.push("", `(Results are truncated: showing first ${kept.length} results. Consider using a more specific path or pattern.)`)
  return { output: kept, text: lines.join("\n") }
}

const secretContainer = /^(headers|environment|env)$/i
const notSecret = new Set(["keywords", "keybind", "keybinds", "keys", "keymap"])
const secretToken = /\b(?:sk-[A-Za-z0-9_-]{8,}|sk_live_[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[bp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g

// Whether a JSON key names a secret: keys, tokens, secrets, passwords,
// credentials, authorization and cookies, but not a key list or keybinds.
export function isSecretKey(name: string): boolean {
  const lower = name.toLowerCase()
  if (notSecret.has(lower)) return false
  if (/api[-_]?key|apikey|token|secret|passw|authorization|credential|cookie|bearer|private[-_]?key|access[-_]?key/.test(lower)) return true
  return lower === "key" || /[-_]key$/.test(lower)
}

// Mask secrets inside text that holds serialized config or a diff of it:
// a `"key": "value"` pair whose key names a secret, and token-shaped strings.
function maskText(text: string): { value: string; masked: number } {
  const parsed = jsonOf(text)
  if (parsed !== undefined) {
    const inner = maskSecrets(parsed.value)
    if (inner.masked === 0) return { value: text, masked: 0 }
    return { value: JSON.stringify(inner.value, null, text.includes("\n") ? 2 : undefined), masked: inner.masked }
  }
  let masked = 0
  // A headers or environment block keeps no value, whatever its keys are
  // called (a diff line of it included).
  const blocks = text.replace(/"(headers|environment|env)"(\s*:\s*)\{([^{}]*)\}/gi, (_whole, name: string, colon: string, body: string) => {
    const inner = body.replace(/"([^"\\]{1,120})"(\s*:\s*)"(?:[^"\\]|\\.)*"/g, (_pair, key: string, separator: string) => {
      masked += 1
      return `"${key}"${separator}"[masked]"`
    })
    return `"${name}"${colon}{${inner}}`
  })
  const pairs = blocks.replace(/"([^"\\]{1,80})"(\s*:\s*)"((?:[^"\\]|\\.)*)"/g, (whole, key: string, colon: string) => {
    if (!isSecretKey(key)) return whole
    masked += 1
    return `"${key}"${colon}"[masked]"`
  })
  const tokens = pairs.replace(secretToken, () => {
    masked += 1
    return "[masked]"
  })
  return { value: tokens, masked }
}

// A string that is itself JSON (a row's config text), parsed; undefined
// otherwise. Parsing failure is the answer, not an error.
function jsonOf(text: string): { value: unknown } | undefined {
  const trimmed = text.trim()
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return undefined
  return Effect.runSync(
    Effect.try(() => ({ value: JSON.parse(trimmed) as unknown })).pipe(Effect.orElseSucceed(() => undefined)),
  )
}

// Mask secret values anywhere in a JSON value: a string under a key that
// names a secret, every string inside headers or environment blocks, and the
// same inside strings that carry serialized config (show's text and diffs).
// An MCP server row (its id names `mcp:`) is config through and through — a
// diff hunk of it can show an environment value with its block heading cut
// off — so every value it carries is masked but its identity and type.
export function maskSecrets(value: unknown, inside = false, mcp = false): { value: unknown; masked: number } {
  if (typeof value === "string") {
    if (inside) return { value: "[masked]", masked: 1 }
    return mcp ? maskConfigText(value) : maskText(value)
  }
  if (Array.isArray(value)) {
    const mapped = value.map((entry) => maskSecrets(entry, inside, mcp))
    return { value: mapped.map((entry) => entry.value), masked: mapped.reduce((sum, entry) => sum + entry.masked, 0) }
  }
  if (value === null || typeof value !== "object") return { value, masked: 0 }
  const record = value as Record<string, unknown>
  // The MCP row itself (its id names `mcp:`) keeps its naming fields; nothing
  // inside its config does, a headers or environment block least of all.
  const row = !inside && typeof record.id === "string" && /(^|:)mcp:/.test(record.id)
  const server = mcp || row
  const out: Record<string, unknown> = {}
  const entries = Object.entries(record).map(([key, entry]) => {
    if (row && identityKeys.has(key)) {
      out[key] = entry
      return 0
    }
    // Everything else an MCP row carries is config: text keeps its shape
    // with every value masked, a structure has every string masked.
    const next =
      server && typeof entry !== "string"
        ? maskSecrets(entry, true, true)
        : maskSecrets(entry, inside || secretContainer.test(key) || (isSecretKey(key) && typeof entry === "string"), server)
    out[key] = next.value
    return next.masked
  })
  return { value: out, masked: entries.reduce((sum, count) => sum + count, 0) }
}

// Fields of an MCP row that name it rather than configure it.
const identityKeys = new Set([
  "id",
  "label",
  "kind",
  "view",
  "type",
  "source",
  "badges",
  "status",
  "summary",
  "enabled",
  "path",
  "updated",
  "tokens",
  "keywords",
  "provenance",
  "sections",
])

// An MCP row's config text or diff: every quoted value but `type` is masked,
// and a token-shaped string anywhere.
function maskConfigText(text: string): { value: string; masked: number } {
  const parsed = jsonOf(text)
  if (parsed !== undefined) {
    // Inside the config every value is masked; its shape stays.
    const inner = maskSecrets(parsed.value, true, true)
    return { value: JSON.stringify(inner.value, null, text.includes("\n") ? 2 : undefined), masked: inner.masked }
  }
  let masked = 0
  const pairs = text.replace(/"([^"\\]{1,120})"(\s*:\s*)"(?:[^"\\]|\\.)*"/g, (whole, key: string, colon: string) => {
    if (key === "type") return whole
    masked += 1
    return `"${key}"${colon}"[masked]"`
  })
  const items = pairs.replace(/^([+\- ]\s*)"(?:[^"\\]|\\.)*"(\s*,?\s*)$/gm, (_whole, lead: string, tail: string) => {
    masked += 1
    return `${lead}"[masked]"${tail}`
  })
  const tokens = items.replace(secretToken, () => {
    masked += 1
    return "[masked]"
  })
  return { value: tokens, masked }
}

// ── schema narrowing (pure) ───────────────────────────────────────────────

type Json = Record<string, unknown>

function deref(root: Json, node: unknown): Json | undefined {
  if (node === null || typeof node !== "object") return undefined
  const ref = (node as Json).$ref
  if (typeof ref === "string" && ref.startsWith("#/$defs/")) {
    const defs = root.$defs as Json | undefined
    return deref(root, defs?.[ref.slice("#/$defs/".length)])
  }
  const branches = [(node as Json).anyOf, (node as Json).oneOf].find(Array.isArray) as unknown[] | undefined
  if (branches !== undefined && (node as Json).properties === undefined && (node as Json).enum === undefined) {
    const object = branches.map((branch) => deref(root, branch)).find((branch) => branch?.properties !== undefined || branch?.items !== undefined)
    if (object !== undefined) return object
  }
  return node as Json
}

// The schema node of a field and the object that holds it.
function schemaAt(root: Json, field: string): { parent: Json; key: string; node: Json } | undefined {
  const segments = field.split(".")
  let current: Json | undefined = root
  for (const [index, segment] of segments.entries()) {
    const many = segment.endsWith("[]")
    const key = many ? segment.slice(0, -2) : segment
    const holder: Json | undefined = current === undefined ? undefined : deref(root, current)
    const properties = holder?.properties as Json | undefined
    const child = deref(root, properties?.[key])
    if (holder === undefined || child === undefined) return undefined
    if (index === segments.length - 1 && !many) return { parent: holder, key, node: child }
    current = many ? deref(root, child.items) : child
    if (index === segments.length - 1 && current !== undefined) return { parent: child, key: "items", node: current }
  }
  return undefined
}

function dropLiteral(node: Json, literal: unknown): void {
  if (Array.isArray(node.enum)) node.enum = node.enum.filter((entry) => entry !== literal)
  for (const key of ["anyOf", "oneOf"]) {
    const branches = node[key]
    if (!Array.isArray(branches)) continue
    node[key] = branches.filter((branch) => {
      if (branch === null || typeof branch !== "object") return true
      if ((branch as Json).const === literal) return false
      const inner = (branch as Json).enum
      if (Array.isArray(inner) && inner.length === 1 && inner[0] === literal) return false
      if (Array.isArray(inner)) (branch as Json).enum = inner.filter((entry) => entry !== literal)
      return true
    })
  }
}

// Narrow one tool's JSON schema in place for the rows that are off: a value
// row drops its literal, a param row drops its parameter (or, for a param that
// is only refused at one value, that value). Returns whether anything changed.
export function narrowSchema(schema: Json, rows: readonly PermRow[]): boolean {
  let changed = false
  for (const row of rows) {
    const field = row.item.field
    if (field === undefined || field === "*") continue
    if (row.item.permKind === "value" && !row.on) {
      const found = schemaAt(schema, field)
      if (found === undefined) continue
      dropLiteral(found.node, row.item.value)
      changed = true
      continue
    }
    if (row.item.permKind === "param" && !row.on && row.item.ruleId !== "sessions.other") {
      const found = schemaAt(schema, field)
      if (found === undefined) continue
      const value = row.item.value
      if (value === undefined || value === true) {
        const properties = found.parent.properties as Json | undefined
        if (properties !== undefined) delete properties[found.key]
        if (Array.isArray(found.parent.required)) found.parent.required = found.parent.required.filter((key) => key !== found.key)
        changed = true
        continue
      }
      if (value === 0) {
        found.node.minimum = 1
        changed = true
        continue
      }
      if (value === null) {
        dropLiteral(found.node, null)
        if (Array.isArray(found.node.type)) found.node.type = found.node.type.filter((entry) => entry !== "null")
        changed = true
      }
      continue
    }
    if (row.item.permKind === "limit" && row.on && (row.item.measure ?? "value") === "value") {
      const limit = limitOf(row.text)
      const found = schemaAt(schema, field)
      if (limit === undefined || found === undefined) continue
      found.node.maximum = limit
      changed = true
    }
  }
  return changed
}

// The members an agent may delegate to, from its "Delegate to" rows.
export function delegateTargets(rows: readonly PermRow[]): string[] {
  return rows
    .filter((row) => row.item.category === "to" && row.on && row.item.ruleId !== "to.other-teams")
    .map((row) => (row.item.ruleId ?? "").slice("to.".length))
    .filter((member) => member.length > 0)
    .toSorted()
}

// Narrow every direct tool of one request for its agent.
export function narrowTools(event: Pick<SessionContext, "agent" | "tools">, table: PermissionTable): void {
  const agent = String(event.agent)
  for (const [name, definition] of Object.entries(event.tools)) {
    const rows = table.toolRows(agent, name)
    if (rows.length === 0) continue
    const schema = structuredClone(definition.input) as Json
    const narrowed = narrowSchema(schema, rows)
    const targets = name === "team_delegate" && rows.some((row) => row.item.category === "to") ? delegateTargets(rows) : undefined
    if (targets !== undefined) {
      const role = schemaAt(schema, "role")
      if (role !== undefined && targets.length > 0) role.node.enum = targets
      definition.description = `${definition.description}\n${targets.length > 0 ? `Members you may delegate to: ${targets.join(", ")}.` : "No member of your team is open to you for delegation."}`
    }
    if (narrowed || targets !== undefined) definition.input = schema as typeof definition.input
  }
}

// ── the hooks ───────────────────────────────────────────────────────────────

interface PendingAsk {
  readonly agent: string
  readonly tool: string
  /** The permission action core checks the call under: the one evaluation this ask answers. */
  readonly action: string
  /** waiting: not asked yet; raised: a question is pending; answered: the human let this call run. */
  status: "waiting" | "raised" | "answered"
  /** When the call registered, so an entry a cancelled call left behind can be swept. */
  readonly at: number
  /**
   * Raised while another open entry shared its action under the same key (Code
   * Mode siblings): the question cannot be told apart from its sibling's, so
   * an "always" answer counts as a single yes and exempts no tool.
   */
  ambiguous?: boolean
}

interface PendingShell {
  readonly patterns: readonly string[]
  readonly at: number
}

export interface EnforcementState {
  /**
   * Calls that need the human, by session, message and call id. A direct call
   * owns its key; Code Mode inner calls share their execute call's key. Every
   * evaluation of an entry's permission action under the key asks while any
   * such entry is not answered (or covered by "always"): a sibling under
   * another action never takes it, a sibling under the same action is asked
   * too (the safe side), and core's re-evaluation of a pending request after an
   * "always" to something else still asks. Entries go when their direct call
   * ends, or with the execute call that holds them.
   */
  readonly asks: Map<string, PendingAsk[]>
  /** Raised entries in the order their questions were created, by call key + action, to map each request to its entry. */
  readonly raised: Map<string, PendingAsk[]>
  /**
   * Call key + action pairs that ever held more than one entry (Code Mode
   * siblings): their questions cannot be told apart, now or later, so none of
   * them may answer "always" for a tool.
   */
  readonly shared: Set<string>
  /** agent + tool pairs the human answered "always" for, until the server restarts. */
  readonly always: Set<string>
  /** Shell calls waiting for create.before, by command, with the variables they must not inherit. */
  readonly shells: Map<string, PendingShell[]>
  /** Code Mode inner calls counted per execute call, with when the execute call started. */
  readonly calls: Map<string, { count: number; at: number }>
  /** Each browser tab's current page, from the browser tools' own results. */
  readonly tabs: Map<string, string>
}

export function enforcementState(): EnforcementState {
  return { asks: new Map(), raised: new Map(), shared: new Set(), always: new Set(), shells: new Map(), calls: new Map(), tabs: new Map() }
}

// Remember the page of every tab a browser result reports: a tab itself
// ({ id, url }), a result about one ({ tab: { id, url } }) or the list.
export function rememberTabs(output: unknown, tabs: Map<string, string>): void {
  if (output === null || typeof output !== "object") return
  const record = output as { id?: unknown; url?: unknown; tab?: unknown; tabs?: unknown }
  if (typeof record.id === "string" && record.id.startsWith("tab_") && typeof record.url === "string") tabs.set(record.id, record.url)
  if (record.tab !== undefined) rememberTabs(record.tab, tabs)
  if (Array.isArray(record.tabs)) for (const tab of record.tabs) rememberTabs(tab, tabs)
}

// The variables one shell invocation must not inherit. create.before carries
// no session, so a shell call is matched to its invocation by command text;
// while calls of the same command overlap, each gets the union of what any of
// them strips (stripping more than a call's own rows is the safe side).
export function takeShell(state: EnforcementState, command: string, now = Date.now()): readonly string[] {
  const queued = (state.shells.get(command) ?? []).filter((entry) => now - entry.at < shellWindowMs)
  if (queued.length === 0) {
    state.shells.delete(command)
    return []
  }
  const union = [...new Set(queued.flatMap((entry) => entry.patterns))]
  if (queued.length === 1) state.shells.delete(command)
  else state.shells.set(command, queued.slice(1).map((entry) => ({ patterns: union, at: entry.at })))
  return union
}

// create.before runs as the shell tool starts (before its own permission
// check could wait for a human), so a registration is normally taken within
// milliseconds. One whose command never started (refused by a core rule) only
// makes later identical commands strip more, and goes after an hour.
const shellWindowMs = 60 * 60 * 1000

function callKey(sessionID: string, messageID: string, callID: string): string {
  return `${sessionID}\u0000${messageID}\u0000${callID}`
}

export interface EnforcementDeps {
  /** Whether a session is a delegated team run, which nobody watches. */
  readonly headless: (sessionID: string) => Promise<boolean>
}

// Whether any agent's direct tools need their schema narrowed: a value or
// parameter that is off, a numeric cap that is on, or a member with "Delegate
// to" rows (team_delegate's role then lists exactly the open members).
export function tableNarrows(table: PermissionTable, agents: readonly string[]): boolean {
  return agents.some((agent) =>
    table.rows(agent).some((row) => {
      if (row.item.category === "to") return true
      if (row.item.permKind === "value" || row.item.permKind === "param") return !row.on
      if (row.item.permKind === "limit") return row.on && (row.item.measure ?? "value") === "value"
      return false
    }),
  )
}

// Whether any row the table holds is doing something: a hook costs every tool
// call a lookup, so a publish where nothing is refused, clamped, asked or
// stripped installs none.
export function tableActive(table: PermissionTable, agents: readonly string[]): boolean {
  return agents.some((agent) =>
    table.rows(agent).some((row) => {
      const kind = row.item.permKind
      if (kind === "team") return false
      if (kind === "limit") return row.on && limitOf(row.text) !== undefined
      if (kind === "approval") return row.item.ruleId === "when.delegated" ? !row.on && table.teamMembers.size > 0 : row.on
      if (row.item.ruleId === "team-members.team-members") return !row.on && table.teamMembers.size > 0
      if (row.item.permKind === "input" && row.item.allow === true) return false
      return !row.on
    }),
  )
}

export async function installEnforcement(
  ctx: Context,
  table: PermissionTable,
  state: EnforcementState,
  deps: EnforcementDeps,
): Promise<Registration[]> {
  const directory = String(ctx.location.directory)
  const exists = (file: string) => existsSync(file)
  const before = await hook(() =>
    ctx.tool.hook("execute.before", (event) =>
      Effect.gen(function* () {
        const agent = String(event.agent)
        const sessionID = String(event.sessionID)
        const key = callKey(sessionID, String(event.messageID), String(event.id))
        sweep(state)
        if (event.tool === "execute") state.calls.set(key, { count: 0, at: Date.now() })
        const rows = table.toolRows(agent, event.tool)
        const executeLimit = event.tool === "execute" ? undefined : codeModeLimit(table, agent, state, key)
        if (executeLimit !== undefined) return yield* Effect.fail(new Tool.Error({ message: executeLimit }))
        if (rows.length === 0) return
        const decision = decide(rows, {
          tool: event.tool,
          input: event.input,
          sessionID,
          directory,
          teamMembers: table.teamMembers,
          exists,
          agent,
          tabUrl: (tab) => state.tabs.get(tab),
        })
        if (decision.refuse !== undefined) return yield* Effect.fail(new Tool.Error({ message: decision.refuse }))
        const headless =
          decision.approval !== undefined || decision.headlessRefusal !== undefined
            ? yield* Effect.promise(() => deps.headless(sessionID).catch(() => false))
            : false
        if (headless && decision.headlessRefusal !== undefined)
          return yield* Effect.fail(new Tool.Error({ message: decision.headlessRefusal }))
        if (decision.approval !== undefined && !state.always.has(`${agent}\u0000${event.tool}`)) {
          if (headless)
            return yield* Effect.fail(
              new Tool.Error({
                message: `Permission denied: ${event.tool} needs the human's approval before each call, and nobody watches a delegated run. Finish with needs=[{kind:"decision",detail:"…"}] instead.`,
              }),
            )
          state.asks.set(key, [
            ...(state.asks.get(key) ?? []),
            { agent, tool: event.tool, action: decision.approval, status: "waiting", at: Date.now() },
          ])
        }
        // Every shell call registers, stripping or not, so overlapping calls
        // of one command can be told apart only as a group (takeShell).
        if (event.tool === "shell") {
          const command = stringsAt(event.input, "command")[0]
          if (command !== undefined)
            state.shells.set(command, [...(state.shells.get(command) ?? []), { patterns: decision.stripEnv ?? [], at: Date.now() }])
        }
        if (decision.input !== undefined) event.input = decision.input
      }),
    ),
  )
  const after = await hook(() =>
    ctx.tool.hook("execute.after", (event) =>
      Effect.sync(() => {
        const key = callKey(String(event.sessionID), String(event.messageID), String(event.id))
        // A direct call takes its key's asks with it; a Code Mode inner call
        // leaves them to its execute call, because an inner call that never
        // registered one cannot be told from its siblings.
        if (event.tool === "execute" || !state.calls.has(key)) {
          state.asks.delete(key)
          for (const raised of [...state.raised.keys()]) if (raised.startsWith(`${key}\u0000`)) state.raised.delete(raised)
          for (const pair of [...state.shared]) if (pair.startsWith(`${key}\u0000`)) state.shared.delete(pair)
        }
        if (event.tool === "execute") state.calls.delete(key)
        if (event.status !== "completed") return
        if (event.tool.startsWith("browser_")) rememberTabs(event.result.output, state.tabs)
        const rows = table.toolRows(String(event.agent), event.tool)
        if (rows.length === 0) return
        if (event.tool === "grep") {
          const truncated = (event.result.metadata as { truncated?: unknown } | undefined)?.truncated === true
          const filtered = filterGrep(event.result.output, grepHidden(rows), { directory, truncated })
          if (filtered === undefined) return
          event.result = { ...event.result, output: filtered.output, content: [{ type: "text", text: filtered.text }] }
          return
        }
        if (event.tool.startsWith("instructions_")) {
          const secrets = rows.find((row) => row.item.ruleId === "secrets.values")
          if (secrets === undefined || secrets.on) return
          const masked = maskSecrets(event.result.output)
          if (masked.masked === 0) return
          event.result = { ...event.result, output: masked.value, content: [{ type: "text", text: JSON.stringify(masked.value, null, 2) }] }
        }
      }),
    ),
  )
  const evaluate = await hook(() =>
    ctx.permission.hook("evaluate", (event) =>
      Effect.sync(() => {
        const source = event.source
        if (source?.type !== "tool") return
        const key = callKey(String(event.sessionID), String(source.messageID), String(source.id))
        const open = (state.asks.get(key) ?? []).filter(
          (entry) => entry.action === event.action && entry.status !== "answered" && !state.always.has(`${entry.agent}\u0000${entry.tool}`),
        )
        if (open.length === 0 || event.effect === "deny") return
        const waiting = open.find((entry) => entry.status === "waiting")
        // Code Mode siblings of one action are indistinguishable here: once a
        // key and action held more than one entry, every question under them
        // names every tool it may be about and answers no "always" for a tool.
        const pair = `${key}\u0000${event.action}`
        const all = (state.asks.get(key) ?? []).filter((entry) => entry.action === event.action)
        if (all.length > 1) state.shared.add(pair)
        const shared = state.shared.has(pair)
        const tools = [...new Set((shared ? all : open).map((entry) => entry.tool))]
        event.effect = "ask"
        event.message = `${tools.join(" or ")} asks the human before each call (Permissions → Approval).`
        if (waiting === undefined) return
        waiting.status = "raised"
        waiting.ambiguous = shared
        const raisedKey = `${key}\u0000${event.action}`
        state.raised.set(raisedKey, [...(state.raised.get(raisedKey) ?? []), waiting])
      }),
    ),
  )
  const shell = await hook(() =>
    ctx.shell.hook("create.before", (invocation) =>
      Effect.sync(() => {
        const patterns = takeShell(state, invocation.command)
        if (patterns.length === 0) return
        invocation.env = Object.fromEntries(
          Object.entries(invocation.env).filter(([name]) => !patterns.some((pattern) => wildcardMatch(name, pattern))),
        )
      }),
    ),
  )
  const replies = await listen(ctx, state)
  return [before, after, evaluate, shell, replies].filter((registration): registration is Registration => registration !== undefined)
}

// A Code Mode run past its "Tool calls per run" cap refuses every further
// inner call. Inner calls share the execute call's id, so they are counted
// under it.
function codeModeLimit(table: PermissionTable, agent: string, state: EnforcementState, key: string): string | undefined {
  const entry = state.calls.get(key)
  if (entry === undefined) return undefined
  const count = entry.count
  state.calls.set(key, { count: count + 1, at: entry.at })
  const row = table.toolRows(agent, "execute").find((entry) => entry.item.ruleId === "limits.calls")
  if (row === undefined || !row.on) return undefined
  const limit = limitOf(row.text)
  if (limit === undefined || count + 1 <= limit) return undefined
  return denied(`Tool calls per run is ${limit}; this run made more`)
}

// An interrupted call skips execute.after. What it can leave behind that
// nothing else removes is swept once it is an hour old, and only that: an
// entry still waiting (its call never reached core's check, which follows
// execute.before at once), an answered one (it asks nothing any more), and a
// raised entry whose question event never came (it comes in the same breath).
// A raised question the human has not answered yet stays however long it
// waits, and an execute call's counter stays until that call ends. Cheap: it
// only walks the maps once they have grown.
export function sweep(state: EnforcementState, now = Date.now()): void {
  const stale = (at: number) => now - at > staleMs
  if (state.asks.size > 50)
    for (const [key, entries] of [...state.asks]) {
      const live = entries.filter((entry) => entry.status === "raised" || !stale(entry.at))
      if (live.length === 0) state.asks.delete(key)
      else if (live.length !== entries.length) state.asks.set(key, live)
    }
  if (state.raised.size > 50)
    for (const [key, entries] of [...state.raised]) {
      const live = entries.filter((entry) => !stale(entry.at))
      if (live.length === 0) state.raised.delete(key)
      else if (live.length !== entries.length) state.raised.set(key, live)
    }
}

const staleMs = 60 * 60 * 1000

// "Always" on a Plus approval stops asking for that agent and tool until the
// server restarts; the approval row itself stays on for the next start.
async function listen(ctx: Context, state: EnforcementState): Promise<Registration | undefined> {
  return hook(() =>
    Effect.gen(function* () {
      const byRequest = new Map<string, PendingAsk>()
      yield* ctx.event.subscribe().pipe(
        Stream.filter((event) => event.type === Permission.Event.Asked.type || event.type === Permission.Event.Replied.type),
        Stream.runForEach((event) =>
          Effect.sync(() => {
            const data = event.data as {
              id?: string
              requestID?: string
              reply?: string
              sessionID?: string
              action?: string
              source?: { messageID?: string; id?: string }
            }
            if (event.type === Permission.Event.Asked.type) {
              if (data.id === undefined || data.source?.messageID === undefined || data.source.id === undefined) return
              // A cancelled question never gets a reply: keep the map bounded.
              if (byRequest.size >= 500) {
                const oldest = byRequest.keys().next().value
                if (oldest !== undefined) byRequest.delete(oldest)
              }
              const key = `${callKey(String(data.sessionID), data.source.messageID, data.source.id)}\u0000${data.action ?? ""}`
              const queue = state.raised.get(key) ?? []
              const raised = queue[0]
              if (raised === undefined) return
              if (queue.length > 1) state.raised.set(key, queue.slice(1))
              else state.raised.delete(key)
              byRequest.set(data.id, raised)
              return
            }
            if (data.requestID === undefined) return
            const raised = byRequest.get(data.requestID)
            byRequest.delete(data.requestID)
            if (raised === undefined || data.reply === "reject") return
            // Once or always: this call may run, so its later checks of the
            // same action do not ask again. "Always" exempts the tool only
            // when the question could only have been about it.
            raised.status = "answered"
            if (data.reply === "always" && raised.ambiguous !== true) state.always.add(`${raised.agent}\u0000${raised.tool}`)
          }),
        ),
        Effect.catchCause(() => Effect.void),
        Effect.forkScoped({ startImmediately: true }),
      )
      return { dispose: Effect.void }
    }),
  )
}

// Install one hook on its own scope. A host without the seam (or a test
// context that dies on it) installs nothing: enforcement of that seam is then
// absent, which the tables and the tree still report honestly.
export async function hook(make: () => Effect.Effect<Registration, never, Scope.Scope>): Promise<Registration | undefined> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const registration = yield* Effect.suspend(make).pipe(Effect.provideService(Scope.Scope, scope))
      return {
        dispose: Effect.all([registration.dispose, Scope.close(scope, Exit.void)], { discard: true }),
      } satisfies Registration
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("plus permission hook not installed", { cause }).pipe(Effect.as(undefined)),
      ),
    ),
  )
}

// Categories of a tool in catalog order, for readers that list them.
export function toolCategories(tool: string): readonly string[] {
  return catalogFor(tool).map((category) => category.id)
}
