# /instructions redesign

Status: design A implemented (2026-09-28). B, C and D are kept here as the
alternatives that were weighed.

Implementation status:

- The workspace view ships in `src/tui/instructions/` (`route.tsx`, `workspace.ts`,
  `row.tsx`, `inspector.tsx`, `diff-pane.tsx`, `editor-pane.tsx`, `splitter.tsx`,
  `help.tsx`, `dialogs.tsx`), with `test/workspace.test.ts` and
  `test/workspace-route.test.tsx` beside the existing route tests.
- The shared foundation (§2) is in: semantic row colours, the real diff with
  the three comparisons and the merged edit (`k` / `t` / `e`), the full-width
  editor with `ctrl+d` preview and discard confirm, the help dialog, the live
  filter, `n`/`N` review jumps, and view survival in
  `context.storage.memory`.
- Tool counts per owner (not in the original design; added with the
  workspace): see §4 and §4's capability mapping. `toolCounts()` in
  `workspace.ts` counts the rows switched on under each owner's Tools group,
  splitting out unpinned Code Mode tools as `through Code Mode` (a pinned one
  is direct). The sidebar owner row, the Tools category tab and the owner
  header all carry the number; the inspector has a `tools` fact. Zero reads
  `no tools` in warning colour with the next step (`l` link a preset, `4` turn
  tools on).
- Follow-up (2026-09-28): the diff completeness defect is fixed (the
  `instructions-workspace-followup.md` Stage A). `unifiedDiff` takes an
  optional `context` and the three review comparisons pass
  `Number.POSITIVE_INFINITY`; see §2.2. Stage C-level navigation (Shift+Tab
  and the terminal aliases, direct `Shift+1–4`, cross-level place and
  expansion mapping) and the non-resize part of Stage D (bulk `E` / `Ctrl+E`
  expansion) are implemented, as is §7's help work (centered, balanced
  columns, workspace dimmed behind any dialog). The resizable outer panels
  (fixed Owners and Inspector widths around the flexible list, mouse drag with
  double-click reset, durable client-local persistence) and the `W` / `alt+W`
  keyboard resize mode are implemented too (Stage D of
  `instructions-workspace-followup.md`). The resize keys were corrected after
  the lab acceptance (Stage G there): they move the selected divider left/right
  rather than a global narrow/widen, so the Inspector's width moves opposite
  the key while the Owners width moves with it.

Priorities, from the owner of the screen:

1. **Intuitive** — every capability of today's screen survives, and so does
   readability.
2. **Looks** — it should feel like OpenCode.

## 1. What is wrong today (observed in a lab TUI, 130×45 and 90×30)

| # | Problem | Evidence |
|---|---------|----------|
| 1 | The same tree is repeated four times (Project, Global, Defaults, Presets); the level being edited is only a far-up ancestor row. | Roots at depth 0, agents at depth 3. |
| 2 | Far to reach: a shell rule sits ~10 levels deep (Project › Agents › OpenCode › build › Tools › OpenCode › shell › Permissions › Commands › rule), ~30 key presses from open. | Walked it in the lab. |
| 3 | Rows are noisy: almost every row repeats `[on] · OpenCode` / `· upstream`; every Base prompt shows a yellow `[unsupported]`, which drowns out the yellow that should mean "needs review". | Base group capture. |
| 4 | The detail pane wastes space: badges repeated as bare words (`on`, `active`, `primary`), one per line with blank lines between; groups say only `No item details`; sections are listed twice (tree and pane). | Claude.txt / Skills captures. |
| 5 | Editing is cramped: a textarea squeezed into half the width under the metadata; the footer keeps advertising tree keys while the editor's own `ctrl+s save` hides elsewhere; esc silently discards the draft; no way to see what you changed before saving. | Enter on Claude.txt. |
| 6 | The "diff" is not a diff: three full copies stacked (Original / Yours / New upstream) with no highlighting, reachable only when a row is flagged for review. `e` claims to edit a *merged* text but starts from yours. OpenCode already ships a real diff renderer (`<diff>`, theme `diff.*` tokens) that is not used. | `diff-pane.tsx`. |
| 7 | Navigation is thin: the filter is a modal prompt applied on submit; no page/home/end; no "next thing to review"; no breadcrumb; one esc closes the whole screen; expansion state is lost on reopen; no mouse. | `route.tsx`, `tree-pane.tsx`. |
| 8 | Help is a text block dumped above a footer that already carries up to 14 hints. | `?`. |
| 9 | Bug under 100 columns: Right on a group opens a detail page that says only "No item details"; arrows do nothing there but the footer still says `arrows move · left/right expand`; only esc escapes. | 90×30 capture. |

What is right and must stay: the categorisation (level → catalogue → origin →
owner → category → origin → item → sections/permissions), the state layer
(`state.ts`, `ops.ts`: every mutation, refusal and revision check), the dialogs
(add/link/rule editor/presets), the query grammar, and every key action.

## 2. Shared foundation (all four designs)

### 2.1 Row anatomy and colour coding

```
▎▾ ● shell                         from preset Build   !
│ │ │ └ label (subdued when off)    └ provenance (dim)  └ review / modified mark
│ │ └ state: ● on  ○ off  (no glyph for structure rows)
│ └ ▸ collapsed  ▾ expanded
└ gutter: warning bar = needs review, info bar = set at this level
```

Semantic tokens only (repo rule: no raw hues):

| Meaning | Token |
|---|---|
| selected row, focused pane | `background.action.primary.focused` + `text.action.primary.focused` (OpenCode's list selection) |
| selected row, unfocused pane | `background.surface.overlay` |
| on ● | `text.formfield.selected` |
| off ○ and its label | `text.subdued` |
| set at this level (modified) ◆ / gutter | `text.feedback.info.default` |
| needs review ! / gutter / counts | `text.feedback.warning.default` |
| missing preset | `text.feedback.warning.default` |
| provenance, meta, hints | `text.subdued` |
| category identity (tab accent) | `categorical[i]` (light 800 / dark 200, as core's stats view does) |
| diffs | `diff.*` — the same props OpenCode's `/diff` and permission prompt pass |
| excluded section | `text.subdued` + strikethrough |

Noise rules: `[on]`/`[off]` become the glyph; the baseline provenance
(`OpenCode`, `upstream`) is not printed; `unsupported`/`unexcludable` leave the
row and become one inspector line ("The whole base prompt always stays live;
exclude sections instead"); mode shows once, dim, beside agents.

### 2.2 A real diff

The review screen renders opentui's `<diff>` (OpenCode's diff renderer) from a
unified patch built by `diff-lines.ts`, with OpenCode's diff tokens, split view
when wide and unified when narrow (`v` toggles). A review has three questions,
each one tab:

1. **Upstream change** — original → new upstream (what changed above you)
2. **Your change** — original → yours
3. **Result** — yours → new upstream (what "take" would do)

`k` keep yours · `t` take upstream · `e` edit a **merged** proposal: a line
three-way merge applies the upstream change onto yours; overlapping hunks get
`<<<<<<< yours / ======= / >>>>>>> upstream` markers. The same view opens on
demand (`c` compare) for any row whose text you have overridden, not only when
flagged.

Every comparison renders the **complete text of both sides** — one full-range
hunk (`unifiedDiff` with `context: Number.POSITIVE_INFINITY`) instead of the
compact 3-line context — so the three tabs share one continuous line universe:
unchanged text far from any change is present in every tab, and switching tabs
keeps the same lines in view. The `<diff>` renderer paints only the hunk lines
it receives and has no gap/ellipsis row, which is why the compact patch made
each tab show a different subset. Compact hunks remain the default of
`unifiedDiff` and for `/diff`, the permission prompt, the editor preview
(`ctrl+d`) and tool output.

### 2.3 Editor

Full width, title + breadcrumb on top, `ctrl+s` save, `ctrl+d` preview your
change as a diff before saving, esc asks before discarding a changed draft.

### 2.4 Help, footer, status

`?` opens a help dialog (grouped keys, the filter grammar), centered on both
axes, one column below 124 columns and two height-balanced columns from there;
while it (or any dialog) is open the workspace keeps its state but renders
unfocused behind the backdrop. The footer shows at most ~8 context-relevant
keys in OpenCode's style (bold key, dim label). The status line keeps the last
result.

## 3. The four designs

Each mockup is 120 columns wide with a real selection: Project › build › Tools › shell.

### Design A — Workspace (recommended)

Levels become tabs, owners (agents, team members, presets, "every agent")
become a sidebar, categories become tabs, and the item list is only the
category's own subtree. Three questions, three places: *where* (level tab),
*who* (sidebar), *what* (category tab), then *which* (list).

```
 Instructions   Project !1   Global   Defaults   Presets                              ? help
 Project › build › Tools
 Agents                    1 Settings  2 Models  3 Compaction  4 Tools  5 Base  6 Skills  7 System
   OpenCode                ──────────────────────────────────────────────────────────────────────
 › ● build      primary      OpenCode                              │ shell                tool
   ● plan       primary    ▸ ● edit                                │ Project › build › Tools
   ● general    subagent   ▸ ● execute                             │ state   on · set here (Project)
   ● explore    subagent   ▾ ● shell                             ◆ │ text    upstream
   ▸ Special                   ● Description                       │
   Plus                      ▸ Permissions                         │ Runs a shell command in the
   ● planner    subagent ! ▸ ○ webfetch                            │ working directory…
   User                      OpenCodePlus                          │
 Teams                     ▸ ● team_delegate                       │
   ▸ crew        on                                                 │
 Saved "shell"
 ↑↓ move  →/enter open  space toggle  c compare  a add  r reset  / filter  tab pane  ? help
```

- Reach: open → `4` (Tools) → `tab` → `/shell` or ↓ → `→` … about 6–10 keys
  instead of about 30.
- The categories are still all there, one keypress each, and each category's
  list is short enough to read.
- Narrow (< 110 cols): the sidebar and the owner are two pages (→ in, ← out);
  the inspector sits under the list.
- Risk: most new code; every route test that walks the tree needs new helpers.

### Design B — Zoomable tree (evolution)

Keep one tree, but add level tabs and "zoom": enter on a group re-roots the tree
there, and a breadcrumb shows where you are (backspace or ← at the top zooms out).
The rest is the shared foundation.

```
 Instructions   Project !1   Global   Defaults   Presets                              ? help
 ‹ Project › Agents › OpenCode › build › Tools
   OpenCode                                                     │ shell                tool
 ▸ ● edit                                                       │ Project › build › Tools
 ▾ ● shell                                                    ◆ │ state   on · set here
     ● Description                                              │
   ▸ Permissions                                                │ Runs a shell command…
```

- Smallest change, and the tests mostly survive.
- You still descend one level at a time, and the owner/category context is only
  in the breadcrumb, so jumping from build › Tools to plan › Tools means zooming
  out three times.

### Design C — Columns (Miller columns, as in ranger/yazi/Finder)

```
 Instructions   Project   Global   Defaults   Presets
 Agents      │ ● build      │ Settings      │   OpenCode      │ shell · tool
 Teams       │ ● plan       │ Models        │ ● edit          │ state on · set here
             │ ● general    │ Compaction    │ ● shell       ◆ │ Runs a shell…
             │ ● explore    │ Tools       › │ ○ webfetch      │
```

- Very clear spatially, and every step is →.
- Only about 3 columns fit, and item → sections → permission categories → rules
  pushes the owner off-screen. Each column gets ~20 characters, which is too
  narrow for rule labels. Under 100 columns it degrades badly.

### Design D — Search first (VS Code settings)

```
 Instructions  / shell_______________________   in Project ▾   show: all ▾
 build › Tools › OpenCode
   ● shell                                   ◆ set here
 build › Tools › OpenCode › shell › Permissions › Commands
   ● Git branches, tags and worktrees
 plan › Tools › OpenCode
   ● shell
```

- Fastest when you know the name.
- Poor for browsing and for discovering what exists. It hides the
  categorisation you built on purpose. The query engine takes 200–900 ms over
  all levels, so it can't run live on every keystroke without a scope.

### Comparison

| | A Workspace | B Zoom tree | C Columns | D Search |
|---|---|---|---|---|
| Keeps the categories visible | yes (tabs + sidebar) | breadcrumb only | yes | no |
| Keys to reach build › shell | ~6 | ~12 | ~8 | ~7 (if the name is known) |
| Switching agent, keeping category | 1 key | zoom out ×3 | 1–2 keys | retype |
| Reading long text | inspector / full-width editor | inspector | a narrow last column | inspector |
| Narrow terminals | two pages | good | poor | good |
| Build cost / risk | high | low | high | medium |

**Recommendation: A**, with D's live filter (`/`, scoped to the level) and B's
breadcrumb. The shared foundation (§2) carries the colour coding, the real diff,
the editor and the help dialog.

## 4. Design A in detail

### Layout

- **Header**: `Instructions`, the level tabs (review count per level in warning
  colour), `? help` on the right. Line 2: breadcrumb.
- **Sidebar** (26–30 cols): the level's catalogues (Agents, Teams) with origin
  subheaders (OpenCode, Plus, User, Special). Rows are owners (agents, team
  members, special agents, presets, Defaults entries, "Every agent" and
  "Every member") and containers (teams, which list their members). Team-level
  actions (space enable, d delete, l link, a add member) happen here. An owner
  row's tail carries the tools switched on for it (right-aligned number, or a
  warning-coloured `no tools`; a zero beside state tags stays as a compact
  warning `0` so the tags keep the room).
- **Main**: the category tabs of the selected owner (number, name, review count),
  then the category's own subtree as a list. Origin subgroups (OpenCode,
  OpenCodePlus, MCP, Code Mode) are header rows, and items expand inline to
  sections and permissions. Above the tabs the owner's header line adds its
  identity (`build  primary · on`); a second line carries the tool count as
  `72 tools on (14 direct, 58 through Code Mode)`, or
  `no tools on · link a preset (l) or turn tools on (4)` at zero. The Tools
  category tab names the owner's count too.
- **Inspector**: a compact key/value card (kind, address, state, provenance,
  preset link, enforcement, model, matches), then the text with excluded
  sections struck through. Group rows get a summary (counts on/off/set
  here/review) instead of "No item details". Owner rows add a `tools` fact
  (`72 tools on (14 direct, 58 through Code Mode) · 75 in all`), and at zero
  the same next step as the header.
- **Focus views**: the editor, the review/compare diff, and the section splitter
  take the full body. Esc returns to where you were.

### Keys

| Key | Sidebar | List |
|---|---|---|
| ↑ ↓ / PgUp PgDn / Home End | move | move |
| → / enter | into the list (a team: expand) | expand / open (edit, review, rule, number, cycle) |
| ← | collapse / parent | collapse / parent, at top level → sidebar |
| tab | switch pane | switch pane |
| shift+tab | next level (wrapping) | next level (wrapping) |
| shift+← / shift+right, shift+[ / shift+] (`{` `}` aliases) | previous / next level | previous / next level |
| shift+1–4 (`!` `@` `#` `$` aliases) | jump to Project / Global / Defaults / Presets | same |
| `[` `]`, `1`–`8` | category | category |
| `<` `>` | level | level |
| E / ctrl+E | expand / collapse all visible rows (E keeps the active row) | same |
| W / alt+W (wide) | resize panels: ←/[ move divider left, →/] move divider right, tab switch Owners/Inspector, enter/esc save | same |
| space / ctrl+space | enable / select agent | toggle / select agent |
| `e` | — | edit text |
| `c` | — | compare with upstream (real diff) |
| `n` / `N` | next / previous row to review in this level | same |
| `a` `d` `r` `l` `p` `s` | add / delete / reset / link / pin / split, as today | same |
| `/` | live filter (level scope) | same |
| `?` | help dialog | help dialog |
| esc | close the screen | back to the sidebar (filter: clear first) |

The mouse works too: click a row, a tab or a category; the wheel scrolls. A
level switch keeps the same owner, category and selected row, and rewrites the
sidebar/list expansion ids where the destination has the equivalent node;
Presets deliberately keep their own selection. In wide mode the two outer
panes are fixed-width with draggable divider columns between them and the
flexible list; double-click resets a divider, `W` / `alt+W` resizes by
keyboard (`←`/`[` move the selected divider left, `→`/`]` move it right; the
Inspector's width moves opposite the key, `tab`, `enter`/`esc`), and the
widths persist.

### State that survives

The level, the owner per level, the category per owner, and the expansions are
kept in `context.storage.memory` for the TUI session, so reopening
`/instructions` returns to the same place. The level keys move that place and
those expansions across a switch where the destination has the node. On first
open the session's current agent is preselected. Panel widths are the one
durable piece: they live in `context.storage.store` under
`opencode.plus.instructions.panels` and survive a TUI restart (narrow mode
ignores them, a wide terminal re-clamps and re-applies them).

### Mapping of every current capability

| Today | Design A |
|---|---|
| Four roots | level tabs `<` `>` |
| Agents / Teams / origin groups | sidebar sections |
| agent/member/special/preset/entry rows | sidebar owners |
| Settings…System/MCP groups | category tabs `[` `]` `1`–`8` |
| items, sections, permissions, rules | list rows (expand inline) |
| enter edit / cycle / toggle / rule editor / number / review | same on the list row; edit and review open focus views |
| space toggle, ctrl+space select agent | same (sidebar for agents and teams) |
| p pin, a add, l link, d delete, r reset, s split | same keys, same dialogs |
| review state/pin/model choice | same select dialogs |
| review text (three stacked texts) | real diff view with three comparisons + merged edit |
| filter prompt | live filter bar |
| `?` text block | help dialog |
| detail pane | inspector card |
| status line, toasts | same |
| open-with-agent (after create) | same (selects the owner) |
| (new) tools switched on per owner | sidebar owner tail, Tools category tab, owner header line, inspector `tools` fact |

## 5. Functional fixes delivered alongside

1. Real diff (opentui `<diff>`, OpenCode diff tokens) instead of three stacked texts.
2. `e` in a review edits a real three-way merge proposal (conflicts marked).
3. On-demand compare (`c`) for any row whose text you have overridden.
4. The editor asks before discarding a changed draft; `ctrl+d` previews the change.
5. Live filter; `n`/`N` jump to the next row to review; PgUp/PgDn/Home/End.
6. The selection always stays in view (scroll follows the cursor).
7. Esc steps back one pane instead of closing the whole screen.
8. The view survives reopening (level, owner, category, expansions).
9. The narrow-mode dead end (bug 9) no longer exists: narrow mode has two
   explicit pages and the footer always matches the keys that are live.
10. Group rows get a summary; badges shown once; `unsupported` is no longer a
    warning.
11. Mouse selection and tab clicks.
