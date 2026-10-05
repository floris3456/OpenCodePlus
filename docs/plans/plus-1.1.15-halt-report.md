# plus-1.1.15 overnight — safe-halt report

**Halted at the user's request, 2026-10-05 12:00 CEST.**
Branch: `plus-1.1.15_overnight`. Last landed implementation/receipt series ends
at `d6aa1c2bbf665585035ca115cf7375d84984a6d4`; this handoff checkpoints the
already-prepared documentation/test cosmetics separately. The overnight plan's
**Done criteria are not met**. Do not merge or promote this as verified.

## Completed and landed

- **B1 warming/Monitor integration:** preserved pinned agent/model, private
  non-durable prompt, transport identity and cache-tail policy. Owned live
  acceptance observed two messages, three completed pings, stable countdown,
  subsequent cache read and composer isolation. This is observed reuse, not
  proof that pings causally refresh an unknown DeepSeek cache lifetime.
- **A1 rename/ownership:** source and owned live acceptance, including refusal
  controls, completed.
- **A2 fields/owners:** model-owner validation; in-place Model/Effort edits;
  original-candidate metadata through store/snapshot/Plus RPC; independent
  field resets; unconditional repeated Model-field no-write refusal; local-only
  Effort-original restoration; keybinding separation. Five-field live checks
  at 80/160 columns completed. Specific inactive B beside active A controls
  are source-regression evidence, not claimed provider/live evidence.
- **Categories and activation:** contextual Model/Category Add, category-header
  deletion, reveal/rename, category identity/member scope repairs and exclusive
  activation. Member-only activation was followed by a real Planner provider
  request. Category routing accepted at 80/160 columns.
- **Monitor:** pages/query/story, historical identity/state/pricing/totals,
  request kind/TTL marker accuracy, revision-cached expensive analysis and
  fast repeat polling; owned page/navigation acceptance. New requests start
  explicitly `running`; interrupt and terminal writer regressions accepted.
  No historical lost-terminal race/reconciliation claim is made.
- **Test/documentation reconciliation:** A3/A6/B6 stale expectations and final
  field/activation fixtures repaired without weakening refusal/exclusivity
  controls. README/SPEC now describe contextual Add and field versus row reset.

Detailed commits, boundary evidence and qualifications remain in
`plus-1.1.15-overnight-log.md` and its linked live receipts. Recent key landed
series: category `a89b1ea49e`, request status `bfe583275f`, fields `d6aa1c2bbf`.

## Latest verification

Parent worktree, combined landed source plus checkpointed test cosmetics:

- Focused Plus checks: **411 pass, 6 existing skips, 0 fail** across 11 files.
- Plus `bun typecheck`: **passed**.
- Whole Plus suite: **2267 pass, 14 existing skips, 0 fail** across 150 files.

Receipts are under the parent run's `tmp/`:
`t106-parent-focused.log`, `t106-parent-typecheck.log`, and
`plus-combined-fields-suite.log`. This replaces the earlier eight-failure Plus
gate. Earlier Core/package checks and a historical root gate passed, but they
are **not fresh final combined-head gates**. Passing tests do not cover the
newly demonstrated legacy Effort gap below.

## Still undone

1. **#6 legacy Effort repeat reset:** a plain local row with a variant but no
   original metadata clears Effort on first reset, then restores the old
   variant on the second instead of refusing without writes. Reproduced using
   the actual landed operations function; store/revision/live behavior was not
   asserted. The three-round repair allowance is exhausted. The queued final
   Model/local-only corrections landed, but this additional gap stays open;
   no extra repair round was silently authorized.
2. **#10/A4 catalogue lifecycle/performance:** real Core Model/State zero
   navigation churn, native refetch avoidance, and effective provider/model
   warming/names/variants preservation remain unproved/unrepaired. T113 stopped
   for lack of material progress; older temporary-transform drafts and timing
   claims remain unaccepted. Fresh source-first work and genuine first plus
   three-repeat list-transition timings would be required.
3. **A5 native composer refresh:** evaluate the existing workaround across two
   chats/Locations, earlier/later manual picks and next-provider attribution.
   Native `agent.updated` source reasoning alone does not authorize removal.
   No fresh A5 run was started before the user halted work.
4. **B4/tool-page/basic team acceptance:** T112's checked-in partial receipt
   claims all five real cache cases and in-chat `monitor.query`/detail equality,
   but its later evidence still needs review and it has no final accepted
   report. Basic Project team delegation/tree/scopes remain incomplete; the
   last visible scout probe failed its first attempt and had no report.
5. **Log diagnosis:** T112's final owned log has one unclassified ERROR.
   Earlier #25 warming-WARN diagnosis identifies a transient pinned `build`
   AgentNotFound failure, with later success; this worker diagnosis is not yet
   an accepted source-defect/no-defect conclusion. Cold starts and unknown
   route lifetimes must remain honestly qualified.
6. **Final gates/sweeps:** fresh touched Core/TUI checks, required
   Core/Plugin/Plus/TUI/Client typechecks and root `bun run check`, followed by
   **both fresh combined-head live sweeps**, are missing. Re-run the Plus gate
   after any future relevant source changes. No final merge-ready verdict.

## Preserved partial evidence and shutdown

- Every direct worker is stopped or superseded; none remains open. Closed runs
  must not be resumed.
- T112 stopped at clean evidence HEAD
  `ec9e73df460bd110c4bccfc84ac262ace06906b5`, retained on branch
  `team/Flash-C-Worker/t1127d55-20261005-1040`. Its evidence is **unlanded and
  unaccepted**, not part of the passing parent suite.
- A 16120-byte diff is preserved at
  `/home/bliss/OpenCodePlus/run/plus/data/opencodeplus/teams/runs/main-165a4a6fe1411f5f/tmp/source-input/t112-halt-unaccepted-evidence.patch`.
  Earlier unaccepted catalogue/source inputs remain in that directory.
- Before owned T112 shutdown, the PTY showed an idle composer and the read-only
  Monitor ledger showed 30 completed, 2 error and zero running requests. Only
  that named PTY was killed. All four identified TUI/server/search PIDs are
  absent; its exact owned-home `/proc` cwd/fd/maps references are zero.
- Final T112 log: 648 lines, 635 INFO, 12 expected confinement WARN, **1 ERROR**
  (09:47:25Z; line hash `8e52c75261fb1d32`). No clean-log acceptance claimed.
- Immutable worker MCPs, unrelated PTYs, preserved worktrees and evidence were
  left untouched. The machine as a whole is not claimed idle.

No remote push, merge into `plus-1.1.15`, release build/promotion,
shared-service access or live-configuration mutation occurred. No further work
is scheduled; continuation requires a new human request.
