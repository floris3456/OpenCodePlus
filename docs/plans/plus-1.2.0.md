# plus-1.2.0: Instructions folders, move, links and merge; chat model isolation; service handover; the 1.1.19 plan

Status: **in progress (amended 2026-10-08 afternoon).** Requests, findings and
the user's decisions first; then the build seat's decisions (B1…), the design
per area, the lanes and work packages with file ownership and order, checks,
acceptance and the release. The amendment adds findings 11–14 (from the night
run and the 12:28 worker crash), decisions B21–B25, lanes `delegated-asks`,
`change-notes`, `prepare-hang` and `team-context`, package I3 and acceptance
13–16.

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
  **Done (N1, merged).**

Added 2026-10-08 afternoon, after the night run:

- **(11) Delegated runs hang on a permission ask.** A delegated run that
  touches a path outside its worktree (a dev home under `run/plus-dev`,
  another worktree) gets an external_directory ask that nobody answers,
  although Plus's "Outside this checkout (external_directory)" row is meant to
  refuse it; the run waits for ever. Each of the four night orchestrators lost
  20–30 minutes this way, and the H2 reproduction (T154) never ran. The first
  fix attempt (T151) crashed on finding 10 at its second step; the cause is
  still unknown. It blocks every live test a worker runs in a dev home.
- **(12) Change notes: four defects behind finding 10.** Traced on the
  installed 1.1.18 (built from `610ae29`; log
  `~/.local/share/opencodeplus/log/opencode.log`). Finding 10's crash happened
  four times: 2026-10-07 23:45 (a build-seat step), 23:56 and 23:57 (cache
  warming pings of two other sessions; warming runs the same hook), and
  2026-10-08 12:28:07.720Z (a Haiku-Worker's second step, 2 s after its first
  finished). The retry succeeded because the note is marked sent before it is
  returned, and the synthetic path had already delivered it. N1 fixed the
  crash: the push is now a text part, and core decodes every hook message,
  normalizing string content. Still open, in `plus/src/instructions/cache-safe.ts`
  and `apply.ts`:
  - (a) **Notes about other agents.** `handlePromptBoundary` loops over every
    agent in `currentPlanSet.roles` and emits a note for each one, so a chat
    receives other agents' role changes. The Haiku-Worker got the build seat's
    role ("# Delegating … # Build seat", message seq 33) and began its next
    reasoning with "I notice the role text has shifted"; the same day a
    Simple-Build chat got Simple-Orchestrator's Ownership and Agent Routing.
  - (b) **A spurious role note at the start.** `computeChangeNote` reports
    "Role text replaces the earlier text" whenever the pinned role was empty
    and the current one is not. The worker's note (seq 32, "# Team member …
    # Implementer") came with no Instructions edit between 12:14:26 and the
    crash: its role was most likely missing when the pin was taken at its
    first request, and filled in 2 s later.
  - (c) **Each note is delivered twice.** `checkAndEmitChangeNote` admits it
    as a synthetic steer message, and `apply.ts` (the per-request hook) also
    pushes it into the current request.
  - (d) **Shadowed edits are silent.** A `set` on a subsection that a
    whole-section customization shadows (Simple-Build › `build-seat`, from
    2026-10-07) saves, but never reaches the assembled prompt, and the result
    does not say so.
- **(13) A step can hang before it starts.** 2026-10-08 02:50:03: the build
  seat's chat (`ses_ee7753a4dffeqLkq8g52fTNTXr`) finished a tool call; its
  next step never started and never failed, and the chat showed "working" for
  hours. The hang is in request preparation (`core/src/session/prompt.ts`
  `SessionPrompt.prepare`, plugin hooks included). The exact line is
  unproven, and the process is gone (evidence: the workspace's
  `run/plus/data/opencodeplus/log/opencode.log`).
- **(14) A child's context size is invisible.** The team token budget
  (`plus/src/teams/schema.ts`) leaves out cache reads, so `team_status` shows
  no context size. Night orchestrators grew to 230–270k unnoticed, and core
  compacts only near the model's limit.

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

## Decisions by the build seat (2026-10-08, autonomous)

Weighed for the user (intuitive, consistent with the TUI), the agent (what the
model receives, the prompt cache) and the system (speed, little load-bearing
behaviour). Each has its reason.

Structure and storage

- **B1. Category tabs become folders** of the same name, one in each tab that
  holds one of its rows; an empty category becomes an empty folder in Tools.
  The tabs go away. Reason: nothing the user made is lost, and it lands where
  its rows already live.
- **B2. Folders and display order are global and agent-independent**, keyed
  by tab kind and item id, like categories today. Reason: tools and system
  files share ids across agents; arranging once is what a user expects;
  per-agent layouts multiply work for no gain to the model (display only).
- **B3. Section order is text.** Moving a section rewrites the item's text at
  the level being edited, like any edit (decision 6). A section moves only
  inside its own item. Reason: a cross-item move would change two prompts and
  blur ownership.
- **B4. One store record per concept, migrated at load** like the existing
  `migrate*` passes: `folder` (tab, id, name, parent, order, items) and
  `order` (scope, items) replace `category`; `rowlink` holds every link type,
  and a customization's `requires` list migrates into `rowlink` records.
  Reason: one source of truth per concept; no dual read paths.
- **B5. No folders in the left sidebar.** Agents, teams and members can be
  reordered there (display only). Reason: they are already grouped; folders
  were asked for inside tabs (decision 5).

Sections

- **B6. Heading-derived texts stay heading-derived.** `a` on a section
  inserts a heading one level deeper at the end of that section, so the split
  is still derived from the text; manual splits gain an optional depth for
  nesting. Today's flattening of a heading-derived item into a manual split
  goes. Reason: the text the model reads carries the structure; no hidden
  offsets to drift.
- **B7. Sections on every text row** (assumption 2): MCP server and tool
  descriptions, tool parameter descriptions, agent and member descriptions,
  keep-alive prompts, compaction instructions. Each kind assembles through the
  same section path as tools and system rows.

Move mode

- **B8. `m` picks up, ↑/↓ move, → enters the folder or section below, ←
  leaves it, Enter drops (one write), Esc restores.** The row shows a "moving"
  marker and the footer names the keys. Rows that cannot move (level tabs,
  group rows of built-in structure, protected rows) say why on `m`. In the
  cold-cache model list `m` is the same mode and changes the try order.

Links

- **B9. Link types:** `either` (default: turning one on saves the other off),
  `oneway` (primary on saves this off; this on leaves the primary alone),
  `shownWhenOn`, `shownWhenOff` (the "Shown when" gates). Switch types act at
  write time in the same save (like exclusive models and teams), so a request
  never evaluates them. Gates act when the request is built, as `requires`
  does today, for every text kind.
- **B10. No cascade.** A switch acts one hop: turning A on turns its linked
  rows off, and their own links do not fire. Reason: predictable, no loops.
- **B11. Links belong to an owner and a level** (agent or member, or none for
  every agent at Defaults) and inherit down the chain like other records.
  Shipped markers show as upstream links; a user can turn an upstream link off
  at a level with a tombstone (as model rows do).
- **B12. Markers never reach the model raw**: gates are evaluated and every
  marker is stripped for every text kind (tool descriptions, skills, base
  prompts, parameters, MCP), not only system rows.

Merge

- **B13. Sentence rows.** Units: a heading, a list item, a table row, a fenced
  block (atomic), and the sentences of a prose paragraph. Defaults: changes
  only yours → included; only upstream → included; both changed the same unit
  → yours included, upstream shown excluded and highlighted (decision 8);
  identical changes → one row. Keys: Space include/exclude, `k` keep yours,
  `u` take upstream, `t` save the merge as shown, `e` edit the merged text.
  A merge equal to upstream is saved as "take" (follow upstream).
- **B14. The tools API carries the proposal**: `show({view:"diff"})` returns
  the units with ids and defaults; `set({resolve:"merge", include:[ids]})`
  saves a choice; `take | keep | edit` stay.

Chat models

- **B15. A chat's model memory per agent comes from its own history** (the
  last assistant message of that agent), not a new store. Reason: core
  already records it; nothing to migrate or keep in sync.
- **B16. The TUI's new-chat default** follows the agent's active model for the
  current project (keyed by location and agent); it never rewrites an
  existing chat. The T4 test is rewritten to assert this.

Service and CLI

- **B17. Replacing an idle service reuses `/update`'s stop path** (terminals
  handed over). With chats running, the prompt comes before the TUI takes the
  screen: "Replace now (running chats pause and resume after the restart) /
  Use the old one / Quit". Use the old one connects with a warning, as an
  explicit `--server` does. Without a terminal: never replace a busy service.
- **B18. The bash CLI calls the same functions as `tools.instructions`**
  through one Plus RPC (`instructions.tool`), so the grammar, ids, refusals
  and log are identical; the log records the actor as `cli`. Output is the
  tool's JSON; exit 1 on a refusal (message on stderr), 2 on usage errors.
  Text comes from `--text`, `--text-file` or stdin (`-`). An old service
  without the RPC gets a clear "replace the service" error.

Runtime

- **B19. A malformed plugin message never fails a step** (finding 10): core
  normalizes string content to a text part and drops anything else that does
  not decode, with a warning naming the hook.
- **B20. `plus/src/index.ts` (7,000 lines) is shared by region**: lanes may
  edit the functions they name in it; new logic goes into new modules with a
  wiring line in `index.ts`. Every other hot file has one owner at a time
  (below). Reason: a file lock on `index.ts` would serialize the release.

Added 2026-10-08 afternoon (findings 11–14)

- **B21. A change note is about the chat's own agent, and arrives once.**
  The prompt boundary checks only the agent running in the session. An empty
  pinned role (taken before roles were filled in) is re-pinned silently, not
  announced. The synthetic steer message is the one delivery: it is durable,
  in history and cache-stable. The push in `apply.ts` goes. Reason: every
  note the model sees should be a real change to its own prompt.
- **B22. A delegated run never waits on a permission ask.** On top of the
  cause fix for finding 11, the teams layer refuses any ask in a delegated
  run at once and audits it. Reason: nobody is there to answer, and a wait
  costs the whole run.
- **B23. Request preparation has a bound.** Past it, the step fails with an
  error naming the stage or hook, instead of hanging. Choose the bound from
  measured preparation times, with a wide margin. Reason: a silent hang is
  worse than a failed step, which the user or parent can resend.
- **B24. The parent hears about a child's context.** One message when a
  child's context passes 100k tokens, like the budget notices, and
  `team_status` shows each child's context size. No forced compaction:
  compacting mid-task loses the details the worker is using.

Added 2026-10-08 evening (build seat, continuing the run)

- **B26. Finding 11's cause, and where the refusal sits.** The row "Outside
  this checkout (external_directory)" installs a core rule only when it is
  off (deny). On, it installs nothing, and core's built-in answer for an
  unmatched `external_directory` is **ask**. The Orchestrator and Planner
  presets (and members made from them) leave it on; only the worker presets
  (`inside`) turn it off. So a delegated orchestrator that reads a dev home
  asks, and nobody answers. Fix in two layers: (1) Plus's permission
  `evaluate` hook (`permission-enforce.ts`) turns any remaining `ask` in a
  delegated run (`deps.headless`) into `deny` before the ask is published,
  with a message that names the action and resource and says nobody answers
  asks in a delegated run, and records the refusal in the run's audit;
  (2) the B22 net in the teams layer: a `permission.asked` event for a
  delegated run's session (an ask raised by any other path) is rejected at
  once and audited. A top-level chat, and a subagent of the user's chat,
  still ask as before. The presets are not changed: an interactive
  orchestrator may still be asked.
- **B27. Change notes (X4), the details of B21.** The prompt boundary reads
  the session's own agent from the session (`ctx.session.get`) and checks
  only that agent. An empty pinned role is replaced in the pin by the current
  one without a note (its next request carries the role in the system prompt:
  one prefix change, not a note). The steered synthetic message is the only
  delivery; a change found while preparing a request mid-turn arrives at the
  next step boundary, not in the request being prepared. A warming ping may
  admit the note (it is durable and outside the cached prefix). An adopted
  role also drops the pinned system prompt for that agent, so the next request
  carries the role (one prefix change).
- **B28. GPT cache (G1 result, G2 fix).** G1
  (`run/evidence/plus-1.2.0/gpt-cache/G1-report.md`): GPT steps keep their
  prefix (1 lost of 1,359 eligible steps; Gemini loses 37%, provider-side).
  GPT's misses are summary compactions: 10 on 2026-10-05 sent 2.0M uncached
  tokens, because the summary request is not the chat's request plus one
  message. Core gives it the compaction agent's system prompt and runs the
  `compaction` content hook, where Plus applies none of its `context`
  shaping (pinned system prompt, tool plans, instruction parts, scrub,
  narrowing); every other plugin already mirrors its `context` transform on
  `compaction`. Fix, for a summary compaction **on the chat's own model**
  (same provider, model and variant): (G2a, core `compaction.ts`) the request
  keeps the chat agent's system prompt, and the compaction system text (the
  agent's compaction system, else the compaction agent's) moves into the
  final user message ahead of the summary prompt; (G2b, Plus `apply.ts`,
  `index.ts` compaction hook) Plus's `compaction` hook applies the same
  shaping as its `context` hook from the session's pin, without notes or
  moving the pin, then marks the rebuild as today. Another model compacting:
  unchanged. Proof: the compaction request's system parts, tools and history
  equal the previous step's up to the summary message (fingerprints), and a
  live same-model compaction reads the history from cache (acceptance 2).
- **B29. The preparation bound (X2) is 120 s.** Measured (Monitor ledger,
  13,872 steps, step start to request sent): p50 6 ms, p99 68 ms. The 21
  cases above 10 s are all CPA quota-retry waits (about 362 s each) before
  the one recorded attempt, not preparation. 120 s is over 1,000× p99 and
  still ends a silent hang. The bound covers request preparation only, never
  provider retries, the summary request or the stream. The step fails with an
  error naming the stage, and the hook and its plugin when a hook was
  running; the chat takes the next message.
  Amended after X2's first commit (`f9d3fcc0a4`), which bounded only the
  request's content hooks: finding 13's step "never started", so the hang
  can sit anywhere between the end of the tool call and the step start.
  Each preparation stage of a step is bounded on its own at 120 s: loading
  the context (`context.select`/`load`, the `session.catalog` hook), the
  compaction decision (`compaction.decide` only, never the summary it
  arms), and the request's content hooks (`session.context`,
  `model.request`). Prompt admission (`SessionPrompt.prepare`, the
  `session.prompt` hook) is not a step: a hang there leaves the prompt
  unadmitted, not a chat "working" for hours, so it is out of X2.
- **B30. WP-B (C2) details, `compaction.decide` overrides.** As
  `plus-1.1.18.md` §2 and §7, made exact: `strategy` replaces the agent's
  compaction strategy for this compaction (a portable decision with
  `remote`, from either side, is still refused); `system` replaces the
  agent's compaction system text (on the chat's own model it travels in the
  final user message, B28); `compactionFallbacks`, when present, is the whole
  fallback list and replaces `compactionFallback`, which otherwise means a
  list of one; each model that fails is recorded as its own failed
  compaction (auto) before the next is tried, as the single fallback is
  today. `optional: true`, when every model failed, returns `skipped` for an
  `auto` trigger, so the step runs uncompacted; `manual` and `overflow`
  ignore it (a manual compaction reports its failure; an overflow cannot
  continue uncompacted). A failed compaction records the model that tried
  it (`model` on the failed message, as on the completed one): the
  summarizing model for a summary, the chat's model for native.
- **B31. I1 split in two, and how `a` writes (B6 made exact).** I1a: `a`
  on a section and nesting; I1b: sections on every text kind (B7). `a` on a
  section of a **heading-derived** item writes a heading one level deeper
  (`#` × (section depth + 1), at least `##`) with the new text at the end of
  the hovered section's span (after its last descendant). The write is an
  edit of the **last leaf section inside that span** (the hovered section
  itself when it has no children), at the level being edited, so no parent
  or whole-item customization is created that would shadow its children
  (finding 12d). `a` on a heading-derived item row appends a heading at the
  item's top heading depth at the end of the text, the same way. The item
  stays heading-derived; the new section appears as a child row at once.
  For a **manual** split (and `block`/`whole` items, which become manual as
  today), boundaries gain an optional `depth` (absent = 0; old stores read
  unchanged); `a` on a manual section inserts the text at the end of its
  span and adds a boundary with depth + 1, shifting later boundaries. Section
  rows get `add: "section"`, so `route.tsx` never falls back to the tab's
  category from a section. The tools API: `split({ id: <section id>, add })`
  adds a child of that section, `split({ id: <item id>, add })` a top-level
  one (today's call, now heading-preserving).
- **B32. I2 (WP-D) in three parts, one after another in the instructions
  lane** (all edit `tree.ts`): I2a the model row layout of `plus-1.1.18.md`
  §2 (Model, Effort, Warming ▸ with Compact before cold and the cold-model
  list, Compaction ▸ Strategy/Model/Instructions) for agent, member, preset
  and Defaults › Models rows, writing C1's fields; the Compaction tab goes
  and the agent tabs renumber; the list takes `a` (catalogue picker), `d`,
  and `m` with B8's keys (↑/↓, Enter drops, Esc restores), which S1 later
  generalizes to every row. I2b the dropdowns of §6 (Ping every, Warming,
  Defaults › Models Effort, Compaction › Model with Inherit; Custom… keeps
  today's prompt). I2c Defaults › Models speed (decision 15): `hostCatalog`
  expires after 5 min and drops on the model-updated event (added to
  `RefreshEvents`), model rows memoized per (catalogue revision, store
  revision). The footer text and `/compact-cold` belong to C3, which owns
  cold detection.
- **B33. WP-G (G4, the cache-miss toast), where it lives.** As
  `plus-1.1.18.md` §9. The TUI asks, the server answers: when a step of the
  chat on screen ends (an assistant message with usage, from the client's
  sync data), the Plus TUI calls a new RPC `monitor.step({ sessionID })`,
  which folds only that session's new rows incrementally (WP-A's cached
  fold) and returns the latest step's verdict, tokens not reused and cause.
  No timer, no polling while idle; if the step's row is not recorded yet the
  RPC says `pending` and the TUI asks once more on the next session event.
  The toast (warning variant): "Cache miss · N tokens not reused · <cause> ·
  type /monitor for details", once per step, only when `isMiss` holds (a
  drop under 1,024 tokens is rounding). Cause words map the Monitor's cause
  chain (after compaction (expected), model switched, agent switched, prompt
  changed · <first changed part>, cache expired, account changed, unknown);
  a compaction armed by a CPA account switch (`quota.switch` metadata) makes
  the cause "account changed · compacted first", in the toast and in
  `/monitor` alike. Off switch: a TUI preference (default on), toggled from
  the command palette ("Cache-miss notices: turn off/on") and the slash
  command `/miss-notices`; it hides the toast only, the Monitor is
  unchanged.
- **B34. C3 (WP-C runtime) in three parts.** C3a, Plus's
  `compaction.decide` (a new module, one wiring line in `index.ts`
  replacing today's inline hook): resolve the C1 fields for (the event's
  agent, the chat's model) with `resolveModelCompactionFields` and set
  `strategy`, `compactionModel` and `system` when a level sets them; cold
  arming per `plus-1.1.18.md` §4 (first step of a new prompt, cold = the
  warming window ended, else idle longer than the Monitor's `cacheLifetime`,
  unknown never cold, running never cold, compacted since the last request
  skipped) sets `compact`, `portable`, `compactionModel` = #1,
  `compactionFallbacks` = #2…, `optional`; a CPA `quota.switch` decision
  takes the chat model's list when it is not empty (Plus's hook runs after
  CPA's, tested); the team `compactWith` arming keeps priority. CPA's
  "Compacting with X (fallback Y) first" notice is built from the final
  decision, so it names the armed models. C3b, the per-chat switch and the
  footer: `compactWarm` gives the model default; the chat switch becomes
  on/off/default (`compact.json` entries read as on), `<leader>j` and
  `/compact-warm` flip the effective value, "follow the model settings"
  resets both switches, and the footer and `warming.status` name the source
  ("· model setting" / "· this chat") and the cold arming ("cache cold ·
  compacts with <model> first"). C3c, `compaction.cold({ sessionID })` RPC,
  `/compact-cold` with its palette entry and toasts (§5), and the team
  followup default (a stopped cold child without `compactWith` uses its
  model's list; refuses with `E_STOPPED` when empty).
- **B25. A shadowed `set` says so.** A write to a section that a
  customization of its parent hides returns a notice naming that row, in the
  tool, the TUI and the CLI alike.

## Design notes per area

- **`a` on a section** (finding 2): section rows get their own add action
  (child section, B6); the category fallback to `instruction.create` is never
  reached from a section.
- **Model leak** (finding 3, decisions 2–4, B15–B16): the T4 effect only
  updates the new-chat default; `applySessionModel` on an agent switch uses the
  chat's last model for that agent, else the agent's active model for the
  chat's project; `pickModelRow` always writes the chat's Project level.
- **Defaults › Models** (finding 7, decision 15): `hostCatalog` gets an expiry
  (5 min) and is dropped on the model-updated event (added to
  `RefreshEvents`); model rows are memoized per (catalogue revision, store
  revision) so `workspaceOf` passes reuse them.
- **Twitch** (finding 4, decision 14): reproduce live first (a streaming reply,
  then a model and an agent change, then an Instructions edit) with frame
  captures; fix the causes found. Expected: reconnect resync must not clear
  and re-reduce the rows; T4's reseed goes with B16.
- **1.1.19 work**: as written in `plus-1.1.18.md` sections 2–9, with its
  cache-safety rule. Section 7's TUI line ("every compaction line names its
  model") is in `tui/src/routes/session/index.tsx`, so it moves to the chat
  lane, which owns that file.

## Lanes and work packages

Purpose branches `plus-1.2.0_<lane>` cut from `plus-1.2.0`; each lane merges
`plus-1.2.0` before it starts a package that depends on another lane.

| Lane (branch) | Who | Packages, in order | Starts |
| --- | --- | --- | --- |
| `note-crash` | Flash-C-Worker | N1 finding 10, both sides, tests. **Done, merged.** | now |
| `gpt-cache` | Orchestrator → Heavy-Worker | G1 investigate, G2 fix, G3 before/after; then WP-G (miss toast) and WP-F (Monitor deltas). The night's G1 reading was never written down: redo it, and write findings to `run/evidence/plus-1.2.0/gpt-cache/` as you go. | now |
| `compaction` | Orchestrator | C1 = WP-C data (store fields, validation, resolution in `model-settings.ts`); C2 = WP-B (core); C3 = WP-C runtime (decide hook, cold detection and arming, per-chat compact switch, CPA notice, `compaction.cold` RPC, `/compact-cold`, team followup default). C1 is committed, not landed: `0c2c35f586` on `team/Simple-Orchestrator/t1450368-20261008-0204`; review it against C1. | now |
| `instructions` | Orchestrator | I0 `pickModelRow` → Project; I1 sections (`a`, nesting, every text kind); I2 = WP-D model rows, dropdowns, Compaction tab removed, Defaults › Models cache and memo (after C1); I3 = B25 shadowed `set` notice (finding 12d) | now |
| `structure` | Orchestrator | S1 folders and move; S2 links; S3 merge UI; S4 = WP-E docs, ids, teaching, skill, help for everything new | after `instructions` lands |
| `merge-engine` | Flash-C-Worker | M1 sentence merge in `diff-lines.ts` (structured result, B13), tests. **Done, merged** (`a9fab156a9`). | when a slot frees |
| `chat-models` | Orchestrator | H1 T4 and per-chat model memory; H2 twitch; H3 compaction line names its model. H1 and H3 are committed, not landed: 4 commits on `team/Simple-Orchestrator/t147b4d7-20261008-0204` (`f8e30b1c84`, `a11c3c7c41`, `34084e6b17`, `cbf848c8bc`). H2 needs a dev home: after `delegated-asks`. | now |
| `service` | Flash-C-Worker | V1 replace if idle, else ask (B17), tests. **Done, merged.** | when a slot frees |
| `cli` | Orchestrator or worker | L1 `instructions.tool` RPC and `opencodeplus instructions …` (B18). Part 1 is committed on `plus-1.2.0_cli` (`30288da1f6`, `b83095bae3`). Open points: map entries in `cli/src/plus.ts`; the RpcHandlers wiring at `plus/src/index.ts:3266`; argv interception before dispatch, because Effect CLI rejects unknown flags and intercepts `--help`. | after S2 lands (link, move exist) |
| `delegated-asks` | Flash-C-Worker, Haiku-Worker | X1 = finding 11: the cause with a failing test, the fix, the B22 safety net, tests | now, first |
| `change-notes` | Flash-C-Worker, Haiku-Worker | X4 = finding 12 a–c, B21, a regression test for each | now |
| `prepare-hang` | Orchestrator → Heavy-Worker | X2 = finding 13: reproduce in a dev home, the B23 bound, tests | now |
| `team-context` | Flash-C-Worker, Haiku-Worker | X3 = finding 14, B24, tests | after `delegated-asks` lands |

### Hot-file owners (one at a time)

| File (`packages/…`) | Owner, in order |
| --- | --- |
| `plus/src/instructions/tree.ts`, `tui/instructions/route.tsx`, `dialogs.tsx`, `state.ts`, `help.tsx`, `workspace.ts` | instructions → structure |
| `plus/src/instructions/ops.ts`, `model.ts`, `sections.ts`, `requires.ts`, `categories.ts`, `tools.ts`, `teaching.ts` | instructions → structure |
| `plus/src/instructions/apply.ts`, `cache-safe.ts` | change-notes → instructions → structure (gpt-cache only by arrangement with the build seat) |
| `core/src/permission.ts`, `core/src/permission/*`, `core/src/file-access.ts`, `core/src/plugin/agent.ts`, `plus/src/instructions/permission-enforce.ts`, `permission-catalog.ts` | delegated-asks |
| `plus/src/teams/*` | delegated-asks → team-context |
| `core/src/session/prompt.ts` | prepare-hang (plugin hook types by arrangement with compaction) |
| `plus/src/instructions/store.ts`, `model-settings.ts` | compaction (C1) → instructions → structure |
| `plus/src/instructions/diff-lines.ts` | merge-engine → structure |
| `plus/src/tui/instructions/diff-pane.tsx` | structure |
| `tui/src/context/local.tsx`, `tui/src/routes/session/*`, `client/src/solid/*` | chat-models |
| `core/src/session/model-request.ts` | note-crash → gpt-cache |
| `core/src/session/compaction*.ts`, plugin hook types | compaction |
| `cliproxyapi/src/quota/*` | compaction (gpt-cache does not edit it) |
| `cliproxyapi/src/*` (rest), `ai/src/*` | gpt-cache |
| `plus/src/monitor/*` | gpt-cache |
| `cli/src/services/*`, `client/src/effect/service.ts`, `client/src/promise/service.ts` | service |
| `plus/bin/opencodeplus`, `cli/src/commands/*` (new command) | cli |
| `plus/src/index.ts`, `plus/src/rpc.ts` | shared by named region (B20) |

## Checks

- Per package: the focused tests it adds or touches, `bun typecheck` in each
  touched package, then `bun run check` at the repo root before the lane is
  merged. Tests run from package directories only.
- The build seat reads each diff, merges the lane into `plus-1.2.0`, and runs
  the lane's focused tests there.

## Acceptance (live, dev home only: `pilotty spawn --name <run> opencodeplus-dev .`)

TUI changes at a narrow (100×30) and a wide (200×50) size. One pass per area
at the end; fix and retest only what fails. Evidence:
`run/evidence/plus-1.2.0/acceptance/`.

1. **Crash:** an Instructions edit mid-turn; the next step runs (no "Session
   failed").
2. **GPT cache:** the before/after per-step miss rate on the same script.
3. **Sections:** `a` on System › Role › … › a section adds a child section; a
   heading-derived item stays heading-derived; an MCP description and a tool
   parameter take a section.
4. **Folders and move:** make a folder in Tools, move rows in and out, reorder,
   nest; reorder the sidebar; move a section (the request text changes order);
   Esc restores; old category tabs appear as folders.
5. **Links:** `L` from row A to row B, either type: A on saves B off; one-way;
   a gate hides a tool-description section from the model; a shipped marker
   shows as an upstream link; no marker reaches the provider (captured body).
6. **Merge:** a row with both-sides changes shows sentence rows with the
   defaults of B13; Space, `u`, `k`, `t`, `e` work; the saved text is right.
7. **Chat models:** two chats on one agent in two projects; a `/models` pick in
   one changes neither the other chat nor the other project, and saves at its
   Project level; an agent switch in a chat returns to that chat's last model
   for the agent.
8. **Twitch:** frame captures while a reply streams across a model change show
   no full redraw or jump.
9. **Defaults › Models:** opens fast the second time; a model-updated event
   refreshes it.
10. **Service:** an older service with no chats is replaced with a notice; with
    a chat running, the prompt appears; Use the old one connects.
11. **CLI:** `opencodeplus instructions list/show/set/link/move` against the
    dev service, matching the tool's results and log.
12. **1.1.19 items:** acceptance 2–8 and 10 of `plus-1.1.18.md`.
13. **Delegated asks:** a worker in a dev-home test touches a path outside its
    worktree; it is refused at once (audited) and the run goes on.
14. **Change notes:**
    - an edit to agent A's row while a chat of agent B runs sends B no note;
    - an edit to B's row gives B exactly one note, seen once, and its next
      step runs;
    - a fresh worker gets no role note at its second step;
    - a `set` on a shadowed section names the shadowing row.
15. **Preparation bound:** a test hook that never returns fails the step
    within the bound, with an error that names it; the chat takes the next
    message.
16. **Child context:** a child passing 100k context sends its parent one
    message; `team_status` shows each child's context size.

## Release

Load the release procedure (`config/skills/opencodeplus-release/SKILL.md` in
the workspace, `docs/releases.md`, the operator guide and contracts) and
follow it: gates and a local native build at the final `plus-1.2.0` commit,
annotated tag `v2.0.18-plus-1.2.0`, push branch and tag, the tag's
`ocp-build` run, `ocp-release.yml` with approval, then qualification of the
published bytes in an owned isolated prefix. The shared service on 40375 is
never touched; the user runs `/update`.
