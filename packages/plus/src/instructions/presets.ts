// What ships as presets (DESIGN §1, §3.4, §3.5) and the builders that turn it,
// plus the stored links, Defaults entries and user presets, into the full
// resolution context.
//
// Pure data and functions, no filesystem: the server, the TUI and the tools
// all import this module and compute the same catalogue — the client from the
// snapshot's items and records, so shipped content never crosses the wire.
import { basicDelegation, builtinTeams } from "./builtin-teams.js"
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
  type Level,
  type LinkRecord,
  type PresetCatalog,
  type PresetOrigin,
  type PresetRecord,
  type PresetRef,
  type RecordScope,
  type ShippedValue,
  type TeamRef,
} from "./model.js"

/** One Native agent preset per native opencode agent (§3.4). */
export const nativePresetIds = ["build", "plan", "general", "explore", "title", "summary", "compaction"] as const

/** The one shipped team preset and the members it carries. */
export const basicTeamId = "basic"
export type BasicMemberId = "planner" | "orchestrator" | "implementer" | "reviewer" | "scout" | "build-seat"
export const basicMemberIds: readonly BasicMemberId[] = ["planner", "orchestrator", "implementer", "reviewer", "scout", "build-seat"]

/** A shipped answer for one item that differs from the item's own shipped value. */
export interface PresetOverride {
  readonly state?: "on" | "off"
  readonly text?: string
  readonly pin?: boolean
}

/** Item id → override. */
export type PresetOverrides = Readonly<Record<string, PresetOverride>>

/** One member of the shipped Basic team preset. */
export interface PlusMemberPreset {
  readonly id: BasicMemberId
  /** The member's own role body (its `system:role`): `shared` plus its role block. */
  readonly role: string
  readonly description: string
  readonly mode: string
  /**
   * Everything the member preset sets besides role, mode, description and its
   * "Delegate to" rows (answered from what each teammate is linked to): the
   * rows the former Plus agent preset of the same name set. A member preset is
   * self-contained and links to nothing.
   */
  readonly overrides: PresetOverrides
  /** Item id prefixes the member preset ships off (tools a namespace may add to later). */
  readonly offPrefixes: readonly string[]
}

export interface PlusTeamPreset {
  readonly id: string
  readonly label: string
  readonly members: readonly PlusMemberPreset[]
}

/**
 * The retired Plus presets, for the load-time migration (`store.ts`
 * `migrateRemovedPresets`): the six Plus agent preset ids, which are also the
 * Basic member ids, and the member ids of the retired team presets
 * (`opencodeplus-team`, `starter`, `review`) that map onto a Basic member.
 */
export const retiredMemberPresets: Readonly<Record<string, Readonly<Record<string, BasicMemberId>>>> = {
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

/** The Basic member a retired Plus agent preset id names; undefined when it is no retired preset. */
export function basicMemberForRetiredAgent(id: string): BasicMemberId | undefined {
  return (basicMemberIds as readonly string[]).includes(id) ? (id as BasicMemberId) : undefined
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

// ── what the Basic member presets set (DESIGN §6) ───────────────────────────
//
// Every former hidden team rule is an ordinary row now; these tables are the
// rows each member preset answers differently from the row's own shipped value,
// so an agent linked to a member preset behaves like the old role of that name
// did, and nothing is read from the agent's id.

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

// An orchestrator's checkout is where team_integrate lands its children's
// commits (a root orchestrator's is the user's), where a stray `git stash` or
// `git clean` destroys work: it changes no files, commits or refs from the
// shell. Implementers change files and team_integrate lands their commits.
const orchestratorShell: PresetOverrides = rows(off, [
  "perm:shell:git-push",
  "perm:shell:git-commit",
  "perm:shell:git-rewrite",
  "perm:shell:rm",
  "perm:shell:commands.git-changes",
  "perm:shell:commands.git-merge",
  "perm:shell:commands.git-refs",
  "perm:shell:commands.git-worktree-add",
  "perm:shell:commands.file-writes",
])

// A planner keeps the release's main line (builtin-teams.ts, its Worktrees and
// Merges sections): from the shell it makes a purpose worktree from it and
// merges finished work into it. Every family that changes files, commits,
// refs, processes, packages, services or the network is off; git merge and
// git worktree add stay on.
const plannerShell: PresetOverrides = rows(off, [
  "perm:shell:git-push",
  "perm:shell:git-commit",
  "perm:shell:git-rewrite",
  "perm:shell:rm",
  "perm:shell:rm-rf",
  "perm:shell:env",
  "perm:shell:sudo",
  "perm:shell:chmod-chown",
  "perm:shell:curl-wget",
  "perm:shell:ssh-scp",
  "perm:shell:docker",
  "perm:shell:kubectl",
  "perm:shell:js-install",
  "perm:shell:npm-publish",
  "perm:shell:pip-install",
  "perm:shell:kill",
  "perm:shell:disk-destructive",
  "perm:shell:commands.git-changes",
  "perm:shell:commands.git-refs",
  "perm:shell:commands.file-writes",
  "perm:shell:commands.kill-by-name",
  "perm:shell:commands.interpreters",
  "perm:shell:commands.registry-run",
  "perm:shell:commands.network-tools",
  "perm:shell:commands.service-control",
  "perm:shell:commands.databases",
  "perm:shell:commands.github-cli",
  "perm:shell:commands.secret-reads",
  "perm:shell:commands.workspace-scripts",
])

const tavily = rows(off, ["tool:search_tavily_search", "tool:search_tavily_extract"])

// Tools a member's role never uses. Each costs tokens on every request and
// invites a call the role text forbids. `websearch` duplicates the search
// server's tools; the skills are the build seat's (configuration, releases,
// issue reports) and the teaching row explains the configuration tools only
// the build seat has (paths.ts teachingItemId and teachingSkillId; not imported:
// this module stays free of filesystem code).
const unused: PresetOverrides = rows(off, [
  "tool:websearch",
  "system:opencodeplus",
  "skill:instructions-tools",
  "skill:opencodeplus-release",
  "skill:report",
])

// Files a member does not change: no edit, write or patch.
const readOnly: PresetOverrides = rows(off, ["tool:edit", "tool:write", "tool:patch"])

// A worker: no shell, no questions nobody watches, no subagents, no chat of
// its own, no further delegation, no web search beyond code search.
const worker: PresetOverrides = {
  ...secrets,
  ...inside,
  ...tavily,
  ...unused,
  ...rows(off, [
    "tool:shell",
    "tool:question",
    "tool:subagent",
    "skill:pilotty",
    "perm:team_get_context:bootstrap.chat",
    "perm:team_delegate:access.delegated",
  ]),
}

// The desktop browser, the Instructions and release tools, the tool monitor
// and session management serve the user's own chat, the build seat; every
// other member ships them off. By prefix: these namespaces add tools.
const seatOnly = ["tool:browser_", "tool:instructions_", "tool:release_", "tool:monitor_", "tool:opencode_"]

/**
 * Per Basic member: the shipped answers that differ from each item's own
 * shipped value (§3.5) — what the former Plus agent preset of the same name
 * set.
 */
const memberBaseOverrides: Readonly<Record<BasicMemberId, PresetOverrides>> = {
  planner: {
    ...secrets,
    ...unused,
    ...plannerShell,
    ...rows(off, ["tool:subagent", "skill:pilotty", "perm:edit:allowed.*", "perm:team_delegate:access.delegated"]),
    // It keeps team_checkpoint: a delegated planner commits its plan file,
    // the only way the plan reaches its parent (an uncommitted new file shows
    // in no diff and lands nowhere). It keeps team_integrate: in the user's
    // chat it lands what the orchestrator it delegated to reports done, which
    // that orchestrator already verified, so it records and runs no checks.
    ...teamToolRows(off, ["set_checks", "check"]),
    ...reach(["status", "list"]),
    ...rows(on, [
      "tool:shell",
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
    ...unused,
    ...tavily,
    // It changes no source files (implementers do, team_integrate lands them);
    // it writes Brief and handoff files (the plan rows) and the tests that
    // judge its implementers, and commits only those, delegated or not.
    ...rows(off, ["tool:question", "tool:subagent", "perm:edit:allowed.*"]),
    ...reach(["status"]),
    ...rows(on, [
      "tool:shell",
      "perm:edit:allowed.tests",
      "perm:team_checkpoint:requirements.editable",
      "perm:team_get_context:bootstrap.chat",
      "perm:team_delegate:access.delegated",
      "perm:team_get_context:accepts.reason",
    ]),
  },
  // Workers address no run but their own, which team_get_context already
  // describes, so team_status is off for all three; a scout changes nothing,
  // so its own diff is always empty.
  implementer: {
    ...worker,
    ...teamToolRows(off, ["delegate", "followup", "integrate", "set_checks", "supersede", "stop", "status", "list"]),
    // The files its checks run are its delegator's (an orchestrator writes the
    // tests): it commits one only when its Brief's scope.paths names it.
    ...rows(on, ["perm:team_finish:requirements.clean", "perm:team_get_context:accepts.scope-paths", "perm:team_checkpoint:requirements.check-files"]),
  },
  reviewer: {
    ...worker,
    ...readOnly,
    ...rows(off, ["skill:opencode"]),
    ...teamToolRows(off, ["delegate", "followup", "integrate", "checkpoint", "set_checks", "supersede", "stop", "status", "list", "check"]),
    ...rows(off, ["perm:team_get_context:accepts.followup"]),
  },
  scout: {
    ...worker,
    ...readOnly,
    ...rows(off, ["skill:opencode"]),
    ...teamToolRows(off, ["delegate", "followup", "integrate", "checkpoint", "set_checks", "supersede", "stop", "status", "list", "check", "diff"]),
  },
  // The build seat is the user's chat: nobody delegates to it, so it has no
  // report to finish. It checkpoints what it may edit, like any chat run.
  "build-seat": {
    ...teamToolRows(off, ["finish"]),
    ...reach(["status", "list"]),
    ...rows(on, [
      "tool:shell",
      "tool:question",
      "tool:subagent",
      "perm:team_get_context:bootstrap.chat",
      "perm:team_delegate:access.delegated",
    ]),
  },
}

// Who a Basic member delegates to lives with the bodies that describe it
// (builtin-teams.ts basicDelegation), by member preset. A "Delegate to" row
// names a teammate, so the member preset answers it from what that teammate
// is linked to (delegateShipped), never from the teammate's id.
const delegation: Readonly<Partial<Record<BasicMemberId, readonly BasicMemberId[]>>> = basicDelegation

const delegateRow = "perm:team_delegate:to."

/**
 * Per team preset, per member: shipped answers of the member preset besides
 * its role body and its "Delegate to" rows — the rows its former agent preset
 * set. A member preset is self-contained: what it does not set falls through
 * to the item's own value, never to a hidden agent preset.
 */
export const plusMemberOverrides: Readonly<Record<string, Readonly<Record<string, PresetOverrides>>>> = Object.fromEntries(
  builtinTeams.map((team) => [
    team.name,
    Object.fromEntries(team.members.map((member): [string, PresetOverrides] => [member.id, memberBaseOverrides[member.id as BasicMemberId] ?? {}])),
  ]),
)

export const plusTeamPresets: readonly PlusTeamPreset[] = builtinTeams.map((team) => ({
  id: team.name,
  label: team.label ?? team.name,
  members: team.members.map((member): PlusMemberPreset => ({
    id: member.id as BasicMemberId,
    role: member.body,
    description: member.fields?.description ?? "",
    mode: member.fields?.mode ?? "primary",
    overrides: plusMemberOverrides[team.name]?.[member.id] ?? {},
    offPrefixes: member.id === "build-seat" ? [] : seatOnly,
  })),
}))

/**
 * Every preset, grouped the way the create picker lists them: Native agent
 * presets, User agent presets, then team presets (Plus, then User), each
 * followed by its member presets. The Plus agent group ships empty: its six
 * presets are the Basic team's member presets now. A user preset whose ref a
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
  return [...native, ...user, ...plusTeams, ...userTeams].filter((entry) => {
    const key = presetKey(entry.ref)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * The preset catalogue the chain reads (§3.2): every preset with its origin
 * and the shipped content of Native and Plus presets. Shipped content is
 * computed on read and never stored:
 * - a Native preset answers every item with its upstream value (state, text,
 *   pin) and `system:role` with its native agent's prompt;
 * - a Basic member preset answers every item with its upstream value overlaid
 *   by its overrides, `system:role` with its own body, and `setting:mode` /
 *   `setting:description` with its fields. It is self-contained: it ships no
 *   links and depends on no agent preset.
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
    shipped: (ref, item, section, upstream, agent, linked) => {
      if (section !== null || ref.kind === "team") return undefined
      if (ref.kind === "member") return memberShipped(ref.team, ref.id, item, upstream, agent, linked)
      if (isControl(item) && (nativePresetIds as readonly string[]).includes(ref.id))
        return valueOf(input.items.find((entry) => entry.id === item && entry.agents?.includes(ref.id)))
      if ((nativePresetIds as readonly string[]).includes(ref.id))
        return valueOf(item === "system:role" ? roles.get(ref.id) : upstream)
      return undefined
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

/**
 * The preset an address sits inside, when it is a preset subtree: an agent
 * preset (`preset/<id>`) or a member preset (`preset/<member>@<team>`).
 * Undefined for every other address and for a preset the listing does not
 * know. Feeds from-label.ts `own`, so a preset's own rows never read "from
 * preset <itself>".
 */
export function presetOfAddress(
  listing: readonly PresetEntry[],
  address: { readonly level: Level; readonly agent: string | null; readonly team?: TeamRef },
): { readonly ref: PresetRef; readonly origin: PresetOrigin } | undefined {
  if (address.level !== "preset" || address.agent === null) return undefined
  const ref: PresetRef =
    address.team === undefined ? { kind: "agent", id: address.agent } : { kind: "member", team: address.team.team, id: address.agent }
  const origin = listing.find((entry) => presetKey(entry.ref) === presetKey(ref))?.origin
  return origin === undefined ? undefined : { ref, origin }
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

/** The preset `owner` is linked to: its stored link, if it has one. */
export function linkOf(links: readonly LinkRecord[], owner: RecordScope): PresetRef | undefined {
  return links.find((record) => scopedTo(record, owner))?.preset
}

/** True when a link to `target` points at `ref` (a team preset's members included). */
export function targetsPreset(target: PresetRef, ref: PresetRef): boolean {
  return presetKey(target) === presetKey(ref) || (ref.kind === "team" && target.kind === "member" && target.team === ref.id)
}

/**
 * Everything linked to a preset, as owner row ids. A team preset is in use
 * when anything links to it or to one of its member presets. `exists` filters
 * out owners that are gone: their links are orphans a delete may ignore (and
 * clean up) rather than be refused by.
 */
export function presetUsers(
  links: readonly LinkRecord[],
  ref: PresetRef,
  exists?: (owner: LinkRecord) => boolean,
): string[] {
  return [
    ...new Set(
      links
        .filter((record) => targetsPreset(record.preset, ref) && (exists === undefined || exists(record)))
        .map(ownerRowId),
    ),
  ]
}

/**
 * The presets a link from `owner` to `target` would pass through before
 * reaching `owner` again (presetKey form), following each preset's stored
 * link; undefined when the chain never comes back (§3.2: cycles are refused
 * on write).
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

/** presetKey → the label the listing shows (`Build`, `Basic › planner`). */
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

// A Basic member preset ships every item: the item's own value overlaid by the
// member's overrides, exactly as the retired agent preset did, so an agent
// linked to a member preset keeps every row it had. Controls and sections are
// not shipped (they resolve from records and configuration).
function memberShipped(
  team: string,
  id: string,
  item: string,
  upstream: Pick<Item, "text" | "enabled" | "pinned"> | undefined,
  agent?: string | null,
  linked?: (agent: string) => readonly PresetRef[],
): ShippedValue | undefined {
  const member = plusTeamPresets.find((entry) => entry.id === team)?.members.find((entry) => entry.id === id)
  if (member === undefined) return undefined
  if (item === "system:role") return { text: member.role, state: "on" }
  if (item === "setting:mode") return { text: member.mode }
  if (item === "setting:description") return { text: member.description }
  if (isControl(item)) return undefined
  const override =
    (item.startsWith(delegateRow) && item !== `${delegateRow}other-teams`
      ? delegateShipped(team, member.id, item.slice(delegateRow.length), agent, linked)
      : undefined) ??
    member.overrides[item] ??
    (member.offPrefixes.some((prefix) => item.startsWith(prefix)) ? off : undefined)
  const shipped = valueOf(upstream)
  if (override === undefined) return shipped
  return { ...shipped, ...override }
}

// "Delegate to <teammate>": a build seat opens every teammate but itself; any
// other member opens a teammate linked (directly, through a user preset or
// through a Defaults entry) to a member preset of its own team preset that it
// delegates to. Its own row is another run of itself, answered the same way.
// Ids decide nothing: a teammate called "implementer" that is linked to the
// reviewer preset is a reviewer.
function delegateShipped(
  team: string,
  member: BasicMemberId,
  teammate: string,
  agent: string | null | undefined,
  linked: ((agent: string) => readonly PresetRef[]) | undefined,
): ShippedValue {
  if (member === "build-seat") return teammate === agent ? off : on
  const targets: readonly string[] = delegation[member] ?? []
  if (targets.length === 0 || linked === undefined) return off
  return linked(teammate).some((ref) => ref.kind === "member" && ref.team === team && targets.includes(ref.id)) ? on : off
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
