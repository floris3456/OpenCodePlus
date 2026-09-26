import { TextAttributes } from "@opentui/core"
import type { Plugin } from "@opencode/plugin/tui"
import { createEffect, For, Show } from "solid-js"
import { fromLabel } from "../../instructions/from-label.js"
import { applies, catalogueForAddress, matchesName, modelCandidates, parseModelItemId, parsePermItemId, resolve, resolveActiveModel, resolveSplit, sameModelCandidate } from "../../instructions/model.js"
import type { Address, AgentSource, CustomizationRecord, From, Item, ModelRecord, Resolved, SplitRecord } from "../../instructions/model.js"
import { categorySummary } from "../../instructions/permission-catalog.js"
import { presetLabels } from "../../instructions/presets.js"
import { curatedRuleMessage, scrubLines } from "../../instructions/tool-permissions.js"
import { agentOf, contextOfSnapshot, itemOf, listingOfSnapshot, recordOf } from "../../instructions/snapshot.js"
import type { TreeNode } from "../../instructions/tree.js"
import type { Level, Plus, Snapshot } from "../../rpc.js"
import { presetName } from "../preset-picker.js"
import { badgeColor, badgeLabels } from "./tree-pane.js"

export interface DetailPaneState {
  saveText: (node: TreeNode, text: string) => Promise<boolean>
}

export interface DetailPaneProps {
  context: Plugin.Context
  node: () => TreeNode | undefined
  snapshot: () => Snapshot | undefined
  state: DetailPaneState
  editing: () => boolean
  onEditingChange: (editing: boolean) => void
  draft: () => string
  onDraftChange: (draft: string) => void
}

function agentsOf(snapshot: Snapshot): AgentSource[] {
  return snapshot.agents.map(agentOf)
}

function itemsOf(snapshot: Snapshot): Item[] {
  return snapshot.items.map(itemOf)
}

function customizationsOf(snapshot: Snapshot): CustomizationRecord[] {
  return snapshot.records
    .map(recordOf)
    .filter((record): record is CustomizationRecord => record.type === "customization")
}

function splitsOf(snapshot: Snapshot): SplitRecord[] {
  return snapshot.records.map(recordOf).filter((record): record is SplitRecord => record.type === "split")
}

function upstreamFor(items: readonly Item[], address: Address): Item | undefined {
  const matches = items.filter((entry) => entry.id === address.item)
  const owner = address.agent
  if (owner === null) return matches[0]
  return matches.find((entry) => applies(entry, owner)) ?? matches[0]
}

function isModelAddress(address: Address): boolean {
  return address.item.startsWith("model:")
}

function modelsOfSnapshot(snapshot: Snapshot): ModelRecord[] {
  return snapshot.records
    .map(recordOf)
    .filter((record): record is ModelRecord => record.type === "model")
}

function upstreamModelOf(snapshot: Snapshot, agent: string | null): { providerID: string; modelID: string; variant?: string } | undefined {
  if (agent === null) return undefined
  const entry = agentsOf(snapshot).find((candidate) => candidate.id === agent)
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
  const scopes = contextOfSnapshot(snapshot)
  const models = modelsOfSnapshot(snapshot)
  const upstream = upstreamModelOf(snapshot, address.agent)
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

export function resolveNode(node: TreeNode, snapshot: Snapshot): Resolved | undefined {
  const address = node.address
  if (address === undefined) return undefined
  const upstream = upstreamFor(itemsOf(snapshot), address)
  if (upstream === undefined) return undefined
  return resolve({
    upstream,
    records: customizationsOf(snapshot),
    splits: splitsOf(snapshot),
    scopes: contextOfSnapshot(snapshot),
    address,
  })
}

export function resolvedText(node: TreeNode, snapshot: Snapshot): string {
  const resolved = resolveNode(node, snapshot)
  if (!resolved) return "No item details"
  return resolved.text
}

export function scrubInfo(
  node: TreeNode,
  snapshot: Snapshot,
): { hidden: number; preview: readonly string[]; keywords: readonly string[] } | undefined {
  const address = node.address
  if (address === undefined) return undefined
  if (address.item.startsWith("perm:")) {
    const upstream = upstreamFor(itemsOf(snapshot), address)
    if (upstream?.kind !== "perm") return undefined
    const keywords = upstream.keywords === undefined ? [] : [...upstream.keywords]
    if (keywords.length === 0) return { hidden: 0, preview: [], keywords: [] }
    const parent = itemsOf(snapshot).find((entry) => entry.id === `tool:${upstream.permTool ?? ""}`)
    if (parent === undefined) return { hidden: 0, preview: [], keywords }
    const scrubbed = scrubLines(parent.text, keywords)
    return { hidden: scrubbed.hidden, preview: scrubbed.preview, keywords }
  }
  const items = itemsOf(snapshot)
  const records = customizationsOf(snapshot)
  const splits = splitsOf(snapshot)
  const scopes = contextOfSnapshot(snapshot)
  const keywords = items.flatMap((item) => {
    if (item.kind !== "perm" || item.keywords === undefined) return []
    const owner = address.agent
    if (owner === null) {
      if (item.agents !== undefined) return []
    } else if (!applies(item, owner)) return []
    // The same owner, team and catalogue as the row: only the item differs.
    const state = resolve({ upstream: item, records, splits, scopes, address: { ...address, item: item.id, section: null } })
    if (state.enabled) return []
    return [...item.keywords]
  })
  const unique = [...new Set(keywords)]
  if (unique.length === 0) return undefined
  const resolved = resolveNode(node, snapshot)
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
  const upstream = upstreamFor(itemsOf(snapshot), address)
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
  return node.actions?.edit === true
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
export function provenanceLine(node: TreeNode, snapshot: Snapshot): string | undefined {
  const address = node.address
  if (address === undefined) return undefined
  const labels = presetLabels(listingOfSnapshot(snapshot))
  const say = (from: From) => {
    const label = fromLabel(from, { labels, level: address.level })
    return label === "set here" ? `set here (${displayLevel(address.level)})` : label
  }
  if (isModelAddress(address)) {
    const detail = modelDetail(node, snapshot)
    if (detail === undefined) return undefined
    const source = node.badges.from === undefined ? displayLevel(detail.source) : say(node.badges.from)
    return detail.active ? `active model: ${source}` : `candidate: ${source}`
  }
  const from = node.badges.from
  if (from === undefined) {
    const resolved = resolveNode(node, snapshot)
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
    return [`matches agents named: ${name}`, listed([...new Set(snapshot.agents.map((agent) => agent.id))].filter((id) => matchesName(name, id)))]
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

export function sectionRows(node: TreeNode, snapshot: Snapshot): SectionRow[] {
  const address = node.address
  if (address === undefined || address.section !== null) return []
  if (isModelAddress(address)) return []
  const upstream = upstreamFor(itemsOf(snapshot), address)
  if (upstream === undefined) return []
  const records = customizationsOf(snapshot)
  const splits = splitsOf(snapshot)
  const scopes = contextOfSnapshot(snapshot)
  const whole = resolve({ upstream, records, splits, scopes, address })
  const split = resolveSplit({ text: whole.text, title: upstream.title, splits, scopes, address })
  return split.sections.map((section) => {
    const sectionAddress: Address = { ...address, section: section.id }
    const sectionResolved = resolve({ upstream, records, splits, scopes, address: sectionAddress })
    return { id: section.id, name: section.name, excluded: !sectionResolved.enabled }
  })
}

export function parentItemTitle(node: TreeNode, snapshot: Snapshot): string | undefined {
  const address = node.address
  if (address === undefined || address.section === null) return undefined
  return upstreamFor(itemsOf(snapshot), address)?.title
}

export function sectionExcluded(node: TreeNode, snapshot: Snapshot): boolean {
  const address = node.address
  if (address === undefined || address.section === null) return false
  const resolved = resolveNode(node, snapshot)
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
export function excludedRanges(node: TreeNode, snapshot: Snapshot): ExcludedRange[] {
  const address = node.address
  if (address === undefined || address.section !== null) return []
  const upstream = upstreamFor(itemsOf(snapshot), address)
  if (upstream === undefined) return []
  const records = customizationsOf(snapshot)
  const splits = splitsOf(snapshot)
  const scopes = contextOfSnapshot(snapshot)
  const whole = resolve({ upstream, records, splits, scopes, address })
  const split = resolveSplit({ text: whole.text, title: upstream.title, splits, scopes, address })
  const excluded = new Set<string>()
  for (const section of split.sections) {
    const sectionAddress: Address = { ...address, section: section.id }
    const sectionResolved = resolve({ upstream, records, splits, scopes, address: sectionAddress })
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

function wholeItemText(node: TreeNode, snapshot: Snapshot): { text: string; ranges: ExcludedRange[] } {
  const text = resolvedText(node, snapshot)
  if (node.address?.section !== null) return { text, ranges: [] }
  return { text, ranges: excludedRanges(node, snapshot) }
}

function renderRanges(text: string, ranges: readonly ExcludedRange[]): { body: string; excluded: boolean }[] {
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
function addressLine(node: TreeNode): string | undefined {
  const address = node.address
  if (address === undefined) return undefined
  const head = address.agent === null ? displayLevel(address.level) : `${displayLevel(address.level)} · ${address.agent}`
  const tail = address.section === null ? address.item : `${address.item} · ${address.section}`
  return `${head} · catalogue: ${catalogueForAddress(address)} · ${tail}`
}

export function DetailPane(props: DetailPaneProps) {
  let area: { plainText: string; isDestroyed: boolean; focus(): void; blur(): void; gotoBufferEnd(): void } | undefined

  function editable(): boolean {
    return isEditable(props.node())
  }

  function cancelEditing() {
    area?.blur()
    props.onDraftChange("")
    props.onEditingChange(false)
  }

  async function saveEditing() {
    const target = area
    const node = props.node()
    if (!target || target.isDestroyed || !node) return
    props.onDraftChange(target.plainText)
    const saved = await props.state.saveText(node, target.plainText)
    if (saved) cancelEditing()
  }

  function isEditing(): boolean {
    return props.editing() && editable()
  }

  createEffect(() => {
    if (!isEditing()) return
    const target = area
    if (!target || target.isDestroyed) return
    target.focus()
    target.gotoBufferEnd()
  })

  // Drafts belong to one node: leaving the node discards the editor
  // instead of saving stale text against a new target. Snapshot changes
  // alone must not discard: a stale-revision save adopts the new snapshot
  // and keeps the draft so the user can save again.
  createEffect((previous: string | undefined) => {
    const node = props.node()
    const current = node?.id
    if (previous !== undefined && current !== previous && props.editing()) cancelEditing()
    return current
  }, undefined)

  props.context.keymap.layer(() => {
    if (!isEditing()) {
      const node = props.node()
      const snapshot = props.snapshot()
      if (!node || !snapshot) return { commands: [] }
      if (!editable()) return { commands: [] }
      return {
        commands: [
          {
            bind: "e",
            title: "Edit text",
            group: "Instructions",
            run: () => {
              props.onDraftChange(resolvedText(node, snapshot))
              props.onEditingChange(true)
            },
          },
        ],
      }
    }
    return {
      commands: [
        { bind: "ctrl+s", title: "Save text", group: "Instructions", run: () => void saveEditing() },
        { bind: "escape", title: "Cancel editing", group: "Instructions", run: cancelEditing },
      ],
    }
  })

  return (
    <box flexGrow={1} flexDirection="column" minHeight={0} paddingLeft={1} paddingRight={1}>
      <Show
        when={props.node()}
        fallback={
          <text flexShrink={0} fg={props.context.theme.text.subdued}>
            Select an item
          </text>
        }
      >
        {(node) => (
          <box flexDirection="column" gap={1} flexGrow={1} minHeight={0}>
            <text flexShrink={0} fg={props.context.theme.text.default}>
              {node().label} ({node().kind})
            </text>
            <Show when={addressLine(node())}>
              {(line) => (
                <text flexShrink={0} fg={props.context.theme.text.subdued}>
                  {line()}
                </text>
              )}
            </Show>
            <Show when={props.snapshot()}>
              {(snapshot) => (
                <>
                  <Show when={provenanceLine(node(), snapshot())}>
                    {(line) => (
                      <text flexShrink={0} fg={props.context.theme.text.subdued}>
                        {line()}
                      </text>
                    )}
                  </Show>
                  <Show when={linkLine(node(), snapshot())}>
                    {(line) => (
                      <text flexShrink={0} fg={props.context.theme.text.subdued}>
                        {line()}
                      </text>
                    )}
                  </Show>
                  <For each={matchLines(node(), snapshot())}>
                    {(line) => (
                      <text flexShrink={0} fg={props.context.theme.text.subdued}>
                        {line}
                      </text>
                    )}
                  </For>
                  <For each={badgeLabels(node())}>
                    {(label) => (
                      <text flexShrink={0} fg={badgeColor(props.context, label)}>
                        {label}
                      </text>
                    )}
                  </For>
                  <Show when={modelDetail(node(), snapshot())}>
                    {(detail) => (
                      <box flexDirection="column" flexShrink={0}>
                        <text flexShrink={0} fg={props.context.theme.text.subdued}>
                          {`provider: ${detail().providerID}`}
                        </text>
                        <text flexShrink={0} fg={props.context.theme.text.subdued}>
                          {`model: ${detail().modelID}`}
                        </text>
                        <Show when={detail().variant}>
                          {(variant) => (
                            <text flexShrink={0} fg={props.context.theme.text.subdued}>
                              {`variant: ${variant()}`}
                            </text>
                          )}
                        </Show>
                        <text flexShrink={0} fg={props.context.theme.text.subdued}>
                          {`source: ${displayLevel(detail().source)}${detail().active ? " · active" : ""}`}
                        </text>
                      </box>
                    )}
                  </Show>
                  <Show when={categoryDetail(node())}>
                    {(line) => (
                      <text flexShrink={0} fg={props.context.theme.text.subdued}>
                        {line()}
                      </text>
                    )}
                  </Show>
                  <Show when={permDetail(node(), snapshot())}>
                    {(detail) => (
                      <box flexDirection="column" flexShrink={0}>
                        <text flexShrink={0} fg={props.context.theme.text.subdued}>
                          {`tool: ${detail().tool} · rule: ${detail().rule}${detail().custom ? " · custom" : ""}`}
                        </text>
                        <text flexShrink={0} fg={props.context.theme.text.subdued}>
                          {`enforced by: ${detail().enforcement}`}
                        </text>
                        <text flexShrink={0} fg={props.context.theme.text.subdued}>
                          {`patterns: ${detail().patterns.join(", ") || "(none)"}`}
                        </text>
                        <text flexShrink={0} fg={props.context.theme.text.subdued}>
                          {`keywords: ${detail().keywords.join(", ") || "(none)"}`}
                        </text>
                        <text flexShrink={0} fg={props.context.theme.text.subdued}>
                          {`provenance: ${detail().provenance.join(", ") || "(curated)"}`}
                        </text>
                        <Show when={detail().message}>
                          {(message) => (
                            <text flexShrink={0} fg={props.context.theme.text.subdued}>
                              {`message: ${message()}`}
                            </text>
                          )}
                        </Show>
                      </box>
                    )}
                  </Show>
                  <Show when={scrubInfo(node(), snapshot())}>
                    {(info) => (
                      <text flexShrink={0} fg={props.context.theme.text.subdued}>
                        {`${info().hidden} lines hidden by rules: ${info().preview.join(" / ")}`}
                      </text>
                    )}
                  </Show>
                  <Show when={node().address?.section === null}>
                    <text flexShrink={0} fg={props.context.theme.text.subdued}>
                      Sections:
                    </text>
                    <For each={sectionRows(node(), snapshot())}>
                      {(row) => (
                        <text
                          flexShrink={0}
                          fg={props.context.theme.text.default}
                          attributes={excludedAttributes(row.excluded)}
                        >
                          {`  - ${row.name} [${row.excluded ? "excluded" : "included"}]`}
                        </text>
                      )}
                    </For>
                  </Show>
                  <Show when={node().address !== undefined && node().address?.section !== null}>
                    <text flexShrink={0} fg={props.context.theme.text.subdued}>
                      Item: {parentItemTitle(node(), snapshot())} ({node().address?.item})
                    </text>
                    <Show when={sectionExcluded(node(), snapshot())}>
                      <text flexShrink={0} fg={props.context.theme.text.subdued}>
                        [excluded]
                      </text>
                    </Show>
                  </Show>
                  <Show
                    when={isEditing()}
                    fallback={
                      <scrollbox flexGrow={1}>
                        <Show
                          when={node().address?.section === null}
                          fallback={
                            <text
                              flexShrink={0}
                              fg={props.context.theme.text.default}
                              attributes={excludedAttributes(sectionExcluded(node(), snapshot()))}
                            >
                              {resolvedText(node(), snapshot())}
                            </text>
                          }
                        >
                          <Show when={wholeItemText(node(), snapshot())}>
                            {(whole) => (
                              <box flexDirection="column" flexShrink={0}>
                                <For each={renderRanges(whole().text, whole().ranges)}>
                                  {(part) => (
                                    <text
                                      flexShrink={0}
                                      fg={props.context.theme.text.default}
                                      attributes={excludedAttributes(part.excluded)}
                                    >
                                      {`${part.body}${part.excluded ? " [excluded]" : ""}`}
                                    </text>
                                  )}
                                </For>
                              </box>
                            )}
                          </Show>
                        </Show>
                      </scrollbox>
                    }
                  >
                    <textarea
                      flexGrow={1}
                      initialValue={props.draft()}
                      textColor={props.context.theme.text.formfield.default}
                      focusedTextColor={props.context.theme.text.formfield.focused}
                      cursorColor={props.context.theme.text.formfield.focused}
                      ref={(next) => {
                        area = next
                      }}
                      onContentChange={() => {
                        if (!area || area.isDestroyed) return
                        props.onDraftChange(area.plainText)
                      }}
                    />
                    <text flexShrink={0} fg={props.context.theme.text.subdued}>
                      ctrl+s save · esc cancel
                    </text>
                  </Show>
                </>
              )}
            </Show>
          </box>
        )}
      </Show>
    </box>
  )
}
