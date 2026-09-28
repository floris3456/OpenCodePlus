# /instructions workspace follow-up — implementation plan

Status: **Stages A–G done** (diff completeness, pane-resize extraction, level
navigation, bulk expansion, help, resizable panels plus the `W` keyboard
resize mode, live lab acceptance, and the post-acceptance resize-direction
correction). The lab found and fixed one host
regression from the upstream merge: the plugin runtime allowlist did not
expose the extracted `createPaneResize`, so no plugin registered at all until
it was added (`fix(tui): expose pane resize to plugin runtime modules`). This
document is the implementation-ready plan for the follow-up work
approved by the human owner of the `/instructions` screen. See
"§16 Implementation status" for what shipped; the diagnostic material in §8
is kept as written.

- Worktree: `worktrees/r4-8/opencode` (branch `r4-8`, base `04dfd7934`).
- Product area: `@opencode/plus` TUI (`/instructions` workspace) plus the
  dependency-safe extraction of one generic TUI helper.
- Authority: **all changes stay local** in this worktree/task branch. No push,
  no rebase, no force, no release promotion; the existing release workflow is
  the only path to a build, and it is out of scope here.
- Design context: `packages/plus/docs/instructions-redesign.md` (design A),
  `packages/plus/SPEC.md` ("Screen layout", "Review (§3.6)").

## 1. Goals and non-goals

### Goals

- G1 — Level navigation: keep the mouse tabs and `<` / `>`; add
  `Shift+Tab` (next), `Shift+Left` / `Shift+[` (previous),
  `Shift+Right` / `Shift+]` (next), and `Shift+1..4` direct
  Project / Global / Defaults / Presets; preserve owner, category, row and
  expansion state across a level change where the destination has the node.
- G2 — Resizable outer panels: left Owners and right Inspector widths are
  mouse-draggable with no mode, the middle list absorbs space, double-click
  resets, widths clamp so the list stays usable, they persist client-local
  across TUI restarts, and narrow mode is unaffected while saved widths return
  in wide mode.
- G3 — Keyboard resize mode without `Ctrl+M`: uppercase `W` (`shift+w`)
  primary, `alt+w` alias; starts at Owners; `Left` / `[` move the selected
  divider left and `Right` / `]` move it right (the Inspector's width moves
  opposite its divider, see §3.3), `Tab` / `Shift+Tab` cycle
  Owners/Inspector, `Enter` or `Escape` save and exit; footer and the active
  semantic divider highlight.
- G4 — Bulk row expansion: `E` toggles all expandable rows in the
  hovered/focused Owners or list pane except the active row; `Ctrl+E` includes
  the active row; if any eligible row is collapsed expand all, otherwise
  collapse all; lowercase `e` stays edit; mouse hover wins over keyboard
  selection.
- G5 — Help: geometrically centered, balanced columns, the background
  workspace rendered unfocused/dim (not highlighted), and exact focus/selection
  restored on close.
- G6 — Diff completeness defect: in the three-comparison review/compare diff,
  show the complete text of both sides in every comparison so no text is
  missing and the tabs share a consistent line universe; keep compact hunks
  everywhere else.

### Non-goals

- NG1 — No new design surface: the workspace layout, categories, sidebar
  semantics, dialogs, state layer, query grammar and existing key actions stay
  as they are except where this plan says otherwise.
- NG2 — No changes to `/diff` (session diff), the permission prompt, the
  session editor preview, or plus tool output diffs: those keep the compact
  3-line-context patch.
- NG3 — No remote push, release promotion, migration or cleanup; no changes to
  `agents/*.json`; no Cairn/Beads operations.
- NG4 — No speculative guards (huge-text caps, change-only toggles, extra help
  scroll keys) — see Deferred.

## 2. Reference inventory (read before implementing)

### Plus/TUI

- `packages/plus/src/tui/instructions/route.tsx` — route, keymap layer, hints,
  wide/narrow layout, `showLevel`, `toggleFocus`, `openHelp`, mode switching,
  `WIDE_THRESHOLD = 110`, `SIDEBAR_WIDTH = 30`, `fitHints`.
- `packages/plus/src/tui/instructions/workspace.ts` — `LEVELS`,
  `workspaceOf` slices (`nav`, `owner`, `categories`, `category`, `list`),
  `canExpand`, `Row` shape (`expandable`, `expanded`, `depth`, `key`).
- `packages/plus/src/tui/instructions/row.tsx` — `RowLine` selection/focus
  styling (`background.action.primary.focused` when focused,
  `background.raised.high` when selected but unfocused), `CURSOR`, `KeyHints`.
- `packages/plus/src/tui/instructions/help.tsx` — `HELP` table, `HELP_WIDE`,
  `HelpDialog`, current two-column split and `ui.dialog` usage.
- `packages/plus/src/tui/instructions/diff-pane.tsx` — `comparisonsOf`,
  `patch`, `patchCounts`, `<diff>` props, `v`/`1-3`/tab keys, `e` merged edit.
- `packages/plus/src/instructions/diff-lines.ts` — `unifiedDiff`,
  `changedLines`, `merge3`; `const context = 3`; hunk merge rule; hunk
  renderer.
- `packages/plus/src/instructions/model.ts` — `threeWay()` inputs
  (`original = basedOnText`, `mine`, `upstream = resolved above`).
- `packages/plus/src/tui/instructions/state.ts` — `threeWay(node)`,
  `resolvedText`, save/resolve paths (unchanged by this plan).

### Plugin/TUI host contracts

- `packages/plugin/src/tui/context.ts` — `Storage` (`memory()` ephemeral,
  `store()` durable), `Keymap`, `DialogOptions` (`size`, `centered`).
- `packages/tui/src/plugin/api.tsx` — storage namespace
  (`plugin.<pluginId>.<key>`), `ui.dialog.set` → `setSize`/`setCentered`.
- `packages/tui/src/ui/dialog.tsx` — dialog stack, `centered` layout
  (`justifyContent="center"`, no `paddingTop`), backdrop dim, `refocus()`.
- `packages/tui/src/context/keymap.tsx` — layer factory (plugin layers default
  to mode `base`), comma bindings, managed textarea layer (target-scoped).
- `packages/tui/src/config/keybind.ts` — `agent.cycle` = `shift+tab`;
  `input.delete.word.backward` = `ctrl+w,…`; `input.line.end` = `ctrl+e`.
- `packages/tui/src/ui/pane-resize.ts` + `pane-resize-handle.tsx` — generic
  mouse resize state machine (drag, 300 ms double-click reset, external
  preference sync, clamp) and the theme-coupled handle.
- `packages/tui/src/app.tsx`, `packages/tui/src/component/session-frame.tsx` —
  production `createPaneResize` usage (`fromMouse`, `contains`, `onCommit` to
  durable storage).

### Renderer/keymap facts (opentui 0.5.10)

- `@opentui/core` `parseKeypress`: legacy uppercase letters arrive as
  `{name: "<letter>", shift: true}`; shifted punctuation arrives as the glyph
  with no shift flag; Kitty arrives as the glyph with `shift: true` (and may
  also resolve a base-layout key); `\r` (Ctrl+M) decodes as `return` before
  ctrl-letter handling.
- `@opentui/core` `DiffRenderable`: parses `patches[0]`, renders only
  `hunk.lines`, consumes `@@` headers, and has no gap/ellipsis row.
- `@opentui/keymap` binding parser: `modifier+name`, names lowercased; comma
  alternatives supported by the host (`registerCommaBindings`).
- Keymap resolution (documented by `test/instructions-escape.test.tsx`):
  priority descending, then newest registration; route layers are registered
  after app layers and win ties at equal priority.

### Plus test harness

- `packages/plus/test/tui.ts` — `renderPlusFixture`/`renderInstructionsRoute`,
  raw `Plugin.Context` stub (keymap layer capture, storage stubs, dialog stub),
  `typeText`, `resize`, `captureCharFrame`/`captureSpans`.
- `packages/plus/test/instructions-nav.ts` — `dispatch` (comma-aware), `reach`,
  `gotoLevel`, `selectedRow`, `breadcrumb`, `footer`.
- `packages/plus/test/instructions-escape.test.tsx` — layer snapshot + winning
  escape model (priority/order), route dialog-call counting.
- `packages/plus/test/instructions-diff-split.test.tsx`,
  `test/workspace-route.test.tsx`, `test/diff-lines.test.ts`,
  `test/perf.test.ts`.
- `@opentui/core/testing` `createTestRenderer` also returns `mockMouse`
  (`moveTo`, `click`, `doubleClick`, `pressDown`, `drag`, `release`), which the
  fixture does not expose yet.

## 3. Key table and terminal aliases

### 3.1 Browse-mode keys (route layer)

| Key (bind string) | Action | Notes |
|---|---|---|
| `tab` | switch pane (sidebar ⇄ list) | unchanged |
| `shift+tab` | **next level** | was "switch pane"; now level |
| `<` / `>` | previous / next level | unchanged, wraps |
| `shift+left`, `shift+[`, `{`, `shift+{` | previous level | alias set, see 3.2 |
| `shift+right`, `shift+]`, `}`, `shift+}` | next level | alias set, see 3.2 |
| `shift+1`, `!`, `shift+!` | Project | direct jump |
| `shift+2`, `@`, `shift+@` | Global | direct jump |
| `shift+3`, `#`, `shift+#` | Defaults | direct jump |
| `shift+4`, `$`, `shift+$` | Presets | direct jump |
| `[` / `]` | previous / next category | unchanged in browse |
| `1`–`8` | category by index | unchanged |
| `shift+w`, `alt+w` | **enter keyboard resize mode** | wide layout only |
| `shift+e` | **bulk expand/collapse except active row** | new |
| `ctrl+e` | **bulk expand/collapse including active row** | new |
| `e` | edit text | unchanged (lowercase) |
| `c`, `p`, `a`, `l`, `d`, `r`, `s`, `n`, `shift+n`, `/`, `?`, `space`, `ctrl+space`, arrows, `enter`, `escape` | unchanged | |
| mouse tab click | switch level | unchanged |

### 3.2 Terminal alias rationale (why each bind exists)

- Binding names are lowercased by `@opentui/keymap`, so `shift+w`, `shift+[`,
  `shift+1` are the canonical modifier forms; uppercase `W`/`E` in bind strings
  would normalize to the unshifted name and never match.
- Legacy terminals: `Shift+1..4` → `!@#$` with `shift: false`; `Shift+[`/`]` →
  `{`/`}` with `shift: false`. Hence the glyph aliases.
- Kitty keyboard protocol: the same keys arrive as the glyph name with
  `shift: true` (e.g. name `!`, shift true). Hence the `shift+<glyph>` aliases.
  If a terminal additionally reports a base-layout key, the existing
  base-layout fallback resolves the `shift+<digit>`/`shift+[` form too, so all
  spellings of the user gesture work.
- Comma-separated bind values are the host's existing multi-binding syntax
  (`config.keybind.ts` uses it; the test `dispatch` helper splits on commas).
- `Ctrl+M` is impossible: byte `0x0D` decodes as `return` before any ctrl-letter
  mapping, so it can never fire as a shortcut (the reason it was excluded).
- `ctrl+w` is rejected even though it decodes reliably: it is globally bound to
  `input.delete.word.backward` and is a destructive editing convention.
- `shift+e` and `shift+w` have no binding anywhere in `packages/tui`,
  `packages/plus` or `packages/plugin`; `ctrl+e` is only bound to
  `input.line.end` inside the target-scoped managed-textarea layer, and the
  resize/expand commands are browse-mode-only, so no live conflict exists.

### 3.3 Resize-mode keys (same layer, swapped command set)

| Key | Action |
|---|---|
| `left`, `[` | move the selected divider one column left |
| `right`, `]` | move the selected divider one column right |
| `tab`, `shift+tab` | cycle Owners → Inspector → Owners |
| `return` | save widths and leave resize mode |
| `escape` | save widths and leave resize mode |
| `shift+w`, `alt+w` | save widths and leave (toggle) |

The keys move the divider, not the panel's width: Owners grows as its divider
moves right, and the Inspector's divider is the panel's left edge, so the
Inspector grows as the divider moves left (its width delta is the negative of
the key direction). Clamps, persistence, save/exit and the mouse mappings are
unchanged. No other browse command fires while resize mode is active. Footer
and the selected panel's divider highlight.

## 4. Level navigation

### 4.1 Behaviour

- `showLevel(next)` stays the single place-preserving switch. Reuse it for all
  new keys. In addition to the existing owner/category/list-row mapping
  (`route.tsx` `across`), map the three expansion sets — `navCollapsed`,
  `listOpen`, `listCollapsed` — through the same anchored id rewrite
  (`^(<kind>):<from>:` → `^(<kind>):<next>:`). Destination levels without the
  node simply carry inert ids; `workspaceOf` already ignores unknown ids and
  `known` is keyed per level.
- `shift+tab` calls `switchLevel(1)` (wrapping like `>`). Remove `shift+tab`
  from `toggleFocus`; `tab` alone keeps pane switching.
- Direct jumps call `showLevel("project" | "global" | "defaults" | "preset")`.
- New level keys are browse-only: not while filtering (the filter layer has its
  own command set), not in edit/diff/split modes, not in resize mode.
- Mouse tabs and `<`/`>` are not touched.

### 4.2 Tests

- `shift+tab` moves to the next level and wraps; `tab` still switches pane.
- Every alias of previous/next (`shift+left`, `shift+[`, `{`, `shift+{`;
  `shift+right`, `shift+]`, `}`, `shift+}`) switches the level.
- Every alias of `shift+1..4` lands on the named level.
- `<`/`>` regression stays green.
- Preservation: after expanding `item:<level>:build:tool:bash`, switching to
  another level that also has build→bash keeps the expansion; owner, category
  and selected row map as today.
- Mouse click on a level tab still switches the level (mockMouse).
- Narrow width (80 cols): all new keys still work.

## 5. Resizable outer panels

### 5.1 Constants and clamps (new `panels.ts`)

- `OWNERS_DEFAULT = 30` (today's `SIDEBAR_WIDTH`).
- `OWNERS_MIN = 24`, `INSPECTOR_MIN = 24`, `MIN_LIST = 30`.
- `defaultInspector(width, owners) = floor((width - owners) * 2 / 5)` — the
  current 3:2 list:inspector split of the area right of the sidebar.
- `clampOwners(size, width, inspector)` =
  `clamp(OWNERS_MIN, size, max(OWNERS_MIN, width - inspector - MIN_LIST - DIVIDERS))`;
  `clampInspector(size, width, owners)` symmetric with `INSPECTOR_MIN` (the
  shipped implementation subtracts both divider columns, `DIVIDERS = 2`).
  Both are pure functions so the unit tests can pin every boundary and the
  two-panel clamp converges (each commit re-clamps against the peer's current
  effective size).
- Sizes apply only in wide mode (`dimensions().width >= WIDE_THRESHOLD`).
  Narrow mode renders exactly as today, writes nothing, and ignores saved
  values; when the terminal returns to wide, saved values are re-clamped and
  re-applied (they "return" unless the terminal is now too small).

### 5.2 Layout

- Wide `Browse`: `Owners (fixed width) | divider | List (flexGrow 1, minWidth 0) |
  divider | Inspector (fixed width)`.
- Replace the inspector's `border={["left"]}` with explicit 1-column divider
  boxes so each divider owns its colour, mouse target and highlight state.
- `listWidth()` (used by the category-tab digit heuristic) must read the same
  effective widths instead of the hardcoded 3/5 split.
- Narrow `Browse` is untouched: sidebar and list are pages, inspector sits
  under the list.

### 5.3 Mouse

- Reuse the extracted state machine (`createPaneResize`) twice, one instance
  per divider; attach `onMouseDrag` / `onMouseDragEnd` / `onMouseUp` to the
  wide Browse root (as `app.tsx`/`session-frame.tsx` do), and
  `onMouseOver` / `onMouseOut` / `onMouseDown` to each divider.
- Owners mapping: `fromMouse = event.x + 1`,
  `contains = (event, size) => event.x >= size - 1 && event.x <= size`.
- Inspector mapping: `fromMouse = dimensions().width - event.x - 1`,
  `contains = (event, size) => event.x >= dimensions().width - size - 1 && event.x <= dimensions().width - size`.
- Double-click reset is already implemented by the shared helper (clean
  release then a second press within 300 ms): Owners → `OWNERS_DEFAULT`;
  Inspector → `defaultInspector(current width, owners)`.
- No mode: a drag anywhere after pressing a divider resizes it; the other
  instance ignores the event because it is not resizing.
- Hover and drag both highlight the divider (`background.raised.high` while
  hovered/dragging is the shared helper's visual convention; use
  `background.action.primary.hovered` if a distinct action state is preferred —
  see 5.6).

### 5.4 Persistence

- `const [panels, savePanels] = context.storage.store<{ owners?: number; inspector?: number }>("opencode.plus.instructions.panels", { initial: {} })`.
- This is the durable TUI-local store (survives hot reload and TUI restarts);
  `storage.memory` is not acceptable because it dies with the TUI. The host
  namespaces it as `plugin.opencode.plus.<key>` on disk and live-syncs across
  running TUI instances.
- Writes are async: `void savePanels(draft => { … }).catch(error => console.error(...))`;
  a failed write must never crash or block the UI.
- The selection `View` (level/owner/category/rows/expansions) stays in
  `storage.memory` exactly as today.

### 5.5 Keyboard resize mode

- Signals: `resizing: "owners" | "inspector" | undefined` and a
  `resizeDraft: { owners: number; inspector: number }` seeded on entry from the
  effective widths. Effective width = draft while resizing, otherwise the
  mouse-managed/clamped preference.
- Entry: `shift+w` or `alt+w`, only when `wide()`. Start on Owners. If the
  terminal becomes narrow while resizing, save and exit automatically.
- Step: 1 column per press, clamped with the same functions.
- `Enter` and `Escape` both save (single `savePanels` write of the pair) and
  exit; `shift+w`/`alt+w` toggles out. Exiting never closes the route and never
  changes the pane focus, selected row, category or expansion.
- The keymap layer gains a resize branch that returns only the resize
  commands; the footer uses `KeyHints` with
  `←/[ move divider left · →/] move divider right · tab panel · enter/esc save`.
- The selected panel's divider gets the active highlight (5.6); the other
  divider stays idle.

### 5.6 Divider highlight token

- Idle: `border.base`.
- Hovered/dragging/keyboard-active: `background.action.primary.hovered`
  (an action-role state token; no raw hues, no borrowed feedback token).
- Verify the built-in light and dark defaults and the custom-theme fallback
  when changing this surface; the test theme in `test/tui.ts` already carries
  the action state set.

### 5.7 Tests

- Drag Owners right/left and Inspector left/right; assert divider column and
  that the middle list changed by the same delta.
- Clamp: dragging Owners to the far right stops so the list keeps `MIN_LIST`;
  same for Inspector; shrinking the terminal re-clamps on render.
- Double-click resets Owners to 30 and Inspector to `defaultInspector`.
- Keyboard mode: `W` enters (footer changes, divider highlighted), `Left`/`[`
  and `Right`/`]` move the selected divider by one column (asserted on the
  divider column, not just the stored width; the Inspector's width moves
  opposite the key), `Tab`/`Shift+Tab` cycles, `Enter` and `Escape`
  save and exit, focus/selection unchanged.
- Persistence: a shared storage backing map across two fixtures — drag in
  fixture A, destroy, render fixture B with the same map, assert the saved
  widths — proving `storage.store` (not `memory`) is used.
- Narrow unaffected: at 100 cols the layout has no dividers and two pages; at
  130 cols the saved widths return.
- Narrow while resizing auto-saves and exits.

## 6. Bulk row expansion (`E` / `Ctrl+E`)

Exact semantics:

1. **Target pane**: the pane whose row the mouse is over (hover wins), else the
   keyboard-focused pane.
2. **Active row**: the hovered row when the hover selects the target pane,
   otherwise the selected row of that pane (`navRow()` / `listRow()`).
3. **Eligible rows**: every row in the target pane with `expandable === true`.
4. **Direction**: if *any* eligible row is collapsed → expand all eligible;
   otherwise collapse all eligible. (Expanding and collapsing are bulk set
   operations, not per-row toggles, so mixed states converge.)
5. `shift+e` excludes the active row from both eligibility and the direction
   decision; `ctrl+e` includes it.
6. Lowercase `e` remains the list's edit-text command and is untouched.

Implementation notes:

- Track hover with `RowLine` `onMouseOver` / `onMouseOut` callbacks feeding a
  `hovered: { pane; key } | undefined` signal (sidebar and list rows both).
- Sidebar changes edit `navCollapsed`; list changes edit `listOpen` /
  `listCollapsed` — do not reuse `setOpen()` because it derives the pane from
  `focus()`.
- Bind only while browsing (not filtering/editing/diff/split/resizing).
- Nothing to do (no eligible rows) is a silent no-op.

Tests: expand-all from any-collapsed; collapse-all when all are expanded;
excluded vs included active row; hover-wins over focus (hover a sidebar row
while the list is focused and assert the sidebar changed, and vice versa);
lowercase `e` still opens the editor; narrow mode works on the list page.

## 7. Help

### 7.1 Centering

- `openHelp` (route) must call
  `context.ui.dialog.set({ size: dimensions().width >= HELP_WIDE ? "xlarge" : "large", centered: true })`
  after `show(...)`. `replace()` resets `centered` to false, so the call order
  matters; with `centered: true` the dialog host centers on both axes
  (no quarter-height top padding).

### 7.2 Balanced columns

- Replace the fixed `[HELP.slice(0, 2), HELP.slice(2)]` split with a helper
  that estimates each group's rendered height (1 title line + per-key
  `max(1, ceil(label.length / labelWidth))`, `labelWidth ≈ columnWidth - 14`)
  and chooses the contiguous cut that minimizes the taller column, preserving
  group order. One column below `HELP_WIDE` (124). Columns stay equal width
  (`flexGrow 1`, `flexBasis 0`).
- Export the splitter for a unit test asserting the height difference is
  minimal across the real `HELP` table and that all six groups are present.

### 7.3 Background unfocused/dim

- Derive `modal = () => context.keymap.mode.current() === "modal"` (the dialog
  host pushes `modal` for the whole dialog stack) and pass
  `focused={focus() === "nav" && !modal()}` /
  `focused={focus() === "list" && !modal()}` into `RowLine`, so the selected
  row uses the unfocused `background.raised.high` style and no cursor while any
  dialog (including help) is open. The backdrop already dims the screen.
- The route's own focus/selection/expansion signals are never written by
  opening or closing help; restoring the renderable focus is the dialog host's
  existing `refocus()` behaviour.

### 7.4 Content

- `HELP` gains the new level keys (`shift+tab`, `shift+[ ]`, `shift+1–4`), the
  `W` resize mode (and its keys), and `E` / `ctrl+E` bulk expansion; the filter
  grammar text is unchanged.

### 7.5 Tests

- `ui.dialog.set` receives `centered: true` and the expected size at ≥124 and
  below it (fixture records `dialog.set` calls).
- Frame at 130×45: all six group titles visible, two columns, equal column
  starts; at 100×40: one column, no wrapping breakage.
- Dim: with the fixture's mode set to `modal`, the selected row's background
  span is the unfocused style; with `base` it is the focused style; after
  restoring `base`, the previously captured frame (cursor row, breadcrumb,
  footer) is identical to before help opened.

## 8. Diff completeness defect (three comparisons)

### 8.1 Reproduction (done in a scratch probe outside the repo)

Scenario: 120-line text; `mine` changed lines 40–90 and line 11; `upstream`
changed line 100. Rendering the real `DiffPane` at 120×30 (split default):

- **Upstream change** shows only lines 97–103 (hunk around line 100);
  `pagedown` does nothing because there is nothing else in the component.
- **Your change** shows two disjoint bands, lines 7–13 and 67–73.
- **Take result** shows three bands (7–13, 37–43, 67–73).
- Line numbers jump between bands (13 → 67) with no gap marker.

Every band is a standard 3-line-context hunk, so each comparison highlights a
different window and the screen reads as truncated/inconsistent. Re-running the
same component with only the patch context changed to "all" shows lines 1–120,
scrolls to the final line, and keeps the same visible lines (and scroll offset)
when switching tabs.

### 8.2 Proven root cause

1. `diff-pane.tsx` builds each tab's patch with `unifiedDiff(left, right, …)`
   and passes it straight to `<diff>`.
2. `diff-lines.ts` emits only changed hunks with `const context = 3`
   (three context lines each side; hunk merge when gaps are ≤ 6 ops).
3. `@opentui/core` `DiffRenderable` consumes `@@` headers and renders only
   `hunk.lines`; it has no ellipsis/gap row, and it never receives the omitted
   lines at all.

Therefore unchanged text is absent from the component, and because the three
comparisons differ in *where* they change, each tab shows a different subset of
lines. Not causal: scrolling (it works when content exists), dimensions
(same behaviour narrow/wide), wrapping (long lines wrap correctly), and the
comparison inputs (`threeWay()` = original/mine/upstream is correct).

### 8.3 Comparison semantics (correct definition)

| Tab | Left (from) | Right (to) | Meaning |
|---|---|---|---|
| Upstream change | complete original upstream | complete new upstream | what changed above you |
| Your change | complete original upstream | complete yours | what you overrode |
| Take result | complete yours | complete new upstream | what `t` would produce |

All three render complete text on both sides with changes highlighted; line
numbers are continuous per side. In read-only compare mode (`c`) the single
"Your change" comparison is complete too. The tab labels and `+N/-N` counters
stay as they are; counters keep counting changed lines only.

### 8.4 Fix

- `unifiedDiff(original, modified, range, options?: { context?: number })`;
  default `3` preserves every existing caller. `hunksOf` takes the context as
  a parameter; `context = Number.POSITIVE_INFINITY` produces one full-range
  hunk with correct header counts (empty↔text, insert start/delete end and
  no-final-newline all verified in the probe).
- `DiffPane` passes the complete-context option for its `patch()` memo only.
  `patchCounts()` (tab headers), `editor-pane.tsx` preview, `tools.ts` and
  `query.ts` keep compact context.
- Keep the scroll offset across tab switches (same line universe); clamp only
  if the new patch is shorter.
- No cap for large texts initially; a 400-line complete patch builds in ~2 ms
  and renders/scrolls correctly. If a real text is ever huge enough to matter,
  add a cap in a follow-up with evidence (see Deferred).

### 8.5 Regression tests

- `diff-lines.test.ts`: complete-context output contains every line of both
  sides, one header with exact counts, and no elided middle region; edge cases
  (empty→text, text→empty, insert start/delete end, no final newline,
  content lines that look like `@@`/`---`/`+++`).
- New `instructions-diff-complete.test.tsx` (mount `DiffPane`):
  - complete text per tab: an unchanged line far from any change (e.g. line 70)
    appears in every tab; each tab's changed regions are present.
  - consistent line visibility: pick an unchanged line number and assert it is
    visible in all three tabs at the same scroll offset.
  - tab switching keeps the shared line universe (and scroll offset).
  - scrolling reaches the last line in wide split and narrow unified.
  - narrow (<120, unified) and wide (split) both complete; `v` still toggles.
  - long line (>300 chars) wraps in narrow with its tail reachable.
  - no final newline: last line shown, no phantom extra line.
  - conflict-marker text (`<<<<<<< yours` … `>>>>>>> upstream` as literal
    content lines) renders completely in all tabs; the existing merged-edit
    and refusal tests stay green.
- One renderer-boundary test that mounts the complete patch in a raw `<diff>`
  and asserts no `Error parsing diff` and all lines present (patch construction
  × renderer contract).

## 9. Exact expected files

Source:

- `packages/plus/src/instructions/diff-lines.ts` — context option.
- `packages/plus/src/tui/instructions/diff-pane.tsx` — complete-context patch.
- `packages/plus/src/tui/instructions/route.tsx` — level keys, expansion
  mapping, panel widths/dividers/mouse, resize mode, `E`/`ctrl+E`, help
  centering, hints.
- `packages/plus/src/tui/instructions/help.tsx` — balanced splitter, new keys.
- `packages/plus/src/tui/instructions/row.tsx` — hover callbacks.
- New `packages/plus/src/tui/instructions/panels.ts` — defaults/clamps/pure
  helpers.
- `packages/plugin/src/tui/pane-resize.ts` (moved from
  `packages/tui/src/ui/pane-resize.ts`), `packages/plugin/src/tui/index.ts`
  (export).
- `packages/tui/src/ui/pane-resize.ts` — deleted after the move.
- `packages/tui/src/app.tsx`, `packages/tui/src/component/session-frame.tsx`,
  `packages/tui/src/ui/pane-resize-handle.tsx` — import the shared helper.
- `packages/tui/test/ui/pane-resize.test.ts`,
  `packages/tui/test/ui/pane-resize-handle.test.tsx` — import path only.

Docs:

- `packages/plus/SPEC.md` — "Screen layout" and "Review (§3.6)".
- `packages/plus/docs/instructions-redesign.md` — §2.2 complete-text diffs,
  §4 key table, surviving state (panel widths), status note.
- `packages/plus/docs/instructions-workspace-followup.md` — this plan.

Tests (plus):

- `test/tui.ts` — fixture additions: `mockMouse`, writable keymap mode signal,
  optional shared storage backing map, recorded `dialog.set` calls.
- `test/diff-lines.test.ts`, new `test/instructions-diff-complete.test.tsx`,
  new `test/instructions-levels.test.tsx`, new
  `test/instructions-panels.test.tsx`, new `test/instructions-expand.test.tsx`,
  new `test/help.test.tsx`; keep `workspace-route`, `instructions-escape`,
  `instructions-diff-split`, `instructions-panes` green.

## 10. Staged implementation sequence

One writer per file; the route file is the only shared hotspot, so C and D are
serialized. All stages stay in this worktree/branch.

- **Stage 0 — baseline.** Confirm clean status/HEAD; run the focused plus test
  files and `bun typecheck` in `packages/plus` to record the pre-change result.
- **Stage A — diff completeness** (independent of B–E). `diff-lines.ts`
  context option + unit tests; `diff-pane.tsx` complete-context patch; new
  diff tests. Files do not overlap the route.
- **Stage B — pane-resize extraction** (independent of A/C). Move the module
  into `@opencode/plugin/tui`, export it, update the two production imports,
  the handle type import, and the two tui test imports; run the existing
  pane-resize tests in `packages/tui` (they pin drag, double-click, clamp and
  external sync) and `bun typecheck` in `packages/plugin` + `packages/tui`.
- **Stage C — levels + help keys** (route/help hotspot; after B so it can use
  the shared helper if needed, and after Stage 0). `route.tsx` level binds and
  expansion mapping; `help.tsx` splitter + content; `openHelp` centering; dim
  wiring; level/help tests. Keep route edits minimal and in the existing
  sections.
- **Stage D — panels + resize mode + bulk expansion** (after C). New
  `panels.ts`; wide layout rewrite in `route.tsx`; mouse handlers; keyboard
  mode; `E`/`ctrl+E`; `row.tsx` hover; fixture additions; panel/expand tests.
- **Stage E — docs + integration.** Update SPEC/redesign; run the full focused
  matrix; run `bun run check` at the repo root; secret-scan the diff; commit
  locally in small conventional commits (the plan file itself is committed
  separately as `docs(plus): plan instructions workspace follow-up`).
- **Stage F — lab.** Wide/narrow live acceptance below (no promotion).

## 11. Automated test matrix (focused)

Run from package directories (tests cannot run from the repo root):

- `packages/plus`: `bun run typecheck`;
  `bun test test/diff-lines.test.ts test/instructions-diff-complete.test.tsx test/instructions-levels.test.tsx test/instructions-panels.test.tsx test/instructions-expand.test.tsx test/help.test.tsx test/workspace-route.test.tsx test/instructions-escape.test.tsx test/instructions-diff-split.test.tsx`.
- `packages/plugin`: `bun typecheck`.
- `packages/tui`: `bun typecheck`;
  `bun test test/ui/pane-resize.test.ts test/ui/pane-resize-handle.test.tsx`.
- Repository root: `bun run check` (canonical lint/type check).

Coverage intent per requirement:

- Levels: every alias, wrapping, focus unchanged, preservation, mouse tab.
- Panels: drag, double-click, clamp boundaries, keyboard mode, persistence via
  a shared backing map, narrow/wide round trip.
- Expansion: expand/collapse direction, active row included/excluded, hover
  wins, lowercase `e` unchanged.
- Help: centered flag, balanced columns, dim spans, exact restore.
- Diff: complete text, consistent lines, tab switching, narrow/wide, long
  text, no final newline, conflict content, renderer boundary.
- Existing suites stay green (regression control).

## 12. Lab acceptance (live TUI, wide and narrow)

Run `bun run dev:live` from this worktree (per repo AGENTS; explicit `--server`
keeps the elected server). Exercise in a scratch project, never the live
controller's home.

Wide (≥120 cols):

1. Level keys: `Shift+Tab`, `Shift+Left`/`Shift+[`, `Shift+Right`/`Shift+]`,
   `Shift+1..4`, plus `<`/`>` and clicking the tabs; owner/category/row and an
   expanded section survive the switch.
2. Panels: drag the Owners divider right/left; drag the Inspector divider;
   confirm the list absorbs; double-click each divider resets; drag past the
   limit and confirm the list stays usable; restart the TUI and confirm the
   widths persist; press `W`, check the footer and the highlighted divider,
   `Left`/`[`, `Right`/`]`, `Tab`, `Enter`, then `Escape`.
3. `E` and `Ctrl+E` in the sidebar and the list: expand-all from mixed state,
   collapse-all when all expanded, active row excluded vs included, hover on a
   different pane than the focused one.
4. Help: geometry (centered), column balance, workspace dim behind it, and the
   exact same cursor row/breadcrumb/footer after closing.
5. Diff: a review row whose text changed in two distant regions plus a read
   row; all three tabs show the complete text, scroll to the end, keep the
   same lines when switching tabs, and `v` toggles split/unified.

Narrow (<110 cols):

6. Two-page layout unchanged; no dividers; saved widths ignored; resize keys
   do nothing; level/expansion keys still work.
7. Return to wide: saved widths come back (clamped if the width shrank).
8. Diff is unified by default and still complete; a long line wraps and its
   tail is reachable.

Record the terminal(s) used and whether the terminal runs the Kitty keyboard
protocol, since the alias set exists for both.

## 13. Rollback, risks, deferred

Rollback:

- Everything is local commits on `r4-8`; reverting the follow-up commits
  restores the pre-change state. The pane-resize move is a pure relocation plus
  import changes, so `git revert` is clean; no data migration is involved.
- The only persistent artifact is the new storage key
  `plugin.opencode.plus.opencode.plus.instructions.panels` (or the equivalent
  namespaced key); deleting that JSON restores defaults and is not destructive.
- The plan file can be dropped independently of the implementation commits.

Risks and mitigations:

- **Extraction touches shared TUI code.** Existing `packages/tui` pane-resize
  tests pin the moved behaviour; typecheck both packages; keep the handle
  component in `packages/tui` so no theme-context coupling moves.
- **Key conflicts live.** Route layers win ties by registration order, already
  relied on by existing keys; verify `shift+tab` (vs `agent.cycle`) and the new
  aliases live. If a terminal swallows a glyph alias, the other aliases in the
  same bind string cover it.
- **Storage writes.** Async and lock-backed; failures are logged, never fatal.
- **Full-context diffs on large texts.** Same LCS cost as today plus more
  output; no cap initially, measure in the lab with a large fixture; add a cap
  only with evidence.
- **Help balance heuristic.** The estimator must be unit-tested on the real
  `HELP` table so a content change cannot silently unbalance the columns.
- **Theme token choice.** The active divider uses an action-state background
  token; verify light/dark defaults and the custom-theme fallback.

Deferred (in scope, not in this plan):

- A "changes only / complete" toggle for very large texts.
- Help scroll keys beyond the mouse wheel when content exceeds the height.
- A plus-local fallback fork of the resize helper if the extraction is
  rejected by review (not preferred; would duplicate the state machine).

## 14. Autonomous decisions

- Primary resize key `shift+w` (displayed `W`) with `alt+w` alias; `Ctrl+M`
  excluded as unreachable, `Ctrl+W` excluded as a destructive global editing
  binding. `Shift+Tab` is repurposed from pane switching to next level; `Tab`
  keeps pane switching.
- `Enter` and `Escape` are equivalent save-and-exit in resize mode; widths
  persist on exit (mouse persists on release/double-click).
- Resize keys move the selected divider, not a global panel width: `Left`/`[`
  left, `Right`/`]` right. The Inspector width therefore moves opposite the
  key (Stage G corrected this after lab acceptance).
- Panel widths use the durable `storage.store`; the selection `View` stays in
  `storage.memory`.
- Level changes map selection *and* expansion sets "where possible".
- Bulk expansion acts on the whole target pane and chooses direction from
  "any collapsed"; the active row is excluded for `E` and included for `Ctrl+E`.
- Help dimming is derived from `keymap.mode.current() === "modal"`, so every
  dialog dims the workspace, not just help.
- Complete-text diff is the default in the three-comparison pane; compact
  hunks stay everywhere else.
- The pane-resize helper moves to `@opencode/plugin/tui` rather than being
  copied, keeping one implementation and the package direction intact.

## 15. Local-only statement

All work described here is performed in this worktree on branch `r4-8` with
local commits only. Nothing is pushed, rebased, force-updated, tagged or
promoted; no candidate is activated. Release remains a separate, authorized
workflow.

## 16. Implementation status

### Stage A — diff completeness (done, 2026-09-28)

Commit: `fix(plus): render complete instruction diffs` (local, branch `r4-8`).

Shipped exactly as §8.4 specifies:

- `src/instructions/diff-lines.ts`: `unifiedDiff(original, modified, range,
  options?)` with `UnifiedDiffOptions { context?: number }`; `hunksOf` takes the
  context as a parameter. The default is 3, so every existing caller
  (`tools.ts`, `editor-pane.tsx`, the `patchCounts` tab counters) keeps the
  compact patch unchanged.
- `src/tui/instructions/diff-pane.tsx`: the `patch()` memo passes
  `{ context: Number.POSITIVE_INFINITY }`; this is the only caller that does.
  The three comparisons (and the read-only `c` compare) therefore emit one
  full-range hunk with continuous per-side line numbers. No scroll, tab, `v`,
  `k`/`t`/`e` or merge3 behaviour changed; the scroll offset stays on the
  scrollbox and survives a tab switch because the diff renderable is updated in
  place.
- No large-text cap and no changes-only toggle (still Deferred).

Tests (all focused, from `packages/plus`):

- `test/diff-lines.test.ts` — compact default preserved (two hunks, distant
  lines elided, explicit `context: 3` identical to default); complete context
  is one `@@ -1,120 +1,120 @@` hunk containing every line of both sides;
  empty↔text and text↔empty counts; insertions at the start and end; missing
  final newline; content lines that look like `@@`/`---`/`+++`/`=======`.
- `test/instructions-diff-complete.test.tsx` — the §8.1 reproduction
  (120 lines, `mine` changes 11 and 40–90, `upstream` line 100) rendered by the
  real `DiffPane` and the real `<diff>` renderable:
  - each of the three comparisons, scrolled top to bottom, shows every line of
    both of its sides (including distant `line060`) and reaches `line001` /
    `line120`;
  - switching comparisons at one scroll offset keeps `line060` visible;
  - the same completeness in narrow unified (100×30), where `v` still toggles
    split/unified;
  - a >300-char line wraps in narrow with its tail visible;
  - no-final-newline text shows its last line without a phantom line;
  - literal `<<<<<<< yours` / `=======` / `>>>>>>> upstream` content renders
    completely in all comparisons;
  - a complete patch with marker-like content mounts in a raw `<diff>` with no
    `Error parsing diff` and every line present.
  - Pre-fix control: the completeness assertions were run against the reverted
    source and failed there (missing distant lines, unreachable `line060`, raw
    patch missing most lines); the no-final-newline and long-line cases pass
    both before and after, as regression guards.

Focused matrix after the change: the two files above plus
`test/instructions-diff-split.test.tsx`, `test/instructions-panes.test.tsx`,
`test/workspace-route.test.tsx`, `test/instructions-escape.test.tsx` and
`test/route.test.tsx` — 143 pass / 0 fail (2 pre-existing skips in
`route.test.tsx`); `bun run typecheck` in `packages/plus` and
`/home/bliss/OpenCodePlus/bin/bun run check` at the repository root clean.

Docs updated for the fix: `SPEC.md` "Review (§3.6)" and
`docs/instructions-redesign.md` (implementation-status bullet and §2.2).

### Stage B — pane-resize extraction (done, 2026-09-28)

Commit: `refactor(plugin): share pane resize controller` (local, branch `r4-8`).

- The state machine moved unchanged to `packages/plugin/src/tui/pane-resize.ts`
  (from `packages/tui/src/ui/pane-resize.ts`, now deleted). It imports only
  `@opentui/core` and `solid-js`, both already optional peer dependencies of
  `@opencode/plugin`, and stays a Solid reactive helper (no Effect/Promise
  domain). `createPaneResize(options)` is exported by name from
  `@opencode/plugin/tui` (`packages/plugin/src/tui/index.ts`). Option and
  return shapes are untouched, so clamping, preferred vs transient size,
  parent-owned drag/release, the left-button filter, commit-on-release,
  double-click reset and the hover/resizing signals behave exactly as before.
- Callers now import through `@opencode/plugin/tui`:
  `packages/tui/src/app.tsx` and
  `packages/tui/src/component/session-frame.tsx` (production),
  `packages/tui/src/feature-plugins/system/storybook/session-tabs.tsx`
  (grep-discovered third caller), `packages/tui/src/ui/pane-resize-handle.tsx`
  (type-only) and the two tests. `PaneResizeHandle` stays in `packages/tui`
  because it reads the theme context (§13).
- Verification (from `packages/tui`):
  `bun test test/ui/pane-resize.test.ts test/ui/pane-resize-handle.test.tsx` —
  9 pass / 0 fail (dark + light handle renders, drag, clamp, 300 ms reset,
  external sync); `bun typecheck` clean in `packages/plugin` and
  `packages/tui`; focused plugin build (`tsc -p tsconfig.build.json`) clean,
  emitting `dist/tui/pane-resize.js`/`.d.ts` and the re-export in
  `dist/tui/index.d.ts`; `bun run check` at the repository root clean
  (oxlint 0 warnings/0 errors, 36/36 turbo typecheck tasks) and the
  `/home/bliss/OpenCodePlus/bin/bun run check` workspace check valid.
- Protocol/HttpApi untouched; no generated client files changed.

### Stage C — level navigation + help (done, 2026-09-28)

Commit: `feat(plus): improve instructions navigation` (local, branch `r4-8`).

- `route.tsx` level keys, exactly as §3.1/§4: `shift+tab` switches to the next
  level (wrapping) and is removed from the pane toggle; `tab` alone keeps pane
  switching. Browse-only comma binds: `shift+left,shift+[,{,shift+{` previous
  and `shift+right,shift+],},shift+}` next; `shift+1,!,shift+!` Project,
  `shift+2,@,shift+@` Global, `shift+3,#,shift+#` Defaults,
  `shift+4,$,shift+$` Presets. `<`/`>` and the mouse tabs are untouched. The
  keys are absent while filtering and in edit/diff/split modes; the host's
  `modal` mode disables the whole browse layer while a dialog is open.
- `showLevel` maps `navCollapsed`, `listOpen` and `listCollapsed` through the
  same anchored `^(<kind>):<from>:` → `^(<kind>):<next>:` rewrite as the
  owner/category/row, so an equivalent destination row stays open and
  collapsed; ids the destination lacks stay inert. Presets keep their
  deliberate separate selection (owner/category/row mapping still returns
  early for `preset`), while their expansions are still rewritten.
- Help, exactly as §7: `openHelp` calls
  `ui.dialog.set({ size: …, centered: true })` after `show()`; the fixed
  2/4 split is replaced by exported `helpColumns`/`helpHeight`, which choose
  the contiguous cut minimising the taller column's estimated height (1 title
  line + `max(1, ceil(label.length / (columnWidth - 14)))` per key);
  `HELP` gains the level keys, the `E` / `ctrl+E` rows and a `W / alt+W` row
  explicitly marked "next stage (not yet active)" — no resize binding is
  registered at this commit (Stage D activates it).
- Modal dim, exactly as §7.3: `modal = () => context.keymap.mode.current() ===
  "modal"`; the sidebar and list pass `focused = focus() === … && !modal()`,
  so behind any dialog the selected row drops the cursor and the focused
  background while the route's selection/expansion signals are never written.

Tests (new, from `packages/plus`):

- `test/instructions-levels.test.tsx` — shift+tab next/wrap and tab-only pane
  toggle; every previous/next alias (`shift+left`, `shift+[`, `{`, `shift+{`;
  `shift+right`, `shift+]`, `}`, `shift+}`); every direct alias (`shift+1..4`,
  `!@#$`, `shift+!@#$`); `<`/`>` regression; preservation of owner, category,
  row, `listOpen` and `navCollapsed` across Project↔Global; the Presets
  separate-selection exception (observed through the saved view); a mouse tab
  click (mockMouse); narrow width; absence while filtering/editing.
- `test/instructions-expand.test.tsx` — E excludes and ctrl+E includes the
  active row; any-collapsed expands all and an all-expanded pane collapses
  all; the focused sidebar collapses/re-expands; hovered pane wins over the
  keyboard focus in both directions; lowercase `e` still edits; narrow list
  page; no eligible rows is a silent no-op.
- `test/help.test.tsx` — the splitter keeps every group in order and its
  taller column equals the best contiguous cut; `dialog.set` receives
  `{ centered: true }` with `xlarge` at 130 and `large` at 100; wide frame has
  two equally starting columns with all six titles; narrow frame is one
  column with wrapped labels; with the keymap mode `modal` the selected row's
  background is `background.raised.high` with no cursor, and restoring `base`
  reproduces the exact pre-modal frame.
- `test/tui.ts` fixture additions used by those tests: `mockMouse`, `flush`
  (hover dispatch), a writable keymap `mode.current`, recorded `dialog.set`
  calls, and a `storage.memory` backing map. The test theme's focused action
  background is now distinct from `raised.high` so the dim/restore assertion
  is meaningful.

Focused matrix at this commit (from `packages/plus`): the three new files plus
`workspace-route`, `instructions-escape`, `instructions-panes`,
`instructions-diff-split`, `instructions-diff-complete`, `diff-lines` and
`route.test.tsx` — 165 pass / 2 pre-existing skips / 0 fail; `bun run
typecheck` clean. Root `bun run check` and the secret scan are recorded with
Stage E below.

### Stage D — bulk expansion + panels + resize mode (done, 2026-09-28)

Commit: `feat(plus): resize instructions panels` (local, branch `r4-8`).

The non-resize part of §6 shipped earlier with
`feat(plus): improve instructions navigation`:

- `row.tsx` gains `onHoverChange` fired from `onMouseOver`/`onMouseOut`; the
  click activation and the selected/focused styling are unchanged.
- `route.tsx` tracks `hovered: { pane, key } | undefined`. `E` (`shift+e`)
  bulk-toggles every expandable visible row of the hovered pane, else the
  focused pane; the hovered row, else the selected row of that pane, is the
  active row and is excluded (ctrl+E includes it). If any eligible row is
  collapsed everything expands, otherwise everything collapses; sidebar rows
  edit `navCollapsed`, list rows edit `listOpen`/`listCollapsed` directly.
  Lowercase `e` remains edit; the keys are browse-only and a pane with no
  eligible rows is a silent no-op.

Panels and the `W` mode (§5, G2–G3) are implemented in the same commit:

- New `panels.ts` owns the whole layout algebra: `OWNERS_DEFAULT = 30`,
  `OWNERS_MIN = 24`, `INSPECTOR_MIN = 24`, `MIN_LIST = 30`,
  `DIVIDER_WIDTH`/`DIVIDERS = 2`, `defaultInspector(width, owners) =
  floor((width - owners) * 2 / 5)`, `clampOwners`/`clampInspector`
  (`clamp(min, size, width - peer - MIN_LIST - DIVIDERS)`, both clamps
  accounting for the two divider columns) and `panelWidths(width, preferred)`
  returning the effective `{ owners, inspector, list }`. The route reads the
  pair from `storage.store` under `opencode.plus.instructions.panels`,
  re-clamped every render; narrow mode ignores it and a wide terminal brings
  it back.
- Wide `Browse` is now `Owners (fixed) | divider | List (flexGrow 1) |
  divider | Inspector (fixed)`; each divider is a one-column bordered box that
  owns its mouse target (idle `border.base` line, raised hover while
  hovered/dragged, action role while `W` selects it) and the inspector's old
  `border={["left"]}` is gone. `createPaneResize` from `@opencode/plugin/tui`
  is used twice (no plus→tui import); drag/drag-end/up live on the wide Browse
  root so a drag continues outside the handle. Left-button only; double-click
  resets Owners to `30` and Inspector to `defaultInspector(width, owners)`.
  A mouse commit persists the pair, so the peer keeps the width it had during
  the drag and the list absorbs exactly the dragged delta. The category-tab
  digit heuristic reads `listWidth()` from the effective widths instead of
  the old fixed 3/5 split.
- `W` / `alt+W` keyboard mode (wide browse only, starts on Owners):
  `←`/`[` narrow and `→`/`]` widen by one, `tab`/`shift+tab` cycle
  Owners ⇄ Inspector, `enter`/`escape` and the toggle key save the draft pair
  and leave. The resize branch of the keymap layer returns only its own
  commands, so no browse key fires inside the mode; the footer shows the
  selected pane and its current columns plus the keys. A terminal that
  becomes narrow auto-saves the draft and leaves. (Stage G corrects the step
  direction: at this commit the selected panel's width followed the key, so
  the Inspector's divider moved opposite the arrow.)

Tests (`test/instructions-panels.test.tsx`, 14 tests): pure defaults/clamps/
`panelWidths` boundaries; the wide dividers between fixed panes; both mouse
drags with the list absorbing the delta; right/middle-button refusal;
drag-past-the-edge clamps; double-click resets for both panes; persistence
across a route remount on one shared backing map with a `storage.memory`
exclusion control; `W` entry/footer/divider highlight/steps/cycling/Enter and
`alt+W` entry/Escape/`alt+W` toggle commits; keyboard clamps at the list
minimum; narrow refusal, absent dividers and auto-save on narrowing; rendered
digit-tab fit at the real effective list width; coexistence with
Tab/Shift+Tab levels and `E`/`ctrl+E`. The fixture now models durable
`storage.store` cells (a shared map across fixtures) and exposes
`storeValue`/`memoryKeys`.

`HELP` documents `W / alt+W` as active; `SPEC.md`, `instructions-redesign.md`
and this file are updated.

### Stage E — docs + integration (done, 2026-09-28)

- `SPEC.md` "Screen layout" carries the level keys, the cross-level place
  and expansion mapping, the Presets exception, the `E`/`ctrl+E` semantics,
  the resizable wide panels (dividers, clamps, double-click reset, durable
  widths) and the `W`/`alt+W` keyboard mode; the "Help" paragraph covers
  centering, balanced columns and dimming.
- `docs/instructions-redesign.md` implementation status, §4 keys and "State
  that survives" are updated the same way, including the durable panel
  widths.
- This file's status and §16 are updated.
- Focused matrix, plus typecheck, root `bun run check` and the secret scan
  pass; the work is committed locally as
  `feat(plus): improve instructions navigation` and, for the resize scope,
  `feat(plus): resize instructions panels`.

### Stage F — lab acceptance (done, 2026-09-28)

Driven with `docs/team-v2/scripts/tui-lab.sh` (pilotty PTY) from this
worktree in the script's isolated lab home/project; nothing was copied into
this repository or the evidence (the script seeds the throwaway home from the
caller's non-secret config by its own design), no secret state was printed,
and every owned session/service was stopped after the run (see Limits).

**Blocker found and fixed first.** With the merged upstream TUI host, the
palette showed no plugin commands at all (`Instructions` missing, `/plugins`
missing): the build-time plugin runtime allowlist
(`packages/tui/src/plugin/runtime-plugin-support.bun.ts`) exposed only
`Plugin`, `PluginContextProvider` and `usePlugin`, so the plus builtin's
`import { createPaneResize } from "@opencode/plugin/tui"` failed and the whole
builtins import rejected; a reconcile rejection is swallowed and only sets
`ready`, which is why the failure was silent. Commit
`3bf2d867e fix(tui): expose pane resize to plugin runtime modules` adds the
export and a focused regression test in `packages/tui/test/plugin-source.test.ts`
that loads a fixture plugin importing `createPaneResize` through the runtime
transform and asserts identity with the host export. This was the whole
Stage B review risk realized: the helper is shared through the plugin package,
but the runtime module surface is an explicit allowlist.

**Wide 130×45** (legacy decoding: the PTY does not run the Kitty protocol;
`Shift+Tab` was sent as raw `CSI Z` and `Shift+Left`/`Shift+Right` as raw
`CSI 1;2D`/`CSI 1;2C`, which is the legacy xterm spelling the alias set exists
for):

- Levels: `<`/`>`; raw `CSI Z` next and wrapping (Presets → Project); raw
  `Shift+Left`/`Shift+Right` previous/next; `{`/`}` previous/next (`{` wraps
  Project → Presets); `!`/`@`/`#`/`$` direct Project/Global/Defaults/Presets;
  a mouse click on the `Global` tab. Switching kept the same owner, category
  and row (e.g. `build › Settings › Enabled` survived Project ⇄ Global) and a
  collapsed `Special` group stayed collapsed at both levels.
- Panels: `W` (typed, the legacy shift+w spelling) and the `alt+w` alias
  (raw `ESC w`) both entered the mode (the alias also left it, as a toggle);
  footer
  `←/[ narrow · →/] widen · tab switch panel · enter/esc save · W Owners 30 cols`;
  single steps move the divider by one column (`[`: Owners 29 at column 29;
  Inspector 39 at column 90); `Tab` and raw `CSI Z` cycle panels; `Enter` and
  `Escape` save; widening past the limit stopped at **Owners 59**
  (130 − inspector 39 − MIN_LIST 30 − 2 dividers) with the list still 30
  columns, and the durable store
  (`…/state/opencode/plus/tui/plugin.opencode.plus.opencode.plus.instructions.panels.json`)
  held `{"owners":59,"inspector":39}`. Closing and reopening the screen and a
  fresh client spawned on the same home both restored `[59,90]`. Two rapid
  left-click pairs reset Owners to `30` and the Inspector to `40` (the 2/5
  default), committed to the store.
- `E`/`Ctrl+E`: with `edit` selected and collapsed in the Tools list, `E`
  left `▸ edit` and expanded `▾ execute` (active row excluded from decision
  and change); `Ctrl+E` then expanded `▾ edit` (included). Sidebar and narrow
  list bulk collapses/expands matched the visible-row convergence. Lowercase
  `e` opened the editor (`ctrl+s save`) and `Escape` cancelled.
- Help: `?` requested `{ size: "xlarge", centered: true }`; measured geometry
  at 130×45: 116-wide box with 7-column margins each side, content columns at
  11 and 67 (two balanced columns, all six titles), 2-row top / 1-row bottom
  margins (no quarter-height padding); no focused cursor behind the modal;
  closing reproduced the pre-open frame exactly.
- Diff: a review fixture was injected only in the lab home — a global
  `customization` record (`tool:read`, upstream with line 100 changed) and a
  project record (text changed at line 11 and 40–90, `basedOnText` the
  120-line original). The Project tab showed `!1`; `n`, then the id filter,
  reached the row and `Enter` opened the three tabs with counters
  `+1/-1`, `+52/-52`, `+53/-53`. Scrolling top→bottom at split width showed
  every one of the 120 lines in each tab, including `UPSTREAM line100` and
  `line120`; switching tabs at one offset kept `line060` visible; `v`
  toggled to unified.

**Narrow 90×30:**

- Two pages, no divider columns, `W`/`alt+W` absent (`cols` never appears in
  the footer) and the saved `{30,40}` ignored; on returning to 130×45 the
  saved widths came back (`[30,89]`). Entering the mode and widening Owners to
  33 and then narrowing the PTY to 90×30 auto-saved the draft and left the
  mode (footer back to browse, store `{"owners":33,"inspector":40}`); back at
  130×45 the dividers returned at `[33,89]`.
- Level keys (`>` `<` `{` `}` `!` `$`, raw `CSI Z`) worked and preserved the
  place; `E`/`Ctrl+E` still collapsed/expanded the focused page.
- Help was one column at `large` (88 columns in 90 → 1-column margins) with
  all six groups; closing restored the frame except the terminal cursor
  overlay position.
- The diff was unified by default: all 120 lines were reachable in all three
  tabs (line120 rendered under the cursor overlay as `line12[0]`), the
  markers were correct, and tab switching at one offset kept `line060`.

**Focused checks after the fix** (from the package directories): plus matrix
244 pass / 2 pre-existing skips / 0 fail; `plugin-source.test.ts` plus the
pane-resize pair 66 pass / 4 environment-only failures (3 need a `node`
binary that is not installed, 1 watcher poll misses its 3 s deadline on the
unmodified base too); `tsgo` clean in `plus`, `plugin` and `tui`; root
`bun run check` clean (oxlint 0/0, turbo 36/36).

**Limits of this lab run (honest):**

- pilotty has no mouse move or drag, so hover-wins targeting and real divider
  dragging could not be driven live; both are covered by the mockMouse tests
  (`instructions-expand`, `instructions-panels`). Clicks, double-clicks and
  tab clicks were driven for real.
- pilotty snapshots carry no ANSI, so the semantic divider/hover colours and
  the dim backdrop are asserted by the span-level tests
  (`instructions-panels`, `help.test.tsx`) and by reading the theme
  resolution; the live frames prove geometry, text and state only.
- No model call was made: the review fixture is records injected into the
  lab home, and the screen was opened with the palette, never by prompting.
- The team-creation/tool-count paths were not modified by this work; the live
  sidebar rendered the owner tool counts (`76 tools on (14 direct, 62 through
  Code Mode)`) and the focused `presets`/`teams` tests stayed green.

### Stage G — resize direction correction (done, 2026-09-28)

Commit: `fix(plus): align inspector resize arrows` (local, branch `r4-8`).

Bug found after the Stage F acceptance: in `W` resize mode the Owners keys
were spatially consistent (`[` moved its divider left) but the Inspector keys
were not, because the step applied the arrow's delta to the panel width
instead of to the divider. `Left` / `[` moved the Inspector divider right and
`Right` / `]` moved it left.

Fix: the step is now divider-direction based (`moveDivider(direction)` in
`route.tsx`): the `left,[` bind passes `-1` and `right,]` passes `1`; Owners
take that delta directly and the Inspector takes its negative, because its
divider is the panel's left edge. Every clamp (`clampOwners` /
`clampInspector`), the draft persistence and save/exit paths
(`Enter`/`Escape`/toggle), the auto-save on narrowing, and every mouse mapping
are unchanged. The footer, the help row and the keymap titles now read
`move divider left` / `move divider right` instead of `narrow` / `widen`,
because the width effect is not global: Owners widens as its divider moves
right, the Inspector widens as its divider moves left.

Focused regression tests (`test/instructions-panels.test.tsx`, all asserted on
the rendered divider columns as well as the stored widths):

- Owners: `Left` / `[` move the divider one column left (x 30 → 29);
  `Right` / `]` one column right (x 29 → 30).
- Inspector after `Tab`: `Left` / `[` move the divider left (40 → 41 cols,
  x 89 → 88) and widen the panel; `Right` / `]` move it right (41 → 40 cols)
  and narrow it.
- Inspector clamps: repeated `[` widen to the list-minimum boundary
  (68 cols, divider x 61) and repeated `]` narrow to `INSPECTOR_MIN`
  (24 cols, divider x 105), committed and re-rendered after `Enter`.
- Persistence and Enter/Escape: the new direction test commits with `Enter`
  (`{ owners: 30, inspector: 41 }`, dividers `[30, 88]`); the updated `alt+W`
  test commits an Inspector step with the toggle key; the remount test still
  proves `storage.store`; the mouse drag, double-click and narrow-mode tests
  are untouched and stay green.

The Stage F lab readings for the Inspector step (`[`: Inspector 39 at column
90, footer `←/[ narrow · →/] widen`) are the pre-correction direction and are
kept as written historical evidence; no new live lab run was performed for
this correction, which is pinned by the tests above.
