# Round 3 T5 — runtime leftovers evidence

Task: T5 (round 3). Scope: `teams/tools.ts` (audit state), `teams/worktree.ts`
(create/remove), `project.ts` (resolution), `teams/run.ts` + `teams/api.ts` +
`index.ts` (run `projectDirectory` and activation), plus SPEC/README.

Every capture below is from the assigned checks:

```
team-runtime  bun test test/teams/tools.test.ts test/teams/audit.test.ts test/teams/worktree.test.ts test/teams/api.test.ts test/project-mode.test.tsx   (cwd packages/plus)
typecheck     bun run typecheck                                                                                                                        (cwd packages/plus)
```

---

## Item 11 — two Code Mode calls that share one CallID

Before: `teams/tools.ts` held audit state in `Map<CallID, TeamCall>`,
`Set<CallID> askedCallIds` and `Map<requestID, CallID> askedRequests`. Under
Code Mode one `execute` runs every inner team tool against one `Tool.Context`,
so all of them share one CallID and one messageID. A sibling that finished
first deleted the shared entry (and the asked flag); the reply observer of a
still-pending call then found nothing and wrote no line at all, and a
`asked:allow` outcome could be attributed to the wrong call.

After: state is a FIFO queue per `(sessionID, messageID, CallID)` plus a
request ID → invocation map. Each invocation claims its own queue entry at
`runGated`, the `permission.asked` observer binds the request to the entry for
the action's tool, and the reply observer writes the line for the invocation
its request named. `runGated` falls back to a local entry when no
`execute.before` entry exists.

Test: `test/teams/tools.test.ts` › "two Code Mode calls that share one CallID
write two distinct audit lines". One shared `Tool.Context`
(`id: call_codemode_shared`, `messageID: msg_codemode_shared`) drives a
`team_delegate` that waits on a human `ask` and a `team_status` that completes
while it waits; the delegate is then rejected with feedback. Actual audit lines
from the passing run (`docs/round3-t5-evidence.md` is a copy of that run's
receipt):

```
[T5 item 11] shared CallID "call_codemode_shared" →
  {"tool":"team_status","outcome":"allowed","ok":true,"code":null,"actor":"fable-planner","sessionID":"ses_shared_call_id","run":"main-sharedcall0001","seq":2}
  {"tool":"team_delegate","outcome":"asked:deny","ok":false,"code":"E_PERMISSION","actor":"fable-planner","sessionID":"ses_shared_call_id","run":"main-sharedcall0001","seq":3}
```

Both lines carry the right tool, outcome, actor, session, run and code, and the
test asserts exactly two `tool.call` lines for the two calls. The chain still
verifies (`audit.verify` green).

---

## Item 12 — the first delegate in a brand-new data root

Failing test on the commit before the fix (the test was added first and run
against `f0522d90`; only `teams/tools.ts` was already fixed at that point):

```
test/teams/worktree.test.ts:
92 |         projectDirectory: repo,
93 |       })
94 |       expect(await exists(c.dir)).toBe(true)
95 |       // This is the first-delegate failure in one assertion: a directory the
96 |       // caller cannot realpath is a directory the host cannot open a session in.
97 |       expect(c.dir).toBe(await realpath(c.dir))
                         ^
error: expect(received).toBe(expected)

Expected: ".../tmp/teams-wt-fresh-ydUMnR/data/ws/worktrees/opencode/implementer/first1a2b-20260921-1905"
Received: ".../tmp/teams-wt-fresh-ydUMnR/link/ws/worktrees/opencode/implementer/first1a2b-20260921-1905"

      at .../packages/plus/test/teams/worktree.test.ts:97:21
(fail) worktree manager > the first create in a brand-new root returns the real directory [12.96ms]
```

The round-2 lab saw the same class as `E_INTERNAL: NotFound:
FileSystem.realPath (.../teams/worktrees/proj/orchestrator/t186ab-…)`: the host
resolves the location directory it is handed with `FileSystem.realPath`, so a
`create` that returns a path that is not the real directory (or whose parents
do not exist yet) fails the first delegate, and the delegate catches it as
`E_INTERNAL`.

Fix (`teams/worktree.ts`): `create` resolves the new directory absolutely up
front, creates its parent chain before `git worktree add` runs, and returns the
`realpath` of the created directory. `remove` is now a plain
`git worktree remove` (the file it used to delete first no longer exists).

After (same test, final run):

```
(pass) worktree manager > the first create in a brand-new root returns the real directory [13.85ms]
```

The test asserts the returned directory exists, is its own `realpath`, and lies
under the realpath of the workspace root, and that the branch resolves to the
base commit in the repository.

---

## Item 13 — no copied project config, activation upward, plain remove

Source changes:

- `teams/worktree.ts`: `ensureProjectConfig` and `removeUntrackedPlusConfig`
  are gone, and `CreateOptions.projectDirectory` with them. `create` writes
  nothing under `.opencodeplus`; `remove` has no config special case.
- `project.ts`: `read(directory)` walks parent directories to the nearest
  `.opencodeplus/project.json`, or returns `undefined` at the filesystem root.
  `enable`/`disable` still act on the directory they are given.
- `teams/run.ts`: `RunRecord.projectDirectory?: string` and
  `byDirectory(root, directory)` (canonical-path comparison).
- `teams/api.ts`: `delegate` records
  `projectDirectory: parent.projectDirectory ?? parent.directory`. The root-run
  bootstrap in `teams/tools.ts` records the Location's own directory.
- `index.ts`: `activationDirectory(directory)` returns a run's recorded
  `projectDirectory` when `byDirectory` finds the run that owns the Location,
  else the Location directory. `activate` and `refreshFromHost` both resolve
  through it.

Tests and captures:

- `test/teams/worktree.test.ts` › "create leaves no project config in the child
  worktree" — the parent has a project.json, the child has no
  `.opencodeplus` at all and `git status --porcelain` is empty.
- › "a parent without a project config still hands the child no file" — no
  invented default either.
- › "remove is a plain git worktree remove with no config special case" — a
  tracked `project.json` arrives with the checkout, the child's copy is the
  committed one, and a non-force `remove` succeeds.
- `test/project-mode.test.tsx` › "project mode resolves upward from a nested
  directory to the nearest config" — `read` finds the root's config from a
  nested directory and prefers the nearer one.
- `test/teams/api.test.ts` › "delegate activates the child through the parent
  project, with no copy". Actual capture:

```
[T5 item 13] child .../tmp/plus-team-api-lZJgbd/opencode/opencodeplus/teams/worktrees/opencode/implementer/t17309-20260921-1918
  child/.opencodeplus/project.json exists: false
  run.projectDirectory: .../tmp/plus-team-api-repo-wfHyAi
  activationDirectory(child): .../tmp/plus-team-api-repo-wfHyAi
  project.read(activation): {"version":1,"protectedAgents":["muse-implementer"]}
```

- The existing `delegate creates a worktree session, record, brief and prompt`
  test flipped: the child has no `.opencodeplus/project.json`, its
  `git status --porcelain` is empty, and the child record carries
  `projectDirectory` = the parent's directory.

`activationDirectory` is directory-based because a plugin instance runs per
Location and activation has no session id; the run that owns the worktree is
found by the directory it opened. `byDirectory` compares canonical paths so a
symlinked or relative data root still matches.

---

## Decision record

- D7 implementation: per-invocation audit state, `(sessionID, messageID,
  CallID)` queue. No global map; all state stays on the `registerTeamTools`
  registration and is cleared on dispose.
- D8 implementation: upward `project.read`; `run.json` gains
  `projectDirectory`; activation for run sessions resolves through it; no copy
  in the worktree and no special case in `remove`.

## Cross-task fallout of the upward walk (needs two files outside T5's scope)

`project.read` now resolves upward, so a directory with **no config anywhere in
its ancestry** stays disabled, while one inside an enabled checkout resolves
enabled. This workspace root (`/home/bliss/OpenCodePlus`) is Plus-enabled, and
`TMPDIR` sits inside it, so four existing `project.disabled` assertions on a
bare `tempRoot()` project no longer hold. Reproduced with the real handlers
(temporary diagnostic in `test/project-mode.test.tsx`, removed again after the
capture):

```
[diag] TMPDIR=/home/bliss/OpenCodePlus/run/team/development-models/runs/w-31917f97c8efcb4f/tmp
  ancestors=["/home/bliss/OpenCodePlus/.opencodeplus/project.json"]
[diag] bare temp project status={"enabled":true,"directory":".../tmp/plus-diag-0Rs0hs"} snapshotFailure=Success
```

Affected, with their exact locations:

- `packages/plus/test/rpc.test.ts:195` — "gated methods fail with
  `project.disabled` when project mode is off" (`tempRoot()` at line 83 under
  `TMPDIR`).
- `packages/plus/test/teams-rpc.test.ts:354` — "team.setEnabled is gated on
  project mode with `project.disabled`".
- `packages/plus/test/teams-rpc.test.ts:1122` — the `team.delete`
  `project.disabled` case.
- `packages/plus/test/teams-rpc.test.ts:1175` — the `team.list`
  `project.disabled` case.

Both files are outside T5's allowed edit paths, so T5 does not touch them.
Isolating those four cases (for example creating their `tempRoot()` under a
directory with no enabled ancestor) is the whole fix; no product code change is
needed for them.

## Check receipts

Final HEAD of this task branch, both assigned checks green:

```
team-runtime: exit 0
  79 pass, 0 fail, 464 expect() calls, ran 5 files
typecheck:    exit 0
  tsgo --noEmit -p tsconfig.test.json
```

## Delivered / deferred

Delivered: items 11, 12, 13 of the round-3 plan, the tests above, and the
SPEC/README updates in the same commit.

Deferred (out of this task's end state, noted for the reader): the RPC surfaces
that read the Location directory directly (`project.status`, `snapshot`, and
the instruction handlers) still resolve that directory plus the new upward
walk; they do not consult a run's recorded `projectDirectory`. Activation is
the path item 13 names, and it does.