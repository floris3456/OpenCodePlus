import { TextAttributes } from "@opentui/core"
import { controlItemFor, isControl } from "../../instructions/agent-controls.js"
import { fromLabel } from "../../instructions/from-label.js"
import { applies, catalogueForAddress, matchesName, modelCandidates, parseModelItemId, parsePermItemId, resolve, resolveActiveModel, resolveSplit, sameModelCandidate } from "../../instructions/model.js"
import type { Address, AgentSource, CustomizationRecord, From, Item, ModelRecord, Resolved, SplitRecord } from "../../instructions/model.js"
import { categorySummary } from "../../instructions/permission-catalog.js"
import { presetLabels } from "../../instructions/presets.js"
import { rowTeamOf, sectionResolveOf, splitOf, wholeOf, type Memo } from "../../instructions/resolve-memo.js"
import { curatedRuleMessage, scrubLines } from "../../instructions/tool-permissions.js"
import { agentOf, contextOfSnapshot, itemOf, listingOfSnapshot, recordOf } from "../../instructions/snapshot.js"
import { controlKind, controlValue, withControlItems, type TreeNode } from "../../instructions/tree.js"
import type { Level, Plus, Snapshot } from "../../rpc.js"
import { presetName } from "../preset-picker.js"

// Everything the inspector derives from a snapshot once. The inspector renders
// per keystroke, so rebuilding the item/record/scope projections per fact made
// a tool row cost ~15 ms; one entry per snapshot brings it under 2 ms.
interface Derived {
  readonly items: readonly Item[]
  readonly customizations: readonly CustomizationRecord[]
  readonly splits: readonly SplitRecord[]
  readonly models: readonly ModelRecord[]
  readonly agents: readonly AgentSource[]
  readonly scopes: ReturnType<typeof contextOfSnapshot>
  /** presetKey → label, for "from preset X". */
  readonly labels: ReadonlyMap<string, string>
}

const derivedCache = new WeakMap<Snapshot, Derived>()

function derivedOf(snapshot: Snapshot): Derived {
  const cached = derivedCache.get(snapshot)
  if (cached !== undefined) return cached
  const records = snapshot.records.map(recordOf)
  const value: Derived = {
    items: withControlItems(snapshot.items.map(itemOf)),
    customizations: records.filter((record): record is CustomizationRecord => record.type === "customization"),
    splits: records.filter((record): record is SplitRecord => record.type === "split"),
    models: records.filter((record): record is ModelRecord => record.type === "model"),
    agents: snapshot.agents.map(agentOf),
    scopes: contextOfSnapshot(snapshot),
    labels: presetLabels(listingOfSnapshot(snapshot)),
  }
  derivedCache.set(snapshot, value)
  return value
}

function upstreamFor(items: readonly Item[], address: Address): Item | undefined {
  if (isControl(address.item)) return controlItemFor(items, address)
  const matches = items.filter((entry) => entry.id === address.item)
  const owner = address.agent
  if (owner === null) return matches[0]
  return matches.find((entry) => applies(entry, owner)) ?? matches[0]
}

// The row's resolved value: through the shared memo when the inspector has it,
// so a row the tree already resolved is a cache hit, not a fresh resolve.
function resolveAt(derived: Derived, address: Address, item: Item, memo?: Memo): Resolved {
  if (memo === undefined)
    return resolve({ upstream: item, records: derived.customizations, splits: derived.splits, scopes: derived.scopes, address })
  if (address.section === null) return wholeOf(memo, address.level, address.agent, item, address.catalogue, rowTeamOf(address))
  return sectionResolveOf(memo, address.level, address.agent, item, address.section, address.catalogue, rowTeamOf(address))
}

function isModelAddress(address: Address): boolean {
  return address.item.startsWith("model:")
}

function upstreamModelOf(derived: Derived, agent: string | null): { providerID: string; modelID: string; variant?: string } | undefined {
  if (agent === null) return undefined
  const entry = derived.agents.find((candidate) => candidate.id === agent)
  return entry?.model
}

export function modelDetail(
  node: TreeNode,
  snapshot: Snapshot,
): { providerID: string; modelID: string; variant?: string; source: Level | "upstream"; active: boolean } | undefined {
  const address = node.address
  if (address === undefined || !isModelAddress(address)) return undefined
  const parsed = parseModelItemId(address.item)
  if (parsed === undefined) return undefined
  const derived = derivedOf(snapshot)
  const scopes = derived.scopes
  const models = derived.models
  const upstream = upstreamModelOf(derived, address.agent)
  // The row's whole address: a member's or Special agent's team, the Teams
  // catalogue — the chain its tree row resolves.
  const input = {
    models,
    scopes,
    level: address.level,
    agent: address.agent,
    ...(address.team === undefined ? {} : { team: address.team }),
    ...(address.catalogue === undefined ? {} : { catalogue: address.catalogue }),
    ...(address.memberOf === undefined ? {} : { memberOf: address.memberOf }),
    ...(upstream === undefined ? {} : { upstream }),
  }
  const candidate = modelCandidates(input).find((entry) => sameModelCandidate(entry, parsed))
  if (candidate === undefined) return undefined
  const active = resolveActiveModel(input)
  return {
    providerID: candidate.providerID,
    modelID: candidate.modelID,
    ...(candidate.variant === undefined ? {} : { variant: candidate.variant }),
    source: candidate.source,
    active: active !== undefined && sameModelCandidate(active, candidate),
  }
}

export function resolveNode(node: TreeNode, snapshot: Snapshot, memo?: Memo): Resolved | undefined {
  const address = node.address
  if (address === undefined) return undefined
  const derived = derivedOf(snapshot)
  const upstream = upstreamFor(derived.items, address)
  if (upstream === undefined) return undefined
  return resolveAt(derived, address, upstream, memo)
}

export function resolvedText(node: TreeNode, snapshot: Snapshot, memo?: Memo): string {
  const resolved = resolveNode(node, snapshot, memo)
  if (!resolved) return "No item details"
  return resolved.text
}

export function scrubInfo(
  node: TreeNode,
  snapshot: Snapshot,
  memo?: Memo,
): { hidden: number; preview: readonly string[]; keywords: readonly string[] } | undefined {
  const address = node.address
  if (address === undefined) return undefined
  const derived = derivedOf(snapshot)
  if (address.item.startsWith("perm:")) {
    const upstream = upstreamFor(derived.items, address)
    if (upstream?.kind !== "perm") return undefined
    const keywords = upstream.keywords === undefined ? [] : [...upstream.keywords]
    if (keywords.length === 0) return { hidden: 0, preview: [], keywords: [] }
    const parent = derived.items.find((entry) => entry.id === `tool:${upstream.permTool ?? ""}`)
    if (parent === undefined) return { hidden: 0, preview: [], keywords }
    const scrubbed = scrubLines(parent.text, keywords)
    return { hidden: scrubbed.hidden, preview: scrubbed.preview, keywords }
  }
  const keywords = derived.items.flatMap((item) => {
    if (item.kind !== "perm" || item.keywords === undefined) return []
    const owner = address.agent
    if (owner === null) {
      if (item.agents !== undefined) return []
    } else if (!applies(item, owner)) return []
    // The same owner, team and catalogue as the row: only the item differs.
    const state = resolveAt(derived, { ...address, item: item.id, section: null }, item, memo)
    if (state.enabled) return []
    return [...item.keywords]
  })
  const unique = [...new Set(keywords)]
  if (unique.length === 0) return undefined
  const resolved = resolveNode(node, snapshot, memo)
  if (resolved === undefined) return undefined
  const scrubbed = scrubLines(resolved.text, unique)
  if (scrubbed.hidden === 0) return undefined
  return { hidden: scrubbed.hidden, preview: scrubbed.preview, keywords: unique }
}

export function permDetail(
  node: TreeNode,
  snapshot: Snapshot,
): {
  tool: string
  rule: string
  patterns: readonly string[]
  keywords: readonly string[]
  provenance: readonly string[]
  custom: boolean
  message?: string
  enforcement: string
} | undefined {
  const address = node.address
  if (address === undefined) return undefined
  const derived = derivedOf(snapshot)
  const upstream = upstreamFor(derived.items, address)
  if (upstream?.kind !== "perm") return undefined
  const parsed = parsePermItemId(address.item)
  if (parsed === undefined) return undefined
  const tool = upstream.permTool ?? parsed.tool
  const rule = upstream.ruleId ?? parsed.ruleId
  // A user rule's own stored message wins; a curated row ships one; a mined
  // row has none and keeps core's generic refusal.
  const message =
    upstream.custom === true
      ? snapshot.records.find(
          (record): record is Plus.SnapshotRuleRecord => record.type === "rule" && record.tool === tool && record.id === rule,
        )?.message ?? upstream.message
      : curatedRuleMessage(tool, rule) ?? upstream.message
  return {
    enforcement: enforcementLine(upstream),
    tool,
    rule,
    patterns: upstream.patterns === undefined ? [] : [...upstream.patterns],
    keywords: upstream.keywords === undefined ? [] : [...upstream.keywords],
    provenance: upstream.provenance === undefined ? [] : [...upstream.provenance],
    custom: upstream.custom === true,
    ...(message === undefined ? {} : { message }),
  }
}

// How a permission row takes effect, in one line for the detail pane.
export function enforcementLine(item: Item): string {
  const kind = item.permKind ?? "rule"
  const field = item.field === undefined ? "" : ` (${item.field})`
  if (kind === "rule") {
    if (item.policy !== undefined) return `role rule: installs its own core rules on ${item.permAction ?? item.permTool ?? "its action"}`
    return `core rule on ${item.permAction ?? item.permTool ?? "the tool"}: off refuses what the patterns match`
  }
  if (kind === "input" && item.fallback === true && item.category === "where")
    return `tool input${field}: off refuses paths outside this checkout unless an allowed row below matches`
  if (kind === "input" && item.fallback === true) return `tool input${field}: off refuses everything this category's allowed rows do not let through`
  if (kind === "input" && item.allow === true) return `tool input${field}: on lets its patterns through while this category's first row is off`
  if (kind === "input") return `tool input${field}: off refuses a call whose value matches the patterns`
  if (kind === "value") return `tool input${field}: off removes "${String(item.value)}" from the schema and refuses it`
  if (kind === "param") return `tool input${field}: off removes the parameter from the schema and refuses a call that uses it`
  if (kind === "limit") return `limit on ${item.field ?? "the call"} (${item.measure ?? "value"}, ${item.mode === "clamp" ? "lowered to the cap" : "refused above it"}): on applies the number`
  if (kind === "approval") return "approval: on asks the human before the call; a delegated run is refused instead"
  if (kind === "env") return "shell environment: off strips the matching variables before the command starts"
  if (item.permTool === "team_get_context" && (item.category === "accepts" || item.category === "limits"))
    return "read by team_delegate and team_followup for this member when a brief or a correction names it, not for the caller"
  if (item.permTool === "team_get_context" && item.category === "bootstrap")
    return "read by the team tools when a chat of this member calls one with no team run yet"
  return "read by the team tools themselves, for the member that calls them"
}

// A Permissions category group's one-line summary, from its id
// (group:<level>:<owner>:tool:<id>:permissions:<category>).
export function categoryDetail(node: TreeNode): string | undefined {
  if (node.kind !== "group") return undefined
  const match = node.id.match(/:tool:([^:]+):permissions(?::(.+))?$/)
  if (match === null) return undefined
  const tool = match[1] ?? ""
  const category = match[2]
  if (category === undefined) return `Every permission of ${tool}, one group per category. Rows are on/off; enter edits a rule's patterns or a limit's number.`
  return categorySummary(tool, category)
}

export function isEditable(node: TreeNode | undefined): boolean {
  if (!node) return false
  if (node.address === undefined) return false
  if (node.address.item.startsWith("perm:")) return false
  const control = controlKind(node.address.item)
  if (control === "cycle" || control === "toggle" || node.badges.disabled !== undefined) return false
  return node.actions?.edit === true
}

export function controlDetail(node: TreeNode, snapshot: Snapshot, memo?: Memo): string[] {
  if (node.enabledRow !== undefined) return [
    node.badges.state === "off" ? "Off: this agent cannot be selected or launched." : "On: this agent is enabled.",
    node.badges.hidden === true ? "Hidden: omitted from the picker; enablement is separate." : "Visible: picker availability also depends on Mode.",
    ...(node.badges.mode ? [`Mode: ${node.badges.mode}`] : []),
  ]
  const item = node.address?.item
  if (item === undefined || controlKind(item) === undefined) return []
  const resolved = resolveNode(node, snapshot, memo)
  if (resolved === undefined) return []
  const help = item === "setting:enabled" ? "Off disables the agent. Its settings remain editable so it can be re-enabled."
    : item === "setting:hidden" ? "On hides the agent from the picker; it does not disable the agent."
    : item === "setting:mode" ? "Enter cycles Primary → Subagent → All."
    : item === "setting:steps" ? "Positive whole-number step limit; empty means unlimited. Reset follows the value above."
    : item === "setting:color" ? "Agent display color (#RRGGBB); empty clears the color. Reset follows the value above."
    : item === "compaction:strategy" ? "Enter cycles Auto → Local → Remote. Remote requires provider support."
    : item === "compaction:model" ? "Local model (provider/model#variant); empty inherits the maintenance compaction model, otherwise the active session model."
    : item === "compaction:instructions" ? "Local compaction instructions; empty saves an empty prompt. Reset follows inherited instructions, including the global compaction agent."
    : "Reset removes only this level's override."
  return [
    `Value: ${controlValue(item, resolved.text, resolved.enabled)}`,
    help,
    ...(node.badges.disabled === undefined ? [] : [node.badges.disabled]),
  ]
}

export function displayLevel(level: Resolved["source"] | Address["level"]): string {
  if (level === "upstream") return "upstream"
  if (level === "project") return "Project"
  if (level === "global") return "Global"
  if (level === "preset") return "Preset"
  return "Defaults"
}

// Where the row's values come from, in the tree's words (from-label.ts): one
// source for state and text, or "state: from preset Orchestrator · text:
// upstream" when they differ. A value this level sets reads "set here
// (Project)".
export function provenanceLine(node: TreeNode, snapshot: Snapshot, memo?: Memo): string | undefined {
  const address = node.address
  if (address === undefined) return node.enabledRow === undefined ? undefined : `enabled: ${node.badges.fromLabel ?? "inherited"}`
  const labels = derivedOf(snapshot).labels
  const say = (from: From) => {
    const label = fromLabel(from, { labels, level: address.level })
    return label === "set here" ? `set here (${displayLevel(address.level)})` : label
  }
  const control = controlKind(address.item)
  if (control !== undefined) {
    const resolved = resolveNode(node, snapshot, memo)
    if (resolved === undefined) return undefined
    return `value: ${say(control === "toggle" ? resolved.from : resolved.textFrom)}`
  }
  if (isModelAddress(address)) {
    const detail = modelDetail(node, snapshot)
    if (detail === undefined) return undefined
    const source = node.badges.from === undefined ? displayLevel(detail.source) : say(node.badges.from)
    return detail.active ? `active model: ${source}` : `candidate: ${source}`
  }
  const from = node.badges.from
  if (from === undefined) {
    const resolved = resolveNode(node, snapshot, memo)
    if (!resolved) return undefined
    return `state: ${say(resolved.from)} · text: ${say(resolved.textFrom)}`
  }
  const textFrom = node.badges.textFrom
  if (textFrom === undefined) return `state and text: ${say(from)}`
  return `state: ${say(from)} · text: ${say(textFrom)}`
}

/**
 * The preset an agent, member, team, Defaults entry or User preset follows:
 * "Created from preset: Orchestrator (Plus)", or "No preset". Nothing for rows
 * that take no link (a Teams entry pattern, a shipped preset of its own).
 */
export function linkLine(node: TreeNode, snapshot: Snapshot): string | undefined {
  const owner = node.owner
  if (owner === undefined) return undefined
  if (owner.level === "defaults" && owner.agent === null) return undefined
  if (owner.link === undefined) return owner.preset !== undefined && owner.preset.origin !== "user" ? undefined : "No preset"
  if (owner.linkMissing === true)
    return `Created from preset: ${presetName(snapshot, owner.link)} — missing (deleted); its rows fall through to the rest of the chain. Relink with l`
  return `Created from preset: ${presetName(snapshot, owner.link)}`
}

/**
 * A Defaults entry's pattern and what it matches now (DESIGN §4): Agents
 * entries match agents by name, Teams entries members of the teams their team
 * pattern matches; a team pattern row lists the teams.
 */
export function matchLines(node: TreeNode, snapshot: Snapshot): string[] {
  const entry = node.owner?.entry
  if (entry === undefined) return []
  const listed = (names: readonly string[]) => (names.length === 0 ? "matching now: nothing yet" : `matching now: ${names.join(", ")}`)
  if (entry.catalogue === "agents") {
    const name = entry.name ?? node.label
    return [`matches agents named: ${name}`, listed([...new Set(derivedOf(snapshot).agents.map((agent) => agent.id))].filter((id) => matchesName(name, id)))]
  }
  const pattern = entry.team ?? "*"
  const teams = (snapshot.teams ?? []).filter((team) => matchesName(pattern, team.team))
  if (entry.name === undefined) return [`matches teams named: ${pattern}`, listed([...new Set(teams.map((team) => team.team))])]
  const name = entry.name
  return [
    `matches members named: ${name} in teams named: ${pattern}`,
    listed([...new Set(teams.flatMap((team) => team.agents.filter((member) => matchesName(name, member)).map((member) => `${team.team} › ${member}`)))]),
  ]
}

export interface SectionRow {
  readonly id: string
  readonly name: string
  readonly excluded: boolean
}

export function sectionRows(node: TreeNode, snapshot: Snapshot, memo?: Memo): SectionRow[] {
  const address = node.address
  if (address === undefined || address.section !== null) return []
  if (controlKind(address.item) !== undefined) return []
  if (isModelAddress(address)) return []
  const derived = derivedOf(snapshot)
  const upstream = upstreamFor(derived.items, address)
  if (upstream === undefined) return []
  const whole = resolveAt(derived, address, upstream, memo)
  const split =
    memo === undefined
      ? resolveSplit({ text: whole.text, title: upstream.title, splits: derived.splits, scopes: derived.scopes, address })
      : splitOf(memo, address.level, address.agent, upstream, address.catalogue, rowTeamOf(address))
  return split.sections.map((section) => {
    const sectionResolved = resolveAt(derived, { ...address, section: section.id }, upstream, memo)
    return { id: section.id, name: section.name, excluded: !sectionResolved.enabled }
  })
}

export function parentItemTitle(node: TreeNode, snapshot: Snapshot): string | undefined {
  const address = node.address
  if (address === undefined || address.section === null) return undefined
  return upstreamFor(derivedOf(snapshot).items, address)?.title
}

export function sectionExcluded(node: TreeNode, snapshot: Snapshot, memo?: Memo): boolean {
  const address = node.address
  if (address === undefined || address.section === null) return false
  const resolved = resolveNode(node, snapshot, memo)
  if (!resolved) return false
  return !resolved.enabled
}

export interface ExcludedRange {
  readonly start: number
  readonly end: number
}

// Whole-item detail shows the resolved text the agent receives with excluded
// section ranges struck through. Ranges come from resolveSplit + section
// ranges (never string matching): excluded parents cover their full range,
// leaf ranges keep text from doubling, matching assemble() semantics.
export function excludedRanges(node: TreeNode, snapshot: Snapshot, memo?: Memo): ExcludedRange[] {
  const address = node.address
  if (address === undefined || address.section !== null) return []
  if (controlKind(address.item) !== undefined) return []
  const derived = derivedOf(snapshot)
  const upstream = upstreamFor(derived.items, address)
  if (upstream === undefined) return []
  const whole = resolveAt(derived, address, upstream, memo)
  const split =
    memo === undefined
      ? resolveSplit({ text: whole.text, title: upstream.title, splits: derived.splits, scopes: derived.scopes, address })
      : splitOf(memo, address.level, address.agent, upstream, address.catalogue, rowTeamOf(address))
  const excluded = new Set<string>()
  for (const section of split.sections) {
    const sectionResolved = resolveAt(derived, { ...address, section: section.id }, upstream, memo)
    if (!sectionResolved.enabled) excluded.add(section.id)
  }
  if (excluded.size === 0) return []
  const ordered = [...split.sections].sort((left, right) => left.start - right.start || left.depth - right.depth)
  const dropped = (id: string) => {
    const parts = id.split("/")
    return parts.some((_, index) => excluded.has(parts.slice(0, index + 1).join("/")))
  }
  const children = new Map<number, number[]>()
  const parents: (number | undefined)[] = ordered.map(() => undefined)
  const stack: number[] = []
  ordered.forEach((section, index) => {
    while (stack.length > 0) {
      const top = ordered[stack[stack.length - 1]]
      if (top.depth < section.depth && top.end > section.start) break
      stack.pop()
    }
    parents[index] = stack.length > 0 ? stack[stack.length - 1] : undefined
    stack.push(index)
  })
  parents.forEach((parent, index) => {
    if (parent === undefined) return
    const list = children.get(parent) ?? []
    list.push(index)
    children.set(parent, list)
  })
  const ranges: ExcludedRange[] = []
  ordered.forEach((section, index) => {
    if (!dropped(section.id)) return
    const parent = parents[index]
    if (parent !== undefined && dropped(ordered[parent].id)) return
    const starts = (children.get(index) ?? []).map((child) => ordered[child].start)
    const ownEnd = starts.length > 0 ? Math.min(...starts) : section.end
    if (ownEnd > section.start) ranges.push({ start: section.start, end: ownEnd })
  })
  return ranges.sort((left, right) => left.start - right.start)
}

export function isExcludedOffset(ranges: readonly ExcludedRange[], offset: number): boolean {
  return ranges.some((range) => offset >= range.start && offset < range.end)
}

// Excluded rows render struck through via the supported OpenTUI text
// attribute. The visible "[excluded]" label carries the same fact as text so
// the state survives renderers that drop attributes.
export function excludedAttributes(excluded: boolean) {
  return excluded ? TextAttributes.STRIKETHROUGH : undefined
}

export function wholeItemText(node: TreeNode, snapshot: Snapshot, memo?: Memo): { text: string; ranges: ExcludedRange[] } {
  const text = resolvedText(node, snapshot, memo)
  if (node.address?.section !== null) return { text, ranges: [] }
  return { text, ranges: excludedRanges(node, snapshot, memo) }
}

export function renderRanges(text: string, ranges: readonly ExcludedRange[]): { body: string; excluded: boolean }[] {
  if (ranges.length === 0) return [{ body: text, excluded: false }]
  const points = [0, text.length]
  for (const range of ranges) {
    points.push(Math.max(0, Math.min(text.length, range.start)))
    points.push(Math.max(0, Math.min(text.length, range.end)))
  }
  const sorted = [...new Set(points)].sort((left, right) => left - right)
  const parts: { body: string; excluded: boolean }[] = []
  for (let index = 0; index + 1 < sorted.length; index++) {
    const start = sorted[index]
    const end = sorted[index + 1]
    if (start === undefined || end === undefined || end <= start) continue
    parts.push({ body: text.slice(start, end), excluded: isExcludedOffset(ranges, start) })
  }
  return parts
}

// The catalogue is part of the address line because the same agent resolves
// differently depending on which catalogue it was reached through: a
// stand-alone agent row inherits the Agents catalogue's Defaults, a team
// member row the Teams catalogue's.
export function addressLine(node: TreeNode): string | undefined {
  const address = node.address
  if (address === undefined) return undefined
  const head = address.agent === null ? displayLevel(address.level) : `${displayLevel(address.level)} · ${address.agent}`
  const tail = address.section === null ? address.item : `${address.item} · ${address.section}`
  return `${head} · catalogue: ${catalogueForAddress(address)} · ${tail}`
}
