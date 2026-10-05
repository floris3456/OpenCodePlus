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

Done: after creating `SweepCat` (L2) it appeared as the last tab in every owner list visited:

| Owner / level | Path shown | Tab row |
| --- | --- | --- |
| Project agent | `Project › Agents › OpenCode › build` | `Settings  Models  Compaction  Tools 78  Base  System  SweepCat` |
| Global agent | `Global › Agents › OpenCode › build` | `… Base  System  SweepCat` |
| Global user agent | `Global › Agents › User › DeepSeek-Build` | `… Base  System  SweepCat` |
| Presets agent | `Presets › Agents › OpenCode › Build` | `… Base  System  SweepCat` |
| Defaults agent inventory | `Defaults › Agents` (`Every agent`) | `Settings  Models  Compaction  Tools 0  Base  System  MCP  SweepCat` |
| Defaults member inventory | `Defaults › Teams` (`Every member`) | `… System  MCP  SweepCat` |
| Presets team member | `Presets › Teams › Plus › Basic › scout` | `… Base  System  SweepCat` |

Representative quote (Defaults › Agents › Every agent list):

```
Settings  Models  Compaction  Tools 0  Base  System  MCP  SweepCat
```

The tab always renders last, after the built-ins (and after `MCP` where the inventory has it).
PASS.

## L4 — `[ ]` cycles through user categories; number keys reach them

Done: on `Defaults › Agents` (`Every agent`) the `]`/`[` keys and digit keys were exercised. The
breadcrumb (line 2 of the screen) walked, starting at `SweepCat`:

```
] : Defaults › Agents › Settings › Enabled
] : Defaults › Agents › Models
8 : Defaults › Agents › SweepCat
7 : Defaults › Agents › MCP › search
1 : Defaults › Agents › Settings › Enabled
[ : Defaults › Agents › SweepCat
```

So `]` moves forward through the tab list (wrapping from the last user category to `Settings`),
`[` moves back (wrapping from `Settings` to the user category), and the digit key `8` selects
`SweepCat` directly (the tab is 8th). PASS.
Both footer hint and `?` help say `[ ]  1-8  previous / next category, or jump to one` and
`m  move a row (with its children) into one of your categories, or back home`.

### L4 layout at 80 columns

Resized to 80×48 and repeated: the tab strip is clipped by the list width but the user tab is
still reachable and the breadcrumb same:

```
] : Defaults › Agents › Settings › Enabled
8 : Defaults › Agents › SweepCat
```

quote of the 80-col screen (Defaults › Agents › SweepCat):

```
▾ Agents                     │ Every agent                                │ SweepCat                                     group
```

PASS.

## L5 — `m` moves an item row into a category through a picker

Done on the tool row `Global › Agents › OpenCode › build › Tools › OpenCode › edit`. With the
cursor on `edit` (footer included `m move`), `m` opened:

```
   ▸ ● read            Move "edit"                                      esc
   ▸ ● shell           [P]ick a category
   ▸ ● skill           Back to Tools (home)
   ▸ ● subagent        SweepCat
```

So the picker lists the user categories and `Back to <home category> (home)`. `Enter` on
`SweepCat` wrote the assignment (L11 for the store line). PASS for the tool row.

All eight row kinds in one line were moved into `SweepCat` from the Defaults inventory
(`Defaults › Agents` `Every agent`, and the agent subtree for the per-agent ones). Each `m`
opened the same picker shape `Move "<label>"` / `[P]ick a category` / `Back to <home category>
(home)` / `SweepCat`:

| Row kind | Row cursor was on | Home choice shown | Moved item id |
| --- | --- | --- | --- |
| tool | `… › Tools › OpenCode › edit` | `Back to Tools (home)` | `tool:edit` |
| setting | `… › Settings › Mode` | `Back to Settings (home)` | `setting:mode` |
| base template | `… › Base › Claude.txt` | `Back to Base (home)` | `base:claude` |
| system instruction | `… › System › Role/persona` | `Back to System (home)` | `system:role` |
| MCP server | `Defaults › Agents › MCP › search` | `Back to MCP (home)` | `mcp:search` |
| model candidate | `… › Models › cliproxyapi/claude-opus-5-5@high` | `Back to Models (home)` | `model:cliproxyapi/claude-opus-5-5@high` |
| rule row | `… › Tools › OpenCode › shell › Permissions › Working directories › Outside this checkout` | `Back to Tools (home)` | `perm:shell:directories.outside` |
| skill | `… › Tools › OpenCode › skill › Permissions › Skills › OpenCode › OpenCode` | `Back to Tools (home)` | `skill:opencode` |

Every `Enter` on `SweepCat` appended the id to the one global category record (L11). PASS: `m`
works on all eight row kinds and the picker offers the category plus the row's home.

## L6 — moved row (with children) lists under that category in every owner list

Done. After the eight moves, `Defaults › Agents › OpenCode › build › SweepCat` lists all of them
(the 7 that are agent rows; `mcp:search` is an inventory-only row and lists under the inventory's
`SweepCat` tab):

```
▾ SweepCat                          contains  7 rows · 6 on · 0 off
    Mode                                                           Primary
  ▾ ● edit
      ● Description
    ▸ Permissions
      ● Outside this checkout
    ▸ ● OpenCode
    ▸ ● Claude.txt                                            active
    ▸ ● Role/persona
  ▾ ● Tools and rules
      ● Code search
      ● Documentation search
      … (Pushing etc.)
```

Home subtraction is visible too: the agent `Tools` tab lost `edit` (14 → 13 OpenCode tools) and
the tool's `Permissions › Working directories` lost `Outside this checkout`, while `Base` no
longer shows `Claude.txt` and `System` no longer shows `Role/persona`; `Models` lost the
`@high` candidate and the inventory `MCP` list lost `search` (the tab count changed at the
Defaults inventory). A moved row is dropped with its whole subtree from home and re-listed at
the category, in every owner list where it appears (Project, Global, Defaults, Presets verified
for the agent rows). PASS.

## L7 — categories display only; inspector shows `category: <name> (home: <category>)`

Done: the inspector for `SweepCat › Role/persona` showed:

```
state       on · always live (exclude sections instead)
source      default (nothing overrides it)
address     Defaults · build · catalogue: agents · system:role
category    SweepCat (home: System)
```

So the row is still the same `system:role` row (same state, source, address) with the display
annotation added. Every moved row keeps its own actions: `edit` still toggles with `space`,
`Mode` still cycles, the rule still shows its patterns, and none of the moves touched a
record's value — the only writes were the category record itself. Inheritance/enforcement
unchanged (the move only edits the category record's `items`). PASS.

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
