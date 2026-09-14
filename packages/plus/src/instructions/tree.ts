import { applies, canReset, resolve, resolveSplit, scopesOf } from "./model.js"
import type { Address, AgentSource, CustomizationRecord, Item, Level, Scopes, SplitRecord } from "./model.js"
import type { Section } from "./sections.js"

export type TreeNodeKind = "root" | "group" | "agent" | "item" | "section"
export type AddKind = "agent" | "base" | "skill" | "instruction" | "mcp"

export interface TreeNodeBadges {
  readonly state?: "on" | "off"
  readonly modified?: boolean
  readonly review?: boolean
  readonly reviewCount?: number
  readonly active?: boolean
  readonly source?: Level | "upstream"
}

export interface TreeNodeActions {
  readonly toggle: boolean
  readonly edit: boolean
  readonly reset: boolean
  readonly remove: boolean
  readonly split: boolean
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

export interface TreeInput {
  readonly items: readonly Item[]
  readonly records: readonly (CustomizationRecord | SplitRecord)[]
  readonly agents: readonly AgentSource[]
  readonly expanded?: ReadonlySet<string>
}

export function tree(input: TreeInput): TreeNode[] {
  const ctx = contextOf(input)
  const expanded = input.expanded ?? new Set<string>()
  const roots = [buildRoot(ctx, "project"), buildRoot(ctx, "global"), buildRoot(ctx, "defaults")]
  return roots.map(finalize).flatMap((root) => visible(root, expanded))
}

interface BuildContext {
  readonly items: readonly Item[]
  readonly customizations: readonly CustomizationRecord[]
  readonly splits: readonly SplitRecord[]
  readonly scopes: Scopes
  readonly agents: readonly AgentSource[]
}

function contextOf(input: TreeInput): BuildContext {
  return {
    items: input.items,
    customizations: input.records.filter((record): record is CustomizationRecord => record.type === "customization"),
    splits: input.records.filter((record): record is SplitRecord => record.type === "split"),
    scopes: scopesOf(input.agents),
    agents: input.agents,
  }
}

interface Logical {
  readonly id: string
  readonly kind: TreeNodeKind
  readonly label: string
  readonly depth: number
  readonly address?: Address
  readonly add?: AddKind
  readonly partial: TreeNodeBadges
  readonly actions: TreeNodeActions
  readonly selfReview: boolean
  readonly children: readonly Logical[]
}

function buildRoot(ctx: BuildContext, level: Level): Logical {
  if (level === "defaults")
    return {
      id: "root:defaults",
      kind: "root",
      label: "Defaults",
      depth: 0,
      partial: {},
      actions: noActions(),
      selfReview: false,
      children: [buildAgentsGroup(ctx), ...buildSharedGroups(ctx)],
    }
  const scope: "project" | "global" = level === "project" ? "project" : "global"
  return {
    id: `root:${level}`,
    kind: "root",
    label: scope === "project" ? "Project agents" : "Global agents",
    depth: 0,
    add: "agent",
    partial: {},
    actions: noActions(),
    selfReview: false,
    children: ctx.agents.filter((agent) => agent.scope === scope).map((agent) => buildAgent(ctx, level, agent, 1)),
  }
}

function buildAgent(ctx: BuildContext, level: Level, agent: AgentSource, depth: number): Logical {
  return {
    id: `agent:${level}:${agent.id}`,
    kind: "agent",
    label: agent.id,
    depth,
    partial: {},
    actions: { ...noActions(), remove: true },
    selfReview: false,
    children: [
      buildTools(ctx, level, agent.id, agent, depth + 1),
      buildBase(ctx, level, agent.id, agent, depth + 1),
      buildSkills(ctx, level, agent.id, agent, depth + 1),
      buildSystem(ctx, level, agent.id, agent, depth + 1),
    ],
  }
}

function buildAgentsGroup(ctx: BuildContext): Logical {
  return {
    id: "group:defaults:agents",
    kind: "group",
    label: "Agents",
    depth: 1,
    add: "agent",
    partial: {},
    actions: noActions(),
    selfReview: false,
    children: ctx.agents.filter((agent) => agent.scope === "defaults").map((agent) => buildAgent(ctx, "defaults", agent, 2)),
  }
}

function buildSharedGroups(ctx: BuildContext): Logical[] {
  return [
    buildTools(ctx, "defaults", null, null, 1),
    buildBase(ctx, "defaults", null, null, 1),
    buildSkills(ctx, "defaults", null, null, 1),
    buildSystem(ctx, "defaults", null, null, 1),
    buildMcpInventory(ctx),
  ]
}

function buildMcpInventory(ctx: BuildContext): Logical {
  return {
    id: "group:defaults::mcp",
    kind: "group",
    label: "MCP",
    depth: 1,
    add: "mcp",
    partial: {},
    actions: noActions(),
    selfReview: false,
    children: sortedKind(ctx, "mcp", null).map((item) => buildItem(ctx, "defaults", null, null, item, 2)),
  }
}

function buildTools(
  ctx: BuildContext,
  level: Level,
  owner: string | null,
  agent: AgentSource | null,
  depth: number,
): Logical {
  const tools = sortedKind(ctx, "tool", owner)
  const prefix = `group:${level}:${owner ?? ""}:tools`
  return {
    id: prefix,
    kind: "group",
    label: "Tools",
    depth,
    partial: {},
    actions: noActions(),
    selfReview: false,
    children: [
      leafGroup(ctx, level, owner, agent, `${prefix}:native`, "Native", depth + 1, tools.filter((item) => item.group === "native")),
      leafGroup(ctx, level, owner, agent, `${prefix}:plus`, "OpenCodePlus", depth + 1, tools.filter((item) => item.group === "plus")),
      mcpGroup(ctx, level, owner, agent, `${prefix}:mcp`, depth + 1, tools.filter((item) => item.group === "mcp")),
      ...strayTools(ctx, level, owner, agent, tools, depth + 1),
    ],
  }
}

function buildSkills(
  ctx: BuildContext,
  level: Level,
  owner: string | null,
  agent: AgentSource | null,
  depth: number,
): Logical {
  const skills = sortedKind(ctx, "skill", owner)
  const prefix = `group:${level}:${owner ?? ""}:skills`
  return {
    id: prefix,
    kind: "group",
    label: "Skills",
    depth,
    partial: {},
    actions: noActions(),
    selfReview: false,
    children: [
      leafGroup(ctx, level, owner, agent, `${prefix}:native`, "Native", depth + 1, skills.filter((item) => item.group === "native")),
      leafGroup(ctx, level, owner, agent, `${prefix}:plus`, "OpenCodePlus", depth + 1, skills.filter((item) => item.group === "plus")),
      mcpGroup(ctx, level, owner, agent, `${prefix}:mcp`, depth + 1, skills.filter((item) => item.group === "mcp")),
      leafGroup(
        ctx,
        level,
        owner,
        agent,
        `${prefix}:project`,
        "Project",
        depth + 1,
        skills.filter((item) => item.group === "project"),
        "skill",
      ),
      ...straySkills(ctx, level, owner, agent, skills, depth + 1),
    ],
  }
}

// Tools or skills whose group belongs to no subgroup still need a row, so
// they hang directly off the category group rather than being dropped.
function strayTools(
  ctx: BuildContext,
  level: Level,
  owner: string | null,
  agent: AgentSource | null,
  tools: readonly Item[],
  depth: number,
): Logical[] {
  return tools
    .filter((item) => item.group !== "native" && item.group !== "plus" && item.group !== "mcp")
    .map((item) => buildItem(ctx, level, owner, agent, item, depth))
}

function straySkills(
  ctx: BuildContext,
  level: Level,
  owner: string | null,
  agent: AgentSource | null,
  skills: readonly Item[],
  depth: number,
): Logical[] {
  return skills
    .filter((item) => item.group !== "native" && item.group !== "plus" && item.group !== "mcp" && item.group !== "project")
    .map((item) => buildItem(ctx, level, owner, agent, item, depth))
}

function buildBase(
  ctx: BuildContext,
  level: Level,
  owner: string | null,
  agent: AgentSource | null,
  depth: number,
): Logical {
  return {
    id: `group:${level}:${owner ?? ""}:base`,
    kind: "group",
    label: "Base",
    depth,
    add: "base",
    partial: {},
    actions: noActions(),
    selfReview: false,
    children: sortedKind(ctx, "base", owner).map((item) => buildItem(ctx, level, owner, agent, item, depth + 1)),
  }
}

function buildSystem(
  ctx: BuildContext,
  level: Level,
  owner: string | null,
  agent: AgentSource | null,
  depth: number,
): Logical {
  const systems = sortedKind(ctx, "system", owner)
  const role = systems.find((item) => item.id === "system:role")
  const head = role === undefined ? [] : [buildItem(ctx, level, owner, agent, role, depth + 1)]
  return {
    id: `group:${level}:${owner ?? ""}:system`,
    kind: "group",
    label: "System",
    depth,
    add: "instruction",
    partial: {},
    actions: noActions(),
    selfReview: false,
    children: [
      ...head,
      ...systems.filter((item) => item.id !== "system:role").map((item) => buildItem(ctx, level, owner, agent, item, depth + 1)),
    ],
  }
}

function leafGroup(
  ctx: BuildContext,
  level: Level,
  owner: string | null,
  agent: AgentSource | null,
  id: string,
  label: string,
  depth: number,
  items: readonly Item[],
  add?: AddKind,
): Logical {
  return {
    id,
    kind: "group",
    label,
    depth,
    ...(add === undefined ? {} : { add }),
    partial: {},
    actions: noActions(),
    selfReview: false,
    children: items.map((item) => buildItem(ctx, level, owner, agent, item, depth + 1)),
  }
}

function mcpGroup(
  ctx: BuildContext,
  level: Level,
  owner: string | null,
  agent: AgentSource | null,
  id: string,
  depth: number,
  items: readonly Item[],
): Logical {
  const servers = [...new Set(items.map((item) => item.server ?? "unknown"))].sort()
  return {
    id,
    kind: "group",
    label: "MCP",
    depth,
    partial: {},
    actions: noActions(),
    selfReview: false,
    children: servers.map((server) =>
      leafGroup(
        ctx,
        level,
        owner,
        agent,
        `${id}:${server}`,
        server,
        depth + 1,
        items.filter((item) => (item.server ?? "unknown") === server),
      ),
    ),
  }
}

function buildItem(
  ctx: BuildContext,
  level: Level,
  owner: string | null,
  agent: AgentSource | null,
  item: Item,
  depth: number,
): Logical {
  const address: Address = { level, agent: owner, item: item.id, section: null }
  const resolved = resolve({ upstream: item, records: ctx.customizations, splits: ctx.splits, scopes: ctx.scopes, address })
  const split = resolveSplit({ text: resolved.text, title: item.title, splits: ctx.splits, scopes: ctx.scopes, address })
  const active = agent?.base !== undefined && item.id === `base:${agent.base}`
  return {
    id: `item:${level}:${owner ?? ""}:${item.id}`,
    kind: "item",
    label: item.id === "system:role" ? "Role/persona" : item.title,
    depth,
    address,
    partial: {
      state: resolved.enabled ? "on" : "off",
      modified: resolved.modified,
      source: resolved.source,
      ...(active ? { active: true } : {}),
    },
    actions: {
      toggle: true,
      edit: true,
      reset: canReset(ctx.customizations, address),
      remove: removable(level, owner, item),
      split: true,
    },
    selfReview: resolved.review,
    children: split.sections.map((section) => buildSection(ctx, level, owner, item, section, depth + 1 + section.depth)),
  }
}

function buildSection(
  ctx: BuildContext,
  level: Level,
  owner: string | null,
  item: Item,
  section: Section,
  depth: number,
): Logical {
  const address: Address = { level, agent: owner, item: item.id, section: section.id }
  const resolved = resolve({ upstream: item, records: ctx.customizations, splits: ctx.splits, scopes: ctx.scopes, address })
  return {
    id: `section:${level}:${owner ?? ""}:${item.id}:${section.id}`,
    kind: "section",
    label: section.name,
    depth,
    address,
    partial: {
      state: resolved.enabled ? "on" : "off",
      modified: resolved.modified,
      review: resolved.review,
      source: resolved.source,
    },
    actions: { toggle: true, edit: true, reset: canReset(ctx.customizations, address), remove: false, split: false },
    selfReview: resolved.review,
    children: [],
  }
}

// User-owned rows can be deleted outright: shared MCP servers, project-group
// items (skills, added instructions, added base prompts), and agents. The
// agent's own Role/persona body is owned but not deletable.
function removable(level: Level, owner: string | null, item: Item): boolean {
  if (level === "defaults" && owner === null && item.kind === "mcp") return true
  if (item.id === "system:role") return false
  return item.group === "project"
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
  return { toggle: false, edit: false, reset: false, remove: false, split: false }
}

interface Final {
  readonly node: TreeNode
  readonly selfReview: boolean
  readonly count: number
  readonly children: readonly Final[]
}

// Roll-up runs over the whole logical tree so collapsed ancestors still
// report review markers for hidden descendants.
function finalize(logical: Logical): Final {
  const children = logical.children.map(finalize)
  const count = children.reduce((sum, child) => sum + child.count + (child.selfReview ? 1 : 0), 0)
  const badges: TreeNodeBadges =
    logical.kind === "section"
      ? logical.partial
      : { ...logical.partial, review: logical.selfReview || count > 0, reviewCount: count }
  const node: TreeNode = {
    id: logical.id,
    kind: logical.kind,
    label: logical.label,
    depth: logical.depth,
    ...(logical.address === undefined ? {} : { address: logical.address }),
    ...(logical.add === undefined ? {} : { add: logical.add }),
    badges,
    actions: logical.actions,
  }
  return { node, selfReview: logical.selfReview, count, children }
}

function visible(root: Final, expanded: ReadonlySet<string>): TreeNode[] {
  if (!expanded.has(root.node.id)) return [root.node]
  return [root.node, ...root.children.flatMap((child) => visible(child, expanded))]
}
