# A5 live acceptance — instructions.changed workaround removal (T114)

Live acceptance for r3-a5-live-1. Question: does the composer still need the
`instructions.changed` workaround in `packages/plus/src/tui/active-team.tsx`, or
does an Instructions model activation already reach the composer (and the next
request) without it? Sanitized evidence only: no credentials, no raw private
prompts.

## Build under test

- Worktree:
  `/home/bliss/OpenCodePlus/run/plus/data/opencodeplus/teams/worktrees/opencode/Flash-C-Worker/t11493ed-20261005-1513`
- Branch: `team/Flash-C-Worker/t11493ed-20261005-1513`
- Base/HEAD at test start: `e33f5c5fa6174ce9e3947db966bb5dc446e8ce47`
- Change under test: removed the `instructions.changed` listener (comment +
  subscription) from `packages/plus/src/tui/active-team.tsx` and its
  `unsubscribeInstructions()` call, and deleted the unit test that asserted it.
- Model at baseline composer: `cliproxyapi/claude-opus-5-5` (`claude-opus-5-5 CLIProxyAPI · high`).

## Owned test home

- Dev home (full path):
  `/home/bliss/OpenCodePlus/run/plus-dev/run-plus-data-opencodeplus-teams-worktrees-opencode-Flash-C-Worker-t11493ed-20261005-1513`
- Server log: `<home>/data/opencode/log/opencode-local.log`
- `project-two` (second folder): `<home>/project-two` (fresh `git init`).
- Two standalone servers share this one dev home; `a5-one` opens the home's
  scratch `project`, `a5-two` opens `project-two`.

## Focused checks at HEAD (before live)

- `packages/plus: bun test test/active-team.test.tsx` → **12 pass, 0 fail**.
- `packages/plus: bun run typecheck` → exit 0.

## Setup — two TUIs, agent `build`

- `pilotty spawn --name a5-one opencodeplus-dev .` → up, resized 160×48.
  Composer baseline: `Build · claude-opus-5-5 CLIProxyAPI · high`
  (agent `build` is already the default selection).
- `mkdir -p $DEV/project-two && git -C $DEV/project-two init -q`, then
  `pilotty spawn --name a5-two opencodeplus-dev . $DEV/project-two` → up,
  resized 160×48. Composer baseline:
  `Build · claude-opus-5-5 CLIProxyAPI · high`.
- Both composers therefore started on the same model, `claude-opus-5-5`.

## Step 1 — activate a model from Instructions in a5-one

`/instructions` → `Project › Agents › OpenCode › build` → `2 Models`. The model
list showed the active row `▸ cliproxyapi/claude-opus-5-5@high  from global · active (global)`.
I navigated Global (`@`) › `build` › Models and added
`cliproxyapi/deepseek-v4.1-flash-cheap` with the `a` → Model → provider
`cliproxyapi` → model `deepseek-v4.1-flash-cheap` → variant `(no variant)`
flow. The toast read `Added model cliproxyapi/deepseek-v4.1-flash-cheap` and
the row then read
`▸ cliproxyapi/deepseek-v4.1-flash-cheap  active ◆`
(Global level), i.e. the activation took effect in the store.

Time the change was committed (after the add-model dialog): `1791206594612`.

## Step 2 — do both composers follow within 2 s?

Snapshots taken at `1791206601016` / `1791206601032` (~5.5 s after commit) and
again repeatedly up to `1791206658123`:

- a5-one: `Build · claude-opus-5-5 CLIProxyAPI · high` — **unchanged** (still
  the pre-activation model), stable for >30 s.
- a5-two: `Build · deepseek-v4.1-flash-cheap CLIProxyAPI` — **changed** to the
  activated model within 2 s.

So the activation reached the *other* TUI (a5-two, which learned it through its
own server's refresh) but not the TUI that made the change (a5-one) — the
composer that performed the activation keeps its stale remembered model. This
is exactly the failure the removed workaround covered.

(Continuing steps 3–4 to characterize the full behavior before deciding.)

## Step 3 — the next request in a5-two runs on the activated model

Sent `Reply with exactly OK` in a5-two. It answered `OK`; composer line
`Build · deepseek-v4.1-flash-cheap · 2.6s · 0.8 tok/s`.

`/monitor` → `5 Steps` showed:

```
  Time      Kind      Agent/Model     In      Read    Write   Out     Reason  Cost    Time    Finish    Tools Called
  15:24:47  step      deepse...h-cheap8.5k    0       0       2       0       $0.00   2.5s    stop      —
```

The request ran on `deepseek-v4.1-flash-cheap`, the activated model. **Step 3
passes.**

## Step 4 — a later manual pick wins

In a5-one I picked `gemini-3.8-flash-high` by hand from the composer model
picker (`Ctrl+P` → `Switch model` → `gemini-3.8-flash-high` → variant
`Default`; the composer read `Build · gemini-3.8-flash-high CLIProxyAPI`) and
sent `Reply with exactly OK picked`. It answered `OK picked`; composer line
`Build · gemini-3.8-flash-high · 2.5s · 0.8 tok/s`. `/monitor` → `5 Steps`:

```
  Time      Kind      Agent/Model     In      Read    Write   Out     Reason  Cost    Time    Finish    Tools Called
  15:25:54  step      gemini...sh-high8.5k    0       0       2       0       $0.00   2.4s    stop      —
```

The request ran on the manually picked model, not the activated one. **Step 4
passes.**

## Step 2 reproduced on a clean restart

Both TUIs were killed and respawned (same shared home; both composers came up
on `deepseek-v4.1-flash-cheap`). In a5-one I again added/activated
`cliproxyapi/gemini-3.8-flash-high` at Global › `build` › Models; the toast read
`Added model cliproxyapi/gemini-3.8-flash-high`, the row read
`▎▸ cliproxyapi/gemini-3.8-flash-high  active ◆`, and the old active row lost
`active`. Commit time `1791206887356`; snapshots ~2 s later
(`1791206889365` / `1791206889368`):

- a5-one: `Build · deepseek-v4.1-flash-cheap CLIProxyAPI` — **unchanged**.
- a5-two: `Build · gemini-3.8-flash-high CLIProxyAPI` — **changed**.

Steps 3 and 4 repeated in this run pass as well: a5-two's next request row read
`gemini...sh-high` (15:28:20), and a5-one's manual `claude-opus-5-5` pick sent a
request row `claude-opus-5-5 8k 4.8k 0 6 … 1.8s stop` (15:29:03).

## Control — workaround restored, both composers follow

To prove the step-2 failure is caused by removing the listener (not by an
unrelated environment difference), I restored both code files to their base
state (`git show e33f5c5:…` over the two files; `git diff e33f5c5 -- …` is now
empty), respawned both TUIs, and repeated exactly the step-1/2 flow. Both
composers had come up on `gemini-3.8-flash-high`; in a5-one I activated
`cliproxyapi/claude-fable-5-1` (`Added model cliproxyapi/claude-fable-5-1`,
`▎▸ cliproxyapi/claude-fable-5-1  active ◆`). Commit time `1791207041013`;
snapshots at `1791207043025` / `1791207043031`:

- a5-one: `Build · claude-fable-5-1 CLIProxyAPI · xhigh`.
- a5-two: `Build · claude-fable-5-1 CLIProxyAPI · xhigh`.

With the `instructions.changed` listener present, **the acting composer updates
within 2 s**. Without it, the acting composer does not. This isolates the
removal as the cause.

## Conclusion — the workaround stays

Step 2 fails without the workaround: an Instructions model activation does not
reach the composer of the TUI that performed it, because the host's
`agent.updated` refresh does not invalidate that TUI's core agent list and the
composer keeps its stale remembered model. `a5-two` followed only because its
own server refresh reached it; the acting TUI `a5-one` did not. The control
confirms the listener is what closes that gap. Pass requires all four steps, so
the pass condition is not met.

Final state: `packages/plus/src/tui/active-team.tsx` and
`packages/plus/test/active-team.test.tsx` are **restored to their original
state**; only this evidence file is committed.

## Server log

`<home>/data/opencode/log/opencode-local.log` at cleanup: 314319 bytes,
**1156 INFO, 36 WARN, 1 ERROR**.

The single ERROR is my own harness mistake, not a product failure: my first
`pilotty spawn --name a5-two opencodeplus-dev . $DEV/project-two` ran before
`$DEV/project-two` existed, so the launcher passed two directories and the CLI
rejected the extra positional:

```
timestamp=2026-10-05T13:19:42.649Z level=ERROR run=714c037e message="cli process failed" cause="Cause([Fail(~effect/cli/CliError/ShowHelp: Help requested)])" args="[\"--standalone\",\"/home/…/project-two\",\"/home/…/project\"]" role=cli
```

I recreated `project-two` and the spawn then succeeded. Every other run was
clean.

All 36 WARN lines are `executor-controlled plugin source refused` for the
workspace-root and worktree `.opencode` sources (expected refusal control), no
other WARN:

```
timestamp=2026-10-05T13:19:29.244Z level=WARN run=4da966e5 message="executor-controlled plugin source refused" path=/home/bliss/OpenCodePlus/.opencode/opencode.json type=document http.span=104 role=server
timestamp=2026-10-05T13:19:29.244Z level=WARN run=4da966e5 message="executor-controlled plugin source refused" path=/home/bliss/OpenCodePlus/.opencode type=directory http.span=104 role=server
… (the same two paths, plus the worktree's
…/t11493ed-20261005-1513/.opencode/opencode.jsonc and …/.opencode, repeat on
each server start; 36 WARN total, all the same message) …
```

No `plus monitor hook failed`, no `generated hook failed`, no relay/provider
error.

## Cleanup

- Both owned pilotty sessions were killed with `pilotty kill -s a5-one` and
  `pilotty kill -s a5-two`; `pilotty list-sessions` then no longer contains
  `a5-one` or `a5-two` (only pre-existing sessions from other runs remain).
- Kernel scan: no live process has its cwd (`/proc/<pid>/cwd`) or an open fd
  (`/proc/<pid>/fd/*`) under this run's dev home
  `…/run-plus-dev/…-t11493ed-20261005-1513`.
- The shared service (port 40375) and `~/.config/opencodeplus` were never
  touched; configuration was changed only inside the owned `$DEV`.

