# @opencode/plus

A thin OpenCode V2 plugin adding an opt-in per-directory "Project mode" that reveals additional Project screens. The package provides a server plugin exposing RPC methods to query and toggle project status, and a TUI plugin exposing keybindings and command palette entries.

The package implements project mode toggling, an interactive Instructions screen for viewing and customizing agent prompts and capabilities, dialog workflows for creating, renaming, and deleting agents, and server RPC handlers that persist and apply customizations across project and global scopes.

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
