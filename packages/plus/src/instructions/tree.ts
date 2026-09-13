import { applies, canReset, effective, type Item, type Snapshot } from "./model.js"
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

export type TreeNodeReset =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string }

export interface TreeNodeAction {
  readonly toggle: TreeNodeToggle
  readonly edit: TreeNodeEdit
  readonly reset: TreeNodeReset
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

export interface ToolSource {
  readonly id: string
  readonly native: boolean
}

export interface TreeInput {
  readonly snapshot: Snapshot
  readonly agents?: readonly AgentSource[]
  readonly tools?: readonly ToolSource[]
  readonly project?: ProjectConfig | null
  readonly expanded?: ReadonlySet<string>
}

const codeModeReason = "code mode tools are exposed through the execute inventory, not the session tool list"
const mcpEditReason = "mcp server configuration can only be changed in config files"
const instructionReason = "the public plugin API does not expose source-aware instruction customization"

export function tree(input: TreeInput): TreeNode[] {
  const agents = input.agents ?? []
  const expandedSet = normalizeExpanded(input.expanded)
  const protectedSet = new Set(input.project?.protectedAgents ?? [])
  const nativeTools = new Set((input.tools ?? []).filter((tool) => tool.native).map((tool) => tool.id))

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
    nativeTools,
  })

  const globalGroup = emitAgentGroup({
    groupId: "group:global",
    label: `Global agents (${globalAgents.length})`,
    agents: globalAgents,
    snapshot: input.snapshot,
    protectedSet,
    expandedSet,
    groupAliases: ["global", "Global agents"],
    nativeTools,
  })

  const defaultsGroup = emitDefaultsGroup({
    snapshot: input.snapshot,
    builtinAgents,
    protectedSet,
    expandedSet,
    nativeTools,
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
  readonly nativeTools: ReadonlySet<string>
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
      nativeTools: input.nativeTools,
    }),
  )

  return [header, ...agentNodes]
}

interface AgentNodeInput {
  readonly agent: AgentSource
  readonly snapshot: Snapshot
  readonly protectedSet: ReadonlySet<string>
  readonly expandedSet: ReadonlySet<string>
  readonly nativeTools: ReadonlySet<string>
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

  const children = emitAgentChildren(agentId, input.snapshot, isProtected, input.nativeTools)
  return [node, ...children]
}

function emitAgentChildren(
  agentId: string,
  snapshot: Snapshot,
  isProtected: boolean,
  nativeTools: ReadonlySet<string>,
): TreeNode[] {
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
    .map((item) => {
      if (nativeTools.has(item.owner))
        return emitItemNode({
          agentId,
          item,
          snapshot,
          label: item.title,
          isProtected,
        })
      return emitItemNode({
        agentId,
        item,
        snapshot,
        label: item.title,
        isProtected,
        toggle: { allowed: false, reason: codeModeReason },
        edit: { allowed: false, reason: codeModeReason },
      })
    })

  const instructions = snapshot.items
    .filter((item) => item.kind === "instruction" && applies(item, agentId))
    .map((item) =>
      emitItemNode({
        agentId,
        item,
        snapshot,
        label: item.title,
        isProtected,
        toggle: { allowed: false, reason: instructionReason },
        edit: { allowed: false, reason: instructionReason },
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
  const toggle = input.toggle ?? { allowed: true }
  const edit = input.edit ?? { allowed: true }
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
      toggle,
      edit,
      reset: resetAction({ snapshot: input.snapshot, item: input.item, agent: input.agentId, toggle, edit }),
    },
  }
}

interface ResetInput {
  readonly snapshot: Snapshot
  readonly item: Item
  readonly agent: string
  readonly toggle: TreeNodeToggle
  readonly edit: TreeNodeEdit
}

function resetAction(input: ResetInput): TreeNodeReset {
  if (!canReset(input.snapshot, input.item, input.agent)) return { allowed: false, reason: "nothing to reset" }
  const toggleBlocked = input.toggle.allowed === false
  const editBlocked = input.edit.allowed === false
  if (toggleBlocked && editBlocked) {
    if (input.toggle.allowed === false && input.edit.allowed === false && input.toggle.reason === input.edit.reason)
      return { allowed: false, reason: input.toggle.reason }
    return { allowed: false, reason: "resetting is not supported for this row" }
  }
  return { allowed: true }
}

interface DefaultsGroupInput {
  readonly snapshot: Snapshot
  readonly builtinAgents: readonly AgentSource[]
  readonly protectedSet: ReadonlySet<string>
  readonly expandedSet: ReadonlySet<string>
  readonly nativeTools: ReadonlySet<string>
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
    nativeTools: input.nativeTools,
  })

  const globalDefaults = emitDefaultTarget({
    id: "defaults:global",
    label: "Global",
    snapshot: input.snapshot,
    expandedSet: input.expandedSet,
    aliases: ["default:global"],
    nativeTools: input.nativeTools,
  })

  const builtinNodes = input.builtinAgents.flatMap((agent) =>
    emitAgentNode({
      agent,
      snapshot: input.snapshot,
      protectedSet: input.protectedSet,
      expandedSet: input.expandedSet,
      nativeTools: input.nativeTools,
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
  readonly nativeTools: ReadonlySet<string>
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

  const children = emitDefaultChildren(input.id, input.snapshot, input.nativeTools)
  return [node, ...children]
}

function emitDefaultChildren(targetId: string, snapshot: Snapshot, nativeTools: ReadonlySet<string>): TreeNode[] {
  const sharedAgent = "*"
  const items = snapshot.items.filter((item) => item.kind !== "prompt" && applies(item, sharedAgent))
  return items.map((item) => emitDefaultNode(targetId, snapshot, sharedAgent, item, nativeTools))
}

function emitDefaultNode(
  targetId: string,
  snapshot: Snapshot,
  sharedAgent: string,
  item: Item,
  nativeTools: ReadonlySet<string>,
): TreeNode {
  const eff = effective(snapshot, item, sharedAgent)
  const toggle: TreeNodeToggle = defaultToggleFor(item, nativeTools)
  const edit: TreeNodeEdit = defaultEditFor(item, nativeTools)
  return {
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
    action: {
      toggle,
      edit,
      reset: resetAction({ snapshot, item, agent: sharedAgent, toggle, edit }),
    },
  }
}

function defaultToggleFor(item: Item, nativeTools: ReadonlySet<string>): TreeNodeToggle {
  if (item.kind === "instruction") return { allowed: false, reason: instructionReason }
  if (item.kind === "tool" && !nativeTools.has(item.owner)) return { allowed: false, reason: codeModeReason }
  return { allowed: true }
}

function defaultEditFor(item: Item, nativeTools: ReadonlySet<string>): TreeNodeEdit {
  if (item.kind === "instruction") return { allowed: false, reason: instructionReason }
  if (item.kind === "tool" && !nativeTools.has(item.owner)) return { allowed: false, reason: codeModeReason }
  if (item.kind === "mcp") return { allowed: false, reason: mcpEditReason }
  return { allowed: true }
}
