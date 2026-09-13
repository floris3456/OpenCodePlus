# @opencode/plus

A thin OpenCode V2 plugin adding an opt-in per-directory "Project mode" that reveals additional Project screens. The package provides a server plugin exposing RPC methods to query and toggle project status, and a TUI plugin exposing keybindings and command palette entries.

The package implements project mode toggling, an interactive Instructions screen for viewing and customizing agent prompts and capabilities, dialog workflows for creating, renaming, and deleting agents, and server RPC handlers that persist and apply project-local customizations.

## Running it

`opencodeplus` behaves like `opencode`: run it without arguments for the current directory, or pass a project directory.

Symlink the launcher onto PATH to use it from anywhere:

```sh
ln -s /path/to/repo/packages/plus/bin/opencodeplus ~/.local/bin/opencodeplus
```

The launcher executes this fork directly from source (the installed `opencode2` binary does not include Plus) and sets `OPENCODE_TUI_CHANNEL=plus` so client-local state such as open tabs remains isolated from installed `opencode2` sessions.

## Layout

```
src/
├── index.ts                 # Server plugin entrypoint defining "opencode.plus" and registering RPC handlers
├── project.ts               # Project-mode filesystem operations for .opencodeplus/project.json
├── rpc.ts                   # Public RPC definition, method and event contracts, and portable schemas
├── agents/
│   └── files.ts             # Agent markdown creation, renaming, frontmatter serialization, and removal
├── instructions/
│   ├── apply.ts             # Customization application to agent prompts, skills, tools, and MCP servers
│   ├── discover.ts          # Discovery of customizable items and agent scopes across the workspace
│   ├── model.ts             # Instruction customization domain model, overrides, and fingerprinting
│   ├── store.ts             # JSONL persistence for instruction records with optimistic revision locking
│   └── tree.ts              # Hierarchical navigation tree projection for agents, items, and status badges
└── tui/
    ├── index.tsx            # TUI plugin entrypoint registering commands and keybindings
    ├── project-mode.tsx     # Solid-based project mode controller, RPC client, and confirmation dialogs
    ├── agents/
    │   └── create.tsx       # Interactive dialog workflows for creating, renaming, and deleting agents
    └── instructions/
        ├── detail-pane.tsx  # Detail pane displaying selected item text, scope, and status badges
        ├── route.tsx        # Instructions screen route with adaptive dual-pane layout and navigation
        ├── state.ts         # Reactive state management for instructions snapshots, selection, and mutations
        └── tree-pane.tsx    # Tree pane rendering collapsible agent groups, item nodes, and badges
```

## Storage

Durable state lives directly in the target project folder under `.opencodeplus/`:

- `.opencodeplus/project.json` — the project-mode marker file (`{ "version": 1, "protectedAgents": [] }`). Its existence marks the directory as having project mode enabled.
- `.opencodeplus/instructions/records.jsonl` — instruction customizations stored as line-delimited JSON, with a first-line `{"revision": n}` header followed by canonical customization records.

Disposable caches belong in OpenCode's own storage via the plugin `storage` domain (`ctx.storage`). There is deliberately no second database.

## Fork touch surface

The package uses only the public plugin API so it stays loadable as an external plugin. The complete list of files changed outside `packages/plus` is:

- `packages/core/src/plugin/internal.ts` — imports `PlusPlugin` from `@opencode/plus` and appends it as the last entry of the `post` plugin array.
- `packages/tui/src/plugin/builtins.ts` — imports `Plus` from `@opencode/plus/tui` and appends it to `builtins`.
- `packages/core/package.json` — adds `"@opencode/plus": "workspace:*"` to dependencies.
- `packages/tui/package.json` — adds `"@opencode/plus": "workspace:*"` to dependencies.
- `bun.lock` — workspace dependency resolution entries.

## Boundaries and known limits

- **Per-server MCP tool checklist: closed, not deferred.** The public plugin API exposes no authoritative link from a tool back to its originating MCP server. Core's internal MCP tool record carries a `server` field (`packages/core/src/mcp/index.ts`), but tool registration passes only name, namespace, mode, schemas, description and executor (`packages/core/src/tool/mcp.ts`), and the public `Tool.Info` (`packages/schema/src/tool.ts`) has no MCP origin field. The tool namespace is a sanitized server name, so matching it would be name inference, which this package forbids. `Mcp.ServerConfig` (`packages/schema/src/mcp.ts`) has server-wide `disabled` and `codemode` but no per-tool enablement. What remains supported is the flat tool list plus a whole-server toggle.
- **Native vs Code Mode tools.** Core partitions tools in `Tool.snapshot` (`packages/core/src/tool.ts`): `options.codemode === false` means native and appears as an individual key of the session tool list; anything else, including absent options, is Code Mode and is reached only through the aggregated `execute` inventory. Plus applies tool changes through the session context, so it can only toggle or re-describe native tools. Code Mode rows are therefore marked non-actionable rather than silently doing nothing. Note the partition happens after the tool registry, so `ctx.tool.transform` itself can reach both kinds — the limit is Plus's application path, not the whole plugin API.
- **Discovery must not observe Plus's own applied output.** `discover()` reads the host after Plus's transforms are installed, so treating that as upstream makes the publish fingerprint flip every pass and produces a permanent dispose/reinstall loop. Prompt discovery avoids this by retaining a per-agent baseline and, for file-backed agents, rereading the markdown body (core decodes agent markdown as `{...frontmatter, system: body}` with the body trimmed). Anything that starts mutating the tool registry would need the same treatment — tools currently have no baseline unmasking.
- **Every client-facing RPC error must be declared** in the `Definition`, because core's `encodeError` fails on undeclared ones.
- **Never send an optional key whose value is `undefined` across the RPC boundary.** Core validates each RPC result as a JSON value, so a present-but-`undefined` property makes the whole call fail with HTTP 400. Omit the key instead. `expectRpcBody` in `test/rpc.test.ts` guards this.
- **Instruction customization: closed at the plugin boundary.** The public plugin API does not expose source-aware instruction customization. Core builds instruction system parts with `SystemPart.make(text)`, giving only `{ type, text }` with no source identity (`packages/core/src/session/model-request.ts`). Core renders files as `Instructions from: <path>\n<content>`, joins them, then merges them with environment, skills, MCP and session sources into ONE combined part, not one per file (`packages/core/src/instruction-discovery.ts`, `packages/core/src/session/context.ts`). File content is inserted unescaped with no end marker, so no reliable span identity exists. Furthermore, core's path-keyed `InstructionDiscovery.Editor` is not exposed on the public plugin `Context` (`packages/plugin/src/effect/plugin.ts`). Instruction rows therefore refuse toggle and edit as non-actionable. Reopening it would need a public source-aware instruction application contract covering session selection and instruction history.
- **Instruction discovery inventory mismatch.** `readProjectInstructions` in `src/instructions/discover.ts` walks DOWNWARD collecting `AGENTS.md` recursively, whereas core's ambient discovery loads global config plus project files UPWARD (`packages/core/src/config/plugin/instruction.ts`), and descendant files instead arrive as synthetic messages when a file is read (`packages/core/src/tool/plugin/read.ts`). Because of this, the instruction rows Plus lists are not the same set core applies to a session.
- **Instruction customizations are project-local only: closed, not deferred.** Plus instruction customizations are stored in `.opencodeplus/instructions/records.jsonl` within the target project directory. Plus does not implement global-scope customization storage or cross-project mutation; the shared Defaults target configures settings shared across agents within the active project rather than a cross-project global scope.
- **Remaining known limits**, listed plainly: builtin agents have no backing file, so an upstream prompt edit stays masked while a customization is active; MCP server configuration is file-owned, so MCP text edits are not applied.
- **Plugin unload disposes applied registrations.** `applied` registrations in `packages/plus/src/instructions/apply.ts` are created on detached scopes (`Scope.make()` driven by `Effect.runPromise`) because application runs through asynchronous helpers outside the activation effect. To prevent these registrations from surviving plugin unload or hot-replacement, `packages/plus/src/index.ts` registers a teardown finalizer (`deactivate(state)`) on the owning plugin activation scope. When core closes the plugin activation scope on unload (such as via `-opencode.plus` in `packages/core/src/config/plugin/source.ts`) or when `packages/core/src/plugin.ts` closes and reactivates the changed plugin suffix, the finalizer disposes all applied registrations so orphaned hooks and transforms do not survive across instances.
- **MCP tools that return asynchronously do not regain their customizations until the next publish.** Plus watches `agent.updated`, `skill.updated` and `config.updated`. Core reconciles MCP tool inventory behind a 100 ms debounce and a `tools.reload()` (`packages/core/src/tool/mcp.ts`) that emits none of those events. So after disabling an MCP server through Plus and then resetting that override, a tool customization belonging to that server is reinstalled only on the next publish, not the moment the tool reappears. Closing this would require a public post-reconciliation tool-inventory notification; subscribing to the earlier MCP event would still race the debounced rebuild.
- **A reset MCP row reports stale availability in the mutation response only.** `publishFresh` in `packages/plus/src/index.ts` discovers using the newly saved records while the previous transform is still installed, so immediately after clearing an MCP override the `upstreamMcpAvailable` inference in `packages/plus/src/instructions/discover.ts` falls through to reading Plus's own still-applied `disabled` flag. Disposal then restores the host correctly and the next discovery reports the right value; only the returned snapshot and the cached publication fingerprint are transiently wrong.
- **An MCP customization carrying `text` renders content that is never applied.** The public `instructions.mutate` schema accepts an optional `text` on any customization, and `packages/plus/src/instructions/apply.ts` applies only enablement for MCP rows, because server configuration is file-owned. The current TUI never creates such a record, but a client that wrote one directly would see the stored text rendered as the resolved configuration while the host kept using the upstream config. `resetFields` deliberately clears only `state` for MCP rows.
- **Upstream permission denials are not reflected in discovered availability.** `skillItems` and `toolItems` in `packages/plus/src/instructions/discover.ts` construct items with the default `available: true`, because the public plugin API surfaces the whole inventory: `ctx.skill.list()` and the `ctx.tool.transform` editor list return every skill and tool for the location without applying any agent's permission rules. Core, however, filters denied skills in `packages/core/src/skill.ts` and drops wholly denied tools in `packages/core/src/tool.ts` before session context hooks run. An agent that upstream denies a skill or native tool therefore still shows that row as `[enabled]`, and toggling it off and back on reports success while the agent remains unable to use it, because for original skills `applySkills` in `packages/plus/src/instructions/apply.ts` only ever adds denials and cannot lift an upstream denial (while for Plus's own private copies it does append allows). Only MCP rows compute availability from upstream state. Closing this is not a local patch: `Item.available` in `packages/plus/src/instructions/model.ts` is a single per-item boolean with `agents: []`, so it cannot represent one agent allowing and another denying the same skill; per-agent availability would have to be threaded through `discover.ts`, `model.ts`, `tree.ts` and the snapshot schema in `packages/plus/src/rpc.ts`. The behaviour is pinned by the test `discovery reports an upstream-denied skill as available (known limitation)` in `packages/plus/test/discover.test.ts`.
- **MCP upstream drift can normalize a toggle away.** `upstreamMcpAvailable` in `packages/plus/src/instructions/discover.ts` infers pre-transform MCP availability from the shared customization record. If the user disables a server through Plus and the upstream configuration is then independently edited to also disable it, the inference still reports upstream as enabled, because a shared record saying `disabled` is taken to mean upstream was enabled. `mergeCustomization` in `packages/plus/src/instructions/model.ts` then treats a subsequent request to enable as redundant and drops the record, so Plus removes its own disable while the upstream disable remains and the row reports success. The symmetric case exists when an upstream-disabled server is enabled through Plus and upstream is then enabled independently. This is not narrowed away because the same toggle is the only way to undo an ordinary Plus override, which is the common case; refusing it would break undo for every correctly-overridden server in order to guard a configuration-drift case. Recovering from drift is possible by resetting the row and refreshing.
- **Toggling an inherited row can clear an unacknowledged review.** When a shared Defaults record carries both customized `text` and a `needs review` flag raised by an upstream change, an agent row that merely inherits that record can be toggled with `space`. `mergeCustomization` in `packages/plus/src/instructions/model.ts` writes a new per-agent state-only record whose `basedOn` is the current item fingerprint, while `override` continues to supply the inherited shared `text`. Because `isReview` compares `basedOn` and `reviewed` against the current fingerprint, the review flag clears on that row without the user ever acknowledging the upstream change, and the stale shared text stays applied. The shared Defaults row itself still shows the review flag. This is not fixed because the correction belongs in the shared/per-agent record merge in `model.ts`, which is the most heavily depended-on algebra in the package.

## Shortcut

- `ctrl+x p` (`<leader>p`) toggles project mode after displaying a confirmation dialog.
- Commands live in the `Project` group and are reachable from the command palette:
  - `plus.project.toggle` ("Toggle project mode"): prompts for confirmation and enables or disables project mode for the current directory.
  - `plus.project.status` ("Show project mode status"): shows a toast with the active project mode directory (enabled only when project mode is active).

## Development notes

- **Portable RPC schemas**: The TUI promise client requires `Rpc.PortableDefinition`; bare Effect schemas do not structurally satisfy it, so `src/rpc.ts` wraps its schemas with `Schema.toStandardSchemaV1`. Note that the Effect `RpcApi` used elsewhere (e.g. `packages/desktop`) accepts a plain `Definition`, which is why the two clients differ.
- **Agent markdown body and frontmatter**: Agent markdown files put the prompt in the **body** (core decodes `{ ...frontmatter, system: body }`); any frontmatter key outside `ConfigAgent.Info` plus `variant` silently routes the file through the legacy V1 migration path. Prompts must not be serialized into a `system` frontmatter property.

## Tests

Tests must be run from `packages/plus`, never from the repository root (a root execution guard prevents running tests from the root):

```sh
# Run focused tests
bun test test/model.test.ts
bun test test/store.test.ts
bun test test/agents.test.ts
bun test test/rpc.test.ts
bun test test/apply.test.ts
bun test test/discover.test.ts
bun test test/tree.test.ts

# Run package typecheck
bun run typecheck
```
