# T3 evidence — protected agents are protected at the API boundary

Status: implemented on this branch. The code and test commit is
`cd02de6d02cf8ee11fe6a720cd6d243966f98a4c` (tree
`7ff03b9a511852b441c065785cc62bd6d5f3cc09`); the receipts below were captured
from the assigned checks at that commit. This file lands in the following
commit, so the branch tip differs from that commit only by this document.

The change was replayed from the accepted T3 patch
(`docs/round3-t3-integration.patch`, source `ce930f2bf7065a15ad7aee1c5808feb8c2ad0609`)
onto the integrated source. The patch path now holds a placeholder note; the
patch itself is in git history under the base commit and its guard design was
applied verbatim.

## What changed

- `packages/plus/src/rpc.ts:685` declares the `Plus.AgentProtected` error
  `{ agent, id?, reason }`, with `id` reserved for a row/input id distinct
  from the protected agent. `rpc.ts:1044` wraps it for the portable client and
  every guarded method lists it under `errors` (`rpc.ts:1126`-`1382`).
- `packages/plus/src/rpc.ts` adds an optional `actor` to `CreateAgentInput`
  (`:406`), `RenameAgentInput` (`:420`), `DeleteAgentInput` (`:434`),
  `CreateTeamInput` (`:535`), `TeamAddAgentInput` (`:552`, retaining T1's
  `fields?`), `TeamRemoveAgentInput` (`:560`), `DeleteTeamInput` (`:567`),
  `ModelAddInput` (`:794`), `ModelRemoveInput` (`:806`), `RuleAddInput`
  (`:878`), `RuleRemoveInput` (`:887`), and `RuleUpdateInput` (`:900`).
  `MutateInput.actor` already existed (`:318`). A missing actor is the TUI;
  only `{ type: "tool" }` is refused.
- `packages/plus/src/index.ts:2329` adds one helper,
  `refuseProtectedForTool(actor, agentId, config)`. It returns the declared
  error when the actor is a tool and the addressed owner is listed in
  `protectedAgents`, and `undefined` otherwise. The refusal message is the
  same text the tool wrappers raise (`tools.ts:429`):
  `agent.protected: row belongs to protected agent "<id>"`.
- `packages/plus/src/index.ts` replaces the old unconditional
  `ruleProtectedRefusal` and the unconditional `agent.create` check with the
  helper; every `createHandlers` surface maps the new code to the declared
  `agent.protected` error (`index.ts:1765`-`2103`).

## Guard map

| write | owner checked | `index.ts` line |
| --- | --- | --- |
| `instructions.mutate` | first changed record's `agent` (team records skipped) | 454 |
| `agent.create` | requested id | 552 |
| `agent.rename` | `from` id | 609 |
| `agent.rename` | `to` id | 611 |
| `agent.delete` | requested id | 647 |
| `team.create` with a template | first protected template member | 938 |
| `team.addAgent` | member id | 1076 |
| `team.removeAgent` | member id | 1172 |
| `team.delete` | first protected member of the discovered team | 1254 |
| `model.add` | `agent` (null = shared row, allowed) | 1380 |
| `model.remove` | `agent` | 1473 |
| `rule.add` | requested `agent` | 1539 |
| `rule.remove` | matched record's owner | 1619 |
| `rule.update` | matched record's owner, else the requested `agent` (the upsert only adopts the caller's address when nothing matched) | 1665 |

Model activation is a `model` record with `active: true` sent through
`instructions.mutate`, so the mutate row above covers add/remove/activate.
`instructions.mutate` compares `deltaRows(loaded.records, records)`:
a full-snapshot mutate that carries a protected agent's records back unchanged
is a no-op, not a refusal.

## Test receipts

Assigned check `protected`
(`bun test test/rpc.test.ts test/tools.test.ts test/teams-rpc.test.ts`,
cwd `packages/plus`) at commit `cd02de6d`, exit code 0. The check harness
truncates the head of stdout but keeps stderr whole, so the exact capture the
existing real-handler regression prints is verbatim below, followed by the
tail of the run:

```
(pass) deleting a protected agent's custom rule through another agent's row is refused [55.42ms]
(pass) removeRule refuses a protected owner's rule for a tool actor and lets the TUI remove it [10.71ms]
(pass) rule.remove RPC from another agent's row refuses a tool actor and lets the TUI remove it [26.57ms]
(pass) updating a protected agent's custom rule through another agent's row is refused (tools API) [32.48ms]
T3 rule.update refusal: {"refused":{"type":"agent.protected","message":"agent.protected: row belongs to protected agent \"alpha\""},"storedLabel":"Custom","logLinesUnchanged":true}
T3 rule.update tui write: {"written":"Hacked","logLinesAppended":true}
(pass) rule.update RPC from another agent's row refuses a tool actor and lets the TUI write [10.44ms]

4 tests skipped:
(skip) instruction create writes a project file core discovery picks up and raises declared errors
(skip) instruction delete removes the project file, refuses traversal, and raises declared errors
(skip) instruction delete drops customizations so re-created instruction resolves new body
(skip) delete instruction removes the project file

 148 pass
 4 skip
 0 fail
 1260 expect() calls
Ran 152 tests across 3 files. [3.08s]
```

The lines above are the `tools.test.ts` regression the patch renames and
extends; the three new `rpc.test.ts` tests and three new `teams-rpc.test.ts`
tests are in the truncated head of stdout, and the run total (`148 pass`,
`0 fail`) covers them. The exact `agent.create` refusal payload is pinned by a
`toEqual` assertion at `test/rpc.test.ts:2280`:

```
{ type: "agent.protected", message: 'agent.protected: row belongs to protected agent "alpha"', data: { agent: "alpha", reason: 'agent.protected: row belongs to protected agent "alpha"' } }
```

Assigned check `typecheck` (`bun run typecheck`, cwd `packages/plus`) at the
same commit, exit code 0:

```
$ tsgo --noEmit -p tsconfig.test.json
```

## What the tests prove

- `test/rpc.test.ts:2261` "protected agents refuse tool-actor agent writes…":
  `agent.create` with a tool actor fails `agent.protected` with the exact
  message and data object, and leaves `<project>/.opencode/agent/alpha.md`
  absent; the same call without an actor writes it. `agent.delete` and both
  `agent.rename` directions are refused for a tool actor with the source file
  and the target path unchanged, while the TUI rename and delete succeed.
- `test/rpc.test.ts:2339` "protected agents refuse tool-actor model
  add/remove…": the refused `model.add` leaves `records` empty; the TUI add
  persists; the refused `model.remove` leaves the model record present; the
  TUI remove deletes it.
- `test/rpc.test.ts:2388` "protected agents refuse tool-actor rule writes…":
  refused `rule.add`/`rule.update`/`rule.remove` leave the stored label
  unchanged and the record present; the TUI add/edit/remove through another
  agent's row succeed with the owner staying `alpha`.
- `test/rpc.test.ts:2462` "instructions.mutate refuses a tool actor…": a tool
  mutate carrying the protected row unchanged succeeds as a no-op; the same
  tool mutate with `text: "second"` fails `agent.protected` and the stored
  text stays `"first"`; the TUI mutate writes `"second"`.
- `test/teams-rpc.test.ts:1479` covers `team.addAgent` and `team.removeAgent`,
  `:1520` covers `team.delete`, and `:1550` covers `team.create` with a
  template: each tool-actor call is refused with `agent.protected` and writes
  no member file, and the same call without an actor succeeds.
- `test/tools.test.ts:1439` "removeRule refuses a protected owner's rule for a
  tool actor…", `:1472` "rule.remove RPC from another agent's row refuses a
  tool actor…", and `:1552` "rule.update RPC from another agent's row refuses
  a tool actor…" assert the refusal type `agent.protected` in the throwing
  context double the exact log-file prefix unchanged across the refusal
  (`logLines(project)` equality), and the TUI call then writing the row and
  appending a log line. The pre-existing tool-wrapper tests
  (`protectedAgents refusal on a write`, `protected agent creation refuses
  before writing a file or log line`, `deleting a protected agent's custom
  rule…`, `updating a protected agent's custom rule…`) are unchanged and
  still pass, so the early tool refusal and its error text are preserved.

The `T3 rule.update refusal` / `T3 rule.update tui write` lines above are
printed by `test/tools.test.ts:1597` and `:1616`, which sit inside the
`rule.update RPC…` regression and read the real handler's captured error and
the persisted rule row; no assertion reads them.

No capture above is a mock: every case drives the real handlers
(`createHandlers`/`createPlusApi`) against a temporary project directory and
asserts stored files, snapshot records, and the append-only log.

## Boundaries respected

- T1's canonical create outputs and `TeamAddAgentInput.fields?` are untouched;
  the T3 patch only added `actor?` beside them.
- T2's `message` field semantics are untouched: the `message` key on
  `RuleAddInput`/`RuleUpdateInput` and `RuleRecord` is unchanged, and T3 does
  not alter the serializer.
- T4's `team.runs.list` / `team.runs.stop` RPC definitions and tests are
  untouched.
- T6 search keys and the `server:search` query filter are untouched.
- No file outside `packages/plus` was modified for this task.
- The temporary `docs/round3-t3-integration.patch` content was removed after
  it was fully replayed. The implementer toolset has no filesystem delete
  primitive, so the path now holds a short placeholder note instead of the
  patch; `git rm packages/plus/docs/round3-t3-integration.patch` finishes the
  removal.