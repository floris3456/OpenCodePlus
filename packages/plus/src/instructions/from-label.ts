// Where a resolved value came from, in the words the tree badge, the detail
// pane and the tools show (DESIGN §2): "from preset Orchestrator", "from
// default *orchestrator*", "from Defaults (every agent)", "OpenCode", "off by
// default". One module so the TUI and `instructions_*` say the same thing.
import { presetKey, type From, type Level, type ReviewPart } from "./model.js"
import type { TreeNode } from "./tree.js"

export interface FromLabelOptions {
  /** presetKey → label (presets.ts presetLabels); a preset without one shows its id. */
  readonly labels?: ReadonlyMap<string, string>
  /** The row's own level: a value set at that level reads "set here". */
  readonly level?: Level
}

export function fromLabel(from: From, options: FromLabelOptions = {}): string {
  if (from.kind === "level") return from.level === options.level ? "set here" : `from ${from.level}`
  if (from.kind === "preset") {
    const ref = from.team === undefined ? { kind: "agent" as const, id: from.id } : { kind: "member" as const, team: from.team, id: from.id }
    const fallback = from.team === undefined ? from.id : `${from.team} › ${from.id}`
    return `from preset ${options.labels?.get(presetKey(ref)) ?? fallback}`
  }
  if (from.kind === "default") return `from default ${from.team === undefined ? from.name : `${from.team} › ${from.name}`}`
  if (from.kind === "defaults-everyone") return "from Defaults (every agent)"
  if (from.kind === "native") return "OpenCode"
  if (from.kind === "upstream") return "upstream"
  return "off by default"
}

/** "to review", or "to review (state)" when the part under review is not the text alone. */
export function reviewLabel(parts: readonly ReviewPart[]): string {
  if (parts.length === 0 || (parts.length === 1 && parts[0] === "text")) return "to review"
  return `to review (${parts.join(", ")})`
}

/**
 * A row's badges in words, in display order: the tree pane renders them and
 * `instructions_list` joins them into its `badges` string.
 */
export function badgeLabels(node: TreeNode): string[] {
  const labels: string[] = []
  // On/off reads from the badge state, not the address: item and section
  // rows always carry state, and team rows carry state with no address (a
  // synthetic address would corrupt the mutate path). Structural rows carry
  // no state and still render no badge.
  if (node.badges.state !== undefined) labels.push(node.badges.state === "off" ? "off" : "on")
  if (node.badges.modified === true) labels.push("modified")
  if (node.badges.active === true) labels.push("active")
  if (node.badges.inactive === true) labels.push("inactive")
  if (node.badges.pinned === true) labels.push("pinned")
  if (node.badges.unsupported === true) labels.push("unsupported")
  if (node.owner?.linkMissing === true) labels.push("missing preset")
  const count = node.badges.reviewCount ?? 0
  if (count > 0) labels.push(`${count} to review`)
  // "to review", or "to review (state)" when the part under review is not
  // the text alone (§3.6); a model row's review carries no parts.
  else if (node.badges.review === true) labels.push(node.badges.reviewOf === undefined ? "review" : reviewLabel(node.badges.reviewOf))
  return labels
}
