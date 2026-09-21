# Round 3 — instructions create/show/delete captured outputs (end-state items 1–3)

Capture head: `2bbcda64a98cbcc06a3641ebb96b170e7fadf024`
Capture tree: `b786afc81aabe4f54b7d937c8caea6c38dab1b6e`
Check: `tools` (`team_check`) — `bun test test/tools.test.ts test/teams-rpc.test.ts test/ops.test.ts`, cwd `packages/plus`
Result at that head: exit code `0`; `129 pass`, `1 skip`, `0 fail`, `793 expect() calls`, `Ran 130 tests across 3 files. [2.13s]`
The one skip is the pre-existing `delete instruction removes the project file` (the disabled
AGENTS.md surface, kept skipped rather than deleted).

This document records only the tool outputs for end-state items 1–3 (and the preserved
`instruction.disabled` surface). It makes no live-verification claim; the orchestrator owns
the walkthrough and the live evidence.

## How the output was produced

The existing real-handler tests in `packages/plus/test/tools.test.ts` (harness
`test/harness.ts`, no mocks) were minimally instrumented with labeled capture calls that
print the values their assertions already check. No assertion, behavior, order or fixture
changed; the captures only add reads:

- `round-trip <kind>` lines come from
  `every enabled create kind returns the row id show and delete accept, and delete removes the row`
  (create → returned id → tree row → `show` → inappropriate-view refusal → `delete`).
- `levels ...` lines come from
  `create returns the created level's model and rule row, not the identical Defaults row`.
- `member flow ...` lines come from
  `create kind member adds members at project and defaults level and returns the member row id`
  and `create kind member forwards the agent fields to team.addAgent`.
- `team template ...` lines come from
  `create kind team passes the template to team.create and produces the template's members`.
- the `instruction.disabled ...` line comes from
  `create kind instruction is refused with instruction.disabled and writes nothing`.

The only text substitution is the disposable `mkdtemp` project root replaced literally with
`<project>` (`round3Value` in the test file). Config-dir paths (global teams, Defaults
overlay) are quoted verbatim as returned. One line is a labeled projection: the agent's
`view: "assembled"` readback lists every visible system/tool/skill text, so
`round-trip agent: show` keeps the row identity, the visible tool/skill ids and the system
entry count and carries `"projection": "assembled text bodies replaced by their ids and a
system entry count"`; its assembled bodies are the only omitted text. No credentials appear
in any line.

Capture channel: each labeled line is printed with `console.log` as its test runs and the
whole block is repeated with `console.error` when the file finishes. The tool transcript for
this check keeps stderr whole but truncates the head of stdout, so the block below is the
stderr copy of the same run (the stdout copy is identical).

## Item 3 — every enabled create kind returns the row id `show` and `delete` accept

Eight enabled kinds: `agent`, `skill`, `base`, `mcp`, `model`, `rule`, `member`, `team`.
Each line shows the create request and its full returned value, the expanded-tree row the
returned id resolved to, the `show` result for that id, any `view.unsupported` refusal the
test asserts, and the `delete` result with `rowStillInTree` after it.

```text
[round3] round-trip agent: create {"request":{"kind":"agent","id":"helper","prompt":"helper role","scope":"project"},"output":{"id":"agent:project:helper","path":"<project>/.opencode/agent/helper.md","item":"helper"},"row":{"id":"agent:project:helper","kind":"agent"}}
[round3] round-trip agent: show {"request":{"id":"agent:project:helper","view":"assembled"},"output":{"id":"agent:project:helper","view":"assembled","agent":"helper","systemEntries":1,"toolIds":["shell","instructions_list","instructions_show","instructions_set","instructions_reset","instructions_split","instructions_create","instructions_delete","instructions_log","execute"],"skillIds":["notes2"],"projection":"assembled text bodies replaced by their ids and a system entry count"}}
[round3] round-trip agent: delete {"request":{"id":"agent:project:helper","confirm":true},"output":{"id":"helper","path":"<project>/.opencode/agent/helper.md","status":"Deleted agent helper"},"rowStillInTree":false}
[round3] round-trip skill: create {"request":{"kind":"skill","name":"notes2","body":"Take notes."},"output":{"id":"item:defaults::skill:notes2","path":"<project>/.opencode/skill/notes2/SKILL.md","item":"skill:notes2"},"row":{"id":"item:defaults::skill:notes2","kind":"item"}}
[round3] round-trip skill: show {"request":{"id":"item:defaults::skill:notes2","view":"resolved"},"output":{"id":"item:defaults::skill:notes2","view":"resolved","text":"Take notes.","assembled":"Take notes.","enabled":true,"source":"upstream"}}
[round3] round-trip skill: delete {"request":{"id":"item:defaults::skill:notes2","confirm":true},"output":{"id":"notes2","path":"<project>/.opencode/skill/notes2/SKILL.md","status":"Deleted skill notes2"},"rowStillInTree":true}
[round3] round-trip base: create {"request":{"kind":"base","id":"custom","title":"Custom.txt","text":"custom base"},"output":{"id":"item:defaults::base:custom","item":"base:custom"},"row":{"id":"item:defaults::base:custom","kind":"item"}}
[round3] round-trip base: show {"request":{"id":"item:defaults::base:custom","view":"resolved"},"output":{"id":"item:defaults::base:custom","view":"resolved","text":"custom base","assembled":"custom base","enabled":true,"source":"upstream"}}
[round3] round-trip base: delete {"request":{"id":"item:defaults::base:custom","confirm":true},"output":{"id":"custom","status":"Deleted base template custom"},"rowStillInTree":false}
[round3] round-trip mcp: create {"request":{"kind":"mcp","name":"search","config":{"type":"remote","url":"https://example.test"}},"output":{"name":"search","id":"item:defaults::mcp:search","item":"mcp:search"},"row":{"id":"item:defaults::mcp:search","kind":"item"}}
[round3] round-trip mcp: show {"request":{"id":"item:defaults::mcp:search","view":"resolved"},"output":{"id":"item:defaults::mcp:search","view":"resolved","text":"{\"type\":\"remote\",\"url\":\"https://example.test\"}","assembled":"{\"type\":\"remote\",\"url\":\"https://example.test\"}","enabled":true,"source":"upstream"}}
[round3] round-trip mcp: delete {"request":{"id":"item:defaults::mcp:search","confirm":true},"output":{"name":"search","status":"Removed MCP server search"},"rowStillInTree":true}
[round3] round-trip model: create {"request":{"kind":"model","providerID":"acme","modelID":"nova-2","level":"project","agent":"owner"},"output":{"level":"project","agent":"owner","providerID":"acme","modelID":"nova-2","id":"item:project:owner:model:acme/nova-2","item":"model:acme/nova-2"},"row":{"id":"item:project:owner:model:acme/nova-2","kind":"item"}}
[round3] round-trip model: show {"request":{"id":"item:project:owner:model:acme/nova-2","view":"resolved"},"output":{"id":"item:project:owner:model:acme/nova-2","view":"resolved","text":"acme/nova-2","assembled":"acme/nova-2","enabled":true,"source":"upstream"}}
[round3] round-trip model: delete {"request":{"id":"item:project:owner:model:acme/nova-2","confirm":true},"output":{"level":"project","agent":"owner","providerID":"acme","modelID":"nova-2","status":"Removed \"item:project:owner:model:acme/nova-2\""},"rowStillInTree":false}
[round3] round-trip rule: create {"request":{"kind":"rule","tool":"shell","id":"owner-rule","label":"Owner rule","patterns":["git push *"],"level":"project","agent":"owner"},"output":{"level":"project","agent":"owner","tool":"shell","id":"item:project:owner:perm:shell:owner-rule","label":"Owner rule","item":"perm:shell:owner-rule"},"row":{"id":"item:project:owner:perm:shell:owner-rule","kind":"item"}}
[round3] round-trip rule: show {"request":{"id":"item:project:owner:perm:shell:owner-rule","view":"resolved"},"output":{"id":"item:project:owner:perm:shell:owner-rule","view":"resolved","tool":"shell","rule":"owner-rule","label":"Owner rule","patterns":["git push *"],"keywords":["git push"],"provenance":[],"custom":true,"enabled":true,"source":"upstream","scrub":{"hidden":0,"preview":[]}}}
[round3] round-trip rule: delete {"request":{"id":"item:project:owner:perm:shell:owner-rule","confirm":true},"output":{"level":"project","agent":"owner","tool":"shell","id":"owner-rule","label":"Owner rule","status":"Removed \"item:project:owner:perm:shell:owner-rule\""},"rowStillInTree":false}
[round3] round-trip member: create {"request":{"kind":"member","team":"crew","level":"project","id":"newbie","prompt":"newbie role"},"output":{"id":"team:project:crew:newbie","path":"<project>/.opencodeplus/teams/crew/newbie.md","item":"newbie"},"row":{"id":"team:project:crew:newbie","kind":"team"}}
[round3] round-trip member: show {"request":{"id":"team:project:crew:newbie","view":"resolved"},"output":{"id":"team:project:crew:newbie","view":"resolved","kind":"member","level":"project","team":"crew","member":"newbie","registered":false}}
[round3] round-trip member: show diff refusal {"request":{"id":"team:project:crew:newbie","view":"diff"},"error":"view.unsupported: diff view is not available for team rows (got team:project:crew:newbie)"}
[round3] round-trip member: delete {"request":{"id":"team:project:crew:newbie","confirm":true},"output":{"id":"newbie","path":"<project>/.opencodeplus/teams/crew/newbie.md","status":"Deleted team member newbie"},"rowStillInTree":false}
[round3] round-trip team: create {"request":{"kind":"team","team":" squad ","level":"project"},"output":{"level":"project","team":"squad","enabled":false,"id":"team:project:squad","item":"squad"},"row":{"id":"team:project:squad","kind":"team"}}
[round3] round-trip team: show {"request":{"id":"team:project:squad","view":"resolved"},"output":{"id":"team:project:squad","view":"resolved","kind":"team","level":"project","team":"squad","enabled":false,"members":[]}}
[round3] round-trip team: show sections refusal {"request":{"id":"team:project:squad","view":"sections"},"error":"view.unsupported: sections view is not available for team rows (got team:project:squad)"}
[round3] round-trip team: delete {"request":{"id":"team:project:squad","confirm":true},"output":{"level":"project","team":"squad","removedMembers":0,"status":"Deleted team squad"},"rowStillInTree":false}
```

The same returned-id contract at each level, including the shared (`agent: null`) model and
rule rows and the no-agent model refusal:

```text
[round3] levels create outputs (model and rule at defaults / project / global) {"noAgentModelError":"create model requires agent for project|global levels","sharedModel":{"level":"defaults","agent":null,"providerID":"acme","modelID":"nova-2","id":"item:defaults::model:acme/nova-2","item":"model:acme/nova-2"},"sharedRule":{"level":"project","agent":null,"tool":"shell","id":"item:defaults::perm:shell:shared-rule","label":"Shared","item":"perm:shell:shared-rule"},"storedShared":{"type":"rule","level":"project","agent":null,"tool":"shell","id":"shared-rule","label":"Shared","patterns":["git push *"],"keywords":["git push"],"updated":"2026-09-21T18:17:26.273Z"},"projectModel":{"level":"project","agent":"proj","providerID":"acme","modelID":"nova-2","id":"item:project:proj:model:acme/nova-2","item":"model:acme/nova-2"},"globalModel":{"level":"global","agent":"glob","providerID":"acme","modelID":"nova-2","id":"item:global:glob:model:acme/nova-2","item":"model:acme/nova-2"},"projectRule":{"level":"project","agent":"proj","tool":"shell","id":"item:project:proj:perm:shell:proj-rule","label":"Proj","item":"perm:shell:proj-rule"},"globalRule":{"level":"global","agent":"glob","tool":"shell","id":"item:global:glob:perm:shell:glob-rule","label":"Glob","item":"perm:shell:glob-rule"},"storedGlobalRule":{"type":"rule","level":"global","agent":"glob","tool":"shell","id":"glob-rule","label":"Glob","patterns":["glob *"],"keywords":["glob"],"updated":"2026-09-21T18:17:26.324Z"}}
[round3] levels delete round-trip {"request":{"id":"item:defaults::model:acme/nova-2","confirm":true},"output":{"level":"defaults","agent":null,"providerID":"acme","modelID":"nova-2","status":"Removed \"item:defaults::model:acme/nova-2\""}}
[round3] levels delete round-trip {"request":{"id":"item:defaults::perm:shell:shared-rule","confirm":true},"output":{"level":"project","agent":null,"tool":"shell","id":"shared-rule","label":"Shared","status":"Removed \"item:defaults::perm:shell:shared-rule\""}}
[round3] levels delete round-trip {"request":{"id":"item:project:proj:model:acme/nova-2","confirm":true},"output":{"level":"project","agent":"proj","providerID":"acme","modelID":"nova-2","status":"Removed \"item:project:proj:model:acme/nova-2\""}}
[round3] levels delete round-trip {"request":{"id":"item:global:glob:model:acme/nova-2","confirm":true},"output":{"level":"global","agent":"glob","providerID":"acme","modelID":"nova-2","status":"Removed \"item:global:glob:model:acme/nova-2\""}}
[round3] levels delete round-trip {"request":{"id":"item:project:proj:perm:shell:proj-rule","confirm":true},"output":{"level":"project","agent":"proj","tool":"shell","id":"proj-rule","label":"Proj","status":"Removed \"item:project:proj:perm:shell:proj-rule\""}}
[round3] levels delete round-trip {"request":{"id":"item:global:glob:perm:shell:glob-rule","confirm":true},"output":{"level":"global","agent":"glob","tool":"shell","id":"glob-rule","label":"Glob","status":"Removed \"item:global:glob:perm:shell:glob-rule\""}}
```

## Item 2 — `create kind:"member"` at project, global and Defaults

`member flow` lines show: a whitespace-padded colon team name normalized to `crew:one` with a
nested member id (`nested/beta`), its entity and record views, the expanded subtree the
returned id resolves into, a `set` on a subtree row, the same member registered after the
team is enabled, the global member and the Defaults overlay member (with the snapshot team
entry that lists `"overlay":["rookie"]`), each delete round-trip, and the `fields` forwarded
to `team.addAgent`.

```text
[round3] member flow: create team crew:one {"request":{"kind":"team","team":"crew:one","level":"project"},"output":{"level":"project","team":"crew:one","enabled":false,"id":"team:project:crew:one","item":"crew:one"}}
[round3] member flow: create project member (padded colon team, nested member id) {"request":{"kind":"member","team":" crew:one ","level":"project","id":"nested/beta","prompt":"beta role"},"output":{"id":"team:project:crew:one:nested/beta","path":"<project>/.opencodeplus/teams/crew:one/nested/beta.md","item":"nested/beta"},"file":{"path":"<project>/.opencodeplus/teams/crew:one/nested/beta.md","text":"beta role"}}
[round3] member flow: project member resolved + record views (team disabled) {"request":{"id":"team:project:crew:one:nested/beta"},"resolved":{"id":"team:project:crew:one:nested/beta","view":"resolved","kind":"member","level":"project","team":"crew:one","member":"nested/beta","registered":false},"record":{"id":"team:project:crew:one:nested/beta","view":"record","record":{"kind":"member","level":"project","team":"crew:one","member":"nested/beta","registered":false}}}
[round3] member flow: project member subtree rows {"subtreeTool":"item:project:crew:one/:nested/beta:tool:shell","memberRows":["team:project:crew:one:nested/beta","group:project:crew:one/:nested/beta:models","group:project:crew:one/:nested/beta:tools","group:project:crew:one/:nested/beta:tools:native","item:project:crew:one/:nested/beta:tool:execute","item:project:crew:one/:nested/beta:tool:shell","section:project:crew:one/:nested/beta:tool:shell:whole","item:project:crew:one/:nested/beta:perm:shell:git","item:project:crew:one/:nested/beta:perm:shell:git-push","item:project:crew:one/:nested/beta:perm:shell:git-commit","item:project:crew:one/:nested/beta:perm:shell:git-rewrite","item:project:crew:one/:nested/beta:perm:shell:rm","item:project:crew:one/:nested/beta:perm:shell:rm-rf","item:project:crew:one/:nested/beta:perm:shell:sudo","item:project:crew:one/:nested/beta:perm:shell:chmod-chown","item:project:crew:one/:nested/beta:perm:shell:curl-wget","item:project:crew:one/:nested/beta:perm:shell:ssh-scp","item:project:crew:one/:nested/beta:perm:shell:docker","item:project:crew:one/:nested/beta:perm:shell:kubectl","item:project:crew:one/:nested/beta:perm:shell:js-install","item:project:crew:one/:nested/beta:perm:shell:npm-publish","item:project:crew:one/:nested/beta:perm:shell:pip-install","item:project:crew:one/:nested/beta:perm:shell:kill","item:project:crew:one/:nested/beta:perm:shell:disk-destructive","item:project:crew:one/:nested/beta:perm:shell:env","item:project:crew:one/:nested/beta:perm:shell:package-scripts","group:project:crew:one/:nested/beta:tools:plus","group:project:crew:one/:nested/beta:tools:plus:codemode","group:project:crew:one/:nested/beta:tools:plus:codemode:instructions","item:project:crew:one/:nested/beta:tool:instructions_create","section:project:crew:one/:nested/beta:tool:instructions_create:whole","item:project:crew:one/:nested/beta:tool:instructions_delete","section:project:crew:one/:nested/beta:tool:instructions_delete:whole","item:project:crew:one/:nested/beta:tool:instructions_list","section:project:crew:one/:nested/beta:tool:instructions_list:whole","item:project:crew:one/:nested/beta:tool:instructions_log","section:project:crew:one/:nested/beta:tool:instructions_log:whole","item:project:crew:one/:nested/beta:tool:instructions_reset","section:project:crew:one/:nested/beta:tool:instructions_reset:whole","item:project:crew:one/:nested/beta:tool:instructions_set","section:project:crew:one/:nested/beta:tool:instructions_set:whole","item:project:crew:one/:nested/beta:tool:instructions_show","section:project:crew:one/:nested/beta:tool:instructions_show:whole","item:project:crew:one/:nested/beta:tool:instructions_split","section:project:crew:one/:nested/beta:tool:instructions_split:whole","group:project:crew:one/:nested/beta:tools:mcp","group:project:crew:one/:nested/beta:base","item:project:crew:one/:nested/beta:base:claude","section:project:crew:one/:nested/beta:base:claude:whole","item:project:crew:one/:nested/beta:base:gpt","section:project:crew:one/:nested/beta:base:gpt:whole","item:project:crew:one/:nested/beta:base:gemini","section:project:crew:one/:nested/beta:base:gemini:whole","item:project:crew:one/:nested/beta:base:general","section:project:crew:one/:nested/beta:base:general:whole","item:project:crew:one/:nested/beta:base:kimi","section:project:crew:one/:nested/beta:base:kimi:whole","item:project:crew:one/:nested/beta:base:muse","section:project:crew:one/:nested/beta:base:muse:whole","item:project:crew:one/:nested/beta:base:trinity","section:project:crew:one/:nested/beta:base:trinity:whole","group:project:crew:one/:nested/beta:skills","group:project:crew:one/:nested/beta:skills:native","group:project:crew:one/:nested/beta:skills:plus","group:project:crew:one/:nested/beta:skills:mcp","group:project:crew:one/:nested/beta:skills:project","group:project:crew:one/:nested/beta:system"]}
[round3] member flow: subtree row set {"request":{"id":"item:project:crew:one/:nested/beta:tool:shell","state":"off"},"output":{"id":"item:project:crew:one/:nested/beta:tool:shell","status":"Disabled \"shell\"","revision":1,"globalRevision":0}}
[round3] member flow: project member view after team enable {"enableResult":{"level":"project","team":"crew:one","enabled":true},"resolved":{"id":"team:project:crew:one:nested/beta","view":"resolved","kind":"member","level":"project","team":"crew:one","member":"nested/beta","registered":true}}
[round3] member flow: create team gcrew (global) {"request":{"kind":"team","team":"gcrew","level":"global"},"output":{"level":"global","team":"gcrew","enabled":false,"id":"team:global:gcrew","item":"gcrew"}}
[round3] member flow: create global member (padded team name) {"request":{"kind":"member","team":" gcrew ","level":"global","id":"gmember","prompt":"global member role"},"output":{"id":"team:global:gcrew:gmember","path":"/home/bliss/OpenCodePlus/run/team/development-models/runs/w-ed46e621f71ebdca/tmp/plus-tools-MmYlei/config/opencodeplus/teams/gcrew/gmember.md","item":"gmember"},"file":{"path":"/home/bliss/OpenCodePlus/run/team/development-models/runs/w-ed46e621f71ebdca/tmp/plus-tools-MmYlei/config/opencodeplus/teams/gcrew/gmember.md","text":"global member role"},"resolved":{"id":"team:global:gcrew:gmember","view":"resolved","kind":"member","level":"global","team":"gcrew","member":"gmember","registered":false}}
[round3] member flow: create Defaults overlay member (padded built-in team name) {"request":{"kind":"member","team":" ship ","level":"defaults","id":"rookie","prompt":"rookie role"},"output":{"id":"team:defaults:ship:rookie","path":"/home/bliss/OpenCodePlus/run/team/development-models/runs/w-ed46e621f71ebdca/tmp/plus-tools-MmYlei/config/opencodeplus/teams-defaults/ship/rookie.md","item":"rookie"},"file":{"path":"/home/bliss/OpenCodePlus/run/team/development-models/runs/w-ed46e621f71ebdca/tmp/plus-tools-MmYlei/config/opencodeplus/teams-defaults/ship/rookie.md","text":"rookie role"},"snapshotTeam":{"level":"defaults","team":"ship","enabled":false,"agents":["mate","rookie"],"overlay":["rookie"]},"resolved":{"id":"team:defaults:ship:rookie","view":"resolved","kind":"member","level":"defaults","team":"ship","member":"rookie","registered":false}}
[round3] member flow: delete project member {"request":{"id":"team:project:crew:one:nested/beta","confirm":true},"output":{"id":"nested/beta","path":"<project>/.opencodeplus/teams/crew:one/nested/beta.md","status":"Deleted team member nested/beta"},"fileExists":false}
[round3] member flow: delete global member {"request":{"id":"team:global:gcrew:gmember","confirm":true},"output":{"id":"gmember","path":"/home/bliss/OpenCodePlus/run/team/development-models/runs/w-ed46e621f71ebdca/tmp/plus-tools-MmYlei/config/opencodeplus/teams/gcrew/gmember.md","status":"Deleted team member gmember"},"fileExists":false}
[round3] member flow: delete Defaults overlay member {"request":{"id":"team:defaults:ship:rookie","confirm":true},"output":{"id":"rookie","path":"/home/bliss/OpenCodePlus/run/team/development-models/runs/w-ed46e621f71ebdca/tmp/plus-tools-MmYlei/config/opencodeplus/teams-defaults/ship/rookie.md","status":"Deleted team member rookie"},"fileExists":false}
[round3] member flow: agent fields forwarded to team.addAgent {"output":{"id":"team:project:crew:fielded","path":"<project>/.opencodeplus/teams/crew/fielded.md","item":"fielded"},"forwarded":{"level":"project","team":"crew","id":"fielded","prompt":"fielded role","fields":{"description":"fielded desc","mode":"subagent"},"actor":{"type":"tool","agent":"alpha","sessionID":"ses_tools_test","messageID":"msg_tools_test"}}}
```

## Item 1 — `create kind:"team"` with a template

The created team reports `"members":["editor","reviewer"]` and the two member rows the
template produced; the member files are the exact bytes the same `team.create` handler
writes. The file contents below are the ones the test compares byte-for-byte against
`formatMarkdown(editor.fields, editor.body)` and `formatMarkdown(undefined, reviewer.body)`
from the injected template registry (`editor` carries `description: "editor desc"`,
`mode: primary`, `permissions: []`).

```text
[round3] team template: create kind team with template {"request":{"kind":"team","team":"mine","level":"project","template":"review"},"output":{"level":"project","team":"mine","enabled":false,"id":"team:project:mine","item":"mine"},"show":{"id":"team:project:mine","view":"resolved","kind":"team","level":"project","team":"mine","enabled":false,"members":["editor","reviewer"]},"snapshotTeam":{"level":"project","team":"mine","enabled":false,"agents":["editor","reviewer"]},"memberRows":["team:project:mine","team:project:mine:editor","team:project:mine:reviewer","team:project:mine:special"]}
[round3] team template: member files written {"editorFile":{"path":"<project>/.opencodeplus/teams/mine/editor.md","text":"---\ndescription: \"editor desc\"\nmode: primary\npermissions: []\n---\neditor role"},"reviewerFile":{"path":"<project>/.opencodeplus/teams/mine/reviewer.md","text":"reviewer role"}}
```

## Preserved disabled surface — `create kind:"instruction"`

The ninth kind stays refused and writes nothing (no `AGENTS.md` under the project root or
under `.opencode/`):

```text
[round3] instruction.disabled: create kind instruction is refused and writes nothing {"request":{"kind":"instruction","name":"AGENTS.md","text":"guide"},"error":"instruction.disabled: AGENTS.md handling in OpenCodePlus is disabled for now; native opencode applies AGENTS.md files. Being reworked with the Context catalogue.","filesWritten":{"projectAgentsMd":false,"dotOpencodeAgentsMd":false}}
```

## Notes for the orchestrator

- This file was added after the capture head `2bbcda64a98cbcc06a3641ebb96b170e7fadf024`; it
  is a docs-only change, so `packages/plus/test/tools.test.ts` is unchanged between the
  capture head and the commit that adds this file (the worker Report carries the final-head
  check receipts).
- The instrumented tests keep their original assertions and pass at the capture head
  (`129 pass`, `1 skip`, `0 fail`).
- Item 1–3 outputs only: no live TUI run, no overall acceptance claim, no walkthrough here.