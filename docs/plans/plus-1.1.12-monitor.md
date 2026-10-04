# plus-1.1.12 — Monitor: one page for tokens, cache and tools, plus tree-scoped tabs

**Objective:** replace the Tools monitor with one intuitive Monitor page that
covers every chat metric: reasoning, cache reads and writes, input, output,
cost, steps and tools with their token attribution. It puts heavy emphasis on
cache misses: each miss is detected, its cause named (or honestly marked
unknown), and enough evidence is recorded that an agent can work out the cause
from the data. The page opens on the current session and is one key away from
the whole team tree, a team, the project or everything. The composer `Team` and
`Tools` tabs default to the current team tree.

Release: `plus-1.1.13` (moved from `plus-1.1.12` on 2026-10-04; how to
resume it: `plus-1.1.13-team-fixes.md`). This was one of three plans run in
parallel:
`plus-1.1.12-session-runtime.md`, `plus-1.1.12-instructions.md`,
`plus-1.1.12-monitor.md` (this). Overlap zones are named under each task.

## Working rules (binding for the orchestrator and every member)

1. **The end states are the contract; the implementation is yours.** A
   different file, seam, schema or layout detail is fine as long as every
   end-state line holds and the change carries the least load: the smallest
   change that reuses existing seams, no new frameworks, no speculative
   robustness. The repository's `AGENTS.md` style guide applies.
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
   from the worktree, at a narrow and a wide terminal size. Say in the report
   what you did and what you saw. Never `bun run dev:live` or `bun run dev`,
   never the live service on port 40375, never live config or live databases
   (the live `monitor.db` included) — copies only.
5. Tests run from package directories, focused files only, never the repo root.
6. Public Protocol / Server `HttpApi` changed → `bun run generate` in
   `packages/client`; never hand-edit generated files.
7. Docs follow behaviour: rewrite the `## Tools` section of
   `packages/plus/README.md` as `## Monitor`, update the `## Team tab` section,
   and keep `src/monitor/tools.ts` descriptions and the agent-facing text exact.
8. Theme tokens by semantic role (repository AGENTS.md "TUI Theme Tokens"): a
   miss is feedback (warning/error), selection uses formfield/action states.
   Extend the theme only if a role is missing.
9. Have a reviewer read each task's diff before you land it. The page's
   intuitiveness is a requirement, so the reviewer judges it from the live
   check's description as well as the code.
10. Commits: `type(scope): subject`. Report every end-state line below and how
    it was verified.

**Checks:** the project names no checks, so a check is `bun test <file>` or
`bun run typecheck` as argv with `cwd` set to the package directory.

**What exists (read first):**
- `src/monitor/ledger.ts`: SQLite `monitor.db`, schema v1. Steps already store
  input, output, reasoning, `cache_read`, `cache_write` and cost. Calls carry
  attributed tokens; there are `session`, `epoch` and `mark` tables.
- `src/monitor/collector.ts`: folds session events (`MonitorEvents`).
- `src/monitor/query.ts`, `src/monitor/attribution.ts`, `src/monitor/tools.ts`:
  `monitor.query` and `monitor.mark` in Code Mode.
- `src/monitor/plugin.ts`.
- `src/rpc.ts`: `MonitorScope`, `MonitorQueryInput`, `MonitorReport` (~1025–1140).
- `src/tui/monitor/{index.tsx,view.tsx,format.ts}`: the `/tools` page and the
  composer `Tools` tab.
- `src/tui/active-team.tsx`: the composer `Team` tab (runs list, `ctrl+a`).
- `src/teams/run.ts`: `RunRecord` has `parent`, `children`, `role` and
  `sessionID`, but no team identity.
- Warming pings go through `SessionGenerate.generate`
  (`packages/core/src/plugin/warming.ts` loop). Their usage is only logged
  today (`packages/core/src/session/generate.ts`, "session generation usage
  diagnostic").
- Plugin hooks that see requests (`packages/plugin/src/effect/session.ts`):
  `context`, `compaction`, `generate`, `title`, `http.request`,
  `http.response`, `experimental.ws.send`.
- Cache lifetimes per provider: README "The interval and the provider's cache
  lifetime".

---

## T1 — Record every request with a fingerprint and its usage (ledger v2)

**End state**
- Every provider request a session makes is recorded with time, session, kind,
  agent, provider/model/variant, and its usage (input, cache read, cache write,
  output, reasoning, cost) or its error. Kinds are agent steps, compactions,
  keep-alive pings and other `generate` calls, and titles (flagged so totals can
  include or exclude them). Steps keep everything they have today.
- **Keep-alive pings are recorded with their usage.** This needs a small core
  seam, since today ping usage is only logged. Recommended: `generate` returns
  usage and the warming loop reports it through the `warming` hook (a `warmed`
  phase) or one dedicated hook. Choose the least load-bearing.
- **Request fingerprint**, recorded for each request as sent (the final wire
  body, HTTP or WebSocket frame, after every transform). It is protocol-aware
  for the protocols in use (OpenAI Responses, OpenAI-compatible chat, Anthropic
  Messages), with a whole-body chunked prefix hash as the fallback for others.
  It holds:
  - one hash and size per system part, named by its source (instruction file,
    base template, Plus guidance row, date/environment block) wherever the
    `context` hook can name it;
  - one hash and size per tool (name; description and schema hashed apart);
  - a hash of the generation/provider options that affect caching (per key
    where visible);
  - rolling prefix hashes per message (role, kind, message id where known) so
    the first diverging message can be found;
  - the cache-control markers / prompt-cache key when present.
- **Context facts:**
  - CLIProxyAPI account switches and quota handoffs (`src/quota/controller.ts`);
  - instruction updates (`session.instructions.updated` with the changed source
    keys);
  - compactions;
  - agent/model switches;
  - reverts.
- **Privacy:** no contents are ever stored, only hashes, sizes (chars and
  estimated tokens), names, ids and timings.
- Schema v2 migrates v1 in place: v1 data stays readable and the new tables
  start empty. Retention stays at 90 days. Writes stay idempotent across Plus
  instances, as today.

**Where:** `src/monitor/ledger.ts`, `collector.ts`, `plugin.ts`, a new
`src/monitor/fingerprint.ts` (or similar), `src/index.ts` (monitor wiring
~166–180, hook registration), `packages/core/src/plugin/warming.ts` and
`packages/core/src/session/generate.ts` (ping usage seam),
`packages/plugin/src/effect/session.ts` if a hook shape changes.

**Overlap:** the session-runtime plan changes the warming loop's `generate`
call in `packages/core/src/plugin/warming.ts` (pings use the last real request's
agent/model). Keep your change to usage reporting.

**Tests:** `test/monitor.test.ts` and `test/monitor-plugin.test.ts`: fingerprints
from real request bodies for each protocol; a ping's usage lands as a ping
request; the v1 → v2 migration keeps v1 rows; no content is stored (assert on
the stored columns).

**Effort:** large.

## T2 — Cache-miss analysis and the agent-facing tools

**End state**
- Every request gets a cache verdict: **hit**, **partial miss**, **miss**,
  **cold start** (first request, or first after compaction/agent or model
  switch: expected, not counted as a miss) or **no cache reported** (provider
  reports no cache fields).
- Expected reusable prefix: the common prefix with the latest earlier request
  of the same session, provider and model. Measured from that request's real
  prompt tokens when the fingerprint shows a pure append, estimated from segment
  sizes otherwise.
  - **Miss:** expected prefix ≥ 1024 tokens and cache read < 50 % of it.
  - **Partial miss:** 50–90 %.
- **Cause, with a confidence**, checked in this order:
  1. *compacted* — expected;
  2. *model / variant switch*;
  3. *agent switch*;
  4. *prefix changed* (certain): the first diverging segment, named. Examples:
     "system part `AGENTS.md` changed", "tool `shell` description changed",
     "tools added: x, removed: y", "option `reasoning.effort` changed",
     "message 14 (tool result) rewritten", "instruction update inserted".
     Also name the instruction update or revert that coincides with it;
  5. *cache expired* (likely): the prefix is identical but the gap since the
     last request or successful ping on it exceeds the provider's cache
     lifetime. Name the gap, the lifetime, the last ping, and whether warming
     was off, ended or failed;
  6. *provider account changed* (likely): a CPA account switch or handoff
     happened in between;
  7. *unknown*: the prefix is identical and within the lifetime. Say so, add
     "provider-side eviction or routing", and attach all evidence.
- **Extra signals:**
  - *unstable prefix*: a segment that changes on 3 or more consecutive requests
    is flagged with its name (for example a timestamp in a system part);
  - ping effectiveness: pings sent, their cost, and whether the next real
    request hit;
  - miss cost: tokens re-written or re-read uncached because of misses, and
    their cost when pricing is known;
  - cache writes never read before expiry;
  - context size now versus at the last compaction.
- **Agent tools (Code Mode):**
  - `monitor.query` gains `scope: "session" | "tree" | "team" | "project" | "all"`
    (default: the calling session), `since: "compaction"` beside `window`, and a
    `view` for overview, cache, tools, sessions and steps (today's groupings
    stay available).
  - One call returns the misses of the calling session with cause, confidence
    and one-line evidence. One more call (`monitor.miss({ id })` or
    `query({ view:"cache", id })`) returns the full evidence: segment diff with
    names, timings, ping history, account switches, expected versus actual
    tokens, and the session and message ids.
  - `monitor.mark` stays.
  - Descriptions say this exactly.

**Where:** `src/monitor/query.ts` (or a new `src/monitor/cache.ts`),
`attribution.ts`, `tools.ts`, `src/rpc.ts` (Monitor schemas: keep every key
optional-omitted, never `undefined`). Derive at query time from the facts. A
stored read model is acceptable only if measured query time requires it.

**Tests:** fixture sessions for each cause (switch, system change, tool change,
gap over the lifetime with warming off, account switch, unknown) → the right
verdict, cause and evidence; the tools return them for the calling session by
default.

**Effort:** large.

## T3 — The Monitor page

**End state**
- `/monitor` (palette: "Monitor: tokens, cache and tools") opens the page. So
  do `/tools`, which stays as an alias, and `M` in the composer `Tools` and
  `Team` tabs. It opens **filtered on the session it was opened from**.
- **Scope** (always visible on the first header line; `s` steps through):
  - **This session**;
  - **Team tree**: the root of this session's delegation tree (team run
    parents and host subagent parents, up to the topmost) and every descendant
    at any depth;
  - **Team**: every session of a chosen Plus team, across trees. Pick it with
    `T`. Record the team on runs from now on; for older runs, derive it from
    role-to-team membership where that is unambiguous;
  - **Project**;
  - **Everything**.
- `S` opens a session picker. Team trees are grouped under their root (root
  title, agent, last active) with children indented, stand-alone chats are
  listed separately, and everything is sorted by last activity, newest first.
  Enter scopes the page to the picked session.
- **When** (second header line; `t` steps through): All · Since last compaction
  (per session) · 15m · 1h · 24h · 7d · 30d.
- **Totals line**, always visible:
  - requests and steps;
  - uncached input, cache read, cache write, output, reasoning;
  - cost;
  - hit rate;
  - misses and their cost;
  - pings.
- **Tabs** (`tab` / `shift+tab` or `1`–`5`): **Overview · Cache · Tools ·
  Sessions · Steps**.
  - **Overview:**
    - the token mix;
    - the agents in scope, sorted by last activity, newest first (agent, model,
      steps, hit rate, misses, tokens, cost, last active);
    - the top 3 misses and the top 3 tools by carried tokens;
    - unstable-prefix warnings;
    - context now versus at the last compaction.
  - **Cache:**
    - every request in time order with its verdict. Misses are marked with the
      feedback token; cold starts are dim; pings are visible;
    - Enter on one opens its detail: cause and confidence, evidence lines,
      what changed by segment name, timing (gap, lifetime, pings), expected
      versus actual tokens, and the ids;
    - `x` shows misses only.
  - **Tools:** today's tools view keeps every capability: group by tool, agent,
    model, target, session or config; drill down; compare; marks; the agent,
    tool and model filters; failed-only.
  - **Sessions:** the sessions in scope as a tree with per-session totals, last
    activity and state. Enter scopes the page to that session; another key
    scopes it to that session's tree.
  - **Steps:** every request with all token fields, duration, finish and the
    tools called. Enter shows that step's calls with attributed tokens and the
    fingerprint change against the previous request.
- **Keys:**
  - `o` order;
  - `a` / `f` / `F` agent, tool and model filters;
  - `/` text filter;
  - `m` mark, `c` compare;
  - Enter drill, `⌫` / esc back, esc closes;
  - `?` lists every key.
  - A one-line hint bar always shows the keys that matter on the current tab.
  - Settings persist; drill-downs do not.
- **Intuitive by construction:**
  - a first-time user can read the scope and the window without pressing
    anything;
  - every number has a label;
  - nothing important needs horizontal scrolling at 100 columns;
  - the narrow layout drops columns before labels.
- The composer `Tools` tab keeps its compact form. Its default scope becomes the
  team tree; `M` opens the page on its session.

**Where:** `src/tui/monitor/index.tsx`, `view.tsx` (split by tab as you see
fit), `format.ts`, `src/tui/index.tsx` (command `plus.monitor.open`, slash
`monitor` plus the `tools` alias). Add a storybook story under
`packages/tui/src/feature-plugins/system/storybook` for the page with fixtures
(repository AGENTS.md "V2 TUI Stories").

**Overlap:** the session-runtime plan edits `src/tui/index.tsx` (footer slot).
Keep your edit to the monitor command.

**Tests:** `test/monitor-view.test.tsx`: opens on the session; `s` reaches the
tree; the Cache tab shows a fixture miss with its cause; detail opens; narrow
and wide layouts. **Live:** create misses on purpose in the dev home (toggle an
instruction row between two messages; switch model; wait past the lifetime with
warming off) and check that each shows with the right cause. Have an agent in
that session call `monitor.query` and get the same answer.

**Effort:** large.

## T4 — The composer `Team` tab defaults to the current team tree

**End state**
- The `Team` tab lists, by default, only the runs of the current chat's team
  tree: the root run above the chat's run and every descendant at any depth,
  shown as a tree (indented by depth).
- A toggle switches between this tree and all runs in the namespace. Use a free
  key (for example `ctrl+t`). The hint bar names the current view (`tree` /
  `all`).
- `ctrl+a` (active/inactive), Enter (attach) and `ctrl+d` (stop/resume) keep
  working in both views.
- A chat that is in no team tree shows `No team runs from this chat · ctrl+t
  shows all`.
- The `Team` and `Tools` tabs stay separate in the composer, as today.

**Where:** `src/tui/active-team.tsx` (composer tab ~215–470),
`src/index.ts` `team.runs.list` (~3029), `src/rpc.ts`, `src/teams/run.ts`;
`test/active-team.test.tsx`. README `## Team tab`.

**Overlap:** the instructions plan may touch the agent-group provider in
`active-team.tsx` (~80–100). Keep your edit to the composer tab.

**Tests:** the tree from an implementer's session shows its orchestrator root
and siblings; toggle to all; the empty state.

**Effort:** medium.
