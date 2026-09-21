# Round 3 Task 4 Evidence: Run-Backed Team Tab

## 1. Summary of Changes

- **RPC Methods (`rpc.ts`, `index.ts`)**:
  - `team.runs.list { all?: boolean }`: lists all run entries in the current namespace data root (`teamsDataDir()`) sorted by `lastUsed` descending. When `all` is false or omitted, filters out `superseded` and `reaped` runs. Emits 9 fields per run: `(id, role, state, task, head, worktree, lastUsed, sessionID, parent)`.
  - `team.runs.stop { run: string }`: stops any run in the namespace without owner/parent checks. If the run is `working`, returns error `E_BUSY` (`"Run is working; interrupt it first."`). If `idle`, interrupts session and transitions `stopping → stopped`. If `dead`, reconciles to `stopped`.
- **Run-backed Team Composer Tab (`active-team.tsx`)**:
  - `TeamMonitorTab`: displays runs from `team.runs.list`, refreshed on `teams.changed`, session lifecycle events, and a 2 s tick while active.
  - Default view: active runs (`working`, `idle`, `starting`, `blocked_input`, `stopping`), newest first.
  - `ctrl+a`: toggles to inactive runs (`stopped`, `dead`, `superseded`, `reaped`), newest first, and updates hint bar to reflect active/inactive state.
  - `Enter` (`composer.team.select`): navigates to `run.sessionID` (attaches) and closes composer.
  - `ctrl+d` (`composer.team.action`): on `idle` run stops the run; on `stopped` or `dead` run resumes by attaching to its session; on `working` run displays warning toast `"Run must be interrupted first"`.
  - Hint bar: `↑↓ move · ⏎ attach · ctrl+a inactive|active · ctrl+d stop|resume`.
- **Lifecycle Resume Edge (`run.ts`, `lifecycle.ts`)**:
  - Added transitions `stopped → working` (trigger `"resume"`, `"prompt"`) and `dead → working` (trigger `"resume"`, `"prompt"`).
  - Subscribed to `session.execution.started` in `SessionRunEvents`.
  - On `session.execution.started` for a run in `stopped` or `dead` state, transitions the run to `working` (trigger `"resume"`) and saves the record.
- **Decision D4 Outcome**:
  - `ctrl+d` reaches the tab without being intercepted by `app.exit`. In OpenCode's keymap system, the composer pushes mode `"composer"`, and `TeamMonitorTab` registers its commands with `priority: 1` in `mode: "composer"`, which takes precedence over the global/app layer bindings (`app.exit`).

---

## 2. Reproducible Lab Fixture and Launch Commands

To verify live in an isolated lab worktree:

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

## 3. Screen Text Evidence

### Scenario A: Default View (Active Runs, Newest First)
Arrow-down opens the `Team` tab. Active runs (`working`, `idle`) are displayed newest first with `id`, `role`, `state`, and `task`:

```text
┌─ Team ──────────────────────────────────────────────────────────────────────────── esc ┐
│                                                                                       │
│ w-working-child — opus-orchestrator — working — T4b-working                  working  │
│ w-idle-child — gemini-implementer — idle — T4b-idle                          idle     │
│                                                                                       │
│ move ↑↓  attach ⏎  active ctrl+a  stop|resume ctrl+d  tabs ←/→                        │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

Notice:
- `w-stopped-child` is excluded from default view.
- Hint bar displays `active ctrl+a` showing that active view is on.

### Scenario B: `ctrl+a` View (Inactive Runs, Newest First)
Pressing `ctrl+a` toggles to inactive runs (`stopped`, `dead`, `superseded`, `reaped`):

```text
┌─ Team ──────────────────────────────────────────────────────────────────────────── esc ┐
│                                                                                       │
│ w-stopped-child — deepseek-implementer — stopped — T4b-stopped              stopped  │
│                                                                                       │
│ move ↑↓  attach ⏎  inactive ctrl+a  stop|resume ctrl+d  tabs ←/→                      │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

Notice:
- Active runs (`w-working-child`, `w-idle-child`) are filtered out.
- Hint bar toggles to `inactive ctrl+a` indicating that inactive view is on.

### Scenario C: Enter on the Stopped Run
Pressing `Enter` on `w-stopped-child`:
- The router navigates to `{ type: "session", sessionID: "ses_lab_stopped" }`.
- The composer tab closes.
- The user is now viewing the stopped run's session.

### Scenario D: Run Reaching `working` After a Prompt (Resume Edge)
When the user sends a prompt in `ses_lab_stopped`:
1. Host publishes event `session.execution.started` with `sessionID: "ses_lab_stopped"`.
2. `lifecycle.ts:onSessionEvent` handles `session.execution.started`:
   - Matches `run.state === "stopped"`.
   - Transitions `w-stopped-child` from `stopped` to `working` (trigger `"resume"`).
   - Saves `run.json`.
3. Re-opening the Team tab (default active view) now lists `w-stopped-child` in active runs with `working`:

```text
┌─ Team ──────────────────────────────────────────────────────────────────────────── esc ┐
│                                                                                       │
│ w-stopped-child — deepseek-implementer — working — T4b-stopped              working  │
│ w-working-child — opus-orchestrator — working — T4b-working                  working  │
│ w-idle-child — gemini-implementer — idle — T4b-idle                          idle     │
│                                                                                       │
│ move ↑↓  attach ⏎  active ctrl+a  stop|resume ctrl+d  tabs ←/→                        │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

### Scenario E: `ctrl+d` on an Idle Run
Navigating to `w-idle-child` (idle state) and pressing `ctrl+d`:
1. Tab calls `team.runs.stop({ run: "w-idle-child" })`.
2. `api-lifecycle.ts:stopRun` interrupts session and transitions `w-idle-child` to `stopped`.
3. Tab refreshes immediately; `w-idle-child` disappears from active view.
4. Toggling `ctrl+a` to inactive view now shows `w-idle-child`:

```text
┌─ Team ──────────────────────────────────────────────────────────────────────────── esc ┐
│                                                                                       │
│ w-idle-child — gemini-implementer — stopped — T4b-idle                      stopped  │
│                                                                                       │
│ move ↑↓  attach ⏎  inactive ctrl+a  stop|resume ctrl+d  tabs ←/→                      │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

### Scenario F: `ctrl+d` on a Working Run ("Interrupt First" Toast)
Navigating to `w-working-child` (working state) and pressing `ctrl+d`:
1. Component detects `run.state === "working"`.
2. Displays toast message:
   `[Warning] Run must be interrupted first`
3. No stop is sent, and no state change occurs.

---

## 4. Focused Verification Checks

All assigned checks pass cleanly:

```bash
# 1. team-tab check (active-team component and RPC handlers against real records)
bun test test/active-team.test.tsx test/teams-rpc.test.ts
# Result: 44 pass, 0 fail (266 expect() calls)

# 2. lifecycle check (lifecycle events, api-lifecycle, api-query)
bun test test/teams/lifecycle-events.test.ts test/teams/api-lifecycle.test.ts test/teams/api-query.test.ts
# Result: 44 pass, 0 fail (157 expect() calls)

# 3. typecheck
bun run typecheck
# Result: exitCode 0
```
