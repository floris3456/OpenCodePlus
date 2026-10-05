# plus-1.1.15 overnight log

## Resume here

- Branch/worktree: `plus-1.1.15_overnight`; initial HEAD `75a8d9e20f`.
- Read this log first after a break, then `plus-1.1.15-overnight.md`.
- Current phase: B2 source merge/review complete; repair its page gaps (#7) before live acceptance.
- Pending acceptance: B1/A1/A2/B2; A3 RPC/A6/B6 post-page assertions; A4/A5/B3/B4; F.
- B1 source merged as `26eacdfc14`; #2 landed `de7c1952bf`, T79 stopped. B1 live T84 and #3 T80 running. A3 T76 landed `ae09701991`, A6 T77 landed `2f7287ee59`, both stopped. B6 fixture landed `1047b1e5df` and stopped.
- A1 source landed `24a1a1115f`; live acceptance pending. A2 source merge/review complete, focused tests passing, newly found field gaps #6 await correction.
- No merge into `plus-1.1.15`, push, release build/promotion, shared-service access, or live-config mutation.

## Decisions

- 2026-10-05: Follow the overnight plan's explicit five-child limit and order (it supersedes the older task plans' two-child limit). Only Flash-C-Worker codes/tests unless its provider is unavailable. I alone merge, review, land, and log.
- 2026-10-05: Start B1 first while independent A3 (T5 expectations), A6, and B6 test repairs run. Defer A3 RPC declarations until all four branch merges land.
- 2026-10-05: Log did not exist at start; created before implementation. Existing prepared branches are inputs, not worktrees to change.

## Progress and verification

### B1 — in progress

- Input branch: `team/Heavy-Implementer/t54a9ef-20261004-1204`.
- Must preserve pinned warming agent/model, `durable: false`, cache policy and private prompt; add generated kind/error, reconcile core tests and Plus index/API.
- Merge conflicts resolved by retaining loaded/pinned `primary` preparation plus generated outcome timing, both core test imports via `ID`/`Ref`, warmed early-return, and existing team retry-status helper.
- Reviewed input changes in core generation/title/transport hooks, plugin session contract, Plus monitor ledger/fingerprints/collector/cache/report/query/tools, quota facts, team identity and tests. Identified #2/#3 below; landing the combined source before targeted repairs, not claiming acceptance yet.
- Checks at merge: core focused five files **45 pass**, core/plugin/plus typechecks pass. Monitor files **49 pass / 5 fail**: all five are the pre-B2 view expecting old session-plus-descendants semantics; repair belongs to B2 (#4). Warnings in monitor refusal controls deliberately exercise containment; monitor-plugin fixture registration warnings need follow-up inspection.
- Live acceptance pending: short warming, two messages, three pings, usage and stable warming status, cache read on next message.
- #2 repair reviewed and landed `de7c1952bf`: transport-only kind override preserves primary content hooks and labels model/HTTP/WS as generate. Core real HTTP middleware and Plus real hook regressions prove one completed fingerprinted row, warming relabel in place, pinned identities, hashed failure and unrelated-step refusal. Parent core five files **46 pass**, Plus requests **18 pass**, core/plugin/plus typechecks pass. T79 stopped; T84 `w-524a6a474852446e` live report running at this HEAD.

### A3/A6/B6 — pending independent repairs

- A3: no Defaults echo for team members; preserve instructions_show refusal evidence on member run-scope rows.
- A6: inspect shell description and registration-count expectations before choosing test or code fix.
- B6: inspect warming test-harness failure; preserve `/tools`, extend `/monitor` checks after B2.

### A1 — merge/review in progress

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
- Parent `bun test test/rpc-contract.test.ts test/plugin-commands.test.tsx`: **24 pass**, Plus typecheck pass. A3/B6 test repair complete; B6 live spelling/alias verification is in T83.

### A6 — complete

- Reviewed and landed `2f7287ee59`: two stale expectations, no production changes. Shell summary correctly describes the existing per-command allow-list; three registrations correctly include team-member enforcement. Permission/catalog assertions preserved. Full rationale in `plus-1.1.15-a6-stale-tests.md`.
- Parent `bun test test/descriptions.test.ts test/team-query-off.test.ts`: **12 pass**, Plus typecheck pass. Stopped.

### B3 — review in progress

- T1/T2 source reviewed at the actual request/collector/fingerprint/analysis boundaries; migration/idempotency/retention and protocol evidence covered by 59 focused tests. #2/#3 remain active, plus new #8/#9 below. Real Instructions update uses key-indexed `delta`; collector's Object.keys matches core.
- T4 reviewed: `buildRunTree` lifts member to topmost root with sibling/deep traversal; UI defaults tree, shows `ctrl+t`, keeps active/inactive and attach/stop behavior, explicit no-team state. Existing focused tests and pending B4/final live establish acceptance; M gap is #7.

## Issues

### #1 — owner-segment model create leaves an unreachable record (open)

- Evidence supplied by overnight plan: `instructions.create({kind:"model",level:"global",agent:"Simple/:Simple-Orchestrator"})` without `team` passes `group:global:Simple/:Simple-Orchestrator:models` owner check, writes literal owner-segment agent, then returns `create.failed`. No deletable tree row.
- Where: `packages/plus/src/tools.ts` model-create owner validation.
- Weight: wrong behavior / Instructions T3 owner identity boundary.
- Plan: refuse owner-segment `agent` with actionable `agent` + `team` instructions before any write; cover store revision/record refusal and valid member create in focused model/tool tests; live re-check in isolated dev home. Leave the existing live-store record untouched.
- Fix/verification: pending A2 reconciliation.

### #2 — auxiliary generation transport is mislabeled after preserving primary transforms (open)

- Seen in source review: `SessionGenerate.generate` correctly uses non-durable primary/context transforms to preserve the real request cache prefix. HTTP hook consequently says `primary`, which Monitor stores as `step`; generated outcome matches only `generate`, creates another row and warming relabels only that duplicate to ping. Wire fingerprint remains on an unfinished step row.
- Where: core `session/generate.ts`, `session/model-request.ts`, Plus `monitor/plugin.ts` and `ledger.ts`.
- Weight: breaks Monitor T1 every-request identity/kind/fingerprint/usage, B1 ping acceptance.
- Plan: distinguish transport request identity/kind without changing primary content hooks/cache policy, propagate generate outcome correctly; actual core HTTP middleware + Plus hook regression must assert exactly one completed fingerprinted generate/ping and no orphan step, pinned identities and durable state unchanged. Live B1 re-check two messages/three pings.
- Fix/verification: pending worker after merge checkpoint.

### #3 — request analysis cache serves stale in-place outcomes (open)

- Seen in source review: report cache key is last request id/count + last fact timestamp/count only. `requestEnded`, final wire fingerprint updates and generate→ping relabel mutate existing rows with those keys unchanged. Polling an open request then its completion can forever show zero usage / old verdict / old kind until another row/fact appears.
- Where: `packages/plus/src/monitor/report.ts:30–69`, ledger writes.
- Weight: wrong live behavior / Monitor T1–T3 facts must reach page.
- Plan: invalidate analysis on real ledger mutation using an existing cheap seam or explicit per-ledger revision, with two-query regression for outcome, final fingerprint, and relabel. Preserve measured query caching where useful; no speculative framework. Live repeat page polling once B2 lands.
- Fix/verification: queued after #2 (same monitor tests/source).
- T80 first repair reviewed: connection-local `total_changes()` fixes local writes and three discriminating regressions, but misses another SQLite handle/process writing the shared file. Sent one correction: combine `PRAGMA data_version` with local changes; two-handle/direct-write regressions, retain no-write polling cache. Not landed yet.

### #4 — pre-page view still assumes old session scope (open, expected B2 integration gap)

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

### #7 — T3 page controls/layout do not fully match real behavior (open)

- Source evidence: `/` saves `filterText` but no tab applies it. Compact renders Tools and requests `view: tools`, while Enter branches on stored `tab` (initial Overview), so a fresh compact Enter is inert. Full and compact share `monitor` stored scope, so M may open on tree rather than its session. Team M navigates directly and bypasses remembered return route. Oldest-first request list is polled using its first row, missing recent activity without a tool feed.
- Other concrete gaps: narrow Cache hides the kind (pings indistinguishable), agents table width 82+ even after dropping model at 80, full-row selection never scrolls into view, and top-tools overview uses whichever grouped/top-limited tool query was last selected. Detail fixtures invent exact line/character changes impossible from hashed segments, include explicit `undefined`, and story ignores request id/scope/view; inherited member field issues are separate #6.
- Weight: breaks Monitor T3 controls, open-session scope, intuitive narrow layout and story/real-contract reconciliation.
- Plan: repair minimal existing seams in page/route/settings/tabs/query and fixtures/story; preserve compact capabilities, temporary drill-downs and persisted settings. Add actual-ledger tests for compact drill, M open/back, filters/selected detail, session/tree ownership, polling and narrow columns/scroll. Live every tab/scope/window and M via both composer tabs at 80/160. Keep optional RPC additions and privacy.
- Worker T83 `w-d97ad6d4f18f9ee2` running from `2f7287ee59`. #1/#6 worker T82 `w-b932eadad70bb911` running from `ae09701991`.
- Root preflight `bun run check` stopped at lint (before typechecks): story `monitor.tsx:466/473` uses restricted `Reflect.get`, two errors. T83 notified to replace these at the typed fixture boundary; canonical final gate remains pending.

### #8 — derived Monitor report loses unknowns/state and window semantics (open)

- Actual isolated-ledger reproduction: an unknown-pricing miss omits request `missCost` but `queryMonitor` totals return `missCost: 0`, because T3's new baseline zero is merged under T2's deliberate omission. Same sessions response has no `state` at all; production has no assignment anywhere, so it always displays `—` despite T3's state requirement. Legacy v1 sessions/agents breakdown also uses only request rows despite retained step totals.
- Source review: windowed ping `sent`/cost use filtered requests but followedByHit/Miss, unstable and unread reuse entire session analysis. Out-of-window signals can exceed sent or describe another period. Agent tokens omit reasoning; Sessions UI token total omits cache reads/writes/reasoning.
- Weight: inaccurate Monitor T2 signals / T3 metrics, not unknown provider-routing behavior.
- Plan: after #3 lands, correct report aggregation/omission and per-session real state using existing query/event/run seams; filtered signals honor the requested window, retain history only as evidence/predecessors. Focused actual-ledger regressions for unknown vs known pricing, windowed pings/unstable/unread, legacy breakdown, running/completed/error states and reasoning/cache-inclusive totals. T83 handles visible Sessions token total; avoid new durable derived state. Re-check page scopes/windows live.

### #9 — legacy call attribution persists content-bearing errors/targets (open)

- Actual collector reproduction writes fictional `FICTIONAL_PRIVATE_ERROR_SENTINEL` unchanged to `call.error` (`tool: …`). Request errors correctly hash through `errorFingerprint`, but callEnded does not. `innerTarget` also writes the first arbitrary string argument of unknown Code Mode tools, and targetOf stores raw search text; commandHead treats any lower-case second argument as a subcommand (e.g. echo's payload).
- Weight: violates T1 no-content ledger privacy; existing request-only privacy assertions miss call columns. No real secret read or printed; reproduction used a fictional sentinel and isolated temp ledger.
- Plan: reuse hashed errors for call persistence and restrict targets to recognized identifiers/names/paths/hosts or hashed query summaries; remove arbitrary-string fallback and only retain known command subcommands. Keep target grouping and useful names, no content redaction framework. Focused tests inspect every stored column with sentinel refusal/control cases; old stores remain readable, no touching/migrating shared live ledger. Owned live check one failed tool/query and inspect isolated ledger.

## Live evidence

None yet.

## Open findings for morning

None beyond #1 pending fix. Final sweep and all required gates remain outstanding.
