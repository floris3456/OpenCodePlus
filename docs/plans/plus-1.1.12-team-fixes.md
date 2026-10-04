# plus-1.1.12 team fixes: plan

**Objective:** release `plus-1.1.12` with the team fixes that cost hours on
every team run. In that release:
- warming pings keep the cache that the next real message reads (F16,
  extreme priority);
- a silent model reply ends after 10 minutes and is retried;
- a child's provider errors reach its parent as they happen;
- closed workspaces stay closed;
- one team sweep runs per server process and waits its turn for the lock;
- `team_stop` can end a working child at once, stopped runs stop warming, and
  a parent cannot restart a run it stopped;
- a team role with `<!-- requires: … -->` lines publishes once instead of
  storming;
- a relative `briefFile` works;
- registry events no longer flood the log;
- enabling a team no longer switches the agent of a chat that is open.

**Release scope (decided 2026-10-04).**
- `plus-1.1.12` = what is already on the branch (session runtime T1–T6, see
  `plus-1.1.12-session-runtime.md`) plus tasks F1–F10 and F16 below.
- The Instructions and Monitor work, still on unmerged branches, moves to
  `plus-1.1.13`. So do the team items that are large or need the new release
  first (`plus-1.1.13-team-fixes.md`, F11–F15).

Research behind every task: `docs/plans/plus-1.1.12-team-bottlenecks.md`,
"Follow-up research (2026-10-04)", questions 1–9. Line numbers are at the
commit that adds this plan.

## Who runs this

Two `Simple-Orchestrator` chats run side by side, one per purpose worktree.
Their tasks touch different files.

| Purpose worktree (branch of the same name) | Path | Tasks |
|---|---|---|
| `plus-1.1.12_team-fixes` | `/home/bliss/OpenCodePlus/worktrees/plus-1.1.12_team-fixes/opencode` | F1–F6 (`packages/plus` team code) |
| `plus-1.1.12_runtime-fixes` | `/home/bliss/OpenCodePlus/worktrees/plus-1.1.12_runtime-fixes/opencode` | F16 first, then F7–F10 (`packages/ai`, `core`, `client`, `tui`, and `packages/plus/src/tui`) |

- Both are made from `plus-1.1.12`, and both have their packages installed.
- Each orchestrator delegates its tasks to workers, reviews and lands their
  commits in its own worktree, and runs nothing else.
- When all its tasks are landed, it tells the user. `Simple-Build` (or the
  user) merges the purpose branch into `plus-1.1.12` with `git merge`.
- Building and activating the release is the user's job (skill
  `opencodeplus-release`). No fix changes the running service before then.
- Start prompts are at the end of this plan.

**Choosing a worker.**
- `Flash-B-Worker` (Gemini) is the fastest but quota-limited. Give it what
  other tasks wait on.
- `Flash-Worker` (DeepSeek through CLIProxyAPI, `deepseek-v4.1-flash-cheap`)
  is cheap with no quota, but much slower. Give it work nothing waits on, and
  start it early.
- `Heavy-Worker` (GPT-6 Astra) is for the intricate tasks marked below.

## Rules for every task

- **Tests:**
  - Run `bun test <file>` from the package directory the task names, never
    from the repository root, never the whole suite.
  - Run `bun typecheck` from every package directory the task touched.
- **Live tests:**
  - Run the worktree's own build in its own home, from the worktree you test:
    `pilotty spawn --name <the session name the task gives> opencodeplus-dev .`.
  - Kill that pilotty session afterwards.
  - That home and its server log:
    ```sh
    DEV=/home/bliss/OpenCodePlus/run/plus-dev/$(git rev-parse --show-toplevel | sed 's|^/home/bliss/OpenCodePlus/||' | tr -d '\n' | tr -c 'A-Za-z0-9._-' '-')
    LOG=$DEV/data/opencode/log/opencode.log
    DEV_TEAMS=$(find $DEV/data -maxdepth 3 -type d -name teams | head -1)
    ```
  - The first run copies the release's providers, agents and instructions
    (including the Simple team) into that home.
  - Never use `bun run dev:live` or `bun run dev`.
- **Commits:**
  - Conventional messages, e.g.
    `fix(plus): record the installed role text as the team baseline`.
  - The landing report names the commit, the tests run and the live result.
  - No `.changeset` files. No push.

## Order

**`plus-1.1.12_team-fixes`:**
- F1, F2, F4 and F6 start together.
- F3 starts after F2 has landed: it uses F2's single-try lock.
- F5 starts after F4 has landed: both add fields to `teams/run.ts#RunRecord`.
- Worker suggestions:
  - F1, F4 and F5 to `Flash-B-Worker`: other work waits on them.
  - F2, F3 and F6 to `Flash-Worker`.
  - F3 to `Heavy-Worker` if the first attempt fails its tests twice.

**`plus-1.1.12_runtime-fixes`:**
- **F16 first, extreme priority.**
  - Delegate it before anything else, to `Heavy-Worker`: getting two requests
    to match byte for byte needs care.
  - Review and land it before any other task.
  - Report it to the user the moment it lands: the user may build an interim
    release with it alone.
- F7, F8, F9 and F10 start right after F16 is delegated. They are
  independent.
  - F16 and F7 both touch `packages/core/src/session/model-request.ts`. Land
    F16 first; F7 rebases.
- Worker suggestions:
  - F7 to `Flash-B-Worker`: Effect stream timeouts across two packages,
    which F16's worker cannot take while busy.
  - F10 to `Flash-B-Worker` after F7.
  - F8 and F9 to `Flash-Worker`.

**Shared files.** Land these one after the other:
- In `team-fixes`:
  - `packages/plus/src/index.ts`: F1 (`captureBaselines`, `teamRoleOverrides`)
    and F4 (`decideWarmingFor`), in separate regions;
  - `teams/lifecycle.ts`: F3, F4, F5;
  - `teams/run.ts`: F4, then F5;
  - `teams/api.ts`: F6 (`delegateHandler`) and F5 (`statusOf`).
- Across the two worktrees, the only shared package is `packages/plus`, in
  disjoint files: F10 changes only `src/tui/active-team.tsx`.

**The unmerged branches moved to 1.1.13.** They are rebased onto this release
in `plus-1.1.13-team-fixes.md`. They overlap here:
- `team/Heavy-Implementer/t54a9ef-20261004-1204` touches
  `core/src/session/model-request.ts` :364-406 (F7 edits :414-417),
  `teams/api.ts#statusOf` (F5) and `teams/run.ts#RunRecord` (F4, F5).
- The instructions branches touch `index.ts` outside F1's region.

## Tasks in `plus-1.1.12_team-fixes`

### F1. Team role records with `requires` lines stop republishing

**Effort:** small. **Package:** `packages/plus`. **Research:** question 8.

**End state.**
- After a team member's role record containing `<!-- requires: … -->` lines is
  saved, `instructions.refresh` leaves the publish fingerprint unchanged.
- The host shows the gated role text every time.
- A team member is never installed with the empty body of its preset-created
  file while a role record exists.

**Interfaces.**
- `packages/plus/src/index.ts#captureBaselines` (:4900):
  - For an owner that is a team winner (`winnerScope.has(owner)`) and has an
    entry in `teamOverrides`, record
    `{ applied: teamOverrides.get(owner), upstream: item.text, fileBacked: false }`.
    This is exactly the text `installTeamAgents` installed.
  - Today `resolve(...)` at :4944 runs without `gate` and without the member's
    `team`, so `applied` keeps the marker lines that publish stripped.
- `packages/plus/src/index.ts#teamRoleOverrides` (:5152):
  - Return the resolved role for every team winner whose resolution is enabled
    and non-empty, even when `instructions/apply.ts#isNoop` (:348) matches the
    discovered text.
  - Reason: `instructions/teams-apply.ts#applyTeamAgent` (:186,
    `override ?? body`) otherwise falls back to the file body, which is empty
    for members created from a preset.
  - Use a team-only option of `instructions/apply.ts#roleUpdates` that skips
    the no-op test. `applyRoles` is unchanged.

**Decisions.**
- Fix the baseline, not the markers.
- Built-in members keep today's result: their override already equals the
  gated shipped body.

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
    - expect `state.fingerprint` unchanged after each call, and the same host
      system on all four reads, never `crew alpha body`.
  - The same with a member file whose body is empty: the host system is never
    `""`.
  - A scratch version of the first test failed on today's code and passed
    without the marker line. It is kept at
    `/home/bliss/OpenCodePlus/run/plus/tmp/opencodeplus/team-fixes-research/zz-scratch-requires-storm.test.ts`.
- Run:
  ```sh
  bun test test/teams-apply.test.ts test/rpc.test.ts test/discover.test.ts test/requires.test.ts
  bun typecheck
  ```

**Live test** (`t1-storm`).
- In the dev chat, use `tools.instructions.set` to put the line
  `<!-- requires: tool:team_finish -->` under `## Reporting` in
  `item:global:Simple/:Flash-Worker:system:role`.
- Wait 60 s. `grep -c 'event.type=agent.updated' $LOG` grows by fewer than 20.
- `tools.instructions.show({ id: "agent:global:Flash-Worker", view: "assembled" })`
  returns the same non-empty length three times in a row.

### F2. Fair waiting on team locks

**Effort:** small. **Package:** `packages/plus`. **Research:** question 4.

**End state.**
- Within one process, callers waiting on the same lock get it in arrival order.
- Polling the file lock (needed across processes) backs off from 25 ms to
  250 ms with jitter.
- A `timeoutMs: 0` call tries exactly once.

**Interfaces.**
- `packages/plus/src/teams/store.ts#lock` (:253):
  - Before the file lock, take the single permit of a module-level
    `Map<lockPath, Semaphore>` entry (`Semaphore.makeUnsafe(1)`), bounded by
    the same deadline.
  - Then run the existing file-lock loop, replacing the fixed sleep at :240
    with `min(250, 25 * 2^n)` plus 0–25 ms of jitter.
  - `E_LOCKED` keeps its code and message.
- `teams/store.ts#LockOptions`: document `timeoutMs: 0` as a single try.

**Decision.** The in-process queue is what fixes the jam: every contender
today was the same server pid.

**Tests.** In `packages/plus`:
- Add to `test/teams/store.test.ts` `describe("lock")` (:61-108):
  - five concurrent calls on one key acquire in call order;
  - `timeoutMs: 0` on a held lock fails `E_LOCKED` at once;
  - a lock released after 100 ms is acquired by a waiter with a 30 s timeout.
- Run:
  ```sh
  bun test test/teams/store.test.ts test/teams/merge.test.ts
  bun typecheck
  ```

**Live test:** covered by F3's.

### F3. One team sweep per process; the repository lock only when an orphan may exist

**Effort:** medium. **Package:** `packages/plus`. **Research:** question 4.
**After:** F2.

**End state.**
- However many workspaces are loaded, one sweep pass runs at a time per
  process, and passes are at least `policy.sweep.tickMs` (2 s) apart.
- `gc` runs at most every `policy.sweep.reconcileMs` (30 s).
- `gc` takes the repository lock only when a scan without the lock found a
  candidate orphan. In the background it tries the lock once and skips the pass
  when the lock is busy.

**Interfaces.**
- `packages/plus/src/teams/lifecycle.ts#startSweep` (:696):
  - Run each pass under a module-level `Semaphore.makeUnsafe(1)` with
    `withPermitsIfAvailable(1)`, plus module-level `lastPassAt` and
    `lastGcAt`.
  - Plus is imported once per process, so module state is process-wide.
  - Each workspace still forks its own loop with its own `ctx`. Whichever loop
    gets the permit runs the pass.
- `teams/lifecycle.ts#sweep` (:486): call `gc` only when
  `Date.now() - lastGcAt >= policy.sweep.reconcileMs`.
- `teams/lifecycle.ts#gc` (:504, lock at :638):
  - Call `teams/worktree.ts#orphans` (:234) without the lock first.
  - Take `lock(root, "repo", repoKey, …, { timeoutMs: 0 })` only when it
    returns candidates. The scan inside the lock stays the one that decides.
- `packages/plus/src/index.ts:196-197`: change the comment to "one pass per
  process at a time". The call stays.

**Tests.** In `packages/plus`:
- Add to `test/teams/gc.test.ts`, using its `startSweeps` helper (:150):
  - three concurrent `startSweep` loops never overlap a pass;
  - `gc` with no candidates never creates `locks/repo/<key>.lock`;
  - with the repo lock held elsewhere, a background `gc` returns at once.
- Keep :629, :753 and :905 passing.
- Run:
  ```sh
  bun test test/teams/gc.test.ts test/teams/lifecycle.test.ts test/teams/worktree.test.ts test/teams/store.test.ts
  bun typecheck
  ```

**Live test** (`t3-sweep`).
- From the dev `Simple-Build` chat, delegate three report tasks to
  `Flash-Worker` ("run `sleep 120` in the shell, then report"), so that four
  workspaces are loaded.
- While they run, sample `$DEV_TEAMS/locks/repo/` every 50 ms for 20 s. The lock
  file exists in under 5% of samples.
- `grep -c 'plus team sweep failed' $LOG` is 0.
- `team_stop` the three children.

### F4. `team_stop` can force; stopped runs stop warming; the stopper cannot restart them

**Effort:** medium. **Package:** `packages/plus`. **Research:** question 5.

**End state.**
- `team_stop({ run })` behaves as today: an idle child stops now, a working
  child stops when its turn ends.
- `team_stop({ run, force: true })` on a working child interrupts its session
  now. The run ends `stopped` when the interruption settles.
- A session whose run is `stopping`, `stopped`, `dead`, `superseded` or
  `reaped` gets no more warming pings.
- `team_followup` refuses a `stopped` run that the caller's run stopped:
  - error `E_STOPPED`, "You stopped run <run id>; delegate a fresh run and point
    its Brief at the old report";
  - runs stopped by the system (no `stoppedBy`) stay resumable.

**Interfaces.**
- `packages/plus/src/teams/schema.ts#StopInput` (:859): add
  `force: Schema.optional(Schema.Boolean)`, described as "End a working child
  now instead of after its turn."
- `packages/plus/src/teams/api-lifecycle.ts#stopHandler` (:117), working
  branch (:135-137):
  - save `stopRequested: true` and `stopRequestedBy: parent.id`;
  - when `args.force === true`, also `interruptSession(ctx, child.sessionID)`.
- `packages/plus/src/teams/lifecycle.ts`:
  - `stopIdle(ctx, root, run, by)` (:302) sets `stoppedBy: by` when `by` is
    given;
  - `onSessionIdle` (:239-241) copies `stopRequestedBy` to `stoppedBy` when it
    stops a run;
  - `consumeStopIntent` (:160) also deletes `stopRequestedBy`.
- `packages/plus/src/teams/run.ts#RunRecord` (:85 area): add optional
  `stopRequestedBy?: string` and `stoppedBy?: string`.
- `packages/plus/src/teams/api-followup.ts` (:121): `E_STOPPED` when
  `child.state === "stopped" && child.stoppedBy === parent.id`.
- `packages/plus/src/index.ts#decideWarmingFor` (:3194): first
  `bySession(teamsDataDir(), event.sessionID)`. If the run is in one of the
  states above, set `event.settings = undefined` and return.

**Decisions.**
- `force` is opt-in, so today's behaviour and its test
  (`test/teams/api-lifecycle.test.ts:180`) stay.
- `team_supersede` stays in 1.1.12. It is removed in 1.1.13 (F15).
- Warming follows the run record; there is no persisted switch.

**Tests.** In `packages/plus`:
- Add to `test/teams/api-lifecycle.test.ts`:
  - `force: true` on a working child calls `session.interrupt` once and sets
    `stopRequestedBy`;
  - without `force` there is no interrupt (the :180 test, unchanged);
  - a stopped idle child records `stoppedBy`.
- Add to `test/teams/api-followup.test.ts`:
  - followup on a child the caller stopped fails `E_STOPPED`;
  - followup on a child stopped by `reconcile` still admits.
- Add to `test/warming.test.ts`: the warming hook clears settings for a session
  whose run record is `stopped`, using a temp teams root.
- Run:
  ```sh
  bun test test/teams/api-lifecycle.test.ts test/teams/api-followup.test.ts test/teams/lifecycle.test.ts test/warming.test.ts test/teams/schema.test.ts
  bun typecheck
  ```

**Live test** (`t4-stop`).
- In the dev `Simple-Build` chat, delegate to `Flash-Worker`: "run `sleep 600`
  in the shell, then report".
- While `team_status` shows it working, call `team_stop` with `force: true`.
  `team_status` shows `stopped` within 10 s.
- After 10 minutes, `grep 'warming session' $LOG` shows no line with its
  session id after the stop.
- `team_followup` on it fails `E_STOPPED`.

### F5. A child's provider errors reach the parent as they happen

**Effort:** medium. **Package:** `packages/plus`. **Research:** question 2.
**After:** F4.

**End state.**
- When a child's step fails with a provider error and is retried, the parent
  gets one message right away and is woken if it is idle:
  "Run <run id> (<role>, <provider/model>) got <error type>: <first 200
  characters of the message>. It retries at <HH:MM UTC>, attempt <n>. Wait, or
  stop it with team_stop force and delegate the Brief to another worker."
- **When it sends:** one message per child, per attempt, per error type. It
  sends when the scheduled wait is 60 s or more, or at the third retry in a row.
  Short transient retries do not wake the parent.
- `team_status` shows `retrying: { until, attempt, error }` while a retry wait
  lies in the future, and `null` otherwise.
- Core's retry behaviour is unchanged.

**Interfaces.**
- `packages/plus/src/teams/session-events.ts`: export
  `RETRY_SCHEDULED = "session.retry.scheduled"`. Do not add it to
  `SessionRunEvents`, which the TUI monitor reads.
- `packages/plus/src/index.ts`, the `runs` subscription (:5447-5460): also pass
  `RETRY_SCHEDULED` events to `teams/lifecycle.ts#onSessionEvent`.
- `teams/lifecycle.ts#onSessionEvent` (:168), on `RETRY_SCHEDULED`.
  The payload is `{ sessionID, assistantMessageID, attempt, at, error }`
  (`packages/schema/src/session-event.ts:572`).
  - `updateRun` sets `retrying` on the run.
  - When the rule above holds and the open attempt's `notifiedErrors` lacks
    `error.type`, add it, `put(root, parent, { kind: "notify", from, text })`,
    then `deliverInbox(ctx, root, parentRecord)`.
  - `settleAttempt` and the `session.execution.started` branch clear
    `retrying`.
- `teams/run.ts#RunRecord`: optional
  `retrying?: { until: string; attempt: number; error: { type: string; message: string } }`.
  `AttemptRecord`: optional `notifiedErrors?: string[]`.
- `teams/api.ts#statusOf` (:1176): add `retrying` (future `until` only).

**Decision.** This replaces "fail the step when the wait exceeds 15 minutes".
The parent decides with what it knows, and plain chats keep today's retries.

**Tests.** In `packages/plus`:
- Add to `test/teams/lifecycle-events.test.ts`:
  - a 90 s retry for a child notifies its parent once;
  - a second retry with the same error type does not notify again;
  - a different error type notifies again;
  - a 5 s retry does not notify until the third in a row;
  - `session.execution.succeeded` clears `retrying`.
- Add to `test/teams/api.test.ts`: `team_status` shows `retrying` for a future
  `until` and `null` for a past one.
- Run:
  ```sh
  bun test test/teams/lifecycle-events.test.ts test/teams/api.test.ts test/teams/run.test.ts test/teams/inbox.test.ts
  bun typecheck
  ```

**Live test** (`t5-errors`).
- Start a stub provider:
  - `/home/bliss/OpenCodePlus/run/plus/tmp/opencodeplus/team-fixes/stub-provider.ts`,
    a Bun server on `127.0.0.1:47811`;
  - it answers `POST /v1/responses` with `429`, `retry-after: 120` and body
    `{"error":{"message":"quota reached"}}`.
- In `$DEV/config/opencode/opencode.json` (the dev home only), add a provider
  `stub`:
  - package `@opencode/ai/providers/openai`;
  - `settings: { baseURL: "http://127.0.0.1:47811/v1", apiKey: "x", transport: "http" }`;
  - model `stub-model`.
- With `tools.instructions`, make `stub/stub-model` the active model of
  `Flash-Worker` in the dev home.
- From the dev `Simple-Build` chat, delegate a one-line report task to
  `Flash-Worker`.
- Within 10 s the build chat receives the message. `team_status` on the child
  shows `retrying.until` about 2 minutes ahead.
- `team_stop` it with `force: true`, and kill the stub.

### F6. A relative `briefFile` resolves against the caller's checkout

**Effort:** small. **Package:** `packages/plus`. **Research:** question 9.

**End state.**
- `team_delegate` with `briefFile: "notes/brief.md"` attaches
  `<caller's checkout>/notes/brief.md`.
- A `briefFile` outside the checkout and the run directory fails `E_PATHS`
  with a message about `briefFile`. The message names the resolved path and
  the two allowed roots, not the `scope.paths` text.

**Interfaces.** `packages/plus/src/teams/api.ts#delegateHandler`, the
`briefFile` block (:323-336):
- resolve with `path.resolve(parent.directory, briefFile)` before `realpath`;
- on refusal, return
  `fail("E_PATHS", <the briefFile message>, [parent.directory, runDir])`
  instead of `PATHS_MESSAGE` and `PATHS_ACCEPTED` (:119-121).

**Decision.** Keep the code `E_PATHS`. Only the message and the accepted list
change.

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

**Live test** (`t6-brief`).
- In the dev `Simple-Build` chat, write `notes/t6.md`.
- Delegate a report task with `briefFile: "notes/t6.md"`. The child's Brief
  contains the file.
- `team_stop` the child.

## Tasks in `plus-1.1.12_runtime-fixes`

### F16. Warming pings keep the cache that the next real message reads (extreme priority)

**Effort:** medium. **Package:** `packages/core`. **Evidence:** research,
question 9 ("Warming keeps the wrong cache warm").

**Why first.** Today warming saves nothing and costs extra.
- A ping and a real step share only the first ~37k tokens (in this chat; 8,715
  earlier in the day).
- So the first ping after any new history re-sends ~250k tokens uncached.
- The first real message after a pause still misses the cache: on 2026-10-04
  at 16:05, 36,901 of 298,033 tokens were read from cache.
- Opus warming is switched off until this is released (see "After both purpose
  branches are merged").

**End state.**
- A warming ping sends exactly the prefix that the session's next real step
  will send: the same tools, the same system prompt, and the same history
  (messages, order, parts and text). Only the ping prompt is added, after the
  last history message.
- Live, through CLIProxyAPI with `claude-opus-5-5`:
  - the first ping after work reads at least 90% of its input from cache;
  - the first real step after 6 minutes of pinging reads at least 90% from
    cache.

**Interfaces.**
- Ping today: `packages/core/src/session/generate.ts#generate` (:22-76).
  - History from `SessionHistory.preview` (:42).
  - Request from `context.request.generate` (:55).
  - Instruction updates appended as a System message before the prompt (:63).
- Real step: `packages/core/src/session/runner/llm.ts#runStep` (:206-297).
  - History from `prepareContext` + `context.load` (:215).
  - Then `SessionModelRequest.baseTranscript` (:224), then
    `context.request.primary` (:231).
- `packages/core/src/session/model-request.ts`:
  - the two kinds run different plugin hooks: `agentHook("context")` vs
    `agentHook("generate")` (:447-454);
  - they set the output limit differently (:279-282).
- Step 1: write the test below. It names the first part where the two requests
  differ.
- Step 2: build the ping from the same history loading and the same request
  preparation as a primary step, including the hooks that change request
  content. Then append the prompt.
  - `generate` keeps its promise not to change the session.
  - Titles keep their own path.

**Decisions.**
- The contract is an identical prefix, pinned by the test.
- If the content is identical but a real step after pings still reads less
  than 90% live, the remaining cause is where CLIProxyAPI places its cache
  breakpoints. Then stop and report the two `session generation usage
  diagnostic` lines and the step's monitor numbers. Do not change anything on a
  guess.

**Tests.** In `packages/core`:
- New `test/session-warming-prefix.test.ts`, using the scripted-model harness of
  `test/session-runner.test.ts`, with one session:
  - a primary step that calls a tool and then answers;
  - `SessionGenerate.generate` with the warming prompt;
  - a second user message, which runs a primary step.
- Capture the three `LLMRequest`s and assert:
  - the ping's tools and system equal the second step's;
  - the ping's messages without the prompt equal the second step's messages
    without the new user message.
- Repeat it for a session with a compaction checkpoint and for one with an
  instruction update.
- Run:
  ```sh
  bun test test/session-warming-prefix.test.ts test/plugin/warming.test.ts test/session-runner.test.ts test/session-model-request.test.ts
  bun typecheck
  ```

**Live test** (`t16-warm`).
- The dev home copies Opus warming "off" from the release. Turn it on there
  only, from the dev chat:
  `tools.instructions.set({ id: "item:defaults:/models:modeldefault:cliproxyapi/claude-opus-5-5", state: "on", interval: "2m" })`.
- As `build` on `cliproxyapi/claude-opus-5-5`, send two messages that make it
  run a few tool calls. Note the time.
- Wait 5 minutes. In `$LOG`, the first `session generation usage diagnostic`
  line after that time shows `cacheReadInputTokens` at 90% or more of
  `inputTokens`.
- Send a message. `tools.monitor.query({ scope: "session", sessionID, since: <send time − 5 s>, until: <send time + 30 s> })`
  shows at least 90% read from cache.
- Turn the dev home's warming off again.

### F7. A no-data timeout on HTTP model replies

**Effort:** medium. **Packages:** `packages/ai`, `packages/core`.
**Research:** question 1.

**End state.**
- An HTTP model request fails with a retryable transport error when no
  response headers arrive within the idle timeout, or when the response body
  sends no bytes for that long. The session retries the step as for any
  transport error.
- The default is 10 minutes. The provider setting `chunkTimeout` (ms) overrides
  it.
- Only the model's own reply is timed. Tool calls, delegation and waiting on
  children have no model request open and are never affected.

**Interfaces.**
- `packages/ai/src/route/transport/index.ts#TransportExecuteOptions` and
  `packages/ai/src/route/client.ts#StreamOptions` (:183): add
  `readonly idleTimeout?: Duration.Input`. `streamPrepared` (:424) already
  passes the options to `transport.execute`.
- `packages/ai/src/route/transport/http.ts#httpJson` `execute` (:90), when
  `idleTimeout` is set:
  - wrap `runtime.http.execute(...)` in `Effect.timeoutOrElse`, failing with
    `TransportError { transport: "http", code: "idle-timeout", operation: "request", phase: "receive", delivery: "ambiguous" }`;
  - wrap the byte stream `RequestExecutor.responseStream(response)` in
    `Stream.timeoutOrElse`, the same shape as
    `core/src/session/model-transport.ts` :417-429, with
    `operation: "read", delivery: "accepted"`;
  - measure bytes before framing, so SSE pings count as data.
- `packages/ai/src/protocols/open-responses-channel.ts`: its `execute` (:179)
  passes `executeOptions` to both `http.execute` calls (:181, :192).
- `packages/core/src/session/model-request.ts`:
  - the returned `options` (:414-417) gain
    `idleTimeout: model.chunkTimeout ?? HTTP_IDLE_TIMEOUT`;
  - `const HTTP_IDLE_TIMEOUT = "10 minutes"` sits beside that module's other
    constants;
  - the WebSocket path keeps its 30 minutes unless `chunkTimeout` is set.

**Decision.** 10 minutes. Thinking almost never takes that long (the user's
observation, 2026-10-04), and the hung replies on 2026-10-04 lasted 35–66
minutes. `provider-error.ts#isRetryable` (:75-79) already retries these error
shapes.

**Tests.**
- In `packages/ai`, add to `test/route.test.ts`, using a test `HttpClient` layer
  and `TestClock`:
  - a body that sends one SSE chunk and then nothing fails with `Transport`
    `idle-timeout`, and `isRetryable` is true;
  - headers that never arrive fail with `operation: "request"`;
  - a body that keeps sending `: ping` lines never times out.
- In `packages/core`, add to `test/session-model-request.test.ts`: the prepared
  `options.idleTimeout` is `"10 minutes"` by default, or the `chunkTimeout`
  value when set.
- Run:
  ```sh
  # packages/ai
  bun test test/route.test.ts test/executor.test.ts test/provider-error.test.ts
  bun typecheck
  # packages/core
  bun test test/session-model-request.test.ts test/session-model-transport.test.ts test/session-runner.test.ts
  bun typecheck
  ```

**Live test** (`t7-idle`).
- Use F5's stub-provider setup, but the stub answers `200` with
  `content-type: text/event-stream`, writes one `: ping\n\n`, then holds the
  connection open.
- Give the `stub` provider `chunkTimeout: 20000`.
- Prompt it from the dev chat. Within about 25 s the chat shows a retry
  instead of waiting forever.
- Kill the stub and the session.

### F8. A closed workspace stays closed

**Effort:** small. **Package:** `packages/client`. **Research:** question 3.

**End state.** The client refetches providers, models, agents or commands after
an `*.updated` event only for workspaces it already holds. The events a
workspace publishes while shutting down no longer load it again.

**Interfaces.** `packages/client/src/solid/data.ts`, the event switch
(:1208-1223):
- for `provider.updated`, `model.updated`, `agent.updated` and
  `command.updated`, still invalidate;
- call `refresh(() => … .sync(location))` only when that catalog's
  `list(location)` is defined or `sync.has(...)` holds for it. This is the
  pattern `config.updated` uses at :1275-1278.

**Decision.** Fix the client, which sends the request that loads the workspace
again. Core still publishes the events.

**Tests.**
- In `packages/client`, add to `test/solid-refresh.test.ts`, beside its
  `config.updated` cases:
  - an `agent.updated` for a location the store never loaded sends no request;
  - one for a loaded location refetches;
  - the same two for `command.updated`.
- Run:
  ```sh
  bun test test/solid-refresh.test.ts test/solid-eviction.test.ts test/solid-data.test.ts
  bun typecheck
  ```

**Live test** (`t8-evict`).
- From the dev `Simple-Build` chat, delegate one report task to `Flash-Worker`
  ("run `git log -1 --oneline` and report").
- Read the report, then `team_stop` the child.
- Leave the dev TUI open and idle for 65 minutes.
- `$LOG` shows `location services evicted` for the child's worktree directory
  and no `location services booted` for it afterwards.

### F9. Registry events no longer flood the server log

**Effort:** small. **Package:** `packages/core`. **Research:** question 9.

**End state.**
- `EventLogger` writes at most one line per event type per 10 s, with a `count`
  of the events since its previous line.
- A storm stays visible but cannot push the log's history out within the hour.

**Interfaces.** `packages/core/src/event-logger.ts#layer` (:9-17):
- keep `EVENT_TYPES`;
- per type, log the first event at once, then count, and log
  `Effect.logInfo("event", { event, count })` once 10 s have passed since that
  type's last line.

**Decision.** Coalesce instead of dropping. These lines are how the 2026-10-04
storm was found.

**Tests.**
- In `packages/core`, add to `test/event-logger.test.ts`: with `TestClock`,
  100 `agent.updated` within 1 s produce one line, and the next line after 10 s
  carries `count: 99`.
- Run:
  ```sh
  bun test test/event-logger.test.ts
  bun typecheck
  ```

**Live test** (`t9-log`). In the dev chat, make 10 `tools.instructions.set`
writes in a row. `$LOG` gains at most a few `event.type=agent.updated` lines.

### F10. Enabling a team no longer switches the agent of an open chat

**Effort:** small. **Packages:** `packages/plus` (`src/tui` only),
`packages/tui`. **Research:** question 9, cause found afterwards.

**Cause (established).**
- When the enabled team changes, every open TUI does two things:
  - it makes that team the active ring;
  - it calls `agents.set(first)` with the first installed member
    (`packages/plus/src/tui/active-team.tsx:157-180`).
- Members are sorted by id, so for Simple that is `Flash-B-Worker`.
- `set` also stores it as the agent of the chat on screen
  (`packages/tui/src/context/local.tsx:175`).
- On top of that, `current()` falls back to the ring's first entry whenever
  the chat's agent is not in the ring (`local.tsx:149`).
- On 2026-10-04 a tool call enabled Simple at 13:08:23. The next message from
  the open `build` chat (13:35:39) ran as `Flash-B-Worker`.

**End state.**
- When the enabled team changes:
  - an open chat keeps its agent;
  - on the home screen the ring changes and its first member is selected, as
    today.
- In a chat whose agent is outside the active ring, the composer still shows
  and sends that agent.

**Interfaces.**
- `packages/plus/src/tui/active-team.tsx`, the effect at :159-180: call
  `context.ui.agents.set?.(first)` only when
  `context.ui.router.current().type !== "session"`. The active group is still
  set.
- `packages/tui/src/context/local.tsx#createAgent` `current()` (:140-150):
  look `selected` up in `availableAgents()` before falling back to
  `agents().at(0)`.

**Tests.**
- In `packages/plus`, change `test/active-team.test.tsx:213`. On the home
  route the test stays as it is. Add a session-route case: the agent is
  unchanged after the server enables a team.
- In `packages/tui`, add to `test/context/local-selection.test.tsx`: a session
  whose agent is not in the active group still reports that agent from
  `current()`.
- Run:
  ```sh
  # packages/plus
  bun test test/active-team.test.tsx
  bun typecheck
  # packages/tui
  bun test test/context/local-selection.test.tsx test/context/agent-groups.test.tsx
  bun typecheck
  ```

**Live test** (`t10-switch`). Check it in a real terminal with pilotty.
- Open a dev chat as `build` and send one message.
- From a second pilotty session on the same dev home, enable Basic with
  `tools.instructions.set({ id: "team:global:Basic", state: "on" })`.
- The first chat's footer still shows `build`, and its next message runs as
  `build`.
- Switch the team back on (`team:global:Simple`).

## After both purpose branches are merged and the release is active

Steps for `Simple-Build` or the user, through `tools.instructions`:
1. Put the `<!-- requires: … -->` lines back into the five Simple role bodies,
   as written in `plus-1.1.12-simple-team.md` §5. Check that
   `event.type=agent.updated` stays flat for a minute (F1).
2. In the `## Watching runs` section of `Simple-Orchestrator` and
   `Simple-Build`:
   - replace "supersede it, delegate the same Brief to another member of its
     kind" with "stop it with team_stop force:true, delegate the same Brief to
     another member of its kind";
   - add after the timer paragraph: "A child's provider errors reach you as
     messages while it retries (F5): read them and decide whether to wait."
3. Turn Opus warming back on (switched off on 2026-10-04 until F16 is
   released). Reset only the warming field, so it comes from the provider
   config again, as before:
   `tools.instructions.reset({ id: "item:defaults:/models:modelsetting:warming:cliproxyapi/claude-opus-5-5" })`.
   `show` on `item:defaults:/models:modeldefault:cliproxyapi/claude-opus-5-5`
   then reads "warm 32m · every 4m".
4. Restart the TUI.

## Start prompts

Open a TUI in each purpose worktree, pick `Simple-Orchestrator`, and send:

**`plus-1.1.12_team-fixes`:**
```text
You are in purpose worktree plus-1.1.12_team-fixes of release plus-1.1.12.
Do tasks F1–F6 of docs/plans/plus-1.1.12-team-fixes.md, in its order and by
its rules. Land each task here with its focused tests and bun typecheck green
and its live test run, then report per task: commit, tests, live result.
When all six are landed, tell me; do not merge into plus-1.1.12.
```

**`plus-1.1.12_runtime-fixes`:**
```text
You are in purpose worktree plus-1.1.12_runtime-fixes of release plus-1.1.12.
Do task F16 first (extreme priority), then F7–F10, of
docs/plans/plus-1.1.12-team-fixes.md, in its order and by its rules. Land each
task here with its focused tests and bun typecheck green and its live test
run, then report per task: commit, tests, live result. Tell me the moment F16
is landed. When all five are landed, tell me; do not merge into plus-1.1.12.
```
