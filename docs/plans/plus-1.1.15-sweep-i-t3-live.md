# Instructions T3 — final live sweep (Flash-C-Worker)

Live verification of every end-state line of Instructions T3 ("a model you add
is active; tool activation works") against this worktree's own build. Source is
`docs/plans/plus-1.1.12-instructions.md` T3; the attached brief is
`tmp/r6/i-t3.md`.

Sanitized only: no credentials, no raw private prompts. No source file was
changed; this evidence file is the only edit.

## What is under test

- NET end states, each recorded below with steps, observed screen/log/test, and
  PASS / FAIL / NOT LIVE:
  1. Adding a model to any Models group makes it the only active row at that
     level for that owner, one store revision, one log line.
  2. `instructions.set({ id: <model row>, active: true })` (and a bare `set`)
     from a tool actor activates it, the model is really used by the next
     request, the inspector shows it active/effective, and `show` reports it.
  3. The flat `model:global:Planner:…` case for a member-only agent: either it
     takes effect for the member's chain or the tool refuses naming the member
     row — chosen behaviour must match `README.md` / `SPEC.md`.

## Build under test

- Worktree:
  `/home/bliss/OpenCodePlus/run/plus/data/opencodeplus/teams/worktrees/opencode/Flash-C-Worker/t1259a04-20261005-1624`
- HEAD: `012caf2267b27eae35dbe01800ededa75dd7e1ff` (branch
  `team/Flash-C-Worker/t1259a04-20261005-1624`).
- Launched exactly: `pilotty spawn --name sweep-i-t3 opencodeplus-dev .` from
  the worktree; own dev home, never port 40375, never `bun run dev`/`dev:live`.
- Owned dev home:
  `/home/bliss/OpenCodePlus/run/plus-dev/run-plus-data-opencodeplus-teams-worktrees-opencode-Flash-C-Worker-t1259a04-20261005-1624`
- Owned store: `<dev-home>/config/opencode/opencodeplus/instructions/records.jsonl`
  and `log.jsonl`.
- Owned server log: `<dev-home>/data/opencode/log/opencode-local.log`.
- Chat model: `cliproxyapi/deepseek-v4.1-flash-cheap`.

## Status

- [x] Build started, home initialized.
- [ ] Line 1 — TUI add for agent, member, preset, Defaults catalogue.
- [ ] Line 2 — tool `set` activation, next request really used, inspector,
      `show`.
- [ ] Line 3 — flat member-only row case.
- [ ] Focused tests / typecheck.
- [ ] Server log ERROR/WARN quoted.
- [ ] Cleanup and `pilotty list-sessions`.

## Evidence log

### 2026-10-05 16:26 — build started

`pilotty spawn --name sweep-i-t3 opencodeplus-dev .` created PTY session
`fd400ebe-9609-428f-8d98-5b97b65bac76`; the TUI came up on Build ·
claude-opus-5-5 CLIProxyAPI. Dev home created by the script, release config
copied into it. Baseline store revision at load: 478 (`records.jsonl` first
line); `log.jsonl` had 480 lines.

Focused baseline at this HEAD, from `packages/plus`:

- `bun test test/model.test.ts test/member-model-activation.test.ts` →
  **58 pass / 0 fail, 246 expect() calls** (includes
  `activateModel flips active within one (level, agent) pair only`,
  `re-adding a tombstoned candidate clears its tombstone and never steals
  active`, and
  `tool activation of a member-only agent's model row writes a flat record its
  member chain reads`).

## Line 1 — Add through the TUI makes it the only active row

**Contract:** Adding a model to any Models group (agent, member, preset,
Defaults catalogue rows; TUI `a`, RPC `model.add`, tool `create kind:"model"`)
makes it the active model at that level for that owner, exclusively. The
previously active row at that level is no longer active. One store revision, one
log line.

_Pending live run._

## Line 2 — Tool `set({ id, active: true })` activation and real use

**Contract:** `instructions.set({ id: <model row>, active: true })` (and a bare
`set`) from a tool actor activates the model, and that model is then really
used. The next request of that agent (stand-alone or team member) runs with it,
the inspector shows it active/effective, and `show` reports it.

_Pending live run._

## Line 3 — Flat `model:global:Planner:…` member-only case

**Contract:** Reproduce the evidence case: activating through the flat
`model:global:Planner:…` row for an agent that exists only as a `Basic` member.
Either that record takes effect for the member's chain, or the tool answers with
the member row to use (refusing the flat row naming the right id). One behaviour,
consistent, documented.

_Pending live run._
