# A1 (T6 rename) live acceptance — Flash-C-Worker t86bee9

Fresh isolated live acceptance replacing stopped T81. Sanitized evidence only:
no credentials, no raw private prompts.

## Build under test

- HEAD: `254fcbcccc6231bda5469d66907d399269670470` (branch
  `team/Flash-C-Worker/t86bee9-20261005-0258`).
- Launched exactly: `pilotty spawn --name overnight-a1-live-retry opencodeplus-dev .`
  from this worktree; own dev home, never shared port 40375, never `bun dev`.
- Dev home: `run/plus-dev/run-plus-data-...-t86bee9-.../`.
- Model: `cliproxyapi/deepseek-v4.1-flash-cheap` where a model call is needed.
- Source log actually opened by the server: `data/opencode/log/opencode-local.log`
  (kernel fd proof recorded below); the plan's `opencode.log` is the
  non-local/released channel name.

## Status

- [x] Build started, home initialized.
- [ ] Setup rows created.
- [ ] R prefill + validation + rename + selection.
- [ ] Files/records follow; history unchanged.
- [ ] Palette `plus.agent.rename`.
- [ ] Tool `instructions.set({id,rename})` for agent/member/team.
- [ ] Refusals: built-in, Special, shipped Defaults team/member, ancestor, protected.
- [ ] Cleanup with kernel proof.

## Evidence log

### 2026-10-05 02:59–03:14 — build, home, setup

- Spawned: `pilotty spawn --name overnight-a1-live-retry opencodeplus-dev .`
  from this worktree. PTY session id `d245882b-751e-4de4-901d-981624cffea4`.
- Own dev home (verified from `/proc/<server>/environ`, which the plan says to
  trust over any registration file):
  - `XDG_CONFIG_HOME=…/t86bee9-…/config`, `XDG_DATA_HOME=…/data`,
    `XDG_STATE_HOME=…/state`, `XDG_CACHE_HOME=…/cache`.
  - `OPENCODE_TUI_CHANNEL=plus`.
  - Server cmdline `…/packages/cli/src/index.ts serve --stdio --port 0`
    (private stdio server; not the shared 40375 service).
- Kernel fd proof the actual log is `opencode-local.log` (not the plan's
  `opencode.log`): `readlink /proc/2702207/fd/9` →
  `…/data/opencode/log/opencode-local.log`; fd 11–13 → `opencode-local.db*`.
- Terminal resized 160×48 for wide passes (also will do 80×24).
- Unit baseline at this HEAD: `bun test test/rename.test.ts` from `packages/plus`
  → **6 pass / 0 fail, 47 expect() calls** (the known ancestor failure is
  fixed at this HEAD; ancestor refusal message is "inherited from an ancestor
  directory and cannot be renamed").
- Created a Project user agent through the real UI create flow (a → name
  `ren-a1` → preset `Build`), then renamed it with `R`:
  - Prompt prefilled exactly the row's current id (`Rename ren-a1` … value
    `ren-a1`).
  - Renamed to `new-a1` through the same dialog → tree selected the renamed row
    `new-a1` and the header followed `Project › Agents › User › new-a1`.
  - On disk: `project/.opencode/agent/ren-a1.md` gone,
    `project/.opencode/agent/new-a1.md` present; the link record followed to
    `agent:"new-a1"`; `log.jsonl` holds `agent.create ren-a1` then
    `agent.rename ren-a1 to new-a1 (project)` at revisions 1→2. Session
    history of those messages is separate (checked later).
- Seeded representative on-disk inputs in the owned home (no other home
  touched):
  - Global user agent `config/opencode/agents/g-a1.md`.
  - Global team `config/opencode/opencodeplus/teams/gcrew/` member `gm1.md`
    (note: global teams root is `<config>/opencodeplus/teams`, not
    `<config>/teams`).
  - Project team `project/.opencodeplus/teams/crew/` members `m1.md`, `m2.md`.
  - Representative records for agent `new-a1` (customization, split, model,
    rule, link), for member `m1` (customization, model, rule, link), plus a
    peer `m2` `perm:team_delegate:to.m1` row and a `team:project:crew` enable
    row, appended to the project `records.jsonl` (revision 2).
- Tree showed `Teams › crew` with members `m1`, `m2` after reload, and
  `state off` on the crew row (enablement is read from records; the seeded
  team record's enabled:true is a defaults/global/project-disk nuance to
  verify against the live enable flow).

### 2026-10-05 03:14–03:20 — R rename agent and member + selection

- **Project user agent rename via `R`** (tree list): prompt `Rename ren-a1`,
  prefilled `ren-a1`; renamed to `new-a1`. Tree header followed
  `Project › Agents › User › new-a1`; the selected row became `new-a1`.
- **Member rename via `R`** on `Project › Teams › crew › m1`:
  - Prompt `Rename m1`, prefilled `m1`. Invalid id `bad:name` refused in-dialog
    with toast `Invalid agent id "bad:name": colons are not allowed (colons
    separate the fields of instruction row ids)`; no file or record change
    (m1.md still present, records count unchanged, revision still 2).
  - Collision to `m2` refused: toast `Agent m2 already exists at
    …/project/.opencodeplus/teams/crew/m2.md`; no change.
  - Renamed `m1` → `m1x` (free id): tree header followed
    `Project › Teams › crew › m1x`, selected row `m1x`; on disk `m1.md` gone,
    `m1x.md` present; all member records moved to `agent:"m1x"`; peer
    `perm:team_delegate:to.m1` became `perm:team_delegate:to.m1x`; log
    `agent.rename m1 to m1x (project team crew)` revision 3.
- **Palette `plus.agent.rename`**: `ctrl+p` → `Rename agent` → agent picker
  listed file-backed agents (disabled/described), picked `g-a1`, prompt
  `Rename g-a1` prefilled `g-a1`; renamed to `g-a2`. Toast/close and on disk
  `config/opencode/agents/g-a1.md` → `g-a2.md`; log
  `agent.rename g-a1 to g-a2 (global)` revision 466. Same path as `R`.

### 2026-10-05 03:24–03:32 — Team rename via R

- **Team rename via `R`** on `Project › Teams › crew`:
  - Prompt `Rename crew`, prefilled `crew`.
  - Invalid name `bad/name` refused in-dialog:
    `Invalid team name "bad/name": team names are single path segments (no
    slashes)`; no change.
  - Renamed `crew` → `squad`: header followed `Project › Teams › squad`,
    selected row `squad`; team directory moved to `…/teams/squad`, member
    files `m1x.md`/`m2.md` inside; every team-scoped record's
    `team.team` moved `crew`→`squad`; enablement record followed; log
    `team.rename crew to squad (project)` revision 4.

### 2026-10-05 03:32–03:40 — Refusals through `R` (live)

- **Built-in OpenCode agent** (`Defaults › Agents › OpenCode › build`, also
  shown at Project): toast
  `Agent build is built in and cannot be renamed` (live screen, row `build`).
- **Special agent** (`… › Special › compaction`): toast
  `Agent compaction is built in and cannot be renamed`.
- **Ancestor-backed agent**: wrote `…/<dev-home>/.opencode/agent/legacy.md`
  (above the session's `project/`), reloaded the tree; row appeared under
  `Project › Agents › User › legacy` with `no tools`. `R` produced the
  full-screen toast (ANSI output captured):
  `Agent legacy is inherited from an ancestor directory and cannot be
  renamed`. No file or record change.

### 2026-10-05 03:40–03:56 — Tool `instructions.set({id,rename})` (live)

Session model switched to `cliproxyapi/deepseek-v4.1-flash-cheap`; agent
`New-B`. Each call ran in a real `execute` tool call and the model printed the
raw result.

- **Agent row**: `instructions.set({id:"agent:project:new-a1",rename:"new-b"})`
  →
  `{"id":"agent:project:new-b","to":"new-b","path":"…/project/.opencode/agent/new-b.md","status":"Renamed new-a1 to new-b"}`.
  On disk `new-b.md`; records (customization/split/model/rule/link) moved to
  `agent:"new-b"`; log actor `{type:"tool",agent:"build"}`
  `agent.rename new-a1 to new-b (project)` revision 5.
- **Member row**:
  `instructions.set({id:"team:project:squad:m1x",rename:"m1y"})` →
  `{"id":"team:project:squad:m1y","to":"m1y","path":"…/teams/squad/m1y.md","status":"Renamed member m1x to m1y"}`.
  Member records and the peer `perm:team_delegate:to.m1x` →
  `…to.m1y`; log `agent.rename m1x to m1y (project team squad)` revision 6.
- **Team row**:
  `instructions.set({id:"team:project:squad",rename:"squad2"})` →
  `{"id":"team:project:squad2","to":"squad2","path":"…/teams/squad2","status":"Renamed team squad to squad2"}`.
  Directory and every team-scoped record followed; log
  `team.rename squad to squad2 (project)` revision 7.
- **Built-in refusal via tool**:
  `instructions.set({id:"agent:project:build",rename:"builder"})` →
  `✗ instructions.set … ↳ agent.invalid: Agent build is built in and cannot
  be renamed`.
- Composer chip followed each rename (`M1x` → `New-B` agent selection) and the
  session-history transcript kept the old names in the already-sent user
  messages (messages are immutable; only the tree/composer changed).
- **Protected agent (tool actor)**:
  wrote `.opencodeplus/project.json` with `protectedAgents: ["new-b"]` in the
  owned project, reselected agent `New-B`, then
  `instructions.set({id:"agent:project:new-b",rename:"new-c"})` →
  `✗ instructions.set … ↳ agent.protected: row belongs to protected agent
  "new-b"`. No file/record change. (Removed the fixture after: see below.)
- **Shipped Defaults team row**: live this build has **no** shipped Defaults
  team row — the shipped teams are presets (`Basic`) and `Defaults › Teams`
  lists only `Every member`. `instructions.set({id:"team:defaults:basic",
  rename:"fleet"})` → `row.unknown: Unknown row "team:defaults:basic"`.
  The shipped-Defaults refusal (`… is shipped and cannot be renamed`) is
  therefore **unit-only** here, proved by
  `test/rename.test.ts` "instructions.set rename covers agent, member and team
  rows and refuses Defaults rows" with an injected `builtins:[{name:"ship"}]`
  registry. The live shipped team is a preset row:
  `instructions.set({id:"team:preset:basic",rename:"fleet"})` →
  `rename.invalid: "Basic" is a preset row and cannot be renamed`.
