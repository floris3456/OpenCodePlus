# plus-1.1.12 team run: bottleneck report

Written 2026-10-04 around 11:10 UTC. All times are UTC (the worktree names use
local time, UTC+2).

Scope: the three orchestrators delegated at 01:01 for the plus-1.1.12 plans, and
their 40+ children.

| Part | Orchestrator run | Plan |
|---|---|---|
| Cache & compaction | `w-faa67c8d26bfb173` | `docs/plans/plus-1.1.12-session-runtime.md` |
| Instructions | `w-5799d74eefd13351` | `docs/plans/plus-1.1.12-instructions.md` |
| Monitor | `w-109248125d41b3fd` | `docs/plans/plus-1.1.12-monitor.md` |

## Summary

Ten hours after delegation, none of the three parts had finished. Per part,
roughly 7 to 9 of those hours went to infrastructure, not to the work. Six
causes, ranked by time lost:

1. **Hung model steps (about 4 h per part).** No timeout ends an HTTP model
   stream that goes silent. The only thing that ends one is the 60-minute
   workspace eviction, which interrupts the run.
2. **Gemini quota ran out and was retried as a short rate limit (about 4 h on
   the critical path).** Children stayed "working" for 2.5 to 4 hours, and
   their parents waited on them.
3. **A jam on the repository lock that grows every hour (about 1 h so far, and
   rising).** Every workspace's Plus plugin runs its own team cleanup pass
   every 2 seconds under the shared lock.
4. **Briefs blocked their children (6 children, 15–60 min each).** Test files
   or needed files were out of scope, and one role has no shell to run its
   tests.
5. **Integration failures from overlapping tasks** (2 tasks redone).
6. **Throttles imposed by the planner:** at most 2 children per orchestrator,
   and Opus at xhigh effort for every orchestrator step.

## Sources

- `run/plus/data/opencodeplus/teams/runs/*/run.json`: attempts, the state
  history and the provider error of each attempt.
- `teams/audit.log`: every team tool call with its duration and error code.
- `teams/runs/<parent>/merge/*.json`: the merge queue and the state history of
  each merge entry (corrected below).
- `teams/runs/*/receipts/`: check receipts and logs.
- `run/plus/data/opencodeplus/log/opencode.log`: the server log (workspace
  boot and eviction, warming, usage, sweep failures).
- Sampling of `teams/locks/repo/opencode.lock` at 50 ms intervals.
- Source at plus-1.1.12. The running server is release `2.0.18-plus-1.1.12`.

## 1. Model steps that hang, with nothing to cut them off

**What happened.** An orchestrator step sent to Opus through CLIProxyAPI got no
answer for 35–66 minutes. There were thirteen such steps:

| Orchestrator | Silent steps |
|---|---|
| Cache & compaction | 01:02–02:04, 02:05–03:06, 05:29–06:29, 09:00–10:00 |
| Instructions | 01:02–02:02, 02:02–03:04, 07:46–08:46, 09:19–09:55, 10:03–10:41 |
| Monitor | 01:02–02:03, 02:05–03:05, 08:00–09:01, 09:17–09:57 |

**Evidence.**
- During each window there was no team tool call and no process spawn in that
  orchestrator's worktree.
- The windows that ended near 60 minutes match a `location services evicted`
  line, and the attempt was marked interrupted at that second.
- That accounts for all 10 interrupted attempts (4, 3 and 3). The planner
  resumed them by hand 8 times.

**Cause.**
- `packages/core/src/session/model-transport.ts` has a "no data" timeout
  (`IDLE_TIMEOUT`, 30 minutes) only on the WebSocket path. The HTTP/SSE path
  (`exchange.fallback()`) has none, and `@opencode/ai` adds no per-chunk
  timeout to HTTP streams. CLIProxyAPI is reached over HTTP (corrected below).
- The only thing that ends a silent step is `LocationActivity`
  (`packages/core/src/location-activity.ts`). After 60 minutes without durable
  session events at a workspace, it interrupts that workspace's executions
  (reason `inactivity`) and evicts it.
- A team run hit that way is "interrupted". It does not resume until someone
  sends a followup or a child's settlement wakes it.
- `teams/schema.ts` defines `timeouts.stallMs` (10 minutes), but nothing reads
  it.

Not established: why the provider side went silent (CLIProxyAPI or upstream).
The client side has no guard either way.

## 2. Gemini quota exhausted, retried as a short rate limit

**What happened.** Around 03:50, Gemini 3.8 Flash (the Flash-B-Implementer
role) started answering 429 with this message:

> All credentials for model gemini-3.8-flash-high are cooling down … Individual
> quota reached … Resets in 4h46m17s

Four children on that role stayed in state `working` until their attempts
failed with `provider.rate-limit` (corrected below):

| Child | Task | Running | Parent |
|---|---|---|---|
| `w-f15454a0a1ed9809` | T23 | 03:10 → failed 07:45 | instructions |
| `w-f4da7ff23b519f9e` | T26 | 03:10 → failed 08:00 | instructions |
| `w-b8127bf1d3bbc5dc` | T30 | 03:37 → failed 07:45 | cache & compaction |
| `w-1e010d97417326ff` | T31 | 03:38 → failed 08:00 | monitor |

**Cause (corrected below).** `packages/core/src/session/runner/retry.ts` retries `RateLimit` up
to 10 times. It honours the provider's retry-after up to `RETRY_AFTER_MAX` (15
minutes) per retry. That is up to 2.5 hours of silent retrying against a quota
that resets in almost 5. A retrying child looks the same as a working one in
`team_status`, and nothing notifies its parent.

**Side effect.** Warming kept pinging the Gemini sessions after the quota ran
out: 291 failed pings from 03:54 to 09:00 (`failed to warm session`). Warming
did not cause the exhaustion (27 Gemini pings before 04:00).

### Why the orchestrators did not move to another implementer sooner

They did move, in new chats, as soon as they learned of the failure. They
learned late:

- **No signal.** An orchestrator wakes only on a child's settlement or a
  followup. The stuck children did not settle until their retries ran out
  (07:45–08:00).
- **No free slot.** The planner's Brief allowed at most 2 children at once.
  The instructions orchestrator had exactly two, both on Gemini, so it could
  not start a replacement beside them. It was idle from 03:11 to 07:45.
- **Gemini looked healthy to the cache & compaction orchestrator.** At 06:30
  it delegated T34 on Flash-B again. That child did finish (08:38): the proxy
  rotates credentials, and some recovered.
- **Heavy-Implementer had already failed twice.** T25 (03:10) and T32 (05:29)
  both ended blocked: that role has no shell, so it cannot run its tests
  without registered checks.
- **The reaction once a failure arrived:**
  - Cache & compaction superseded T30 at 07:46:05 and delegated a
    Flash-Implementer (DeepSeek) at 07:46:21.
  - Instructions read the failure at 07:46, then its next step hung for an
    hour (bottleneck 1). It replaced both children with Flash-Implementers at
    08:47.
  - Monitor read the failure at 08:00, hung until 09:01, then delegated a
    Flash-Implementer at 09:03.

## 3. Repository-lock jam

**What happened.** Saving work (`team_checkpoint`), starting a child
(`team_delegate`) and merging (`team_integrate`) all need the per-repository
file lock `teams/locks/repo/opencode.lock`. More and more of these calls time
out after 30 seconds with `E_LOCKED`.

**Evidence.**
- **Lock sample, 10:56:43–10:57:00.** The server process held the lock in
  back-to-back holds of about 300 ms each. It was free only in roughly 50 ms
  gaps, about once a second: busy about 95% of the time.
- **The cleanup pass itself fails on the lock.** The server log has
  `plus team sweep failed … Lock repo:opencode busy` 4,345 times. Per hour:
  8 (03:00), 8 (05:00), 48 (06:00), 31 (07:00), 543 (08:00), 1,430 (09:00),
  2,276 (10:00).
- **Open workspaces** (booted minus evicted): 3 at 00:50, 22 at 03:30, 30 at
  08:30, 36 at 09:30, 42 at 10:30.
- **E_LOCKED failures in the audit log:** 42 (19 checkpoint, 16 integrate, 7
  delegate).
- **One merge took 11 tries.** The merge queue for `w-6c06a166ba8d4848` (cache
  & compaction) shows it from 10:14 to 10:47:
  - It was stuck in `rebasing`: the lock for the temporary worktree could not
    be taken.
  - It was stuck in `landing` after its checks had already passed.
  - It landed on the 11th try, after 33 minutes.
- **The jam continues.** At 11:01–11:03 the instructions orchestrator failed
  `team_integrate` three times in a row.

**Cause.**
- `packages/plus/src/index.ts:172` (corrected below) calls `startSweep` inside the plugin's
  effect. The plugin is instantiated once per workspace, so every open
  workspace runs its own sweep. The comment above it says "one tick, one
  place".
- `teams/lifecycle.ts` `startSweep` repeats every `sweep.tickMs` (2,000 ms).
  `gc` reads every run record and merge entry each pass. Then it takes the repo
  lock for the orphan scan (`lifecycle.ts:638`: `git worktree list` plus a
  realpath for each worktree) on every pass, whether or not anything could be
  an orphan.
- `teams/store.ts` `lock` polls every 25 ms with no queue and gives up after
  30 s. Forty pollers starve the rare real operation.
- `teams/merge.ts` `process` takes the repo lock again for the landing step,
  after the checks have run. A timeout there throws away a verified merge,
  and the next call reruns every check (corrected below).

Not established: why the workspaces are not released. The count grows with
every child, and evicted orchestrator workspaces re-boot within the same
second. Warming pings on finished sessions are a likely contributor
(corrected below).

**Side effects.**
- Every worktree, including every temporary merge worktree, gets a full
  `bun install` (`node_modules` 3.1 GB, about 210k files). This takes about
  10 s on btrfs with the cache, so it is not slow.
- Four temporary merge worktrees (`teams/worktrees/opencode/merge/*`, about
  3.3 GB each) were left behind because their cleanup also needed the lock
  (corrected below).

## 4. Briefs that blocked their children

Six children ended blocked for reasons the Brief could have prevented. Each one
cost a supersede plus a fresh child re-reading the code:

| Child | Task | Blocked because |
|---|---|---|
| `w-a779a31806d6fc78` | T29 | Test files run by its checks were not in `scope.paths`. |
| `w-5ab36fefe733e036` | T41 | Test files not in scope. Also, `team_finish` reported all four checks red while `team_check` at the same HEAD passed them (unexplained). (corrected below) |
| `w-e12f29a0b414bcaa` | T32 | `quota/register.ts` and a test file were out of scope. It also needed a sibling's file. |
| `w-3fc0816475ddf514` | T38 | `core/src/session/context.ts` was out of scope. |
| `w-dee21a04426c57fd` | T25 | Heavy-Implementer has no shell, so its tests had to be registered as checks first. |
| `w-a8ff90abaf0b09eb` | T37 | Its check depended on a parent commit that had not been integrated yet. |

Refused calls in the audit log:

| Refusal | Count |
|---|---|
| `team_checkpoint` `E_SCOPE` | 20 |
| `team_delegate` `E_PATHS` (mostly the relative `briefFile` path, reported as a scope error) | 10 |
| `team_finish` `E_CHECKS_RED` | 6 |
| `team_finish` `E_SUMMARY` | 5 |
| `team_integrate` `E_NOT_DONE` | 3 |

## 5. Integration failures from overlapping tasks

- Monitor T3 (`w-315ded470d504aee`) was done, but failed the parent's
  `monitor` and `team-tab` checks on the rebased commits.
- Monitor T2 (`w-750a5ac9f0d99f5c`) was done, but failed `monitor`.
- Both are being redone together as `T33.rework.1`.

## 6. Throttles imposed by the planner

- At most 2 children per orchestrator. This came from the 12-live-run
  namespace cap and the planner's Brief.
- Orchestrators run on Opus at xhigh effort, and every orchestrator step goes
  through it.

## Smaller costs

- **Warming today:** 281 completed pings, 43.8M input tokens, 72% read from
  cache. 75 pings were mostly uncached (12.3M uncached tokens). Pings continue
  on sessions whose step is hung.

## Time lost per part (approximate)

| Part | Hung steps | Waiting on Gemini children | Lock and merge retries |
|---|---|---|---|
| Cache & compaction | ~4 h | most of 03:47–07:45 | ~40 min (08:52–08:59, 10:16–10:48) |
| Instructions | ~4 h 15 min | 03:11–07:45 | starting at 11:01 |
| Monitor | ~3 h 40 min | 03:47–05:28, plus one child slowed on Gemini 06:10–09:19 | a few minutes so far |

## Proposed fixes

Source fixes take effect only after a new release is activated. The running
server is the installed release.

1. **HTTP model streams.** Add a "no data" timeout of a few minutes on the
   HTTP/SSE path (core `model-transport.ts` fallback, or the `@opencode/ai`
   HTTP route), so a silent stream becomes a normal retryable transport error.
   Use `teams/schema.ts` `timeouts.stallMs` to flag a team run with no progress.
2. **Long rate limits.** When retry-after is longer than about 15 minutes (or
   the body says the quota is exhausted), fail fast with a clear error instead
   of retrying for hours. Show "retrying until …" in `team_status`. Stop
   warming pings on rate-limited or hung sessions.
3. **Team lock.**
   - Run one sweep per server process, not per workspace.
   - Take the repo lock in `gc` only when a candidate orphan exists.
   - Give the lock a queue or a fairer backoff.
   - Do not discard verified checks when the landing step loses the lock:
     retry the landing alone.
   - Remove leftover merge worktrees.
4. **Interrupted team runs.** Resume them automatically after an `inactivity`
   interruption, or exempt a team session with a live step from eviction once
   fix 1 bounds silent steps.
5. **Brief defaults.**
   - Allow each touched package's `test/*` in scope.
   - Give implementers a way to run their tests (a shell, or the test commands
     registered as checks).
   - Delegate a task only after the work it depends on has landed.
   - Report a relative `briefFile` as such, not as a scope error.

## Follow-up research (2026-10-04)

Written 14:50–15:40 UTC against source at `6f394c15ca` (branch
`plus-1.1.12`). Each answer marks what is **established** (read in source, or
seen in a record or log) and what is **inferred**.

**About the evidence.**
- The server log is trimmed in place: past 50 MB it keeps the last 25 MB
  (`packages/util/src/observability/logging.ts:9-11`, `trim` at :86). The
  13:09–14:01 republish storm (question 8) wrote 127,522
  `event.type=agent.updated` lines, so the log now starts at
  `2026-10-04T11:32:58Z`. The log-derived counts in sections 1–3 above can no
  longer be re-checked.
- What remains:
  - `teams/runs/*/run.json` (attempts, state history);
  - `teams/audit.log`;
  - the merge entries and receipts;
  - the monitor database, read through `tools.monitor.query`;
  - the log from 11:32 onward.
- The server process restarted at 12:13:14 (log `run=fe8d592a`, same release).
  The old process logged 1,855 `plus team sweep failed` lines between 11:32 and
  12:12. The new one has logged none, because only a few workspaces are loaded.

### 1. Silent HTTP model streams

**Answer.** Neither the HTTP request nor its response stream has any timeout
on the route CLIProxyAPI uses. The no-data timeout belongs in `@opencode/ai`'s
HTTP transport, `packages/ai/src/route/transport/http.ts#httpJson` `execute`,
with the value passed down from core.

**Evidence (established).**
- CLIProxyAPI is configured as `package: "@opencode/ai/providers/openai"` with
  `settings.transport: "http"` and no `chunkTimeout`
  (`~/.config/opencodeplus/opencode.json`, secrets not read).
- Core binds the WebSocket executor only when
  `input.webSocket === "session" && model.transport === "websocket"`
  (`packages/core/src/session/model-request.ts:388-412`). For CLIProxyAPI,
  `SessionModelTransport` and its `IDLE_TIMEOUT` (`model-transport.ts:25`,
  :417-429) are never reached. The report's "HTTP/SSE path
  (`exchange.fallback()`)" is not the path these steps took either.
- Both HTTP paths end in `httpJson.execute` (`transport/http.ts:90-98`):
  - the plain route;
  - the Open Responses route, which calls `http.execute` when no WebSocket is
    supplied (`protocols/open-responses-channel.ts:181`) and for its fallback
    (:192).
- `httpJson.execute` waits for headers with `runtime.http.execute(...)` and then
  streams `RequestExecutor.responseStream(response)` (`route/executor.ts:212-217`).
  There is no timeout on either.
- `chunkTimeout` already exists as a provider setting
  (`packages/schema/src/config/provider.ts:13`, read at
  `core/src/model-resolver.ts:395`). On native `@opencode/ai` routes it only
  feeds the WebSocket idle timeout (`model-request.ts:410`). Only AI-SDK
  packages apply it to HTTP (`core/src/aisdk.ts:131-162`, `wrapSSE`).
- The silent windows are visible in the monitor. The longest gap between tool
  calls in each orchestrator session:
  - cache & compaction (`ses_efb920b7…`): 09:00–10:01;
  - monitor (`ses_efb9191b…`): 09:19–09:57.

  Each attempt ended `interrupted` at the end of a window (`run.json`
  attempts). The final count is 4 interrupted attempts per orchestrator. The
  fourth one for instructions (11:47) and for monitor (11:37) was the planner's
  `team_stop`, not eviction.

**Not established:** why the stream went silent on the provider side. The
`IDLE_TIMEOUT` comment ("reasoning models can stream nothing for several
minutes") also applies to HTTP. The timeout has to measure bytes, not parsed
events, so SSE comments and pings keep it alive.

### 2. How 429 retry waits are chosen; when to stop retrying

**Answer.**
- A 429 is classified in `@opencode/ai`, then retried by core.
  `classifyProviderFailure` (`packages/ai/src/provider-error.ts:177`) returns
  `QuotaExceeded` (not retried, :88) only for 402, a known quota code, or a 429
  whose text matches `QUOTA_TEXT` (:147: `insufficient quota`,
  `quota exceeded`, `budget exceeded`, `usage limit`).
- CLIProxyAPI's text ("All credentials … cooling down … Individual quota
  reached … Resets in 4h46m17s") matches none of them, so it became
  `RateLimit` (:211-222) with `retryAfterMs` taken from `retry-after-ms` or
  `retry-after` (`route/executor.ts:23-36`).
- `runner/retry.ts` waits `max(backoff, min(retryAfter, 15 min))` (:31-56),
  for at most 10 retries **per logical step**: `SessionRunnerRetry.make` runs
  once per `runStep` (`runner/llm.ts:209`). A success resets the count.
- The Plus quota hook (`plus/src/quota/register.ts:64`,
  `quota/controller.ts:341`) overrides the decision only for CPA `quota_*`
  codes, which this was not.
- **Threshold to adopt:**
  - A provider wait longer than `RETRY_AFTER_MAX` (15 min) ends the step now
    with the reset time in the error, instead of being clamped and retried.
  - Waits up to 15 minutes keep retrying as today.

**Evidence and correction.** Monitor, per child session:

| Child | First call | Silent | Worked again | Silent until failure |
|---|---|---|---|---|
| T23 | 03:10 | 03:50:54–05:17:23 | 05:17–05:30:50 | → 07:45:58 |
| T26 | 03:11 | 03:50:50–05:17:22 | 05:17–05:30:37 | → 08:00:43 |
| T30 | 03:38 | 03:50:49–05:17:16 | 05:17–05:30:35 | → 07:45:43 |
| T31 | 03:39 | 03:51:26–05:17:16 | 05:17–05:30:37 | → 08:00:42 |

- The children were not stuck from 03:50 to their failure. All four went quiet
  within 40 s of each other, came back within 7 s of each other at 05:17,
  worked for 13 minutes, then went quiet again.
- The second silence lasted 135 and 150 minutes: exactly 9 and 10 waits of the
  15-minute clamp.
- Backoff alone totals at most about 101 s (comment at `retry.ts:42-44`). So
  the provider sent a retry-after of at least 15 minutes (inferred from that
  arithmetic; the header itself was not recorded).
- The simultaneous return at 05:17 fits the proxy reporting the end of a
  credential cooldown rather than the 4h46m quota reset (inferred).

**"Retrying until …" in `team_status` (established that it is feasible).**
- Every wait publishes the durable `session.retry.scheduled` event, with `at`
  and `attempt` (`packages/schema/src/session-event.ts:572`, published at
  `retry.ts:96-102`).
- Plus already subscribes to session events for runs
  (`plus/src/index.ts:5447-5460`, `teams/lifecycle.ts#onSessionEvent`) but
  ignores this one.
- `team_status` (`teams/api.ts#statusOf`, :1176) has no field for it.

### 3. Why workspaces never unload; why they re-boot within a second

**Answer (established).**
- Workspaces do get evicted after 60 minutes without durable session events
  (`packages/core/src/location-activity.ts:33-84`).
- But every eviction is undone within 0.08–1.7 s. Shutting the workspace down
  makes Plus remove its agent registrations (`plus/src/index.ts#deactivate`),
  and each removal publishes `agent.updated` tagged with that workspace
  (`core/src/agent.ts:93`).
- The client re-fetches agents and commands for every workspace named in such
  an event (`packages/client/src/solid/data.ts:1216-1223`). Unlike
  `config.updated` (:1275-1278), it does not check whether it ever loaded that
  workspace.
- That request boots the workspace again (`server/src/location.ts:64`).
- The open-workspace count therefore only grows: 3 → 42 in the old process.

**Evidence.**
- In the current log, all 30 evictions are followed by a boot of the same
  directory. Examples:

  | Directory | Evicted | Booted again |
  |---|---|---|
  | `Orchestrator/t131092-20261004-0301` | 11:34:07.826 | 11:34:09.153 (`http.span` = boot duration, 936 ms) |
  | `/home/bliss/OpenCodePlus` | 13:14:17.922 | 13:14:18.052 |

- Between each eviction and the next boot there are 13–14 `agent.updated`
  lines and 1 `command.updated`, and no warming line.

**Correction:** warming is not what re-boots workspaces.
- A warming ping (`SessionGenerate.generate`) publishes no durable event, and
  its loop runs in the evicted workspace's own plugin scope
  (`core/src/plugin/warming.ts:72,134`).
- Warming does keep spending tokens after a run stops: orchestrator
  `w-5799d74eefd13351` stopped at 11:47:42 and was pinged at 11:51, 11:55,
  11:59, 12:03 and 12:07, until its 30-minute window ran out.
- There is no core API to stop warming for a session or to release a workspace
  from a plugin.

### 4. The repository-lock jam

All five claims hold. Corrections:

- **Sweep call site.** It is at `plus/src/index.ts:198` at HEAD (:172 was the
  release tag).
  - Plus is a built-in plugin instantiated once per workspace
    (`core/src/plugin.ts:292`, `location-services.ts:20-56`), so each loaded
    workspace forks its own `startSweep` (`teams/lifecycle.ts:696-702`).
  - `Schedule.spaced(2000)` waits 2 s after each pass ends. A pass stuck on the
    lock lasts 30 s or more.
- **What each pass does.** It reads every run and merge entry, then always
  takes `lock(repo)` (`lifecycle.ts:638`) for `git worktree list` plus a
  `realpath` per worktree (`worktree.ts:240-255`; 57 worktrees today).
- **The lock.** `store.ts#lock` polls every 25 ms (:240) for at most 30 s
  (:265), with no queue. All contenders are the same server pid, so the
  stale-lock break never fires.
- **Merge entries.** They have no state history; `MergeEntry` has no history,
  receipts or temp-dir field (`merge.ts:14-28`).
  - Every `team_integrate` call creates a new entry (`api-integrate.ts:131`).
  - `drain` picks only `pending` and `paused` entries (`merge.ts:369`).
  - An entry that loses the lock is abandoned:
    - in `rebasing`, because the state is saved (:275) before the
      `worktree add` lock (:278);
    - in `landing`, when the lock at :319 times out.
  - `w-6c06a166ba8d4848` left 11 entries under `runs/w-faa67c8d26bfb173/merge/`:
    6 `rebasing`, 4 `landing`, 1 `landed` (10:14:30 → 10:47:34).
  - Its receipts survive (`runs/<parent>/receipts/*-0dad01c.json`), but
    `process` reruns every check (:299-305) and never consults `checks.stale`.
  - Abandoned `rebasing`/`landing` entries count as open merges in `gc`
    (`lifecycle.ts:539`), so they also block reaping.
- **Leftover merge worktrees.** There are five, not four:
  - three from the cache & compaction landings, one from instructions at
    11:03, and one from a monitor merge that ended `red`;
  - each is about 2.8 GB apparent, but `node_modules` is hard-linked, so the
    unique cost is about 150 MB each;
  - `removeTemp` needs the repo lock (`merge.ts:125`) and its failure is
    swallowed (:355);
  - nothing removes them later, because `orphans()` skips the merge area
    (`worktree.ts:252`, asserted by `test/teams/gc.test.ts:1032`).
- **Not re-checked:** the 95% lock-busy sample. The process that showed it is
  gone.

### 5. `team_stop` / `team_supersede`, warming, unloading; `team_followup` after a stop

**Answer (established).**
- **Warming:** neither tool touches warming. A stopped run's session keeps
  being pinged until its window expires (example in question 3).
- **Unloading:** the workspace unloads only by inactivity, and is then booted
  again (question 3).
- **`team_stop` on a working child:** it does not interrupt anything. It sets
  `stopRequested` and returns `stopping` (`teams/api-lifecycle.ts:135-137`).
  The run stops only when its turn ends (`lifecycle.ts:239-241`), which for a
  hung step means at eviction.
  - Only an idle child is interrupted and stopped at once (:125-129).
  - So the Simple plan's "`team_stop` … ends any open step" holds only for
    idle runs.
- **`team_followup`:**
  - it accepts a `stopped` child (`teams/api-followup.ts:121`);
  - it admits it through `admitIdleChild`, which moves `stopped → starting`
    (:233);
  - the record does not say who stopped it: `stopIdle(…, by)` uses `by` only to
    skip the notice (`lifecycle.ts:302-311`).

**Fix points.**
- The Plus warming hook already runs before every ping
  (`plus/src/index.ts#decideWarmingFor`, :3194; core checks the hook at
  `plugin/warming.ts:92-99`). It can clear `event.settings` for a session whose
  run is `stopped`, `stopping`, `dead`, `superseded` or `reaped`. That needs no
  new API and no persisted switch.
- Unloading needs the client fix from question 3.
- `team_followup` can refuse when the record carries `stoppedBy` equal to the
  caller's run.

### 6. Self-resume after an `inactivity` interruption, or exemption?

**Answer: exempt, after question 1's timeout lands. No self-resume.**

**Reasons (established facts first).**
- Eviction interrupts a workspace's executions only when no durable session
  event arrived for 60 minutes (`location-activity.ts:53-70`).
- Every retry wait publishes a durable `session.retry.scheduled` (question 2).
  Once silent streams fail after 10 minutes, a model step is never silent long
  enough to be evicted.
- What is left is a single tool call running longer than 60 minutes. Shell
  commands carry their own timeout, and `question` is refused in delegated
  runs.
- Exempting a workspace that has an active execution (touch it instead of
  interrupting) costs one changed branch in `location-activity.ts`.
- Self-resume has costs:
  - It would repeat the interrupted step every 60 minutes while the cause
    persists, hiding the hang.
  - It needs Plus to tell `inactivity` apart from a user stop. Today
    `onSessionEvent` drops the `reason` field of
    `session.execution.interrupted` (`session-event.ts:259`;
    `lifecycle.ts:196-198`).
- Recording that reason on the attempt is still useful: the parent's settlement
  notice can then say why.

### 7. T41: `team_finish` red while `team_check` passed at the same HEAD

**Answer (established).**
- The checks never failed: every receipt has `exitCode: 0, passed: true`.
- They ran at the same HEAD (`771f80b`) on a dirty tree:
  `porcelain: ["?? packages/plus/.diag.json"]`, an untracked file that is not
  ignored. In attempt 2 the test files were modified as well.
- `team_finish` throws away dirty receipts in three places:
  - `stale()` treats them as missing and reruns all four checks
    (`teams/checks.ts:541`);
  - `receiptsAt()` filters them out (:531);
  - each check then lands in `red`, with the log line `"failed"`
    (`teams/api.ts:607-616`).
- The precise `dirty_tree` message in `verifyReceipt` (`checks.ts:467-473`) is
  never reached from finish.
- `team_check` returns `passed: true` without mentioning the dirty tree.
- The `E_DIRTY` gate, which would have named the file, comes after the checks
  gate (`api.ts:629` vs :606).
- Audit: finish `E_CHECKS_RED` at 10:00:26, 10:01:24, 10:02:08, 11:03:25 and
  11:03:59; `team_check` passed at 10:00:41–57 and 11:02:44–58.
- Parent: `w-5799d74eefd13351` (instructions), not monitor.

**Correction to section 4's table:** "test files not in scope" does not hold for
T41.
- The Brief's scope includes `packages/plus/test/*`.
- The `E_SCOPE` refusals came from the check-files lock: a file a check runs
  may be changed only if `scope.paths` names that exact file
  (`api.ts:716-722`, `check-files.ts:38-42`). A `dir/*` entry does not count.

**Inferred:** `.diag.json` was the worker's own diagnostic output (its mtime,
09:56:12, matches a failing run).

### 8. The Simple role republish storm

**Answer (established, reproduced in a unit test).** It happens when a team
member's stored role record contains a `<!-- requires: … -->` line.
- Publish installs the **gated** text, with the markers stripped:
  - `teamRoleOverrides` → `roleUpdates` → `resolvedFor(…, gate)`
    (`plus/src/instructions/apply.ts:401-418`);
  - `stripMarkers` in `instructions/model.ts:1349`.
- `captureBaselines` records as `applied` an **ungated** resolve that keeps the
  markers (`plus/src/index.ts:4939-4954`; no `gate`, no `team` in the address).
- **Next discovery:**
  - The host text no longer equals `applied`, so `upstreamPrompt` reports
    Plus's own output as upstream (`instructions/discover.ts:768`).
  - `roleUpdates` then sees a no-op (`apply.ts:412`) and returns no override.
  - `installTeamAgents` falls back to the member file body
    (`instructions/teams-apply.ts:186`, `agent.system = override ?? body`).
- **The publish after that** sees the body, differs again, and reinstalls the
  role. This repeats forever.
- Basic's shipped bodies with markers do not storm. They have no record, so the
  first loop skips them (:4945). The team loop (:4980-4989) records the gated
  override, which matches what was installed.
- **Worse than noise:**
  - Members created from a preset have an **empty** file body (all six
    `teams/Simple/*.md`).
  - So on every other publish the member was installed with an empty system
    prompt. That is the "flips to empty" seen live.
- **Reproduction.** In a scratch copy of the `teams-apply.test.ts` pattern
  (project team `crew`, member `alpha`, role record, four
  `instructions.refresh` calls), not committed:
  - with `"…\n## Tests\n<!-- requires: tool:read -->\n…"`, the fingerprint
    changed on every refresh and the host alternated between
    `"crew alpha body"` and `"edited alpha role"`;
  - the same record without the marker line was stable.
- **Live control:** stripping the five marker lines at about 14:00 stopped the
  storm at 14:01:10. The rate went from about 2,300 to 0 `agent.updated` per
  minute.

### 9. Other findings

- **Log retention.**
  - `core/src/event-logger.ts:7` logs every `agent.updated`, `provider.updated`,
    `model.updated`, `command.updated` and `config.updated` at INFO.
  - Any churn in those events pushes the head of the trimmed log out within
    hours. It cost today's morning evidence.
  - Each instructions write also multiplies: every loaded workspace's Plus
    instance republishes. The log showed 210–700 `agent.updated` per minute
    during the Simple setup writes, before the storm.
- **`E_PATHS` for `briefFile`.**
  - A relative `briefFile` is `realpath`ed against the server's working
    directory, not the caller's checkout (`teams/api.ts:323-335`).
  - It is then refused with the `scope.paths` message
    (`PATHS_MESSAGE`, :119-121).
  - That is all 10 `team_delegate` `E_PATHS` refusals in the 12:51 audit
    snapshot.
- **`team_stop` on a working child does not interrupt it** (question 5).
  Combined with question 1, stopping a hung child took until eviction.
- **Not established: why this chat switched to `Flash-B-Worker`.**
  - The monitor shows `ses_ef90203d4ffe…` running as `build` until 13:35, as
    `Flash-B-Worker` from 13:35:39 to 13:44:48, and as `build` again after the
    user's revert.
  - The switch came with the next prompt after an unanswered `question`, while
    the storm made the client re-fetch the agent list about 37 times a second.
  - No log line records the agent a prompt was sent with.
