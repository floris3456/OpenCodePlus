# Round 3 T5 — runtime leftovers evidence

Task: T5 (round 3). Scope: `teams/tools.ts` (audit state), `teams/api.ts`
(delegate registration order), `teams/worktree.ts` (create/remove),
`project.ts` (resolution), `teams/run.ts` + `index.ts` (run
`projectDirectory`, activation and API resolution), plus SPEC/README.

This revision supersedes the partial one:

- Item 12 is now reproduced by the **real** failure mechanism. The earlier
  symlink/canonical-name test in `worktree.test.ts` only pins the canonical
  name `create` returns; it never produced a `NotFound`, because the directory
  it names does exist. The real end-to-end failure is the orphan sweep racing
  the first `delegate`: `sessions.create` activates Plus in the new worktree
  before `delegate` had saved the child `run.json`, so the periodic GC found a
  worktree no run claimed and force-removed it before the host's
  `FileSystem.realPath` resolved it.
- The disabled-root RPC tests now isolate themselves with an explicit disabled
  `.opencodeplus/project.json` instead of relying on a bare temp directory,
  because project mode resolves upward into this workspace.

Every capture below is from the assigned checks:

```
team-runtime   bun test test/teams/tools.test.ts test/teams/audit.test.ts test/teams/worktree.test.ts test/teams/api.test.ts test/project-mode.test.tsx   (cwd packages/plus)
rpc-isolation  bun test test/rpc.test.ts test/teams-rpc.test.ts                                                                                        (cwd packages/plus)
typecheck      bun run typecheck                                                                                                                       (cwd packages/plus)
```

---

## Item 11 — two Code Mode calls that share one CallID

Source state (unchanged from the partial base, verified by inspection):
`teams/tools.ts` keeps audit state per `registerTeamTools` registration as a
FIFO queue per `(sessionID, messageID, CallID)` plus a request ID →
invocation map. `runGated` claims one queue entry per invocation
(`claimCall`, `tools.ts:102`), the `permission.asked` observer binds the
request to the unclaimed entry whose tool the action names (`bindAsked`,
`tools.ts:123`), and the `permission.replied` observer writes the line for
the invocation its request named (`handleReplied`, `tools.ts:225`). The
`execute.after` observer takes an unclaimed entry only (`takeCall`,
`tools.ts:110`). There is no global map and no value keyed by CallID alone.

Test: `test/teams/tools.test.ts` › "two Code Mode calls that share one CallID
write two distinct audit lines". One shared `Tool.Context`
(`id: call_codemode_shared`, `messageID: msg_codemode_shared`) drives a
`team_delegate` that waits on a human `ask` and a `team_status` that completes
while it waits; the delegate is then rejected with feedback. The test asserts
exactly `[team_status allowed true …, team_delegate asked:deny false …]` and
that `audit.verify` still passes.

Actual output of that test in the final `team-runtime` run:

```
[T5 item 11] shared CallID "call_codemode_shared" →
  {"tool":"team_status","outcome":"allowed","ok":true,"code":null,"actor":"fable-planner","sessionID":"ses_shared_call_id","run":"main-sharedcall0001","seq":2}
  {"tool":"team_delegate","outcome":"asked:deny","ok":false,"code":"E_PERMISSION","actor":"fable-planner","sessionID":"ses_shared_call_id","run":"main-sharedcall0001","seq":3}
```

Both lines carry the right tool, outcome, actor, session, run and code; the
sibling that finished first did not consume the pending call's refusal line.

---

## Item 12 — the first delegate in a brand-new data root (real GC race)

Mechanism, now closed in `teams/api.ts`:

1. `delegate` creates the worktree with the real `worktree.create`.
2. It now writes the **starting child run** (`state: "starting"`,
   `sessionID: null`, `directory: created.dir`,
   `projectDirectory: parent.projectDirectory ?? parent.directory`) and syncs
   it to disk **before** `ctx.session.create(...)`.
3. Creating the session is what activates Plus in the new worktree (the child
   plugin instance is built for that Location) and what the plugin's startup
   sweep can interleave with. Because the record is already on disk, the
   sweep's orphan scan (`gc` → `worktree.orphans(repoRoot, owned, knownDirs)`)
   finds `created.dir` in `knownDirs` and removes nothing; activation with no
   session id yet resolves the record by directory
   (`run.byDirectory` → `index.ts activationDirectory`).
4. The session id is written onto the same record immediately after the host
   returns it.
5. If `sessions.create` fails, the pre-registered run is transitioned
   `starting → superseded` before the error surfaces, so it does not keep
   claiming a bounds slot forever (`reconcile` skips records with no session
   id).

Test: `test/teams/api.test.ts` › "the first delegate registers the child run
before the host opens its session". It uses the real `worktree.create`, the
real `gc(root)` (default policy, the same function `sweep` calls) and the real
`fs.realpath` boundary. The recording session domain runs the sweep inside
`create`, i.e. in exactly the window the host opens the session, and captures
what a real host would see:

- `fs.realpath(location)` before the sweep,
- `activationDirectory(location)` (the project mode the child plugin would use),
- `byDirectory(root, location)?.sessionID` (must be `null`),
- `gc(root).orphansRemoved` (must be `[]`),
- `fs.realpath(location)` after the sweep,
- `fs.realpath(value.directory)` once `delegate` returns.

**Failing-before** — the same test run against the pre-fix ordering (session
created first, record written after; `teams/api.ts` reverted only for this
run). Command: `team-runtime` as above. Exit code 1; 81 pass, 1 fail. (Line
numbers are from the captured run; later cosmetic logging added to the same
test does not change what it asserts.)

```
test/teams/api.test.ts:
(pass) delegate creates a worktree session, record, brief and prompt [35.70ms]
(pass) delegate activates the child through the parent project, with no copy [19.28ms]
311 |         directory: string
312 |       }
313 |
314 |       // The host's realPath boundary: the directory it resolves exists, and it
315 |       // still exists after the sweep that ran during session creation.
316 |       expect(await fs.realpath(value.directory)).toBe(value.directory)
                            ^
ENOENT: no such file or directory, lstat '/home/bliss/OpenCodePlus/run/team/development-models/runs/w-1e57ed56bbdb72c5/tmp/plus-team-api-Aws6ev/opencode/opencodeplus/teams/worktrees/opencode/implementer/t1e462-20260921-2026'
    path: "/home/bliss/OpenCodePlus/run/team/development-models/runs/w-1e57ed56bbdb72c5/tmp/plus-team-api-Aws6ev/opencode/opencodeplus/teams/worktrees/opencode/implementer/t1e462-20260921-2026",
 syscall: "lstat",
   errno: -2,
    code: "ENOENT"

      at async <anonymous> (/home/bliss/OpenCodePlus/worktrees/team-development-models/w-1e57ed56bbdb72c5/opencode/packages/plus/test/teams/api.test.ts:316:23)
      at async withIsolatedTeamsRoot (/home/bliss/OpenCodePlus/worktrees/team-development-models/w-1e57ed56bbdb72c5/opencode/packages/plus/test/teams/api.test.ts:33:18)
      at async <anonymous> (/home/bliss/OpenCodePlus/worktrees/team-development-models/w-1e57ed56bbdb72c5/opencode/packages/plus/test/teams/api.test.ts:264:9)
(fail) the first delegate registers the child run before the host opens its session [25.85ms]

1 tests failed:
(fail) the first delegate registers the child run before the host opens its session [25.85ms]

 81 pass
 1 fail
 473 expect() calls
Ran 82 tests across 5 files. [1.70s]
```

This is the class of failure the round-2 lab reported as
`E_INTERNAL: NotFound: FileSystem.realPath (.../teams/worktrees/proj/...-…)`:
the returned directory no longer exists. Nothing is faked — `gc` really
removed the worktree because no run record claimed it.

**Passing-after** — the final `team-runtime` run, exit code 0:

```
(pass) the first delegate registers the child run before the host opens its session [24.19ms]

 84 pass
 0 fail
 489 expect() calls
Ran 84 tests across 5 files. [1.71s]
```

The worktree text in `worktree.test.ts` was updated to say what it pins (the
canonical name `create` returns) and to point at this end-to-end repro; its
assertions are unchanged.

---

## Item 13 — no copied project config, activation upward, plain remove

Source changes (all present on this branch):

- `teams/worktree.ts`: `create` writes nothing under `.opencodeplus`; it
  resolves the new directory absolutely, creates its parent chain before
  `git worktree add`, and returns the `realpath` of the created directory.
  `remove` is a plain `git worktree remove` with no config special case
  (`worktree.ts:105`).
- `project.ts`: `read(directory)` walks parent directories to the nearest
  `.opencodeplus/project.json`. A config carrying `enabled: false` is an
  explicit opt-out that stops the walk and reports disabled; `disable` writes
  that marker into the directory it is given instead of deleting a file the
  walk would immediately re-inherit; `enable` replaces the marker. This is
  what lets a nested fixture (or checkout) opt out of an enabled ancestor.
- `teams/run.ts`: `RunRecord.projectDirectory?: string` and
  `byDirectory(root, directory)` (canonical-path comparison), which resolves a
  run by the worktree directory it owns even when `sessionID` is still null.
- `teams/api.ts`: `delegate` records
  `projectDirectory: parent.projectDirectory ?? parent.directory` and, as
  item 12 describes, writes that record before creating the session. The
  root-run bootstrap in `teams/tools.ts` records the Location's own directory.
- `index.ts`: `activationDirectory(directory)` returns a run's recorded
  `projectDirectory` when `byDirectory` finds the run that owns the Location,
  else the Location directory. `activate`, `refreshFromHost`, `publishFresh`
  (including team discovery and team policy rows), `applySessionModel`,
  `project.status` and every `createPlusApi` handler (guards, `snapshot`,
  `mutate`, `log`, `assembled`, and the write handlers) resolve through it.
  `project.enable`/`project.disable` stay on the Location's own directory.

Tests and captures:

- `test/teams/worktree.test.ts` › "create leaves no project config in the child
  worktree" — the parent has a project.json, the child has no `.opencodeplus`
  at all and `git status --porcelain` is empty.
- › "a parent without a project config still hands the child no file" — no
  invented default either.
- › "remove is a plain git worktree remove with no config special case" — a
  tracked `project.json` arrives with the checkout, the child's copy is the
  committed one, and a non-force `remove` succeeds.
- `test/project-mode.test.tsx` › "project mode resolves upward from a nested
  directory to the nearest config" — `read` finds the root's config from a
  nested directory and prefers the nearer one.
- › "an explicit disabled marker stops the upward walk and enable replaces it"
  — the marker file is
  `{"version":1,"protectedAgents":[],"enabled":false}`, `read` below it is
  `undefined`, the enabled ancestor is untouched, and `enable` replaces the
  marker.
- `test/teams/api.test.ts` › "delegate activates the child through the parent
  project, with no copy". Actual capture from the final run:

```
[T5 item 13] child /home/bliss/OpenCodePlus/run/team/development-models/runs/w-1e57ed56bbdb72c5/tmp/plus-team-api-WuJuIA/opencode/opencodeplus/teams/worktrees/opencode/implementer/t148cd-20260921-2028
  child/.opencodeplus/project.json exists: false
  run.projectDirectory: /home/bliss/OpenCodePlus/run/team/development-models/runs/w-1e57ed56bbdb72c5/tmp/plus-team-api-repo-vJar8E
  activationDirectory(child): /home/bliss/OpenCodePlus/run/team/development-models/runs/w-1e57ed56bbdb72c5/tmp/plus-team-api-repo-vJar8E
  project.read(activation): {"version":1,"protectedAgents":["muse-implementer"]}
```

- `test/teams/api.test.ts` › "activation in a child worktree installs the
  parent project's agents and tools". This drives the **real plugin
  entrypoint** (`src/index.ts` default export) through the shared
  `fullContext` harness, with a Location whose directory is the child
  worktree and a real parent project that enables one project team
  (`crew`/`alpha`). No activated flag is fabricated: the test asserts the
  tool registrations the harness actually holds
  (`team_delegate`, `team_status`, eight `instructions_*` tools), that
  `agent.list()` really contains the team member `alpha`, and that closing
  the plugin scope disposes every one of them (`installedToolIds(ctx)` is
  `[]` afterwards). Actual output from the final run:

```
[T5 item 13] child plugin activation through the real entrypoint
  location: .../teams/worktrees/opencode/implementer/t1a58e-20260921-2029
  team tools installed: 14
  instructions tools installed: 8
  team member agents installed: alpha
```

- `test/teams/api.test.ts` › "project guards, snapshot and mutate resolve a
  child worktree through its run's projectDirectory". With the child worktree
  as the Location, `project.status` is `{enabled:true,directory:<parent repo>}`,
  `instructions.snapshot` succeeds, and `instructions.mutate` with the
  snapshot's revisions returns `ok:true` — all through the real handlers on
  the real harness, with no `.opencodeplus/project.json` in the child. Actual
  output from the final run:

```
[T5 item 13] child API resolves the inherited project
  location: .../teams/worktrees/opencode/implementer/t16818-20260921-2029
  project.status: {"enabled":true,"directory":".../plus-team-api-repo-moShSV"}
  snapshot revisions: project=0 global=0
  mutate ok: true
```
- `test/teams/api.test.ts` › "a failed session create retires the pre-registered
  child run" — `E_INTERNAL` from the failed create, one child record,
  `state: "superseded"`, `sessionID: null`.

`activationDirectory` is directory-based because a plugin instance runs per
Location and activation has no session id; `byDirectory` compares canonical
paths so a symlinked or relative data root still matches.

---

## Disabled-root fixture isolation (`rpc-isolation`)

Project mode resolves upward, and this development workspace root is Plus
enabled, so a bare temp project under `TMPDIR` resolved `enabled: true`. Five
existing cases failed for that reason. The fix is in the fixtures only: both
`tempRoot()` helpers (`test/rpc.test.ts`, `test/teams-rpc.test.ts`) now write
an explicit disabled project.json with `disable(project)` before any test
runs, and tests that need project mode call `enable(project)` as before. No
assertion was weakened or removed.

Failing before (base, `rpc-isolation`, exit 1):

```
(fail) gated methods fail with project.disabled when project mode is off [8.91ms]
(fail) team.create raises every declared error through a real call [4.01ms]
(fail) team.setEnabled is gated on project mode with project.disabled [0.52ms]
(fail) team.delete raises every declared error through a real call [0.67ms]
(fail) team.list returns discovered teams, enabled state, and member modes without a snapshot [4.23ms]

 76 pass
 3 skip
 5 fail
 683 expect() calls
Ran 84 tests across 2 files. [647.00ms]
```

Passing after (final `rpc-isolation`, exit 0):

```
(pass) gated methods fail with project.disabled when project mode is off [13.02ms]
(pass) team.create raises every declared error through a real call [3.87ms]
(pass) team.setEnabled is gated on project mode with project.disabled [0.42ms]
(pass) team.delete raises every declared error through a real call [1.81ms]
(pass) team.list returns discovered teams, enabled state, and member modes without a snapshot [4.98ms]

 81 pass
 3 skip
 0 fail
 721 expect() calls
Ran 84 tests across 2 files. [721.00ms]
```

---

## Check receipts

Final HEAD of this task branch:

```
team-runtime:  exit 0
  84 pass, 0 fail, 489 expect() calls, ran 5 files
rpc-isolation: exit 0
  81 pass, 3 skip, 0 fail, 721 expect() calls, ran 2 files
typecheck:     exit 0
  tsgo --noEmit -p tsconfig.test.json
```

## Delivered / deferred

Delivered: items 11, 12 and 13 of the round-3 plan — per-call audit state kept
and re-proven, the real first-delegate GC race closed by registering the
starting run before session creation, child activation and the project API
resolving the recorded `projectDirectory`, explicit disabled project markers
for opt-out and fixture isolation, plain `worktree.remove`, the tests above,
and the SPEC/README updates in the same commit.

Deferred (out of this task's end state, noted for the reader): `discoverAll`'s
instruction discovery still reads `ctx.location.project.directory` as core
resolves it for the Location (it is not available in this task's edit scope);
team discovery, policy rows, `publishFresh`, activation and the whole Plus API
use the run's recorded `projectDirectory`.