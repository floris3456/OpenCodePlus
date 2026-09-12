import { applies, effective, type Item, type Snapshot } from "./model.js"
import type { AgentScope, AgentSource } from "./discover.js"
import type { ProjectConfig } from "../project.js"

export type TreeNodeKind =
  | "group"
  | "agent"
  | "default"
  | "prompt"
  | "skill"
  | "tool"
  | "instruction"
  | "mcp"

export type TreeNodeToggle =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string }

export type TreeNodeEdit =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string }

export interface TreeNodeBadges {
  readonly enabled?: boolean
  readonly customized?: boolean
  readonly review?: boolean
  readonly protected?: boolean
  readonly readOnly?: boolean
}

export interface TreeNodeAction {
  readonly toggle: TreeNodeToggle
  readonly edit: TreeNodeEdit
}

export interface TreeNode {
  readonly id: string
  readonly kind: TreeNodeKind
  readonly label: string
  readonly depth: number
  readonly badges: TreeNodeBadges
  readonly agentId?: string
  readonly itemId?: string
  readonly scope?: AgentScope
  readonly action?: TreeNodeAction
}

export interface TreeInput {
  readonly snapshot: Snapshot
  readonly agents?: readonly AgentSource[]
  readonly project?: ProjectConfig | null
  readonly expanded?: ReadonlySet<string>
}

export function tree(input: TreeInput): TreeNode[] {
  const agents = input.agents ?? []
  const expandedSet = normalizeExpanded(input.expanded)
  const protectedSet = new Set(input.project?.protectedAgents ?? [])

  const projectAgents = agents.filter((agent) => agent.scope === "project")
  const globalAgents = agents.filter((agent) => agent.scope === "global")
  const builtinAgents = agents.filter((agent) => agent.scope === "builtin")

  const projectGroup = emitAgentGroup({
    groupId: "group:project",
    label: `Project agents (${projectAgents.length})`,
    agents: projectAgents,
    snapshot: input.snapshot,
    protectedSet,
    expandedSet,
    groupAliases: ["project", "Project agents"],
  })

  const globalGroup = emitAgentGroup({
    groupId: "group:global",
    label: `Global agents (${globalAgents.length})`,
    agents: globalAgents,
    snapshot: input.snapshot,
    protectedSet,
    expandedSet,
    groupAliases: ["global", "Global agents"],
  })

  const defaultsGroup = emitDefaultsGroup({
    snapshot: input.snapshot,
    builtinAgents,
    protectedSet,
    expandedSet,
  })

  return [...projectGroup, ...globalGroup, ...defaultsGroup]
}

function normalizeExpanded(expanded?: ReadonlySet<string>): ReadonlySet<string> {
  if (!expanded) return new Set<string>()
  return expanded
}

function isExpanded(id: string, expandedSet: ReadonlySet<string>, aliases?: readonly string[]): boolean {
  if (expandedSet.has(id)) return true
  if (!aliases) return false
  return aliases.some((alias) => expandedSet.has(alias))
}

interface AgentGroupInput {
  readonly groupId: string
  readonly label: string
  readonly agents: readonly AgentSource[]
  readonly snapshot: Snapshot
  readonly protectedSet: ReadonlySet<string>
  readonly expandedSet: ReadonlySet<string>
  readonly groupAliases: readonly string[]
}

function emitAgentGroup(input: AgentGroupInput): TreeNode[] {
  const header: TreeNode = {
    id: input.groupId,
    kind: "group",
    label: input.label,
    depth: 0,
    badges: {},
  }

  if (!isExpanded(input.groupId, input.expandedSet, input.groupAliases)) {
    return [header]
  }

  const agentNodes = input.agents.flatMap((agent) =>
    emitAgentNode({
      agent,
      snapshot: input.snapshot,
      protectedSet: input.protectedSet,
      expandedSet: input.expandedSet,
    }),
  )

  return [header, ...agentNodes]
}

interface AgentNodeInput {
  readonly agent: AgentSource
  readonly snapshot: Snapshot
  readonly protectedSet: ReadonlySet<string>
  readonly expandedSet: ReadonlySet<string>
}

function emitAgentNode(input: AgentNodeInput): TreeNode[] {
  const isProtected = input.protectedSet.has(input.agent.id)
  const agentId = input.agent.id
  const nodeId = `agent:${agentId}`

  const node: TreeNode = {
    id: nodeId,
    kind: "agent",
    label: agentId,
    depth: 1,
    badges: {
      protected: isProtected,
      readOnly: isProtected,
    },
    agentId,
    scope: input.agent.scope,
  }

  if (!isExpanded(nodeId, input.expandedSet, [agentId])) {
    return [node]
  }

  const children = emitAgentChildren(agentId, input.snapshot, isProtected)
  return [node, ...children]
}

function emitAgentChildren(agentId: string, snapshot: Snapshot, isProtected: boolean): TreeNode[] {
  const prompts = snapshot.items
    .filter((item) => item.kind === "prompt" && applies(item, agentId))
    .map((item) =>
      emitItemNode({
        agentId,
        item,
        snapshot,
        label: "Prompt",
        isProtected,
        toggle: { allowed: false, reason: "an agent always needs a system prompt" },
      }),
    )

  const skills = snapshot.items
    .filter((item) => item.kind === "skill" && applies(item, agentId))
    .map((item) =>
      emitItemNode({
        agentId,
        item,
        snapshot,
        label: item.title,
        isProtected,
      }),
    )

  const tools = snapshot.items
    .filter((item) => item.kind === "tool" && applies(item, agentId))
    .map((item) =>
      emitItemNode({
        agentId,
        item,
        snapshot,
        label: item.title,
        isProtected,
      }),
    )

  const instructions = snapshot.items
    .filter((item) => item.kind === "instruction" && applies(item, agentId))
    .map((item) =>
      emitItemNode({
        agentId,
        item,
        snapshot,
        label: item.title,
        isProtected,
        toggle: { allowed: false, reason: "instruction customizations are not applied yet" },
        edit: { allowed: false, reason: "instruction customizations are not applied yet" },
      }),
    )

  return [...prompts, ...skills, ...tools, ...instructions]
}

interface ItemNodeInput {
  readonly agentId: string
  readonly item: Item
  readonly snapshot: Snapshot
  readonly label: string
  readonly isProtected: boolean
  readonly toggle?: TreeNodeToggle
  readonly edit?: TreeNodeEdit
}

function emitItemNode(input: ItemNodeInput): TreeNode {
  const eff = effective(input.snapshot, input.item, input.agentId)
  return {
    id: `agent:${input.agentId}:${input.item.id}`,
    kind: input.item.kind,
    label: input.label,
    depth: 2,
    badges: {
      enabled: eff.enabled,
      customized: eff.customized,
      review: eff.review,
      readOnly: input.isProtected,
    },
    agentId: input.agentId,
    itemId: input.item.id,
    action: {
      toggle: input.toggle ?? { allowed: true },
      edit: input.edit ?? { allowed: true },
    },
  }
}

interface DefaultsGroupInput {
  readonly snapshot: Snapshot
  readonly builtinAgents: readonly AgentSource[]
  readonly protectedSet: ReadonlySet<string>
  readonly expandedSet: ReadonlySet<string>
}

function emitDefaultsGroup(input: DefaultsGroupInput): TreeNode[] {
  const header: TreeNode = {
    id: "group:defaults",
    kind: "group",
    label: "Defaults",
    depth: 0,
    badges: {},
  }

  if (!isExpanded("group:defaults", input.expandedSet, ["defaults", "Defaults"])) {
    return [header]
  }

  const projectDefaults = emitDefaultTarget({
    id: "defaults:project",
    label: "Project",
    snapshot: input.snapshot,
    expandedSet: input.expandedSet,
    aliases: ["default:project"],
  })

  const globalDefaults = emitDefaultTarget({
    id: "defaults:global",
    label: "Global",
    snapshot: input.snapshot,
    expandedSet: input.expandedSet,
    aliases: ["default:global"],
  })

  const builtinNodes = input.builtinAgents.flatMap((agent) =>
    emitAgentNode({
      agent,
      snapshot: input.snapshot,
      protectedSet: input.protectedSet,
      expandedSet: input.expandedSet,
    }),
  )

  return [header, ...projectDefaults, ...globalDefaults, ...builtinNodes]
}

interface DefaultTargetInput {
  readonly id: string
  readonly label: string
  readonly snapshot: Snapshot
  readonly expandedSet: ReadonlySet<string>
  readonly aliases: readonly string[]
}

function emitDefaultTarget(input: DefaultTargetInput): TreeNode[] {
  const node: TreeNode = {
    id: input.id,
    kind: "default",
    label: input.label,
    depth: 1,
    badges: {},
  }

  if (!isExpanded(input.id, input.expandedSet, input.aliases)) {
    return [node]
  }

  const children = emitDefaultChildren(input.id, input.snapshot)
  return [node, ...children]
}

function emitDefaultChildren(targetId: string, snapshot: Snapshot): TreeNode[] {
  const sharedAgent = "*"
  const items = snapshot.items.filter((item) => item.kind !== "prompt" && applies(item, sharedAgent))
  return items.map((item) => emitDefaultNode(targetId, snapshot, sharedAgent, item))
}

function emitDefaultNode(targetId: string, snapshot: Snapshot, sharedAgent: string, item: Item): TreeNode {
  const eff = effective(snapshot, item, sharedAgent)
  const base = {
    id: `${targetId}:${item.id}`,
    kind: item.kind,
    label: item.title,
    depth: 2,
    badges: {
      enabled: eff.enabled,
      customized: eff.customized,
      review: eff.review,
    },
    itemId: item.id,
  }
  if (item.kind === "instruction")
    return {
      ...base,
      action: {
        toggle: { allowed: false, reason: "instruction customizations are not applied yet" },
        edit: { allowed: false, reason: "instruction customizations are not applied yet" },
      },
    }
  return {
    ...base,
    action: {
      toggle: { allowed: true },
      edit: { allowed: true },
    },
  }
}
