# #24 interrupted-request timing — actual-boundary reproduction and repair

**Issue:** [#24 in `plus-1.1.15-overnight-log.md`](plus-1.1.15-overnight-log.md)
recorded an owned ledger row after a visibly interrupted `monitor.query` tool
call that read `status=completed` with `ended=NULL`. The question was whether
that is a legitimate unknown (the physical LLM attempt completed before the
orchestration was interrupted) or a missing terminal event/timing in the
Monitor reconciliation.

## What was found

The observation was **two different facts folded into one misleading row**:

1. **Legitimate part.** When a physical LLM attempt really completes and the
   *tool / orchestration* around it is interrupted afterwards, the attempt has
   an honest known end. The collector must keep it. That part of #24 is lawful
   and is now pinned by a regression, not changed.

2. **Demonstrated defect.** An open `request` row — one that has been started by
   the `http.request` / `experimental.ws.send` hook but whose terminal
   `session.step.ended` / `session.step.failed` / `generated` outcome was never
   delivered to this Location — was inserted without a `status`. The `request`
   table declares `status text not null default 'completed'`, so the row
   inherited `completed` while `ended` stayed `NULL` and `duration` stayed
   `NULL`. That is exactly the `status=completed, ended=NULL` shape in #24. The
   open row claimed a terminal outcome it never observed.

   The ledger boundary already encodes the honest vocabulary for open call rows
   (`status = 'running'`, see `call.status` and `query.ts` running accounting
   for Code Mode), but the `request` insert bypassed it through the schema
   default.

## The repair

`packages/plus/src/monitor/ledger.ts`, `requestStarted`:

- the `insert into request (...)` now writes `status = 'running'` explicitly,
  instead of leaving the column to its `'completed'` default;
- `requestEnded` is the only writer of a terminal request status, unchanged.

Nothing else changed. No identity, window, duration, or outcome is guessed: an
open row stays open (`ended NULL`) and now *reads* open too, and a completed
attempt keeps its real end. The `on conflict(id) do update` clause does not
touch `status`, so an idempotent re-observation cannot downgrade a settled row.

This is a minimal, focused boundary fix at the actual ledger seam; the collector
and hook logic are untouched.

## Controls (all in `packages/plus/test/monitor-interruption.test.ts`)

The new test exercises the **real** `watchMonitor` hooks, the real collector and
the real ledger — only the host event stream is scripted. It asserts on stored
`request` rows and on the real `monitorQuery` page/state output.

- **interrupted, no observed terminal event** → `status=running`, `ended`
  undefined, `duration`/`finish` omitted; the page omits `durationMs`; the
   session-state fallback does not invent a terminal state. *Fails before the fix
  (`completed`)*.
- **completed physical attempt, later interrupted** → keeps `status=completed`,
  real `ended`, real `duration`, real `finish`; the interruption boundary does
  not reopen or rewrite it.
- **pre-output interruption** → the host's `session.step.failed` settles it as
  `status=error` with its end and error, never a completed claim.
- **simultaneous unrelated request** → an interrupted step leaves a warming ping
  and another session's request open.
- **replay / two monitors** → three repeated `http.request` observations on one
  Location write one row that stays `running`; a later terminal settles it once.
- **failed provider** → an HTTP 400 response keeps `status=error`.
- **generate / ping unaffected** → a `generated` outcome still settles to
  `completed`, and the warming relabel only changes the kind.

Control run: reverting the one-line ledger change makes 3 of the 7 tests fail
(the open-row status assertions); restoring it makes all 7 pass. The test cannot
pass by duplicating decision logic — all assertions read the real boundaries.

## Live check (`pilotty spawn --name continuation-monitor-interruption opencodeplus-dev .`)

Own worktree, own home, explicit `cliproxyapi/claude-opus-5-5` chooser; no
shared service / live DB / config touched.

Steps and what was seen:

1. Sent a real small tool request; a first step completed
   (`status=completed, ended set, finish=tool-calls`) and a second step opened.
2. Sent a tool request that sleeps 120s so a real tool was **actively running**
   (`⠙ python3 -c "import time; time.sleep(120)"; echo "exit=$?"`, footer
   `1 shell`). While it ran, the owned monitor.db held the open row as
   `status=running, ended=NULL, duration=NULL, finish=NULL` — the honest open
   state.
3. Pressed **Escape** to interrupt the active tool/orchestration. The chat
   showed `$ python3 ...`, `Tool execution interrupted`, and
   `Build · claude-opus-5-5 · 1m 53s · 62.9 tok/s · interrupted`.
   The owned ledger row then settled as
   `status=error, ended=<real>, duration=113515, finish=error,
   error={"type":"aborted","hash":"6f82565e8ee3cd1c","chars":16}` — the host's
   real terminal boundary, not a fabricated completed.
4. Opened `/monitor`. At 160×40 the Steps tab printed the interrupted row as
   `... 613 19.7k 0 164 ... $0.00 1.9m error shell` — an honest known duration
   and `finish=error`. The completed rows kept their real `2.8s` / `2.5s` /
   `5.9s` `tool-calls`/`stop` finishes. (Rows print `—` for an unknown duration
   via `formatMsLabel`, so an open row would show `—`, never `0ms`.)

Log classification during the live observation of `opencode-local.log` (198 lines): 192
INFO, 6 WARN (the known `executor-controlled plugin source refused` path
guards), **0 ERROR**. The only non-INFO event worth naming is one
`GET /api/shell/<id>/output http.status=404` after the interrupt — the expected
shell-output poll for a tool that was interrupted, not an unexplained fault. No
external-route rejection appeared. No environment, prompt, or credential content
was dumped; no timestamp was mutated.

Process ownership and cleanup: kernel `cwd`/`fd`/`maps` scans found no live
runtime process bound to the exact dev home after
`pilotty kill -s continuation-monitor-interruption` (`SESSION_EXITED`); the only
worktree `cwd` match left is the immutable release worker CLI
(`opencodeplus search-mcp`), which was not started by this run and was not
touched. The pre-existing sessions of other runs were left untouched.

## Verdict

A concrete, minimal source defect exists and is **fixed**: an open request row
no longer inherits the schema's fabricated `completed` status. The historical
`completed + ended=NULL` observation is explained as a row that claimed a
terminal outcome it never observed.

The complementary lawful case — a genuinely completed physical attempt followed
by an interrupted tool/orchestration — is preserved and regression-covered: it
keeps its honest known end. A race between `step.ended` delivery and the
interruption boundary was **not** observed live and is not claimed; the live
interrupt settled through the real `session.step.failed` path.

## Deferred / open

- No provider-side statement is made about the historical row itself; #24 was an
   observation and remains explained, not proven to have a race. Parent's final
   exact-home kernel scan found 0 cwd/fd/maps matches; the final actual log had
   245 lines / 239 INFO / 6 expected confinement WARN / 0 ERROR. Both facts were
   independently checked after the worker's final settlement.
- The broader question of whether a request whose terminal event is *permanently*
  lost (rather than delivered late) should ever be reconciled by a later
  execution boundary is left open; the honest current behavior is to keep the
  row open, which the tests assert.
