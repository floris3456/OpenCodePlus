# T3 / overnight#18 — member-only model activation live proof

Live acceptance for the Instructions T3 evidence case: an agent that exists
only as a team member is addressed by its member row id, not a flat owner id.
This closes the overnight#18 review gap: the earlier `model.test.ts` case called
`activateModelRow` directly on a member row; this run exercises the actual
`instructions.*` tool boundary against a member-only agent and observes the next
primary request's real provider model.

Sanitized evidence only: no credentials, no raw private prompts.

## Build under test

- HEAD: `12c3a75c8ec3c606f1e5f910dcdc8f69cb55ec88` (parent base `95480af6ab322a89f42b305b999bb457c7117b85`, branch
  `team/Flash-B-Worker/t1029cd3-20261005-0610`); historical initial run at
  `7d8995925ceb827f580bb4f953328351f368cc84` (branch
  `team/Flash-C-Worker/t91575a-20261005-0455`).
- Diagnostic fix in `packages/plus/src/tools.ts`: `unknownError` appends the
  member-row note for both flat model owner id forms when candidate exists
  under a real member.
- Launched exactly:
  `pilotty spawn --name overnight-member-backup opencodeplus-dev .` from this worktree;
  own dev home, never shared port 40375, never `bun dev`/`bun run dev:live`.
- Owned dev home (full path):
  `/home/bliss/OpenCodePlus/run/plus-dev/run-plus-data-opencodeplus-teams-worktrees-opencode-Flash-B-Worker-t1029cd3-20261005-0610`
- Owned log (proven by kernel fd below):
  `<dev-home>/data/opencode/log/opencode-local.log`
- Owned SQLite (session history / Monitor ledger):
  `<dev-home>/data/opencode/opencode-local.db` and
  `<dev-home>/data/opencode/opencodeplus/monitor.db`
- Model used for real requests in `overnight-member-backup`:
  `cliproxyapi/claude-opus-5-5` (DeepSeek-cheap quota exhausted #21; working
  observed fallback per decision #21). Historical DeepSeek cheap receipt
  retained below.

Path shorthand (exact absolute paths):

- `<dev-home>` =
  `/home/bliss/OpenCodePlus/run/plus-dev/run-plus-data-opencodeplus-teams-worktrees-opencode-Flash-B-Worker-t1029cd3-20261005-0610`
- `<worktree>` =
  `/home/bliss/OpenCodePlus/run/plus/data/opencodeplus/teams/worktrees/opencode/Flash-B-Worker/t1029cd3-20261005-0610`

## What changed (minimal diagnostic fix)

`packages/plus/src/tools.ts`: `unknownError` optionally takes the snapshot memo
and appends a member-row note when a flat model owner id names no row but the
matching `<team>/:<member>` row exists. Both flat forms the T3 evidence names
are recognized:

- the row grammar `item:<level>:<owner>:model:<provider>/<model>[@variant]`;
- the legacy log target `model:<level>:<owner>:<provider>/<model>[@variant]`
  that `model.add`/`mutate` recorded before the member owner path existed.

`set`, `reset`, `split`, `delete` and `show` pass the memo they already built.
The note never invents a candidate, an owner or a team: it only fires when the
exact candidate row already exists under a real member, and when several teams
hold the same member it lists every matching row instead of choosing one. No
field, reset, index or owner-segment semantics changed; T82 still owns those.

## Status

- [x] Both flat member-only id forms reproduced at the real tool boundary.
- [x] Refusal names the exact member row for both forms.
- [x] Refusal writes nothing: records, both revisions and log unchanged.
- [x] Negative controls: a flat id naming no member, and a real member id whose
      candidate does not exist, both keep the plain `row.unknown`.
- [x] Ambiguous member id lists every matching member row.
- [x] Member row activates through `set` (`active:true` and a bare set).
- [x] Activation is one global revision and one log line, and another owner's
      active candidate is preserved.
- [x] `create` with the member's team writes the member row; without the team it
      refuses.
- [x] Discriminating two-candidate exclusive control proven live via build seat
      actor (resolves D1).
- [x] Member-only proof: agent file absence, member tree origin, no Defaults echo/file.
- [x] Automatic composer reflection without manual composer-model pick.
- [x] Real next primary request for Global Basic/Planner member observed:
      agent `Planner`, provider `cliproxyapi`, model `claude-opus-5-5`
      in the owned Monitor ledger, with wire fingerprint. (Historical DeepSeek
      cheap receipt preserved).
- [x] 7 Plus focused checks and typecheck pass at HEAD.
- [x] Runtime cleanup with kernel proof.

## Member-only proof (no stand-alone agent file/node)

Proving that `Planner` exists ONLY as a team member, never as a stand-alone agent:

1. **Agent file absence in owned config**:
   - `<dev-home>/config/opencode/agents/` contains:
     `DeepSeek-Build.md`, `Gemini-Build.md`, `astra-reviewer.md`, `deepseek-worker.md`, `release.md`.
     Neither `Planner.md` nor `Planner.json` nor `T91Only.md` exists.
   - `<dev-home>/project/.opencode/agent/`: empty / no agent files exist.
2. **Team member origin**:
   - The member file lives strictly under the team:
     `<dev-home>/config/opencode/opencodeplus/teams/Basic/Planner.md`.
   - The snapshot / tree node is `team:global:Basic:Planner`, linked to preset
     `basic/planner`. There is no `agent:global:Planner` or `agent:project:Planner`
     row in the tree.
3. **No Defaults echo / file**:
   - No Defaults agent file or entry exists for `Planner`.
4. **Flat per-agent model record ≠ standalone agent**:
   - The model record stored at `records.jsonl` is `{"type":"model","level":"global","agent":"Planner",...}`
     without a `team` key because the member lookup chain reads per-agent records down
     its scope chain. That storage record does not constitute a stand-alone agent node.

## Evidence log

### 2026-10-05 06:20–06:26 — live run `overnight-member-backup` (exclusive two-candidate proof, D1 resolved)

Launched `pilotty spawn --name overnight-member-backup opencodeplus-dev .` on
worktree base HEAD `95480af6ab322a89f42b305b999bb457c7117b85` (commit `12c3a75c8ec3c606f1e5f910dcdc8f69cb55ec88`).

**Kernel state during test**:
- Launcher PID `3357819`: cwd `<dev-home>/project`, fd 9 -> `<dev-home>/data/opencode/log/opencode-local.log`
- Server PID `3357912`: cwd `<worktree>/packages/cli`, fd 9 -> `<dev-home>/data/opencode/log/opencode-local.log`, fd 11, 12, 13 -> `<dev-home>/data/opencode/opencode-local.db` (`-wal`/`-shm`)

**Parent actor driving member configuration (resolves D1)**:
The `basic/planner` preset deliberately hides the `instructions.*` namespace, so
the member itself has no instruction tools. The parent seat actor (`build`), which
has `instructions.*` enabled, was used to configure and activate the member row.

**Real actions executed via `execute` tool in session**:

1. Created team `Basic`:
   - `create({ kind: "team", team: "Basic", level: "global" })` →
     `{"id":"team:global:Basic","item":"Basic","enabled":false}` (log `team.create Basic (global)`, revision 465).
2. Created member `Planner`:
   - `create({ kind: "member", team: "Basic", level: "global", id: "Planner", preset: "basic/planner" })` →
     `{"id":"team:global:Basic:Planner","path":"<dev-home>/config/opencode/opencodeplus/teams/Basic/Planner.md","item":"Planner"}` (log `team.addAgent Planner to Basic (global)`, revision 466).
3. Created member candidate 1 (`claude-opus-5-5`):
   - `create({ kind: "model", level: "global", agent: "Planner", team: "Basic", providerID: "cliproxyapi", modelID: "claude-opus-5-5" })` →
     `{"id":"item:global:Basic/:Planner:model:cliproxyapi/claude-opus-5-5","item":"model:cliproxyapi/claude-opus-5-5"}` (log `model.add cliproxyapi/claude-opus-5-5 (global)`, revision 467).
4. Both flat ID refusals with exact member guidance:
   - **Legacy log target**:
     `set({ id: "model:global:Planner:cliproxyapi/claude-opus-5-5", active: true })` →
     `row.unknown: Unknown row "model:global:Planner:cliproxyapi/claude-opus-5-5"; "Planner" is a member of team "Basic": use "item:global:Basic/:Planner:model:cliproxyapi/claude-opus-5-5"`.
   - **Row grammar form**:
     `set({ id: "item:global:Planner:model:cliproxyapi/claude-opus-5-5", active: true })` →
     `row.unknown: Unknown row "item:global:Planner:model:cliproxyapi/claude-opus-5-5"; "Planner" is a member of team "Basic": use "item:global:Basic/:Planner:model:cliproxyapi/claude-opus-5-5"`.
   - **Negative control 1** (unknown owner):
     `set({ id: "item:global:Nobody:model:cliproxyapi/claude-opus-5-5" })` →
     `row.unknown: Unknown row "item:global:Nobody:model:cliproxyapi/claude-opus-5-5"`.
   - **Negative control 2** (unknown model on real member):
     `set({ id: "item:global:Planner:model:cliproxyapi/nonexistent-model" })` →
     `row.unknown: Unknown row "item:global:Planner:model:cliproxyapi/nonexistent-model"`.
5. Discriminating two-candidate control:
   - Staged independent candidate 2 (`gpt-6-astra`) without calling provider:
     `create({ kind: "model", level: "global", agent: "Planner", team: "Basic", providerID: "cliproxyapi", modelID: "gpt-6-astra" })` →
     `{"id":"item:global:Basic/:Planner:model:cliproxyapi/gpt-6-astra","item":"model:cliproxyapi/gpt-6-astra"}` (revision 468).
   - Show candidate 2: `show({ id: "item:global:Basic/:Planner:model:cliproxyapi/gpt-6-astra", view: "record" })` →
     `record.active: true`.
   - Show candidate 1: `show({ id: "item:global:Basic/:Planner:model:cliproxyapi/claude-opus-5-5", view: "record" })` →
     `record.active: undefined` (inactive).
   - Activated target candidate 1 (`claude-opus-5-5`) via **bare set** (no `active` field):
     `set({ id: "item:global:Basic/:Planner:model:cliproxyapi/claude-opus-5-5" })` →
     `{"id":"item:global:Basic/:Planner:model:cliproxyapi/claude-opus-5-5","status":"Activated \"cliproxyapi/claude-opus-5-5\"","revision":0,"globalRevision":469}`.
   - Show candidate 1 after bare set:
     `show({ id: "item:global:Basic/:Planner:model:cliproxyapi/claude-opus-5-5", view: "record" })` →
     `record.active: true`, `level: "global"`, `agent: "Planner"`, `basedOn: ""` (no `team` key).
   - Show candidate 2 after bare set:
     `show({ id: "item:global:Basic/:Planner:model:cliproxyapi/gpt-6-astra", view: "record" })` →
     `record.active: undefined` (cleared).
   - **One active flag**: exactly one candidate active for Planner.
   - **One revision / log line**: log line
     `mutate 2 rows (global): model:global:Planner:cliproxyapi/claude-opus-5-5, model:global:Planner:cliproxyapi/gpt-6-astra`, global revision 469.
   - **Other owners preserved**: records for `Build`, `Simple-Planner`, `Reviewer`, etc. retained their active models untouched in `records.jsonl`.
6. Enabled team `Basic`:
   - `set({ id: "team:global:Basic", state: "on" })` →
     `team.setEnabled Basic enabled (global)`, revision 470, `disabledTeams:[{"level":"global","team":"Simple"}]`.

**Composer reflection & Next primary provider request**:
- Switched agent via back-tab `\033[Z` to `Planner` (Team: Basic).
- Composer automatically displayed:
  `Planner · claude-opus-5-5 CLIProxyAPI`
  No manual composer-model pick was performed.
- Sent prompt: `Reply with exactly: PLANNER-OPUS-ROUTE-OK` as agent `Planner`.
- Received reply: `PLANNER-OPUS-ROUTE-OK` (`Planner · claude-opus-5-5 · 3.1s · 6.8 tok/s`).
- Monitor ledger request row (`monitor.db`):
  `3a72981c-94d6-4658-a89c-a39b009e23b6`:
  `kind:"step"`, `agent:"Planner"`, `provider:"cliproxyapi"`, `model:"claude-opus-5-5"`, `variant:"default"`, `status:"completed"`, `finish:"stop"`.
- Wire fingerprint (`request_fingerprint`):
  `protocol:"openai-responses"`, `body_hash:"6da49c60aebd1cf5"`, `response_id:"c6abc002df63d57d"`.
- Real wire request completed through the elected member route.

---

### 2026-10-05 03:15–03:24 — historical live run `t91-member` (DeepSeek-cheap)

All tool calls below are **real actions**: the model executed them through the
`execute` tool's Code Mode `instructions.*` calls, and the raw results were read
from the owned SQLite `session_message` rows and the owned store/log.

**A genuinely member-only agent.** Created through the tools (store revision
469→473, log lines `team.create T91Team`, `team.addAgent T91Only to T91Team from
member:basic/planner`, `model.add cliproxyapi/deepseek-v4.1-flash-cheap
(global)`):

- `create {kind:"team", team:"T91Team", level:"global"}` →
  `{"id":"team:global:T91Team","item":"T91Team","enabled":false}`.
- `create {kind:"member", team:"T91Team", level:"global", id:"T91Only",
  preset:"basic/planner"}` →
  `{"id":"team:global:T91Team:T91Only","item":"T91Only"}`. No Global agent
  `T91Only` was ever created, so the flat owner id cannot exist.
- `create {kind:"model", level:"global", agent:"T91Only", team:"T91Team",
  providerID:"cliproxyapi", modelID:"deepseek-v4.1-flash-cheap"}` →
  `{"id":"item:global:T91Team/:T91Only:model:cliproxyapi/deepseek-v4.1-flash-cheap","item":"model:cliproxyapi/deepseek-v4.1-flash-cheap"}`.
  This is the member row, not a flat record.

Flat refusal (real, exact message from the `session_message` row):

```
row.unknown: Unknown row "item:global:T91Only:model:cliproxyapi/deepseek-v4.1-flash-cheap";
"T91Only" is a member of team "T91Team": use
"item:global:T91Team/:T91Only:model:cliproxyapi/deepseek-v4.1-flash-cheap"
```

Member activation (real, exact result):

- `set {id:"item:global:T91Team/:T91Only:model:cliproxyapi/deepseek-v4.1-flash-cheap"}`
  (a **bare set**, no `active` field) →
  `{"id":"item:global:T91Team/:T91Only:model:cliproxyapi/deepseek-v4.1-flash-cheap","status":"Activated \"cliproxyapi/deepseek-v4.1-flash-cheap\"","revision":0,"globalRevision":472}`.
- `show {id:"item:global:T91Team/:T91Only:model:cliproxyapi/deepseek-v4.1-flash-cheap", view:"record"}`
  reported the stored record `level:"global", agent:"T91Only", active:true,
  basedOn:"cliproxyapi/deepseek-v4.1-flash-cheap"` (no `team` key), which is the
  per-agent record the member chain reads.

### 2026-10-05 03:20 — T91Only team enable and next primary request (historical)

- `set {id:"team:global:T91Team", state:"on"}` →
  `team.setEnabled T91Team enabled (global)`, `disabledTeams:[{level:"global",
  team:"Simple"}]`; the owned store recorded
  `{"type":"team","level":"global","team":"T91Team","enabled":true,...}`
  (revision 473). The composer agent cycled to `T91Only` and read
  `T91Only · deepseek-v4.1-flash-cheap CLIProxyAPI`.
- Real prompt `Reply with exactly: MEMBER-ROUTE-OK` sent as agent `T91Only`.
  The reply was `MEMBER-ROUTE-OK`.
- Owned Monitor ledger `request` row
  `695281b5-da9e-4dcc-b80b-0431b4271b06`:
  `kind:"step"`, `agent:"T91Only"`, `provider:"cliproxyapi"`,
  `model:"deepseek-v4.1-flash-cheap"`, `variant:"default"`, `status:"completed"`,
  `finish:"stop"`. This is the **actual next primary provider model**.
- `request_fingerprint` for the same request: `protocol:"openai-responses"`,
  `body_hash:"3fad815cc92ebe23"`, `response_id:"5617d847774bb11f"` — a real wire
  request was built and completed.

### 2026-10-05 03:38–03:42 — historical corrected run `t91-member2` (both flat forms)

The review asked that the legacy `model:<level>:<owner>:<provider>/<model>`
evidence id also earn the hint. This run exercised both forms in one prompt as
agent `build` (seat) on the same owned home, whose store already had the Global
`Basic` team with `Planner` only as a member (no Global `Planner` agent file).

Real results (read from the owned `session_message` row):

1. `set {id:"model:global:Planner:cliproxyapi/deepseek-v4.1-flash-cheap", active:true}`
   → `row.unknown: Unknown row "model:global:Planner:cliproxyapi/deepseek-v4.1-flash-cheap"; "Planner" is a member of team "Basic": use "item:global:Basic/:Planner:model:cliproxyapi/deepseek-v4.1-flash-cheap"`.
2. `set {id:"item:global:Planner:model:cliproxyapi/deepseek-v4.1-flash-cheap", active:true}`
   → `row.unknown: Unknown row "item:global:Planner:model:cliproxyapi/deepseek-v4.1-flash-cheap"; "Planner" is a member of team "Basic": use "item:global:Basic/:Planner:model:cliproxyapi/deepseek-v4.1-flash-cheap"`.
3. `set {id:"item:global:Basic/:Planner:model:cliproxyapi/deepseek-v4.1-flash-cheap"}`
   (bare) → `{"status":"Activated \"cliproxyapi/deepseek-v4.1-flash-cheap\"","revision":0,"globalRevision":473}`.
4. `show {id:"item:global:Basic/:Planner:model:cliproxyapi/deepseek-v4.1-flash-cheap", view:"record"}`
   → `record.active:true`, `level:"global"`, `agent:"Planner"`, no `team` key.

Both flat refusals name the identical member row; the legacy evidence id is not
silently accepted or mislabeled.

### 2026-10-05 03:40 — Global Basic/Planner member-only, next primary request (historical)

- `set {id:"team:global:Basic", state:"on"}` → `team.setEnabled Basic enabled
  (global)`, revision 474, `disabledTeams:[{level:"global", team:"T91Team"}]`.
  Owned store: `{"type":"team","level":"global","team":"Basic","enabled":true,...}`.
- Switched the composer agent to `Planner` (Team: Basic (global)); the composer
  read `Planner · deepseek-v4.1-flash-cheap CLIProxyAPI`.
- Real prompt `Reply with exactly: PLANNER-MEMBER-ROUTE-OK` sent as agent
  `Planner`; the reply was `PLANNER-MEMBER-ROUTE-OK`.
- Owned Monitor ledger `request` row
  `96854532-5dd4-409d-b5b3-ab00613280ba`:
  `kind:"step"`, `agent:"Planner"`, `provider:"cliproxyapi"`,
  `model:"deepseek-v4.1-flash-cheap"`, `variant:"default"`, `status:"completed"`,
  `finish:"stop"`.
- `request_fingerprint`: `protocol:"openai-responses"`,
  `body_hash:"63ae440ecf693f5c"`, `response_id:"e708b93baced3a24"` — a real wire
  request was built and completed.

---

## Source verification at current HEAD

From `packages/plus`:

- `bun test test/member-model-activation.test.ts` → **5 pass, 0 fail** (62 expects).
  Covers both flat forms, no-write refusals, negative controls, ambiguity,
  exclusive activation, one-revision/one-log proof for add and set with another
  owner preserved, and create with/without member team.
- `bun test test/model.test.ts` → **50 pass, 0 fail** (170 expects).
- `bun test test/rpc.test.ts` → **58 pass, 3 skip, 0 fail** (674 expects).
- `bun test test/plus-instructions-propagation.test.ts` → **5 pass, 0 fail** (31 expects).
- `bun test test/monitor-requests.test.ts` → **18 pass, 0 fail** (195 expects).
- `bun test test/monitor-plugin.test.ts` → **3 pass, 0 fail** (22 expects).
- `bun run typecheck` → passes (`tsgo --noEmit -p tsconfig.test.json` clean).
- `bun test test/tools.test.ts` baseline → **66 pass, 1 skip, 4 fail** (473 expects).
  The four failures are pre-existing overnight#15 unlanded T100 field-reset cases;
  they fail identically with and without this slice's changes.

## Runtime cleanup

Owned processes were identified by kernel state (cwd under this worktree or the
owned dev home, and fds targeting the owned dev home), never by a registration file.

**Kernel proof during test** (`overnight-member-backup`):
- Launcher PID `3357819`: cwd `<dev-home>/project`, fd 9 -> `<dev-home>/data/opencode/log/opencode-local.log`.
- Server PID `3357912`: cwd `<worktree>/packages/cli`, fd 9 -> `<dev-home>/data/opencode/log/opencode-local.log`,
  fds 11, 12, 13 -> `<dev-home>/data/opencode/opencode-local.db` (`-wal`/`-shm`).

**Shutdown**:
- Exited cleanly via palette `exit` (exit code 0).
- `pilotty status -s overnight-member-backup` reported `state:"exited"`, `exit_code:0`, `success:true`.
- PIDs `3357819` and `3357912` confirmed dead via `/proc`.
- No live process holds a cwd or fd under `<dev-home>`.
- `pilotty list-sessions` lists no `overnight-member-backup` session.
- Prior historical cleanup from parent: `t91-verify` PIDs `3292354`/`3292439`/`3292557` exited palette exit code 0, home cwd/fd/maps none.
- Immutable release controller's `search-mcp` child untouched.

**Log line classification**:
`<dev-home>/data/opencode/log/opencode-local.log`:
- Total lines: 203
- INFO: 197
- WARN: 6 (all 6 are expected executor confinement warnings: `executor-controlled plugin source refused` for `.opencode/opencode.json` / `.opencode`)
- ERROR: 0

## Open issues / deferred

- **D1 — exclusive activation live from member chat RESOLVED.** The live exclusive
  case was successfully driven using the build seat parent actor (`build`) while
  the member's `basic/planner` preset instructions namespace remained unchanged off.
  Discriminating two-candidate control proved that adding candidate 2 made it active,
  bare `set` on candidate 1 made candidate 1 exclusively active (clearing candidate 2),
  the composer automatically reflected `Planner · claude-opus-5-5`, and the next primary
  request ran through `cliproxyapi/claude-opus-5-5` with verified ledger and fingerprint.
- **D2 — no broad field/reset change.** This slice deliberately does not touch
  owner-segment create, reset or model-field semantics; T82 / T100 owns those
  (overnight#1/#6/#15/#17) and the four pre-existing `tools.test.ts` failures.
