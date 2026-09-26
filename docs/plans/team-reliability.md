# Team reliability: small fixes, real acceptance tests

Status: **planned; implementation and candidate live acceptance are not yet run**.
Source baseline: `7c113a154f54bd5c333712c2e67ca7f61486dcc5`.
Input: [field verification report](../reports/team-field-verification.md).

## Goal and working rules

Make the workflow that failed in the field test work reliably: configure a team,
delegate bounded work, receive reports, continue the lead, correct a worker,
integrate, inspect history, and finish the lead with a saved report.

- Fix demonstrated failures and closely related unsafe admission paths first.
  Do not turn the recommendations into a new orchestration framework.
- Prefer existing APIs, state transitions, permissions, and test fixtures. Add
  neither another task board nor a second event/usage store.
- Use fast Gemini Flash models for both test leads and workers. Discover the
  actual model catalogue first: prefer `gemini-3.8-flash` if exposed; the previous
  host demonstrably offered `cliproxyapi/gemini-3.8-flash-high`. If Gemini 3.8
  Flash is unavailable, **GPT Luna 5.6 is an explicitly permitted fallback** for
  both test leads and workers. Resolve its exact provider/model ID from the
  catalogue and record the fallback in the evidence. Do not invent IDs or
  silently substitute another model.
- One implementer at a time by default. A general sub-agent may own a bounded
  implementation task in its own worktree; do not share a writing worktree.
  No chain of planning/review agents. At most one targeted review of changed
  lifecycle/permission boundaries; live results, not review count, decide done.
- Use focused regressions, then provider-backed live tests of the candidate.
  Unit tests or a source read alone cannot close a live failure.
- Preserve all safety rules, ownership checks, check gates and report guards.
  No controller restart, release promotion, foreign-run mutation, secret commit,
  or edits to live runtime records. This is product Plus code, not workspace
  `scripts/team`; its build/restart workflow must not be applied to this task.

## Second-pass decisions

The previous report mixes bugs, deliberately chosen contracts, and larger product
ideas. They should not all receive the same treatment.

| Finding | Decision for this repair pass |
| --- | --- |
| First root finish rejected after external continuation | Fix attempt admission; keep duplicate-report protection |
| Removed worktree breaks history and accepts execution targets | Fix historical reads and reject unavailable execution targets |
| Idle Session retains MCP cwd | Guard removal and retain when unsafe; do not build a general process manager |
| Stopped-child queued correction cannot progress | Resume a valid stopped child through existing admission; never acknowledge undeliverable work as queued |
| Negative scope is advisory; same-role scopes are unioned | Enforce the calling run's scope using existing session-aware permission hooks and checkpoint validation |
| Model creation loses team owner | Use the TUI's existing owner resolution in the tool |
| `show.from` mixes state/text provenance | Expose both existing provenance values; do not change inheritance |
| Zero-token telemetry; attempts called turns | Read existing Session totals and name the counter honestly; keep budgets advisory |
| Replay returns stale starting state | Label the admission replay and return a fresh current-state observation |
| Activation is exclusive | Preserve the contract; clearly report which teams activation disables |
| Split native/Code Mode discovery and hardcoded role names | Improve existing tool guidance/context using the actual roster; no new catalogue service |
| Lost structured error properties | Keep actionable code/message/accepted guidance; transport-wide error changes are deferred |
| Team selection, mailbox management, correction wizard, preflight framework | Defer; not necessary to repair the tested workflow |

### Context retrieved to avoid unnecessary design work

- `teams/lifecycle.ts:197–207` reopens run state without opening an attempt;
  `:316–359` already admits attempts for inbox delivery. Reuse that vocabulary
  and the run lock rather than replacing the lifecycle.
- `teams/run.ts:149–152` already defines stopped-to-starting followup/resume.
  Fix the missing implementation rather than silently removing that capability.
- `packages/plugin/src/effect/permission.ts:7–20` exposes `sessionID`, resources,
  action and the permission effect. Per-run enforcement does **not** require a
  new Core permission architecture.
- Delegation already saves `brief.json`, including `scope.forbidden`
  (`teams/api.ts:433–434`). Existing runs have an authoritative scope source;
  do not discard their exclusions or migrate the live database.
- `Session.Info.tokens` and `TokenUsage.total` already exist in Schema, and
  `ctx.session.get` is exposed by the plugin domain. Do not invent token counters
  or parse provider transcripts for ordinary budget reporting.
- The plugin MCP domain currently exposes listing/transform/reload, **not** a
  child-location disconnect operation. Automatic dependency teardown would be
  more than a local fix. Retention is the safe small first implementation.
- Both integration and GC reach `teams/worktree.ts:146–157`; fixing only the
  integration caller would leave another removal path unguarded.

## Execution order

### 0. Prepare one bounded live harness

Reuse the prior tiny Git fixture pattern and public-client driver, not the old
finished sessions. Give this run its own fixture, Instructions state, database,
credentials, ports, ownership record and evidence directory under
`run/team/team-reliability/runs/<run>/`.

Use an explicitly launched **owned candidate host**, with source/build identity
pinned to the tested checkpoint and no changing source beneath it. Prefer the
existing isolated source-test launcher or existing candidate build path; do not
invent a release controller. The source launcher `bin/opencodeplus-dev` already
uses a private home and standalone host, but its copied provider configuration
must remain private and outside Git. Retain reviewed bootstrap safety guidance.

Connect the matching public client to that explicit endpoint. Do not use implicit
service discovery that can replace the live service. Verify health PID, executable
or source snapshot, version, loaded Plus identity and API compatibility. Testing
the old r4.6 host again would not validate these fixes. `dev:live` likewise targets
the elected host, not automatically the candidate.

Configure an isolated fast-model lead and worker/reviewer presets. Reuse one lead
and two same-role child sessions where practical; a fresh reviewer is optional,
not a mandatory expensive review stage. Set explicit focused checks and bounds.
Keep product implementation work on the known-good host; candidate sessions only
execute the disposable acceptance task.

### 1. Repair attempt admission and stopped followups

Files: `teams/lifecycle.ts`, `run.ts`, `api-followup.ts`, finish handling in
`api.ts`; corresponding lifecycle/followup tests.

1. At execution start, open a new attempt when the existing one is terminal or
   absent. Reuse an already-admitted open attempt from bootstrap/delegation/inbox
   delivery. Make this decision within the existing run-state lock.
2. Preserve old reports and terminal attempts. A genuine second finish must
   still fail. Distinguish “attempt ended without a report” from “report exists.”
3. For a stopped child with a present worktree, valid Session and allowed
   corrections, use the existing resume/followup transition and admission path,
   including applicable capacity checks and consumption of the old stop intent.
   Deliver once; replay must not create another attempt.
4. Reject removed-worktree, missing-session, terminal or otherwise unresumable
   targets **before** writing an inbox item, budget change or request receipt.
   Keep working-child queue delivery working; do not add a polling daemon.

**Live gate:** lead pauses without finishing, receives a child notification,
then continues externally and saves its first report. Verify a later execution
gets its own attempt and a duplicate finish within one attempt is refused.
Stop an owned idle child, queue a correction, and observe exactly one new attempt
and report without manually prompting that child. Repeat the request ID.

### 2. Make landing, cleanup and historical reads consistent

Files: `teams/api-integrate.ts`, `worktree.ts`, GC in `lifecycle.ts`,
`api.ts` diff/check paths, and `api-followup.ts` admission.

1. Verify actual child execution quiescence through the existing Session API
   before landing; a saved `done` report alone is insufficient. Use a bounded
   wait/refusal, not an unbounded tool call or an interrupt to make it idle.
2. Put a conservative directory-in-use check at the shared removal boundary,
   covering integration, GC and orphan removal. On Linux derive references from
   `/proc` (cwd/fd/maps), with ownership and incomplete inspection explicit.
   If safe removal cannot be established on a platform, retain the directory.
   Never kill a process by name or treat a missing registration as proof.
3. Keep successful landing separate from cleanup. If references remain, return
   `landed` plus retained-worktree/reason information; keep the actual worktree
   state present. Do not fail the merge after it has already landed, or claim
   resources were released. Existing cleanup may retry later with the same guard.
4. For an already-removed child's diff, use its retained base/head commits in a
   surviving repository of the same Git identity. Do not accidentally show the
   parent's current dirty tree. Preserve visibility checks, path filters,
   byte limits and `--no-ext-diff`/`--no-textconv`.
5. Reject checks, checkpoints and followups that require a removed worktree with
   an actionable “delegate fresh from current parent” refusal. No new archived
   run state, database or correction tool is needed in this pass.

**Live gate:** let an owned idle MCP retain the worker directory. Integration
must land safely and explicitly retain it—not delete it or require a hidden
supervisor workaround. After an ownership-checked release of that idle resource,
verify safe removal through the same guarded path and fetch the historical diff.
Attempt a post-removal followup; verify refusal and no admitted work. Keep a
focused isolated test for GC/orphan removal using the same guard.

### 3. Enforce the individual run's edit and checkpoint scope

Files: `instructions/permission-enforce.ts`, `team-policy-rows.ts`,
`teams/api.ts` checkpoint handling and existing scope helpers.

Resolve the caller through the existing Session-to-run mapping. Use its validated
positive paths and forbidden paths from the stored brief; validate new scopes at
admission. Apply the same matching contract at the permission and checkpoint
boundaries. For a scoped delegated run, outside-scope or forbidden resources deny;
an in-scope resource leaves the existing permission decision unchanged. Never
turn a prior denial or approval requirement into an allow. Preserve fixed safety
exclusions and root/non-team behavior.

Reuse the existing permission hook rather than introducing session-cloned agents
or a new permission engine. Update generated Instructions rows/guidance so they
describe the enforced per-run boundary, not a misleading role-wide union.
Exercise write/edit/patch, including a patch's source and destination paths.

**Live gate:** two same-role workers get disjoint paths in separate worktrees.
Each can change its own file, but cannot change the other's path. One allowed
directory includes a specifically forbidden fixture file: edit and checkpoint
must reject it, with its hash and Git index unchanged. The fixture paths are
harmless test files, never actual credentials or protected workspace state.

### 4. Close the small Instructions and response-parity gaps

Files: `src/tools.ts`, existing model-owner helpers, `instructions/model.ts`,
`teams/policy.ts`/tool descriptions and delegate replay handling.

- Forward the selected team owner through model creation **and** returned-row
  lookup, matching the existing TUI path. Fail invalid ownership before saving.
- Return state and text provenance separately, reusing the resolver's existing
  `from` and `textFrom`; retain existing response fields where compatibility needs
  them. Do not change reset or inheritance behavior to fix an explanation bug.
- Mark idempotent admissions as replays and distinguish their original receipt
  from a fresh current-state observation. Keep original identity/payload and
  request-ID conflict semantics; do not rewrite admission history.
- Add the direct-vs-Code-Mode tool map to existing team guidance/context. Resolve
  delegation targets from the actual permitted roster, not hardcoded personas.
- Make activation's exclusive effect explicit in its tool result and existing
  TUI interaction/help. No per-session team-selection redesign or new wizard.

**Live gate:** create/activate a model on a team-preset member while a same-named
standalone preset exists; only the intended owner changes and the returned row
is addressable. Override/reset role text and verify both provenance values.
Put a fresh token only in the preset instructions, **not** in any prompt or
brief; ask a new session for its inherited verification token. Check publication
separately. This tests inheritance behavior without claiming raw provider capture.
Replay a completed delegation; inspect both stable identity and current state.
Switch between two isolated test teams and verify that the reported deactivations
match the actual enabled states; do not alter other projects' team selection.

### 5. Make telemetry truthful without building a metrics system

Files: status/wait/context paths in `teams/api.ts`, `teams/schema.ts`, and the
small set of consumers discovered by searching `turnsUsed`/`tokensUsed`.

Read `ctx.session.get(...).tokens` and use `TokenUsage.total`. Share the same
usage definition between status and wait's advisory budget evaluation. Report
unavailable usage as unavailable, not zero. Label usage as Session-cumulative;
do not pretend it is per-attempt accounting. Expose `attemptsUsed` as the actual
counter; update internal consumers and document any compatibility alias instead
of pretending attempts are model calls. Leave existing budget admission semantics
and advisory-only behavior unchanged.

**Live gate:** after real calls using the selected permitted model, status matches
the public Session totals at a settled boundary and is nonzero when the Session
reports nonzero usage.
A small token-only advisory budget is exceeded consistently in status/wait.
Multiple model calls do not masquerade as one measured model call. No hard budget
interrupt is introduced.

### 6. Run one final end-to-end acceptance, then checkpoint evidence

Use a fresh fixture on the **final candidate**, with the fast-model team, normal
tool guidance and no direct edits to team state:

1. Create preset members/model settings and instantiate the team in the isolated
   global scope. Check the intended roster, permissions and model publication.
2. Delegate, inspect status/list, wait with and without acknowledgment, run the
   assigned failing baseline then passing focused checks, and checkpoint.
3. Continue the lead after a notification; correct an owned stopped worker;
   verify attempt/report identity and delegate/followup replays.
4. Perform the same-role/forbidden-path refusal probes and confirm no unintended
   file or index changes. Check ordinary allowed work still succeeds.
5. Integrate with the expected parent HEAD, check the landed result and historical
   diff, and verify honest retained/removed cleanup behavior.
6. Stop and supersede only owned confirmed-idle children; verify idempotence and
   hidden/history listing behavior. Finish the lead and verify its report file
   and tool-visible report actually exist. An `E_FINISH_TWICE` here is a failure.
7. Verify final actual Session idleness, owned resource references and fixture
   cleanliness; disable the isolated test teams and retain useful evidence.

This covers all fourteen team tools with meaningful assertions. Do not add model
calls just to increase a coverage counter. If a case fails, read its exact tool
result and owning code, fix that path, rerun that case, then rerun the final flow
after any change that affects its behavior. No speculative redesign/re-review loop.

## Focused automated checks

Run tests from `packages/plus`, selecting the touched files—not `bun test` for the
whole package and never tests from repository root:

- Lifecycle/admission: `test/teams/lifecycle-events.test.ts`,
  `api-followup.test.ts`, and the root-continuation case in `walkthrough.test.ts`.
- Landing/history: `test/teams/api-integrate.test.ts`, `api-query.test.ts`,
  `worktree.test.ts`, `gc.test.ts`.
- Scope: `test/permission-hooks.test.ts`, `test/teams/permissions.test.ts`,
  `test/teams/api-git-ops.test.ts`.
- Instructions/output: relevant cases in `test/tools.test.ts`,
  `test/teams/models.test.ts`, `api.test.ts`, `api-query.test.ts`.

Paths without the repeated prefix in each bullet are in `test/teams/`.
Add focused regression cases to these owners rather than a large new harness.
Run `bun typecheck` in each changed package. If public Protocol/HttpApi changes
prove necessary, regenerate the client from `packages/client`; none is planned.
Keep the workspace structure and team-index smoke checks.

## Explicitly deferred

- Multiple simultaneously selected teams/per-session team selection.
- General mailbox UI/cancellation, archive-correction wizard, dry-run/preflight
  service, role/template framework, unified tool-catalogue service.
- Automatic cross-location MCP teardown or per-team lazy MCP startup. This pass
  makes retention truthful and removal safe; it does not promise resource-free
  idle Sessions or automatic cleanup of every retained worktree.
- Transport-wide structured error redesign, hard budget enforcement, distributed
  scheduling/ownership, global event-store changes, and whole-suite campaigns.

The plan accounts for these findings without declaring them fixed. Promote a
deferred item only if a concrete acceptance failure makes it necessary; retrieve
that boundary's context first and choose the smallest supported solution.

## Definition of done

- The candidate passes the final provider-backed flow, including a saved root
  report, stopped-worker correction, scope refusals and post-landing history.
- Each repaired live failure has a before/after receipt; source-only issues have
  focused regressions plus the specified safe candidate probe.
- Evidence identifies source/build, host, public-client version, actual returned
  model ID, test-owned Sessions/runs, commits, check outputs and cleanup outcome.
  Save/readback/publication/model behavior remain distinct claims.
- No hidden manual runtime repair, scope expansion, safety toggle, secret commit,
  controller replacement or candidate promotion was required to pass.
- A local task-branch commit records the fixes and concise verification results.
  If model access or the isolated candidate cannot be made available, record the
  blocker: the live gate remains incomplete, not silently waived.
