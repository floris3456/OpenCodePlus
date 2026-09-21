# Teams tools round 3 — walkthrough

- **Assembled at:** worktree HEAD `fe908491ae45316e13258bce273af43b61ebcab9` (the
  parent's integrated round-3 branch). Every pasted block repeats the capture head its
  source document records.
- **Plan:** `docs/handoffs/2026-09-22-teams-tools-round3/plan.md`, "Expected end state".
  This document covers items 1–15 and the D4 outcome. Item 16 (`docs/TOOLS.md`) is T7;
  items 17–19 are the review gate and the parent's finish.
- **Status: evidence-assembly checkpoint, not overall completion.** Everything already
  committed on this branch is pasted below. Every final-lab proof the parent still has to
  capture is labelled **PENDING** together with exactly what must be pasted. Pending
  labels are removed only after that evidence exists.
- **Author:** this walkthrough was transcribed by a worker because the orchestrator holds
  the read and live tools but no file-edit capability. The orchestrator owns the live
  captures and the verification.

## Surfaces, and how each block is labelled

| Label | What it is |
| --- | --- |
| REAL LAB (pilotty) | A literal screen capture from the real product driven with `docs/team-v2/scripts/tui-lab.sh` and pilotty in an isolated lab home under `run/tmp-build/`. Never the human's server on 40374, never `~/.config/opencode`, never `run/plus`. |
| IN-PROCESS REAL-HANDLER HARNESS | `bun test` running the real handlers through `packages/plus/test/harness.ts` and the `test/teams/*` harnesses: real files, real git worktrees, real run records, real permission evaluation. No mocks. |
| TUI COMPONENT TEST | `bun test` rendering the real TUI component against a stubbed RPC. It cannot prove a live keypress reaches the product, so it is never the only evidence for a live item. |
| DETERMINISTIC TRANSPORT | `docs/round3-lab.ts`: a credential-free loopback OpenAI-compatible fixture that serves only the model transport. The host's provider resolution, session execution, permission evaluation and tool results stay real. Used only where a capture needs a model to answer. |

Live-capture source heads: baseline lab `r3-main-1ecb-before` ran source
`f0522d90f2537ebcd4a516b50122e951f4503fc6`; the first after lab `r3-main-1ecb-after` ran
source `ff72f8788595221c45bee3297ffe9f8ffd5f9d6d`. Each block below repeats its head.

---

## Item 1 — `create kind:"team"` with `template` produces the template's members

**Source:** `packages/plus/docs/round3-instructions-output.md` §Item 1. Surface:
IN-PROCESS REAL-HANDLER HARNESS. Capture head
`2bbcda64a98cbcc06a3641ebb96b170e7fadf024` (assigned `tools` check at that head: `129
pass`, `1 skip`, `0 fail`).

```text
[round3] team template: create kind team with template {"request":{"kind":"team","team":"mine","level":"project","template":"review"},"output":{"level":"project","team":"mine","enabled":false,"id":"team:project:mine","item":"mine"},"show":{"id":"team:project:mine","view":"resolved","kind":"team","level":"project","team":"mine","enabled":false,"members":["editor","reviewer"]},"snapshotTeam":{"level":"project","team":"mine","enabled":false,"agents":["editor","reviewer"]},"memberRows":["team:project:mine","team:project:mine:editor","team:project:mine:reviewer","team:project:mine:special"]}
[round3] team template: member files written {"editorFile":{"path":"<project>/.opencodeplus/teams/mine/editor.md","text":"---\ndescription: \"editor desc\"\nmode: primary\npermissions: []\n---\neditor role"},"reviewerFile":{"path":"<project>/.opencodeplus/teams/mine/reviewer.md","text":"reviewer role"}}
```

`create kind:"team"` forwards `template` to `api.createTeam`, the same handler the TUI's
templated team create calls. The member files above are compared byte-for-byte against
`formatMarkdown(editor.fields, editor.body)` and `formatMarkdown(undefined,
reviewer.body)` from the injected template registry
(`packages/plus/docs/round3-t1-evidence.md`). **Complete.**

---

## Item 2 — `create kind:"member"` at project, global and Defaults level

**Source:** `packages/plus/docs/round3-instructions-output.md` §Item 2. Surface:
IN-PROCESS REAL-HANDLER HARNESS. Capture head
`2bbcda64a98cbcc06a3641ebb96b170e7fadf024`.

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

The three levels are the project team directory, `globalTeamsPath()` and the Defaults
overlay at `<configDir>/opencodeplus/teams-defaults/`; the padded names are trimmed to
`crew:one`, `gcrew` and `ship`, and a nested member id (`nested/beta`) round-trips.
**Complete.**

---

## Item 3 — every `create` returns the row id `show`, `delete` and `set` accept

**Source:** `packages/plus/docs/round3-instructions-output.md` §Item 3 and §Levels.
Surface: IN-PROCESS REAL-HANDLER HARNESS. Capture head
`2bbcda64a98cbcc06a3641ebb96b170e7fadf024`.

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

The returned `id` is the tree row id for the created row, and `item` names the created
thing inside its row kind (`packages/plus/docs/round3-t1-evidence.md`):

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

`set` on a created row's address is exercised by the suite's own tests, e.g. the
`create model, activate through set, list with item:model and active, then delete` case
(`packages/plus/docs/round3-t2-evidence.md` check `rule-persistence`).

The ninth kind, `instruction`, is **intentionally refused** — the accepted Context pause
while AGENTS.md handling is reworked with the Context catalogue. This document claims
**eight** enabled create kinds, not nine; the refusal below is the expected behaviour and
writes nothing:

```text
[round3] instruction.disabled: create kind instruction is refused and writes nothing {"request":{"kind":"instruction","name":"AGENTS.md","text":"guide"},"error":"instruction.disabled: AGENTS.md handling in OpenCodePlus is disabled for now; native opencode applies AGENTS.md files. Being reworked with the Context catalogue.","filesWritten":{"projectAgentsMd":false,"dotOpencodeAgentsMd":false}}
```

**Complete.**

---

## Item 4 — a user rule carries the refusal message; the dialog and `show` display it

**Source:** `packages/plus/docs/round3-live-evidence.md` (dialog and detail pane) and
`packages/plus/docs/round3-rule-enforcement.md` (in-process). Capture heads: REAL LAB first
after lab `ff72f8788595221c45bee3297ffe9f8ffd5f9d6d`; in-process fix tree
`2723640dfed3c02157f0a0df6efebd3e7b014aef`.

### REAL LAB (pilotty) — before: the rule dialog had no message field

```text
--- Terminal 130x45 | Cursor: (14, 37) ---
Filter:cshell                                                     Project (root)
 ›- Project                                                    ▀
    + Agents                                                      No item details
      + Native
        + build
          + Tools
            + Native
              + shell [on]
                  shell [on]
                  git [on]
                  Git push [on]
                  env [on]
                  git checkout -- [  Rule keywords                                        esc
                  Git commit [on]
                  git rebase [on]    [b]lank for defaults
                  git reset [on]
                  git reset --hard   enter submit
                  npm run [on]
                  Git history rewrites [on]
                  Remove files [on]
                  Recursive force remove [on]
                  Sudo [on]
                  Change permissions or ownership [on]
                  Download with curl or wget [on]
                  SSH or SCP [on]
                  Docker [on]
                  Kubectl [on]
                  JavaScript package install [on]
                  npm publish [on]
                  pip install [on]
                  Kill processes [on]
                  Disk destructive [on]
                  Package scripts [on]
        + plan
          + Tools
            + Native
              + shell [on]
                  shell [on]
                  git [on]
                  Git push [on]
                  env [on]
                  git checkout -- [on]
                  Git commit [on]
                  git rebase [on]
arrows move · left/right expand · enter edit · a add · / filter · ? help · esc back
```

### REAL LAB (pilotty) — after: the optional refusal-message prompt

```text
--- Terminal 130x45 | Cursor: (14, 37) ---
 Instructions                                                     Project (root)
 ›- Project
    + Agents                                                      No item details
    + Teams
  - Global
    + Agents
    + Teams
  - Defaults
    + Agents
    + Teams
                                     Message shown on refusal (optional)                  esc
                                     [f]orce pushes are not allowed here
                                     enter submit
arrows move · left/right expand · enter edit · a add · / filter · ? help · esc back
```

### REAL LAB (pilotty) — after: the saved rule shows `message` in the detail pane

```text
--- Terminal 130x45 | Cursor: (44, 124) ---
Filter:cRound3 refusal                                            Round3 refusal (item)
  - Project                                                    ▀
    + Agents                                                      Project · build · catalogue: agents · perm:shell:round3-refusal
      + Native
        + build                                                   overridden here: Project
          + Tools
            + Native                                              off
              + shell [on]
 ›                Round3 refusal [off]                            tool: shell · rule: round3-refusal · custom
        + plan                                                    patterns: printf round3-denied
          + Tools                                                 keywords: printf round3-denied
            + Native                                              provenance: (curated)
              + shell [on]                                        message: Round3 sentinel command is denied.
                  Round3 refusal [on]
        + Special                                                 0 lines hidden by rules:
          + general
            + Tools                                               Sections:
              + Native
                + shell [on]                                        - Round3 refusal [excluded]
                    Round3 refusal [on]
          + explore                                               Round3 refusal
            + Tools                                               printf round3-denied [excluded]
              + Native
                + shell [on]
                    Round3 refusal [on]                                                                                                     + compaction
            + Tools
              + Native
                + shell [on]
                    Round3 refusal [on]
          + title
            + Tools
              + Native
                + shell [on]
                    Round3 refusal [on]
          + summary
            + Tools
              + Native
                + shell [on]
                    Round3 refusal [on]
  - Global
    + Agents
      + Native
        + build
arrows move · left/right expand · enter edit rule · space toggle · a add · d delete · r reset · / filter · ? help · esc back
                                                                                                                             [_]
```

### IN-PROCESS REAL-HANDLER HARNESS — the message reaches core's own `evaluate`

From the `rules` check after the fix (`packages/plus/docs/round3-rule-enforcement.md`, tree
`2723640dfed3c02157f0a0df6efebd3e7b014aef`; command `bun test test/apply.test.ts
test/rule-message-persistence.test.ts test/rpc.test.ts`, cwd `packages/plus`):

```text
test/apply.test.ts:
(pass) a perm rule off installs a core deny proved by Permission.evaluate (not a local matcher) [82.26ms]
(pass) a user rule's own message reaches Permission.evaluate through apply [0.74ms]
(pass) a Defaults-scope agent's perm row saved off at project level installs the core deny [0.36ms]
...
test/rule-message-persistence.test.ts:
(pass) rule message persistence across boundaries > tool surface: instructions_create, instructions_show, instructions_set > create kind: 'rule' with message, show display, and disk persistence [42.80ms]
(pass) rule message persistence across boundaries > core Permission.evaluate integration > Permission.evaluate receives custom user rule message [0.69ms]
(pass) rule message persistence across boundaries > core Permission.evaluate integration > a built-in agent's project-level row off installs the host deny through the real publish path [26.46ms]

 109 pass
 5 skip
 0 fail
 786 expect() calls
Ran 114 tests across 3 files. [931.00ms]
```

The same after-fix command spans the T2 persistence suite quoted in
`packages/plus/docs/round3-t2-evidence.md`: store round-trip, `ruleOf`, `toRpcRecords`,
`rule.add`/`rule.update`, tool `create`/`show`/`set` with message, and
`Permission.evaluate` receiving it (89 pass, 1 skip, 0 fail).

**PENDING — the model-visible refusal text (DETERMINISTIC TRANSPORT).** Item 4 also
requires that when such a rule denies, the model receives that message. The committed lab
recipe is `packages/plus/docs/round3-lab.md`: the fixture answers `ROUND3_REFUSAL` with a
native `shell` call `printf round3-denied`; a deny rule whose message is exactly
`Round3 sentinel command is denied.` must make the next provider request carry that
sentinel; `GET /proof` must then report `"sentinelSeen": true`. Paste the lab's
model-visible tool result and the `/proof` body here when the parent captures them.

**Complete for the dialog, `show`, disk and core-evaluate halves; model-visible half
pending.**

---

## Item 5 — protected agents are protected at the API boundary

**Source:** `packages/plus/docs/round3-t3-evidence.md`. Surface: IN-PROCESS
REAL-HANDLER HARNESS. Commit `cd02de6d02cf8ee11fe6a720cd6d243966f98a4c` (tree
`7ff03b9a511852b441c065785cc62bd6d5f3cc09`); the document lands one commit later.

One helper, `refuseProtectedForTool(actor, agentId, config)` (`src/index.ts:2329`),
returns the declared error only when the actor is a tool and the addressed owner is in
`protectedAgents`; a missing actor is the TUI. Every write surface is guarded:
`instructions.mutate`, `agent.create/rename/delete`, `team.create` (template members),
`team.addAgent/removeAgent/delete`, `model.add/remove`, `rule.add/remove/update`. The tool
layer keeps its early refusal with the same text. The exact refusal payload is pinned by a
`toEqual` assertion at `test/rpc.test.ts:2280`:

```text
{ type: "agent.protected", message: 'agent.protected: row belongs to protected agent "alpha"', data: { agent: "alpha", reason: 'agent.protected: row belongs to protected agent "alpha"' } }
```

Assigned check `protected` (`bun test test/rpc.test.ts test/tools.test.ts
test/teams-rpc.test.ts`, cwd `packages/plus`) at commit `cd02de6d`, exit code `0`:

```text
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

The same commit's `typecheck` exits `0` (`$ tsgo --noEmit -p tsconfig.test.json`). The
document's guard map and the test-by-test proof (refused tool-actor writes leave files,
records and log lines unchanged; the same calls without an actor succeed) are in
`packages/plus/docs/round3-t3-evidence.md` §"Guard map" and §"What the tests prove".
**Complete; needs no screen.**

---

## Item 6 — the Team tab shows runs (default view: active)

**Source:** `packages/plus/docs/round3-live-evidence.md` (live) and
`packages/plus/docs/round3-t4-evidence.md` (implementation receipts).

### REAL LAB (pilotty) — before: the tab was member-backed

```text
--- Terminal 130x45 | Cursor: (44, 130) ---
   New session                   +
  ┃                                                                                       New session - 2026-09-21T17:00:38.
  ┃  Reply only OK. Do not use tools.                                                     770Z
  ┃
                                                                                          MCP
     Error: Error from provider (Console): OpenCode's free tier can only be used from     • search                    Connected
     within OpenCode
     Build · Muse Spark 1.3 Free · 557ms
  ┃
  ┃  Subagents  Shell  Terminals  Team                                           esc
  ┃
  ┃  No active team — select one with ctrl+x a
  ┃
  ┃  select enter  tabs ←/→
  ┃                                                                                       /…/tui-lab-r3-main-1ecb-b…/proj:master
                                                                                                                                   [_]
```

### REAL LAB (pilotty) — after: the run-backed tab (empty run set)

Source `ff72f8788595221c45bee3297ffe9f8ffd5f9d6d`, lab `r3-main-1ecb-after`:

```text
--- Terminal 130x45 | Cursor: (6, 128) ---
   New session                   +
  ┃                                                                                       New session - 2026-09-21T17:48:09.
  ┃  Round3 parent chat                                                                   121Z
  ┃
                                                                                          MCP
     Error: Error from provider (Console): OpenCode's free tier can only be used from     • search                    Connected [ ]
     within OpenCode
     Build · Muse Spark 1.3 Free · 567ms
  ┃
  ┃  Subagents  Shell  Terminals  Team                                           esc
  ┃
  ┃  No active runs
  ┃
  ┃  move ↑↓  attach ⏎  active ctrl+a  stop|resume ctrl+d  tabs ←/→
  ┃                                                                                       /…/tui-lab-r3-main-1ecb-a…/proj:master
```

### TUI COMPONENT TEST — rows by default, toggle and select

`packages/plus/docs/round3-t4-evidence.md` §4 reports the assigned `team-tab` check green
with `test/active-team.test.tsx` covering: `createActiveTeam registers composer tab and
hints, cleans up on dispose`; `TeamMonitorTab renders active runs by default, toggles to
inactive with ctrl+a, and navigates with select`; the two `ctrl+d` action tests. Rows come
from `team.runs.list` with `(id, role, state, task, head, worktree, lastUsed, sessionID,
parent)`, sorted `lastUsed` descending; the default filter is the active states
(`working`, `idle`, `starting`, `blocked_input`, `stopping`).

**PENDING — a real-lab capture with runs present.** The pilotty capture above shows the
run-backed tab with no runs. Item 6 needs a final-lab capture listing one row per run
with id, role, state and task, newest first, in the default active view. The parent's lab
recipe (two delegated children, one idle and one stopped) is in
`packages/plus/docs/round3-t4-evidence.md` §3 and `packages/plus/docs/round3-delegate.md`.

**Partial — implementation and empty-view capture present; populated default-view capture
pending.**

---

## Item 7 — `ctrl+a` toggles to inactive runs and back

**Source:** `packages/plus/docs/round3-t4-evidence.md` for the implementation; no pilotty
capture exists yet.

Implementation: `ctrl+a` (`composer.team.toggle`, `inactive`/`active`) flips the filter to
the inactive states (`stopped`, `dead`, `superseded`, `reaped`), newest first, and updates
the hint bar, which the after capture above shows as `active ctrl+a`.

**PENDING — the pilotty captures.** Take both views in the final lab: the default active
view and the `ctrl+a` inactive view on the same run set, with the hint bar visible in
each, plus the toggle back.

**Pending live.**

---

## Item 8 — Enter on any row, active or inactive, attaches

**Source:** `packages/plus/docs/round3-t4-evidence.md` (component test); no pilotty capture
yet.

`Enter` runs `composer.team.select`, which navigates to that run's `sessionID` and closes
the composer (the component test above covers the navigation).

**PENDING — the pilotty capture.** In the final lab, select a row and show the TUI
navigating to that run's session; do it once on an active row and once on an inactive row.

**Pending live.**

---

## Item 9 — `ctrl+d` on a selected run: stop, resume, or interrupt-first

**Source:** `packages/plus/docs/round3-t4-evidence.md`,
`packages/plus/docs/round3-lifecycle.md` (in-process); no pilotty capture yet.

Implementation: `ctrl+d` (`composer.team.action`) on an `idle` run stops it; on `stopped`
or `dead` it attaches to the run's session (and `session.execution.started` moves the run
`stopped|dead → working`); on a `working` run it shows the warning that the run must be
interrupted first. The after capture's hint bar names the key: `stop|resume ctrl+d`.

### IN-PROCESS REAL-HANDLER HARNESS — the resume state machine

From `packages/plus/docs/round3-lifecycle.md` after the fix (`lifecycle` check, cwd
`packages/plus`):

```text
test/teams/lifecycle-events.test.ts:
(pass) the subscribed events are the host's canonical execution events plus the deprecated idle alias [0.04ms]
(pass) a turn that ends without finish leaves the run idle and the attempt no_report [4.61ms]
...
(pass) a resumed stopped run consumes the stop intent its stop already satisfied [5.00ms]
(pass) a resumed dead run consumes the stop intent and settles idle after success [4.19ms]
(pass) a resumed run stays usable: its queued followup starts the next attempt after success [5.96ms]
(pass) a stop intent on a starting run is not consumed by execution.started [3.79ms]
(pass) a stop intent on a working run still stops it when its turn succeeds [2.81ms]

 55 pass
 0 fail
 218 expect() calls
Ran 55 tests across 3 files. [676.00ms]
```

`packages/plus/docs/round3-t4-evidence.md` §4 also reports `team.runs.stop` covering
`working → E_BUSY`, `dead → stopped`, `idle → stopped`, terminal preservation and
`run.unknown`, and `test/active-team.test.tsx` covering the three `ctrl+d` outcomes plus
the rejected-stop warning toast.

### Decision D4 outcome

D4 asked for `ctrl+a` active/inactive and `ctrl+d` stop/resume, with `ctrl+s` only as the
fallback if the host's global `app.exit` consumed `ctrl+d` before the tab. **The D4
outcome recorded here: the actual `Ctrl+D` reaches the tab, so the tab keeps `ctrl+d` and
`ctrl+s` is not used.** What is on this branch: `composer.team.action` is registered in
mode `composer` with `priority: 1`, while the global `app.exit` registration lives in mode
`app` (`packages/plus/docs/round3-t4-evidence.md` §2, code inspection of
`packages/tui/src/routes/session/composer/index.tsx` and `Keymap`), and the parent's
baseline lab capture below is the probe that `Ctrl+D` did not leave the client:

```text
--- Terminal 130x45 | Cursor: (39, 5) ---
   New session                   +
  ┃                                                                                       New session - 2026-09-21T17:00:38.
  ┃  Reply only OK. Do not use tools.                                                     770Z
  ┃
                                                                                          MCP
     Error: Error from provider (Console): OpenCode's free tier can only be used from     • search                    Connected
     within OpenCode
     Build · Muse Spark 1.3 Free · 557ms
  ┃
  ┃
  ┃
  ┃  Build · Muse Spark 1.3 Free OpenCode Zen
  ╹▀▀[▀]▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
  /…/tmp-b…/tui-lab-r3-main-1ecb-before/proj:master  shift+tab agents  ctrl+p commands    /…/tui-lab-r3-main-1ecb-b…/proj:master
```

**PENDING — the pilotty captures.** In the final lab, with one working, one idle and one
stopped/dead run: `ctrl+d` on the idle run → stopped; `ctrl+d` on the stopped/dead run →
attach, then a first prompt and the run reading `working`; `ctrl+d` on the working run →
the must-interrupt-first message; the hint bar visible in each. These prove the key
routing at the final head as well as the three outcomes.

**Pending live; D4 decision recorded.**

---

## Item 10 — the tab works in the human's chat and in a delegated child's chat, and never lists another namespace's runs

**Source:** `packages/plus/docs/round3-live-evidence.md` (human chat) and
`packages/plus/docs/round3-t4-evidence.md` (namespace scoping).

The human-chat half is the after capture in item 6: the Team tab inside the parent chat at
`r3-main-1ecb-after`. Namespace scoping is implementation and test: `team.runs.list`
lists entries for this data root (`teamsDataDir()`), and the assigned `team-tab` check's
`teams-rpc.test.ts` case `team.runs.list returns namespace runs, sorted lastUsed desc,
with all 9 fields, and all:false hides superseded/reaped` was green.

**PENDING — the delegated child's chat.** Item 10 needs a final-lab capture of the Team
tab inside a child's chat, created by the real delegate handler
(`packages/plus/docs/round3-delegate.md`), showing it works there and lists only that
namespace's runs.

**Pending live for the child-chat half.**

---

## Item 11 — two Code Mode calls that share one CallID produce two distinct audit lines

**Source:** `packages/plus/docs/round3-t5-evidence.md` §Item 11. Surface: IN-PROCESS
REAL-HANDLER HARNESS (the `test/teams/` harness). Test:
`test/teams/tools.test.ts` › "two Code Mode calls that share one CallID write two
distinct audit lines".

```text
[T5 item 11] shared CallID "call_codemode_shared" →
  {"tool":"team_status","outcome":"allowed","ok":true,"code":null,"actor":"fable-planner","sessionID":"ses_shared_call_id","run":"main-sharedcall0001","seq":2}
  {"tool":"team_delegate","outcome":"asked:deny","ok":false,"code":"E_PERMISSION","actor":"fable-planner","sessionID":"ses_shared_call_id","run":"main-sharedcall0001","seq":3}
```

Both lines carry the right tool, outcome, actor, session, run and code; the sibling that
finished first did not consume the pending call's refusal line. Audit state is per
invocation (a FIFO queue per `(sessionID, messageID, CallID)` plus a request-id map, no
global map). **Complete.**

---

## Item 12 — the first `delegate` in a brand-new data root succeeds

**Source:** `packages/plus/docs/round3-t5-evidence.md` §Item 12. Surface: IN-PROCESS
REAL-HANDLER HARNESS with the real `worktree.create`, the real `gc(root)` and the real
`fs.realpath` boundary; the recording session domain runs the sweep inside `create`, in
exactly the window the host opens the session.

**Failing before** (pre-fix ordering; `team-runtime` check exit 1, 81 pass / 1 fail):

```text
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

**Passing after** (final `team-runtime` check, exit 0):

```text
(pass) the first delegate registers the child run before the host opens its session [48.70ms]

 84 pass
 0 fail
 489 expect() calls
Ran 84 tests across 5 files. [1.85s]
```

The fix registers the `starting` child run (with `sessionID: null` and its
`projectDirectory`) on disk before `ctx.session.create(...)`, so the plugin's startup
orphan sweep finds the worktree claimed; a failed create retires the pre-registered run
`starting → superseded`. **Complete.**

---

## Item 13 — no copied project config in child worktrees; activation resolves upward; plain remove

**Source:** `packages/plus/docs/round3-t5-evidence.md` §Item 13. Surface: IN-PROCESS
REAL-HANDLER HARNESS (real worktrees, real plugin entrypoint, real project files).

Captured from the final `team-runtime` run:

```text
[T5 item 13] child /home/bliss/OpenCodePlus/run/team/development-models/runs/w-1e57ed56bbdb72c5/tmp/plus-team-api-3muoXh/opencode/opencodeplus/teams/worktrees/opencode/implementer/t1d35a-20260921-2030
  child/.opencodeplus/project.json exists: false
  run.projectDirectory: /home/bliss/OpenCodePlus/run/team/development-models/runs/w-1e57ed56bbdb72c5/tmp/plus-team-api-repo-JxIAVx
  activationDirectory(child): /home/bliss/OpenCodePlus/run/team/development-models/runs/w-1e57ed56bbdb72c5/tmp/plus-team-api-repo-JxIAVx
  project.read(activation): {"version":1,"protectedAgents":["muse-implementer"]}
```

```text
[T5 item 13] child plugin activation through the real entrypoint
  location: /home/bliss/OpenCodePlus/run/team/development-models/runs/w-1e57ed56bbdb72c5/tmp/plus-team-api-GOM6T3/opencode/opencodeplus/teams/worktrees/opencode/implementer/t12821-20260921-2030
  team tools installed: 14
  instructions tools installed: 8
  team member agents installed: alpha
```

```text
[T5 item 13] child API resolves the inherited project
  location: /home/bliss/OpenCodePlus/run/team/development-models/runs/w-1e57ed56bbdb72c5/tmp/plus-team-api-EH6faH/opencode/opencodeplus/teams/worktrees/opencode/implementer/t186e7-20260921-2030
  project.status: {"enabled":true,"directory":"/home/bliss/OpenCodePlus/run/team/development-models/runs/w-1e57ed56bbdb72c5/tmp/plus-team-api-repo-eyt2Zi"}
  snapshot revisions: project=0 global=0
  mutate ok: true
```

`worktree.create` writes nothing under `.opencodeplus`; `project.read` walks parent
directories; `delegate` records `projectDirectory`; `activationDirectory` returns it for
the Location; `remove` is a plain `git worktree remove`. The same document's tests cover a
tracked `project.json` arriving with a checkout (the child keeps the committed one), a
bare parent handing the child no file, and the upward walk with an explicit
`enabled: false` opt-out marker. **Complete.**

---

## Item 14 — search keys live in key files with the value redacted

**Source:** `packages/plus/docs/round3-t6-evidence.md` §2. Surface: IN-PROCESS
REAL-HANDLER HARNESS. Command `bun test test/search/register.test.ts` (cwd
`packages/plus`). Disposable sentinel values (`sentinel-exa-<uuid>`,
`sentinel-tavily-<uuid>`) were generated at test runtime, written to key files under
`$OPENCODEPLUS_SEARCH_KEYS_DIR/<name>.key` with mode `0600`, read via `readKey(name)`, and
verified for sentinel equality. Real credentials were never accessed.

```json
{
  "exa": {
    "path": "/home/bliss/OpenCodePlus/run/team/development-models/runs/w-7c7d22401bd4059c/tmp/plus-search-register-iBfHcU/project/search/exa.key",
    "mode": "0600",
    "size": 50,
    "mtime": "2026-09-21T17:09:19.264Z",
    "sentinelMatch": true,
    "value": "[REDACTED (sentinel matched)]"
  },
  "tavily": {
    "path": "/home/bliss/OpenCodePlus/run/team/development-models/runs/w-7c7d22401bd4059c/tmp/plus-search-register-iBfHcU/project/search/tavily.key",
    "mode": "0600",
    "size": 53,
    "mtime": "2026-09-21T17:09:19.264Z",
    "sentinelMatch": true,
    "value": "[REDACTED (sentinel matched)]"
  }
}
```

Mode `0600` is strictly enforced (a `0644` file throws), values are trimmed, a key file
wins over `EXA_API_KEY`/`TAVILY_API_KEY`, the environment is the fallback, and a missing
key returns the existing tool error. The product path is
`<XDG_DATA_HOME>/opencode/opencodeplus/search/{exa,tavily}.key`; `packages/plus/README.md`
documents it for `bin/opencodeplus` (`README.md:375-376`). No key value appears in this
document, a config file, a row, a log or a report. **Complete.**

---

## Item 15 — `instructions.list where:"server:search"` returns the `mcp:search` row and its tool rows

**Source:** `packages/plus/docs/round3-t6-evidence.md` §3. Surface: IN-PROCESS
REAL-HANDLER HARNESS: the registered `instructions_list` tool handler executed with
`{ "where": "server:search" }` against the real instructions tree from `test/harness.ts`
with the search MCP server registered (`registerSearchMcp`) and its tools carrying
`origin: { type: "mcp", name: "search" }`.

Invocation input:

```json
{
  "where": "server:search"
}
```

Captured stdout from the registered handler:

```json
{
  "rows": [
    {
      "id": "item:defaults:alpha:tool:exa_code_search",
      "badges": "on",
      "source": "upstream",
      "tokens": 5
    },
    {
      "id": "section:defaults:alpha:tool:exa_code_search:whole",
      "badges": "on",
      "source": "upstream",
      "tokens": 5
    },
    {
      "id": "item:defaults:alpha:tool:tavily_search",
      "badges": "on",
      "source": "upstream",
      "tokens": 6
    },
    {
      "id": "section:defaults:alpha:tool:tavily_search:whole",
      "badges": "on",
      "source": "upstream",
      "tokens": 6
    },
    {
      "id": "item:defaults::tool:exa_code_search",
      "badges": "on",
      "source": "upstream",
      "tokens": 5
    },
    {
      "id": "section:defaults::tool:exa_code_search:whole",
      "badges": "on",
      "source": "upstream",
      "tokens": 5
    },
    {
      "id": "item:defaults::tool:tavily_search",
      "badges": "on",
      "source": "upstream",
      "tokens": 6
    },
    {
      "id": "section:defaults::tool:tavily_search:whole",
      "badges": "on",
      "source": "upstream",
      "tokens": 6
    },
    {
      "id": "item:defaults::mcp:search",
      "badges": "on",
      "source": "upstream",
      "tokens": 97
    },
    {
      "id": "section:defaults::mcp:search:whole",
      "badges": "on",
      "source": "upstream",
      "tokens": 97
    },
    {
      "id": "item:defaults:opencodeplus-team/:astra-planner:tool:exa_code_search",
      "badges": "on",
      "source": "upstream",
      "tokens": 5
    },
    {
      "id": "section:defaults:opencodeplus-team/:astra-planner:tool:exa_code_search:whole",
      "badges": "on",
      "source": "upstream",
      "tokens": 5
    },
    {
      "id": "item:defaults:opencodeplus-team/:astra-planner:tool:tavily_search",
      "badges": "on",
      "source": "upstream",
      "tokens": 6
    },
    {
      "id": "section:defaults:opencodeplus-team/:astra-planner:tool:tavily_search:whole",
      "badges": "on",
      "source": "upstream",
      "tokens": 6
    },
    {
      "id": "item:defaults:opencodeplus-team/:astra-reviewer:tool:exa_code_search",
      "badges": "on",
      "source": "upstream",
      "tokens": 5
    },
    {
      "id": "section:defaults:opencodeplus-team/:astra-reviewer:tool:exa_code_search:whole",
      "badges": "on",
      "source": "upstream",
      "tokens": 5
    },
    {
      "id": "item:defaults:opencodeplus-team/:astra-reviewer:tool:tavily_search",
      "badges": "on",
      "source": "upstream",
      "tokens": 6
    },
    {
      "id": "section:defaults:opencodeplus-team/:astra-reviewer:tool:tavily_search:whole",
      "badges": "on",
      "source": "upstream",
      "tokens": 6
    },
    {
      "id": "item:defaults:opencodeplus-team/:fable-planner:tool:exa_code_search",
      "badges": "on",
      "source": "upstream",
      "tokens": 5
    },
    {
      "id": "section:defaults:opencodeplus-team/:fable-planner:tool:exa_code_search:whole",
      "badges": "on",
      "source": "upstream",
      "tokens": 5
    },
    {
      "id": "item:defaults:opencodeplus-team/:fable-planner:tool:tavily_search",
      "badges": "on",
      "source": "upstream",
      "tokens": 6
    },
    {
      "id": "section:defaults:opencodeplus-team/:fable-planner:tool:tavily_search:whole",
      "badges": "on",
      "source": "upstream",
      "tokens": 6
    },
    {
      "id": "item:defaults:opencodeplus-team/:gemini-implementer:tool:exa_code_search",
      "badges": "on",
      "source": "upstream",
      "tokens": 5
    },
    {
      "id": "section:defaults:opencodeplus-team/:gemini-implementer:tool:exa_code_search:whole",
      "badges": "on",
      "source": "upstream",
      "tokens": 5
    },
    {
      "id": "item:defaults:opencodeplus-team/:gemini-implementer:tool:tavily_search",
      "badges": "on",
      "source": "upstream",
      "tokens": 6
    },
    {
      "id": "section:defaults:opencodeplus-team/:gemini-implementer:tool:tavily_search:whole",
      "badges": "on",
      "source": "upstream",
      "tokens": 6
    },
    {
      "id": "item:defaults:opencodeplus-team/:muse-implementer:tool:exa_code_search",
      "badges": "on",
      "source": "upstream",
      "tokens": 5
    },
    {
      "id": "section:defaults:opencodeplus-team/:muse-implementer:tool:exa_code_search:whole",
      "badges": "on",
      "source": "upstream",
      "tokens": 5
    },
    {
      "id": "item:defaults:opencodeplus-team/:muse-implementer:tool:tavily_search",
      "badges": "on",
      "source": "upstream",
      "tokens": 6
    },
    {
      "id": "section:defaults:opencodeplus-team/:muse-implementer:tool:tavily_search:whole",
      "badges": "on",
      "source": "upstream",
      "tokens": 6
    },
    {
      "id": "item:defaults:opencodeplus-team/:opus-implementer:tool:exa_code_search",
      "badges": "on",
      "source": "upstream",
      "tokens": 5
    },
    {
      "id": "section:defaults:opencodeplus-team/:opus-implementer:tool:exa_code_search:whole",
      "badges": "on",
      "source": "upstream",
      "tokens": 5
    },
    {
      "id": "item:defaults:opencodeplus-team/:opus-implementer:tool:tavily_search",
      "badges": "on",
      "source": "upstream",
      "tokens": 6
    },
    {
      "id": "section:defaults:opencodeplus-team/:opus-implementer:tool:tavily_search:whole",
      "badges": "on",
      "source": "upstream",
      "tokens": 6
    },
    {
      "id": "item:defaults:opencodeplus-team/:opus-orchestrator:tool:exa_code_search",
      "badges": "on",
      "source": "upstream",
      "tokens": 5
    },
    {
      "id": "section:defaults:opencodeplus-team/:opus-orchestrator:tool:exa_code_search:whole",
      "badges": "on",
      "source": "upstream",
      "tokens": 5
    },
    {
      "id": "item:defaults:opencodeplus-team/:opus-orchestrator:tool:tavily_search",
      "badges": "on",
      "source": "upstream",
      "tokens": 6
    },
    {
      "id": "section:defaults:opencodeplus-team/:opus-orchestrator:tool:tavily_search:whole",
      "badges": "on",
      "source": "upstream",
      "tokens": 6
    },
    {
      "id": "item:defaults:opencodeplus-team/:scout:tool:exa_code_search",
      "badges": "on",
      "source": "upstream",
      "tokens": 5
    },
    {
      "id": "section:defaults:opencodeplus-team/:scout:tool:exa_code_search:whole",
      "badges": "on",
      "source": "upstream",
      "tokens": 5
    }
  ],
  "total": 72
}
```

Verification notes from the same document: the filter matched the MCP server row
`item:defaults::mcp:search` directly (via `address.item.startsWith("mcp:")`) and matched
`exa_code_search` and `tavily_search` for server `search` across the shared defaults,
active agents and team-member defaults; unrelated tools (`tool:bash`) were excluded.
**Complete.**

---

## Pending evidence — exact list for the parent's follow-up captures

| Item | What is missing | Where it goes |
| --- | --- | --- |
| 4 | Model-visible refusal text through the DETERMINISTIC TRANSPORT: the lab's tool result carrying `Round3 sentinel command is denied.` and `/proof` with `"sentinelSeen": true` | Item 4, replace the **PENDING** paragraph |
| 6 | REAL LAB (pilotty) capture of the run-backed Team tab with real runs: one row per run with id, role, state and task, newest first, default active view | Item 6, replace the **PENDING** paragraph |
| 7 | REAL LAB (pilotty) captures of the active view and the `ctrl+a` inactive view on the same run set, hint bar visible, and the toggle back | Item 7, replace the **PENDING** paragraph |
| 8 | REAL LAB (pilotty) capture of Enter attaching to a run's session, once active and once inactive | Item 8, replace the **PENDING** paragraph |
| 9 | REAL LAB (pilotty) captures: `ctrl+d` idle → stopped; `ctrl+d` stopped/dead → attach then the run reads `working` after the first prompt; `ctrl+d` working → must-interrupt-first; hint bar visible | Item 9, replace the **PENDING** paragraph |
| 10 | REAL LAB (pilotty) capture of the Team tab inside a delegated child's chat, listing only that namespace's runs | Item 10, replace the **PENDING** paragraph |

Everything else in items 1–15 is pasted above from committed evidence. This document does
not claim the pending live captures and does not claim overall round-3 completion; the
parent removes each pending label once the evidence exists.

## Decisions recorded by this document

- **D4 outcome:** the actual `Ctrl+D` reaches the tab; the tab keeps `ctrl+d` for
  stop/resume and `ctrl+s` is not used (details and the pending live proof under item 9).
- **`instruction.disabled`:** intentionally refused and an accepted Context pause, not a
  failed create; this document claims eight enabled create kinds, not nine (item 3).