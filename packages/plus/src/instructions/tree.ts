import { builtinBaseIds } from "../agents/base.js"
import {
  applies,
  canReset,
  hasModelActiveAt,
  hasModelRecordAt,
  modelCandidates,
  modelItemId,
  parseModelItemId,
  resolveActiveModel,
  sameModelCandidate,
} from "./model.js"
import type { Address, AgentSource, CustomizationRecord, Item, Level, ModelRecord, SplitRecord } from "./model.js"
import {
  flagOf,
  memoOf,
  contextOf,
  splitOf,
  textEntryOf,
  wholeOf,
  sectionResolveOf,
  type BuildContext,
  type Memo,
} from "./resolve-memo.js"
import type { MemoInput as BaseMemoInput } from "./resolve-memo.js"
import type { Section, Split } from "./sections.js"

export type { Memo }
export { buildMemo } from "./resolve-memo.js"

// Teams at all three tiers, including built-in defaults teams with no
// filesystem path. This widens the shared memo input with the same `Level`
// the tree uses so Defaults rows render.
export interface TeamInput {
  readonly level: Level
  readonly team: string
  readonly enabled: boolean
  readonly agents: readonly string[]
  readonly overlay?: readonly string[]
}

export interface MemoInput extends Omit<BaseMemoInput, "teams"> {
  readonly teams?: readonly TeamInput[]
}

export type TreeNodeKind = "root" | "group" | "agent" | "team" | "item" | "section"
export type AddKind = "agent" | "base" | "skill" | "instruction" | "mcp" | "section" | "team" | "model" | "rule"

export interface TreeNodeBadges {
  readonly state?: "on" | "off"
  readonly modified?: boolean
  readonly review?: boolean
  readonly reviewCount?: number
  readonly active?: boolean
  readonly source?: Level | "upstream"
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
  const memo = memoOf(ctx)
  const roots = [lazyRoot(ctx, memo, "project"), lazyRoot(ctx, memo, "global"), lazyRoot(ctx, memo, "defaults")]
  return roots.flatMap((root) => emit(root, expanded))
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
  readonly actions: TreeNodeActions
  readonly selfReview: () => boolean
  readonly partial: () => TreeNodeBadges
  readonly reviewCount: () => number
  readonly children: () => readonly Lazy[]
}

// The same skeleton the tree walks, exposed so the query engine can filter
// rows without resolving: every field above is cheap, resolution runs only
// through materialize() for rows that survive the structural filters.
export function skeletonOf(memo: Memo): Lazy[] {
  return [lazyRoot(memo.ctx, memo, "project"), lazyRoot(memo.ctx, memo, "global"), lazyRoot(memo.ctx, memo, "defaults")]
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
    const nodeLevel = node.id.split(":")[1]
    if (nodeLevel !== rowLevel) return false

    // Teams group under root: group:<level>:teams
    if (node.id === `group:${nodeLevel}:teams`) {
      if (rowKind === "team") return true
      if (rowId.startsWith(`group:${nodeLevel}:teams`)) return true
      if (rowId.includes("/:")) return true
      if (rowKind === "item" || rowKind === "section") return true
      return false
    }

    // Agents group under root: group:<level>:agents
    if (node.id === `group:${nodeLevel}:agents`) {
      if (rowKind === "agent") return true
      if (rowId.startsWith(`group:${nodeLevel}:agents`)) return true
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

    // Shared defaults category groups (group:defaults::<category>)
    if (node.id.startsWith("group:defaults::")) {
      if (rowKind === "item" || rowKind === "section") {
        const owner = parts[2]
        return owner === ""
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
    const agentParts = node.id.split(":")
    const agentLevel = agentParts[1]
    const agentId = node.label
    if (agentLevel !== rowLevel) return false
    if (rowKind === "group" && rowId.startsWith(`group:${agentLevel}:${agentId}:`)) return true
    if ((rowKind === "item" || rowKind === "section") && parts[2] === agentId) return true
    return false
  }

  if (node.kind === "team") {
    const teamParts = node.id.split(":")
    const teamLevel = teamParts[1]
    if (teamLevel !== rowLevel) return false
    if (node.depth === 2) {
      if (rowId.startsWith(`${node.id}:`)) return true
      if (rowId.startsWith(`group:${teamLevel}:${node.label}/:`)) return true
      if (rowKind === "item" || rowKind === "section") return true
      return false
    }
    if (node.depth >= 3) {
      const member = node.label
      if (rowKind === "group" && rowId.includes(`/:${member}:`)) return true
      if ((rowKind === "item" || rowKind === "section") && parts[2] === member) return true
      return false
    }
    return false
  }

  if (node.kind === "item") {
    if (node.address === undefined) return false
    const itemLevel = parts[1]
    const itemOwner = parts[2]
    if (itemLevel !== node.address.level || itemOwner !== (node.address.agent ?? "")) return false
    if (rowKind === "section") {
      const sectionItemId = parts.slice(3, -1).join(":")
      return sectionItemId === node.address.item
    }
    if (rowKind === "item" && node.address.item.startsWith("tool:")) {
      const toolName = node.address.item.slice("tool:".length)
      const ruleItemId = parts.slice(3).join(":")
      if (ruleItemId.startsWith(`perm:${toolName}:`)) return true
    }
    return false
  }

  return false
}

// Section ids come from the split, so an item with no section customizations
// contributes zero without resolving anything; only items that actually have
// section overrides pay for one whole resolve plus one split. Flagged
// sections roll up into ancestor counts like any other row so saved content
// needing attention stays discoverable from collapsed ancestors.
function itemRollup(memo: Memo, level: Level, owner: string | null, item: Item): number {
  if (item.execute === true) return 0
  const entry = textEntryOf(memo, level, owner, item.id)
  if (entry === undefined) return 0
  if (entry.sections.size === 0) return 0
  return splitOf(memo, level, owner, item).sections.filter(
    (section) => entry.sections.has(section.id) && flagOf(memo, level, owner, item, section.id),
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
  readonly actions: TreeNodeActions
  readonly children: () => readonly Lazy[]
}

function branch(memo: Memo, args: BranchArgs): Lazy {
  const kids = (): readonly Lazy[] => cachedKids(memo, args.id, args.children)
  return {
    id: args.id,
    kind: args.kind,
    label: args.label,
    depth: args.depth,
    ...(args.add === undefined ? {} : { add: args.add }),
    actions: args.actions,
    selfReview: () => cachedSelfReview(memo, args.id, () => false),
    partial: () => ({}),
    reviewCount: () => cachedReviewCount(memo, args.id, () => rollup(kids())),
    children: kids,
  }
}

function lazyRoot(ctx: BuildContext, memo: Memo, level: Level): Lazy {
  if (level === "defaults")
    return branch(memo, {
      kind: "root",
      id: "root:defaults",
      label: "Defaults",
      depth: 0,
      actions: noActions(),
      children: () => [lazyAgentsGroup(ctx, memo, "defaults"), ...lazyTeamsGroup(ctx, memo, "defaults"), ...lazySharedGroups(ctx, memo)],
    })
  return branch(memo, {
    kind: "root",
    id: `root:${level}`,
    label: level === "project" ? "Project" : "Global",
    depth: 0,
    actions: noActions(),
    children: () => [lazyAgentsGroup(ctx, memo, level), ...lazyTeamsGroup(ctx, memo, level)],
  })
}

declare module "./model.js" {
  interface AgentSource {
    readonly ancestor?: boolean
  }
}

function lazyAgent(ctx: BuildContext, memo: Memo, level: Level, agent: AgentSource, depth: number): Lazy {
  return branch(memo, {
    kind: "agent",
    id: `agent:${level}:${agent.id}`,
    label: agent.id,
    depth,
    // Deletion eligibility mirrors removalPlan in ops.ts, which refuses every
    // scope except project|global. Defaults rows must not advertise `d`.
    // Built-ins and ancestor-backed agents cannot be deleted via agent.delete.
    actions: { ...noActions(), remove: level !== "defaults" && agentOriginOf(agent) === "user" && agent.ancestor !== true },
    children: () => [
      lazyModels(ctx, memo, level, agent.id, agent, depth + 1),
      lazyTools(ctx, memo, level, agent.id, agent, depth + 1),
      lazyBase(ctx, memo, level, agent.id, agent, depth + 1),
      lazySkills(ctx, memo, level, agent.id, agent, depth + 1),
      lazySystem(ctx, memo, level, agent.id, agent, depth + 1),
    ],
  })
}

function lazyAgentsGroup(ctx: BuildContext, memo: Memo, level: Level): Lazy {
  return branch(memo, {
    kind: "group",
    id: `group:${level}:agents`,
    label: "Agents",
    depth: 1,
    add: "agent",
    actions: noActions(),
    children: () => [lazyNativeAgents(ctx, memo, level), lazyPlusAgents(ctx, memo, level), lazyUserAgents(ctx, memo, level)],
  })
}

// Origin subgroups: server-side origin carried on AgentSource, never inferred
// here from ids or paths. Native holds native agents plus the nested Special
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
    label: "Native",
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
    children: () =>
      ctx.agents.filter((agent) => agent.scope === level && agentOriginOf(agent) === "user").map((agent) => lazyAgent(ctx, memo, level, agent, 3)),
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
// hang under each team row with the same five groups an Agents-group agent
// renders (Models, Tools, Base, Skills, System): the member rows themselves
// carry no address and no toggle, while their descendants address the same
// records as the Agents-group rows (level + agent + item) with working
// toggle/edit/reset.
function lazyTeamsGroup(ctx: BuildContext, memo: Memo, level: Level): Lazy[] {
  const teams = ctx.teams
    .filter((team) => team.level === level)
    .toSorted((left, right) => (left.team < right.team ? -1 : left.team > right.team ? 1 : 0))
  return [
    branch(memo, {
      kind: "group",
      id: `group:${level}:teams`,
      label: "Teams",
      depth: 1,
      add: "team",
      actions: noActions(),
      children: () => teams.map((team) => lazyTeam(ctx, memo, level, team)),
    }),
  ]
}

function lazyTeamMember(ctx: BuildContext, memo: Memo, level: Level, team: TeamInput, member: string, depth: number): Lazy {
  const agent = ctx.agents.find((entry) => entry.id === member && entry.scope === level) ?? ctx.agents.find((entry) => entry.id === member) ?? null
  const owner = member
  const removable = level !== "defaults" || (team.overlay?.includes(member) ?? false)
  // Team-member group ids use `/:` between team and member. Agent ids forbid
  // `:` (validateAgentId in agents/files.ts) while team names allow it, so an
  // owner containing `:` can only be a team member group and never collides
  // with a nested agent id like `crew/alpha` (`/` alone is legal in agent
  // ids). The `/` is kept so the existing `group:<level>:<team>/` prefix still
  // matches; the extra `:` is the disambiguator. Team names never contain
  // `/`, so the split on the first `/` stays unambiguous even for colon team
  // names and nested member ids.
  return branch(memo, {
    kind: "team",
    id: `team:${level}:${team.team}:${member}`,
    label: member,
    depth,
    add: "agent",
    actions: { ...noActions(), remove: removable },
    children: () => [
      lazyModels(ctx, memo, level, owner, agent, depth + 1, `group:${level}:${team.team}/:${member}:models`),
      lazyTools(ctx, memo, level, owner, agent, depth + 1, `group:${level}:${team.team}/:${member}:tools`),
      lazyBase(ctx, memo, level, owner, agent, depth + 1, `group:${level}:${team.team}/:${member}:base`),
      lazySkills(ctx, memo, level, owner, agent, depth + 1, `group:${level}:${team.team}/:${member}:skills`),
      lazySystem(ctx, memo, level, owner, agent, depth + 1, `group:${level}:${team.team}/:${member}:system`),
    ],
  })
}

function lazyTeam(ctx: BuildContext, memo: Memo, level: Level, team: TeamInput): Lazy {
  const kids = (): readonly Lazy[] =>
    cachedKids(memo, `team:${level}:${team.team}`, () =>
      team.agents.map((member) => lazyTeamMember(ctx, memo, level, team, member, 3)),
    )
  return {
    id: `team:${level}:${team.team}`,
    kind: "team",
    label: team.team,
    depth: 2,
    add: "agent",
    actions: { ...noActions(), toggle: true },
    selfReview: () => false,
    partial: () => ({ state: team.enabled ? ("on" as const) : ("off" as const) }),
    reviewCount: () => 0,
    children: kids,
  }
}

function lazySharedGroups(ctx: BuildContext, memo: Memo): Lazy[] {
  return [
    lazyModels(ctx, memo, "defaults", null, null, 1),
    lazyTools(ctx, memo, "defaults", null, null, 1),
    lazyBase(ctx, memo, "defaults", null, null, 1),
    lazySkills(ctx, memo, "defaults", null, null, 1),
    lazySystem(ctx, memo, "defaults", null, null, 1),
    lazyMcpInventory(ctx, memo),
  ]
}

function lazyMcpInventory(ctx: BuildContext, memo: Memo): Lazy {
  return branch(memo, {
    kind: "group",
    id: "group:defaults::mcp",
    label: "MCP",
    depth: 1,
    add: "mcp",
    actions: noActions(),
    children: () => sortedKind(ctx, "mcp", null).map((item) => lazyItem(ctx, memo, "defaults", null, null, item, 2)),
  })
}

// Models group, first child of every agent subtree and first shared Defaults
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
): Lazy {
  const prefix = groupId ?? `group:${level}:${owner ?? ""}:models`
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
        const candidates = modelCandidates({ models: ctx.models, scopes: ctx.scopes, level, agent: owner, ...(upstream === undefined ? {} : { upstream }) })
        const active = resolveActiveModel({ models: ctx.models, scopes: ctx.scopes, level, agent: owner, ...(upstream === undefined ? {} : { upstream }) })
        return candidates
          .toSorted((left, right) => {
            const leftId = modelItemId(left)
            const rightId = modelItemId(right)
            if (leftId < rightId) return -1
            if (leftId > rightId) return 1
            return 0
          })
          .map((candidate) => lazyModelItem(memo, ctx, level, owner, candidate, active, depth + 1))
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
  candidate: { providerID: string; modelID: string; variant?: string; source: Level | "upstream" },
  active: { providerID: string; modelID: string; variant?: string } | undefined,
  depth: number,
): Lazy {
  const itemId = modelItemId(candidate)
  const address: Address = { level, agent: owner, item: itemId, section: null }
  const target = { providerID: candidate.providerID, modelID: candidate.modelID, ...(candidate.variant === undefined ? {} : { variant: candidate.variant }) }
  const isActive = active !== undefined && sameModelCandidate(target, active)
  const hasLocal = hasModelRecordAt(ctx.models, { level, agent: owner }, target)
  const canResetHere = hasModelActiveAt(ctx.models, { level, agent: owner })
  void memo
  void parseModelItemId
  return {
    id: `item:${level}:${owner ?? ""}:${itemId}`,
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
    selfReview: () => false,
    partial: () => ({
      ...(isActive ? { active: true as const } : {}),
      source: candidate.source,
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
): Lazy {
  const prefix = groupId ?? `group:${level}:${owner ?? ""}:tools`
  return branch(memo, {
    kind: "group",
    id: prefix,
    label: "Tools",
    depth,
    actions: noActions(),
    children: () => {
      const tools = sortedKind(ctx, "tool", owner)
      return [
        toolOriginGroup(ctx, memo, level, owner, agent, `${prefix}:native`, "Native", depth + 1, tools.filter((item) => item.group === "native")),
        toolOriginGroup(ctx, memo, level, owner, agent, `${prefix}:plus`, "OpenCodePlus", depth + 1, tools.filter((item) => item.group === "plus")),
        mcpToolsGroup(ctx, memo, level, owner, agent, `${prefix}:mcp`, depth + 1, tools.filter((item) => item.group === "mcp")),
        ...strayTools(ctx, memo, level, owner, agent, tools, depth + 1),
      ]
    },
  })
}

function lazySkills(
  ctx: BuildContext,
  memo: Memo,
  level: Level,
  owner: string | null,
  agent: AgentSource | null,
  depth: number,
  groupId?: string,
): Lazy {
  const prefix = groupId ?? `group:${level}:${owner ?? ""}:skills`
  return branch(memo, {
    kind: "group",
    id: prefix,
    label: "Skills",
    depth,
    actions: noActions(),
    children: () => {
      const skills = sortedKind(ctx, "skill", owner)
      return [
        leafGroup(ctx, memo, level, owner, agent, `${prefix}:native`, "Native", depth + 1, skills.filter((item) => item.group === "native")),
        leafGroup(ctx, memo, level, owner, agent, `${prefix}:plus`, "OpenCodePlus", depth + 1, skills.filter((item) => item.group === "plus")),
        mcpGroup(ctx, memo, level, owner, agent, `${prefix}:mcp`, depth + 1, skills.filter((item) => item.group === "mcp")),
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
        ),
        ...straySkills(ctx, memo, level, owner, agent, skills, depth + 1),
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
): Lazy[] {
  return tools
    .filter((item) => item.group !== "native" && item.group !== "plus" && item.group !== "mcp")
    .map((item) => lazyItem(ctx, memo, level, owner, agent, item, depth))
}

function straySkills(
  ctx: BuildContext,
  memo: Memo,
  level: Level,
  owner: string | null,
  agent: AgentSource | null,
  skills: readonly Item[],
  depth: number,
): Lazy[] {
  return skills
    .filter((item) => item.group !== "native" && item.group !== "plus" && item.group !== "mcp" && item.group !== "project")
    .map((item) => lazyItem(ctx, memo, level, owner, agent, item, depth))
}

function lazyBase(
  ctx: BuildContext,
  memo: Memo,
  level: Level,
  owner: string | null,
  agent: AgentSource | null,
  depth: number,
  groupId?: string,
): Lazy {
  return branch(memo, {
    kind: "group",
    id: groupId ?? `group:${level}:${owner ?? ""}:base`,
    label: "Base",
    depth,
    add: "base",
    actions: noActions(),
    children: () => sortedKind(ctx, "base", owner).map((item) => lazyItem(ctx, memo, level, owner, agent, item, depth + 1)),
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
): Lazy {
  return branch(memo, {
    kind: "group",
    id: groupId ?? `group:${level}:${owner ?? ""}:system`,
    label: "System",
    depth,
    add: "instruction",
    actions: noActions(),
    children: () => {
      const systems = sortedKind(ctx, "system", owner)
      const role = systems.find((item) => item.id === "system:role")
      const head = role === undefined ? [] : [lazyItem(ctx, memo, level, owner, agent, role, depth + 1)]
      return [
        ...head,
        ...systems.filter((item) => item.id !== "system:role").map((item) => lazyItem(ctx, memo, level, owner, agent, item, depth + 1)),
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
): Lazy {
  return branch(memo, {
    kind: "group",
    id,
    label,
    depth,
    ...(add === undefined ? {} : { add }),
    actions: noActions(),
    children: () => items.map((item) => lazyItem(ctx, memo, level, owner, agent, item, depth + 1)),
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
        ),
      )
    },
  })
}

// Native/OpenCodePlus tool origin group: plain tools hang directly off the
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
        .map((item) => lazyItem(ctx, memo, level, owner, agent, item, depth + 1))
      if (code.length === 0) return rows
      return [...rows, codemodeGroup(ctx, memo, level, owner, agent, `${id}:codemode`, depth + 1, code, true)]
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
        .map((item) => lazyItem(ctx, memo, level, owner, agent, item, depth + 1))
      if (code.length === 0) return rows
      return [...rows, codemodeGroup(ctx, memo, level, owner, agent, `${id}:codemode`, depth + 1, code, false)]
    },
  })
}

// Code Mode tools group labelled `Code Mode`. Under the Native and
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
): Lazy {
  return branch(memo, {
    kind: "group",
    id,
    label: "Code Mode",
    depth,
    actions: noActions(),
    children: () => {
      if (!namespaced) return items.map((item) => lazyItem(ctx, memo, level, owner, agent, item, depth + 1))
      const direct = items
        .filter((item) => item.namespace === undefined)
        .map((item) => lazyItem(ctx, memo, level, owner, agent, item, depth + 1))
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
                .map((item) => lazyItem(ctx, memo, level, owner, agent, item, depth + 2)),
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
): Lazy {
  const address: Address = { level, agent: owner, item: item.id, section: null }
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
  const kids = (): readonly Lazy[] => {
    if (executable) return []
    if (perm) return []
    const sections = cachedKids(memo, `item:${level}:${owner ?? ""}:${item.id}`, () =>
      splitOf(memo, level, owner, item).sections.map((section) =>
        lazySection(ctx, memo, level, owner, item, section, depth + 1 + section.depth),
      ),
    )
    // Permission rows hang directly off the tool row after its sections, in
    // byOrderTitle order. Empty sets emit nothing; the `a` choice on the tool
    // row still offers rule creation.
    return [...sections, ...toolPermRows(ctx, memo, level, owner, item, depth + 1)]
  }
  if (perm) {
    const permAddress: Address = { level, agent: owner, item: item.id, section: null }
    return {
      id: `item:${level}:${owner ?? ""}:${item.id}`,
      kind: "item",
      label: item.title,
      depth,
      address: permAddress,
      actions: {
        toggle: true,
        edit: true,
        reset: canReset(ctx.customizations, permAddress),
        remove: item.custom === true,
        split: false,
        pin: false,
      },
      selfReview: () => false,
      partial: () => permBadges(memo, level, owner, item),
      reviewCount: () => 0,
      children: kids,
    }
  }
  return {
    id: `item:${level}:${owner ?? ""}:${item.id}`,
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
      remove: removable(level, owner, item),
      split: splittable,
      pin: codemode && !executable,
    },
    selfReview: () => cachedSelfReview(memo, `item:${level}:${owner ?? ""}:${item.id}`, () => flagOf(memo, level, owner, item, null)),
    partial: () => itemBadges(memo, level, owner, agent, item, wholeNoToggle),
    reviewCount: () => cachedReviewCount(memo, `item:${level}:${owner ?? ""}:${item.id}`, () => itemRollup(memo, level, owner, item)),
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

// Permission rule rows for a native/plus tool, in byOrderTitle order, as
// direct children of the tool row after its sections. Empty sets emit
// nothing. Carries no group wrapper: expanding the tool shows sections, then
// rules.
export function toolPermRows(
  ctx: BuildContext,
  memo: Memo,
  level: Level,
  owner: string | null,
  item: Item,
  depth: number,
): Lazy[] {
  if (!canHostPermRules(item)) return []
  const toolId = item.id.slice("tool:".length)
  const rows = ctx.items
    .filter((entry) => entry.kind === "perm" && entry.permTool === toolId)
    .filter((entry) => (owner === null ? entry.agents === undefined : applies(entry, owner)))
    .toSorted(byOrderTitle)
  if (rows.length === 0) return []
  return rows.map((entry) => lazyPermRow(memo, level, owner, entry, depth))
}

function lazyPermRow(memo: Memo, level: Level, owner: string | null, item: Item, depth: number): Lazy {
  const address: Address = { level, agent: owner, item: item.id, section: null }
  return {
    id: `item:${level}:${owner ?? ""}:${item.id}`,
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
    partial: () => permBadges(memo, level, owner, item),
    reviewCount: () => 0,
    children: () => [],
  }
}

function permBadges(memo: Memo, level: Level, owner: string | null, item: Item): TreeNodeBadges {
  const resolved = wholeOf(memo, level, owner, item)
  return { state: resolved.enabled ? "on" : "off", modified: resolved.modified, source: resolved.source }
}

function itemBadges(
  memo: Memo,
  level: Level,
  owner: string | null,
  agent: AgentSource | null,
  item: Item,
  wholeNoToggle = false,
): TreeNodeBadges {
  const resolved = wholeOf(memo, level, owner, item)
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
): Lazy {
  const address: Address = { level, agent: owner, item: item.id, section: section.id }
  // Code Mode sections apply like any other section now that per-agent
  // catalog rewrites reach them, so they carry the normal toggle/edit/reset
  // treatment with no gate.
  return {
    id: `section:${level}:${owner ?? ""}:${item.id}:${section.id}`,
    kind: "section",
    label: section.name,
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
    selfReview: () =>
      cachedSelfReview(memo, `section:${level}:${owner ?? ""}:${item.id}:${section.id}`, () =>
        flagOf(memo, level, owner, item, section.id),
      ),
    partial: () => sectionBadges(memo, level, owner, item, section),
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
): TreeNodeBadges {
  const resolved = sectionResolveOf(memo, level, owner, item, section.id)
  return {
    state: resolved.enabled ? "on" : "off",
    modified: resolved.modified,
    review: resolved.review,
    source: resolved.source,
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
