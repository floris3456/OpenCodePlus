// The permission table a publish hands the team tools, built the production
// way: the real catalogue rows of every tool a team rule lives on, the real
// per-member rows, and each member linked to a preset and resolved through the
// real chain (presets, fallback off) by apply's own table builder. Tests that
// need "a member that behaves like the old orchestrator" link it to the Plus
// orchestrator preset here; nothing reads a member's id.
import { createState } from "../../src/index.js"
import { permissionTableOf, type ApplyInput } from "../../src/instructions/apply.js"
import { fingerprint, permItemId, resolve, type CustomizationRecord, type Item, type LinkRecord, type PresetRef } from "../../src/instructions/model.js"
import type { PermissionTable } from "../../src/instructions/permission-enforce.js"
import { catalogItems, categoryOfRow } from "../../src/instructions/permission-catalog.js"
import { curatedRules } from "../../src/instructions/tool-permissions.js"
import { chainContext, plusTeamPresets } from "../../src/instructions/presets.js"
import { policyMembersOf, teamPolicyItems, type PolicyRun } from "../../src/instructions/team-policy-rows.js"
import { teamTools } from "../../src/teams/policy.js"

export interface TeamMember {
  readonly id: string
  readonly team?: string
  /** What the member is created from; absent = no preset (every shared row falls back to off). */
  readonly preset?: PresetRef
}

export const shippedTeam = "opencodeplus-team"

/** The shipped team's members, each linked to its member preset (as team.create links them). */
export function shippedMembers(team = shippedTeam): TeamMember[] {
  const members = plusTeamPresets.find((entry) => entry.id === shippedTeam)?.members ?? []
  return members.map((member) => ({ id: member.id, team, preset: { kind: "member", team: shippedTeam, id: member.id } }))
}

/** A member linked straight to a Plus agent preset. */
export function linked(id: string, preset: string, team = shippedTeam): TeamMember {
  return { id, team, preset: { kind: "agent", id: preset } }
}

const nativeTools = ["read", "glob", "grep", "edit", "write", "patch", "shell", "question", "subagent"]
const searchTools = ["search_tavily_search", "search_tavily_extract", "search_exa_code_search"]

function toolItem(id: string, group: Item["group"]): Item {
  return { id: `tool:${id}`, kind: "tool", group, title: id, text: id, enabled: true, fingerprint: fingerprint(id) }
}

export const inventory: readonly Item[] = [
  ...teamTools.map((name) => toolItem(`team_${name}`, "plus")),
  ...nativeTools.map((name) => toolItem(name, "native")),
  ...searchTools.map((name) => toolItem(name, "mcp")),
]

const catalog = catalogItems(inventory, (tool) => (tool.startsWith("team_") ? `team.${tool.slice("team_".length)}` : tool === "write" || tool === "patch" ? "edit" : tool))

// The curated rule rows discovery lists for the native tools (shell's git
// push, read's .env files, …), shaped as discovery shapes them.
const curated: readonly Item[] = curatedRules
  .filter((rule) => nativeTools.includes(rule.tool))
  .map((rule): Item => {
    const text = `${rule.label}\n${rule.patterns.join("\n")}`
    return {
      id: permItemId(rule.tool, rule.id),
      kind: "perm",
      group: "none",
      title: rule.label,
      text,
      enabled: true,
      fingerprint: fingerprint(text),
      permTool: rule.tool,
      permAction: rule.tool === "write" ? "edit" : rule.tool,
      ruleId: rule.id,
      patterns: [...rule.patterns],
      keywords: [...rule.keywords],
      provenance: [],
      category: categoryOfRow({ permTool: rule.tool, provenance: [], ruleId: rule.id }, true),
    }
  })

/** One stored override of a member's row, at the member's own team address. */
export function change(member: TeamMember, item: string, value: { state?: "on" | "off"; text?: string }): CustomizationRecord {
  return {
    type: "customization",
    level: "project",
    agent: member.id,
    ...(member.team === undefined ? {} : { team: { level: "project", team: member.team } }),
    item,
    section: null,
    ...(value.state === undefined ? {} : { state: value.state }),
    ...(value.text === undefined ? {} : { text: value.text }),
    basedOn: "",
    updated: "",
  }
}

export function presetInput(
  options: {
    readonly members?: readonly TeamMember[]
    readonly records?: readonly CustomizationRecord[]
    readonly runs?: readonly PolicyRun[]
  } = {},
): ApplyInput {
  const members = options.members ?? shippedMembers()
  const items = [...inventory, ...catalog, ...curated, ...teamPolicyItems(policyMembersOf(members), options.runs ?? [])]
  const links = members.flatMap((member): LinkRecord[] =>
    member.preset === undefined
      ? []
      : [
          {
            type: "link",
            level: "project",
            agent: member.id,
            ...(member.team === undefined ? {} : { team: { level: "project", team: member.team } }),
            preset: member.preset,
            updated: "",
          },
        ],
  )
  const teams = [...new Set(members.flatMap((member) => (member.team === undefined ? [] : [member.team])))].map((team) => ({
    team,
    agents: members.filter((member) => member.team === team).map((member) => member.id),
  }))
  return {
    items,
    agents: members.map((member) => ({
      id: member.id,
      level: "project",
      ...(member.team === undefined ? {} : { team: { level: "project", team: member.team } }),
    })),
    records: options.records ?? [],
    splits: [],
    scopes: chainContext({
      agents: members.map((member) => ({ id: member.id, scope: "project", origin: "user", ...(member.team === undefined ? {} : { team: member.team }) })),
      items,
      links,
      teams,
    }),
    teamAgents: members.map((member) => member.id),
  }
}

/** The table a publish would hand the team tools for these members. */
export function presetTable(options: Parameters<typeof presetInput>[0] = {}): PermissionTable {
  return permissionTableOf(presetInput(options))
}

let shipped: PermissionTable | undefined

/** The shipped team's table, built once: every member linked to its member preset. */
export function shippedTable(): PermissionTable {
  shipped ??= presetTable()
  return shipped
}

/** Plugin state whose permission table is the shipped team's (or `table`). */
export function teamState(table?: PermissionTable): ReturnType<typeof createState> {
  const state = createState()
  state.permissions = table ?? shippedTable()
  return state
}

/**
 * Every row a member has, resolved for it through the chain (rule rows
 * included, which the permission table leaves to core): item id → on/off.
 */
export function resolvedStates(input: ApplyInput, member: string): Record<string, "on" | "off"> {
  const agent = input.agents.find((entry) => entry.id === member)
  if (agent === undefined) throw new Error(`no member ${member}`)
  return Object.fromEntries(
    input.items
      .filter((item) => item.agents === undefined || item.agents.includes(member))
      .map((item) => {
        const resolved = resolve({
          upstream: item,
          records: input.records,
          splits: input.splits,
          scopes: input.scopes,
          address: { level: agent.level, agent: member, item: item.id, section: null, ...(agent.team === undefined ? {} : { team: agent.team }) },
        })
        return [item.id, resolved.enabled ? "on" : "off"] as const
      }),
  )
}
