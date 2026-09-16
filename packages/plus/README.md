# @opencode/plus

An OpenCode V2 plugin adding an opt-in per-directory "Project mode" plus an Instructions screen for viewing and customizing what each agent sees: tools, base prompts, skills, and system instructions. The server plugin (`src/index.ts`, RPC id `opencode.plus`) discovers inventory, persists customizations across two stores, and applies them through the public plugin API; the TUI plugin (`src/tui`) renders the tree, detail, diff, and splitter panes.

## Running it

`opencodeplus` runs the Instructions TUI for a directory: run it without arguments for the current directory, or pass flags and an optional project directory. Subcommands are refused; they must be run from the repository with `bun run dev <subcommand>`, because running them through the launcher would misdirect cwd-sensitive handlers. In the narrow case where a flag value happens to match a subcommand name (for example `--prompt run`), the launcher fails safe and also refuses the invocation.

Symlink the launcher onto PATH to use it from anywhere:

```sh
ln -s /path/to/repo/packages/plus/bin/opencodeplus ~/.local/bin/opencodeplus
```

The launcher executes this fork directly from source (the installed `opencode2` binary does not include Plus) and sets `OPENCODE_TUI_CHANNEL=plus` so client-local state such as open tabs remains isolated from installed `opencode2` sessions.

## Layout

Three top-level trees, in order: `Project`, `Global`, `Defaults`. Each of the three holds an `Agents` group (`[a: add agent]`) whose children are the agents with the identical subtree:

```
<Agent>
  Models                     union down the chain plus the agent's upstream model (`source` badge, one `active`)
    <model>
  Tools                      Native / OpenCodePlus / MCP > <server>, each with a `Code Mode` subgroup when it has Code Mode rows (namespaced below Native/OpenCodePlus, flat below an MCP server)
    <tool>
      <section>
      Permissions              (after sections; native/plus non-Code-Mode non-`execute` tools only)
        <rule>
  Base                       [a: add base prompt]
    <template>.txt           (the one matching the agent's model is marked "active")
      <section>
  Skills                     Native / OpenCodePlus / MCP > <server> / Project [a: add skill]
    <skill>
      <section>
  System                     [a: add instruction]
    Role/persona             (always first)
    <instruction>
      <section>
```

`Defaults` holds `Agents` followed by the shared inventories: `Models`, `Tools`, `Base`, `Skills`, `System`, `MCP` (`[a: add MCP server]`). `a` on an Agents group adds an agent at that level. `d` deletes project/global agents (`agent.delete`), shared MCP servers (`mcp.remove`), project-owned skills (`skill.delete`), user base templates (`base.delete`), and project instruction files (`instruction.delete`). Rows that still cannot be deleted — upstream-owned skills, builtin base templates, native/MCP tool rows, section rows, and an agent's own `Role/persona` prompt body — keep a specific refusal message naming why.

Code Mode tool rows support toggle, edit, split, reset and a new **pin** (`p` toggles it, the `pinned` badge reads the resolved pin); pinning keeps a tool's full listing inline in the catalog even when the inline budget is tight. The synthetic `execute` row is a native toggle-only row. Code Mode and `execute` rows carry no `Permissions` subgroup: their denies are whole-tool only.

## Model selection

Each agent subtree opens with a `Models` group (`[a: add model]` from the host catalog). Rows are the union of stored candidates down the existing chain (most-specific source wins) plus the agent's upstream model, each with a `source` badge (`project`/`global`/`defaults`/`upstream`). At most one stored row per (level, agent) carries `active`; the effective model is the first active row down the chain, else upstream. Space (or `set` with or without `active: true`) activates one candidate exclusively at that level, creating the local row when the candidate is inherited; `r` clears only that level's active flag so the chain falls through; `d` deletes the candidate at that level only. Adding stores an inactive row and never steals the effective model. The active model reaches the host in one `ctx.agent.transform` (`applyModels` in `src/instructions/apply.ts`) and reaches sessions through `switchModel` on `session.created` / `session.agent.selected` only when the session's current model differs; manual mid-session picks (`session.model.selected`) are never subscribed to and never overridden. The base template follows the model family automatically: the context hook classifies each request's model through `ctx.prompt.active` and applies only the template active for that request.

## Permission rules

Each native/plus non-Code-Mode non-`execute` tool row carries a `Permissions` subgroup (`[a: add rule]`) after its sections, listing that tool's rules: curated defaults plus candidates mined from text Plus already holds (tool/base/skill/role/file/teaching text, with `provenance` naming the mentioning item ids, most-mentioned first), plus user `RuleRecord` customs. Turning a rule OFF installs one core deny per pattern (`{ action, resource, effect: "deny" }`, appended; core evaluates last-match-wins) for that agent and scrubs matching lines from tool descriptions, system parts, and catalog descriptions. Patterns are CORE RESOURCE WILDCARDS, not regex (`*` spans any run, `?` one character); for shell the resource is the parsed command text, so `git *` also matches a bare `git`. The action derives from the tool id (`edit`/`write`/`patch` share core's `edit` action, everything else uses its own id). Scrub keywords come only from the single `keywordsForPattern` (head plus subcommands, stopping at wildcards/flags, so `git push *` scrubs `git push` lines, not every `git` line). Mined candidates are view-time only: never persisted and never part of the publish fingerprint (only a stored off-state or a `RuleRecord` enters it via `records`).

## Inheritance

Resolution runs Defaults → Global → Project, most specific first: `project/A → global/A → defaults/A → shared → upstream` (the global and template steps apply only when that agent exists at that level). Text and state resolve independently: the first level supplying each field wins. Pin resolves down the same chain as `enabled`: the nearest record carrying `pin` wins, else the registry default. `r` removes the override at the current level only. A state-only override never marks a node modified and never raises review, so a disabled-but-unmodified copy keeps taking upstream text silently. Unmodified nodes store nothing, so they re-resolve on every read and upstream edits propagate live with no user action.

## Review and diff

A modified copy whose upstream moved turns yellow, rolls up to collapsed ancestors as "N to review", and resolves through a three-way diff (original upstream / mine / new upstream): `k` keep mine, `t` take new, `e` edit merged text. Sections warn independently without raising siblings.

## Sections

Derived from markdown headings, else XML-style blocks, else the whole text. `s` cuts a manual split (arrows move, `b` boundary, `e` rename, `x` remove, `ctrl+s` save). A split belongs to the item at the level where it was made and resolves down the same chain; include/exclude belongs to the agent.

## Keys

Up/down move, left collapse/parent, right expand, Enter edit text (or diff on yellow review rows), Space toggle include/exclude (on a Models row: activate exclusively at that level; on a rule row: toggle the rule), `p` pin (Code Mode tool rows), `a` add (`a` on a Models group adds a catalog candidate; `a` on a Permissions group adds a rule scoped to that group, prompting otherwise), `d` delete (`d` on a model row deletes the candidate at that level; `d` on a rule row deletes only user-created rules), `r` reset override (`r` on a model row clears only that level's active flag), `s` split, `/` filter, `?` help, esc back. Inside the diff: `k` keep mine, `t` take new, `e` edit.

## Storage

Two stores: project scope in `<project>/.opencodeplus/instructions/records.jsonl` (`level === "project"` only), global scope and Defaults in `<configDir>/opencodeplus/instructions/records.jsonl` (global and defaults levels). Each store tracks its own revision from its file header. Saves supply separate expected project and global revisions and serialize under a process-wide global gate plus the per-project gate in a fixed order, so concurrent projects cannot clobber the shared global file. Stale saves identify the conflicting store (`project` or `global`), and a save only writes and bumps the store whose routed records actually changed (a project-only save leaves the global revision untouched and vice versa). Format is v2 JSONL: a `{"version":2,"revision":n}` header line, then one canonical record per line. A v1 `records.jsonl` header (no `version`) is migrated on load and the first save writes v2 to both stores, so v1 is never written and the two formats never sit side by side.

RPC (`src/rpc.ts`, id `opencode.plus`): `project.status/enable/disable`, `instructions.snapshot/refresh/mutate/assembled`, `agent.create/rename/delete`, `skill.create/import/delete`, `base.create/delete`, `instruction.create/delete`, `mcp.add/remove`, `model.add/remove`, `catalog.models`, `rule.add/remove`, `team.setEnabled`; events `project.changed`, `instructions.changed`. The binding contract is `SPEC.md`.

## Tools

Agent-facing Code Mode namespace `instructions` (`src/instructions/teaching.ts` pins the contract, `instructions-tools` skill carries the details). Agents call `tools.instructions.list({...})` inside `execute`, never as native tools. The tools exist only while project mode is enabled (`project.disabled` otherwise), and no tool enables or disables project mode.

| tool | input |
| --- | --- |
| `list` | `{ where?, fields?, sort?, limit?, offset? }` (`limit` defaults to 40; `where` accepts `item:model\|perm`, `active`, and `tool:<id>`) |
| `show` | `{ id, view? }` (`view` defaults to `resolved`; on a perm row any view returns `patterns`, `keywords`, `provenance`, and a scrub preview) |
| `set` | `{ id, text?, state?, resolve?, pin?, active? }` (`state` is `on`\|`off`; `resolve` is `keep`\|`take`\|`edit`; `pin` keeps the tool's full listing inline in the catalog; `active: true` activates a model row exclusively at that level — a bare `set` on a model row activates too; perm rows accept only `state`) |
| `reset` | `{ id }` (deletes the override at that row; on a model row clears only that level's active flag) |
| `split` | `{ id, boundaries?, add? }` (`boundaries` is `[{ id, name, start }]` with character offsets; `add: { name, text }` appends a trailing section; perm and model rows cannot be split) |
| `create` | `{ kind, ...fields }`, one row per call: agent needs `id` + `prompt`; skill needs `name` + `body`; base needs `id` + `title` + `text`; instruction needs `name` + `text`; mcp needs `name` + `config`; team needs `team` + `level`; model needs `providerID` + `modelID` (optional `variant`, `level`/`agent`); rule needs `tool` + `id` + `label` + `patterns` (optional `keywords`, `level`/`agent`) |
| `delete` | `{ id, confirm: true }` (refused without `confirm: true`; on a model row removes the candidate at that level; only user-created rules can be deleted) |
| `log` | `{ where?, limit?, offset? }` → `{ entries, total }`, both log files merged newest-first |

`show` views: `resolved` (default), `upstream` (text above the override), `mine` (stored text), `record` (raw override), `sections` (section ids), `diff` (original→mine and original→upstream unified diffs plus a one-line summary), `assembled` (full effective prompt, agent row ids only). `set` with `resolve: "keep"` acks upstream keeping text, `"take"` drops stored text and follows upstream, `"edit"` stores `text` against current upstream.

Row ids name one row everywhere: the TUI filter, tool calls, log targets, and error messages all use the same string:

- `item:<level>:<agent|''>:<itemId>` — a whole row (empty agent segment is the shared Defaults row)
- `section:<level>:<agent|''>:<itemId>:<sectionId>` — one section inside a row
- `agent:<level>:<id>` — one agent's subtree (only these accept `view: "assembled"`)
- `team:<level>:<name>` — one team
- `model:<providerID>/<modelID>` (optionally `@<variant>`) — the `<itemId>` of a model row
- `perm:<toolId>:<ruleId>` (the rule id keeps any extra `:` it contains) — the `<itemId>` of a permission row

`<level>` is `project`, `global`, or `defaults`.

Guards: writes for agents listed in `.opencodeplus/project.json` `protectedAgents` are refused; `delete` needs `confirm: true`; no tool enables or disables project mode; every successful write is logged with actor `tool`.

Log format is `Plus.LogEntry` (`src/rpc.ts`): `{ ts, actor: { type: tui|tool, agent?, sessionID?, messageID? }, op, target, summary, revision }`. Project writes append to `<project>/.opencodeplus/instructions/log.jsonl`, global/defaults writes to `<configDir>/opencodeplus/instructions/log.jsonl`. The log's own `where` grammar is small: a bare word matches over op, target, summary, and actor agent; keyed tokens are `actor:tui|tool`, `agent:<text>`, `op:<text>`, `target:<prefix>`, `session:<text>`, `since:<instant>` / `before:<instant>` (ISO date or `<n><s|m|h|d|w>` age).

## Fork touch surface

Every place core changed for this feature, and why the plugin API could not do it:

- `packages/schema/src/tool.ts` — `Tool.Info.origin?: { type: "mcp" | "plugin"; name }`. Registration keeps only whitelisted fields and the namespace sanitizes the server name irreversibly, so no plugin could recover the real server for grouping. (`packages/core/test/tool-origin.test.ts`)
- `packages/core/src/tool/mcp.ts` — passes the real server name as `origin` at registration. (same test)
- `packages/core/src/instruction-discovery.ts` + `packages/core/src/session/context.ts` — one `Instructions.Source` per file keyed by path and one system part per file, instead of every file merged into a single part with no source identity. The plugin editor alone could not restore boundaries core had already erased. (`packages/core/test/instruction-source-parts.test.ts`)
- `packages/core/src/prompt-template.ts` + `packages/core/src/plugin/*` — a `PromptTemplate` registry (templates plus active-for-model) exposed as `ctx.prompt`, so the active base prompt is knowable and selectable; it used to live only inside core internals. `PromptTemplate.raw(model)` owns the per-model raw-text selection (including gpt-6 → `gpt-astra.txt`), shared by the OpenAI optimize plugin and exposed as `ctx.prompt.raw`, so Plus aligns tool guidance against the template core actually rendered rather than the classification's canonical template — otherwise a customized gpt base silently wipes astra-rendered guidance on gpt-6 requests. (`packages/core/test/prompt-template.test.ts`)
- `packages/plugin/src/effect/instruction.ts`, `prompt.ts` — the public plugin surface for the two above (`ctx.instruction.transform`, `ctx.prompt`).
- `packages/cli/src/util/process.ts` + `packages/cli/src/services/standalone.ts` — a real bug fix, not a feature seam: a background server inherited the caller's working directory, breaking `opencodeplus` and `bun run dev <dir>`; `serviceDirectory()` returns the package root holding `tsconfig.json`. (`packages/cli/test/self-command.test.ts`, `packages/client/test/service-contender.test.ts`)
- `packages/client/src/effect/service.ts` + `packages/client/src/promise/service.ts` — `ensure()` records a non-zero contender exit as a pending failure and stops spawning replacements until live contenders drain, so a real startup error (for example a port conflict) surfaces instead of being outrun by its own replacement. A zero exit, the legitimately elected loser, keeps the previous backoff. Both implementations were changed identically without touching Protocol, HttpApi, or generated client surfaces. (`packages/client/test/service.test.ts`, `packages/client/test/promise-service.test.ts`)
- `packages/cli/src/server-process.ts` — `recognizeIncumbent` probes `/api/health` once before its retry loop and fails fast when the port answers 200 with a body that provably fails to decode as the health shape, so a foreign occupant no longer costs 15 seconds of silence. (`packages/cli/test/service.test.ts`)
- `packages/core/src/tool.ts`: `Tool.snapshot` now drops a tool when its own id is wholly denied, not only its permission group, so a single Code Mode tool can be excluded for one agent. (`packages/core/test/tool-origin.test.ts`)
- `packages/plugin/src/effect/session.ts` + `packages/core/src/session/context.ts`: a `session.catalog` hook fired inside `SessionContext.select`, letting a plugin rewrite each agent's Code Mode catalog descriptions and pins. The registry editor is global, so `editor.update` would change one description for every agent and, because discovery reads the host back, would flip the publish fingerprint into a dispose/reinstall loop. (`packages/core/test/session-catalog.test.ts`)
- Loading wiring only: `PlusPlugin` appended last in `post` (`packages/core/src/plugin/internal.ts`), `Plus` in the TUI `builtins`, workspace deps in `core`/`tui` `package.json`.

## Boundaries and known limits

Only what is provably impossible, with what was tried:

- **The `execute` row is host-owned.** Core synthesizes the tool, so there is no upstream description to edit and the row is toggle-only; turning it off installs a deny for `execute`, which removes Code Mode (and its catalog instruction) for that agent.
- **Token counts on Code Mode rows are approximate.** Only the first description line, truncated at 120 characters, is counted, and the host-generated signature part of the catalog line is not counted — that is why the number is an approximation of the real cost rather than the whole stored text.
- **User-created base templates can never become active.** `ctx.prompt.active` only ever answers with host template ids (`packages/core/src/prompt-template.ts`). Because `applyBasePlan` matches candidates strictly against `activeByAgent` (`packages/plus/src/instructions/apply.ts`), custom user base templates never reach `system[0]`; in the tree, user base templates are marked `inactive` (`packages/plus/src/instructions/tree.ts`).
- **Discovery unmasks Plus's own output.** Discovery reads the host after Plus's transforms are installed, so reporting that text as upstream flips the publish fingerprint every pass into a dispose/reinstall loop. Plus retains per-item applied/upstream baselines (`src/instructions/inventory.ts`, captured in `src/index.ts`) and rereads file-backed agent bodies instead.
- **Every client-facing RPC error must be declared** in the `Definition`, because core's `encodeError` dies on undeclared ones (`packages/core/src/rpc.ts`).
- **Never send an optional key whose value is `undefined` across the RPC boundary.** Results are validated as JSON, so the whole call fails with HTTP 400. Omit the key instead. `expectRpcBody` in `test/rpc.test.ts` guards this.
- **Upstream permission denials are invisible.** `ctx.skill.list()` and the tool editor list return the full inventory without agent permission evaluation (core filters later in `packages/core/src/skill.ts` and `packages/core/src/tool.ts`), and `Item.available` is one boolean per item, not per agent. A denied row shows `[enabled]` and toggling it is a no-op upstream. Threading per-agent availability through discover, model, tree, and RPC was cut as disproportionate. No test currently pins this.
- **Async MCP tools regain customizations at the next publish, not on reappearance.** Core reconciles MCP tools behind a 100 ms debounce plus `tools.reload()` (`packages/core/src/tool/mcp.ts`), which emits none of the events Plus watches (`agent.updated`, `skill.updated`, `config.updated`). Closing it needs a public post-reconciliation inventory notification.
- **Custom rules are globally unique by tool+id, not per level/agent.** `rule.add`/`rule.remove` match existing records by `(tool, id)` only, so a second level or agent cannot define its own rule with the same tool+id.
- **The TUI add-rule flow prompts for scope.** `a` on a Permissions group defaults to that group's level/agent and otherwise prompts for level then agent (mirroring add-model); the dialog calls `rule.add` with the chosen scope, shared (`agent: null`) or per-agent.
- **MCP tool rows get no Permissions subgroup** because their resource is always `"*"`, so per-resource rules would never match core evaluation.
- **Code Mode and `execute` rows only support whole-tool denies.** Per-resource subgroups are skipped there (`tree.ts` `permsGroup`); use the row toggle.
- **`write`/`edit`/`patch` share one enforcement action.** Core asserts `action: "edit"` for all three (core/src/tool/plugin/edit.ts, write.ts, patch.ts); Plus prefers the tool's own `options.permission` carried on perm items and falls back to that map.
- **PATH-scoped search restriction is NOT expressible for glob/grep.** Core authorizes `input.pattern`, not the search path (core/src/tool/plugin/grep.ts:87-89, glob.ts:68-70), so a deny can only match search text mentioning a string (e.g. `*node_modules*`), never a directory walk like `grep({ pattern: "HEAD", path: ".git" })`.

## Shortcut

- `ctrl+x p` (`<leader>p`) toggles project mode after displaying a confirmation dialog.
- Commands live in the `Project` group and are reachable from the command palette:
  - `plus.project.toggle` ("Toggle project mode"): prompts for confirmation and enables or disables project mode for the current directory.
  - `plus.project.status` ("Show project mode status"): shows a toast with the active project mode directory (enabled only when project mode is active).
  - `plus.instructions.open` ("Instructions", slash `/instructions`): opens the Instructions screen (enabled only when project mode is active).

## Development notes

- **Portable RPC schemas**: The TUI promise client requires `Rpc.PortableDefinition`; bare Effect schemas do not structurally satisfy it, so `src/rpc.ts` wraps its schemas with `Schema.toStandardSchemaV1`. Note that the Effect `RpcApi` used elsewhere (e.g. `packages/desktop`) accepts a plain `Definition`, which is why the two clients differ.
- **Agent markdown body and frontmatter**: Agent markdown files put the prompt in the **body** (core decodes `{ ...frontmatter, system: body }`); any frontmatter key outside `ConfigAgent.Info` plus `variant` silently routes the file through the legacy V1 migration path. Prompts must not be serialized into a `system` frontmatter property.

## Tests

Tests must be run from `packages/plus`, never from the repository root (a root execution guard prevents running tests from the root):

```sh
# Run focused tests
bun test test/model.test.ts test/tree.test.ts
bun test test/store.test.ts test/sections.test.ts
bun test test/agents.test.ts test/rpc.test.ts test/rpc-contract.test.ts
bun test test/apply.test.ts test/discover.test.ts
bun test test/route.test.tsx test/instructions-panes.test.tsx test/instructions-diff-split.test.tsx

# Run package typecheck
bun run typecheck
```
