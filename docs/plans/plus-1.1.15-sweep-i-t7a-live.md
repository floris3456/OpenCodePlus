# plus-1.1.15 — live sweep Instructions T7 part A

Run: `sweep-i-t7a` (Flash-C-Worker, task T127 `w-ac25abd5093619a5`).
Worktree: `/home/bliss/OpenCodePlus/run/plus/data/opencodeplus/teams/worktrees/opencode/Flash-C-Worker/t127ac25-20261005-1641`.
Dev home: `/home/bliss/OpenCodePlus/run/plus-dev/run-plus-data-opencodeplus-teams-worktrees-opencode-Flash-C-Worker-t127ac25-20261005-1641`.
Dev log: `<dev-home>/data/opencode/log/opencode-local.log`.

Launched exactly `pilotty spawn --name sweep-i-t7a opencodeplus-dev .` from this worktree and
`pilotty resize -s sweep-i-t7a 160 48`. No shared service (port 40375), no `bun run dev:live`,
no `bun run dev`, no live configuration mutation outside `$DEV`.

Scoped steps (from the attached brief file `r6/i-t7a.md`), followed in order; results are
appended as each step completes.

## Step 0 — setup

Done: spawned the TUI, resized to 160×48, killed it (to seed while the store was quiescent),
appended one old-style row to
`$DEV/config/opencode/opencodeplus/instructions/records.jsonl`:

```
{"type":"model","level":"global","agent":"plan","providerID":"cliproxyapi","modelID":"deepseek-v4.1-flash-cheap","variant":"high","updated":"2026-10-05T00:00:00.000Z"}
```

The file went from 245 to 246 lines; the appended row is the last line. Then spawned the TUI
again and resized to 160×48. Store header before this sweep: `{"version":2,"revision":478}`.

PASS.

## Step 1 — layout (field rows and sources)

Done: `/instructions` Enter, `@` (Global → `Global › Agents › OpenCode › build`), `→`
(middle pane), `2` (Models → `… › Models › cliproxyapi/claude-opus-5-5@high`). Enter on the
solid cursor row `cliproxyapi/claude-opus-5-5@high` opened the field group (footer became
`enter open fields   ←→ close`).

At **160×48** (Global, active inherited row):

```
▌▾ cliproxyapi/claude-opus-5-5@high                                active ◆
▎    Model                               cliproxyapi/claude-opus-5-5@high ◆
▎    Effort                                                          high ◆
     Warming                                            32m · opencode.json
     Ping every                                               4m · defaults
     Keep-...romptThis is a keep-alive reques...with exactly: OK · built-in
```

At **80×24** (Global):

```
▌▾ cliproxyapi/claude-opus-5-5@high                                    active ◆
▎    Model                                   cliproxyapi/claude-opus-5-5@high ◆
▎    Effort                                                              high ◆
     Warming                                                32m · opencode.json
     Ping every                                                   4m · defaults
     Keep-...romptThis is a keep-alive request....y with exactly: OK · built-in
```

Then `#` (Defaults → `Defaults › Agents › OpenCode › build › Models`), selected `Models` in
the sidebar (`Down` put the cursor on the second row), `→`, and `→` opened
`cliproxyapi/claude-opus-5-5@xhigh` into field rows:

At **160×48** (Defaults):

```
▌▾ cliproxyapi/claude-opus-5-5@xhighfrom default build...arm 30m · every 4m
▎    Model                              cliproxyapi/claude-opus-5-5@xhigh ◆
▎    Effort                                                         xhigh ◆
▎    Warming                                                          30m ◆
▎    Ping every                                                        4m ◆
     Keep-...romptThis is a keep-alive reques...with exactly: OK · built-in
```

At **80×24** (Defaults):

```
▌▾ cliproxyapi/claude-opus-5-5@xhigh   from default build · warm 30m · every 4m
▎    Model                                  cliproxyapi/claude-opus-5-5@xhigh ◆
▎    Effort                                                             xhigh ◆
▎    Warming                                                              30m ◆
▎    Ping every                                                            4m ◆
     Keep-...romptThis is a keep-alive request....y with exactly: OK · built-in
```

The five rows are `Model`, `Effort`, `Warming`, `Ping every`, `Keep-...rompt` (Keep-alive
prompt) in the same style for both the Global and the Defaults candidate, at both widths.
Values are shown; a `◆` marks a value set at the current level, and an inherited value shows
its source (`· opencode.json`, `· defaults`, `· built-in`). Both panes show the same field-row
style. PASS.

## Step 2 — pickers

Done on `Global › Agents › OpenCode › build › Models › cliproxyapi/claude-opus-5-5@xhigh`
(field group open; the row is build's Defaults-derived candidate, also verified on the Defaults
level candidate). On the `Model` field Enter opened the catalogue picker; quote then Esc:

```
     Model             Model provider                                   esc
                       [S]elect a provider
                       cliproxyapi
                       lithosai
                       opencode
```

On the `Effort` field Enter opened the variant picker of that model; quote then Esc:

```
     Effort            Effort · cliproxyapi/claude-opus-5-5             esc
                       [T]he variant this row runs with
                       (inherit / none) No variant of its own
                       high
                       low
                       max
                       medium
                       xhigh
```

The inspector showed `field model / value cliproxyapi/claude-opus-5-5@xhigh · defaults` and
`field effort / value xhigh · defaults`. Both opened without a write; after Esc the field group
was back at the same rows. PASS.

## Step 3 — edit one field

Done: on the Global `build` candidate `cliproxyapi/claude-opus-5-5@high` (`row ... warming
32m · opencode.json`), put the cursor on the `Warming` field and Enter; the editor showed
`[3]2m · opencode.json` with hint `off, on, or the total time to keep the cache warm … Empty
inherits. Now: 32m · opencode.json.` Cleared it (Ctrl+A) and typed `20m`, Enter. The field row
then showed:

```
▌▾ cliproxyapi/claude-opus-5-5@high                          active · warm 20m ◆
▎    Warming                                                    20m ◆
```

and the inspector `field warming / value 20m`.

Store line before (records.jsonl line 215):

```
{"type":"model","level":"global","agent":"build","providerID":"cliproxyapi","modelID":"claude-opus-5-5","variant":"high","active":true,"basedOn":"cliproxyapi/claude-fable-5-1@xhigh","updated":"2026-09-29T10:13:12.020Z"}
```

Store line after (still line 215, line count 246 unchanged):

```
{"type":"model","level":"global","agent":"build","providerID":"cliproxyapi","modelID":"claude-opus-5-5","variant":"high","active":true,"basedOn":"cliproxyapi/claude-fable-5-1@xhigh","warming":"20m","updated":"2026-10-05T14:50:28.549Z"}
```

Only `warming` was added and the `updated` timestamp changed; `providerID`, `modelID`,
`variant`, `active`, `basedOn` are byte-identical. Header revision moved `478 → 479` (one
edit = one revision). PASS.

## Step 4 — reset and repeat reset

Done on the Global `build` candidate `cliproxyapi/claude-opus-5-5@high`. Edit to `20m` as in
step 3 (record line 215 held `"warming":"20m"`), then `r` on the `Warming` field.

First reset: the field returned to its inherited value and source; the footer dropped its
`r reset` hint at the same moment. Store header before `{"version":2,"revision":487}` → after
`{"version":2,"revision":488}`; line 215 after the reset lost `warming`:

```
{"type":"model","level":"global","agent":"build","providerID":"cliproxyapi","modelID":"claude-opus-5-5","variant":"high","active":true,"basedOn":"cliproxyapi/claude-fable-5-1@xhigh","updated":"2026-10-05T15:12:14.855Z"}
```

Screen after the first reset: `Warming 32m · opencode.json`, inspector
`field warming / value 32m · opencode.json`.

Repeat reset: the header was `{"version":2,"revision":488}` before and **byte-identical** after
(`diff` of the whole `records.jsonl` against a copy taken before the keypress printed nothing);
line 215 was unchanged. But the refusal text was **not** shown: once the field is inherited the
live footer hint drops `r reset` (the hints list is built from `canReset(node)`,
`route.tsx:1431`), so pressing `r` again is a silent no-op. A grep of the whole retained session
output for `no override` returns 0 matches.

So: no-write on repeat PASS (revision 488 unchanged, store byte-identical); the expected
`"has no override to reset"` refusal text FAIL — it never reaches the screen in this build
because `canReset`/`actions.reset` gate the key off for an inherited field
(`packages/plus/src/instructions/tree.ts:1980` sets `reset: current.own`). The tool-layer
refusal exists (`packages/plus/src/instructions/ops.ts:1696,1699,1701`) but the TUI does not
invoke it here. Step 4 marked FAIL for the refusal sub-claim; see concerns.

## Step 5 — old-style row repeat reset

Done: Global › `plan` › Models (`→`, `2`) → `cliproxyapi/deepseek-v4.1-flash-cheap@high`
(the seeded row, `variant: high`, no `originalCandidate`). Enter opened the field group
(`Model cliproxyapi/deepseek-v4.1-flash-cheap@high`, `Effort high`, `Warming off · built-in`,
`Ping every 4m · built-in`, `Keep-alive prompt … OK · built-in`). Cursor on `Effort`, `r`.

First `r`: the row lost its variant. Store header `{"version":2,"revision":488}` →
`{"version":2,"revision":489}`; line count 246 → 247. The live row (now line 225) has no
variant and no `originalCandidate`; the old candidate is tombstoned at line 228:

```
225: {"type":"model","level":"global","agent":"plan","providerID":"cliproxyapi","modelID":"deepseek-v4.1-flash-cheap","updated":"2026-10-05T15:18:30.991Z"}
228: {"type":"model","level":"global","agent":"plan","providerID":"cliproxyapi","modelID":"deepseek-v4.1-flash-cheap","variant":"high","removed":true,"updated":"2026-10-05T15:18:30.990Z"}
```

Row/label after: `cliproxyapi/deepseek-v4.1-flash-cheap`, `Effort none`. PASS.

Reopened the row (Enter), cursor on `Effort` (`field effort / value none`), `r` again. Header was
`{"version":2,"revision":489}` before **and after**; a whole-file `diff` against a copy taken
before the keypress printed nothing (`STORE BYTE-IDENTICAL`), and the field stayed `none`. But the
refusal text was again **not** displayed: the footer showed no `r reset` on the `none` field, and
grep of the retained session output for `no override` returned 0 matches. Same gate as step 4 —
`packages/plus/src/instructions/tree.ts:1980` sets `actions.reset: current.own` and
`packages/plus/src/tui/instructions/route.tsx:1523` only binds `r` when `canReset(node)`, so an
un-overridden field never invokes the tool-layer refusal
(`packages/plus/src/instructions/ops.ts:1775,1799`).

So: first reset PASS; second reset no-write PASS (revision 489 unchanged, store byte-identical);
the expected `"has no override to reset"` refusal text FAIL — never shown. Step 5 marked FAIL
for the refusal sub-claim.

## Server log

`<dev-home>/data/opencode/log/opencode-local.log`: 397 lines, **0 ERROR / 12 WARN**. Every WARN
is the expected `executor-controlled plugin source refused` (refusing `OpenCodePlus/.opencode`
and this worktree's `.opencode`); no other WARN message occurs:

```
timestamp=2026-10-05T14:42:36.280Z level=WARN run=092321dc message="executor-controlled plugin source refused" path=/home/bliss/OpenCodePlus/.opencode/opencode.json type=document http.span=99 role=server
timestamp=2026-10-05T14:42:36.280Z level=WARN run=092321dc message="executor-controlled plugin source refused" path=/home/bliss/OpenCodePlus/.opencode type=directory http.span=99 role=server
timestamp=2026-10-05T14:42:38.059Z level=WARN run=092321dc message="executor-controlled plugin source refused" path=/home/bliss/OpenCodePlus/.opencode/opencode.json type=document http.span=110 role=server
timestamp=2026-10-05T14:42:38.059Z level=WARN run=092321dc message="executor-controlled plugin source refused" path=/home/bliss/OpenCodePlus/.opencode type=directory http.span=110 role=server
timestamp=2026-10-05T14:42:38.059Z level=WARN run=092321dc message="executor-controlled plugin source refused" path=/home/bliss/OpenCodePlus/run/plus/data/opencodeplus/teams/worktrees/opencode/Flash-C-Worker/t127ac25-20261005-1641/.opencode/opencode.jsonc type=document http.span=110 role=server
timestamp=2026-10-05T14:42:38.059Z level=WARN run=092321dc message="executor-controlled plugin source refused" path=/home/bliss/OpenCodePlus/run/plus/data/opencodeplus/teams/worktrees/opencode/Flash-C-Worker/t127ac25-20261005-1641/.opencode type=directory http.span=110 role=server
timestamp=2026-10-05T14:43:36.080Z level=WARN run=cfa5c8ac message="executor-controlled plugin source refused" path=/home/bliss/OpenCodePlus/.opencode/opencode.json type=document http.span=156 role=server
timestamp=2026-10-05T14:43:36.080Z level=WARN run=cfa5c8ac message="executor-controlled plugin source refused" path=/home/bliss/OpenCodePlus/.opencode type=directory http.span=156 role=server
timestamp=2026-10-05T14:43:37.719Z level=WARN run=cfa5c8ac message="executor-controlled plugin source refused" path=/home/bliss/OpenCodePlus/.opencode/opencode.json type=document http.span=77 role=server
timestamp=2026-10-05T14:43:37.719Z level=WARN run=cfa5c8ac message="executor-controlled plugin source refused" path=/home/bliss/OpenCodePlus/.opencode type=directory http.span=77 role=server
timestamp=2026-10-05T14:43:37.719Z level=WARN run=cfa5c8ac message="executor-controlled plugin source refused" path=/home/bliss/OpenCodePlus/run/plus/data/opencodeplus/teams/worktrees/opencode/Flash-C-Worker/t127ac25-20261005-1641/.opencode/opencode.jsonc type=document http.span=77 role=server
timestamp=2026-10-05T14:43:37.719Z level=WARN run=cfa5c8ac message="executor-controlled plugin source refused" path=/home/bliss/OpenCodePlus/run/plus/data/opencodeplus/teams/worktrees/opencode/Flash-C-Worker/t127ac25-20261005-1641/.opencode type=directory http.span=77 role=server
```

## Cleanup

Killed the one session I started (`pilotty kill -s sweep-i-t7a` → `Session
15833326-… killed`); `pilotty list-sessions` afterwards showed no `sweep-i-t7a`. A `/proc`
scan of `environ` and `cwd` for this dev home found no process. No shared service, port 40375,
`~/.config/opencodeplus`, `bun run dev:live` or `bun run dev` was used, and configuration was
changed only inside `$DEV`.

## Result per step

| Step | Result |
| --- | --- |
| 0 setup | PASS |
| 1 layout | PASS |
| 2 pickers | PASS |
| 3 edit one field | PASS |
| 4 reset + repeat reset | PASS (reset; repeat no-write) / **FAIL** (expected refusal text not shown) |
| 5 old-style repeat reset | PASS (first reset; second no-write) / **FAIL** (expected refusal text not shown) |

