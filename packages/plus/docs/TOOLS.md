# Plus tool inventory

The tools, rows, permissions, RPC methods and Team-tab keybinds OpenCodePlus
(`packages/plus`) exposes. Every claim cites `path:line` relative to the
repository root; the cited line resolves on this branch. Presentations are
present-tense descriptions of the source, not a history.

## 1. Surfaces and modes

| Surface | Registered at | Contents |
| --- | --- | --- |
| `instructions` namespace | `packages/plus/src/index.ts:3234` | 8 tools (`packages/plus/src/tools.ts:231`–`packages/plus/src/tools.ts:403`) |
| `search` MCP server | `packages/plus/src/index.ts:3235` | 3 tools (`packages/plus/src/search/mcp.ts:36`–`packages/plus/src/search/mcp.ts:112`) |
| `team` namespace | `packages/plus/src/index.ts:3260` | 14 tools (`packages/plus/src/teams/tools.ts:343`–`packages/plus/src/teams/tools.ts:468`) |

- `instructions` declares `editor.namespace({ name: "instructions", … })`
  (`packages/plus/src/tools.ts:230`) with shared options
  `{ namespace, codemode: true, permission: "instructions" }`
  (`packages/plus/src/tools.ts:62`).
- `team` declares `editor.namespace({ name: "team", … })`
  (`packages/plus/src/teams/tools.ts:342`) and every tool's options are
  `{ namespace, codemode, permission: "team.<name>" }`
  (`packages/plus/src/teams/tools.ts:483`).
- `search` is a local MCP server named `opencodeplus-search`, version `1.0.0`
  (`packages/plus/src/search/mcp.ts:116`), served over stdio
  (`packages/plus/src/search/bin.ts:5`). Registration sets the server's
  `OPENCODEPLUS_SEARCH_KEYS_DIR` environment
  (`packages/plus/src/search/register.ts:48`) and leaves an existing `search`
  server untouched (`packages/plus/src/search/register.ts:33`).

`codemode: false` registers a native tool; `codemode: true` registers a tool
reachable through the Code Mode catalog. For the team namespace the split is
policy data: `directTools` are native and `codeTools` are Code Mode
(`packages/plus/src/teams/policy.ts:39`–`packages/plus/src/teams/policy.ts:53`).
The `instructions` namespace is entirely Code Mode
(`packages/plus/src/tools.ts:62`).

## 2. `instructions` namespace

Eight tools are registered (`packages/plus/src/tools.ts:231`,
`packages/plus/src/tools.ts:256`, `packages/plus/src/tools.ts:270`,
`packages/plus/src/tools.ts:297`, `packages/plus/src/tools.ts:320`,
`packages/plus/src/tools.ts:347`, `packages/plus/src/tools.ts:359`,
`packages/plus/src/tools.ts:384`). Writes carry the actor
`{ type: "tool", agent, sessionID, messageID }`
(`packages/plus/src/tools.ts:415`), pass `actor: tool`, and retry once when the
snapshot revision is stale (`packages/plus/src/tools.ts:612`).

| Tool | Inputs | Output |
| --- | --- | --- |
| `instructions_list` | `where`, `fields[]`, `sort`, `limit` (default 40), `offset` | Query result (`packages/plus/src/tools.ts:133`, `packages/plus/src/tools.ts:248`) |
| `instructions_show` | `id`, `view` = `resolved` (default), `upstream`, `mine`, `diff`, `record`, `sections`, `assembled` | Row view (`packages/plus/src/tools.ts:141`, `packages/plus/src/tools.ts:265`) |
| `instructions_set` | `id`, `text`, `state` `on`/`off`, `pin`, `active`, `resolve` `keep`/`take`/`edit`, `label`, `patterns`, `keywords`, `message` | `{ id, status, revision, globalRevision }` (`packages/plus/src/tools.ts:156`, `packages/plus/src/tools.ts:294`) |
| `instructions_reset` | `id` | `{ id, status, revision, globalRevision }` (`packages/plus/src/tools.ts:169`, `packages/plus/src/tools.ts:317`) |
| `instructions_split` | `id`, `boundaries[]`, or `add { name, text }` | `{ id, status, revision, globalRevision }` (`packages/plus/src/tools.ts:173`, `packages/plus/src/tools.ts:344`) |
| `instructions_create` | `kind` plus kind fields (`packages/plus/src/tools.ts:181`) | `{ …created, id, item }` per kind (§4) |
| `instructions_delete` | `id`, `confirm` | Removal result plus `status` (`packages/plus/src/tools.ts:217`, `packages/plus/src/tools.ts:1345`) |
| `instructions_log` | `where`, `limit`, `offset` | Change-log entries, newest first (`packages/plus/src/tools.ts:222`, `packages/plus/src/tools.ts:104`) |

`where` uses `key:value` terms; the structural keys (`kind`, `item`, `tool`,
`group`, `server`, `namespace`, `level`, `catalogue`, `agent`, `state`, `team`,
`run`, …) are listed in the `instructions-tools` teaching text
(`packages/plus/src/instructions/teaching.ts:48`). The `server:` filter matches
both tool rows that carry a `server` and the `mcp:<name>` inventory row itself
(`packages/plus/src/instructions/query.ts:914`–`packages/plus/src/instructions/query.ts:925`).

Reads never refuse for protection (`packages/plus/src/tools.ts:66`).

### 2.1 `show` per row kind

- Item rows render resolved text (default), upstream text, `mine`, `diff`
  (two unified diffs plus a one-line summary), `record`, or section ids
  (`packages/plus/src/tools.ts:996`–`packages/plus/src/tools.ts:1017`).
- Perm rows additionally report `tool`, `rule`, `label`, `patterns`,
  `keywords`, `provenance`, `custom`, `enabled`, `source`, `scrub`, the
  `message` the model reads when the rule denies, and, for team policy rows,
  both sides of the row's `policy` (`packages/plus/src/tools.ts:960`–
  `packages/plus/src/tools.ts:993`).
- Team and member rows carry no item address: `resolved` returns the entity
  (`level`, `team`, `enabled`/`members`, or the member registration) and
  `record` nests it under `record`; every other view fails
  `view.unsupported:` (`packages/plus/src/tools.ts:935`–`packages/plus/src/tools.ts:946`).
- `assembled` accepts only `agent:<level>:<id>` and returns that agent's
  assembled view (`packages/plus/src/tools.ts:915`–`packages/plus/src/tools.ts:927`).

### 2.2 `set` / `reset` / `split` / `delete`

- `set` with `text` saves an override; `state` toggles explicitly; `pin`
  pins or unpins a Code Mode tool; `active: true` activates a model row;
  `resolve` resolves a review row; on a perm row `label`, `patterns`,
  `keywords` and `message` update the rule, and a message-only edit derives
  label and patterns from the rule it edits
  (`packages/plus/src/tools.ts:733`–`packages/plus/src/tools.ts:753`,
  `packages/plus/src/tools.ts:862`–`packages/plus/src/tools.ts:881`).
  A bare `id` toggles (`packages/plus/src/tools.ts:600`).
- `reset` removes the stored text/state at the addressed row (model rows clear
  only that level's active flag) (`packages/plus/src/tools.ts:79`).
- `split` sets manual boundaries or appends one section
  (`packages/plus/src/tools.ts:83`, `packages/plus/src/tools.ts:603`).
- `delete` requires `confirm: true` (`packages/plus/src/tools.ts:368`) and
  refuses with a labelled reason for rows that are not deletable: built-in base
  templates (`packages/plus/src/instructions/ops.ts:857`), non-project skills
  (`packages/plus/src/instructions/ops.ts:854`), non-project instructions
  (`packages/plus/src/instructions/ops.ts:862`), sections
  (`packages/plus/src/instructions/ops.ts:864`), `system:role`
  (`packages/plus/src/instructions/ops.ts:865`), and tool/MCP rows
  (`packages/plus/src/instructions/ops.ts:866`). Only user-created rules are
  deletable (`packages/plus/src/tools.ts:816`).

### 2.3 Error prefixes

| Prefix | Meaning | Source |
| --- | --- | --- |
| `project.disabled:` | Plus is not active for the directory | `packages/plus/src/tools.ts:400`, `packages/plus/src/tools.ts:410` |
| `row.unknown:` | No tree row matches the id | `packages/plus/src/tools.ts:425` |
| `agent.protected:` | The row belongs to a protected agent | `packages/plus/src/tools.ts:429` |
| `delete.unconfirmed:` | `delete` was called without `confirm:true` | `packages/plus/src/tools.ts:369` |
| `view.unsupported:` | The view is not available for that row kind | `packages/plus/src/tools.ts:918`, `packages/plus/src/tools.ts:942` |
| `create.failed:` | The created row is not visible in the tree | `packages/plus/src/tools.ts:1337` |
| `stale:` | A write conflicted twice | `packages/plus/src/tools.ts:649` |
| `instruction.disabled:` | AGENTS.md create is disabled | `packages/plus/src/tools.ts:60`, `packages/plus/src/tools.ts:1161` |
| `<code>: <message>` | Any failing API/RPC result keeps its code | `packages/plus/src/tools.ts:797`, `packages/plus/src/tools.ts:1128` |
| `<label> cannot be …` | Row-level refusals (edit, resolve, toggle, delete) | `packages/plus/src/instructions/ops.ts:130`, `packages/plus/src/instructions/ops.ts:134` |

## 3. Row-id grammar

Levels are `defaults`, `global`, `project`
(`packages/plus/src/instructions/model.ts:5`). Tree row ids are built by
concatenation and matched by exact string equality; `/`, `@` and extra `:` in
the item segment are not escaped (`packages/plus/src/instructions/model.ts:421`).

### 3.1 Entity rows

| Grammar | Row | Source |
| --- | --- | --- |
| `root:<level>` | Level root | `packages/plus/src/instructions/tree.ts:478` |
| `agent:<level>:<id>` | Agent | `packages/plus/src/instructions/tree.ts:562` |
| `team:<level>:<team>` | Team (depth 2) | `packages/plus/src/instructions/tree.ts:819` |
| `team:<level>:<team>:<member>` | Team member (depth 3) | `packages/plus/src/instructions/tree.ts:751` |
| `team:<level>:<team>:special` | Special group inside a team | `packages/plus/src/instructions/tree.ts:776` |
| `team:<level>:<team>:special:<agent>` | Special agent inside a team | `packages/plus/src/instructions/tree.ts:798` |

### 3.2 Item and section rows

```
item:<level>:<owner>:<itemId>
section:<level>:<owner>:<itemId>:<sectionId>
```

`<owner>` is the agent id, or the catalogue's inventory owner segment: the
empty string for the Agents catalogue and `/teams` for the Teams catalogue
(`packages/plus/src/instructions/tree.ts:501`–`packages/plus/src/instructions/tree.ts:511`,
`packages/plus/src/instructions/tree.ts:534`–`packages/plus/src/instructions/tree.ts:551`).
Team-member rows use the member path `<team>/:<member>`, and team special rows
use `<team>/:special:<agent>` (`packages/plus/src/instructions/tree.ts:747`,
`packages/plus/src/instructions/tree.ts:794`). Agent ids forbid `:` and never
start with `/`, so an owner path can never collide with an agent id
(`packages/plus/src/instructions/tree.ts:504`).

Item id families:

| Item id | Row | Source |
| --- | --- | --- |
| `tool:<toolId>` | Native/Plus/MCP tool row | `packages/plus/src/instructions/discover.ts:513` |
| `base:<templateId>` | Base prompt template | `packages/plus/src/instructions/discover.ts:553` |
| `skill:<skillId>` | Skill | `packages/plus/src/instructions/discover.ts:606` |
| `system:<relativePath>` | System file | `packages/plus/src/instructions/discover.ts:833` |
| `mcp:<serverName>` | MCP server row | `packages/plus/src/instructions/discover.ts:713` |
| `model:<providerID>/<modelID>[@<variant>]` | Model candidate | `packages/plus/src/instructions/model.ts:428` |
| `perm:<tool>:<ruleId>` | Permission rule | `packages/plus/src/instructions/model.ts:451` |

Group rows use `group:<level>:<owner>:<family>`; the agents subtrees are
`group:<level>:agents`, `:native`, `:native:special`, `:plus`, `:user`
(`packages/plus/src/instructions/tree.ts:582`, `packages/plus/src/instructions/tree.ts:653`,
`packages/plus/src/instructions/tree.ts:667`, `packages/plus/src/instructions/tree.ts:679`,
`packages/plus/src/instructions/tree.ts:691`) and the team subtree is
`group:<level>:teams` (`packages/plus/src/instructions/tree.ts:720`). The six
shared inventory groups (`models`, `tools`, `base`, `skills`, `system`, `mcp`)
exist only at `defaults` (`packages/plus/src/instructions/tree.ts:486`–
`packages/plus/src/instructions/tree.ts:499`).

### 3.3 Change-log targets

`instructions.log` entries carry a target in the stored-record form
`team:<level>:<team>`, `model:<level>:<agent|''>:<provider>/<model>[@<variant>]`,
`rule:<level>:<agent|''>:<tool>:<id>`, or
`item|section:<level>:<agent|''>:<itemId>[:<sectionId>]`
(`packages/plus/src/index.ts:2581`–`packages/plus/src/index.ts:2592`).

## 4. `instructions.create` kinds and returned ids

`create` accepts nine `kind` literals (`packages/plus/src/tools.ts:182`).
Eight create and return `{ …created, id, item }`; `instruction` is refused.
`id` is the tree row id that `show`, `set` and `delete` accept; `item` is the
created item's own id (`packages/plus/src/tools.ts:94`,
`packages/plus/src/tools.ts:159`–`packages/plus/src/tools.ts:162`).

| `kind` | Required fields | Returned `id` | Returned `item` | Source |
| --- | --- | --- | --- | --- |
| `agent` | `id`, `prompt`; `scope` defaults `project` | `agent:<scope>:<id>` | agent id | `packages/plus/src/tools.ts:1108`–`packages/plus/src/tools.ts:1130` |
| `skill` | `name`, `body` | `item:defaults::skill:<id>` | `skill:<id>` | `packages/plus/src/tools.ts:1132`–`packages/plus/src/tools.ts:1142` |
| `base` | `id`, `title`, `text` | `item:defaults::base:<id>` | `base:<id>` | `packages/plus/src/tools.ts:1144`–`packages/plus/src/tools.ts:1156` |
| `instruction` | (disabled) | — | — | `packages/plus/src/tools.ts:1158`–`packages/plus/src/tools.ts:1161` |
| `mcp` | `name`, `config` | `item:defaults::mcp:<name>` | `mcp:<name>` | `packages/plus/src/tools.ts:1170`–`packages/plus/src/tools.ts:1180` |
| `team` | `team`, `level` `project`/`global`; optional `template` | `team:<level>:<team>` | team name | `packages/plus/src/tools.ts:1182`–`packages/plus/src/tools.ts:1195` |
| `member` | `team`, `level` `project`/`global`/`defaults`, `id`, `prompt`; optional `template`/`fields` | `team:<level>:<team>:<member>` | member id | `packages/plus/src/tools.ts:1197`–`packages/plus/src/tools.ts:1224` |
| `model` | `providerID`, `modelID`; `level` defaults `project`; `agent` required unless level is `defaults` | `item:<level>:<owner>:model:<providerID>/<modelID>[@<variant>]` | item id | `packages/plus/src/tools.ts:1226`–`packages/plus/src/tools.ts:1265` |
| `rule` | `tool`, `id`, `label`, `patterns`; `level` defaults `project` | `item:<level>:<owner>:perm:<tool>:<rule>` | item id | `packages/plus/src/tools.ts:1267`–`packages/plus/src/tools.ts:1308` |

`<owner>` follows §3.2: the agent id for agent-owned rows, the catalogue
segment for shared rows (`packages/plus/src/instructions/tree.ts:501`–
`packages/plus/src/instructions/tree.ts:511`). `catalogue: "agents" | "teams"`
(default `agents`) picks which catalogue a shared model or rule lands in; base,
instruction and mcp create one file both catalogues list
(`packages/plus/src/tools.ts:95`, `packages/plus/src/tools.ts:205`,
`packages/plus/src/instructions/model.ts:303`).

A create never formats an id: it resolves the row through the same tree that
`show`, `set` and `delete` read, retrying 12 times at 100 ms, and fails
`create.failed:` if the row never appears
(`packages/plus/src/tools.ts:1314`–`packages/plus/src/tools.ts:1341`).

### 4.1 Model: project + agent requirement

`level` is `input.level ?? input.scope ?? "project"`
(`packages/plus/src/tools.ts:1229`). At `project` or `global` level a model row
must name an `agent`; otherwise create fails with
`create model requires agent for project|global levels`
(`packages/plus/src/tools.ts:1232`–`packages/plus/src/tools.ts:1234`). At
`defaults`, an empty agent (or `_`) means the shared row (`agent: null`)
(`packages/plus/src/tools.ts:1235`). The returned row is resolved at the
written level and owner, so a project candidate is never reported as an
inherited Defaults row (`packages/plus/src/tools.ts:1251`–
`packages/plus/src/tools.ts:1263`).

### 4.2 Rule: project storage, visible Defaults row

`level` is `input.level ?? input.scope ?? "project"`
(`packages/plus/src/tools.ts:1270`). An empty agent (or `_`) means a shared
rule (`agent: null`) (`packages/plus/src/tools.ts:1273`). Shared inventory has
exactly one set of rows, at `defaults`, because that is the one address the
resolution chain falls through to (`packages/plus/src/instructions/tree.ts:486`–
`packages/plus/src/instructions/tree.ts:499`). A rule with no agent therefore
keeps its requested storage level but its only visible row is the shared
Defaults catalogue row, and that row is the returned `id`
(`packages/plus/src/tools.ts:1293`–`packages/plus/src/tools.ts:1305`).

### 4.3 The `instruction.disabled` contract

`instructions.create kind:"instruction"` always fails with `INSTRUCTION_DISABLED`,
whose text begins `instruction.disabled:`
(`packages/plus/src/tools.ts:59`, `packages/plus/src/tools.ts:1161`). The
handlers `instruction.create` and `instruction.delete` return code
`instruction.invalid` carrying the same text while `INSTRUCTIONS_DISABLED` is
`true` (`packages/plus/src/index.ts:2132`, `packages/plus/src/index.ts:795`–
`packages/plus/src/index.ts:800`, `packages/plus/src/index.ts:831`–
`packages/plus/src/index.ts:835`). The remaining eight kinds create, and each
returned `id` round-trips through `show`, `set` and `delete` with no
`row.unknown` (`packages/plus/src/tools.ts:94`,
`packages/plus/src/tools.ts:1108`–`packages/plus/src/tools.ts:1308`).

## 5. `team` namespace

Fourteen tools, eight native and six Code Mode
(`packages/plus/src/teams/policy.ts:39`–`packages/plus/src/teams/policy.ts:53`).
Every call is gated: the session must be the run's own session
(`E_NOT_ACTOR`, `packages/plus/src/teams/tools.ts:645`), the tool must be
inside the role's ceiling (`E_ROLE`,
`packages/plus/src/teams/tools.ts:636`–`packages/plus/src/teams/tools.ts:643`),
and the audit line is written whatever the outcome
(`packages/plus/src/teams/tools.ts:522`). A planner or orchestrator session
with no run yet bootstraps a root run on its first team call
(`packages/plus/src/teams/tools.ts:552`–`packages/plus/src/teams/tools.ts:609`).

### 5.1 Roles and ceilings

Roles map to five kinds: planner (`fable-planner`, `astra-planner`),
orchestrator (`sol-orchestrator`, `opus-orchestrator`), implementer
(`muse-implementer`, `gemini-implementer`, `spark-implementer`,
`opus-implementer`), reviewer (`astra-reviewer`) and scout
(`packages/plus/src/teams/policy.ts:10`–`packages/plus/src/teams/policy.ts:21`).
An unknown role is `E_ROLE` (`packages/plus/src/teams/policy.ts:25`).

| Kind | Native (direct) | Code Mode |
| --- | --- | --- |
| planner | `delegate`, `followup`, `supersede`, `stop`, `finish` | `status`, `diff`, `list`, `wait`, `get_context` |
| orchestrator | `delegate`, `followup`, `integrate`, `set_checks`, `supersede`, `stop`, `finish` | `status`, `diff`, `list`, `wait`, `get_context`, `check` |
| implementer | `checkpoint`, `finish` | `status`, `diff`, `get_context`, `check` |
| reviewer | `finish` | `status`, `diff`, `get_context` |
| scout | `finish` | `status`, `diff`, `get_context` |

Source: `packages/plus/src/teams/policy.ts:57`–`packages/plus/src/teams/policy.ts:82`.
`delegate` accepts only the roles in `delegatedRoles`
(`packages/plus/src/teams/schema.ts:26`), with planner/orchestrator and
implementer/reviewer/scout combinations checked in the API
(`packages/plus/src/teams/api.ts:185`–`packages/plus/src/teams/api.ts:205`).

### 5.2 Tools

| Tool | Mode | Input schema | Purpose |
| --- | --- | --- | --- |
| `team_delegate` | native | `Brief` (`packages/plus/src/teams/schema.ts:135`) | Start a bounded task in a new isolated worktree |
| `team_finish` | native | `Report` (`packages/plus/src/teams/schema.ts:184`) | Declare an outcome for the current attempt |
| `team_followup` | native | `FollowupInput` (`packages/plus/src/teams/schema.ts:607`) | Send a correction to an owned child |
| `team_integrate` | native | `IntegrateInput` (`packages/plus/src/teams/schema.ts:625`) | Enqueue a completed child commit |
| `team_checkpoint` | native | `CheckpointInput` (`packages/plus/src/teams/schema.ts:631`) | Commit intended files after checking HEAD |
| `team_set_checks` | native | `SetChecksInput` (`packages/plus/src/teams/schema.ts:638`) | Record the task's focused checks |
| `team_supersede` | native | `SupersedeInput` (`packages/plus/src/teams/schema.ts:643`) | Abandon an owned child and cancel its task |
| `team_stop` | native | `StopInput` (`packages/plus/src/teams/schema.ts:650`) | Stop an owned child |
| `team_status` | Code Mode | `StatusInput` (`packages/plus/src/teams/schema.ts:655`) | Self plus direct children status |
| `team_wait` | Code Mode | `WaitInput` (`packages/plus/src/teams/schema.ts:660`) | Wait for children to settle or idle |
| `team_diff` | Code Mode | `DiffInput` (`packages/plus/src/teams/schema.ts:682`) | A run's worktree diff |
| `team_list` | Code Mode | `ListInput` (`packages/plus/src/teams/schema.ts:690`) | Runs visible to this caller |
| `team_get_context` | Code Mode | `GetContextInput` (`packages/plus/src/teams/schema.ts:698`) | Brief, checks, siblings, inbox and budget |
| `team_check` | Code Mode | `CheckInput` (`packages/plus/src/teams/schema.ts:701`) | Run one assigned focused check |

Registration lines: `packages/plus/src/teams/tools.ts:343` (`delegate`),
`:352` (`finish`), `:361` (`followup`), `:370` (`integrate`), `:379`
(`checkpoint`), `:388` (`set_checks`), `:397` (`supersede`), `:406` (`stop`),
`:415` (`status`), `:424` (`wait`), `:433` (`diff`), `:442` (`list`), `:451`
(`get_context`), `:460` (`check`). Every tool's permission action is
`team.<name>` (`packages/plus/src/teams/tools.ts:483`).

Validation ceilings: run ids match `^(main|w)-[0-9a-f]{16}$`
(`packages/plus/src/teams/schema.ts:18`); heads are 40 hex chars
(`packages/plus/src/teams/schema.ts:15`); task ids match
`^T[0-9]+(\.rework\.[0-9]+)?$` (`packages/plus/src/teams/schema.ts:21`).
Brief `scope.paths` max 40, `forbidden` max 20, `interfaces` max 20,
`decisions` max 20, `effort` defaults `medium`
(`packages/plus/src/teams/schema.ts:141`–`packages/plus/src/teams/schema.ts:156`).
Checks are at most 12, with distinct ids and explicit `bun test FILE` or
`bun run SCRIPT` argv (`packages/plus/src/teams/schema.ts:95`–
`packages/plus/src/teams/schema.ts:113`). A report summary is at most 15 lines
(`packages/plus/src/teams/schema.ts:173`) and 1500 characters
(`packages/plus/src/teams/schema.ts:186`); `needs`, `concerns`, `deferred` max
10 and `findings` max 50 (`packages/plus/src/teams/schema.ts:187`–
`packages/plus/src/teams/schema.ts:196`). `followup` caps the prompt at 4000
characters and `integrate` requires `expectedParentHead`
(`packages/plus/src/teams/schema.ts:610`, `packages/plus/src/teams/schema.ts:627`).
`supersede` bounds `reason` to 10–500 characters and `waitMs` to
0–120000 (`packages/plus/src/teams/schema.ts:645`,
`packages/plus/src/teams/schema.ts:646`).

`team_list` is scoped by role: planners see every run in the namespace, and
every other role sees its own run plus its direct children, sorted by
`lastUsed` descending (`packages/plus/src/teams/api-query.ts:32`–
`packages/plus/src/teams/api-query.ts:58`). The human Team tab does not use it:
`team.runs.list` is namespace-wide (§8).

### 5.3 Error codes

Tool failures carry `<CODE>: <message>`; the code is the text before the first
colon (`packages/plus/src/teams/tools.ts:651`). `failed` results may append
`accepted: …` for a retryable shape (`packages/plus/src/teams/tools.ts:616`).

| Code | Raised when | Source |
| --- | --- | --- |
| `E_NOT_ACTOR` | The session is not the run's owner | `packages/plus/src/teams/tools.ts:647` |
| `E_ROLE` | Unknown role or a tool outside the role ceiling | `packages/plus/src/teams/tools.ts:664`, `packages/plus/src/teams/api.ts:185` |
| `E_INTERNAL` | Unexpected failure (git read, unknown run) | `packages/plus/src/teams/tools.ts:562`, `packages/plus/src/teams/api.ts:138` |
| `E_TRANSITION` | An illegal run/attempt transition | `packages/plus/src/teams/run.ts:210`, `packages/plus/src/teams/run.ts:342` |
| `E_LOCKED` | State root locked by another writer | `packages/plus/src/teams/store.ts:114` |
| `E_CHECKS` | Check validation (count, ids, argv form) | `packages/plus/src/teams/schema.ts:97` |
| `E_SUMMARY` | Report summary over 15 lines | `packages/plus/src/teams/schema.ts:177` |
| `E_BOUNDS` | In-flight bounds exceeded | `packages/plus/src/teams/api.ts:274` |
| `E_PATHS` | Scope path outside the task worktree | `packages/plus/src/teams/api.ts:235`, `packages/plus/src/teams/api.ts:337` |
| `E_REPO` | Unknown repo for delegate | `packages/plus/src/teams/api.ts:212` |
| `E_BASE` | Unknown base ref | `packages/plus/src/teams/api.ts:222`, `packages/plus/src/teams/worktree.ts:81` |
| `E_REASON` | `reason` too short or a required reason missing | `packages/plus/src/teams/api.ts:249` |
| `E_SPARK` | `spark-implementer` brief outside its limits | `packages/plus/src/teams/api.ts:241` |
| `E_TOO_LONG` | Objective or prompt over its cap | `packages/plus/src/teams/api.ts:305` |
| `E_REQUEST_ID` | Reused request id | `packages/plus/src/teams/api.ts:293`, `packages/plus/src/teams/api-followup.ts:85` |
| `E_FINISH_TWICE` | A second report for the same attempt | `packages/plus/src/teams/api.ts:466` |
| `E_CHECKS_RED` | `finish done` with a failing check | `packages/plus/src/teams/api.ts:494` |
| `E_DIRTY` | Worktree dirty at a boundary that needs it clean | `packages/plus/src/teams/api.ts:503`, `packages/plus/src/teams/merge.ts:200` |
| `E_NEEDS` | `blocked` without needs | `packages/plus/src/teams/api.ts:510` |
| `E_STALE_HEAD` | `checkpoint` expectedHead mismatch | `packages/plus/src/teams/api.ts:569` |
| `E_SCOPE` | Checkpoint file outside `scope.paths` | `packages/plus/src/teams/api.ts:572` |
| `E_MESSAGE` | Commit message not conventional | `packages/plus/src/teams/api.ts:576` |
| `E_STAGED` | Staged files not in `files[]` | `packages/plus/src/teams/api.ts:588` |
| `E_TIMEOUT_MIN` | Check timeout below the 10000 ms floor | `packages/plus/src/teams/api.ts:634` |
| `E_NOT_VISIBLE` | Run outside the caller's namespace | `packages/plus/src/teams/api.ts:639`, `packages/plus/src/teams/api.ts:762` |
| `E_NO_BRIEF` | `get_context` with no stored brief | `packages/plus/src/teams/api.ts:692` |
| `E_UNKNOWN_RUN` | Unknown run id | `packages/plus/src/teams/api-query.ts:88`, `packages/plus/src/teams/api.ts:1003` |
| `E_NOT_CHILD` | Target is not a direct child | `packages/plus/src/teams/api-lifecycle.ts:27` |
| `E_BUSY` | Target is working (or delivery:`now` while busy) | `packages/plus/src/teams/api-lifecycle.ts:84`, `packages/plus/src/teams/api-followup.ts:169` |
| `E_TERMINAL` | Target is terminal | `packages/plus/src/teams/api-followup.ts:66` |
| `E_REVIEWER` | Followup addressed to a reviewer | `packages/plus/src/teams/api-followup.ts:74` |
| `E_DEPS` | Plan dependency error (unknown, duplicate, cycle) | `packages/plus/src/teams/tasks.ts:161` |
| `E_TASK_BLOCKED` | Task dependencies are open | `packages/plus/src/teams/tasks.ts:266` |
| `E_TASK_CLAIMED` | Task claimed by another run | `packages/plus/src/teams/tasks.ts:270` |
| `E_TASK_TRANSITION` | Illegal task state change | `packages/plus/src/teams/tasks.ts:263` |
| `E_REWORK_LIMIT` | More than 8 rework tasks | `packages/plus/src/teams/tasks.ts:387` |
| `E_STALE_PARENT` | Integrate parent HEAD moved | `packages/plus/src/teams/merge.ts:193`, `packages/plus/src/teams/merge.ts:343` |
| `E_ALREADY` | Child already landed | `packages/plus/src/teams/merge.ts:208` |
| `E_INBOX_FULL` | Child inbox at capacity | `packages/plus/src/teams/inbox.ts:100` |
| `E_UNKNOWN_CHECK` | `team_check` with an unassigned id | `packages/plus/src/teams/checks.ts:352` |
| `E_CHECK_TIMEOUT` | Check exceeded its timeout | `packages/plus/src/teams/checks.ts:225` |
| `E_CHECK_MUTATED` | Check mutated its worktree | `packages/plus/src/teams/checks.ts:234` |
| `E_PERMISSION` | The call was denied by a rule or a human | `packages/plus/src/teams/tools.ts:197`, `packages/plus/src/teams/tools.ts:243` |

### 5.4 Audit outcomes

Every gated team call writes a `tool.call` line to the audit chain
(`packages/plus/src/teams/tools.ts:139`–`packages/plus/src/teams/tools.ts:155`).
Its outcome is one of four values
(`packages/plus/src/teams/audit.ts:8`):

| Outcome | Meaning | Where written |
| --- | --- | --- |
| `allowed` | The body ran and no permission request intervened | `packages/plus/src/teams/tools.ts:522` |
| `asked:allow` | A permission request named this call and it proceeded | `packages/plus/src/teams/tools.ts:522` |
| `denied` | A rule denial, or a rejection carrying feedback | `packages/plus/src/teams/tools.ts:186`–`packages/plus/src/teams/tools.ts:199` |
| `asked:deny` | The human rejected the permission request | `packages/plus/src/teams/tools.ts:225`–`packages/plus/src/teams/tools.ts:246` |

The `tool.call` payload is `run`, `actor`, `sessionID`, `tool`, `ok`, `code`,
`durationMs` and `outcome` (`packages/plus/src/teams/tools.ts:139`). Per-call
state is keyed by `(sessionID, messageID, CallID)` and queued, so two calls
that share one CallID under Code Mode claim their own entries and produce two
lines (`packages/plus/src/teams/tools.ts:86`–`packages/plus/src/teams/tools.ts:114`,
`packages/plus/src/teams/tools.ts:500`–`packages/plus/src/teams/tools.ts:512`).
A rejection with feedback is written once: `Permission.CorrectedError` is left
to the replied observer (`packages/plus/src/teams/tools.ts:178`–
`packages/plus/src/teams/tools.ts:181`).

The chain also records `run.created` (`packages/plus/src/teams/run.ts:421`)
and `receipt.written` (`packages/plus/src/teams/checks.ts:273`). Each line is
HMAC-SHA256 over the previous line's SHA-256 and the canonical body
(`packages/plus/src/teams/audit.ts:89`, `packages/plus/src/teams/audit.ts:105`),
the key lives at `<teams data dir>/audit.key` with mode `0600`
(`packages/plus/src/teams/audit.ts:60`–`packages/plus/src/teams/audit.ts:87`),
and payloads carry ids, kinds and short status strings only
(`packages/plus/src/teams/audit.ts:103`). `verify` walks `prev` and `hmac` per
line (`packages/plus/src/teams/audit.ts:135`); `exportChain` drops the `hmac`
field (`packages/plus/src/teams/audit.ts:170`). The teams data dir is
`<XDG_DATA_HOME>/opencode/opencodeplus/teams`
(`packages/plus/src/instructions/paths.ts:41`).

## 6. `search` MCP tools

The server is `opencodeplus-search` (`packages/plus/src/search/mcp.ts:116`).

| Tool | Inputs | Errors |
| --- | --- | --- |
| `exa_code_search` | `query`, `type` `fast`/`auto`/`neural`/`keyword` (default `fast`), `numResults` 1–100 (default 10), `includeDomains`, `excludeDomains`, `startPublishedDate`, `endPublishedDate`, `contents` (default `{ highlights: true }`) (`packages/plus/src/search/mcp.ts:41`) | `EXA_API_KEY is not set in the host environment` (`packages/plus/src/search/mcp.ts:24`), `Exa search failed (<status>): …` (`packages/plus/src/search/mcp.ts:31`) |
| `tavily_search` | `query` 1–400 chars, `search_depth` `ultra-fast`/`fast`/`basic`/`advanced` (default `basic`), `topic` `general`/`news`/`finance`, `max_results` 1–20 (default 5), `time_range`, `include_domains`, `exclude_domains` (`packages/plus/src/search/mcp.ts:74`) | `TAVILY_API_KEY is not set in the host environment` (`packages/plus/src/search/mcp.ts:11`), `Tavily search failed (<status>): …` (`packages/plus/src/search/mcp.ts:18`) |
| `tavily_extract` | `urls` 1–20, `extract_depth` `basic`/`advanced`, `query`, `chunks_per_source` 1–5, `format` `markdown`/`text` (`packages/plus/src/search/mcp.ts:97`) | As `tavily_search` (`packages/plus/src/search/mcp.ts:9`) |

Failed calls return a text result `{ error: … }` with `isError: true`
(`packages/plus/src/search/mcp.ts:62`).

Keys are read at call time from
`<XDG_DATA_HOME>/opencode/opencodeplus/search/{exa,tavily}.key` (file mode
`0600`, value trimmed), falling back to `EXA_API_KEY` / `TAVILY_API_KEY` in the
process environment (`packages/plus/src/search/keys.ts:12`–
`packages/plus/src/search/keys.ts:45`). A key file whose mode is not `0600`
fails the call rather than being used (`packages/plus/src/search/keys.ts:35`).
Plus sets `OPENCODEPLUS_SEARCH_KEYS_DIR` on the server environment when it
registers the server (`packages/plus/src/search/register.ts:48`), and the
directory is overridable through that same variable
(`packages/plus/src/search/keys.ts:17`). No key is written to a config file,
row, log or report (`packages/plus/src/search/keys.ts:22`, README
`packages/plus/README.md:375`).

The search server's tools are permission actions of the form
`<server>_<tool>` (`packages/core/src/tool/mcp.ts:17`). Plus narrows the Tavily
tools for implementers, reviewers and scouts with the action
`search_tavily_*` (`packages/plus/src/instructions/team-policy-rows.ts:81`,
`packages/plus/src/instructions/team-policy-rows.ts:166`).

## 7. Permission actions and effects

A permission rule is `{ action, resource, effect, message? }` with `effect` one
of `allow`, `deny`, `ask` (`packages/schema/src/permission.ts:58`). Core
evaluates rules last-match-wins, so Plus appends and never has to decide
whether an earlier rule is redundant (`packages/plus/src/instructions/apply.ts:342`).

- `allow` lets the call proceed.
- `deny` refuses it. A denying rule's `message` is sent to the model instead
  of the generic refusal (`packages/schema/src/permission.ts:63`).
- `ask` raises a permission request to the human; an asking rule's `message`
  travels on the request as `metadata.message`
  (`packages/schema/src/permission.ts:65`).

Plus installs rules through the agent registration
(`packages/plus/src/instructions/apply.ts:337`–`packages/plus/src/instructions/apply.ts:363`).
A perm row that resolves OFF installs one deny per pattern, carrying the
rule's message (`packages/plus/src/instructions/apply.ts:365`–
`packages/plus/src/instructions/apply.ts:396`). Team policy rows install their
`policy.on` rules when the row resolves enabled and `policy.off` rules when it
resolves disabled (`packages/plus/src/instructions/apply.ts:408`–
`packages/plus/src/instructions/apply.ts:426`).

### 7.1 Actions Plus knows

| Action | Governs | Source |
| --- | --- | --- |
| `instructions` | The `instructions` namespace | `packages/plus/src/tools.ts:62` |
| `team.<name>` | One team tool; non-members get one `team.*` deny | `packages/plus/src/teams/tools.ts:484`, `packages/plus/src/instructions/apply.ts:434` |
| `shell`, `read`, `edit`, `write`, `webfetch`, `glob`, `grep` | Curated tool rules carried by perm items | `packages/plus/src/instructions/tool-permissions.ts:110`–`packages/plus/src/instructions/tool-permissions.ts:211` |
| `subagent`, `skill` | Id rules populated from discovered agents and skills | `packages/plus/src/instructions/tool-permissions.ts:226`–`packages/plus/src/instructions/tool-permissions.ts:234` |
| `question`, `task`, `shell`, `external_directory`, `read`, `subagent` | Role-native answers installed by team policy rows | `packages/plus/src/teams/policy.ts:98`–`packages/plus/src/teams/policy.ts:113` |
| `search_tavily_*` | The search server's Tavily tools | `packages/plus/src/instructions/team-policy-rows.ts:81` |

A perm item's action is the tool's own `options.permission` when the registry
provides it, falling back to the tool id; `edit`, `write` and `patch` share
core's `edit` action (`packages/plus/src/instructions/apply.ts:385`,
`packages/plus/src/instructions/tool-permissions.ts:293`).

### 7.2 Messages

- Shipped curated rules always carry a short message, one line each, naming
  the pattern they answer for
  (`packages/plus/src/instructions/tool-permissions.ts:99`,
  `packages/plus/src/instructions/tool-permissions.ts:110`–`packages/plus/src/instructions/tool-permissions.ts:221`).
- A user rule's `message` is optional on `RuleRecord`
  (`packages/plus/src/instructions/model.ts:577`); absent means the generic
  refusal. `validateRuleInput` trims it and treats a blank value as absent
  (`packages/plus/src/instructions/tool-permissions.ts:611`). It round-trips
  through the rule store and the snapshot serializer
  (`packages/plus/src/tools.ts:516`).
- `instructions_show` on a perm row returns the effective message: the user
  rule's own stored message wins, a curated row ships one, a mined row has none
  (`packages/plus/src/tools.ts:968`, `packages/plus/src/tools.ts:1027`).
- The TUI rule dialog prompts `Message shown on refusal (optional)` and writes
  it through `rule.update`; the detail pane renders `message:` when present
  (`packages/plus/src/tui/instructions/dialogs.tsx:802`,
  `packages/plus/src/tui/instructions/detail-pane.tsx:507`).
- Team policy messages: a native deny reads
  `<action>[ "<resource>"] is not available to <role>[; run checks with team_check]`
  (`packages/plus/src/instructions/team-policy-rows.ts:135`); a ceiling deny
  reads `team_<tool> is outside the <kind> ceiling`
  (`packages/plus/src/instructions/team-policy-rows.ts:160`); the edit-scope
  rules explain `scope.paths` and the never-editable state
  (`packages/plus/src/instructions/team-policy-rows.ts:269`–
  `packages/plus/src/instructions/team-policy-rows.ts:276`).

### 7.3 `ask` and `deny` by role

The role's native answers are data: `read` of key/env/auth files, `subagent`
and `task` are denied for every role; `question` is allow for planners and deny
otherwise; `shell` is allow for orchestrators and deny otherwise;
`external_directory` is allow for planners/orchestrators and deny otherwise
(`packages/plus/src/teams/policy.ts:98`–`packages/plus/src/teams/policy.ts:113`).
Implementers are denied rather than asked because a headless ask never returns
(`packages/plus/src/teams/policy.ts:99`).

`team.delegate` ships as `ask` for planner members, the human approval moment
(`packages/plus/src/instructions/team-policy-rows.ts:183`–
`packages/plus/src/instructions/team-policy-rows.ts:201`). A child run
overrides any ask to deny, again because a headless ask never returns
(`packages/plus/src/instructions/team-policy-rows.ts:211`–
`packages/plus/src/instructions/team-policy-rows.ts:216`). A live run's edit
scope arrives as rules on its role: the role's first row denies `*`, each row
allows its own `scope.paths`, and the last row denies `.git/**` and
`.opencodeplus/**` (`packages/plus/src/instructions/team-policy-rows.ts:204`–
`packages/plus/src/instructions/team-policy-rows.ts:243`).

### 7.4 Protected agents

Protection is decided by `actor.type === "tool"`. The tool layer refuses early
with `agent.protected: row belongs to protected agent "<id>"`
(`packages/plus/src/tools.ts:428`) before `set`, `reset`, `split`, `delete`,
and on agent/member/model/rule creates
(`packages/plus/src/tools.ts:284`, `packages/plus/src/tools.ts:375`). The API
boundary applies the same rule to every write that arrives with a tool actor,
including `instructions.mutate` with a caller-supplied actor
(`packages/plus/src/index.ts:2335`–`packages/plus/src/index.ts:2345`); a
missing actor normalizes to `{ type: "tui" }` and is never refused
(`packages/plus/src/index.ts:2571`).

## 8. RPC methods

The plugin RPC definition id is `opencode.plus`
(`packages/plus/src/rpc.ts:1092`). Inputs and outputs are the portable schemas
listed before the method table; every write input accepts an optional `actor`
(`packages/plus/src/rpc.ts:868`).

| Method | Input → output | Declared errors | Definition |
| --- | --- | --- | --- |
| `project.status` | `Empty` → `PortableStatus` | — | `packages/plus/src/rpc.ts:1095` |
| `project.enable` | `Empty` → `PortableStatus` | — | `packages/plus/src/rpc.ts:1099` |
| `project.disable` | `Empty` → `PortableStatus` | — | `packages/plus/src/rpc.ts:1103` |
| `instructions.snapshot` | `Empty` → `PortableSnapshot` | `project.disabled` | `packages/plus/src/rpc.ts:1107` |
| `instructions.refresh` | `Empty` → `PortableSnapshot` | `project.disabled` | `packages/plus/src/rpc.ts:1114` |
| `instructions.mutate` | `PortableMutateInput` → `PortableMutateResult` | `project.disabled`, `agent.protected` | `packages/plus/src/rpc.ts:1121` |
| `instructions.log` | `PortableLogInput` → `PortableLogOutput` | `project.disabled` | `packages/plus/src/rpc.ts:1129` |
| `instructions.assembled` | `PortableAssembledInput` → `PortableAssembled` | `project.disabled`, `agent.unknown` | `packages/plus/src/rpc.ts:1136` |
| `agent.create` | `PortableCreateAgentInput` → `PortableAgentRef` | `project.disabled`, `agent.exists`, `agent.invalid`, `agent.protected` | `packages/plus/src/rpc.ts:1144` |
| `agent.rename` | `PortableRenameAgentInput` → `PortableRenameAgentResult` | `project.disabled`, `agent.missing`, `agent.exists`, `agent.invalid`, `agent.protected` | `packages/plus/src/rpc.ts:1154` |
| `agent.delete` | `PortableDeleteAgentInput` → `PortableAgentRef` | `project.disabled`, `agent.missing`, `agent.invalid`, `agent.protected` | `packages/plus/src/rpc.ts:1165` |
| `skill.create` | `PortableCreateSkillInput` → `PortableSkillRef` | `project.disabled`, `skill.exists`, `skill.invalid` | `packages/plus/src/rpc.ts:1175` |
| `skill.import` | `PortableImportSkillInput` → `PortableSkillRef` | `project.disabled`, `skill.exists`, `skill.invalid` | `packages/plus/src/rpc.ts:1184` |
| `skill.delete` | `PortableDeleteSkillInput` → `PortableSkillRef` | `project.disabled`, `skill.missing`, `skill.invalid` | `packages/plus/src/rpc.ts:1193` |
| `base.create` | `PortableCreateBaseInput` → `PortableBaseRef` | `project.disabled`, `base.exists`, `base.invalid` | `packages/plus/src/rpc.ts:1202` |
| `base.delete` | `PortableDeleteBaseInput` → `PortableBaseRef` | `project.disabled`, `base.missing`, `base.invalid` | `packages/plus/src/rpc.ts:1211` |
| `instruction.create` | `PortableCreateInstructionInput` → `PortableInstructionRef` | `project.disabled`, `instruction.exists`, `instruction.invalid` | `packages/plus/src/rpc.ts:1220` |
| `instruction.delete` | `PortableDeleteInstructionInput` → `PortableInstructionRef` | `project.disabled`, `instruction.missing`, `instruction.invalid` | `packages/plus/src/rpc.ts:1229` |
| `mcp.add` | `PortableAddMcpInput` → `PortableMcpRef` | `project.disabled`, `mcp.exists`, `mcp.invalid` | `packages/plus/src/rpc.ts:1238` |
| `mcp.remove` | `PortableMcpRef` → `PortableMcpRef` | `project.disabled`, `mcp.missing`, `mcp.invalid` | `packages/plus/src/rpc.ts:1247` |
| `team.create` | `PortableCreateTeamInput` → `PortableTeamRef` | `project.disabled`, `team.exists`, `team.invalid`, `team.create`, `agent.protected` | `packages/plus/src/rpc.ts:1256` |
| `team.setEnabled` | `PortableSetTeamEnabledInput` → `PortableTeamRef` | `project.disabled`, `team.unknown`, `team.invalid` | `packages/plus/src/rpc.ts:1267` |
| `team.addAgent` | `PortableTeamAddAgentInput` → `PortableAgentRef` | `project.disabled`, `team.unknown`, `team.invalid`, `agent.exists`, `agent.invalid`, `agent.protected` | `packages/plus/src/rpc.ts:1276` |
| `team.removeAgent` | `PortableTeamRemoveAgentInput` → `PortableAgentRef` | `project.disabled`, `team.unknown`, `team.invalid`, `agent.invalid`, `agent.protected` | `packages/plus/src/rpc.ts:1288` |
| `team.delete` | `PortableDeleteTeamInput` → `PortableDeleteTeamResult` | `project.disabled`, `team.unknown`, `team.invalid`, `agent.protected` | `packages/plus/src/rpc.ts:1299` |
| `team.list` | `Empty` → `PortableTeamListOutput` | `project.disabled` | `packages/plus/src/rpc.ts:1309` |
| `team.runs.list` | `PortableTeamRunsListInput` → `PortableTeamRunsListOutput` | — | `packages/plus/src/rpc.ts:1316` |
| `team.runs.stop` | `PortableTeamRunsStopInput` → `PortableTeamRunsStopOutput` | `E_BUSY`, `run.unknown` | `packages/plus/src/rpc.ts:1321` |
| `model.add` | `PortableModelAddInput` → `PortableModelRef` | `project.disabled`, `model.exists`, `model.invalid`, `agent.protected` | `packages/plus/src/rpc.ts:1329` |
| `model.remove` | `PortableModelRemoveInput` → `PortableModelRef` | `project.disabled`, `model.missing`, `model.invalid`, `agent.protected` | `packages/plus/src/rpc.ts:1339` |
| `catalog.models` | `Empty` → `PortableCatalogModelsOutput` | `project.disabled` | `packages/plus/src/rpc.ts:1349` |
| `rule.add` | `PortableRuleAddInput` → `PortableRuleRef` | `project.disabled`, `rule.exists`, `rule.invalid`, `agent.protected` | `packages/plus/src/rpc.ts:1356` |
| `rule.remove` | `PortableRuleRemoveInput` → `PortableRuleRef` | `project.disabled`, `rule.missing`, `rule.invalid`, `agent.protected` | `packages/plus/src/rpc.ts:1366` |
| `rule.update` | `PortableRuleUpdateInput` → `PortableRuleRef` | `project.disabled`, `rule.invalid`, `agent.protected` | `packages/plus/src/rpc.ts:1376` |

Events: `project.changed` (`packages/plus/src/rpc.ts:1387`),
`instructions.changed` (`packages/plus/src/rpc.ts:1390`) and `teams.changed`
(`packages/plus/src/rpc.ts:1393`).

`team.list` returns teams, not runs (`packages/plus/src/rpc.ts:1309`); the
agent-facing `team_list` tool lists runs visible to the caller's role (§5.2).
`team.runs.list` is namespace-wide: it reads every `runs/<id>/run.json` under
the Plus data root, hides `superseded`/`reaped` unless `all: true`, and sorts
by `lastUsed` descending (`packages/plus/src/teams/api-query.ts:166`–
`packages/plus/src/teams/api-query.ts:176`,
`packages/plus/src/teams/api-query.ts:20`). Its handler passes `{ all }`
straight through (`packages/plus/src/index.ts:2027`). `team.runs.stop` is the
human stop: idle runs are interrupted and moved `stopping` → `stopped`, a
`working` run fails `E_BUSY`, a `dead` run is reconciled to `stopped`, and a
`stopped`/`stopping`/terminal run answers with its current state
(`packages/plus/src/teams/api-lifecycle.ts:80`–`packages/plus/src/teams/api-lifecycle.ts:103`,
`packages/plus/src/index.ts:2033`).

## 9. Team composer tab

The chat composer registers a tab `id: "team"`, `label: "Team"`
(`packages/plus/src/tui/active-team.tsx:214`). Its hint bar reads
`↑↓ move · ⏎ attach · ctrl+a active|inactive · ctrl+d stop|resume`
(`packages/plus/src/tui/active-team.tsx:217`–`packages/plus/src/tui/active-team.tsx:222`).

Rows are runs, one per run, rendered `id — role — state — task`
(`packages/plus/src/tui/active-team.tsx:498`), newest first because the list
is sorted by `lastUsed` descending (`packages/plus/src/teams/api-query.ts:20`).
The default view filters to active states `working`, `idle`, `starting`,
`blocked_input`, `stopping`; `ctrl+a` switches to inactive states `stopped`,
`dead`, `superseded`, `reaped`
(`packages/plus/src/tui/active-team.tsx:329`–`packages/plus/src/tui/active-team.tsx:336`).
The list refreshes on `teams.changed`, on `session.*` data events, and on a 2 s
tick while the tab is active
(`packages/plus/src/tui/active-team.tsx:305`–`packages/plus/src/tui/active-team.tsx:321`).

| Key | Command | Behavior |
| --- | --- | --- |
| `↑` | `composer.team.up` | Previous run; at the first row, closes the tab (`packages/plus/src/tui/active-team.tsx:396`) |
| `↓` | `composer.team.down` | Next run, wrapping (`packages/plus/src/tui/active-team.tsx:408`) |
| `⏎` | `composer.team.select` | Attach: navigates to the run's session and closes the tab (`packages/plus/src/tui/active-team.tsx:418`, `packages/plus/src/tui/active-team.tsx:350`) |
| `ctrl+a` | `composer.team.toggle_activity` | Toggle active/inactive view, reset selection to the first row (`packages/plus/src/tui/active-team.tsx:428`) |
| `ctrl+d` | `composer.team.action` | `idle` → stop via `team.runs.stop`; `stopped`/`dead` → attach (resume); `working` → toast `Run must be interrupted first`; other states are ignored (`packages/plus/src/tui/active-team.tsx:439`, `packages/plus/src/tui/active-team.tsx:357`–`packages/plus/src/tui/active-team.tsx:388`) |

The keymap layer is `mode: "composer"`, `enabled` while the tab is active,
`priority: 1` (`packages/plus/src/tui/active-team.tsx:390`). That layer owns
`ctrl+d` while the tab is active; the host's global `app.exit` also names
`ctrl+d` (`packages/tui/src/config/keybind.ts:48`), and the tab binding takes
precedence — `ctrl+d` reaches the Team tab and no fallback key is used.
Mouse move selects a row, mouse up attaches it
(`packages/plus/src/tui/active-team.tsx:480`).

Resume is not a tool. On a `stopped` or `dead` run, `ctrl+d` attaches to the
session; when that session starts executing, the lifecycle observer moves the
run back to `working` on trigger `resume` (trigger `prompt` from `idle`)
(`packages/plus/src/teams/lifecycle.ts:188`–`packages/plus/src/teams/lifecycle.ts:196`),
and the transition table carries `stopped → working` and `dead → working`
(`packages/plus/src/teams/run.ts:137`, `packages/plus/src/teams/run.ts:147`).
The tab lists the data root's runs only; it does not filter by team, and the
active-team concept stays in the footer
(`packages/plus/src/tui/active-team.tsx:204`).