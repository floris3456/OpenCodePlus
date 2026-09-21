# T1 Evidence — create row ids, team templates, and team members

Base: `ff72f8788595221c45bee3297ffe9f8ffd5f9d6d` (integrated T2/T4/T6 plus the
rule-message persistence work). This document records the focused checks that
ran green for this change; it makes no live-verification claim (the
orchestrator owns live runs).

## Enabled create kinds — eight, with `instruction` refused

`create` writes one row per call and returns `{ id, item, … }`: `id` is the row
id `show`/`set`/`delete` accept, `item` names the created thing inside its row
kind. Every id below is resolved from the expanded tree in
`src/instructions/ops.ts` (`createdItemRow`, `createdAgentRow`,
`createdTeamRow`, `createdMemberRow`); no branch formats a fallback id, and a
create whose row is absent fails with `create.failed`.

| # | kind | write | returned `id` | returned `item` |
| - | ---- | ----- | ------------- | --------------- |
| 1 | `agent` | `agent.create` (project/global) | `agent:project:helper` | `helper` |
| 2 | `skill` | `skill.create` | `item:defaults::skill:notes2` | `skill:notes2` |
| 3 | `base` | `base.create` | `item:defaults::base:custom` | `base:custom` |
| 4 | `mcp` | `mcp.add` | `item:defaults::mcp:search` | `mcp:search` |
| 5 | `team` | `team.create` (+ `template`) | `team:project:squad` | `squad` |
| 6 | `member` | `team.addAgent` | `team:project:crew:newbie` | `newbie` |
| 7 | `model` | `model.add` | `item:project:owner:model:acme/nova-2` | `model:acme/nova-2` |
| 8 | `rule` | `rule.add` | `item:project:owner:perm:shell:owner-rule` | `perm:shell:owner-rule` |

Shared rows (no `agent`) land at `defaults` and return the canonical visible
Defaults catalogue row: `item:defaults::model:acme/nova-2` and
`item:defaults::perm:shell:shared-rule` (the `catalogue: "teams"` form is
`item:defaults:/teams:…`). The ninth kind, `instruction`, stays refused:

```
instruction.disabled: AGENTS.md handling in OpenCodePlus is disabled for now; native opencode applies AGENTS.md files. Being reworked with the Context catalogue.
```

(`src/tools.ts` `INSTRUCTION_DISABLED`; asserted by the test below — no
instruction row is created or enabled).

## End-state item 1 — `kind:"team"` with `template`

`create kind:"team"` forwards `template` to `api.createTeam`, the same handler
the TUI's templated team create calls. The test drives the registered tool,
then asserts the member files byte-for-byte against
`formatMarkdown(member.fields, member.body)` from the injected registry and
that both member rows (`team:project:mine:editor`, `team:project:mine:reviewer`)
resolve in the tree.

## End-state item 2 — `kind:"member"`

`create kind:"member"` calls `api.addTeamAgent` with `team`, `level`, `id`,
`prompt` and optional `template`/`fields` (conditional spread; no `as any`, no
API widening). Tests cover:

- `team:project:crew:one:nested/beta` — a colon team name and a nested member
  id, written to `<project>/.opencodeplus/teams/crew:one/nested/beta.md` and
  deleted through `team.removeAgent`;
- `team:defaults:ship:rookie` — the Defaults overlay at
  `<configDir>/opencodeplus/teams-defaults/ship/rookie.md`, listed with
  `overlay: ["rookie"]` and removable;
- fields forwarding: the same tool run records the `team.addAgent` request
  through a delegating recorder (the real handler still writes the file) and
  asserts the request carries `fields`, `prompt`, `level`, `team`, and the
  `tool` actor. `team.addAgent` renders those fields into the member file; the
  forwarding contract is what this test pins.

## End-state item 3 — create, show, delete round-trip

One test walks all eight enabled kinds: create → the returned `id` is asserted
exactly → the row is found in the expanded tree with the expected kind → `show`
returns the row (or refuses the view with `view.unsupported`, never
`row.unknown`, for address-less agent/team/member rows) → `delete` with
`confirm: true` returns the plan's exact status. A second test creates the same
model and rule at `defaults`, `project` (agent `proj`), and `global` (agent
`glob`) and asserts each returned id names its own level's row rather than the
identical Defaults row.

## Captured check output

From `packages/plus`, the assigned check `tools`
(`bun test test/tools.test.ts test/teams-rpc.test.ts test/ops.test.ts`) at the
working tree this document is committed with:

```
(pass) every enabled create kind returns the row id show and delete accept, and delete removes the row [200.85ms]
(pass) create returns the created level's model and rule row, not the identical Defaults row [248.39ms]
(pass) create kind member adds members at project and defaults level and returns the member row id [20.90ms]
(pass) create kind member forwards the agent fields to team.addAgent [12.61ms]
(pass) create kind team passes the template to team.create and produces the template's members [5.14ms]
(pass) create kind instruction is refused with instruction.disabled and writes nothing [0.50ms]
...
 129 pass
 1 skip
 0 fail
 765 expect() calls
Ran 130 tests across 3 files. [2.14s]
```

The one skip is the pre-existing `delete instruction removes the project file`
(the disabled-AGENTS surface, kept skipped rather than deleted). The assigned
check `typecheck` (`bun run typecheck`) exits `0`:

```
$ tsgo --noEmit -p tsconfig.test.json
```

Two pre-existing tests were updated to the new contract, not weakened:

- `create agent/skill/base/instruction/mcp write the same files as the api path`
  and `a tool create appends a log line with actor tool` now list the skill and
  MCP server in their fixture's host registry: the unit harnesses do not rescan
  the disk the way core's watcher does, and a create now requires its row to
  exist. Their file-parity and log assertions are unchanged.
- `instructions_create with kind team creates the directory disabled and logs
  actor tool` asserts the same object plus the new `id`/`item` keys.
- `perm rules toggle, show, list by item:perm and tool, create custom, and
  delete only customs` asserts the shared rule's canonical Defaults row id and
  item id instead of the old bare rule id.

## Deliberately deferred (out of this task's edit scope)

- `src/instructions/teaching.ts` still describes the create table without
  `member` and without the returned `{ id, item }` contract. It is the
  agent-facing skill text and belongs with the tool-surface documentation task
  (T7 / a follow-up), not this one.