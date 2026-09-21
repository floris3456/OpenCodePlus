# Round 3 live TUI captures

Captured by the orchestrator with `docs/team-v2/scripts/tui-lab.sh` and pilotty in isolated lab homes. These are literal screen captures, not illustrations. Baseline runs source `f0522d90f2537ebcd4a516b50122e951f4503fc6`; the first after lab runs source `ff72f8788595221c45bee3297ffe9f8ffd5f9d6d`. The final walkthrough records final-head verification separately.

Baseline lab: `r3-main-1ecb-before`. First after lab: `r3-main-1ecb-after`.

## Before: member-backed Team tab

```text
--- Terminal 130x45 | Cursor: (44, 130) ---
   New session                   +
  ┃                                                                                       New session - 2026-09-21T17:00:38.
  ┃  Reply only OK. Do not use tools.                                                     770Z
  ┃
                                                                                          MCP
     Error: Error from provider (Console): OpenCode's free tier can only be used from     • search                    Connected
     within OpenCode
     Build · Muse Spark 1.3 Free · 557ms
  ┃
  ┃  Subagents  Shell  Terminals  Team                                           esc
  ┃
  ┃  No active team — select one with ctrl+x a
  ┃
  ┃  select enter  tabs ←/→
  ┃                                                                                       /…/tui-lab-r3-main-1ecb-b…/proj:master
                                                                                                                                  [_]
```

## Before: Ctrl+D leaves the client open

```text
--- Terminal 130x45 | Cursor: (39, 5) ---
   New session                   +
  ┃                                                                                       New session - 2026-09-21T17:00:38.
  ┃  Reply only OK. Do not use tools.                                                     770Z
  ┃
                                                                                          MCP
     Error: Error from provider (Console): OpenCode's free tier can only be used from     • search                    Connected
     within OpenCode
     Build · Muse Spark 1.3 Free · 557ms
  ┃
  ┃
  ┃
  ┃  Build · Muse Spark 1.3 Free OpenCode Zen
  ╹▀▀[▀]▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
  /…/tmp-b…/tui-lab-r3-main-1ecb-before/proj:master  shift+tab agents  ctrl+p commands    /…/tui-lab-r3-main-1ecb-b…/proj:master
```

## Before: rule keywords prompt

```text
--- Terminal 130x45 | Cursor: (14, 37) ---
Filter:cshell                                                     Project (root)
 ›- Project                                                    ▀
    + Agents                                                      No item details
      + Native
        + build
          + Tools
            + Native
              + shell [on]
                  shell [on]
                  git [on]
                  Git push [on]
                  env [on]
                  git checkout -- [  Rule keywords                                        esc
                  Git commit [on]
                  git rebase [on]    [b]lank for defaults
                  git reset [on]
                  git reset --hard   enter submit
                  npm run [on]
                  Git history rewrites [on]
                  Remove files [on]
                  Recursive force remove [on]
                  Sudo [on]
                  Change permissions or ownership [on]
                  Download with curl or wget [on]
                  SSH or SCP [on]
                  Docker [on]
                  Kubectl [on]
                  JavaScript package install [on]
                  npm publish [on]
                  pip install [on]
                  Kill processes [on]
                  Disk destructive [on]
                  Package scripts [on]
        + plan
          + Tools
            + Native
              + shell [on]
                  shell [on]
                  git [on]
                  Git push [on]
                  env [on]
                  git checkout -- [on]
                  Git commit [on]
                  git rebase [on]
arrows move · left/right expand · enter edit · a add · / filter · ? help · esc back
```

## Before: keywords goes directly to scope

```text
--- Terminal 130x45 | Cursor: (14, 39) ---
Filter:cshell                                                     Project (root)
 ›- Project                                                    ▀
    + Agents                                                      No item details
      + Native
        + build
          + Tools
            + Native
              + shell [on]
                  shell [on]
                  git [on]
                  Git push [on]
                  env [on]
                  git checkout -- [    Rule scope                                       esc
                  Git commit [on]
                  git rebase [on]      [S]earch
                  git reset [on]
                  git reset --hard     Project Stored with this project
                  npm run [on]         Global Stored in your global config
                  Git history rewri    Defaults Shared default for every agent
                  Remove files [on]
                  Recursive force r
                  Sudo [on]
                  Change permissions or ownership [on]
                  Download with curl or wget [on]
                  SSH or SCP [on]
                  Docker [on]
                  Kubectl [on]
                  JavaScript package install [on]
                  npm publish [on]
                  pip install [on]
                  Kill processes [on]
                  Disk destructive [on]
                  Package scripts [on]
        + plan
          + Tools
            + Native
              + shell [on]
                  shell [on]
                  git [on]
                  Git push [on]
                  env [on]
                  git checkout -- [on]
                  Git commit [on]
                  git rebase [on]
arrows move · left/right expand · enter edit · a add · / filter · ? help · esc back
```

## After: optional refusal-message prompt

```text
--- Terminal 130x45 | Cursor: (14, 37) ---
 Instructions                                                     Project (root)
 ›- Project
    + Agents                                                      No item details
    + Teams
  - Global
    + Agents
    + Teams
  - Defaults
    + Agents
    + Teams
                                     Message shown on refusal (optional)                  esc
                                     [f]orce pushes are not allowed here
                                     enter submit
arrows move · left/right expand · enter edit · a add · / filter · ? help · esc back
```

## After: saved rule disabled with refusal text in detail pane

```text
--- Terminal 130x45 | Cursor: (44, 124) ---
Filter:cRound3 refusal                                            Round3 refusal (item)
  - Project                                                    ▀
    + Agents                                                      Project · build · catalogue: agents · perm:shell:round3-refusal
      + Native
        + build                                                   overridden here: Project
          + Tools
            + Native                                              off
              + shell [on]
 ›                Round3 refusal [off]                            tool: shell · rule: round3-refusal · custom
        + plan                                                    patterns: printf round3-denied
          + Tools                                                 keywords: printf round3-denied
            + Native                                              provenance: (curated)
              + shell [on]                                        message: Round3 sentinel command is denied.
                  Round3 refusal [on]
        + Special                                                 0 lines hidden by rules:
          + general
            + Tools                                               Sections:
              + Native
                + shell [on]                                        - Round3 refusal [excluded]
                    Round3 refusal [on]
          + explore                                               Round3 refusal
            + Tools                                               printf round3-denied [excluded]
              + Native
                + shell [on]
                    Round3 refusal [on]                                                                                                     + compaction
            + Tools
              + Native
                + shell [on]
                    Round3 refusal [on]
          + title
            + Tools
              + Native
                + shell [on]
                    Round3 refusal [on]
          + summary
            + Tools
              + Native
                + shell [on]
                    Round3 refusal [on]
  - Global
    + Agents
      + Native
        + build
arrows move · left/right expand · enter edit rule · space toggle · a add · d delete · r reset · / filter · ? help · esc back
                                                                                                                            [_]
```

## After: empty run-backed Team tab

```text
--- Terminal 130x45 | Cursor: (6, 128) ---
   New session                   +
  ┃                                                                                       New session - 2026-09-21T17:48:09.
  ┃  Round3 parent chat                                                                   121Z
  ┃
                                                                                          MCP
     Error: Error from provider (Console): OpenCode's free tier can only be used from     • search                    Connected [ ]
     within OpenCode
     Build · Muse Spark 1.3 Free · 567ms
  ┃
  ┃  Subagents  Shell  Terminals  Team                                           esc
  ┃
  ┃  No active runs
  ┃
  ┃  move ↑↓  attach ⏎  active ctrl+a  stop|resume ctrl+d  tabs ←/→
  ┃                                                                                       /…/tui-lab-r3-main-1ecb-a…/proj:master
```
