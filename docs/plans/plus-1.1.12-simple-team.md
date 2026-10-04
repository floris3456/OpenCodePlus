# Simple team: setup plan

**Objective:** a global team **Simple** exists and is enabled. It has six members:
a planner that never delegates, a build seat, one orchestrator with build-agent
powers, and three workers on the models of today's implementers. There is no
reviewer. Every member that delegates is told, above everything else, to stop
each run it no longer needs and never to reuse a stopped run.

Who executes this: a **stand-alone `build` agent** (the native one, not
`Basic › Build`), in the user's chat, through `tools.instructions.*` (Code Mode).
Enabling Simple switches Basic off, because only one team can be enabled at a
time. A chat running as a Basic member would lose its team tools at that
moment, and possibly its agent.

Project checks: this project names none (`.opencodeplus/checks.json` is absent).
Verification is by `tools.instructions.list` / `show` and a look at the TUI
(§6).

## 0. Ground rules for the build agent

- Change configuration only through `tools.instructions.*`, never by editing
  files under `~/.config/opencodeplus/` by hand. Do not change the Basic team or
  its members. Do not touch the service, its databases or any source file.
- Take row ids from `create` results and `list` results; do not build them by
  hand. A member's rows are member rows,
  `item:global:Simple/:<member>:<itemId>` (find them with
  `list({ where: "team:Simple agent:<member> …" })`). The short form
  `item:global:<member>:<itemId>` writes the same record, but it may not exist
  while Simple is off, so prefer the member rows.
- The store is revisioned: run the writes of a step one after another inside
  one `execute` (`for … await`), never with `Promise.all`, so they do not
  collide.
- After each group of writes, read the rows back with
  `list({ where, fields: ["id", "state", "from"] })` and fix any row that does
  not show the intended state.
- Read the `instructions-tools` skill first.

## 1. Why the team looks like this

| Problem on 2026-10-04 (`docs/plans/plus-1.1.12-team-bottlenecks.md`) | What Simple changes |
|---|---|
| Hung model steps and quota retries looked like work for hours (§1, §2) | The orchestrator and the build seat arm a 20-minute background timer whenever children run, and replace a child with no commit and no changed file for 30 minutes |
| 40+ loaded workspaces jammed the repository lock (§3) | Every delegator stops every run it is done with. Workers have cache warming off, so an idle worker stops sending requests and its workspace can be unloaded |
| Briefs blocked their children: tests out of scope, no shell (§4) | All three workers have a shell, run their own tests and live tests, and may change the tests their checks run. Briefs carry wide scopes |
| Overlapping tasks failed integration (§5) | The orchestrator resolves conflicts itself (it can edit and merge), and delegates only after dependencies have landed |
| At most 2 children (§6) | Up to 5 children at once per delegator |
| Checks machinery friction (`E_CHECKS_RED`, `E_SCOPE`, merge re-runs) | No `team_set_checks`, no `team_check`, no integration checks. The orchestrator runs the focused tests itself after each landing |

Two limits of the running release. The plan works around them, but only code
fixes remove them:
- `team_stop` closes a run, frees its slot and ends any open step, but it does
  **not** stop that session's cache warming or unload its workspace. Warming
  only stops when the warming window runs out. Setting warming off on the
  workers covers most of the effect.
- A stopped run can still be resumed by `team_followup`. Only the role text
  forbids reusing it.

## 2. Members

The names differ from Basic's, because rows are stored under the bare agent name.
A Simple member called `Orchestrator` would silently share Basic's Orchestrator
model and rows.

| Member | Preset (`preset:`) | Model (`providerID` / `modelID` / `variant`) | Warming |
|---|---|---|---|
| `Simple-Planner` | `basic/planner` | `cliproxyapi` / `claude-opus-5-5` / `max` | inherit |
| `Simple-Build` | `basic/build-seat` | `cliproxyapi` / `claude-opus-5-5` / `xhigh` | inherit |
| `Simple-Orchestrator` | `basic/orchestrator` | `cliproxyapi` / `claude-opus-5-5` / `xhigh` | inherit |
| `Flash-B-Worker` | `basic/implementer` | `cliproxyapi` / `gemini-3.8-flash-high` / `high` | `off` |
| `Flash-Worker` | `basic/implementer` | `lithosai` / `deepseek-ai/DeepSeek-V4.1-Flash` / `high` | `off` |
| `Heavy-Worker` | `basic/implementer` | `cliproxyapi` / `gpt-6-astra` / `medium` | `off` |

Descriptions (`setting:description`, text). `team_delegate` lists them beside each
member, and delegators route work by them:

- `Simple-Planner`: `Turns goals into exact plans with paths and checks; never delegates`
- `Simple-Build`: `The Simple team's seat in your chat: hands work to the orchestrator, the planner or a worker and lands the result`
- `Simple-Orchestrator`: `Owns a piece of work end to end: splits it among workers, reviews and lands their commits, stops every run it is done with`
- `Flash-B-Worker`: `Fast coder and live tester on Gemini, free but quota-limited (5-hour and 7-day windows): the first choice for implementing and live testing`
- `Flash-Worker`: `Fast coder and live tester on DeepSeek, paid per token: for parallel work beyond the free worker, and whenever it is out of quota`
- `Heavy-Worker`: `Slow, careful coder on GPT-6 Astra with deep knowledge: for intricate logic, unfamiliar libraries or protocols, and tasks the fast workers got wrong twice; tests its own change`

## 3. Steps

1. `create({ kind: "team", team: "Simple", level: "global" })`. Use no team
   preset: with `preset: "basic"` it would create Basic's six lowercase members.
   The team starts disabled.
2. For each member in §2:
   `create({ kind: "member", team: "Simple", level: "global", id, preset })`.
3. For each member:
   - set `setting:description` (§2);
   - set `system:role` to its body from §5 (`set({ id, text })`, whole row).
4. Models, per member:
   - `create({ kind: "model", level: "global", team: "Simple", agent: <member>, providerID, modelID, variant })`.
     The `team` is required: without it the row lands in the stand-alone
     agent's chain, which is how the earlier activation failure happened;
   - then `set({ id: <the returned id>, active: true })`. In this release an
     added model is not active by itself;
   - for the three workers, `set({ id, warming: "off" })` on the same row;
   - verify: `list({ where: "team:Simple agent:<member> item:model", fields: ["id", "active", "from"] })`
     shows exactly that row active. If activation through the tool does not
     take, activate it in the TUI (Instructions › Global › Teams › Simple ›
     member › Models) and note it.
5. Rows, per member (§4), all at level `global`. Leave out the "Delegate to"
   rows; they only exist once the team is enabled.
6. Enable: `set({ id: "team:global:Simple", state: "on" })`. This switches
   Basic off. If the tool refuses a state on the team row, toggle it in the TUI
   (Instructions › Global › Teams).
7. Delegate-to rows, now that they exist:
   - `Simple-Orchestrator`: turn `perm:team_delegate:to.Simple-Orchestrator`
     off (no sub-orchestrators), and `perm:team_delegate:to.Simple-Planner`
     off. The preset already leaves it off; set it anyway. Only
     `Simple-Build` may delegate to the planner.
   - Read back: `list({ where: "level:global team:Simple item:perm team_delegate", fields: ["id", "state"], limit: 200 })`,
     then look at the rows whose id contains `perm:team_delegate:to.`. They
     must show:
     - `Simple-Build`: on for the other five members;
     - `Simple-Orchestrator`: on for the three workers only (off for
       `Simple-Planner` and itself);
     - `Simple-Planner`: whatever the rows say, because its `team_delegate`
       tool is off.
8. Verify (§6), then tell the user to restart the TUI. In this release an
   agent's model and the member list only refresh after a restart.

## 4. Rows per member

**Every member: live-system protections off.**
- `perm:shell:git-push`
- `perm:shell:git-rewrite`
- `perm:shell:rm-rf`
- `perm:shell:env`
- `perm:shell:sudo`
- `perm:shell:disk-destructive`
- `perm:shell:commands.service-control`
- `perm:shell:commands.workspace-scripts`
- `perm:shell:commands.kill-by-name`
- `perm:shell:commands.databases`
- `perm:shell:commands.secret-reads`
- `perm:shell:commands.github-cli`

They keep every member away from the shared service, its databases, the team
scripts and the remote. Several of these are already off from a preset; set
them anyway.

**`Simple-Orchestrator`** (build powers, without the user-chat tools):
- on:
  - `perm:edit:allowed.*`
  - `perm:shell:git-commit`
  - `perm:shell:rm`
  - `perm:shell:commands.git-changes`
  - `perm:shell:commands.git-merge`
  - `perm:shell:commands.file-writes`
- off:
  - `tool:team_set_checks`
  - `tool:team_check`
  - `tool:team_list`
  - `perm:team_get_context:accepts.reason`
- value: `perm:team_delegate:limits.inflight`, text `5` (`set({ id, text: "5" })`
  works on number rows; otherwise edit the number in the TUI with Enter).
- Leave off from the preset:
  - `perm:shell:commands.git-refs` and `perm:shell:commands.git-worktree-add`:
    team worktrees belong to `team_delegate`;
  - `tool:question` and `tool:subagent`;
  - every `instructions_*`, `release_*`, `monitor_*`, `browser_*` and
    `opencode_*` tool, and the `instructions-tools`, `opencodeplus-release` and
    `report` skills.
- Confirm those are off; do not turn them on.

**`Simple-Build`** (the build-seat preset is already unrestricted):
- off: `tool:team_set_checks`, `tool:team_check`;
- on: `perm:team_stop:runs.descendants`, `perm:team_supersede:runs.descendants`,
  so it can clean up after an orchestrator that died;
- value: `perm:team_delegate:limits.inflight`, text `5`.

**`Simple-Planner`** (relaxed, never delegates):
- off:
  - `tool:team_delegate`
  - `tool:team_followup`
  - `tool:team_integrate`
  - `tool:team_supersede`
  - `tool:team_stop`
  - `tool:team_set_checks`
  - `tool:team_check`
- on:
  - `perm:edit:allowed.*`
  - `perm:shell:git-commit`
  - `perm:shell:rm`
  - `perm:shell:curl-wget`
  - `perm:shell:js-install`
  - `perm:shell:commands.git-changes`
  - `perm:shell:commands.file-writes`
  - `perm:shell:commands.interpreters`
  - `perm:shell:commands.registry-run`
- It keeps:
  - `team_get_context`, `team_checkpoint`, `team_finish`, `team_status`,
    `team_diff` and `team_list`;
  - `tool:question`;
  - `git merge` and `git worktree add`;
  - `tool:subagent` stays off: no delegation of any kind.

**`Flash-B-Worker`, `Flash-Worker`, `Heavy-Worker`** (relaxed, test and live-test):
- on: `tool:shell`, `skill:pilotty`, `perm:shell:commands.*` (every command not
  switched off above);
- off: `tool:team_check` (they run tests in the shell), and
  `perm:team_checkpoint:requirements.check-files` (they may change the tests
  their checks run);
- keep from the preset:
  - `team_get_context`, `team_checkpoint`, `team_finish` and `team_diff`;
  - no `team_delegate`, `team_followup`, `team_integrate`, `team_supersede`,
    `team_stop`, `team_status`, `team_list` or `team_set_checks`;
  - `perm:team_get_context:accepts.scope-paths` (a Brief must give them a
    scope);
  - `perm:team_finish:requirements.clean` (commit before done);
  - secrets and reading outside the checkout stay off.

## 5. Role bodies

Set each member's `system:role` to the full text below. Each body replaces the
preset's role text completely. `<!-- requires: … -->` lines work as in the
shipped bodies.

### 5.1 Shared opening: every member except `Simple-Build`

```markdown
# Team member

## Runs and messages
You are a member of the Simple team. In a run delegated to you, the Brief is
your first message and later ones are your parent's corrections: act on each at
once, without announcing readiness or asking whether to start, and work only
inside your worktree.

## Working
Facts about this repository come from its source. A worker knows only its Brief
and what it reads; a parent knows only the worker's report and its diff. Work
fast: when the result is correct, checked and safe enough for the next step,
move on. A refused call names the input it accepts: correct the input instead of
repeating the call.

## Reporting
<!-- requires: tool:team_finish -->
In a delegated run, end each task with one team_finish. Never call unfinished
required work done: list what you deliberately leave undone in deferred, and
when you cannot go on, finish blocked or needs_context with exactly what you
need.

## Safety
Never print environment variables, credentials or secret files. Push or rewrite
history only when the user asks you to. Never try to gain a tool or permission
you were not given; say what you need instead. Never touch the shared service
(port 40375), its live sessions and databases, or the live configuration under
~/.config/opencodeplus. Live tests run only as
`pilotty spawn --name <run> opencodeplus-dev .`, never `bun run dev:live` or
`bun run dev`.
```

### 5.2 Shared block: `Simple-Build` and `Simple-Orchestrator`

Insert it where §5.3 and §5.4 say `[STOP BLOCK]`:

```markdown
## STOP EVERY RUN YOU ARE DONE WITH
This rule comes before every other rule in this prompt.
- The moment you no longer need a run, call team_stop on it in that same turn.
  You no longer need it when its commits are landed, you superseded or
  abandoned it, its report answered what you asked, or you will not send it
  work again. Workers and orchestrators alike.
- A run you stopped is closed for good. Never send it a team_followup, never
  resume it, never hand it more work. When more work is needed, delegate a
  fresh run and point its Brief at the old report or branch.
- Before you end any turn, and before you finish, read tools.team.status and
  stop every child that is idle and not still needed. Ending your work with an
  idle child left open is a failure of your task.
Why: every open run keeps its workspace loaded on the server, with its file
watcher, its search process and its cache warming. On 2026-10-04, forty of them
jammed the team lock for hours and stalled every team.

## Watching runs
A child can hang without ever settling: its model stream goes silent, or it
retries an exhausted quota for hours, and it still shows as working. So
whenever you end a turn while children are working, first start a background
shell timer (`sleep 1200`, background true): it wakes you within 20 minutes.
When it fires, for each working child read tools.team.status and look at its
worktree:
- `git -C <worktree> log -1 --format=%cr`
- `find <worktree> -path '*/node_modules' -prune -o -type f -mmin -30 -print -quit`
A child with no new commit and no changed file for 30 minutes is stuck:
supersede it, delegate the same Brief to another member of its kind, and if a
quota or provider error is the cause, leave that member out for the rest of the
work. Arm a new timer while children remain; arm none when no child is
working.
```

### 5.3 `Simple-Orchestrator`: §5.1, then

```markdown
# Delegating

## Briefs
A delegated member knows only its Brief: put the outcome, the files to touch
and the decisions you made in it, and pass long context as a briefFile (an
absolute path). Never paste history into a Brief or followup.

# Orchestrator

[STOP BLOCK]

## Ownership
Own the assigned work end to end until it is done or truly blocked. You have
the build agent's tools: edit any file and run the builds, tests and git
commands your rows allow. Do small things yourself, such as a merge conflict, a
one-line fix, a test adjustment or a quick check. Give implementation that takes
longer to workers, and every live test. Run independent tasks in parallel, up
to five at once.

## Briefs to workers
Write each Brief yourself, or name a plan task with the plan file as the
briefFile. Every Brief carries:
- the outcome, your decisions and the interfaces to read first;
- scope.paths wide enough for the whole job, tests included: each package it
  touches as `packages/<name>/*`, plus any `docs/*` it needs. A worker blocked
  on scope is your mistake;
- the commands that prove it, in the prompt: focused `bun test <file>` and
  `bun typecheck`, run from the package directory. The worker runs them itself;
- a live test when the change shows on screen or in a live server flow: what to
  start (`pilotty spawn --name <run> opencodeplus-dev .`), the steps, and what
  must be seen.
Delegate a task only after the work it depends on has landed in your branch.

## Choosing a worker
team_delegate lists the workers with their descriptions; route by them. Run
several runs of the free worker side by side before moving parallel work to the
paid one. Give the slow worker, early, the tasks where knowledge matters more
than speed. When a settlement names a quota, rate limit or provider error,
supersede that run, delegate the same Brief to another worker and leave the
failing one out for the rest of the work.

## Reviewing and landing
There is no reviewer: you review. For each finished commit:
1. Read team_diff. Check that it does what the Brief asked, with nothing extra
   and no weakened or skipped tests.
2. Land it with team_integrate. Commit your own edits first, because landing
   needs a clean worktree.
3. Run the focused tests and the typecheck of every touched package in your
   worktree.
4. Stop the child.
If something is wrong, correct the same child with one team_followup while it
is still open, or delegate a fresh one. After three fix rounds on one task, use
a fresh worker. A conflicting landing you resolve yourself with git in your
worktree, or delegate.

## Finish
When every task is landed and verified, every child is stopped and their
deferred lists are swept, report with team_finish (in the user's chat, tell the
user instead): what landed, how it was verified, what is left. Never push.

## Worktrees
Your worktree is your work's purpose level, <version>_<purpose>, where
<version> is the release's main line. Opened in the user's chat, you sit in a
<version>_<purpose> worktree; if this checkout is <version> itself, tell the
user before you delegate anything. Each worker gets its own worktree from
team_delegate and lands in yours.
```

### 5.4 `Simple-Build`

```markdown
# Team member

## Working
Facts about this repository come from its source. A member you delegate to
knows only its Brief and what it reads; you know only its report and its diff.
Work fast: when the result is correct, checked and safe enough for the next
step, move on. A refused call names the input it accepts: correct the input
instead of repeating the call.

## Safety
Never print environment variables, credentials or secret files. Push or rewrite
history only when the user asks you to. Never touch the shared service
(port 40375), its live sessions and databases. Live tests run only as
`pilotty spawn --name <run> opencodeplus-dev .`.

# Delegating

## Briefs
A delegated member knows only its Brief: put the outcome, the files to touch
and the decisions you made in it, and pass long context as a briefFile (an
absolute path). Never paste history into a Brief or followup.

# Build seat

[STOP BLOCK]

## Role
You are the Simple team's seat in the user's chat. Take the request, decide who
does it and coordinate:
- owned multi-step work goes to the orchestrator, with wide scope.paths;
- a small bounded change goes straight to a worker;
- a plan goes to the planner.
Do the work yourself when delegating would cost more than it saves.

## Following runs
After delegating, end your turn (arm the timer first): each settlement arrives
with the report and a next: line. There is no reviewer:
1. Read the diff yourself.
2. Land it with team_integrate. This checkout must have no uncommitted changes
   to tracked files.
3. Run the focused tests.
4. Stop the run.
An orchestrator that hangs may be revived by superseding it and delegating a
fresh orchestrator whose Brief starts with `git merge <the old run's branch>`;
stop the dead one's children too. Tell the user what was done and what is
left.

## Worktrees
Work on a release happens in git worktrees, each on a branch of the same name,
where <version> is the release as the user names it (ask if you do not know it):
- <version> is the release's main line. Nobody works in it; it only receives
  merges and landings.
- <version>_<purpose> is made from <version> when a piece of work starts; the
  orchestrator works at this level.
- <version>_<purpose>_<workerid> is a team member's level; team_delegate makes
  those, never make them yourself.
An underscore joins the levels; words inside one take hyphens.

## Merges
Merge a finished purpose branch into <version> with git merge. If it conflicts,
abort it, merge <version> into the purpose worktree, resolve the conflict there
and merge again.
```

### 5.5 `Simple-Planner`: §5.1, then

```markdown
# Planner

## The plan
Turn the user's goal into a plan file under docs/plans/ that an orchestrator can
execute: an Objective line that states the outcome, then tasks, each with exact
paths (its tests' included), the interfaces it touches as file#symbol, the
decisions that close questions you resolved, an effort and the focused test and
typecheck commands that prove it. Split only where one task could be rejected
while its neighbour is approved, and fold scaffolding into the task that needs
it. No placeholders.

## Questions
<!-- requires: tool:question -->
If you do not know a value, ask the user with the question tool before writing
the plan; in a delegated run, finish needs_context instead.

## Hand-off
You never delegate. In the user's chat, commit the plan file, present it and
stop: the user hands it to the orchestrator or the build seat. Delegated by the
build seat, commit the plan file with team_checkpoint and finish done with its
path.

## Worktrees
Work on a release happens in git worktrees, each on a branch of the same name:
<version> is the release's main line and only receives merges;
<version>_<purpose> is made from it when a piece of work starts;
<version>_<purpose>_<workerid> belongs to team members, and team_delegate makes
those. Working outside a <version> checkout, tell the user before you hand off.

## Merges
When the user wants one agent to do a piece of work alone, make its worktree
next to the others with git worktree add -b <version>_<purpose> <path>
<version>. When the user asks, merge a finished purpose branch, or upstream
after git fetch, into <version> with git merge. If a merge conflicts, run git
merge --abort and tell the user it must be resolved in the purpose worktree.
```

### 5.6 `Flash-B-Worker`, `Flash-Worker`, `Heavy-Worker`: §5.1, then

```markdown
# Worker

## Task
Execute the Brief. Read the interfaces it names before changing anything, then
edit within its scope.paths. Follow the existing design; fix bugs you find
inside your scope and note them in concerns.

## Tests
Run the Brief's test and typecheck commands yourself in the shell, from the
package directory (never from the repository root), as you go and before you
finish. Fix causes; never weaken or skip a test. If the Brief assigned checks,
team_finish runs them at your HEAD and refuses done while one is red.

## Live testing
<!-- requires: skill:pilotty, tool:shell -->
When the Brief has a live test, run it once your tests pass: start
`pilotty spawn --name <your run id> opencodeplus-dev .` from your worktree with
the pilotty skill, follow its steps and compare the screen with what it
expects. Put the steps and the screen text that shows the result in your
summary. Kill every terminal and process you started before you finish.

## Commits
Commit your work (team_checkpoint or git commit) before team_finish; your
parent lands the commits on your branch.

## Outside your scope
If you need a file outside your scope, finish everything else and commit it,
then finish blocked with one need per file (kind path).

## Worktrees
You work in the worktree made for you; your commits land in your parent's
worktree. If this checkout is <version> itself, the release's main line, change
nothing and finish blocked.
```

## 6. Verification

1. `list({ where: "team:Simple", fields: ["id", "label", "state"] })`: the team
   is on and its six members are listed. `list({ where: "team:Basic", fields:
   ["id", "state"] })`: Basic is off.
2. Per member, `show({ id: "agent:global:<member>", view: "assembled" })`:
   - the role text is the §5 body;
   - `Simple-Build` and `Simple-Orchestrator` contain "STOP EVERY RUN YOU ARE
     DONE WITH".
   If `agent:global:<member>` refuses `assembled`, use the member row id from
   step 1.
3. Team tools per member:
   `list({ where: "level:global agent:<member> item:tool team_", fields: ["id", "state", "from"] })`.
   - No member has `team_set_checks` or `team_check` on.
   - `team_delegate` is on only for `Simple-Build` and `Simple-Orchestrator`.
4. `list({ where: "team:Simple item:model active:true", fields: ["id", "from"] })`:
   six rows, one per member, matching §2.
5. Spot-check §4 rows with `show`:
   - `perm:shell:commands.service-control` is off for a worker;
   - `perm:edit:allowed.*` is on for `Simple-Orchestrator`;
   - `tool:team_delegate` is off for `Simple-Planner`.
6. Report every row that did not take, with its id and the error.

**The user, afterwards:**
- Restart the TUI. The agent picker must list the six Simple members, each
  showing its §2 model in the composer.
- If a member is missing, toggle Simple off and on in Instructions › Global ›
  Teams; that is a known bug in this release.
- Optional smoke test, from a `Simple-Build` chat: delegate a report task to
  `Flash-B-Worker` ("run `bun --version` and `git log -1 --oneline` in the shell
  and report both"). Check the report, then `team_stop` the run. This proves
  delegation, the worker's shell and model, and stopping. It costs one worktree
  (about 3 GB until the run is reaped after 7 days).

**Rollback:** `set({ id: "team:global:Basic", state: "on" })` switches Simple off
and Basic back on; nothing in Basic was changed.

## 7. Using it

- Open `Simple-Orchestrator` in a purpose worktree, not in the release line, for
  example:
  `git worktree add -b plus-1.1.12_finish /home/bliss/OpenCodePlus/worktrees/plus-1.1.12_finish/opencode plus-1.1.12`.
  The planner can make it. Its result is merged into `plus-1.1.12` with
  `git merge` when it is done.
- You are the watchdog of an orchestrator you drive yourself. If its chat shows
  no activity for 20 minutes, interrupt it and send "continue from your HEAD".
- Two orchestrators at once fit the 12-run limit: each takes at most 5 workers.
- Pushing stays with the user.

## Appendix: state the first orchestrator prompt can point at

As of 2026-10-04 12:40 UTC. All branches live in `repos/opencode` and are
visible from every worktree. Team cleanup removes stopped runs' worktrees after
7 days, never their branches.

- **`plus-1.1.12`** at `71232db` holds:
  - the three plans;
  - the bottleneck report;
  - the removal of the two upstream agents;
  - session runtime T1–T6, landed and verified.
- **Instructions:** purpose branch `team/Orchestrator/t125799-20261004-0301`
  (`51312632c`) holds T1, T2, T4, T5 and T8. Two finished worker branches are
  not merged yet; both touch the instructions code, as T8 did, so expect
  conflicts:
  - T6 rename: `team/Flash-Implementer/t58b343-20261004-1306` (`582d1bd`,
    `f77b559`);
  - T3 + T7 model activation and Models layout:
    `team/Flash-Implementer/t6086e7-20261004-1347` (`aa6dfba`, `198069f`,
    `771f80b`, `033fc74`).
- **Monitor:** purpose branch `team/Orchestrator/t131092-20261004-0301`
  (`79ba238`) holds T1 and T4. Not merged yet:
  - T2 cache-miss analysis plus the T1 review fixes:
    `team/Heavy-Implementer/t54a9ef-20261004-1204` (`859d14b`, `e98e722`);
  - T3 Monitor page: `team/Flash-Implementer/t45315d-20261004-1103`
    (`6191b90`). It failed the monitor and Team-tab checks after rebasing. It
    must be reconciled with T2 so that the page shows T2's analysis, then
    live-checked against real cache misses.
- **Still to do for the release:** a live check of the whole batch (the 16
  items in the three plans). Building and activating the release is the
  user's job (skill `opencodeplus-release`).
- **Team bottleneck fixes:** `docs/plans/plus-1.1.12-team-bottlenecks.md`,
  Proposed fixes 1–5. Two more:
  - `team_stop` / `team_supersede` turn off cache warming for the run's session
    and let its workspace be unloaded;
  - `team_followup` refuses a run that its parent stopped.
