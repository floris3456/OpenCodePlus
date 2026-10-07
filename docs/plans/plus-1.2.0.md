# plus-1.2.0: Instructions folders, move, links and merge; chat model isolation; service handover; the 1.1.19 plan

Status: **requests, findings and decisions recorded (2026-10-08). The plan
itself (work packages, file ownership, order, checks) is still to be written.**

Base: `610ae2976e` (= tag `v2.0.18-plus-1.1.18`). Release line `plus-1.2.0`
(`worktrees/plus-1.2.0/opencode`, receives merges only). This plan is on
`plus-1.2.0_plan`. Release version `2.0.18-plus-1.2.0`.

1.2.0 = every request below **plus** the unbuilt 1.1.19 work from
`docs/plans/plus-1.1.18.md` sections 2–9 (WPs B, C, D, E, G) **plus** WP-F
(Monitor fingerprint store as deltas; the 1.1.18 release report promised it for
the next release). Decided by the user, 2026-10-08.

## Requests (user, 2026-10-08, on the installed 1.1.18)

1. Create categories that tools, models and system instructions can be placed
   in. Add sections to any description or instruction. Move any section,
   category or row around in the UI intuitively.
2. `a` on a section (System › Role/persona › orchestrator › Choosing a worker,
   and elsewhere) fails with `instruction.disabled: AGENTS.md handling …`. It
   must add a section inside the hovered section.
3. Changing the model or effort for an agent in one chat changes it in other
   chats with that agent, even across projects. Existing chats keep what they
   had. Project level seems not enforced.
4. The chat sometimes reloads quickly and the text twitches.
5. A move function in the Instructions TUI on any row or category (not the
   level tabs Project…Presets), staying within its own pane (left sidebar or
   middle pane).
6. Row review: there is no "take upstream"; the merged text shows raw
   `<<<<<<< yours … >>>>>>> upstream` markers; merging should offer
   include/exclude per changed sentence, and still allow typing.
7. Defaults › Models loads slowly. Cache the model list when Instructions
   opens; refresh every 5 minutes, or, with the CLIProxyAPI integration
   installed, whenever a new sync is pulled.
8. `<!-- requires: tool:subagent -->`: does the model see it when it has the
   tool? Make conditions user-, tool- and command-configurable: a link mode in
   the TUI (primary row, linked rows, a pop-up, "link another row"), and every
   Plus action runnable from bash.
9. After updating 1.1.16 → 1.1.17, `opencodeplus` failed with
   `ServiceRefusalError: Service version mismatch: running 2.0.18-plus-1.1.12,
   replacement refused` until `opencode service stop`.

## Findings (source at the base; paths under `packages/`)

Evidence and full traces: `run/evidence/plus-1.2.0/analysis/findings.md`
(workspace).

- **(2) `a` on a section.** Section rows have no `add`
  (`plus/src/instructions/tree.ts` `lazySection`), so `route.tsx` `add()` falls
  back to the tab's category; System's is `add: "instruction"`
  (`tree.ts` `lazySystem`) → `instruction.create`, refused by
  `INSTRUCTIONS_DISABLED = true` (`plus/src/index.ts`). `ops.addSection` only
  works on item rows, always appends at the end of the item, and turns a
  heading-derived item into a flat manual split. No nested section add exists.
- **(3) Model leak.** Core keeps a model per chat and never moves it
  (`core/src/session/runner/model.ts`). The TUI "T4" effect
  (`tui/src/context/local.tsx`, `configuredAgentModels`) reseeds **every
  chat's** selection, across all projects, when an agent's model changes; its
  test `tui/test/agent-model-refresh.test.tsx` asserts the reseed. Since
  models-pick, every `/models` pick, variant pick and Ctrl+T changes the
  agent's model, so each one rewrites other chats. The map is keyed by agent
  id only, so opening a chat in another project with a different agent model
  also counts as a change. `pickModelRow` (`plus/src/instructions/ops.ts`)
  writes Global when no Project row supplies the model.
  `applySessionModel` (`plus/src/index.ts`) also applies the agent's active
  model on `session.agent.selected`.
- **(1, 5) Categories and move.** User categories exist as global-only tabs
  (`plus/src/instructions/categories.ts`, `CategoryRecord {name, order,
  items}`), holding whole item rows; `m` opens "move to category"
  (`dialogs.tsx` `move`). Nothing can be reordered: tools/base/system sort by
  built-in order then title, sections by text offset, agents by origin then
  discovery order, teams alphabetically. Sections exist for tool, base, system
  and skill items only; MCP, model rows, agent and member descriptions have
  none. Manual sections are always flat.
- **(6) Review.** `resolve:"take"` (follow upstream) works in the API and
  state; the text review screen (`plus/src/tui/instructions/diff-pane.tsx`)
  only has `k` keep, `t` take merged (sends `take` only when the merge equals
  upstream), `e` edit. `merge3` (`plus/src/instructions/diff-lines.ts`) is an
  in-house line diff3 that flattens its result and writes the markers; a
  paragraph is one line, so any two edits in it conflict. The tools API
  `resolve` accepts `keep | take | edit`; `show({view:"diff"})` returns no
  merge proposal.
- **(7) Defaults › Models.** `state.hostCatalog` caches `ctx.model.list()`
  with no expiry. The cost is building every model's row (warming and effort
  resolution, review counts) in `lazyModelsSection`, repeated across
  `workspaceOf` passes. CPA's sync calls `ctx.provider.reload()` and core's
  models.dev refresh (5 min) does too; both publish a model-updated event that
  Plus's `RefreshEvents` does not listen to.
- **(8) `requires` markers.** For system rows (Role/persona, instruction
  files, Tools and rules) a met condition's marker is stripped before the
  model sees it (`model.ts` `stripMarkers`; `plus/test/requires.test.ts`
  asserts no `<!--` reaches the model). Markers in tool descriptions, skills
  and base prompts are neither evaluated nor stripped; no shipped text has one
  there today. Granularity is a heading section. No row-to-row link exists
  (only models and teams being exclusive). `l` = "Link to preset"; `L` is free.
  There is no bash command surface (`plus/bin/opencodeplus` refuses
  subcommands; `tools.instructions.*` run only in a chat).
- **(9) Service refusal.** `cli/src/services/service-config.ts` sets
  `replace: false` for Plus and `client/src/effect/service.ts` refuses any
  version mismatch (exact string match), unhandled. `install.sh` only stages
  a release; only `/update` (`cli/src/services/plus-update.ts`) waits for
  idle, stops and swaps the service. CLI commands other than the TUI ignore
  the version, so an old service survives updates.
- **(4) Chat twitch.** Not reproduced yet. Candidates: a reconnect
  invalidates every sync key and re-reduces the rows (`client/src/solid/data.ts`,
  `tui/src/routes/session/rows.ts`, `index.tsx` scroll restore); the T4 reseed
  and `session.model.selected` rows on agent or model changes.

- **(10) "Session failed" after a mid-chat Instructions change (regression in
  1.1.18, seen live 2026-10-07 23:43:54Z on the build seat's own chat).** The
  log shows `Failed to drain Session: TypeError: T.content.map is not a
  function` in `SessionModelRequest.prepare`. Plus's `context` hook
  (`plus/src/instructions/apply.ts`, the steered change note after
  `checkAndEmitChangeNote`, from `1025fe6960`) pushes
  `{ role: "user", content: noteText }`: string content, hidden by
  `as never`. Core's `unsupportedParts` (`core/src/session/model-request.ts`,
  `boundImages(unsupportedParts(shaped.messages, …))`, first in the 1.1.18 tag)
  maps `message.content` as an array. The first step after any change that
  emits a note fails; re-sending works because the note is not pushed again.
  Fix it properly: Plus pushes a real text part, and core checks hook-returned
  messages against the message schema at the hook boundary, so a plugin
  cannot crash the runner. Add a regression test for each.

## Decisions (user, 2026-10-08)

1. **Release.** Everything is 1.2.0: today's requests, the 1.1.19 plan
   (sections 2–9 of `plus-1.1.18.md`: WPs B, C, D, E, G) and WP-F.
2. **Agent switch inside a chat.** The chat remembers its own model per agent:
   switching to an agent uses what this chat last used for it, and the
   agent's active model only if this chat never used that agent.
3. **Existing chats never change** when an agent's model changes elsewhere (a
   pick, Ctrl+T, an Instructions activation, another project).
4. **A `/models` pick or Ctrl+T saves at the chat's Project level**, always.
   Other projects are never affected. (Amends the models-pick rule "the level
   that supplies the model, else Global".)
5. **Categories are folders inside a tab** (Tools, Models, System, …):
   collapsible, holding that tab's rows, nestable and movable.
6. **Order reaches the model only for sections.** Moving a section reorders
   the text sent (a prompt change like any edit). Tools, models, system files,
   folders, agents and teams: screen order only.
7. **Move = pick up, arrows, drop.** `m` picks the row up; ↑/↓ move it; →
   into a folder or section, ← out of it; Enter drops; Esc cancels. It stays in
   its own pane (left sidebar or middle pane); the level tabs (Project …
   Presets) do not move. Replaces today's `m` "move to category" dialog.
8. **Merge screen.** No text markers. Each changed sentence is a row to
   include or exclude (Space); `e` still opens the text to type; `u` takes
   upstream outright. Where yours and upstream changed the same sentence,
   **yours starts included** and upstream's is shown excluded and
   highlighted.
9. **Row links: a real switch.** Like model rows and teams: turning A on saves
   the linked row as off; it stays off until turned on.
10. **One system for links and "Shown when".** Link types per linked row:
    either on → the other off (default); primary on → this off (one-way: this
    row can be turned on without turning the primary off); shown only while
    the primary is on; shown only while it is off. Shipped `requires:`
    markers appear as upstream links. Links work on every row kind (so tool
    descriptions, skills and base prompts can be conditioned, and their
    markers no longer reach the model raw).
11. **Key `L`** starts and completes a row link; `l` stays "Link to preset".
    `L` on a row that already belongs to another primary's link names those
    primaries.
12. **Bash: a full CLI mirror.** `opencodeplus instructions
    list|show|set|reset|split|create|delete|log|link|move`, the same ids and
    grammar as `tools.instructions`, talking to the running service.
13. **Service of another version at startup: replace if idle, else ask.** No
    chat running: stop the old service (terminals handed over), start the new
    one, one-line notice. Chats running: ask "replace now / use the old one /
    quit".
14. **Chat twitch** is seen while a reply streams (minor) and after a model,
    agent or Instructions change (main case).
15. **Defaults › Models**: as requested (cache on opening Instructions;
    refresh on the model-updated event, which CPA's sync and the models.dev
    refresh both publish; 5 minutes as the fallback), and the rows memoized.

Assumptions recorded with the decisions (not contradicted by the user):

- `a` on a section adds a child section at the end of the hovered section.
- "Any description or instruction" means every text row, including MCP
  server and tool descriptions, tool parameter descriptions, agent and member
  descriptions, keep-alive prompts and compaction instructions.

16. **End to end, including the release.** The run tags, pushes and publishes
    1.2.0 itself (git push and `gh` were enabled for Simple-Build at Global on
    2026-10-08; force push stays off).
17. **GPT cache misses** (cliproxyapi/gpt-*) are investigated and fixed in
    1.2.0, first, by Heavy-Implementer.

## Open
- Existing global category tabs: how they become folders (proposal: one
  folder per tab its items belong to, same name).
- Where display order and folders are stored (proposal: global, like
  categories today; section order is text, per level like any edit).
