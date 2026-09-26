# Plus Instructions — Foundation Spec

Binding contract for the Instructions TUI foundation: the sections engine
(`src/instructions/sections.ts`), the level-aware inheritance model
(`src/instructions/model.ts`), and the two-store v2 record format with
migration (`src/instructions/store.ts`, `src/instructions/paths.ts`).

## Tree shape

Four top-level roots in this order: `Project`, `Global`, `Defaults`,
`Presets` (DESIGN §2; §"Presets root" below). Each of the first three
roots holds exactly two **catalogues**, `Agents` (`group:<level>:agents`,
`[a: add agent]`) and `Teams` (`group:<level>:teams`, `[a: add team]`). A
catalogue owns its population and, at `Defaults`, its own shared inventory, and
a row resolved through one catalogue never reads the other's inventory
(`model.ts` `resolutionChain`).

```
Defaults
  Agents                                    group:defaults:agents
    OpenCode / Special / Plus / User        (unchanged agent subtrees)
    Models · Tools · Base · Skills · System · MCP     group:defaults::<category>
  Teams                                     group:defaults:teams
    <team> > <member>                       (unchanged team subtrees)
    Models · Tools · Base · Skills · System · MCP     group:defaults:/teams:<category>
```

`Project` and `Global` carry the same two catalogue roots holding their own
agents and teams; only `Defaults` carries shared inventories, because
`{ level: "defaults", agent: null }` is the one address the resolution chain
falls through to.

The `Agents` catalogue's children are the origin subgroups (`OpenCode`, `Plus`,
`User`, with `Special` nested under `OpenCode`: `group:<level>:agents:native`,
`group:<level>:agents:native:special`, `group:<level>:agents:plus`,
`group:<level>:agents:user`, all always emitted even when empty; agent rows
keep `agent:<level>:<id>`; `add: "agent"` sits on the `Agents` group and the
`User` subgroup, never on `OpenCode`/`Special`/`Plus`) holding that level's
agents with the identical subtree. The `Teams` catalogue holds that level's
teams, whose team rows (`team:<level>:<team>`, `add: "agent"`) hold member
rows (`team:<level>:<team>:<member>`, `add: "agent"`) expanding to the same
five agent groups. At `Defaults` the `Agents` catalogue's `User` subgroup
holds the Agents **entries** (`agent:defaults:<name-or-pattern>`, `[a: add
entry]` on the Agents group and its User subgroup) and the `Teams` catalogue
holds the Teams entries: one row per team pattern (`team:defaults:<pattern>`,
`[a: add member entry]`, removable = every member entry of the pattern) with
its member entries (`team:defaults:<pattern>:<name>`); an injected Defaults
team registry (tests only; none ships) lists its teams with working toggles
and the entries of a pattern equal to its name. `[a]` on the Defaults Teams
group adds a team entry (team pattern, member pattern, preset: §"TUI create,
link and review" below). Entry rows address `defaults/<name>` (Teams:
`defaults/<name>@<pattern>`, catalogue teams) and are removable
(`entry.delete`). Built-in OpenCode and Special agents
project under the Project, Global and Defaults roots with row id `agent:<level>:<id>` and are not
removable (`actions.remove === false`). Ancestor-backed project agents are
discovered through core's upward `.opencode` walk, are file-backed, and are not
removable (`AgentEntry.ancestor: true` suppresses deletion because deletion is
confined to the local project). Team member rows carry `add: "agent"` and are
removable when on-disk (project/global, invoking `team.removeAgent`) while
Defaults registry members are refused (`actions.remove === false`). Team
create from a `group:<level>:teams` row takes that level (name, then team
preset; no scope dialog); on the Defaults Teams group `a` creates a team entry
instead.

Every agent in the three level roots, every Defaults entry and every preset has the identical subtree:

```
<Agent>
  Models
    <model>
  Tools
    OpenCode / OpenCodePlus
      <tool>
        Description            (its one section, relabelled; several sections hang under a Description group)
        Permissions            (omitted when the tool lists no row for this owner)
          <category>
            <row>
      Code Mode                (only when that origin has Code Mode rows)
        <namespace>
          <tool>
            Description · Permissions
    MCP > <server>
      <tool>
        Description · Permissions
      Code Mode                (rows directly, no namespace level)
        <tool>
          Description · Permissions
    Other permissions        (team members only: role rows whose tool this inventory lacks)
  Base                     [a: add base prompt]
    <Template>.txt         (the one matching the agent's Plus-active model is marked "active")
      <section>
  Skills
    OpenCode / OpenCodePlus / MCP > <server> / Project [a: add skill]
      <skill>
        <section>
  System                   [a: add instruction]
    Role/persona           (always first)
    <instruction>
      <section>
```

Team member rows (`tree.ts` `lazyTeamMember`): under Teams → `<team>` at
every level, each member row (`team:<level>:<team>:<member>`, kind `"team"`,
no address, no toggle) carries `add: "agent"` and is removable when on-disk
(project/global, invoking `team.removeAgent`) while Defaults registry members
are refused (`actions.remove === false`). Each member
row expands to the same five groups an Agents-group agent renders (Models,
Tools, Base, Skills, System, in that order) with working toggle/edit/reset on
their rows, whether or not the team is enabled and whether or not the host
registered the agent. The owner for those groups is the bare member id with
the registered agent when one exists
(`ctx.agents.find(a => a.id === member && a.scope === level) ?? find(a => a.id === member) ?? null`),
so shared items (`agents === undefined`) populate for unregistered members
while `system:role` appears only for registered ones. A member's rows address
the same records as its Agents-catalogue rows (level + agent + item, and
`address.agent` stays the bare agent id), so an edit made under Teams and one
made under Agents are one record — but they resolve through different
catalogues, so they carry their own ids under the member's owner path:
`group:<level>:<team>/:<member>:models|tools|base|skills|system` for the five
groups (with nested Tools/Skills subgroup ids extending those prefixes) and
`item:<level>:<team>/:<member>:<itemId>` /
`section:<level>:<team>/:<member>:<itemId>:<id>` for their rows, whose address
carries `catalogue: "teams"` and `memberOf: { level, team }`. `memberOf` makes
the row resolve with its own team exactly as apply resolves that member
(`L/A@T` first, the team-scoped link of T, T's Teams entries), so a member of an
enabled team never shows a same-id disabled team's link, and team-scoped
overrides are in the displayed chain; the address's own node (what edits,
resets and model activations write) stays the per-agent `L/A`. The flat `item:<level>:<member>:<itemId>` id
still resolves: it is the stand-alone Agents-catalogue row for the same agent.
`dialogs.tsx` `scopeFromModelsGroup` accepts the `<team>/:<member>` owner form
and strips the `<team>/:` prefix so `a` on a member's Models group adds for the
member id; for a member preset, a Teams entry member and a team's Special agent
(whose records are team-scoped) it also passes `team: {level, team}`, so `a` on
a member preset's Models group adds `model.add {level: "preset", agent,
team: {level: "preset", team}}` with no prompts.

### Presets root (`tree.ts` `lazyPresetRoot`)

```
Presets                               root:preset
  Agents                              group:preset:agents
    OpenCode / Plus / User            group:preset:agents:native|plus|user   (User: [a: add preset])
      <preset>                        agent:preset:<id>   (label: the preset's label; five groups)
  Teams                               group:preset:teams
    Plus / User                      group:preset:teams:plus|user          (User: [a: add team preset])
      <team preset>                   team:preset:<team>  (User: [a: add member preset])
        <member preset>               team:preset:<team>:<member>  (five groups)
```

Agent preset rows address `preset/<id>`; member preset rows
`preset/<member>@<team>` (`team: {level:"preset", team}`, catalogue teams)
under the owner path `<team>/:<member>`. Only User presets carry `remove`
(`preset.delete`, refused while in use). A live run's edit-scope rows never
list under a preset of the same id. Presets and Defaults entries get the
Role/persona row discovery gives every agent (`presets.ts` `withOwnerRoles`).

Every agent, member, team, entry and preset row carries `owner`: the link
owner (`level`, `agent`, `team?`) `link.set` addresses, the preset
(`{ref, origin}`) or entry (`{catalogue, team?, name?}`) it is, and `link`, the
preset it is linked to now. Item, perm, section and model rows carry
`badges.from` (where the on/off state came from, `model.ts` `From`),
`badges.textFrom` (when the text came from elsewhere), `badges.fromLabel`
(`from-label.ts`: "from preset Orchestrator", "from default *orchestrator*",
"from Defaults (every agent)", "OpenCode", "upstream", "off by default", "set
here", "from global") and `badges.reviewOf` (the parts to review). A model row
whose own active record recorded an active model above that has since changed
is to review.

### TUI create, link and review (`tui/instructions/dialogs.tsx`, `route.tsx`, `tui/preset-picker.ts`)

The human's flow everywhere (DESIGN §5): `a` → a name → a preset → done; no
template, prompt, model or mode step. The preset picker (`pickAgentPreset`,
title `Preset`) groups its options by `category`: `Agent presets · OpenCode`,
`Agent presets · Plus`, `Agent presets · User`, `Team preset members` (titles
`<team> › <member>`), then `None — everything off` (no category, value
`__none__` → no `preset`). The team preset picker (`pickTeamPreset`, title
`Team preset`) groups `Plus` / `User` and ends with `Empty team`
(value `""` → no `preset`).

| cursor | dialogs | call |
| --- | --- | --- |
| Project/Global `Agents` or its `User` subgroup (any row under Project/Global via the generic `Add` → Agent) | prompt `Create agent` → `Preset` | `agent.create {scope: the row's root, id, preset?}`; the new row is revealed and selected |
| Project/Global `Teams` | prompt `Team name` → `Team preset` | `team.create {level: the row's root, team, preset?}`; row revealed |
| a team row or member row at Project/Global | prompt `Member name` → `Preset` | `team.addAgent {level, team, id, preset?}` |
| Defaults `Agents` or its `User` subgroup | prompt `Agent name or pattern` (`* and % match any text, case-insensitive (e.g. *orchestrator*)`) → `Preset` | `entry.create {catalogue: "agents", name, preset?}` |
| Defaults `Teams` | prompts `Team name or pattern` → `Member name or pattern` → `Preset` | `team.addAgent {level: "defaults", team: pattern, id: pattern, preset?}` (a team pattern is a row only while it has a member entry) |
| a Defaults team entry row or member entry row | prompt `Member name or pattern` → `Preset` | `team.addAgent {level: "defaults", team: the row's team PATTERN (its owner), id, preset?}` |
| Presets → Agents → `User` | prompt `Preset name` → `Base preset` (the agent picker, incl. None) | `preset.create {kind: "agent", id, from?}` |
| Presets → Teams → `User` | prompt `Team preset name` → `Team preset` (incl. `Empty team`) | `preset.create {kind: "team", id, from?}` |
| a User team preset row | prompt `Member name` → `Preset` | `preset.addMember {team, id, from?}` |
| any Models group (agent, member, entry, preset, member preset) | `Model provider` → `Model` (→ `Variant`) | `model.add` at the group's owner, team-scoped where its rows are |
| outside Project/Global (generic `Add` → Agent/Team) | … then `Agent scope` / `Team scope` last | as above |

A created row is revealed (`state.reveal`: its ancestors expand and it is
selected as soon as a snapshot carries it; moving the cursor drops the wish).

The palette `Create agent` (`tui/agents/create.tsx`) has no cursor: prompt
`Create agent` → `Agent scope` (Project / Global) → `Preset` → `agent.create`,
then navigates to the new agent.

**`l` relink.** Bound on every row whose `owner` is linkable (`isLinkable`: an
agent, member or team at Project/Global, a Defaults entry, a User preset or
member preset; never a Teams entry pattern row, an OpenCode/Plus preset or an
OpenCode agent's Defaults row). An agent-like owner gets `pickAgentPreset` with
title `Link to preset`, the current link as `current`, and `None — unlink`; a
team owner (`agent: null`) gets `pickTeamPreset` with title `Link to team
preset` and `None — unlink`. The choice calls `link.set {level, agent, team?,
catalogue?, preset | null}`; success toasts `Linked <row> to <Label> (<Origin>)`
or `Unlinked <row>`, a refusal (`link.cycle`, `agent.protected`,
`preset.readonly`, `link.invalid`) toasts the server's message.

**`d` on a User preset or entry** calls `preset.delete {ref}` /
`entry.delete`; a refusal is toasted, and a `preset.inUse` refusal names the
users (`data.users`, appended when the message does not already name them).
When every user is in another project (`data.elsewhere`), a second confirm
(`Delete preset <name> anyway?`) names them and, on yes, calls
`preset.delete {ref, confirm: true}`. An owner linked to a deleted preset shows
the warning badge `missing preset`.

**Tree pane.** An inheriting row shows its `badges.fromLabel` as a dim suffix
after its badges (`shell [on] · from preset Orchestrator`), never when the row
sets the value itself (`set here`). The review badge reads through
`reviewLabel`: `to review`, `to review (state)`, `to review (text, state)`; a
model row's review reads `review`. Both colours follow the theme role: the
suffix is secondary text (`text.subdued`), every review label the warning
feedback token it always had.

**Detail pane.** The provenance line names state and text sources in the same
words: `state and text: from preset Orchestrator`, or `state: from preset
Orchestrator · text: upstream` when they differ; a value this level sets reads
`set here (Project)`; model rows `active model: …` / `candidate: …`. Owner rows
add `Created from preset: Orchestrator (Plus)` or `No preset` (nothing for a
shipped preset of its own). Defaults entry rows add what they match: `matches
agents named: <pattern>` / `matches members named: <m> in teams named: <t>` /
`matches teams named: <t>`, then `matching now: …` computed from the snapshot's
agents and teams with `matchesName`.

**Review (§3.6).** Enter on a review row whose `reviewOf` holds `state` or
`pin` opens a choice (title `Review "<row>"`): `Keep yours (<yours>)` →
`resolveReview keep` limited to those parts (the value above is re-recorded),
`Take <from label> (<above>)` (e.g. `Take from preset Orchestrator (on)`) →
`take` limited to those parts; values read `on`/`off` and `pinned`/`not
pinned`. With `text` under review too, the three-way diff opens after the
choice for the text. A text-only review opens the diff as before. A model row
under review offers `Keep yours (<model>)` (`acknowledgeActiveModel`: your
active model re-records the model above) and `Take <from label> (<model
above>)` (`clearModelActive`). The hint line shows `enter review` on review
rows and `l link` where `l` is bound.

### Catalogues (`model.ts`, `tree.ts`, `store.ts`)

`Catalogue` is `"agents" | "teams"`, and absent always means `"agents"` — so
every address, record and row id written before the split keeps its exact
bytes and its exact meaning.

- **Resolution.** `resolutionChain` ends in the shared inventory of ONE
  catalogue: `{ level: "defaults", agent: null, catalogue }` where `catalogue`
  is the address's own, or `"teams"` when the address carries a `team`. A
  stand-alone agent therefore inherits only the Agents catalogue's "everyone"
  rows and a team member only the Teams catalogue's, then its team, then
  itself. An agent that is both resolves differently depending on which it was
  launched as (`apply.ts` sets `team` for agents that come from an enabled
  team); the detail pane names the catalogue on every addressed row.
- **Records.** Only the shared inventory is per catalogue: `catalogue` is
  written on `customization`, `split`, `model` and `rule` records with
  `agent === null`, never on a per-agent record, which is one record both
  catalogues read (`catalogueMatches`, `catalogueField`).
- **Row ids.** The catalogue rides in the owner position the grammar already
  has: `item:<level>::<itemId>` is the Agents inventory (unchanged) and
  `item:<level>:/teams:<itemId>` the Teams one; group ids likewise
  `group:defaults::<category>` and `group:defaults:/teams:<category>`. Agent
  ids forbid `:` and never start with `/`, so `/teams` can never collide.
- **Migration.** `store.migrateCatalogues` runs on every `load`: a store where
  no record carries a `catalogue` is pre-split, so every shared Defaults row is
  duplicated into the Teams catalogue and everything that applied to everyone
  before still applies to everyone. `load` reports `cataloguesMigrated`;
  `ensureCatalogues` persists it as one revision and `index.ts` appends one
  `op: "migrate.catalogues"` log line (target `root:defaults`) naming that
  revision. Idempotent: the copies carry `catalogue: "teams"`, so later loads
  find nothing to do and log nothing.
- **Deferred.** MCP server enablement is host-global (one `ctx.mcp` config), so
  `apply.ts` reads it from the Agents catalogue; the Teams catalogue's `MCP`
  rows exist for parity and their enablement is not applied separately.

Code Mode grouping (`tree.ts`): inside each origin group, Code Mode tools
sit under a `Code Mode` subgroup; below OpenCode and OpenCodePlus it holds one
group per tool namespace (sorted like the server groups) with
namespace-less tools hanging directly off it, while below an MCP server the
rows hang directly off it and the namespace level is skipped (every tool of
one server already shares one namespace). The origin subgroup id appends
`:codemode` to its origin group (`…:tools:<origin>:codemode`), namespace
groups append `:<namespace>` (`…:codemode:<namespace>`), and MCP servers
hold rows directly under `…:mcp:<server>:codemode`. Empty subgroups are
never emitted: the caller skips the group when there are no rows, and every
namespace group comes from a row so it is non-empty by construction. The
synthetic `execute` row (`tool:execute`) is a plain OpenCode row, toggle-only:
its text is host-owned and not editable, and it carries no other affordance.
It has no Description; its only child is its Permissions group (Limits →
Tool calls per run).

Models group (`tree.ts` `lazyModels`): first child of every agent subtree
and first shared Defaults inventory. The group id is
`group:<level>:<agent|''>:models` (the shared Defaults group is
`group:defaults::models`); it carries `add: "model"`. Rows are the union
down the chain (deduplicated) plus the agent's upstream model, each with a
`source` badge naming the level it came from. Toggle activates exclusively
at this level (creating the local row when the candidate is inherited),
remove deletes the row at this level only; no edit, split, or pin. `active`
marks the resolved winner down the chain (or upstream when nothing is
active).

Tool rows (`tree.ts` `lazyItem`, `toolPermissions`): every tool row, Code
Mode and MCP included, expands into Description and Permissions.

- **Description** is the tool's text. A text that splits into one section is
  that section row itself, relabelled `Description` (its id is unchanged, e.g.
  `section:<level>:<owner>:tool:<id>:whole`, and it keeps the section
  toggle/edit/reset). A text with several sections hangs them under a
  `Description` group (`group:<level>:<owner>:tool:<id>:description`) that
  carries the tool's own address, so its detail shows every section combined,
  and offers no action of its own. Other item kinds keep their sections as
  direct children. The `execute` row has no Description.
- **Permissions** (`group:<level>:<owner>:tool:<id>:permissions`) holds one
  group per category (`…:permissions:<category>`, labelled by
  `permission-catalog.ts` `categoryLabel`), each holding that category's rows
  (`toolPermissionRows`). `<owner>` is the owner segment of the tool's row id
  (`''`, `/teams`, an agent id, `<team>/:<member>`, `<team>/:special:<id>`).
  The group is omitted when the tool lists no row for this owner: a shared
  (owner-less) row lists only rows with no `agents`, an owner's row the rows
  that apply to it. A row lists under `hostOf(permTool)` — its own tool, except
  `external_directory` (under read), `task` (under subagent) and `search`
  (under search_tavily_search) — and a row whose category carries `alsoUnder`
  lists again under each of those tools with the row id
  `item:<level>:<owner>:perm:<tool>:<rule>@<alias>` (edit's Protected files and
  Where under write and patch): one permission, one address and one record, a
  distinct row id per listing. Categories follow `categoryOrder(tool)`:
  Delegate to, Runs, Access, Team role, the tool's legacy category, the
  categories shared into it (under write and patch: edit's Files, Protected
  files and Where, with edit's labels), the catalog's categories in catalog
  order, Approval, Rules, Mentioned in instructions, then any other category
  by id (Run edit scopes).
  Inside a category the fallback
  ("Everything else") row comes first, then `byOrderTitle` (mined rows keep the
  miner's most-mentioned-first rank; catalog rows carry `1000 + categoryIndex *
  100 + rowIndex`, so they follow curated rows). Building the groups resolves
  nothing; `toolPermRows` returns the same rows flat.
- **Other permissions** (`group:<level>:<owner>:tools:policy`, the id the old
  `Policy` group had) sits last in the `Tools` group of an owner with team role
  rows and holds only the role rows (`policy`) whose host tool this owner's
  inventory lacks; it is omitted when every row found its tool.

Only OpenCode/Plus, non-Code-Mode, non-`execute` tool rows offer a user rule
(`canHostPermRules`): MCP resources are always `"*"` and Code Mode denies are
whole-tool, so a user rule — a core rule — there would never match core
evaluation. The other tools' Permissions list catalog rows, which the tool
hook enforces on the call's input (Permission rules, below). A tool row that can host rules
carries no direct `add`: `a` presents the Section / Permission rule choice
(`dialogs.tsx` `addFor`); every other splittable row keeps `add: "section"`.
Scope and tool derive from the tool or perm row address
(`scopeFromToolOrPermRow` / `toolFromToolOrPermRow`). A user rule lists in its
tool's legacy category (below), else in Rules.

`enter` on a perm row (`route.tsx`) depends on the row:

- a limit or bound row (`permission-catalog.ts` `isValueRow`: `permKind:
  "limit"`, or a `team` row of a `limits` category whose text holds a number)
  prompts for the number (titled with the row label, `A number. Space switches
  the cap off and on.`, prefilled with the resolved text) and saves the first
  integer of the answer as the row's text through `saveText`; an answer with no
  number toasts `"<label>" takes a number`. Space still switches the cap off
  and on, and the number stays for when it is switched back on;
- a row with no patterns (values, parameters, approvals, team switches) toasts
  `"<label>" is a switch: space turns it on or off`;
- every other perm row opens the rule editor (label → patterns → keywords →
  message, each prefilled; tool and rule id come from the snapshot item's
  `permTool`/`ruleId`, the message from the rule record, level and agent from
  the row address), persisting through `rule.update`, which upserts a
  `RuleRecord` by `tool` + `id` — so editing a curated, mined or catalog row
  materialises a custom override of the same identity.

The hint line says `enter edit number`, `space switch` or `enter edit rule`
accordingly. The detail pane (`detail-pane.tsx`) prints `enforced by:
<enforcementLine>` under a perm row's `tool: … · rule: …` line (the kinds
table under Permission rules gives each line), `Every permission of <tool>,
one group per category. Rows are on/off; enter edits a rule's patterns or a
limit's number.` on a Permissions group, and `categorySummary` on a category
group.

Agent sources and scopes (`model.ts`)

```ts
export type AgentScope = "project" | "global" | "defaults"
export type AgentOrigin = "native" | "special" | "plus" | "user"
export interface AgentSource {
  readonly id: string
  readonly scope: AgentScope
  readonly origin?: AgentOrigin
  readonly path?: string
  /** id of the base prompt template active for this agent's Plus-active model, e.g. "gpt" */
  readonly base?: string
}
/** { global: ids with scope "global", defaults: ids with scope "defaults" } */
export function scopesOf(agents: readonly AgentSource[]): Scopes
```

Origin is computed server-side in `discover.ts` (`special` for
`title|summary|compaction`, `native` for `build|plan|general|explore`, else
`user`; file-backed agents are always `user`) and upgraded to `plus` in
`index.ts` `toSnapshot` when the id is in `plusTeamOutputIds` or the source
carries `team`. It crosses the RPC boundary on `AgentEntry.origin` and is
carried through `snapshot.ts` `agentOf` into `tree.ts` `lazyAgentsGroup`,
which groups by that carried value (never by hardcoded ids or path/team
heuristics in the tree layer). Hidden is a visibility setting and does not
make an agent Special. OpenCode is the displayed inherited origin; stored
`native` row ids, API discriminators and `group:native` filters remain
compatible. OpenCode ships agent presets but no team presets, so Presets →
Teams has only Plus and User categories. Ancestor-backed project agents are discovered
through core's upward `.opencode` walk, are file-backed, and carry
`AgentEntry.ancestor: true` across the RPC boundary; because
`existingAgentPath` confines deletion to the project directory and cannot
resolve ancestor paths, ancestor rows suppress the delete action
(`actions.remove === false`).

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
export type Level = "defaults" | "global" | "project" | "preset"
export interface Address {
  readonly level: Level
  readonly agent: string | null // null = Defaults shared-inventory row; only valid at "defaults"
  readonly item: string
  readonly section: string | null // null = the whole item
}
export type ItemKind = "tool" | "base" | "skill" | "system" | "mcp" | "model" | "perm"
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
  /** True for user-created base templates (deletable, never the host active answer). */
  readonly userBase?: boolean
  /** True for Code Mode tools: applied through deny rules and the catalog hook. */
  readonly codemode?: boolean
  /** The Code Mode namespace the tool is grouped under (`tool.options.namespace`). */
  readonly namespace?: string
  /** The tool registry's own default pin (`tool.options.pinned`), i.e. the upstream value a user pin overrides. */
  readonly pinned?: boolean
  /** Marks the single synthetic host-owned `execute` row. Only discovery ever sets it, always `true`. */
  readonly execute?: boolean
  /** Perm rule rows only: the parent tool id (e.g. "shell", "edit", "subagent"). Only discovery ever sets it. */
  readonly permTool?: string
  /** Perm rule rows only: the rule id within its tool (e.g. "git-push"). Only discovery ever sets it. */
  readonly ruleId?: string
  /** Perm rule rows only: core wildcard patterns denied when the row is off. Only discovery ever sets it. */
  readonly patterns?: readonly string[]
  /** Perm rule rows only: whole-word scrub keywords derived via keywordsForPattern. Only discovery ever sets it. */
  readonly keywords?: readonly string[]
  /** Perm rule rows only: item ids whose text mentioned this rule, most-mentioned first. Only discovery ever sets it. */
  readonly provenance?: readonly string[]
  /** Perm rule rows only: true when the row comes from a user RuleRecord. Only discovery ever sets it. */
  readonly custom?: boolean
  /** Perm rows only: the Permissions category of the tool the row is listed under (e.g. "commands", "files", "to"). */
  readonly category?: string
  /** Perm rows only: how the row is enforced. Absent means "rule": core rules on `permAction`. */
  readonly permKind?: PermKind
  /** input/value/param/limit/approval rows: the input field the row reads (dotted path; `[]` walks an array). */
  readonly field?: string
  /** value rows: the literal the row allows. param rows: the value that counts as using the parameter (absent: any value). */
  readonly value?: string | number | boolean | null
  /** An allow-list row: while on it lets its patterns through a category whose fallback is off. */
  readonly allow?: boolean
  /** limit rows: what the number in the row's text caps, and what a call above it gets. */
  readonly measure?: "value" | "length" | "count"
  readonly mode?: "clamp" | "refuse"
  /** Refusal text of catalog and team rows; curated and user rules keep theirs in tool-permissions.ts and RuleRecords. */
  readonly message?: string
  /** True for a category's "Everything else" row. */
  readonly fallback?: boolean
  /** Other tool ids whose Permissions list this same row. */
  readonly alsoUnder?: readonly string[]
}
export type PermKind = "rule" | "input" | "value" | "param" | "limit" | "approval" | "env" | "team"
```

`Item` also carries `permAction`, `policy` and `runID` on perm rows (team
rules, below). What each `PermKind` means and who enforces it is under
Permission rules.

Item id forms (documented, not enforced): `tool:<toolId>`,
`base:<templateId>` (gpt|claude|muse|gemini|general|kimi|trinity), `skill:<skillId>`,
`system:role` (the agent's own prompt body = Role/persona),
`system:<relativePath>`, `mcp:<server>`,
`model:<providerID>/<modelID>` or `model:<providerID>/<modelID>@<variant>`,
`perm:<toolId>:<ruleId>` (the rule id keeps any extra `:` it contains; row
ids address the whole row by concatenation and match by exact string
equality, so `/`, `@`, and extra `:` inside the item segment need no
escaping; the parsers split on the first `/` and the first `:` only). A
catalog row's rule id is `<category>.<row>` (`perm:shell:commands.git-changes`,
`perm:team_delegate:limits.inflight`, `perm:team_status:runs.others`), a
team member's own `to.<member>` and `run:<runID>` (Teams without kinds).

Resolution chain (`resolutionChain(address, ctx)`, DESIGN §3), most specific
first, resolving `text`, `state`, `pin` and the active model independently —
the first node supplying that field wins, else the fallback:

| node | chain |
| ---- | ----- |
| project/A (team T optional) | project/A@T → project/A → global/A (Global A exists) → expand(nearest link among those) → matching Defaults entries, most specific first, each followed by expand(its link) → defaults/null → fallback |
| global/A | global/A → expand(link) → entries → defaults/null → fallback |
| defaults/E (entry or OpenCode agent) | defaults/E → expand(link of E) → defaults/null → fallback |
| preset/P | expand(P) → defaults/null → fallback |
| defaults/null | defaults/null → fallback |

`expand(P)` = `preset/P` (the human's edits) → `shipped/P` (OpenCode and Plus
presets only: content from the catalogue, never stored) → expand(link of P).
A member preset `M@TP` is `preset/M@{level:"preset",team:TP}` and never falls
through to a stand-alone agent preset `M`. A preset already in the chain is
not expanded again (cycles are cut). An agent in `ctx.defaults` (OpenCode agents
shown at Defaults) has its own exact Defaults node `defaults/A`, ordered as an
exact Agents entry. Agents-catalogue entries match stand-alone agents;
Teams-catalogue entries (`defaults/<member pattern>@{level:"defaults",
team:<team pattern>}`) match a member whose team (from the address, else
`ctx.memberTeams`) matches. `matchesName(pattern, name)`: `*`/`%` = any run,
whole name, case-insensitive, everything else literal. `entrySpecificity`:
exact first, more literal characters first, then name order (Teams: member
exactness, team exactness, member literals, team literals).

Fallback (§3.3): `state` falls back to the item's upstream state only for an
agent in `ctx.native` (origin native/special, a team's Special agents
included), an item the agent owns (`item.agents` includes it — its Role/persona
— or `item.ownedBy` names it: a user-created rule row carries its RuleRecord's
agent there, without limiting which agents the row applies to) and an OpenCode
preset; everything else — user agents, members, Defaults entries,
`defaults/null`, other presets — falls back to **off**. `text` and `pin`
always fall back to upstream. A context without `native` (a bare
`{ global, defaults }`) keeps the pre-preset rule: everything falls back to
upstream.

```ts
export interface ChainContext {
  readonly global: ReadonlySet<string>
  readonly defaults: ReadonlySet<string>
  readonly native?: ReadonlySet<string>
  readonly links?: readonly LinkRecord[]
  readonly entries?: readonly EntryRecord[]
  readonly presets?: PresetCatalog // presets (ref, origin), shipped links, shipped(ref, item, section), model(ref)
  readonly memberTeams?: ReadonlyMap<string, readonly string[]>
}
export type Scopes = ChainContext // scopesOf(agents) fills global, defaults and native (origin native|special)

export interface Resolved {
  readonly text: string
  readonly assembled: string // text with excluded sections dropped (whole items only)
  readonly enabled: boolean
  readonly pinned: boolean // nearest node carrying `pin` down the chain, else the upstream registry default
  readonly source: Level | "upstream"
  readonly from: From // where the state came from
  readonly textFrom: From
  readonly pinFrom: From
  readonly overriddenHere: boolean
  readonly modified: boolean
  readonly review: boolean // reviewOf is not empty
  readonly reviewOf: readonly ("text" | "state" | "pin")[]
}
// From: level | preset (id, team?, shipped) | default (name, team?) | defaults-everyone | native | upstream | off
```

- `modified` is **text-only**: a state-only override never marks a node
  modified and never raises review, so a disabled-but-otherwise-unmodified copy
  keeps taking upstream text silently.
- Text review (yellow) is raised when the node is `modified` at this level
  AND the current upstream fingerprint (resolved from the chain **above**
  this level) differs from BOTH the record's `basedOn` and its `acknowledged`.
- State and pin review (§3.6): `merge(..., scopes)` setting `state` or `pin`
  stores what the chain above resolves at that moment (`basedOnState`,
  `basedOnPin`); the part is under review when the value above now differs.
  Records without them never flag.
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
  unchanged; still modified. A tracked state/pin re-records the value above
  (`basedOnState`, `basedOnPin`).
- **take**: remove the parts under review — `text`, `basedOnText`,
  `acknowledged` for text (also when nothing is under review), `state` +
  `basedOnState`, `pin` + `basedOnPin` — and drop the record entirely if it
  then carries no text, state or pin, so live propagation resumes.
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

### Model selection (`model.ts`)

```ts
export interface ModelRefLike { readonly providerID: string; readonly modelID: string; readonly variant?: string }
export interface ModelCandidate extends ModelRefLike { readonly source: Level | "upstream" }
export function modelItemId(input: { providerID: string; modelID: string; variant?: string }): string
export function parseModelItemId(id: string): { providerID: string; modelID: string; variant?: string } | undefined
export function permItemId(tool: string, ruleId: string): string
export function parsePermItemId(id: string): { tool: string; ruleId: string } | undefined
export function modelKey(candidate: Pick<ModelRefLike, "providerID" | "modelID" | "variant">): string
export function modelCandidates(input: { models: readonly ModelRecord[]; scopes: Scopes; level: Level; agent: string | null; upstream?: ModelRefLike }): ModelCandidate[]
export function resolveActiveModel(input: { models: readonly ModelRecord[]; scopes: Scopes; level: Level; agent: string | null; upstream?: ModelRefLike }): ModelCandidate | undefined
export function addModelRecord(models: readonly ModelRecord[], address: { level: Level; agent: string | null }, target: { providerID: string; modelID: string; variant?: string }, updated: string): ModelRecord[]
export function ensureActivateModel(models: readonly ModelRecord[], address: { level: Level; agent: string | null }, target: { providerID: string; modelID: string; variant?: string }, updated: string): ModelRecord[]
export function activateModel(records: readonly ModelRecord[], address: { level: Level; agent: string | null }, target: { providerID: string; modelID: string; variant?: string }): ModelRecord[]
export function clearModelActive(models: readonly ModelRecord[], address: { level: Level; agent: string | null }): ModelRecord[]
export function removeModelRecord(models: readonly ModelRecord[], address: { level: Level; agent: string | null }, target: { providerID: string; modelID: string; variant?: string }): ModelRecord[]
```

- Candidates are the union down the existing `resolutionChain` (most
  specific first), deduplicated with most-specific source winning, plus the
  agent's upstream model appended last when not already present. Shared rows
  (`agent: null`) contribute only at `defaults`; upstream contributes only
  when `agent !== null`.
- The effective model is the first `active === true` record down the chain
  (presets and Defaults entries included; a shipped preset's
  `presets.model(ref)` counts as active), else upstream. No active record and
  no upstream means Plus installs nothing for that agent.
- Active-model review: `activateModel`/`ensureActivateModel` with a
  `ModelContext { scopes, upstream? }` store `basedOn` = the key of the active
  model above (`aboveActiveModelKey`, "" when none); `resolveActiveModel`
  marks the own winner `review: true` when that key has changed.
  `acknowledgeActiveModel` is keep; `clearModelActive` is take.
- Invariant: at most one record per (level, agent) carries `active`.
  `activateModel` clears `active` from only that pair's other records;
  activating the already-active record (with no stray actives) or a target
  with no record at all returns an identical list. `addModelRecord` stores
  an inactive row and never steals the effective model; `ensureActivateModel`
  plants the local row first, then flips it exclusively (this is the TUI
  space path for inherited candidates). `r` (`clearModelActive`) clears only
  this level's active flag, leaving candidates in place so the chain falls
  through; with no active at this address it returns an identical list.
- Delivery: `applyModels` (`apply.ts`) resolves each effective agent and
  sets the host model in one `ctx.agent.transform`; upstream winners install
  nothing. Sessions adopt the agent's active model through `switchModel` on
  `session.created` / `session.agent.selected` only when the session's
  current model differs (`index.ts`); manual mid-session picks
  (`session.model.selected`) are never subscribed to and never overridden.
  The per-agent base badge follows the Plus-active model rather than the
  upstream model, with `PromptTemplate.active` classifying `claude` and
  `gemini` model ids to their own base template ids (`claude` and `gemini`).
  The base template follows the model family automatically: the context
  hook classifies each request's model through `ctx.prompt.active` and
  applies only the template active for that request.

## Store (`store.ts`, `paths.ts`)

```ts
export type RecordState = "on" | "off"
export interface CustomizationRecord {
  readonly type: "customization"
  readonly level: Level
  readonly agent: string | null
  readonly team?: { readonly level: Level; readonly team: string }
  readonly item: string
  readonly section: string | null
  readonly text?: string
  readonly state?: RecordState
  readonly pin?: boolean
  readonly basedOn: string
  readonly basedOnText?: string
  readonly acknowledged?: string
  readonly updated: string
}
export interface SplitRecord {
  readonly type: "split"
  readonly level: Level
  readonly agent: string | null
  readonly team?: { readonly level: Level; readonly team: string }
  readonly item: string
  readonly boundaries: readonly Boundary[]
  readonly updated: string
}
export type StoredRecord =
  | CustomizationRecord | SplitRecord | TeamRecord | ModelRecord | RuleRecord
  | LinkRecord | EntryRecord | PresetRecord
```

Preset records (DESIGN §7): `LinkRecord {type:"link", level, agent|null,
team?, catalogue?, preset: {kind:"agent",id} | {kind:"member",team,id} |
{kind:"team",id}, updated}`; `EntryRecord {type:"entry", level:"defaults",
catalogue, team?, name, updated}`; `PresetRecord {type:"preset",
level:"preset", kind:"agent"|"team", id, team?, fields?: {mode?,
description?}, updated}`. `CustomizationRecord` gains `basedOnState?`,
`basedOnPin?` (after `acknowledged`); `ModelRecord` gains `basedOn?` (after
`active`). Level `preset` routes to the global file; team records never carry
it. Sort keys: links `["link", agent, team, catalogue, level, preset kind,
preset team, preset id, updated]`, entries `["entry", catalogue, team, name,
updated]`, presets `["preset", kind, team, id, updated]`. The catalogue
migration considers only customization, split, model and rule records.
The snapshot carries links, entries and user presets in their own fields
(`Snapshot.links`, `.entries`, `.presets`), never in `records`, and
`instructions.mutate` re-merges the stored ones like team records, so a client
that resubmits only inventory records cannot drop them.

### Presets and the chain context (`presets.ts`)

`presets.ts` holds what ships as presets and builds the full chain context.
It is pure data and functions (no filesystem), shared by the server, the TUI
and the tools, so shipped content never crosses the wire: every side builds
the same catalogue from the snapshot's `items` and preset records.

- **OpenCode agent presets** (`nativePresetIds`: build, plan, general, explore,
  title, summary, compaction). `shipped(ref, item, null, upstream)` answers
  every item with the resolving item's upstream `{ text, state, pin? }` and
  `system:role` with the OpenCode agent's own role item text.
- **Plus agent presets** (`plusAgentPresets`: planner, orchestrator,
  implementer, reviewer, scout, build-seat; mode `primary`). Each ships every
  item's upstream value, overlaid by `plusAgentOverrides[id]` (the former
  role rules, DESIGN §6; see Teams without kinds), and `system:role` = `shared` +
  the role block (`builtin-teams.ts` `teamRoles`; build-seat has its own).
- **Plus team presets** (`plusTeamPresets`, from `builtin-teams.ts`:
  opencodeplus-team, starter, review). A member preset ships its own role body
  as `system:role` and `plusMemberOverrides[team][member]`; everything else
  follows its shipped link (`shippedLinks`: `preset/<member>@<team>` →
  its Plus agent preset).
- **User presets** are `PresetRecord`s (a member preset is `kind:"agent"`
  with `team`); they ship nothing, their content is ordinary `preset`-level
  records and their links.
- No preset ships an active model yet (`model()` is always undefined).

`presetListing(presets)` lists every preset as data `{ ref, origin, kind,
label, description?, mode?, members? }` (OpenCode, Plus, User agent presets,
then Plus and User team presets each followed by their member presets).
`presetCatalog({ items, presets })` builds the `PresetCatalog`;
`chainContext({ agents, items, links, entries, presets, teams })` builds the
full `ChainContext` (`scopesOf(agents)` plus links, entries, the catalogue and
`memberTeams`). `presetStateOf(records)` picks links, entries and presets out
of any record list. Every production resolution reads the full context:
publish (`buildActiveModels`, apply, specials, team role overrides, baselines,
the fingerprint view), discovery's base badge, `instructions.assembled`, the
memo behind the tree/query/ops, the tools' `show`, and the TUI state and
detail pane (`snapshot.ts` `contextOfSnapshot`, `memoInputOf`).

A member's link carries its team (`L/A@T`). The tree's member rows carry
`memberOf` (the row's own team), so their chain is apply's team-scoped chain
for that team; an address without a team or `memberOf` in the Teams catalogue
reads a link of `L/A@T` for any team `memberTeams` names. Both pick
the nearest link among the member's own nodes with the team-scoped node first:
`L/A@T`, then `L/A`, then `global/A` — a Global link of the same id never
beats the member's team-scoped link.

Apply installs nothing without records only while every agent is *plain*
(no Defaults entry exists, no link names it, and its fallback is upstream);
any other agent's untouched rows follow a preset or fall back to off, so they
install. An MCP server row (`kind:"mcp"`) is server configuration, not an
agent setting, and keeps its upstream state at every address.

Ops that set `state`/`pin` pass the context to `merge` (recording
`basedOnState`/`basedOnPin`), and activating a model passes it to
`ensureActivateModel` (recording `basedOn`).

```ts
// Per-agent model selection: which provider model an agent uses. `active`
// is `true` or omitted, never `false`: records cross the RPC boundary as
// JSON, where a present-but-undefined key fails validation.
export interface ModelRecord {
  readonly type: "model"
  readonly level: Level
  readonly agent: string | null
  readonly team?: { readonly level: Level; readonly team: string }
  readonly providerID: string
  readonly modelID: string
  readonly variant?: string
  readonly active?: true
  readonly updated: string
}
// One user-added tool permission rule. On/off reuses CustomizationRecord
// state on the `perm:<tool>:<rule>` item address, so resolve() already
// yields `enabled` with no new logic.
export interface RuleRecord {
  readonly type: "rule"
  readonly level: Level
  readonly agent: string | null
  readonly team?: { readonly level: Level; readonly team: string }
  readonly tool: string
  readonly id: string
  readonly label: string
  readonly patterns: readonly string[]
  readonly keywords: readonly string[]
  /** Refusal text the model reads when this rule denies; absent means the generic refusal. */
  readonly message?: string
  readonly updated: string
}
```

Splits belong to the **item**, not the agent, and are stored at the level they
were made; they resolve down the same chain as overrides. Model and rule
records route by level like any other record: `project` to the project file,
`global`/`defaults` to the global file. Canonical sort keys order models by
`["model", providerID, modelID, variant ?? "", String(agent), level,
active ? "active" : "", updated]` and rules by `["rule", tool, id,
String(agent), level, updated]`, ending with `updated` so the order is total
and an unchanged save stays a no-op.

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
In `stable()`'s canonical key order `pin` sits after `state` and before
`basedOn`. Each store carries its own revision read from its own file header; a save
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
| `instructions.mutate` | `{ expectedRevision, expectedGlobalRevision, records, actor? }` | `MutateResult` | `project.disabled`, `agent.protected` |
| `instructions.assembled` | `{ agent }` | `Assembled` | `project.disabled`, `agent.unknown` |
| `agent.create` | `{ scope, id, preset?: PresetRef, actor? }` | `AgentRef` | `project.disabled`, `agent.exists`, `agent.invalid`, `agent.protected`, `preset.invalid` |
| `agent.rename` | `{ scope, from, to, actor? }` | `RenameAgentResult` | `project.disabled`, `agent.missing`, `agent.exists`, `agent.invalid`, `agent.protected` |
| `agent.delete` | `{ scope, id, actor? }` | `AgentRef` | `project.disabled`, `agent.missing`, `agent.invalid`, `agent.protected` |
| `skill.create` | `{ name, body }` | `SkillRef` | `project.disabled`, `skill.exists`, `skill.invalid` |
| `skill.import` | `{ path }` | `SkillRef` | `project.disabled`, `skill.exists`, `skill.invalid` |
| `skill.delete` | `{ id }` | `SkillRef` | `project.disabled`, `skill.missing`, `skill.invalid` |
| `base.create` | `{ id, title, text }` | `BaseRef` | `project.disabled`, `base.exists`, `base.invalid` |
| `base.delete` | `{ id }` | `BaseRef` | `project.disabled`, `base.missing`, `base.invalid` |
| `instruction.create` | `{ name, text }` | `InstructionRef` | `project.disabled`, `instruction.exists`, `instruction.invalid` |
| `instruction.delete` | `{ name }` | `InstructionRef` | `project.disabled`, `instruction.missing`, `instruction.invalid` |
| `mcp.add` | `{ name, config }` | `McpRef` | `project.disabled`, `mcp.exists`, `mcp.invalid` |
| `mcp.remove` | `{ name }` | `McpRef` | `project.disabled`, `mcp.missing`, `mcp.invalid` |
| `team.create` | `{ level, team, preset?: team preset id, actor? }` | `TeamRef` | `project.disabled`, `team.exists`, `team.invalid`, `team.create`, `agent.protected` |
| `team.setEnabled` | `{ level, team, enabled }` | `TeamRef` | `project.disabled`, `team.unknown`, `team.invalid` |
| `team.addAgent` | `{ level, team, id, preset?: PresetRef, actor? }` | `AgentRef` (at defaults `path` is the entry's row id) | `project.disabled`, `team.unknown`, `team.invalid`, `agent.exists`, `agent.invalid`, `agent.protected`, `preset.invalid`, `entry.invalid`, `entry.exists` |
| `team.removeAgent` | `{ level, team, id, actor? }` | `AgentRef` | `project.disabled`, `team.unknown`, `team.invalid`, `agent.invalid`, `agent.protected` |
| `team.delete` | `{ level, team, actor? }` | `DeleteTeamResult` | `project.disabled`, `team.unknown`, `team.invalid`, `agent.protected` |
| `team.list` | `void` | `TeamListOutput` | `project.disabled` |
| `team.runs.list` | `{ all?: boolean }` | `TeamRunsListOutput` | — |
| `team.runs.stop` | `{ run: string }` | `TeamRunsStopOutput` | `E_BUSY`, `run.unknown` |
| `model.add` | `{ level, agent, providerID, modelID, variant?, actor? }` | `ModelRef` | `project.disabled`, `model.exists`, `model.invalid`, `agent.protected` |
| `model.remove` | `{ level, agent, providerID, modelID, variant?, actor? }` | `ModelRef` | `project.disabled`, `model.missing`, `model.invalid`, `agent.protected` |
| `catalog.models` | `void` | `{ models: CatalogModel[] }` (`{ providerID, modelID, variant?, name }`, one entry per base model plus one per variant) | `project.disabled` |
| `rule.add` | `{ level, agent, catalogue?, tool, id, label, patterns, keywords?, message?, actor? }` | `RuleRef` | `project.disabled`, `rule.exists`, `rule.invalid`, `agent.protected` |
| `rule.remove` | `{ level, agent, tool, id, actor? }` | `RuleRef` | `project.disabled`, `rule.missing`, `rule.invalid`, `agent.protected` |
| `rule.update` | `{ level, agent, catalogue?, tool, id, label, patterns, keywords?, message?, actor? }` | `RuleRef` | `project.disabled`, `rule.invalid`, `agent.protected` |
| `entry.create` | `{ catalogue, name, team?, preset?: PresetRef, actor? }` | `EntryRef` | `project.disabled`, `entry.invalid`, `entry.exists`, `preset.invalid` |
| `entry.delete` | `{ catalogue, name?, team?, actor? }` | `EntryRef` (`removed`) | `project.disabled`, `entry.invalid`, `entry.missing` |
| `entry.rename` | `{ catalogue, name, team?, to, actor? }` | `EntryRef` | `project.disabled`, `entry.invalid`, `entry.exists`, `entry.missing` |
| `preset.create` | `{ kind: "agent", id, from?: PresetRef, actor? }` or `{ kind: "team", id, from?: team preset id, actor? }` | `PresetResult` | `project.disabled`, `preset.invalid`, `preset.exists` |
| `preset.addMember` | `{ team, id, from?: PresetRef, actor? }` | `PresetResult` | `project.disabled`, `preset.invalid`, `preset.exists`, `preset.readonly` |
| `preset.delete` | `{ ref: PresetRef, confirm?, actor? }` | `PresetResult` | `project.disabled`, `preset.invalid`, `preset.readonly`, `preset.inUse` |
| `link.set` | `{ level, agent, team?, catalogue?, preset: PresetRef \| null, actor? }` | `LinkResult` | `project.disabled`, `link.invalid`, `link.cycle`, `preset.invalid`, `preset.readonly`, `agent.protected` |

Presets, entries and links (DESIGN §4, §5, §7). `agent.create` and
`team.addAgent` write the preset's `mode` and `description` (OpenCode presets:
what the host reports for the OpenCode agent) and an EMPTY body, and store a
link at the created owner (members: team-scoped); no preset is "None —
everything off" (no link, and a stale link at that owner is dropped). A file
never goes out without a mode: None (or a preset that names no mode) writes
`mode: primary`, core's own default for an agent (`Agent.Info.default`), so the
minimal file is `---\nmode: primary\n---\n`. Core skips an empty agent file
(`core/src/config/plugin/agent.ts` decodes only a file with content), so an
empty file would never register with the host. Ids keep their case
(`Opus-Orchestrator-Max` registers as written). `agent.rename` moves the
agent's link and its own records (customizations, splits, models, rules at
`{level: scope, agent: from}`, no team) to the new id with the file; records a
deleted agent of the new id left behind give way, while a member of the same
id and the agent at another level keep theirs. If the store cannot be saved,
the file is moved back and the call answers `agent.invalid`.
`team.addAgent` at `defaults` stores a Teams member entry (`team`, `id` are
patterns) instead of a file. Entry names may hold `*`/`%`, never `:`, NUL or a
line break (`presets.ts` `validateEntryName`); team patterns follow
`validateTeamName`; a Teams entry always stores its team pattern (default
`*`) and may not be named `special`. A duplicate (same catalogue, team pattern
and name) or an Agents entry named like an OpenCode agent's own Defaults row is
`entry.exists`. Deleting or renaming an entry takes its own records and link
with it. `preset.create` checks the id against every preset of that kind
(`preset.exists`); an agent preset copies its base's mode/description into
`fields` and links to it; a team preset from a team preset copies the member
list (each member preset linked to the source member, the team linked to the
source team). `preset.addMember` takes User team presets only
(`preset.readonly`). `preset.delete` refuses OpenCode/Plus presets and, while
any stored or shipped link points to the preset (or, for a team preset, to one
of its members from outside it), answers `preset.inUse { users, elsewhere? }`
with the owners' row ids; it removes the preset's records, its members' and
their links. User presets live in the global store but a project's links live
in that project's store, and projects are not enumerable, so every save that
writes a project store keeps a global index of the projects whose store holds
a link (`linked-projects.json` next to the global records; `store.ts`
`linkedProjects`). A delete reads each listed project's own store for the
truth: links in this project or the global store always refuse (relink them
here first); links other projects hold are listed as `<directory> › <row id>`
in `users` and per project in `elsewhere`, and refuse unless the call passes
`confirm: true` (the TUI asks a second time; the `instructions_delete` tool
takes `force: true`). A listed project whose store is gone or holds no link
never blocks and is dropped from the index. The reference check (this store,
the index and every listed store) and the deletion commit run under one write
gate (`store.ts` `updateGated`, the gate every save takes), so a link another
project commits meanwhile is either seen and refuses, or is written after the
preset is gone. A link whose preset no longer
exists never breaks resolution: its node contributes nothing and the rows fall
through to the rest of the chain; the owner row carries `owner.linkMissing`,
the badge `missing preset` (warning), and the detail line `Created from
preset: <id> — missing (deleted)…`, until it is relinked (`l`). `link.set` validates the owner (an existing project/global agent, team
or member, a Defaults entry, or a User preset — OpenCode/Plus presets are
`preset.readonly`), the preset's kind (an agent takes an agent or member
preset, a team a team preset) and, at `preset` level, refuses a link that
would bring the preset back to itself (`link.cycle { through }`). A team's
link names the team preset its members come from (resolution never expands a
team preset itself): relinking a team to team preset TP also relinks every
member whose id TP has a member of to `TP › member` (a member without a
counterpart keeps its link) in the same save, and `LinkResult.members` lists
them (`{ agent, preset }`, id order); unlinking a team touches no member
(`members: []`). At `preset` level the relink is cycle-checked as one batch
(each new link against the graph with every other new link applied, so two
member relinks cannot close a cycle between them) and a cycle refuses the
whole relink. The TUI toast and the tool's `status` add
`relinked <members>`. A tool actor
is refused for a protected agent's link (presets are not agents: their owners
and rows are never protected), and for a team relink that would relink a
protected member (the refusal names it; the TUI is never refused). Every write logs one line (`entry.*`,
`preset.*`, `link.set`) to the store the records live in. `Snapshot.listing`
carries every preset (`PresetListEntry`: ref, origin, kind, label,
description?, mode?, members?).

`ModelRef` is `{ level, agent, providerID, modelID, variant?, active? }`;
`RuleRef` is `{ level, agent, tool, id, label }`. `model.add` stores an
inactive candidate and requires it to exist in the host model catalog
(unknown models fail with `model.invalid`); shared rows (`agent: null`)
live at `defaults` only. `rule.add` derives `keywords` through
`keywordsForPattern` when omitted and matches existing rules by `(tool, id)`
globally, not per level/agent. `rule.remove` matches by `(tool, id)` only:
`level`/`agent` are carried but not part of the lookup. `rule.update`
upserts a `RuleRecord` by `(tool, id)`, so editing a curated or mined row
materialises a custom override of the same identity; blank `keywords`
derive server-side via `keywordsForPattern` like `rule.add`. `message` is
trimmed, a blank one clears the stored text, and an omitted one on
`rule.update` preserves it. `catalogue` names the addressed row's
catalogue: a first write (the override) lands in it, so a Teams row
materialises a Teams rule while the Agents form stays keyless; a matched
record keeps its stored `level`, `agent`, `catalogue` and `team`, so an
address `catalogue` never retargets it and a message edit cannot move a
Teams rule into the Agents catalogue. Curated-identity
policy: a stored record whose `tool` + `id` matches a curated rule is treated
as an override of that curated rule. This is accepted reserved-identity
semantics, not an unconditional compatibility guarantee. `rule.add`,
`rule.update`, and `rule.remove` share one `refuseProtectedForTool` guard:
the protected-agent refusal is decided at the PlusApi boundary from the
request's `actor`, so a tool-originated write is refused whichever surface
forwarded it (tools, the RPC, or a direct API call), while a missing actor —
the TUI — is never refused. Protection follows the row's effective owner: on
an update the matched record's owner, not the caller's row address; on an
add the requested `agent`. The declared error is `agent.protected` with
`{ agent, id?, reason }`, and the reason text is the same
`agent.protected: row belongs to protected agent "<id>"` the tools raise.
Deleting an item is a write to other agents' rows too: `rule.remove` refuses
a tool actor before the rule is saved when the item-record cascade would drop
a customization or split owned by a protected agent, even when the removed
rule itself is shared or owned by someone else. `skill.delete`,
`base.delete` and `mcp.remove` guard their cascades the same way before the
file or the project config entry is removed. Their RPC inputs carry no
`actor`, so their boundary always normalises to the TUI and the cascade
refusal is unreachable over RPC; the `PlusApi` results for those three
methods carry the `agent.protected` variant for the tool callers that do pass
an actor.

Events: `project.changed`, `instructions.changed`, `teams.changed`.

New optional keys: `SnapshotItem` carries `codemode`, `namespace`,
`pinned`, `execute`, `permTool`, `ruleId`, `patterns`, `keywords`,
`provenance`, `custom`, `policy?` (`{ on, off }`, each an array of
`{ action, resource, effect: "allow" | "deny" | "ask" }`) and `runID?`, the two
fields that make a team policy row read as a policy row on the client side,
and the per-tool permission fields `category?`, `permKind?`
(`"rule" | "input" | "value" | "param" | "limit" | "approval" | "env" | "team"`),
`field?`, `value?` (string, number, boolean or null), `allow?`, `measure?`
(`"value" | "length" | "count"`), `mode?` (`"clamp" | "refuse"`), `message?`,
`fallback?` and `alsoUnder?` (string array) — `index.ts` `toSnapshot` sends and
`snapshot.ts` `itemOf` reads every one, so the TUI and the tools list the same
rows the server enforces;
`SnapshotCustomizationRecord` carries `pin`, `team?` (`{ level, team }`);
`SnapshotSplitRecord` carries `team?` (`{ level, team }`);
`AssembledTool` carries `codemode`, `pinned`. `SnapshotRecord` is the union
of `SnapshotCustomizationRecord`, `SnapshotSplitRecord`,
`SnapshotModelRecord` (`{ type: "model", level, agent, team?: { level, team }, providerID, modelID,
variant?, active?: true, updated }`), and `SnapshotRuleRecord`
(`{ type: "rule", level, agent, team?: { level, team }, tool, id, label, patterns, keywords,
message?, updated }`). `AgentEntry` carries `origin?` (`"native" | "special" | "plus" |
"user"`, computed server-side), `model?` (`{ providerID, modelID,
variant? }`), `ancestor?` (`boolean`, true when backed by an ancestor directory
agent file), and `fileBacked`. `ModelAddInput` and `ModelRemoveInput` carry optional `team?: { level, team }`.
Every team row expands to its member rows followed by a `Special` row (`team:<level>:<team>:special`),
which expands to `compaction`, `title`, and `summary` (`team:<level>:<team>:special:<id>`),
each carrying the five groups (`group:<level>:<team>/:special:<id>:<group>`). Their overrides carry `team: { level, team }`
and apply only while the team is enabled. While it is the enabled winner, every Special agent the host runs is published
with that team (`computeSpecialOverrides` in `index.ts`), so apply resolves its tools, permissions, skills and model through
the same team-scoped chain its Special rows show — whether or not the team sets an active model for it. Optional keys are omitted
when unset: never send an optional key whose value is `undefined` across
the RPC boundary, because results are validated as JSON and the whole call
fails with HTTP 400.

### `Assembled` Shape

`system` is the agent's installed system text read back from the host after
application (agent transforms are registry-level, so `agent.list` reflects
them). Tool entries reflect what is true at registry level
(enablement/visibility): per-agent tool text installs through a session
context hook, which is session-scoped for a specific agent, so `assembled`
cannot produce a session-scoped tool view for an arbitrary agent without
creating a session and reports the registry (upstream) description even when
the override applies correctly inside that agent's sessions.

The permission scrub and the stored skill desire it reads resolve each row
exactly as apply does (`apply.ts` `resolvedFor`), over the agents and context
a publish applies (`index.ts` `publishChain`): a team member, and an enabled
team's Special agent, resolves with its team.

```ts
export interface Assembled {
  readonly agent: string
  readonly system: readonly string[]
  readonly tools: readonly AssembledTool[]
  readonly skills: readonly { readonly id: string; readonly content: string }[]
}
export interface AssembledTool {
  readonly id: string
  readonly description: string
  readonly codemode?: boolean
  readonly pinned?: boolean
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
- `team.unknown`: `{ level: TeamLevel, team: string }`
- `team.exists`: `{ level: TeamLevel, team: string }`
- `team.create`: `{ level: TeamLevel, team: string, reason: string }`
- `model.exists`: `{ level: Level, agent: string | null, providerID: string, modelID: string, variant?: string }`
- `model.missing`: `{ level: Level, agent: string | null, providerID: string, modelID: string, variant?: string }`
- `model.invalid`: `{ providerID: string, modelID: string, variant?: string, reason: string }`
- `rule.exists`: `{ level: Level, agent: string | null, tool: string, id: string }`
- `rule.missing`: `{ level: Level, agent: string | null, tool: string, id: string }`
- `rule.invalid`: `{ tool: string, id: string, reason: string }`

## Teams (`teams.ts`, `builtin-teams.ts`, `paths.ts`, `store.ts`, `rpc.ts`)

A team is a named set of agents toggled as a unit. When a team is enabled
its agents become visible to core as real agents. Teams have three tiers:
`"project" | "global" | "defaults"`. Project and global teams are
user-authored directories on disk. No team ships at Defaults any more
(DESIGN §2): the shipped teams in `builtin-teams.ts` are Plus team presets
(`presets.ts`) a project or global team is created from, and the old Defaults
overlay directory (`teams-defaults/`) is not read. The `defaults` tier remains
an injectable registry (`PlusApiOptions.builtins`, empty in production) so the
Defaults Teams machinery keeps one input until Defaults team entries replace
it; its teams can be enabled and disabled but take no members. Precedence is
project over global over defaults. Created teams are always stored at project
or global level, never defaults.

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
`sub/agent`). The defaults tier is the injected registry only (name plus
member agents with id and markdown body); it has no filesystem path.

Validation (`validateTeamName`, same confinement style as
`validateAgentId`/`resolveInstructionPath`): rejects empty names, NUL,
absolute paths, any `/` or `\`, `.`, and anything containing `..`. Validated
names can never escape the teams directory; unvalidated input fails closed.

Discovery: project and global tiers list one entry per immediate
subdirectory, sorted by name; a team directory with no agent files is still
a team; a missing teams directory means no teams, not an error. Only `*.md`
files are members (other files are ignored), listed as `{ id, path }`
sorted by id. The defaults tier lists the injected registry's teams and
members (no overlay), sorted by team name and member id.

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
  `team.invalid` (shipped teams cannot be created). An optional `preset`
  names a team preset, Plus or User (DESIGN §5): each member is written as `<team>/<member>.md` with only the
  member preset's `mode` and `description` and an empty body, then links are
  stored at the team's level — each member `{agent: member, team: {level,
  team}}` → `{kind:"member", team: preset, id: member}` and the team `{agent:
  null, team}` → `{kind:"team", id: preset}` — so role text, tools and every
  other row follow the preset live. Unknown names fail with `team.invalid`
  (`Unknown team preset <name>`); a tool actor may not create a protected
  member (`agent.protected`); an omitted
  preset creates an empty team. Creation does NOT enable:
  the new team has no record, so the next snapshot lists it as DISABLED until
  `team.setEnabled` toggles it. Gated by project mode (`project.disabled`).
  Fails with `team.invalid` on invalid name, `team.exists` when the directory
  already exists, or `team.create` when the write itself fails. Logs `team.create`
  to the owning store with the caller's actor on success only; the file write
  never moves a revision. The TUI `a` on `group:project:teams` or
  `group:global:teams` asks `Team name`, then the `Team preset` picker (Plus
  and User team presets, `Empty team`), and creates at that level without a
  scope dialog; `group:defaults:teams` creates a team entry instead
  (§"TUI create, link and review").
- `team.setEnabled` (`SetTeamEnabledInput` → `TeamRef`): toggles one team at
  any of the three tiers. Gated by project mode (`project.disabled`). Fails
  with `team.invalid` on invalid name, or `team.unknown` when the team is not
  found (no directory on disk at that level for project/global, no built-in
  with that name for defaults). A defaults record routes to the global store.
  `saveTeamRecord` replaces only the matching `(level, team)` record and leaves
  customization and split records undisturbed; toggling to an unchanged state
  stays a no-op without moving revisions. Retries once on concurrent conflict
  before raising `team.unknown`.
- `team.addAgent` (`TeamAddAgentInput` → `AgentRef`): adds one agent to a team
  at project or global level (`<teamdir>/<id>.md`) carrying the optional
  `preset`'s `mode` and `description` and an empty body, and stores a
  team-scoped link (`{agent: id, team: {level, team}}` → the preset); unknown
  presets fail with `preset.invalid`. At `defaults` it adds a Teams member
  ENTRY (`team` and `id` are patterns, no file; no overlay is read): see
  `entry.create`. Reuses `validateAgentId` and `formatMarkdown` (never the
  regular-agent `create()`). Refuses an existing member
  id with `agent.exists` (path in data) and invalid ids with `agent.invalid`. After the write calls `refreshAfterFileChange(...,
  true)` exactly as `createAgent` does, so an enabled team's new member
  installs without a restart. Both team rows and member rows carry `add: "agent"`;
  `a` on `team:<level>:<team>` or on `team:<level>:<team>:<member>` opens only
  the name → preset flow with the team's level as scope, never the generic
  picker.
- `team.removeAgent` (`TeamRemoveAgentInput` → `AgentRef`): removes one member
  from a project or global team. Bound to `d delete` on team member rows.
  Unlinks `<teamdir>/<id>.md`; a Defaults registry member fails with
  `team.invalid` (delete refused). Removing the last member leaves an empty team directory. After unlink
  calls `refreshAfterFileChange(..., true)` so an enabled team's uninstalled
  member unregisters from the host immediately.
- `team.delete` (`DeleteTeamInput` → `DeleteTeamResult`): deletes a team at
  project or global scope (`level: "defaults"` is refused with `team.invalid`:
  built-in teams cannot be deleted). Bound to `d delete` on team rows.
  An enabled team is first disabled (reusing `team.setEnabled false` logic so
  member agents unregister from the host and registrations dispose), then the
  team directory is removed recursively (`fs.rm`), and any `TeamRecord` for that
  level and team is removed from the store. Fails with `project.disabled` when
  project mode is disabled, `team.invalid` on invalid name or when directory
  escapes the teams root, or `team.unknown` when the team directory is not found.
  Returns `{ level, team, removedMembers }`. Logs `team.delete` with the caller's actor.
- `team.list` (`Empty` → `TeamListOutput`): returns `{ teams: [{ level, team, enabled, members: [{ id, mode }] }] }`.
  Cheap read of discovered teams and their enabled states without computing an instructions snapshot.
  Discovered teams are sorted by level then team name; members are sorted by id in discoverTeams order.
- `team.runs.list` (`TeamRunsListInput` → `TeamRunsListOutput`): returns `{ runs: [{ id, role, state, task, head, worktree, lastUsed, sessionID, parent }] }` for this data root (`teamsDataDir()`), sorted by `lastUsed` descending. When `all` is false or omitted, hides superseded and reaped runs. Namespace-wide human read independent of project mode.
- `team.runs.stop` (`TeamRunsStopInput` → `TeamRunsStopOutput`): stops any run in the namespace by ID without ownership checks (`idle` transitions to `stopping → stopped`, `dead` reconciles to `stopped`, `working` returns error `E_BUSY`, terminal runs like `superseded`/`reaped` remain preserved). Returns `{ run, state }`. Namespace-wide human operation independent of project mode.

Implemented: the `Teams` tree group beside `Agents` under the `Project`,
`Global`, and `Defaults` roots (`tree.ts`), always present even when empty
with `[a: add team]` (the Defaults group lists real built-in rows with
working toggles and member rows that expand to full agent subtrees; `add` there
creates a Teams entry). Both team rows and member rows carry
`add: "agent"`, so `a` on a team row or member row adds an agent to that team
through `team.addAgent` (at `defaults` a member entry of the row's team pattern), and
TUI wiring (`state.ts` `space` → real `team.setEnabled` + snapshot refresh, `a`
→ real `team.create` / `team.addAgent` + snapshot refresh, `d` on a team row
→ `team.delete` confirmation + snapshot refresh, `d` on a member row
→ `team.removeAgent` confirmation + snapshot refresh; `tree-pane.tsx` on/off
badge). A created team starts disabled. Built-in teams cannot be created or
deleted, and take no members (no Defaults overlay is read). Store
persistence and the RPC surface are implemented.

### Run-backed Team composer tab (`tui/active-team.tsx`)

In a chat, arrow-down to the `Team` composer tab shows runs in the current namespace (not members), one row per run displaying `id`, `role`, `state`, and `task`, newest first.
- Default view displays active runs (`working`, `idle`, `starting`, `blocked_input`, `stopping`).
- `ctrl+a` toggles to inactive runs (`stopped`, `dead`, `superseded`, `reaped`), newest first, and back; the hint bar indicates which view is active.
- `Enter` (`composer.team.select`) on any row, active or inactive, attaches by navigating to that run's session (`sessionID`).
- `ctrl+d` (`composer.team.action`): on an `idle` run, stops the run; on a `stopped` or `dead` run, resumes by attaching to its session (the lifecycle resume consumes any retained `stopRequested`, so the resumed run reads `working` once its first prompt starts executing and settles `idle` on success); on a `working` run, displays a toast warning that the run must be interrupted first.
- Hint bar: `move ↑↓  attach ⏎  active ctrl+a  stop|resume ctrl+d  tabs ←/→`; the `ctrl+a` hint names the view that is on (`inactive ctrl+a` while the inactive view is showing), and `tabs ←/→` is the composer's own hint.
- The list automatically refreshes on `teams.changed`, host session lifecycle events, and on a 2 s periodic interval while the tab is active.

## Team tools (`teams/schema.ts`, `teams/tools.ts`)

The `team` namespace advertises only tools that work. It holds exactly
fourteen: `delegate`, `finish`, `followup`, `integrate`, `checkpoint`,
`set_checks`, `supersede` and `stop` (native, `codemode: false`), and
`status`, `wait`, `get_context`, `diff`, `list` and `check` (Code Mode). Every
one has a real handler in `teams/api.ts`; no registered team tool returns
`E_NOT_IMPLEMENTED`.

Nine names are **not** in the namespace, not in any team tool row and not named
by any built-in prompt: `review`, `shutdown_request`, `resume`, `prepare`,
`plan_handoff`, `metrics`, `exa_code_search`, `tavily_search` and
`tavily_extract`. Web and code search are not team tools: they are delivered by
the `search` MCP server and narrowed per role by a policy row (below).

`diff` is a read-only `git diff` of a run the caller can see — its own run or
one of its children. `from` is `base` (the default), `parent` (the parent
run's HEAD) or a 40-hex commit; `paths` narrows the patch. Output is
`{ run, from, head, bytes, truncated, patch }`, truncated to `maxBytes`
(default 200000) with `truncated: true`. A run that is neither the caller's
nor one of its children refuses with `E_NOT_VISIBLE`, unless the caller's
`team_diff` Runs rows reach it (below).

A planner, orchestrator or build member opening a fresh chat and calling any
team tool creates the `main` root run bound to that session automatically and
then answers normally. There is no `prepare`. All other no-run calls keep the exact
`E_NOT_ACTOR` message, as does a session whose run role differs from the
calling agent. A session with no location / no repository directory that calls
any team tool gets `E_NOT_ACTOR: This session has no repository directory; open the chat in a git repository to use team tools.`
and no run record is written; root-run bootstrap executes only when `git rev-parse --show-toplevel` succeeds.

Every team tool has exactly one input schema; all of them live in
`teams/schema.ts` and are imported by `teams/tools.ts` and by the handler that
implements the tool. The tool layer validates the input once, against the
registered schema; handlers receive the decoded value and never re-decode.
`E_INPUT` is therefore unreachable from a tool call. Tool input schemas accept
explicit `null` values for optional fields (`task: null`, `scope.forbidden: null`,
`findings: null`, etc.) as equivalent to omission at every depth of the input:
a `null` is dropped wherever `undefined` already decodes, including array
elements (`checks: [{ id, argv, cwd: null }]`) and fields behind optional or
default wrappers (`context: { interfaces: null }`,
`followup({ budget: { turns: null } })`), while `null` on required fields
strictly produces a schema validation error at any depth.

`Brief.role` (the member a `delegate` starts) is any member id of 1–128
characters, not a fixed list: who may delegate to whom is the caller's
Delegate to rows, and each agent's `team_delegate` schema lists the
co-members whose rows are on (`session.context` narrowing, under Permission
rules). `delegate` checks in this order, each refusal an `E_ROLE`: that some
delegation is open to the caller (a Delegate to row on, or Members of other
teams), the caller's Access row "Delegate from a delegated run" when the
caller's own run is delegated, that the target is a member of an enabled team,
the caller's Delegate to row for it (`teams/reach.ts` `mayDelegate`), then the
Delegation depth bound. Then, after the repository, base and check shapes, the
**target's** Briefs it accepts and Brief limits rows (below).

### Teams without kinds: every team rule is a row (DESIGN §6)

An agent behaves exactly as its rows say; nothing is read from its id. There
are no kinds: no id table, no `-planner`/`-orchestrator`/… suffix, no
`delegatesTo`, `reachesByDefault`, `requiresCleanWorktree`, tool ceiling or
native-permission table in code, and no `kind === …` branch. A team member is
any agent of an enabled team. `teams/policy.ts` holds only the team tool lists.

Every former hidden rule is a **shared catalogue row** (`permission-catalog.ts`,
no `agents`, so every agent has it). An agent that nothing sets resolves it to
its fallback (§3.3: off, unless the agent is from OpenCode). The **Plus presets**
(`presets.ts` `plusAgentOverrides`, `plusMemberOverrides`) set them so an agent
linked to a Plus preset behaves like the old role of that name, row for row.
The team tools read the rows through the permission table
(`PlusState.permissions`, rebuilt on every publish) for the right member — the
caller, or the member a brief or correction names. **Without a table (bare unit
tests, or before the first publish) and for an agent the table does not know,
every team row reads off** (`teamAllows`, `teamLimit`): a permission is
refused, a requirement demands nothing, a bound is absent.

| former hidden rule | row now (id, category → label) | read for |
| --- | --- | --- |
| every team call needs a kind; caller/target must name one | gone: members are the enabled teams' agents | — |
| team tool ceiling per kind | `tool:team_<tool>` (the tool rows; off installs the core deny `team.<tool>` `*` for a member, direct and Code Mode alike) | the caller (tool plans, Code Mode denies, core deny) |
| root-run bootstrap only for planner/orchestrator/build | `perm:team_get_context:bootstrap.chat`, Team runs → Start a team run from a chat | the calling member |
| delegated planner may not delegate | `perm:team_delegate:access.delegated`, Access → Delegate from a delegated run | the caller |
| implementer target needs `scope.paths` | `perm:team_get_context:accepts.scope-paths`, Briefs it accepts → Scope paths for a commit (`E_PATHS`) | the target |
| planner target only plan files | `perm:team_get_context:accepts.plan-files`, … → Plan files only (allow-list, patterns `docs/plans/*`, `docs/handoffs/*`, matched as given or under any directory; `E_PATHS`) | the target |
| orchestrator target needs a reason; spark's reason | `perm:team_get_context:accepts.reason`, … → A reason (`E_REASON`; replaces the caller-side "Reason when delegating to an orchestrator") | the target |
| spark: exactly one check, ≤5 paths | `accepts.check` → A check; `limits.paths` Brief limits → Paths per brief (5); `limits.checks` → Checks per brief (1) (`E_BRIEF`) | the target |
| reviewer cannot be followed up | `perm:team_get_context:accepts.followup`, … → Corrections by followup (off: `E_NO_FOLLOWUP`) | the child |
| Runs reach per kind | `perm:team_<tool>:runs.descendants`, `runs.others` (Runs) for followup, stop, supersede, status, wait, diff, list; shipped off | the caller |
| implementer must commit | `perm:team_finish:requirements.clean`, Requirements for done → Worktree committed before done (`E_DIRTY`), shipped off | the finishing member |
| read secrets | read → Files rows `keys`, `credentials`, `opencode-config` (Provider config and service passwords), `run-configs`, `databases`, and the curated `perm:read:env` | core rules |
| subagent, task, question, shell | `tool:subagent` (task is its legacy action), `tool:question`, `tool:shell` | tool plans |
| external directories | read → Where → `where.external` "Outside this checkout, for every tool (external_directory)", a rule row denying `external_directory *` while off, beside Where's `outside` (read), edit's Where and glob/grep Search roots | core rule / tool hook |
| planner edits plan files only | edit → Files it may change: `allowed.*` "Every other file" (fallback) and `allowed.plans` (allow-list) for edit, write and patch | tool hook |
| planner asks before delegating | `perm:team_delegate:approval.every` | tool hook |
| orchestrator shell changes | shell curated rows `git-push`, `git-commit`, `git-rewrite`, `rm` and catalog Commands `git-changes`, `git-refs`, `file-writes` | core rules |
| Tavily narrowing | `tool:search_tavily_search`, `tool:search_tavily_extract` | tool plans |
| grep secret files | grep → Files rows (as read's) and Include filters `env`, `keys` | tool hook |

What the Plus agent presets set (every other row is the catalogue's shipped value):

- **planner** — secrets off (read and grep); `tool:shell`, `tool:subagent` off;
  `team_integrate`, `team_checkpoint`, `team_set_checks`, `team_check` off;
  Runs on for status, wait, list; Approval on for team_delegate; Access
  "Delegate from a delegated run" off; Files it may change: every other file
  off, plan files on; Briefs it accepts: Plan files only on; Start a team run
  from a chat on; `tool:question` on.
- **orchestrator** — secrets off; `tool:question`, `tool:subagent` off;
  `team_checkpoint` off; the seven shell change rows off; Runs on for status and
  wait; A reason on; `tool:shell`, Start a team run and Delegate from a
  delegated run on.
- **implementer** — secrets off; outside-checkout rows off (read and edit
  Where, `where.external`, glob/grep roots); `tool:shell`, `tool:question`,
  `tool:subagent`, both Tavily tools off; Start a team run and Delegate from a
  delegated run off; `team_delegate`, `followup`, `integrate`, `set_checks`,
  `supersede`, `stop`, `wait`, `list` off; Worktree committed before done and
  Scope paths for a commit on.
- **reviewer** — as implementer's worker rows, with every team tool but
  `finish`, `status`, `diff`, `get_context` off, and Corrections by followup off.
- **scout** — as reviewer, taking corrections.
- **build-seat** — Runs on for status, wait, list; `tool:shell`,
  `tool:question`, `tool:subagent`, Start a team run and Delegate from a
  delegated run on; every "Delegate to" row of its team on (not Members of
  other teams).

The shipped team presets' member presets add each member's "Delegate to" rows
by its teammates' presets (planner → orchestrators; orchestrator →
orchestrators, implementers, reviewers, scouts) and spark-implementer's A
reason, A check, Paths per brief and Checks per brief on. They name teammates
by the team preset's member ids: a teammate renamed after the team was created
gets a new, off "Delegate to" row.

#### Per-member rows (`instructions/team-policy-rows.ts`)

Only rows that name something a member alone has are generated, for every
member of an enabled team (`policyMembersOf` keeps every one):

- `perm:team_delegate:to.<peer>` (Delegate to, `team`) — one per other member
  of the same enabled team, labelled with its id (text = the id), shipped off;
  plus `perm:team_delegate:to.other-teams` "Members of other teams", shipped
  off; on, it opens every member of an enabled team that has no row of its
  own. Their fallback is their own shipped state (off).
- `perm:edit:run:<runID>` (Run edit scopes) — per-run edit scope, derived from
  `run.json` while the run is non-terminal (a delegated run with no
  `scope.paths` included: it may edit nothing). On installs, in order,
  `deny edit *`, one `allow edit <path>` per `scope.paths` entry, then
  `deny edit .git/**` and `deny edit .opencodeplus/**` (core evaluates
  last-match-wins, so the never-editable state wins over the scope allows). It
  carries edit rules only. The row carries `runID` and is filterable with
  `run:<id>`.

The other catalog rows of the team tools (the per-tool table under Permission
rules) are read by the same handlers: `team_delegate` Limits — Children
working at once 4, Delegation depth 3, Brief size 6000 characters, Live team
runs in total 12, all on (`E_BOUNDS`, `E_ROLE`, `E_TOO_LONG`; an off row
removes the bound); `team_followup` Limits (Followups per child 5, shipped off;
`E_ROUNDS`); `team_finish` Requirements for done (Assigned checks pass at HEAD,
on, `E_CHECKS_RED`; A commit deliverable has at least one commit, off,
`E_NO_COMMIT`); `team_integrate` Outcomes it lands (done, done_with_concerns;
`E_NOT_DONE`) and Branches it lands on (Protected branches `main`, `master`,
`v2`, `ocp-main`, `release*`, shipped on; off refuses landing while the
parent's branch matches, `E_BRANCH`); `team_get_context` Contents (Sibling
runs of the same task); `team_check` Checks it may run (the assigned check's
family: `bun test` files or `bun run` scripts; `E_PERMISSION`). Their other
categories (Deliverables, Effort, Scope it may grant, Checks it may assign,
Parameters, Approval, …) are value, input, param, limit and approval rows the
tool hook enforces as it does for any tool.

#### Rule messages

`Permission.Rule` (`packages/schema/src/permission.ts`) carries an optional
`message`. When that rule is the one that denies, core's `assert` refuses with
it instead of `Permission denied: <action>`, so the model reads the reason;
when the rule asks, the message rides on the request as `metadata.message` so
the TUI can say why it is asking. A rule with no message encodes exactly as it
did before the field existed. A rule answers for a *pattern*, not for one call,
so the quoted subject in these texts is the rule's own resource.

The per-run edit scope rules carry one — the two texts the round-1
permission hook sent, word for word:
`"<resource>" is outside your scope.paths [<union of the member's live scopes>]. Report it in needs=[{kind:"path"...}].`
on the `deny edit *`, and
`"<resource>" is version-control or paused-tool state and is never editable, even inside scope.paths [<union>]. Report it in needs=[{kind:"path"...}].`
on `deny edit .git/**` and `deny edit .opencodeplus/**` (the `, even inside
scope.paths […]` clause is dropped when the run declares no paths). The
allows carry none. `Plus.PolicyRule` (`src/rpc.ts`) carries the field too, so
a message survives the snapshot the TUI and the tools read:
`instructions_show` on a `perm:` row returns the row's `policy` — the `on` and
`off` rules it installs, each with its own message — beside the row's patterns
and resolved state. Team rows the handlers read carry their refusal text as the
row's `message` (the words after the member id in `E_ROLE`, `E_PATHS`,
`E_REASON`, `E_BRIEF`, `E_NO_FOLLOWUP` and the bootstrap `E_NOT_ACTOR`).

Tool permission rules carry the same field:

- Every curated rule in `tool-permissions.ts` ships a short one-line message
  (for example `pushing is not allowed here`). `apply.ts` installs it on each
  core deny the row emits when the rule is off.
- A user `RuleRecord` carries an optional `message`. `rule.add` and
  `rule.update` accept it, `create kind:"rule"` and `set` on a perm row carry
  it through the tools, and the TUI rule dialog prompts for it after keywords
  ("Message shown on refusal (optional)"). A blank message clears it; omitting
  it on `rule.update` leaves the stored text alone, so a label/pattern edit
  never drops it. A matched record also keeps its stored `catalogue` and
  `team`, so changing the message of a shared Teams rule never rewrites it as
  an Agents rule; a first write takes the addressed row's catalogue.
- Catalog and team preset rows carry their refusal text on the item
  (`Item.message`, e.g. `reading outside this checkout is not allowed here`).
  A rule row's denies carry it, and the tool hook refuses with `Permission
  denied: <message>`; a row without one gets a generated text (`<label> is not
  allowed here`, `<field> "<value>" (<label>) is not allowed here`, `<label>
  is <n>; this call has <m>`).
- `apply.ts` prefers the user record's message for a custom row and falls back
  to the curated message, then the catalog row's own, for a shipped row
  (`curatedRuleMessage(tool, rule) ?? item.message`); a mined row has none and
  keeps the generic refusal.
- `instructions_show` on a perm row returns `message` when the row has one
  (the same fallback), and the TUI detail pane prints it under `provenance`.
- Two whole-set resubmissions carry the same optional fields. A state-only
  write — `set` with `state` alone — goes through `tools.ts`
  `toSnapshotRecords`; every TUI write (`persist` in
  `tui/instructions/state.ts`) resubmits through `toRpcRecords`. Both carry
  `message` on every rule and `catalogue` on every shared (`agent === null`)
  record, exactly like `toRecord` (`index.ts`). Toggling one row therefore
  never drops another rule's message and never moves a Teams-catalogue rule
  into the Agents catalogue.

There is no `Policy` group any more. Each row lists under the tool it governs,
in that tool's Permissions (`hostOf`: external directories under read, task
under subagent, the `search` row under search_tavily_search): Delegate to,
Runs, Access and Team role come first, then the tool's other categories (tree
shape, above). Only a role row whose tool this owner's inventory lacks goes to
`Other permissions` (`group:<level>:<team>/:<member>:tools:policy`, the old
group's id), which is omitted when every row found its tool.

Role rows' core rules land with every other row's in `orderRules` order
(Permission rules → Rule order): defaults, then what lets something through,
then refusals. A role row's own order — `deny *`, the allowed paths, the
never-editable state — is that order, so it survives unchanged, and a role's
`allow shell *` can no longer undo a shell row that is off.

Team tools appear only under the Teams catalogue's `Tools` inventory; the
Agents catalogue never lists them. An agent that is not a member of an enabled
team receives one wildcard deny, `{ action: "team.*", resource: "*", effect:
"deny" }`, which is the shape core drops a tool for
(`packages/core/src/tool.ts` `whollyDisabled` matches the action by wildcard
against `options.permission`). `E_NOT_ACTOR` is therefore never the answer to
"why can't build call this": `build` never sees a `team_*` tool at all, unless
it is a member of an enabled team. A member's id says nothing about what it
may do. A member whose `tool:team_<tool>` row resolves off gets one more
refusal, `{ action: "team.<tool>", resource: "*", effect: "deny" }` on the
tool's own permission (`apply.ts` `teamToolDenials`), whether the tool is
direct (hidden from the model by the tool plan) or Code Mode (denied by its
registry id): hiding is not refusing, and the registry-id deny never matches
`team.<tool>`.

A refusal renders as `${code}: ${message}`. When the error carries `accepted`,
one more line follows: `accepted: ${JSON.stringify(accepted)}`. For example,
a commit delegated with empty paths to a member whose Scope paths for a commit
row is on (the implementer preset's) refuses with:

```
E_PATHS: muse-implementer needs scope.paths (files or dir/* it may edit) for a commit deliverable (Briefs it accepts → Scope paths for a commit).
accepted: ["packages/plus/src/*","packages/plus/test/*"]
```

`E_CHECKS` and `E_SUMMARY` are raised by the `delegate` / `set_checks` /
`finish` handlers through `validateChecks` / `validateSummary`, not by schema
filters, and both carry `accepted`.

Error codes carrying `accepted` today:
- `E_PATHS`: valid scope paths array (`["packages/plus/src/*","packages/plus/test/*"]`); for a target whose Plan files only row is on, `<target> accepts plan files only: every scope path must match one of its patterns [<patterns>]; outside them: [<paths>].` with the row's patterns
- `E_ROLE`: the first member open to the caller (`{"role":"<member>"}`), present only when one is. The message ends in what is open — `You may delegate to: <members>.` or `No member is open to you for delegation.` — after `<agent> may not delegate.`, `"<role>" is not a member of an enabled team.` or `<agent> may not delegate to "<role>".`. A delegated run whose Delegate from a delegated run row is off gets `<agent>: a delegated run of yours may not delegate further; finish with needs=[{kind:"decision",...}] instead` with `"report blocked with needs=[{kind:\"decision\"}]"`. The depth bound keeps `Depth limit <n> reached; this run cannot delegate. Report blocked with needs=[{kind:"decision",...}] instead.` with `"report blocked with needs=[{kind:\"decision\"}]"`.
- `E_CHECKS`: valid check definition (`{"id":"plus-tests","argv":["bun","test","packages/plus/test/model.test.ts"]}`)
- `E_SUMMARY`: summary length guidance (`"a summary of ≤15 lines"`)
- `E_TIMEOUT_MIN`: `"timeoutMs <timeoutMs> is below the 10000ms floor."`; minimum timeout object (`{"timeoutMs":10000}`)
- `E_BRIEF`: the target's A check (`{"checks":1}`), Paths per brief (`{"paths":<n>}`) or Checks per brief (`{"checks":<n>}`) row refuses the brief: `<target> needs at least one check (Briefs it accepts → A check).`, `<target> accepts at most <n> scope paths per brief (Brief limits → Paths per brief); this brief has <m>.`, `<target> accepts at most <n> checks per brief (Brief limits → Checks per brief); this brief has <m>.`
- `E_REASON`: the target's A reason row is on and the brief has none: `<target> needs a reason: say why this member and not another (Briefs it accepts → A reason).` with `{"reason":"3 independent packages, each needs its own workers"}`
- `E_NEEDS`: valid needs array (`[{"kind":"path","detail":"packages/core/src/x.ts is outside scope; needed to add the export"}]`)
- `E_MESSAGE`: conventional commit example (`"fix: apply agent filter in query"`)
- `E_BASE`: valid base ref (`"ocp-main"`)
- `E_REPO`: caller's repository key
- `E_DIRTY`: uncommitted files object (`{"files":[...]}`)
- `E_BOUNDS`: `"call wait first"` for both bounds: `In-flight limit <n> reached (<runs>). Wait for a child to settle (tools.team.wait) first.` and `Live team runs limit <n> reached (<runs>). Wait for a run to settle (tools.team.wait) first.` (the old texts pointed at a policy file that is never loaded: `api.ts` decodes `Policy` from `{}`). `<n>` is the caller's Children working at once / Live team runs in total row. In-flight and member limits count only live runs in `starting|working|idle|blocked_input` whose `sessionID` is not null; runs superseded because session creation failed never count.
- `E_NO_FOLLOWUP`: `followup` to a child whose Corrections by followup row is off (the reviewer preset's): `<child> takes no corrections by followup: delegate a fresh run with team_delegate and point it at the previous report (Briefs it accepts → Corrections by followup).` with `"delegate a fresh run"`
- `E_ROUNDS`: `"supersede and delegate a fresh run"` once a child has had as many corrections as its Followups per child row allows
- `E_BRANCH`: `"a task branch"` when the parent's branch matches the Protected branches row while that row is off
- `E_NO_COMMIT`: `{"status":"blocked","needs":[{"kind":"info","detail":"why nothing was committed"}]}` for `done` on a commit deliverable with no commit since the base, while its row is on
- `E_PERMISSION` (from `team_check`): `{"status":"blocked","needs":[{"kind":"check","detail":"<check id>"}]}` when the caller's Checks it may run row for that check's family is off
- `E_NOT_VISIBLE`: the caller's own run id when `status`, `wait` or `diff` names a run out of its reach; `"a run id from list{}"` when `wait` or `diff` names a run not in the namespace
- `E_REQUEST_ID`: `"requestID \"<requestID>\" was used with different arguments; reuse only to retry the identical call, else pick a new requestID."`; reuse guidance (`"pick a new requestID"`)
- `E_STALE_PARENT`: `"Your HEAD is <parentHead>; pass it as expectedParentHead (never the child's commit)."`; current parent HEAD commit string (`"<sha>"`)
- `E_TASK_BLOCKED`: `"Task <taskID> not found."`; empty array (`[]`) when task not found
- `E_TOO_LONG`: brief length guidance (`"pass briefFile"`)
- `E_CHECKS_RED`: blocked report status and needs (`{"status":"blocked","needs":[{"kind":"check","detail":"..."}]}`)
- `E_NOT_ACTOR`: caller is not run owner (`"This session is not the owner of run <id>..."`) or session has no repository directory (`"This session has no repository directory; open the chat in a git repository to use team tools."`)
- `objective`: schema validation refusal when `objective` is shorter than 20 characters (`"Expected a value with a length of at least 20"`)
- `E_BUSY`: `followup` with `delivery:"now"` against a working child refuses with
  `{"delivery":"queue"}`; the queued form is then delivered by the child's own
  idle handoff. `stop` on a working child requests stop after its turn (setting
  `stopRequested` on the run and returning `{ run, state: "stopping" }`), which
  `onSessionIdle` completes to `stopped`. The retained flag is consumed when
  the session is resumed, so the resumed turn settles `idle` (see below).
- `get_context` on a root run returns the run fields with `brief: null` (rather
  than failing `E_NO_BRIEF`). The `conventions` field has been removed.

New input and output fields:
- `wait` input `ack?: boolean` (default `true`). Output gains
  `acknowledged: RunID[]` — exactly the owned children whose settled attempt
  this call wrote `runs/<run>/ack.json` for. `ack:false` reads the same
  outcomes and acknowledges nothing, so `acknowledged` is `[]`.
- `wait` releases its internal race and pause timers as soon as it returns so
  a caller process is never held open past its result.
- `status` entries gain `acked: { attempt, at } | null`, read back from
  `runs/<run>/ack.json` (`RunAck` in `teams/schema.ts`). `status` itself never
  acknowledges, so `wait`'s `acknowledged` and `status`'s `acked` always agree.
- `list` and `status` entries carry `worktree: "present" | "removed" | "dirty"`,
  reporting whether the run's git worktree exists, has been removed (on landing
  via `integrate` or GC reaping), or is stopped with uncommitted/tracked modifications.
  `status` reports the record's value (`worktree` defaulting to `"present"`) next to
  its live `dirty` git read, so the registered `team_status` and `team_list` agree.

### Audit chain and permission gating (`teams/audit.ts`, `teams/tools.ts`)

Every gated invocation of a team tool (`team_*`) writes a tamper-evident, HMAC-SHA256 authenticated record of kind `tool.call` to `<teams data dir>/audit.log` (key stored at `<teams data dir>/audit.key` with file mode `0600`).

Each `tool.call` audit entry contains:
- `seq`: Monotonically increasing 1-based sequence number
- `at`: ISO 8601 UTC timestamp
- `kind`: `"tool.call"`
- `run`: Run ID associated with the session (e.g. `main-...` or `w-...`), or `null` if no run is bound
- `actor`: Agent role name (e.g. `"fable-planner"`, `"sol-orchestrator"`, `"muse-implementer"`)
- `sessionID`: Session ID where the call originated
- `tool`: Dotted/qualified tool name (e.g. `"team_delegate"`, `"team_status"`)
- `ok`: Boolean indicating call success (`true` when handler completed; `false` on permission refusal or handler error)
- `code`: Error code on failure (`"E_PERMISSION"` on permission gate refusals, or handler error code like `"E_NOT_ACTOR"`, `"E_ROLE"`, etc.; `null` on success)
- `durationMs`: Call duration in milliseconds
- `outcome`: Permission authorization outcome:
  - `"allowed"`: Tool call was permitted by the permission rules without requiring human approval (`ok: true` on success, or `ok: false` with handler error code)
  - `"asked:allow"`: Tool call required human confirmation (`ask`), human approved the request in the TUI, and the tool executed (`ok: true`)
  - `"denied"`: Tool call was refused at call time by a `deny` rule (e.g. a Code Mode team tool whose tool row is off, or a core rule a row installs); `runGated` was never reached (`ok: false`, `code: "E_PERMISSION"`)
  - `"asked:deny"`: Tool call required human confirmation (`ask`) and the human rejected it in the TUI, with or without feedback; `runGated` was never reached (`ok: false`, `code: "E_PERMISSION"`)

Which component writes which outcome, and why exactly one line is written per gated call:
- `"allowed"` and `"asked:allow"` are written by `runGated`, which runs only once the call is authorized. The `"asked:allow"` form is used when `permission.asked` named this invocation as its `source` (same session, message and tool CallID) and the user replied `once` or `always`.
- `"asked:deny"` is written by the `permission.replied` observer, when a reply of `reject` arrives for a request ID it mapped to a team invocation at `permission.asked`. It owns **both** human rejections: with feedback (core's `CorrectedError`) and without feedback (core's `DeclinedError`, a deliberate defect that never becomes a typed `Tool.Error`, so no `tool.execute.after` hook fires for it and the reply event is the call's only trace). A request ID is mapped once and dropped on its first reply, so a repeated or cascaded reply for the same request writes nothing further.
- `"denied"` is written by the `tool.execute.after` observer, and only for a permission refusal whose cause is not `Permission.CorrectedError` — that is, a `deny` rule refusing at call time, for which core creates no permission request and therefore publishes no `permission.replied` event.
- The three writers are disjoint by construction: an authorized call reaches only `runGated`, a rule denial reaches only `tool.execute.after`, and a human rejection is written only from the reply. A rejection with feedback is the single refusal both observers see, and `tool.execute.after` recognises its `Permission.CorrectedError` cause and leaves that line to the reply observer.
- Both are observers. They record outcomes and never decide them: neither writes permissions nor registers a `permission.evaluate` hook, and both read state scoped to the `registerTeamTools` registration, never a module global. The state is a FIFO queue of in-flight invocations keyed by `(sessionID, messageID, tool CallID)`, plus a request ID → invocation map. Under Code Mode one `execute` runs many team tools against the same `Tool.Context` — one CallID and one messageID — so each invocation claims its own queue entry: a sibling that completes first can neither overwrite nor consume a pending call's state, and the reply observer writes the line for the invocation its request named. An invocation with no queued entry (no `execute.before` hook fired) keeps local state instead.

### Run state follows the host session (`teams/lifecycle.ts`)

A run's state is driven by its host session, not by whether the agent called a
tool. `index.ts` subscribes to `session.execution.succeeded`,
`session.execution.failed`, `session.execution.interrupted`, and
`session.execution.started` (`SessionRunEvents`), resolves `sessionID → run`
with `run.bySession`, and ignores sessions with no run.
`session.execution.succeeded` is the host's canonical success event
(`SessionEvent.Execution.Succeeded`, published by core's `SessionExecution` at
the end of every busy period). `session.idle` is a deprecated schema event the
host no longer publishes; it stays in the subscription set only as a
compatibility alias that settles identically. On `session.execution.started`, a
run in `idle`, `starting`, `stopped`, or `dead` state transitions to `working`
(trigger `prompt` for `idle`, `resume` for others). Resuming a `stopped` or
`dead` run consumes a retained `stopRequested` intent first: that intent was
already satisfied by the stop that produced the state, so the resumed turn
settles `idle` instead of stopping again. A stop intent on a run that has not
stopped yet (`idle`, `starting`) is preserved and still stops it at
settlement. A `working` run is a no-op; `superseded` and `reaped` runs remain
unchanged. For turn-ending events (`session.execution.succeeded`,
`session.idle`, `session.execution.failed`, `session.execution.interrupted`),
`onSessionIdle` then, in this order:

1. settles the open attempt — `failed` on `session.execution.failed`,
   `interrupted` on `session.execution.interrupted`, otherwise (`session.execution.succeeded`,
   the deprecated `session.idle`) `no_report`
   (walked forward through `finishing` by `run.toFinishing`). An attempt whose
   `report-<n>.json` already exists belongs to `finish` and is left alone;
2. moves the run `working → idle` (`turn_ended`) or `starting → idle`
   (`connected`);
3. tells the parent once: one `child.settled` inbox item naming the run, the
   attempt, the settled status and the report path, guarded by `notified` on
   the attempt. An idle parent is prompted with it immediately; a working
   parent receives it through its own idle handoff;
4. drains the inbox with `inbox.take` into ONE new attempt (trigger
   `followup`), prompts the run's session with the rendered items and moves it
   `idle → working`. Items already recorded on an attempt's `inbox` list (a
   followup that was delivered immediately to an already idle child) are
   consumed without being prompted again.

`InboxKind` gains `child.settled`; `partition` and `batchNotify` classify it
with `notify` and `system`, so a batch of settlements reaches a parent as one
synthetic text.

`lifecycle.sweep(ctx, root)` is the one periodic tick: `startSweep` runs it at
`policy.sweep.tickMs` (default 2000 ms) forked on the plugin scope, so it is
cancelled with the plugin and never runs in a unit test that does not start it.
It returns `{ dead, gc }` — the reconciled dead run ids and the pass's whole
`GcResult` — and carries dead-run reconciliation plus garbage collection
(`gc(root, policy)` → `{ reaped, skippedDirty, orphansRemoved, removeFailed }`):
- Landed child worktrees are removed immediately upon successful landing via `integrate`,
  preserving the branch ref, run record, brief, reports, and receipts, and marking `worktree: "removed"`.
- Stopped and superseded runs older than `gc.reapAfter` (parsed from duration strings such as `"7d"`),
  not referenced by any open (non-terminal) merge queue entry, and not promoted from (when `keepPromotedFrom: true`),
  are transitioned to `reaped` and their worktrees removed. GC removes `superseded` worktrees with `--force`;
  a dirty `stopped` worktree is skipped from reaping and marked `worktree: "dirty"`.
- A run is reaped only once its directory is verifiably absent. When removal fails — a git-locked
  worktree is the usual case — the run keeps its state and its `worktree` value, stays claimed for the
  orphan scan, and is named in `removeFailed` instead of `reaped`; a later pass reaps it once removal succeeds.
- Orphan worktrees are detected and removed via `worktree.orphans(repoRoot, owned, knownDirs)`, where
  `owned` is `worktree.ownedRoot(root, repoKey)` — `<teams root>/worktrees/<repoKey>`, the directory
  `worktree.create` places its children in. Only unclaimed worktrees **under that directory** are
  candidates: another worktree of the same repository (a developer's own checkout) is never a candidate
  and is never removed. The temporary merge area (`<owned>/merge`) is also excluded: a live merge worktree
  is owned by the merge in flight, not by a run record.

### Provisioning and the orphan sweep are mutually exclusive (`teams/worktree.ts`, `teams/lifecycle.ts`, `teams/api.ts`)

A `delegate` provision has two steps — `worktree.create` and the child run record
that claims the new directory — while the periodic sweep force-removes worktrees
no run record claims. The two now share the repository lock
(`lock(root, "repo", repoKey, …)`):

- `delegate` runs `worktree.provision(root, opts, register)`, which holds the
  repository lock across `create` **and** the `register` callback that writes the
  starting `run.json`. No sweep decision can observe the new worktree between
  those steps, and no other `create` or `remove` for that repository interleaves.
- `gc`'s orphan step takes the same repository lock and **re-lists the run
  records inside it** instead of trusting the snapshot it read at the start of
  the pass. A pass whose earlier steps took seconds — merge scans, dirty checks,
  reaping — can no longer judge a worktree created meanwhile unclaimed. The
  removal itself runs under that lock via `worktree.removeLocked`; `worktree.remove`
  keeps its own lock for every other caller.
- `worktree.orphans(repoRoot, owned, knownDirs, { minAgeMs })` treats any
  candidate **younger than `policy.timeouts.startMs`** (default 60000 ms) as
  owned. A directory that may still be mid-provision — created outside the lock
  path, or whose record write has not started — is protected for that window
  instead of force-removed; a genuinely abandoned worktree is swept by a later
  pass once it is older than the bound.

`worktree.create` and `worktree.remove` keep their own repository-lock holds, so
callers outside `delegate` retain the same mutual exclusion without registering a
run record.

### A run's worktree state is owned by whoever removes the directory (`teams/run.ts`, `teams/lifecycle.ts`, `teams/api-integrate.ts`)

`run.json`'s `worktree` field follows the directory it names: `present` while it
exists, `dirty` when GC found uncommitted changes in a stopped run's copy, and
`removed` once the directory is gone. The pass that removes the directory owns
the field, and `removed` is terminal for it.

- `saveRun` enforces that at the record boundary: when the record already on
  disk has `worktree === "removed"`, the write keeps `removed` — whatever the
  caller supplied, `"present"`, `"dirty"` or an omitted field — and applies
  every other field of the caller's record unchanged. A stored `removed`
  therefore survives any later full-record write, by any writer. This is a
  field-level guarantee for `worktree` only, not a general lost-update fix:
  other fields written from a stale copy can still be overwritten.
- `integrate` marks a landed child `removed` only after `worktree.remove`
  succeeds, and applies the mark through `run.updateRun`, so only that field
  changes on the record as it is at write time.
- The passes that settle a run without a tool call — `reconcile`'s dead-run
  pass, `session.execution.started`, and `onSessionIdle` (including the stop
  transition when `stopRequested` is set) — also load, modify and write through
  `run.updateRun`, in one `state` lock hold. Their writes are based on the
  record as it is after a concurrent removal, so a settle that began before a
  landing cannot resurrect the worktree that landing removed. Either
  interleaving ends with `removed`.
- `updateRun(root, id, update)` reads `runs/<id>/run.json`, calls `update` with
  the current record, and writes what it returns under the same `state` lock
  `loadRun`/`saveRun` use; returning the record unchanged skips the write. It
  never creates a record, so the `run.created` audit entry stays `saveRun`'s.
- `deliverInbox` in `teams/lifecycle.ts` is included: both its working-delivery write
  (transitioning the run to `working` with the newly admitted attempt) and its prompt error
  rollback path apply their updates to the current on-disk record through `run.updateRun`.
  A child whose worktree is removed while inbox delivery is in flight or whose prompt fails
  cannot have a stale `present` written back over `removed`.
- `saveRun` latches a stored `removed`: when the record on disk already reads
  `worktree: "removed"`, any later full-record write keeps `removed`, whatever the
  caller supplied (`"present"`, `"dirty"`, or an omitted field), while every other
  field of that write is applied unchanged. Because that guard sits in `saveRun`,
  it covers **every** full-record writer — GC's snapshot writes and the
  `loadRun` → `saveRun` handlers in `api.ts`, `api-lifecycle.ts` and
  `api-followup.ts` included — without needing any claim about which of them can
  run concurrently with a removal. This is a **field-level guarantee for
  `worktree` only**, not a general lost-update fix; other fields written from a
  stale copy can still be overwritten.

### Project mode resolution, worktrees and activation (`project.ts`, `teams/worktree.ts`, `teams/run.ts`, `index.ts`)

- `project.read(directory)` resolves **upward**: it walks parent directories until it finds a
  `.opencodeplus/project.json` or reaches the filesystem root, and the nearest config wins. A session
  opened below an enabled checkout therefore reads the same project, and `project.status` reports
  `enabled: true` for it. A config carrying `enabled: false` is an explicit opt-out: it stops the walk
  and reports disabled, so a nested directory can leave an enabled ancestor's project. A directory with
  no config anywhere in its ancestry stays disabled. `enable` returns the resolved config unchanged when
  one already exists upward and otherwise writes `.opencodeplus/project.json` in the directory it was
  given; `disable` writes the explicit marker there (the nearest resolved config with `enabled: false`)
  instead of deleting a file the upward walk would immediately re-inherit.
- `worktree.create` resolves the new directory to an absolute path, creates its parent chain before
  `git worktree add` runs, and returns the `realpath` of the created directory. A brand-new data root
  has no `worktrees/` yet: the first `delegate` must hand the host a directory that
  `FileSystem.realPath(location.directory)` can resolve, and a data root reached through a symlink must
  not yield two names for one worktree.
- Team worktrees are **not** Plus projects. `create` writes no `.opencodeplus/project.json` into them
  (there is no inherited copy, and no default file), and `worktree.remove` is a plain
  `git worktree remove` with no config special case. A `project.json` that is tracked in the repository
  arrives with the checkout and is left alone.
- `delegate` records `projectDirectory` on the child's `run.json`: the parent run's recorded
  `projectDirectory`, else the parent's own `directory`. The root-run bootstrap records the Location's
  own directory. Activation for a run's session cannot walk up from the worktree — the worktree is
  outside the parent's tree — so `activationDirectory(directory)` (`index.ts`) returns the recorded
  `projectDirectory` when `teams/run.ts` `byDirectory` finds the run that owns the Location, else the
  Location's own directory; `activate` and `refreshFromHost` both resolve through it, and
  `project.read` then reads the parent's project config. `byDirectory` compares canonical paths, so a
  symlinked or relative data root still matches its run.
- `delegate` writes the starting child run to disk **before** the host creates its session. Creating the
  session activates Plus in the new worktree, and the periodic sweep collects any worktree no run record
  claims as an orphan; a record saved only afterwards leaves a window in which the first delegate's
  worktree is removed before the host's `FileSystem.realPath` resolves it. The pre-registration makes
  the orphan scan claim the directory immediately, and activation resolves the run by directory because
  no session id exists yet; the session id is written on the same record once the host returns it.
- Every `createPlusApi` handler (project guards, `snapshot`, `mutate`, `log`, `assembled`, and the
  agent/skill/base/instruction/mcp/team/rule writes), `project.status`, `activate`, `refreshFromHost`,
  `publishFresh` (including its team discovery and team policy rows) and `applySessionModel` resolve
  their project directory through `activationDirectory`, so a child worktree's API sees and edits the
  project its run recorded. `project.enable` and `project.disable` act on the Location's own directory,
  never the inherited one.

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
// A preset as tools name it: "<id>" (agent preset), "<team>/<member>" (member preset), or the RPC PresetRef.
export type PresetInput = string | PresetRef
export interface SetInput { readonly id: string; readonly text?: string; readonly state?: "on" | "off"; readonly resolve?: ToolResolve; readonly pin?: boolean; readonly active?: boolean; readonly label?: string; readonly patterns?: readonly string[]; readonly keywords?: readonly string[]; readonly message?: string; readonly preset?: PresetInput | null }
export interface ResetInput { readonly id: string }
export interface SplitInput { readonly id: string; readonly boundaries?: readonly Boundary[]; readonly add?: { readonly name: string; readonly text: string } }
export type CreateInput =
  | { readonly kind: "agent"; readonly id: string; readonly scope?: "project" | "global"; readonly preset?: PresetInput }
  | { readonly kind: "skill"; readonly name: string; readonly body: string }
  | { readonly kind: "base"; readonly id: string; readonly title: string; readonly text: string }
  | { readonly kind: "instruction"; readonly name: string; readonly text: string }
  | { readonly kind: "mcp"; readonly name: string; readonly config: Record<string, unknown> }
  | { readonly kind: "team"; readonly team: string; readonly level: "project" | "global"; readonly preset?: string }
  | { readonly kind: "member"; readonly team: string; readonly level: "project" | "global" | "defaults"; readonly id: string; readonly preset?: PresetInput }
  | { readonly kind: "entry"; readonly catalogue: "agents" | "teams"; readonly name: string; readonly team?: string; readonly preset?: PresetInput }
  | { readonly kind: "preset"; readonly id: string; readonly from?: PresetInput }
  | { readonly kind: "teamPreset"; readonly id: string; readonly from?: string }
  | { readonly kind: "presetMember"; readonly team: string; readonly id: string; readonly from?: PresetInput }
  | { readonly kind: "model"; readonly providerID: string; readonly modelID: string; readonly variant?: string; readonly level?: "project" | "global" | "defaults" | "preset"; readonly agent?: string; readonly catalogue?: "agents" | "teams" }
  | { readonly kind: "rule"; readonly tool: string; readonly id: string; readonly label: string; readonly patterns: readonly string[]; readonly keywords?: readonly string[]; readonly message?: string; readonly level?: "project" | "global" | "defaults"; readonly agent?: string; readonly catalogue?: "agents" | "teams" }
// Every kind resolves to CreatedRow: { id, item }, where id is the row id
// show/set/delete accept and item names the created thing inside its row kind
// (`skill:…`, `model:…`, `perm:…`, or the agent/team/member id). The RPC's own
// fields (path, name, level, agent, tool, providerID, modelID, …) pass through
// beside them. A create whose written row is not in the tree fails with
// create.failed and never returns a hand-formatted id.
export interface CreatedRow { readonly id: string; readonly item: string }
export interface DeleteInput { readonly id: string; readonly confirm: true }
```

- `list` returns the matching row ids (default projection `id, badges,
  source, tokens`; `limit` defaults to 40, and since every tool lists its
  catalog rows an agent's perm rows run well past it). Filters (`where`) support `server:<name>`, which matches both the `mcp:<name>` server row and its tool rows (e.g. `where: "server:search"` returns `mcp:search` and all search tools). `show` defaults to view
  `resolved`. On a perm row every view but `record` returns the rule view
  (`tool`, `rule`, `label`, `patterns`, `keywords`, `provenance`, `custom`,
  `enabled`, `source`, `category`, `kind` — the row's `permKind`, `rule` when
  absent — plus `field` and `value` when the row has them and `limit` — the
  resolved number, `null` when the text holds none — on a limit or bound row;
  plus a scrub preview: `scrub.hidden` lines would drop,
  `scrub.preview` shows up to 3; plus `message` when the rule has one — a
  user rule's own text, or for a shipped row the curated text, else the
  catalog row's own; plus `policy` on a team role row). Team and member rows
  carry no item address: `resolved` (default) returns the entity
  (`{ kind: "team", level, team, enabled, members, overlay? }` or
  `{ kind: "member", level, team, member, registered }`, where `registered`
  says whether the host currently registers that agent) and `record` returns
  the same entity nested under `record`; every other view fails with
  `view.unsupported`. `assembled` renders the full effective prompt and accepts agent
  row ids only (`agent:<level>:<id>`); any other id fails with
  `view.unsupported`. `record` returns the raw override including `pin`
  when set. `diff` returns two unified diffs (original→mine and
  original→upstream) plus a one-line summary. `set` with `pin` keeps the
  tool's full listing inline in the catalog even when the inline budget is
  tight. `set` with `active: true` activates a model row exclusively at that
  level (a bare `set` on a model row activates too; model rows refuse text,
  state, pin, and resolve); on a perm row `state` applies, or `label` +
  `patterns` (`keywords` optional) to update the rule through `rule.update`,
  or `message` alone to set the refusal text (a message-only edit derives
  label and patterns from the rule it edits), or `text` on a limit or bound
  row (`isValueRow`) to set its number — `set({ id, text: "8" })` stores the
  first integer in the text, anything without one fails with `"<label>" takes
  a number (got "<text>")`, and `text` on any other perm row is still
  refused (no pin, active, or resolve). `set` with `resolve: "keep"`
  acks upstream keeping text, `"take"` drops stored text and follows upstream,
  `"edit"` stores `text` against current upstream. `reset` deletes the
  override at that row (on a model row clears only that level's active flag).
  `split` boundaries are `{ id, name, start }` with
  character offsets into the row text; `add: { name, text }` appends a new
  trailing section; perm and model rows cannot be split. `create` writes one row per call and returns `CreatedRow` fields: `id` is the
  row id `show`, `set` and `delete` accept for that row, `item` names the
  created thing inside its row kind (`skill:…`, `base:…`, `mcp:…`, `model:…`,
  `perm:…`, or the agent/team/member id), and the RPC's own fields pass through
  beside them. `create` with `kind: "agent"` needs `id` (`scope`
  defaults to project, `preset` optional: no preset is everything off). `create` with
  `kind: "team"` creates the team directory DISABLED (enabling stays a
  separate `set` on the team row) and passes an optional team `preset` through
  `team.create`, so the members match the TUI's team create.
  `create` with `kind: "member"` needs `team` + `level` + `id` and
  calls `team.addAgent` (`preset` optional); at `level: "defaults"` it adds a
  Teams member entry and returns `team:defaults:<pattern>:<name>`; the team name
  is trimmed exactly as `team.addAgent` trims it before the row is resolved.
  `entry` calls `entry.create`, `preset`/`teamPreset` call `preset.create`,
  `presetMember` calls `preset.addMember`, each returning its tree row id.
  `set({ id, preset })` relinks the row's owner (`link.set`; `null` unlinks;
  refused on rows with no owner). `delete` removes Defaults entries and User
  presets through `removalPlan`'s `entry.delete` / `preset.delete` plans; an
  in-use preset surfaces `preset.inUse` with the linked row ids. Presets are not
  agents: `protectedAgents` never refuses a preset row, while an agent,
  member or team member's link stays protected. `create` with `kind: "model"` needs
  `providerID` + `modelID` (`variant`/`level`/`agent` optional); `level`
  defaults to `project` and project/global levels require an `agent`, so a
  model with no `agent` is only the shared Defaults row when `level` is
  explicitly `defaults`. `create` with `kind: "rule"` needs `tool` + `id` +
  `label` + `patterns` (patterns are core wildcards, not regex); `message` is
  the optional refusal text the model reads; `level` defaults to `project` and
  a rule with no `agent` is stored at that requested level. The returned row is
  resolved through the same tree the TUI shows: an agent-qualified create is
  resolved at its own level and owner, never reported as the identical Defaults
  row, and a shared (`agent: null`) rule is resolved through its canonical
  visible Defaults catalogue row (`item:defaults::…`, or
  `item:defaults:/teams:…` for `catalogue: "teams"`) while the record keeps its
  requested level. A create whose row
  cannot be found fails with `create.failed` and does not invent an id; file-
  derived rows (skills, MCP servers) are given a short window for the host's
  watcher to publish them before that failure. `create` takes an optional
  `catalogue` (`agents|teams`, default `agents`) that picks which catalogue a
  shared (`agent: null`) `model` or `rule` lands in; `base`, `instruction` and
  `mcp` create one file both catalogues list, so `catalogue` does not change
  what is written. `create` with `kind: "instruction"` is refused with
  `instruction.disabled` pending the Context catalogue: OpenCode applies
  AGENTS.md files and no instruction row is created or bare-name enabled.
  `delete` without
  `confirm: true` fails with `delete.unconfirmed` and writes nothing;
  on a model row it removes the candidate at that level, and only
  user-created (`custom`) rules can be deleted.
- Row ids (same string in the TUI filter, tool calls, the log, and error
  messages): `item:<level>:<owner>:<itemId>` and
  `section:<level>:<owner>:<itemId>:<sectionId>`, where `<owner>` is the agent
  id, `''` for the Agents-catalogue shared Defaults row, `/teams` for the
  Teams-catalogue one, `<team>/:<member>` for a team member's row and
  `<team>/:special:<id>` for a team special agent's. Plus `agent:<level>:<id>`,
  `team:<level>:<name>`, `team:<level>:<name>:<member>`,
  `team:<level>:<name>:special`, `team:<level>:<name>:special:<id>`, catalogue
  roots `group:<level>:agents` and `group:<level>:teams`, inventory groups
  `group:defaults::<category>` and `group:defaults:/teams:<category>`, member
  group prefixes `group:<level>:<team>/:<member>:<group>` and
  `group:<level>:<team>/:special:<id>:<group>`, a tool row's
  `group:<level>:<owner>:tool:<id>:description` and
  `group:<level>:<owner>:tool:<id>:permissions[:<category>]`, a shared perm
  row's listing under another tool `item:<level>:<owner>:perm:<tool>:<rule>@<tool>`
  (the same address as the row itself), and item ids
  `model:<providerID>/<modelID>[@<variant>]` and
  `perm:<toolId>:<ruleId>` (a catalog row's rule id is `<category>.<row>`).
  `<level>` is `project`,
  `global`, or `defaults`. Every id that resolved before the catalogue split
  still resolves and still means the Agents catalogue.
- Guards: a write whose actor is a tool cannot change a row belonging to an
  agent listed in `protectedAgents`, through any surface — the tool wrappers,
  the RPC, or `instructions.mutate` with a caller-supplied actor — and fails
  with `agent.protected` (`{ agent, id?, reason }`); a missing actor is the
  TUI and never refuses. `instructions.mutate` decides from the changed rows
  only, so carrying a protected agent's unchanged records in a full-snapshot
  mutate is not a refusal. The guard covers the item-record cascade as well:
  deleting a rule, skill, base template or MCP server as a tool actor is
  refused when any protected agent holds a customization or split for that
  item, and the refusal is decided before anything is written — the rule
  record, the file on disk, every record and the log all stay untouched.
  Unknown ids fail with `row.unknown`. A no-op or a refusal writes nothing
  and logs nothing.

### Applying Code Mode rows (`apply.ts`, `model.ts`)

A resolved `off` on a Code Mode tool or on `execute` installs an agent
permission rule `{ action: <tool id>, resource: "*", effect: "deny" }`;
denying `execute` removes Code Mode (and its catalog instruction) for that
agent. Resolved text and pin install through the `session.catalog` hook
keyed by the qualified catalog path (`<namespace>.<normalized name>`),
derived from the Item's namespace plus the normalized title
(`title.replace(/[^a-zA-Z0-9_-]/g, "_")`) rather than reversible from the
registry id. The hook only mutates entries that already exist: an unknown
path is skipped.

### Permission rules (`permission-catalog.ts`, `permission-enforce.ts`, `tool-permissions.ts`, `discover.ts`, `apply.ts`, `assembled.ts`, `index.ts`)

- Rows come from four sources. The per-tool catalog (`permission-catalog.ts`,
  below) gives every tool, Code Mode and MCP included, its categories of
  rows. Team rows come from `team-policy-rows.ts` (Team rules are instructions
  rows). Two view-time sources are merged by `mergeRules` (curated
  label wins on a pattern-set collision; most-mentioned discovered first,
  then unmentioned curated generics): the curated registry (shell, edit,
  write, read, webfetch, glob, grep entries, plus one `idRules` row per
  discovered agent/skill id for `subagent`/`skill`), and candidates mined
  from text Plus already holds (tool/base/skill/role/file/teaching rows,
  with `provenance` naming the mentioning item ids). The merged rank carries
  through as `Item.order` so the tree shows most-mentioned first. User
  `RuleRecord` customs overlay as `custom: true` rows; a record whose
  `tool` + `id` is a catalog row's keeps what that row is (its category, kind,
  input field, fallback or allow role) and replaces only its label, patterns,
  keywords and message (`discover.ts` `permItems`). Mined and catalog rows are
  view-time only: never persisted, and never part of the publish fingerprint
  (`fingerprintPublish` and the publish snapshot keep only the perm items
  carrying `policy` or `agents` — team rows, so a run starting or settling
  republishes; a stored state, number or `RuleRecord` enters via `records`).
  The TUI add-rule
  flow prompts for scope (row scope when invoked on a tool or perm row,
  otherwise level then agent); custom rules are globally unique by `(tool, id)`,
  not per level/agent (`rule.add`/`rule.remove`/`rule.update` match by tool+id
  only, ownership and logging follow the record actually matched).
- Display and enforcement resolve one chain for every item kind (tools,
  skills, base, system, perm) and the active model. An OpenCode built-in
  (`build`, `plan`, `explore`, …: origin native or special, discovered at
  Defaults, no team) owns a visible row under Project, Global and Defaults
  alike (`nativeAgentsForLevel`/`specialAgentsForLevel` in `tree.ts`) and ops
  writes at the row's own address; its runtime answer is its Project row's:
  `project/A → global/A → link → Defaults entries → defaults/A →
  defaults/null` (`runtimeScope` in `model.ts`, used by `apply.ts`
  `resolvedFor`/`applyModels`, the active-model cache, the prompt baselines
  and the assembled view). `scopesOf` lists these agents at Global, so the
  tree's Project row reads the same chain. A Defaults entry `*` turning
  `tool:shell` off therefore shows off under Project → build and removes
  shell at runtime. Any other agent resolves at its own level, the row it is
  shown on: a host agent the tree lists under Defaults only resolves at
  Defaults, and a team-scoped agent keeps its chain and the Teams catalogue.
  MCP server rows live at Defaults for every agent only and resolve there.
- Toggling any row is a `CustomizationRecord` with state on/off on the
  `perm:<tool>:<rule>` item address, so `resolve()` already yields
  `enabled`; a limit row's number is that record's `text`. Every rule-kind
  perm item (`permKind` absent or `rule`) OFF for an agent installs one core
  deny per pattern (`{ action, resource: pattern, effect: "deny" }`) through
  the agent registration (`apply.ts` `permDenials`). Rule rows only ever
  refuse: a category's fallback row and its allow-list rows are input rows,
  checked on the call itself, so no core allow from one category can reopen
  what another row or a role row closed. The denies land last in
  `orderRules` order (below). Rows of every other kind install no core rule:
  `permission-enforce.ts` answers them. The action comes from the
  per-rule `permAction` carried on the perm item by discovery (the tool's own
  `options.permission`), falling back to `actionForToolId`: `edit`/`write`/
  `patch` share core's `edit` action, every other tool uses its own id.
- Patterns are CORE RESOURCE WILDCARDS over the tool's permission resource,
  NOT regex: `*` spans any run, `?` matches one character. For shell the
  resource is the parsed command text, so `git *` also matches a bare `git`
  (the curated head-only rules still carry both `git` and `git *`); for file
  tools the resource is the file path (project-relative inside the project,
  absolute outside it), for webfetch the URL, for glob/grep the user's
  search pattern (a core rule cannot scope a directory walk: core authorizes
  `input.pattern`, so `grep({ pattern: "HEAD", path: ".git" })` evaluates
  resource `"HEAD"`; the Search roots rows and grep's Files rows read `path`
  at the tool hook instead), for subagent/skill the exact id. Operation-scoped
  patch restriction is not expressible as a core rule: core's permission
  resource for patch is the file path only (core/src/tool/plugin/patch.ts
  asserts `action: "edit"`), and the hunk type never reaches the permission
  layer. Carrying it as an extra resource or an extra action both change
  decisions for existing configurations that never enabled Plus, and a
  targeted opt-in cannot be defined reliably against the wildcard matcher. So
  core rules cannot tell add/update/delete apart; patch's Operations rows read
  `patchText` at the tool hook instead (add, delete, move), and the
  `edit`-action path rules still apply to patch. The tool-input rows match
  with `wildcardMatch`, Plus's copy of core's wildcard (a trailing ` *` also
  matches the bare head). User
  patterns validate through `validateRuleInput` (at least one non-empty
  pattern; keywords default through `keywordsForPattern` when omitted).
  `commandHeads` (Plus's own head-depth table: `git: 2`, `docker: 2`,
  `rm: 1`, …) drives the miner's `git rebase *`-style patterns.
  `mineGenericPaths` only keeps a token that is a glob containing `/` or an
  extension, or a path whose last segment carries a file extension, stripping
  trailing sentence punctuation and source-location references
  (`src/services/process.ts:712.` → `src/services/process.ts`).
- Keywords derive only through the single `keywordsForPattern`: head word
  plus subcommand words, stopping at the first wildcard or flag (`git push
  *` → `["git push"]`); a pattern with no literal leading word falls back
  to its first meaningful segment (`*.git*` → `[".git"]`). Catalog rows ship
  no keywords — their patterns name common words (`cp`, `touch`, `tee`) that a
  derived keyword would strip from unrelated guidance — so turning one off
  scrubs no prompt line. Saving one through the rule editor or `rule.update`
  makes it a user rule, whose blank keywords derive like any rule's.
- Scrub points (all line-level whole-word, case-insensitive
  `scrubLines`/`containsWholeWord`): the `session.context` hook (every tool
  description plus every system part, after the text plans), the
  `session.catalog` hook (Code Mode catalog descriptions, after the
  text/pin plans), and the `assembled` view (registry descriptions, system,
  and skill content). Empty keyword sets install no extra hooks.

#### The per-tool catalog (`permission-catalog.ts`)

`catalogFor(tool, group)` names the categories a tool lists: native, team,
instructions, release, search and opencode tools by their tables, `browser_*`
tools by what each does to a page, any other tool of group `mcp` or `plus`
the Approval category alone (an MCP leaf and the plugin gate both reach a
permission check), every other tool nothing. `catalogItems` turns each
category of each tool row into ordinary perm items, `perm:<tool>:<category>.<row>`,
carrying `permTool`, `permAction`, `ruleId`, `patterns`, `category`,
`permKind`, `field` (the row's, else the category's), `value`, `measure`,
`mode`, `message`, `fallback`, `allow` and `alsoUnder`, and an empty
`keywords`. A row's text is its label and patterns — a limit row's is just
its number. The module is data plus the helpers every enforcer shares:
`wildcardMatch` and `valuesAt` (a dotted field whose `[]` segments walk
arrays: `scope.paths[]`, `questions[].multiple`).

Row semantics, the same in every category:

- The fallback ("Everything else") row — Every other file, Every other site,
  Every other command, or Outside this checkout in read's and edit's Where —
  is the category's default. On leaves the agent's own answer in place; off
  refuses everything the category's allow-list rows do not let through
  (Outside this checkout: only paths outside the Location directory). A
  fallback is always an input row, checked on the call, even inside a rule
  category (read's Every other file reads `path`, shell's Every other command
  `command`).
- A deny-list row, the default, refuses what it matches while it is off. It
  ships on (nothing refused) unless what it guards is never wanted.
- An allow-list row (`allow: true`: Temporary directories, `/tmp/*` and
  `*/run/plus/tmp/*`, in read's and edit's Where) lets its patterns through
  while it is on, and only matters once the fallback is off.
- A limit or bound row carries its number as its text; on applies it, off
  removes the cap.

Shipped off in the catalog: every `limit` row, every Approval row, question's
In delegated team runs, subagent's Team members (without a team run),
team_finish's A commit deliverable has at least one commit, and
team_followup's Followups per child. Every other catalog row ships on,
team_delegate's four bounds included.

How each kind is enforced (`model.ts` `PermKind`):

| kind | enforced by | what the row does |
| --- | --- | --- |
| `rule` | core rules (`apply.ts` `permDenials`) on the tool's own permission resource | off denies what the patterns match (a refusal: it lands last) |
| `input` | `tool.execute.before`, wildcards over every value at `field` | off refuses a call whose value matches; a fallback off refuses every value it covers that no on allow row lets through |
| `value` | `tool.execute.before`, `session.context` | off refuses a call using the literal — supplied, or left to the tool's default (the category's `default`: webfetch `markdown`, effort `medium`, delivery `queue`, until `settled`, diff from `base`, Tavily depth `basic` and topic `general`, Exa type `fast`) — and drops it from the direct tool's schema |
| `param` | `tool.execute.before`, `session.context` | off refuses a call that uses the parameter (at `value`, when set) and drops it from the schema (`timeout: 0` becomes `minimum: 1`, `approvalRef: null` loses `null`) |
| `limit` | `tool.execute.before` (`session.context` sets `maximum` for a `value` cap) | on applies the number: `clamp` lowers a larger top-level number to it, `refuse` refuses above it; `measure` is the number itself, the longest string (`length`) or the count of entries (`count`; patch counts `*** Add/Update/Delete File:` headers) |
| `approval` | `tool.execute.before`, `permission.evaluate`, the permission reply events | on asks the human before each call; a delegated run is refused instead |
| `env` | `tool.execute.before`, `shell.create.before` | off strips the matching environment variables before the command starts |
| `team` | the team handlers (`teams/reach.ts`) | as each row says (Team rules are instructions rows) |

The detail pane's `enforced by:` line (`detail-pane.tsx` `enforcementLine`)
says the same per row:

```
rule, role row  role rule: installs its own core rules on <action>
rule            core rule on <action>: off refuses what the patterns match
input, Where    tool input (<field>): off refuses paths outside this checkout unless an allowed row below matches
input, fallback tool input (<field>): off refuses everything this category's allowed rows do not let through
input, allow    tool input (<field>): on lets its patterns through while this category's first row is off
input           tool input (<field>): off refuses a call whose value matches the patterns
value           tool input (<field>): off removes "<value>" from the schema and refuses it
param           tool input (<field>): off removes the parameter from the schema and refuses a call that uses it
limit           limit on <field> (<measure>, lowered to the cap | refused above it): on applies the number
approval        approval: on asks the human before the call; a delegated run is refused instead
env             shell environment: off strips the matching variables before the command starts
team            read by the team tools themselves
```

Rows whose meaning is not one pattern over one field (`permission-enforce.ts`
`specialRefusal`, `paramUsed`): write's Operations tell create from overwrite
by whether the path, resolved against the Location directory, exists; patch's
by the `*** Add File:`, `*** Delete File:` and `*** Move to:` lines in
`patchText`; subagent's Team members refuses an `agent` that is a member of an
enabled team; an `instructions_*` tool's Its own rows refuses a row id that
addresses the caller — owner segment `<agent>` (`item:<level>:<agent>:…`),
a Teams-catalogue owner `<team>/:<agent>`, `agent:<level>:<agent>` or
`team:<level>:<team>:<agent>` (`addressesAgent`) — while the other Rows it may
change match the id; Secrets in rows never refuses (it masks results);
browser_tabs_list's Use refuses every call while off; the Sites of a
tab-scoped browser tool (`field: tabID`) judge the tab's current page as the
browser tools' own results last reported it — a page not known yet passes
unless the fallback is off (`the page of tab <id> is not known yet; open it
with browser.tabs.open or browser.navigate first`). An Outside this checkout
input row (`<category>.outside`) matches a value that resolves outside the
Location directory (`~` expands), and the opencode session tools' Other
sessions row a `sessionID` other than the caller's.

Where a row lists (`categoryOfRow`, `categoryLabel`, `categoryOrder`,
`hostOf`): a catalog or team row carries its own `category`; a mined row goes
to `suggested`, "Mentioned in instructions"; curated, `idRules` and user rows
take their tool's legacy category — shell Commands, edit/write/patch/read
Files, webfetch Sites, glob/grep Search patterns, subagent Agents, skill
Skills — else Rules. Shell's and read's legacy categories share the catalog's
ids (`commands`, `files`), so their curated and catalog rows list together;
edit's legacy Files sits beside Protected files. Row ids never changed, so
stored overrides keep resolving; only where the rows list moved.

Categories per tool (catalog and legacy; kinds in parentheses, numbers are
the shipped limits):

| tool | categories |
| --- | --- |
| `read` | Files (rule: secret files and the curated rows; fallback Every other file, input `path`) · Where (input `path`: fallback Outside this checkout, allow Temporary directories) · Content (input `path`: images, PDFs) · Limits (Lines per read 2000, clamp) · Approval |
| `glob` | Search patterns (curated) · Search roots (input `path`: outside) · Parameters (`hidden`) · Limits (Results per call 100, clamp) · Approval |
| `grep` | Search patterns (curated) · Files (input `path`, fallback: secret files; filters results) · Include filters (input `include`) · Search roots (input `path`) · Limits (Matches per call 100, clamp) · Approval |
| `edit` | Files (curated; also under patch) · Protected files (rule: keys, credentials, `.opencodeplus/`, `.github/`, agent and team definitions, AGENTS.md, `release/`, tests; also under write and patch) · Where (input: fallback Outside this checkout, allow Temporary directories; also under write and patch, patch's paths read from its headers) · Parameters (`replaceAll`) · Approval |
| `write` | Files (curated) · Protected files, Where (edit's) · Operations (input `path`: create, overwrite) · Limits (Largest file written 200000 characters, refuse) · Approval |
| `patch` | Files, Protected files, Where (edit's) · Operations (input `patchText`: add, delete, move) · Limits (Files per patch 20, refuse) · Approval |
| `shell` | Commands (rule; fallback Every other command, input `command`: curated rows, git working-tree changes, git refs and worktrees, file writes, stopping processes by name, inline interpreter code, registry runs, network tools, service control, database shells, GitHub CLI, printing secret files, workspace scripts) · Working directories (input `workdir`: outside) · Parameters (`background`, `timeout: 0`, `workdir`) · Environment (env: keys, tokens, passwords) · Limits (Longest timeout 600000 ms, clamp) · Approval |
| `question` | Parameters (`questions[].multiple`) · Limits (Questions per call 4, refuse) · When (approval: In delegated team runs, off) |
| `subagent` | Agents (one row per agent id) · Team members (input `agent`, off) · Parameters (`background`, `sessionID`) · Approval |
| `skill` | Skills (one row per skill id) · Approval |
| `webfetch` | Sites (curated) · More sites (rule: private networks, cloud metadata, paste and capture sites) · Formats (value `format`) · Limits (Longest timeout 60 s, clamp) · Approval |
| `websearch` | Queries (rule: keys and tokens, local paths) · Approval |
| `execute` | Limits (Tool calls per run 50, refuse: Code Mode inner calls per `execute` call) |
| `opencode_session_move` | Sessions (param `sessionID`: other sessions) · Destinations (input `directory`: absolute paths, `../`) |
| `opencode_session_rename` | Sessions (param `sessionID`) · Limits (Longest title 80 characters, refuse) |
| `team_delegate` | Deliverables (value `deliverable.kind`) · Effort (value `effort`) · Scope it may grant (input `scope.paths[]`: edit's protected paths) · Checks it may assign (input `checks[].argv`) · Parameters (`repo`, `base`, `briefFile`, `prompt`, `task`) · Limits (team: 4, 3, 6000, 12, on) · Requirements (team: reason) · Approval |
| `team_followup` | Delivery (value `delivery`) · Parameters (`budget`) · Limits (team: Followups per child 5, off) · Approval |
| `team_integrate` | Outcomes it lands (team) · Branches it lands on (team: protected branches) · Approval |
| `team_checkpoint` | Commit types (input `message`: feat, fix, docs, chore, refactor, test) · Limits (Files per checkpoint 50, refuse) · Approval |
| `team_finish` | Outcomes (value `status`) · Needs (value `needs[].kind`) · Requirements for done (team: checks on, commit off; a member's clean row) |
| `team_set_checks` | Check commands (input `checks[].argv`) · Approval |
| `team_supersede`, `team_stop` | Approval |
| `team_status` | — |
| `team_wait` | Wait until (value `until`) · Parameters (`ack: false`) · Limits (Longest wait 600000 ms, clamp) |
| `team_diff` | Compare against (value `from`) · Limits (Largest diff 200000 bytes, clamp) |
| `team_list` | Parameters (`all`) |
| `team_get_context` | Contents (team: siblings) |
| `team_check` | Checks it may run (team: test files, package scripts) |
| `instructions_list`, `_show`, `_log` | Secrets in rows (input: Show secret values; off masks) · Approval |
| `instructions_set` | Rows it may change (input `id`: its own rows, perm, model, team, Global and Defaults rows) · Changes (param: `text`, `state`, `pin`, `active`, `resolve`, `patterns`) · Approval |
| `instructions_reset`, `_split`, `_delete` | Rows it may change · Approval |
| `instructions_create` | Kinds (value `kind`) · Levels (value `level`) · Approval |
| `release_request` | Kinds (value `kind`: build, promote) · Targets (value `artifact.target`) · Parameters (`approvalRef: null`) · Approval |
| `release_status` | Approval |
| `search_tavily_search` | Queries (input `query`) · Search depth (value `search_depth`) · Topics (value `topic`) · Limits (Results per search 10, clamp) · Approval |
| `search_tavily_extract` | Sites (input `urls[]`, fallback: localhost, private networks, cloud metadata, plain HTTP, paste sites) · Extract depth (value `extract_depth`) · Limits (Pages per call 5, refuse) · Approval |
| `search_exa_code_search` | Queries (input `query`) · Search types (value `type`) · Parameters (`contents.text`, `contents.summary`) · Limits (Results per search 10, clamp) · Approval |
| `browser_navigate`, `browser_tabs_open` | Sites (input `url`, fallback: localhost, private networks, cloud metadata, plain HTTP, paste sites) |
| `browser_tabs_list` | Use (List this session's tabs) |
| every other `browser_*` | Sites (the tab's current page) and, by tool: `files_upload`/`files_drop` Files (input `paths[]`, fallback: secret files) · Limits (Files per call 2, refuse); `network_get` Parameters (`includeBody`) · Limits (Largest body 5000 characters, clamp); `dialog` Actions (value `action`: get, accept, dismiss); `evaluate` Parameters (`frameID`) · Limits (Longest script 4000 characters, refuse); `screenshot` Parameters (`fullPage`); `fill`/`fill_form` Limits (Longest text typed 2000 characters, refuse); `trace_start` Limits (Longest trace 10000 ms, clamp) |

The team tools' catalog rows (Teams without kinds): `team_get_context` Team
runs (Start a team run from a chat) · Contents · Briefs it accepts (Scope paths
for a commit, Plan files only, A reason, A check, Corrections by followup) ·
Brief limits (Paths per brief 5, Checks per brief 1, shipped off);
`team_delegate` Access (Delegate from a delegated run) before its other
categories; Runs (Deeper descendants, Any other run, shipped off) on
`followup`, `stop`, `supersede`, `status`, `wait`, `diff` and `list`;
`team_finish` Requirements for done gains Worktree committed before done
(shipped off). read's Where gains `external` (a rule row on
`external_directory`), edit gains Files it may change (listed under write and
patch too). A team member also lists its own rows: Delegate to on
`team_delegate` (first), and Run edit scopes last on edit. A category shared
from another tool lists after the tool's own and takes its label from its id
there: edit's Files, Protected files and Where list under write and patch right
after the tool's own legacy category, with edit's labels.

#### Enforcement (`permission-enforce.ts`)

`apply.ts` builds every agent's resolved non-rule rows on each publish
(`permissionTable`: lazily per agent; a row no record addresses resolves to
its shipped state without a chain walk) and returns them as
`Applied.permissions`, which `index.ts` keeps in `PlusState.permissions` for
the team tools. `toolRows(agent, tool)` is an agent's rows listed under one
tool, its own and the ones it shares (`alsoUnder`). `installEnforcement`
answers them through the plugin seams:

- `tool.execute.before` sees every call — direct tools, Code Mode inner calls
  and MCP tools — with its full input before core authorizes it. `decide`
  refuses (`Tool.Error`, `Permission denied: <message>`), clamps (rewrites the
  input), queues an approval, or queues the environment patterns a shell
  command must lose. It also counts Code Mode inner calls per `execute` call:
  past Tool calls per run every further inner call is refused (`Permission
  denied: Tool calls per run is <n>; this run made more`).
- `permission.evaluate` runs when core authorizes that call, matched by
  session, message and call id and by the permission action the entry
  names (the tool's `permAction`); Code Mode inner calls share their
  `execute` call's id. An entry is waiting, raised or answered: every
  evaluation of its action under the key asks — with `<tool> asks the human
  before each call (Permissions → Approval).` — while an entry is not
  answered and its agent and tool have no `always`. So a sibling under
  another action never takes an approval, a sibling under the same action is
  asked too (the safe side), and core's re-evaluation of a pending request
  after an `always` to something else still asks. The `permission.asked` and
  `permission.replied` events map each question to its entry: `once` or
  `always` marks it answered (the call's later checks of the same action
  pass), `always` also stops asking for that agent and tool until the server
  restarts (the row stays on) — unless the question was shared by Code Mode
  siblings of the same action, which it then names together (`<tool> or
  <tool> asks …`) and whose "always" exempts no tool, for as long as that
  execute call runs. Entries go when their
  direct call, or the `execute` call holding them, ends; what an interrupted
  call leaves behind (an entry never asked, or already answered) is swept
  after an hour, never a question still waiting for the human. An evaluation core already
  denies stays denied.
- `tool.execute.after` drops the files grep's Files rows hide from its result
  (keeping core's text: absolute paths, and the truncation notice when core's
  search hit its limit), masks secret values in `instructions_*` results while
  Secrets in rows → Show secret values is off (strings under a key naming a
  secret, every string inside `headers`, `environment` or `env`, the same
  inside a string that is itself JSON and inside diffs, and token-shaped
  strings anywhere; an MCP server row — its id names `mcp:` — is config
  through and through, so every value of its config is masked — its JSON text
  keeping its shape, numbers and booleans kept — while the row itself keeps
  its naming fields: id, label, kind, view, source, status, summary), and
  remembers each browser tab's page from browser results.
- `shell.create.before` strips the registered variables. It carries no agent,
  so every shell call registers its command text (stripping or not) and the
  invocation takes the oldest registration of that text; while calls of one
  command overlap, each gets the union of what any of them strips (stripping
  more is the safe side). A registration whose command never started expires
  after an hour.
- `session.context` narrows each direct tool's JSON schema per agent
  (`narrowTools`): an off value's literal and an off parameter disappear, an
  on `value` limit sets `maximum`, and `team_delegate`'s `role` becomes an enum
  of exactly the co-members whose Delegate to rows are on, with `Members you
  may delegate to: <members>.` (or `No member of your team is open to you for
  delegation.`) appended to its description. Code Mode tools are not narrowed;
  the tool hook still refuses there.

A delegated team run (a `w` run, found through `teams/run.ts` `bySession`)
has nobody to ask,
so an approval there is refused: `Permission denied: <tool> needs the human's
approval before each call, and nobody watches a delegated run. Finish with
needs=[{kind:"decision",detail:"…"}] instead.` Question's When → In delegated
team runs row (off) refuses a question there with `no human watches a
delegated run; finish with needs_context instead of asking`.

A hook costs every tool call a lookup, so `apply` installs these hooks and the
reply listener only when `tableActive`: some agent has a row doing something —
an off row other than a team row, an on limit holding a number, an on
approval row, and, only while an enabled team has members, question's
delegated-run row or subagent's Team members row (both ship off).
Narrowing rides the existing `session.context` hook, else installs its own,
only when `tableNarrows`: an off value or parameter, an on `value` limit, or
any Delegate to row. A host without a seam installs nothing for it (`plus
permission hook not installed`); the rows still list and show their state.

#### Rule order (`apply.ts` `orderRules`)

Every Plus rule — rule-kind rows' denies (`permDenials`), role rows'
`policy` (`policyRules`), the non-member `team.*` deny and a member's
`team.<tool>` deny for a team tool row that is off — lands in one
stable order: first a role row's whole-resource defaults (`*`; `allow`, then
`ask`, then `deny`), then the role rules that let a specific resource through
(a run's scope paths, a planner's plan files), then the role's own specific
refusals, and last every refusal of a row that is off and the namespace deny
(`refusal`), even one whose pattern is `*`. Core answers last-match-wins, so a
row that is off always refuses what it matches and the most restrictive role
default wins. This fixed a real bug: role rules used to be appended after
every row's denies, so an orchestrator's role row `allow shell *` landed last
and let `git push` through while the `git push` row was off.

#### What cannot be enforced, and what is best effort

- **No approval for browser tools or core's opencode session tools.** They
  carry no plugin origin and reach no permission check, so there is nothing to
  turn into a question: they list no Approval category, and their other rows
  are refused at `tool.execute.before`.
- **glob and grep path scoping is tool-input rows, not core rules.** Core
  authorizes `input.pattern`, so the Search roots rows (and grep's Files and
  Include filters) read `path`/`include` at `tool.execute.before`, and grep's
  results are filtered afterwards. glob has no Files category: it returns
  names, and its Search roots row only decides whether it may walk outside the
  Location directory.
- **Shell file writes and network use are pattern-based best effort.** The
  Commands rows (and the orchestrator's role row) match each parsed command's
  text: while off they refuse `>`, `tee`, `cp`, `nc`, `rsync` and the rest as
  written, but a script, an interpreter running a file or any program no
  pattern names can still write files or open connections.
- **Patch operations are read from `patchText`.** Core's resource is the file
  path only; the Operations rows parse the patch headers, and a plain update
  has no row of its own.
- **Code Mode schemas are not narrowed.** An off value or parameter of a Code
  Mode tool stays in its catalog signature and is refused when called.
- **A browser tab's page is what the browser last reported.** A tab whose page
  is not known yet passes Sites unless the fallback is off.
- **A limit caps what a call asks for, and what it leaves to the tool.** A
  clamp row lowers a supplied number, and sets an omitted field to the cap
  when the tool's own default is higher (read 2000 lines, glob and grep 100,
  shell 120000 ms, webfetch 30 s, Tavily 5 and Exa 10 results, wait 60000 ms,
  diff 200000 bytes).

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
export type Field = "id" | "badges" | "source" | "tokens" | "text" | "upstream" | "record" | "label" | "path" | "updated" | "sections" | "from"
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
  `item` is `tool|base|skill|system|mcp|model|perm`; `tool` is the parent
  tool id on perm rows (e.g. `tool:shell`) — the row's own `permTool`, so a
  shared row listed under write (`…@write`) answers `tool:edit` and a hosted
  role row its action (`tool:external_directory`); `group` is
  `native|plus|mcp|project|none`; `server` is the exact (case-insensitive)
  MCP server name; `level` is `project|global|defaults|preset`; `catalogue` is
  `agents|teams` (addressed rows answer from their address, structural rows
  from their id — a `<team>/:<member>` group is teams; roots belong to neither
  and match nothing); `agent` is a
  case-insensitive substring match, `_` is the shared (agent-less) row; `state`
  is `on|off`; `modified`/`overridden` read the row's own stored text;
  `review` includes rolled-up descendant review (the badges string is the
  tree's badge words, `badgeLabels` in from-label.ts: `to review`,
  `to review (state)`/`to review (pin)` when a part other than the text is
  under review, `review` on a model row); `source` is `project|global|defaults|preset|upstream`; `active` is the base template active
  for the row's agent model (following the Plus-active model), or the resolved active model on model rows;
  `inactive` is a user base template that can
  never become active; `unsupported` is whole `system:role` and whole base
  rows; `codemode` reads the item flag; `namespace` is the exact Code Mode
  namespace; `pinned` reads the resolved pin; `execute` reads the
  synthetic-row flag; `can` is `toggle|edit|reset|remove|split|pin`; `has` is
  `record|split|sections|text`; `id` is a case-insensitive prefix match;
  `label` is a substring (a positive `id:` or `level:` term walks only the
  roots its rows can live under, and an `id:` prefix skips splitting items
  whose rows cannot match); `updated` compares the row's own override (or
  split) timestamp against an ISO date or a `<n><s|m|h|d|w>` age, where
  `>`/`<` on an age mean older/newer than; `team` is the exact
  (case-insensitive) team name on agent/team rows; `acked` reads
  `acknowledged`; `excluded` is an addressed row whose effective state is
  off; `identical` is stored text equal to upstream text; `dead` is a record
  that can never apply (MCP text overrides, off-state
  on whole `system:role`/base rows); `shadowed` is a row whose text a more
  specific level overrides for the same scope; `orphan` is a record naming a
  missing item, agent, or section (`orphan:true` also pulls those rows into
  the candidates); `tokens` is `ceil(length/4)` of the resolved text — on a
  Code Mode row this is the catalog-line approximation (first description
  line truncated at 120 characters, not counting the host-generated
  signature part of the catalog line — that is why the number is an
  approximation of the real cost),
  not the whole stored text;
  `delta` is changed lines vs upstream (0 with no stored text);
  `overriders` counts distinct agents overriding a Defaults shared row (0
  elsewhere); `text`/`upstream` are substrings over the resolved/upstream
  text. Numeric keys take `>`, `<`, `>=`, `<=`, `=` comparisons (`=` may be
  bare); boolean keys take `true|false`.
- Evaluation order: filters run sorted by rank — structural keys first
  (`kind item tool group server level agent overridden active inactive
  unsupported codemode namespace pinned execute can has id label updated team acked), then `state modified review source excluded`, then the
  text-dependent keys in order `identical dead shadowed orphan tokens delta
  overriders text upstream`. Structural filters never resolve row text.
- Memo: one `Memo` per snapshot input (`buildMemo`), caching whole/section
  resolves, splits, and review flags per address key plus an index of
  addresses holding stored text (addresses without one short-circuit review
  to false). Candidates walk the lazy skeleton without resolving; resolved
  and upstream text are computed lazily per candidate and cached on it. A
  caller-supplied `memo` reuses those caches.
- A tool row's structural groups list in tree order after it: the
  Description group (when the text has several sections) before its sections,
  then the Permissions group, each category group and its rows
  (`toolPermissions`, walked without resolving anything). They are
  `kind:group` candidates with no address and no badges, so `item:`, `tool:`,
  `state:` and the other keys that read a row's item never match them — the
  Description group, whose tree row carries the tool's address for the detail
  pane, is never listed as the tool a second time — and a tool row's
  `sections` field names its sections only. `id:group:<level>:<owner>:tool:<id>:permissions` lists a
  tool's Permissions group and its category groups.
- The TUI filter (`state.ts`) runs the same engine (`query` with
  `fields: ["id"]`) and reveals each match with its ancestor chain; Code
  Mode sections surface as rows like any other section; a `where` the
  grammar rejects falls back to a label/id substring match.

### Errors

| error | meaning |
| `row.unknown` | no row has that id; `list` again for the current id |
| `create.failed` | the write landed but its row is not in the tree; re-read with `instructions_list` |
| `agent.protected` | that agent is in `protectedAgents` and the write's actor is a tool; data is `{ agent, id?, reason }` |
| `delete.unconfirmed` | retry with `confirm: true` |
| `instruction.disabled` | `create kind:"instruction"` is refused pending the Context catalogue; OpenCode applies AGENTS.md files |
| `view.unsupported` | that view needs another id kind (`assembled` needs an agent row) |
| `project.disabled` | project mode is off and no tool changes that |

## Search MCP server (`src/search/mcp.ts`, `src/search/bin.ts`, `src/search/register.ts`)

Plus ships a built-in search MCP server providing Exa code search and Tavily web search and extraction.

### Registration and lifecycle

On activation (`activate` / `ensureTooling`), Plus reads `ctx.mcp.transform` to check for an existing MCP server named `search`:
- When absent (`editor.get("search") === undefined`), Plus registers its search server:
  `editor.set("search", new Mcp.LocalConfig({ type: "local", command: [process.execPath, <path to bin.ts|bin.js>], environment: { OPENCODEPLUS_SEARCH_KEYS_DIR: <XDG_DATA_HOME>/opencode/opencodeplus/search } }))`
  and reloads MCP via `ctx.mcp.reload()`. The registration is tracked and disposes cleanly on deactivation.
- When present, Plus leaves the existing configuration untouched and logs `search MCP already configured; not replacing`.

The server entrypoint is `packages/plus/src/search/bin.ts`, which runs over stdio and gracefully exits on `SIGTERM`, `SIGINT`, or stdin `end`.

### Tools and schemas

The search server exposes three tools with the identical schemas used by the workspace build seat:

1. `exa_code_search`
   - Description: Search billions of GitHub repos, docs, Stack Overflow, and dev blogs for real, working code examples via Exa.
   - Input schema:
     - `query`: string, min length 1 (natural language description of code needed)
     - `type`: enum `["fast", "auto", "neural", "keyword"]`, default `"fast"`
     - `numResults`: integer, min 1, max 100, default 10
     - `includeDomains`: optional array of strings
     - `excludeDomains`: optional array of strings
     - `startPublishedDate`: optional string
     - `endPublishedDate`: optional string
     - `contents`: optional object with `text` (boolean or `{ maxCharacters: number }`), `highlights` (boolean), `summary` (boolean), default `{ highlights: true }`
2. `tavily_search`
   - Description: Search the web via Tavily.
   - Input schema:
     - `query`: string, min 1, max 400
     - `search_depth`: enum `["ultra-fast", "fast", "basic", "advanced"]`, default `"basic"`
     - `topic`: enum `["general", "news", "finance"]`, default `"general"`
     - `max_results`: integer, min 1, max 20, default 5
     - `time_range`: optional enum `["day", "week", "month", "year"]`
     - `include_domains`: optional array of strings
     - `exclude_domains`: optional array of strings
3. `tavily_extract`
   - Description: Extract clean content from up to 20 URLs via Tavily.
   - Input schema:
     - `urls`: array of URL strings, min 1, max 20
     - `extract_depth`: enum `["basic", "advanced"]`, default `"basic"`
     - `query`: optional string
     - `chunks_per_source`: optional integer, min 1, max 5
     - `format`: enum `["markdown", "text"]`, default `"markdown"`

When registered under the `search` server name, core exposes them to models with the prefixed IDs:
- `search_exa_code_search`
- `search_tavily_search`
- `search_tavily_extract`

### Authentication and error handling

API keys are read at call time:
1. From key files under `$OPENCODEPLUS_SEARCH_KEYS_DIR/<name>.key` (`<XDG_DATA_HOME>/opencode/opencodeplus/search/{exa,tavily}.key`, with file mode `0600` strictly enforced, value trimmed).
2. Falling back to process environment variables:
   - `EXA_API_KEY` for `exa_code_search`
   - `TAVILY_API_KEY` for `tavily_search` and `tavily_extract`

Keys are never written to any config file, row, test fixture, log, report, or commit.

If a key file has insecure permissions (mode not `0600`), the tool call returns an error result.

If a key is missing from both the key file and the host environment, the tool returns a formatted tool error result rather than crashing or returning empty content:
- Missing `EXA_API_KEY`: `{ error: "EXA_API_KEY is not set in the host environment" }` with `isError: true`
- Missing `TAVILY_API_KEY`: `{ error: "TAVILY_API_KEY is not set in the host environment" }` with `isError: true`

### Team prompts and per-role policy

Built-in team prompts reference the search tools by their exact model-visible IDs:
- `shared` prompt (all members): `search_exa_code_search` for external APIs.
- `planner` prompt: `search_tavily_search` and `search_tavily_extract` for documentation.

The `perm:search:team-tavily` policy row disables `search_tavily_*` on `*` for implementer, reviewer, and scout roles while keeping `search_exa_code_search` available. It lists under `search_tavily_search` → Permissions → Access; the three tools' own categories (Queries, Sites, depths, topics, types, limits, Approval) are in the per-tool table under Permission rules.
