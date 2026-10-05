# plus-1.1.15 overnight log

## Resume here

- Branch/worktree: `plus-1.1.15_overnight`; initial HEAD `75a8d9e20f`.
- Read this log first after a break, then `plus-1.1.15-overnight.md`.
- Current phase: B1 merge/review. No task newly landed yet.
- Pending: B1, A1, A2, B2; A3/A6/B6 repairs; A4/A5/B3/B4; F.
- No merge into `plus-1.1.15`, push, release build/promotion, shared-service access, or live-config mutation.

## Decisions

- 2026-10-05: Follow the overnight plan's explicit five-child limit and order (it supersedes the older task plans' two-child limit). Only Flash-C-Worker codes/tests unless its provider is unavailable. I alone merge, review, land, and log.
- 2026-10-05: Start B1 first while independent A3 (T5 expectations), A6, and B6 test repairs run. Defer A3 RPC declarations until all four branch merges land.
- 2026-10-05: Log did not exist at start; created before implementation. Existing prepared branches are inputs, not worktrees to change.

## Progress and verification

### B1 — in progress

- Input branch: `team/Heavy-Implementer/t54a9ef-20261004-1204`.
- Must preserve pinned warming agent/model, `durable: false`, cache policy and private prompt; add generated kind/error, reconcile core tests and Plus index/API.
- Live acceptance pending: short warming, two messages, three pings, usage and stable warming status, cache read on next message.

### A3/A6/B6 — pending independent repairs

- A3: no Defaults echo for team members; preserve instructions_show refusal evidence on member run-scope rows.
- A6: inspect shell description and registration-count expectations before choosing test or code fix.
- B6: inspect warming test-harness failure; preserve `/tools`, extend `/monitor` checks after B2.

## Issues

### #1 — owner-segment model create leaves an unreachable record (open)

- Evidence supplied by overnight plan: `instructions.create({kind:"model",level:"global",agent:"Simple/:Simple-Orchestrator"})` without `team` passes `group:global:Simple/:Simple-Orchestrator:models` owner check, writes literal owner-segment agent, then returns `create.failed`. No deletable tree row.
- Where: `packages/plus/src/tools.ts` model-create owner validation.
- Weight: wrong behavior / Instructions T3 owner identity boundary.
- Plan: refuse owner-segment `agent` with actionable `agent` + `team` instructions before any write; cover store revision/record refusal and valid member create in focused model/tool tests; live re-check in isolated dev home. Leave the existing live-store record untouched.
- Fix/verification: pending A2 reconciliation.

## Live evidence

None yet.

## Open findings for morning

None beyond #1 pending fix. Final sweep and all required gates remain outstanding.
