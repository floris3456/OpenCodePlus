import { builtinBaseIds } from "../agents/base.js"
import { ownRule, ruleItem } from "./rules.js"
import { booleanControl, controlIds, controlItemFor, controlItems, isControl } from "./agent-controls.js"
import { attentionRowChoices, isAttentionRow } from "../attention-settings.js"
import { mentions, met, requirementOf } from "./requires.js"
import { guidanceItemId } from "./paths.js"
import {
  applies,
  canReset,
  catalogueOf,
  entrySpecificity,
  formatDuration,
  hasModelActiveAt,
  modelCandidates,
  modelRuntimeScope,
  resolveModelFields,
  modelItemId,
  parseModelItemId,
  presetKey,
  resolveActiveModel,
  resolutionChain,
  sameModelCandidate,
  scopedTo,
} from "./model.js"
import { completeOrder, defaultSystemOrder, firstSlot, modelPromptsSlot, slotOfItem, storedSystemOrder, toolsItemId, userSystemRows } from "./system-order.js"
import { matchesModel } from "./model-patterns.js"
import type {
  Address,
  AgentSource,
  Catalogue,
  EntryRecord,
  From,
  Item,
  Level,
  PresetOrigin,
  PresetRef,
  Resolved,
  ReviewPart,
  TeamRef,
} from "./model.js"
import {
  folderIdOfRef,
  folderRef,
  groupScope,
  hasOwnLayout,
  layoutPrint,
  layoutSource,
  orderOf,
  ownerGroupIds,
  tabOfGroupId,
  teamsOwnerSegment,
  type FolderRecord,
} from "./folders.js"
import { fromLabel } from "./from-label.js"
import {
  COLD_ITEM_SEGMENT,
  coldCompactSummary,
  coldDefaultItemId,
  coldListValue,
  coldModelItemId,
  COLD_COMPACT_LABEL,
  effectiveCompaction,
  effectiveImages,
  hostModelOf,
  modelDefaultItemId,
  modelDefaultKeys,
  modelDefaultRowId,
  modelDefaultValue,
  modelDefaultView,
  isModelSettingRowId,
  modelSettingItemId,
  modelSettingParentRowId,
  modelSettingRowId,
  modelSettingValue,
  everySettings,
  isEvery,
  resolveModelCompactionFields,
  settingsFor,
  defaultEffort,
  modelSettingEffective,
  isDefaultSwitchField,
  modelFieldItemId,
  MODEL_FIELD_LABELS,
  MODEL_SETTING_LABELS,
  MODELS_GROUP_ID,
  MODELS_OWNER,
  MODEL_DEFAULT_PREFIX,
  type CompactionFrom,
  type CompactionDefaults,
  type EffectiveCompaction,
  type HostWarming,
  type ModelDefaultField,
  type ModelDefaultView,
  type ModelFieldName,
  type ModelSettingsField,
  type ModelSettingsKey,
  type ModelSettingsRecord,
} from "./model-settings.js"
import { IMAGE_FIELDS, imageWord, type ImageField } from "../image-settings.js"
import { linkOf, presetOfAddress, type PresetEntry } from "./presets.js"
import {
  buildMemo,
  enabledOf,
  flagOf,
  splitOf,
  textEntryOf,
  wholeOf,
  sectionResolveOf,
  teamFields,
  type BuildContext,
  type Memo,
  type RowTeam,
} from "./resolve-memo.js"
import type { MemoInput as BaseMemoInput } from "./resolve-memo.js"
import { ownBody, wrappingSection, type Section, type Split } from "./sections.js"
import type { TeamLevel } from "./teams.js"
import { categoryOfRow, categoryOrder, hostOf } from "./permission-catalog.js"
import { toolModes } from "./tool-mode.js"
import { curatedRuleMessage } from "./tool-permissions.js"

export type { Memo }
export { buildMemo }

// Teams at all three tiers, including built-in defaults teams with no
// filesystem path. This widens the shared memo input with the same `Level`
// the tree uses so Defaults rows render.
export interface TeamInput {
  /** Teams exist at project, global and defaults; team presets are not TeamInputs. */
  readonly level: TeamLevel
  readonly team: string
  readonly enabled: boolean
  readonly agents: readonly string[]
  readonly overlay?: readonly string[]
}

export interface MemoInput extends Omit<BaseMemoInput, "teams"> {
  readonly teams?: readonly TeamInput[]
}

export type TreeNodeKind = "root" | "group" | "agent" | "team" | "item" | "section"
// `preset` adds a user agent preset, `team-preset` a user team preset. `agent`
// on a Defaults Agents group adds an entry, on a Defaults team entry row a
// member entry, on a user team preset a member preset; `team` on the Defaults
// Teams group adds a team entry.
export type SkillScopeTarget = { scope: "project" | "global" | "defaults" | "preset"; preset?: string }

// The scope a new skill is written to comes from the Skills node Add was
// invoked on: the level in its group id, and — under Presets — the preset name.
// A node without a Skills group id (the generic Add picker) defaults to the
// project, preserving the previous behavior. The subgroup (OpenCode, Project,
// …) is a skill's origin, not the creation target, so only the level is read.
export function skillScopeOfNode(node: { readonly id: string } | undefined): SkillScopeTarget {
  // The owner's Skills tab: group:<level>:<owner>:skills[:origin…], the owner
  // an agent, `<team>/:<member>` or `<team>/:special:<id>`.
  const match = node?.id.match(/^group:(project|global|defaults|preset):([^:]*\/:special:[^:]+|[^:]*\/:[^:]+|[^:]*):skills(?::.*)?$/)
  if (match === null || match === undefined) return { scope: "project" }
  const scope = match[1] as SkillScopeTarget["scope"]
  if (scope !== "preset") return { scope }
  // Member presets carry `<team>/:<member>`; the filesystem needs one segment.
  const preset = (match[2] ?? "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "")
  return preset.length === 0 ? { scope: "project" } : { scope, preset }
}

export type AddKind =
  | "agent"
  | "base"
  | "skill"
  | "instruction"
  | "system"
  | "mcp"
  | "section"
  | "team"
  | "model"
  | "rule"
  | "preset"
  | "team-preset"
  | "folder"
  | "modelprompt"

/**
 * What an agent, team, member, entry or preset row stands for: the owner of
 * its link (what `link.set` and `instructions_set {preset}` address) and,
 * for presets and entries, which one it is.
 */
export interface RowOwner {
  readonly level: Level
  readonly agent: string | null
  readonly team?: TeamRef
  readonly catalogue?: Catalogue
  readonly preset?: { readonly ref: PresetRef; readonly origin: PresetOrigin }
  /** Defaults entries; a Teams entry pattern row carries no `name`. */
  readonly entry?: { readonly catalogue: Catalogue; readonly team?: string; readonly name?: string }
  /** The preset the owner is linked to now (its stored link, else the one it ships with). */
  readonly link?: PresetRef
  /** The linked preset no longer exists: rows fall through to the rest of the chain until relinked. */
  readonly linkMissing?: true
}

export interface TreeNodeBadges {
  readonly state?: "on" | "off"
  /** Group rows with a mixed on/off split: "n/m" (n on of m), shown where item rows show their on/off marker. */
  readonly summary?: string
  /** System rows and sections: the rows its condition names (requires.ts) and whether this owner has each as required. */
  readonly requires?: readonly { readonly id: string; readonly on: boolean; readonly met: boolean }[]
  /** Where that condition comes from: "its text" (the section's own line) or a level ("set here", "from Global", …). */
  readonly requiresFrom?: string
  /** This row's own level holds the condition (null on set drops it). */
  readonly requiresHere?: boolean
  /** On, with its row and enclosing sections on, but this owner does not meet its condition: the agent does not get it. */
  readonly heldBack?: boolean
  /** Section rows: tools or skills its text names that this owner has off, with no `requires` line covering them. */
  readonly mentions?: readonly { readonly word: string; readonly id: string }[]
  /** Tool, skill and rule rows: the Tools and rules sections that belong to this row. */
  readonly guidance?: readonly string[]
  /** Resolved control value, shown beside its label without changing the row id. */
  readonly value?: string
  /** Hidden affects picker visibility; it is independent of enabled/off. */
  readonly hidden?: boolean
  readonly mode?: string
  /** A temporarily unavailable control, with the reason shown in details. */
  readonly disabled?: string
  readonly modified?: boolean
  readonly review?: boolean
  readonly reviewCount?: number
  /** Which parts of the row's own override are to review (text, state, pin). */
  readonly reviewOf?: readonly ReviewPart[]
  readonly active?: boolean
  /** The level whose record is active (`upstream` for the host model); differs from the row's level when the active model is inherited. */
  readonly activeFrom?: Level | "upstream"
  readonly source?: Level | "upstream"
  /** Where the on/off state (model rows: the candidate) came from. */
  readonly from?: From
  /** Where the text came from, when that differs from `from`. */
  readonly textFrom?: From
  /** `from` in words (from-label.ts): "from preset Orchestrator", "off by default", … */
  readonly fromLabel?: string
  /** The Models group's effective model when it is not one of this level's listed rows: "<model> · active at <level>". */
  readonly effective?: string
  /** User base template that can never be the host active answer. */
  readonly inactive?: boolean
  /** System list: which of the first part's alternatives the request carries ("not sent: replaced by Role/persona", "base prompt sent instead"). */
  readonly slotNote?: string
  /** Model prompts: the patterns of the models the row is sent for (model-patterns.ts). */
  readonly models?: readonly string[]
  /** Registry or user pin state for Code Mode tool rows. */
  readonly pinned?: boolean
  /** Whole Role/persona or whole base row: apply keeps the original text live, so the row cannot be toggled off. */
  readonly unsupported?: boolean
  /** Whole Role/persona or whole base row: apply keeps the original text live, so the row cannot be toggled off. */
  readonly unexcludable?: boolean
  /** Model rows: cache warming for this agent and model ("off", "on", "45m" …) and the level that set it. */
  readonly warming?: string
  readonly warmingFrom?: Level
  /** Model rows: the keep-alive interval ("4m", "3m30s" …) and the level that set it. */
  readonly interval?: string
  readonly intervalFrom?: Level
  /** Model rows: warm while waiting ("off", "2h" …) and the level that set it. */
  readonly waiting?: string
  readonly waitingFrom?: Level
  /** Model rows: the keep-alive text and the level that set it. */
  readonly prompt?: string
  readonly promptFrom?: Level
}

export interface TreeNodeActions {
  readonly toggle: boolean
  readonly edit: boolean
  readonly reset: boolean
  readonly remove: boolean
  readonly split: boolean
  readonly pin: boolean
  /** "Shown when": a condition can be set here (system rows but Role/persona, and their sections; requires.ts). */
  readonly requires?: boolean
}

export interface TreeNode {
  readonly id: string
  readonly kind: TreeNodeKind
  readonly label: string
  readonly depth: number
  /** Known child availability for text rows, including whole-text Description aliases. */
  readonly expandable?: boolean
  readonly address?: Address
  readonly add?: AddKind
  readonly owner?: RowOwner
  /** Entity rows toggle their real Enabled item, retaining their entity address. */
  readonly enabledRow?: string
  /**
   * The own-body row of a hidden top-level wrapper section (label
   * "Introduction"): the row and its address are the wrapper's, its inspector
   * shows only the wrapper's own body, never the whole document.
   */
  readonly introduction?: true
  readonly badges: TreeNodeBadges
  readonly actions?: TreeNodeActions
}

export interface TreeInput extends Omit<BaseMemoInput, "teams"> {
  readonly teams?: readonly TeamInput[]
  readonly expanded?: ReadonlySet<string>
}

function asBaseInput(input: TreeInput): BaseMemoInput {
  return input as unknown as BaseMemoInput
}

export function tree(input: TreeInput): TreeNode[] {
  return treeOf(buildTreeMemo(input), input.expanded ?? new Set<string>())
}

// The memo a screen builds once per snapshot; every tree-shaped view derives
// its rows from this same memo instead of rebuilding context and cache per
// call.
export function buildTreeMemo(input: Omit<TreeInput, "expanded">): Memo {
  return buildMemo(asBaseInput(input))
}

// Rows for an expansion set over an already-built memo: one flatMap over the
// lazy skeleton, resolving/emitting only the rows the expansion reaches.
export function treeOf(memo: Memo, expanded: ReadonlySet<string>): TreeNode[] {
  return skeletonOf(memo).flatMap((root) => emit(root, expanded))
}

// Single-pass full expansion oracle (tests and benches): the skeleton already
// knows every id without resolving anything, so walk it directly. The TUI
// filter no longer uses this; it materialises only matches and ancestors.
export function expandedTree(input: Omit<TreeInput, "expanded">): TreeNode[] {
  const memo = buildTreeMemo(input)
  return collectSkeleton(skeletonOf(memo)).map(materialize)
}

// Lazy skeleton: ids, labels, depths, and actions are cheap, so the structure
// is built without resolving anything. Resolution runs only for emitted rows
// and for roll-up flags; collapsed subtrees never resolve.
export interface Lazy {
  readonly id: string
  readonly kind: TreeNodeKind
  readonly label: string
  readonly depth: number
  readonly expandable?: boolean
  readonly address?: Address
  readonly add?: AddKind
  readonly owner?: RowOwner
  readonly enabledRow?: string
  readonly introduction?: true
  readonly actions: TreeNodeActions
  readonly selfReview: () => boolean
  readonly partial: () => TreeNodeBadges
  /** Item rows: the on/off state alone, without the badges' full resolution. */
  readonly enabled?: () => boolean
  readonly reviewCount: () => number
  readonly children: () => readonly Lazy[]
}

// The same skeleton the tree walks, exposed so the query engine can filter
// rows without resolving: every field above is cheap, resolution runs only
// through materialize() for rows that survive the structural filters.
// Roots in DESIGN §2 order; Presets last.
export function skeletonOf(memo: Memo): Lazy[] {
  const cached = skeletonCache.get(memo)
  if (cached !== undefined) return cached
  const roots = [
    lazyRoot(memo.ctx, memo, "project"),
    lazyRoot(memo.ctx, memo, "global"),
    lazyRoot(memo.ctx, memo, "defaults"),
    lazyPresetRoot(memo.ctx, memo),
  ].map(cacheChildren)
  skeletonCache.set(memo, roots)
  return roots
}

// A memo represents one immutable snapshot/draft. Cache only visited branches;
// selection, move planning and rendering can share them without expanding peers.
const skeletonCache = new WeakMap<Memo, Lazy[]>()
const pathCache = new WeakMap<Memo, Map<string, readonly Lazy[]>>()

function cacheChildren(node: Lazy): Lazy {
  let children: readonly Lazy[] | undefined
  // Preserve lazy getters: spreading the row resolves expandable/actions even
  // when a structural query never needs the row's text or sections.
  return Object.create(node, { children: { value: () => children ??= node.children().map(cacheChildren) } }) as Lazy
}

export function collectSkeleton(roots: readonly Lazy[]): Lazy[] {
  return roots.flatMap(collectOne)
}

function collectOne(lazy: Lazy): Lazy[] {
  return [lazy, ...lazy.children().flatMap(collectOne)]
}

export function materialize(lazy: Lazy): TreeNode {
  return finalizeLazy(lazy)
}

declare module "./resolve-memo.js" {
  interface Memo {
    reviewCountCache?: Map<string, number>
    selfReviewCache?: Map<string, boolean>
    controlItems?: readonly Item[]
    modelViewCache?: Map<string, ModelDefaultView>
  }
}

// Defaults › Models views, once per memo and row: workspaceOf re-emits the rows on each pass,
// and a memo is rebuilt whenever the store or the catalogue changes (a new snapshot).
function cachedModelView(memo: Memo, id: string, compute: () => ModelDefaultView): ModelDefaultView {
  let cache = memo.modelViewCache
  if (cache === undefined) {
    cache = new Map<string, ModelDefaultView>()
    memo.modelViewCache = cache
  }
  const cached = cache.get(id)
  if (cached !== undefined) return cached
  const value = compute()
  cache.set(id, value)
  return value
}

function cachedReviewCount(memo: Memo, id: string, compute: () => number): number {
  let cache = memo.reviewCountCache
  if (cache === undefined) {
    cache = new Map<string, number>()
    memo.reviewCountCache = cache
  }
  const cached = cache.get(id)
  if (cached !== undefined) return cached
  const value = compute()
  cache.set(id, value)
  return value
}

function cachedSelfReview(memo: Memo, id: string, compute: () => boolean): boolean {
  let cache = memo.selfReviewCache
  if (cache === undefined) {
    cache = new Map<string, boolean>()
    memo.selfReviewCache = cache
  }
  const cached = cache.get(id)
  if (cached !== undefined) return cached
  const value = compute()
  cache.set(id, value)
  return value
}

export function findLazy(memo: Memo, rowId: string): Lazy | undefined {
  return lazyPath(memo, rowId).at(-1)
}

/** The real ancestor path, including saved folders and semantic tool exposure. */
export function lazyPath(memo: Memo, rowId: string): readonly Lazy[] {
  let cache = pathCache.get(memo)
  if (cache === undefined) {
    cache = new Map<string, readonly Lazy[]>()
    pathCache.set(memo, cache)
  }
  const cached = cache.get(rowId)
  if (cached !== undefined) return cached
  const walk = (nodes: readonly Lazy[], targeted: boolean): readonly Lazy[] | undefined => {
    for (const node of nodes) {
      if (node.id === rowId) return [node]
      if (targeted && !canDescend(node, rowId)) continue
      const found = walk(node.children(), targeted)
      if (found !== undefined) return [node, ...found]
    }
    return undefined
  }
  const path = walk(skeletonOf(memo), true) ?? walk(skeletonOf(memo), false) ?? []
  cache.set(rowId, path)
  return path
}

function canDescend(node: Lazy, rowId: string): boolean {
  if (node.id.endsWith(":system") && rowId === node.id.replace(/:system$/, ":base")) return true
  if (rowId.startsWith(node.id + ":") || rowId.startsWith(node.id + "/")) return true
  if (node.kind === "section" && node.id.endsWith(":description")) {
    return rowId.startsWith(node.id.slice(0, -":description".length).replace(/^item:/, "section:") + ":")
  }

  const parts = rowId.split(":")
  const rowKind = parts[0]
  const rowLevel = parts[1]

  if (node.kind === "root") {
    return node.id === `root:${rowLevel}`
  }

  if (node.kind === "group") {
    // A tool's Description and Permissions groups (and the Permissions
    // categories): group:<level>:<owner>:tool:<id>:description|permissions[:<category>].
    const toolGroup = node.id.match(/^group:(.+):(tool:[^:]+):(description|permissions)(?::.*)?$/)
    if (toolGroup !== null) {
      const prefix = toolGroup[1]
      if (toolGroup[3] === "description") return rowId.startsWith(`section:${prefix}:${toolGroup[2]}:`)
      return rowId.startsWith(`item:${prefix}:perm:`) || rowId.startsWith(`group:${prefix}:${toolGroup[2]}:permissions:`)
    }
    const nodeLevel = node.id.split(":")[1]
    if (nodeLevel !== rowLevel) return false

    // Presets root groups: group:preset:agents[:<origin>] hold agent presets
    // (owner segments without `/:`), group:preset:teams[:<origin>] team
    // presets and their members (owner `<team>/:<member>`).
    const presetGroup = node.id.match(/^group:preset:(agents|teams)(?::(native|plus|user))?$/)
    if (presetGroup !== null) {
      if (presetGroup[1] === "agents") {
        if (rowKind === "agent") return true
        if (rowId.startsWith("group:preset:teams")) return false
        return (rowKind === "group" || rowKind === "item" || rowKind === "section") && !rowId.includes("/:")
      }
      return rowKind === "team" || rowId.includes("/:") || rowId.startsWith("group:preset:teams")
    }

    // Team Special group: team:<level>:<team>:special
    if (node.id.endsWith(":special")) {
      const match = node.id.match(/^team:(project|global|defaults):(.+):special$/)
      if (match) {
        const tLevel = match[1]
        const tName = match[2]
        if (rowId.startsWith(`team:${tLevel}:${tName}:special:`)) return true
        if (rowId.startsWith(`group:${tLevel}:${tName}/:special:`)) return true
        if (rowId.startsWith(`item:${tLevel}:${tName}/:special:`)) return true
        if (rowId.startsWith(`section:${tLevel}:${tName}/:special:`)) return true
        return false
      }
    }

    // Special category groups: group:<level>:<team>/:special:<id>:<group>
    if (node.id.includes("/:special:")) {
      const match = node.id.match(/^group:(project|global|defaults):(.+)\/:special:(.+):([a-z]+)$/)
      if (match) {
        const tLevel = match[1]
        const tName = match[2]
        const spId = match[3]
        const groupName = match[4]
        if (rowKind === "item" || rowKind === "section") {
          const itemPrefix = `${rowKind}:${tLevel}:${tName}/:special:${spId}:`
          if (rowId.startsWith(itemPrefix)) {
            if (groupName === "models") return rowId.includes(":model:")
            if (groupName === "tools") return rowId.includes(":tool:") || rowId.includes(":perm:")
            if (groupName === "base") return rowId.includes(":base:")
            if (groupName === "skills") return rowId.includes(":skill:")
            if (groupName === "system") return rowId.includes(":system:")
            return true
          }
        }
        return false
      }
    }

    // Teams catalogue root: group:<level>:teams. It owns the team rows and,
    // at defaults, the Teams inventory groups (group:defaults:/teams:*).
    if (node.id === `group:${nodeLevel}:teams`) {
      if (rowKind === "team") return true
      if (rowId.startsWith(`group:${nodeLevel}:teams`)) return true
      if (rowId.startsWith(`group:${nodeLevel}:${teamsOwnerSegment}:`)) return true
      if (rowId.includes("/:")) return true
      if (rowKind === "item" || rowKind === "section") return true
      return false
    }

    // Agents catalogue root: group:<level>:agents. It owns the origin groups
    // and, at defaults, the Agents inventory groups (group:defaults::*).
    if (node.id === `group:${nodeLevel}:agents`) {
      if (rowKind === "agent") return true
      if (rowId.startsWith(`group:${nodeLevel}:agents`)) return true
      if (rowId.startsWith(`group:${nodeLevel}:${teamsOwnerSegment}:`)) return false
      if (rowId.startsWith(`item:${nodeLevel}:${teamsOwnerSegment}:`)) return false
      if (rowId.startsWith(`section:${nodeLevel}:${teamsOwnerSegment}:`)) return false
      if (rowKind === "group" && !rowId.includes("/:") && !rowId.startsWith(`group:${nodeLevel}:teams`)) return true
      if (rowKind === "item" || rowKind === "section") return true
      return false
    }

    // Origin group under agents (native, native:special, plus, user)
    if (node.id.startsWith(`group:${nodeLevel}:agents:`)) {
      if (rowKind === "agent") return true
      if (rowId.startsWith(node.id)) return true
      if (rowKind === "group" && !rowId.includes("/:") && !rowId.startsWith(`group:${nodeLevel}:teams`)) return true
      if (rowKind === "item" || rowKind === "section") return true
      return false
    }

    // Team-member category groups: group:<level>:<team>/:<member>:<cat>.
    // Their rows carry the same `<team>/:<member>` owner path.
    if (node.id.includes("/:") && !node.id.includes("/:special:")) {
      const member = node.id.match(/^group:(project|global|defaults|preset):(.+\/:.+):([a-z]+)$/)
      if (member !== null) {
        if (rowKind !== "item" && rowKind !== "section") return false
        return rowId.startsWith(`${rowKind}:${member[1]}:${member[2]}:`)
      }
    }

    // Defaults › Models: group:defaults:/models, its rows carry the same
    // /models owner segment (model-settings.ts).
    if (node.id === `group:defaults:${MODELS_OWNER}`) {
      if (rowKind !== "item" && rowKind !== "section") return false
      return parts[2] === MODELS_OWNER
    }

    // Shared defaults category groups, one set per catalogue:
    // group:defaults::<category> and group:defaults:/teams:<category>.
    if (node.id.startsWith("group:defaults::") || node.id.startsWith(`group:defaults:${teamsOwnerSegment}:`)) {
      if (rowKind === "item" || rowKind === "section") {
        const owner = parts[2]
        return owner === (node.id.startsWith("group:defaults::") ? "" : teamsOwnerSegment)
      }
      return false
    }

    // Category groups under an agent or team member (group:<level>:<owner>:<cat> or group:<level>:<team>/:<member>:<cat>)
    if (rowKind === "item" || rowKind === "section") {
      const owner = parts[2]
      if (owner === "") return false
      if (node.id.includes(`:${owner}:`) || node.id.includes(`/:${owner}:`)) {
        return true
      }
    }
    return false
  }

  if (node.kind === "agent") {
    const agentLevel = node.id.split(":")[1]
    // The id, not the label: a preset row shows its preset's label.
    const agentId = node.id.slice(`agent:${agentLevel}:`.length)
    if (agentLevel !== rowLevel) return false
    if (rowKind === "group" && rowId.startsWith(`group:${agentLevel}:${agentId}:`)) return true
    if ((rowKind === "item" || rowKind === "section") && parts[2] === agentId) return true
    return false
  }

  if (node.kind === "team") {
    const teamParts = node.id.split(":")
    const teamLevel = teamParts[1]
    if (teamLevel !== rowLevel) return false
    if (node.id.includes(":special:")) {
      const match = node.id.match(/^team:(project|global|defaults):(.+):special:(.+)$/)
      if (match) {
        const tLevel = match[1]
        const tName = match[2]
        const spId = match[3]
        if (rowId.startsWith(`group:${tLevel}:${tName}/:special:${spId}:`)) return true
        if (rowId.startsWith(`item:${tLevel}:${tName}/:special:${spId}:`)) return true
        if (rowId.startsWith(`section:${tLevel}:${tName}/:special:${spId}:`)) return true
        return false
      }
    }
    // Team rows sit at depth 2 (depth 3 under the Presets root's origin
    // groups); their members one deeper. Both read the id, not the label:
    // members never hold `:` while team names may, so the member is the last
    // segment and its rows carry the `<team>/:<member>` owner path.
    const rest = node.id.slice(`team:${teamLevel}:`.length)
    if (node.depth === (teamLevel === "preset" ? 3 : 2)) {
      if (rowId.startsWith(`${node.id}:`)) return true
      return ownedBy(rowId, teamLevel, `${rest}/:`)
    }
    const cut = rest.lastIndexOf(":")
    return ownedBy(rowId, teamLevel, `${rest.slice(0, cut)}/:${rest.slice(cut + 1)}:`)
  }

  if (node.kind === "item") {
    if (node.address === undefined) return false
    const ownerPath = node.id.slice("item:".length, -node.address.item.length)
    if (node.address.item.startsWith("tool:")) {
      const tool = node.address.item.slice("tool:".length)
      if (rowId === `item:${ownerPath}toolmode:${tool}`) return true
      if (["item", "section"].some((kind) => rowId.startsWith(`${kind}:${ownerPath}param:${tool}:`))) return true
      if (rowId.startsWith(`item:${ownerPath}perm:`)) {
        const permission = rowId.slice(`item:${ownerPath}perm:`.length).split(":")[0]
        if (permission !== undefined && hostOf(permission) === tool || rowId.endsWith(`@${tool}`)) return true
      }
      if (tool === "skill" && ["item", "section"].some((kind) => rowId.startsWith(`${kind}:${ownerPath}skill:`))) return true
    }
    if (node.address.item.startsWith("param:") && rowId.startsWith(`item:${ownerPath}`)) {
      return rowId.startsWith(`item:${ownerPath}perm:`) || rowId.startsWith(`item:${ownerPath}skill:`)
    }
    // A Defaults › Models row holds its field rows.
    if (isModelSettingRowId(rowId)) return modelSettingParentRowId(rowId) === node.id
    if (rowKind === "section") {
      if (rowId.startsWith(node.id.replace("item:", "section:") + ":")) return true
    }
    const itemLevel = parts[1]
    const itemOwner = parts[2]
    if (itemLevel !== node.address.level || itemOwner !== (node.address.agent ?? "")) return false
    if (rowKind === "section") {
      const sectionItemId = parts.slice(3, -1).join(":")
      return sectionItemId === node.address.item
    }
    if (rowKind === "group" && rowId.startsWith(`${node.id.replace(/^item:/, "group:")}:`)) return true
    if (rowKind === "item" && node.address.item.startsWith("tool:")) {
      const toolName = node.address.item.slice("tool:".length)
      const ruleItemId = parts.slice(3).join(":")
      if (ruleItemId.startsWith(`perm:${toolName}:`)) return true
      if (ruleItemId.endsWith(`@${toolName}`)) return true
      const permTool = ruleItemId.startsWith("perm:") ? ruleItemId.slice("perm:".length).split(":")[0] : undefined
      if (permTool !== undefined && hostOf(permTool) === toolName) return true
    }
    return false
  }

  return false
}

function ownedBy(rowId: string, level: string, ownerPrefix: string): boolean {
  return ["group", "item", "section"].some((kind) => rowId.startsWith(`${kind}:${level}:${ownerPrefix}`))
}

// Section ids come from the split, so an item with no section customizations
// contributes zero without resolving anything; only items that actually have
// section overrides pay for one whole resolve plus one split. Flagged
// sections roll up into ancestor counts like any other row so saved content
// needing attention stays discoverable from collapsed ancestors.
function itemRollup(memo: Memo, level: Level, owner: string | null, item: Item, catalogue?: Catalogue, team?: RowTeam): number {
  if (item.execute === true) return 0
  const entry = textEntryOf(memo, level, owner, item.id, catalogue, team)
  if (entry === undefined) return 0
  if (entry.sections.size === 0) return 0
  return splitOf(memo, level, owner, item, catalogue, team).sections.filter(
    (section) => entry.sections.has(section.id) && flagOf(memo, level, owner, item, section.id, catalogue, team),
  ).length
}

function cachedKids(memo: Memo, id: string, build: () => readonly Lazy[]): readonly Lazy[] {
  const cached = memo.kids.get(id)
  if (cached !== undefined) return cached as readonly Lazy[]
  const kids = build()
  memo.kids.set(id, kids)
  return kids
}

function rollup(children: readonly Lazy[]): number {
  return children.reduce((sum, child) => sum + child.reviewCount() + (child.selfReview() ? 1 : 0), 0)
}

function emit(lazy: Lazy, expanded: ReadonlySet<string>): TreeNode[] {
  const head = [finalizeLazy(lazy)]
  if (!expanded.has(lazy.id)) return head
  return head.concat(lazy.children().flatMap((child) => emit(child, expanded)))
}

// Same badge rule as before: sections carry their own flags, every other row
// rolls hidden and visible descendant review into review/reviewCount. Group
// rows additionally carry their toggle summary (on, off or n/m), computed
// from their nearest toggleable descendants.
function finalizeLazy(lazy: Lazy): TreeNode {
  if (lazy.kind === "section") return shell(lazy, lazy.partial())
  const count = lazy.reviewCount()
  const self = lazy.selfReview()
  if (lazy.kind !== "group") return shell(lazy, { ...lazy.partial(), review: self || count > 0, reviewCount: count })
  const toggle = groupToggleOf(lazy)
  return {
    ...shell(lazy, {
      ...lazy.partial(),
      ...(toggle.state === undefined ? {} : { state: toggle.state }),
      ...(toggle.summary === undefined ? {} : { summary: toggle.summary }),
      review: self || count > 0,
      reviewCount: count,
    }),
    ...(toggle.toggle ? { actions: { ...lazy.actions, toggle: true } } : {}),
  }
}

// A group row is toggleable when it has at least one toggleable descendant.
// "Its rows" are the nearest toggleable descendants: the walk stops at the
// first node that is itself toggleable (actions.toggle, or an entity with an
// Enabled control), so a tool's own Permissions and sections are never rows
// of an outer group. Model rows are activation, not on/off, and permission
// rows are switches of their own tool, so both are excluded. A group whose
// rows include a team row is left to the team paths (team.setEnabled), not
// the record toggle.
export interface GroupToggleRows {
  readonly rows: readonly Lazy[]
  readonly hasTeam: boolean
  /** A team's member or special agent row (team-kind with its own Enabled control): such groups never toggle. */
  readonly hasMember: boolean
}

// Lazies are memoized per tree memo, so one walk per group per memo: a parent
// group reuses its child groups' walks instead of repeating them.
const groupRowsCache = new WeakMap<Lazy, GroupToggleRows>()
const groupToggleCache = new WeakMap<Lazy, { readonly toggle: boolean; readonly state?: "on" | "off"; readonly summary?: string }>()

export function groupToggleRows(lazy: Lazy): GroupToggleRows {
  const cached = groupRowsCache.get(lazy)
  if (cached !== undefined) return cached
  const rows: Lazy[] = []
  let hasTeam = false
  let hasMember = false
  const visit = (node: Lazy): void => {
    // A row's sections belong to that row: a category toggles whole rows
    // only, so a row whose whole cannot be toggled (Role/persona, a base
    // template) is skipped with its sections, never blanked section by section.
    if (node.kind === "section") return
    if (node.kind === "group") {
      const nested = groupToggleRows(node)
      rows.push(...nested.rows)
      if (nested.hasTeam) hasTeam = true
      if (nested.hasMember) hasMember = true
      return
    }
    if (node.kind === "team") {
      // Whole teams are rows of a Teams group (team.setEnabled). A member or
      // special agent inside a team carries an agent's Enabled control: a
      // group holding those (a team's Special group) does not toggle.
      if (node.enabledRow !== undefined) hasMember = true
      if (node.enabledRow === undefined && node.actions.toggle === true) {
        rows.push(node)
        hasTeam = true
      }
      return
    }
    if (node.enabledRow !== undefined) {
      if (node.actions.toggle === true) rows.push(node)
      return
    }
    if (node.address !== undefined && node.actions.toggle === true) {
      if (!isGroupToggleExcluded(node)) rows.push(node)
      return
    }
    if (node.kind === "item") return
    for (const child of node.children()) visit(child)
  }
  for (const child of lazy.children()) visit(child)
  const found = { rows, hasTeam, hasMember }
  groupRowsCache.set(lazy, found)
  return found
}

function isGroupToggleExcluded(lazy: Lazy): boolean {
  const item = lazy.address?.item
  if (item === undefined) return false
  if (item.startsWith("model")) return true
  if (item.startsWith("perm:")) return true
  return false
}

export function groupToggleOf(lazy: Lazy): { readonly toggle: boolean; readonly state?: "on" | "off"; readonly summary?: string } {
  const cached = groupToggleCache.get(lazy)
  if (cached !== undefined) return cached
  const result = groupToggleSummary(groupToggleRows(lazy))
  groupToggleCache.set(lazy, result)
  return result
}

function groupToggleSummary(found: GroupToggleRows): { readonly toggle: boolean; readonly state?: "on" | "off"; readonly summary?: string } {
  if (found.hasMember || found.rows.length === 0) return { toggle: false }
  // Item rows answer their state without resolving their text; entity rows
  // (an agent's Enabled) read it from their badges.
  const states = found.rows
    .map((row) => (row.enabled === undefined ? row.partial().state : row.enabled() ? "on" : "off"))
    .filter((state): state is "on" | "off" => state === "on" || state === "off")
  if (states.length === 0) return { toggle: false }
  const on = states.filter((state) => state === "on").length
  if (on === states.length) return { toggle: true, state: "on" }
  if (on === 0) return { toggle: true, state: "off" }
  return { toggle: true, summary: `${on}/${states.length}` }
}

function shell(lazy: Lazy, badges: TreeNodeBadges): TreeNode {
  return {
    id: lazy.id,
    kind: lazy.kind,
    label: lazy.label,
    depth: lazy.depth,
    ...(lazy.address === undefined ? {} : { address: lazy.address }),
    ...(lazy.add === undefined ? {} : { add: lazy.add }),
    ...(lazy.owner === undefined ? {} : { owner: lazy.owner }),
    ...(lazy.enabledRow === undefined ? {} : { enabledRow: lazy.enabledRow }),
    ...(lazy.introduction === undefined ? {} : { introduction: lazy.introduction }),
    ...(lazy.expandable === undefined ? {} : { expandable: lazy.expandable }),
    badges,
    actions: lazy.actions,
  }
}

interface BranchArgs {
  readonly kind: TreeNodeKind
  readonly id: string
  readonly label: string
  readonly depth: number
  readonly add?: AddKind
  readonly owner?: RowOwner
  readonly actions: TreeNodeActions
  readonly children: () => readonly Lazy[]
  /** Extra badges the structural row itself carries (the Models group's effective model). */
  readonly partial?: () => TreeNodeBadges
  /** Known child availability, when it is known without building the children. */
  readonly expandable?: boolean
}

// `address` lets a structural row show an item's detail (a tool's
// Description group shows the tool's whole text) while its actions stay off.
function branch(memo: Memo, args: BranchArgs, address?: Address): Lazy {
  const kids = (): readonly Lazy[] => arrangeList(memo, args.id, cachedKids(memo, args.id, args.children))
  return {
    id: args.id,
    kind: args.kind,
    label: args.label,
    depth: args.depth,
    ...(address === undefined ? {} : { address }),
    ...(args.add === undefined ? {} : { add: args.add }),
    ...(args.owner === undefined ? {} : { owner: args.owner }),
    ...(args.expandable === undefined ? {} : { expandable: args.expandable }),
    actions: args.actions,
    selfReview: () => cachedSelfReview(memo, args.id, () => false),
    partial: args.partial ?? (() => ({})),
    reviewCount: () => cachedReviewCount(memo, args.id, () => rollup(kids())),
    children: kids,
  }
}

// Every root holds exactly two catalogues, Agents and Teams. Each owns its own
// population (agent origins / team rows) and, at Defaults where the shared
// "everyone" rows live, its own inventory groups. A row resolved through
// one catalogue never reads the other's inventory (model.ts resolutionChain).
function lazyRoot(ctx: BuildContext, memo: Memo, level: Level): Lazy {
  return branch(memo, {
    kind: "root",
    id: `root:${level}`,
    label: level === "project" ? "Project" : level === "global" ? "Global" : "Defaults",
    depth: 0,
    actions: noActions(),
    children: () => [
      lazyAgentsGroup(ctx, memo, level),
      ...(level === "defaults" ? [lazyModelsSection(ctx, memo)] : []),
      lazyTeamsGroup(ctx, memo, level),
    ],
  })
}

// Defaults › Models (model-settings.ts): the model settings every agent falls
// back to when its own row does not set them. One "Every model" row and one
// row per model the host catalog offers, plus any stored rows and agent
// models. Listing a model writes nothing. Rows edit through modelSettings.set,
// not the inventory mutate: they are their own surface, not agent rows.
function lazyModelsSection(ctx: BuildContext, memo: Memo): Lazy {
  return branch(memo, {
    kind: "group",
    id: MODELS_GROUP_ID,
    label: "Models",
    depth: 1,
    actions: noActions(),
    children: () =>
      [
        {} as ModelSettingsKey,
        ...modelDefaultKeys({
          modelSettings: ctx.modelSettings,
          models: ctx.models,
          agents: ctx.agents,
          hostModels: ctx.hostModels,
        }),
      ].map((key) => lazyModelDefault(ctx, memo, key)),
  })
}

function modelDefaultLabel(key: ModelSettingsKey): string {
  return key.providerID === undefined || key.modelID === undefined ? "Every model" : `${key.providerID}/${key.modelID}`
}

function lazyModelDefault(ctx: BuildContext, memo: Memo, key: ModelSettingsKey): Lazy {
  const item = modelDefaultItemId(key)
  const record = settingsFor(ctx.modelSettings, key)
  const address: Address = { level: "defaults", agent: null, item, section: null }
  const host = key.providerID === undefined || key.modelID === undefined ? undefined : hostModelOf(ctx.hostModels, { providerID: key.providerID, modelID: key.modelID })
  const view = (): ModelDefaultView =>
    cachedModelView(memo, item, () => modelDefaultViewOf(key, record, everySettings(ctx.modelSettings), host?.warming, host?.variants))
  // The row opens (→) into one row per field; each field edits on its own.
  return {
    id: modelDefaultRowId(key),
    kind: "item",
    label: modelDefaultLabel(key),
    depth: 2,
    address,
    actions: { toggle: false, edit: false, reset: record !== undefined, remove: record !== undefined, split: false, pin: false },
    selfReview: () => false,
    partial: () => ({ value: modelDefaultValue(view()), ...(record === undefined ? {} : { modified: true as const }) }),
    reviewCount: () => 0,
    // Model rows have no Model field; the rest is the same layout as an agent
    // model row: Effort, the Warming group (Warming, Ping every, Warm while
    // waiting, Keep-alive prompt, Compact before cold and the cold-cache list) and Compaction.
    children: () => [
      lazyModelDefaultField(ctx, memo, key, record, "effort", 3),
      modelGroup(memo, {
        id: defaultGroupRowId(key, "warming"),
        label: "Warming",
        depth: 3,
        summary: () => defaultsWarmingSummary(ctx, memo, key, record),
        children: [
          () => lazyModelDefaultField(ctx, memo, key, record, "warming", 4),
          () => lazyModelDefaultField(ctx, memo, key, record, "interval", 4),
          () => lazyModelDefaultField(ctx, memo, key, record, "waiting", 4),
          () => lazyModelDefaultField(ctx, memo, key, record, "prompt", 4),
          () => lazyModelDefaultField(ctx, memo, key, record, "compactWarm", 4),
          () => lazyDefaultColdGroup(ctx, memo, key, record, 4),
        ],
      }),
      modelGroup(memo, {
        id: defaultGroupRowId(key, "compaction"),
        label: "Compaction",
        depth: 3,
        summary: () => compactionStrategyWord(defaultsCompaction(ctx, key, record).strategy.value),
        children: [
          () => lazyModelDefaultField(ctx, memo, key, record, "compactionStrategy", 4),
          () => lazyModelDefaultField(ctx, memo, key, record, "compactionInput", 4),
          () => lazyModelDefaultField(ctx, memo, key, record, "compactionOutput", 4),
          () => lazyModelDefaultField(ctx, memo, key, record, "compactionModel", 4),
          () => lazyModelDefaultField(ctx, memo, key, record, "compactionInstructions", 4),
        ],
      }),
      modelGroup(memo, {
        id: defaultGroupRowId(key, "images"),
        label: "Images",
        depth: 3,
        summary: () => imagesSummary(defaultsImages(ctx, key, record)),
        children: IMAGE_FIELDS.map((field) => () => lazyModelDefaultField(ctx, memo, key, record, field, 4)),
      }),
    ],
  }
}

// The Defaults › Models image layers: the model's own row, then Every model, then built-in.
function defaultsImages(ctx: BuildContext, key: ModelSettingsKey, record: ModelSettingsRecord | undefined) {
  const every = everySettings(ctx.modelSettings)
  return effectiveImages({
    ...(record === undefined ? {} : { model: record }),
    ...(every === undefined || isEvery(key) ? {} : { every }),
  })
}

/** An Images group's summary: how new images are converted and how far they are shrunk. */
function imagesSummary(images: ReturnType<typeof effectiveImages>): string {
  return `${imageWord("imageConvert", images.imageConvert.value)} · ${imageWord("imageShrink", images.imageShrink.value)}`
}

// The Defaults › Models compaction layers: the model's own row, then Every
// model, then built-in (model-settings.ts). The agent-wide rows are per agent
// and do not show on the shared Defaults surface.
function defaultsCompaction(ctx: BuildContext, key: ModelSettingsKey, record: ModelSettingsRecord | undefined): EffectiveCompaction {
  const every = everySettings(ctx.modelSettings)
  if (isEvery(key)) return effectiveCompaction({ ...(record === undefined ? {} : { model: record }) })
  return effectiveCompaction({
    ...(record === undefined ? {} : { model: record }),
    ...(every === undefined ? {} : { every }),
  })
}

function defaultsWarmingSummary(ctx: BuildContext, memo: Memo, key: ModelSettingsKey, record: ModelSettingsRecord | undefined): string {
  const host = key.providerID === undefined || key.modelID === undefined ? undefined : hostModelOf(ctx.hostModels, { providerID: key.providerID, modelID: key.modelID })
  const view = cachedModelView(memo, modelDefaultItemId(key), () => modelDefaultViewOf(key, record, everySettings(ctx.modelSettings), host?.warming, host?.variants))
  return view.on.value ? `${formatDuration(view.duration.value)} · every ${formatDuration(view.interval.value)}` : "off"
}

// One field row under a Defaults › Models row. Warming fields read the
// keep-alive view; the compaction fields read the compaction view; every row
// reports its own value and, when inherited, its source.
function lazyModelDefaultField(
  ctx: BuildContext,
  memo: Memo,
  key: ModelSettingsKey,
  record: ModelSettingsRecord | undefined,
  field: ModelDefaultField,
  depth: number,
): Lazy {
  const host = key.providerID === undefined || key.modelID === undefined ? undefined : hostModelOf(ctx.hostModels, { providerID: key.providerID, modelID: key.modelID })
  const view = (): ModelDefaultView =>
    cachedModelView(memo, modelDefaultItemId(key), () => modelDefaultViewOf(key, record, everySettings(ctx.modelSettings), host?.warming, host?.variants))
  const own = record?.[field] !== undefined
  const switchField = isDefaultSwitchField(field)
  const value = (): string => {
    if (field === "imageConvert" || field === "imageShrink" || field === "imagesFull") {
      const image = defaultsImages(ctx, key, record)[field]
      const text = imageWord(field, image.value)
      return own ? text : `${text} · ${compactionSource(image.from)}`
    }
    if (field === "compactionInput" || field === "compactionOutput") {
      const threshold = defaultsCompaction(ctx, key, record)[field]
      const text = threshold.value ? `${threshold.value} tokens` : "off"
      return own ? text : `${text} · ${compactionSource(threshold.from)}`
    }
    if (field === "compactionStrategy") {
      const strategy = defaultsCompaction(ctx, key, record).strategy
      return own ? compactionStrategyWord(strategy.value) : `${compactionStrategyWord(strategy.value)} · ${compactionSource(strategy.from)}`
    }
    if (field === "compactionModel") {
      const model = defaultsCompaction(ctx, key, record).model
      const text = model.value ?? "Inherited model"
      return own ? text : `${text} · ${compactionSource(model.from)}`
    }
    if (field === "compactionInstructions") {
      const instructions = defaultsCompaction(ctx, key, record).instructions
      const text = instructions.value === undefined ? "Empty prompt" : instructions.value.length > 24 ? `${instructions.value.slice(0, 23)}…` : instructions.value
      return own ? text : `${text} · ${compactionSource(instructions.from)}`
    }
    if (field === "compactWarm") {
      const compactWarm = defaultsCompaction(ctx, key, record).compactWarm
      return own ? (compactWarm.value ? "on" : "off") : `${compactWarm.value ? "on" : "off"} · ${compactionSource(compactWarm.from)}`
    }
    return modelSettingValue(view(), field as ModelSettingsField, record)
  }
  return {
    id: modelSettingRowId(key, field),
    kind: "item",
    label: MODEL_SETTING_LABELS[field],
    depth,
    address: { level: "defaults", agent: null, item: modelSettingItemId(key, field), section: null },
    actions: { toggle: switchField, edit: !switchField, reset: own, remove: false, split: false, pin: false },
    selfReview: () => false,
    partial: () => ({ value: value(), ...(own ? { modified: true as const } : {}) }),
    reviewCount: () => 0,
    children: () => [],
  }
}

// The Defaults cold-cache group, the same shape as an agent row's.
function lazyDefaultColdGroup(
  ctx: BuildContext,
  memo: Memo,
  key: ModelSettingsKey,
  record: ModelSettingsRecord | undefined,
  depth: number,
): Lazy {
  const id = defaultGroupRowId(key, "cold")
  const effective = (): EffectiveCompaction => defaultsCompaction(ctx, key, record)
  const kids = (): readonly Lazy[] =>
    effective().coldModels.value.map((model, index): Lazy => ({
      id: defaultColdRowId(key, index),
      kind: "item",
      label: model,
      depth: depth + 1,
      address: { level: "defaults", agent: null, item: coldDefaultItemId(key, index), section: null },
      actions: { toggle: false, edit: false, reset: false, remove: true, split: false, pin: false },
      selfReview: () => false,
      partial: () => ({ value: coldListValue(index, model) }),
      reviewCount: () => 0,
      children: () => [],
    }))
  const own = record?.coldCompact !== undefined || record?.coldModels !== undefined
  return {
    id,
    kind: "group",
    label: COLD_COMPACT_LABEL,
    depth,
    address: { level: "defaults", agent: null, item: modelSettingItemId(key, "coldCompact"), section: null },
    actions: { toggle: false, edit: false, reset: own, remove: false, split: false, pin: false },
    selfReview: () => false,
    partial: () => ({ value: coldCompactSummary(effective().coldModels.value) }),
    reviewCount: () => cachedReviewCount(memo, id, () => rollup(kids())),
    children: kids,
  }
}

function modelDefaultViewOf(
  key: ModelSettingsKey,
  record: ModelSettingsRecord | undefined,
  every: ModelSettingsRecord | undefined,
  host: HostWarming | undefined,
  variants: readonly string[] | undefined,
): ModelDefaultView {
  return modelDefaultView({
    key,
    ...(record === undefined ? {} : { record }),
    ...(every === undefined ? {} : { every }),
    ...(host === undefined ? {} : { host }),
    ...(variants === undefined ? {} : { variants }),
  })
}

// DESIGN §2: Presets → Agents → OpenCode / Plus / User; Teams → Plus / User. An agent preset
// row (`agent:preset:<id>`) and a member preset row
// (`team:preset:<team>:<member>`) carry the same groups as any agent;
// their rows address `preset/<id>` (members `preset/<member>@<team>`). Only
// User presets can be removed or take new presets and members.
function lazyPresetRoot(ctx: BuildContext, memo: Memo): Lazy {
  return branch(memo, {
    kind: "root",
    id: "root:preset",
    label: "Presets",
    depth: 0,
    actions: noActions(),
    children: () => [
      branch(memo, {
        kind: "group",
        id: "group:preset:agents",
        label: "Agents",
        depth: 1,
        actions: noActions(),
        children: () =>
          presetOrigins.map((origin) =>
            branch(memo, {
              kind: "group",
              id: `group:preset:agents:${origin}`,
              label: originLabel(origin),
              depth: 2,
              ...(origin === "user" ? { add: "preset" as const } : {}),
              actions: noActions(),
              children: () =>
                ctx.listing
                  .filter((entry) => entry.kind === "agent" && entry.origin === origin)
                  .map((entry) => lazyPresetAgent(ctx, memo, entry)),
            }),
          ),
      }),
      branch(memo, {
        kind: "group",
        id: "group:preset:teams",
        label: "Teams",
        depth: 1,
        actions: noActions(),
        children: () =>
          presetOrigins.filter((origin) => origin !== "native").map((origin) =>
            branch(memo, {
              kind: "group",
              id: `group:preset:teams:${origin}`,
              label: originLabel(origin),
              depth: 2,
              ...(origin === "user" ? { add: "team-preset" as const } : {}),
              actions: noActions(),
              children: () =>
                ctx.listing
                  .filter((entry) => entry.kind === "team" && entry.origin === origin)
                  .map((entry) => lazyPresetTeam(ctx, memo, entry)),
            }),
          ),
      }),
    ],
  })
}

const presetOrigins = ["native", "plus", "user"] as const

function originLabel(origin: PresetOrigin): string {
  if (origin === "native") return "OpenCode"
  if (origin === "plus") return "Plus"
  return "User"
}

function lazyPresetAgent(ctx: BuildContext, memo: Memo, entry: PresetEntry): Lazy {
  const id = entry.ref.id
  return lazyOwnerRow(ctx, memo, {
    level: "preset",
    id,
    label: entry.label,
    // An OpenCode preset shows its agent's upstream model.
    agent: entry.origin === "native" ? (ctx.agents.find((agent) => agent.id === id && agent.scope === "defaults") ?? null) : null,
    depth: 3,
    remove: entry.origin === "user",
    owner: ownerOf(ctx, { level: "preset", agent: id, preset: { ref: entry.ref, origin: entry.origin } }),
  })
}

function lazyPresetTeam(ctx: BuildContext, memo: Memo, entry: PresetEntry): Lazy {
  const team = { team: entry.ref.id, agents: entry.members ?? [] }
  const members = ctx.listing.filter((candidate) => candidate.ref.kind === "member" && candidate.ref.team === team.team)
  return branch(memo, {
    kind: "team",
    id: `team:preset:${team.team}`,
    label: entry.label,
    depth: 3,
    ...(entry.origin === "user" ? { add: "agent" as const } : {}),
    owner: ownerOf(ctx, {
      level: "preset",
      agent: null,
      team: { level: "preset", team: team.team },
      preset: { ref: entry.ref, origin: entry.origin },
    }),
    actions: { ...noActions(), remove: entry.origin === "user" },
    children: () =>
      members.map((member) => lazyTeamMember(ctx, memo, "preset", team, member.ref.id, 4, false, member)),
  })
}

// The shared inventory groups of one catalogue. Only Defaults carries
// them: `{ level: "defaults", agent: null }` is the one address the resolution
// chain falls through to, so an inventory row at any other level would address
// records no agent ever reads.
function lazyInventory(ctx: BuildContext, memo: Memo, catalogue: Catalogue, depth: number): readonly Lazy[] {
  return withFolders(memo, [
    lazyModels(ctx, memo, "defaults", null, null, depth, undefined, undefined, catalogue),
    lazyTools(ctx, memo, "defaults", null, null, depth, undefined, undefined, catalogue),
    lazySkills(ctx, memo, "defaults", null, null, depth, undefined, undefined, catalogue),
    lazySystem(ctx, memo, "defaults", null, null, depth, undefined, undefined, catalogue),
    lazyControls(memo, "setting", "defaults", null, depth, undefined, catalogue),
    lazyMcpInventory(ctx, memo, catalogue, depth),
  ])
}

// Folders and display order (folders.ts). Each tab group keeps its rows except
// those a folder holds; a folder lists its rows (with their children) in its
// items order, and child folders in place. The tab's top level follows its
// order record: listed folders and rows first, in that order, then the rest as
// they were (folders before rows). A tab with neither a folder nor an order is
// returned as it is.
function withFolders(memo: Memo, groups: readonly Lazy[]): readonly Lazy[] {
  if (memo.ctx.folders.length === 0 && memo.ctx.orders.length === 0) return groups
  return groups.map((group) => arrangeTab(memo, group))
}

// A list's order: its own, else for a list inside a tab the same list of the
// first owner down the tab's chain that orders it.
function listOrder(memo: Memo, id: string): readonly string[] | undefined {
  const own = orderOf(memo.ctx.orders, groupScope(id))?.items
  if (own !== undefined) return own
  const tabs = tabsOf(memo)
  const prefix = id
    .split(":")
    .map((_, index, parts) => parts.slice(0, index + 1).join(":"))
    .find((candidate) => candidate !== id && tabs.has(candidate))
  if (prefix === undefined) return undefined
  const rest = id.slice(prefix.length)
  return tabs.get(prefix)?.slice(1).map((owner) => orderOf(memo.ctx.orders, groupScope(`${owner}${rest}`))?.items).find((items) => items !== undefined)
}

// The display token a lazy contributes to a `group:<id>` order: an item id, a
// folder ref, or an owner row id (agent, team, member). Group headings have none.
function lazyListToken(lazy: Lazy): string | undefined {
  const at = lazy.id.indexOf(":folder:")
  if (at !== -1) return folderRef(lazy.id.slice(at + ":folder:".length))
  if (lazy.kind === "agent" || lazy.kind === "team") return lazy.id
  return lazy.address?.section === null ? lazy.address.item : undefined
}

// One group's direct children in the order a `group:<id>` record names: listed
// tokens first in that order, the rest as they were. A group with no such record
// is returned untouched (S1b).
function arrangeList(memo: Memo, id: string, home: readonly Lazy[]): readonly Lazy[] {
  // A System group's order record holds slot ids, already applied by lazySystem.
  if (id.endsWith(":system")) return home
  const listed = listOrder(memo, id)
  if (listed === undefined || listed.length === 0) return home
  return [
    ...listed.flatMap((ref) => home.filter((lazy) => lazyListToken(lazy) === ref)),
    ...home.filter((lazy) => {
      const token = lazyListToken(lazy)
      return token === undefined || !listed.includes(token)
    }),
  ]
}

/**
 * The layout a tab shows. `source` is the tab whose folders and order it
 * reads: its own, else the first down its owner's chain that has one (a
 * preset's, Defaults', Global's), else undefined, the legacy layout.
 * `inherited` is what it would read without its own. Its own copy is to
 * review once what it inherits is no longer what the copy was based on.
 */
export function tabLayout(memo: Memo, tabId: string): { readonly source: string | undefined; readonly inherited: string | undefined; readonly own: boolean; readonly review: boolean } {
  const tab = tabOfGroupId(tabId)
  const layout = { folders: memo.ctx.folders, orders: memo.ctx.orders }
  const owners = layoutOwners(memo, tabId)
  const inherited = layoutSource(layout, owners.slice(1))
  const own = hasOwnLayout(layout, tabId)
  const basedOn = orderOf(memo.ctx.orders, groupScope(tabId))?.basedOn
  const review = own && tab !== undefined && basedOn !== undefined && layoutPrint(layout, inherited, tab) !== basedOn
  return { source: own ? tabId : inherited, inherited, own, review }
}

// A tab, then the same tab of each owner down its chain: the chain its rows
// resolve through, so layouts flow from presets and Defaults to Global and
// Project as text and on/off do.
function layoutOwners(memo: Memo, tabId: string): string[] {
  const tab = tabOfGroupId(tabId)
  const address = tab === undefined ? undefined : ownerAddressOfTab(tabId, tab)
  if (tab === undefined || address === undefined) return [tabId]
  return [...new Set([tabId, ...resolutionChain(address, memo.ctx.scopes).flatMap((node) => ownerGroupIds(node, tab))])]
}

// The owner a tab id names (`group:<level>:<owner>:<tab>`), as the address its
// rows resolve with: an agent, a member (`<team>/:<member>`), a team's Special
// agent (`<team>/:special:<id>`), or the shared inventory ('' or `/teams`).
function ownerAddressOfTab(tabId: string, tab: string): Address | undefined {
  const level = tabId.split(":")[1]
  if (level !== "project" && level !== "global" && level !== "defaults" && level !== "preset") return undefined
  const owner = tabId.slice(`group:${level}:`.length, -(tab.length + 1))
  const at = { level, item: "", section: null } as const
  if (owner === "") return { ...at, agent: null }
  if (owner === teamsOwnerSegment) return { ...at, agent: null, catalogue: "teams" }
  const special = owner.indexOf("/:special:")
  if (special !== -1) return { ...at, agent: owner.slice(special + "/:special:".length), team: { level, team: owner.slice(0, special) } }
  const member = owner.indexOf("/:")
  if (member === -1) return { ...at, agent: owner }
  const team: TeamRef = { level, team: owner.slice(0, member) }
  return level === "preset" ? { ...at, agent: owner.slice(member + 2), team } : { ...at, agent: owner.slice(member + 2), memberOf: team }
}

// Each arranged tab's owners down its chain (layoutOwners), so the lists
// inside it (Tools › OpenCode, …) read their order down the same chain.
const tabOwners = new WeakMap<Memo, Map<string, readonly string[]>>()

function tabsOf(memo: Memo): Map<string, readonly string[]> {
  const known = tabOwners.get(memo)
  if (known !== undefined) return known
  const created = new Map<string, readonly string[]>()
  tabOwners.set(memo, created)
  return created
}

// A tab whose own layout is to review counts as a row to review, and says what.
function withLayoutReview(group: Lazy): Lazy {
  return { ...group, selfReview: () => true, partial: () => ({ ...group.partial(), reviewOf: ["layout"] }) }
}

function arrangeTab(memo: Memo, group: Lazy): Lazy {
  if (group.id.endsWith(":system")) return group
  const tab = tabOfGroupId(group.id)
  if (tab === undefined) return group
  const layout = tabLayout(memo, group.id)
  tabsOf(memo).set(group.id, layoutOwners(memo, group.id))
  const folders = memo.ctx.folders.filter((folder) => folder.tab === tab && folder.owner === layout.source)
  const listed = orderOf(memo.ctx.orders, layout.source === undefined ? `tab:${tab}` : groupScope(layout.source))?.items ?? []
  const reviewed = layout.review ? withLayoutReview(group) : group
  if (folders.length === 0 && listed.length === 0) return reviewed
  const byItem = new Map(folders.flatMap((folder) => folder.items.filter((entry) => folderIdOfRef(entry) === undefined).map((item) => [item, folder.id] as const)))
  const referenced = new Set(folders.flatMap((folder) => folder.items.flatMap((entry) => folderIdOfRef(entry) ?? [])))
  const folderPrefix = `${group.id}:folder:`
  const tokenOf = (lazy: Lazy): string | undefined => {
    if (lazy.id.startsWith(folderPrefix)) return folderRef(lazy.id.slice(folderPrefix.length))
    return lazy.address?.section === null ? lazy.address.item : undefined
  }
  return {
    ...reviewed,
    children: () => {
      const home = group.children()
      const rows = indexRows(home, byItem)
      const folderRow = (folder: FolderRecord, depth: number, seen: ReadonlySet<string>): Lazy =>
        branch(memo, {
          kind: "group",
          id: `${folderPrefix}${folder.id}`,
          label: folder.name,
          depth,
          actions: noActions(),
          children: () =>
            folder.items.flatMap((entry): Lazy[] => {
              const child = folderIdOfRef(entry)
              if (child !== undefined) {
                const sub = folders.find((candidate) => candidate.id === child)
                return sub === undefined || seen.has(child) ? [] : [folderRow(sub, depth + 1, new Set([...seen, child]))]
              }
              const row = rows.get(entry)
              return row === undefined ? [] : [rebase(row, depth + 1 - row.depth)]
            }),
        })
      const topFolders = folders.filter((folder) => !referenced.has(folder.id)).map((folder) => folderRow(folder, group.depth + 1, new Set([folder.id])))
      const kept = home.filter((child) => assignedItem(child, byItem) === undefined).map((child) => dropAssigned(child, byItem))
      const defaults = [...topFolders, ...kept]
      return [
        ...listed.flatMap((ref) => defaults.filter((lazy) => tokenOf(lazy) === ref)),
        ...defaults.filter((lazy) => {
          const token = tokenOf(lazy)
          return token === undefined || !listed.includes(token)
        }),
      ]
    },
  }
}

// The item a row stands for, when it is a whole row (never a section) and an
// assignment names it. Group rows have no address and are never assignable.
// The folder id a whole item row is held in, when it is held (group rows and
// section rows never are).
function assignedItem(lazy: Lazy, byItem: ReadonlyMap<string, string>): string | undefined {
  const address = lazy.address
  if (address === undefined || address.section !== null) return undefined
  return byItem.get(address.item)
}

// Rebuild the home subtrees without the assigned rows: dropping a row drops its
// whole subtree, and the filter runs at each level so nothing assigned survives
// under an unrelated group either.
function dropAssigned(lazy: Lazy, byItem: ReadonlyMap<string, string>): Lazy {
  return {
    ...lazy,
    children: () =>
      lazy
        .children()
        .filter((child) => assignedItem(child, byItem) === undefined)
        .map((child) => dropAssigned(child, byItem)),
  }
}

// The held rows by item id, in home tree order (the first one found wins).
// A folder lists them under itself at its own indent (rebase).
function indexRows(groups: readonly Lazy[], byItem: ReadonlyMap<string, string>): Map<string, Lazy> {
  const out = new Map<string, Lazy>()
  const visit = (lazy: Lazy) => {
    const item = lazy.address?.section === null ? lazy.address.item : undefined
    if (item !== undefined && byItem.has(item)) {
      if (!out.has(item)) out.set(item, lazy)
      return
    }
    if (lazy.kind === "section") return
    for (const child of lazy.children()) visit(child)
  }
  for (const group of groups) visit(group)
  return out
}

function rebase(lazy: Lazy, delta: number): Lazy {
  if (delta === 0) return lazy
  return {
    ...lazy,
    depth: lazy.depth + delta,
    children: () => lazy.children().map((child) => rebase(child, delta)),
  }
}

// Owner segment of a row id. An agent owns its own segment; a shared
// inventory row carries the catalogue discriminator instead — `` (empty) for
// Agents, which is exactly the id every pre-split record and row used, and
// `/teams` for Teams. Agent ids forbid `:` and never start with `/`, so
// `/teams` can never collide with one.
function ownerSegment(owner: string | null, catalogue?: Catalogue): string {
  if (owner !== null) return owner
  return catalogueOf(catalogue) === "teams" ? teamsOwnerSegment : ""
}

function addressOf(
  level: Level,
  owner: string | null,
  item: string,
  section: string | null,
  teamRef?: RowTeam,
  catalogue?: Catalogue,
): Address {
  return {
    level,
    agent: owner,
    item,
    section,
    ...teamFields(teamRef),
    // The Agents catalogue is the absent default, so an Agents-catalogue
    // address stays byte-identical to the address the same row carried before
    // the split.
    ...(catalogueOf(catalogue) === "teams" ? { catalogue: "teams" as const } : {}),
  }
}

// `item:<level>:<owner>:<itemId>` and `section:<level>:<owner>:<itemId>:<id>`.
// <owner> is the agent id under the Agents catalogue, `<team>/:<member>` and
// `<team>/:special:<agent>` under Teams, `` for the Agents inventory and
// `/teams` for the Teams one. The Agents-catalogue forms are exactly the ids
// that resolved before the split, so every stored id keeps working; the Teams
// forms are new ids for rows that resolve through a different chain.
function rowIdOf(
  kind: "item" | "section",
  level: Level,
  owner: string | null,
  item: string,
  catalogue?: Catalogue,
  ownerPath?: string,
  section?: string,
): string {
  const tail = section === undefined ? item : `${item}:${section}`
  return `${kind}:${level}:${ownerPath ?? ownerSegment(owner, catalogue)}:${tail}`
}

declare module "./model.js" {
  interface AgentSource {
    readonly ancestor?: boolean
  }
}

function lazyAgent(ctx: BuildContext, memo: Memo, level: Level, agent: AgentSource, depth: number): Lazy {
  return lazyOwnerRow(ctx, memo, {
    level,
    id: agent.id,
    label: agent.id,
    agent,
    depth,
    // Deletion eligibility mirrors removalPlan in ops.ts, which refuses every
    // scope except project|global. Defaults rows must not advertise `d`.
    // Built-ins and ancestor-backed agents cannot be deleted via agent.delete.
    remove: level !== "defaults" && agentOriginOf(agent) === "user" && agent.ancestor !== true,
    // Project and Global agents own a link; a native agent's Defaults row is
    // its own exact entry and takes none (create a Defaults entry instead).
    ...(level === "defaults" ? {} : { owner: ownerOf(ctx, { level, agent: agent.id }) }),
  })
}

// An `agent:<level>:<id>` row with the agent groups: a discovered agent, a
// Defaults entry or an agent preset. Their rows address `level/<id>`.
function lazyOwnerRow(
  ctx: BuildContext,
  memo: Memo,
  row: {
    readonly level: Level
    readonly id: string
    readonly label: string
    readonly agent: AgentSource | null
    readonly depth: number
    readonly remove: boolean
    readonly owner?: RowOwner
  },
): Lazy {
  return withAgentControls(memo, branch(memo, {
    kind: "agent",
    id: `agent:${row.level}:${row.id}`,
    label: row.label,
    depth: row.depth,
    ...(row.owner === undefined ? {} : { owner: row.owner }),
    actions: { ...noActions(), remove: row.remove },
    children: () =>
      withFolders(memo, [
        lazyModels(ctx, memo, row.level, row.id, row.agent, row.depth + 1),
        lazyTools(ctx, memo, row.level, row.id, row.agent, row.depth + 1),
        lazySkills(ctx, memo, row.level, row.id, row.agent, row.depth + 1),
        lazySystem(ctx, memo, row.level, row.id, row.agent, row.depth + 1),
        lazyControls(memo, "setting", row.level, row.id, row.depth + 1),
      ]),
  }), row.level, row.id)
}

// A link owner with the preset it is linked to now.
// A link to a preset no listing has (deleted from another project over its
// links) stays on the owner, marked missing: its rows fall through to the rest
// of the chain and the row says so until it is relinked.
function ownerOf(ctx: BuildContext, owner: Omit<RowOwner, "link" | "linkMissing">): RowOwner {
  const link = linkOf(ctx.scopes.links ?? [], owner)
  if (link === undefined) return owner
  const missing = !ctx.listing.some((entry) => presetKey(entry.ref) === presetKey(link))
  return { ...owner, link, ...(missing ? { linkMissing: true as const } : {}) }
}

function lazyAgentsGroup(ctx: BuildContext, memo: Memo, level: Level): Lazy {
  return branch(memo, {
    kind: "group",
    id: `group:${level}:agents`,
    label: "Agents",
    depth: 1,
    add: "agent",
    actions: noActions(),
    children: () => [
      lazyNativeAgents(ctx, memo, level),
      lazyPlusAgents(ctx, memo, level),
      lazyUserAgents(ctx, memo, level),
      ...(level === "defaults" ? lazyInventory(ctx, memo, "agents", 2) : []),
    ],
  })
}

// Origin subgroups: server-side origin carried on AgentSource, never inferred
// here from ids or paths. OpenCode holds its agents plus the nested Special
// subgroup; Plus and User hold their own agents. All four ids are always
// emitted even when empty; agent rows keep `agent:<level>:<id>`.
function agentOriginOf(agent: AgentSource): "native" | "special" | "plus" | "user" {
  if (agent.origin === "native" || agent.origin === "special" || agent.origin === "plus" || agent.origin === "user")
    return agent.origin
  return "user"
}

function nativeAgentsForLevel(ctx: BuildContext, level: Level): AgentSource[] {
  const defaults = ctx.agents.filter((agent) => agent.scope === "defaults" && agentOriginOf(agent) === "native")
  if (level === "defaults") return defaults
  const scoped = ctx.agents.filter((agent) => agent.scope === level && agentOriginOf(agent) === "native")
  const sameLevelIds = new Set(ctx.agents.filter((agent) => agent.scope === level).map((agent) => agent.id))
  const seen = new Set<string>()
  const result: AgentSource[] = []
  for (const agent of scoped) {
    if (!seen.has(agent.id)) {
      seen.add(agent.id)
      result.push(agent)
    }
  }
  for (const agent of defaults) {
    if (!sameLevelIds.has(agent.id) && !seen.has(agent.id)) {
      seen.add(agent.id)
      result.push(agent)
    }
  }
  return result
}

function specialAgentsForLevel(ctx: BuildContext, level: Level): AgentSource[] {
  const defaults = ctx.agents.filter((agent) => agent.scope === "defaults" && agentOriginOf(agent) === "special")
  if (level === "defaults") return defaults
  const scoped = ctx.agents.filter((agent) => agent.scope === level && agentOriginOf(agent) === "special")
  const sameLevelIds = new Set(ctx.agents.filter((agent) => agent.scope === level).map((agent) => agent.id))
  const seen = new Set<string>()
  const result: AgentSource[] = []
  for (const agent of scoped) {
    if (!seen.has(agent.id)) {
      seen.add(agent.id)
      result.push(agent)
    }
  }
  for (const agent of defaults) {
    if (!sameLevelIds.has(agent.id) && !seen.has(agent.id)) {
      seen.add(agent.id)
      result.push(agent)
    }
  }
  return result
}

function lazyNativeAgents(ctx: BuildContext, memo: Memo, level: Level): Lazy {
  return branch(memo, {
    kind: "group",
    id: `group:${level}:agents:native`,
    label: "OpenCode",
    depth: 2,
    actions: noActions(),
    children: () => [
      ...nativeAgentsForLevel(ctx, level).map((agent) => lazyAgent(ctx, memo, level, agent, 3)),
      lazySpecialAgents(ctx, memo, level),
    ],
  })
}

function lazySpecialAgents(ctx: BuildContext, memo: Memo, level: Level): Lazy {
  return branch(memo, {
    kind: "group",
    id: `group:${level}:agents:native:special`,
    label: "Special",
    depth: 3,
    actions: noActions(),
    children: () =>
      specialAgentsForLevel(ctx, level).map((agent) => lazyAgent(ctx, memo, level, agent, 4)),
  })
}

function lazyPlusAgents(ctx: BuildContext, memo: Memo, level: Level): Lazy {
  return branch(memo, {
    kind: "group",
    id: `group:${level}:agents:plus`,
    label: "Plus",
    depth: 2,
    actions: noActions(),
    children: () =>
      ctx.agents
        .filter((agent) => agent.scope === level && agentOriginOf(agent) === "plus" && !isTeamMemberEcho(ctx, level, agent))
        .map((agent) => lazyAgent(ctx, memo, level, agent, 3)),
  })
}

// An installed team member is not a Defaults agent: the host echoes it as an
// unbacked defaults agent. Keep the echo in ctx.agents (a team member's Models
// resolve through it) but do not list it under Defaults › Agents (T5); it
// already renders under its own team.
function isTeamMemberEcho(ctx: BuildContext, level: Level, agent: AgentSource): boolean {
  if (level !== "defaults" || agent.path !== undefined) return false
  return ctx.teams.some((team) => team.enabled && team.agents.includes(agent.id))
}

function lazyUserAgents(ctx: BuildContext, memo: Memo, level: Level): Lazy {
  return branch(memo, {
    kind: "group",
    id: `group:${level}:agents:user`,
    label: "User",
    depth: 2,
    add: "agent",
    actions: noActions(),
    children: () => [
      ...ctx.agents
        .filter((agent) => agent.scope === level && agentOriginOf(agent) === "user" && !isTeamMemberEcho(ctx, level, agent))
        .map((agent) => lazyAgent(ctx, memo, level, agent, 3)),
      ...(level === "defaults" ? agentEntries(ctx).map((entry) => lazyEntryAgent(ctx, memo, entry)) : []),
    ],
  })
}

// Defaults → Agents → User: one row per Agents entry (DESIGN §4), in the
// order they match (exact names first, then more literal characters).
function agentEntries(ctx: BuildContext): EntryRecord[] {
  return ctx.entries
    .filter((entry) => entry.catalogue === "agents")
    .toSorted((left, right) => entrySpecificity({ name: left.name }, { name: right.name }))
}

function lazyEntryAgent(ctx: BuildContext, memo: Memo, entry: EntryRecord): Lazy {
  return lazyOwnerRow(ctx, memo, {
    level: "defaults",
    id: entry.name,
    label: entry.name,
    agent: null,
    depth: 3,
    remove: true,
    owner: ownerOf(ctx, { level: "defaults", agent: entry.name, entry: { catalogue: "agents", name: entry.name } }),
  })
}

// Teams mirror the Agents group shape: a depth-1 "Teams" group per
// project/global/defaults root holding one toggleable row per team.
// Project and global rows come from on-disk team directories; Defaults rows
// come from the built-in source registry with no filesystem path. The group
// is always present (like Agents) with an `add: "team"` affordance, so an
// empty level still advertises team creation. `add` there still creates at
// project or global scope, never defaults: pressing `a` opens the existing
// addTeam flow, which prompts for a project/global scope. Member agent ids
// hang under each team row with the same groups an Agents-group agent renders.
// Member rows retain their entity identity and alias their Enabled setting's
// toggle. Their descendants address the same records as the Agents-group rows
// (level + agent + item), resolved through the Teams catalogue.
function lazyTeamsGroup(ctx: BuildContext, memo: Memo, level: Level): Lazy {
  const teams = ctx.teams
    .filter((team) => team.level === level)
    .toSorted((left, right) => (left.team < right.team ? -1 : left.team > right.team ? 1 : 0))
  return branch(memo, {
    kind: "group",
    id: `group:${level}:teams`,
    label: "Teams",
    depth: 1,
    add: "team",
    actions: noActions(),
    children: () => [
      ...teams.map((team) => lazyTeam(ctx, memo, level, team)),
      ...(level === "defaults"
        ? teamEntryPatterns(ctx)
            .filter((pattern) => !teams.some((team) => team.team === pattern))
            .map((pattern) => lazyEntryTeam(ctx, memo, pattern))
        : []),
      ...(level === "defaults" ? lazyInventory(ctx, memo, "teams", 2) : []),
    ],
  })
}

// Defaults → Teams: one row per team pattern of the Teams entries (absent =
// `*`), its member entries under it (DESIGN §4). A pattern is a row only
// while it has a member entry: the entry record is the member.
function teamEntryPatterns(ctx: BuildContext): string[] {
  return [...new Set(teamEntries(ctx).map((entry) => entry.team ?? "*"))].toSorted((left, right) =>
    entrySpecificity({ name: left }, { name: right }),
  )
}

function teamEntries(ctx: BuildContext): EntryRecord[] {
  return ctx.entries
    .filter((entry) => entry.catalogue === "teams")
    .toSorted((left, right) =>
      entrySpecificity({ name: left.name, team: left.team ?? "*" }, { name: right.name, team: right.team ?? "*" }),
    )
}

function membersOfPattern(ctx: BuildContext, pattern: string): string[] {
  return teamEntries(ctx)
    .filter((entry) => (entry.team ?? "*") === pattern)
    .map((entry) => entry.name)
}

function lazyEntryTeam(ctx: BuildContext, memo: Memo, pattern: string): Lazy {
  const team: TeamInput = { level: "defaults", team: pattern, enabled: false, agents: membersOfPattern(ctx, pattern) }
  return branch(memo, {
    kind: "team",
    id: `team:defaults:${pattern}`,
    label: pattern,
    depth: 2,
    add: "agent",
    owner: { level: "defaults", agent: null, team: { level: "defaults", team: pattern }, entry: { catalogue: "teams", team: pattern } },
    actions: { ...noActions(), remove: true },
    children: () => team.agents.map((member) => lazyTeamMember(ctx, memo, "defaults", team, member, 3, true)),
  })
}

// A member row: a discovered team's member, a Defaults Teams entry (`entry`)
// or a member preset (`preset`). Entries and member presets are team-scoped
// nodes (`defaults/<name>@<pattern>`, `preset/<member>@<team>`), so their rows
// carry the team on their address; a discovered member's rows address the
// agent itself in the Teams catalogue.
function lazyTeamMember(
  ctx: BuildContext,
  memo: Memo,
  level: Level,
  team: TeamInput | { readonly team: string; readonly agents: readonly string[] },
  member: string,
  depth: number,
  entry = false,
  preset?: PresetEntry,
): Lazy {
  if (member === "special") {
    throw new Error(`Cannot construct team member "special": member id "special" is reserved`)
  }
  const agent =
    entry || preset !== undefined
      ? null
      : (ctx.agents.find((candidate) => candidate.id === member && candidate.scope === level) ??
        ctx.agents.find((candidate) => candidate.id === member) ??
        null)
  const owner = member
  const scoped = entry || preset !== undefined
  // An ordinary member resolves as a member of this team — its team-scoped
  // link and records, this team's Teams entries — exactly as apply resolves
  // it, while its own records stay the per-agent ones (`memberOf`).
  const teamRef: RowTeam = scoped ? { level, team: team.team } : { memberOf: { level, team: team.team } }
  const removable =
    preset !== undefined
      ? preset.origin === "user"
      : entry || level !== "defaults" || ("overlay" in team && (team.overlay?.includes(member) ?? false))
  const rowOwner: RowOwner | undefined =
    preset !== undefined
      ? ownerOf(ctx, { level, agent: member, team: { level, team: team.team }, preset: { ref: preset.ref, origin: preset.origin } })
      : entry
        ? ownerOf(ctx, { level, agent: member, team: { level, team: team.team }, entry: { catalogue: "teams", team: team.team, name: member } })
        : level === "defaults"
          ? undefined
          : ownerOf(ctx, { level, agent: member, team: { level, team: team.team } })
  // Team-member group ids use `/:` between team and member. Agent ids forbid
  // `:` (validateAgentId in agents/files.ts) while team names allow it, so an
  // owner containing `:` can only be a team member group and never collides
  // with a nested agent id like `crew/alpha` (`/` alone is legal in agent
  // ids). The `/` is kept so the existing `group:<level>:<team>/` prefix still
  // matches; the extra `:` is the disambiguator. Team names never contain
  // `/`, so the split on the first `/` stays unambiguous even for colon team
  // names and nested member ids.
  const memberPath = `${team.team}/:${member}`
  const memberGroup = `group:${level}:${memberPath}`
  return withAgentControls(memo, branch(memo, {
    kind: "team",
    id: `team:${level}:${team.team}:${member}`,
    label: member,
    depth,
    // A member preset takes no member of its own; every other member row adds
    // to its team (a member entry, a member file).
    ...(preset === undefined ? { add: "agent" as const } : {}),
    ...(rowOwner === undefined ? {} : { owner: rowOwner }),
    actions: { ...noActions(), remove: removable },
    // A member's rows address the same per-agent records as its Agents-group
    // rows (level + agent + item), so an edit made here and an edit made there
    // are one record. What differs is the chain — this team's `L/A@T` node,
    // link and Teams entries, then the Teams catalogue, never Agents — which
    // is a different resolved answer, so the rows carry their own ids under
    // the member's `<team>/:<member>` owner path instead of colliding with
    // the stand-alone agent's.
    children: () =>
      withFolders(memo, [
        lazyModels(ctx, memo, level, owner, agent, depth + 1, `${memberGroup}:models`, teamRef, "teams", memberPath),
        lazyTools(ctx, memo, level, owner, agent, depth + 1, `${memberGroup}:tools`, teamRef, "teams", memberPath),
        lazySkills(ctx, memo, level, owner, agent, depth + 1, `${memberGroup}:skills`, teamRef, "teams", memberPath),
        lazySystem(ctx, memo, level, owner, agent, depth + 1, `${memberGroup}:system`, teamRef, "teams", memberPath),
        lazyControls(memo, "setting", level, owner, depth + 1, teamRef, "teams", memberPath),
      ]),
  }), level, owner, teamRef, "teams", memberPath)
}

function lazyTeamSpecial(ctx: BuildContext, memo: Memo, level: Level, team: TeamInput): Lazy {
  const specials = specialAgentsForLevel(ctx, level)
  return branch(memo, {
    kind: "group",
    id: `team:${level}:${team.team}:special`,
    label: "Special",
    depth: 3,
    actions: noActions(),
    children: () =>
      specials.map((agent) => lazyTeamSpecialAgent(ctx, memo, level, team, agent)),
  })
}

function lazyTeamSpecialAgent(
  ctx: BuildContext,
  memo: Memo,
  level: Level,
  team: TeamInput,
  agent: AgentSource,
): Lazy {
  const owner = agent.id
  const teamRef: TeamRef = { level, team: team.team }
  const specialPath = `${team.team}/:special:${agent.id}`
  const specialGroup = `group:${level}:${specialPath}`
  return withAgentControls(memo, branch(memo, {
    kind: "team",
    id: `team:${level}:${team.team}:special:${agent.id}`,
    label: agent.id,
    depth: 4,
    actions: noActions(),
    children: () =>
      withFolders(memo, [
        lazyModels(ctx, memo, level, owner, agent, 5, `${specialGroup}:models`, teamRef, "teams", specialPath),
        lazyTools(ctx, memo, level, owner, agent, 5, `${specialGroup}:tools`, teamRef, "teams", specialPath),
        lazySkills(ctx, memo, level, owner, agent, 5, `${specialGroup}:skills`, teamRef, "teams", specialPath),
        lazySystem(ctx, memo, level, owner, agent, 5, `${specialGroup}:system`, teamRef, "teams", specialPath),
        lazyControls(memo, "setting", level, owner, 5, teamRef, "teams", specialPath),
      ]),
  }), level, owner, teamRef, "teams", specialPath)
}

function lazyTeam(ctx: BuildContext, memo: Memo, level: Level, team: TeamInput): Lazy {
  // A Defaults team (an injected registry; none ships) also lists the member
  // entries whose team pattern is exactly its name.
  const entries = level === "defaults" ? membersOfPattern(ctx, team.team).filter((member) => !team.agents.includes(member)) : []
  const kids = (): readonly Lazy[] =>
    arrangeList(
      memo,
      `team:${level}:${team.team}`,
      cachedKids(memo, `team:${level}:${team.team}`, () => [
        ...team.agents.map((member) => lazyTeamMember(ctx, memo, level, team, member, 3)),
        ...entries.map((member) => lazyTeamMember(ctx, memo, level, team, member, 3, true)),
        lazyTeamSpecial(ctx, memo, level, team),
      ]),
    )
  const owner = level === "defaults" ? undefined : ownerOf(ctx, { level, agent: null, team: { level, team: team.team } })
  return {
    id: `team:${level}:${team.team}`,
    kind: "team",
    label: team.team,
    depth: 2,
    add: "agent",
    ...(owner === undefined ? {} : { owner }),
    actions: { ...noActions(), toggle: true, remove: level !== "defaults" },
    selfReview: () => false,
    partial: () => ({ state: team.enabled ? ("on" as const) : ("off" as const) }),
    reviewCount: () => 0,
    children: kids,
  }
}

function lazyMcpInventory(ctx: BuildContext, memo: Memo, catalogue: Catalogue, depth: number): Lazy {
  return branch(memo, {
    kind: "group",
    id: `group:defaults:${ownerSegment(null, catalogue)}:mcp`,
    label: "MCP",
    depth,
    add: "mcp",
    actions: noActions(),
    children: () =>
      sortedKind(ctx, "mcp", null).map((item) =>
        lazyItem(ctx, memo, "defaults", null, null, item, depth + 1, undefined, catalogue),
      ),
  })
}

/** Control behavior is UI metadata; values and inheritance belong to the discovered Items. */
export function controlKind(item: string | undefined): "toggle" | "cycle" | "text" | undefined {
  if (item === undefined) return undefined
  if (booleanControl(item)) return "toggle"
  if (controlChoices(item) !== undefined) return "cycle"
  if (isControl(item)) return "text"
  return undefined
}

export function controlChoices(item: string | undefined): readonly string[] | undefined {
  if (item?.startsWith("toolmode:")) return toolModes
  if (item !== undefined && isAttentionRow(item)) return attentionRowChoices(item)
  if (item === "setting:mode") return ["primary", "subagent", "all"]
  if (item === "compaction:strategy") return ["auto", "local", "remote"]
  return undefined
}

/** Older/empty snapshots still have the backend's default controls for presets and Defaults. */
export function withControlItems(items: readonly Item[]): readonly Item[] {
  if (items.some((item) => isControl(item.id) && item.agents === undefined)) return items
  return [...items, ...controlItems()]
}

function itemsForControls(memo: Memo): readonly Item[] {
  return memo.controlItems ??= withControlItems(memo.ctx.items)
}

export function controlValue(item: string, text: string, enabled: boolean): string {
  if (item.startsWith("toolmode:") && text === "codemode") return "Code Mode"
  if (isAttentionRow(item) && text.length === 0) return "As in Settings"
  if (controlKind(item) === "toggle") return enabled ? "On" : "Off"
  if (controlChoices(item) !== undefined) return text.length === 0 ? "Inherited" : text[0].toUpperCase() + text.slice(1)
  if (text.length > 0) return text.replace(/\s+/g, " ").slice(0, 80)
  if (item === "compaction:model") return "Inherited model"
  if (item === "compaction:instructions") return "Empty prompt"
  if (item === "setting:steps") return "Unlimited"
  return "Not set"
}

function lazyControls(
  memo: Memo,
  kind: "setting" | "compaction",
  level: Level,
  owner: string | null,
  depth: number,
  teamRef?: RowTeam,
  catalogue?: Catalogue,
  ownerPath?: string,
): Lazy {
  const items = itemsForControls(memo)
  return branch(memo, {
    kind: "group",
    id: `group:${level}:${ownerPath ?? ownerSegment(owner, catalogue)}:${kind === "setting" ? "settings" : "compaction"}`,
    label: kind === "setting" ? "Settings" : "Compaction",
    depth,
    actions: noActions(),
    children: () => {
      const rows = [...new Set(items.filter((item) => item.kind === kind && isControl(item.id)).map((item) => item.id))]
        .flatMap((item) => {
          const upstream = controlItemFor(items, addressOf(level, owner, item, null, teamRef, catalogue))
          return upstream === undefined ? [] : [upstream]
        })
        .sort(byOrderTitle)
      const attention = rows.filter((item) => isAttentionRow(item.id))
      return [
        ...rows.filter((item) => !isAttentionRow(item.id)).map((item) => lazyControl(memo, level, owner, item, depth + 1, teamRef, catalogue, ownerPath)),
        // An agent's own notification rows; the global ones are Settings › Notifications, so
        // Defaults has none.
        ...(owner === null || attention.length === 0
          ? []
          : [
              branch(memo, {
                kind: "group",
                id: `group:${level}:${ownerPath ?? ownerSegment(owner, catalogue)}:notifications`,
                label: "Notifications",
                depth: depth + 1,
                actions: noActions(),
                children: () => attention.map((item) => lazyControl(memo, level, owner, item, depth + 2, teamRef, catalogue, ownerPath)),
              }),
            ]),
      ]
    },
  })
}

export function lazyControl(
  memo: Memo,
  level: Level,
  owner: string | null,
  item: Item,
  depth: number,
  teamRef?: RowTeam,
  catalogue?: Catalogue,
  ownerPath?: string,
): Lazy {
  const address = addressOf(level, owner, item.id, null, teamRef, catalogue)
  const id = rowIdOf("item", level, owner, item.id, catalogue, ownerPath)
  const local = item.id === "compaction:model" || item.id === "compaction:instructions"
  const strategy = local ? controlItemFor(itemsForControls(memo), { ...address, item: "compaction:strategy" }) : undefined
  const disabled = () => strategy !== undefined && wholeOf(memo, level, owner, strategy, catalogue, teamRef).text === "remote"
    ? "Remote compaction uses the provider. Local model and instructions are retained; choose Auto or Local to edit them."
    : undefined
  const toggle = controlKind(item.id) === "toggle"
  // B7: a free-text control's text reaches its consumer, so it takes sections
  // like any other text row: the agent/member description and the agent-wide
  // compaction instructions. Mode, strategy, model, color and steps are
  // enumerated or scalar values, not text to section.
  const sectioned = item.id === "setting:description" || item.id === "compaction:instructions"
  return {
    id,
    kind: "item",
    label: item.title[0].toUpperCase() + item.title.slice(1),
    depth,
    get expandable() {
      return sectioned && splitOf(memo, level, owner, item, catalogue, teamRef).kind !== "whole"
    },
    address,
    ...(sectioned ? { add: "section" as const } : {}),
    get actions() {
      const available = disabled() === undefined
      return {
        ...noActions(),
        toggle: toggle && available,
        edit: !toggle && available,
        reset: available && canReset(memo.ctx.customizations, address),
        ...(sectioned ? { split: available } : {}),
      }
    },
    selfReview: () => flagOf(memo, level, owner, item, null, catalogue, teamRef),
    partial: () => {
      const resolved = wholeOf(memo, level, owner, item, catalogue, teamRef)
      const from = toggle ? resolved.from : resolved.textFrom
      const reason = disabled()
      return {
        ...(toggle ? { state: resolved.enabled ? "on" as const : "off" as const } : {}),
        value: controlValue(item.id, resolved.assembled, resolved.enabled),
        modified: resolved.modified,
        source: resolved.source,
        from,
        fromLabel: fromLabel(from, { labels: memo.ctx.labels, level, ...ownOption(memo.ctx, level, owner, teamRef) }),
        ...(resolved.reviewOf.length === 0 ? {} : { reviewOf: resolved.reviewOf }),
        ...(reason === undefined ? {} : { disabled: reason }),
      }
    },
    reviewCount: () => 0,
    children: () => {
      if (!sectioned) return []
      const split = splitOf(memo, level, owner, item, catalogue, teamRef)
      return split.kind === "whole" ? [] : sectionKids(memo.ctx, memo, level, owner, item, split, depth + 1, teamRef, catalogue, ownerPath)
    },
  }
}

// Entity rows retain their ids and entity semantics. Their on/off action is
// an alias of the same Enabled item the Settings category renders, including
// its team/catalogue chain; no second record or synthetic item is introduced.
function withAgentControls(
  memo: Memo,
  row: Lazy,
  level: Level,
  owner: string,
  teamRef?: RowTeam,
  catalogue?: Catalogue,
  ownerPath?: string,
): Lazy {
  const address = addressOf(level, owner, "setting:enabled", null, teamRef, catalogue)
  const items = itemsForControls(memo)
  const enabled = controlItemFor(items, address)
  if (enabled === undefined) return row
  const control = lazyControl(memo, level, owner, enabled, row.depth, teamRef, catalogue, ownerPath)
  return {
    ...row,
    enabledRow: control.id,
    actions: {
      ...row.actions,
      toggle: control.actions.toggle,
      reset: controlIds.some((item) => canReset(memo.ctx.customizations, { ...address, item })),
    },
    partial: () => {
      const hidden = controlItemFor(items, { ...address, item: "setting:hidden" })
      const mode = controlItemFor(items, { ...address, item: "setting:mode" })
      const { value, ...badges } = control.partial()
      return {
        ...row.partial(),
        ...badges,
        ...(hidden === undefined ? {} : { hidden: wholeOf(memo, level, owner, hidden, catalogue, teamRef).enabled }),
        ...(mode === undefined ? {} : { mode: wholeOf(memo, level, owner, mode, catalogue, teamRef).text }),
      }
    },
  }
}

// Models group, the first tab of each agent subtree and shared Defaults
// inventory. Rows are the union down the chain (deduplicated) plus the
// agent's upstream model, each carrying a source badge naming the level it
// came from. Toggle activates exclusively at this level, remove hides or
// deletes the row at this level only; edit replaces it; no split or pin.
// Active marks the agent's effective model: the runtime chain's winner (a
// native built-in's Defaults row runs at Project), which may sit at another
// level than the row's own — then the badge reads `active (<level>)` and the
// inspector from fact says inherited. When that winner is not one of this
// level's rows, nothing is marked active and both the group and its rows carry
// `effective`, so a level never claims a model that is not the one in force
// and the row under the cursor still names the model in force.
function lazyModels(
  ctx: BuildContext,
  memo: Memo,
  level: Level,
  owner: string | null,
  agent: AgentSource | null,
  depth: number,
  groupId?: string,
  teamRef?: RowTeam,
  catalogue?: Catalogue,
  ownerPath?: string,
): Lazy {
  const prefix = groupId ?? `group:${level}:${ownerSegment(owner, catalogue)}:models`
  return branch(
    memo,
    {
      kind: "group",
      id: prefix,
      label: "Models",
      depth,
      add: "model",
      actions: noActions(),
      partial: () => {
        const effective = effectiveUnlisted(memo, prefix, ctx, level, owner, agent, teamRef, catalogue)
        return effective === undefined ? {} : { effective }
      },
      children: () =>
        cachedKids(memo, prefix, () => {
          const state = cachedModelsState(memo, prefix, () => lazyModelsState(ctx, level, owner, agent, teamRef, catalogue))
          const effective = effectiveUnlisted(memo, prefix, ctx, level, owner, agent, teamRef, catalogue)
          return state.candidates
            .toSorted((left, right) => {
              const leftId = modelItemId(left)
              const rightId = modelItemId(right)
              if (leftId < rightId) return -1
              if (leftId > rightId) return 1
              return 0
            })
            .map((candidate) => lazyModelItem(memo, ctx, level, owner, candidate, state.active, depth + 1, teamRef, catalogue, ownerPath, effective))
        }) as readonly Lazy[],
    },
  )
}

// The group's and its rows' effective note: present only when the agent's
// effective model is not one of this level's listed candidates.
function effectiveUnlisted(
  memo: Memo,
  prefix: string,
  ctx: BuildContext,
  level: Level,
  owner: string | null,
  agent: AgentSource | null,
  teamRef?: RowTeam,
  catalogue?: Catalogue,
): string | undefined {
  const state = cachedModelsState(memo, prefix, () => lazyModelsState(ctx, level, owner, agent, teamRef, catalogue))
  if (state.active === undefined) return undefined
  if (state.candidates.some((candidate) => sameModelCandidate(candidate, state.active!))) return undefined
  return `${modelLabel(state.active)} · active at ${levelWord(state.active.source)}`
}

interface ModelsState {
  readonly candidates: ReturnType<typeof modelCandidates>
  /** The agent's effective model on its runtime chain, whether or not this level lists it. */
  readonly active: ReturnType<typeof resolveActiveModel>
}

const modelsStateCache = new WeakMap<Memo, Map<string, ModelsState>>()

function cachedModelsState(memo: Memo, prefix: string, build: () => ModelsState): ModelsState {
  let cache = modelsStateCache.get(memo)
  if (cache === undefined) {
    cache = new Map()
    modelsStateCache.set(memo, cache)
  }
  const cached = cache.get(prefix)
  if (cached !== undefined) return cached
  const state = build()
  cache.set(prefix, state)
  return state
}

function lazyModelsState(
  ctx: BuildContext,
  level: Level,
  owner: string | null,
  agent: AgentSource | null,
  teamRef?: RowTeam,
  catalogue?: Catalogue,
): ModelsState {
  const upstream = upstreamForModels(ctx, level, owner, agent)
  const view = {
    models: ctx.models,
    scopes: ctx.scopes,
    level,
    agent: owner,
    ...teamFields(teamRef),
    ...(catalogue === undefined ? {} : { catalogue }),
    ...(upstream === undefined ? {} : { upstream }),
  }
  const runtime = modelRuntimeScope({
    scopes: ctx.scopes,
    level,
    owner,
    ...(agent?.scope === undefined ? {} : { agentScope: agent.scope }),
    ...(teamFields(teamRef).team === undefined ? {} : { team: teamFields(teamRef).team! }),
  })
  return {
    candidates: modelCandidates(view),
    active: resolveActiveModel({ ...view, level: runtime.level, scopes: runtime.scopes }),
  }
}

function levelWord(level: Level | "upstream"): string {
  if (level === "defaults") return "defaults"
  if (level === "global") return "global"
  if (level === "preset") return "preset"
  if (level === "project") return "project"
  return "upstream"
}

function upstreamForModels(
  ctx: BuildContext,
  level: Level,
  owner: string | null,
  agent: AgentSource | null,
): { providerID: string; modelID: string; variant?: string } | undefined {
  if (owner === null) return undefined
  if (agent?.model !== undefined) return agent.model
  const scoped = ctx.agents.find((entry) => entry.id === owner && entry.scope === level)
  if (scoped?.model !== undefined) return scoped.model
  return ctx.agents.find((entry) => entry.id === owner)?.model
}

function lazyModelItem(
  memo: Memo,
  ctx: BuildContext,
  level: Level,
  owner: string | null,
  candidate: { providerID: string; modelID: string; variant?: string; source: Level | "upstream"; from: From },
  active: { providerID: string; modelID: string; variant?: string; source?: Level | "upstream"; review?: true } | undefined,
  depth: number,
  teamRef?: RowTeam,
  catalogue?: Catalogue,
  ownerPath?: string,
  effective?: string,
): Lazy {
  const itemId = modelItemId(candidate)
  const address = addressOf(level, owner, itemId, null, teamRef, catalogue)
  const target = { providerID: candidate.providerID, modelID: candidate.modelID, ...(candidate.variant === undefined ? {} : { variant: candidate.variant }) }
  const isActive = active !== undefined && sameModelCandidate(target, active)
  // The row's own node: a member row's is per-agent (teamFields → memberOf).
  const own = teamFields(teamRef).team
  const scope = { level, agent: owner, ...(own !== undefined ? { team: own } : {}), ...(catalogue === undefined ? {} : { catalogue }) }
  const canResetHere = hasModelActiveAt(ctx.models, scope)
  void memo
  void parseModelItemId
  const id = rowIdOf("item", level, owner, itemId, catalogue, ownerPath)
  return {
    id,
    kind: "item",
    label: modelLabel(candidate),
    depth,
    address,
    actions: {
      toggle: true,
      edit: false,
      reset: canResetHere,
      // Any model row is removable: a local record is deleted, an inherited or
      // upstream row is hidden at this level with a tombstone, and the row
      // that is currently effective refuses with its own message.
      remove: true,
      split: false,
      pin: false,
    },
    // §3.6: the row's own active model, recorded against an active model
    // above that has since changed. Only when the active record is at the
    // row's own level: a review belongs to the level that chose the model.
    selfReview: () => isActive && active?.review === true && active.source === level,
    partial: () => {
      const fields = resolveModelFields(
        { models: ctx.models, scopes: ctx.scopes, level, agent: owner, ...teamFields(teamRef), ...(catalogue === undefined ? {} : { catalogue }) },
        target,
      )
      return {
        ...(isActive ? { active: true as const } : {}),
        ...(isActive && active?.source !== undefined && active.source !== "upstream" && active.source !== level ? { activeFrom: active.source } : {}),
        ...(!isActive && effective !== undefined ? { effective } : {}),
        source: candidate.source,
        from: candidate.from,
        fromLabel: fromLabel(candidate.from, { labels: ctx.labels, level, ...ownOption(ctx, level, owner, teamRef) }),
        ...(fields.warming === undefined ? {} : { warming: fields.warming.value, warmingFrom: fields.warming.level }),
        ...(fields.interval === undefined ? {} : { interval: fields.interval.value, intervalFrom: fields.interval.level }),
        ...(fields.waiting === undefined ? {} : { waiting: fields.waiting.value, waitingFrom: fields.waiting.level }),
        ...(fields.prompt === undefined ? {} : { prompt: fields.prompt.value, promptFrom: fields.prompt.level }),
      }
    },
    reviewCount: () => 0,
    // The row opens into Model and Effort, then the Warming, Compaction and Images
    // group rows; Warming holds its fields, Compact before cold and the
    // cold-cache list, Compaction its strategy, model and instructions, Images
    // how new images are stored and what happens when they fill a request.
    children: () => modelRowChildren(memo, ctx, level, owner, candidate, id, depth + 1, teamRef, catalogue, ownerPath),
  }
}

interface ModelFieldInfo {
  readonly value: string
  readonly own: boolean
}

// The children of an agent/member/preset model row: Model and Effort, then the
// Warming and Compaction group rows (plus-1.1.18 §2). Warming and Compaction
// carry no address and no toggle: their fields differ in kind, so Space does
// nothing. Only the cold-cache group is itself a switch, and it opens into the
// numbered model list.
function modelRowChildren(
  memo: Memo,
  ctx: BuildContext,
  level: Level,
  owner: string | null,
  candidate: { providerID: string; modelID: string; variant?: string; source: Level | "upstream"; from: From },
  modelRowId: string,
  depth: number,
  teamRef?: RowTeam,
  catalogue?: Catalogue,
  ownerPath?: string,
): readonly Lazy[] {
  return [
    lazyModelField(memo, ctx, level, owner, candidate, "model", depth, teamRef, catalogue, ownerPath),
    lazyModelField(memo, ctx, level, owner, candidate, "effort", depth, teamRef, catalogue, ownerPath),
    modelGroup(memo, {
      id: modelGroupRowId(modelRowId, "warming"),
      label: "Warming",
      depth,
      summary: () => warmingGroupSummary(memo, ctx, level, owner, candidate, teamRef, catalogue),
      children: [
        () => lazyModelField(memo, ctx, level, owner, candidate, "warming", depth + 1, teamRef, catalogue, ownerPath),
        () => lazyModelField(memo, ctx, level, owner, candidate, "interval", depth + 1, teamRef, catalogue, ownerPath),
        () => lazyModelField(memo, ctx, level, owner, candidate, "waiting", depth + 1, teamRef, catalogue, ownerPath),
        () => lazyModelField(memo, ctx, level, owner, candidate, "prompt", depth + 1, teamRef, catalogue, ownerPath),
        () => lazyModelField(memo, ctx, level, owner, candidate, "compactWarm", depth + 1, teamRef, catalogue, ownerPath),
        () => coldListGroup(memo, ctx, level, owner, candidate, modelRowId, depth + 1, teamRef, catalogue, ownerPath),
      ],
    }),
    modelGroup(memo, {
      id: modelGroupRowId(modelRowId, "compaction"),
      label: "Compaction",
      depth,
      summary: () => compactionGroupSummary(memo, ctx, level, owner, candidate, teamRef, catalogue),
      children: [
        () => lazyModelField(memo, ctx, level, owner, candidate, "compactionStrategy", depth + 1, teamRef, catalogue, ownerPath),
        () => lazyModelField(memo, ctx, level, owner, candidate, "compactionInput", depth + 1, teamRef, catalogue, ownerPath),
        () => lazyModelField(memo, ctx, level, owner, candidate, "compactionOutput", depth + 1, teamRef, catalogue, ownerPath),
        () => lazyModelField(memo, ctx, level, owner, candidate, "compactionModel", depth + 1, teamRef, catalogue, ownerPath),
        () => lazyModelField(memo, ctx, level, owner, candidate, "compactionInstructions", depth + 1, teamRef, catalogue, ownerPath),
      ],
    }),
    modelGroup(memo, {
      id: modelGroupRowId(modelRowId, "images"),
      label: "Images",
      depth,
      summary: () => imagesSummary(effectiveImagesFor(ctx, level, owner, candidate, teamRef, catalogue)),
      children: IMAGE_FIELDS.map((field) => () => lazyModelField(memo, ctx, level, owner, candidate, field, depth + 1, teamRef, catalogue, ownerPath)),
    }),
  ]
}

// A plain group row: no address, no toggle, a summary line and children. Space
// on it does nothing (its fields differ in kind).
function modelGroup(
  memo: Memo,
  args: {
    readonly id: string
    readonly label: string
    readonly depth: number
    readonly summary: () => string
    readonly children: readonly (() => Lazy)[]
  },
): Lazy {
  const kids = (): readonly Lazy[] => cachedKids(memo, args.id, () => args.children.map((build) => build()))
  return {
    id: args.id,
    kind: "group",
    label: args.label,
    depth: args.depth,
    actions: noActions(),
    selfReview: () => false,
    partial: () => ({ value: args.summary() }),
    reviewCount: () => cachedReviewCount(memo, args.id, () => rollup(kids())),
    children: kids,
  }
}

// The cold-cache group: the numbered list of models that compact a cold cache
// (`r` inherits). Whether they do is the global Settings switch.
function coldListGroup(
  memo: Memo,
  ctx: BuildContext,
  level: Level,
  owner: string | null,
  candidate: { providerID: string; modelID: string; variant?: string; source: Level | "upstream"; from: From },
  modelRowId: string,
  depth: number,
  teamRef?: RowTeam,
  catalogue?: Catalogue,
  ownerPath?: string,
): Lazy {
  const id = modelGroupRowId(modelRowId, "cold")
  const itemId = modelFieldItemId(targetOf(candidate), "coldCompact")
  const address = addressOf(level, owner, itemId, null, teamRef, catalogue)
  const rows = (): readonly string[] => coldListOf(memo, ctx, level, owner, candidate, teamRef, catalogue).value
  const own = (): boolean => coldOwnAt(ctx, level, owner, candidate, teamRef, catalogue)
  const kids = (): readonly Lazy[] =>
    rows().map((model, index): Lazy => ({
      id: modelColdRowId(modelRowId, index),
      kind: "item",
      label: model,
      depth: depth + 1,
      address: { ...address, item: coldModelItemId(targetOf(candidate), index) },
      actions: { toggle: false, edit: false, reset: false, remove: true, split: false, pin: false },
      selfReview: () => false,
      partial: () => ({ value: coldListValue(index, model) }),
      reviewCount: () => 0,
      children: () => [],
    }))
  return {
    id,
    kind: "group",
    label: COLD_COMPACT_LABEL,
    depth,
    address,
    actions: { toggle: false, edit: false, reset: own(), remove: false, split: false, pin: false },
    selfReview: () => false,
    partial: () => ({ value: coldCompactSummary(rows()) }),
    reviewCount: () => cachedReviewCount(memo, id, () => rollup(kids())),
    children: kids,
  }
}

function targetOf(candidate: { providerID: string; modelID: string; variant?: string }): { providerID: string; modelID: string; variant?: string } {
  return { providerID: candidate.providerID, modelID: candidate.modelID, ...(candidate.variant === undefined ? {} : { variant: candidate.variant }) }
}

// A nested group under a model row, addressed so `:model:` never appears: the
// `isModelRowId`/`isModelDefaultRowId` checks stay true only for the model row
// itself, never for its groups or field rows.
function modelGroupRowId(modelRowId: string, suffix: string): string {
  return `${modelRowId.replace(/^item:/, "group:").replace(/:model:/, ":modelgroup:")}:${suffix}`
}

// A cold-cache list row under a model row: an item id with its own marker.
function modelColdRowId(modelRowId: string, index: number): string {
  return `${modelRowId.replace(/:model:/, ":coldmodel:")}:${COLD_ITEM_SEGMENT}:${index}`
}

// A nested group or cold-list row under a Defaults › Models row: `group:` for
// the groups and a distinct `item:` marker for the rows, so only the model row
// itself answers `isModelDefaultRowId`.
function defaultGroupRowId(key: ModelSettingsKey, suffix: string): string {
  return `${modelDefaultRowId(key).replace(/^item:/, "group:")}:${suffix}`
}

function defaultColdRowId(key: ModelSettingsKey, index: number): string {
  return `item:defaults:${MODELS_OWNER}:modelcold:${modelDefaultItemId(key).slice(MODEL_DEFAULT_PREFIX.length)}:${COLD_ITEM_SEGMENT}:${index}`
}

// The effective compaction for one agent model row: the row's own chain, then
// the agent's old agent-wide rows, then Defaults › Models, Every model, the
// shared Defaults rows and opencode.json (model-settings.ts).
// The image settings this agent on this model resolves: its model rows, then Defaults › Models.
function effectiveImagesFor(
  ctx: BuildContext,
  level: Level,
  owner: string | null,
  candidate: { providerID: string; modelID: string; variant?: string },
  teamRef?: RowTeam,
  catalogue?: Catalogue,
) {
  const target = targetOf(candidate)
  const row = resolveModelCompactionFields(
    { models: ctx.models, scopes: ctx.scopes, level, agent: owner, ...teamFields(teamRef), ...(catalogue === undefined ? {} : { catalogue }) },
    target,
  )
  const model = settingsFor(ctx.modelSettings, target)
  const every = everySettings(ctx.modelSettings)
  return effectiveImages({ row, ...(model === undefined ? {} : { model }), ...(every === undefined ? {} : { every }) })
}

function effectiveCompactionFor(
  memo: Memo,
  ctx: BuildContext,
  level: Level,
  owner: string | null,
  candidate: { providerID: string; modelID: string; variant?: string; source: Level | "upstream"; from: From },
  teamRef?: RowTeam,
  catalogue?: Catalogue,
): EffectiveCompaction {
  const target = targetOf(candidate)
  const row = resolveModelCompactionFields(
    { models: ctx.models, scopes: ctx.scopes, level, agent: owner, ...teamFields(teamRef), ...(catalogue === undefined ? {} : { catalogue }) },
    target,
  )
  const { agent, agents } = agentWideCompaction(memo, level, owner, teamRef, catalogue)
  const model = settingsFor(ctx.modelSettings, target)
  const every = everySettings(ctx.modelSettings)
  return effectiveCompaction({
    row,
    ...(agent === undefined ? {} : { agent }),
    ...(agents === undefined ? {} : { agents }),
    ...(model === undefined ? {} : { model }),
    ...(every === undefined ? {} : { every }),
  })
}

// The old agent-wide `compaction:*` rows, still applied by resolution: the
// owner's own chain (labelled `agent-wide`) and the shared Defaults rows
// (labelled `every agent`). The UI never writes them again.
function agentWideCompaction(
  memo: Memo,
  level: Level,
  owner: string | null,
  teamRef?: RowTeam,
  catalogue?: Catalogue,
): { agent?: CompactionDefaults; agents?: CompactionDefaults } {
  if (owner === null) return {}
  const items = itemsForControls(memo)
  const value = (itemId: string, atLevel: Level, atOwner: string | null): { readonly text: string; readonly level: boolean } | undefined => {
    const address = addressOf(atLevel, atOwner, itemId, null, teamRef, catalogue)
    const item = controlItemFor(items, address)
    if (item === undefined) return undefined
    const resolved = wholeOf(memo, atLevel, atOwner, item, catalogue, teamRef)
    // The text reaches core as the assembled body (section edits and
    // exclusions applied), the same body apply installs.
    const text = resolved.assembled
    // The backend's default rows carry "" for the model and instructions; an
    // empty text there is "inherit", not an explicit empty prompt.
    if (text.length === 0 && (itemId === "compaction:model" || itemId === "compaction:instructions")) return undefined
    return { text, level: resolved.textFrom.kind === "level" }
  }
  const own = (itemId: string): string | undefined => {
    const found = value(itemId, level, owner)
    return found === undefined || !found.level ? undefined : found.text
  }
  const shared = (itemId: string): string | undefined => {
    const text = value(itemId, "defaults", null)?.text
    // The backend's default rows carry the built-in values (auto, "", ""); a
    // value equal to the built-in is "not set" here, not an every-agent layer.
    if (itemId === "compaction:strategy" && text === "auto") return undefined
    return text
  }
  const agentFields = {
    ...(own("compaction:strategy") === undefined ? {} : { strategy: own("compaction:strategy") }),
    ...(own("compaction:model") === undefined ? {} : { model: own("compaction:model") }),
    ...(own("compaction:instructions") === undefined ? {} : { instructions: own("compaction:instructions") }),
  }
  const agentsFields = {
    ...(shared("compaction:strategy") === undefined ? {} : { strategy: shared("compaction:strategy") }),
    ...(shared("compaction:model") === undefined ? {} : { model: shared("compaction:model") }),
    ...(shared("compaction:instructions") === undefined ? {} : { instructions: shared("compaction:instructions") }),
  }
  return {
    ...(Object.keys(agentFields).length === 0 ? {} : { agent: agentFields }),
    ...(Object.keys(agentsFields).length === 0 ? {} : { agents: agentsFields }),
  }
}

function coldListOf(
  memo: Memo,
  ctx: BuildContext,
  level: Level,
  owner: string | null,
  candidate: { providerID: string; modelID: string; variant?: string; source: Level | "upstream"; from: From },
  teamRef?: RowTeam,
  catalogue?: Catalogue,
): EffectiveCompaction["coldModels"] {
  return effectiveCompactionFor(memo, ctx, level, owner, candidate, teamRef, catalogue).coldModels
}

// Whether this level's own model row sets the list (or the retired switch, so a reset clears it).
function coldOwnAt(
  ctx: BuildContext,
  level: Level,
  owner: string | null,
  candidate: { providerID: string; modelID: string; variant?: string },
  teamRef?: RowTeam,
  catalogue?: Catalogue,
): boolean {
  const target = targetOf(candidate)
  const scope = { level, agent: owner, ...teamFields(teamRef), ...(catalogue === undefined ? {} : { catalogue }) }
  return ctx.models.some(
    (record) =>
      record.removed !== true &&
      scopedTo(record, scope) &&
      sameModelCandidate(record, target) &&
      (record.coldCompact !== undefined || record.coldModels !== undefined),
  )
}

function warmingGroupSummary(
  memo: Memo,
  ctx: BuildContext,
  level: Level,
  owner: string | null,
  candidate: { providerID: string; modelID: string; variant?: string; source: Level | "upstream"; from: From },
  teamRef?: RowTeam,
  catalogue?: Catalogue,
): string {
  const target = targetOf(candidate)
  const rowScope = { level, agent: owner, ...teamFields(teamRef), ...(catalogue === undefined ? {} : { catalogue }) }
  const fields = resolveModelFields({ models: ctx.models, scopes: ctx.scopes, ...rowScope }, target)
  const host = hostModelOf(ctx.hostModels, { providerID: candidate.providerID, modelID: candidate.modelID })
  const modelSetting = settingsFor(ctx.modelSettings, target)
  const view = modelDefaultViewOf(target, modelSetting, everySettings(ctx.modelSettings), host?.warming, host?.variants)
  const warming = fields.warming ?? (view.on.value ? { value: formatDuration(view.duration.value), level: view.duration.from as Level } : { value: "off", level: view.on.from as Level })
  const interval = fields.interval ?? { value: formatDuration(view.interval.value), level: view.interval.from as Level }
  return warming.value === "off" ? "off" : `${warming.value} · every ${interval.value}`
}

function compactionGroupSummary(
  memo: Memo,
  ctx: BuildContext,
  level: Level,
  owner: string | null,
  candidate: { providerID: string; modelID: string; variant?: string; source: Level | "upstream"; from: From },
  teamRef?: RowTeam,
  catalogue?: Catalogue,
): string {
  const compaction = effectiveCompactionFor(memo, ctx, level, owner, candidate, teamRef, catalogue)
  return compactionStrategyWord(compaction.strategy.value)
}

function compactionStrategyWord(strategy: string): string {
  return strategy[0].toUpperCase() + strategy.slice(1)
}

// The source word a compaction field shows: the level's own name, else the
// agent-wide / every-agent / defaults words.
function compactionSource(from: CompactionFrom): string {
  if (from === "agent") return "agent-wide"
  if (from === "agents") return "every agent"
  return defaultsSource(from)
}

// One field row under an agent/member/preset model row. The effective value
// and, when inherited, its source; editing writes only this field at this
// level, resetting clears it so the level below (or Defaults › Models) decides.
function lazyModelField(
  memo: Memo,
  ctx: BuildContext,
  level: Level,
  owner: string | null,
  candidate: { providerID: string; modelID: string; variant?: string; source: Level | "upstream"; from: From },
  field: ModelFieldName,
  depth: number,
  teamRef?: RowTeam,
  catalogue?: Catalogue,
  ownerPath?: string,
): Lazy {
  const target = { providerID: candidate.providerID, modelID: candidate.modelID, ...(candidate.variant === undefined ? {} : { variant: candidate.variant }) }
  const itemId = modelFieldItemId(target, field)
  const address = addressOf(level, owner, itemId, null, teamRef, catalogue)
  const rowScope = { level, agent: owner, ...teamFields(teamRef), ...(catalogue === undefined ? {} : { catalogue }) }
  const info = (): ModelFieldInfo => {
    const host = hostModelOf(ctx.hostModels, { providerID: candidate.providerID, modelID: candidate.modelID })
    const modelSetting = settingsFor(ctx.modelSettings, { providerID: candidate.providerID, modelID: candidate.modelID })
    const view = modelDefaultViewOf(target, modelSetting, everySettings(ctx.modelSettings), host?.warming, host?.variants)
    const fields = resolveModelFields({ models: ctx.models, scopes: ctx.scopes, ...rowScope }, target)
    const local = ctx.models.find(
      (record) => record.removed !== true && scopedTo(record, rowScope) && sameModelCandidate(record, target),
    )
    if (field === "model") {
      // The row always names its candidate; the source is the level that
      // supplied it, so an inherited row says where the model comes from.
      if (local?.originalCandidate !== undefined) {
        const orig = local.originalCandidate
        const modelEdited = orig.editedFields !== undefined
          ? orig.editedFields.includes("model")
          : (local.providerID !== orig.providerID || local.modelID !== orig.modelID)
        const source = orig.source ?? (candidate.source !== level ? candidate.source : "upstream")
        return {
          value: modelEdited ? modelLabel(candidate) : `${modelLabel(candidate)} · ${levelWord(source)}`,
          own: modelEdited,
        }
      }
      const inherited = candidate.source !== level
      return { value: inherited ? `${modelLabel(candidate)} · ${levelWord(candidate.source)}` : modelLabel(candidate), own: !inherited }
    }
    if (field === "effort") {
      // An explicit variant belongs to the candidate, so it is inherited when
      // the candidate is: the Effort field names the same source as Model.
      if (local?.originalCandidate !== undefined) {
        const orig = local.originalCandidate
        const effortEdited = orig.editedFields !== undefined
          ? orig.editedFields.includes("effort")
          : ((local.variant ?? undefined) !== (orig.variant ?? undefined))
        const source = orig.source ?? (candidate.source !== level ? candidate.source : "upstream")
        if (effortEdited) {
          return { value: target.variant ?? "none", own: true }
        }
        if (target.variant !== undefined) {
          return { value: `${target.variant} · ${levelWord(source)}`, own: false }
        }
        const inherited = defaultEffort({ ...(modelSetting === undefined ? {} : { model: modelSetting }), ...(everySettings(ctx.modelSettings) === undefined ? {} : { every: everySettings(ctx.modelSettings) }), ...(host?.variants === undefined ? {} : { variants: host.variants }) })
        return inherited === undefined ? { value: "none", own: false } : { value: `${inherited.value} · ${defaultsSource(inherited.from)}`, own: false }
      }
      if (target.variant !== undefined) {
        const inherited = candidate.source !== level
        return { value: inherited ? `${target.variant} · ${levelWord(candidate.source)}` : target.variant, own: !inherited }
      }
      const inherited = defaultEffort({ ...(modelSetting === undefined ? {} : { model: modelSetting }), ...(everySettings(ctx.modelSettings) === undefined ? {} : { every: everySettings(ctx.modelSettings) }), ...(host?.variants === undefined ? {} : { variants: host.variants }) })
      return inherited === undefined ? { value: "none", own: false } : { value: `${inherited.value} · ${defaultsSource(inherited.from)}`, own: false }
    }
    if (field === "compactWarm") {
      const compaction = effectiveCompactionFor(memo, ctx, level, owner, candidate, teamRef, catalogue)
      const compactWarm = compaction.compactWarm
      const own = ownCompactionField(ctx, level, owner, candidate, teamRef, catalogue, "compactWarm")
      return { value: own ? (compactWarm.value ? "on" : "off") : `${compactWarm.value ? "on" : "off"} · ${compactionSource(compactWarm.from)}`, own }
    }
    if (field === "imageConvert" || field === "imageShrink" || field === "imagesFull") {
      const image = effectiveImagesFor(ctx, level, owner, candidate, teamRef, catalogue)[field]
      const own = ownCompactionField(ctx, level, owner, candidate, teamRef, catalogue, field)
      const text = imageWord(field, image.value)
      return { value: own ? text : `${text} · ${compactionSource(image.from)}`, own }
    }
    if (field === "compactionInput" || field === "compactionOutput") {
      const threshold = effectiveCompactionFor(memo, ctx, level, owner, candidate, teamRef, catalogue)[field]
      const own = ownCompactionField(ctx, level, owner, candidate, teamRef, catalogue, field)
      const text = threshold.value ? `${threshold.value} tokens` : "off"
      return { value: own ? text : `${text} · ${compactionSource(threshold.from)}`, own }
    }
    if (field === "compactionStrategy") {
      const compaction = effectiveCompactionFor(memo, ctx, level, owner, candidate, teamRef, catalogue)
      const strategy = compaction.strategy
      const own = ownCompactionField(ctx, level, owner, candidate, teamRef, catalogue, "compactionStrategy")
      const text = compactionStrategyWord(strategy.value)
      return { value: own ? text : `${text} · ${compactionSource(strategy.from)}`, own }
    }
    if (field === "compactionModel") {
      const compaction = effectiveCompactionFor(memo, ctx, level, owner, candidate, teamRef, catalogue)
      const model = compaction.model
      const own = ownCompactionField(ctx, level, owner, candidate, teamRef, catalogue, "compactionModel")
      const text = model.value ?? "Inherited model"
      return { value: own ? text : `${text} · ${compactionSource(model.from)}`, own }
    }
    if (field === "compactionInstructions") {
      const compaction = effectiveCompactionFor(memo, ctx, level, owner, candidate, teamRef, catalogue)
      const instructions = compaction.instructions
      const own = ownCompactionField(ctx, level, owner, candidate, teamRef, catalogue, "compactionInstructions")
      const text = instructions.value === undefined ? "Empty prompt" : instructions.value.length > 24 ? `${instructions.value.slice(0, 23)}…` : instructions.value
      return { value: own ? text : `${text} · ${compactionSource(instructions.from)}`, own }
    }
    // Warming / Ping every / Warm while waiting / Keep-alive prompt: the effective value wherever
    // the agent's chain sets it, not only at this row's level. An inherited
    // value names its own level; the Defaults › Models fallback names the
    // settings surface it came from.
    const resolved = fields[field as "warming" | "interval" | "waiting" | "prompt"]
    if (resolved !== undefined) {
      const own = resolved.level === level
      return { value: own ? resolved.value : `${resolved.value} · ${levelWord(resolved.level)}`, own }
    }
    const effective = modelSettingEffective(view, field as "warming" | "interval" | "waiting" | "prompt")
    if (effective === undefined) return { value: "none", own: false }
    return { value: `${effective.text} · ${defaultsSource(effective.from)}`, own: false }
  }
  const current = info()
  const switchField = field === "compactWarm"
  return {
    id: rowIdOf("item", level, owner, itemId, catalogue, ownerPath),
    kind: "item",
    label: MODEL_FIELD_LABELS[field],
    depth,
    address,
    actions: { toggle: switchField, edit: !switchField, reset: current.own, remove: false, split: false, pin: false },
    selfReview: () => false,
    partial: () => ({ value: info().value, ...(info().own ? { modified: true as const } : {}) }),
    reviewCount: () => 0,
    children: () => [],
  }
}

// Whether this level's own model row sets one compaction field for the target.
function ownCompactionField(
  ctx: BuildContext,
  level: Level,
  owner: string | null,
  candidate: { providerID: string; modelID: string; variant?: string },
  teamRef: RowTeam | undefined,
  catalogue: Catalogue | undefined,
  field: "compactWarm" | "compactionStrategy" | "compactionModel" | "compactionInstructions" | "compactionInput" | "compactionOutput" | ImageField,
): boolean {
  const target = targetOf(candidate)
  const scope = { level, agent: owner, ...teamFields(teamRef), ...(catalogue === undefined ? {} : { catalogue }) }
  return ctx.models.some(
    (record) => record.removed !== true && scopedTo(record, scope) && sameModelCandidate(record, target) && record[field] !== undefined,
  )
}

// Where an inherited Defaults › Models value came from, in the words the
// field rows use. Levels keep their own name; the rest name the settings
// surface (mirroring model-settings.ts sourceWord).
function defaultsSource(from: "model" | "every" | "config" | "host" | "built-in" | "chat" | Level): string {
  if (from === "model") return "defaults"
  if (from === "every") return "every model"
  if (from === "config") return "opencode.json"
  if (from === "host") return "host"
  if (from === "built-in") return "built-in"
  if (from === "chat") return "chat"
  return from
}

function modelLabel(candidate: { providerID: string; modelID: string; variant?: string }): string {
  if (candidate.variant === undefined) return `${candidate.providerID}/${candidate.modelID}`
  return `${candidate.providerID}/${candidate.modelID}@${candidate.variant}`
}

function lazyTools(
  ctx: BuildContext,
  memo: Memo,
  level: Level,
  owner: string | null,
  agent: AgentSource | null,
  depth: number,
  groupId?: string,
  teamRef?: RowTeam,
  catalogue?: Catalogue,
  ownerPath?: string,
): Lazy {
  const prefix = groupId ?? `group:${level}:${ownerSegment(owner, catalogue)}:tools`
  return branch(memo, {
    kind: "group",
    id: prefix,
    label: "Tools",
    depth,
    actions: noActions(),
    children: () => {
      const tools = sortedKind(ctx, "tool", owner).filter((item) => visibleInCatalogue(item, catalogue))
      return [
        toolOriginGroup(ctx, memo, level, owner, agent, `${prefix}:native`, "OpenCode", depth + 1, tools.filter((item) => item.group === "native"), teamRef, catalogue, ownerPath),
        toolOriginGroup(ctx, memo, level, owner, agent, `${prefix}:plus`, "OpenCodePlus", depth + 1, tools.filter((item) => item.group === "plus"), teamRef, catalogue, ownerPath),
        mcpToolsGroup(ctx, memo, level, owner, agent, `${prefix}:mcp`, depth + 1, tools.filter((item) => item.group === "mcp"), teamRef, catalogue, ownerPath),
        ...strayTools(ctx, memo, level, owner, agent, tools, depth + 1, teamRef, catalogue, ownerPath),
        ...policyGroup(ctx, memo, level, owner, `${prefix}:policy`, depth + 1, tools, teamRef, catalogue, ownerPath),
      ]
    },
  })
}

// Team tools live in the Teams catalogue only. A stand-alone agent never
// calls them (apply denies the whole namespace for every non-member), so
// listing them under Agents would advertise rows that can never resolve to a
// usable tool.
function visibleInCatalogue(item: Item, catalogue?: Catalogue): boolean {
  if (catalogueOf(catalogue) === "teams") return true
  return !(item.namespace === teamNamespace || item.id.startsWith(`tool:${teamNamespace}_`))
}

const teamNamespace = "team"

// A member's rule rows list under the tool they govern (Permissions → Team
// role). The rows whose tool is not in this owner's inventory (a tool the host
// never registered here) hang in one "Other permissions" group so they stay
// reachable; the group is omitted when every row found its tool.
function policyGroup(
  ctx: BuildContext,
  memo: Memo,
  level: Level,
  owner: string | null,
  id: string,
  depth: number,
  tools: readonly Item[],
  teamRef?: RowTeam,
  catalogue?: Catalogue,
  ownerPath?: string,
): Lazy[] {
  if (owner === null) return []
  const present = new Set(tools.map((item) => item.id.slice("tool:".length)))
  const rows = policyRowsFor(ctx, owner, level).filter((item) => !present.has(hostOf(item.permTool ?? "")))
  if (rows.length === 0) return []
  return [
    branch(memo, {
      kind: "group",
      id,
      label: "Other permissions",
      depth,
      actions: noActions(),
      children: () => rows.map((item) => lazyPermRow(memo, level, owner, item, depth + 1, teamRef, catalogue, ownerPath)),
    }),
  ]
}

function policyRowsFor(ctx: BuildContext, owner: string, level: Level): Item[] {
  return ctx.items
    .filter((item) => item.kind === "perm" && item.policy !== undefined && applies(item, owner) && listedAt(level, item))
    .toSorted(byOrderTitle)
}

// A live run's edit scope belongs to the running agent; a preset of the same
// id is not that agent and never lists it.
function listedAt(level: Level, item: Item): boolean {
  return level !== "preset" || item.runID === undefined
}

function lazySkills(
  ctx: BuildContext,
  memo: Memo,
  level: Level,
  owner: string | null,
  agent: AgentSource | null,
  depth: number,
  groupId?: string,
  teamRef?: RowTeam,
  catalogue?: Catalogue,
  ownerPath?: string,
): Lazy {
  const prefix = groupId ?? `group:${level}:${ownerSegment(owner, catalogue)}:skills`
  return branch(memo, {
    kind: "group",
    id: prefix,
    label: "Skills",
    depth,
    // Add is offered on the Skills group itself and on each origin leaf, so a
    // user can create a skill at this node's scope wherever they invoke it.
    add: "skill",
    actions: noActions(),
    children: () => {
      const skills = sortedKind(ctx, "skill", owner)
      return [
        leafGroup(ctx, memo, level, owner, agent, `${prefix}:native`, "OpenCode", depth + 1, skills.filter((item) => item.group === "native"), "skill", teamRef, catalogue, ownerPath),
        leafGroup(ctx, memo, level, owner, agent, `${prefix}:plus`, "OpenCodePlus", depth + 1, skills.filter((item) => item.group === "plus"), "skill", teamRef, catalogue, ownerPath),
        leafGroup(ctx, memo, level, owner, agent, `${prefix}:global`, "Global", depth + 1, skills.filter((item) => item.group === "global"), "skill", teamRef, catalogue, ownerPath),
        leafGroup(ctx, memo, level, owner, agent, `${prefix}:defaults`, "Defaults", depth + 1, skills.filter((item) => item.group === "defaults"), "skill", teamRef, catalogue, ownerPath),
        leafGroup(ctx, memo, level, owner, agent, `${prefix}:preset`, "Preset", depth + 1, skills.filter((item) => item.group === "preset"), "skill", teamRef, catalogue, ownerPath),
        mcpGroup(ctx, memo, level, owner, agent, `${prefix}:mcp`, depth + 1, skills.filter((item) => item.group === "mcp"), teamRef, catalogue, ownerPath),
        leafGroup(
          ctx,
          memo,
          level,
          owner,
          agent,
          `${prefix}:project`,
          "Project",
          depth + 1,
          skills.filter((item) => item.group === "project"),
          "skill",
          teamRef,
          catalogue,
          ownerPath,
        ),
        ...straySkills(ctx, memo, level, owner, agent, skills, depth + 1, teamRef, catalogue, ownerPath),
      ]
    },
  })
}

// Tools or skills whose group belongs to no subgroup still need a row, so
// they hang directly off the category group rather than being dropped.
function strayTools(
  ctx: BuildContext,
  memo: Memo,
  level: Level,
  owner: string | null,
  agent: AgentSource | null,
  tools: readonly Item[],
  depth: number,
  teamRef?: RowTeam,
  catalogue?: Catalogue,
  ownerPath?: string,
): Lazy[] {
  return tools
    .filter((item) => item.group !== "native" && item.group !== "plus" && item.group !== "mcp")
    .map((item) => lazyItem(ctx, memo, level, owner, agent, item, depth, teamRef, catalogue, ownerPath))
}

function straySkills(
  ctx: BuildContext,
  memo: Memo,
  level: Level,
  owner: string | null,
  agent: AgentSource | null,
  skills: readonly Item[],
  depth: number,
  teamRef?: RowTeam,
  catalogue?: Catalogue,
  ownerPath?: string,
): Lazy[] {
  return skills
    .filter(
      (item) =>
        item.group !== "native" &&
        item.group !== "plus" &&
        item.group !== "mcp" &&
        item.group !== "project" &&
        item.group !== "global" &&
        item.group !== "defaults" &&
        item.group !== "preset",
    )
    .map((item) => lazyItem(ctx, memo, level, owner, agent, item, depth, teamRef, catalogue, ownerPath))
}

// The Base group is the first slot together with Role/persona: an enabled,
// non-empty Role/persona replaces the base prompt in the request, so the group says so,
// and the base prompt matching the model ("active") then reads "not sent" too.
function lazyBase(
  ctx: BuildContext,
  memo: Memo,
  level: Level,
  owner: string | null,
  agent: AgentSource | null,
  depth: number,
  groupId: string,
  teamRef: RowTeam | undefined,
  catalogue: Catalogue | undefined,
  ownerPath: string | undefined,
  replaced: () => boolean,
): Lazy {
  return branch(memo, {
    kind: "group",
    id: groupId,
    label: "Base",
    depth,
    add: "base",
    actions: noActions(),
    partial: () => (replaced() ? { slotNote: "not sent: replaced by Role/persona" } : {}),
    children: () =>
      sortedKind(ctx, "base", owner).map((item) => {
        const row = lazyItem(ctx, memo, level, owner, agent, item, depth + 1, teamRef, catalogue, ownerPath)
        return { ...row, partial: () => {
          const badges = row.partial()
          return badges.active === true && replaced() ? { ...badges, slotNote: "not sent" } : badges
        } }
      }),
  })
}

// System lists every part of the owner's system prompt in the order the model
// receives it (system-order.ts), headed by the tool definitions, which the
// model receives before it and which never move: Role/persona and the Base
// group (one slot: the base prompt is sent only while Role/persona is empty), OpenCode's
// own parts (movable, not editable), OpenCodePlus, Tools and rules and the
// user's System rows. Moving a row stores the order, which reorders the
// request; it has no folders.
function lazySystem(
  ctx: BuildContext,
  memo: Memo,
  level: Level,
  owner: string | null,
  agent: AgentSource | null,
  depth: number,
  groupId?: string,
  teamRef?: RowTeam,
  catalogue?: Catalogue,
  ownerPath?: string,
): Lazy {
  const id = groupId ?? `group:${level}:${ownerSegment(owner, catalogue)}:system`
  return branch(memo, {
    kind: "group", id, label: "System", depth, add: "system", actions: noActions(),
    children: () => {
      const systems = sortedKind(ctx, "system", owner)
      const role = systems.find((item) => item.id === "system:role")
      // As apply's roleCandidates: an enabled, non-empty Role/persona replaces the
      // base prompt, and an agent's own prompt body stays in its place when
      // Role/persona is off or empty (the shared row has no body of its own).
      const replaced = () => {
        if (role === undefined) return false
        if (owner !== null && role.text.trim().length > 0) return true
        const resolved = wholeOf(memo, level, owner, role, catalogue, teamRef)
        return resolved.enabled && resolved.assembled.trim().length > 0
      }
      const row = (item: Item) =>
        item.opencodePart === undefined
          ? lazyItem(ctx, memo, level, owner, agent, item, depth + 1, teamRef, catalogue, ownerPath)
          : lazyOpencodePart(level, owner, item, depth + 1, teamRef, catalogue, ownerPath)
      const rowsOf = (slot: string): Lazy[] => {
        if (slot !== firstSlot) {
          const rows = systems.filter((item) => item.id !== "system:role" && slotOfItem(item) === slot)
          if (slot === modelPromptsSlot)
            return [lazyModelPrompts(ctx, memo, level, owner, agent, depth + 1, id.replace(/:system$/, ":model-prompts"), rows, teamRef, catalogue, ownerPath)]
          const part = rows.find((item) => item.opencodePart !== undefined)
          if (part === undefined || slot !== "core/instructions") return rows.toSorted((left, right) => Number(right.opencodePart !== undefined) - Number(left.opencodePart !== undefined)).map(row)
          // Each AGENTS.md file opens under OpenCode's "AGENTS.md files" row.
          const files = rows.filter((item) => item !== part).map((item) => lazyItem(ctx, memo, level, owner, agent, item, depth + 2, teamRef, catalogue, ownerPath))
          return [lazyOpencodePart(level, owner, part, depth + 1, teamRef, catalogue, ownerPath, files)]
        }
        const head = role === undefined ? undefined : row(role)
        return [
          ...(head === undefined ? [] : [{ ...head, partial: () => (replaced() ? head.partial() : { ...head.partial(), slotNote: "base prompt sent instead" }) }]),
          lazyBase(ctx, memo, level, owner, agent, depth + 1, id.replace(/:system$/, ":base"), teamRef, catalogue, ownerPath, replaced),
        ]
      }
      const tools = systems.find((item) => item.id === toolsItemId)
      return [
        ...(tools === undefined ? [] : [row(tools)]),
        ...systemOrderAt(memo, addressOf(level, owner, "system:role", null, teamRef, catalogue)).flatMap(rowsOf),
      ]
    },
  })
}

// The model prompts: one slot, right after the base prompt unless moved. Each
// is sent only to a request whose model one of its patterns names, so each row
// says which models it is for and whether this owner's model is one of them
// (the owner's active model; the Defaults rows have none to check).
function lazyModelPrompts(
  ctx: BuildContext,
  memo: Memo,
  level: Level,
  owner: string | null,
  agent: AgentSource | null,
  depth: number,
  groupId: string,
  prompts: readonly Item[],
  teamRef: RowTeam | undefined,
  catalogue: Catalogue | undefined,
  ownerPath: string | undefined,
): Lazy {
  const model = () => {
    if (owner === null) return undefined
    const active = cachedModelsState(memo, `${groupId}#model`, () => lazyModelsState(ctx, level, owner, agent, teamRef, catalogue)).active
    if (active === undefined) return undefined
    const name = hostModelOf(ctx.hostModels, { providerID: active.providerID, modelID: active.modelID })?.name
    return { providerID: active.providerID, id: active.modelID, ...(name === undefined ? {} : { name }) }
  }
  return branch(memo, {
    kind: "group",
    id: groupId,
    label: "Model prompts",
    depth,
    add: "modelprompt",
    expandable: prompts.length > 0,
    actions: noActions(),
    partial: () => (prompts.length === 0 ? { slotNote: "none yet · a adds one" } : {}),
    children: () =>
      prompts.map((item) => {
        const row = lazyItem(ctx, memo, level, owner, agent, item, depth + 1, teamRef, catalogue, ownerPath)
        return { ...row, add: "modelprompt" as const, partial: () => {
          const models = item.models ?? []
          const target = model()
          if (models.length === 0) return { ...row.partial(), models, slotNote: "names no model: never sent" }
          if (target === undefined) return { ...row.partial(), models }
          const shown = target.name ?? target.id
          return { ...row.partial(), models, slotNote: matchesModel(models, target) ? `sent with ${shown}` : `not sent: model is ${shown}` }
        } }
      }),
  })
}

// One of OpenCode's own parts: it moves with the System order, but OpenCode
// builds its content per request, so nothing here edits, toggles or splits it.
// The AGENTS.md part opens into its files, which are rows of their own.
function lazyOpencodePart(
  level: Level,
  owner: string | null,
  item: Item,
  depth: number,
  teamRef?: RowTeam,
  catalogue?: Catalogue,
  ownerPath?: string,
  files: readonly Lazy[] = [],
): Lazy {
  return {
    id: rowIdOf("item", level, owner, item.id, catalogue, ownerPath),
    kind: "item",
    label: item.title,
    depth,
    expandable: files.length > 0,
    address: addressOf(level, owner, item.id, null, teamRef, catalogue),
    actions: noActions(),
    selfReview: () => false,
    partial: () => (item.id === toolsItemId ? { fromLabel: "OpenCode", slotNote: "first, before the system prompt" } : { fromLabel: "OpenCode" }),
    reviewCount: () => files.reduce((total, file) => total + file.reviewCount(), 0),
    children: () => files,
  }
}

/** The owner's complete System order: the first one stored down its chain, else the request's default order. */
export function systemOrderAt(memo: Memo, address: Address): string[] {
  const stored = storedSystemOrder(memo.ctx.orders, resolutionChain(address, memo.ctx.scopes))
  return completeOrder(stored ?? [], defaultSystemOrder(userSystemRows(memo.ctx.items)))
}

/** The slot a System list row stands for: Role/persona and the Base group share the first one. */
export function systemSlotOf(memo: Memo, row: Pick<Lazy, "id" | "kind" | "address">): string | undefined {
  if (row.kind === "group") return row.id.endsWith(":base") ? firstSlot : row.id.endsWith(":model-prompts") ? modelPromptsSlot : undefined
  const id = row.address?.section === null ? row.address.item : undefined
  const item = id === undefined ? undefined : memo.ctx.items.find((entry) => entry.id === id)
  return item === undefined ? undefined : slotOfItem(item)
}

function leafGroup(
  ctx: BuildContext,
  memo: Memo,
  level: Level,
  owner: string | null,
  agent: AgentSource | null,
  id: string,
  label: string,
  depth: number,
  items: readonly Item[],
  add?: AddKind,
  teamRef?: RowTeam,
  catalogue?: Catalogue,
  ownerPath?: string,
): Lazy {
  return branch(memo, {
    kind: "group",
    id,
    label,
    depth,
    ...(add === undefined ? {} : { add }),
    actions: noActions(),
    children: () =>
      items.map((item) => lazyItem(ctx, memo, level, owner, agent, item, depth + 1, teamRef, catalogue, ownerPath)),
  })
}

function mcpGroup(
  ctx: BuildContext,
  memo: Memo,
  level: Level,
  owner: string | null,
  agent: AgentSource | null,
  id: string,
  depth: number,
  items: readonly Item[],
  teamRef?: RowTeam,
  catalogue?: Catalogue,
  ownerPath?: string,
): Lazy {
  return branch(memo, {
    kind: "group",
    id,
    label: "MCP",
    depth,
    actions: noActions(),
    children: () => {
      const servers = [...new Set(items.map((item) => item.server ?? "unknown"))].sort()
      return servers.map((server) =>
        leafGroup(
          ctx,
          memo,
          level,
          owner,
          agent,
          `${id}:${server}`,
          server,
          depth + 1,
          items.filter((item) => (item.server ?? "unknown") === server),
          undefined,
          teamRef,
          catalogue,
          ownerPath,
        ),
      )
    },
  })
}

// OpenCode/OpenCodePlus tool origin group: plain tools hang directly off the
// group exactly as before, while Code Mode tools move under a `Code Mode`
// child group (absent when there are no Code Mode rows) because a plugin can
// rewrite the catalog per agent and deny a single tool by id.
function toolOriginGroup(
  ctx: BuildContext,
  memo: Memo,
  level: Level,
  owner: string | null,
  agent: AgentSource | null,
  id: string,
  label: string,
  depth: number,
  items: readonly Item[],
  teamRef?: RowTeam,
  catalogue?: Catalogue,
  ownerPath?: string,
): Lazy {
  return branch(memo, {
    kind: "group",
    id,
    label,
    depth,
    actions: noActions(),
    children: () => {
      const exposed = exposedTools(memo, items, level, owner, catalogue, teamRef)
      const code = exposed.filter((item) => item.codemode === true)
      const rows = exposed
        .filter((item) => item.codemode !== true)
        .map((item) => lazyItem(ctx, memo, level, owner, agent, item, depth + 1, teamRef, catalogue, ownerPath))
      if (code.length === 0) return rows
      return [
        ...rows,
        codemodeGroup(ctx, memo, level, owner, agent, `${id}:codemode`, depth + 1, code, true, teamRef, catalogue, ownerPath),
      ]
    },
  })
}

// MCP tool inventory: one group per server like mcpGroup, but each server
// splits its Code Mode tools under its own `Code Mode` child. The namespace
// level is skipped because every tool of one server already shares one
// namespace.
function mcpToolsGroup(
  ctx: BuildContext,
  memo: Memo,
  level: Level,
  owner: string | null,
  agent: AgentSource | null,
  id: string,
  depth: number,
  items: readonly Item[],
  teamRef?: RowTeam,
  catalogue?: Catalogue,
  ownerPath?: string,
): Lazy {
  return branch(memo, {
    kind: "group",
    id,
    label: "MCP",
    depth,
    actions: noActions(),
    children: () => {
      const servers = [...new Set(items.map((item) => item.server ?? "unknown"))].sort()
      return servers.map((server) =>
        toolServerGroup(
          ctx,
          memo,
          level,
          owner,
          agent,
          `${id}:${server}`,
          server,
          depth + 1,
          items.filter((item) => (item.server ?? "unknown") === server),
          teamRef,
          catalogue,
          ownerPath,
        ),
      )
    },
  })
}

function toolServerGroup(
  ctx: BuildContext,
  memo: Memo,
  level: Level,
  owner: string | null,
  agent: AgentSource | null,
  id: string,
  label: string,
  depth: number,
  items: readonly Item[],
  teamRef?: RowTeam,
  catalogue?: Catalogue,
  ownerPath?: string,
): Lazy {
  return branch(memo, {
    kind: "group",
    id,
    label,
    depth,
    actions: noActions(),
    children: () => {
      const exposed = exposedTools(memo, items, level, owner, catalogue, teamRef)
      const code = exposed.filter((item) => item.codemode === true)
      const rows = exposed
        .filter((item) => item.codemode !== true)
        .map((item) => lazyItem(ctx, memo, level, owner, agent, item, depth + 1, teamRef, catalogue, ownerPath))
      if (code.length === 0) return rows
      return [
        ...rows,
        codemodeGroup(ctx, memo, level, owner, agent, `${id}:codemode`, depth + 1, code, false, teamRef, catalogue, ownerPath),
      ]
    },
  })
}

// Code Mode tools group labelled `Code Mode`. Under the OpenCode and
// OpenCodePlus origins it holds one group per tool namespace (sorted like the
// server groups), with namespace-less tools hanging directly off it; for MCP
// servers the rows hang directly off it. Empty groups are never emitted: the
// caller skips the group when there are no rows, and every namespace here
// comes from a row so it is non-empty by construction.
//
// Dotted namespaces nest under their first segment: `browser` plus
// `browser.*` become one `Browser` group holding the bare namespace's tools
// as `Pages` and one group per sub-namespace (`CPU`, `Files`, …). A first
// segment with no dotted namespace keeps today's single flat group, id and
// label unchanged, so `image`, `opencode`, `instructions`, `monitor`,
// `release`, `team` and `search` look exactly as today.
function exposedTools(memo: Memo, items: readonly Item[], level: Level, owner: string | null, catalogue?: Catalogue, teamRef?: RowTeam): readonly Item[] {
  return items.map((item) => {
    if (item.execute === true) return item
    const exposure = memo.ctx.items.find((entry) => entry.id === `toolmode:${item.id.slice("tool:".length)}`)
    if (exposure === undefined) return item
    return { ...item, codemode: wholeOf(memo, level, owner, exposure, catalogue, teamRef).assembled === "codemode" }
  })
}

function codemodeGroup(
  ctx: BuildContext,
  memo: Memo,
  level: Level,
  owner: string | null,
  agent: AgentSource | null,
  id: string,
  depth: number,
  items: readonly Item[],
  namespaced: boolean,
  teamRef?: RowTeam,
  catalogue?: Catalogue,
  ownerPath?: string,
): Lazy {
  return branch(memo, {
    kind: "group",
    id,
    label: "Code Mode",
    depth,
    actions: noActions(),
    children: () => {
      if (!namespaced)
        return items.map((item) => lazyItem(ctx, memo, level, owner, agent, item, depth + 1, teamRef, catalogue, ownerPath))
      const direct = items
        .filter((item) => item.namespace === undefined)
        .map((item) => lazyItem(ctx, memo, level, owner, agent, item, depth + 1, teamRef, catalogue, ownerPath))
      return [...direct, ...namespaceGroups(ctx, memo, level, owner, agent, id, depth + 1, items, teamRef, catalogue, ownerPath)]
    },
  })
}

// One Code Mode namespace group per first segment, sorted like the server
// groups. A segment with no dotted namespace stays a single flat group
// (`${id}:${namespace}`, label unchanged); otherwise the segment becomes a
// parent (`${id}:${segment}`, capitalized) whose first child is the bare
// namespace's tools (`Pages` for browser, `General` elsewhere) followed by
// one group per sub-namespace labelled by its last segment (`cpu` reads
// `CPU`). A sub-namespace id spells the full namespace with dots as colons,
// so `browser.cpu` reads `${id}:browser:cpu`.
function namespaceGroups(
  ctx: BuildContext,
  memo: Memo,
  level: Level,
  owner: string | null,
  agent: AgentSource | null,
  id: string,
  depth: number,
  items: readonly Item[],
  teamRef?: RowTeam,
  catalogue?: Catalogue,
  ownerPath?: string,
): Lazy[] {
  const namespaces = [...new Set(items.map((item) => item.namespace))].filter((ns): ns is string => ns !== undefined).sort()
  const firsts = [...new Set(namespaces.map((namespace) => namespace.split(".")[0]!))].sort()
  return firsts.map((first) => {
    const dotted = namespaces.filter((namespace) => namespace.startsWith(`${first}.`))
    if (dotted.length === 0) {
      const namespace = namespaces.find((candidate) => candidate === first)!
      return branch(memo, {
        kind: "group",
        id: `${id}:${namespace}`,
        label: namespace,
        depth,
        actions: noActions(),
        children: () =>
          items
            .filter((item) => item.namespace === namespace)
            .map((item) => lazyItem(ctx, memo, level, owner, agent, item, depth + 1, teamRef, catalogue, ownerPath)),
      })
    }
    const bare = namespaces.includes(first)
      ? [
          branch(memo, {
            kind: "group",
            id: `${id}:${first}:${first === "browser" ? "pages" : "general"}`,
            label: first === "browser" ? "Pages" : "General",
            depth: depth + 1,
            actions: noActions(),
            children: () =>
              items
                .filter((item) => item.namespace === first)
                .map((item) => lazyItem(ctx, memo, level, owner, agent, item, depth + 2, teamRef, catalogue, ownerPath)),
          }),
        ]
      : []
    return branch(memo, {
      kind: "group",
      id: `${id}:${first}`,
      label: capitalizeSegment(first),
      depth,
      actions: noActions(),
      children: () => [
        ...bare,
        ...dotted.map((namespace) =>
          branch(memo, {
            kind: "group",
            id: `${id}:${namespace.replaceAll(".", ":").toLowerCase()}`,
            label: capitalizeSegment(namespace.split(".").at(-1)!),
            depth: depth + 1,
            actions: noActions(),
            children: () =>
              items
                .filter((item) => item.namespace === namespace)
                .map((item) => lazyItem(ctx, memo, level, owner, agent, item, depth + 2, teamRef, catalogue, ownerPath)),
          }),
        ),
      ],
    })
  })
}

function capitalizeSegment(segment: string): string {
  if (segment.toLowerCase() === "cpu") return "CPU"
  return segment.charAt(0).toUpperCase() + segment.slice(1)
}

function lazyItem(
  ctx: BuildContext,
  memo: Memo,
  level: Level,
  owner: string | null,
  agent: AgentSource | null,
  item: Item,
  depth: number,
  teamRef?: RowTeam,
  catalogue?: Catalogue,
  ownerPath?: string,
): Lazy {
  const address = addressOf(level, owner, item.id, null, teamRef, catalogue)
  // Code Mode tool rows are first-class: a plugin can rewrite the catalog per
  // agent and deny a single tool by id, so their toggle/edit/split/pin apply
  // like any other tool. The synthetic `execute` row is host-owned: it
  // toggles, but its text is not editable and it carries no other affordance.
  // Whole Role/persona and whole base rows cannot be excluded either: apply
  // keeps the original text live, so toggling would report "Disabled" for a
  // no-op. Their text edits and section toggles still apply, so only the
  // whole-row toggle is gated.
  const codemode = item.kind === "tool" && item.codemode === true
  const executable = item.execute === true
  const wholeNoToggle = item.id === "system:role" || item.kind === "base"
  const splittable =
    !executable && (item.kind === "tool" || item.kind === "system" || item.kind === "skill" || item.kind === "base")
  const perm = item.kind === "perm"
  const hostRules = canHostPermRules(item)
  const rowId = rowIdOf("item", level, owner, item.id, catalogue, ownerPath)
  const kids = (): readonly Lazy[] => {
    if (perm) return []
    const tool = item.kind === "tool"
    if (executable) return [
      ...toolParameters(ctx, memo, level, owner, item, rowId, depth + 1, teamRef, catalogue, ownerPath),
      ...toolPermissions(ctx, memo, level, owner, item, depth + 1, teamRef, catalogue, ownerPath),
    ]
    // A tool's text is one of several things under it (mode, parameters, permissions), so it gets a Description row
    // of its own. Every other row is only text: the row itself is the whole text and opens straight into its sections.
    const sections = cachedKids(memo, rowId, () => {
      const split = splitOf(memo, level, owner, item, catalogue, teamRef)
      if (tool) return [descriptionRow(memo, level, owner, item, rowId, split, depth + 1, teamRef, catalogue, ownerPath)]
      return split.kind === "whole" ? [] : sectionKids(ctx, memo, level, owner, item, split, depth + 1, teamRef, catalogue, ownerPath)
    })
    if (!tool) return sections
    return [
      ...sections,
      ...ctx.items.filter((entry) => entry.id === `toolmode:${item.id.slice("tool:".length)}`)
        .map((entry) => lazyControl(memo, level, owner, entry, depth + 1, teamRef, catalogue, ownerPath)),
      ...toolParameters(ctx, memo, level, owner, item, rowId, depth + 1, teamRef, catalogue, ownerPath),
      ...toolPermissions(ctx, memo, level, owner, item, depth + 1, teamRef, catalogue, ownerPath),
    ]
  }
  if (perm) {
    return {
      id: rowId,
      kind: "item",
      label: item.title,
      depth,
      address,
      actions: {
        toggle: true,
        edit: true,
        reset: canReset(ctx.customizations, address),
        remove: item.custom === true,
        split: false,
        pin: false,
      },
      selfReview: () => false,
      partial: () => permBadges(memo, level, owner, item, teamRef, catalogue),
      reviewCount: () => 0,
      children: kids,
    }
  }
  return {
    id: rowId,
    kind: "item",
    label: item.id === "system:role" ? "Role/persona" : item.title,
    depth,
    address,
    // A tool row that can host rules offers both sections and rules through
    // `a`, so it carries no direct add: dialogs present the Section /
    // Permission rule choice. Every other splittable row keeps add:"section".
    ...(splittable && !hostRules ? { add: "section" as const } : {}),
    actions: {
      toggle: executable || codemode || !wholeNoToggle,
      edit: !executable,
      reset: !executable && canReset(ctx.customizations, address),
      remove: teamFields(teamRef).team !== undefined ? false : removable(level, owner, item),
      split: splittable,
      pin: codemode && !executable,
      // An instruction file or Tools and rules can be sent only when rows are
      // on; Role/persona is always sent (its sections take conditions).
      ...(item.kind === "system" && item.id !== "system:role" ? { requires: true } : {}),
    },
    selfReview: () => cachedSelfReview(memo, rowId, () => flagOf(memo, level, owner, item, null, catalogue, teamRef)),
    partial: () => itemBadges(memo, level, owner, agent, item, wholeNoToggle, teamRef, catalogue),
    enabled: () => enabledOf(memo, level, owner, item, catalogue, teamRef),
    reviewCount: () => cachedReviewCount(memo, rowId, () => itemRollup(memo, level, owner, item, catalogue, teamRef)),
    children: kids,
  }
}

// Whether a tool row can host permission rules: native/plus, non-Code-Mode,
// non-execute, with a tool: id. Eligibility is structural (not row count) so
// an empty rule set still offers the `a` choice.
function canHostPermRules(item: Item): boolean {
  if (item.kind !== "tool") return false
  if (item.group !== "native" && item.group !== "plus") return false
  if (item.codemode === true || item.execute === true) return false
  const toolId = item.id.startsWith("tool:") ? item.id.slice("tool:".length) : undefined
  if (toolId === undefined || toolId.length === 0) return false
  return true
}

interface ListedRow {
  readonly item: Item
  /** The tool this row is listed under when that is not its own (a shared row's alias). */
  readonly alias?: string
}

// Every permission row listed under one tool for this owner: its own rows,
// the member's role rows it hosts (external directories under read), and the
// rows it shares with another tool (edit's Protected files under write and
// patch), in category order, "Everything else" first in each.
export function toolPermissionRows(
  ctx: BuildContext,
  owner: string | null,
  toolId: string,
  level?: Level,
  team?: RowTeam,
  catalogue?: Catalogue,
): { category: string; rows: ListedRow[] }[] {
  const listed = permIndex(ctx).get(toolId) ?? []
  const rows = listed.flatMap((row) => {
    const item = ruleItem(row.item, ctx.rules, ctx.scopes, addressOf(level ?? "project", owner, row.item.id, null, team, catalogue))
    return item === undefined ? [] : [{ ...row, item }]
  }).filter(
    (row) =>
      (owner === null ? row.item.agents === undefined : applies(row.item, owner)) &&
      (level === undefined || listedAt(level, row.item)),
  )
  const byCategory = new Map<string, ListedRow[]>()
  for (const row of rows) {
    const category = categoryOfRow(row.item, row.item.ruleId !== undefined && curatedRuleMessage(row.item.permTool ?? "", row.item.ruleId) !== undefined)
    byCategory.set(category, [...(byCategory.get(category) ?? []), row])
  }
  const order = categoryOrder(toolId)
  const rank = (category: string) => {
    const index = order.indexOf(category)
    return index === -1 ? order.length : index
  }
  return [...byCategory.entries()]
    .toSorted(([left], [right]) => rank(left) - rank(right) || (left < right ? -1 : left > right ? 1 : 0))
    .map(([category, entries]) => ({
      category,
      rows: entries.toSorted((left, right) => Number(right.item.fallback === true) - Number(left.item.fallback === true) || byOrderTitle(left.item, right.item)),
    }))
}

// The same rows as flat lazy rows, the shape the query engine enumerates: a
// tool row's permission rows share its owner path and never need the
// structural Permissions and category groups.
export function toolPermRows(
  ctx: BuildContext,
  memo: Memo,
  level: Level,
  owner: string | null,
  item: Item,
  depth: number,
  teamRef?: RowTeam,
  catalogue?: Catalogue,
  ownerPath?: string,
): Lazy[] {
  if (item.kind !== "tool") return []
  return toolPermissionRows(ctx, owner, item.id.slice("tool:".length), level, teamRef, catalogue).flatMap((entry) =>
    entry.rows.map((row) => lazyPermRow(memo, level, owner, row.item, depth, teamRef, catalogue, ownerPath, row.alias)),
  )
}

const permIndexCache = new WeakMap<readonly Item[], Map<string, ListedRow[]>>()

// Perm rows by the tool they list under, built once per item list.
function permIndex(ctx: BuildContext): Map<string, ListedRow[]> {
  const cached = permIndexCache.get(ctx.items)
  if (cached !== undefined) return cached
  const index = new Map<string, ListedRow[]>()
  const add = (tool: string, row: ListedRow) => index.set(tool, [...(index.get(tool) ?? []), row])
  for (const item of ctx.items) {
    if (item.kind !== "perm" || item.permTool === undefined) continue
    add(hostOf(item.permTool), { item })
    for (const other of item.alsoUnder ?? []) add(other, { item, alias: other })
  }
  permIndexCache.set(ctx.items, index)
  return index
}

// Permission rows sit directly beneath the argument they constrain.
export function toolPermissions(
  ctx: BuildContext,
  memo: Memo,
  level: Level,
  owner: string | null,
  item: Item,
  depth: number,
  teamRef?: RowTeam,
  catalogue?: Catalogue,
  ownerPath?: string,
  parameter?: string,
): Lazy[] {
  const toolId = item.id.slice("tool:".length)
  const categories = toolPermissionRows(ctx, owner, toolId, level, teamRef, catalogue)
  const params = paramIndex(ctx).get(toolId) ?? []
  // Which skills an agent may load is set in its Skills tab only, not here.
  return categories.flatMap((entry) => entry.rows
    .filter((row) => permissionParameter(row.item, toolId, params) === parameter)
    .map((row) => lazyPermRow(memo, level, owner, row.item, depth, teamRef, catalogue, ownerPath, row.alias)))
}

function permissionParameter(item: Item, tool: string, params: readonly Item[]): string | undefined {
  if (params.length === 0) return undefined
  if (item.permissionParameter !== undefined) return item.permissionParameter
  const field = item.field?.split(/[.\[]/)[0]
  if (field !== undefined && params.some((param) => param.title === field)) return field
  const resource: Record<string, string> = {
    read: "path", edit: "path", write: "path", patch: "patchText", shell: "command",
    glob: "pattern", grep: "pattern", webfetch: "url", websearch: "query", skill: "name", subagent: "agent",
    team_delegate: "role", team_followup: "run", team_integrate: "run", team_finish: "status",
    team_checkpoint: "files", team_set_checks: "checks", team_stop: "run", team_status: "run",
    team_diff: "run", team_list: "all", team_check: "id",
    instructions_find: "where", instructions_read: "id", instructions_log: "where",
  }
  const name = item.ruleId === "limits.attachment" && tool === "team_delegate" ? "briefFile"
    : resource[tool]
  if (name !== undefined && params.some((param) => param.title === name)) return name
  if (params.length === 1) return params[0]?.title
  return undefined
}

const paramIndexCache = new WeakMap<readonly Item[], Map<string, Item[]>>()

// Parameter rows by the tool they belong to, built once per item list.
function paramIndex(ctx: BuildContext): Map<string, Item[]> {
  const cached = paramIndexCache.get(ctx.items)
  if (cached !== undefined) return cached
  const index = new Map<string, Item[]>()
  for (const item of ctx.items) {
    if (item.kind !== "param" || item.paramTool === undefined) continue
    index.set(item.paramTool, [...(index.get(item.paramTool) ?? []), item])
  }
  paramIndexCache.set(ctx.items, index)
  return index
}

// A tool's direct parameter rows, in schema
// order. Its text is the parameter's description; an optional one switches
// off (the model no longer sees it), a required one cannot.
export function toolParameters(
  ctx: BuildContext,
  memo: Memo,
  level: Level,
  owner: string | null,
  item: Item,
  rowId: string,
  depth: number,
  teamRef?: RowTeam,
  catalogue?: Catalogue,
  ownerPath?: string,
): Lazy[] {
  const params = paramIndex(ctx).get(item.id.slice("tool:".length)) ?? []
  return params.map((param) => lazyParamRow(memo, level, owner, param, depth, teamRef, catalogue, ownerPath, () =>
    toolPermissions(ctx, memo, level, owner, item, depth + 1, teamRef, catalogue, ownerPath, param.title)))
}

function lazyParamRow(
  memo: Memo,
  level: Level,
  owner: string | null,
  item: Item,
  depth: number,
  teamRef?: RowTeam,
  catalogue?: Catalogue,
  ownerPath?: string,
  permissions: () => readonly Lazy[] = () => [],
): Lazy {
  const address = addressOf(level, owner, item.id, null, teamRef, catalogue)
  const id = rowIdOf("item", level, owner, item.id, catalogue, ownerPath)
  const editable = item.paramTool !== "execute"
  return {
    id,
    kind: "item",
    label: `${item.title}: ${item.paramType ?? "any"}${item.required === true ? " (required)" : ""}`,
    depth,
    address,
    // The host-owned execute schema cannot be rewritten by the plugin.
    // A parameter's text is its description, so it takes sections like any
    // other text row (heading-derived, or a manual split and `a` on sections).
    ...(editable ? { add: "section" as const } : {}),
    actions: {
      toggle: item.required !== true,
      edit: editable,
      reset: editable && canReset(memo.ctx.customizations, address),
      remove: false,
      split: editable,
      pin: false,
    },
    selfReview: () => cachedSelfReview(memo, id, () => flagOf(memo, level, owner, item, null, catalogue, teamRef)),
    partial: () => permBadges(memo, level, owner, item, teamRef, catalogue),
    reviewCount: () => 0,
    children: () => [
      ...(editable ? [descriptionRow(memo, level, owner, item, id, splitOf(memo, level, owner, item, catalogue, teamRef), depth + 1, teamRef, catalogue, ownerPath)] : []),
      ...permissions(),
    ],
  }
}

function lazyPermRow(
  memo: Memo,
  level: Level,
  owner: string | null,
  item: Item,
  depth: number,
  teamRef?: RowTeam,
  catalogue?: Catalogue,
  ownerPath?: string,
  alias?: string,
): Lazy {
  const address = addressOf(level, owner, item.id, null, teamRef, catalogue)
  // A shared row listed under another tool keeps its own address (one
  // permission, one record) and gets a distinct row id there.
  const id = `${rowIdOf("item", level, owner, item.id, catalogue, ownerPath)}${alias === undefined ? "" : `@${alias}`}`
  return {
    id,
    kind: "item",
    label: item.title,
    depth,
    address,
    actions: {
      toggle: true,
      edit: true,
      reset: canReset(memo.ctx.customizations, address),
      remove: ownRule(memo.ctx.rules, address) !== undefined,
      split: false,
      pin: false,
    },
    selfReview: () => false,
    partial: () => permBadges(memo, level, owner, item, teamRef, catalogue),
    reviewCount: () => 0,
    children: () => [],
  }
}

function permBadges(
  memo: Memo,
  level: Level,
  owner: string | null,
  item: Item,
  teamRef?: RowTeam,
  catalogue?: Catalogue,
): TreeNodeBadges {
  const resolved = wholeOf(memo, level, owner, item, catalogue, teamRef)
  const guidance = guidanceFor(memo, level, owner, item.id, teamRef, catalogue)
  return {
    ...(guidance.length === 0 ? {} : { guidance }),
    state: resolved.enabled ? "on" : "off",
    modified: resolved.modified,
    source: resolved.source,
    ...fromBadges(memo.ctx, resolved, level, ownPreset(memo.ctx, level, owner, teamRef)),
  }
}

// Where the row's state (and, when different, its text) came from, and what
// of its own override is to review (DESIGN §2, §3.6).
function fromBadges(
  ctx: BuildContext,
  resolved: Pick<Resolved, "from" | "textFrom" | "reviewOf">,
  level: Level,
  own: OwnPreset | undefined,
): Pick<TreeNodeBadges, "from" | "textFrom" | "fromLabel" | "reviewOf"> {
  return {
    from: resolved.from,
    ...(sameFrom(resolved.from, resolved.textFrom) ? {} : { textFrom: resolved.textFrom }),
    fromLabel: fromLabel(resolved.from, { labels: ctx.labels, level, ...(own === undefined ? {} : { own }) }),
    ...(resolved.reviewOf.length === 0 ? {} : { reviewOf: resolved.reviewOf }),
  }
}

type OwnPreset = { readonly ref: PresetRef; readonly origin: PresetOrigin }

// The preset a row sits inside, when it is a preset subtree: its own content
// reads "set here"/the baseline it ships, never "from preset <itself>"
// (from-label.ts `own`). Member rows carry their team preset; every other
// level has no own preset.
function ownPreset(ctx: BuildContext, level: Level, owner: string | null, team?: RowTeam): OwnPreset | undefined {
  return presetOfAddress(ctx.listing, {
    level,
    agent: owner,
    team: team === undefined || "memberOf" in team ? undefined : team,
  })
}

// The `own` option for a fromLabel call, ready to spread.
function ownOption(ctx: BuildContext, level: Level, owner: string | null, team?: RowTeam): { readonly own?: OwnPreset } {
  const own = ownPreset(ctx, level, owner, team)
  return own === undefined ? {} : { own }
}

function sameFrom(left: From, right: From): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function itemBadges(
  memo: Memo,
  level: Level,
  owner: string | null,
  agent: AgentSource | null,
  item: Item,
  wholeNoToggle = false,
  teamRef?: RowTeam,
  catalogue?: Catalogue,
): TreeNodeBadges {
  const resolved = wholeOf(memo, level, owner, item, catalogue, teamRef)
  const active = agent?.base !== undefined && item.id === `base:${agent.base}`
  // A builtin-id shadow CAN be the host active answer (the classifier answers
  // host ids like `gpt`, and the shadow carries that id), so marking it
  // inactive would lie. Only non-builtin user ids — which the host never
  // reports as active — read inactive. Creation refuses builtin ids outright;
  // shadows reaching here predate that refusal and stay deletable cleanup.
  const shadowedBuiltin = item.kind === "base" && item.userBase === true && builtinBaseIds().has(baseIdOf(item.id))
  const codemodeTool = item.kind === "tool" && item.codemode === true
  const guidance = item.kind === "tool" || item.kind === "skill" || item.kind === "mcp" ? guidanceFor(memo, level, owner, item.id, teamRef, catalogue) : []
  const condition: Pick<TreeNodeBadges, "requires"> =
    item.kind === "system" && resolved.requires !== undefined ? conditionBadges(memo, level, owner, resolved.requires, teamRef, catalogue) : {}
  return {
    ...(guidance.length === 0 ? {} : { guidance }),
    ...condition,
    ...(resolved.enabled && unmet(condition.requires) ? { heldBack: true } : {}),
    state: resolved.enabled ? "on" : "off",
    modified: resolved.modified,
    source: resolved.source,
    ...fromBadges(memo.ctx, resolved, level, ownPreset(memo.ctx, level, owner, teamRef)),
    ...(active ? { active: true } : {}),
    // A user template id can never be the host active answer, so it reads as
    // applicable while never reaching system[0]. `inactive` reuses the
    // existing active/state badge slot the tree already uses for base
    // liveness: it is the negation of active, not a new visual language.
    ...(item.kind === "base" && item.userBase === true && !shadowedBuiltin ? { inactive: true } : {}),
    // Code Mode tools apply like any other tool, so the row reads live
    // state. `pinned` mirrors the resolved pin (registry default or user
    // override) so the pin reads on the row that carries the pin action.
    ...(codemodeTool && resolved.pinned ? { pinned: true } : {}),
    // Whole Role/persona and whole base rows cannot be excluded: apply keeps
    // the original text live, so toggling would report "Disabled" for a
    // no-op. `unsupported` marks the refused toggle; `unexcludable` names the
    // reason for status/detail text.
    ...(wholeNoToggle ? { unsupported: true, unexcludable: true } : {}),
  }
}

// A text-row alias of the item's whole address, not a second stored body.
// Its distinct row id lets the tree expand Description independently of the item.
function descriptionRow(
  memo: Memo,
  level: Level,
  owner: string | null,
  item: Item,
  rowId: string,
  split: Split,
  depth: number,
  teamRef?: RowTeam,
  catalogue?: Catalogue,
  ownerPath?: string,
): Lazy {
  const address = addressOf(level, owner, item.id, null, teamRef, catalogue)
  return {
    id: `${rowId}:description`,
    kind: "section",
    label: "Description",
    depth,
    expandable: split.kind !== "whole",
    address,
    add: "section",
    actions: {
      edit: true,
      toggle: false,
      reset: canReset(memo.ctx.customizations, address),
      remove: false,
      split: true,
      pin: false,
    },
    selfReview: () => flagOf(memo, level, owner, item, null, catalogue, teamRef),
    partial: () => ({
      ...itemBadges(memo, level, owner, null, item, false, teamRef, catalogue),
      review: flagOf(memo, level, owner, item, null, catalogue, teamRef),
    }),
    reviewCount: () => 0,
    children: () => split.kind === "whole" ? [] : sectionKids(memo.ctx, memo, level, owner, item, split, depth + 1, teamRef, catalogue, ownerPath),
  }
}

// A lone wrapper heading is not an extra level: its body becomes Introduction
// and its children render at `base`. Stored section ids and addresses stay stable.
function sectionKids(
  ctx: BuildContext,
  memo: Memo,
  level: Level,
  owner: string | null,
  item: Item,
  split: Split,
  base: number,
  teamRef?: RowTeam,
  catalogue?: Catalogue,
  ownerPath?: string,
): Lazy[] {
  const wrapper = wrappingSection(split)
  if (wrapper === undefined)
    return split.sections.map((section) =>
      lazySection(ctx, memo, level, owner, item, section, base + section.depth, teamRef, catalogue, ownerPath),
    )
  const address = addressOf(level, owner, item.id, wrapper.id, teamRef, catalogue)
  const body = ownBody(wholeOf(memo, level, owner, item, catalogue, teamRef).text, split, wrapper)
  return split.sections.flatMap((section): Lazy[] => {
    if (section.id !== wrapper.id)
      return [lazySection(ctx, memo, level, owner, item, section, base + section.depth - 1, teamRef, catalogue, ownerPath)]
    // No row for a body with nothing in it, unless a stored record would be
    // stranded without one (excluding it still drops the wrapper and children).
    if (body.length === 0 && !canReset(memo.ctx.customizations, address)) return []
    return [
      lazySection(ctx, memo, level, owner, item, section, base, teamRef, catalogue, ownerPath, {
        label: "Introduction",
        introduction: true,
      }),
    ]
  })
}

function lazySection(
  ctx: BuildContext,
  memo: Memo,
  level: Level,
  owner: string | null,
  item: Item,
  section: Section,
  depth: number,
  teamRef?: RowTeam,
  catalogue?: Catalogue,
  ownerPath?: string,
  options?: { readonly label?: string; readonly introduction?: boolean },
): Lazy {
  const address = addressOf(level, owner, item.id, section.id, teamRef, catalogue)
  const id = rowIdOf("section", level, owner, item.id, catalogue, ownerPath, section.id)
  // Code Mode sections apply like any other section now that per-agent
  // catalog rewrites reach them, so they carry the normal toggle/edit/reset
  // treatment with no gate.
  return {
    id,
    kind: "section",
    label: options?.label ?? section.name,
    depth,
    ...(options?.introduction === true ? { introduction: true as const } : {}),
    address,
    add: "section",
    actions: {
      toggle: true,
      // A wrapper's own body is presentation: an edit would store its section
      // text, which replaces its children in the assembled text. The item's own
      // editor still edits the whole document.
      edit: options?.introduction !== true,
      reset: canReset(ctx.customizations, address),
      remove: false,
      split: false,
      pin: false,
      // A system section can be sent only when rows are on (its wrapper's
      // body is the whole document: condition the row itself instead).
      ...(item.kind === "system" && options?.introduction !== true ? { requires: true } : {}),
    },
    selfReview: () => cachedSelfReview(memo, id, () => flagOf(memo, level, owner, item, section.id, catalogue, teamRef)),
    partial: () => sectionBadges(memo, level, owner, item, section, teamRef, catalogue),
    reviewCount: () => 0,
    children: () => [],
  }
}

function sectionBadges(
  memo: Memo,
  level: Level,
  owner: string | null,
  item: Item,
  section: Section,
  teamRef?: RowTeam,
  catalogue?: Catalogue,
): TreeNodeBadges {
  const resolved = sectionResolveOf(memo, level, owner, item, section.id, catalogue, teamRef)
  const capability: Pick<TreeNodeBadges, "requires"> = item.kind === "system" ? capabilityBadges(memo, level, owner, item, section, resolved, teamRef, catalogue) : {}
  // Held back only where it would be sent otherwise: its row and the
  // sections around it (ids nest with "/") are on.
  const parts = section.id.split("/")
  const heldBack =
    resolved.enabled &&
    unmet(capability.requires) &&
    wholeOf(memo, level, owner, item, catalogue, teamRef).enabled &&
    parts.slice(0, -1).every((_, index) => sectionResolveOf(memo, level, owner, item, parts.slice(0, index + 1).join("/"), catalogue, teamRef).enabled)
  return {
    state: resolved.enabled ? "on" : "off",
    modified: resolved.modified,
    review: resolved.review,
    source: resolved.source,
    ...fromBadges(memo.ctx, resolved, level, ownPreset(memo.ctx, level, owner, teamRef)),
    ...capability,
    ...(heldBack ? { heldBack: true } : {}),
  }
}

function unmet(requires: TreeNodeBadges["requires"]): boolean {
  return requires?.some((requirement) => !requirement.met) === true
}

// Whether the owner has a row on, as apply decides it for that agent;
// undefined for a row it does not have. Shared rows (no owner) cannot answer.
function ownerHas(memo: Memo, level: Level, owner: string, id: string, teamRef?: RowTeam, catalogue?: Catalogue): boolean | undefined {
  const item = memo.ctx.items.find((candidate) => candidate.id === id && applies(candidate, owner))
  return item === undefined ? undefined : wholeOf(memo, level, owner, item, catalogue, teamRef).enabled
}

const namesCache = new WeakMap<Memo, ReadonlyMap<string, string>>()

// The words a text uses for each tool and skill (requires.ts `mentions`).
function namesOf(memo: Memo): ReadonlyMap<string, string> {
  const cached = namesCache.get(memo)
  if (cached !== undefined) return cached
  const names = new Map<string, string>()
  for (const candidate of memo.ctx.items) {
    if (candidate.kind === "tool" && candidate.execute !== true) names.set(candidate.id.slice("tool:".length), candidate.id)
    if (candidate.kind === "skill") names.set(candidate.id.slice("skill:".length), candidate.id)
  }
  namesCache.set(memo, names)
  return names
}

// A condition as the tree shows it for this owner: each row, and whether the
// owner meets it. A shared row (no owner) cannot answer.
function conditionBadges(
  memo: Memo,
  level: Level,
  owner: string | null,
  condition: NonNullable<Resolved["requires"]>,
  teamRef?: RowTeam,
  catalogue?: Catalogue,
): Pick<TreeNodeBadges, "requires" | "requiresFrom" | "requiresHere"> {
  return {
    requires: condition.ids.map((raw) => {
      const requirement = requirementOf(raw)
      // A shared row (no owner) has no agent to ask: shown as met.
      return { ...requirement, met: owner === null || met(requirement, (id) => ownerHas(memo, level, owner, id, teamRef, catalogue)) }
    }),
    requiresFrom:
      condition.from === "text" ? "its text" : fromLabel(condition.from, { labels: memo.ctx.labels, level, ...ownOption(memo.ctx, level, owner, teamRef) }),
    ...(condition.here ? { requiresHere: true } : {}),
  }
}

// A system section's condition (a level's record, else the line in its text)
// and the tools or skills its own body names that the owner has off with no
// condition here or above covering them.
function capabilityBadges(
  memo: Memo,
  level: Level,
  owner: string | null,
  item: Item,
  section: Section,
  resolved: Resolved,
  teamRef?: RowTeam,
  catalogue?: Catalogue,
): Pick<TreeNodeBadges, "requires" | "requiresFrom" | "requiresHere" | "mentions"> {
  const condition = resolved.requires === undefined ? {} : conditionBadges(memo, level, owner, resolved.requires, teamRef, catalogue)
  if (owner === null) return condition
  // The section and its ancestors (ids nest with "/") answer for a mention.
  const parts = section.id.split("/")
  const covered = new Set(
    parts.flatMap((_, index) => sectionResolveOf(memo, level, owner, item, parts.slice(0, index + 1).join("/"), catalogue, teamRef).requires?.ids ?? []),
  )
  const covers = (id: string) => covered.has(id) || covered.has(`!${id}`)
  // Its own body: from its heading to the next heading (a subsection answers for itself).
  const lines = resolved.text.split("\n")
  const next = lines.findIndex((line, index) => index > 0 && /^#{1,6}\s/.test(line))
  const body = (next === -1 ? lines : lines.slice(0, next)).join("\n")
  const mentioned = [...namesOf(memo)]
    .filter(([word, id]) => !covers(id) && ownerHas(memo, level, owner, id, teamRef, catalogue) !== true && mentions(body, word))
    .map(([word, id]) => ({ word, id }))
  return { ...condition, ...(mentioned.length === 0 ? {} : { mentions: mentioned }) }
}

// The Tools and rules sections whose condition names this row, as this owner
// resolves them (a level may have rewritten, added or re-conditioned sections).
function guidanceFor(memo: Memo, level: Level, owner: string | null, id: string, teamRef?: RowTeam, catalogue?: Catalogue): readonly string[] {
  const row = memo.ctx.items.find((candidate) => candidate.id === guidanceItemId && (owner === null || applies(candidate, owner)))
  if (row === undefined) return []
  return splitOf(memo, level, owner, row, catalogue, teamRef)
    .sections.filter((section) =>
      (sectionResolveOf(memo, level, owner, row, section.id, catalogue, teamRef).requires?.ids ?? []).some((raw) => requirementOf(raw).id === id),
    )
    .map((section) => section.name)
}

// User-owned rows can be deleted outright: shared MCP servers, project-group
// items (skills, the project-owned AGENTS.md instruction, added base
// prompts), user-created base templates (which carry group "none" with
// userBase, deletable through base.delete while builtins stay refused —
// builtin-id shadows pre-dating the creation refusal included, so deleting
// them restores the host template), user-created System rows, and agents. The
// agent's own Role/persona body is owned but not deletable.
function removable(level: Level, owner: string | null, item: Item): boolean {
  if (level === "defaults" && owner === null && item.kind === "mcp") return true
  if (item.id === "system:role") return false
  if (item.kind === "base" && item.userBase === true) return true
  if (item.kind === "system" && item.userSystem === true) return true
  // A skill is deletable wherever a user authored it: the project's own
  // directory or one of the global-directory scopes. Built-in and plugin
  // skills (native/plus/mcp) are not files and stay refused.
  if (item.kind === "skill") return item.skillScope !== undefined || item.group === "project"
  return item.group === "project"
}

// Built-in base ids live in agents/base.ts (the creation refusal source): a
// user template with one of these ids shadows the host template and can be
// its agent's active answer, so it must never read `inactive`.
function baseIdOf(id: string): string {
  return id.startsWith("base:") ? id.slice("base:".length) : id
}

function sortedKind(ctx: BuildContext, kind: Item["kind"], owner: string | null): Item[] {
  return ctx.items
    .filter((item) => item.kind === kind && (owner === null || applies(item, owner)))
    .sort(byOrderTitle)
}

function byOrderTitle(left: Item, right: Item): number {
  const order = (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER)
  if (order !== 0) return order
  if (left.title < right.title) return -1
  if (left.title > right.title) return 1
  return 0
}

function noActions(): TreeNodeActions {
  return { toggle: false, edit: false, reset: false, remove: false, split: false, pin: false }
}
