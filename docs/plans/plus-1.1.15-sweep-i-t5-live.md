# Instructions T5 live sweep — Flash-C-Worker t136f068

Final live sweep of Instructions T5 ("Global and Project team members never leak
into Defaults, including a team named like a shipped preset team") in this
worktree's own build. Evidence only; no source file changed.

## Build under test

- Worktree (this one):
  `/home/bliss/OpenCodePlus/run/plus/data/opencodeplus/teams/worktrees/opencode/Flash-C-Worker/t136f068-20261005-1811`
- HEAD at test start: `31623301b057b3c65489fea2616d4889ecb5ae05`
  (branch `team/Flash-C-Worker/t136f068-20261005-1811`).
- Launched exactly: `pilotty spawn --name sweep-i-t5 opencodeplus-dev .` from
  the worktree root, then `pilotty resize -s sweep-i-t5 160 48`. Own dev home,
  never shared port 40375, never `bun run dev:live`, never `bun run dev`.
- Owned dev home (`$DEV`):
  `/home/bliss/OpenCodePlus/run/plus-dev/run-plus-data-opencodeplus-teams-worktrees-opencode-Flash-C-Worker-t136f068-20261005-1811`
- Real global config directory of this dev build (upstream identity):
  `$DEV/config/opencode`; Global instruction store in
  `$DEV/config/opencode/opencodeplus/instructions/records.jsonl`; Global teams in
  `$DEV/config/opencode/opencodeplus/teams/`; project store in
  `$DEV/project/.opencodeplus/`.
  `~/.config/opencodeplus` is the installed product's directory and was never
  read or written.
- Server log: `$DEV/data/opencode/log/opencode-local.log`.

## End-state line

Copied from `docs/plans/plus-1.1.12-instructions.md` T5:

**End state:** creating a team at Global or Project and adding members from
presets one by one writes only that team's files and team-scoped records. Those
members appear only under that level's team, and under levels that resolve
through it as today. They never appear under Defaults (Agents or Teams), and no
Defaults entry, overlay or record is written. This includes a team whose name
equals a shipped preset team's name in another case (`Basic` vs `basic`) or
the same case.

## Decisions taken for this build

- This home already has a Global team named `Basic` (copied from the release).
  New teams: a Global team `BASIC` and a Project team `basic`, members added
  from Presets › Teams › Basic members one by one.
- Before the first change: `grep -c '"level":"defaults"'` on the global store,
  and `ls -R` of the Defaults overlay/entries location.
- After each team's members are added: repeat both, and quote Defaults › Agents
  and Defaults › Teams from the tree.
- Where something cannot be shown live, cite `bun test test/tree.test.ts` or
  `bun test test/agents.test.ts` from `packages/plus`.

## Results

(Each result is added below the moment it is observed; checkpoints follow.)

### Baseline before the first change

Session spawned and resized; TUI came up on `Build · claude-opus-5-5
CLIProxyAPI · high`. Pre-existing store and the Defaults location:

```
$ grep -c '"level":"defaults"' "$DEV/config/opencode/opencodeplus/instructions/records.jsonl"
10
$ head -1 "$DEV/config/opencode/opencodeplus/instructions/records.jsonl"
{"version":2,"revision":492}
$ wc -l "$DEV/config/opencode/opencodeplus/instructions/records.jsonl"
255
```

The Defaults overlay/entries location on disk is the global instruction store
itself — there is **no** on-disk Defaults overlay or entries directory in this
build (the old `teams-defaults/` overlay is not read; `teams.ts:8-13`). An
`ls -R` of the only global Plus location, `$DEV/config/opencode/opencodeplus/`:

```
$ ls -R "$DEV/config/opencode/opencodeplus/"
.../opencodeplus/:
instructions

.../opencodeplus/instructions:
OPENCODEPLUS.md
linked-projects.json
log.jsonl
records.jsonl
```

No `teams/`, no `skills/`, no `teams-defaults/`, no `entries/` directory exists
at baseline. The 10 `"level":"defaults"` lines are all `model` /
`modelSettings` rows (lines 223, 226, 227, 234, 237, 240, 246, 251, 252, 253);
there is **no** `"type":"entry"` record at all (`grep -c '"type":"entry"'` = 0)
and no `"type":"team"` record with `"level":"defaults"` (the two team records
are `global/Basic` and `global/Simple`).

Existing (release-copied) Global teams in the store: `global/Basic`
(`enabled:false`) and `global/Simple` (`enabled:true`). Per the Brief's
decision, the new Global team is named `BASIC` (different case from the shipped
`Basic`).


