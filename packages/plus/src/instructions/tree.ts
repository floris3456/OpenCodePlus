import { builtinBaseIds } from "../agents/base.js"
import { booleanControl, controlIds, controlItemFor, controlItems, isControl } from "./agent-controls.js"
import {
  applies,
  canReset,
  catalogueOf,
  entrySpecificity,
  hasModelActiveAt,
  hasModelRecordAt,
  modelCandidates,
  modelItemId,
  parseModelItemId,
  presetKey,
  resolve,
  resolveActiveModel,
  resolveSplit,
  sameModelCandidate,
} from "./model.js"
import type {
  Address,
  AgentSource,
  Catalogue,
  CustomizationRecord,
  EntryRecord,
  From,
  Item,
  Level,
  ModelRecord,
  PresetOrigin,
  PresetRef,
  Resolved,
  ReviewPart,
  SplitRecord,
  TeamRef,
} from "./model.js"
import { fromLabel } from "./from-label.js"
import { linkOf, type PresetEntry } from "./presets.js"
import {
  flagOf,
  memoOf,
  contextOf,
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
import type { Section, Split } from "./sections.js"
import type { TeamLevel } from "./teams.js"
import { categoryLabel, categoryOfRow, categoryOrder, hostOf } from "./permission-catalog.js"
import { curatedRuleMessage } from "./tool-permissions.js"

export type { Memo }
export { buildMemo } from "./resolve-memo.js"

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
export type AddKind =
  | "agent"
  | "base"
  | "skill"
  | "instruction"
  | "mcp"
  | "section"
  | "team"
  | "model"
  | "rule"
  | "preset"
  | "team-preset"

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
  readonly source?: Level | "upstream"
  /** Where the on/off state (model rows: the candidate) came from. */
  readonly from?: From
  /** Where the text came from, when that differs from `from`. */
  readonly textFrom?: From
  /** `from` in words (from-label.ts): "from preset Orchestrator", "off by default", … */
  readonly fromLabel?: string
  /** User base template that can never be the host active answer. */
  readonly inactive?: boolean
  /** Registry or user pin state for Code Mode tool rows. */
  readonly pinned?: boolean
  /** Whole Role/persona or whole base row: apply keeps the original text live, so the row cannot be toggled off. */
  readonly unsupported?: boolean
  /** Whole Role/persona or whole base row: apply keeps the original text live, so the row cannot be toggled off. */
  readonly unexcludable?: boolean
}

export interface TreeNodeActions {
  readonly toggle: boolean
  readonly edit: boolean
  readonly reset: boolean
  readonly remove: boolean
  readonly split: boolean
  readonly pin: boolean
}

export interface TreeNode {
  readonly id: string
  readonly kind: TreeNodeKind
  readonly label: string
  readonly depth: number
  readonly address?: Address
  readonly add?: AddKind
  readonly owner?: RowOwner
  /** Entity rows toggle their real Enabled item, retaining their entity address. */
  readonly enabledRow?: string
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
  const ctx = contextOf(asBaseInput(input))
  const expanded = input.expanded ?? new Set<string>()
  return skeletonOf(memoOf(ctx)).flatMap((root) => emit(root, expanded))
}

export const expandedTreeCounter = { count: 0 }
export function resetExpandedTreeCounter(): void {
  expandedTreeCounter.count = 0
}

// Single-pass full expansion for filter matching: the skeleton already knows
// every id without resolving anything, so walk it directly instead of
// converging by repeated expanded builds. Output matches tree() with every id
// expanded.
export function expandedTree(input: Omit<TreeInput, "expanded">): TreeNode[] {
  expandedTreeCounter.count++
  const memo = memoOf(contextOf(asBaseInput(input)))
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
  readonly address?: Address
  readonly add?: AddKind
  readonly owner?: RowOwner
  readonly enabledRow?: string
  readonly actions: TreeNodeActions
  readonly selfReview: () => boolean
  readonly partial: () => TreeNodeBadges
  readonly reviewCount: () => number
  readonly children: () => readonly Lazy[]
}

// The same skeleton the tree walks, exposed so the query engine can filter
// rows without resolving: every field above is cheap, resolution runs only
// through materialize() for rows that survive the structural filters.
// Roots in DESIGN §2 order; Presets last.
export function skeletonOf(memo: Memo): Lazy[] {
  return [
    lazyRoot(memo.ctx, memo, "project"),
    lazyRoot(memo.ctx, memo, "global"),
    lazyRoot(memo.ctx, memo, "defaults"),
    lazyPresetRoot(memo.ctx, memo),
  ]
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
  }
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
  const roots = skeletonOf(memo)
  const found = descendLazy(roots, rowId)
  if (found !== undefined) return found
  return collectSkeleton(roots).find((node) => node.id === rowId)
}

function descendLazy(nodes: readonly Lazy[], rowId: string): Lazy | undefined {
  for (const node of nodes) {
    if (node.id === rowId) return node
    if (canDescend(node, rowId)) {
      const found = descendLazy(node.children(), rowId)
      if (found !== undefined) return found
    }
  }
  return undefined
}

function canDescend(node: Lazy, rowId: string): boolean {
  if (rowId.startsWith(node.id + ":") || rowId.startsWith(node.id + "/")) return true

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
// rolls hidden and visible descendant review into review/reviewCount.
function finalizeLazy(lazy: Lazy): TreeNode {
  if (lazy.kind === "section") return shell(lazy, lazy.partial())
  const count = lazy.reviewCount()
  const self = lazy.selfReview()
  return shell(lazy, { ...lazy.partial(), review: self || count > 0, reviewCount: count })
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
}

// `address` lets a structural row show an item's detail (a tool's
// Description group shows the tool's whole text) while its actions stay off.
function branch(memo: Memo, args: BranchArgs, address?: Address): Lazy {
  const kids = (): readonly Lazy[] => cachedKids(memo, args.id, args.children)
  return {
    id: args.id,
    kind: args.kind,
    label: args.label,
    depth: args.depth,
    ...(address === undefined ? {} : { address }),
    ...(args.add === undefined ? {} : { add: args.add }),
    ...(args.owner === undefined ? {} : { owner: args.owner }),
    actions: args.actions,
    selfReview: () => cachedSelfReview(memo, args.id, () => false),
    partial: () => ({}),
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
    children: () => [lazyAgentsGroup(ctx, memo, level), lazyTeamsGroup(ctx, memo, level)],
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
function lazyInventory(ctx: BuildContext, memo: Memo, catalogue: Catalogue, depth: number): Lazy[] {
  return [
    lazyControls(memo, "setting", "defaults", null, depth, undefined, catalogue),
    lazyModels(ctx, memo, "defaults", null, null, depth, undefined, undefined, catalogue),
    lazyControls(memo, "compaction", "defaults", null, depth, undefined, catalogue),
    lazyTools(ctx, memo, "defaults", null, null, depth, undefined, undefined, catalogue),
    lazyBase(ctx, memo, "defaults", null, null, depth, undefined, undefined, catalogue),
    lazySkills(ctx, memo, "defaults", null, null, depth, undefined, undefined, catalogue),
    lazySystem(ctx, memo, "defaults", null, null, depth, undefined, undefined, catalogue),
    lazyMcpInventory(ctx, memo, catalogue, depth),
  ]
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

export const teamsOwnerSegment = "/teams"

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
    children: () => [
      lazyControls(memo, "setting", row.level, row.id, row.depth + 1),
      lazyModels(ctx, memo, row.level, row.id, row.agent, row.depth + 1),
      lazyControls(memo, "compaction", row.level, row.id, row.depth + 1),
      lazyTools(ctx, memo, row.level, row.id, row.agent, row.depth + 1),
      lazyBase(ctx, memo, row.level, row.id, row.agent, row.depth + 1),
      lazySkills(ctx, memo, row.level, row.id, row.agent, row.depth + 1),
      lazySystem(ctx, memo, row.level, row.id, row.agent, row.depth + 1),
    ],
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
      ctx.agents.filter((agent) => agent.scope === level && agentOriginOf(agent) === "plus").map((agent) => lazyAgent(ctx, memo, level, agent, 3)),
  })
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
      ...ctx.agents.filter((agent) => agent.scope === level && agentOriginOf(agent) === "user").map((agent) => lazyAgent(ctx, memo, level, agent, 3)),
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
    children: () => [
      lazyControls(memo, "setting", level, owner, depth + 1, teamRef, "teams", memberPath),
      lazyModels(ctx, memo, level, owner, agent, depth + 1, `${memberGroup}:models`, teamRef, "teams", memberPath),
      lazyControls(memo, "compaction", level, owner, depth + 1, teamRef, "teams", memberPath),
      lazyTools(ctx, memo, level, owner, agent, depth + 1, `${memberGroup}:tools`, teamRef, "teams", memberPath),
      lazyBase(ctx, memo, level, owner, agent, depth + 1, `${memberGroup}:base`, teamRef, "teams", memberPath),
      lazySkills(ctx, memo, level, owner, agent, depth + 1, `${memberGroup}:skills`, teamRef, "teams", memberPath),
      lazySystem(ctx, memo, level, owner, agent, depth + 1, `${memberGroup}:system`, teamRef, "teams", memberPath),
    ],
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
    children: () => [
      lazyControls(memo, "setting", level, owner, 5, teamRef, "teams", specialPath),
      lazyModels(ctx, memo, level, owner, agent, 5, `${specialGroup}:models`, teamRef, "teams", specialPath),
      lazyControls(memo, "compaction", level, owner, 5, teamRef, "teams", specialPath),
      lazyTools(ctx, memo, level, owner, agent, 5, `${specialGroup}:tools`, teamRef, "teams", specialPath),
      lazyBase(ctx, memo, level, owner, agent, 5, `${specialGroup}:base`, teamRef, "teams", specialPath),
      lazySkills(ctx, memo, level, owner, agent, 5, `${specialGroup}:skills`, teamRef, "teams", specialPath),
      lazySystem(ctx, memo, level, owner, agent, 5, `${specialGroup}:system`, teamRef, "teams", specialPath),
    ],
  }), level, owner, teamRef, "teams", specialPath)
}

function lazyTeam(ctx: BuildContext, memo: Memo, level: Level, team: TeamInput): Lazy {
  // A Defaults team (an injected registry; none ships) also lists the member
  // entries whose team pattern is exactly its name.
  const entries = level === "defaults" ? membersOfPattern(ctx, team.team).filter((member) => !team.agents.includes(member)) : []
  const kids = (): readonly Lazy[] =>
    cachedKids(memo, `team:${level}:${team.team}`, () => [
      ...team.agents.map((member) => lazyTeamMember(ctx, memo, level, team, member, 3)),
      ...entries.map((member) => lazyTeamMember(ctx, memo, level, team, member, 3, true)),
      lazyTeamSpecial(ctx, memo, level, team),
    ])
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
    children: () => [...new Set(items.filter((item) => item.kind === kind).map((item) => item.id))]
      .flatMap((item) => {
        const upstream = controlItemFor(items, addressOf(level, owner, item, null, teamRef, catalogue))
        return upstream === undefined ? [] : [upstream]
      })
      .sort(byOrderTitle)
      .map((item) => lazyControl(memo, level, owner, item, depth + 1, teamRef, catalogue, ownerPath)),
  })
}

function lazyControl(
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
  return {
    id,
    kind: "item",
    label: item.title[0].toUpperCase() + item.title.slice(1),
    depth,
    address,
    get actions() {
      const available = disabled() === undefined
      return {
        ...noActions(),
        toggle: toggle && available,
        edit: !toggle && available,
        reset: available && canReset(memo.ctx.customizations, address),
      }
    },
    selfReview: () => flagOf(memo, level, owner, item, null, catalogue, teamRef),
    partial: () => {
      const resolved = wholeOf(memo, level, owner, item, catalogue, teamRef)
      const from = toggle ? resolved.from : resolved.textFrom
      const reason = disabled()
      return {
        ...(toggle ? { state: resolved.enabled ? "on" as const : "off" as const } : {}),
        value: controlValue(item.id, resolved.text, resolved.enabled),
        modified: resolved.modified,
        source: resolved.source,
        from,
        fromLabel: fromLabel(from, { labels: memo.ctx.labels, level }),
        ...(resolved.reviewOf.length === 0 ? {} : { reviewOf: resolved.reviewOf }),
        ...(reason === undefined ? {} : { disabled: reason }),
      }
    },
    reviewCount: () => 0,
    children: () => [],
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

// Models group, following Settings in each agent subtree and shared Defaults
// inventory. Rows are the union down the chain (deduplicated) plus the
// agent's upstream model, each carrying a source badge naming the level it
// came from. Toggle activates exclusively at this level, remove deletes the
// row at this level only; no edit, split, or pin. Active marks the resolved
// winner down the chain (or upstream when nothing is active).
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
  return branch(memo, {
    kind: "group",
    id: prefix,
    label: "Models",
    depth,
    add: "model",
    actions: noActions(),
    children: () =>
      cachedKids(memo, prefix, () => {
        const upstream = upstreamForModels(ctx, level, owner, agent)
        const scope = {
          models: ctx.models,
          scopes: ctx.scopes,
          level,
          agent: owner,
          ...teamFields(teamRef),
          ...(catalogue === undefined ? {} : { catalogue }),
          ...(upstream === undefined ? {} : { upstream }),
        }
        const candidates = modelCandidates(scope)
        const active = resolveActiveModel(scope)
        return candidates
          .toSorted((left, right) => {
            const leftId = modelItemId(left)
            const rightId = modelItemId(right)
            if (leftId < rightId) return -1
            if (leftId > rightId) return 1
            return 0
          })
          .map((candidate) => lazyModelItem(memo, ctx, level, owner, candidate, active, depth + 1, teamRef, catalogue, ownerPath))
      }) as readonly Lazy[],
  })
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
  active: { providerID: string; modelID: string; variant?: string; review?: true } | undefined,
  depth: number,
  teamRef?: RowTeam,
  catalogue?: Catalogue,
  ownerPath?: string,
): Lazy {
  const itemId = modelItemId(candidate)
  const address = addressOf(level, owner, itemId, null, teamRef, catalogue)
  const target = { providerID: candidate.providerID, modelID: candidate.modelID, ...(candidate.variant === undefined ? {} : { variant: candidate.variant }) }
  const isActive = active !== undefined && sameModelCandidate(target, active)
  // The row's own node: a member row's is per-agent (teamFields → memberOf).
  const own = teamFields(teamRef).team
  const scope = { level, agent: owner, ...(own !== undefined ? { team: own } : {}), ...(catalogue === undefined ? {} : { catalogue }) }
  const hasLocal = hasModelRecordAt(ctx.models, scope, target)
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
      remove: hasLocal,
      split: false,
      pin: false,
    },
    // §3.6: the row's own active model, recorded against an active model
    // above that has since changed.
    selfReview: () => isActive && active?.review === true,
    partial: () => ({
      ...(isActive ? { active: true as const } : {}),
      source: candidate.source,
      from: candidate.from,
      fromLabel: fromLabel(candidate.from, { labels: ctx.labels, level }),
    }),
    reviewCount: () => 0,
    children: () => [],
  }
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
    actions: noActions(),
    children: () => {
      const skills = sortedKind(ctx, "skill", owner)
      return [
        leafGroup(ctx, memo, level, owner, agent, `${prefix}:native`, "OpenCode", depth + 1, skills.filter((item) => item.group === "native"), undefined, teamRef, catalogue, ownerPath),
        leafGroup(ctx, memo, level, owner, agent, `${prefix}:plus`, "OpenCodePlus", depth + 1, skills.filter((item) => item.group === "plus"), undefined, teamRef, catalogue, ownerPath),
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
    .filter((item) => item.group !== "native" && item.group !== "plus" && item.group !== "mcp" && item.group !== "project")
    .map((item) => lazyItem(ctx, memo, level, owner, agent, item, depth, teamRef, catalogue, ownerPath))
}

function lazyBase(
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
  return branch(memo, {
    kind: "group",
    id: groupId ?? `group:${level}:${ownerSegment(owner, catalogue)}:base`,
    label: "Base",
    depth,
    add: "base",
    actions: noActions(),
    children: () =>
      sortedKind(ctx, "base", owner).map((item) =>
        lazyItem(ctx, memo, level, owner, agent, item, depth + 1, teamRef, catalogue, ownerPath),
      ),
  })
}

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
  return branch(memo, {
    kind: "group",
    id: groupId ?? `group:${level}:${ownerSegment(owner, catalogue)}:system`,
    label: "System",
    depth,
    add: "instruction",
    actions: noActions(),
    children: () => {
      const systems = sortedKind(ctx, "system", owner)
      const role = systems.find((item) => item.id === "system:role")
      const head =
        role === undefined ? [] : [lazyItem(ctx, memo, level, owner, agent, role, depth + 1, teamRef, catalogue, ownerPath)]
      return [
        ...head,
        ...systems
          .filter((item) => item.id !== "system:role")
          .map((item) => lazyItem(ctx, memo, level, owner, agent, item, depth + 1, teamRef, catalogue, ownerPath)),
      ]
    },
  })
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
      const code = items.filter((item) => item.codemode === true)
      const rows = items
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
      const code = items.filter((item) => item.codemode === true)
      const rows = items
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
      const namespaces = [...new Set(items.map((item) => item.namespace))].filter((ns): ns is string => ns !== undefined).sort()
      return [
        ...direct,
        ...namespaces.map((namespace) =>
          branch(memo, {
            kind: "group",
            id: `${id}:${namespace}`,
            label: namespace,
            depth: depth + 1,
            actions: noActions(),
            children: () =>
              items
                .filter((item) => item.namespace === namespace)
                .map((item) => lazyItem(ctx, memo, level, owner, agent, item, depth + 2, teamRef, catalogue, ownerPath)),
          }),
        ),
      ]
    },
  })
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
    if (executable) return toolPermissions(ctx, memo, level, owner, item, rowId, depth + 1, teamRef, catalogue, ownerPath)
    const sections = cachedKids(memo, rowId, () => {
      const split = splitOf(memo, level, owner, item, catalogue, teamRef)
      // A tool's text is its Description: one section is the Description row
      // itself, several hang under a Description group whose detail shows
      // them combined. Other items keep their sections as direct children.
      if (tool && split.sections.length === 1) {
        const only = split.sections[0]
        return only === undefined ? [] : [lazySection(ctx, memo, level, owner, item, only, depth + 1, teamRef, catalogue, ownerPath, "Description")]
      }
      if (tool && split.sections.length > 1)
        return [
          branch(memo, {
            kind: "group",
            id: `${rowId.replace(/^item:/, "group:")}:description`,
            label: "Description",
            depth: depth + 1,
            actions: noActions(),
            children: () =>
              split.sections.map((section) =>
                lazySection(ctx, memo, level, owner, item, section, depth + 2 + section.depth, teamRef, catalogue, ownerPath),
              ),
          }, address),
        ]
      return split.sections.map((section) =>
        lazySection(ctx, memo, level, owner, item, section, depth + 1 + section.depth, teamRef, catalogue, ownerPath),
      )
    })
    if (!tool) return sections
    return [...sections, ...toolPermissions(ctx, memo, level, owner, item, rowId, depth + 1, teamRef, catalogue, ownerPath)]
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
    },
    selfReview: () => cachedSelfReview(memo, rowId, () => flagOf(memo, level, owner, item, null, catalogue, teamRef)),
    partial: () => itemBadges(memo, level, owner, agent, item, wholeNoToggle, teamRef, catalogue),
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
): { category: string; rows: ListedRow[] }[] {
  const listed = permIndex(ctx).get(toolId) ?? []
  const rows = listed.filter(
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
  return toolPermissionRows(ctx, owner, item.id.slice("tool:".length), level).flatMap((entry) =>
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

// A tool's Permissions group: one group per category, each holding its rows.
// Omitted when the tool lists no row for this owner. Structural only: building
// it resolves nothing, so the query engine walks it without paying for a
// split.
export function toolPermissions(
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
  const toolId = item.id.slice("tool:".length)
  const categories = toolPermissionRows(ctx, owner, toolId, level)
  if (categories.length === 0) return []
  const prefix = `${rowId.replace(/^item:/, "group:")}:permissions`
  return [
    branch(memo, {
      kind: "group",
      id: prefix,
      label: "Permissions",
      depth,
      actions: noActions(),
      children: () =>
        categories.map((entry) =>
          branch(memo, {
            kind: "group",
            id: `${prefix}:${entry.category}`,
            label: categoryLabel(toolId, entry.category),
            depth: depth + 1,
            actions: noActions(),
            children: () =>
              entry.rows.map((row) => lazyPermRow(memo, level, owner, row.item, depth + 2, teamRef, catalogue, ownerPath, row.alias)),
          }),
        ),
    }),
  ]
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
      remove: item.custom === true,
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
  return { state: resolved.enabled ? "on" : "off", modified: resolved.modified, source: resolved.source, ...fromBadges(memo.ctx, resolved, level) }
}

// Where the row's state (and, when different, its text) came from, and what
// of its own override is to review (DESIGN §2, §3.6).
function fromBadges(
  ctx: BuildContext,
  resolved: Pick<Resolved, "from" | "textFrom" | "reviewOf">,
  level: Level,
): Pick<TreeNodeBadges, "from" | "textFrom" | "fromLabel" | "reviewOf"> {
  return {
    from: resolved.from,
    ...(sameFrom(resolved.from, resolved.textFrom) ? {} : { textFrom: resolved.textFrom }),
    fromLabel: fromLabel(resolved.from, { labels: ctx.labels, level }),
    ...(resolved.reviewOf.length === 0 ? {} : { reviewOf: resolved.reviewOf }),
  }
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
  return {
    state: resolved.enabled ? "on" : "off",
    modified: resolved.modified,
    source: resolved.source,
    ...fromBadges(memo.ctx, resolved, level),
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
  label?: string,
): Lazy {
  const address = addressOf(level, owner, item.id, section.id, teamRef, catalogue)
  const id = rowIdOf("section", level, owner, item.id, catalogue, ownerPath, section.id)
  // Code Mode sections apply like any other section now that per-agent
  // catalog rewrites reach them, so they carry the normal toggle/edit/reset
  // treatment with no gate.
  return {
    id,
    kind: "section",
    label: label ?? section.name,
    depth,
    address,
    actions: {
      toggle: true,
      edit: true,
      reset: canReset(ctx.customizations, address),
      remove: false,
      split: false,
      pin: false,
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
  return {
    state: resolved.enabled ? "on" : "off",
    modified: resolved.modified,
    review: resolved.review,
    source: resolved.source,
    ...fromBadges(memo.ctx, resolved, level),
  }
}

// User-owned rows can be deleted outright: shared MCP servers, project-group
// items (skills, the project-owned AGENTS.md instruction, added base
// prompts), user-created base templates (which carry group "none" with
// userBase, deletable through base.delete while builtins stay refused —
// builtin-id shadows pre-dating the creation refusal included, so deleting
// them restores the host template), and agents. The
// agent's own Role/persona body is owned but not deletable.
function removable(level: Level, owner: string | null, item: Item): boolean {
  if (level === "defaults" && owner === null && item.kind === "mcp") return true
  if (item.id === "system:role") return false
  if (item.kind === "base" && item.userBase === true) return true
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
