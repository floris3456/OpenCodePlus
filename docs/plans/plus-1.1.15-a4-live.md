# A4 (Instructions T7 speed): live measurement

Residual-run R4. Measure only: no source file was changed. The parent ran
this measurement itself after two worker runs (T115, T117) stalled. Neither
recorded a number.

## Build under test

- Worktree `plus-1.1.15_overnight` at `a9139659b2`. Its source is unchanged
  since `a531bc98b9`.
- Started exactly `pilotty spawn --name <name> opencodeplus-dev .` from the
  worktree root, then `pilotty resize -s <name> 160 48`. Each list was measured
  in a fresh PTY, which starts its own standalone server.
- Owned dev home: `run/plus-dev/worktrees-plus-1.1.15_overnight-opencode`. It
  was created by the first spawn, from the release config. Its log is
  `data/opencode/log/opencode-local.log`.
- No provider request was made.

## Method

- A timed open: `a=$(date +%s%3N)`, send one key, `pilotty wait-for` a model
  name, `b=$(date +%s%3N)`. Each wait answered `"found": true`. The reported
  value is `b - a` in ms.
- Before each timed key, a snapshot checked that the name was **not** on
  screen.
- The numbers include pilotty's key round trip and `wait-for` polling. They
  are upper bounds on the UI's own render time.
- **A trap that stalled both workers:** on the Instructions sidebar a group
  row (Plus, User, Teams, a collapsed Agents) keeps the list of the row
  selected before it. So a model name can be on screen without the list having
  been opened. On a fresh server, `↓` from `summary` onto `Plus` shows
  summary's settings, not the models. Waiting for a model name there times out
  (observed: 30010 ms timeout). That attempt is not a measurement.
- Targets (Instructions T7): under 1500 ms on the first open after a server
  start, under 300 ms on every repeat.

## Defaults › Models (PTY `r4-defaults`)

Keys: `/instructions` Enter, `#` (Defaults). The sidebar cursor was moved to
`User`; it still showed summary's settings, without the predicate. The first
open is `↓` onto `Models`. Each repeat starts on `Teams`, which shows the list
of `Every member` because the cursor came up from there: `↓ ↓` to `Every member`,
then `↑` to `Teams`, predicate absent. The timed key is `↑` onto `Models`.
Predicate: `muse-spark-1.3-contributor` (a row only that list shows).

| Open | a | b | ms |
|---|---|---|---|
| first after server start | 1791209963035 | 1791209963168 | **133** |
| repeat 1 | 1791210001627 | 1791210001758 | **131** |
| repeat 2 | 1791210004526 | 1791210004655 | **129** |
| repeat 3 | 1791210007432 | 1791210007563 | **131** |

Three earlier "repeats" (5, 4 and 10 ms) and three more (11, 6 and 4 ms) were
discarded. They started from `Teams` or `User` while those still showed the
models list, so the predicate was already on screen.

## Global › Agents › OpenCode › build › Models (PTY `r4-agent`, fresh server)

Keys: `/instructions` Enter, `@` (Global). The header reads
`Global › Agents › OpenCode › build`. `→` moves focus into the middle pane,
which shows Settings, predicate absent. The first open is `2` (Models). Each
repeat is `1` (Settings, predicate gone), then timed `2`. Predicate:
`claude-opus-5-5@xhigh` (the row `from default build`, shown only in that
list).

| Open | a | b | ms |
|---|---|---|---|
| first after server start | 1791210050276 | 1791210050290 | **14** |
| repeat 1 | 1791210051524 | 1791210051540 | **16** |
| repeat 2 | 1791210052788 | 1791210052804 | **16** |
| repeat 3 | 1791210054039 | 1791210054053 | **14** |

## Result

- Defaults › Models: first 133 ms (target < 1500), repeats 129–131 ms
  (target < 300). **Met.**
- build's Models: first 14 ms, repeats 14–16 ms. **Met.**
- The two lists differ by about 115 ms on every open, first or repeat. That
  matches a polling step in `wait-for` more than a render cost. Either way,
  both are inside the targets.
- These match T103's earlier unaccepted numbers in kind: Defaults first
  274–301 ms, repeats 140–153 ms; an agent's Models about 10 ms.
- Per the residual plan, A4 is done and #10 (no catalogue reads during
  navigation) moves to `plus-1.1.16-team-fixes.md` item 6.

## Server log

352 lines: 340 INFO, 12 WARN, **0 ERROR**. All 12 WARN lines are the expected
`executor-controlled plugin source refused`, for
`/home/bliss/OpenCodePlus/.opencode`, its `opencode.json`, and this worktree's
`.opencode` and `.opencode/opencode.jsonc`. They repeat at each of the two
server starts (14:17:42–44Z and 14:20:26–27Z).

## Cleanup

`pilotty kill` on `r4-defaults` and `r4-agent`. `pilotty list-sessions` then
lists neither. A `/proc` cwd/fd scan finds no process referencing the owned
dev home.
