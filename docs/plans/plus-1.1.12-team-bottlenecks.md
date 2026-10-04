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
  each merge entry.
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
  timeout to HTTP streams. CLIProxyAPI is reached over HTTP.
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
failed with `provider.rate-limit`:

| Child | Task | Running | Parent |
|---|---|---|---|
| `w-f15454a0a1ed9809` | T23 | 03:10 → failed 07:45 | instructions |
| `w-f4da7ff23b519f9e` | T26 | 03:10 → failed 08:00 | instructions |
| `w-b8127bf1d3bbc5dc` | T30 | 03:37 → failed 07:45 | cache & compaction |
| `w-1e010d97417326ff` | T31 | 03:38 → failed 08:00 | monitor |

**Cause.** `packages/core/src/session/runner/retry.ts` retries `RateLimit` up
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
- `packages/plus/src/index.ts:172` calls `startSweep` inside the plugin's
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
  and the next call reruns every check.

Not established: why the workspaces are not released. The count grows with
every child, and evicted orchestrator workspaces re-boot within the same
second. Warming pings on finished sessions are a likely contributor.

**Side effects.**
- Every worktree, including every temporary merge worktree, gets a full
  `bun install` (`node_modules` 3.1 GB, about 210k files). This takes about
  10 s on btrfs with the cache, so it is not slow.
- Four temporary merge worktrees (`teams/worktrees/opencode/merge/*`, about
  3.3 GB each) were left behind because their cleanup also needed the lock.

## 4. Briefs that blocked their children

Six children ended blocked for reasons the Brief could have prevented. Each one
cost a supersede plus a fresh child re-reading the code:

| Child | Task | Blocked because |
|---|---|---|
| `w-a779a31806d6fc78` | T29 | Test files run by its checks were not in `scope.paths`. |
| `w-5ab36fefe733e036` | T41 | Test files not in scope. Also, `team_finish` reported all four checks red while `team_check` at the same HEAD passed them (unexplained). |
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
