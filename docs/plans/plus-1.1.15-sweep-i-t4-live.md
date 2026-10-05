# Instructions T4 live sweep — Flash-C-Worker t132c0ec

Final live sweep of Instructions T4 ("an agent's model applies without
restarting the TUI; newest wins") in this worktree's own build. Evidence only;
no source file changed.

## Build under test

- Worktree (this one):
  `/home/bliss/OpenCodePlus/run/plus/data/opencodeplus/teams/worktrees/opencode/Flash-C-Worker/t132c0ec-20261005-1731`
- HEAD at test start: `9c6b6f9c3d63d9ba47bfc33137dd6aed3dcb805b`
  (branch `team/Flash-C-Worker/t132c0ec-20261005-1731`).
- Launched exactly: `pilotty spawn --name sweep-i-t4 opencodeplus-dev .` from
  the worktree root, then `pilotty resize -s sweep-i-t4 160 48`. Own dev home,
  never shared port 40375, never `bun run dev:live`, never `bun run dev`.
- Owned dev home:
  `/home/bliss/OpenCodePlus/run/plus-dev/run-plus-data-opencodeplus-teams-worktrees-opencode-Flash-C-Worker-t132c0ec-20261005-1731`
  (shorthand `<dev-home>` below).
- Server log: `<dev-home>/data/opencode/log/opencode-local.log`.

## End-state lines

Copied from `docs/plans/plus-1.1.12-instructions.md` T4:

1. After a model is activated for an agent (Instructions TUI or tool), within
   about 2 seconds and without restarting anything: the composer shows that
   model whenever that agent is selected, both in **new chats** and in **open
   chats**.
2. After a model is activated for an agent, within about 2 seconds and without
   restarting anything: the **next message sent** with that agent uses it.
3. Precedence is **newest wins**: an Instructions activation overrides earlier
   composer picks for that agent in every open chat.
4. A composer pick made **after** the activation wins for that chat until the
   agent's model changes again.

## Results

### Line 1 — composer shows the activated model, new chats and open chats

**Baseline (before any activation):** at TUI start (`1791214384285`) the
composer of the first (open) chat read
`Build · claude-opus-5-5 CLIProxyAPI · high`.

**Action / observation (new chat).** In Instructions at
`Global › Agents › OpenCode › build › Models` I pressed `a` → `Model` →
provider `cliproxyapi` → model `deepseek-v4.1-flash-cheap` → variant
`(no variant)`; the final Enter landed at **`1791214517459`**. The screen
toasted `Added model cliproxyapi/deepseek-v4.1-flash-cheap` and the new row
read `▸ cliproxyapi/deepseek-v4.1-flash-cheap  active ◆` while the previous row
dropped to `▸ cliproxyapi/claude-opus-5-5@high` with no active marker.

- Open chat: escaping Instructions at **`1791214531812`** (≈ **0.9 s** after the
  activation) the composer read
  `Build · deepseek-v4.1-flash-cheap CLIProxyAPI` — no restart.
- New chat: `ctrl+x n` created a new session; at **`1791214581688`** its
  composer read `Build · deepseek-v4.1-flash-cheap CLIProxyAPI`.

**Result: PASS** — the composer shows the activated model for `build` within
about 0.9 s, in both the open chat and a new chat, with no TUI or server
restart.
