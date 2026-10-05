# A1 (T6 rename) live acceptance — Flash-C-Worker t86bee9

Fresh isolated live acceptance replacing stopped T81. Sanitized evidence only:
no credentials, no raw private prompts.

## Build under test

- HEAD: `254fcbcccc6231bda5469d66907d399269670470` (branch
  `team/Flash-C-Worker/t86bee9-20261005-0258`).
- Launched exactly: `pilotty spawn --name overnight-a1-live-retry opencodeplus-dev .`
  from this worktree; own dev home, never shared port 40375, never `bun dev`.
- Owned dev home (full path):
  `/home/bliss/OpenCodePlus/run/plus-dev/run-plus-data-opencodeplus-teams-worktrees-opencode-Flash-C-Worker-t86bee9-20261005-0258`
- Actual log the server opens (full path):
  `/home/bliss/OpenCodePlus/run/plus-dev/run-plus-data-opencodeplus-teams-worktrees-opencode-Flash-C-Worker-t86bee9-20261005-0258/data/opencode/log/opencode-local.log`
  — proven by kernel fd below.
  `<dev-home>/data/opencode/opencode.log` does not exist; that name is the
  non-local/released channel.
- Owned SQLite (history check): `<dev-home>/data/opencode/opencode-local.db`.
- Model: `cliproxyapi/deepseek-v4.1-flash-cheap` where a model call is needed.

Path shorthand used below (both are exact absolute paths):

- `<dev-home>` =
  `/home/bliss/OpenCodePlus/run/plus-dev/run-plus-data-opencodeplus-teams-worktrees-opencode-Flash-C-Worker-t86bee9-20261005-0258`
- `<worktree>` =
  `/home/bliss/OpenCodePlus/run/plus/data/opencodeplus/teams/worktrees/opencode/Flash-C-Worker/t86bee9-20261005-0258`

## Status

- [x] Build started, home initialized.
- [x] Fixture rows created (explicitly marked below) and real UI/RPC rows
      created through supported paths.
- [x] R prefill + validation + rename + selection (Project and Global).
- [x] Files/records follow; history unchanged.
- [x] Palette `plus.agent.rename` (same path).
- [x] Tool `instructions.set({id,rename})` for agent/member/team.
- [x] Refusals live: built-in OpenCode, Special, ancestor-backed, protected
      tool actor, collision. Shipped Defaults team/member refusal is
      **unit-only** at this HEAD (see D1) because no Defaults team ships.
- [x] Cleanup with kernel proof (cwd/fd and final owned-PID absence).
- [x] `bun test test/rename.test.ts` 6 pass / 0 fail; `bun typecheck` in
      `packages/plus` passes.

## Fixtures vs real actions

Two kinds of setup appear below and are labelled:

- **Real action** — done through the running build: the TUI create/rename
  flows, the palette, or `instructions.*`/RPC calls executed by the model in a
  real `execute` tool call. These are the acceptance evidence.
- **Fixture** — a file or store record written directly into the owned home to
  put a representative record in place before a real rename. A fixture only
  seeds state; the rename that moves it is the observed action.

Fixture limitation found and classified: appending records to
`records.jsonl` out of band does **not** bump the store revision or emit a
store-change event, so the first snapshot after a seed can be stale. This is an
**invalid-fixture artifact, not a product issue**: the seeded crew enablement
(`enabled:true`) first read as `state off`, and became `state on` as soon as
the next real store write (the member rename) bumped the revision and
reloaded. Product writes always bump the revision and emit events; only my
direct append skipped that.

## Evidence log

### 2026-10-05 02:59–03:14 — build, home, setup (run `overnight-a1-live-retry`)

- Spawned `pilotty spawn --name overnight-a1-live-retry opencodeplus-dev .`
  from this worktree. PTY session id `d245882b-751e-4de4-901d-981624cffea4`.
- Terminal resized 160×48 for wide passes (also 80×24 later).
- Unit baseline at this HEAD: `bun test test/rename.test.ts` from
  `packages/plus` → **6 pass / 0 fail, 47 expect() calls**.
- **Real action** — created a Project user agent through the UI create flow
  (`a` → name `ren-a1` → preset `Build`), then renamed it with `R`:
  - Prompt prefilled exactly the row's current id (`Rename ren-a1`, value
    `ren-a1`).
  - Renamed to `new-a1`: tree selected `new-a1`, header followed
    `Project › Agents › User › new-a1`.
  - On disk `project/.opencode/agent/ren-a1.md` gone, `new-a1.md` present; the
    link record followed to `agent:"new-a1"`; log `agent.create ren-a1` then
    `agent.rename ren-a1 to new-a1 (project)` revisions 1→2.
- **Fixtures** (owned home only): Global user agent
  `config/opencode/agents/g-a1.md`; Global team
  `config/opencode/opencodeplus/teams/gcrew/` member `gm1.md`; Project team
  `project/.opencodeplus/teams/crew/` members `m1.md`, `m2.md`; representative
  records for agent `new-a1` (customization, split, model, rule, link), member
  `m1` (customization, model, rule, link), a peer `m2`
  `perm:team_delegate:to.m1` row, and a `team:project:crew` enable record.
  Global teams root is `<config>/opencodeplus/teams`, not `<config>/teams`.

### 2026-10-05 03:14–03:32 — R agent/member/team rename (run 1)

- **Real action, member rename via `R`** on `Project › Teams › crew › m1`:
  - Invalid id `bad:name` refused in-dialog:
    `Invalid agent id "bad:name": colons are not allowed (colons separate the
    fields of instruction row ids)`; no file or record change.
  - Collision to `m2` refused: `Agent m2 already exists at
    …/project/.opencodeplus/teams/crew/m2.md`; no change.
  - Renamed `m1` → `m1x`: header followed, selected row `m1x`; `m1.md` gone,
    `m1x.md` present; member records moved to `agent:"m1x"`; peer
    `perm:team_delegate:to.m1` became `…to.m1x`; log
    `agent.rename m1 to m1x (project team crew)` revision 3.
- **Real action, team rename via `R`** on `Project › Teams › crew`:
  - Invalid name `bad/name` refused: `Invalid team name "bad/name": team names
    are single path segments (no slashes)`; no change.
  - Renamed `crew` → `squad`: header followed; directory moved to
    `…/teams/squad`; every team-scoped record's `team.team` moved
    `crew`→`squad`; enablement followed; log
    `team.rename crew to squad (project)` revision 4.
- **Real action, palette `plus.agent.rename`**: `ctrl+p` → `Rename agent` →
  picker → `g-a1`; prompt `Rename g-a1` prefilled `g-a1`; renamed to `g-a2`.
  `config/opencode/agents/g-a1.md` → `g-a2.md`; log
  `agent.rename g-a1 to g-a2 (global)` revision 466. Same path as `R`.
- **Real action, refusals through `R`**:
  - Built-in `build` (shown at Project): `Agent build is built in and cannot
    be renamed`.
  - Special `compaction`: `Agent compaction is built in and cannot be
    renamed`.
  - Ancestor-backed fixture `<dev-home>/.opencode/agent/legacy.md` above the
    session's `project/`, shown at `Project › Agents › User › legacy`:
    `Agent legacy is inherited from an ancestor directory and cannot be
    renamed`. No file or record change.

### 2026-10-05 03:40–04:10 — tools, refusals, warming, history (run 1)

Composer model `cliproxyapi/deepseek-v4.1-flash-cheap`, agent `New-B`. Each is
a **real action** in a real `execute` tool call; the model printed the raw
result.

- **Agent**: `instructions.set({id:"agent:project:new-a1",rename:"new-b"})` →
  `{"id":"agent:project:new-b","to":"new-b","path":"<dev-home>/project/.opencode/agent/new-b.md","status":"Renamed new-a1 to new-b"}`.
  On disk `new-b.md`; records (customization/split/model/rule/link) moved to
  `agent:"new-b"`; log actor `{type:"tool",agent:"build"}`
  `agent.rename new-a1 to new-b (project)` revision 5.
- **Member**: `instructions.set({id:"team:project:squad:m1x",rename:"m1y"})` →
  `{"id":"team:project:squad:m1y","to":"m1y","path":"<dev-home>/project/.opencodeplus/teams/squad/m1y.md","status":"Renamed member m1x to m1y"}`.
  Member records and the peer `perm:team_delegate:to.m1x` → `…to.m1y`; log
  `agent.rename m1x to m1y (project team squad)` revision 6.
- **Team**: `instructions.set({id:"team:project:squad",rename:"squad2"})` →
  `{"id":"team:project:squad2","to":"squad2","path":"<dev-home>/project/.opencodeplus/teams/squad2","status":"Renamed team squad to squad2"}`.
  Directory and every team-scoped record followed; log
  `team.rename squad to squad2 (project)` revision 7.
- **Refusals via tools**:
  - Built-in `agent:project:build`:
    `agent.invalid: Agent build is built in and cannot be renamed`.
  - Special `agent:project:compaction`:
    `agent.invalid: Agent compaction is built in and cannot be renamed`.
    (The `Defaults` id `agent:defaults:compaction` is not a tree row:
    `rename.invalid: "compaction" is not a renamable row`.)
  - Ancestor-backed `agent:project:legacy`:
    `agent.invalid: Agent legacy is inherited from an ancestor directory and
    cannot be renamed`.
  - Protected agent (tool actor), after a **fixture**
    `.opencodeplus/project.json` with `protectedAgents:["new-b"]`:
    `agent.protected: row belongs to protected agent "new-b"`.
  - Shipped Defaults team id `team:defaults:basic`:
    `row.unknown: Unknown row "team:defaults:basic"` — no live Defaults team
    exists; the shipped `Basic` is a preset, and
    `team:preset:basic` → `rename.invalid: "Basic" is a preset row and cannot
    be renamed`.
- **Warming row follows (real action, fixture record)**: a **fixture**
  team-scoped warming model record for member `m1y`
  (`warming:"30 minutes", interval:"3.5 minutes", prompt:"keep-warm
  sentinel"`) then **real rename** `m1y` → `m1z`: the record's `agent` moved to
  `"m1z"` with warming/interval/prompt intact, `perm:team_delegate:to.m1y`
  moved to `…to.m1z`, file moved to `…/squad2/m1z.md`. Member Models showed
  `▎▸ cliproxyapi/deep…-v4.1-flash-cheapwarm 30 minutes …ery 3.5 minutes ◆`.
- **Session history keeps old names (real, read from owned SQLite)**:
  `session_message` rows sent while the row was `new-a1` still carry that
  text; rows after the rename carry `new-b`; assistant rows recorded before
  the rename keep `agent:"m1x"`. Nothing rewrites old messages.
- **Runtime log / relay error — open availability finding (not a T6 defect,
  not a harness dismissal).** The only `level=ERROR` in
  `<dev-home>/data/opencode/log/opencode-local.log` (final counts at the end
  of my runs: 1592 lines, 1 ERROR, 49 WARN, 1542 INFO; the WARNs are
  `executor-controlled plugin source refused`) is a genuine relay rejection.
  Sanitized facts from the owned projected state, not from raw config or
  prompts:
  - Owned monitor ledger `data/opencode/opencodeplus/monitor.db`, `request`
    rows: 37 `completed` and 1 `error`; the error row is
    `0d434120-52eb-4cb1-8e8b-a85a378c0fe6`: kind `step`, agent `new-b`,
    provider `cliproxyapi`, model `claude-fable-5-1`, variant `xhigh`, status
    `error`, `finish=error`, `started=1791165229421`,
    `ended=1791165229443` (22 ms), `error` =
    `{"type":"provider.invalid-request","status":400,"hash":"0dd35a2328c29e26","chars":43}`.
  - The same request has exactly one `request_fingerprint` row (protocol
    `openai-responses`, `body_hash=e2044e429a5004d3`), so a real wire request
    was built and sent.
  - Log line: `Failed to drain Session … AI.Error …` with inner
    `AI.Error.InvalidRequest: unknown provider for model claude-fable-5-1`
    (sanitized: no body/prompt copied). In `provider-error.ts` that inner
    type maps to `InvalidRequestError` because the relay answered HTTP 400;
    the `message` comes from the relay body.
  - `claude-fable-5-1` is a **release-provided** catalog model
    (`config/opencode/opencode.json` ships it under provider `cliproxyapi`
    with variants low/medium/high/xhigh/max), not a fixture I seeded. So the
    chooser offered a real, valid entry, the client built a valid request, and
    the CLIProxyAPI relay rejected it with HTTP 400 — an **operational
    provider/relay availability failure**, not a wrong host provider and not a
    T6 rename defect. Correcting the composer to
    `cliproxyapi/deepseek-v4.1-flash-cheap` then completed every subsequent
    request (ledger rows `completed`). Parent records this as an operational
    finding; it cannot be fixed from this worktree (provider config / shared
    relay). No further provider probes were run.

### 2026-10-05 04:10 — narrow (80×24) pass (run 1)

- `Project › Teams › squad2 › m1z`, `R` opened the prefilled prompt
  `Rename m1z` with `m1z`.
- Team row footer narrow reads `… space toggle   a add   l link   R rename
  d delete …`; the R hint is present at 80 columns.
- **Refusal captured narrow (followup run `overnight-a1-live-narrow`)**:
  at 80×24, `R` on `Project › Agents › OpenCode › explore` showed the toast
  `Agent explore is built in and cannot be renamed` in the narrow layout. So
  the refusal path is now observed at both 160×48 and 80×24.
- No layout break; Instructions is already a narrow two-page layout.

### 2026-10-05 04:18–04:22 — Global rename (run `overnight-a1-live-retry2`)

Same worktree, own dev home, second owned PTY. All **real actions**:

- `Global › Teams › gcrew` → `R`, prefilled `gcrew`, renamed `gcrew2`: header
  followed; directory moved to
  `<dev-home>/config/opencode/opencodeplus/teams/gcrew2`; log
  `team.rename gcrew to gcrew2 (global)` revision 466.
- `Global › Teams › gcrew2 › gm1` → `R`, prefilled `gm1`, renamed `gm1x`:
  header followed; `gm1x.md` present; log
  `agent.rename gm1 to gm1x (global team gcrew2)` revision 466.

### 2026-10-05 04:23–04:32 — remaining lines (run `overnight-a1-live-final`)

Same worktree, own dev home, third owned PTY. All renames are **real
actions**; records are labelled fixtures.

- **Enablement is real and readable live**: toggling `Project › Teams ›
  squad2` with Space wrote
  `team.setEnabled squad2 disabled (project)` and later `… enabled …`, changed
  the record's `enabled` and the inspector `state on/off`. (The earlier stale
  `state off` from the fixture is the invalid-fixture artifact described
  above.)
- **Collision on team rename**: renamed a fixture team `taken` to `squad2`
  while `squad2` existed → `Team squad2 already exists`; no change.
- **Member `split` record follows (real rename over a fixture split)**: a
  fixture `split` record for member `m1z`; team rename `squad2` → `squadx`
  moved its `team.team`; member rename `m1z` → `m1w` moved its `agent`; the
  member file moved too.
- **Global agent records follow**: a **fixture** set (customization, model,
  rule) for `g-a2`, then **real rename** `g-a2` → `g-a4`: all three records
  moved to `agent:"g-a4"`; `config/opencode/agents/g-a2.md` → `g-a4.md`; log
  `agent.rename g-a2 to g-a4 (global)` revision 469. A separate real rename
  `DeepSeek-Build` → `g-a3` also followed its records.
- **Global member records follow**: a **fixture** set (customization, model)
  for `gm1x`, then **real rename** `gm1x` → `gm1z`: both records moved to
  `agent:"gm1z"`; `gm1z.md` present; log
  `agent.rename gm1x to gm1z (global team gcrew2)` revision 473.
- **160×48** re-check of the Global team/member rows and the prefilled `R`
  prompt at the end of this run (wide layout intact).

## T6 end-state line checklist

| T6 line | Result |
| --- | --- |
| `R` prompts prefilled, validated like creation | live: Project + Global agent/member/team; palette — prefilled with current id; bad ids/collisions refused without writes |
| Renamable: Project/Global user agents | live: `ren-a1`→`new-a1` (project), `g-a1`→`g-a2`, `DeepSeek-Build`→`g-a3`, `g-a2`→`g-a4` (global) |
| Renamable: on-disk team members | live: `m1`→`m1x`→`m1y`→`m1z`→`m1w` (project), `gm1`→`gm1x`→`gm1z` (global) |
| Renamable: Project/Global teams | live: `crew`→`squad`→`squad2`→`squad3`→`squadx` (project), `gcrew`→`gcrew2` (global) |
| Collision: choose another free key, update help/hints | live refusals `Agent m2 already exists …` and `Team squad2 already exists`; no writes; `R rename` hint in wide and narrow footers |
| File/team directory follows | live: agent `.md` and team dir moved in every run |
| Customizations, splits, models, rules, links follow | live: agent set incl. agent `split`; member set incl. a live member `split` (real rename over a fixture split, run 3); global agent + global member sets. Unit proofs: `test/rename.test.ts` "rename an agent moves its file and records of every kind and keeps resolution" asserts `["customization","link","model","rule","split"]`; "rename a member moves its records and the Delegate-to rows that name it" asserts `["customization","link","model","rule"]` for the member |
| Warming rows follow | live: `m1y`→`m1z` kept warming/interval/prompt |
| `team_delegate` "Delegate to" rows follow | live: `to.m1`→`to.m1x`→`to.m1y`→`to.m1z`→`to.m1w` |
| Team-scoped records + team enablement follow | live: enablement record and every scoped row followed team renames; enable toggle is real |
| Tree selection follows | live after every rename (header + selected row) |
| Session history keeps the old name | live: owned SQLite `session_message` still holds old ids/agent |
| Refuse built-in OpenCode agents | live: R toast + tool `agent.invalid` |
| Refuse Special agents | live: R toast + tool `agent.invalid` |
| Refuse shipped Defaults teams | **unit-only** (no live Defaults team at this HEAD; see D1); live preset row refused `rename.invalid` |
| Refuse shipped Defaults members | **unit-only** (same; `team:defaults:ship:mate` in the test) |
| Refuse ancestor-backed agents | live: R toast + tool `agent.invalid` |
| Refuse protected agent for a tool actor | live: `agent.protected` |
| Palette `plus.agent.rename` same path | live: picker → prefill → rename → file/log |
| Tools `instructions.set({id,rename})` on agent/member/team | live for all three |
| Documented in `teaching.ts` | source read: `teaching.ts:79,138` documents the shape and refusals |

## Runtime cleanup

Owned processes were identified by kernel state (cwd under this worktree or
the owned dev home, and the private `serve --stdio --port 0` cmdline), never
by a registration file.

Kernel proof that the server opens `opencode-local.log` (run
`overnight-a1-live-final`, before exit), with exact paths:

- Launcher PID `2982254`:
  - cwd:
    `/home/bliss/OpenCodePlus/run/plus-dev/run-plus-data-opencodeplus-teams-worktrees-opencode-Flash-C-Worker-t86bee9-20261005-0258/project`
  - fd 9 →
    `/home/bliss/OpenCodePlus/run/plus-dev/run-plus-data-opencodeplus-teams-worktrees-opencode-Flash-C-Worker-t86bee9-20261005-0258/data/opencode/log/opencode-local.log`
- Private server PID `2982300`:
  - cwd:
    `/home/bliss/OpenCodePlus/run/plus/data/opencodeplus/teams/worktrees/opencode/Flash-C-Worker/t86bee9-20261005-0258/packages/cli`
  - fd 9 →
    `/home/bliss/OpenCodePlus/run/plus-dev/run-plus-data-opencodeplus-teams-worktrees-opencode-Flash-C-Worker-t86bee9-20261005-0258/data/opencode/log/opencode-local.log`
  - fd 11 →
    `/home/bliss/OpenCodePlus/run/plus-dev/run-plus-data-opencodeplus-teams-worktrees-opencode-Flash-C-Worker-t86bee9-20261005-0258/data/opencode/opencode-local.db`
  - fd 12 / 13 → the same path with `-wal` / `-shm`.
- Maps proof (run `overnight-a1-live-proof`, server PID `3041206`): the
  `/proc/3041206/maps` entries under the owned dev home are exactly the
  `opencode-local.db-shm` mapping; the loaded native libraries map from the
  owned worktree's `node_modules/.bun/…` paths. No shared-service path appears.

After exiting each run through the palette `exit`:

- Run 1 owned PIDs `2702055` (launcher), `2702207` (server), `2702254` and
  `2879171` (server search children) — all gone.
- Run 2 owned PIDs `2957618` and `2957664` — all gone.
- Run 3 owned PIDs `2982254` (launcher), `2982300` (server), `2982447` and
  `2982732` (search children) — all gone.
- Narrow followup PIDs `3033923` (launcher) and `3033960` (server) — gone.
- Proof run PIDs `3041131`, `3041146` (launcher) and `3041206` (server) — gone.
- `pilotty status` for each of the five sessions reports `exited`; none appears
  in `pilotty list-sessions`.
- No live process has its cwd under the owned dev home and no live process
  holds an fd whose target is under it (checked over every `/proc/<pid>/cwd`
  and `/proc/<pid>/fd/*`). This proof uses only owned cwd/fd/maps paths.

## Open issues / deferred

- **D1 — shipped Defaults team/member refusal is unit-only live.** No
  Defaults team ships at this HEAD (the shipped `Basic` is a preset, and the
  production plugin passes no builtins registry), so the exact
  `… is shipped and cannot be renamed` message was not observed live. Covered
  by `test/rename.test.ts` with an injected `builtins` registry. To observe it
  live would need a build that ships a Defaults team.
- **D2 — narrow refusal toast: closed.** A small owned followup run captured
  the built-in refusal at 80×24:
  `Agent explore is built in and cannot be renamed`. No deferral remains.
- **D3 — `cliproxyapi/claude-fable-5-1` relay rejection (open operational
  finding, parent logs it).** One `level=ERROR`; a genuine release-provided
  catalog model with a real wire request (owned ledger row
  `0d434120-52eb-4cb1-8e8b-a85a378c0fe6`, `provider.invalid-request` HTTP 400,
  hash `0dd35a2328c29e26`) was rejected by the CLIProxyAPI relay. Not a T6
  defect and not fixable from this worktree (provider config / shared relay).
  Correcting the composer to `cliproxyapi/deepseek-v4.1-flash-cheap` completed
  every subsequent request.
- **Note — no source edits.** This run only created
  `docs/plans/plus-1.1.15-a1-live.md`; `packages/*` and
  `docs/plans/plus-1.1.15-overnight-log.md` were not touched.
