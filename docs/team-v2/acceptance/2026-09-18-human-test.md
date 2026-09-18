# Human test script — run a team from the product (2026-09-18)

This is the procedure a person follows to run a team on a real project through
OpenCodePlus itself. It was written first, then executed end to end by the
orchestrator that landed the lifecycle, shell, model and handler work. Each
step names the command or keypress, what you should see, and where to look when
you want the evidence rather than the screen.

---

## 0. Before you start

You need:

- a **project directory** — any git repository with at least one commit and a
  test you can name as a focused check. This run used a copy of the
  repository's own `packages/util` as a standalone project: real source, real
  tests, and the check we pick needs no `node_modules`.
- a **models config** — `opencode.json` with your provider and models. Running
  the product normally this is your own `~/.config/opencode`; this acceptance
  run used an isolated one so it could never touch the human's.

Paths used throughout:

```
GATE = run/team/development-models/runs/main-eb54dee54b63c6e5/tmp/opencode/gate-human
  config/opencode/opencode.json   provider + models (mode 0600, never printed)
  home/{data,state,cache}         XDG_DATA_HOME / STATE_HOME / CACHE_HOME
  tmp/                            TMPDIR
  project/                        the real project (a copy of packages/util)
  env.sh                          exports the isolated XDG home
  start-tui.sh                    the product entrypoint with that env
```

Team state for a given XDG home always lives at

```
$XDG_DATA_HOME/opencode/opencodeplus/teams/
  audit.log                     hash-chained event log
  runs/<run id>/                run.json, brief.md, checks.json,
                                receipts/, report-<n>.json, inbox/, merge/
  worktrees/<repo>/<role>/<n>   the children's worktrees
```

Never inside a worktree. `team_list` prints the run ids; everything else is a
file under that root.

**Normal invocation.** `bin/opencodeplus <project>` — that wrapper pins the
mainline checkout and the shared Plus data dir. This acceptance run needed the
task branch and an isolated home, so it called the same entrypoint one level
down with its own environment:

```sh
. $GATE/env.sh
$REPO/packages/plus/bin/opencodeplus $PROJ      # == sh $GATE/start-tui.sh
```

Both run `packages/cli/src/index.ts <project>`, i.e. the TUI, which starts its
own background server. There is no separate `serve` step.

---

## 1. Open the product and enable project mode

```sh
sh $GATE/start-tui.sh
```

**Expect:** the OpenCode TUI on the project, with a normal chat composer.

Press `Ctrl+P` to open the command palette, type `project`, and choose
**Toggle project mode**. Confirm the dialog ("Enable project mode for
<project>?") with `Enter`.

**Expect:** a toast, and `.opencodeplus/project.json` now exists in the project.

**Where to look:**

```sh
cat $PROJ/.opencodeplus/project.json
```

## 2. Enable the `opencodeplus-team` in the Instructions TUI

`Ctrl+P` → type `instructions` → **Instructions** (or `/instructions` in the
composer). Project mode must be on or the command is disabled.

Navigate **Defaults → Teams**. Put the cursor on `opencodeplus-team` and press
`space`.

**Expect:** the row flips to `[on]`, and expanding it lists exactly the nine
roles: `astra-planner`, `astra-reviewer`, `fable-planner`,
`gemini-implementer`, `muse-implementer`, `opus-orchestrator`, `scout`,
`sol-orchestrator`, `spark-implementer`.

**Where to look:** the store gains a team record —

```sh
grep '"type":"team"' \
  $XDG_CONFIG_HOME/opencode/opencodeplus/instructions/records.jsonl
```

and the live agent surface gains nine agents:

```sh
curl -s -u "opencode:$PW" "$SERVER/api/agent?directory=$PROJ" \
  | jq -r '.[].id' | sort
```

## 3. Pin a model per role

This is how you get two roles on two different models in one run.

Still in Instructions: **Defaults → Agents → opus-orchestrator → Model**, put
the cursor on the model you want and press `space` to activate it. Repeat for
**muse-implementer** with a *different* model.

**Expect:** each agent's Model section shows one active row.

**Where to look:**

```sh
grep '"type":"model"' \
  $XDG_CONFIG_HOME/opencode/opencodeplus/instructions/records.jsonl
```

Two lines, `{"type":"model","level":"defaults","agent":"opus-orchestrator",…}`
and `{"agent":"muse-implementer",…}`, each with `"active":true`.

You can also write those two lines into `records.jsonl` directly and bump the
header `revision`; the TUI and the plugin read the same file.

Confirm the pins really reached the sessions once the run is going:

```sh
curl -s -u "opencode:$PW" "$SERVER/api/session/<parent session id>" | jq .model
curl -s -u "opencode:$PW" "$SERVER/api/session/<child  session id>" | jq .model
```

## 4. Open a session as `opus-orchestrator` and bootstrap the run

Switch the session's agent to `opus-orchestrator` (the agent switcher in the
composer, or `Ctrl+P` → the agent command). Then type into the composer:

> Call team_prepare with no arguments, then stop and tell me the run id.

**Expect:** a `team_prepare` tool call returning

```json
{"run":"main-<hex>","session":"ses_…","directory":"<project>",
 "role":"opus-orchestrator","state":"working","base":"<sha>","head":"<sha>"}
```

This is the **root bootstrap form**: a no-argument `team_prepare` from an
orchestrator or planner session that owns no run creates the main run. Calling
it again from the same chat returns the same run (idempotent).

**Where to look:**

```sh
TEAMS=$XDG_DATA_HOME/opencode/opencodeplus/teams
cat $TEAMS/runs/main-*/run.json
grep '"kind":"run.created"' $TEAMS/audit.log
grep '"tool":"team_prepare"' $TEAMS/audit.log
```

## 5. Delegate a real task to `muse-implementer`

In the same chat:

> team_delegate to muse-implementer. requestID "h1". objective: <a real change
> in this project>. deliverable kind "commit". scope.paths: ["<the one file>"].
> checks: [{"id":"<id>","argv":["bun","test","<the test file>"]}]. effort small.

**Expect:** a `team_delegate` result with a new `w-…` run id, a session id, a
`directory` under `<teams>/worktrees/…`, a branch `team/implementer/…` and a
`briefPath`. The child starts working immediately — it is a session in the same
process, not a spawned host.

**Where to look:**

```sh
ls $TEAMS/runs/                  # main-… and w-…
cat $TEAMS/runs/w-*/brief.md     # exactly what the child received
cat $TEAMS/runs/w-*/checks.json  # the check you named
grep '"tool":"team_delegate"' $TEAMS/audit.log
```

## 6. Wait for it, then read it back three ways

In the same chat:

> team_wait on the child with timeoutMs 120000, then team_status, then
> team_list.

**Expect:**

- `team_wait` →
  `{"settled":[{"run":"w-…","attemptState":"succeeded","report":{"status":"done","summary":"…","path":"…/report-1.json"}}],"timedOut":false,"stillOpen":[],"overBudget":[]}`.
  `wait` carries status, summary and the report path only; read `needs` from
  `team_status` or from the report file.
- `team_status` → one entry per run with `state`, `attempt`, `attemptState`,
  `head`, `dirty`, `branch`, `checks:[{id,passed,atHead}]`, `report`,
  `children`, `parent`, `budget`.
- `team_list` → one row per visible run with `run, role, runtime, state, task,
  parent, head, branch, directory, reportStatus, lastUsed`. An orchestrator
  sees its own run plus its direct children; a planner sees every run in the
  namespace; `superseded` and `reaped` need `all:true`.

**Where to look:**

```sh
cat $TEAMS/runs/w-*/report-1.json  # status, needs, commits, checks, dirty
ls  $TEAMS/runs/w-*/receipts/      # <check>-<head7>.json, one per HEAD
grep '"tool":"team_wait"' $TEAMS/audit.log
```

## 7. Integrate the child's commit into your own worktree

Read your own HEAD first — `expectedParentHead` is *your* HEAD, never the
child's commit.

> Run `git rev-parse HEAD` (orchestrators have shell), then
> team_integrate {run:"w-…", expectedParentHead:"<that sha>"}.

**Expect:** `{"entry":"<ulid>","state":"landed","head":"<new parent HEAD>"}`,
and the project's working tree really contains the child's change.

The merge queue rebases the child in a temporary worktree, runs your
`team_set_checks` checks there, and only then fast-forwards your branch. It
refuses a dirty parent (`E_DIRTY`), a stale `expectedParentHead`
(`E_STALE_PARENT`), a child that is still working (`E_BUSY`), a child whose
last report is not done (`E_NOT_DONE`) and a second landing (`E_ALREADY`).

**Where to look:**

```sh
git -C $PROJ log --oneline -3
ls $TEAMS/runs/main-*/merge/     # <ulid>.json entries and _queue.json
grep '"tool":"team_integrate"' $TEAMS/audit.log
```

Worth doing before a review: record your own integration checks first, so the
queue verifies them.

> team_set_checks {checks:[{"id":"<id>","argv":["bun","test","<file>"]}]}

**Expect:** `{"checks":["<id>"]}`, written to
`$TEAMS/runs/main-<id>/checks.json`.

## 8. Stop a second child, then supersede it

Delegate a second child (`requestID "h2"`) on a different file, then, while it
is still working:

> team_stop {run:"w-…2"}

**Expect:** `E_BUSY: Child is working; call shutdown_request then wait, or
supersede.` — the documented refusal, not a failure of the tool.

> team_supersede {run:"w-…2", reason:"<at least 10 characters>", waitMs:0}

**Expect:**
`{"run":"w-…2","state":"superseded","hadUncommitted":<bool>,"head":"<sha>"}`.
The child's worktree and any commits it made are **kept** — supersede abandons,
it never deletes.

Then `team_stop` on a child that has finished (it is `idle`):

**Expect:** `{"run":"w-…","state":"stopped"}`.

**Where to look:**

```sh
jq '{state, supersededReason, history}' $TEAMS/runs/w-<second>/run.json
ls $TEAMS/worktrees/*/implementer/   # the superseded worktree is still there
grep -E '"tool":"team_(stop|supersede)"' $TEAMS/audit.log
```

## 9. Restart the product; the dead child reads dead, and you can delegate again

Quit the TUI and stop the background server it started, then launch again:

```sh
sh $GATE/start-tui.sh
```

On start the plugin runs **reconcile**: every non-terminal run whose host
session no longer exists moves to `dead` (`probe_failed` from `idle`/`working`,
`start_failed` from `starting`), its open attempt is marked `failed`, and one
line lands in the parent's inbox.

Open a session as `opus-orchestrator` in the same project, `team_prepare` (this
returns a *new* main run — the old chat's run belonged to the old session),
then:

> team_list {all:true}

**Expect:** the child from the interrupted run shows `state: "dead"` and
`runtime: "stopped"`.

A parent still holding the old run learns the same thing from a single
`team_wait`: wait reconciles before it reports `timedOut`, so a child whose
session died comes back as `settled` with `attemptState:"failed"` and
`report:null` instead of hanging out the whole timeout.

Finally confirm the parent can still delegate. **Finished children no longer
occupy a slot**, so a parent with four completed children can start a fifth.

> team_delegate … (requestID "h3")

**Expect:** a new `w-…` run id, not `E_BOUNDS`.

**Where to look:**

```sh
jq '{state, attempts, history}' $TEAMS/runs/w-<dead>/run.json
cat $TEAMS/runs/main-*/inbox/*.json | head
grep '"tool":"team_delegate"' $TEAMS/audit.log | tail -2
```

---

## Close out

Stop only your own gate's processes, then confirm the audit chain verifies:

```sh
pkill -f 'packages/cli/src/index.ts'
cd $REPO/packages/plus && TEAMS=$TEAMS bun -e '
  const { verify } = await import("./src/teams/audit.ts")
  console.log(await verify(process.env.TEAMS))
'
```

## What is not here yet

- **No sweeper.** Nothing polls. `reconcile` runs at plugin start and inside
  `team_wait` before it reports a timeout. A child that dies while nobody is
  waiting is noticed at the next wait or the next restart.
- **`integrate` reports only `landed` or `pending`.** A rebase conflict or a red
  integration check is recorded in the merge entry under
  `runs/<parent>/merge/<ulid>.json` (`state: "conflict"` with the files, or
  `"red"` with the check ids) but is returned to the caller as `pending`,
  because 03's output enum has no third value and the sweeper that delivers
  those outcomes to the parent inbox does not exist yet. Read the merge entry
  when `integrate` says `pending` and you expected `landed`.
- **Ten handlers are still scaffolded** and answer `E_NOT_IMPLEMENTED`:
  `review`, `diff`, `metrics`, `resume`, `shutdown_request`, `plan_handoff`,
  `prepare` (the `cwd` form only — the no-argument root form is real),
  `exa_code_search`, `tavily_search`, `tavily_extract`.
- **Implementers have no shell.** They edit files and run `team_check`; a
  `shell` call is refused immediately rather than hanging on a permission
  prompt nobody can answer.
