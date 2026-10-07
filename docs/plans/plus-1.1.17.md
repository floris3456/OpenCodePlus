# plus-1.1.17: instant Instructions writes, categories, and the 1.1.16 backlog

Base: `416eea926a` (= `v2.0.18-plus-1.1.16`). Integration branch `plus-1.1.17`
(worktree `worktrees/plus-1.1.17/opencode`). Every work package (WP) runs in its
own worktree `worktrees/p117-<wp>/opencode`, branch `p117-<wp>`, cut from the
integration branch; the build seat reviews and merges each one.

Scope (user, 2026-10-07): the four new requests below, plus every item of
`plus-1.1.16-team-fixes.md` (items 1–10). Worked autonomously: decisions are
made here from measured facts and recorded with their reason.

## Measured (2026-10-07, dev home with a copy of the real store: 329 records, 939 items, 12 agents)

Real server from this source, the TUI's own toggle path (`toggle()` from
`ops.ts`, records exactly as `persist` sends them) over `POST /api/rpc`:

- **One toggle, one location:** snapshot 60–80 ms (782 KB JSON), memo+toggle
  10–20 ms, `instructions.mutate` 250–315 ms. The mutate request carries the
  whole store (306 records, 183 KB) and answers with a whole snapshot.
- **The TUI then loads a second full snapshot** on its own
  `instructions.changed` event. A second quick toggle is computed against a
  stale revision and fails with "Revision changed … retry".
- **Fan-out:** every write wakes every loaded location (`notifySharedStoreChanged`
  → `refreshFromHost` → `publishFresh`), uncoalesced. With 7 locations, 10
  toggles cost **8.1 s of server CPU**, half of it a 4 s tail after the last
  reply, all on the one JS thread that also serves chats. The live service had
  ~50 locations loaded (1.1.16 plan item 4): seconds per change, minutes for
  30 agent changes — the reported 6-minute waits.
- **Profile of that burst** (9.05 s busy, inclusive, our packages):
  - Plus `discover` 44%: `permItems`/`mineDiscoveredRules` 19%,
    `readTransform` 16%.
  - Core tool registration 22%: every transform replay calls `editor.add` →
    `registrationError` → `ToolDefinition.make(definition(tool))` →
    `toJsonSchema` for every tool, every time (the browser plugin's ~45 tools
    alone 13%). Schemas never change.
  - Core `State.get` rebuilds 25%: each Plus publish installs and disposes
    ~10 registrations, each notifying separately (plugins have no batch).
  - Plus `apply` 23%: `resolveWhole`/`sectionOverrides` recomputed per agent
    and item from scratch.
  - Every publish also runs `agent.reload()`, `skill.reload()` and
    `mcp.reload()` even when that output did not change.

## Decisions

From the user (2026-10-07):
- **Followup to a working child** (item 8): delivered at the soonest moment
  that does not interrupt it — the next safe step boundary (`delivery:
  "steer"`), not the end of its turn.
- **A stopped run keeps warming** for one more warming window (item 8).
- **Mark 1.1.16 Latest:** done (`ocp-latest` run 37552862041).
- The 2026-09-29 follow-ups are dropped.

Made here:
- **Writes are deltas.** `instructions.mutate` accepts
  `{ changes: { upsert, remove }, snapshot?: boolean }` next to today's full
  `records` form (kept for compatibility). The server applies the delta to the
  *current* store under one write lock, so concurrent writers never get a stale
  refusal for unrelated rows; the same key last-writer-wins, as a single-user
  tool should. Reason: 183 KB per toggle and the stale-revision failure both
  disappear, and a queue can merge many edits into one write.
- **The TUI is optimistic.** A toggle, edit or group toggle changes the screen
  at once; a write queue merges pending edits into one delta per round trip,
  shows "Saving N…", and reverts with a message on refusal. Its own
  `instructions.changed` events (revision ≤ last confirmed) do not reload.
- **The writer publishes at once; other locations coalesce.** They refresh on
  a trailing quiet period (1 s), one after the other with a yield between, and
  a location with a refresh pending flushes it in Plus's session `prompt` hook,
  so no request ever runs on stale instructions.
- **A publish only replaces what changed.** Each apply part (roles, models,
  skills, session tools, enforcement, MCP, agent controls, team installs) has a
  plan fingerprint; an unchanged part keeps its registration and skips its
  reload. All registration changes of one publish run in one core batch
  (new plugin API `ctx.batch(effect)`, backed by `State.batch`).
- **Pure work is memoized process-wide** by content: tool JSON Schema per
  schema object (core), mined permission rules per tool text, resolution per
  (item fingerprint, records revision, scope).
- **Targets:** with 7 locations, 10 toggles ≤ 1.5 s total server CPU (from
  8.1 s), mutate ≤ 60 ms, no tail longer than the coalescing delay; the TUI
  shows a toggle in the next frame; 30 agent `instructions.set` calls finish in
  ≤ 10 s wall.
- **Browser category:** all `browser*` Code Mode namespaces move under one
  category **Browser**. The bare `browser` namespace (preview, navigate,
  click, read …) becomes **Pages**; the others keep their last segment (CPU,
  Files, Heap, Network, Tabs, Trace).
- **Every category toggles.** Space on a group row turns on or off its nearest
  toggleable rows (it does not descend past a toggleable row). All on → all
  off; otherwise → all on (tri-state, as in common UIs). The row shows on, off
  or `n/m`. Protected rows are skipped and named. One delta write. The agent
  tool takes the same op on a group id.
- **#29:** a new chat starts on the current agent's *active* model (picks are
  saved as the active model since 1.1.16), not the composer's leftover.
- **#31:** warming stops the window when the pinned agent is still missing on
  the next ping (two `AgentNotFoundError` in a row), with a core test.
- **Monitor › Cache:** newest first, in the cache tab only (the report keeps
  its chronological order for other consumers).

## Work packages

| WP | What | Model | Depends on |
|---|---|---|---|
| core-perf | Core: memoize tool JSON Schema per schema object; `ctx.batch` plugin API (effect and promise) over `State.batch` | gemini-3.8-flash-high | – |
| write-path | Plus: delta `instructions.mutate`, write lock, no reload-from-disk after save, snapshot only on request, server snapshot cache by revision + publish fingerprint, agent tools on deltas with one memo build | deepseek-v4.1-flash-cheap | – |
| publish | Plus: per-part plan fingerprints (replace only changed registrations, skip unchanged reloads), publish in `ctx.batch`, memoized mining/resolution, coalesced other-location refresh + `prompt`-hook flush | gemini-3.8-flash-high | core-perf (batch) |
| tui-queue | TUI optimistic write queue on deltas; skip own-event reloads | deepseek-v4.1-flash-cheap | write-path |
| categories | Browser parent category + rename; group toggle op (ops, TUI, agent tool) | muse-spark-1.3 | – (uses ops; persists via queue once merged) |
| teams-a | Items 1 (Briefs), 7 (moved chat), 10 #27 (E_NO_COMMIT) | deepseek-v4.1-flash-cheap | – |
| teams-b | Items 2 (budgets) and 8 (followup after stop, steer, warm/cold) | gemini-3.8-flash-high | – |
| small | Monitor cache order; #29 new chat model; #31 warming | muse-spark-1.3 | – |
| sections | Item 3 (sections are the one text; migration; "Full text") | gemini-3.8-flash-high | publish |
| params | Item 6 (Parameters section) | deepseek-v4.1-flash-cheap | sections |
| cache-safe | Item 5 (changes reach a running chat via core's instruction mechanism) | gemini-3.8-flash-high | publish, sections |
| service | Item 4 (load on first message, unload on stop, `/refresh` + tool, no per-folder watchers) | deepseek-v4.1-flash-cheap | publish |
| catalogue | Item 9 (no catalogue reads while navigating) | muse-spark-1.3 | publish |

Item details stay in `plus-1.1.16-team-fixes.md`; this plan overrides it only
where a decision above says so. Search stays on Plus's own server (item 4.6
remains on hold until item 6 has landed and been measured).

## Rules for every WP

- Own worktree and branch only; never touch another worktree, the shared
  service (:40375), `~/.config/opencodeplus`, or any process you did not start.
- Follow the repository `AGENTS.md` style guide. Focused tests from package
  directories, `bun typecheck` in each touched package, root `bun run check`
  before the final commit. No whole-suite runs.
- A failing-before control for each fixed behavior; test the real
  implementation, no mocks of the code under test.
- Live TUI checks: `pilotty spawn --name <run> opencodeplus-dev .` from the
  worktree, sessions killed afterwards. Evidence in
  `run/evidence/plus-1.1.17/<wp>/` (report + `checks/`), no secrets.
- Local conventional commits; no push.

## Acceptance (build seat, on the integrated branch)

- The burst benchmark (`run/plus-dev/worktrees-plus-1.1.17-opencode/tmp/`)
  meets the targets above; profile again.
- All 12 `release/checks.json` gates, each WP's focused tests, root check.
- Live TUI: toggling 20 rows quickly shows each at once, the queue drains, a
  chat sent mid-queue runs on the new settings; group toggles; Browser
  category; Monitor cache order.
- Release 1.1.17 through `opencodeplus-release`.
