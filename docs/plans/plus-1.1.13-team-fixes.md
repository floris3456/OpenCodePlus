# plus-1.1.13: scope, order, and the remaining team fixes

**Objective:** release `plus-1.1.13` on top of the released `plus-1.1.12`,
with:
- the Instructions work (`plus-1.1.12-instructions.md`, T1–T8);
- the Monitor work (`plus-1.1.12-monitor.md`, T1–T4);
- five team fixes:
  - a merge that loses the lock retries only its landing (F11);
  - leftover merge worktrees and abandoned merge entries are cleaned up (F12);
  - a workspace unloads when its cache warming ends, keeps pinging while a tool
    runs, and is never cut off while a step runs (F13);
  - `team_finish` says why checks are red (F14);
  - `team_supersede` is folded into `team_stop` (F15).

Both plan files keep their `plus-1.1.12-…` names, because Briefs and run
records point at them. Their release line now says `plus-1.1.13`.

**Start condition:** `plus-1.1.12` is released and active, with F1–F10 and
F16 of `plus-1.1.12-team-fixes.md` included.
- The teams that do this work then already have the HTTP timeout, the child
  error messages, `team_stop` force, and closed workspaces staying closed.
- The `requires` lines are back in the Simple role bodies.

Research: `docs/plans/plus-1.1.12-team-bottlenecks.md`, "Follow-up research
(2026-10-04)". Line numbers are at the commit that adds this plan. Re-check
them after the 1.1.12 merges.

## Setting up

Done by `Simple-Build` or the user, from `/home/bliss/OpenCodePlus/repos/opencode`
or any worktree of it:

```sh
git worktree add -b plus-1.1.13 /home/bliss/OpenCodePlus/worktrees/plus-1.1.13/opencode plus-1.1.12
git worktree add -b plus-1.1.13_instructions /home/bliss/OpenCodePlus/worktrees/plus-1.1.13_instructions/opencode plus-1.1.13
git worktree add -b plus-1.1.13_monitor /home/bliss/OpenCodePlus/worktrees/plus-1.1.13_monitor/opencode plus-1.1.13
git worktree add -b plus-1.1.13_team-fixes /home/bliss/OpenCodePlus/worktrees/plus-1.1.13_team-fixes/opencode plus-1.1.13
```

Then run `bun install --frozen-lockfile` in each new worktree.

| Purpose worktree | What it does | Branches it merges first, in this order |
|---|---|---|
| `plus-1.1.13_instructions` | `plus-1.1.12-instructions.md` T1–T8: the remaining items, the reconciliation, and the live check | 1. `team/Orchestrator/t125799-20261004-0301` (`51312632c`, T1, T2, T4, T5, T8)<br>2. `team/Flash-Implementer/t58b343-20261004-1306` (T6 rename)<br>3. `team/Flash-Implementer/t6086e7-20261004-1347` (T3 + T7) |
| `plus-1.1.13_monitor` | `plus-1.1.12-monitor.md` T1–T4, then the live check against real cache misses | 1. `team/Orchestrator/t131092-20261004-0301` (`79ba238`, T1, T4)<br>2. `team/Heavy-Implementer/t54a9ef-20261004-1204` (T2 + T1 review fixes)<br>3. `team/Flash-Implementer/t45315d-20261004-1103` (T3 page, reconciled so it shows T2's analysis) |
| `plus-1.1.13_team-fixes` | F11–F15 below | none |

**Conflicts to expect when merging those branches onto 1.1.12:**
- `core/src/session/model-request.ts`: F7 added `idleTimeout` next to
  `t54a9ef`'s edit.
- `teams/run.ts#RunRecord`: F4 and F5 added fields next to `t54a9ef`'s `team?`.
- `teams/api.ts#statusOf`: F5 added `retrying`.
- `packages/plus/src/index.ts`: F1 and F4 changed it; the instructions branches
  edit other regions.

Keep both sides in every case. Each orchestrator resolves these in its own
worktree. If a merge into `plus-1.1.13` conflicts, abort it, merge
`plus-1.1.13` into the purpose worktree, resolve there, and merge again.

## Order

- **First:** `plus-1.1.13_team-fixes` and `plus-1.1.13_instructions`, side by
  side. Two orchestrators with up to 5 workers each fit the 12-run limit.
- **Then:** `plus-1.1.13_monitor`, as soon as one of the two is merged into
  `plus-1.1.13`.
- **Inside `team-fixes`:**
  - F11, F13 and F14 start together;
  - F12 follows F11 (it uses F11's `tempDir`);
  - F15 goes last, after the instructions and monitor branches are merged into
    `plus-1.1.13`, because it edits `instructions/permission-catalog.ts` and
    `monitor/attribution.ts`.
- **Worker suggestions for `team-fixes`:**
  - F11 to `Heavy-Worker` (merge state machine);
  - F13 to `Flash-B-Worker` (core and Plus, others wait on it);
  - F12, F14 and F15 to `Flash-Worker`.

The rules for tests, live tests, the dev home (`$DEV`, `$LOG`, `$DEV_TEAMS`) and
commits are those of `plus-1.1.12-team-fixes.md`, "Rules for every task".

## Tasks in `plus-1.1.13_team-fixes`

### F11. A merge that loses the lock retries only its landing

**Effort:** large. **Package:** `packages/plus`. **Research:** question 4.

**End state.**
- A merge entry that cannot take the repository lock for `worktree add` stays
  `pending`.
- An entry that has verified its checks but lost the landing lock stays
  `landing`, keeping its rebased tip and its temporary worktree. The next
  `team_integrate` or `drain` lands it without rerunning checks, as long as the
  parent HEAD has not moved.
- Calling `team_integrate` again for the same child and head reuses the open
  entry instead of creating another.

**Interfaces.**
- `packages/plus/src/teams/merge.ts#MergeEntry` (:14-28): add optional
  `rebaseBase`, `rebasedTip` and `tempDir`.
- `teams/merge.ts#process`:
  - save `rebasing` only after `worktree add` succeeds (today it is saved at
    :275, before the lock at :278);
  - on `E_LOCKED` at the landing lock (:319), save the entry `landing` with
    those three fields and skip `removeTemp`;
  - on entry, for a `landing` entry that has `rebasedTip`:
    - if the parent HEAD equals `rebaseBase`, run the ff-only merge;
    - otherwise take the existing `stale_parent` path, and rerun only the
      checks `checks.ts#stale` (:537) reports.
- `teams/merge.ts#drain` (:366-371): also pick `landing` entries that have
  `rebasedTip`.
- `teams/api-integrate.ts#integrateHandler` (new entry at :131): reuse an open
  entry with the same `childRun` and `childHead`.

**Decision.** Land only onto an unchanged parent HEAD. A moved parent means a
fresh rebase, as today.

**Tests.** In `packages/plus`:
- Add to `test/teams/merge.test.ts` (near :129-204):
  - a landing lock timeout keeps the entry `landing` with its tip and temp
    worktree;
  - the next drain lands it without running checks (count executions with a
    check that appends to a file);
  - a moved parent HEAD reruns stale checks only;
  - a `worktree add` lock timeout leaves the entry `pending`.
- Add to `test/teams/api-integrate.test.ts` (near :708): a second integrate for
  the same child and head returns the same entry id.
- Run:
  ```sh
  bun test test/teams/merge.test.ts test/teams/api-integrate.test.ts test/teams/checks.test.ts
  bun typecheck
  ```

**Live test** (`t11-merge`).
- In the dev `Simple-Build` chat, delegate a one-line commit task to a worker,
  then `team_integrate` it.
- It lands, and `$DEV_TEAMS/worktrees/opencode/merge/` is empty afterwards.

### F12. Leftover merge worktrees and abandoned merge entries are cleaned up

**Effort:** medium. **Package:** `packages/plus`. **Research:** question 4.
**After:** F11.

**End state.**
- `gc` removes a merge-area worktree that no open entry names in `tempDir`,
  once it is older than `policy.timeouts.startMs`.
- These entries are marked `abandoned`:
  - `rebasing` entries older than 1 hour;
  - `landing` entries without `rebasedTip` older than 1 hour.
- Abandoned entries no longer count as open merges, which today blocks reaping
  (`teams/lifecycle.ts:539`).
- The five leftover merge worktrees in the release data are removed by the
  release's own `gc` once 1.1.13 is active. Nobody removes them by hand.

**Interfaces.**
- `teams/worktree.ts#orphans` (:234; the merge-area skip is at :252): takes an
  optional `mergeOwned: Set<string>` and reports merge-area worktrees not in it.
- `teams/lifecycle.ts#gc` (:504):
  - builds `mergeOwned` from open entries' `tempDir`;
  - removes reported merge worktrees with `git worktree remove --force` inside
    the same locked pass;
  - applies the `abandoned` cutoff when reading entries (:525-544).
- `teams/merge.ts`: add the state `"abandoned"`. `drain` ignores it.

**Tests.** In `packages/plus`:
- Change `test/teams/gc.test.ts:1032`: a merge worktree that no entry names,
  past the age limit, is removed; one named by an open entry is kept.
- Add to `test/teams/gc.test.ts`: a 2-hour-old `rebasing` entry becomes
  `abandoned` and no longer blocks reaping its child.
- Add `mergeOwned` cases to `test/teams/worktree.test.ts`.
- Run:
  ```sh
  bun test test/teams/gc.test.ts test/teams/worktree.test.ts test/teams/merge.test.ts
  bun typecheck
  ```

**Live test** (`t12-leftover`).
- After F11's live test, add a stray worktree under
  `$DEV_TEAMS/worktrees/opencode/merge/` with `git worktree add`, and age it
  with `touch -d '-2 hours'`.
- Within 30 s it is gone, and `git worktree list` no longer shows it.

### F13. A workspace unloads when its warming ends; pings continue while a tool runs; a running step is never cut off

**Effort:** large. **Packages:** `packages/core`, `packages/plugin`,
`packages/plus`. **Research:** questions 3 and 6. Decided 2026-10-04: option
(b), keep pinging while a tool runs.

**End state.**
- **When an idle workspace unloads:**
  - if one of its sessions has an open warming window, the moment the last
    such window ends;
  - otherwise, 60 minutes after its last durable session event, as today.
- A workspace that has an active execution is never unloaded and never
  interrupted by inactivity. Its clock restarts instead.
- While a session's execution runs (a long shell command or test), its warming
  window does not end, and pings continue until the execution finishes. The
  tool's own timeout bounds how long.
- A team attempt that ends `interrupted` records the host's reason (`user`,
  `shutdown`, `superseded` or `inactivity`), and the parent's notice shows it.

**Interfaces.**
- `packages/plugin/src/effect/session.ts#SessionWarming` (:152): `phase` gains
  `"expire"`, asked when a window reaches its end.
- `packages/core/src/plugin/warming.ts`, the loop (:86-89): on `now >= expires`,
  call `decide({ …, phase: "expire" })` first.
  - If it returns settings whose `since + duration` lies ahead, keep the loop.
  - Otherwise end it, as today.
- The same loop reports the window to `LocationActivity`:
  - on schedule (:184-199), extend (:174-181, :101-102) and end (:87, :98,
    :168), call `hold(sessionID, expires | undefined)`;
  - add `hold` to the plugin context's location API
    (`packages/core/src/plugin/host.ts`), backed by a new
    `LocationActivity.Service.hold(ref, key, until)`.
- `packages/core/src/location-activity.ts`:
  - keep the holds per location;
  - expiry = the latest hold if there are any holds, otherwise last touch +
    `timeToLive`;
  - in the expiry pass (:53-83), a location with an active execution is touched
    instead of interrupted; others are evicted as today.
- `packages/plus/src/warming.ts#createWarmingStore` `decide`: at
  `phase: "expire"` (and `"warm"`), when `busy.has(sessionID)` (set by
  `running()`, :410), return the settings with `duration` stretched so that
  `since + duration >= now + interval`.
- `packages/plus/src/teams/lifecycle.ts#onSessionEvent` (:196-198): pass the
  decoded `reason` of `session.execution.interrupted`
  (`packages/schema/src/session-event.ts:259`) to `onSessionIdle`.
  `settleAttempt` (:249) stores `error: { type: "session.interrupted", message: reason }`,
  and `childSettledText` shows it.

**Decisions.**
- Never cut off a running step. 1.1.12's F7 already ends a silent model reply
  after 10 minutes, so what remains is a running tool.
- Pings continue during a tool; there is no compaction in the middle of a tool.
  Long tool runs are rare (checks take 20–50 s and are capped at 15 minutes),
  so the extra pings cost little. Compacting around an open tool call would
  need a change to core compaction.

**Tests.**
- In `packages/core`:
  - add to `test/location-activity.test.ts`, with
    `layer({ timeToLive: "1 second", sweepInterval: "100 millis" })`:
    - a location with a hold 3 s ahead is evicted at the hold, not before;
    - a location without holds is evicted after `timeToLive`;
    - a location with an active execution is never evicted or interrupted;
  - add to `test/plugin/warming.test.ts`: an `expire` decision that stretches
    the duration keeps pinging; none ends the loop.
- In `packages/plus`:
  - add to `test/warming.test.ts`: a busy session's `expire` decision stretches
    the window; an idle one does not;
  - add to `test/teams/lifecycle-events.test.ts`: an `interrupted` event with
    `reason: "inactivity"` is stored on the attempt and shown in the parent's
    notice.
- Run:
  ```sh
  # packages/core
  bun test test/location-activity.test.ts test/plugin/warming.test.ts
  bun typecheck
  # packages/plugin
  bun typecheck
  # packages/plus
  bun test test/warming.test.ts test/teams/lifecycle-events.test.ts
  bun typecheck
  ```

**Live test** (`t13-unload`).
- In the dev home, set Defaults › Models warming for the worker's model to 8
  minutes with a 2-minute interval (`tools.instructions.set` on its
  `modeldefault` row).
- From the dev `Simple-Build` chat, delegate to `Flash-Worker`: "run `sleep 900`
  in the shell, then report".
- `$LOG` keeps showing `warming session` for the child every ~2 minutes until
  the sleep ends.
- After the report, `team_stop` the child. `$LOG` shows
  `location services evicted` for its worktree within about 8 minutes of its
  last real request, and no `booted` line for it after that.

### F14. `team_finish` says why checks are red; `team_check` says when a pass will not count

**Effort:** small. **Package:** `packages/plus`. **Research:** question 7.

**End state.**
- When a check's latest receipt at HEAD passed but was recorded on a dirty
  tree, `team_finish` reports `E_CHECKS_RED` with that reason and the files,
  for example
  `"<check id>: passed, but on a dirty tree (?? packages/plus/.diag.json); commit or remove those files"`.
- `team_check` results carry `dirty` and `porcelain`. When `dirty` is true they
  also carry
  `message: "passed on a dirty tree: team_finish will run it again on a clean tree"`.

**Interfaces.**
- `teams/api.ts#finishHandler` (:600-625): for a check with no clean receipt,
  read the latest receipt at HEAD without the clean filter. Use
  `teams/checks.ts#verifyReceipt` (:453) and its `dirty_tree` message instead
  of `firstLogLine(undefined)`.
- `teams/checks.ts#CheckResult` (:68): add `dirty: boolean` and
  `porcelain: string[]`. `checkHandler` (`api.ts`, near :966) returns them.

**Decision.** Keep the order of the gates and the clean-tree rule; only the
reporting changes.

**Tests.** In `packages/plus`:
- Add to `test/teams/api.test.ts`: an untracked file plus a passing check makes
  `team_finish` fail `E_CHECKS_RED`, with "dirty tree" and the file name in the
  message.
- Add to `test/teams/checks.test.ts`: on a dirty tree `team_check` returns
  `dirty: true` and the porcelain lines.
- Run:
  ```sh
  bun test test/teams/api.test.ts test/teams/checks.test.ts test/teams/is-clean-receipt.test.ts
  bun typecheck
  ```

**Live test:** none. Simple runs no checks; the unit tests cover the Basic path.

### F15. `team_supersede` is folded into `team_stop`

**Effort:** medium. **Package:** `packages/plus`. **After:** the instructions
and monitor merges.

**End state.**
- `team_stop` takes optional `reason` (at most 300 characters, as `supersede`'s
  today) and `cancelTask: boolean`.
  - With `cancelTask: true` it marks the run's task `cancelled` in its plan, as
    `supersede` does today.
  - `force` (from 1.1.12) still ends a working child at once.
- `team_list` hides `stopped` runs whose task was cancelled, just as it hides
  `superseded` ones today.
- The tool `team_supersede` no longer exists. Removing it touches:
  - its permission rows;
  - the shipped `basic` team presets and role texts;
  - the monitor's attribution;
  - the Simple role texts.
  None of these mention it afterwards.
- Existing `superseded` run records stay readable and still count as terminal.

**Interfaces.**
- `teams/schema.ts`: add `reason` and `cancelTask` to `StopInput` (:859);
  remove `SupersedeInput`.
- `teams/api-lifecycle.ts`: move `cancelTask` and the reason notice from
  `supersedeHandler` (:140-211) into `stopHandler`; delete `supersedeHandler`.
- `teams/tools.ts`, `teams/api.ts`: remove the `supersede` tool and its API
  entry.
- `teams/api-query.ts#listHandler` (:42-48): hide `stopped` runs whose task
  state is `cancelled` unless `all`.
- `instructions/permission-catalog.ts` and `monitor/attribution.ts`: drop
  `team_supersede`.
- The shipped `basic` member presets and role texts: replace supersede with
  `team_stop` `cancelTask: true`. Find them with
  `grep -rn "supersede" packages/plus/src`.
- After the release is active: in the Simple role bodies,
  `tools.instructions.set` replaces "superseded or abandoned it" and
  "supersede" with the `team_stop` wording.

**Tests.** In `packages/plus`:
- Move the supersede cases of `test/teams/api-lifecycle.test.ts` (:294 onward)
  to `team_stop` with `cancelTask: true`.
- Keep `test/team2-contract.test.ts` and `test/teams/tools.test.ts` green with
  the tool removed.
- Add to `test/teams/api-query.test.ts`: a cancelled, stopped run is hidden
  unless `all`.
- Run:
  ```sh
  bun test test/teams/api-lifecycle.test.ts test/teams/tools.test.ts test/team2-contract.test.ts test/teams/api-query.test.ts test/permission-catalog.test.ts test/monitor.test.ts test/builtin-teams.test.ts
  bun typecheck
  ```

**Live test** (`t15-stop`).
- In the dev `Simple-Build` chat, delegate a report task, then call `team_stop`
  with `cancelTask: true` and a reason.
- `team_list` no longer shows the run, and `team_list` with `all` shows it as
  `stopped`.
- The team tools offered to the chat do not include `team_supersede`.

## Start prompts

Open a TUI in the purpose worktree, pick `Simple-Orchestrator`, and send:

**`plus-1.1.13_team-fixes`:**
```text
You are in purpose worktree plus-1.1.13_team-fixes of release plus-1.1.13.
Do tasks F11–F15 of docs/plans/plus-1.1.13-team-fixes.md, in its order and by
the rules it names. F15 waits until the instructions and monitor branches are
merged into plus-1.1.13; ask me before starting it. Land each task here with
its focused tests and bun typecheck green and its live test run, then report
per task: commit, tests, live result. Do not merge into plus-1.1.13.
```

**`plus-1.1.13_instructions`:**
```text
You are in purpose worktree plus-1.1.13_instructions of release plus-1.1.13.
First merge, in this order, team/Orchestrator/t125799-20261004-0301,
team/Flash-Implementer/t58b343-20261004-1306 and
team/Flash-Implementer/t6086e7-20261004-1347, resolving conflicts here as
docs/plans/plus-1.1.13-team-fixes.md describes. Then finish and verify T1–T8 of
docs/plans/plus-1.1.12-instructions.md (its release is now plus-1.1.13), each
with focused tests, bun typecheck and its live test. Report per task. Do not
merge into plus-1.1.13.
```

**`plus-1.1.13_monitor`:**
```text
You are in purpose worktree plus-1.1.13_monitor of release plus-1.1.13.
First merge, in this order, team/Orchestrator/t131092-20261004-0301,
team/Heavy-Implementer/t54a9ef-20261004-1204 and
team/Flash-Implementer/t45315d-20261004-1103, resolving conflicts here as
docs/plans/plus-1.1.13-team-fixes.md describes; the T3 page must show T2's
analysis. Then finish and verify T1–T4 of docs/plans/plus-1.1.12-monitor.md
(its release is now plus-1.1.13), each with focused tests, bun typecheck and a
live check against real cache misses. Report per task. Do not merge into
plus-1.1.13.
```
