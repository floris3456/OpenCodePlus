# Instructions presets and product-team field verification

Date: 2026-09-26. Execution plan: [team-field-verification](../plans/team-field-verification.md).

## Scope and release boundary

This exercise used real Instructions mutations and provider-backed product team
sessions, not mocked tool calls. It assesses `packages/plus/src/teams`; the
workspace supervisor `./bin/team` is a separate system.

- Live host: immutable `0.0.0-plus-r4.6`, PID 700039, verified against health and
  `/proc/700039/exe`. No release promotion or controller restart.
- Public network client: the `packages/client` subtree at source baseline
  `24c5f2dc66dc65ffbf49bea97b33aa38f43f7aff`; service discovery and compatibility
  checked without calling service `ensure` or replacing the host.
- The preceding agent-controls candidate is **not loaded**: live
  `instructions.list` rejects `item:setting`, and live `instructions.set` has no
  `mode` parameter. This exercise does not validate those new controls.
- Product team implementation has no source diff between the live source
  revision `59069f781` and the candidate baseline above.
- Plan checkpoint: `2861551e2a068553039381b243ea9d1b2069d806`.

## Presets and actual work

Two User team presets were instantiated as global teams with the same names:

| Team | Members | Work |
| --- | --- | --- |
| `field-verify-26` | `fv26-lead`, `fv26-maker`, `fv26-review` | Implement a tiny statistics function, make a follow-up notes commit, run focused checks, integrate, review |
| `field-audit-26` | `fa26-lead`, `fa26-scout` | Read-only implementation/test audit and lifecycle probes |

Reusable agent presets: `field-lead-26`, `field-maker-26`, `field-review-26`,
`field-reader-26`. Their active model IDs are respectively
`cliproxyapi/gpt-5.6-sol`, `cliproxyapi/gemini-3.8-flash-high`,
`cliproxyapi/gpt-6-astra`, and `cliproxyapi/gemini-3.8-flash-high`.
These are observed configured/returned model IDs, not independent attestations
of an upstream provider's internal model routing.

Roles inherited the shipped safety instructions and added unique canaries.
Leads had shell/edit/write/patch disabled. Delegation was explicitly enabled only
to their own named members; cross-team and foreign-run reach were not expanded.
Protected-agent mutation remained enforced. Distinct worker worktrees avoided
shared writers. No tests, safety instructions, credentials, or live runtime
records were edited by workers.

The fixture lives at `worktrees/team-fieldwork/fixture`, task branch
`field-verification`. Baseline `24aca5ac9d0c089c9630dedeb156bca9f2789ff4`
deliberately failed three of four tests. The maker produced:

- `90cb7106cb52941a0a52c23b1ae5b1b7c0728cdf`: `src/stats.ts` implementation.
- `1bb03a559f482d174df458beb4baec7974ab9e59`: requested `notes/review.md` follow-up.

Independent Git inspection confirmed only these two paths changed, with tests
and `AGENTS.md` unchanged. Check receipts passed at each committed implementation
HEAD. Integration landed at `1bb03a559f482d174df458beb4baec7974ab9e59`.
The reviewer approved it without findings. Both the parent's team check and a
separate supervisor invocation of `bun test test/stats.test.ts` passed all four
tests; the parent working tree was clean.

## Instructions coverage

All eight tools were exercised:

| Tool | Verified behavior |
| --- | --- |
| `create` | User agent/team presets, preset members, explicit model candidates, global team instances |
| `list` | Exact row discovery and readback; temporary deleted preset absent |
| `show` | Entities, resolved/mine/diff views, sections, model/permission inheritance |
| `set` | Preset links, role overrides, model activation, permission/tool toggles, team activation |
| `reset` | Global role override removed without losing inherited member text; transitive preset `grep` override restored |
| `split` | Audit lead role retained existing text and appended a named `field-protocol` section |
| `log` | Actor, session/message attribution and revision history |
| `delete` | Unreferenced ephemeral preset deleted; referenced preset and unconfirmed deletion refused |

Live negative probes returned `preset.inUse`, `link.cycle`,
`delete.unconfirmed`, and `agent.protected`. None was bypassed. A failed
multi-call Code Mode batch did **not** roll back earlier successful mutations;
readback was necessary. No transactional behavior was assumed.

Save/publication/execution were checked separately: Instructions readback,
location-scoped host `agent.list`, then actual session messages/tool results.
Canary emission was observed, but the prompts also supplied the canaries: this
does **not** independently establish their preset origin in model requests.
Resolved Instructions readback and host publication remain separate evidence
from provider-request inclusion; no raw provider request capture was performed.

## Team coverage and outcome

All **14 product team tools** were exercised across five provider-backed sessions.
The deduplicated transcript index records 78 team calls, including refusals and
idempotency replays—not 78 successful operations.

| Tool | Result |
| --- | --- |
| `get_context` | Stable root bootstrap identity; child brief/scope/checks read successfully |
| `set_checks` | Focused `bun test test/stats.test.ts` accepted; unrestricted `bun test` refused with `E_CHECKS` |
| `delegate` | Maker, reviewer and scout created with distinct worktrees and model/config provenance; exact replay returned the same maker |
| `status` | Report, HEAD-bound checks and acknowledged-attempt fields observed; misleading budget telemetry documented below |
| `list` | Own-parent filters worked; superseded scout hidden by default and visible with `all:true` |
| `wait` | Both `ack:false` and `ack:true` behaved correctly; sub-floor timeout refused with `E_TIMEOUT_MIN` |
| `check` | Deliberate baseline failures, then four passing tests; unknown ID refused with `E_UNKNOWN_CHECK` |
| `checkpoint` | Two scoped commits with expected-HEAD checks; no test edits |
| `finish` | Maker, reviewer and scout reports saved; empty-needs blocked probe refused with `E_NEEDS`; both resumed roots exposed `E_FINISH_TWICE` defect |
| `diff` | Actual changed paths, empty audit diff, and explicit `truncated:true` at 100 bytes; landed-child history failed with `ENOENT` |
| `followup` | Maker correction became attempt 2; reviewer refusal `E_NO_FOLLOWUP` respected |
| `integrate` | Stale parent refused with `E_STALE_PARENT`; valid integration landed and parent checks passed |
| `stop` | All three owned idle children stopped; repeated calls returned the same stopped state |
| `supersede` | Owned stopped scout superseded twice idempotently; history retained |

The audit scout returned exact file references and `FIELD_SCOUT_26`; its worktree
diff was zero. The audit lead emitted `FIELD_AUDIT_SECTION_26`, and the reviewer
returned `FIELD_REVIEW_26` with no findings. Those tokens were prompt-supplied;
their emission is not an independent preset-delivery test. A future blind probe
should omit the expected token from the user/delegation prompt.

Both root finish attempts were refused despite being their first such calls.
Their underlying tasks succeeded, but **neither root saved a final team report**.
Final read-only run-record inspection showed both roots idle with only
`no_report` attempts and no report files. This is a failed lifecycle gate, not an
all-green end-to-end claim.

## Findings and implementation priorities

Evidence labels distinguish **live** observations from **source-only** findings.
The latter were independently reviewed by general sub-agents; they were not
turned into dangerous live probes merely to improve coverage.

### P1 — Resuming a root can leave no open attempt capable of finishing

**Live:** the verification root's first and only `team_finish` call returned
`E_FINISH_TWICE`, claiming a report already existed. Status before and after
instead showed `working`, attempt 3 `no_report`, `report:null`; independent
inspection found no `report*` files for that root.
The read-only audit root independently reproduced the same refusal on attempt 2;
its first finish call also saved no report.

**Source explanation:** notification delivery admitted attempts 2 and 3. Their
acknowledgment-only model responses ended as terminal `no_report`. Subsequent
external prompts reopened the run but did not allocate an open attempt.
`finishHandler` refuses either an existing report **or any terminal attempt**,
but labels both cases as a recorded report. References:
`packages/plus/src/teams/lifecycle.ts:197–207,219–260,297–359`,
`api.ts:554–564`, `run.ts:294–303`, `tools.ts:565–645`.

Fix admission at execution start: allocate a new attempt when none is open,
without duplicating one already admitted by bootstrap/delegation/inbox delivery.
Keep terminal-attempt immutability and duplicate-report protection. Distinguish
an ended-without-report refusal from a duplicate report.

Acceptance: bootstrap a root, finish a host execution without a report, resume
externally, and successfully record one report on a fresh attempt. Repeat with a
settlement-notification acknowledgment between prompts; verify notification
attempts are reused and a second report remains refused. Existing
`test/teams/lifecycle-events.test.ts:424–442` checks only the run state, not this
attempt invariant.

No supported self-recovery exists in this root's authorized workflow:
self-followup refuses `E_NOT_CHILD`. We did not weaken finish guards, rewrite run
records, manufacture notifications, or restart completed children. The public
session API proves this root idle, **not successfully team-finished**.

### P1 — Lifecycle must own execution, dependencies, and worktree retirement

**Live precursor:** after the maker finished and the public session API confirmed
its drain idle, a location-scoped `search-mcp` subprocess still held the child
worktree as its kernel cwd. Same-user `/proc/*/{cwd,fd,maps}` inspection found it;
run metadata alone did not establish that deletion was safe.

The supervisor verified the location contained only the owned child session,
then disconnected that location's idle `search` MCP through the public API.
A repeated kernel scan had no matches or unreadable same-user processes. Only
then was integration authorized. We did **not** demonstrate deletion under a
live process, kill by executable name, or restart the shared host.

**Required behavior:** a single ownership-aware retirement operation should
confirm the session drain, release owned location resources, and only then remove
the worktree. A settled report and host-alive status are not that proof. Add a
test with an owned idle MCP retaining cwd and verify safe release ordering.

**Source confirmation:** `api-integrate.ts:55–76,131–141` checks stored state,
not the execution drain; `worktree.ts:144–158` directly invokes removal.
`api-lifecycle.ts:118–141` stops the Session, not its Location MCP. Core MCP
disconnect closes the connection scope (`packages/core/src/mcp/index.ts:606–617,
778–785`). Search is eagerly registered independently of whether the worker
needs it (`packages/plus/src/index.ts:4230–4238`, `search/register.ts:72–88`).
A per-team lazy/disabled search policy could reduce idle processes without
removing teaching or safety instructions; it does not currently exist.

### P1 — Archived/landed run capabilities need an explicit contract

**Live:** after successful integration, historical `team.diff` failed with
`ENOENT: ENOENT: no such file or directory, posix_spawn 'git'`.
**Source confirmation:** integration removes the worktree but records only
`worktree:"removed"`; diff/check still use `record.directory`, and followup
does not reject removed worktrees. References:
`packages/plus/src/teams/api-integrate.ts:131–142`, `api.ts:911–965`,
`api-followup.ts:127–158,198–219`.

Serve historical diffs from retained commits in the surviving repository. Reject
new execution on archived runs with a structured reason and fresh-run guidance.
Acceptance: land a fixture child, retrieve its original diff, and verify a
followup cannot admit work into the removed directory. No post-landing execution
was attempted in this exercise.

### P1 — Queued followups to stopped children can become stranded

**Source-only:** stopped/dead are nonterminal; followup queues non-idle children,
but automatic delivery requires `idle`. `delivery:"now"` instead refuses with
`E_BUSY`. References: `api-followup.ts:134–149,184–190`, `run.ts:242–244`,
`lifecycle.ts:316–321,371–376`.

Either reject admission clearly or implement the documented stopped-to-starting
transition with capacity checks. Acceptance: an owned stopped child receives one
queued followup, starts one new attempt, and delivers exactly once without an
external session nudge. We intentionally did not create a stranded live mailbox.

### P1 — Negative scope is not an enforced exclusion

**Source-only:** `scope.forbidden` is rendered as “Must not touch,” but policy and
checkpoint boundaries use positive paths, not those exclusions. References:
`brief.ts:24–40`, `api.ts:360–379,680–682`,
`packages/plus/src/instructions/team-policy-rows.ts:27–32,132–139`.

Carry exclusions into enforcement and checkpoint validation; exclusions must win.
Acceptance: `paths:["src/*"]`, `forbidden:["src/excluded.ts"]` permits a sibling
but rejects the excluded file at both boundaries. No forbidden edit was attempted
against a live worker to prove this source finding.

### P2 — Instructions model creation loses team-member ownership

**Source-only; live workaround used:** the tool accepts `team` but its model
branch omits team context from `addModel` and created-row lookup. The TUI forwards
that owner correctly. References: `packages/plus/src/tools.ts:1456–1493`,
`rpc.ts:1045–1053`, `tui/instructions/dialogs.tsx:583–586,683–688`.

We configured linked agent-preset model candidates instead. Fix the tool to use
the same owner resolution as the TUI. Acceptance: creating a model for a User
team-preset member returns its addressable row and does not write to a same-named
standalone agent preset. A post-write lookup failure must not imply no save.

### P2 — Budget telemetry reports zero tokens and calls attempts “turns”

**Live:** provider-backed multi-call work still reported `tokensUsed:0`;
the maker counter rose from one to two only on followup attempts.
**Source confirmation:** hardcoded zero and `record.attempts.length` in
`api.ts:1244–1250`; token exhaustion needs usage that status/wait do not supply
(`schema.ts:595–610`, `api.ts:1215,1279–1284`).

Aggregate actual session usage, or report unavailable rather than zero. Rename
the attempt counter. Test status/wait consistency with known nonzero usage and
multiple model calls within one attempt. Budgets are intentionally advisory;
absence of a hard stop is not itself a bug.

### P2 — Same-role workers share a union of edit scopes

**Source-only, documented limitation:** scope permissions are grouped by role,
including nonterminal stopped/dead peers; checkpoint positive paths remain
per-run. References: `team-policy-rows.ts:38–75,125–176`,
`packages/plus/README.md:245–251`, `api.ts:680–682`.

Run/session-specific permission evaluation would provide genuine separation.
Acceptance: two same-role workers with disjoint scopes cannot edit each other's
paths; archived peers do not widen permissions. This is not an undisclosed
unioning regression.

### P2 — Idempotency should preserve identity without replaying stale state

**Live:** replaying the exact delegate request returned the original run/session
without creating another worker, but returned cached `state:"starting"` after
status already showed the completed child idle. Identity idempotency works;
the response is easy to misinterpret.

Return `replayed:true` plus refreshed status, or label the payload explicitly as
the original admission receipt. Test replay after completion and after followup.

### P2/P3 — Expose provenance, activation effects, and discoverability clearly

- **Live + source:** resolved role text contained inherited member-preset text
  while `show.from` identified the shipped Scout. This is state provenance, not
  a failed reset. Expose both `stateFrom` and `textFrom`, with owner identities.
  References: `instructions/model.ts:848–859,1163–1192`, `tools.ts:1142–1155`.
- **Live + source, intentional contract:** enabling one team disables other
  enabled teams across loaded project/global/defaults records. This is not a
  simple availability toggle. Provide an activation-effects preview; longer term,
  separate available teams from per-session selection. References:
  `index.ts:3102–3129`, `test/teams-rpc.test.ts:310–340`. This does not prove one
  universally selected team across every host project.
- **Live:** six team reads/checks are discoverable through Code Mode, while eight
  direct native tools are not. The lead wasted repeated searches for delegate
  and set_checks before using the direct tools. Provide a unified capability
  manifest, including surface and exact signature, rather than silently incomplete
  search results. The audit prompt supplied this mapping explicitly.
- **Live:** Code Mode refusal exceptions carried the error code/accepted input
  in their message, while `.code` and `.data` were null. Preserve structured
  domain errors so agents need not parse prose.
- Custom-role delegation required explicit member-specific permission setup;
  rows appeared only when that roster was enabled. A disabled-team preflight
  should expose role links, target permissions, model resolution, and blockers
  without activating the team or broadening permissions.
- Shipped orchestration text names shipped roles. For renamed preset members we
  explicitly adapted those targets, preserving safety instructions. Role-aware
  preset instantiation should resolve actual roster capabilities, not leave
  misleading hardcoded delegation names or silently grant new targets.

### Additional missing capabilities worth scheduling

- An archive-aware correction operation: create a fresh worker from the landed
  parent with links to the prior run, review, and check receipts, rather than
  prompting a session whose worktree is gone.
- Mailbox inspection/cancellation and explicit admission/delivery/attempt IDs for
  followups. These would make stuck or superseded requests diagnosable without
  editing runtime records.
- Machine-readable capability preflight for a preset/global team before launch,
  including available models, effective tools, delegation targets, disabled
  actions, and activation side effects.
- Separate execution-idle, report-settled, acknowledged-attempt, host-alive, and
  resources-released fields. The live list's `runtime:"running"` on an idle child
  is not useful proof that the worker is executing—or safe to remove.

These are assessment recommendations, not features silently implemented or
deployed during this field test.

## Evidence, limitations, and retained state

Local evidence root (not committed):
`run/team/team-fieldwork/runs/ses_f227a73ceffe7EvvHwbH6pqkJk/`.
It contains the ownership report, sanitized host checks, phase prompts, actual
session transcripts, focused-check results, and kernel-liveness receipts.
Instructions mutations and readbacks are in the initiating parent session's
transcript; `final-instructions-readback.json` copies selected observed fields,
not an independent configuration parse. The coverage index's
`mentionedErrorCodes` is a text-mention aid, not a per-call verdict; exact errors
must be read from the underlying tool results.

An independent general-agent evidence review reconstructed the 78-call index
(69 completed / 9 error) and confirmed the fixture commits, checks, root-report
failures, stale replay, historical-diff error, and kernel receipt scope. It also
caught the canary-origin overclaim and missing explicit wait receipts; the report
was corrected and the final waits were rerun with explicit completion receipts.

Not exercised: busy interruption, foreign-run mutation, destructive cleanup,
cross-team delegation, concurrent same-role writers, provider failures, crash
recovery, or token-budget enforcement. No broad product suite ran. Workspace
smoke checks `./bin/bun run check` and `./bin/team list` both exited 0.

Final retained state:

| Entity | State |
| --- | --- |
| User team presets and four agent presets | Retained for reuse |
| Both global field teams | Disabled, verified through Instructions `show` |
| Existing project `Test` team | Enabled state remains false; no direct definition mutation |
| Verification root `main-1babfc7bbd6c5b73` | Idle, no final report due to the defect |
| Audit root `main-ca188c0635eddef1` | Idle, no final report due to the defect |
| Maker `w-0fed70036a5c811d` | Stopped, two successful reports, integrated worktree removed |
| Reviewer `w-f89cbb6de824edce` | Stopped, successful report and clean worktree retained |
| Scout `w-42835f81fcbdcfeb` | Superseded, successful report and clean worktree retained |
| Fixture parent | Clean at `1bb03a559f482d174df458beb4baec7974ab9e59` |

`checks/final-owned-idle.json` records successful public `session.wait` calls and
absence from `session.active` for all five exact owned session IDs, with the same
healthy host PID/version. Only their verified-idle, location-scoped search MCP
connections were disconnected. Final kernel scans of the fixture and child
worktree namespace found no matching cwd/fd/maps references and no unreadable
same-user processes (`final-fixture-kernel-idle.json`,
`final-children-kernel-idle.json`). This is not a claim that unrelated hosts or
processes are stopped.

The plan/report are the only product-source changes from this field exercise.
Runtime state, preset records, transcripts, credentials, and the pre-existing
untracked `.opencodeplus/instructions` files are not committed. No product fix
or release was deployed. Additional runtime-generated untracked
`.opencodeplus/teams/Test/*.md` files were observed and preserved without staging
or deletion. Re-enabling a retained global team is an explicit later
choice; remember that activation disables other teams in the loaded scopes.
