import { TextAttributes, type RGBA, type ScrollBoxRenderable } from "@opentui/core"
import type { Plugin } from "@opencode/plugin/tui"
import { For, Show } from "solid-js"
import { reviewLabel } from "../../instructions/from-label.js"
import { controlKind, type Memo, type TreeNode } from "../../instructions/tree.js"
import { fromWords, MODELS_GROUP_ID } from "../../instructions/model-settings.js"
import { formatDuration } from "../../instructions/model.js"
import { modelDefaultsViewOf } from "../../instructions/snapshot.js"
import type { Snapshot } from "../../rpc.js"
import {
  addressLine,
  controlDetail,
  excludedAttributes,
  linkLine,
  matchLines,
  modelDetail,
  permDetail,
  provenanceLine,
  renderRanges,
  resolvedText,
  scrubInfo,
  sectionExcluded,
  sectionRows,
  wholeItemText,
  displayLevel,
} from "./detail-pane.js"
import { structureDetail } from "./descriptions.js"
import { toolWords, type Row, type ToolCount } from "./workspace.js"

export interface InspectorProps {
  readonly context: Plugin.Context
  readonly node: () => TreeNode | undefined
  /** The row as the pane shows it (its label may differ from the node's: "Every agent"). */
  readonly label: () => string | undefined
  readonly snapshot: () => Snapshot | undefined
  /** Breadcrumb of the row. */
  readonly path: () => string
  /** The row's visible children, for a group's summary. */
  readonly children: () => readonly Row[]
  readonly ref?: (scroll: ScrollBoxRenderable) => void
  /** An owner's tool count, when the row is an owner. */
  readonly tools?: () => ToolCount | undefined
  /** The screen's shared snapshot memo: facts read the tree's resolutions. */
  readonly memo?: () => Memo | undefined
}

// A value nobody overrides: the tree's baseline words (from-label.ts). A
// preset's shipped content is its baseline too (a Native preset ships OpenCode's
// own content, a Plus preset its own).
const BASELINE =
  /^(?:(?:state and text|value|enabled): (?:OpenCode|upstream|shipped)|state: (?:OpenCode|upstream|shipped) · text: (?:OpenCode|upstream|shipped))$/

type Fact = readonly [key: string, value: string, tone?: "warning" | "info" | "value" | "subdued"]

// What a row is, in one word, for the title line.
export function kindWord(node: TreeNode): string {
  const item = node.address?.item
  if (node.kind === "agent") return node.owner?.entry !== undefined ? "Defaults entry" : node.owner?.preset !== undefined ? "preset" : "agent"
  if (node.kind === "team") return node.id.includes(":special:") ? "special agent" : node.owner?.agent === null ? "team" : "member"
  if (node.kind === "root") return "level"
  if (node.kind === "group") return node.id === MODELS_GROUP_ID ? "category" : "group"
  if (node.kind === "section") return "section"
  if (item?.startsWith("perm:") === true) return "permission"
  if (item?.startsWith("modeldefault:") === true) return "model defaults"
  if (item?.startsWith("model:") === true) return "model"
  if (item?.startsWith("tool:") === true) return "tool"
  if (item?.startsWith("skill:") === true) return "skill"
  if (item?.startsWith("base:") === true) return "base prompt"
  if (controlKind(item) !== undefined) return "setting"
  return "item"
}

export function factsOf(node: TreeNode, snapshot: Snapshot, children: readonly Row[], memo?: Memo): Fact[] {
  const facts: Fact[] = []
  const defaults = modelDefaultsView(node, snapshot)
  if (defaults !== undefined) {
    facts.push([
      "warming",
      defaults.on.value ? `${formatDuration(defaults.duration.value)} · ${fromWords(defaults.duration.from)}` : `off · ${fromWords(defaults.on.from)}`,
      defaults.on.value ? "value" : undefined,
    ] as Fact)
    facts.push(["ping every", `${formatDuration(defaults.interval.value)} · ${fromWords(defaults.interval.from)}`])
    facts.push(["keep-alive", `${defaults.prompt.value} · ${fromWords(defaults.prompt.from)}`])
    if (defaults.effort !== undefined) facts.push(["effort", `${defaults.effort.value} · ${fromWords(defaults.effort.from)}`])
    facts.push(["applies to", defaults.key.providerID === undefined ? "every model" : `${defaults.key.providerID}/${defaults.key.modelID}, unless an agent's own model row sets a field`])
    return facts
  }
  if (node.badges.state !== undefined) {
    const locked = node.badges.unexcludable === true || node.badges.unsupported === true
    facts.push(["state", `${node.badges.state}${locked ? " · always live (exclude sections instead)" : ""}`])
  }
  const provenance = provenanceLine(node, snapshot, memo)
  if (provenance !== undefined) facts.push(["source", BASELINE.test(provenance) ? "default (nothing overrides it)" : provenance.replace(/^(state and text|value|enabled): /, "")])
  const link = linkLine(node, snapshot)
  if (link !== undefined) facts.push(["preset", link.replace(/^Created from preset: /, ""), node.owner?.linkMissing === true ? "warning" : undefined])
  for (const line of matchLines(node, snapshot)) {
    const split = line.indexOf(": ")
    facts.push([split === -1 ? "matches" : line.slice(0, split).replace(/^matches /, "matches ").replace(/^matching now$/, "now"), split === -1 ? line : line.slice(split + 2)])
  }
  const model = modelDetail(node, snapshot)
  if (model !== undefined) {
    facts.push(["model", `${model.providerID}/${model.modelID}${model.variant === undefined ? "" : `#${model.variant}`}`])
    const inherited =
      model.active && model.activeFrom !== undefined && model.activeFrom !== "upstream" && model.activeFrom !== node.address?.level
        ? model.activeFrom === model.source
          ? " (inherited)"
          : ` (inherited from ${displayLevel(model.activeFrom)})`
        : ""
    facts.push(["from", `${displayLevel(model.source)}${model.active ? " · active" : ""}${inherited}`])
    facts.push([
      "warming",
      node.badges.warming === undefined
        ? "host configuration (enter edits it here)"
        : `${node.badges.warming} · set at ${displayLevel(node.badges.warmingFrom ?? "project")}`,
    ])
    if (node.badges.interval !== undefined)
      facts.push(["ping every", `${node.badges.interval} · set at ${displayLevel(node.badges.intervalFrom ?? "project")}`])
    if (node.badges.prompt !== undefined)
      facts.push(["keep-alive", `${node.badges.prompt} · set at ${displayLevel(node.badges.promptFrom ?? "project")}`])
  }
  if (node.badges.effective !== undefined) facts.push(["effective", node.badges.effective])
  const perm = permDetail(node, snapshot)
  if (perm !== undefined) {
    facts.push(["rule", `${perm.tool} · ${perm.rule}${perm.custom ? " · custom" : ""}`])
    facts.push(["enforced by", perm.enforcement])
    facts.push(["patterns", perm.patterns.join(", ") || "(none)"])
    if (perm.keywords.length > 0) facts.push(["keywords", perm.keywords.join(", ")])
    facts.push(["provenance", perm.provenance.join(", ") || "curated"])
    if (perm.message !== undefined) facts.push(["message", perm.message])
  }
  const scrub = scrubInfo(node, snapshot, memo)
  if (scrub !== undefined && scrub.hidden > 0) facts.push(["hidden", `${scrub.hidden} lines hidden by rules: ${scrub.preview.join(" / ")}`])
  const sections = sectionRows(node, snapshot, memo)
  if (sections.length > 1) {
    const excluded = sections.filter((row) => row.excluded).length
    facts.push(["sections", `${sections.length}${excluded > 0 ? ` · ${excluded} excluded` : ""}`])
  }
  if (node.address?.section !== null && node.address !== undefined && sectionExcluded(node, snapshot, memo)) facts.push(["section", "excluded"])
  const count = node.badges.reviewCount ?? 0
  if (node.badges.review === true)
    facts.push(["review", `${node.badges.reviewOf === undefined ? "to review" : reviewLabel(node.badges.reviewOf)} · enter to review`, "warning"])
  else if (count > 0) facts.push(["review", `${count} to review below · n jumps to the next`, "warning"])
  // The catalogue decides what an addressed row inherits (README §catalogues).
  const address = addressLine(node)
  if (address !== undefined) facts.push(["address", address, "subdued"])
  if (node.kind === "group" || node.kind === "root" || (node.kind === "team" && node.address === undefined && children.length > 0)) {
    const stated = children.filter((row) => row.node.badges.state !== undefined)
    if (children.length > 0) {
      const on = stated.filter((row) => row.node.badges.state === "on").length
      const here = children.filter((row) => row.node.badges.modified === true || row.node.badges.fromLabel === "set here").length
      facts.push(["contains", [`${children.length} rows`, ...(stated.length > 0 ? [`${on} on`, `${stated.length - on} off`] : []), ...(here > 0 ? [`${here} set here`] : [])].join(" · ")])
    }
  }
  return facts
}

export function notesOf(node: TreeNode, snapshot: Snapshot, memo?: Memo): string[] {
  const notes = controlDetail(node, snapshot, memo).filter((line) => !line.startsWith("Value: "))
  const detail = structureDetail(node)
  return [...notes, ...(detail === undefined ? [] : [detail]), ...modelsNotes(node), ...modelDefaultsNotes(node, snapshot)]
}

// One Defaults › Models row's resolution order, in words. The agent's row wins
// field by field; below this row sit opencode.json (per model or provider) and
// the built-in defaults.
function modelDefaultsNotes(node: TreeNode, snapshot: Snapshot): string[] {
  const defaults = modelDefaultsView(node, snapshot)
  if (defaults === undefined) return []
  const rows = ["The agent's own model row sets a field first; whatever it leaves out resolves here."]
  if (defaults.key.providerID !== undefined) rows.push("Below this row: Every model, then opencode.json, then the built-in defaults.")
  else rows.push("Below this row: opencode.json and the built-in defaults. Enter edits; empty clears a field.")
  return rows
}

function modelDefaultsView(node: TreeNode, snapshot: Snapshot) {
  return modelDefaultsViewOf(snapshot, node.address?.item)
}

// The Models group's note: what happens when nothing is active, including the
// hidden-upstream case (`d` on the upstream row stores a tombstone, which
// removes the row but not the host's own fallback).
function modelsNotes(node: TreeNode): string[] {
  if (node.kind !== "group" || !node.id.endsWith(":models")) return []
  return ["With no active model here, OpenCode falls back to its host configuration, removed rows included."]
}

export function Inspector(props: InspectorProps) {
  const theme = () => props.context.theme
  const tone = (fact: Fact) =>
    fact[2] === "warning"
      ? theme().text.feedback.warning.base
      : fact[2] === "info"
        ? theme().text.feedback.info.base
        : fact[2] === "subdued"
          ? theme().text.muted
          : theme().text.base
  const value = (node: TreeNode, snapshot: Snapshot) => {
    const item = node.address?.item
    if (item === undefined || controlKind(item) === undefined) return undefined
    return controlDetail(node, snapshot, props.memo?.()).find((line) => line.startsWith("Value: "))?.slice("Value: ".length)
  }
  const hasText = (node: TreeNode) =>
    node.address !== undefined &&
    node.enabledRow === undefined &&
    controlKind(node.address.item) === undefined &&
    !node.address.item.startsWith("model:") &&
    !node.address.item.startsWith("perm:")
  return (
    <box flexGrow={1} flexDirection="column" minHeight={0} minWidth={0} paddingLeft={1} paddingRight={1}>
      <Show
        when={props.node()}
        fallback={<text fg={theme().text.muted}>Nothing selected</text>}
      >
        {(node) => (
          <scrollbox flexGrow={1} minHeight={0} ref={(scroll: ScrollBoxRenderable) => props.ref?.(scroll)} verticalScrollbarOptions={{ visible: false }}>
            <box flexDirection="row" flexShrink={0}>
              <text flexGrow={1} minWidth={0} wrapMode="none" truncate fg={theme().text.base} attributes={TextAttributes.BOLD}>
                {props.label() ?? node().label}
              </text>
              <text flexShrink={0} fg={theme().text.muted}>
                {kindWord(node())}
              </text>
            </box>
            <text flexShrink={0} fg={theme().text.muted} wrapMode="word">
              {props.path()}
            </text>
            <Show when={props.snapshot()}>
              {(snapshot) => (
                <box flexDirection="column" flexShrink={0} paddingTop={1}>
                  <Show when={value(node(), snapshot())}>
                    {(current) => <Fact context={props.context} fact={["value", current(), "value"]} color={theme().text.formfield.base} />}
                  </Show>
                  <Show when={props.tools?.()}>
                    {(count) => (
                      <Fact
                        context={props.context}
                        fact={["tools", `${toolWords(count())} · ${count().total} in all${count().on === 0 ? " · this agent cannot act: link a preset (l) or turn tools on (4)" : ""}`]}
                        color={count().on === 0 ? theme().text.feedback.warning.base : theme().text.base}
                      />
                    )}
                  </Show>
                  <For each={factsOf(node(), snapshot(), props.children(), props.memo?.())}>
                    {(fact) => <Fact context={props.context} fact={fact} color={tone(fact)} />}
                  </For>
                  <For each={notesOf(node(), snapshot(), props.memo?.())}>
                    {(line) => (
                      <text flexShrink={0} fg={node().badges.disabled === undefined ? theme().text.muted : theme().text.formfield.disabled} wrapMode="word">
                        {line}
                      </text>
                    )}
                  </For>
                  <Show when={hasText(node())}>
                    <box flexDirection="column" flexShrink={0} paddingTop={1}>
                      <Show
                        when={node().address?.section === null}
                        fallback={
                          <text
                            fg={sectionExcluded(node(), snapshot(), props.memo?.()) ? theme().text.muted : theme().text.base}
                            attributes={excludedAttributes(sectionExcluded(node(), snapshot(), props.memo?.()))}
                            wrapMode="word"
                          >
                            {resolvedText(node(), snapshot(), props.memo?.())}
                          </text>
                        }
                      >
                        <For each={(() => { const whole = wholeItemText(node(), snapshot(), props.memo?.()); return renderRanges(whole.text, whole.ranges) })()}>
                          {(part) => (
                            <text
                              fg={part.excluded ? theme().text.muted : theme().text.base}
                              attributes={excludedAttributes(part.excluded)}
                              wrapMode="word"
                            >
                              {`${part.body}${part.excluded ? " [excluded]" : ""}`}
                            </text>
                          )}
                        </For>
                      </Show>
                    </box>
                  </Show>
                </box>
              )}
            </Show>
          </scrollbox>
        )}
      </Show>
    </box>
  )
}

function Fact(props: { readonly context: Plugin.Context; readonly fact: Fact; readonly color: RGBA }) {
  return (
    <box flexDirection="row" flexShrink={0}>
      <text flexShrink={0} width={12} fg={props.context.theme.text.muted}>
        {props.fact[0]}
      </text>
      <text flexGrow={1} minWidth={0} fg={props.color} wrapMode="word">
        {props.fact[1]}
      </text>
    </box>
  )
}
