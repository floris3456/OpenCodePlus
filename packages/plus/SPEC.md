# Plus Instructions — Foundation Spec

Binding contract for the Instructions TUI foundation: the sections engine
(`src/instructions/sections.ts`), the level-aware inheritance model
(`src/instructions/model.ts`), and the two-store v2 record format with
migration (`src/instructions/store.ts`, `src/instructions/paths.ts`).

## Tree shape

Three top-level roots in this order: `Project agents`, `Global agents`,
`Defaults`. Every agent in all three roots has the identical subtree:

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
`[a: add agent template]`) and then the shared inventories: `Tools`, `Base`
`[a]`, `Skills`, `System` `[a]`, `MCP` `[a: add MCP server]`.

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
export interface Customization {
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
export type Record = Customization | SplitRecord
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
Per-directory async write gate plus optimistic `expectedRevision` stale
results are preserved from the previous store.

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
| `base.create` | `{ id, title, text }` | `BaseRef` | `project.disabled`, `base.exists`, `base.invalid` |
| `instruction.create` | `{ name, text }` | `InstructionRef` | `project.disabled`, `instruction.exists`, `instruction.invalid` |
| `mcp.add` | `{ name, config }` | `McpRef` | `project.disabled`, `mcp.exists`, `mcp.invalid` |
| `mcp.remove` | `{ name }` | `McpRef` | `project.disabled`, `mcp.missing`, `mcp.invalid` |

Events: `project.changed`, `instructions.changed`.

### `Assembled` Shape

Host-applied assembled instructions read back after application:

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
- `skill.invalid`: `{ id: string, reason: string }`
- `base.exists`: `{ id: string }`
- `base.invalid`: `{ id: string, reason: string }`
- `instruction.exists`: `{ path: string }`
- `instruction.invalid`: `{ name: string, reason: string }`
- `mcp.exists`: `{ name: string }`
- `mcp.missing`: `{ name: string }`
- `mcp.invalid`: `{ name: string, reason: string }`

