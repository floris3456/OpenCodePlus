# plus-1.1.12 team fixes: plan

**Objective:** the team runtime no longer loses hours to infrastructure.
- A silent model stream fails after 10 minutes and is retried.
- A long rate limit fails the step at once with its reset time, and shorter
  waits show in `team_status`.
- Loaded workspaces stay unloaded once evicted.
- One team sweep runs per server process, takes the repository lock only when
  there is something to clean, and waits in turn.
- A merge that loses the lock while landing retries only the landing.
- `team_stop` ends a working child at once, stops its cache warming, and the
  parent cannot resume a run it stopped.
- A team member's role record with `<!-- requires: … -->` lines publishes once
  instead of storming.
- `team_finish` says why checks are red.
- A relative `briefFile` works.

Each task below lands with its focused tests green and `bun typecheck` clean in
every package it touches.

Research behind every task: `docs/plans/plus-1.1.12-team-bottlenecks.md`,
section "Follow-up research (2026-10-04)", questions 1–9. Line numbers are at
`plus-1.1.12` `6f394c15ca`.

## Who runs this and how

- **Executor:** a `Simple-Orchestrator` (team Simple, see
  `docs/plans/plus-1.1.12-simple-team.md`). It works in its own purpose
  worktree, made by the planner or the build seat:
  ```sh
  git worktree add -b team-fixes /home/bliss/OpenCodePlus/worktrees/team-fixes/opencode plus-1.1.12
  ```
  It delegates tasks to the three workers and lands their commits itself. The
  result is merged into `plus-1.1.12` with `git merge` when done. Pushing stays
  with the user.
- **Tests:**
  - Run `bun test <file>` from the package directory named in the task, never
    from the repository root, never the whole suite.
  - Run `bun typecheck` from each touched package directory.
  - The worktree needs `bun install --frozen-lockfile` once before the first
    test.
- **Live tests:**
  - Run the worktree's own build in its own home:
    `pilotty spawn --name <the task's session name> opencodeplus-dev .` from
    the worktree. Each task names its session, e.g. `t1-storm`.
  - Kill that pilotty session afterwards.
  - The home is
    `/home/bliss/OpenCodePlus/run/plus-dev/worktrees-team-fixes-opencode/`
    (below: `$DEV`).
    - Its server log is `$DEV/data/opencode/log/opencode.log`.
    - Its teams data directory (below: `$DEV_TEAMS`) is the one printed by
      `find $DEV/data -maxdepth 3 -type d -name teams`.
  - Never use `bun run dev:live` or `bun run dev`: they attach to or replace the
    shared service.
- **When fixes take effect:** none of this changes the running service. Fixes
  reach it only after a release build and activation, which is the user's job
  (skill `opencodeplus-release`).
- **Commits:**
  - One commit or more per task, conventional messages, e.g.
    `fix(plus): record the installed role text as the team baseline`.
  - No `.changeset` files.
  - A worker commits; the orchestrator reviews and lands.

## Order and parallelism

| Wave | Tasks (parallel within a wave) | Why this order |
|---|---|---|
| 1 | T1, T2, T6, T10, T13, T14 | Independent files. T1 stops the empty-prompt flip and goes first. |
| 2 | T3, T9, T12 | T3 follows T2 (both change retry behaviour, and both are tested through the runner). T9 changes `teams/run.ts`. |
| 3 | T4, T5 | T4 changes `teams/run.ts` after T9 and builds on T3. T5 follows T6 (it calls the lock with the new single-try option). |
| 4 | T7, T11 | T7 needs T6's lock. T11 needs T2 landed: the exemption is only safe once silent streams end. |
| 5 | T8 | Needs T7's `tempDir` field and T5's `gc` changes. |

**Files touched by more than one task.** Land these one after the other and
rebase the later one:
- `packages/plus/src/teams/run.ts`: T9 (`stoppedBy`), then T4 (`retrying`,
  `retryNoticeAt`). T11 uses the attempt's existing `error` field and does not
  change `run.ts`.
- `packages/plus/src/teams/lifecycle.ts`: T5 (`startSweep`, `gc`), T9
  (`stopIdle`), T4 and T11 (`onSessionEvent`), T8 (`gc`).
- `packages/plus/src/teams/api.ts`: T12 (`finishHandler`, `checkHandler`), T13
  (`delegateHandler`), T4 (`statusOf`). These are separate regions.
- `packages/plus/src/index.ts`: T1 (`captureBaselines`, `teamRoleOverrides`),
  T9 (`decideWarmingFor`). These are separate regions.

### Overlaps with the unmerged plus-1.1.12 branches

These branches are listed in the appendix of
`docs/plans/plus-1.1.12-simple-team.md`. Whichever lands second resolves the
conflict.

| Branch | Touches | Overlaps |
|---|---|---|
| `team/Heavy-Implementer/t54a9ef-20261004-1204` (monitor T2) | `core/src/session/model-request.ts` :364-406; `teams/api.ts` `statusOf` (tail); `teams/run.ts` `RunRecord` (`team?` field) and `saveRun` | T2 edits the options block right below it (:414-417). T4 edits `statusOf` and `RunRecord`. T9 edits `RunRecord`. Expect text conflicts; keep both changes. |
| `team/Orchestrator/t131092-20261004-0301`, `team/Flash-Implementer/t45315d-20261004-1103` (monitor) | `teams/run.ts` (new function after :573); `index.ts` imports and `createHandlers` | Low overlap: adjacent appends in `run.ts` with T4 and T9. |
| `team/Orchestrator/t125799-20261004-0301`, `team/Flash-Implementer/t58b343-20261004-1306` (instructions T1/T2/T4/T5/T8, T6 rename) | `index.ts` (`Plugin.define` near :165, many `createPlusApi` regions); `instructions/{snapshot,store,query,tree,…}.ts` | `index.ts` near the sweep call (T5 does not edit `index.ts`). T1 is in `captureBaselines`/`teamRoleOverrides` (:4900–5190), outside their hunks. |
| `team/Flash-Implementer/t6086e7-20261004-1347` (T3 + T7 model activation) | `instructions/discover.ts`; `index.ts` :117 `PlusState`, :4195–4237 `discoverAll` | T1 reads `discover.ts#upstreamPrompt` but does not change it. Re-run T1's tests after merging this branch. |

## Tasks

### T1. Team member role records with `requires` markers stop republishing

**Effort:** small. **Package:** `packages/plus`. **Research:** question 8.

**End state.**
- After a member's role record containing `<!-- requires: … -->` lines is
  saved, `instructions.refresh` leaves the publish fingerprint unchanged.
- The host shows the gated role text every time.
- A team member is never installed with the empty body of its preset-created
  file while a role record exists.

**Interfaces.**
- `packages/plus/src/index.ts#captureBaselines` (:4900).
  - For an owner that is a team winner (`winnerScope.has(owner)`) and has an
    entry in `teamOverrides`, record
    `{ applied: teamOverrides.get(owner), upstream: item.text, fileBacked: false }`.
    This is exactly the text `installTeamAgents` installed.
  - Do not resolve ungated. Today `resolve(...)` at :4944 runs without `gate`
    and without the member's `team`, so `applied` keeps the marker lines that
    publish stripped.
- `packages/plus/src/index.ts#teamRoleOverrides` (:5152).
  - Return the resolved role for every team winner whose resolution is enabled
    and non-empty, even when `roleUpdates`' no-op check (`apply.ts#isNoop`,
    :348) matches the discovered text.
  - `installTeamAgents` needs the text either way, because its fallback
    (`instructions/teams-apply.ts#applyTeamAgent`, :186,
    `override ?? body`) is the file body, which is empty for members created
    from a preset.
  - Implement it with a team-specific variant of the loop in
    `instructions/apply.ts#roleUpdates` (an option to skip the no-op test).
    Do not change `applyRoles`.

**Decisions.**
- Fix the baseline, not the markers. The Simple role bodies were stored without
  their marker lines on 2026-10-04 as a stop-gap. After this release they may
  carry markers again.
- Built-in members keep today's result: their override equals the gated
  shipped body, as before.

**Tests.** In `packages/plus`:
- Add to `test/teams-apply.test.ts`, next to "a customized team member role
  survives publication…" (:307):
  - "a member role record with a requires marker keeps the fingerprint across
    refreshes":
    - project team `crew` with member `alpha` (body `crew alpha body`);
    - enable it;
    - mutate a `system:role` record
      `"edited alpha role\n\n## Tests\n<!-- requires: tool:read -->\n\nrun them"`;
    - call `instructions.refresh` four times;
    - expect `state.fingerprint` unchanged after each call, and the host system
      equal on all four reads, never `crew alpha body`.
  - The same with a member file whose body is empty: expect the host system
    never to be `""`.
  - A scratch version of the first test failed on today's code (the host
    alternated between body and role) and passed without the marker line. It
    is kept outside the repository at
    `run/plus/tmp/opencodeplus/team-fixes-research/zz-scratch-requires-storm.test.ts`.
- Run:
  ```sh
  bun test test/teams-apply.test.ts test/rpc.test.ts test/discover.test.ts test/requires.test.ts
  bun typecheck
  ```

**Live test.**
- In a dev chat (`pilotty spawn --name t1-storm opencodeplus-dev .`), use
  `tools.instructions.set` to give one Simple member's
  `item:global:Simple/:Flash-Worker:system:role` a line
  `<!-- requires: tool:team_finish -->` above its `## Reporting` heading.
- Wait 60 s.
- `grep -c 'event.type=agent.updated'` on the dev home's log must grow by fewer
  than 20.
- `tools.instructions.show({ id: "agent:global:Flash-Worker", view: "assembled" })`
  must return the same non-empty length three times.

### T2. A no-data timeout on HTTP model streams

**Effort:** medium. **Packages:** `packages/ai`, `packages/core`.
**Research:** question 1.

**End state.**
- An HTTP model request fails with a retryable transport error when either
  happens:
  - no response headers arrive within the idle timeout;
  - the response body sends no bytes for that long.
- The session retries the step as for any transport error.
- The default is 10 minutes. A provider's existing `chunkTimeout` setting (ms)
  overrides it.

**Interfaces.**
- `packages/ai/src/route/transport/index.ts#TransportExecuteOptions`: add
  `readonly idleTimeout?: Duration.Input`.
- `packages/ai/src/route/client.ts#StreamOptions` (:183): add the same field.
  `streamPrepared` (:424) already passes `options` to `transport.execute`.
- `packages/ai/src/route/transport/http.ts#httpJson` `execute` (:90):
  - When `options?.idleTimeout` is set, wrap `runtime.http.execute(...)` in
    `Effect.timeoutOrElse`. On timeout:
    `TransportError { transport: "http", code: "idle-timeout", operation: "request", phase: "receive", delivery: "ambiguous" }`.
  - Wrap the byte stream `RequestExecutor.responseStream(response)` in
    `Stream.timeoutOrElse`, the same shape as `core/src/session/model-transport.ts`
    :417-429. On timeout: `operation: "read", delivery: "accepted"`.
  - Measure bytes, before framing, so SSE comments and pings count as data.
- `packages/ai/src/protocols/open-responses-channel.ts`: the `execute` at :179
  passes `executeOptions` into both `http.execute` calls (:181 and :192).
- `packages/core/src/session/model-request.ts`: in the returned `options`
  (:414-417), add `idleTimeout: model.chunkTimeout ?? HTTP_IDLE_TIMEOUT`, with
  `const HTTP_IDLE_TIMEOUT = "10 minutes"` beside the other constants of that
  module.
  - The WebSocket path keeps `IDLE_TIMEOUT` (30 minutes) unless `chunkTimeout`
    is set, as today.

**Decisions.**
- 10 minutes. The longest healthy silence seen in today's runs was well under
  that, and the hung steps lasted 35–66 minutes.
- `provider-error.ts#isRetryable` already retries these shapes (:75-79). No
  classification change.
- `compact` requests (`CompactOperation`, `EndpointCompactOptions`) are out of
  scope.

**Tests.**
- In `packages/ai`, add to `test/route.test.ts`:
  - "an HTTP stream that sends no bytes for idleTimeout fails with a retryable
    idle-timeout": a test `HttpClient` layer whose response body emits one SSE
    chunk and then never ends; use `TestClock`; assert `AIError` reason
    `Transport`, `code: "idle-timeout"`, and `isRetryable(...) === true`.
  - "headers that never arrive fail with idle-timeout": `operation: "request"`.
  - "a stream that keeps sending pings never times out".
- In `packages/core`, add to `test/session-model-request.test.ts`: the prepared
  `options.idleTimeout` is `"10 minutes"` without `chunkTimeout`, and the
  configured number when it is set.
- Run:
  ```sh
  # packages/ai
  bun test test/route.test.ts test/executor.test.ts test/provider-error.test.ts
  bun typecheck
  # packages/core
  bun test test/session-model-request.test.ts test/session-model-transport.test.ts test/session-runner.test.ts
  bun typecheck
  ```

**Live test.**
- Start a stub provider:
  - a Bun script at
    `/home/bliss/OpenCodePlus/run/plus/tmp/opencodeplus/team-fixes/stub-provider.ts`
    serving `POST /v1/responses` on `127.0.0.1:47811`;
  - it answers `200`, `content-type: text/event-stream`, writes one
    `: ping\n\n`, then holds the connection open.
- In the dev home's `config/opencode/opencode.json` (not the release config),
  add a provider:
  - `stub`, package `@opencode/ai/providers/openai`;
  - `settings: { baseURL: "http://127.0.0.1:47811/v1", apiKey: "x", transport: "http", chunkTimeout: 20000 }`;
  - one model.
- Prompt it from `pilotty spawn --name t2-idle opencodeplus-dev .`.
- Within about 25 s the TUI shows a retry. The dev log shows the
  `session.retry.scheduled` path rather than a step that never ends.
- Kill the stub and the session.

### T3. A long provider wait fails the step instead of being clamped

**Effort:** small. **Package:** `packages/core`. **Research:** question 2.

**End state.**
- A `RateLimit` or `ProviderInternal` error whose `retryAfterMs` exceeds
  `RETRY_AFTER_MAX` (15 minutes) is not retried. The step fails with that
  provider error, so a team child settles and its parent hears about it within
  seconds.
- Shorter waits behave as today.

**Interfaces.**
- `packages/core/src/session/runner/retry.ts`:
  - In `policy` (:58), when `retryAfter(input)` would clamp (the raw
    `retryAfterMs > RETRY_AFTER_MAX`), set `decision: { retry: false }` before
    calling `input.hook(event)`. Plugins can still override, and the Plus quota
    hook (`plus/src/quota/register.ts:64`) keeps its CPA `quota_*` handling.
  - `retryAfter` (:34) keeps clamping for the waits it allows.

**Decisions.**
- Decide on the provider's wait, not on message text. CLIProxyAPI's
  "All credentials … cooling down" recovered after 86 minutes once today, so
  `QUOTA_TEXT` (`packages/ai/src/provider-error.ts:147`) is not widened.
- The error message keeps the provider's own text. CPA's text carries
  "Resets in …".

**Tests.**
- In `packages/core`, add to `test/session-runner.test.ts`, next to its
  existing `retryAfterMs` cases:
  - a 429 with `retryAfterMs: 16 * 60_000` fails the step on the first error,
    with no `session.retry.scheduled`;
  - `retryAfterMs: 60_000` still schedules a retry 60 s out.
- Run:
  ```sh
  bun test test/session-runner.test.ts test/session-error.test.ts
  bun typecheck
  ```

**Live test.**
- Use T2's stub server, answering `429` with `retry-after: 3600` and body
  `{"error":{"message":"quota reached. Resets in 1h"}}`.
- The dev chat shows the error at once; there is no retry countdown.
- With `retry-after: 5`, it retries after 5 s.

### T4. "Retrying until …" in `team_status`, and the parent is told

**Effort:** medium. **Package:** `packages/plus`. **Research:** question 2.

**End state.**
- While a run's session waits on a scheduled retry, `team_status` shows
  `retrying: { until, attempt, error }`.
- A wait of 5 minutes or more puts one notice in the parent's inbox and wakes
  it: "Run <id> (<role>, <model>) is waiting on <error type> until <HH:MM UTC>;
  supersede it to use another worker".

**Interfaces.**
- `packages/plus/src/teams/session-events.ts`: export
  `RETRY_SCHEDULED = "session.retry.scheduled"`. Do not add it to
  `SessionRunEvents`, which the TUI monitor reads.
- `packages/plus/src/index.ts`: the `runs` subscription (:5447) also forwards
  `RETRY_SCHEDULED` to `teams/lifecycle.ts#onSessionEvent`.
- `packages/plus/src/teams/lifecycle.ts#onSessionEvent` (:168): on
  `RETRY_SCHEDULED`:
  - `updateRun` sets `retrying: { until: <ISO of data.at>, attempt, error: { type, message } }`;
  - if `at - now >= 5 * 60_000` and the open attempt has no
    `retryNoticeAt`, set it, `put(root, parent, { kind: "notify", from, text })`
    and `deliverInbox(ctx, root, parent)`.
  - `settleAttempt` and the `session.execution.started` branch clear
    `retrying`.
- `packages/plus/src/teams/run.ts#RunRecord`: add the optional
  `retrying?: { until: string; attempt: number; error: { type: string; message: string } }`.
  `AttemptRecord` gets optional `retryNoticeAt?: string`.
- `packages/plus/src/teams/api.ts#statusOf` (:1176): add
  `retrying: record.retrying !== undefined && Date.parse(record.retrying.until) > Date.now() ? record.retrying : null`.

**Decisions.**
- Show only future waits. A retry that later succeeds leaves a past `until`,
  which reads as `null`.
- Do not wire `teams/schema.ts` `timeouts.stallMs`. After T2 a silent step ends
  in 10 minutes and shows up here as a retry.

**Tests.** In `packages/plus`:
- Add to `test/teams/lifecycle-events.test.ts`:
  - a `session.retry.scheduled` for a child session sets `retrying`;
  - a later `session.execution.succeeded` clears it;
  - a 6-minute wait notifies the parent once, and two such events still notify
    once.
- Add to `test/teams/api.test.ts`: `team_status` shows `retrying` for a future
  `until` and `null` for a past one.
- Run:
  ```sh
  bun test test/teams/lifecycle-events.test.ts test/teams/api.test.ts test/teams/run.test.ts
  bun typecheck
  ```

**Live test.**
- Use T2's stub, answering `429` with `retry-after: 400`.
- From a dev `Simple-Build` chat, delegate a one-line report task to a worker
  whose model is the stub.
- `team_status` on the child shows `retrying.until` about 6–7 minutes ahead.
- The build chat receives the notice.
- `team_stop` the child.

### T5. One team sweep per process; the repository lock only when an orphan may exist

**Effort:** medium. **Package:** `packages/plus`. **Research:** question 4
(a, b).

**End state.**
- However many workspaces are loaded, one sweep pass runs at a time per process,
  with passes at least `policy.sweep.tickMs` apart.
- `gc` runs at most every `policy.sweep.reconcileMs` (30 s).
- `gc` takes the repository lock only when an unlocked scan found a candidate
  orphan.
- In the background, it tries the lock once and skips the pass when the lock
  is busy.

**Interfaces.**
- `packages/plus/src/teams/lifecycle.ts#startSweep` (:696):
  - Wrap the pass in a module-level `Semaphore.makeUnsafe(1)` with
    `withPermitsIfAvailable(1)`, plus module-level `lastPassAt` and
    `lastGcAt`. Plus is imported once per process (`core/src/plugin/internal.ts`),
    so module state is process-wide.
  - Each workspace keeps forking its own loop. It uses its live `ctx`, and the
    first loop to get the permit does the pass.
- `packages/plus/src/teams/lifecycle.ts#sweep` (:486): call `gc` only when
  `Date.now() - lastGcAt >= policy.sweep.reconcileMs`.
- `packages/plus/src/teams/lifecycle.ts#gc` (:504, lock at :638):
  - First call `worktree.ts#orphans` without the lock, with the known
    directories from the runs already read.
  - Take `lock(root, "repo", repoKey, …, { timeoutMs: 0 })` only when it
    returns candidates. Use the single-try option from T6.
  - Inside the lock, repeat the scan as today. That second scan decides.
- `packages/plus/src/index.ts:196-198`: keep the call and fix the comment ("one
  pass per process at a time").

**Decisions.**
- Keep `startSweep` per workspace (a loop per plugin scope) and gate it with
  process state. Do not invent a process-level service: the plugin API has
  none.
- A busy lock means another operation is doing real work. Skipping a background
  pass loses nothing.

**Tests.** In `packages/plus`:
- Add to `test/teams/gc.test.ts`, using its `startSweeps` helper (:150):
  - three concurrent `startSweep` loops on one root never overlap a pass, and
    run about one pass per tick in total;
  - `gc` with no orphan candidates never creates `locks/repo/<key>.lock`;
  - with the repo lock held elsewhere, a background `gc` returns at once and
    leaves the candidate for the next pass.
- Keep :629, :753 and :905 passing.
- Run:
  ```sh
  bun test test/teams/gc.test.ts test/teams/lifecycle.test.ts test/teams/worktree.test.ts
  bun typecheck
  ```

**Live test.**
- Start `pilotty spawn --name t5-sweep opencodeplus-dev .`.
- From its `Simple-Build` chat, delegate three report tasks to `Flash-Worker`
  ("run `sleep 120` in the shell, then report"). Each child worktree is a
  workspace loaded in the same dev server, so four workspaces run the sweep.
- While they run, sample `$DEV_TEAMS/locks/repo/` every 50 ms for 20 s.
  The lock file exists in under 5% of samples.
- The dev log has no `plus team sweep failed`.
- `team_stop` the three children.

### T6. Fair waiting on team locks

**Effort:** small. **Package:** `packages/plus`. **Research:** question 4 (c).

**End state.**
- Within one process, callers waiting on the same lock get it in arrival order.
- Polling of the file lock (still needed across processes) backs off from
  25 ms to 250 ms with jitter.
- A `timeoutMs: 0` call tries exactly once.

**Interfaces.**
- `packages/plus/src/teams/store.ts#lock` (:253):
  - Take a permit from a module-level `Map<lockPath, Semaphore>` (one permit
    each) before the file lock, bounded by the same deadline.
  - Then run the existing file-lock loop (:236-241), with the sleep at :240
    replaced by `min(250, 25 * 2^n)` plus 0–25 ms of jitter.
  - The `E_LOCKED` message and code are unchanged.
- `packages/plus/src/teams/store.ts#LockOptions`: document `timeoutMs: 0` as a
  single try.

**Decisions.**
- The in-process queue is what fixes today's jam: all contenders were the one
  server pid.
- Cross-process fairness is out of scope.

**Tests.** In `packages/plus`:
- Add to `test/teams/store.test.ts` `describe("lock")` (:61-108):
  - five concurrent `lock` calls on one key acquire in call order;
  - `timeoutMs: 0` on a held lock fails `E_LOCKED` at once;
  - a held lock released after 100 ms is acquired by a 30-s waiter.
- Run:
  ```sh
  bun test test/teams/store.test.ts test/teams/merge.test.ts
  bun typecheck
  ```

**Live test:** covered by T5's sampling.

### T7. A merge that loses the lock retries only its landing

**Effort:** large. **Package:** `packages/plus`. **Research:** question 4 (d).

**End state.**
- A merge entry that cannot take the repository lock for `worktree add` stays
  `pending`.
- One that verified its checks but lost the landing lock stays `landing`, keeps
  its rebased tip and temporary worktree, and the next `team_integrate` (or
  `drain`) lands it without rerunning checks, provided the parent HEAD did not
  move.
- Calling `team_integrate` again for the same child and head reuses the open
  entry instead of creating another.

**Interfaces.**
- `packages/plus/src/teams/merge.ts#MergeEntry` (:14-28): add optional
  `rebaseBase`, `rebasedTip` and `tempDir`.
- `packages/plus/src/teams/merge.ts#process`:
  - Save `rebasing` only after `worktree add` succeeds (today it is saved at
    :275, before the lock at :278).
  - On `E_LOCKED` at the landing lock (:319), save the entry `landing` with
    `rebaseBase`, `rebasedTip` and `tempDir`, and skip `removeTemp`.
  - On entry into `process` for a `landing` entry with `rebasedTip`:
    - parent HEAD == `rebaseBase`: run the ff-only merge;
    - otherwise: take the existing `stale_parent` path, and rerun only the
      checks `checks.ts#stale` (:537) reports.
- `packages/plus/src/teams/merge.ts#drain` (:366-371): also pick `landing`
  entries that have `rebasedTip`.
- `packages/plus/src/teams/api-integrate.ts#integrateHandler` (new entry at
  :131): reuse an open entry for the same `childRun` and `childHead`.

**Decisions.**
- Land only on an unchanged parent HEAD. A moved parent means a fresh rebase,
  as today.
- Entries already stuck from 2026-10-04 are handled by T8's cutoff, not
  migrated.

**Tests.** In `packages/plus`:
- Add to `test/teams/merge.test.ts`, near :129-204:
  - "landing lock timeout keeps the entry landing with its tip and temp
    worktree";
  - "the next drain lands it without running checks": count executions with a
    check that appends to a file;
  - "a moved parent HEAD reruns stale checks only";
  - "a worktree-add lock timeout leaves the entry pending".
- Add to `test/teams/api-integrate.test.ts` (near :708): a second integrate for
  the same child and head returns the same entry id.
- Run:
  ```sh
  bun test test/teams/merge.test.ts test/teams/api-integrate.test.ts test/teams/checks.test.ts
  bun typecheck
  ```

**Live test.**
- In a dev `Simple-Build` chat, delegate a trivial commit task (add one line to
  a scratch file) to a worker, then `team_integrate` it.
- It lands.
- `$DEV_TEAMS/worktrees/opencode/merge/` is empty afterwards.

### T8. Leftover merge worktrees and abandoned merge entries are cleaned up

**Effort:** medium. **Package:** `packages/plus`. **Research:** question 4 (e).
**Depends on:** T5, T7.

**End state.**
- `gc` removes a merge-area worktree that no open entry names in `tempDir` once
  it is older than `policy.timeouts.startMs`.
- `rebasing` entries older than 1 hour, and `landing` entries without
  `rebasedTip` older than 1 hour, are marked `abandoned`. They no longer count
  as open merges, which today blocks reaping (`teams/lifecycle.ts:539`).

**Interfaces.**
- `packages/plus/src/teams/worktree.ts#orphans` (:234; the merge-area skip is
  at :252): take an optional `mergeOwned: Set<string>` and report merge-area
  worktrees not in it.
- `packages/plus/src/teams/lifecycle.ts#gc` (:504):
  - build `mergeOwned` from open entries' `tempDir`;
  - remove reported merge worktrees with `git worktree remove --force` inside
    the same locked pass;
  - add the `abandoned` cutoff when reading merge entries (:525-544).
- `packages/plus/src/teams/merge.ts`: add `"abandoned"` to the entry state type.
  `drain` ignores it.

**Decisions.**
- Only `gc` removes merge worktrees, under the repository lock and past an age
  limit. It never removes one an open entry names.
- The five leftover worktrees in the release data
  (`teams/worktrees/opencode/merge/*`) are handled once the release is active:
  its `gc` removes them. Nobody removes them by hand.

**Tests.** In `packages/plus`:
- Change `test/teams/gc.test.ts:1032`: a merge worktree no entry names, past the
  age limit, is removed; one named by an open entry is kept.
- Add to `test/teams/gc.test.ts`: a 2-hour-old `rebasing` entry becomes
  `abandoned` and no longer blocks reaping its child.
- Add cases to `test/teams/worktree.test.ts` for `orphans` with `mergeOwned`.
- Run:
  ```sh
  bun test test/teams/gc.test.ts test/teams/worktree.test.ts test/teams/merge.test.ts
  bun typecheck
  ```

**Live test:** after T7's live test, create a stray merge worktree in the dev
home with `git worktree add` under `$DEV_TEAMS/worktrees/opencode/merge/`, touch
it older (`touch -d '-2 hours'`), and wait one `gc` period (30 s). It is gone,
and `git worktree list` no longer shows it.

### T9. Stopping a run ends it, stops its warming, and the stopper cannot resume it

**Effort:** medium. **Package:** `packages/plus`. **Research:** question 5.

**End state.**
- `team_stop` on a `working` child interrupts its session at once; the run
  ends `stopped` when the interruption settles.
- A session whose run is `stopping`, `stopped`, `dead`, `superseded` or
  `reaped` gets no more warming pings.
- `team_followup` refuses a `stopped` run that the caller's run stopped.
  - The error is `E_STOPPED`: "You stopped run <id>; delegate a fresh run".
  - Runs stopped by the system, which have no `stoppedBy`, stay resumable.

**Interfaces.**
- `packages/plus/src/teams/api-lifecycle.ts`:
  - `stopHandler` (:117), working branch (:135-137): after saving
    `stopRequested: true` and `stopRequestedBy: parent.id`, call
    `interruptSession(ctx, child.sessionID)`.
  - `stopRun` (:94): today it refuses a working run with `E_BUSY`. Make it do
    the same as `stopHandler`.
  - `supersedeHandler` is unchanged; it already interrupts.
- `packages/plus/src/teams/lifecycle.ts`:
  - `stopIdle(ctx, root, run, by)` (:302) sets `stoppedBy: by` when `by` is
    given;
  - `onSessionIdle` (:239-241) copies `stopRequestedBy` to `stoppedBy` when it
    stops a run.
- `packages/plus/src/teams/run.ts#RunRecord` (:85 area): add optional
  `stopRequestedBy?: string` and `stoppedBy?: string`.
  `lifecycle.ts#consumeStopIntent` (:160) also deletes `stopRequestedBy`.
- `packages/plus/src/teams/api-followup.ts` (:121): return `E_STOPPED` when
  `child.state === "stopped" && child.stoppedBy === parent.id`.
- `packages/plus/src/index.ts#decideWarmingFor` (:3194): first
  `bySession(teamsDataDir(), event.sessionID)`. If the run is in one of the
  states above, set `event.settings = undefined` and return.

**Decisions.**
- Interrupt on stop. The parent asked for it, and waiting for the turn to end
  took until eviction for a hung step.
- No persisted warming switch: the decision follows the run record, so a run
  resumed by `team_followup` warms again.
- This changes the tested behaviour "stop on a working child sets
  stopRequested and reports stopping" (`test/teams/api-lifecycle.test.ts:180`).
  It now also interrupts.

**Tests.** In `packages/plus`:
- Update `test/teams/api-lifecycle.test.ts:180` to expect one
  `session.interrupt` call.
- Add to `test/teams/api-lifecycle.test.ts`: a stopped idle child records
  `stoppedBy`.
- Add to `test/teams/api-followup.test.ts`:
  - followup on a child the caller stopped fails `E_STOPPED`;
  - followup on a child stopped by `reconcile` still admits.
- Add to `test/warming.test.ts`: the warming hook clears settings for a session
  whose run record is `stopped`, using a temp teams root.
- Run:
  ```sh
  bun test test/teams/api-lifecycle.test.ts test/teams/api-followup.test.ts test/teams/lifecycle.test.ts test/warming.test.ts
  bun typecheck
  ```

**Live test.**
- In a dev `Simple-Build` chat, delegate to `Flash-Worker`: "run `sleep 600`
  in the shell, then report".
- Once `team_status` shows it working, `team_stop` it. `team_status` shows
  `stopped` within 10 s.
- After 10 minutes, the dev log has no `warming` line naming its session.
- `team_followup` on it fails `E_STOPPED`.

### T10. An evicted workspace stays unloaded

**Effort:** small. **Package:** `packages/client`. **Research:** question 3.

**End state.** The client re-fetches providers, models, agents or commands
after an `*.updated` event only for workspaces it has already loaded. The
events a workspace publishes while it shuts down no longer boot it again.

**Interfaces.**
- `packages/client/src/solid/data.ts`, the event switch (:1208-1223):
  - for `provider.updated`, `model.updated`, `agent.updated` and
    `command.updated`, still invalidate;
  - call `refresh(() => … .sync(location))` only when that catalog's `list(location)`
    is defined or `sync.has(...)` holds for it. This is the pattern
    `config.updated` uses at :1275-1278.

**Decisions.**
- Fix the client, which issues the re-boot request. Do not suppress the events
  in core teardown: other subscribers may rely on them.

**Tests.**
- In `packages/client`, add to `test/solid-refresh.test.ts`, next to its
  `config.updated` cases:
  - an `agent.updated` for a location the store never loaded issues no request;
  - one for a loaded location re-fetches;
  - the same for `command.updated`.
- Run:
  ```sh
  bun test test/solid-refresh.test.ts test/solid-eviction.test.ts test/solid-data.test.ts
  bun typecheck
  ```

**Live test.**
- Run `pilotty spawn --name t10-evict opencodeplus-dev .`.
- From its `Simple-Build` chat, delegate one report task to `Flash-Worker`
  ("run `git log -1 --oneline` and report"). Read the report, then
  `team_stop` the child. With T9 its warming is off as well.
- Keep the dev TUI open and idle for 65 minutes (`LocationActivity`'s
  60-minute limit).
- The dev log shows `location services evicted` for the child's worktree
  directory and no `location services booted` for that directory afterwards.

### T11. Eviction no longer interrupts a running step; interruptions say why

**Effort:** small. **Packages:** `packages/core`, `packages/plus`.
**Research:** question 6. **Depends on:** T2 landed.

**End state.**
- A workspace past its 60 minutes that still owns an active execution has its
  clock reset; nothing is interrupted.
- A team attempt that ends `interrupted` records the host's reason (`user`,
  `shutdown`, `superseded`, `inactivity`), and the parent's settlement notice
  shows it.

**Interfaces.**
- `packages/core/src/location-activity.ts`, the expiry pass (:53-83): when
  `owners.length > 0`, call `touch(entry.ref)` and return, instead of
  `execution.interrupt(…, { reason: "inactivity" })`. Locations with no owner
  are evicted as today.
- `packages/plus/src/teams/lifecycle.ts#onSessionEvent` (:196-198): pass the
  decoded `reason` of `session.execution.interrupted`
  (`packages/schema/src/session-event.ts:259`) to `onSessionIdle`.
- `settleAttempt` (:249) stores
  `error: { type: "session.interrupted", message: reason }` on the interrupted
  attempt.
- `childSettledText` includes it.

**Decisions.**
- Exempt rather than self-resume. With T2, a model step cannot stay silent
  past 10 minutes without a durable `session.retry.scheduled`, which already
  refreshes the clock.
- Self-resume would repeat a step every 60 minutes and hide hangs.

**Tests.**
- In `packages/core`, add to `test/location-activity.test.ts`: with
  `layer({ timeToLive: "1 second", sweepInterval: "100 millis" })` and an
  active execution at the location, after 2 s the location is still cached and
  no interrupt was requested; without one, it is evicted.
- In `packages/plus`, add to `test/teams/lifecycle-events.test.ts`: an
  `interrupted` event with `reason: "inactivity"` stores it on the attempt and
  in the parent's `child.settled` text.
- Run:
  ```sh
  # packages/core
  bun test test/location-activity.test.ts
  bun typecheck
  # packages/plus
  bun test test/teams/lifecycle-events.test.ts test/teams/lifecycle.test.ts
  bun typecheck
  ```

**Live test:** none beyond T2's. A 60-minute silent step can no longer be
produced once T2 is in.

### T12. `team_finish` says why checks are red; `team_check` says when a pass will not count

**Effort:** small. **Package:** `packages/plus`. **Research:** question 7.

**End state.**
- When `team_finish` finds a check whose latest receipt at HEAD passed but was
  recorded on a dirty tree, `E_CHECKS_RED` names that and the files, e.g.
  `"<id>: passed, but on a dirty tree (?? packages/plus/.diag.json); commit or remove those files"`.
- `team_check` results carry `dirty` and `porcelain`, plus a note when the
  result will not count for finish.

**Interfaces.**
- `packages/plus/src/teams/api.ts#finishHandler` (:600-625): for a check with no
  clean receipt, read its latest receipt at HEAD without the clean filter. If
  one passed while dirty, use `checks.ts#verifyReceipt` (:453) and its
  `dirty_tree` message as the detail, instead of
  `firstLogLine(undefined) → "failed"`.
- `packages/plus/src/teams/checks.ts#CheckResult` (:68): add `dirty: boolean`,
  `porcelain: string[]`.
- `checkHandler` (`api.ts`, near :966) returns them. When `dirty` is true it
  adds `message: "passed on a dirty tree: team_finish will run it again on a clean tree"`.

**Decisions.**
- Keep the order of the gates and the clean-tree rule. Only the reporting
  changes.

**Tests.** In `packages/plus`:
- Add to `test/teams/api.test.ts`: a run with an untracked file and a passing
  check fails `team_finish` with `E_CHECKS_RED` whose message contains
  "dirty tree" and the file name.
- Add to `test/teams/checks.test.ts`: `team_check` on a dirty tree returns
  `dirty: true` and the porcelain lines.
- Keep `test/teams/is-clean-receipt.test.ts` green.
- Run:
  ```sh
  bun test test/teams/api.test.ts test/teams/checks.test.ts test/teams/is-clean-receipt.test.ts
  bun typecheck
  ```

**Live test:** none. Simple runs no checks. The unit tests cover the Basic
path.

### T13. A relative `briefFile` resolves against the caller's checkout, with its own error

**Effort:** small. **Package:** `packages/plus`. **Research:** question 9.

**End state.**
- `team_delegate` with `briefFile: "notes/brief.md"` attaches
  `<caller checkout>/notes/brief.md`.
- A `briefFile` outside the checkout and the run directory fails `E_PATHS`
  with a message about `briefFile`, naming the resolved path and the two
  allowed roots, not the `scope.paths` message.

**Interfaces.** `packages/plus/src/teams/api.ts#delegateHandler`, the
`briefFile` block (:323-336):
- resolve with `path.resolve(parent.directory, briefFile)` before `realpath`;
- on refusal return `fail("E_PATHS", <briefFile message>, [parent.directory, runDir])`
  instead of `PATHS_MESSAGE` and `PATHS_ACCEPTED` (:119-121).

**Decisions.** Keep the error code `E_PATHS`, so callers matching on codes keep
working. Only the message and the accepted list change.

**Tests.** In `packages/plus`:
- Add to `test/teams/api.test.ts`:
  - a relative `briefFile` inside the caller's worktree is attached;
  - `briefFile: "/etc/hostname"` fails `E_PATHS`, and its message contains
    "briefFile" and not "scope.paths".
- Run:
  ```sh
  bun test test/teams/api.test.ts test/teams/brief-report.test.ts
  bun typecheck
  ```

**Live test:**
- in a dev `Simple-Build` chat, write `notes/t13.md` in the worktree;
- delegate a report task with `briefFile: "notes/t13.md"`;
- the child's Brief contains the file;
- `team_stop` the child.

### T14. Registry events no longer flood the server log

**Effort:** small. **Package:** `packages/core`. **Research:** question 9.

**End state.**
- `EventLogger` writes at most one line per event type per 10 s, with a
  `count` of the events since its last line.
- A storm stays visible (count per line) but cannot push the trimmed log's
  history out within the hour.

**Interfaces.**
- `packages/core/src/event-logger.ts#layer` (:9-17): keep `EVENT_TYPES`.
- Per type, log the first event at once, then accumulate a count and log
  `Effect.logInfo("event", { event, count })` when 10 s have passed since that
  type's last line.

**Decisions.**
- Coalesce rather than drop. These lines are how the 2026-10-04 storm was
  found.

**Tests.**
- In `packages/core`, add to `test/event-logger.test.ts`: 100 `agent.updated`
  within 1 s produce one line, and the next line after 10 s carries
  `count: 99`. Use `TestClock`.
- Run:
  ```sh
  bun test test/event-logger.test.ts
  bun typecheck
  ```

**Live test:**
- In a dev chat, run 10 `tools.instructions.set` writes in a row.
- The dev log gains at most a handful of `event.type=agent.updated` lines, not
  dozens per write.

## Not in this plan

- The Brief defaults from the report (test files in scope, a shell for
  implementers, delegate after dependencies land). The Simple team design
  covers them (`plus-1.1.12-simple-team.md` §1). Only the `briefFile` error is
  fixed here (T13).
- Why the provider side went silent (question 1), and why a chat switched to
  `Flash-B-Worker` (question 9). Neither is established, and no task can fix
  them blind.
- The planner's throttles (at most 2 children, Opus at xhigh). These are
  configuration, already changed by the Simple team.

## Done when

- T1–T14 have landed on `team-fixes` with their focused tests and
  `bun typecheck` green.
- Each live test above has been run once in the worktree's dev home, with its
  observed result written in the landing commit message or in the
  orchestrator's report.
- `team-fixes` is merged into `plus-1.1.12`.
- The user builds and activates the release.
