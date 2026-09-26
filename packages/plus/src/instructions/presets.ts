// What ships as presets (DESIGN §1, §3.4, §3.5) and the builders that turn it,
// plus the stored links, Defaults entries and user presets, into the full
// resolution context.
//
// Pure data and functions, no filesystem: the server, the TUI and the tools
// all import this module and compute the same catalogue — the client from the
// snapshot's items and records, so shipped content never crosses the wire.
import { builtinTeams, teamRoles } from "./builtin-teams.js"
import { controlItems, isControl } from "./agent-controls.js"
import {
  fingerprint,
  presetKey,
  scopedTo,
  scopesOf,
  type AgentSource,
  type ChainContext,
  type EntryRecord,
  type Item,
  type LinkRecord,
  type PresetCatalog,
  type PresetOrigin,
  type PresetRecord,
  type PresetRef,
  type RecordScope,
  type ShippedValue,
} from "./model.js"

/** One Native agent preset per native opencode agent (§3.4). */
export const nativePresetIds = ["build", "plan", "general", "explore", "title", "summary", "compaction"] as const

export type PlusAgentPresetId = "planner" | "orchestrator" | "implementer" | "reviewer" | "scout" | "build-seat"

/** A shipped answer for one item that differs from the item's own shipped value. */
export interface PresetOverride {
  readonly state?: "on" | "off"
  readonly text?: string
  readonly pin?: boolean
}

/** Item id → override. */
export type PresetOverrides = Readonly<Record<string, PresetOverride>>

export interface PlusAgentPreset {
  readonly id: PlusAgentPresetId
  readonly label: string
  readonly description: string
  readonly mode: "primary"
  /** The preset's `system:role`: `shared` plus the role block. */
  readonly role: string
}

export interface PlusMemberPreset {
  readonly id: string
  /** The Plus agent preset the member preset is linked to (a shipped link). */
  readonly preset?: PlusAgentPresetId
  /** The member's own role body (its `system:role`). */
  readonly role: string
  readonly description: string
  readonly mode: string
}

export interface PlusTeamPreset {
  readonly id: string
  readonly label: string
  readonly members: readonly PlusMemberPreset[]
}

/** A preset as the create flows and the tree list it (data only, no UI). */
export interface PresetEntry {
  readonly ref: PresetRef
  readonly origin: PresetOrigin
  readonly kind: PresetRef["kind"]
  readonly label: string
  readonly description?: string
  readonly mode?: string
  /** Team presets: their member ids, in order. */
  readonly members?: readonly string[]
}

/** Stored records the chain reads besides the inventory records. */
export interface PresetState {
  readonly links?: readonly LinkRecord[]
  readonly entries?: readonly EntryRecord[]
  readonly presets?: readonly PresetRecord[]
}

export interface ContextInput extends PresetState {
  readonly agents: readonly AgentSource[]
  /** Discovered items: Native presets ship their native agent's role text from these. */
  readonly items: readonly Item[]
  /** Teams and their member ids (any level, enabled or not): a member without a team on its address reads these. */
  readonly teams?: readonly { readonly team: string; readonly agents: readonly string[] }[]
}

const buildSeatRole = `You are the build seat: the team's seat in the user's chat. Take the request,
decide who does it and coordinate: planning to a planner, owned execution to an
orchestrator, a small bounded piece straight to an implementer, a lookup to a
scout, a review to a reviewer. You may delegate to every member. Follow your
runs with team_status, team_wait and team_diff, answer their needs with
team_followup, and report back to the user what was done and what is left.
Do the work yourself only when delegating would cost more than it saves.`

export const plusAgentPresets: readonly PlusAgentPreset[] = [
  plusAgent("planner", "Planner", "Turns goals into exact task plans with paths and checks", teamRoles.planner),
  plusAgent("orchestrator", "Orchestrator", "Owns work, delegates by task, verifies and integrates", teamRoles.orchestrator),
  plusAgent("implementer", "Implementer", "Executes the brief inside scope and finishes", teamRoles.implementer),
  plusAgent("reviewer", "Reviewer", "Reviews diffs against the brief with findings", teamRoles.reviewer),
  plusAgent("scout", "Scout", "Finds things and reports exact file locations compactly", teamRoles.scout),
  plusAgent("build-seat", "Build seat", "Coordinates the team from the chat and may delegate to every member", buildSeatRole),
]

// ── what the Plus agent presets set (DESIGN §6) ─────────────────────────────
//
// Every former hidden team rule is an ordinary row now; these tables are the
// rows each preset answers differently from the row's own shipped value, so
// an agent linked to a preset behaves like the old role of that name did,
// and nothing is read from the agent's id.

const on: PresetOverride = { state: "on" }
const off: PresetOverride = { state: "off" }

function rows(state: PresetOverride, ids: readonly string[]): PresetOverrides {
  return Object.fromEntries(ids.map((id) => [id, state]))
}

function teamToolRows(state: PresetOverride, tools: readonly string[]): PresetOverrides {
  return rows(state, tools.map((tool) => `tool:team_${tool}`))
}

// Which runs a coordinator may address beyond its own and its children.
function reach(tools: readonly string[]): PresetOverrides {
  return rows(on, tools.flatMap((tool) => [`perm:team_${tool}:runs.descendants`, `perm:team_${tool}:runs.others`]))
}

// Secrets a team member neither reads nor searches: read's and grep's secret
// file rows and grep's include filters aimed at them.
const secretFiles = ["env", "keys", "credentials", "opencode-config", "run-configs", "databases"]
const secrets: PresetOverrides = rows(off, [
  "perm:read:env",
  ...secretFiles.filter((id) => id !== "env").map((id) => `perm:read:files.${id}`),
  ...secretFiles.map((id) => `perm:grep:files.${id}`),
  "perm:grep:include.env",
  "perm:grep:include.keys",
])

// Paths outside the checkout: read and edit's Where, the external_directory
// rule every other tool asks, and glob's and grep's search roots.
const inside: PresetOverrides = rows(off, [
  "perm:read:where.outside",
  "perm:read:where.external",
  "perm:edit:where.outside",
  "perm:glob:roots.outside",
  "perm:grep:roots.outside",
])

// An orchestrator works in its parent's checkout (a root orchestrator in the
// human's), where a stray `git stash` or `git clean` destroys work: it changes
// no files, commits or refs from the shell. Implementers change files and
// team_integrate lands their commits.
const orchestratorShell: PresetOverrides = rows(off, [
  "perm:shell:git-push",
  "perm:shell:git-commit",
  "perm:shell:git-rewrite",
  "perm:shell:rm",
  "perm:shell:commands.git-changes",
  "perm:shell:commands.git-refs",
  "perm:shell:commands.file-writes",
])

const tavily = rows(off, ["tool:search_tavily_search", "tool:search_tavily_extract"])

// A worker: no shell, no questions nobody watches, no subagents, no chat of
// its own, no further delegation.
const worker: PresetOverrides = {
  ...secrets,
  ...inside,
  ...tavily,
  ...rows(off, [
    "tool:shell",
    "tool:question",
    "tool:subagent",
    "perm:team_get_context:bootstrap.chat",
    "perm:team_delegate:access.delegated",
  ]),
}

/**
 * Per Plus agent preset: the shipped answers that differ from each item's
 * own shipped value (§3.5).
 */
export const plusAgentOverrides: Readonly<Record<PlusAgentPresetId, PresetOverrides>> = {
  planner: {
    ...secrets,
    ...rows(off, ["tool:shell", "tool:subagent", "perm:edit:allowed.*", "perm:team_delegate:access.delegated"]),
    ...teamToolRows(off, ["integrate", "checkpoint", "set_checks", "check"]),
    ...reach(["status", "wait", "list"]),
    ...rows(on, [
      "tool:question",
      "perm:edit:allowed.plans",
      "perm:team_delegate:approval.every",
      "perm:team_get_context:bootstrap.chat",
      "perm:team_get_context:accepts.plan-files",
    ]),
  },
  orchestrator: {
    ...secrets,
    ...orchestratorShell,
    ...rows(off, ["tool:question", "tool:subagent"]),
    ...teamToolRows(off, ["checkpoint"]),
    ...reach(["status", "wait"]),
    ...rows(on, [
      "tool:shell",
      "perm:team_get_context:bootstrap.chat",
      "perm:team_delegate:access.delegated",
      "perm:team_get_context:accepts.reason",
    ]),
  },
  implementer: {
    ...worker,
    ...teamToolRows(off, ["delegate", "followup", "integrate", "set_checks", "supersede", "stop", "wait", "list"]),
    ...rows(on, ["perm:team_finish:requirements.clean", "perm:team_get_context:accepts.scope-paths"]),
  },
  reviewer: {
    ...worker,
    ...teamToolRows(off, ["delegate", "followup", "integrate", "checkpoint", "set_checks", "supersede", "stop", "wait", "list", "check"]),
    ...rows(off, ["perm:team_get_context:accepts.followup"]),
  },
  scout: {
    ...worker,
    ...teamToolRows(off, ["delegate", "followup", "integrate", "checkpoint", "set_checks", "supersede", "stop", "wait", "list", "check"]),
  },
  "build-seat": {
    ...reach(["status", "wait", "list"]),
    ...rows(on, [
      "tool:shell",
      "tool:question",
      "tool:subagent",
      "perm:team_get_context:bootstrap.chat",
      "perm:team_delegate:access.delegated",
    ]),
  },
}

// The build seat "may delegate to every member": every "Delegate to" row of
// its team ships on, whoever the teammate is. Members of other teams stay off.
function buildSeatDelegates(item: string): ShippedValue | undefined {
  if (!item.startsWith("perm:team_delegate:to.") || item === "perm:team_delegate:to.other-teams") return undefined
  return { state: "on" }
}

// Who a Plus agent preset delegates to, by the teammate's own preset:
// planners hand plans to orchestrators; orchestrators split work among
// orchestrators, implementers, reviewers and scouts and never back to a
// planner. The shipped team presets turn this into their members' "Delegate
// to" rows below.
const delegation: Readonly<Partial<Record<PlusAgentPresetId, readonly PlusAgentPresetId[]>>> = {
  planner: ["orchestrator"],
  orchestrator: ["orchestrator", "implementer", "reviewer", "scout"],
  "build-seat": ["planner", "orchestrator", "implementer", "reviewer", "scout"],
}

// Which Plus agent preset each shipped team member is created from.
const memberAgentPresets: Readonly<Record<string, Readonly<Record<string, PlusAgentPresetId>>>> = {
  "opencodeplus-team": {
    "fable-planner": "planner",
    "astra-planner": "planner",
    "sol-orchestrator": "orchestrator",
    "opus-orchestrator": "orchestrator",
    "muse-implementer": "implementer",
    "gemini-implementer": "implementer",
    "spark-implementer": "implementer",
    "opus-implementer": "implementer",
    "astra-reviewer": "reviewer",
    scout: "scout",
  },
  starter: { planner: "planner", helper: "implementer" },
  review: { reviewer: "reviewer", editor: "implementer" },
}

// Member-specific answers besides "Delegate to": the rapid-loop implementer
// takes a small, justified piece with exactly one check.
const memberExtras: Readonly<Record<string, Readonly<Record<string, PresetOverrides>>>> = {
  "opencodeplus-team": {
    "spark-implementer": rows(on, [
      "perm:team_get_context:accepts.reason",
      "perm:team_get_context:accepts.check",
      "perm:team_get_context:limits.paths",
      "perm:team_get_context:limits.checks",
    ]),
  },
}

/**
 * Per Plus team preset, per member: shipped answers of the member preset
 * besides its role body — its "Delegate to" rows for its teammates (by the
 * teammates' presets) and spark's brief rows. Anything a member preset does
 * not set falls through to its agent preset.
 */
export const plusMemberOverrides: Readonly<Record<string, Readonly<Record<string, PresetOverrides>>>> = Object.fromEntries(
  Object.entries(memberAgentPresets).map(([team, members]) => [
    team,
    Object.fromEntries(
      Object.entries(members).map(([member, preset]) => {
        const targets = delegation[preset] ?? []
        const delegates = Object.entries(members)
          .filter(([peer, peerPreset]) => peer !== member && targets.includes(peerPreset))
          .map(([peer]) => `perm:team_delegate:to.${peer}`)
        return [member, { ...rows(on, delegates), ...memberExtras[team]?.[member] }]
      }),
    ),
  ]),
)

export const plusTeamPresets: readonly PlusTeamPreset[] = builtinTeams.map((team) => ({
  id: team.name,
  label: team.name,
  members: team.members.map((member): PlusMemberPreset => {
    const preset = memberAgentPresets[team.name]?.[member.id]
    const agent = plusAgentPresets.find((entry) => entry.id === preset)
    return {
      id: member.id,
      ...(preset === undefined ? {} : { preset }),
      role: member.body,
      description: member.fields?.description ?? agent?.description ?? "",
      mode: member.fields?.mode ?? "primary",
    }
  }),
}))

/** Links that ship with the Plus team presets: each member preset → its Plus agent preset. */
export const shippedLinks: readonly LinkRecord[] = plusTeamPresets.flatMap((team) =>
  team.members.flatMap((member): LinkRecord[] =>
    member.preset === undefined
      ? []
      : [
          {
            type: "link",
            level: "preset",
            agent: member.id,
            team: { level: "preset", team: team.id },
            preset: { kind: "agent", id: member.preset },
            updated: "",
          },
        ],
  ),
)

/**
 * Every preset, grouped the way the create picker lists them: Native agent
 * presets, Plus agent presets, User agent presets, then team presets (Plus,
 * then User), each followed by its member presets. A user preset whose ref a
 * shipped preset already takes is dropped (create refuses it).
 */
export function presetListing(
  presets: readonly PresetRecord[] = [],
  /** What the host reports for each native agent (mode, description), when known. */
  nativeFields: ReadonlyMap<string, { readonly mode?: string; readonly description?: string }> = new Map(),
): PresetEntry[] {
  const native = nativePresetIds.map((id): PresetEntry => {
    const fields = nativeFields.get(id)
    return {
      ref: { kind: "agent", id },
      origin: "native",
      kind: "agent",
      label: capitalized(id),
      ...(fields?.description === undefined ? {} : { description: fields.description }),
      ...(fields?.mode === undefined ? {} : { mode: fields.mode }),
    }
  })
  const plus = plusAgentPresets.map(
    (preset): PresetEntry => ({
      ref: { kind: "agent", id: preset.id },
      origin: "plus",
      kind: "agent",
      label: preset.label,
      description: preset.description,
      mode: preset.mode,
    }),
  )
  const user = presets
    .filter((record) => record.kind === "agent" && record.team === undefined)
    .map((record): PresetEntry => userEntry(record, { kind: "agent", id: record.id }, record.id))
  const plusTeams = plusTeamPresets.flatMap((team): PresetEntry[] => [
    {
      ref: { kind: "team", id: team.id },
      origin: "plus",
      kind: "team",
      label: team.label,
      members: team.members.map((member) => member.id),
    },
    ...team.members.map(
      (member): PresetEntry => ({
        ref: { kind: "member", team: team.id, id: member.id },
        origin: "plus",
        kind: "member",
        label: `${team.label} › ${member.id}`,
        description: member.description,
        mode: member.mode,
      }),
    ),
  ])
  const userTeams = presets
    .filter((record) => record.kind === "team")
    .flatMap((team): PresetEntry[] => {
      const members = presets.filter((record) => record.kind === "agent" && record.team === team.id)
      return [
        { ...userEntry(team, { kind: "team", id: team.id }, team.id), members: members.map((member) => member.id) },
        ...members.map((member) =>
          userEntry(member, { kind: "member", team: team.id, id: member.id }, `${team.id} › ${member.id}`),
        ),
      ]
    })
  const seen = new Set<string>()
  return [...native, ...plus, ...user, ...plusTeams, ...userTeams].filter((entry) => {
    const key = presetKey(entry.ref)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * The preset catalogue the chain reads (§3.2): every preset with its origin,
 * the shipped links, and the shipped content of Native and Plus presets.
 * Shipped content is computed on read and never stored:
 * - a Native preset answers every item with its upstream value (state, text,
 *   pin) and `system:role` with its native agent's prompt;
 * - a Plus agent preset answers every item with its shipped value, its
 *   overrides over that, and `system:role` with its role text;
 * - a Plus member preset answers `system:role` with its own body and its
 *   overrides; everything else falls through its shipped link.
 * No preset ships an active model yet.
 */
export function presetCatalog(input: { readonly items: readonly Item[]; readonly presets?: readonly PresetRecord[] }): PresetCatalog {
  const roles = new Map(
    nativePresetIds.flatMap((id): [string, Item][] => {
      const role = input.items.find((item) => item.id === "system:role" && item.agents?.includes(id) === true)
      return role === undefined ? [] : [[id, role]]
    }),
  )
  return {
    presets: presetListing(input.presets).map((entry) => ({ ref: entry.ref, origin: entry.origin })),
    links: shippedLinks,
    shipped: (ref, item, section, upstream) => {
      if (section !== null || ref.kind === "team") return undefined
      if (ref.kind === "member") return memberShipped(ref.team, ref.id, item)
      if (isControl(item) && (nativePresetIds as readonly string[]).includes(ref.id))
        return valueOf(input.items.find((entry) => entry.id === item && entry.agents?.includes(ref.id)))
      if ((nativePresetIds as readonly string[]).includes(ref.id))
        return valueOf(item === "system:role" ? roles.get(ref.id) : upstream)
      const plus = plusAgentPresets.find((preset) => preset.id === ref.id)
      if (plus === undefined) return undefined
      if (item === "setting:mode") return { text: plus.mode }
      if (item === "setting:description") return { text: plus.description }
      if (isControl(item)) return undefined
      const shipped = item === "system:role" ? { text: plus.role, state: "on" as const } : valueOf(upstream)
      const override = plusAgentOverrides[plus.id][item] ?? (plus.id === "build-seat" ? buildSeatDelegates(item) : undefined)
      if (override === undefined) return shipped
      return { ...shipped, ...override }
    },
    model: () => undefined,
  }
}

/**
 * The full chain context (§3.1): the scopes of the discovered agents, the
 * stored links and Defaults entries, the preset catalogue and each member's
 * teams.
 */
export function chainContext(input: ContextInput): ChainContext {
  return {
    ...scopesOf(input.agents),
    links: input.links ?? [],
    entries: input.entries ?? [],
    presets: presetCatalog({ items: input.items, presets: input.presets ?? [] }),
    memberTeams: memberTeamsOf(input.teams ?? []),
  }
}

/** Picks the records the chain reads besides the inventory out of any stored record list. */
export function presetStateOf(records: readonly { readonly type: string }[]): Required<PresetState> {
  return {
    links: records.filter((record): record is LinkRecord => record.type === "link"),
    entries: records.filter((record): record is EntryRecord => record.type === "entry"),
    presets: records.filter((record): record is PresetRecord => record.type === "preset"),
  }
}

/**
 * The members of a team preset (Plus or User) with the fields a created member
 * file copies (§5); undefined when no team preset has that id.
 */
export function teamPresetMembers(
  id: string,
  presets: readonly PresetRecord[] = [],
): readonly { readonly id: string; readonly mode?: string; readonly description?: string }[] | undefined {
  const plus = plusTeamPresets.find((team) => team.id === id)
  if (plus !== undefined)
    return plus.members.map((member) => ({ id: member.id, mode: member.mode, description: member.description }))
  if (!presets.some((record) => record.kind === "team" && record.id === id)) return undefined
  return presets
    .filter((record) => record.kind === "agent" && record.team === id)
    .map((record) => ({
      id: record.id,
      ...(record.fields?.mode === undefined ? {} : { mode: record.fields.mode }),
      ...(record.fields?.description === undefined ? {} : { description: record.fields.description }),
    }))
}

/** A preset's own node: what its edits and its link are stored under (§3.2). */
export function presetOwner(ref: PresetRef): RecordScope {
  if (ref.kind === "agent") return { level: "preset", agent: ref.id }
  if (ref.kind === "member") return { level: "preset", agent: ref.id, team: { level: "preset", team: ref.team } }
  return { level: "preset", agent: null, team: { level: "preset", team: ref.id } }
}

/**
 * The tree row id of a link owner: `agent:<level>:<id>` for an agent, an
 * agent preset or an Agents entry, `team:<level>:<team>:<id>` for a member, a
 * member preset or a Teams entry, `team:<level>:<team>` for a team.
 */
export function ownerRowId(owner: Pick<RecordScope, "level" | "agent" | "team">): string {
  if (owner.agent === null) return `team:${owner.level}:${owner.team?.team ?? ""}`
  if (owner.team !== undefined) return `team:${owner.level}:${owner.team.team}:${owner.agent}`
  return `agent:${owner.level}:${owner.agent}`
}

/** The preset `owner` is linked to: its stored link, else the link it ships with. */
export function linkOf(links: readonly LinkRecord[], owner: RecordScope): PresetRef | undefined {
  return (
    links.find((record) => scopedTo(record, owner))?.preset ??
    shippedLinks.find((record) => scopedTo(record, owner))?.preset
  )
}

/**
 * Everything linked to a preset (stored and shipped links), as owner row ids.
 * A team preset is in use when anything links to it or to one of its member
 * presets; its own members' links do not count.
 */
export function presetUsers(links: readonly LinkRecord[], ref: PresetRef): string[] {
  const inside = (record: LinkRecord) =>
    ref.kind === "team" && record.level === "preset" && record.team?.level === "preset" && record.team.team === ref.id
  const targets = (target: PresetRef) =>
    presetKey(target) === presetKey(ref) || (ref.kind === "team" && target.kind === "member" && target.team === ref.id)
  return [...new Set([...links, ...shippedLinks].filter((record) => targets(record.preset) && !inside(record)).map(ownerRowId))]
}

/**
 * The presets a link from `owner` to `target` would pass through before
 * reaching `owner` again (presetKey form), following each preset's stored
 * then shipped link; undefined when the chain never comes back (§3.2: cycles
 * are refused on write).
 */
export function linkCycle(links: readonly LinkRecord[], owner: PresetRef, target: PresetRef): string[] | undefined {
  const walk = (current: PresetRef | undefined, path: readonly string[]): string[] | undefined => {
    if (current === undefined) return undefined
    const key = presetKey(current)
    if (key === presetKey(owner)) return [...path, key]
    if (path.includes(key)) return undefined
    return walk(linkOf(links, presetOwner(current)), [...path, key])
  }
  return walk(target, [])
}

/** presetKey → the label the listing shows (`Orchestrator`, `review › editor`). */
export function presetLabels(listing: readonly PresetEntry[]): ReadonlyMap<string, string> {
  return new Map(listing.map((entry) => [presetKey(entry.ref), entry.label]))
}

/**
 * A Role/persona row for every owner no discovered `system:role` item applies
 * to (presets and Defaults entries are not agents, so discovery gives them
 * none): an empty body the owner's preset or its own edits fill.
 */
export function ownerRoleItems(items: readonly Item[], owners: readonly string[]): Item[] {
  const roles = items.filter((item) => item.id === "system:role")
  return [...new Set(owners)]
    .filter((owner) => !roles.some((item) => item.agents?.includes(owner) === true))
    .map((owner) => ({
      id: "system:role",
      kind: "system",
      group: "none",
      title: "Role/persona",
      text: "",
      enabled: true,
      fingerprint: fingerprint(""),
      agents: [owner],
    }))
}

/** `items` plus a Role/persona row for every preset and Defaults entry that has none. */
export function withOwnerRoles(items: readonly Item[], state: PresetState): Item[] {
  const owners = [
    ...presetListing(state.presets).flatMap((entry) => (entry.ref.kind === "team" ? [] : [entry.ref.id])),
    ...(state.entries ?? []).map((entry) => entry.name),
  ]
  const controls = [...new Set(owners)].flatMap((owner) =>
    controlItems(owner, {}, items.find((item) => item.id === "compaction:instructions" && item.agents === undefined)?.text)
      .filter((row) => !items.some((item) => item.id === row.id && item.agents?.includes(owner) && item.controlTeam === undefined)),
  )
  return [...items, ...ownerRoleItems(items, owners), ...controls]
}

/**
 * A Defaults entry name or pattern (§4): `*` and `%` are wildcards; like an
 * agent id it may nest with `/`, and never holds `:` (row ids split on it),
 * NUL or a line break.
 */
export function validateEntryName(raw: string): { ok: true; name: string } | { ok: false; reason: string } {
  const name = raw.trim()
  if (name.length === 0) return { ok: false, reason: "Entry name cannot be empty" }
  if (name.includes(":")) return { ok: false, reason: `Invalid entry name "${name}": colons are not allowed` }
  if (name.includes("\0") || name.includes("\n") || name.includes("\r"))
    return { ok: false, reason: `Invalid entry name "${name}": control characters are not allowed` }
  // As in an agent id, `/` only nests: a trailing `/` would read as a team
  // member's `<team>/:<member>` owner path in row ids.
  if (name.split("/").some((segment) => segment.length === 0))
    return { ok: false, reason: `Invalid entry name "${name}": empty path segment (check for leading, trailing, or double slashes)` }
  return { ok: true, name }
}

function plusAgent(id: PlusAgentPresetId, label: string, description: string, role: string): PlusAgentPreset {
  return { id, label, description, mode: "primary", role: `${teamRoles.shared}\n\n${role}` }
}

function memberShipped(team: string, id: string, item: string): ShippedValue | undefined {
  const member = plusTeamPresets.find((entry) => entry.id === team)?.members.find((entry) => entry.id === id)
  if (member === undefined) return undefined
  if (item === "system:role") return { text: member.role, state: "on" }
  if (item === "setting:mode") return { text: member.mode }
  if (item === "setting:description") return { text: member.description }
  return plusMemberOverrides[team]?.[id]?.[item]
}

function valueOf(item: Pick<Item, "text" | "enabled" | "pinned"> | undefined): ShippedValue | undefined {
  if (item === undefined) return undefined
  return { text: item.text, state: item.enabled ? "on" : "off", ...(item.pinned === undefined ? {} : { pin: item.pinned }) }
}

function userEntry(record: PresetRecord, ref: PresetRef, label: string): PresetEntry {
  return {
    ref,
    origin: "user",
    kind: ref.kind,
    label,
    ...(record.fields?.description === undefined ? {} : { description: record.fields.description }),
    ...(record.fields?.mode === undefined ? {} : { mode: record.fields.mode }),
  }
}

function capitalized(id: string): string {
  return `${id.slice(0, 1).toUpperCase()}${id.slice(1)}`
}

function memberTeamsOf(teams: readonly { readonly team: string; readonly agents: readonly string[] }[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const team of teams)
    for (const agent of team.agents) {
      const known = out.get(agent) ?? []
      if (!known.includes(team.team)) out.set(agent, [...known, team.team])
    }
  return out
}
