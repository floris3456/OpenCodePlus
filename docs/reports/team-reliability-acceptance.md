# Team reliability candidate acceptance — 2026-09-26

**Result: selected repairs implemented and final candidate live flow passed.**
This is candidate verification, not a release promotion. The earlier
[field verification](team-field-verification.md) remains the pre-repair evidence.

## Identity and isolation

| Item | Observed value |
| --- | --- |
| Product task branch | `team-reliability` in `worktrees/r4-7/opencode` |
| Starting checkpoint | `c45226921`; existing worktree was not reset |
| Final executable source | `6809e087338bf613294c8ce85d9430a6e610bfad` |
| Candidate source directory | `worktrees/reliability-final/opencode` (clean, detached, frozen during live testing) |
| Host | owned standalone source CLI, Bun 1.4.2, health version `local`, PID 1395937, loopback port 56693 |
| Public client | imported from the same pinned candidate source |
| Loaded Plus | builtin `opencode.plus`, active at fixture location |
| Fixture | `worktrees/team-reliability/fixture`, own Git repository/task branch |
| Fixture baseline | `40a5bc99c7e426a51cd5b2b03ed43dd8a6ac89be` |
| Fixture final HEAD | `d1299a26f641a897c3f730db2b91ab197a42ea05` |

The host used private config, credential, database, home, cache, temporary
directory and port under the evidence root. Reviewed workspace/bootstrap safety
instructions were retained. No implicit service discovery, installed-release
substitution, shared service replacement, controller restart or promotion occurred.
The earlier pre-review candidate was stopped while Session-free; it was not used
to claim acceptance of the final fixes.

Provider models were discovered from the candidate catalogue, then checked in
actual public assistant-message `model` fields:

- `cliproxyapi/gemini-3.8-flash-high` (`default`): configurator, lead, both initial
  workers; it was available and responded successfully.
- `cliproxyapi/gpt-5.6-luna` (`default`): worker A correction only. Core's existing
  model-context hook exposes `edit`/`write` to Gemini and `patch` to GPT. Gemini
  therefore could not execute the requested patch probe. The explicitly permitted
  Luna fallback was selected through public `session.switchModel` while A was
  idle/stopped; the only correction prompt came from `team_followup`.

Model evidence uses Session selection and actual message models, not summaries
or inherited RunRecord model snapshots. Admission snapshot fields are not a
per-call model trace. No raw provider-request capture is claimed.

## Changes and checkpoints

All production changes are confined to `packages/plus`; no upstream Core, Server,
Protocol, Client or CLI changes were needed. No generated client regeneration was
needed: the additive RPC response fields are Plus-owned portable definitions,
not public Protocol/HttpApi changes. Workspace `scripts/team` and `agents/*.json`
were not changed.

| Commit | Repair |
| --- | --- |
| `eba7b41c6` | Root/inbox admission, resumable stopped followups, replay observations, per-Session run scope, checkpoint checks, removed execution/history, Session usage |
| `26f685f3b` | Instructions model-owner forwarding/readback, state/text provenance, exclusive activation results, native/Code Mode/roster guidance |
| `426a140c1` | Settled replay and scope-guidance regressions |
| `5a254f186` | Actual Session-idle integration gate, shared kernel-liveness removal guard, landed-vs-cleanup results, cleanup retries |
| `6809e0873` | Concrete directory checkpoint expansion, landed-correction refusal/divergent-tip retention, invalid legacy-scope guidance isolation |

There was one targeted lifecycle/permission review. Its three actionable findings
were fixed and regression-tested before pinning the final candidate. Reusable
boundary logic lives in separate Plus `availability.ts`, `directory-use.ts`,
`scope.ts` and `usage.ts` files; existing owning paths call those boundaries.

## Focused automated verification

Run from `packages/plus` (never repository-root tests):

```text
bun test test/teams/lifecycle-events.test.ts test/teams/api-followup.test.ts
  test/teams/walkthrough.test.ts test/teams/api.test.ts
  test/teams/api-query.test.ts test/teams/api-git-ops.test.ts
  test/teams/permissions.test.ts test/permission-hooks.test.ts
  test/tools.test.ts test/teams/tools.test.ts test/teams/models.test.ts
  test/teams-rpc.test.ts test/ops.test.ts test/teams/api-integrate.test.ts
  test/teams/worktree.test.ts test/teams/gc.test.ts
```

**378 pass, 1 existing skip, 0 fail; 2,415 assertions.**
Separate `bun test test/log.test.ts`: **14 pass, 0 fail; 131 assertions.**
`bun typecheck`: **exit 0**. Workspace `./bin/bun run check` and `./bin/team list`:
**exit 0**. `git diff --check`: clean. No whole-suite campaign or weakened gate.

Focused regressions include byte-identical index preservation on forbidden
checkpoint and directory-selection refusal, actual owned process cwd/fd/maps
retention, shared GC/orphan removal guards, divergent post-landing child tip
retention, missing/removed execution targets, unavailable usage, prior permission
allow/ask/deny preservation and invalid ownership before saving.

## Final provider-backed flow

| Case | Actual result |
| --- | --- |
| Continued lead | `main-659a9807f9175f44`: initial pause without report, real child notifications, multiple external continuations, final attempt 10 succeeded with durable `report-10.json` and `report-10.md` |
| Genuine duplicate | Second identical finish in attempt 10 returned `E_FINISH_TWICE`; first saved report remains intact |
| Stopped correction | A `w-819ccdae8abe73bb`: stopped idempotently, followup opened exactly attempt 2, saved report 2, consumed stop intent; no manual child prompt |
| Replay | `accept-a` delegate and `correct-a` followup preserved original receipt/identity and included explicit replay plus current idle/working state; no new worker or attempt |
| Same-role scope | A and B both `tr-maker`, disjoint `src/a/*`/`src/b/*`; cross-worker writes denied, own edits/checkpoints passed |
| Forbidden operations | Both excluded-file edits and A's excluded-file checkpoint denied; Luna's cross-scope patch move and forbidden patch denied before mutation; allowed notes patch succeeded |
| Integrity | Forbidden files and tests match baseline hashes, denied destinations absent, final index/worktree clean, only the three intended fixture files changed |
| Checks and integration | Each worker recorded a failing baseline then passing focused check; parent a gate passed on A landing, a+b gates passed on B landing; final parent checks both passed |
| Retention | First integrations returned landed + retained, explicitly identifying owned idle search MCP PIDs 1473200 and 1475128 holding worker cwd |
| Removal | Public MCP disconnect after Session-idleness and PID/PPID/uid/cwd/command ownership checks; `/proc` guard then clear; ordinary integration retry returned alreadyLanded + removed |
| Historical diff | Both removed workers remained diffable; A path filter and 50-byte truncation worked, B retained original child tip despite parent rebase |
| Unavailable execution | New post-landing and removed-worktree followups refused with delegate-fresh guidance; no refusal request receipt, no new attempt/inbox/budget admission |
| Stop/supersede/history | B stopped twice and superseded twice idempotently; hidden in default listing and retained in all/history listing; A finally stopped while actually idle |
| Model ownership | Same-named standalone `tr-maker` preset stayed inactive; `tr-team/tr-maker` model was created/activated and its returned row was showable with the correct owner |
| Provenance/activation | State remained from Implementer while overridden text came from global; reset restored preset text provenance; activation reported exactly `tr-other` disabled when `tr-live` enabled |
| Blind inheritance | Fresh token existed only in preset role text, absent from all prompts/briefs; new lead response reproduced it; publication checked separately |
| Usage | At settled boundary public Session total and team status both 1,414,406 for A; attemptsUsed=2 is not model-call count; status and wait agreed tokens:1 was exceeded |
| Actual idleness | Public Session active map empty for all four owned Sessions before disconnect/shutdown; not inferred from team reports |

All fourteen team tools had meaningful calls. The machine assertion receipt
contains **23 passed, 0 failed** checks against tool responses, Session data,
reports and Git, rather than the agents' summaries. In particular, A's initial
Gemini summary overclaimed patch coverage; actual tool inspection exposed that,
and the Luna correction performed the real patch probes before acceptance.

Owned Session identities:

- Configurator: `ses_f218f98cbffemgIzOmZEIr4EUD`.
- Lead: `ses_f218d246dffeMViHLPTTJQ8hh0`.
- A: `ses_f218cf259ffek7Rei3We33cJAZ` (two succeeded attempts).
- B: `ses_f218cdd67ffeHLSxJDIrsL24Kk` (one succeeded attempt;
  run `w-c350f00c3c842d65` subsequently superseded).

## Evidence and final resources

Workspace-relative evidence root:
`run/team/team-reliability/runs/ses_f21ad377bffeKRh2JryilgQS5l/`.
Shareable receipts include:

- `checks/candidate-identity.json`, `checks/patch-model-selection.json`.
- `checks/review-final-focused.log`, `checks/review-typecheck.log`,
  `checks/log-focused.log`, `checks/workspace-check.log`, `checks/team-index.log`.
- `checks/acceptance-assertions.json`, `checks/observe-before-integrate.json`,
  `checks/observe-landed.json`, `checks/observe-retired.json`.
- `checks/release-children-mcp.json`, `checks/release-parent-mcp.json`,
  `checks/candidate-stop.json`, `checks/final-resources.json`.

Private configuration and raw runtime transcripts remain outside Git; no
credentials or runtime state are committed. The original `.opencodeplus/` in the
product worktree and unrelated workspace changes are preserved.

Final state:

- Four owned Sessions actually idle; lead final report succeeded, A run stopped,
  B superseded. Session/database/report history retained.
- Test teams `tr-live` and `tr-other` disabled via public API; private test presets
  retained, not installed into the shared service.
- All three owned search MCP instances disconnected through public API. Candidate
  host stopped with SIGTERM only after explicit idleness and ownership checks.
  Kernel verification found both tracked candidate hosts and all three MCP PIDs
  **absent**, not merely missing from registration records.
- Both test-worker worktrees removed through the guarded product path; Git branches
  and reports retained. Clean fixture retained at the final HEAD above.
- Clean final/pre-review candidate snapshots and both implementation sub-agent
  worktrees retained. No destructive cleanup, remote push or history rewrite.

## Limitations deliberately not changed

The plan's deferrals remain: multi-selected/per-session teams; mailbox UI,
archive-correction/preflight/template/catalogue systems; automatic cross-location
MCP teardown/lazy startup; transport-wide structured errors; hard budgets;
distributed scheduling/ownership; global event-store changes. Unsafe or incomplete
directory-liveness proof means retention, not forced removal. Usage is
Session-cumulative, not per-attempt accounting; `turnsUsed` remains a compatibility
alias for attempts. This run establishes no raw provider-payload capture and no
release promotion.
