# plus-1.1.15 overnight log

## Resume here

- Branch/worktree: `plus-1.1.15_overnight`; initial HEAD `75a8d9e20f`.
- Read this log first after a break, then `plus-1.1.15-overnight.md`.
- Current phase: B3 review/issue repairs alongside B1/A1 acceptance; repair B2 page gaps (#7) before live acceptance.
- Pending: B1/A1/A2/B2 live, #1/#6/#7/#8/#10/#13/#14/#15 repairs, A4/A5/B4 and F. A3/A6/B6 source tests complete; B6 live is in the page acceptance.
- B1 source merged as `26eacdfc14`; #2 landed `de7c1952bf`, #3 landed `339c6e2f36`, #9 landed `4588c190a2`; their source workers stopped. B1 fresh live T88, #1/#6/#15 T82, A1 live T86, #7 fresh T87, #8/#13 T89 running. T81/T83/T84 stopped for no material worktree activity. A3/A6/B6 tests landed and stopped.
- A1 source landed `24a1a1115f`; live acceptance pending. A2 source merge/review complete, focused tests passing, newly found field gaps #6 await correction.
- No merge into `plus-1.1.15`, push, release build/promotion, shared-service access, or live-config mutation.

## Decisions

- 2026-10-05: Follow the overnight plan's explicit five-child limit and order (it supersedes the older task plans' two-child limit). Only Flash-C-Worker codes/tests unless its provider is unavailable. I alone merge, review, land, and log.
- 2026-10-05: Start B1 first while independent A3 (T5 expectations), A6, and B6 test repairs run. Defer A3 RPC declarations until all four branch merges land.
- 2026-10-05: Log did not exist at start; created before implementation. Existing prepared branches are inputs, not worktrees to change.
- 2026-10-05 03:02 local: watchdog inspection found T83 had no commit or changed file for 35 minutes; stopped force and delegated fresh same-kind T87 at current HEAD. No provider failure reported, so Flash-C remains the only coder. Other runs had recent changes or started less than 30 minutes ago. T83 made no source/evidence changes and claimed no acceptance.
- 2026-10-05 03:22 local: T84 had no new commit/file for over 30 minutes and no report; stopped force. Its read-only Brief could not checkpoint evidence (orchestrator scope mistake), so the fresh B1 run receives a scoped evidence document. Preserve its actual isolated ledger and partial observations; do not infer complete acceptance from counts.

## Progress and verification

### B1 — in progress

- Input branch: `team/Heavy-Implementer/t54a9ef-20261004-1204`.
- Must preserve pinned warming agent/model, `durable: false`, cache policy and private prompt; add generated kind/error, reconcile core tests and Plus index/API.
- Merge conflicts resolved by retaining loaded/pinned `primary` preparation plus generated outcome timing, both core test imports via `ID`/`Ref`, warmed early-return, and existing team retry-status helper.
- Reviewed input changes in core generation/title/transport hooks, plugin session contract, Plus monitor ledger/fingerprints/collector/cache/report/query/tools, quota facts, team identity and tests. Identified #2/#3 below; landing the combined source before targeted repairs, not claiming acceptance yet.
- Checks at merge: core focused five files **45 pass**, core/plugin/plus typechecks pass. Monitor files **49 pass / 5 fail**: all five are the pre-B2 view expecting old session-plus-descendants semantics; repair belongs to B2 (#4). Warnings in monitor refusal controls deliberately exercise containment; monitor-plugin fixture registration warnings need follow-up inspection.
- Live acceptance pending: short warming, two messages, three pings, usage and stable warming status, cache read on next message.
- #2 repair reviewed and landed `de7c1952bf`: transport-only kind override preserves primary content hooks and labels model/HTTP/WS as generate. Core real HTTP middleware and Plus real hook regressions prove one completed fingerprinted row, warming relabel in place, pinned identities, hashed failure and unrelated-step refusal. Parent core five files **46 pass**, Plus requests **18 pass**, core/plugin/plus typechecks pass. T79 stopped; T84 `w-524a6a474852446e` live report running at this HEAD.
- Runtime evidence decision: the private source server actually opens `opencode-local.log` (kernel fd proof from T81), not necessarily the plan's `opencode.log`; live workers notified to read the actual file(s), never treat the missing alternate filename as no errors.
- Fresh B1 live T88 `w-b9c40c8bc0aa8b1d` at `89a86fac9a`; evidence-only scope `docs/plans/plus-1.1.15-b1-live.md`, owned PTY `overnight-b1-live-retry`. T84 stopped, partial facts/cleanup below; full two-message/three-ping/stable-status/next-read sequence still required.
- T88 attempt 1 ended `no_report`, with only setup checkpoint `9d79f74ea2`: four core files 33 pass, Plus requests 18 pass, core/Plus typechecks; actual Defaults › Models shows saved `warm 4m · every 1m`. No provider failure was reported. Resumed the still-needed idle run immediately as attempt 2 to complete the existing owned test rather than repeat setup; required to append observations and explicitly `team_finish`. No ping/provider-use/status/cleanup acceptance inferred from the setup checkpoint.

### A3/A6/B6 — initial repair scope (results below)

- A3: no Defaults echo for team members; preserve instructions_show refusal evidence on member run-scope rows.
- A6: inspect shell description and registration-count expectations before choosing test or code fix.
- B6: inspect warming test-harness failure; preserve `/tools`, extend `/monitor` checks after B2.

### A1 — source reviewed/landed, live T86 running

- Input `team/Flash-Implementer/t58b343-20261004-1306` merges cleanly. Reviewed all source/docs/test additions: file/member/team API paths, record rewrites, tools/RPC, rename selection/help.
- Reproduced known ancestor refusal failure: rename test **5 pass / 1 fail** (`legacy` called built-in rather than ancestor). Actual cause is #5, not refusal order.
- Small discovery-boundary fix retained symlink confinement and the real global-config-directory exclusion, but removed premature stop at its arbitrary parent directory. Verification: `bun test test/rename.test.ts test/discover.test.ts test/model.test.ts test/rpc.test.ts test/categories.test.ts test/monitor-requests.test.ts test/active-team.test.tsx` **185 pass, 5 pre-existing skips, 0 fail**; Plus typecheck passes. Live pending a worker slot.

### A2 — source landing, acceptance pending

- Input `team/Flash-Implementer/t6086e7-20261004-1347` reviewed. Resolved tools conflict keeping category + rename routing before new field routing; dialogs keep category and rename functions and return `editModelField`, not removed `editModel`.
- Documented closed editing decision in README: Model/Effort replace in place, inherited old candidate hidden at this level, re-add restores/activates.
- `bun test test/model.test.ts test/rpc.test.ts test/model-settings.test.ts test/instructions-panes.test.tsx test/categories.test.ts test/rename.test.ts` **151 pass, 3 pre-existing skips, 0 fail**; Plus typecheck passes.
- #1 and #6 corrections, T3 member provider-use evidence, every T7 field live, A4 speed and A5 workaround evaluation still pending.

### B2 — source merge/review complete, acceptance pending

- Merged T3 page input `team/Flash-Implementer/t45315d-20261004-1103` personally. Retained T2 topmost-root tree SQL and fail-closed incomplete scope; removed duplicate auto-merged query/report/totals fields. New totals stay optional, with UI fallbacks rather than changing the RPC contract.
- Reviewed all page tabs, keymap, command/route wiring, compact Tools, session picker, story and test diffs. Production view uses real RPC; story renders the actual view. Found #7 below; no acceptance claim until repair/live.
- `bun test test/monitor*.test.*`: **59 pass, 0 fail**; Plus/TUI typechecks pass. No tests skipped/weakened. Revised session-only test expectations are intentional T2 scope changes, but additional tree/compact regression needed (#7).
- Synthetic analysis benchmark: first session overview 60.3 ms; tree 494.6 ms; all 10013.8 ms. Repeat 0.85/3.97/78.85 ms respectively; cache rows repeat 0.40/3.09/75.43 ms. All first-open cost recorded for follow-up, not a passing speed claim.
- Monitor-plugin tests warn `plus monitor hooks registration failed`: the old context fixture has unimplemented hooks while tests exercise events. Investigate/repair fixture alongside A3 RPC/B6; expected explicit ledger-failure controls retain their warnings.

### A3/B6 — partial source verified

- T76 diff reviewed and landed `ae09701991`: only two T5 expectation repairs, plus rule/pattern assertions; no enforcement change. Parent checks **24 pass**, Plus typecheck. Stopped.
- B6 `1047b1e5df`: reviewed test-harness-only `ui.prompt.guard` repair; production setup matches the public context. Parent command tests 2 pass, Plus typecheck pass. Worker stopped. `/monitor` plus `/tools` alias assertions remain after B2.
- After all four merges, A3 RPC expected-method list gains `category.mutate`; B6 now asserts exact `/monitor`, `/tools` alias, title, palette and unchanged unique command id. Small parent test reconciliation, not production change.
- Parent `bun test test/rpc-contract.test.ts test/plugin-commands.test.tsx`: **24 pass**, Plus typecheck pass. A3/B6 test repair complete; B6 live spelling/alias verification is now in fresh T87.

### A6 — complete

- Reviewed and landed `2f7287ee59`: two stale expectations, no production changes. Shell summary correctly describes the existing per-command allow-list; three registrations correctly include team-member enforcement. Permission/catalog assertions preserved. Full rationale in `plus-1.1.15-a6-stale-tests.md`.
- Parent `bun test test/descriptions.test.ts test/team-query-off.test.ts`: **12 pass**, Plus typecheck pass. Stopped.

### Additional Instructions review

- Personally read T1/T2/T4/T5 initial commits and current source: real config directory and cascade, process-wide store notifications + Location publish, registered team members/Defaults filtering, local model newest-wins reseeding. Found #11 cascade isolation and fixed it; A5 workaround evaluation still pending. T8 source/category/tree/key review found #12 and #14.
- Current focused five files: **95 pass / 2 fail**; both failures are post-B2 active-team hint/count expectations (new M), sent to T83 under #7. The other four files (agents/tree/categories/propagation) pass. TUI real local model refresh tests **2 pass**, TUI typecheck passes. Source tests are not multi-TUI live acceptance.

### B3 — initial end-state source review complete; corrections/acceptance pending

- T1/T2 source reviewed at the actual request/collector/fingerprint/analysis boundaries; migration/idempotency/retention and protocol evidence covered by 59 focused tests. #2/#3 remain active, plus new #8/#9 below. Real Instructions update uses key-indexed `delta`; collector's Object.keys matches core.
- T4 reviewed: `buildRunTree` lifts member to topmost root with sibling/deep traversal; UI defaults tree, shows `ctrl+t`, keeps active/inactive and attach/stop behavior, explicit no-team state. Existing focused tests and pending B4/final live establish acceptance; M gap is #7.
- T1 coverage: real HTTP/WS final observers and transport identity/outcome joins, pricing/usage/error rows, named hashed protocol fingerprints, instruction/compaction/switch/revert/account facts, migration, retention and idempotency reviewed in source. Actual-boundary `monitor-requests` tests cover these (including later-transform and unrelated-request refusal controls); legacy call privacy is the separately reproduced #9, not covered by the old request-only privacy test.
- T2 coverage: common-prefix measurement, exact 1024/50%/90% thresholds, ordered cold/miss causes, confidence and detail evidence, Code Mode scope/window/detail/refusal/marks reviewed. Real-ledger `monitor-cache` and `monitor.test` cover the standard causes and tool grouping. #8 is the inaccurate aggregate/window/state seam; #13 is the real private-ping-tail cause gap. Cached pricing unknown must remain omitted; do not equate a zero total with known free processing.
- T3/T4 coverage: full/compact command/open/back route, header/window/totals/tabs, facet/text/drill keys, persisted settings, narrow/wide layout, Team tree and no-team controls, story production component, README Monitor and Team sections personally read. #7 records gaps; README additionally claimed Sessions `space`/`t` both tree while `t` is window, sent to T87 for one consistent key. The README's separate `## Tools` at line 159 describes Instructions agent tools, not the old Monitor section, and is retained.
- Initial source review is not live acceptance. Re-read repair diffs against these end states, then B4 and the fresh final sweeps must establish the actual live claims.

## Issues

### #1 — owner-segment model create leaves an unreachable record (open)

- Evidence supplied by overnight plan: `instructions.create({kind:"model",level:"global",agent:"Simple/:Simple-Orchestrator"})` without `team` passes `group:global:Simple/:Simple-Orchestrator:models` owner check, writes literal owner-segment agent, then returns `create.failed`. No deletable tree row.
- Where: `packages/plus/src/tools.ts` model-create owner validation.
- Weight: wrong behavior / Instructions T3 owner identity boundary.
- Plan: refuse owner-segment `agent` with actionable `agent` + `team` instructions before any write; cover store revision/record refusal and valid member create in focused model/tool tests; live re-check in isolated dev home. Leave the existing live-store record untouched.
- Fix/verification: pending A2 reconciliation.

### #2 — auxiliary generation transport is mislabeled after preserving primary transforms (source fixed, live pending)

- Seen in source review: `SessionGenerate.generate` correctly uses non-durable primary/context transforms to preserve the real request cache prefix. HTTP hook consequently says `primary`, which Monitor stores as `step`; generated outcome matches only `generate`, creates another row and warming relabels only that duplicate to ping. Wire fingerprint remains on an unfinished step row.
- Where: core `session/generate.ts`, `session/model-request.ts`, Plus `monitor/plugin.ts` and `ledger.ts`.
- Weight: breaks Monitor T1 every-request identity/kind/fingerprint/usage, B1 ping acceptance.
- Plan: distinguish transport request identity/kind without changing primary content hooks/cache policy, propagate generate outcome correctly; actual core HTTP middleware + Plus hook regression must assert exactly one completed fingerprinted generate/ping and no orphan step, pinned identities and durable state unchanged. Live B1 re-check two messages/three pings.
- Fix/verification: `de7c1952bf`; parent focused tests/typechecks and exact discriminating assertions recorded under B1. T84 live pending.

### #3 — request analysis cache serves stale in-place outcomes (source fixed, live pending)

- Seen in source review: report cache key is last request id/count + last fact timestamp/count only. `requestEnded`, final wire fingerprint updates and generate→ping relabel mutate existing rows with those keys unchanged. Polling an open request then its completion can forever show zero usage / old verdict / old kind until another row/fact appears.
- Where: `packages/plus/src/monitor/report.ts:30–69`, ledger writes.
- Weight: wrong live behavior / Monitor T1–T3 facts must reach page.
- Plan: invalidate analysis on real ledger mutation using an existing cheap seam or explicit per-ledger revision, with two-query regression for outcome, final fingerprint, and relabel. Preserve measured query caching where useful; no speculative framework. Live repeat page polling once B2 lands.
- Fix/verification: queued after #2 (same monitor tests/source).
- T80 first repair reviewed: connection-local `total_changes()` fixes local writes and three discriminating regressions, but misses another SQLite handle/process writing the shared file. Sent one correction: combine `PRAGMA data_version` with local changes; two-handle/direct-write regressions, retain no-write polling cache. Not landed yet.
- Correction reviewed and landed `339c6e2f36`: composite local-change/data-version revision, completion through second WAL handle and direct update regressions plus original three. Parent cache **14 pass**, ledger/requests/plugin **34 pass**, Plus typecheck passes. Benchmark repeat session/tree/all 0.84/4.15/87.49 ms; cold Everything still 10.34 s (recorded, not speed acceptance). T80 stopped; live page polling acceptance pending T83.

### #4 — pre-page view still assumes old session scope (source reconciliation complete; compact live pending #7)

- Observed merge check: five `monitor-view.test.tsx` failures, including expected `scope this chat + delegated`, four calls versus two, missing `explore` facet and absent child groups. T2 intentionally makes `session` exactly one session; compact Tools must default to tree in T3.
- Plan: reconcile B2 production compact/full view and tests against T2 tree/session contract; run every monitor file and Plus/TUI typechecks; live /monitor, /tools and M at 80/160 columns.

### #5 — ancestor scan stops at configured global directory's parent (fix in A1)

- Observed `rename.test.ts` refusal returned `Agent legacy is built in and cannot be renamed`. With `OPENCODE_CONFIG_DIR=<fixture>/config` and project `<fixture>/project`, discovery stops at `<fixture>` before seeing `<fixture>/.opencode/agent/legacy.md`.
- Weight: breaks Instructions T6 clear ancestor refusal; also wrong ancestor discovery for a real custom config directory beside a project.
- Files: `packages/plus/src/instructions/discover.ts`.
- Decision/fix: remove the `current === globalParent` stop; the actual global directory exclusion and realpath/symlink checks still prevent treating global files as project files. This matches V2 upward discovery to filesystem root.
- Focused proof passed within A1's 185-test check, including refusal and symlink controls; Plus typecheck passes. Live A1 ancestor refusal in isolated home still pending.

### #6 — model field inheritance/reset breaks T7 (open)

- Source review: `lazyModelField` ignores inherited agent/member warming/interval/prompt whenever the source level is not the current level and instead displays Defaults values. An inherited explicit variant reports `own: true` without its source. `resetModelFieldRow` explicitly refuses Model reset even though T7 says `r` resets each field; the new test incorrectly blesses this refusal. `show view:record` does not match team/catalogue, risking another owner's record.
- Where: `instructions/tree.ts`, `instructions/ops.ts`, `tools.ts`, model-field tests/docs.
- Weight: breaks Instructions T7 effective values/provenance/field reset and owner identity.
- Plan: field display follows real resolved chain and includes its actual source; reset Model restores the inherited candidate at this level while preserving unrelated fields (closed editing semantics), reset Effort inherits correctly; record lookup matches full scope. Cover Global→Project, team/preset/catalogue identity, every individual edit/reset and preservation. Update inaccurate refusal expectation; live every field after correction at 80/160 columns.
- Additional review note for A4: catalogue is cached but first snapshot still calls `ctx.model.list()`; verify T7's catalogue-only-in-pickers rule in measured speed work, not only timings.
- Early T82 diff review: a proposed Model reset used the upstream active model, which is not necessarily the edited candidate (inherited active A, inactive B edited to C). Sent a discriminating B→C→reset regression and required restoring this row's original identity while preserving unrelated fields/effort and activation intent. No verdict/landing yet. A delayed provider-stream error message from 00:46 UTC was read; current run is streaming, not retrying, and has later source changes, so it recovered and stays assigned.

### #7 — T3 page controls/layout do not fully match real behavior (open)

- Source evidence: `/` saves `filterText` but no tab applies it. Compact renders Tools and requests `view: tools`, while Enter branches on stored `tab` (initial Overview), so a fresh compact Enter is inert. Full and compact share `monitor` stored scope, so M may open on tree rather than its session. Team M navigates directly and bypasses remembered return route. Oldest-first request list is polled using its first row, missing recent activity without a tool feed.
- Other concrete gaps: narrow Cache hides the kind (pings indistinguishable), agents table width 82+ even after dropping model at 80, full-row selection never scrolls into view, and top-tools overview uses whichever grouped/top-limited tool query was last selected. Detail fixtures invent exact line/character changes impossible from hashed segments, include explicit `undefined`, and story ignores request id/scope/view; inherited member field issues are separate #6.
- Weight: breaks Monitor T3 controls, open-session scope, intuitive narrow layout and story/real-contract reconciliation.
- Plan: repair minimal existing seams in page/route/settings/tabs/query and fixtures/story; preserve compact capabilities, temporary drill-downs and persisted settings. Add actual-ledger tests for compact drill, M open/back, filters/selected detail, session/tree ownership, polling and narrow columns/scroll. Live every tab/scope/window and M via both composer tabs at 80/160. Keep optional RPC additions and privacy.
- T83 stopped for no material activity for 35 minutes. Fresh T87 `w-52d5fb25d626bd21` started at `254fcbcccc`; same page repairs/live, forbidden Instructions/report/cache/collector/ledger overlap. #1/#6 T82 `w-b932eadad70bb911` running from `ae09701991`.
- Root preflight `bun run check` stopped at lint (before typechecks): story `monitor.tsx:466/473` uses restricted `Reflect.get`, two errors. T83 notified to replace these at the typed fixture boundary; canonical final gate remains pending.
- Parent broader focused check also finds two stale active-team expectations after new M: hint list misses monitor/M and commands expect 6 instead of 7. T83 notified; action assertions must remain and actual M open/back regression added.

### #8 — derived Monitor report loses unknowns/state and window semantics (open)

- Actual isolated-ledger reproduction: an unknown-pricing miss omits request `missCost` but `queryMonitor` totals return `missCost: 0`, because T3's new baseline zero is merged under T2's deliberate omission. Same sessions response has no `state` at all; production has no assignment anywhere, so it always displays `—` despite T3's state requirement. Legacy v1 sessions/agents breakdown also uses only request rows despite retained step totals.
- Source review: windowed ping `sent`/cost use filtered requests but followedByHit/Miss, unstable and unread reuse entire session analysis. Out-of-window signals can exceed sent or describe another period. Agent tokens omit reasoning; Sessions UI token total omits cache reads/writes/reasoning.
- Weight: inaccurate Monitor T2 signals / T3 metrics, not unknown provider-routing behavior.
- Plan: after #3 lands, correct report aggregation/omission and per-session real state using existing query/event/run seams; filtered signals honor the requested window, retain history only as evidence/predecessors. Focused actual-ledger regressions for unknown vs known pricing, windowed pings/unstable/unread, legacy breakdown, running/completed/error states and reasoning/cache-inclusive totals. T83 handles visible Sessions token total; avoid new durable derived state. Re-check page scopes/windows live.
- Further review: unread writes are counted even before their expiry (analysis has no as-of time), and later out-of-window reads can change historical-window signals. Session `agent` is overwritten by title/generate hook identities; derive/enrich Sessions from real host active/outcome/agent when available, not the last auxiliary request. `ctx.session.active()` and `Session.Info.outcome` are existing authoritative seams.
- T89 `w-0064570ccf6aa2d2` started at `312d72c725` for #8 and #13 together (shared cache.ts). Owns report/cache/host enrichment, only query totals/state integration; T87 retains query filters/top-tools and all UI. Requires new actual-ledger `monitor-analysis.test.ts`, existing cache/requests/plugin/RPC controls, Plus typecheck and owned live RPC/state/metrics evidence. Full B4 deliberate misses/scopes wait for the combined corrected page/analysis HEAD. Refused first delegation scope was corrected to source/test directories plus exact README/evidence files; no permission bypass.

### #9 — legacy call attribution persists content-bearing errors/targets (fixed; source and owned live verified)

- Actual collector reproduction writes fictional `FICTIONAL_PRIVATE_ERROR_SENTINEL` unchanged to `call.error` (`tool: …`). Request errors correctly hash through `errorFingerprint`, but callEnded does not. `innerTarget` also writes the first arbitrary string argument of unknown Code Mode tools, and targetOf stores raw search text; commandHead treats any lower-case second argument as a subcommand (e.g. echo's payload).
- Weight: violates T1 no-content ledger privacy; existing request-only privacy assertions miss call columns. No real secret read or printed; reproduction used a fictional sentinel and isolated temp ledger.
- Plan: reuse hashed errors for call persistence and restrict targets to recognized identifiers/names/paths/hosts or hashed query summaries; remove arbitrary-string fallback and only retain known command subcommands. Keep target grouping and useful names, no content redaction framework. Focused tests inspect every stored column with sentinel refusal/control cases; old stores remain readable, no touching/migrating shared live ledger. Owned live check one failed tool/query and inspect isolated ledger.
- T85 `w-c7c1ed13b4ed9214` repairing privacy from `339c6e2f36`; owns collector/attribution/ledger and non-cache Monitor tests, not page/query/report or Instructions. Also reconciles stale monitor-plugin hook fixture warnings without weakening failure controls.
- Early T85 diff correctly hashes call errors at the persistence boundary and removes arbitrary inner-argument attribution. Proposed program-arity check still retains `git fictional_private_payload_sentinel`; requested recognized-subcommand-only control. Also require lowercase echo sentinel (uppercase alone would not discriminate old regex). No final verdict/landing yet.
- T85 attempt 1 reported source `44970b598a` and README `f130f6cf2d`, green focused checks and isolated failed-tool/search privacy evidence; queued correction is now attempt 2 working, so not landed/stopped yet. Its report identified four existing `tools.test.ts` failures; parent reproduced and recorded #15 rather than ignoring them.
- T85 attempt 2 source correction `77eeb9397b` personally read: explicit known subcommands, lowercase arbitrary git/echo refusal assertions over every table, useful git diff/push and bun test controls, updated README. Reported focused checks/live lowercase controls pass. Receipt followup is attempt 3 working (exact log/owned cleanup proof and allowed-path vs content-sentinel distinction), still not landed.
- Full diff/receipt reviewed and landed as `4588c190a2`, T85 stopped immediately. Parent monitor/cache/requests/plugin/RPC focused check **72 pass / 0 fail**, Plus typecheck passes. Expected ledger/final-observer failure-control warnings remain; bogus monitor-plugin registration warnings are gone. Parent clarified the receipt's unit-vs-live sentinel table: all stored-column fictional-sentinel controls are real source regressions, whereas actual owned live exercised failed read/search/shell and lowercase git/echo with useful git diff. No invented claim that all five unit inputs ran through the TUI.
- Owned receipt `plus-1.1.15-monitor-privacy-live.md`: actual `opencode-local.log` has 24 warning/error lines, all executor-controlled source refusals, zero other errors/warnings. Parent independently confirms PIDs 2757434/2757513/2757651/2757697 absent and no cwd/fd/maps match in the exact privacy dev home. Failed-read path names intentionally stay visible; only error/query/content payloads are hashed/omitted. Existing old raw records stay readable, not migrated or edited. No push.

### #10 — navigation still reads the provider catalogue through base classification (open)

- Source review: `discoverAll` calls `resolveBaseTemplates` on every discovery; it unconditionally calls `ctx.model.list()` before the separately cached `hostModelsFor`. The latter also loads on navigation's first snapshot and is cleared by host agent/skill events. Thus cached host Models alone does not establish T7's catalogue-only-in-pickers rule.
- Where: `packages/plus/src/index.ts:4529–4555,4610–4662`, `instructions/discover.ts`; A4.
- Plan: profile actual first/repeat Defaults and agent Models opens, correct measured catalogue work at existing registry/cache seams without stale base-family classification or dropping host warming/variants, prove navigation makes no catalogue fetch and pickers load/cache it. Measure live before/after with prescribed clock method, record every number; targets 1.5 s/300 ms.

### #11 — deleting a standalone agent erases same-id team edits (source fixed, live pending)

- Source review: `removeAgentRecords` scopes model/rule/link removal by absent `team`, but customization/split branches match only level + agent. Deleting a Global user agent whose id also names a Global team member removes that independent member's edits/splits.
- Where: `packages/plus/src/index.ts:3713`; violates T1/T5 owner isolation.
- Plan: one-line team-owner exclusion before cascade branches; extend actual `agent.delete` regression with same-id team customization/split controls. Parent handles this small fix, Plus propagation/RPC/Monitor-focused checks and typecheck; final Instructions live sweep covers delete and preserved member owner.
- Actual `agent.delete` regression failed before repair: expected two member-owned records, received `[]`; standalone records correctly deleted. One-line exclusion applied; propagation/RPC/Monitor plugin+requests **84 pass, 3 pre-existing skips, 0 fail**, Plus typecheck passes. Member controls survive, standalone re-create starts clean, single revision preserved. Live final sweep still pending.

### #12 — punctuation-equivalent category names collide on row identity (source fixed, live pending)

- Source review: category create/rename checks names case-insensitively, but row ids use `categorySlug`; `One Two` and `One-Two` both produce `category:one-two`. Creation can return the same id twice; id-based rename/delete then selects the first category and one tab hides the other.
- Where: `packages/plus/src/index.ts:1465,1494`, `instructions/categories.ts`; breaks T8 category identity/rename/delete.
- Plan: reuse the handler's existing name-or-slug `find` for create/rename collision validation, before any write. Actual API regression proves refusal leaves revision/records unchanged, unique names and same-category punctuation/case rename still work. Parent handles two-line repair/test; final live categories sweep includes refusal.
- Actual create regression failed before repair (`ok:true` instead of refusal). Both name/slug checks now reuse `find`; parent category/RPC/Monitor plugin+requests **85 pass, 3 pre-existing skips, 0 fail**, Plus typecheck passes. No-write refusal controls and same-id rename pass; live pending final sweep.

### #13 — private ping tail is falsely described as a changed cache prefix (open)

- Actual isolated-ledger reproduction used real Anthropic wire fingerprints: unchanged long system + user history, assistant cache marker before the ping's private last user prompt; next primary preserves that marked prefix and replaces the uncached private tail with new user input. Report says `miss / prefix-changed`, `firstDivergence: message 3 (text)`, expected 9193, gap 10000 ms, lifetime 300000 ms, healthy ping at 390000. It names normal private→real input replacement as the certain miss cause although the reusable marked prefix is unchanged.
- Where: `monitor/cache.ts` full-message comparison/cause selection. Breaks T2 honest cause/evidence, is the real B1 warming shape, not relay-account conjecture.
- Plan: compare/report changes of the reusable prefix, not the known uncached ping tail; preserve exact final-wire fingerprint and show real divergence elsewhere. Minimal existing ping kind/cache-marker seams; regressions for healthy/failed/different-model pings, normal next user input, and a genuinely changed marked system/message. Within lifetime an unchanged reusable prefix must remain unknown/provider-side; over lifetime only successful compatible pings refresh it. Owned B4/final live re-check.

### #14 — category selection changes what Delete does to content rows (open)

- Source review: Instructions `remove()` first handles an explicit category header, then unconditionally deletes the selected user category even when `current()` is a model/item/agent row. Moving a deletable model into a category means d now asks to delete the category instead of the model; sidebar deletion is similarly hijacked. T8 says categories are display-only and editing stays unchanged; T7 model d must remain.
- Where: `packages/plus/src/tui/instructions/route.tsx:1028–1033` and its key handling; category add also needs live verification in Models where the direct add path may bypass the generic Category choice.
- Plan: only an explicit category header targets category deletion; other rows retain their original delete path. Real route/key regression and live category/model delete plus header delete/refusal control, at 80/160; include T8 move/reset/edit preservation and help/hints.

### #15 — four old model tool tests contradict landed activation/edit semantics (open)

- Parent `bun test test/tools.test.ts`: **66 pass, 1 existing skip, 4 fail**. Worker T85 reproduced them at its base before privacy edits. One replacement test at line 1329 expects one stored model record but receives two (candidate plus hiding tombstone); three delete flows at lines 2455/2557/3070 try to delete a model immediately after create, which now correctly activates it exclusively and refuses deleting the effective model.
- Weight: failing Instructions regression gate; contracts T3 auto-activation and A2 closed in-place editing are not to be weakened.
- Plan: reconcile these actual tool tests after validating each failure against the contract: assert exactly one visible edited row plus the correctly scoped tombstone, preserved active/unrelated fields; preserve the effective-model deletion refusal, explicitly activate another candidate/reset the local active flag before deletion/hiding as appropriate. Retain returned-level/owner id and re-add/refusal assertions. T82 already owns model/tool tests; include this in its focused check and later live model sweep. Fixture permission-hook warnings are separate from these four demonstrated assertion/refusal failures.

## Live evidence

- T81 had no commit or changed worktree file for 35 minutes and no report: stopped force per watchdog, not accepted as complete. Its named PTY was in a rename dialog at 160×48 (no busy indicator); owned SQLite showed one idle session, no compaction and 12 completed/zero unfinished requests. Kernel cwd/fds established owned test PIDs 2623601/2623736 and isolated log/database paths. Parent exited via palette; PTY exit 0, `/proc` confirms both PIDs gone. `pilotty kill` then reports SESSION_EXITED. Partial evidence retained in the old dev home, no source/state deletion. A fresh A1 acceptance run is required; no end-state claim from incomplete evidence.
- T84 cleanup: named PTY `overnight-b1-live` snapshot reports `outcome: exited`, exit 0, `killed_by_client: true`; `pilotty kill` confirms SESSION_EXITED. A `/proc` cwd/fd/maps scan for exact dev home `run/plus-dev/run-plus-data-opencodeplus-teams-worktrees-opencode-Flash-C-Worker-t84524a-20261005-0236` finds **no matches**. The only worktree-cwd match was the immutable release worker CLI, not a test runtime, and was not touched. Read-only owned ledger has 11 completed/1 errored ping, 15 completed steps and 1 completed title; ping totals input 644/cache read 92928/cache write 0/output 22. These are preserved partial facts, not proof of prescribed screen/status sequence or final acceptance. An initial totals query used legacy column `cache_read` and failed; corrected against actual `cache_read_tokens` schema. No store/config migration or mutation.

## Open findings for morning

Issues #1/#6/#7/#8/#10/#13/#14/#15 and the acceptance/gates above remain pending. Final sweep has not run; no final acceptance claim.
