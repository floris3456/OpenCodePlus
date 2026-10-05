# plus-1.1.15 — model field/owner repair live receipt (#1/#6/#15/#17)

Run: `continuation-fields` (Flash-C-Worker, task T106 `w-cab5839840e3b9d6`).
Worktree: `/home/bliss/OpenCodePlus/run/plus/data/opencodeplus/teams/worktrees/opencode/Flash-C-Worker/t106cab5-20261005-0929`.
Dev home: `/home/bliss/OpenCodePlus/run/plus-dev/run-plus-data-opencodeplus-teams-worktrees-opencode-Flash-C-Worker-t106cab5-20261005-0929`.
Dev log (proven by kernel fd): `<dev-home>/data/opencode/log/opencode-local.log`.
Dev SQLite: `<dev-home>/data/opencode/opencode-local.db` (+`-wal`/`-shm`).
Launched exactly: `pilotty spawn --name continuation-fields opencodeplus-dev .` from this
worktree. No shared service (port 40375), no `bun run dev:live`, no `bun run dev`, no live
configuration mutation, no release build/push.

The dev home was seeded with the release's providers/agents/instructions. The owned project
store (`<dev-home>/project/.opencodeplus/instructions/records.jsonl`) was the disposable
fixture for the field edits below; the owned global store carries the pre-existing records and
was never used as a source of truth for these claims.

## Build under test

- Source HEAD: `88c914294274d8d0772952af22459c1e58362be1` (base `b6835471ee1b6b088d717ebff565d345c4da430f`);
  this live receipt and its added focused controls are committed at `199607495f2331908aeaeb2f833422e38e134bbc`.
- Applied the preserved T100 source input as an unaccepted draft, retaining the landed T102
  member diagnostics and T99/T104 Monitor repairs.
- Seeded active/inherited candidates: Global `cliproxyapi/claude-opus-5-5@high` (active),
  Defaults `build` `cliproxyapi/claude-opus-5-5@xhigh` (active, warm 30m / every 4m).

## #6 — queued corrections verified

### Original metadata restores the row-specific candidate

- **Inherited original.** Edited Effort on the Defaults-derived candidate `…@xhigh` → `low`.
  The owned store then held exactly one live row plus a tombstone of the replaced candidate:
  `{"variant":"low","originalCandidate":{"…","variant":"xhigh","source":"defaults","editedFields":["effort"]}}`
  and `{"variant":"xhigh","removed":true}`. `r` on the Effort field restored `xhigh` and
  removed both the `low` row and its `xhigh` tombstone (revision 2, one live candidate gone,
  no stale hidden row). This is the queued "inactive inherited B alongside active A → C →
  reset restores B" contract at the TUI boundary.
- **Local-only original.** Edited the Model field of the Defaults-derived row to
  `cliproxyapi/gemini-3.8-flash-high`; the store recorded
  `originalCandidate.source:"defaults"` on the live replacement and a tombstone for the old
  candidate. `r` on Model restored the Defaults candidate (`claude-opus-5-5@xhigh`) and left
  the owned project store empty (`{"version":2,"revision":4}` only). No `resolveActiveModel`
  guess of the upstream active model was used.
- **Repeated reset refuses without writes.** The focused regression
  `model-settings.test.ts` "no-warming control" drives B@high→Model C→Effort low→activate→
  reset Model (B@low active)→repeat reset (refuses, identical records/revision)→reset Effort
  (B@high active preserved). It passes at HEAD.
- **Unknown legacy original refuses honestly.** The focused regression
  "Model reset refuses honestly for a legacy row with no original metadata" asserts the
  refusal contains `no recorded original candidate` and the store is byte-identical
  afterwards. The old `resolveActiveModel(above)` fallback is removed from `ops.ts`.

### Field rows show the effective value and its real source

Measured in the live TUI (80 and 160 columns), on `Project › Agents › OpenCode › build ›
Models › cliproxyapi/claude-opus-5-5@xhigh` with the field group open:

```
 Model                         cliproxyapi/claude-opus-5-5@xhigh · defaults
 Effort                                                    xhigh · defaults
 Warming                                                     30m · defaults
 Ping every                                                   4m · defaults
 Keep-...romptThis is a keep-alive request....y with exactly: OK · built-in
```

and on the active inherited row `…@high`:

```
 Model                            cliproxyapi/claude-opus-5-5@high · global
 Effort                                                       high · global
 Warming                                                32m · opencode.json
 Ping every                                                   4m · defaults
 Keep-...romptThis is a keep-alive request....y with exactly: OK · built-in
```

Every field names its real source (`· global`, `· defaults`, `· opencode.json`); the earlier
bug that displayed Defaults values whenever the source level differed is gone.

## #17 — lowercase `r` resets, Shift+R renames

At 160 columns on the `build` agent row, `R` (typed as Shift+r) opened the Rename prompt
(`Rename category · Models`) and Escape dismissed it; the lowercase `r` on a field row
performed Reset. The route binding is now `shift+r` only (no bare `R` token), so the keymap
cannot normalize it onto the reset key. `route.test.tsx` "no model field command binding
normalizes onto the reset key r" asserts exactly one `r` token, no bare `R`, `shift+r`
present, and that `r` really writes the reset through the real command.

## #1 — owner-segment create refuses before any write

- **Tool boundary.** `instructions_create({ kind:"model", level:"global",
  agent:"Simple/:Simple-Orchestrator" })` (no `team`) now fails with `model.invalid: … is a
  team member's owner path, not an agent id; pass agent "Simple-Orchestrator" with team
  "Simple"`, leaving the store and revision unchanged. The valid retry
  `agent:"Simple-Orchestrator", team:"Simple"` returns `item:global:Simple/:Simple-Orchestrator:model:acme/nova-2`
  and writes the expected record.
- **RPC boundary.** `model.add` with the same owner path is refused with the same message at
  the RPC contract, with a no-write assertion on the snapshot revision and records
  (`rpc.test.ts` "model.add refuses a team member owner path before writing and names agent +
  team").

## #15 — the eight stale suite failures reconciled

Whole `packages/plus` suite at HEAD: **2249 pass / 14 existing skips / 0 fail / 36508
expects** (148 files). The eight previously failing cases now assert the actual contracts
without weakening refusal controls:

- `ops.test.ts`: replacement-active and inherited-local assertions select the live row
  (`record.removed !== true`) and assert the tombstone exists for the replaced candidate.
- `tools.test.ts`: replacement row count counts the live row and asserts the tombstone;
  the created-active deletion flows reset the active flag first (create activates
  exclusively); the inherited deletion/re-add case activates another candidate before the
  effective-model delete.
- `route.test.tsx`: the removed whole-row editor is replaced by the field-row flow; the
  out-of-catalog text-entry case becomes the Model-field picker with an empty host catalog
  (toast, no write).

## Live acceptance at 80 and 160 columns

- **80×24.** Model group opens with two candidates (`…@high` active, `…@xhigh` from
  defaults); Enter opens the five field rows; each field shows its inherited label; `r` on
  Warming cleared the local `45m` back to `32m · opencode.json`; `r` on Effort restored
  `xhigh`; active-model `d` refused with `"cliproxyapi/claude-opus-5-5@high" is the active
  model here: activate another model first`.
- **160×48.** The same group and fields render wide (list + inspector + detail), including
  the exact `warming 30m · set at Defaults` / `ping every 4m · set at Defaults` facts.
- **Every field edits and resets independently** (Ping every and Keep-alive prompt measured
  live on the Defaults-derived `…@xhigh` row at 80 and 160):
  - Warming `30m · defaults` → typed `45m` → row `warm 45m`; `r` cleared it to `inherited`.
  - Ping every `4m · defaults` → typed `5m` → row `every 5m`; `r` cleared it to `4m · defaults`.
    Repeated at 6m → `6m` → `r` → `4m · defaults`.
  - Keep-alive prompt `… Reply with exactly: OK · built-in` → typed `ping me ok` → row
    `ping me ok`; `r` cleared it to `… Reply with exactly: OK · built-in`.
  - Each edit left the row's other fields untouched and the active inherited candidate
    (`…@high`) unchanged: after every reset the group again showed `…@high` active plus the
    one local `…@xhigh` row with its remaining local warming only.
  - The edits and resets produced exactly one owned-store revision each (rev 5–11), visible
    as one live local record, never a second visible row.
- **Delete and re-add.** In a third pass the inherited `…@xhigh` row's `d` opened the
  remove confirmation and, confirmed, wrote a tombstone (one revision; `…@xhigh` no longer
  listed), while `a` in the Models group opened the `Model provider` → `Model` → `Variant`
  pickers. Adding `cliproxyapi/claude-opus-5-5@xhigh` (the hidden candidate) cleared its
  tombstone and activated it exclusively: after the add the group showed
  `…@high` (unbadged) beside `…@xhigh` `active · warm 30m · every 4m`, with the owned store
  holding exactly one live `…@high` row and one active `…@xhigh` row — one visible row per
  candidate, no tombstone left (revision 15). This closes the live re-add control.
- **Model picker.** Enter on the Model field opens `Model provider`, then the model list;
  selecting an entry replaces the candidate in place (one visible row + tombstone), and a
  later `r` restores the original candidate.
- **Effort picker.** Enter on Effort opens `Effort · cliproxyapi/claude-opus-5-5` with the
  candidate's variants (`high`, `low`, `max`, `medium`, `xhigh`) plus `(inherit / none)`.
- **Active/warming compatibility.** Editing Warming and resetting it preserved the active
  candidate and the unrelated fields; the reset status showed the restored inherited value.

No request was needed for these field claims; the composer stayed on the observed working
`cliproxyapi/claude-opus-5-5` route. No TTL is asserted or invented.

## Runtime classification and cleanup

- Actual `opencode-local.log` (final pass): **1056 lines / 1026 INFO / 30 WARN / 0 ERROR**;
  all 30 WARNs are the expected `executor-controlled plugin source refused` refusals, zero
  other warnings/errors. Earlier passes logged 436/424/12/0 and 642/624/18/0 with the same
  all-refusal classification.
- Owned PIDs (kernel cwd/fd proven), first pass:
  - launcher `3823121`: cwd `<dev-home>/project`, fd 9 → `<dev-home>/data/opencode/log/opencode-local.log`;
  - server `3823152`: cwd `<worktree>/packages/cli`, fd 9 → the log, fds 11/12/13 → the owned `opencode-local.db` (+`-wal`/`-shm`);
  - search `3823220`: cwd `<dev-home>/project`.
- Exited the owned TUI through the palette (`Ctrl+P` → `exit` → Enter) in every pass;
  pilotty status `exited`, exit code `0`, `killed_by_client:false`.
- Parent-verifiable cleanup: the first-pass PIDs are absent; a full `/proc` cwd/fd/maps scan
  for the exact owned home finds **no matches** after every pass. No test PTY or owned
  runtime remains. No environment/credential material was read or printed.

## Checked at HEAD

- `models`: `bun test test/model.test.ts test/model-settings.test.ts` — 82 pass / 0 fail.
- `rpc`: `bun test test/rpc.test.ts test/rpc-contract.test.ts` — pass.
- `tools-ops`: `bun test test/tools.test.ts test/ops.test.ts` — 115 pass / 1 skip / 0 fail.
- `route-panes`: `bun test test/route.test.tsx test/instructions-panes.test.tsx` — 101 pass / 2 skip / 0 fail.
- `both-parts-index`: `bun test test/plus-instructions-propagation.test.ts test/monitor-plugin.test.ts test/monitor-requests.test.ts` — 26 pass / 0 fail.
- `plus-typecheck`: `bun run typecheck` — pass.
- Whole `packages/plus` suite — 2249 pass / 14 skip / 0 fail.

## Open / not claimed

- No provider request was made for these field/owner claims, so no next-primary-request model
  attribution is claimed here; T102 already accepted member-only primary routing.
- #16/#20/#21/#23 remain external availability findings and are unchanged.
