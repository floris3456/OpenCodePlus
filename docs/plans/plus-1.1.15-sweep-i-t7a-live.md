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

_(pending)_

## Step 4 — reset and repeat reset

_(pending)_

## Step 5 — old-style row repeat reset

_(pending)_
