# plus-1.1.15 residual work

**Where:** worktree `plus-1.1.15_overnight`, from `5f09e0e5d2`.
- Read `plus-1.1.15-halt-report.md` first.
- The rules, live-test rules and issue loop of `plus-1.1.15-overnight.md` still
  apply, except where this file differs.
- The task plans are `plus-1.1.12-instructions.md` and
  `plus-1.1.12-monitor.md`.

**State at the start** (checked 2026-10-05 12:20):
- the whole `packages/plus` suite: 2267 pass, 14 skip, 0 fail;
- root `bun run check`: passes;
- everything else is in the halt report.

**This run:**
- **Log:** add a `## Residual run` section to `plus-1.1.15-overnight-log.md`.
  Write one short entry per event, in plain sentences with normal spacing.
- **Briefs:** each Brief below is already decided. Copy it, do not widen it.
  Never attach the overnight plan, the log or a task plan; copy the lines a
  worker needs into its Brief.
- **Live tests:** every live-test Brief includes its evidence file in
  `scope.paths`. The worker writes to that file after each step.
- **Workers:** in the order of your role: Flash-C-Worker, then Flash-Worker,
  then Flash-B-Worker.
- **Not here:** no merge into `plus-1.1.15`, no push, no release.

## Order

1. Delegate R3, R4 and R2's live test first. They do not depend on each
   other.
2. While they run, do R1 and R2's review yourself.
3. R5 once R1–R4 have landed or been recorded.
4. R6 last.

## R1. #6: a second Effort reset on an old row (do it yourself)

- **Bug:** `packages/plus/src/instructions/ops.ts:1775-1777`, in
  `resetModelFieldRow`.
  - The row in question is a plain local row with a variant and no
    `originalCandidate`.
  - Its Effort reset calls `setModelFieldRow(…, "")`, which goes through
    `editModelRow` and records `originalCandidate` (variant `high`,
    `editedFields: ["effort"]`).
  - A second reset then brings `high` back instead of refusing.
- **Change:** in that branch, remove the variant directly, without recording
  `originalCandidate`.
  - Use the record operations the branch above uses: remove the record, add it
    again without the variant.
  - Carry over warming, interval, prompt and `active`.
- **Test** in `test/ops.test.ts`, on a plain local `acme/nova@high` row that is
  active:
  - the first Effort reset leaves the row without a variant, without
    `originalCandidate`, and still active;
  - the second reset refuses with "has no override to reset", and the records
    are unchanged.
- **Checks:** from `packages/plus`, run
  `bun test test/ops.test.ts test/model-settings.test.ts test/model.test.ts test/tools.test.ts`
  and `bun typecheck`.

## R2. B4 evidence and the Basic team

**First, yourself:**
1. Review T112's evidence on branch `team/Flash-C-Worker/t1127d55-20261005-1040`
   at `ec9e73df46`: one file, `docs/plans/plus-1.1.15-real-cache-live.md`.
   Land it if its claims match what it cites. Otherwise record the gaps and land
   only what holds.
2. Classify T112's one ERROR (09:47:25Z) and the #25 warming WARN. Read them in
   `run/plus-dev/run-plus-data-opencodeplus-teams-worktrees-opencode-Flash-C-Worker-t1127d55-20261005-1040/data/opencode/log/opencode-local.log`.
   Record for each: a source defect (open an issue), or not (say why).

**Then delegate one live test** (evidence file
`docs/plans/plus-1.1.15-basic-team-live.md`):
1. In the dev home, create a project team from the `basic` preset.
2. Delegate one small report task to it.
3. Check the Team tree, the Team scopes and the composer's Team tab.
4. Stop the run, and check that it shows as stopped.

## R3. A5: does the composer need the workaround? (one worker, live)

- **Change:** remove the `instructions.changed` listener in
  `packages/plus/src/tui/active-team.tsx:74-82`: its comment, the
  subscription, and its unsubscribe call.
- **Live test**, with two TUIs on two folders (evidence file
  `docs/plans/plus-1.1.15-a5-live.md`):
  1. Activate a model for an agent in Instructions.
  2. Both composers show it within 2 s.
  3. The next message runs on it: check the request row in `/monitor`.
  4. A later model pick in a composer wins over it.
- **Deliverable:** if every step passes, a commit. If any step fails, a report
  only: the workaround stays, with the reason.

## R4. A4: measure speed, do not redesign (one worker, live)

- **Decision:** measure only. T103's unaccepted numbers already met the targets:
  - Defaults › Models: about 274–301 ms on first open, 140–153 ms on repeats;
  - an agent's Models: about 10 ms.
- **Brief** (evidence file `docs/plans/plus-1.1.15-a4-live.md`). At 160
  columns, open Defaults › Models and one agent's Models:
  - first after a fresh server start, then three repeats;
  - time each open with `date +%s%3N` around the key press and pilotty's wait
    for a model name that shows only in that list;
  - record every number.
- **Targets:** under 1.5 s first, under 300 ms on repeats.
  - **Met:** A4 is done, and #10 (no catalogue reads during navigation) moves
    to `plus-1.1.16-team-fixes.md`.
  - **Missed:** profile it yourself before any worker changes code.

## R5. Gates (yourself, after R1–R4 land)

- From `packages/plus`: `bun test` (the whole suite).
- From `packages/core`: the five warming and generation files in the overnight
  plan's B1.
- From `packages/tui`: the touched tests.
- `bun typecheck` in `core`, `plugin`, `plus`, `tui` and `client`.
- `bun run check` from the repository root.

## R6. Final live sweep (workers, at one HEAD, after R5)

- **One Brief per task**, each with its own evidence file: Instructions T1–T8
  and Monitor T1–T4. Instructions T2 needs two TUIs on two folders.
- **Each Brief carries:**
  - that task's end-state lines, copied in;
  - the start command;
  - "write each line's result to the evidence file as you go".
- **Up to four at once.**
- **Issue loop** as in the overnight plan:
  - a fix goes in only once you have decided it;
  - afterwards, sweep again only the tasks it touches.

## Done

- R1–R6 are landed or recorded.
- At the final HEAD: the whole Plus suite, the typechecks and `bun run check`
  pass.
- Every end-state line is verified, or recorded as open with its reason.
- Every child is stopped, and the log is committed.

Then tell the user briefly:
- what landed;
- what is still open;
- what the merge into `plus-1.1.15` must know.

## Start prompt

A chat runs in the folder its TUI was started from, and its team run lands
there. So start the TUI from
`/home/bliss/OpenCodePlus/worktrees/plus-1.1.15_overnight/opencode`, not from
`plus-1.1.15`. Then pick `Simple-Orchestrator` and send:

```text
You are the only orchestrator, in worktree plus-1.1.15_overnight of release
plus-1.1.15. First run pwd: if it does not end in
plus-1.1.15_overnight/opencode, make no team call, say so in one line and stop.
Do docs/plans/plus-1.1.15-residual.md, R1 to R6 in its Order, by its rules and
your role, until its Done holds. Read docs/plans/plus-1.1.15-halt-report.md
first. R1 and the R2 reviews are done (see "## Residual run" in
docs/plans/plus-1.1.15-overnight-log.md): do not redo them. Delegate only the
Briefs the plan names, as written. Log in
docs/plans/plus-1.1.15-overnight-log.md under "## Residual run". Do not merge
into plus-1.1.15.
```

**2026-10-05, first attempt:** the chat was opened from the TUI in
`plus-1.1.15`. Its role says to tell the user before delegating from a
`<version>` checkout, so it delegated nothing: it did R1 and the R2 reviews by
hand in this worktree and stopped. That was correct. Workers would have
branched from `plus-1.1.15`, and `team_integrate` would have landed there.
