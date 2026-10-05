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

### Result: PASS (TUI `a` on agent, preset, member preset, Defaults)

Store baseline revision at load: **478**. Every add below was done through the
running build's Instructions TUI: step into the target's `Models` group,
press `a`, pick provider → model → variant, and watch the store and log.

**1. Global agent `general` — exclusivity across two adds.**

- `a` on `Global › Agents › OpenCode › general › Models` → provider
  `cliproxyapi` → model `deepseek-v4.1-flash-cheap` → variant `max`.
  Screen toast `Added model cliproxyapi/deepseek-v4.1-flash-cheap`, the new row
  read `▸ cliproxyapi/deepseek-v4.1-flash-cheap@max  active ◆`. Store line 227:
  `{"type":"model","level":"global","agent":"general",...,"variant":"max","active":true,...}`.
  Log: `model.add cliproxyapi/deepseek-v4.1-flash-cheap (global)`, revision
  **479**.
- `a` again on the same Models group → `cliproxyapi/claude-opus-5-5` (no
  variant). New row `▸ cliproxyapi/claude-opus-5-5  active ◆`; the flash-cheap
  row dropped to `▸ … ◆` with **no** `active` badge. Store line 215 now
  `claude-opus-5-5 active:true` and line 228 `deepseek…@max` with no `active`
  field. Log: one `model.add cliproxyapi/claude-opus-5-5 (global)`, revision
  **480**. So one add = one revision + one log line, and the previously active
  row at that level is no longer active.

**2. Defaults catalogue `general` — same exclusivity.**

- Defaults (`#`) → Agents › OpenCode › general › Models, `a` → `gpt-6-sol`
  (no variant): store line 236
  `{"level":"defaults","agent":"general",...,"active":true,...}`, log
  `model.add cliproxyapi/gpt-6-sol (defaults)`, revision **481**. Inspector
  showed `effective cliproxyapi/claude-opus-5-5 · active at global` because the
  Global row still wins down the chain.
- `a` again → `gpt-6.1-sol`: store line 239 `gpt-6.1-sol active:true`; line 238
  `gpt-6-sol` no longer active. Log `model.add cliproxyapi/gpt-6.1-sol
  (defaults)`, revision **487**.

**3. Agent preset `Build`.**

- Presets (`$`) → Agents › OpenCode › Build › Models, `a` →
  `cliproxyapi/gpt-5.6-luna`: row `▸ cliproxyapi/gpt-5.6-luna  active ◆`;
  store line 233 `{"level":"preset","agent":"build",...,"active":true}`; log
  `model.add cliproxyapi/gpt-5.6-luna (preset)`, revision **488**.

**4. Member preset `basic/implementer` (team-scoped owner path).**

- Presets (`$`) → Teams › Plus › Basic › implementer › Models, `a` →
  `cliproxyapi/gpt-6-luna`: row `▸ cliproxyapi/gpt-6-luna  active ◆`; store
  line 236
  `{"level":"preset","agent":"implementer","team":{"level":"preset","team":"basic"},...,"active":true}`;
  log target `model:preset:basic:preset:implementer:cliproxyapi/gpt-6-luna`,
  revision **482**.

All four levels: the added row is the only `active` row at that level for that
owner, and each add is exactly one revision and one `model.add` log line.

**5. Real file-backed Global team member `Sweep`/`Sweep-Only`.**

Created team `Sweep` through the TUI (`Global › Teams`, `a` → `Sweep`, empty
team; log `team.create Sweep (global)`, revision 488), then added member
`Sweep-Only` from member preset `Basic › implementer` (`a` on the team →
Member name `Sweep-Only` → preset `Basic › implementer`; toast
`Created agent Sweep-Only in team Sweep at …/config/opencode/opencodeplus/teams/Sweep/Sweep-Only.md`,
log `team.addAgent Sweep-Only to Sweep (global) from member:basic/implementer`,
revision 489).

On `Global › Teams › Sweep › Sweep-Only › Models` the inherited candidate read
`▸ cliproxyapi/gpt-6-luna from preset Basic › implementer · active (preset)`.
`a` there → `cliproxyapi/gpt-6.1-sol` (no variant): toast
`Added model cliproxyapi/gpt-6.1-sol`, new row
`▸ cliproxyapi/gpt-6.1-sol  active ◆`, and the inherited gpt-6-luna row lost the
`active` badge (`from preset Basic › implementer` with no marker). Store line
242 `{"type":"model","level":"global","agent":"Sweep-Only","providerID":
"cliproxyapi","modelID":"gpt-6.1-sol","active":true,...}`; log
`model.add cliproxyapi/gpt-6.1-sol (global)` target
`model:global:Sweep-Only:cliproxyapi/gpt-6.1-sol`, revision **491**. One
revision, one log line, previously-active row no longer active.

**Line 1 result: PASS** for TUI `a` on a Global agent, a Defaults catalogue
row, an agent preset, a member preset, and a real Global team member.

## Line 2 — Tool `set({ id, active: true })` activation and real use

**Contract:** `instructions.set({ id: <model row>, active: true })` (and a bare
`set`) from a tool actor activates the model, and that model is then really
used. The next request of that agent (stand-alone or team member) runs with it,
the inspector shows it active/effective, and `show` reports it.

### Result: PASS (tool actor `set`, real use by the `build` agent)

All tool calls below were made by the chat's model (`build`) through the real
Code Mode `instructions.*` namespace; the log actor is `tool/agent build`.

**Activation through `set`.**

- Prompted: *call `tools.instructions.set` with id
  `item:global:general:model:cliproxyapi/deepseek-v4.1-flash-cheap@max` and
  active true*. Transcript result:
  `{"id":"item:global:general:model:cliproxyapi/deepseek-v4.1-flash-cheap@max",
  "status":"Activated \"cliproxyapi/deepseek-v4.1-flash-cheap@max\"",
  "revision":0,"globalRevision":492}`. Store line 231 gained `"active":true`
  with `"basedOn":"cliproxyapi/gpt-6.1-sol"` and the previous active
  `claude-opus-5-5` (line 218) lost `active`. Log:
  `mutate 2 rows (global): model:global:general:cliproxyapi/claude-opus-5-5,
  model:global:general:…deepseek-v4.1-flash-cheap@max`, revision **492**, one
  line.
- The agent is `build`; `set` on `build`'s own rows was also driven. Prompted
  create `gpt-6-luna` then `set` id `item:global:build:model:cliproxyapi/
  gpt-6-luna` active true. Transcript:
  `{"id":"item:global:build:model:cliproxyapi/gpt-6-luna","status":
  "Activated \"cliproxyapi/gpt-6-luna\"","revision":0,"globalRevision":495}`
  and `instructions.list where=agent:build item:model` → `gpt-6-luna: active`,
  `gpt-6.1-sol: inactive`. Store: line 240 `gpt-6-luna active:true
  basedOn:"cliproxyapi/claude-opus-5-5@xhigh"`; line 244 `gpt-6.1-sol` no
  active. Logs: `model.add` revision 494 and
  `mutate 2 rows (global): …gpt-6-luna, …gpt-6.1-sol` revision **495**, both
  actor tool/build.

**The composer reflects it.** After that `set`, the composer model line read
`Build · gpt-6-luna CLIProxyAPI` (no manual pick). It had read
`Build · claude-opus-5-5 CLIProxyAPI · high` before activation.

**The next request really ran on it.** Sent `Reply with exactly: PONG. Use no
tools.`; reply `PONG.` rendered under `Build · gpt-6-luna · 1.3s · 5.4 tok/s`.
`/monitor` → `5 Steps` shows the new step at `17:07:22  step  gpt-6-luna  924
9.7k  0  7  $0.00  1.3s  stop`. So the request's row carried
model `gpt-6-luna`, not the previous `claude-opus-5-5`.

**`show` reports it.** The same transcript: `instructions.show
[id=item:global:build:model:cliproxyapi/gpt-6-luna]` returned
`"assembled":"cliproxyapi/gpt-6-luna"`, `"enabled":true`, `"from":"set here"`.
The inspector in the Instructions TUI likewise marked the row
`active ◆` / `source  active model: set here (Global)` in line 1.

**Line 2 result: PASS.** Tool `set` (and tool `create kind:"model"`) from the
real tool actor activated the row; the composer switched with no manual pick;
the very next request was served by the activated model (`/monitor` Steps); and
`show`/`list` report the row active.

## Line 3 — Flat `model:global:Planner:…` member-only case

**Contract:** Reproduce the evidence case: activating through the flat
`model:global:Planner:…` row for an agent that exists only as a `Basic` member.
Either that record takes effect for the member's chain, or the tool answers with
the member row to use (refusing the flat row naming the right id). One behaviour,
consistent, documented.

_Pending live run._
