# plus-1.1.15 — live sweep Instructions T8 (own categories)

Run: `sweep-i-t8` (Flash-C-Worker, task T133).
Worktree: `/home/bliss/OpenCodePlus/run/plus/data/opencodeplus/teams/worktrees/opencode/Flash-C-Worker/t13387b5-20261005-1749`.
Dev home: `/home/bliss/OpenCodePlus/run/plus-dev/run-plus-data-opencodeplus-teams-worktrees-opencode-Flash-C-Worker-t13387b5-20261005-1749`.
Dev log: `<dev-home>/data/opencode/log/opencode-local.log`.

Launched exactly `pilotty spawn --name sweep-i-t8 opencodeplus-dev .` from this worktree and
`pilotty resize -s sweep-i-t8 160 48`. No shared service (port 40375), no `bun run dev:live`,
no `bun run dev`, no `~/.config/opencodeplus`, no live configuration mutation outside `$DEV`.

Lines verified against the attached brief file `r6/i-t8.md`; results appended as each line
completes.

## L1 — categories are Settings · Models · Compaction · Tools · Base · System · MCP; add own

Done: `/instructions` Enter on the Project agent list showed the agent-level tab row
`1 Settings 2 Models 3 Compaction 4 Tools 78 5 Base 6 System` (no MCP at agent level). `#`
(Defaults → `Defaults › Agents › build`), `Home`, `Down` (Every agent), `→` opened the shared
inventory; its tab row is exactly:

```
Settings  Models  Compaction  Tools 0  Base  System  MCP
```

So the seven built-in categories are present, in order, for the Defaults inventories
(`Every agent`; `Down`/`→` reaches the same row for `Every member`). Agent-level subtrees show
the same tabs minus `MCP` — the inventory-only group. PASS for the built-in list.

The "add your own categories after them" half is verified in L2–L4.

## L2 — `a` on the list offers Category; asks for a name

Done: on the Defaults inventory list (`Every agent`, list pane focused), pressed `a`. The Add
dialog opened with title `Add` and prompt `[S]elect what to add` listing, in order:
`Agent`, `Base prompt`, `Skill`, `MCP server`, `Team`, `Model`, `Permission rule`, **`Category`**.
Selected `Category` (7×`Down`, `Enter`); the dialog switched to:

```
                     Category name                                        esc
                     Your own tab after the built-in categories; move rows
                     into it with m.
                     [M]ine
                     enter submit
```

Typed `SweepCat`, `Enter`. The tab row became
`Settings  Models  Compaction  Tools 0  Base  System  MCP  SweepCat`: the new tab is last.
Store header went `{"version":2,"revision":492}` (line count 255) →
`{"version":2,"revision":493}` (line count 256); the new record (line 2) is:

```
{"type":"category","level":"global","name":"SweepCat","order":0,"items":[],"updated":"2026-10-05T15:52:04.258Z"}
```

and `log.jsonl` gained:

```
{"ts":"2026-10-05T15:52:04.258Z","actor":{"type":"tui"},"op":"category","target":"category:sweepcat","summary":"Created category \"SweepCat\"","revision":493}
```

PASS.

(Named decision: the prompt's placeholder is `[M]ine`, not empty; `Enter` submits the typed name.)

## L3 — new category tab appears for every owner at every level

Pending.

## L4 — `[ ]` cycles through user categories; number keys reach them

Pending.

## L5 — `m` moves an item row into a category through a picker

Pending.

## L6 — moved row (with children) lists under that category in every owner list

Pending.

## L7 — categories display only; inspector shows `category: <name> (home: <category>)`

Pending.

## L8 — `R` renames a user category

Pending.

## L9 — `d` deletes after confirmation; its rows go home; empty category text

Pending.

## L10 — filter `category:<name>`

Pending.

## L11 — category records stored once globally, revisioned and logged, all projects share

Pending.

## L12 — tools: create / set / delete / list where category

Pending.

## L13 — documented in `teaching.ts` and the skill text

Pending.

## Server log

Pending.

## Cleanup

Pending.

## Result per line

| Line | Result |
| --- | --- |
| L1 | Pending |
| L2 | Pending |
| L3 | Pending |
| L4 | Pending |
| L5 | Pending |
| L6 | Pending |
| L7 | Pending |
| L8 | Pending |
| L9 | Pending |
| L10 | Pending |
| L11 | Pending |
| L12 | Pending |
| L13 | Pending |
