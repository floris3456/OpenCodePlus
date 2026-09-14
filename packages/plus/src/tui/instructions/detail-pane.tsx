import { TextAttributes } from "@opentui/core"
import type { Plugin } from "@opencode/plugin/tui"
import { createEffect, For, Show } from "solid-js"
import { resolve, resolveSplit, scopesOf } from "../../instructions/model.js"
import type { Address, AgentSource, CustomizationRecord, Item, Resolved, SplitRecord } from "../../instructions/model.js"
import type { TreeNode } from "../../instructions/tree.js"
import type { Snapshot } from "../../rpc.js"
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
  return snapshot.agents.map((agent) => ({
    id: agent.id,
    scope: agent.scope,
    ...(agent.path === undefined ? {} : { path: agent.path }),
    ...(agent.base === undefined ? {} : { base: agent.base }),
  }))
}

function itemsOf(snapshot: Snapshot): Item[] {
  return snapshot.items.map((item) => ({
    id: item.id,
    kind: item.kind,
    group: item.group,
    ...(item.server === undefined ? {} : { server: item.server }),
    title: item.title,
    text: item.text,
    enabled: item.enabled,
    fingerprint: item.fingerprint,
    ...(item.agents === undefined ? {} : { agents: [...item.agents] }),
    ...(item.order === undefined ? {} : { order: item.order }),
  }))
}

function customizationsOf(snapshot: Snapshot): CustomizationRecord[] {
  const out: CustomizationRecord[] = []
  for (const record of snapshot.records) {
    if (record.type !== "customization") continue
    out.push({
      level: record.level,
      agent: record.agent,
      item: record.item,
      section: record.section,
      ...(record.text === undefined ? {} : { text: record.text }),
      ...(record.state === undefined ? {} : { state: record.state }),
      basedOn: record.basedOn,
      ...(record.basedOnText === undefined ? {} : { basedOnText: record.basedOnText }),
      ...(record.acknowledged === undefined ? {} : { acknowledged: record.acknowledged }),
      updated: record.updated,
    })
  }
  return out
}

function splitsOf(snapshot: Snapshot): SplitRecord[] {
  const out: SplitRecord[] = []
  for (const record of snapshot.records) {
    if (record.type !== "split") continue
    out.push({
      level: record.level,
      agent: record.agent,
      item: record.item,
      boundaries: record.boundaries.map((boundary) => ({ ...boundary })),
    })
  }
  return out
}

export function resolveNode(node: TreeNode, snapshot: Snapshot): Resolved | undefined {
  const address = node.address
  if (address === undefined) return undefined
  const upstream = itemsOf(snapshot).find((item) => item.id === address.item)
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

export function isEditable(node: TreeNode | undefined): boolean {
  if (!node) return false
  if (node.address === undefined) return false
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
  const upstream = itemsOf(snapshot).find((item) => item.id === address.item)
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
  return snapshot.items.find((item) => item.id === address.item)?.title
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
  const upstream = itemsOf(snapshot).find((item) => item.id === address.item)
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
