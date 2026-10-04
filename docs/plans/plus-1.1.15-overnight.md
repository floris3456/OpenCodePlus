# plus-1.1.15 overnight: finish the Instructions and Monitor work

**Objective:** by morning, both purpose branches hold every task of
`plus-1.1.12-instructions.md` (T1–T8) and `plus-1.1.12-monitor.md` (T1–T4):
merged, reconciled, checked against every end-state line, and live-tested in
the worktree's own build. Every issue found on the way has a fix landed, or is
recorded as open with its evidence. The user merges both branches into
`plus-1.1.15` in the morning.

Both task plans stay the contract for *what* each task must do (their end
states and working rules). This plan says what is left, in which order, and how
the night runs.

## Who runs this

Two `Simple-Orchestrator` chats run side by side, one per purpose worktree.
Each one delegates, reviews and lands in its own worktree. Start prompts are at
the end.

| Purpose worktree (branch of the same name) | Path | Part |
|---|---|---|
| `plus-1.1.15_instructions` | `/home/bliss/OpenCodePlus/worktrees/plus-1.1.15_instructions/opencode` | Part A |
| `plus-1.1.15_monitor` | `/home/bliss/OpenCodePlus/worktrees/plus-1.1.15_monitor/opencode` | Part B |

- Both are made from `plus-1.1.15`. `plus-1.1.15` is merged into them, and
  their packages are installed.
- **Workers:**
  - `Flash-C-Worker` takes all coding and live tests. It is slow, so start
    runs early and run several side by side.
  - `Flash-B-Worker` is used only while `Flash-C-Worker` is unavailable (its
    settlement names a quota, rate limit or provider error).
  - `Flash-Worker` and `Heavy-Worker` are switched off.
- **At most 4 children working at once per orchestrator.** One stale Basic run
  already holds a slot of the namespace's 12. If `team_delegate` refuses with
  `E_BOUNDS`, run `sleep 300` in the shell and try again. Never finish blocked
  for `E_BOUNDS`.
- Nobody merges into `plus-1.1.15`, pushes, builds a release or touches the
  shared service.

## Rules for every task

- **Never ask the user.** The user is asleep. Decide inside the end state and
  write the decision in your log (below).
- **Tests:**
  - `bun test <file>` from the package directory, never from the repository
    root;
  - `bun typecheck` in every package a task touched.
- **Live tests:**
  - Run the worktree's own build in its own home, from the worktree you test:
    `pilotty spawn --name <run id> opencodeplus-dev .` (pilotty skill).
  - Use a narrow (80 columns) and a wide (160 columns) terminal when layout
    matters.
  - Kill every pilotty session and process you started before you finish.
  - The home and its server log:
    ```sh
    DEV=/home/bliss/OpenCodePlus/run/plus-dev/$(git rev-parse --show-toplevel | sed 's|^/home/bliss/OpenCodePlus/||' | tr -d '\n' | tr -c 'A-Za-z0-9._-' '-')
    LOG=$DEV/data/opencode/log/opencode.log
    ```
  - The first run copies the release's providers, agents and instructions
    into that home. Change configuration only there.
  - In a live chat, pick `cliproxyapi/deepseek-v4.1-flash-cheap` unless the
    test needs another model.
  - Read `$LOG` for errors and warnings after every live test. An unexplained
    error is an issue.
  - Never `bun run dev:live` or `bun run dev`. Never the shared service (port
    40375), its sessions or databases, or the live config under
    `~/.config/opencodeplus`.
- **Commits:**
  - Conventional messages (`fix(plus): …`).
  - No `.changeset` files. No push.
- **Landing:**
  - Review every worker diff yourself against the end-state lines it claims.
  - Land it with `team_integrate`.
  - Run the focused tests and the typecheck of every touched package in your
    worktree.
  - Stop the run.
- **Briefs:**
  - Point at this plan and the task plan as `briefFile`.
  - Name the end-state lines.
  - Use wide `scope.paths` (`packages/<name>/*`, `docs/*`).
  - Name the focused tests, and the live test with what must be seen.

### The log

Keep one log per worktree, committed as you go:
- `docs/plans/plus-1.1.15-overnight-instructions-log.md` (Part A);
- `docs/plans/plus-1.1.15-overnight-monitor-log.md` (Part B).

It is your memory across compactions: read it first after any break. It holds:
- **Progress:** each task's state, commits and the tests run.
- **Decisions:** what you decided and why.
- **Live tests:** when, what was done, what was seen. Quote screen text and
  log lines.
- **Issues:** one entry each (below).

### Live testing

Live-test whenever a big task has landed. That is every task below marked
**Live**, and any change visible in the TUI or a live server flow. When all
tasks have landed, run the **final sweep**: every end-state line of the task
plan, one by one, in one fresh build. Repeat the sweep after the fixes it
caused, until a sweep finds nothing new.

Give each live test to a worker. Write in the Brief:
- the build to run (the worker's own worktree is at your HEAD);
- the steps;
- what must be seen.

The worker reports the screen text and the `$LOG` lines.

### Issues: find, plan, fix

An issue is anything that does not match the task plan or works wrong. Sources:
- a live test or the final sweep;
- a failing test;
- your review;
- a worker's concerns or deferred items;
- an error in `$LOG`;
- anything else you notice in code you read.

For each issue:
1. **Record it in the log** (`A-<n>` or `B-<n>`):
   - what was seen, exactly;
   - where;
   - its weight: breaks an end state, wrong behaviour, or cosmetic;
   - its cause, if known.
2. **Plan the fix in the same entry:**
   - the outcome;
   - the files;
   - the test that proves it;
   - the live re-check.
3. **Fix it.** Delegate a worker with the entry as its Brief. Do it yourself
   only if it is a one-line fix.
4. **Land it** and repeat the check that found it. Record the commit and the
   result.

Limits:
- **Scope:**
  - Fix issues in your part's code and its tests.
  - An issue in code the other part owns (`src/monitor/**` and
    `src/tui/monitor/**` for Part B; `src/instructions/**` and
    `src/tui/instructions/**` for Part A): record it with evidence and leave
    it for the morning.
  - In the shared files (`src/index.ts`, `src/rpc.ts`,
    `packages/plus/README.md`, `src/tui/active-team.tsx`), keep each change
    small, and note it in the log for the morning merge.
- **Three rounds:** after three fix rounds on one issue, leave it open with
  everything learned.
- **Never trade an end state for a fix.** If a fix would break another end
  state, record both and leave the issue open.

## Known state at the start (checked 2026-10-05)

**Failing tests on `plus-1.1.15`.** Four `packages/plus` tests fail on
`plus-1.1.15` itself:
- `descriptions.test.ts`: "a tool's Description group, a team's Special group
  and permission categories" (the expected shell text is outdated);
- `plugin-commands.test.tsx`: "<leader>p opens Instructions and no
  plus.project command exists" and "the tools command is exposed as the
  lowercase slash command /tools" (setup fails in `src/tui/warming.tsx:157`);
- `team-query-off.test.ts`: "off on team.diff for a defaults-level team agent
  denies that tool and drops it from the catalog" (expects 2 registrations,
  gets 3).

Tasks A6 and B6 fix them.

**`plus-1.1.15_instructions`:**
- Holds T1, T2, T4, T5 and T8, from `team/Orchestrator/t125799-20261004-0301`.
  Workers live-tested them; nobody reviewed them.
- Full `packages/plus` suite: 2125 pass. Besides the four above, three tests
  fail because of this branch:
  - `rpc-contract.test.ts` "every method and event is declared": T8 added
    `category.mutate`;
  - `teams/permissions.test.ts` "instructions_show on a run edit-scope row
    reports the rules and the message each refuses with", and
    `teams/walkthrough.test.ts` "[20d] root bootstrap, delegate, context,
    checkpoint, finish, notification, integrate". Both still expect a team
    member's `item:defaults:<member>:…` echo, which T5 removed.
- Not merged yet:
  - **T6** `team/Flash-Implementer/t58b343-20261004-1306`. It merges cleanly.
    One of its tests fails: `test/rename.test.ts` "rename refuses built-in
    and ancestor-backed agents". An ancestor-backed agent is refused with
    "Agent legacy is built in and cannot be renamed"; the test wants the
    message to name the ancestor. The worker never ran this file.
  - **T3 + T7** `team/Flash-Implementer/t6086e7-20261004-1347`. It conflicts
    in `packages/plus/src/tools.ts` (1 hunk) and
    `packages/plus/src/tui/instructions/dialogs.tsx` (1 hunk, about 80 lines:
    T7 removes the old whole-row model editor). Its tests passed on its own
    base. T7's timings were never measured.
  - `team/Flash-Implementer/t415ab3-20261004-1047` is an older copy of T3 +
    T7. Do not merge it.

**`plus-1.1.15_monitor`:**
- Holds T1 (ledger v2, fingerprints, ping usage) and T4 (Team tab tree), from
  `team/Orchestrator/t131092-20261004-0301`. Merging it onto `plus-1.1.15`
  conflicted in `core/src/plugin/warming.ts` and `core/src/session/generate.ts`.
  These were resolved to keep both sides (merge commit `291ebb7c1d`):
  - 1.1.15 side: the ping pins the last real request's agent and model; the
    request is `durable: false`; the cache policy is
    `{ tools: true, system: true, messages: { tail: 2 } }`;
  - monitor side: the `warmed` phase and the `generated` hook.
- Full `packages/plus` suite: only the four failures above.
- **Known defect in the branch:** the `warmed` notification runs Plus's
  warming decision with `settings: undefined` (T1 review finding 6). The T2
  branch fixes it. Nothing from this branch may ship before B1 lands.
- Not merged yet:
  - **T2 + fixes for the 11 T1 review findings**
    `team/Heavy-Implementer/t54a9ef-20261004-1204` (`859d14b`, `e98e722`).
    It conflicts in `core/src/session/generate.ts` (14 lines),
    `core/test/session-generate.test.ts`, `plus/src/index.ts` and
    `plus/src/teams/api.ts`.
  - **T3 page** `team/Flash-Implementer/t45315d-20261004-1103` (`6191b90`).
    It was built on fixtures before T2 existed. After T2 it conflicts in
    `plus/src/rpc.ts` (3 hunks, about 220 lines), `monitor/query.ts`,
    `tui/monitor/format.ts` and `README.md`.
  - `t24fc37`, `t33750a` and `t32e12f` are earlier copies of the same work.
    Do not merge them.
- The T1–T4 contract between the analysis and the page:
  `docs/plans/plus-1.1.12-monitor-contract.md`.

## Part A: `plus-1.1.15_instructions`

Order:
- A1 and A3 (the two T5 tests) start together.
- A2 follows A1: both touch `dialogs.tsx`.
- A3's `rpc-contract` part comes after A1 and A2, because both may add
  methods.
- A4 and A5 follow A2.
- A6 runs any time.
- A7 runs last.

**A1. T6 rename (Live).**
- Merge `team/Flash-Implementer/t58b343-20261004-1306` yourself.
- Fix the ancestor-backed refusal: it must say the agent comes from an
  ancestor and cannot be renamed. Keep the built-in refusal for built-ins.
- Tests: `bun test test/rename.test.ts`, plus `bun typecheck`.
- Live: every T6 end-state line, including the refusals and
  `instructions.set({ id, rename })`.

**A2. T3 + T7 models (Live).**
- Merge `team/Flash-Implementer/t6086e7-20261004-1347` and resolve both
  conflicts. Keep T6's and T8's additions; T7's removal of the old model
  editor stands.
- Decision: editing a row's Model or Effort changes that row in place. When
  the old candidate is inherited, it is hidden at that level, so one row never
  becomes two; a later re-add restores it. Document this in the README's
  Models text.
- Tests in `packages/plus`:
  - `test/model.test.ts`
  - `test/rpc.test.ts`
  - `test/model-settings.test.ts`
  - `test/instructions-panes.test.tsx`
  - `bun typecheck`
- Live:
  - the T3 evidence case: activate a model through a member row of a team
    whose members exist only as team members; the next message of that
    member runs on it;
  - every T7 field row: Enter edits, `r` resets, the inherited sources
    show.

**A3. Repair the three failing tests.**
- `teams/permissions.test.ts` and `teams/walkthrough.test.ts`:
  - T5's end state is the contract: no team member appears under Defaults.
  - Expect the member row id. Drop the Defaults echo.
  - Check that `instructions_show` on the member's run edit-scope row still
    reports its rules and message.
- `rpc-contract.test.ts`: declare every method the branch adds, after A1 and
  A2.

**A4. T7 speed (Live).**
- Measure Defaults › Models and an agent's Models in the live build:
  - the first open after a server start;
  - three repeat opens.
- Method: `date +%s%3N` around the key press and pilotty's wait for the
  screen change.
- The targets: under 1.5 s first, under 300 ms repeat.
- If a target is missed:
  - profile, and fix the measured cause;
  - measure again.
- Record every number in the log.

**A5. T4 without the workaround (Live).**
- T4 added a refresh in `src/tui/active-team.tsx` (invalidate and sync
  `data.location.agent` on `instructions.changed`). With T2 present, find out
  whether it is still needed.
- If T2's `agent.updated` already refreshes the composer:
  - remove the workaround;
  - repeat the T4 live test: activate a model for an agent in Instructions;
    the open chat's composer shows it, and the next message uses it; a later
    composer pick still wins.

**A6. Repair the two stale mainline tests of this area.**
- `descriptions.test.ts` (outdated shell text).
- `team-query-off.test.ts` (2 versus 3 registrations).
- First find out whether the test or the code is wrong; fix the one that is.
  Record the decision.

**A7. Final sweep (Live).**
- First:
  - `bun test` (whole suite) in `packages/plus`;
  - the touched `packages/tui` tests;
  - `bun typecheck` in `packages/plus`, `packages/tui` and `packages/client`;
  - `bun run check` from the repository root.
- Then every end-state line of T1–T8 live, in one fresh build. T2 needs two
  TUIs on two folders.
- Then the issue loop, until a sweep finds nothing new.

## Part B: `plus-1.1.15_monitor`

Order:
- B1 first: it fixes a warming defect.
- B2 after B1.
- B3 any time after B2.
- B4 after B2.
- B6 any time.
- B5 last.

**B1. Merge T2 and the T1 review fixes (Live).**
- Merge `team/Heavy-Implementer/t54a9ef-20261004-1204` yourself.
- In `core/src/session/generate.ts`, keep everything `plus-1.1.15` has:
  - the pinned `agent`/`model` input;
  - `durable: false`;
  - the `LLMRequest.update` with the cache policy and the private prompt.

  Then add T2's changes (the `generated` hook with kind and error).
- Resolve the other three files keeping both sides.
- Tests:
  - `packages/core`:
    - `test/plugin/warming.test.ts`
    - `test/plugin/warming-ping-usage.test.ts`
    - `test/session-warming-prefix.test.ts`
    - `test/session-generate.test.ts`
    - `test/plugin/plan.test.ts`
  - `packages/plus`:
    - `test/monitor.test.ts`
    - `test/monitor-plugin.test.ts`
    - `test/monitor-requests.test.ts`
    - `test/monitor-cache.test.ts`
    - every other `test/monitor*` file. T2 deletes the stub
      `test/monitor-request.test.ts`; keep that deletion.
  - `bun typecheck` in `core`, `plugin` and `plus`.
- Live:
  - In the dev home, give one model short warming (Defaults › Models,
    e.g. `warm 4m · every 1m`).
  - Send two messages.
  - Wait through three pings.
  - Check:
    - `monitor.query` lists the pings as pings, with their usage;
    - the Plus warming status in the TUI does not change with each ping
      (finding 6);
    - the next message reads the cache.

**B2. Merge the T3 page and wire it to T2 (Live).**
- Merge `team/Flash-Implementer/t45315d-20261004-1103`.
- Reconcile it with T2:
  - the page renders what the real `monitor.query` returns (requests,
    agents, sessions, miss detail, pings) — the contract fields — not
    fixtures;
  - the storybook story's fixtures follow the same contract;
  - T2's tree scope (lifted to the topmost root) is what the page shows as
    Team tree.
- Tests:
  - `test/monitor-view.test.tsx`
  - the monitor tests
  - `bun typecheck` in `plus` and `tui`.
- Live: open `/monitor` and `/tools` and `M` from the composer tabs. Walk
  every tab, scope and window at 80 and 160 columns.

**B3. Review T1–T4 against every end-state line.**
- Read the landed diffs yourself:
  - T1: ledger v2, fingerprints, privacy, migration, retention,
    idempotency;
  - T2: verdicts, causes in their order, extra signals, tools and their
    descriptions;
  - T3: page, keys, hint bar, layouts, README `## Monitor`;
  - T4: Team tab tree, `ctrl+t`, empty state, README `## Team tab`.
- Each gap becomes an issue.

**B4. Real cache misses (Live).**
- In one dev session, cause each case on purpose:
  - toggle an instruction row between two messages;
  - switch the model;
  - switch the agent;
  - turn warming off and wait past the cache lifetime;
  - compact.
- Each must show on the Cache tab with the right verdict and cause, and Enter
  must show its evidence.
- Then have the agent in that session call `monitor.query` for its misses and
  one miss's detail. The answer must match the page.
- Model:
  - Use `cliproxyapi/deepseek-v4.1-flash-cheap` if its requests report cache
    fields.
  - If they show "no cache reported", use `cliproxyapi/claude-fable-5-1`, with
    as few messages as the cases need.
- Team scopes:
  - create a project team from the `basic` preset in the dev home;
  - delegate one small report task;
  - check the Team tree and Team scopes and the composer Team tab;
  - stop the run.
- The CLIProxyAPI relay is known to move Anthropic cache breakpoints (1.1.14
  qualification: the first ping read only the tools). A miss the analysis
  calls *unknown* there is a finding to record with its evidence, not a
  failure of T2.

**B5. Final sweep (Live).**
- First:
  - `bun test` (whole suite) in `packages/plus`;
  - the touched `packages/core` and `packages/tui` tests;
  - `bun typecheck` in `core`, `plugin`, `plus` and `tui`;
  - `bun run check` from the repository root.
- Then every end-state line of T1–T4 live, in one fresh build.
- Then the issue loop, until a sweep finds nothing new.

**B6. Repair the stale `/tools` command tests.**
- `plugin-commands.test.tsx`: its setup fails in `src/tui/warming.tsx:157`.
- Fix the test harness or the code, whichever is wrong, so both tests pass
  with T3's `/monitor` and its `/tools` alias.

## Done

A part is done when all of these hold:
- every task above has landed;
- every end-state line of its task plan is verified by a test or live, or is
  recorded as open with its reason;
- its whole `packages/plus` suite passes, and so do the typechecks and
  `bun run check`;
- the last final sweep found nothing new;
- every child is stopped;
- the log is committed.

Then tell the user, in the chat, briefly:
- what landed (commits);
- how each end state was verified;
- the issues fixed and the issues left open;
- anything the morning merge into `plus-1.1.15` must know (shared-file
  changes).

## Start prompts

Open a TUI in each purpose worktree, pick `Simple-Orchestrator`, and send:

**`plus-1.1.15_instructions`:**
```text
You are in purpose worktree plus-1.1.15_instructions of release plus-1.1.15.
This is an overnight run and the user is asleep: never ask, decide and log.
Do Part A of docs/plans/plus-1.1.15-overnight.md by its rules and in its
order, with its live tests and its issue loop, until its Done holds. The task
plan is docs/plans/plus-1.1.12-instructions.md. Keep your log in
docs/plans/plus-1.1.15-overnight-instructions-log.md and read it first after
any break. Do not merge into plus-1.1.15.
```

**`plus-1.1.15_monitor`:**
```text
You are in purpose worktree plus-1.1.15_monitor of release plus-1.1.15.
This is an overnight run and the user is asleep: never ask, decide and log.
Do Part B of docs/plans/plus-1.1.15-overnight.md by its rules and in its
order, with its live tests and its issue loop, until its Done holds. The task
plan is docs/plans/plus-1.1.12-monitor.md. Start with B1: the branch has a
warming defect until it lands. Keep your log in
docs/plans/plus-1.1.15-overnight-monitor-log.md and read it first after any
break. Do not merge into plus-1.1.15.
```
