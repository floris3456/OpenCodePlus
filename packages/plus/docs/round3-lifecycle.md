# Round 3 lifecycle corrections: canonical success and resumed stop intent

Two corrections inside `src/teams/lifecycle.ts`, with the regression tests in
`test/teams/lifecycle-events.test.ts`.

## 1. Canonical host success

The host publishes `SessionEvent.Execution.Succeeded` at the end of every busy
period (`packages/schema/src/session-event.ts`, emitted by
`packages/core/src/session/execution.ts`). Plus only mapped the deprecated
ephemeral `session.idle`, so a lab run whose model finished stayed `working`
and admitted: `/api/session/active` was empty while no settlement ever reached
the run. `OUTCOMES` now maps `session.execution.succeeded` to `idle`. The
deprecated `session.idle` alias stays mapped because older harnesses still
drive it; failed and interrupted behavior is unchanged.

The regression suite takes the event names from the schema owner
(`SessionEvent.Execution.*.type`) so a rename fails the suite instead of
silently unsubscribing Plus.

## 2. Stale stop intent on resume

`stop` on a run that is executing sets `stopRequested`, and the stop that
completes on the next settlement leaves `stopped` (or, through
reconciliation, `dead`) with the flag still set. Attaching to that run and
prompting it used to start a turn with the old flag, so the first successful
turn immediately stopped again. On `session.execution.started`, a run in
`stopped` or `dead` now consumes the retained intent before moving to
`working`; the resumed turn settles `idle`, drains its inbox and takes further
prompts. A `stopRequested` on a run that has not stopped yet (`idle`,
`starting`) is preserved and still stops it at settlement.

## Focused evidence

All commands ran with `cwd` `packages/plus`; paths in the output are relative
to that directory. The `lifecycle` check is exactly:

```
bun test test/teams/lifecycle-events.test.ts test/teams/api-lifecycle.test.ts test/teams/api-query.test.ts
```

### Baseline, unmodified HEAD `f1b7cf67`

`lifecycle` exit 0:

```
 50 pass
 0 fail
 180 expect() calls
Ran 50 tests across 3 files. [696.00ms]
```

`typecheck` (`bun run typecheck`) exit 0.

### Before the source fix, with the new regression tests

`lifecycle` exit 1 — 15 failures, 13 of them the canonical-success path and
both stop-intent resume paths; `api-lifecycle.test.ts` and
`api-query.test.ts` still passed (21 and 8 tests):

```
test/teams/lifecycle-events.test.ts:
...
    "session.execution.failed",
    "session.execution.interrupted",
    "session.execution.started",
-   "session.execution.succeeded",
    "session.idle",
  ]

- Expected  - 1
+ Received  + 0

      at <anonymous> (test/teams/lifecycle-events.test.ts:125:44)
(fail) the subscribed events are the host's canonical execution events plus the deprecated idle alias [2.24ms]
...
error: expect(received).toBe(expected)

Expected: "idle"
Received: "working"

      at <anonymous> (test/teams/lifecycle-events.test.ts:145:26)
(fail) a turn that ends without finish leaves the run idle and the attempt no_report [2.67ms]
...
Expected: "idle"
Received: "starting"

      at <anonymous> (test/teams/lifecycle-events.test.ts:165:26)
(fail) a starting child reaches idle when its first turn ends [2.58ms]
...
error: expect(received).toBeUndefined()

Received: true

      at <anonymous> (test/teams/lifecycle-events.test.ts:575:60)
(fail) a resumed stopped run consumes the stop intent its stop already satisfied [4.18ms]
...
error: expect(received).toBeUndefined()

Received: true

      at <anonymous> (test/teams/lifecycle-events.test.ts:612:58)
(fail) a resumed dead run consumes the stop intent and settles idle after success [3.55ms]
...
15 tests failed:
(fail) the subscribed events are the host's canonical execution events plus the deprecated idle alias [2.24ms]
(fail) a turn that ends without finish leaves the run idle and the attempt no_report [2.67ms]
(fail) a starting child reaches idle when its first turn ends [2.58ms]
(fail) an attempt whose report is already written is left to finish [1.96ms]
(fail) a followup queued while working is delivered as a new attempt on idle [2.55ms]
(fail) two queued followups arrive as one prompt and one attempt [3.15ms]
(fail) a followup already delivered to an idle child is not prompted twice [4.90ms]
(fail) a settled child puts exactly one child.settled item in a working parent's inbox [3.98ms]
(fail) the settlement names the report status and path when the child reported [2.12ms]
(fail) an idle parent is prompted with the settlement immediately [1.20ms]
(fail) a resumed stopped run consumes the stop intent its stop already satisfied [4.18ms]
(fail) a resumed dead run consumes the stop intent and settles idle after success [3.55ms]
(fail) a resumed run stays usable: its queued followup starts the next attempt after success [3.10ms]
(fail) a stop intent on a starting run is not consumed by execution.started [2.72ms]
(fail) a stop intent on a working run still stops it when its turn succeeds [1.63ms]

 40 pass
 15 fail
 156 expect() calls
Ran 55 tests across 3 files. [573.00ms]
```

### After the fix

`lifecycle` exit 0 — the settled fan-out (attempt settlement, parent
notification, inbox delivery) and both resume paths pass, with the
ordinary-intent guards:

```
test/teams/lifecycle-events.test.ts:
(pass) the subscribed events are the host's canonical execution events plus the deprecated idle alias [0.04ms]
(pass) a turn that ends without finish leaves the run idle and the attempt no_report [4.61ms]
...
(pass) a resumed stopped run consumes the stop intent its stop already satisfied [5.00ms]
(pass) a resumed dead run consumes the stop intent and settles idle after success [4.19ms]
(pass) a resumed run stays usable: its queued followup starts the next attempt after success [5.96ms]
(pass) a stop intent on a starting run is not consumed by execution.started [3.79ms]
(pass) a stop intent on a working run still stops it when its turn succeeds [2.81ms]

 55 pass
 0 fail
 218 expect() calls
Ran 55 tests across 3 files. [676.00ms]
```

`typecheck` (`bun run typecheck`) exit 0:

```
$ tsgo --noEmit -p tsconfig.test.json
```

## Not claimed here

This worker has no shell and no TUI; the real before/after TUI capture for the
integrated `ctrl+d` resume walkthrough is owned by the parent integration. This
document claims only the focused in-process checks above. GC and the T4 tab
behavior were not modified.