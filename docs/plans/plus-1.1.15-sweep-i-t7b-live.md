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
