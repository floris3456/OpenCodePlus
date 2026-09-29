# Instructions fast + Plus always on — evidence (2026-09-29)

Branch `instructions-fast` (local only, not pushed). Base: `origin/v2` @ 5a6e4d4e6 (= `v0.0.0-plus-r4.8`, the installed release).
It merges branch `plus-always-on` (project-mode removal).
All changes are in `packages/plus`, apart from one SDK test line (see §5).
No Protocol/HttpApi change was made, so there is no client regeneration.

## 1. What changed

### The human's request
1. The `/instructions` UI was slow. It should be as responsive as possible when opened and on every action.
2. Project mode is removed. `.opencodeplus/` is created automatically when Plus first writes project-scoped state for a directory.
3. `ctrl+x p` (`<leader>p`) opens Instructions.

### Decisions implemented
1. Plus is always active in every directory. Global/Defaults customizations therefore apply everywhere; this is intended.
2. `src/project.ts`:
   - `read(dir)` walks upward as before and returns `DEFAULT_CONFIG` when no config exists; it never returns undefined.
   - The legacy `enabled` key still decodes but is ignored. A config carrying it is simply the nearest config.
   - `enable`/`disable` are deleted.
   - `ensure(dir)` writes `<dir>/.opencodeplus/project.json` only when no config exists at or above `dir`, so it never shadows an ancestor's `protectedAgents`.
3. `.opencodeplus/` is created only by project-scoped writes, in `activationDirectory(location)`:
   - `store.save` when the project store changes;
   - `log.appendForLevel` for project log entries;
   - project-level `team.create` / `team.addAgent`, after validation, so a refused write creates nothing.

   Reads create nothing. A read-triggered catalogue migration never creates a missing project store and keeps those rows in the global file, so nothing is lost. The `forced` migration branch never writes an empty project store.
4. All `project.disabled` gates are gone. `activate`, `refreshFromHost` and `applySessionModel` always proceed. `project.status`/`project.enable`/`project.disable`, the `project.changed` event and every `project.disabled` error declaration are removed from `rpc.ts` and `tools.ts`.
5. TUI:
   - `src/tui/project-mode.tsx` and the `plus.project.*` commands are deleted, along with every `enabled: () => mode.status().enabled` gate.
   - `plus.instructions.open` has `bind: "<leader>p"` and keeps `/instructions` and its palette entry.
   - Pressing it while Instructions is open is a no-op.
6. Contract text is updated in `teaching.ts`, `README.md`, `SPEC.md` (RPC table rebuilt from `rpc.ts`), `docs/TOOLS.md` and `docs/tui-walkthrough.md`. Dated evidence docs are untouched.

### Performance work
| item | change |
|---|---|
| P1 | One resolution memo per snapshot (`buildTreeMemo`, `treeOf(memo, open)`). `treeWith`, `queryIds`, `reviewTargets`, the filter, inspector and TUI ops all reuse it; `ops.ts` entry points take an optional memo. |
| P2 | The dead flat-tree state in `state.ts` is deleted (`expanded`, `allNodes`, `selectedId`, `select*`, `move`, `toggleExpanded`, `ensureSelection`, `applyPending`). |
| P3 | `matchedTree(input, where, memo)` in `query.ts` returns matches plus the ancestor chains from the candidate walk and materialises only those rows. The grammar-rejected fallback walks skeleton lazies. |
| P4 | Tool counts are computed on demand per owner (`toolCountOf`). Only the acted-on owner is counted synchronously; the other sidebar owners fill in background slices (≤ 4 owners / ≈ 8 ms per task), cancelled when the memo or level changes. |
| P5 | `instructions.changed` reloads are coalesced: one in flight plus one trailing. The generation guard is kept. |
| P6 | A stale-while-revalidate snapshot cache per directory (`src/tui/snapshot-cache.ts`). Instructions renders the cached snapshot at once and revalidates. An event or a put for another directory marks entries stale, and an older snapshot never replaces a newer one. The dialogs and `agents/create.tsx` read fresh entries only. |
| P7 | Inspector derivations are computed once per snapshot (`WeakMap<Snapshot,…>`) and resolve through the shared memo. |
| P8 | The list pane renders only the viewport window plus a margin, with spacers. Justified by profile: 1459 RowLines cost ~80–90 ms of a ~310 ms filter, and a wide filter (~15k rows) crashed OpenTUI with "Failed to create SyntaxStyle". Stable row identity was skipped because keys were already 31–47 ms and row rebuilds were not dominant. |
| P9 | `TeamMonitorTab` refreshes only on session lifecycle events (`SessionRunEvents`, never `*.delta`), with a trailing 250 ms throttle. |
| P10 | A generated live-scale fixture (`test/perf.test.ts`) asserts `memoBuildCounter.count === 1` across open, ↓, right, level switch, `n` and filter. The counter sits in `memoOf`. Temporarily rebuilding per call makes it fail with `Expected: 1 / Received: 6`. |

## 2. Benchmarks

### Setup
- Input: the live snapshot of `/home/bliss/OpenCodePlus` (1149 items, 787 perm rows, 21 agents; ~121k fully expanded rows). It was fetched read-only and is **not committed**.
- Harness: the package's TUI route harness at 180×50. The scripts are in the scratch dir `run/plus/tmp/opencodeplus/ifast-bench/` (`route-bench*.test.ts`, `route-filter.test.ts`).
- Runs: 3 each, sequential, same machine. "Before" is a detached `origin/v2` worktree; "after" is the final `instructions-fast` HEAD.

### Route harness
| action | r4.7 (earlier diagnosis) | before (origin/v2 = r4.8) | after | target |
|---|---|---|---|---|
| open → first usable frame | 140 | 376 / 379 / 385 | **123 / 124 / 136** | < 250 ✅ |
| first ↓ after open | 33 | 666 / 675 / 669 | **33 / 33 / 34** | < 60 ✅ |
| sidebar ↓ #2–#5 | 35 | 34–167 | 33–40 | < 60 ✅ |
| list ↓ | — | 32–40 | 26–42 | < 60 ✅ |
| category 4 (Tools) | — | 134–138 | **36–43** | < 60 ✅ |
| right (open tool row) | — | 86–88 | **35–37** | < 60 ✅ |
| `>` level switch | — | 268–279 | **40–42** | < 60 ✅ |
| `>` level switches (bench2, incl. Presets) | — | 176–193 | **33–39** | < 60 ✅ |
| `<` level back | — | 84–113 | 33–38 | < 60 ✅ |
| `n` next review | — | 133–137 | **33–43** | < 60 ✅ |
| `instructions.changed` → next ↓ reflected | — | 429–451 | **34–36** | reload blocks < 100 ✅ |
| `instructions.changed` reload flush | — | 70–92 | 54–74 | — |
| filter "shell" → results, after the 150 ms debounce | ~7000 | 8428 / 8532 / 8777 | **191 / 200 / 191** | < 300 ✅ |
| reopen with warm cache (revalidating RPC held) | — | n/a (no cache) | **70 / 89 / 84** (cold 121–135) | — |
| wide filter (~15k rows at Global) | — | — | renders in ~1.1 s (it crashed before windowing) | — |

### Core computations
Measured with `bench.ts` before and `bench-new.ts` after, by WP-B, on the same snapshot.

| computation | before | after |
|---|---|---|
| one `tree()` / memo build | 40–53 ms per call, many calls | `buildTreeMemo` 6 ms, once per snapshot |
| `workspaceOf` cold (project) | 224 ms (5 builds) | 20 ms |
| tool counts, project level | 524–531 ms sweep | per owner 2–4 ms cold / 0.2 ms warm; 25 owners 51 ms total, sliced |
| `reviewTargets`, project | 138–141 ms | 0.6 ms |
| filter rows "level:project shell" | 7544 ms (`expandedTree`) | 182 ms cold / 67 ms warm (`matchedTree`) |
| `findRow` with shared memo | 4–6 ms | 0.0–0.4 ms |
| inspector facts for a tool row | 5–15 ms | 0.19 ms |

### Live TUI (`bun run dev:live /home/bliss/OpenCodePlus`)
The client is this worktree; the live server runs r4.8. Driven with pilotty at 180×50.

| action | first screen change | settled |
|---|---|---|
| `ctrl+x p` cold open | 28 ms | 313 ms (includes the live snapshot RPC and count slices) |
| sidebar ↓ ×5 | 8–28 ms | 19–37 ms |
| tab → list, list ↓ ×3 | 7–29 ms | 16–35 ms |
| category 4, tools ↓ | 16–31 ms | 29–40 ms |
| `>` Global / Defaults / Presets | 37–43 ms | 78–128 ms (background count slices, non-blocking) |
| `<`, `n` | 6–26 ms | 16–38 ms |
| `/` then type "shell" | — | 235 ms from the first typed char, including the 150 ms debounce |
| `ctrl+x p` while Instructions is open | no change in 20 s (no-op, as specified) | — |
| `ctrl+x p` reopen (warm cache) | 79 ms | 159 ms |

## 3. Tests

All tests were run from `packages/plus` of the final worktree (commands abbreviated; full logs are in the scratch dir).

| command | result |
|---|---|
| `bun test` on 36 files: `test/instructions-*.test.tsx test/workspace*.test.* test/rpc*.test.ts test/agent-create*.test.* test/route.test.tsx test/perf.test.ts test/query.test.ts test/ops.test.ts test/tree.test.ts test/teams-rpc.test.ts test/tools.test.ts test/teaching.test.ts test/store.test.ts test/log.test.ts test/active-team.test.tsx test/search/register.test.ts test/always-on.test.ts test/plugin-commands.test.tsx test/catalogues.test.ts test/agent-controls-{route,state,tree}.test.* test/help.test.tsx test/teams/lifecycle-events.test.ts` | 690 pass, 6 skip, **2 fail (baseline)** |
| `bun test` on every other test file changed on the branch (26 files: agent-controls, assembled, base-templates, builtin-teams, instruction-create, member-fields, presets*, rule-message-persistence, teams-apply, teams-store, teams/{api,models,permissions,publish-loop,roles,walkthrough}, tool-rule-state, tui-rule-state, …) | 301 pass, 6 skip, 0 fail |
| `bun test test/teams` | 456 pass, **3 fail (baseline)** |
| `packages/sdk`: `bun test test/instructions-agent-controls.test.ts` | 4 pass, 0 fail |
| `bun typecheck` (packages/plus) | clean |
| `TURBO_FORCE=true bun run check` (worktree root) | lint 0 warnings / 0 errors; 36/36 typecheck tasks successful |
| `grep -rnF -e project.enable -e project.disable -e project.changed -e project.disabled -e plus.project packages/plus/src` | no match (exit 1) |

New behaviour tests, each paired with a failure or refusal control:
- `test/always-on.test.ts`:
  - a fresh-directory snapshot creates nothing;
  - a project write creates `project.json` and `instructions/records.jsonl`;
  - a global-only write creates nothing;
  - under an ancestor config, a child write creates no `project.json`, and the ancestor's `protectedAgents` refuses a tool actor for agent x but allows agent y;
  - first-write `team.create` / `team.addAgent` / a log-only `skill.create` create the config;
  - a refused `team.create` creates nothing;
  - a read-triggered migration creates nothing and loses nothing.
- `test/plugin-commands.test.tsx`: `<leader>p` runs `plus.instructions.open`, no `plus.project.*` command exists, and the key is a no-op while the screen is open.
- `test/instructions-snapshot-cache.test.tsx`:
  - the cached rows render before the held RPC answers (control: an empty cache shows loading);
  - with the screen closed, events cause 0 RPCs, and the next open fetches once;
  - fresh or stale dialog/create reads cost 0 or 1 RPCs;
  - the cache handles two directories correctly;
  - an older put is ignored.
- `test/active-team.test.tsx`:
  - 100 deltas cause 0 refreshes;
  - a burst of 20 lifecycle events causes exactly 1 trailing refresh, which shows the final state;
  - no refresh happens after dispose.
- `test/instructions-windowing.test.tsx`: 2000 rows mount at most viewport + margin RowLines, and the last row is reachable.
- `test/query.test.ts`: `matchedTree` equals an independent `expandedTree` oracle (sets and order), including the `level:` scope and the grammar-rejected fallback.
- `test/perf.test.ts`: one memo build per snapshot; on-demand tool counts equal the old sweep for every owner at every level; sliced sidebar counts.

### Baseline failures
These fail identically on a detached `origin/v2` worktree and are unrelated to this branch.
- `test/teaching.test.ts`:
  - "a plugin origin does not survive Skill.Info decoding, so the skill matches by id"
  - "the release workflow is listed under Plus skills without relabeling unrelated skills"

  In both, the fixture passes `location`, while the schema's `Skill.Info` now requires `path`.
- `test/teams`:
  - "Corrections by followup: off refuses a correction with its words, on queues it"
  - "followup reaches a grandchild only while the caller's Deeper descendants row for team_followup is on"
  - "run state machine (02 §1) > representative undocumented pairs are refused with E_TRANSITION"
- `test/model.test.ts`: "a model update for a current team agent missing from the registry still lands". This one is order-dependent:
  - it fails in the batch `bun test test/apply.test.ts test/catalogues.test.ts test/model.test.ts test/log.test.ts test/assembled.test.ts` on both trees (143 pass / 1 fail each);
  - it passes when `model.test.ts` runs alone (45 pass) on both trees.

## 4. Verified where

| claim | verified by |
|---|---|
| Instructions speed and every key < 60 ms | route harness on the live snapshot (above), and live `dev:live` on the real workspace |
| `ctrl+x p` opens Instructions and is a no-op while open | plugin test, and live `dev:live` |
| warm reopen | harness (70–89 ms), and live (79 ms) |
| filter speed and windowing | harness, and live |
| one memo per snapshot | unit/harness counting test with a demonstrated failing control |
| project-mode removal, gate removal, `.opencodeplus` auto-create, read paths creating nothing, `protectedAgents` under ancestors | **plugin tests only**. The live server still runs r4.8 server code, so these are *not* live-verified. No lab runtime was used. |
| team tab throttle | counting test only; not observed live |

## 5. Notes and remaining risks

- Plus is now active in every directory. Global/Defaults customizations, teaching and tooling apply outside former project-mode directories.
- An auto-created `.opencodeplus/` appears as untracked in a repository's `git status` after the first project-scoped write.
- The activation cost (discoverAll + publishFresh) is now paid for every Location. **It was not measured on a real host in this work**; measure it in an owned lab runtime before release.
- `packages/sdk/test/instructions-agent-controls.test.ts` dropped its `plus["project.enable"]` call, which no longer typechecks.
- `packages/tui/test/fixture/tui-client.ts` still stubs `/api/rpc/opencode.plus/project.status`. Nothing calls it any more; it was left alone because it is outside `packages/plus`.
- `expandedTree` stays in `tree.ts` as the test oracle. The TUI no longer calls it.
- A filter matching ~15k rows now renders (~1.1 s) instead of crashing, but it is still slow. Narrow filters are fast.
