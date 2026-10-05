# Instructions T7 part B — final live sweep (sweep-i-t7b)

Live sweep of Instructions T7 part B in this worktree's own build:
model-row Space/`r`/`d` keys and badges, no whole-row editor, and the
instructions tools' `set` on field rows.

## Build and home

- Worktree: `/home/bliss/OpenCodePlus/run/plus/data/opencodeplus/teams/worktrees/opencode/Flash-C-Worker/t1280af3-20261005-1704`
- Start commit (HEAD at test start): to be filled.
- Launched exactly: `pilotty spawn --name sweep-i-t7b opencodeplus-dev .` from the
  worktree root, then `pilotty resize -s sweep-i-t7b 160 48`.
- Dev home: `/home/bliss/OpenCodePlus/run/plus-dev/run-plus-data-opencodeplus-teams-worktrees-opencode-Flash-C-Worker-t1280af3-20261005-1704`
- Server log: `<dev-home>/data/opencode/log/opencode-local.log`
- The store under test is the dev home's owned
  `<dev-home>/config/opencode/opencodeplus/instructions/records.jsonl`.
- No shared service (40375), no `bun run dev:live`, no `bun run dev`, no
  `~/.config/opencodeplus`, no source file changed (evidence file only).

## Steps

### Step 1 — model-row badges (PASS)

Keys: `/instructions` Enter (`Project › Agents › OpenCode › build`), then `@`
(`Global › Agents › OpenCode › build`). Cursor was on `build`. `→` focused the
middle pane (Settings), then `2` (Models). The header read
`Global › Agents › OpenCode › build › Models › cliproxyapi/claude-opus-5-5@high`
and the middle pane showed the two model rows:

```
▸ cliproxyapi/claude-opus-5-5@high                                active ◆
 ▸ cliproxyapi/claude-opus-5-5@xhighfrom default build...arm 30m · every 4m
```

The active row carries the `active` badge and the `◆` marker; the inherited row
carries the `from default build` note and a `warm 30m · every 4m` badge. The
footer of this pane lists `↑↓ move   enter open fields   ←→ open   space toggle
a add   m move   d delete   r reset   [ ] category   tab sidebar   / filter
? help   esc sidebar`.

**PASS** — the model rows keep their `active`/`◆` and `warm …` badges.

### Step 2 — Space activates exclusively (PASS)

State before: the owned store's `build` model records were
`…claude-opus-5-5 variant high active` (line 215) and no `build` deepseek row.

Pressed `a` → chose `Model` → `Model provider` (`cliproxyapi`, `lithosai`,
`opencode`) → `Model` → `deepseek-v4.1-flash-cheap` → `Variant` →
`(no variant)`. Adding made it the active one; the pane showed:

```
▸ cliproxyapi/claude-opus-5-5@high                                       ◆
▸ cliproxyapi/claude-opus-5-5@xhighfrom default build...arm 30m · every 4m
▸ cliproxyapi/deepseek-v4.1-flash-cheap                           active ◆
```

and the store gained exactly (one activation, exclusive):

```
{"type":"model","level":"global","agent":"build","providerID":"cliproxyapi","modelID":"deepseek-v4.1-flash-cheap","active":true,"updated":"2026-10-05T15:07:10.645Z"}
```

while the opus record lost `active:true`:

```
{"type":"model","level":"global","agent":"build","providerID":"cliproxyapi","modelID":"claude-opus-5-5","variant":"high","basedOn":"cliproxyapi/claude-opus-5-5@xhigh","updated":"2026-09-29T10:13:12.020Z"}
```

Then Space on `cliproxyapi/claude-opus-5-5@high` (cursor `↑` back to it). The
pane then showed opus as the only active row at Global for build and deepseek
without `active`:

```
▌▸ cliproxyapi/claude-opus-5-5@high                                active ◆
 ▸ cliproxyapi/claude-opus-5-5@xhighfrom default build...arm 30m · every 4m
▎▸ cliproxyapi/deepseek-v4.1-flash-cheap                                  ◆
```

Store after (two `build` model rows, exactly one `active`):

```
{"type":"model","level":"global","agent":"build","providerID":"cliproxyapi","modelID":"claude-opus-5-5","variant":"high","active":true,"basedOn":"cliproxyapi/claude-opus-5-5@xhigh","updated":"2026-09-29T10:13:12.020Z"}
{"type":"model","level":"global","agent":"build","providerID":"cliproxyapi","modelID":"deepseek-v4.1-flash-cheap","updated":"2026-10-05T15:07:10.645Z"}
```

The deepseek row dropped `"active":true`; the opus row got `"active":true`
(`◆` marker alone remains on the inactive deepseek row).

**PASS** — Space activates exclusively at this level; adding a model already
activates it.

### Step 3 — `r` clears the active flag; Space restores (PASS)

Store before: `{"version":2,"revision":480}` and the `build` opus row
`…claude-opus-5-5 variant high active:true …`.

Pressed `r` on the active `cliproxyapi/claude-opus-5-5@high` row. The row lost
`active` (the `◆` marker remained) and the inspector changed `source` from
`active model: set here (Global)` to `candidate: set here (Global)`, `from` to
`Global`:

```
▌▸ cliproxyapi/claude-opus-5-5@high                                       ◆
 ▸ cliproxyapi...us-5-5@xhighfrom default build · a...· warm 30m · every 4m
▎▸ cliproxyapi/deepseek-v4.1-flash-cheap                                  ◆
```

Store after `r`: `{"version":2,"revision":481}` and

```
{"type":"model","level":"global","agent":"build","providerID":"cliproxyapi","modelID":"claude-opus-5-5","variant":"high","updated":"2026-09-29T10:13:12.020Z"}
```

(no `active`).

Then pressed Space on that row to restore. Store after: `revision 482` and

```
{"type":"model","level":"global","agent":"build","providerID":"cliproxyapi","modelID":"claude-opus-5-5","variant":"high","active":true,"basedOn":"cliproxyapi/claude-opus-5-5@xhigh","updated":"2026-09-29T10:13:12.020Z"}
```

The row again shows `active ◆`, deepseek unbadged.

**PASS** — `r` on the active model row clears the active flag at this level and
writes one revision; Space restores it.
