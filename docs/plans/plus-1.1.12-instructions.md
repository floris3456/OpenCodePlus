# plus-1.1.12 — Instructions: agents, teams, models, rename and categories

**Objective:** every Instructions change applies at once everywhere, with no
restart, toggle dance or wrong directory. Concretely: agents delete, disable and
appear correctly; teams show new members immediately; a model you add is active
and actually used; an agent's model applies without restarting the TUI; Global
teams never leak into Defaults. Agents, members and teams can be renamed. Models
lists load fast and agents' Models use the Defaults › Models field layout. You
can create your own categories and move any row into them.

Release: `plus-1.1.13` (moved from `plus-1.1.12` on 2026-10-04; how to
resume it: `plus-1.1.13-team-fixes.md`). This was one of three plans run in
parallel:
`plus-1.1.12-session-runtime.md`, `plus-1.1.12-instructions.md` (this),
`plus-1.1.12-monitor.md`. Overlap zones are named under each task.

## Working rules (binding for the orchestrator and every member)

1. **The end states are the contract; the implementation is yours.** A
   different file, seam or design is fine as long as every end-state line holds
   and the change carries the least load: the smallest change that reuses
   existing seams, no new frameworks, no speculative robustness. The
   repository's `AGENTS.md` style guide applies.
2. **Finish everything end-to-end without stopping.** Do not ask the user or
   the planner anything: decide inside the end state and record the decision
   in your report. The only acceptable reason to leave a task unfinished is a
   provider failure (the model provider unreachable or refusing after retries).
   Then finish every other task, finish `done_with_concerns`, and quote the
   exact error.
3. **Concurrency:** at most 2 of your children working at once (the live-run
   limit of 12 is shared by the whole namespace). If a delegation is refused
   with `E_BOUNDS` while none of your own children is working, run `sleep 120`
   in the shell and retry. Never finish blocked for `E_BOUNDS`.
4. **Every task ends verified:** focused tests at the real boundary (no mocks of
   the code under test, no duplicated logic in tests), `bun run typecheck` in
   every touched package, and for anything visible in the TUI a live check in
   the worktree's own build: `pilotty spawn --name <run> opencodeplus-dev .`
   from the worktree. Say in the report what you did and what you saw. Never
   `bun run dev:live` or `bun run dev`, never the live service on port 40375,
   never live config (`~/.config/opencodeplus`) or live databases — copies only.
5. Tests run from package directories (`packages/plus`, `packages/tui`,
   `packages/client`), focused files only, never the repo root.
6. Public Protocol / Server `HttpApi` changed → `bun run generate` in
   `packages/client`; never hand-edit generated files.
7. Docs follow behaviour: `packages/plus/README.md`, `packages/plus/SPEC.md`
   where the binding contract changes, `src/instructions/teaching.ts` and the
   `instructions-tools` skill text when a tool contract changes. Update
   `tui/instructions/help.tsx` and footer hints when keys change.
8. Have a reviewer read each task's diff before you land it.
9. Commits: `type(scope): subject`.
10. Report every end-state line below and how it was verified.

**Checks:** the project names no checks, so a check is `bun test <file>` or
`bun run typecheck` as argv with `cwd` set to the package directory.

**Evidence from the user's machine (read only, never write):**
- Live config dir is `~/.config/opencodeplus/`: agents in `agents/`, teams in
  `teams/Basic/`, records and log in `instructions/`.
- Delete failed with `Agent deepseek-worker does not exist at
  /home/bliss/.config/opencode/agents/deepseek-worker.md`; the file is at
  `~/.config/opencodeplus/agents/deepseek-worker.md`.
- The user's Global team is `Basic` (capital B). Its members are linked to the
  shipped `basic` member presets (`link` records with
  `team: {level:"global", team:"Basic"}`).
- Tool-actor model writes the user said "didn't work", in
  `~/.config/opencodeplus/instructions/log.jsonl` at
  2026-10-03T21:31: actor tool/agent `build`, op `mutate`, targets such as
  `model:global:Planner:cliproxyapi/claude-opus-5-5@max` and
  `model:global:Orchestrator:cliproxyapi/claude-opus-5-5@xhigh`. Note: these
  agents exist only as `Basic` team members, and the targets carry no team
  owner path.

---

## T1 — Global agent files live in the real config directory

**End state**
- Create, rename, delete and file reads for Global agents use the host's real
  global config directory (`~/.config/opencodeplus` for this product, honouring
  `OPENCODE_CONFIG_DIR`).
- Deleting Global › User › `deepseek-worker` (or any Global user agent)
  succeeds. The agent then disappears from the tree, the agent switcher and the
  team pickers at once (T2), and its stored records (customizations, splits,
  models, rules, links, warming rows) are removed in the same store revision.
  Re-creating an agent with the same id therefore starts clean.

**Root cause:** `packages/plus/src/agents/files.ts` → `configDirectory()` (~344)
hardcodes `<XDG_CONFIG_HOME>/opencode`. `packages/plus/src/instructions/paths.ts`
→ `globalConfigDir()` already resolves the product namespace. Also check every
other path builder for the same mistake.

**Where:** `agents/files.ts`; `index.ts` `agent.delete` / `agent.rename` (~700–830,
~2749–2775); `test/agents.test.ts`.

**Effort:** small.

## T2 — Agent and team changes reach every open TUI at once

**End state:** within about 2 seconds, with no TUI or server restart, in every
open TUI and every Location (not only the one where the change was made):
- disabling, enabling, creating, deleting or renaming an agent updates the
  agent switcher (`shift+tab`), the agent picker and the Team picker;
- creating a team, adding or removing members, and enabling or disabling a team
  updates the same three places and the Instructions tree. In particular, a team
  you just created and filled shows its members immediately, without toggling
  the team off and on;
- disabled agents never linger in `shift+tab`.

**Root-cause hints (verify, do not assume)**
- Bus events are Location-filtered (comment at `index.ts` ~5476). A change made
  from one Location reaches other Locations' Plus instances only when they next
  hit `refreshActiveModelsIfStale` on a session event.
- The TUI re-lists agents only on `agent.updated` for its own Location
  (`packages/client/src/solid/data.ts` ~1216).
- Team members are registered through `ctx.agent.transform` / `applyTeamAgent`
  (`installTeamAgents` in `instructions/teams-apply.ts`, `index.ts` ~4819,
  ~5330–5378). Check that adding a member to an existing or new team registers
  it without a re-enable.
- `tui/active-team.tsx` builds agent groups from enabled teams filtered by host
  agent ids (~87–91).
- All Locations run in one server process, so a process-wide notification of a
  shared-store revision change is a cheap seam. A file watcher is another.
  Choose the least load-bearing.

**Overlap:** the monitor plan rewrites the composer `Team` tab in
`tui/active-team.tsx`. Limit your edits there to the agent-group provider.

**Tests:** a Plus test with two Plus instances (two Locations) sharing one
global store: a change through one is applied by the other and publishes
`agent.updated` there. A team created, then filled, registers its members. TUI:
`shift+tab` cycles without the disabled agent. **Live:** two TUIs on two
directories; disable an agent in one and `shift+tab` in the other skips it
within 2 s; create a team and add members, and they show in the Team picker at
once.

**Effort:** medium.

## T3 — A model you add is active; tool activation works

**End state**
- Adding a model to any Models group (agent, member, preset, Defaults catalogue
  rows; TUI `a`, RPC `model.add`, tool `create kind:"model"`) makes it the
  active model at that level for that owner, exclusively. The previously active
  row at that level is no longer active. One store revision, one log line.
- `instructions.set({ id: <model row>, active: true })` (and a bare `set`) from
  a tool actor activates the model, and that model is then really used. The
  next request of that agent (as a stand-alone agent or as a team member,
  whichever chain the row belongs to) runs with it, the inspector shows it as
  active/effective, and `show` reports it.
- Reproduce the evidence case first: activating through the flat
  `model:global:Planner:…` row for an agent that exists only as a `Basic`
  member. Either that record must take effect for the member's chain, or the
  tool must answer with the member row to use (refusing the flat row with a
  message that names the right id). Pick one, make it consistent, and document
  it.

**Where:** `index.ts` `addModel` (~1640–1754), `removeModel`; `instructions/model.ts`;
`instructions/ops.ts` / `query.ts` (tool `set`/`create`); `teaching.ts`;
`test/model.test.ts`, `test/rpc.test.ts`.

**Effort:** small–medium.

## T4 — An agent's model applies without restarting the TUI

**End state**
- After a model is activated for an agent (Instructions TUI or tool), within
  about 2 seconds and without restarting anything:
  - the composer shows that model whenever that agent is selected, both in new
    chats and in open chats;
  - the next message sent with that agent uses it.
- Precedence is **newest wins**: an Instructions activation overrides earlier
  composer picks for that agent in every open chat. A composer pick made after
  the activation wins for that chat until the agent's model changes again.

**Root-cause hints**
- `packages/tui/src/context/local.tsx` remembers selections in
  `selectionBySessionAgent`, `newSessionModelByLocationAgent` and the durable
  `session.model` (`sessionSelection` ~330, `newSessionModel` ~276). These win
  over the agent's configured `model`, and nothing clears them when the agent's
  model changes.
- The prompt commits the composer selection with `switchModel` right before
  sending (`component/prompt/index.tsx` ~1280–1300). That overrides Plus's
  `applySessionModel` (`index.ts` ~5482), which runs only on `session.created`
  / `session.agent.selected`.
- T2's propagation must deliver the `agent.updated` this depends on.

**Tests:** a `packages/tui` test of the local model context: an `agent.updated`
whose agent's model changed replaces remembered selections for that agent, and
a later manual pick still wins. **Live:** open chat with agent X; activate a
different model for X in Instructions; the composer shows it, and the next
message's model (sidebar/usage) is it.

**Effort:** medium.

## T5 — Global and Project team members never leak into Defaults

**End state:** creating a team at Global or Project and adding members from
presets one by one writes only that team's files and team-scoped records. Those
members appear only under that level's team, and under levels that resolve
through it as today. They never appear under Defaults (Agents or Teams), and no
Defaults entry, overlay or record is written. This includes a team whose name
equals a shipped preset team's name in another case (`Basic` vs `basic`) or
the same case.

**Where:** `index.ts` `addTeamAgent` (~1326–1423: Defaults takes `createEntryRecord`,
Global/Project write a member file plus `setOwnerLink`), `team.create`
(~1090–1220), `instructions/tree.ts` (Defaults › Teams population),
`instructions/teams.ts`, `builtin-teams.ts`, the TUI add flow in
`tui/instructions/dialogs.tsx` / `route.tsx` (check which level the flow
passes). Reproduce first in a copied store.

**Tests:** `test/tree.test.ts` / `test/agents.test.ts`: a Global `Basic` team
with preset-linked members → no Defaults rows or records.

**Effort:** small–medium.

## T6 — Rename agents, team members and teams

**End state**
- In the Instructions tree, `R` on a renamable row prompts for the new name
  (prefilled, validated like creation) and renames it. Renamable rows are:
  Project/Global user agents, on-disk team members, and Project/Global teams.
  If `R` collides, choose another free key and update help and hints.
- Everything that names the renamed thing follows:
  - its file or team directory;
  - every stored record (customizations, splits, models, rules, links, warming
    rows, team-scoped records, `team_delegate` "Delegate to" rows naming a
    member, team enablement);
  - the tree selection.
- Session history keeps the old name.
- Not offered, and refused through the RPC/tools with a clear message: built-in
  OpenCode/Special agents, shipped Defaults teams and members, ancestor-backed
  agents, and rows of a `protectedAgents` agent for a tool actor.
- The palette command `plus.agent.rename` uses the same path.
- Tools: `instructions.set({ id, rename: "<new>" })` (or an equally plain
  shape) on agent, member and team rows. Documented in `teaching.ts`.

**Where:** `index.ts` `agent.rename` (~740–790, ~2749), `agents/files.ts`
`rename`, team storage (`instructions/teams.ts`, `teams-apply.ts`), `store.ts`
(record rewrite in one revision), `tui/instructions/route.tsx`, `dialogs.tsx`,
`help.tsx`, `tui/agents/create.tsx`; `rpc.ts` (`team.rename` and member rename
if needed).

**Tests:** rename an agent with records of every kind → records move and
resolution is unchanged; rename a team → members and records follow; refusals
for built-ins.

**Effort:** medium.

## T7 — Models lists are fast; an agent's Models uses the Defaults › Models layout

**End state**
- Opening Defaults › Models (and an agent's Models) shows its rows in under
  300 ms on repeat visits and under 1.5 s on the first open after a server
  start. Measure before and after in the live TUI and report the numbers.
  Navigating fetches no provider catalogue; the catalogue loads only for
  pickers, and is cached.
- Instructions → agent / member / preset → Models: each model row opens (`→` or
  Enter) into field rows in the same style as Defaults › Models:
  - `Model` (provider/model; Enter opens the catalogue picker);
  - `Effort` (variant; Enter opens a picker of that model's variants);
  - `Warming`;
  - `Ping every`;
  - `Keep-alive prompt`.
- Each field row shows its effective value and, when inherited, its source
  (`· every model`, `· defaults`, `· opencode.json`, `· global`, …). Enter edits
  only that field; `r` resets that field at this level.
- The model row keeps Space (activate, exclusive), `d`, `r` (clear active) and
  its `active` / `warm 2h` badges.
- The old whole-row editor dialog is removed.
- Tools: `set` on the field rows mirrors the Defaults › Models field rows.

**Where:** `instructions/model-settings.ts` (field-row ids/labels/values ~482–579),
`instructions/model.ts`, `instructions/tree.ts` (~707–735 Defaults › Models;
agent Models group), `instructions/discover.ts` `hostModelsOf` (~209, a
`ctx.model.list()` on every call), `index.ts` (~1290, ~5752),
`tui/instructions/route.tsx` (~887–907 Models owner handling), `dialogs.tsx`
(~132, ~164, ~745 `catalog.models`), `inspector.tsx`, `workspace.ts`,
`snapshot-cache.ts`. Profile first; fix the measured cause.

**Overlap:** T3 also touches model rows. Sequence T3 before T7 or have one child
own both.

**Tests:** `test/model-settings.test.ts`, `test/model.test.ts`,
`test/instructions-panes.test.tsx` for the field rows and edits.

**Effort:** medium–large.

## T8 — Your own categories

**End state**
- The list's categories today are Settings · Models · Compaction · Tools · Base
  · System · MCP. You can add your own categories after them.
  - `a` on the list offers **Category**; it asks for a name.
  - The new category tab appears for every owner (agents, members, presets,
    Defaults inventories) at every level.
  - `[ ]` cycles through user categories too, and number keys reach them.
- `m` on any item row moves it into one of your categories, through a picker:
  your categories, plus "back to <home category>". Item rows include a tool, a
  skill, a base template, a system instruction, an MCP server, a model
  candidate, a setting and a rule row.
- A moved row (with its children) then lists under that category instead of its
  home category, in every owner list where the row appears.
- Categories are display only: toggling, editing, inheritance and enforcement
  are unchanged. The inspector shows `category: <name> (home: <category>)`.
- On a user category:
  - `R` renames it;
  - `d` deletes it after confirmation, and its rows go back home;
  - an empty category says `No rows yet · m on a row moves it here`.
- Filter: `category:<name>`.
- Stored once, in the global store, as category records (name, order, the item
  ids it holds). Category records are revisioned and logged like other records,
  and all projects share them.
- Tools:
  - `instructions.create({ kind: "category", name })`;
  - `instructions.set({ id: <row id>, category: "<name>" | null })`;
  - `instructions.delete({ id: <category id>, confirm: true })`;
  - `list where:"category:<name>"`.
  Documented in `teaching.ts` and the skill text.

**Decisions (closed)**
- Assignments are keyed by item id, not per agent or level. One organisation
  applies everywhere.
- A user category cannot hold section rows or group rows. A row's children move
  with it.

**Where:** `instructions/store.ts` (new record kind; migration-free: absent
means none), `instructions/tree.ts`, `instructions/query.ts` / `ops.ts`,
`teaching.ts`, `rpc.ts` (snapshot carries categories),
`tui/instructions/route.tsx`, `workspace.ts`, `panels.ts`, `row.tsx`,
`inspector.tsx`, `help.tsx`.

**Tests:** `test/store.test.ts` (round trip), `test/tree.test.ts` (rows move,
children follow, delete returns them), a TUI test for `m` and the new tab, and
a tool test.

**Effort:** large.
