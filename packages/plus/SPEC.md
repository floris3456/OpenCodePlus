# Plus Instructions — Foundation Spec

Binding contract for the Instructions TUI foundation: the sections engine
(`src/instructions/sections.ts`), the level-aware inheritance model
(`src/instructions/model.ts`), and the two-store v2 record format with
migration (`src/instructions/store.ts`, `src/instructions/paths.ts`).

## Tree shape

Three top-level roots in this order: `Project`, `Global`, `Defaults`.
`Project` and `Global` each hold an `Agents` group (`[a: add agent]`) whose
children are origin subgroups (`Native`, `Plus`, `User`, with `Special`
nested under `Native`: `group:<level>:agents:native`,
`group:<level>:agents:native:special`, `group:<level>:agents:plus`,
`group:<level>:agents:user`, all always emitted even when empty; agent rows
keep `agent:<level>:<id>`; `add: "agent"` sits on the `Agents` group and the
`User` subgroup, never on `Native`/`Special`/`Plus`) holding that level's
agents with the identical subtree, plus a `Teams`
group (`[a: add team]`) holding that level's on-disk teams. `Defaults` holds
`Agents` (template agents in the same origin subgroups, each with the full subtree, `[a: add agent template]`),
`Teams` (built-in shipped teams with working toggles and member rows that
expand to full agent subtrees, `[a: add team]` still creates at project or
global, never
defaults), and then the shared inventories: `Models` `[a]`, `Tools`, `Base` `[a]`, `Skills`,
`System` `[a]`, `MCP` `[a: add MCP server]`.

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

Team member rows (`tree.ts` `lazyTeamMember`): under Teams → `<team>` at
every level, each member row (`team:<level>:<team>:<member>`, kind `"team"`,
no address, no toggle) expands to the same five groups an Agents-group agent
renders (Models, Tools, Base, Skills, System, in that order) with working
toggle/edit/reset on their rows, whether or not the team is enabled and
whether or not the host registered the agent. The owner for those groups is
the bare member id with the registered agent when one exists
(`ctx.agents.find(a => a.id === member && a.scope === level) ?? find(a => a.id === member) ?? null`),
so shared items (`agents === undefined`) populate for unregistered members
while `system:role` appears only for registered ones. Item and section ids
and their addresses stay identical to the Agents-group ones (they address the
same records by design: level + agent + item, and `address.agent` stays the
bare agent id). Only the five group ids get the team prefix to avoid
colliding with the Agents-group ids for the same agent at the same level:
`group:<level>:<team>/<member>:models|tools|base|skills|system`, with nested
Tools/Skills subgroup ids extending those prefixes. `dialogs.tsx`
`scopeFromModelsGroup` accepts the `<team>/<member>` owner form and strips
the `<team>/` prefix so `a` on a member's Models group adds for the member
id.

`Defaults` holds `Agents` (template agents, each with the full subtree,
`[a: add agent template]`), `Teams` (built-in shipped teams, each with
working toggles and member rows that expand to full agent subtrees,
`[a: add team]` still creates
at project or global, never defaults), and then the shared inventories:
`Models` `[a]`, `Tools`, `Base` `[a]`, `Skills`, `System` `[a]`, `MCP` `[a: add MCP server]`.

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
(label → patterns → keywords, each prefilled; tool and rule id come from
the snapshot item's `permTool`/`ruleId`, level and agent from the row
address), persisting through `rule.update`, which upserts a `RuleRecord`
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
  /** id of the base prompt template active for this agent's model, e.g. "gpt" */
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
heuristics in the tree layer).

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
`base:<templateId>` (gpt|claude|muse|gemini|general), `skill:<skillId>`,
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
  readonly tool: string
  readonly id: string
  readonly label: string
  readonly patterns: readonly string[]
  readonly keywords: readonly string[]
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
| `team.create` | `{ level, team, template? }` | `TeamRef` | `project.disabled`, `team.exists`, `team.invalid`, `team.create` |
| `team.setEnabled` | `{ level, team, enabled }` | `TeamRef` | `project.disabled`, `team.unknown`, `team.invalid` |
| `team.addAgent` | `{ level, team, id, template?, prompt }` | `AgentRef` | `project.disabled`, `team.unknown`, `team.invalid`, `agent.exists`, `agent.invalid` |
| `model.add` | `{ level, agent, providerID, modelID, variant? }` | `ModelRef` | `project.disabled`, `model.exists`, `model.invalid` |
| `model.remove` | `{ level, agent, providerID, modelID, variant? }` | `ModelRef` | `project.disabled`, `model.missing`, `model.invalid` |
| `catalog.models` | `void` | `{ models: CatalogModel[] }` (`{ providerID, modelID, variant?, name }`, one entry per base model plus one per variant) | `project.disabled` |
| `rule.add` | `{ level, agent, tool, id, label, patterns, keywords? }` | `RuleRef` | `project.disabled`, `rule.exists`, `rule.invalid` |
| `rule.remove` | `{ level, agent, tool, id }` | `RuleRef` | `project.disabled`, `rule.missing`, `rule.invalid` |
| `rule.update` | `{ level, agent, tool, id, label, patterns, keywords? }` | `RuleRef` | `project.disabled`, `rule.invalid` |

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
derive server-side via `keywordsForPattern` like `rule.add`. Curated-identity
policy: a stored record whose `tool` + `id` matches a curated rule is treated
as an override of that curated rule. This is accepted reserved-identity
semantics, not an unconditional compatibility guarantee. `updateRule`
and `removeRule` share one `ruleProtectedRefusal` guard: protection follows
the matched record's owner, not the caller's row address.

Events: `project.changed`, `instructions.changed`.

New optional keys: `SnapshotItem` carries `codemode`, `namespace`,
`pinned`, `execute`, `permTool`, `ruleId`, `patterns`, `keywords`,
`provenance`, `custom`; `SnapshotCustomizationRecord` carries `pin`;
`AssembledTool` carries `codemode`, `pinned`. `SnapshotRecord` is the union
of `SnapshotCustomizationRecord`, `SnapshotSplitRecord`,
`SnapshotModelRecord` (`{ type: "model", level, agent, providerID, modelID,
variant?, active?: true, updated }`), and `SnapshotRuleRecord`
(`{ type: "rule", level, agent, tool, id, label, patterns, keywords,
updated }`). `AgentEntry` carries `origin?` (`"native" | "special" | "plus" |
"user"`, computed server-side), `model?` (`{ providerID, modelID,
variant? }`) and `fileBacked`. Optional keys are omitted
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
- `team.unknown`: `{ level: FileScope, team: string }`
- `team.exists`: `{ level: FileScope, team: string }`
- `team.create`: `{ level: FileScope, team: string, reason: string }`
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
  never moves a revision. The TUI `a` on a Teams group lists Blank plus the
  Defaults teams from `instructions.snapshot` first (Blank default, so the old
  two-prompt flow is unchanged when chosen) and passes `template` when set.
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
  seeding fields and prompt, unknown names fail with `agent.invalid`. Refuses
  an existing member id with `agent.exists` (path in data) and invalid ids
  with `agent.invalid`. After the write calls `refreshAfterFileChange(...,
  true)` exactly as `createAgent` does, so an enabled team's new member
  installs without a restart. The team row carries `add: "agent"` (member rows
  carry none); `a` on `team:<level>:<team>` opens only the Agent template →
  id → prompt flow with the team's level as scope, never the generic picker.

Implemented: the `Teams` tree group beside `Agents` under the `Project`,
`Global`, and `Defaults` roots (`tree.ts`), always present even when empty
with `[a: add team]` (the Defaults group lists real built-in rows with
working toggles and informational member rows; `add` there still creates at
project or global scope, never defaults). Each team row carries
`add: "agent"` (member rows carry none), so `a` on a team row adds an agent
to that team through `team.addAgent` with the Defaults overlay for
`level: "defaults"`, and TUI wiring (`state.ts`
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
export interface SetInput { readonly id: string; readonly text?: string; readonly state?: "on" | "off"; readonly resolve?: ToolResolve; readonly pin?: boolean; readonly active?: boolean; readonly label?: string; readonly patterns?: readonly string[]; readonly keywords?: readonly string[] }
export interface ResetInput { readonly id: string }
export interface SplitInput { readonly id: string; readonly boundaries?: readonly Boundary[]; readonly add?: { readonly name: string; readonly text: string } }
export type CreateInput =
  | { readonly kind: "agent"; readonly id: string; readonly prompt: string }
  | { readonly kind: "skill"; readonly name: string; readonly body: string }
  | { readonly kind: "base"; readonly id: string; readonly title: string; readonly text: string }
  | { readonly kind: "instruction"; readonly name: string; readonly text: string }
  | { readonly kind: "mcp"; readonly name: string; readonly config: Record<string, unknown> }
  | { readonly kind: "team"; readonly team: string; readonly level: "project" | "global" }
  | { readonly kind: "model"; readonly providerID: string; readonly modelID: string; readonly variant?: string; readonly level?: "project" | "global" | "defaults"; readonly agent?: string }
  | { readonly kind: "rule"; readonly tool: string; readonly id: string; readonly label: string; readonly patterns: readonly string[]; readonly keywords?: readonly string[]; readonly level?: "project" | "global" | "defaults"; readonly agent?: string }
export interface DeleteInput { readonly id: string; readonly confirm: true }
```

- `list` returns the matching row ids (default projection `id, badges,
  source, tokens`; `limit` defaults to 40). `show` defaults to view
  `resolved`. On a perm row any view returns the rule view (`tool`, `rule`,
  `label`, `patterns`, `keywords`, `provenance`, `custom`, `enabled`,
  `source`, plus a scrub preview: `scrub.hidden` lines would drop,
  `scrub.preview` shows up to 3). `assembled` renders the full effective prompt and accepts agent
  row ids only (`agent:<level>:<id>`); any other id fails with
  `view.unsupported`. `record` returns the raw override including `pin`
  when set. `diff` returns two unified diffs (original→mine and
  original→upstream) plus a one-line summary. `set` with `pin` keeps the
  tool's full listing inline in the catalog even when the inline budget is
  tight. `set` with `active: true` activates a model row exclusively at that
  level (a bare `set` on a model row activates too; model rows refuse text,
  state, pin, and resolve); on a perm row `state` applies, or `label` +
  `patterns` (`keywords` optional) to update the rule through `rule.update`
  (no text, pin, active, or resolve). `set` with `resolve: "keep"`
  acks upstream keeping text, `"take"` drops stored text and follows upstream,
  `"edit"` stores `text` against current upstream. `reset` deletes the
  override at that row (on a model row clears only that level's active flag).
  `split` boundaries are `{ id, name, start }` with
  character offsets into the row text; `add: { name, text }` appends a new
  trailing section; perm and model rows cannot be split. `create` writes one row per call; `create` with
  `kind: "team"` creates the team directory DISABLED (enabling stays a
  separate `set` on the team row); `create` with `kind: "model"` needs
  `providerID` + `modelID` (`level` defaults to `project`, `agent` is
  required for project/global levels); `create` with `kind: "rule"` needs
  `tool` + `id` + `label` + `patterns` (patterns are core wildcards, not
  regex). `delete` without
  `confirm: true` fails with `delete.unconfirmed` and writes nothing;
  on a model row it removes the candidate at that level, and only
  user-created (`custom`) rules can be deleted.
- Row ids (same string in the TUI filter, tool calls, the log, and error
  messages): `item:<level>:<agent|''>:<itemId>` (empty agent segment is the
  shared Defaults row), `section:<level>:<agent|''>:<itemId>:<sectionId>`,
  `agent:<level>:<id>`, `team:<level>:<name>`, with item ids
  `model:<providerID>/<modelID>[@<variant>]` and
  `perm:<toolId>:<ruleId>`. `<level>` is `project`,
  `global`, or `defaults`.
- Row ids (same string in the TUI filter, tool calls, the log, and error
  messages): `item:<level>:<agent|''>:<itemId>` (empty agent segment is the
  shared Defaults row), `section:<level>:<agent|''>:<itemId>:<sectionId>`,
  `agent:<level>:<id>`, `team:<level>:<name>`. `<level>` is `project`,
  `global`, or `defaults`.
- Guards: writes for agents listed in `protectedAgents` fail with
  `agent.protected`; unknown ids fail with `row.unknown`. A no-op or a
  refusal writes nothing and logs nothing.

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
  MCP server name; `level` is `project|global|defaults`; `agent` is a
  case-insensitive substring match, `_` is the shared (agent-less) row; `state`
  is `on|off`; `modified`/`overridden` read the row's own stored text;
  `review` includes rolled-up descendant review; `source` is
  `project|global|defaults|upstream`; `active` is the base template active
  for the row's agent model, or the resolved active model on model rows;
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
| `agent.protected` | that agent is in `protectedAgents` |
| `delete.unconfirmed` | retry with `confirm: true` |
| `view.unsupported` | that view needs another id kind (`assembled` needs an agent row) |
| `project.disabled` | project mode is off and no tool changes that |

