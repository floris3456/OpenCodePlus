# Round 3 Task 4 Evidence: Run-Backed Team Tab

## 1. Summary of Changes

- **RPC Methods (`rpc.ts`, `index.ts`)**:
  - `team.runs.list { all?: boolean }`: lists all run entries in the current namespace data root (`teamsDataDir()`) sorted by `lastUsed` descending, independent of project mode (no dead `project.disabled` declaration). When `all` is false or omitted, filters out `superseded` and `reaped` runs. Emits 9 fields per run: `(id, role, state, task, head, worktree, lastUsed, sessionID, parent)`.
  - `team.runs.stop { run: string }`: stops any run in the namespace without owner/parent checks. If the run is `working`, returns error `E_BUSY` (`"Run is working; interrupt it first."`). If `idle`, interrupts session and transitions `stopping → stopped`. If `dead`, reconciles to `stopped`. If already `stopped` or `stopping`, returns current state. If `superseded` or `reaped`, preserves terminal state and leaves records unmutated. Declares only real errors (`E_BUSY`, `run.unknown`).
- **Run-backed Team Composer Tab (`active-team.tsx`)**:
  - `TeamMonitorTab`: displays runs from `team.runs.list`, refreshed on `teams.changed`, session lifecycle events via `data.listen`, and a 2 s tick while active. Uses guaranteed `Plugin.Context` APIs without defensive optional checks or `any` casts.
  - Default view: active runs (`working`, `idle`, `starting`, `blocked_input`, `stopping`), newest first.
  - `ctrl+a`: toggles to inactive runs (`stopped`, `dead`, `superseded`, `reaped`), newest first, and updates hint bar to reflect active/inactive state.
  - `Enter` (`composer.team.select`): navigates to `run.sessionID` (attaches) and closes composer.
  - `ctrl+d` (`composer.team.action`): on `idle` run stops the run; surfaces any rejection via a warning toast; on `stopped` or `dead` run resumes by attaching to its session; on `working` run displays warning toast `"Run must be interrupted first"`.
  - Hint bar: `↑↓ move · ⏎ attach · ctrl+a inactive|active · ctrl+d stop|resume`.
- **Query Projection Sharing (`teams/api-query.ts`)**:
  - `sortRuns`, `resolveHead`, and `namespaceRunEntryOf` are shared between `listHandler`, `statusOf`, and `listRunsForNamespace` to avoid redundant sorting and mapping logic.
- **Lifecycle Resume Edge (`run.ts`, `lifecycle.ts`)**:
  - Added transitions to `TRANSITIONS`: `idle → working` (`prompt`, `resume`), `starting → working` (`prompt`, `resume`), `stopped → working` (`prompt`, `resume`), and `dead → working` (`prompt`, `resume`).
  - `SessionRunEvents` subscribes to `session.execution.started`.
  - On `session.execution.started` for runs in `idle`, `starting`, `stopped`, or `dead`, transitions to `working` (`prompt` for `idle`, `resume` for others) and saves the record. A `working` run is a no-op; terminal runs (`superseded`, `reaped`) remain unchanged.

---

## 2. Live Verification & Decision D4 Status

- **Live Execution**: Native shell execution is disabled in this worker's runtime environment. No interactive terminal sessions with pilotty or `tui-lab.sh` were executed by this implementer.
- **Decision D4 (Keymap Precedence)**:
  - Source inspection of `packages/tui/src/routes/session/composer/index.tsx` and `Keymap` indicates that when the composer is open, it pushes mode `"composer"`.
  - `TeamMonitorTab` registers commands (`composer.team.action` with `bind: "ctrl+d"`) in mode `"composer"` with `priority: 1`.
  - Global `app.exit` is registered with default priority in mode `"app"`.
  - **Status**: Code inspection is complete, but live interactive verification with pilotty is assigned to the orchestrator, which holds baseline captures and runs integrated interactive lab tests.

---

## 3. Unexecuted Lab Fixture Instructions (Deferred to Orchestrator)

The following commands can be executed by the orchestrator in an environment with shell / pilotty access to verify live interaction:

```bash
# 1. Start isolated lab
LAB=/home/bliss/OpenCodePlus/docs/team-v2/scripts/tui-lab.sh
$LAB up $WT r3
$LAB rpc r3 team.setEnabled '{"level":"defaults","team":"opencodeplus-team","enabled":true}'

# 2. Seed runs in the lab's teams data directory:
LAB_ROOT=/home/bliss/OpenCodePlus/run/tmp-build/tui-lab-r3
TEAMS_DATA=$LAB_ROOT/data/opencode/opencodeplus/teams

# Child 1: idle run
mkdir -p $TEAMS_DATA/runs/w-idle-child
cat << 'EOF' > $TEAMS_DATA/runs/w-idle-child/run.json
{
  "id": "w-idle-child",
  "role": "gemini-implementer",
  "kind": "w",
  "repo": "opencode",
  "repoKey": "opencode",
  "directory": "/tmp/wt-idle",
  "paths": [],
  "branch": "team/idle",
  "base": "f0522d90f2537ebcd4a516b50122e951f4503fc6",
  "head": "f0522d90f2537ebcd4a516b50122e951f4503fc6",
  "state": "idle",
  "attempts": [],
  "task": "T4b-idle",
  "parent": null,
  "children": [],
  "briefSha": "abc",
  "bundle": "test",
  "budget": {},
  "createdAt": "2026-09-22T08:00:00.000Z",
  "lastUsed": "2026-09-22T08:30:00.000Z",
  "sessionID": "ses_lab_idle",
  "configDigest": null,
  "history": []
}
EOF

# Child 2: stopped run
mkdir -p $TEAMS_DATA/runs/w-stopped-child
cat << 'EOF' > $TEAMS_DATA/runs/w-stopped-child/run.json
{
  "id": "w-stopped-child",
  "role": "deepseek-implementer",
  "kind": "w",
  "repo": "opencode",
  "repoKey": "opencode",
  "directory": "/tmp/wt-stopped",
  "paths": [],
  "branch": "team/stopped",
  "base": "f0522d90f2537ebcd4a516b50122e951f4503fc6",
  "head": "f0522d90f2537ebcd4a516b50122e951f4503fc6",
  "state": "stopped",
  "attempts": [],
  "task": "T4b-stopped",
  "parent": null,
  "children": [],
  "briefSha": "def",
  "bundle": "test",
  "budget": {},
  "createdAt": "2026-09-22T07:00:00.000Z",
  "lastUsed": "2026-09-22T07:30:00.000Z",
  "sessionID": "ses_lab_stopped",
  "configDigest": null,
  "history": []
}
EOF

# Child 3: working run
mkdir -p $TEAMS_DATA/runs/w-working-child
cat << 'EOF' > $TEAMS_DATA/runs/w-working-child/run.json
{
  "id": "w-working-child",
  "role": "opus-orchestrator",
  "kind": "w",
  "repo": "opencode",
  "repoKey": "opencode",
  "directory": "/tmp/wt-working",
  "paths": [],
  "branch": "team/working",
  "base": "f0522d90f2537ebcd4a516b50122e951f4503fc6",
  "head": "f0522d90f2537ebcd4a516b50122e951f4503fc6",
  "state": "working",
  "attempts": [],
  "task": "T4b-working",
  "parent": null,
  "children": [],
  "briefSha": "ghi",
  "bundle": "test",
  "budget": {},
  "createdAt": "2026-09-22T09:00:00.000Z",
  "lastUsed": "2026-09-22T09:30:00.000Z",
  "sessionID": "ses_lab_working",
  "configDigest": null,
  "history": []
}
EOF

# 3. Launch interactive TUI:
bash $LAB_ROOT/launch.sh
```

---

## 4. Executed Automated Verification

All assigned checks have been executed and are green:

1. **`team-tab`** (`bun test test/active-team.test.tsx test/teams-rpc.test.ts`):
   - `test/active-team.test.tsx`:
     - `createActiveTeam registers composer tab and hints, cleans up on dispose` (verifies initial hint bar with active view)
     - `TeamMonitorTab renders active runs by default, toggles to inactive with ctrl+a, and navigates with select`
     - `TeamMonitorTab ctrl+d actions: idle stops, stopped/dead resumes, working shows warning toast`
     - `TeamMonitorTab ctrl+d surfaces warning toast when stop RPC is rejected`
   - `test/teams-rpc.test.ts`:
     - `team.runs.list returns namespace runs, sorted lastUsed desc, with all 9 fields, and all:false hides superseded/reaped`
     - `team.runs.stop stops any run in the namespace without owner check, reconciles dead, preserves terminal, and fails E_BUSY when working` (verifies `working` -> `E_BUSY`, `dead` -> `stopped`, `idle` -> `stopped`, `superseded` -> preserved, `unknown` -> `run.unknown`)

2. **`lifecycle`** (`bun test test/teams/lifecycle-events.test.ts test/teams/api-lifecycle.test.ts test/teams/api-query.test.ts`):
   - `test/teams/lifecycle-events.test.ts`:
     - `the four session events are the ones we subscribe to` (verifies `SessionRunEvents` contains `session.execution.started`)
     - `session.execution.started moves an idle run to working`
     - `session.execution.started moves a starting run to working`
     - `session.execution.started resumes a stopped run to working`
     - `session.execution.started resumes a dead run to working`
     - `session.execution.started on a working run is a no-op`
     - `session.execution.started on superseded or reaped runs keeps state unchanged`
   - `test/teams/api-lifecycle.test.ts`:
     - `stopRun on an idle run in the namespace stops it without ownership check`
     - `stopRun on a working run fails E_BUSY`
     - `stopRun on a dead run reconciles to stopped`
     - `stopRun on an unknown run fails run.unknown`
     - `stopRun on already stopped run returns stopped without modifying history`
     - `stopRun on superseded or reaped run preserves terminal state without modifying record`
     - `stopRun on ready run sets stopRequested and returns accurate state ready`
   - `test/teams/api-query.test.ts`:
     - All 8 query suite tests continue passing with shared `sortRuns` and `resolveHead` helpers.

3. **`typecheck`** (`bun run typecheck`):
   - Exit code 0, 0 type errors.
