# Round 3 live delegation lab driver

`docs/round3-delegate.ts` is lab-only evidence tooling. It runs the **real Plus
delegate handler** against a **real isolated tui-lab host session**, so the
orchestrator can capture the run-backed Team tab with a child that was actually
delegated instead of a fabricated `run.json`.

- It drives the registered `team.delegate` tool handler by default; with
  `--direct-api` it calls the exported `TeamApi.delegate`.
- Only the session seams travel over the bridge: `create`, `get`, `prompt`,
  `wait`, `interrupt` and `switchModel` (plus the other session calls the
  client API exposes) go to the lab host's documented `/api/session` routes
  (`packages/protocol/src/groups/session.ts`) over loopback with Basic auth.
- The **child run, its worktree and its session are created by the real
  handler**. The parent run is only a seed for a chat that already exists in
  the lab.
- **Deterministic loopback model transport is a separate helper.** This driver
  never builds, replaces or fakes a provider; it only creates and prompts
  sessions on the host.

This document describes evidence tooling. Item 10 of the round-3 end state
("the tab works inside the human's real chat and inside a delegated child's
chat alike") is **not proven by this driver**; it is proven by the
orchestrator's TUI captures against the run this driver creates.

## Safety rules (enforced, not configurable)

- `--lab-home` must be an explicit existing directory under
  `/home/bliss/OpenCodePlus/run/tmp-build/tui-lab-*`. The human data root
  (`run/plus`) is refused.
- `--base-url` must be a loopback origin (`127.0.0.1`, `localhost`, `[::1]`)
  with an explicit port. Port `40374` (the human's server) is refused, and a
  URL that embeds credentials is refused.
- The password is read from the environment (`OPENCODEPLUS_LAB_PASSWORD` by
  default). It is never printed, written to any seed, included in any call
  record, or put in a report; only the host's `Authorization` header sees it.
  `--password` is accepted but the environment is preferred, because command
  lines leak into process listings.
- The driver writes only under `<lab-home>/data/opencode/opencodeplus/teams`.
  It does not read host config, user config, credentials or logs.

## Prerequisites

1. An isolated lab is up (never the human's server): create it with
   `docs/team-v2/scripts/tui-lab.sh` in the workspace root, for example
   `$LAB up <worktree> r3`. The lab data root is
   `/home/bliss/OpenCodePlus/run/tmp-build/tui-lab-r3/data`.
2. The lab host is serving on a loopback origin with a password. Use the
   origin the lab prints and its password lookup; do not point this driver at
   `40374`.
3. A **genuine parent chat already exists** in the lab, and its session id is
   known (from the lab TUI or the lab's RPC helper). The chat's directory must
   be inside a git repository; the driver checks this before seeding.
4. Deterministic loopback model transport (owned by the separate helper) is
   installed in the lab so sessions created by the handler can execute. The
   driver only creates and prompts the sessions.

## Exact command

From `packages/plus` in the task worktree:

```sh
cd packages/plus
OPENCODEPLUS_LAB_PASSWORD=<lab-password> \
bun docs/round3-delegate.ts \
  --lab-home /home/bliss/OpenCodePlus/run/tmp-build/tui-lab-r3 \
  --base-url http://127.0.0.1:<lab-port> \
  --parent-session <ses_genuine_parent_chat> \
  --brief docs/round3-delegate-brief.json
```

`docs/round3-delegate-brief.json` above means a JSON file you create, for
example from the brief below; inline JSON and `-` (stdin) are also accepted.

Add `--model <providerID>/<modelID>` when the child must run the deterministic
loopback model the transport helper serves; without it the child keeps the lab
host's default model.

`--help` prints the same contract:

```sh
bun docs/round3-delegate.ts --help
```

Options:

| Flag | Meaning |
| --- | --- |
| `--lab-home <path>` | explicit lab home under `run/tmp-build/tui-lab-*` |
| `--base-url <url>` | loopback lab host origin; port 40374 refused |
| `--parent-session <id>` | session id of the genuine lab chat |
| `--brief <file\|json\|->` | delegate Brief as a JSON file, inline JSON, or `-` for stdin |
| `--password-env <NAME>` | environment variable holding the password (default `OPENCODEPLUS_LAB_PASSWORD`) |
| `--password <value>` | inline password; prefer the environment |
| `--parent-run <id>` | seeded parent run id (default `main-` + 16 hex of `sha256(session)`) |
| `--parent-role <role>` | role recorded on the seeded parent run (default `opus-orchestrator`) |
| `--call-id <id>` | `Tool.Context` call id for the registered handler |
| `--model <provider/model>` | pin the model the child session switches to through the bridge; omit to leave the lab host's choice |
| `--seed-only` | write/verify the parent seed and stop |
| `--direct-api` | call `TeamApi.delegate` instead of the registered tool |

Environment fallbacks: `OPENCODEPLUS_LAB_HOME`, `OPENCODEPLUS_LAB_BASE_URL`,
`OPENCODEPLUS_LAB_PARENT_SESSION`.

## Brief example

The brief is the ordinary delegate Brief. Keep the objective at least 20
characters and give an implementer commit a `scope.paths` entry:

```json
{
  "requestID": "r3-live-child-1",
  "role": "muse-implementer",
  "objective": "Reply with one short line proving the delegated child chat is alive.",
  "deliverable": { "kind": "report", "format": "text" },
  "scope": { "paths": [] },
  "checks": [],
  "effort": "small"
}
```

## What the run writes

With the default tool path, the real `team.delegate` handler writes:

- the parent run seed at `runs/<parent-run>/run.json` (only if absent; an
  existing seed is reused and must match the same session and directory);
- the child run at `runs/<child-run>/run.json`, with `parent` set to the seed,
  plus `runs/<child-run>/brief.md`, `brief.json` and `checks.json`;
- a real child worktree at `<teams-root>/worktrees/<repo>/<role>/<name>-<stamp>`
  on a `team/<role>/<name>` branch;
- one request replay key at `requests/<parent-run>__<requestID>.json`;
- the audit line the tool wrapper appends for the call.

The child's Location and session id are whatever the handler passed to
`sessions.create`; the driver records each host call as method, path and
status in its output.

Delegate replay is real behaviour: rerunning the identical brief with the same
`requestID` returns the recorded outcome instead of creating a second child.
Use a new `requestID` for a new delegation and keep `--parent-run` stable so
the same genuine chat seeds the same parent run.

The driver does not assert anything about `.opencodeplus/project.json` inside
the child worktree. On branches before the project-mode change the handler may
copy the parent's file there; on later branches it resolves project mode
upward. Either behaviour is fine for this driver.

## Output

A successful run prints one JSON object:

```json
{
  "ok": true,
  "via": "team.delegate",
  "lab": { "baseUrl": "http://127.0.0.1:51000", "labHome": "...", "teamsRoot": "..." },
  "parent": { "run": "main-...", "session": "ses_...", "role": "opus-orchestrator", "directory": "...", "state": "working" },
  "hostCalls": [{ "method": "POST", "path": "/api/session", "status": 200 }],
  "child": { "run": "w-...", "session": "ses_...", "role": "muse-implementer", "state": "starting", "directory": "...", "branch": "team/implementer/...", "parent": "main-..." },
  "output": { "run": "w-...", "session": "ses_...", "task": "T...", "state": "starting", "directory": "...", "branch": "...", "base": "...", "briefPath": "...", "budget": {} }
}
```

Failures print one `round3-delegate: <message>` line and exit non-zero; the
message never contains the password.

## What is real, what is fixture

Real, driven by this driver and its self-check:

- the registered `team.delegate` tool handler and the `TeamApi.delegate`
  fallback;
- `git worktree add` for the child worktree;
- the child run record with the parent link and the handler's own Location;
- the host session calls that carry the delegation: create, switch model,
  prompt, and the id the host returns.

Fixture, and labeled as such:

- non-session `Context` domains come from the shared `test/harness.ts`; the
  `ctx.agent.reload()` seam is therefore a no-op while the real lab host's own
  Plus instance reacts to the session it created;
- in the self-check, the session host is a loopback HTTP fixture that records
  requests; in a live run it is the lab host itself;
- deterministic loopback model transport is the separate helper, not this
  driver.

Not proven here: the Team-tab TUI behaviour. Item 10 needs the orchestrator's
captures of the real TUI against the run this driver creates.

## Using it for the live capture

1. Seed the parent run once (optional but useful for a clean capture):

   ```sh
   OPENCODEPLUS_LAB_PASSWORD=<lab-password> bun docs/round3-delegate.ts \
     --lab-home /home/bliss/OpenCodePlus/run/tmp-build/tui-lab-r3 \
     --base-url http://127.0.0.1:<lab-port> \
     --parent-session <ses_genuine_parent_chat> --seed-only
   ```

2. Run the delegation command above and keep its JSON output as evidence.
3. In the lab TUI, open the parent chat's Team tab: the delegated child run
   created by this driver is the row to capture. The TUI capture itself is the
   orchestrator's evidence for item 10, not this driver's.

## Self-check

```sh
cd packages/plus
bun test test/round3-delegate.test.ts
bun run typecheck
```

The test uses the shared `test/harness.ts` for non-session domains, a temp git
repository, and a **loopback HTTP fixture** that implements the documented
session routes and records what the bridge sent. The fixture is explicitly a
fixture: it is not a lab host and not a model transport. The test verifies that
the registered `team.delegate` handler runs against the bridge, that the child
run record and the child Location come from the real handler, and that the
rendered brief reaches the child session prompt.

Because the harness's tool domain has no host hook seam, registering the team
tools logs two `plus team tool ... hook registration failed` warnings on
stderr in both the test and the CLI. They are expected, they do not affect the
delegation path, and stdout stays a single JSON object.