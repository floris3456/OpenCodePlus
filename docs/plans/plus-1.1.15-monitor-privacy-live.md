# Monitor call-privacy repair — owned live evidence (issue #9)

Sanitized, owned-only evidence for the call-attribution privacy repair on
`packages/plus/src/monitor`. No credentials, configs or raw prompt bodies are
recorded here; all payloads below are fictional sentinels.

- Run id: `overnight-monitor-privacy` (pilotty), worker branch
  `team/Flash-C-Worker/t85c7c1-20261005-0239`.
- HEADs tested: `44970b598a` (error hashing + target restriction),
  `77eeb9397b` (recognized-subcommand allowlist; the live rerun below).
- Base: `339c6e2f36f233e2e9791d918ae7068d1b2aea33`.

## Owned home and log

Owned isolated home (never the shared service or `~/.config/opencodeplus`):

```
DEV=/home/bliss/OpenCodePlus/run/plus-dev/run-plus-data-opencodeplus-teams-worktrees-opencode-Flash-C-Worker-t85c7c1-20261005-0239
```

The source server's actual open log is `opencode-local.log` (the overnight
plan's `opencode.log` does not exist here):

```
LOG=$DEV/data/opencode/log/opencode-local.log
```

Inspected log counts at the end of the run (file grew across earlier runs in
the same home, so the counts cover all of them):

- total `level=WARN|ERROR` lines: 24
- non-refusal `level=WARN|ERROR` lines: **0**
- lines containing `plus monitor`: **0**

The only warnings are the expected, benign refusal of the executor-controlled
plugin source for the parent tree; sanitized unique forms:

```
level=WARN message="executor-controlled plugin source refused" path=<tree>/.opencode type=directory role=server
level=WARN message="executor-controlled plugin source refused" path=<tree>/.opencode type=document role=server
```

## Owned processes and shutdown

Processes owning this home (kernel-derived via `/proc/<pid>/environ` and
`/proc/<pid>/cwd`, not a registration file), captured before the kill:

| PID | PPID | cwd |
| --- | --- | --- |
| 2757434 | 1140758 | `$DEV/project` (pilotty client) |
| 2757513 | 2757434 | `<worktree>/packages/cli` (dev server) |
| 2757651 | 2757513 | `$DEV/project` (session) |
| 2757697 | 2757513 | `<worktree>/packages/cli` (session) |

After `pilotty kill`: every one of 2757434/2757513/2757651/2757697 is absent
from `/proc`, and a fresh scan of `pgrep -f opencode` finds **no** process with
`$DEV` in its environment.

PTY exit outcome (`pilotty status`):

```
state=exited exit_code=0 signal=null success=true killed_by_client=true
```

## Corrected lowercase shell control (commit 77eeb9397b)

The review found that `commandHeads` gave only arity, so a lowercase arbitrary
second word to a 2-word program was still persisted. `commandHead` now keeps a
second word only when it is one of the program's actual recognized
subcommands. Owned live rerun, two shell calls:

Screen (sanitized):

```
1. git fictional_lowercase_payload_sentinel failed with exit code 1:
   git: 'fictional_lowercase_payload_sentinel' is not a git command.
2. echo fictional_lowercase_payload_sentinel succeeded with exit code 0:
   fictional_lowercase_payload_sentinel
```

Stored rows in the owned `$DEV/data/opencode/opencodeplus/monitor.db`:

```
{"tool":"shell","target":"git","status":"completed","error":null}
{"tool":"shell","target":"echo","status":"completed","error":null}
```

So the payload text itself was never persisted as a target; the programs `git`
and `echo` were. In the prior run at `77eeb9397b`, a later
`git diff --stat` stored target `"git diff"`, i.e. the allowlist keeps useful
subcommands.

## Sentinel accounting (distinguish the two kinds)

Five content/error/query sentinels whose absence from **all** stored tables is
proven, plus one pathname sentinel that is intentionally retained:

| sentinel | where injected | persisted? |
| --- | --- | --- |
| `FICTIONAL_PRIVATE_ERROR_SENTINEL` | failed tool error message | no — stored as `{"type":"tool.execution","hash":"9b318c6cf1a79421","chars":72}` |
| `FICTIONAL_SHELL_PAYLOAD_SENTINEL` | shell stdout payload | no |
| `FICTIONAL_SEARCH_SENTINEL` | grep pattern | no — stored as hash + `33c` |
| `FICTIONAL_QUERY_SENTINEL` | websearch query | no — stored as hash + size |
| `FICTIONAL_PAYLOAD_SENTINEL` | unknown Code Mode inner input | no — target omitted |
| `fictional_lowercase_payload_sentinel` | `git` / `echo` second word | no — programs `git`, `echo` only |
| `/…/FICTIONAL_PRIVACY_ERROR_SENTINEL.txt` | file **path** argument | **yes, by design** — paths are explicitly allowed target semantics |

The failed-read pathname is a legitimate file target; only its error *text* was
hashed. No blanket claim is made that a pathname sentinel is absent.

## Covered by tests (source commits)

- `test/monitor.test.ts`: `every stored call column refuses content sentinels
  while useful names remain` (inspects every table) and `callEnded hashes an
  error at the ledger boundary so alternate callers cannot leak text`.
- `test/monitor-plugin.test.ts`: real `session.hook` fixture; stale
  registration warnings removed while deliberate ledger-failure warnings stay.
