# Category Routing & Delete Isolation Live Acceptance — Fresh Owned Build (T107)

Live acceptance of category display-only routing (#14/T8): an explicit category
header is the only `d` that deletes a category, content and sidebar rows keep
their own delete path, Models `a` offers a contextual Model/Category choice,
and rename is the explicit `shift+r`. This receipt is a correction of the
preserved but unaccepted T101 draft; it is not derived from that draft's
claims, and no old `attempt1done` is treated as acceptance.

## Build under test

- Worktree: `/home/bliss/OpenCodePlus/run/plus/data/opencodeplus/teams/worktrees/opencode/Flash-C-Worker/t1078072-20261005-0930`
- Branch: `team/Flash-C-Worker/t1078072-20261005-0930`
- Task: T107 (fresh continuation after the Flash-C quota run; preserved T101 input applied locally)
- Base commit: `b6835471ee1b6b088d717ebff565d345c4da430f`
- Commits: `bbb0da353e` (source + tests) then receipt-correction commits at HEAD
- Owned PTY sessions: `continuation-category`, `continuation-category2`,
  `continuation-category3`, `continuation-category4`, `continuation-provenance`
- Shared service port 40375: untouched.

### Source/build provenance of the observed screen

Every live observation above ran the candidate source in this worktree, not the
installed `2.0.18-plus-1.1.14` release:

- `opencodeplus-dev .` runs this worktree's `packages/cli/src/index.ts`; the
  owned server PID's actual `cmdline` was
  `…/t1078072-20261005-0930/packages/cli/src/index.ts serve --stdio --port 0`.
- `@opencode/plus` resolves from this worktree to
  `…/t1078072-20261005-0930/packages/plus/src/index.ts` (verified with
  `bun -e 'require.resolve("@opencode/plus")'` from `packages/core`), i.e. the
  candidate `packages/plus/src` in this worktree, not the immutable release.
- The live `a` dialog listed `Model` and `Category` (the candidate
  `dialogs.tsx` change), which the installed release does not implement.
- The only other worktree source PIDs are the owned `packages/plus/src/search/bin.ts`
  children; the immutable `2.0.18-plus-1.1.14` `opencodeplus search-mcp` and the
  other-run PTYs are not part of this build.

A fresh `continuation-provenance` session at HEAD `47cb20c748` re-opened
`Project › Agents › OpenCode › build › Models` and `a` again showed
`Add / [S]elect what to add / Model / Category`, binding the observed behavior
to the candidate source.

## Owned test home

- Dev home: `/home/bliss/OpenCodePlus/run/plus-dev/run-plus-data-opencodeplus-teams-worktrees-opencode-Flash-C-Worker-t1078072-20261005-0930`
- Server log (actual file the server opens): `<home>/data/opencode/log/opencode-local.log`
- Project store: `<home>/project/.opencodeplus/instructions/records.jsonl`
- Global/Defaults store: `<home>/config/opencode/opencodeplus/instructions/records.jsonl`
- Mutable store being written: the owned home above only, never a live controller home.

## Focused checks at HEAD (before live)

Run from `packages/plus`:

- `bun test test/instructions-category-route.test.tsx` → **9 pass, 0 fail** (34 expects).
- `bun test test/categories.test.ts test/workspace.test.ts` → **15 pass, 0 fail** (67 expects).
- `bun test test/instructions-panes.test.tsx` → **11 pass, 0 fail** (389 expects).
- `bun test test/plugin-commands.test.tsx` → **2 pass, 0 fail** (14 expects).
- `bun run typecheck` → exit 0.

The new `test/instructions-category-route.test.tsx` drives the real
`InstructionsRoute` and asserts the actual adapter calls: `modelRemoves` are
derived from the `instructions.mutate` request records (a previously visible
project model with no surviving copy is a real removal), `categoryMutates`
records the real `category.mutate` input, and the header-delete case asserts
`action: "delete"` while the content-delete case asserts no `delete` at all.
The harness restores `OPENCODE_CONFIG_DIR` in `afterEach`.

## Observed screen sequences & evidence

Spawned owned TUI via `pilotty spawn --name continuation-category opencodeplus-dev .`.

### 1. 160-column mode (160×48)

#### Case A: `a` in Models offers Model AND Category, context preserved
- On `Project › Agents › OpenCode › build › Models`, pressed `a`.
- Dialog `Add` / `[S]elect what to add` listed `Model` and `Category`.
- Selected `Model` → went straight to `Model provider` (`cliproxyapi`, `lithosai`, `opencode`);
  no scope/agent prompt, so the Models group context was preserved.
- Selected `cliproxyapi` → `Model` listed `DeepSeek V4.1 Flash (deepseek-ai/DeepSeek-V4.1-Flash…)`.
  The flow was cancelled with Escape before writing; the actual `model.add`
  argument (`level/agent/providerID/modelID`) is asserted by the route test.

#### Case B: Category creation via `a` in Models
- `a` → `Category` → prompt `Category name` with `Your own tab after the built-in categories; move rows into it with m.`
- Entered `Alpha Cat` → Enter.
- Category bar became `Settings  Models  Compaction  Tools 78  Base  System  Alpha Cat`.
- Global store gained `{"type":"category","level":"global","name":"Alpha Cat","order":0,"items":[],"updated":"…07:42:34…"}`.

#### Case C: Inactive model deletion inside a user category keeps the category
- On `Models`, moved the inactive candidate `cliproxyapi/claude-opus-5-5@xhigh` into `Alpha Cat` with `m`.
- Navigated to `Alpha Cat` (`]`), cursor on the `@xhigh` content row, pressed `d`.
- Confirmation: `Remove "cliproxyapi/claude-opus-5-5@xhigh"?` and the message
  `Remove model "cliproxyapi/claude-opus-5-5@xhigh" at this level? …` — **not** a `Delete category` dialog.
- Confirmed. The inactive row disappeared; category `Alpha Cat` remained with its `1 rows`.
- Project store recorded `{"type":"model","…","variant":"xhigh","removed":true,"updated":"…07:43:22…"}`.
  This is the actual inactive-model removal, not only a dialog.

#### Case D: Active model `d` refuses with no writes
- Moved the active `cliproxyapi/claude-opus-5-5@high` into `Alpha Cat`, cursor on its content row, pressed `d`.
- Status: `"cliproxyapi/claude-opus-5-5@high" is the active model here: activate another model first`.
- No confirmation dialog, no store write; the category and row stayed intact.

#### Case E: Header `d` deletes the category and moved rows return home
- With the active row moved into `Alpha Cat`, moved the cursor to the header row `▾ Alpha Cat`.
- `d` → `Delete category "Alpha Cat"? Its rows return to their home categories. This cannot be undone.`
- Confirmed (the confirm dialog focuses `Confirm` only after `Right`/tab; plain `Enter` on `Cancel` cancelled — a real, observed behaviour).
- Status: `Deleted category "Alpha Cat"`. The category record disappeared from the global store
  (`grep '"type":"category"'` → 0) and the model reappeared under `Models`.

#### Case F: Sidebar owner `d` deletes the disposable owner, not the selected category
- At `Global`, created user agent `disposable-agent` from the Build preset.
- Selected user category `Gamma Cat` (present in the tabs), escaped to the sidebar, positioned on `disposable-agent`, pressed `d`.
- Confirmation: `Delete agent disposable-agent?` / `Delete global agent "disposable-agent"?` — **not** `Delete category "Gamma Cat"?`.
- Confirmed: `Deleted agent disposable-agent`; its file `config/opencode/agents/disposable-agent.md` was removed,
  while `Gamma Cat` remained in the global store.

#### Case G: Field Enter/r retains ordinary behaviour; help/hints name `shift+r`
- `Enter` on the `Effort` field opened the variant picker
  `(inherit / none) No variant of its own / high / low / max / medium / xhigh`.
  Selecting `low` produced `cliproxyapi/claude-opus-5-5@low` (active); the
  previous `@high` record became `removed:true` and a new `@low active` record
  was written to the project store. **Actual selection was `low`**, so this
  corrects the preserved draft's "no variant" ↔ `@low` contradiction: the row
  was explicitly added/selected at `low` in the picker.
- `r` on the `Model` field kept its ordinary refusal:
  `"Model" cannot be reset; activate another model or delete the row`.
- `r` on the `Effort` field cleared the local variant override as before
  (row returned to `cliproxyapi/claude-opus-5-5` with `Effort none`).
- Footer hint read `shift+r rename`; the help dialog listed
  `shift+r   rename a user category, user agent, team member or team`.
  Lowercase `r` remained available for reset.
- Limitation: the full model-field reset metadata repair (#6) belongs to a
  parallel worker and is **not** accepted here. Only the ordinary
  Enter/`r` field behaviour above is observed; this receipt makes no claim
  about original-candidate/inherited-variant reset metadata.

### 2. 80-column narrow mode (80×24)

- Resized to 80×24; the stacked single-pane layout rendered the category bar as
  `Settings  Models  Compaction  Tools 78  Base  System  Beta Narrow` and the
  header `▾ Beta Narrow` with its child row.
- Case H (header delete at 80): created `Beta Narrow` via Models `a`, moved the
  active model into it with `m`, squeezed `d` on the header →
  `Delete category "Beta Narrow"? Its rows return to their home categories.`;
  Enter confirmed → `Deleted category "Beta Narrow"`; the category record went
  to 0 and the model returned to `Models`.
- Case I (Model path at 80): `a` → `Model` → `Model provider` → `Model` — the
  contextual group was preserved and no scope prompt appeared. (The add was
  cancelled with Escape before a model was written; the adapter `model.add`
  argument is asserted by the route test rather than claimed live.)
- Case J (field edit/reset at 80): `Right` into the model row expanded the four
  field rows; `Down` to `Effort`, `Enter` opened the variant picker without
  clipping, and `r` cleared the override; `Up` to `Model`, `r` kept the ordinary
  `"Model" cannot be reset…` refusal.
- Case K (sidebar owner at 80): created `Gamma Cat` and `disposable-agent`;
  sidebar `d` on the disposable owner confirmed `Delete agent disposable-agent?`
  and removed the owner, leaving `Gamma Cat`.
- Case L (help & reachability): `?` opened the help with `shift+r` in the
  Change group; Escape returned. With the active model moved into `Gamma Cat`,
  the number key `7` opened `Project › Agents › OpenCode › build › Gamma Cat`,
  `]`/`[` cycled to and back from it, and a text filter (`cliproxyapi`) matched
  the moved row under `Gamma Cat`. `category:Gamma` and `category:Gamma Cat`
   both reported `No matches`: the name match is exact and an unquoted space
   separates terms. The existing query grammar also supports quoted values,
   e.g. `category:"Gamma Cat"` (`query.ts:918–952`); that quoted form was not
   exercised live here. The route test proves the populated `category:<name>`
   path for a space-free name. No spaced-name routing defect is established.
- Case M: Escape from help and dialogs returned to the composer (`Ask anything…`).

## Ownership and cleanup

- Kernel-owned launcher/server/search for the first PTY (derived from
  `/proc/<pid>/{cwd,fd,maps}`):
  - `3674448`: TUI launcher (`…/packages/cli/src/index.ts --standalone <home>/project`)
  - `3674556`: server (`…/packages/cli/src/index.ts serve --stdio --port 0`)
  - `3674661`, `3674734`: `packages/plus/src/search/bin.ts`
- Exited each PTY through the palette (`Ctrl+P` → `exit` → `Enter`); snapshot
  reported `outcome: "exited"`, and the launcher/server/search PIDs were
  verified **ABSENT** afterwards.
- Final kernel scan for the exact dev home and worktree: no `cwd`/`fd`/`maps`
  match for any of the owned runtime PIDs. The only remaining matches are
  unrelated: PID `3650531` is an immutable `opencodeplus search-mcp` release
  binary, and the `continuation-real-cache` PTY belongs to another run; both
  were left untouched.
- Final server log `opencode-local.log` after all five owned PTYs (the three
  routing PTYs, the reachability PTY and the provenance PTY): **1046 lines /
  1016 INFO / 30 WARN / 0 ERROR**. All 30 WARN lines are the expected
  `executor-controlled plugin source refused` notice (the worktree and
  `/home/bliss/OpenCodePlus/.opencode` sources); no ERROR line was recorded.
  (`continuation-real-cache` and `continuation-fields` remain owned by other
  runs and were untouched.)

## Scope

Changes are limited to `packages/plus/src/tui/instructions/{route,dialogs,workspace,help}.tsx`,
`packages/plus/test/{instructions-category-route.test.tsx,instructions-nav.ts,tui.ts}`
and this document. No backend/model-field repair, no `rpc.ts`/`index.ts` edit,
no weakened or skipped test.

## Known reconciliation outside this scope

`packages/plus/test/route.test.tsx` is forbidden to this worker. The intended
Models `a` change adds one `Add` select before `Model provider`, so the test
`a on a member preset's Models group adds a team-scoped model at level preset`
(line 3677) now fails: it expects `["Model provider", "Model"]` while the real
flow is `["Add", "Model provider", "Model"]`. At base this file had **87 pass /
2 skip / 2 fail**; at HEAD it has **86 pass / 2 skip / 3 fail**. The three
failures are:

- the new `Add`-step expectation above (introduced by this task's intended change);
- `enter on a model row edits model, variant, warming, interval and prompt; w is no longer bound`;
- `enter on a model row refuses a model outside the host catalog` (5000 ms timeout).

The last two are pre-existing at base and are the recorded #6/#15 model-row
editor failures owned by the parallel field worker, not this task. The parent
must reconcile line 3677 (one added `Add` step) when landing, or the model-add
affordance change cannot pass that forbidden file.
