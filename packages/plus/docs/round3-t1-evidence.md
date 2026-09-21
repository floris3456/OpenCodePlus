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

Storage keeps the original defaults: `level` defaults to `project`, a model at
project/global needs an `agent` (only an explicit `level: "defaults"` with no
agent is the shared Defaults row), and a rule with no `agent` is stored at the
requested level. A shared (`agent: null`) rule resolves through its canonical
visible Defaults catalogue row (`item:defaults::perm:…`, or
`item:defaults:/teams:perm:…` for `catalogue: "teams"`) while the record stays
at the requested level; an agent-qualified model or rule resolves at its own
level and owner, never as the identical Defaults row. The ninth kind,
`instruction`, stays refused:

```
instruction.disabled: AGENTS.md handling in OpenCodePlus is disabled for now; native opencode applies AGENTS.md files. Being reworked with the Context catalogue.
```

(`src/tools.ts` `INSTRUCTION_DISABLED`; asserted by the test below — no
instruction row is created or enabled).

## End-state item 1 — `kind:"team"` with `template`

`create kind:"team"` forwards `template` to `api.createTeam`, the same handler
the TUI's templated team create calls. The test drives the registered tool,
asserts the member files byte-for-byte against
`formatMarkdown(member.fields, member.body)` from the injected registry, and
asserts `show` on the created team row reports both member rows
(`team:project:mine:editor`, `team:project:mine:reviewer`).

## End-state item 2 — `kind:"member"`

`create kind:"member"` calls `api.addTeamAgent` with `team`, `level`, `id`,
`prompt` and optional `template`/`fields` (conditional spread; no `as any`, no
API widening), and the team name is trimmed exactly as `team.addAgent` trims
it before the row lookup. Tests cover:

- `team:project:crew:one:nested/beta` — a whitespace-padded colon team name and
  a nested member id, written to `<project>/.opencodeplus/teams/crew:one/nested/beta.md`,
  shown as a `member` entity (`registered: false` while the team is disabled,
  `true` after `team.setEnabled`), toggled through a subtree row
  (`item:project:crew:one/:nested/beta:tool:shell`), and deleted through
  `team.removeAgent`;
- `team:global:gcrew:gmember` — a global member whose padded team name is
  trimmed, written under `globalTeamsPath()` and deleted;
- `team:defaults:ship:rookie` — the Defaults overlay at
  `<configDir>/opencodeplus/teams-defaults/ship/rookie.md`, listed with
  `overlay: ["rookie"]` and removable;
- fields forwarding: the same tool run records the `team.addAgent` request
  through a delegating recorder (the real handler still writes the file) and
  asserts the request carries `fields`, `prompt`, `level`, `team`, and the
  `tool` actor.

## End-state item 3 — create, show, delete round-trip

One test walks all eight enabled kinds: create → the returned `id` is asserted
exactly → the row is found in the expanded tree with the expected kind → `show`
succeeds with meaningful output (agent rows through `view: "assembled"`, skill /
base / mcp / model / rule rows through `resolved`, team and member rows through
the entity `resolved` view) → an inappropriate view (`diff` on a member,
`sections` on a team) still fails with `view.unsupported` → `delete` with
`confirm: true` returns the plan's exact status. A second test creates the same
model and rule at `defaults`, `project` (agent `proj`), and `global` (agent
`glob`), asserts each returned id names its own level's row, asserts the
persisted storage location (shared and project rules in the project records
file, the global rule in the global records file, `level`/`agent` on the stored
records), and asserts delete of the returned ids removes the written records.
The no-agent model create without a level is asserted to keep the original
`create model requires agent for project|global levels` refusal.

## Captured check output

From `packages/plus`, the assigned check `tools`
(`bun test test/tools.test.ts test/teams-rpc.test.ts test/ops.test.ts`):

```
(pass) every enabled create kind returns the row id show and delete accept, and delete removes the row [188.10ms]
(pass) create returns the created level's model and rule row, not the identical Defaults row [254.99ms]
(pass) create kind member adds members at project and defaults level and returns the member row id [76.99ms]
(pass) create kind member forwards the agent fields to team.addAgent [15.04ms]
(pass) create kind team passes the template to team.create and produces the template's members [8.30ms]
(pass) create kind instruction is refused with instruction.disabled and writes nothing [0.52ms]
...
 129 pass
 1 skip
 0 fail
 793 expect() calls
Ran 130 tests across 3 files. [2.23s]
```

The one skip is the pre-existing `delete instruction removes the project file`
(the disabled-AGENTS surface, kept skipped rather than deleted). The assigned
check `typecheck` (`bun run typecheck`) exits `0`:

```
$ tsgo --noEmit -p tsconfig.test.json
```

Three pre-existing tests were updated to the new contract, not weakened:

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

The agent-facing `src/instructions/teaching.ts` create table is updated by a
separate companion; it is outside this task's edit paths and is not claimed
here.