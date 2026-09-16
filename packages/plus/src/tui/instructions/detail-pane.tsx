import { TextAttributes } from "@opentui/core"
import type { Plugin } from "@opencode/plugin/tui"
import { createEffect, For, Show } from "solid-js"
import { applies, modelCandidates, parseModelItemId, parsePermItemId, resolve, resolveActiveModel, resolveSplit, sameModelCandidate, scopesOf } from "../../instructions/model.js"
import type { Address, AgentSource, CustomizationRecord, Item, ModelRecord, Resolved, SplitRecord } from "../../instructions/model.js"
import { scrubLines } from "../../instructions/tool-permissions.js"
import { agentOf, itemOf, recordOf } from "../../instructions/snapshot.js"
import type { TreeNode } from "../../instructions/tree.js"
import type { Level, Snapshot } from "../../rpc.js"
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
  const agents = agentsOf(snapshot)
  const scopes = scopesOf(agents)
  const models = modelsOfSnapshot(snapshot)
  const upstream = upstreamModelOf(snapshot, address.agent)
  const candidates = modelCandidates({ models, scopes, level: address.level, agent: address.agent, ...(upstream === undefined ? {} : { upstream }) })
  const candidate = candidates.find((entry) => sameModelCandidate(entry, parsed))
  if (candidate === undefined) return undefined
  const active = resolveActiveModel({ models, scopes, level: address.level, agent: address.agent, ...(upstream === undefined ? {} : { upstream }) })
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
    scopes: scopesOf(agentsOf(snapshot)),
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
  const scopes = scopesOf(agentsOf(snapshot))
  const keywords = items.flatMap((item) => {
    if (item.kind !== "perm" || item.keywords === undefined) return []
    const owner = address.agent
    if (owner === null) {
      if (item.agents !== undefined) return []
    } else if (!applies(item, owner)) return []
    const state = resolve({ upstream: item, records, splits, scopes, address: { level: address.level, agent: address.agent, item: item.id, section: null } })
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
): { tool: string; rule: string; patterns: readonly string[]; keywords: readonly string[]; provenance: readonly string[]; custom: boolean } | undefined {
  const address = node.address
  if (address === undefined) return undefined
  const upstream = upstreamFor(itemsOf(snapshot), address)
  if (upstream?.kind !== "perm") return undefined
  const parsed = parsePermItemId(address.item)
  if (parsed === undefined) return undefined
  return {
    tool: upstream.permTool ?? parsed.tool,
    rule: upstream.ruleId ?? parsed.ruleId,
    patterns: upstream.patterns === undefined ? [] : [...upstream.patterns],
    keywords: upstream.keywords === undefined ? [] : [...upstream.keywords],
    provenance: upstream.provenance === undefined ? [] : [...upstream.provenance],
    custom: upstream.custom === true,
  }
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
  return "Defaults"
}

export function provenanceLine(node: TreeNode, snapshot: Snapshot): string | undefined {
  const address = node.address
  if (address === undefined) return undefined
  if (isModelAddress(address)) {
    const detail = modelDetail(node, snapshot)
    if (detail === undefined) return undefined
    if (detail.active) return `active model from: ${displayLevel(detail.source)}`
    return `candidate from: ${displayLevel(detail.source)}`
  }
  const resolved = resolveNode(node, snapshot)
  if (!resolved) return undefined
  if (resolved.overriddenHere) return `overridden here: ${displayLevel(address.level)}`
  return `inherited from: ${displayLevel(resolved.source)}`
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
  const scopes = scopesOf(agentsOf(snapshot))
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
  const scopes = scopesOf(agentsOf(snapshot))
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

function addressLine(node: TreeNode): string | undefined {
  const address = node.address
  if (address === undefined) return undefined
  const head = address.agent === null ? displayLevel(address.level) : `${displayLevel(address.level)} · ${address.agent}`
  const tail = address.section === null ? address.item : `${address.item} · ${address.section}`
  return `${head} · ${tail}`
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
                  <Show when={permDetail(node(), snapshot())}>
                    {(detail) => (
                      <box flexDirection="column" flexShrink={0}>
                        <text flexShrink={0} fg={props.context.theme.text.subdued}>
                          {`tool: ${detail().tool} · rule: ${detail().rule}${detail().custom ? " · custom" : ""}`}
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
