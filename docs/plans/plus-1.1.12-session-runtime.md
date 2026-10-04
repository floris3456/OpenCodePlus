# plus-1.1.12 — Session runtime: cache warming footer and remote compaction

**Objective:** the prompt footer always shows the chat's cache state (also under
question and permission prompts); compact before cold reads as one label;
warming recognises every compaction (`compacted`, no pings, one Enter sends);
keep-alive pings follow the agent/model of the last real request; and Claude
models reached through CLIProxyAPI compact remotely when the strategy is Auto.

Release: `plus-1.1.12`, together with `plus-1.1.12-team-fixes.md` (decided
2026-10-04). The Instructions and Monitor plans moved to `plus-1.1.13`. This
was one of three plans run in parallel:
`plus-1.1.12-session-runtime.md` (this), `plus-1.1.12-instructions.md`,
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
   provider failure (the model provider or CLIProxyAPI unreachable or refusing
   after retries). Then finish every other task, finish `done_with_concerns`,
   and quote the exact error.
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
   `packages/core`, `packages/ai`), focused files only, never the repo root.
6. Public Protocol / Server `HttpApi` changed → `bun run generate` in
   `packages/client`; never hand-edit generated files.
7. Docs follow behaviour: `packages/plus/README.md` (Cache warming section),
   `packages/plus/src/cliproxyapi/README.md`.
8. Have a reviewer read each task's diff before you land it.
9. Commits: `type(scope): subject` (feat, fix, docs, chore, refactor, test).
10. Report every end-state line below and how it was verified.

**Checks:** the project names no checks (`.opencodeplus/checks.json` is
absent), so a check is `bun test <file>` or `bun run typecheck` as argv with
`cwd` set to the package directory.

---

## T1 — The footer stays visible under question and permission prompts

**End state**
- While the question tool's form (`FormPrompt`) or a permission request
  (`PermissionPrompt`) replaces the composer, the footer row that normally sits
  under the composer stays visible under that prompt. It has the same content:
  the running spinner/status, every plugin entry in `prompt.footer` and
  `prompt.footer.status` (Plus's cache countdown, usage and the like) and the
  location.
- The footer takes no keys from the prompt above it. Narrow terminals truncate
  it the way the composer footer does.

**Where**
- `packages/tui/src/routes/session/index.tsx`: the `<Switch>` around lines
  1477–1525 that shows `PermissionPrompt` / `FormPrompt` / `Prompt`.
- `packages/tui/src/component/prompt/index.tsx`: the footer row around lines
  1887–1971, `footerInput()`.
- `packages/tui/src/feature-plugins/prompt/footer.tsx` (an existing
  `prompt.footer` entry).
- Suggested approach: extract the footer row into one component that `Prompt`
  uses and that the session route renders under `FormPrompt` and
  `PermissionPrompt`. Follow `packages/tui/AGENTS.md` and the theme-token rules.

**Tests:** a `packages/tui/test` render of the session route with a pending form
and with a pending permission shows the footer slots. **Live:** ask the agent
to use the question tool while warming is on; `cache warm · …` stays visible
under the question.

**Effort:** small.

## T2 — Compact before cold is one label

**End state**
- The separate `compact before cold` marker at the far left of the footer is
  gone.
- While compact before cold is on, the warming label carries it:
  - `compact cache warm · 23:41 left` counts down to the moment the chat will
    compact. That is `compactAt` when a compaction is scheduled, otherwise the
    window end. With warming off and compaction scheduled one ping interval
    after the last request, it still reads `compact cache warm · m:ss left`.
  - `compact cache cold` once that moment has passed without a compaction.
  - `compacted` after a compaction (T3).
- With the switch off, the labels are unchanged (`cache warm · … left`,
  `cache cold`, `cache warming off`).
- Toasts, `<leader>j`, `/compact-warm` and the cold-send confirmation
  (`cache cold · enter again to send`) are unchanged.

**Where:** `packages/plus/src/tui/warming.tsx` (`warmingLabel`,
`COMPACT_MARKER`, `CompactMarker`), `packages/plus/src/tui/index.tsx` (the
`prepend: "prompt.footer.status"` slot), `packages/plus/test/warming-footer.test.tsx`,
README "Cache warming".

**Overlap:** the monitor plan edits `packages/plus/src/tui/index.tsx` (the
monitor command). Keep your edit to the footer slot lines.

**Tests:** `bun test test/warming-footer.test.tsx` (packages/plus). **Live:**
`<leader>j` in a warm chat shows `compact cache warm · …` in one place.

**Effort:** small.

## T3 — Warming recognises every compaction

**End state**
- A compaction is recognised however it happened:
  - compact before cold, `/compact`, or automatic/overflow compaction;
  - a compaction run under another agent or model, followed by switching back;
  - a compaction that completed while Plus or the server was restarting or
    updating.
- From the moment a compaction completes until the next real request in that
  chat:
  - the footer reads `compacted` (muted text);
  - no keep-alive ping is sent: a loop already scheduled in core stops at its
    next warm decision without sending;
  - no compact-before-cold compaction is scheduled;
  - the first Enter sends, with no cold-cache confirmation.
- The next real request starts a normal window (`cache warm · … left`).
- After a compaction you never have to press Enter twice.

**Decisions**
- The source of truth is the session's durable history (its latest completed
  compaction), not the warming store's in-memory window. A restart cannot lose
  it. Read it cheaply: once per status read or warm decision, behind a small
  cache that `session.compaction.ended` / `session.compacted` events
  invalidate.
- A compaction's own request never opens a warming window, whoever started it.
  Today only compactions the store started itself are excluded
  (`compacting` set).

**Where**
- `packages/plus/src/warming.ts`: `createWarmingStore`, `decide`, `status`,
  `statusOf`, the `compacting` and `coldAt` logic.
- `packages/plus/src/index.ts`:
  - `decideWarmingFor` (~3168);
  - `watchHostEvents` (~5395), which today subscribes only run events for
    warming.
- `packages/plus/src/rpc.ts`: `WarmingStatus` (~963–1010). Add the compacted
  fact, and omit the key when it is absent (README: never send `undefined`
  across RPC).
- `packages/plus/src/tui/warming.tsx`: the label and `guard`.
- `packages/core/src/plugin/warming.ts`: `hook(..., "compaction")` opens a
  window today. Plus's `warming` hook answer (settings `undefined`) is the
  intended seam; touch core only if that seam cannot do it.

**Tests:** `packages/plus/test/warming.test.ts` must cover:
- a compaction the store did not start → `compacted`, and the warm decision
  returns no settings;
- a fresh store instance (restart) whose session history shows a compaction
  after the window started → `compacted`;
- the next primary activity → a normal window;
- the guard lets the first Enter through while `compacted`.

**Live:** a warm chat → `/compact` → the footer reads `compacted`, no
`warming session` log line follows, and one Enter sends.

**Effort:** medium.

## T4 — Pings follow the last real request's agent and model

**End state**
- After the composer switches agent or model, keep-alive pings continue exactly
  as before. They use the same agent, model, variant and interval as the chat's
  last real request and keep its remaining window, so that cache stays warm.
  The footer keeps showing that window.
- The moment a real request (message, command or compaction) runs with a
  different agent or model, the old pings stop. That request's agent/model then
  decides warming: pings start only if warming is on for it.
- A blank Enter that only commits the composer selection (no model request)
  does not change what is pinged.
- A ping is always sent with the last real request's agent/model/variant,
  never with the session's current selection. Today `SessionGenerate.generate`
  resolves from the stored session selection, which a blank Enter can change.

**Where**
- `packages/core/src/plugin/warming.ts` (`loop` → `ctx.session.generate({ sessionID, prompt })`).
- `packages/core/src/session/generate.ts` and `packages/core/src/session.ts`
  (`generate`).
- `packages/plugin/src/effect/session.ts` only if the plugin surface must carry
  it.
- Prefer a core-internal path for the warming plugin over widening the public
  `generate` API. If you do widen it, regenerate the client.

**Overlap:** the monitor plan adds ping-usage reporting in the same loop
(`packages/core/src/plugin/warming.ts`). Keep your change to the generate call
and its inputs.

**Tests:** a core test of the warming loop: select another agent/model with no
request → the ping still uses the old one; a real request with the new one →
the old loop stops and the new settings apply. Plus `warming.test.ts` pins that
decisions read the activity's agent/model.

**Effort:** small–medium.

## T5 — Anthropic native compaction in `@opencode/ai`

**End state**
- `LLMClient.compact` works for Anthropic Messages routes (`anthropic`,
  `anthropic-compatible`, whichever the CPA relay uses). It uses the in-band
  `compact_20260112` context-management edit with `pause_after_compaction` and
  produces the result `SessionCompaction`'s native path consumes: checkpoint
  persisted, usage accounted.
- These routes declare `compact.trigger`. `ModelResolver` therefore accepts
  `settings.compaction: { type: "native" }` for their models, and
  `SessionCompaction` with strategy **Auto** chooses native for them.
- Below Anthropic's minimum trigger (the schema says 50 000 input tokens),
  native compaction cannot run: Auto falls back to a local summary, and Remote
  fails honestly with a clear message.
- Read Anthropic's current compaction documentation with the search tools
  before coding; the wire contract decides.

**Where**
- `packages/ai/src/protocols/anthropic-messages.ts`:
  - `ContextManagement` (~61);
  - the body build (~1040–1100);
  - compaction stream parsing (~1324–1401);
  - beta headers (~1640).
- `packages/ai/src/providers/anthropic.ts`, `anthropic-compatible.ts`.
- `packages/ai/src/route/client.ts` (`compact`, `trigger`).
- Reference implementation: `packages/ai/src/protocols/openai-responses.ts`
  (`checkpointBody` ~225, `route.compact` ~326),
  `protocols/utils/responses-compaction.ts`.
- `packages/core/src/session/compaction.ts` (~235–270, ~429–450).
- `packages/core/src/model-resolver.ts` (~183–193).
- Keep the mechanism behind `LLMClient.compact` (repository AGENTS.md, V2
  Session Core).

**Tests:** `packages/ai` tests against recorded/fixture Anthropic streams that
contain a compaction block (`packages/http-recorder` exists). A core test:
Auto + native model → native path; below minimum → local.

**Effort:** large.

## T6 — Claude through CLIProxyAPI's Anthropic relay; Auto compacts remotely

**End state**
- For every provider routed to CLIProxyAPI, Claude models (CPA reports them as
  Anthropic-owned, or their ids start with `claude-`) are sent through CPA's
  Anthropic Messages relay. They get:
  - the Anthropic protocol package;
  - Anthropic-spelled effort variants;
  - `settings.compaction: { type: "native" }`.
- This holds in the user's current setup (a legacy `quota-handoff.json` route
  with the catalogue off) as well as in catalogue mode. With compaction strategy
  Auto (the default), Opus therefore compacts remotely.
- The user's own `package` or `settings.compaction` for a model in
  opencode.json still wins.
- One switch per route turns the relay off (for example
  `"anthropicRelay": false` in `cliproxyapi.json`; name it as fits the config
  file).
- These keep working on the Anthropic path: warming pings, usage, cost, cache
  accounting and quota handoff. Handoff keeps its portable local summary on an
  account switch, by design (`decision.portable`).
- The live opencode.json carries `compaction: {"mode":"local"}` on the Claude
  models, a key the config schema ignores. Document it as inert. Do not edit
  live config.
- **Live provider smoke** in the dev home (copied credentials only):
  - a Claude session through CPA, strategy Auto, compacts natively (the
    checkpoint/log shows the remote route);
  - a normal step and a warming ping succeed on the Anthropic path, and cache
    read tokens are reported.
  - A provider failure here is the one allowed blocker: quote the exact
    response.

**Where**
- `packages/plus/src/cliproxyapi/index.ts`, `catalog.ts` (`applyCatalogue`,
  `spellVariants`), `config.ts`, `README.md`.
- `packages/plus/src/quota/*` (routes).
- `packages/core/src/variant.ts` (Anthropic variant spelling).
- `packages/plus/test/cliproxyapi/`.
- Depends on T5.

**Effort:** medium.
