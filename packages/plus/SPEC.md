# Plus Instructions — Foundation Spec

Binding contract for the Instructions TUI foundation: the sections engine
(`src/instructions/sections.ts`), the level-aware inheritance model
(`src/instructions/model.ts`), and the two-store v2 record format with
migration (`src/instructions/store.ts`, `src/instructions/paths.ts`).

## Tree shape

Three top-level roots in this order: `Project`, `Global`, `Defaults`.
`Project` and `Global` each hold an `Agents` group (`[a: add agent]`) whose
children are that level's agents with the identical subtree, plus a `Teams`
group (`[a: add team]`) holding that level's on-disk teams. `Defaults` holds
`Agents` (template agents, each with the full subtree, `[a: add agent template]`),
`Teams` (built-in shipped teams with working toggles and informational
member rows, `[a: add team]` still creates at project or global, never
defaults), and then the shared inventories: `Tools`, `Base` `[a]`, `Skills`,
`System` `[a]`, `MCP` `[a: add MCP server]`.

Every agent in all three roots has the identical subtree:

```
<Agent>
  Tools
    Native / OpenCodePlus / MCP > <server>
      <tool>
        <section>
  Base                     [a: add base prompt]
    <Template>.txt         (the one matching the agent's model is marked "active")
      <section>
  Skills
    Native / OpenCodePlus / MCP > <server> / Project [a: add skill]
      <skill>
        <section>
  System                   [a: add instruction]
    Role/persona           (always first)
    <instruction>
      <section>
```

`Defaults` holds `Agents` (template agents, each with the full subtree,
`[a: add agent template]`), `Teams` (built-in shipped teams, each with
working toggles and informational member rows, `[a: add team]` still creates
at project or global, never defaults), and then the shared inventories:
`Tools`, `Base` `[a]`, `Skills`, `System` `[a]`, `MCP` `[a: add MCP server]`.

Agent sources and scopes (`model.ts`)

```ts
export type AgentScope = "project" | "global" | "defaults"
export interface AgentSource {
  readonly id: string
  readonly scope: AgentScope
  readonly path?: string
  /** id of the base prompt template active for this agent's model, e.g. "gpt" */
  readonly base?: string
}
/** { global: ids with scope "global", defaults: ids with scope "defaults" } */
export function scopesOf(agents: readonly AgentSource[]): Scopes
```

## Sections engine (`sections.ts`)

```ts
export type SplitKind = "heading" | "block" | "manual" | "whole"
export interface Section {
  readonly id: string
  readonly name: string
  readonly depth: number
  readonly start: number
  readonly end: number
}
export interface Split { readonly kind: SplitKind; readonly sections: readonly Section[] }
export interface Boundary { readonly id: string; readonly name: string; readonly start: number }
export function derive(text: string, title: string): Split
export function manual(text: string, boundaries: readonly Boundary[]): Split
export function assemble(text: string, split: Split, excluded: ReadonlySet<string>): string
export function slice(text: string, section: Section): string
```

- `derive` picks, in order: **heading** when the text contains markdown ATX
  headings at line start; else **block** when it contains XML-style blocks at
  line start (`<system_reminder>` … `</system_reminder>`); else **whole**.
- heading: `# Harness` → depth 0 id `harness`; `## Intermediate Commentary`
  under a preceding `# Communication` → depth 1 id
  `communication/intermediate-commentary`. A section runs until the next
  heading of the same or shallower depth, or end of text. Non-blank text before
  the first heading becomes a depth-0 `Preamble` (id `preamble`). Slugs are
  lowercase with non-alphanumerics collapsed to `-` and trimmed; collisions get
  `-2`, `-3`.
- block: one depth-0 section per `<tag>`…`</tag>` block at line start, id and
  name from the tag name. Text outside blocks joins the preceding section, or a
  leading `Preamble`.
- manual: exactly the boundaries given, sorted by `start`; each names the slice
  starting at its offset and running to the next boundary or end. Non-blank
  text before the first boundary becomes `Preamble`. All manual sections are
  depth 0.
- whole: one section `{ id: "whole", name: title, depth: 0, start: 0, end:
  text.length }`.
- `assemble` drops every excluded section **and its descendants** (descendant =
  id starts with `<parentId>/`), keeps the rest in original order, collapses
  blank runs left behind to a single blank line, and trims. It emits leaf
  ranges only so text covered by both a parent and its child is never doubled;
  a parent's own text (before its first child) belongs to the parent.

## Level-aware model (`model.ts`)

```ts
export type Level = "defaults" | "global" | "project"
export interface Address {
  readonly level: Level
  readonly agent: string | null // null = Defaults shared-inventory row; only valid at "defaults"
  readonly item: string
  readonly section: string | null // null = the whole item
}
export type ItemKind = "tool" | "base" | "skill" | "system" | "mcp"
export type ItemGroup = "native" | "plus" | "mcp" | "project" | "none"
export interface Item {
  readonly id: string
  readonly kind: ItemKind
  readonly group: ItemGroup
  readonly server?: string
  readonly title: string
  readonly text: string
  readonly enabled: boolean
  readonly fingerprint: string
  readonly agents?: readonly string[]
  readonly order?: number
}
```

Item id forms (documented, not enforced): `tool:<toolId>`,
`base:<templateId>` (gpt|claude|muse|gemini|general), `skill:<skillId>`,
`system:role` (the agent's own prompt body = Role/persona),
`system:<relativePath>`, `mcp:<server>`.

Resolution chain, most specific first, resolving `text` and `state`
independently — first level supplying that field wins:

| node | chain |
| ---- | ----- |
| project/A | project/A → global/A (only when a Global agent A exists) → defaults/A (only when a Defaults template A exists) → defaults/null → upstream |
| global/A | global/A → defaults/A → defaults/null → upstream |
| defaults/A | defaults/A → defaults/null → upstream |
| defaults/null | defaults/null → upstream |

Scopes are explicit input: `export interface Scopes {
readonly global: ReadonlySet<string>; readonly defaults:
ReadonlySet<string> }`.

```ts
export interface Resolved {
  readonly text: string
  readonly assembled: string // text with excluded sections dropped (whole items only)
  readonly enabled: boolean
  readonly source: Level | "upstream"
  readonly overriddenHere: boolean
  readonly modified: boolean
  readonly review: boolean
}
```

- `modified` is **text-only**: a state-only override never marks a node
  modified and never raises review, so a disabled-but-otherwise-unmodified copy
  keeps taking upstream text silently.
- `review` (yellow) is true when the node is `modified` at this level AND the
  current upstream fingerprint (resolved from the chain **above** this level)
  differs from BOTH the record's `basedOn` and its `acknowledged`.
- Sections warn independently: a modified section raises review on itself
  without raising it on sibling sections.
- Roll-up: `countReview(entries, prefix)` counts reviewable descendants under
  an address prefix so ancestors can display "N to review".

```ts
export interface ThreeWay {
  readonly original: string // record.basedOnText
  readonly mine: string
  readonly upstream: string // what the level above says now
}
export function threeWay(input: ChainInput): ThreeWay | undefined
export type Resolution = "keep" | "take" | "edit"
```

- **keep**: set `acknowledged` to the current upstream fingerprint; text
  unchanged; still modified.
- **take**: remove `text`, `basedOnText`, `acknowledged` (drop the record
  entirely if it then carries no state), so live propagation resumes and the
  node is unmodified again.
- **edit**: set `text` to the new text and set `basedOn`, `basedOnText`,
  `acknowledged` to the current upstream; still modified, review cleared.

Also exported: `merge(records, address, fields, upstream)` (apply a field
change at one address returning the full new record list), `reset(records,
address)` (remove the override at that level only), `canReset`,
`resolveSplit` (item-level manual split down the same chain, else derived),
`applies`, `fingerprint` (sha256).

**Live propagation is structural, not event-driven**: an unmodified node stores
no `text`, so it re-resolves from the chain every read and a change above is
seen with no user action.

## Store (`store.ts`, `paths.ts`)

```ts
export type RecordState = "on" | "off"
export interface CustomizationRecord {
  readonly type: "customization"
  readonly level: Level
  readonly agent: string | null
  readonly item: string
  readonly section: string | null
  readonly text?: string
  readonly state?: RecordState
  readonly basedOn: string
  readonly basedOnText?: string
  readonly acknowledged?: string
  readonly updated: string
}
export interface SplitRecord {
  readonly type: "split"
  readonly level: Level
  readonly agent: string | null
  readonly item: string
  readonly boundaries: readonly Boundary[]
  readonly updated: string
}
export type StoredRecord = CustomizationRecord | SplitRecord | TeamRecord
```

Splits belong to the **item**, not the agent, and are stored at the level they
were made; they resolve down the same chain as overrides.

Two stores, each with its own revision:

- **project** — `<project>/.opencodeplus/instructions/records.jsonl`, holds
  only `level === "project"`.
- **global** — `<globalConfigDir>/opencodeplus/instructions/records.jsonl`,
  holds `level === "global"` and `level === "defaults"`.

`paths.ts` exports `globalConfigDir()` (`OPENCODE_CONFIG_DIR`, else
`$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`), `projectRecordsPath`,
and `globalRecordsPath`.

Format: first line `{"version":2,"revision":<n>}`, then one JSON record per
line, canonically ordered and stably keyed so an unchanged save is a no-op.
Each store carries its own revision read from its own file header; a save
supplies `expectedProjectRevision` and `expectedGlobalRevision`. Writes serialize
under a process-wide async gate keyed on the resolved global records path AND
the per-project gate, acquired in a fixed order (global then project) across
read+write, so two different projects can no longer clobber the shared global
file. A stale result names the losing store as `store: "project" | "global"`.
A save only writes and bumps the store whose routed records actually changed (a
project-only save leaves the global revision untouched and vice versa; an
unchanged save leaves both files and revisions untouched).

Migration: a store file whose header lacks `"version"` is v1
(`{"revision":n}` header; records
`{item,agent,text?,state,basedOn,reviewed?,updated}`). Converted on load:
`agent === "*"` → `{ level: "defaults", agent: null }`, any other agent → `{
level: "project", agent }`; `enabled` → `"on"`, `disabled` → `"off"`,
`"inherit"` → key omitted; `reviewed` → `acknowledged`; `prompt:<agent>` →
`system:role`, `instruction:<rel>` → `system:<rel>`, `skill:`/`tool:`/`mcp:`
unchanged; `section: null`. Defaults-level records found in a v1 project file
route into the **global** store. Migration is idempotent and the first save
after a migrating load writes v2 to both stores. v1 is never written.

## §10 RPC

Methods exposed over the `opencode.plus` RPC definition (`src/rpc.ts`):

| Method | Input | Output | Errors |
| --- | --- | --- | --- |
| `project.status` | `void` | `Status` | — |
| `project.enable` | `void` | `Status` | — |
| `project.disable` | `void` | `Status` | — |
| `instructions.snapshot` | `void` | `Snapshot` | `project.disabled` |
| `instructions.refresh` | `void` | `Snapshot` | `project.disabled` |
| `instructions.mutate` | `{ expectedRevision, expectedGlobalRevision, records }` | `MutateResult` | `project.disabled` |
| `instructions.assembled` | `{ agent }` | `Assembled` | `project.disabled`, `agent.unknown` |
| `agent.create` | `{ scope, id, template?, fields?, prompt }` | `AgentRef` | `project.disabled`, `agent.exists`, `agent.invalid` |
| `agent.rename` | `{ scope, from, to }` | `RenameAgentResult` | `project.disabled`, `agent.missing`, `agent.exists`, `agent.invalid` |
| `agent.delete` | `{ scope, id }` | `AgentRef` | `project.disabled`, `agent.missing`, `agent.invalid` |
| `skill.create` | `{ name, body }` | `SkillRef` | `project.disabled`, `skill.exists`, `skill.invalid` |
| `skill.import` | `{ path }` | `SkillRef` | `project.disabled`, `skill.exists`, `skill.invalid` |
| `skill.delete` | `{ id }` | `SkillRef` | `project.disabled`, `skill.missing`, `skill.invalid` |
| `base.create` | `{ id, title, text }` | `BaseRef` | `project.disabled`, `base.exists`, `base.invalid` |
| `base.delete` | `{ id }` | `BaseRef` | `project.disabled`, `base.missing`, `base.invalid` |
| `instruction.create` | `{ name, text }` | `InstructionRef` | `project.disabled`, `instruction.exists`, `instruction.invalid` |
| `instruction.delete` | `{ name }` | `InstructionRef` | `project.disabled`, `instruction.missing`, `instruction.invalid` |
| `mcp.add` | `{ name, config }` | `McpRef` | `project.disabled`, `mcp.exists`, `mcp.invalid` |
| `mcp.remove` | `{ name }` | `McpRef` | `project.disabled`, `mcp.missing`, `mcp.invalid` |
| `team.create` | `{ level, team }` | `TeamRef` | `project.disabled`, `team.exists`, `team.invalid`, `team.create` |
| `team.setEnabled` | `{ level, team, enabled }` | `TeamRef` | `project.disabled`, `team.unknown`, `team.invalid` |

Events: `project.changed`, `instructions.changed`.

### `Assembled` Shape

`system` is the agent's installed system text read back from the host after
application (agent transforms are registry-level, so `agent.list` reflects
them). Tool entries reflect what is true at registry level
(enablement/visibility): per-agent tool text installs through a session
context hook, which is session-scoped for a specific agent, so `assembled`
cannot produce a session-scoped tool view for an arbitrary agent without
creating a session and reports the registry (upstream) description even when
the override applies correctly inside that agent's sessions.

```ts
export interface Assembled {
  readonly agent: string
  readonly system: readonly string[]
  readonly tools: readonly { readonly id: string; readonly description: string }[]
  readonly skills: readonly { readonly id: string; readonly content: string }[]
}
```

### Errors

- `project.disabled`: `{ directory: string }`
- `agent.exists`: `{ path: string }`
- `agent.missing`: `{ path: string }`
- `agent.invalid`: `{ id: string, reason: string }`
- `agent.unknown`: `{ agent: string }`
- `skill.exists`: `{ id: string }`
- `skill.missing`: `{ id: string }`
- `skill.invalid`: `{ id: string, reason: string }`
- `base.exists`: `{ id: string }`
- `base.missing`: `{ id: string }`
- `base.invalid`: `{ id: string, reason: string }`
- `instruction.exists`: `{ path: string }`
- `instruction.missing`: `{ name: string }`
- `instruction.invalid`: `{ name: string, reason: string }`
- `mcp.exists`: `{ name: string }`
- `mcp.missing`: `{ name: string }`
- `mcp.invalid`: `{ name: string, reason: string }`
- `team.invalid`: `{ team: string, reason: string }`
- `team.unknown`: `{ level: FileScope, team: string }`
- `team.exists`: `{ level: FileScope, team: string }`
- `team.create`: `{ level: FileScope, team: string, reason: string }`

## Teams (`teams.ts`, `builtin-teams.ts`, `paths.ts`, `store.ts`, `rpc.ts`)

A team is a named set of agents toggled as a unit. When a team is enabled
its agents become visible to core as real agents. Teams have three tiers:
`"project" | "global" | "defaults"`. Project and global teams are
user-authored directories on disk; defaults teams are shipped source data
from `builtin-teams.ts` with no filesystem path, never written, never
created or deleted. They can be enabled and disabled like any other team;
their records carry level `defaults` and route to the global store, and
precedence is project over global over defaults. Created teams are always
stored at project or global level, never defaults.

```ts
export type TeamLevel = "project" | "global" | "defaults"
export interface TeamRecord {
  readonly type: "team"
  readonly level: TeamLevel
  readonly team: string
  readonly enabled: boolean
  readonly updated: string
}
export interface TeamAgent { readonly id: string; readonly path?: string; readonly body?: string }
export interface DiscoveredTeam {
  readonly level: TeamLevel
  readonly team: string
  readonly path?: string
  readonly agents: readonly TeamAgent[]
}
export function validateTeamName(raw: string): { ok: true; team: string } | { ok: false; reason: string }
export function discoverTeams(
  level: TeamLevel,
  projectDirectory: string,
  registry?: readonly BuiltinTeam[],
): Promise<DiscoveredTeam[]>
export function discoverBuiltinTeams(registry?: readonly BuiltinTeam[]): DiscoveredTeam[]
export function isTeamEnabled(records: readonly TeamRecord[], level: TeamLevel, team: string): boolean
export function resolveTeams(
  discovered: readonly DiscoveredTeam[],
  records: readonly TeamRecord[],
  regular: readonly AgentSource[],
): { teams: readonly TeamContribution[]; agents: readonly AgentSource[] }
export interface TeamEntry {
  readonly level: TeamLevel
  readonly team: string
  readonly enabled: boolean
  readonly agents: readonly string[]
}
export interface SetTeamEnabledInput {
  readonly level: TeamLevel
  readonly team: string
  readonly enabled: boolean
}
export interface TeamRef {
  readonly level: TeamLevel
  readonly team: string
  readonly enabled: boolean
}
```

On-disk layout (mirrors how `projectRecordsPath`/`globalRecordsPath`
resolve): `paths.ts` exports `projectTeamsPath(directory)` →
`<projectDir>/.opencodeplus/teams` and `globalTeamsPath(configDir =
globalConfigDir())` → `<globalConfigDir()>/opencodeplus/teams`. A project or
global team is one directory `<root>/<team>/`; agent files are
`<team>/<agentId>.md` in the same frontmatter+body format `agents/files.ts`
`formatMarkdown` writes, including nested ids (`sub/agent.md` →
`sub/agent`). Defaults teams are shipped source data
(`builtin-teams.ts` exports the registry: name plus member agents with id
and markdown body, kept separate from the logic so what is shipped is
obvious); they have no filesystem path and are never written.

Validation (`validateTeamName`, same confinement style as
`validateAgentId`/`resolveInstructionPath`): rejects empty names, NUL,
absolute paths, any `/` or `\`, `.`, and anything containing `..`. Validated
names can never escape the teams directory; unvalidated input fails closed.

Discovery: project and global tiers list one entry per immediate
subdirectory, sorted by name; a team directory with no agent files is still
a team; a missing teams directory means no teams, not an error. Only `*.md`
files are members (other files are ignored), listed as `{ id, path }`
sorted by id. The defaults tier never touches the filesystem: it comes only
from the built-in registry, listed as `{ id, body }` with no `path`, sorted
by team name and member id. The registry is injectable so behaviour tests
supply fixtures instead of coupling to the shipped roster.

Membership: `isTeamEnabled` returns the matching record's `enabled`, and a
team with no record at all is DISABLED. `resolveTeams` reports each team's
enabled flag with its members plus the winning team copy per agent id as
`AgentSource` entries (`scope` = team level, `path` = team file for on-disk
members and absent for built-ins, `team` = team name; `model.ts`
`AgentSource.team` is optional and additive).

Collision rule extends the `model.ts` chain (project over global over
defaults): level rank decides first, applied both between team copies and
between a team copy and a same-id regular agent. Ties go to the established
non-team identity: a regular project agent beats a project team copy, a
regular global agent beats a global team copy, and only a team copy outranks
a defaults template. A project or global team, or an authored agent, beats a
built-in member with the same id. Among enabled team copies at the same
level with the same agent id, the lexicographically smallest team name wins.

Store persistence (`store.ts`): team records persist through the `V2Team`
schema (`type: "team"`, `level: "project" | "global" | "defaults"`, `team`,
`enabled`, `updated`) as part of `V2Record` / `StoredRecord`. Team records
route by level: `project` to the project file and `global`/`defaults` to the
global file. Canonical ordering keys team records by `["team", record.team,
record.level, String(record.enabled), record.updated]`, stably serialized so
an unchanged save is a no-op (neither file touched, neither revision moves).

RPC surface (`rpc.ts`, `index.ts`):
- `Snapshot.teams` (`readonly TeamEntry[]`, optional key in schema for older
  clients/fixtures, always emitted by server): populated by `snapshotTeams()`,
  where membership comes from disk discovery (`discoverTeams`) for
  project/global plus the built-in registry for defaults, and enablement from
  stored team records (`isTeamEnabled`). A discovered team with no record
  reads as disabled; a record with no matching team never surfaces in
  `snapshot.teams`.
- Team-record exclusion invariant: team records are deliberately EXCLUDED from
  `Snapshot.records` in `toSnapshot`. Clients inspect teams through
  `Snapshot.teams` and toggle them via `team.setEnabled`.
- Mutate-preservation invariant: `instructions.mutate` re-merges stored team
  records (`loaded.records.filter((record) => record.type === "team")`) before
  saving. A client that cannot see team records in `snapshot.records` cannot
  delete them on a mutate round-trip. Preserved records pass through `route`/`same`
  unchanged, keeping an otherwise unchanged save a no-op without moving revisions.
- `team.create` (`CreateTeamInput` → `TeamRef`): creates the team directory
  under the matching teams root (`projectTeamsPath` for `"project"`,
  `globalTeamsPath` for `"global"`); `level: "defaults"` is refused with
  `team.invalid` (shipped teams cannot be created). Creation does NOT enable:
  the new team has no record, so the next snapshot lists it as DISABLED until
  `team.setEnabled` toggles it. Gated by project mode (`project.disabled`).
  Fails with `team.invalid` on invalid name, `team.exists` when the directory
  already exists, or `team.create` when the write itself fails. Logs `team.create`
  to the owning store with the caller's actor on success only; the file write
  never moves a revision.
- `team.setEnabled` (`SetTeamEnabledInput` → `TeamRef`): toggles one team at
  any of the three tiers. Gated by project mode (`project.disabled`). Fails
  with `team.invalid` on invalid name, or `team.unknown` when the team is not
  found (no directory on disk at that level for project/global, no built-in
  with that name for defaults). A defaults record routes to the global store.
  `saveTeamRecord` replaces only the matching `(level, team)` record and leaves
  customization and split records undisturbed; toggling to an unchanged state
  stays a no-op without moving revisions. Retries once on concurrent conflict
  before raising `team.unknown`.

Implemented: the `Teams` tree group beside `Agents` under the `Project`,
`Global`, and `Defaults` roots (`tree.ts`), always present even when empty
with `[a: add team]` (the Defaults group lists real built-in rows with
working toggles and informational member rows; `add` there still creates at
project or global scope, never defaults), and TUI wiring (`state.ts`
`space` → real `team.setEnabled` + snapshot refresh, `a` → real
`team.create` + snapshot refresh; `tree-pane.tsx` on/off badge). A created
team starts disabled. Built-in teams cannot be created or deleted. Store
persistence and the RPC surface are implemented.

## §11 Tools, log, and query

Agent-facing Code Mode namespace `instructions` (`teaching.ts` pins the
user-visible contract). All tools require project mode (`project.disabled`
otherwise); no tool enables or disables project mode. Every successful write
is logged with actor `tool`.

### Tool surface

```ts
export type ToolView = "resolved" | "upstream" | "mine" | "record" | "sections" | "diff" | "assembled"
export type ToolResolve = "keep" | "take" | "edit"
export interface ListInput { readonly where?: string; readonly fields?: readonly Field[]; readonly sort?: Sort; readonly limit?: number; readonly offset?: number }
export interface ShowInput { readonly id: string; readonly view?: ToolView }
export interface SetInput { readonly id: string; readonly text?: string; readonly state?: "on" | "off"; readonly resolve?: ToolResolve }
export interface ResetInput { readonly id: string }
export interface SplitInput { readonly id: string; readonly boundaries?: readonly Boundary[]; readonly add?: { readonly name: string; readonly text: string } }
export type CreateInput =
  | { readonly kind: "agent"; readonly id: string; readonly prompt: string }
  | { readonly kind: "skill"; readonly name: string; readonly body: string }
  | { readonly kind: "base"; readonly id: string; readonly title: string; readonly text: string }
  | { readonly kind: "instruction"; readonly name: string; readonly text: string }
  | { readonly kind: "mcp"; readonly name: string; readonly config: Record<string, unknown> }
  | { readonly kind: "team"; readonly team: string; readonly level: "project" | "global" }
export interface DeleteInput { readonly id: string; readonly confirm: true }
```

- `list` returns the matching row ids (default projection `id, badges,
  source, tokens`; `limit` defaults to 40). `show` defaults to view
  `resolved`. `assembled` renders the full effective prompt and accepts agent
  row ids only (`agent:<level>:<id>`); any other id fails with
  `view.unsupported`. `diff` returns two unified diffs (original→mine and
  original→upstream) plus a one-line summary. `set` with `resolve: "keep"`
  acks upstream keeping text, `"take"` drops stored text and follows upstream,
  `"edit"` stores `text` against current upstream. `reset` deletes the
  override at that row. `split` boundaries are `{ id, name, start }` with
  character offsets into the row text; `add: { name, text }` appends a new
  trailing section. `create` writes one row per call; `create` with
  `kind: "team"` creates the team directory DISABLED (enabling stays a
  separate `set` on the team row). `delete` without
  `confirm: true` fails with `delete.unconfirmed` and writes nothing.
- Row ids (same string in the TUI filter, tool calls, the log, and error
  messages): `item:<level>:<agent|''>:<itemId>` (empty agent segment is the
  shared Defaults row), `section:<level>:<agent|''>:<itemId>:<sectionId>`,
  `agent:<level>:<id>`, `team:<level>:<name>`. `<level>` is `project`,
  `global`, or `defaults`.
- Guards: writes for agents listed in `protectedAgents` fail with
  `agent.protected`; unknown ids fail with `row.unknown`. A no-op or a
  refusal writes nothing and logs nothing.

### Log (`log.ts`, `rpc.ts`, `index.ts`)

```ts
export interface LogEntry { readonly ts: string; readonly actor: Actor; readonly op: string; readonly target: string; readonly summary: string; readonly revision: number }
export interface Actor { readonly type: "tui" | "tool"; readonly agent?: string; readonly sessionID?: string; readonly messageID?: string }
export interface LogInput { readonly where?: string; readonly limit?: number; readonly offset?: number }
export interface LogOutput { readonly entries: readonly LogEntry[]; readonly total: number }
```

- Files: project writes append to
  `<project>/.opencodeplus/instructions/log.jsonl`; global/defaults writes
  append to `<globalConfigDir>/opencodeplus/instructions/log.jsonl`. One
  JSON object per line; the summary is capped at 200 characters with newlines
  stripped.
- Append-only guarantees: logging never bumps a revision, never enters
  `records.jsonl`, and never feeds the publish fingerprint. One line is
  appended per store actually changed (a mutate touching both stores appends
  one line to each, naming only that store's changed rows); a no-op or a
  refusal appends nothing. File operations and team toggles log on success
  only, to the owning store, carrying that store's current revision (the file
  write never moves it).
- Reads (`instructions.log`, `readBoth`): both files merged newest-first
  (same-file ties break towards the later line). A missing file reads as
  empty; a corrupt line is skipped, never fatal. `total` counts filtered
  entries before offset/limit slicing; `offset`/`limit` are floored at 0
  (`NaN` means unset).
- Log `where` grammar: space-separated tokens, ANDed; `!` negates one token.
  A bare word is a case-insensitive substring over op, target, summary, and
  actor agent. Keyed tokens: `actor:tui|tool` (exact actor type),
  `agent:<text>` (substring over actor agent), `op:<text>` (substring over
  op), `target:<prefix>` (prefix over target), `session:<text>` (substring
  over actor sessionID), `since:<instant>` / `before:<instant>` over `ts`,
  where an instant is an ISO date or a `<number><s|m|h|d|w>` age before now.
  An unknown key falls back to bare-word matching of the whole token; an
  unparseable instant matches nothing.

### Query grammar (`query.ts`)

```ts
export type Field = "id" | "badges" | "source" | "tokens" | "text" | "upstream" | "record" | "label" | "path" | "updated" | "sections"
export type Sort = "tokens" | "delta" | "updated" | "label" | "id" | "-tokens" | "-delta" | "-updated" | "-label" | "-id"
export interface QueryOptions { readonly where?: string; readonly fields?: readonly Field[]; readonly sort?: Sort; readonly limit?: number; readonly offset?: number }
export interface QueryRow { readonly id: string; readonly badges?: string; readonly source?: Level | "upstream"; readonly tokens?: number; readonly text?: string; readonly upstream?: string; readonly record?: CustomizationRecord; readonly label?: string; readonly path?: string; readonly updated?: string; readonly sections?: readonly string[] }
export function query(input: MemoInput, options?: QueryOptions, memo?: Memo): { rows: QueryRow[]; total: number }
```

- Terms are space-separated and ANDed. `!key:value` negates one term.
  `key:a,b` is OR within a single key. A bare word matches case-insensitively
  over label or id. Values may be single- or double-quoted and `\`-escaped;
  an empty term or empty value throws, as does an unknown key.
- `sort:<key>` is a directive, not a filter: it cannot be negated and takes
  exactly one value. An explicit `sort` option wins over the directive. Sort
  keys are `tokens|delta|updated|label|id` with an optional `-` prefix for
  descending; ties keep tree order.
- Default projection is `id, badges, source, tokens`. `total` counts matches
  before offset/limit slicing. `offset`/`limit` must be integers ≥ 0 (else
  `bad query offset|limit`); `offset` defaults to 0, `limit` defaults to all
  matches.
- Key semantics: `kind` is `root|group|agent|team|item|section`;
  `item` is `tool|base|skill|system|mcp`; `group` is
  `native|plus|mcp|project|none`; `server` is the exact (case-insensitive)
  MCP server name; `level` is `project|global|defaults`; `agent` is a
  case-insensitive substring match, `_` is the shared (agent-less) row; `state`
  is `on|off`; `modified`/`overridden` read the row's own stored text;
  `review` includes rolled-up descendant review; `source` is
  `project|global|defaults|upstream`; `active` is the base template active
  for the row's agent model; `inactive` is a user base template that can
  never become active; `unsupported` is Code Mode tool rows (and their
  sections), whole `system:role`, and whole base rows; `codemode` reads the
  item flag; `can` is `toggle|edit|reset|remove|split`; `has` is
  `record|split|sections|text`; `id` is a case-insensitive prefix match;
  `label` is a substring; `updated` compares the row's own override (or
  split) timestamp against an ISO date or a `<n><s|m|h|d|w>` age, where
  `>`/`<` on an age mean older/newer than; `team` is the exact
  (case-insensitive) team name on agent/team rows; `acked` reads
  `acknowledged`; `excluded` is an addressed row whose effective state is
  off; `identical` is stored text equal to upstream text; `dead` is a record
  that can never apply (Code Mode tool rows, MCP text overrides, off-state
  on whole `system:role`/base rows); `shadowed` is a row whose text a more
  specific level overrides for the same scope; `orphan` is a record naming a
  missing item, agent, or section (`orphan:true` also pulls those rows into
  the candidates); `tokens` is `ceil(length/4)` of the resolved text;
  `delta` is changed lines vs upstream (0 with no stored text);
  `overriders` counts distinct agents overriding a Defaults shared row (0
  elsewhere); `text`/`upstream` are substrings over the resolved/upstream
  text. Numeric keys take `>`, `<`, `>=`, `<=`, `=` comparisons (`=` may be
  bare); boolean keys take `true|false`.
- Evaluation order: filters run sorted by rank — structural keys first
  (`kind item group server level agent overridden active inactive
  unsupported codemode can has id label updated team acked), then `state modified review source excluded`, then the
  text-dependent keys in order `identical dead shadowed orphan tokens delta
  overriders text upstream`. Structural filters never resolve row text.
- Memo: one `Memo` per snapshot input (`buildMemo`), caching whole/section
  resolves, splits, and review flags per address key plus an index of
  addresses holding stored text (addresses without one short-circuit review
  to false). Candidates walk the lazy skeleton without resolving; resolved
  and upstream text are computed lazily per candidate and cached on it. A
  caller-supplied `memo` reuses those caches.
- The TUI filter (`state.ts`) runs the same engine (`query` with
  `fields: ["id"]`) and reveals each match with its ancestor chain; gated
  Code Mode sections never surface as rows; a `where` the grammar rejects
  falls back to a label/id substring match.

### Errors

| error | meaning |
| `row.unknown` | no row has that id; `list` again for the current id |
| `agent.protected` | that agent is in `protectedAgents` |
| `delete.unconfirmed` | retry with `confirm: true` |
| `view.unsupported` | that view needs another id kind (`assembled` needs an agent row) |
| `project.disabled` | project mode is off and no tool changes that |

