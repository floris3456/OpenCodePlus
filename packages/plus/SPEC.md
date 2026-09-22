# Plus Instructions — Foundation Spec

Binding contract for the Instructions TUI foundation: the sections engine
(`src/instructions/sections.ts`), the level-aware inheritance model
(`src/instructions/model.ts`), and the two-store v2 record format with
migration (`src/instructions/store.ts`, `src/instructions/paths.ts`).

## Tree shape

Three top-level roots in this order: `Project`, `Global`, `Defaults`. Each
root holds exactly two **catalogues**, `Agents` (`group:<level>:agents`,
`[a: add agent]`) and `Teams` (`group:<level>:teams`, `[a: add team]`). A
catalogue owns its population and, at `Defaults`, its own shared inventory, and
a row resolved through one catalogue never reads the other's inventory
(`model.ts` `resolutionChain`).

```
Defaults
  Agents                                    group:defaults:agents
    Native / Special / Plus / User          (unchanged agent subtrees)
    Models · Tools · Base · Skills · System · MCP     group:defaults::<category>
  Teams                                     group:defaults:teams
    <team> > <member>                       (unchanged team subtrees)
    Models · Tools · Base · Skills · System · MCP     group:defaults:/teams:<category>
```

`Project` and `Global` carry the same two catalogue roots holding their own
agents and teams; only `Defaults` carries shared inventories, because
`{ level: "defaults", agent: null }` is the one address the resolution chain
falls through to.

The `Agents` catalogue's children are the origin subgroups (`Native`, `Plus`,
`User`, with `Special` nested under `Native`: `group:<level>:agents:native`,
`group:<level>:agents:native:special`, `group:<level>:agents:plus`,
`group:<level>:agents:user`, all always emitted even when empty; agent rows
keep `agent:<level>:<id>`; `add: "agent"` sits on the `Agents` group and the
`User` subgroup, never on `Native`/`Special`/`Plus`) holding that level's
agents with the identical subtree. The `Teams` catalogue holds that level's
teams, whose team rows (`team:<level>:<team>`, `add: "agent"`) hold member
rows (`team:<level>:<team>:<member>`, `add: "agent"`) expanding to the same
five agent groups. At `Defaults` the `Agents` catalogue's agents are template
agents (`[a: add agent template]`) and the `Teams` catalogue's teams are the
built-in shipped teams with working toggles (`[a: add team]` still creates at
project or global, never defaults). Built-in Native and Special agents
project under every root with row id `agent:<level>:<id>` and are not
removable (`actions.remove === false`). Ancestor-backed project agents are
discovered through core's upward `.opencode` walk, are file-backed, and are not
removable (`AgentEntry.ancestor: true` suppresses deletion because deletion is
confined to the local project). Team member rows carry `add: "agent"` and are
removable when on-disk (project/global, or a Defaults overlay file, invoking
`team.removeAgent`) while shipped Defaults members are refused
(`actions.remove === false`). Team create from a `group:<level>:teams` row takes
that level (creating directly at project or global without a scope dialog;
Defaults prompts for project or global) and prefills the name from the chosen
template.

Every agent in all three roots has the identical subtree:

```
<Agent>
  Models
    <model>
  Tools
    Native / OpenCodePlus
      <tool>
        <section>
        <rule>                 (permission rules after sections; native/plus non-Code-Mode non-execute tools only)
      Code Mode                (only when that origin has Code Mode rows)
        <namespace>
          <tool>
            <section>
    MCP > <server>
      <tool>
        <section>
      Code Mode                (rows directly, no namespace level)
        <tool>
          <section>
  Base                     [a: add base prompt]
    <Template>.txt         (the one matching the agent's Plus-active model is marked "active")
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

Team member rows (`tree.ts` `lazyTeamMember`): under Teams → `<team>` at
every level, each member row (`team:<level>:<team>:<member>`, kind `"team"`,
no address, no toggle) carries `add: "agent"` and is removable when on-disk
(project/global, or a Defaults overlay file, invoking `team.removeAgent`) while
shipped Defaults members are refused (`actions.remove === false`). Each member
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
carries `catalogue: "teams"`. The flat `item:<level>:<member>:<itemId>` id
still resolves: it is the stand-alone Agents-catalogue row for the same agent.
`dialogs.tsx` `scopeFromModelsGroup` accepts the `<team>/:<member>` owner form
and strips the `<team>/:` prefix so `a` on a member's Models group adds for the
member id.

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
sit under a `Code Mode` subgroup; below Native and OpenCodePlus it holds one
group per tool namespace (sorted like the server groups) with
namespace-less tools hanging directly off it, while below an MCP server the
rows hang directly off it and the namespace level is skipped (every tool of
one server already shares one namespace). The origin subgroup id appends
`:codemode` to its origin group (`…:tools:<origin>:codemode`), namespace
groups append `:<namespace>` (`…:codemode:<namespace>`), and MCP servers
hold rows directly under `…:mcp:<server>:codemode`. Empty subgroups are
never emitted: the caller skips the group when there are no rows, and every
namespace group comes from a row so it is non-empty by construction. The
synthetic `execute` row (`tool:execute`) is a plain Native row, toggle-only:
its text is host-owned and not editable, and it carries no other affordance.

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

Permission rows (`tree.ts` `toolPermRows`): direct children of a
native/plus tool row after its section rows, sorted by `order` then title
(`byOrderTitle`, carrying the miner's most-mentioned-first rank). No group
wrapper is ever emitted: empty rule sets emit nothing at all. Only
native/plus, non-Code-Mode, non-`execute` tools host rows
(`canHostPermRules`): MCP resources are always `"*"` and Code Mode denies
are whole-tool, so per-resource rules there would never match core
evaluation. A tool row that can host rules carries no direct `add`: `a`
presents the Section / Permission rule choice (`dialogs.tsx` `addFor`);
every other splittable row keeps `add: "section"`. Scope and tool derive
from the tool or perm row address (`scopeFromToolOrPermRow` /
`toolFromToolOrPermRow`). `enter` on a perm row opens the rule editor
(label → patterns → keywords → message, each prefilled; tool and rule id come
from the snapshot item's `permTool`/`ruleId`, the message from the rule
record, level and agent from the row address), persisting through
`rule.update`, which upserts a `RuleRecord`
by `tool` + `id` — so editing a curated or mined row materialises a custom
override of the same identity.

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
`explore|title|summary|compaction|general`, `native` for `build|plan`, else
`user`; file-backed agents are always `user`) and upgraded to `plus` in
`index.ts` `toSnapshot` when the id is in `plusTeamOutputIds` or the source
carries `team`. It crosses the RPC boundary on `AgentEntry.origin` and is
carried through `snapshot.ts` `agentOf` into `tree.ts` `lazyAgentsGroup`,
which groups by that carried value (never by hardcoded ids or path/team
heuristics in the tree layer). Ancestor-backed project agents are discovered
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
export type Level = "defaults" | "global" | "project"
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
}
```

Item id forms (documented, not enforced): `tool:<toolId>`,
`base:<templateId>` (gpt|claude|muse|gemini|general|kimi|trinity), `skill:<skillId>`,
`system:role` (the agent's own prompt body = Role/persona),
`system:<relativePath>`, `mcp:<server>`,
`model:<providerID>/<modelID>` or `model:<providerID>/<modelID>@<variant>`,
`perm:<toolId>:<ruleId>` (the rule id keeps any extra `:` it contains; row
ids address the whole row by concatenation and match by exact string
equality, so `/`, `@`, and extra `:` inside the item segment need no
escaping; the parsers split on the first `/` and the first `:` only).

Resolution chain, most specific first, resolving `text`, `state`, and `pin`
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
  readonly pinned: boolean // nearest record carrying `pin` down the chain, else the upstream registry default
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
- The effective model is the first `active === true` record down the chain,
  else upstream. No active record and no upstream means Plus installs
  nothing for that agent.
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
export type StoredRecord = CustomizationRecord | SplitRecord | TeamRecord | ModelRecord | RuleRecord
```

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
| `agent.create` | `{ scope, id, template?, fields?, prompt, actor? }` | `AgentRef` | `project.disabled`, `agent.exists`, `agent.invalid`, `agent.protected` |
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
| `team.create` | `{ level, team, template?, actor? }` | `TeamRef` | `project.disabled`, `team.exists`, `team.invalid`, `team.create`, `agent.protected` |
| `team.setEnabled` | `{ level, team, enabled }` | `TeamRef` | `project.disabled`, `team.unknown`, `team.invalid` |
| `team.addAgent` | `{ level, team, id, template?, fields?, prompt, actor? }` | `AgentRef` | `project.disabled`, `team.unknown`, `team.invalid`, `agent.exists`, `agent.invalid`, `agent.protected` |
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
fields that make a team policy row read as a policy row on the client side;
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
which expands to `general`, `explore`, `compaction`, `title`, and `summary` (`team:<level>:<team>:special:<id>`),
each carrying the five groups (`group:<level>:<team>/:special:<id>:<group>`). Their overrides carry `team: { level, team }`
and apply only while the team is enabled. Optional keys are omitted
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
user-authored directories on disk; defaults teams are shipped source data
from `builtin-teams.ts` editable through the Defaults overlay directory
(`<globalConfigDir>/opencodeplus/teams-defaults/<team>/<id>.md`). Built-in
teams as named units cannot be created or deleted via `team.create`, but
they can be enabled and disabled like any other team, and member agents can
be added or customized through the overlay. Their enablement records carry
level `defaults` and route to the global store, and precedence is project
over global over defaults. Created teams are always stored at project or
global level, never defaults.

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
obvious) plus an editable on-disk overlay
(`teams.ts` `globalDefaultsTeamsPath()` →
`<globalConfigDir()>/opencodeplus/teams-defaults`, one directory
`<root>/<team>/` with `<team>/<agentId>.md` member files in the same
format); they have no team-level filesystem path, only member overlay files.

Validation (`validateTeamName`, same confinement style as
`validateAgentId`/`resolveInstructionPath`): rejects empty names, NUL,
absolute paths, any `/` or `\`, `.`, and anything containing `..`. Validated
names can never escape the teams directory; unvalidated input fails closed.

Discovery: project and global tiers list one entry per immediate
subdirectory, sorted by name; a team directory with no agent files is still
a team; a missing teams directory means no teams, not an error. Only `*.md`
files are members (other files are ignored), listed as `{ id, path }`
sorted by id. The defaults tier merges the built-in registry with the
overlay: a member file with the same id REPLACES the built-in member, a new
id is APPENDED, still `level: "defaults"` with `body` read from the file and
`path` set so the installer reads it, sorted by team name and member id.
The registry is injectable so behaviour tests supply fixtures instead of
coupling to the shipped roster.

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
  `team.invalid` (shipped teams cannot be created). An optional `template`
  names a built-in Defaults team from the injected registry; each member is
  written as `<team>/<member>.md` through `formatMarkdown` (body and fields,
  with a present `fields.permissions` written verbatim). Unknown template
  names fail with `team.invalid` (`Unknown team template <name>`); an omitted
  template creates an empty team. Creation does NOT enable:
  the new team has no record, so the next snapshot lists it as DISABLED until
  `team.setEnabled` toggles it. Gated by project mode (`project.disabled`).
  Fails with `team.invalid` on invalid name, `team.exists` when the directory
  already exists, or `team.create` when the write itself fails. Logs `team.create`
  to the owning store with the caller's actor on success only; the file write
  never moves a revision. The TUI `a` on a `group:<level>:teams` row lists Blank
  plus the Defaults teams from `instructions.snapshot` first (Blank default, so the
  old two-prompt flow is unchanged when chosen). For `group:project:teams` and
  `group:global:teams`, it takes that level directly without a scope dialog;
  `group:defaults:teams` prompts for `project` or `global` scope. When a
  template is chosen, the team name prompt is prefilled with the template name,
  and `template` is passed to `team.create`.
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
  at any tier. Project/global writes `<teamdir>/<id>.md`; defaults writes the
  overlay `<globalConfigDir>/opencodeplus/teams-defaults/<team>/<id>.md`.
  Reuses `validateAgentId`, `readTemplate`, and `formatMarkdown` (never the
  regular-agent `create()`); an optional `template` names a Defaults agent
  seeding fields and prompt, unknown names fail with `agent.invalid`. Optional
  `fields` (`CreateAgentFields`) override template fields for explicit defined
  keys while omitted keys inherit from the template. Refuses an existing member
  id with `agent.exists` (path in data) and invalid ids with `agent.invalid`. After the write calls `refreshAfterFileChange(...,
  true)` exactly as `createAgent` does, so an enabled team's new member
  installs without a restart. Both team rows and member rows carry `add: "agent"`;
  `a` on `team:<level>:<team>` or on `team:<level>:<team>:<member>` opens only
  the Agent template → id → prompt flow with the team's level as scope, never
  the generic picker.
- `team.removeAgent` (`TeamRemoveAgentInput` → `AgentRef`): removes one member
  from a team at any tier. Bound to `d delete` on team member rows. Project/global
  unlinks `<teamdir>/<id>.md`; defaults unlinks the overlay file
  `<globalConfigDir>/opencodeplus/teams-defaults/<team>/<id>.md`. Shipped
  built-in members without an overlay file fail with `team.invalid` (delete
  refused). Removing the last member leaves an empty team directory. After unlink
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
working toggles and member rows that expand to full agent subtrees; `add` there still creates at
project or global scope, never defaults). Both team rows and member rows carry
`add: "agent"`, so `a` on a team row or member row adds an agent to that team
through `team.addAgent` with the Defaults overlay for `level: "defaults"`, and
TUI wiring (`state.ts` `space` → real `team.setEnabled` + snapshot refresh, `a`
→ real `team.create` / `team.addAgent` + snapshot refresh, `d` on a team row
→ `team.delete` confirmation + snapshot refresh, `d` on a member row
→ `team.removeAgent` confirmation + snapshot refresh; `tree-pane.tsx` on/off
badge). A created team starts disabled. Built-in teams cannot be created or
deleted (though their members are editable through the Defaults overlay). Store
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

Nine names are **not** in the namespace, not in any role ceiling and not named
by any built-in prompt: `review`, `shutdown_request`, `resume`, `prepare`,
`plan_handoff`, `metrics`, `exa_code_search`, `tavily_search` and
`tavily_extract`. Web and code search are not team tools: they are delivered by
the `search` MCP server and narrowed per role by a policy row (below).

`diff` is a read-only `git diff` of a run the caller can see — its own run or
one of its children. `from` is `base` (the default), `parent` (the parent
run's HEAD) or a 40-hex commit; `paths` narrows the patch. Output is
`{ run, from, head, bytes, truncated, patch }`, truncated to `maxBytes`
(default 200000) with `truncated: true`. A run that is neither the caller's
nor one of its children refuses with `E_NOT_VISIBLE`.

A planner or orchestrator opening a fresh chat and calling any team tool
creates the `main` root run bound to that session automatically and then
answers normally. There is no `prepare`. All other no-run calls keep the exact
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

### Team rules are instructions rows (`instructions/team-policy-rows.ts`)

There is one source of truth for what a team member may do, and it is the
instructions system. No file under `src/teams` writes permissions onto an
agent, registers a permission hook, or decides tool visibility:
`teams/policy.ts` states the ceiling and the native answers as data,
`instructions/team-policy-rows.ts` turns that data into ordinary rows under
each member, and `instructions/apply.ts` installs whatever those rows resolve
to. They are listable (`instructions.list`), showable, logged, and overridable
at project or global level like any other row.

Every row is a `perm:` row carrying `agents: [<member>]` and both sides of its
own answer: `policy.on` is installed when the row resolves enabled,
`policy.off` when it resolves disabled. The shipped `enabled` state is the
role's answer, so `on` reads as "permitted" exactly like every other row.

Row ids the producer emits, per member of an enabled team:

- `perm:shell:team-role`, `perm:question:team-role`,
  `perm:external_directory:team-role`, `perm:subagent:team-role`,
  `perm:task:team-role` — one per native permission action, `*` resource.
  Shipped on for the roles that may (shell for orchestrators; question for
  planners; external directories for planners and orchestrators), off for the
  rest. On installs an explicit `allow`, off a `deny`.
- `perm:read:team-role` — keys, env files and credentials (`*.key`, `*.env*`,
  `*/auth.json`). Shipped off for every role.
- `perm:team_<tool>:role-ceiling` — one per team tool **outside** the role's
  ceiling, shipped off, denying `team.<tool>` on `*`. Tools inside the ceiling
  carry no row: the member simply keeps them.
- `perm:team_delegate:team-role` — shipped on for planner members, requesting
  `team.delegate` on `*` with effect `ask` (the human-approval moment). Off
  installs a `deny`.
- `perm:search:team-tavily` — shipped off for implementers, reviewers and
  scouts, denying `search_tavily_*` on `*`. Code search stays available.
- `perm:edit:run:<runID>` — per-run edit scope, derived from `run.json` while
  the run is non-terminal. On installs, in order, `deny edit *`, one
  `allow edit <path>` per `scope.paths` entry (when paths are non-empty), then
  `deny edit .git/**` and `deny edit .opencodeplus/**` (core evaluates
  last-match-wins, so the never-editable state wins over the scope allows). For
  child runs (`w-...`), any `ask` effect carried by the member (e.g.
  `team.delegate` for planners) is overridden to `deny` so headless children
  never block on `ask`. The row carries `runID` and is filterable with
  `run:<id>`.

#### Rule messages

`Permission.Rule` (`packages/schema/src/permission.ts`) carries an optional
`message`. When that rule is the one that denies, core's `assert` refuses with
it instead of `Permission denied: <action>`, so the model reads the reason;
when the rule asks, the message rides on the request as `metadata.message` so
the TUI can say why it is asking. A rule with no message encodes exactly as it
did before the field existed. A rule answers for a *pattern*, not for one call,
so the quoted subject in these texts is the rule's own resource.

Three kinds of team policy rule carry one:

- Edit scope (`perm:edit:run:<runID>`), the two texts the round-1 permission
  hook sent, word for word:
  `"<resource>" is outside your scope.paths [<union of the role's live scopes>]. Report it in needs=[{kind:"path"...}].`
  on the `deny edit *`, and
  `"<resource>" is version-control or paused-tool state and is never editable, even inside scope.paths [<union>]. Report it in needs=[{kind:"path"...}].`
  on `deny edit .git/**` and `deny edit .opencodeplus/**` (the `, even inside
  scope.paths […]` clause is dropped when the run declares no paths).
- Native denies (`perm:<action>:team-role`):
  `<action> is not available to <member>` for a `*` resource,
  `<action> "<resource>" is not available to <member>` for a narrower one, and
  `shell is not available to <member>; run checks with team_check` for shell.
- Ceiling denies (`perm:team_<tool>:role-ceiling`):
  `team_<tool> is outside the <kind> ceiling`.

The per-run `ask`→`deny` override and the `perm:search:team-tavily` narrowing
carry no message. `Plus.PolicyRule` (`src/rpc.ts`) carries the field too, so a
message survives the snapshot the TUI and the tools read: `instructions_show`
on a `perm:` row returns the row's `policy` — the `on` and `off` rules it
installs, each with its own message — beside the row's patterns and resolved
state, so a reader sees what the rule says when it refuses.

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
- `apply.ts` prefers the user record's message for a custom row and falls back
  to the curated message for a curated row; a mined row has none and keeps the
  generic refusal.
- `instructions_show` on a perm row returns `message` when the row has one,
  and the TUI detail pane prints it under `provenance`.
- Two whole-set resubmissions carry the same optional fields. A state-only
  write — `set` with `state` alone — goes through `tools.ts`
  `toSnapshotRecords`; every TUI write (`persist` in
  `tui/instructions/state.ts`) resubmits through `toRpcRecords`. Both carry
  `message` on every rule and `catalogue` on every shared (`agent === null`)
  record, exactly like `toRecord` (`index.ts`). Toggling one row therefore
  never drops another rule's message and never moves a Teams-catalogue rule
  into the Agents catalogue.

Rows appear in a `Policy` group under the member's `Tools` group
(`group:<level>:<team>/:<member>:tools:policy`), not under the tool each
governs, because several of them govern an action with no tool row to hang
under. The group is omitted for owners with no policy rows.

Team tools appear only under the Teams catalogue's `Tools` inventory; the
Agents catalogue never lists them. An agent that is not a member of an enabled
team receives one wildcard deny, `{ action: "team.*", resource: "*", effect:
"deny" }`, which is the shape core drops a tool for
(`packages/core/src/tool.ts` `whollyDisabled` matches the action by wildcard
against `options.permission`). `E_NOT_ACTOR` is therefore never the answer to
"why can't build call this": `build` never sees a `team_*` tool at all.

A refusal renders as `${code}: ${message}`. When the error carries `accepted`,
one more line follows: `accepted: ${JSON.stringify(accepted)}`. For example,
an implementer delegate call with empty paths refuses with:

```
E_PATHS: Implementers need scope.paths (files or dir/* they may edit).
accepted: ["packages/plus/src/*","packages/plus/test/*"]
```

`E_CHECKS` and `E_SUMMARY` are raised by the `delegate` / `set_checks` /
`finish` handlers through `validateChecks` / `validateSummary`, not by schema
filters, and both carry `accepted`.

Error codes carrying `accepted` today:
- `E_PATHS`: valid scope paths array (`["packages/plus/src/*","packages/plus/test/*"]`)
- `E_ROLE`: allowed target role object (`{"role":"opus-orchestrator"}`)
- `E_CHECKS`: valid check definition (`{"id":"plus-tests","argv":["bun","test","packages/plus/test/model.test.ts"]}`)
- `E_SUMMARY`: summary length guidance (`"a summary of ≤15 lines"`)
- `E_TIMEOUT_MIN`: `"timeoutMs <timeoutMs> is below the 10000ms floor."`; minimum timeout object (`{"timeoutMs":10000}`)
- `E_SPARK`: spark delegation example (`{"reason":"...","paths":["src/a.ts"],"checks":1}`)
- `E_REASON`: orchestrator reason example (`{"reason":"3 independent packages, each needs its own workers"}`)
- `E_NEEDS`: valid needs array (`[{"kind":"path","detail":"packages/core/src/x.ts is outside scope; needed to add the export"}]`)
- `E_MESSAGE`: conventional commit example (`"fix: apply agent filter in query"`)
- `E_BASE`: valid base ref (`"ocp-main"`)
- `E_REPO`: caller's repository key
- `E_DIRTY`: uncommitted files object (`{"files":[...]}`)
- `E_BOUNDS`: bounds action guidance (`"call wait first"` or `"raise bounds.members in policy"`). In-flight and member limits count only live runs in `starting|working|idle|blocked_input` whose `sessionID` is not null; runs superseded because session creation failed never count.
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
  - `"denied"`: Tool call was refused at call time by a `deny` rule (e.g. out-of-ceiling tool, child planner delegation, or native denial); `runGated` was never reached (`ok: false`, `code: "E_PERMISSION"`)
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
the field, and `removed` is terminal for it: a later save of a copy read before
the removal cannot put `present` or `dirty` back.

- `integrate` marks a landed child `removed` only after `worktree.remove`
  succeeds, and applies the mark through `run.updateRun`, so only that field
  changes on the record as it is at write time.
- The passes that settle a run without a tool call — `reconcile`'s dead-run
  pass, `session.execution.started`, and `onSessionIdle` (including the stop
  transition when `stopRequested` is set) — also load, modify and write through
  `run.updateRun`, in one `state` lock hold. Their writes are therefore based on
  the record as it is after a concurrent removal instead of on the copy they
  read first, so a settle that began before a landing can no longer resurrect
  the worktree that landing removed. Either interleaving ends with `removed`.
- `updateRun(root, id, update)` reads `runs/<id>/run.json`, calls `update` with
  the current record, and writes what it returns under the same `state` lock
  `loadRun`/`saveRun` use; returning the record unchanged skips the write. It
  never creates a record, so the `run.created` audit entry stays `saveRun`'s.

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
export interface SetInput { readonly id: string; readonly text?: string; readonly state?: "on" | "off"; readonly resolve?: ToolResolve; readonly pin?: boolean; readonly active?: boolean; readonly label?: string; readonly patterns?: readonly string[]; readonly keywords?: readonly string[]; readonly message?: string }
export interface ResetInput { readonly id: string }
export interface SplitInput { readonly id: string; readonly boundaries?: readonly Boundary[]; readonly add?: { readonly name: string; readonly text: string } }
export type CreateInput =
  | { readonly kind: "agent"; readonly id: string; readonly prompt: string; readonly scope?: "project" | "global"; readonly template?: string; readonly fields?: CreateAgentFields }
  | { readonly kind: "skill"; readonly name: string; readonly body: string }
  | { readonly kind: "base"; readonly id: string; readonly title: string; readonly text: string }
  | { readonly kind: "instruction"; readonly name: string; readonly text: string }
  | { readonly kind: "mcp"; readonly name: string; readonly config: Record<string, unknown> }
  | { readonly kind: "team"; readonly team: string; readonly level: "project" | "global"; readonly template?: string }
  | { readonly kind: "member"; readonly team: string; readonly level: "project" | "global" | "defaults"; readonly id: string; readonly prompt: string; readonly template?: string; readonly fields?: CreateAgentFields }
  | { readonly kind: "model"; readonly providerID: string; readonly modelID: string; readonly variant?: string; readonly level?: "project" | "global" | "defaults"; readonly agent?: string; readonly catalogue?: "agents" | "teams" }
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
  source, tokens`; `limit` defaults to 40). Filters (`where`) support `server:<name>`, which matches both the `mcp:<name>` server row and its tool rows (e.g. `where: "server:search"` returns `mcp:search` and all search tools). `show` defaults to view
  `resolved`. On a perm row any view returns the rule view (`tool`, `rule`,
  `label`, `patterns`, `keywords`, `provenance`, `custom`, `enabled`,
  `source`, plus a scrub preview: `scrub.hidden` lines would drop,
  `scrub.preview` shows up to 3; plus `message` when the rule has one — a
  user rule's own text or the curated one it ships). Team and member rows
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
  label and patterns from the rule it edits)
  (no text, pin, active, or resolve). `set` with `resolve: "keep"`
  acks upstream keeping text, `"take"` drops stored text and follows upstream,
  `"edit"` stores `text` against current upstream. `reset` deletes the
  override at that row (on a model row clears only that level's active flag).
  `split` boundaries are `{ id, name, start }` with
  character offsets into the row text; `add: { name, text }` appends a new
  trailing section; perm and model rows cannot be split. `create` writes one row per call and returns `CreatedRow` fields: `id` is the
  row id `show`, `set` and `delete` accept for that row, `item` names the
  created thing inside its row kind (`skill:…`, `base:…`, `mcp:…`, `model:…`,
  `perm:…`, or the agent/team/member id), and the RPC's own fields pass through
  beside them. `create` with `kind: "agent"` needs `id` + `prompt` (`scope`
  defaults to project, `template`/`fields` optional). `create` with
  `kind: "team"` creates the team directory DISABLED (enabling stays a
  separate `set` on the team row) and passes an optional `template` through
  `team.create`, so the members match the TUI's templated team create.
  `create` with `kind: "member"` needs `team` + `level` + `id` + `prompt` and
  calls `team.addAgent`, so `level: "defaults"` writes the same Defaults
  overlay the TUI writes and `template`/`fields` are the agent fields
  `kind: "agent"` takes; the team name is trimmed exactly as `team.addAgent`
  trims it before the row is resolved. `create` with `kind: "model"` needs
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
  `instruction.disabled` pending the Context catalogue: native opencode applies
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
  `group:<level>:<team>/:special:<id>:<group>`, and item ids
  `model:<providerID>/<modelID>[@<variant>]` and
  `perm:<toolId>:<ruleId>`. `<level>` is `project`,
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

### Permission rules (`tool-permissions.ts`, `discover.ts`, `apply.ts`, `assembled.ts`, `index.ts`)

- Rules come from two view-time sources merged by `mergeRules` (curated
  label wins on a pattern-set collision; most-mentioned discovered first,
  then unmentioned curated generics): the curated registry (shell, edit,
  write, read, webfetch, glob, grep entries, plus one `idRules` row per
  discovered agent/skill id for `subagent`/`skill`), and candidates mined
  from text Plus already holds (tool/base/skill/role/file/teaching rows,
  with `provenance` naming the mentioning item ids). The merged rank carries
  through as `Item.order` so the tree shows most-mentioned first. User
  `RuleRecord` customs overlay as `custom: true` rows. Mined candidates are
  view-time only: never persisted, and never part of the publish fingerprint
  (`fingerprintPublish` filters out `kind === "perm"`; only a stored
  off-state or a `RuleRecord` enters it via `records`). The TUI add-rule
  flow prompts for scope (row scope when invoked on a tool or perm row,
  otherwise level then agent); custom rules are globally unique by `(tool, id)`,
  not per level/agent (`rule.add`/`rule.remove`/`rule.update` match by tool+id
  only, ownership and logging follow the record actually matched).
- Perm rows resolve from the Project level for an agent whose discovered
  scope is Defaults and that carries no team, so the chain is
  `project/A → global/A → defaults/A → shared` (`resolvedFor` in `apply.ts`).
  A Defaults-scope agent (every host built-in: `build`, `plan`, `explore`, …)
  owns a visible row under Project, Global and Defaults alike
  (`nativeAgentsForLevel`/`specialAgentsForLevel` in `tree.ts`) and ops writes
  at the row's own address, so the record a user actually saves carries
  `{level:"project", agent:"build"}`; resolving at the discovered Defaults
  level reached neither that record nor a Global one and the saved OFF
  installed no deny and no refusal message at all. Every other item kind
  keeps the discovered scope, and a team-scoped agent keeps its established
  chain and the Teams catalogue unchanged.
- Toggling any rule is a `CustomizationRecord` with state on/off on the
  `perm:<tool>:<rule>` item address, so `resolve()` already yields
  `enabled`. Every perm item OFF for an agent installs one core deny per
  pattern (`{ action, resource: pattern, effect: "deny" }`) through the
  agent registration; because core permission evaluation is last-match-wins,
  appending is always sufficient. The action comes from the per-rule
  `permAction` carried on the perm item by discovery (the tool's own
  `options.permission`), falling back to `actionForToolId`: `edit`/`write`/
  `patch` share core's `edit` action, every other tool uses its own id.
- Patterns are CORE RESOURCE WILDCARDS over the tool's permission resource,
  NOT regex: `*` spans any run, `?` matches one character. For shell the
  resource is the parsed command text, so `git *` also matches a bare `git`
  (the curated head-only rules still carry both `git` and `git *`); for file
  tools the resource is the file path (project-relative inside the project,
  absolute outside it), for webfetch the URL, for glob/grep the user's
  search pattern (PATH-scoped search restriction is NOT expressible: core
  authorizes `input.pattern`, so `grep({ pattern: "HEAD", path: ".git" })`
  evaluates resource `"HEAD"`), for subagent/skill the exact id. Operation-
  scoped patch restriction is NOT expressible: core's permission resource for
  patch is the file path only (core/src/tool/plugin/patch.ts asserts
  `action: "edit"`), and the hunk type never reaches the permission layer.
  Carrying it as an extra resource or an extra action both change decisions
  for existing configurations that never enabled Plus, and a targeted opt-in
  cannot be defined reliably against the wildcard matcher. So add/update/
  delete cannot be distinguished; the `edit`-action path rules still apply to
  patch. User
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
  to its first meaningful segment (`*.git*` → `[".git"]`).
- Scrub points (all line-level whole-word, case-insensitive
  `scrubLines`/`containsWholeWord`): the `session.context` hook (every tool
  description plus every system part, after the text plans), the
  `session.catalog` hook (Code Mode catalog descriptions, after the
  text/pin plans), and the `assembled` view (registry descriptions, system,
  and skill content). Empty keyword sets install no extra hooks.

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
  `item` is `tool|base|skill|system|mcp|model|perm`; `tool` is the parent
  tool id on perm rows (e.g. `tool:shell`); `group` is
  `native|plus|mcp|project|none`; `server` is the exact (case-insensitive)
  MCP server name; `level` is `project|global|defaults`; `catalogue` is
  `agents|teams` (addressed rows answer from their address, structural rows
  from their id; roots belong to neither and match nothing); `agent` is a
  case-insensitive substring match, `_` is the shared (agent-less) row; `state`
  is `on|off`; `modified`/`overridden` read the row's own stored text;
  `review` includes rolled-up descendant review; `source` is
  `project|global|defaults|upstream`; `active` is the base template active
  for the row's agent model (following the Plus-active model), or the resolved active model on model rows;
  `inactive` is a user base template that can
  never become active; `unsupported` is whole `system:role` and whole base
  rows; `codemode` reads the item flag; `namespace` is the exact Code Mode
  namespace; `pinned` reads the resolved pin; `execute` reads the
  synthetic-row flag; `can` is `toggle|edit|reset|remove|split|pin`; `has` is
  `record|split|sections|text`; `id` is a case-insensitive prefix match;
  `label` is a substring; `updated` compares the row's own override (or
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
| `instruction.disabled` | `create kind:"instruction"` is refused pending the Context catalogue; native opencode applies AGENTS.md files |
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

The `perm:search:team-tavily` policy row disables `search_tavily_*` on `*` for implementer, reviewer, and scout roles while keeping `search_exa_code_search` available.

