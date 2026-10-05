# plus-1.1.15 — live sweep Instructions T7 part A

Run: `sweep-i-t7a` (Flash-C-Worker, task T127 `w-ac25abd5093619a5`).
Worktree: `/home/bliss/OpenCodePlus/run/plus/data/opencodeplus/teams/worktrees/opencode/Flash-C-Worker/t127ac25-20261005-1641`.
Dev home: `/home/bliss/OpenCodePlus/run/plus-dev/run-plus-data-opencodeplus-teams-worktrees-opencode-Flash-C-Worker-t127ac25-20261005-1641`.
Dev log: `<dev-home>/data/opencode/log/opencode-local.log`.

Launched exactly `pilotty spawn --name sweep-i-t7a opencodeplus-dev .` from this worktree and
`pilotty resize -s sweep-i-t7a 160 48`. No shared service (port 40375), no `bun run dev:live`,
no `bun run dev`, no live configuration mutation outside `$DEV`.

Scoped steps (from the attached brief file `r6/i-t7a.md`), followed in order; results are
appended as each step completes.

## Step 0 — setup

Done: spawned the TUI, resized to 160×48, killed it (to seed while the store was quiescent),
appended one old-style row to
`$DEV/config/opencode/opencodeplus/instructions/records.jsonl`:

```
{"type":"model","level":"global","agent":"plan","providerID":"cliproxyapi","modelID":"deepseek-v4.1-flash-cheap","variant":"high","updated":"2026-10-05T00:00:00.000Z"}
```

The file went from 245 to 246 lines; the appended row is the last line. Then spawned the TUI
again and resized to 160×48. Store header before this sweep: `{"version":2,"revision":478}`.

PASS.

## Step 1 — layout (field rows and sources)

_(pending)_

## Step 2 — pickers

_(pending)_

## Step 3 — edit one field

_(pending)_

## Step 4 — reset and repeat reset

_(pending)_

## Step 5 — old-style row repeat reset

_(pending)_
