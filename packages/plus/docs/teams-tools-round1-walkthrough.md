# Teams tools round 1 — walkthrough

- **Branch HEAD when this document was written:** `062a102ea2d7bf5926fc76609dc2b376e6449dfa`
- **Round base:** `ocp-main` before T1 (see `git log --oneline` on this branch)
- **Plan:** `docs/handoffs/2026-09-21-teams-tools-round1/plan.md`, section "Expected end state"

## How the evidence below was produced

Two surfaces, and every section says which it used.

1. **The real product**, driven with pilotty through
   `docs/team-v2/scripts/tui-lab.sh` in a throwaway XDG home under
   `run/tmp-build/tui-lab-r1`: its own config, its own port, its own two-commit
   git project. Nothing touches the human's server on 40374, `~/.config/opencode`,
   `run/plus`, `bin/`, `agents/`, `scripts/team` or `releases/`. Screens are
   pasted as pilotty captured them; `/api/agent` and `instructions.snapshot` are
   read over that lab server's own HTTP port with its own credential.
2. **`packages/plus/test/teams/walkthrough.test.ts`**, committed on this branch
   and re-runnable with `cd packages/plus && bun test test/teams/walkthrough.test.ts`.
   It drives the registered team and instructions tools through the same seam an
   agent calls, over real git repositories and worktrees, a real team data root,
   real run records, briefs, reports, check receipts and inbox files. Its own
   header states the two doubles:

```
Round-1 team walkthrough evidence. Everything below is produced by
packages/plus/test/teams/walkthrough.test.ts against real machinery:
real git repositories and worktrees, a real team data root under a temp
XDG_DATA_HOME, real run records, briefs, reports, check receipts, inbox
files and instructions rows. Two things are doubles: the host session
domain is the recording double the tests use (a plugin cannot spawn
model-backed sessions in-process), and host session.idle /
session.execution.* events are delivered by calling the exported
lifecycle handlers directly. Run ids, ULIDs, timestamps and temp paths
vary between runs.
```

Items **20a, 20c and 20i** are proven in the real product (surface 1). Items
**20b, 20d–20h and 21** are proven with surface 2, as the plan's verification
recipe permits ("Team-tool proofs that need no screen may use the test harnesses
under `packages/plus/test/teams/` in-process instead — say which you used"), and
20b and 20c are *also* shown in the product.

## What live testing changed

Driving the real TUI found two defects that no unit test could see, and both are
fixed on this branch with regression tests that fail on the commit before them:

| Defect | Symptom in the product | Fix |
| --- | --- | --- |
| `teamPolicyRows` resolved members against unfiltered discovery, so once Plus installed a team's members the host echoed them back as defaults-scope agents and `visibleAgents` shadowed every member | `/api/agent` showed a member with **no** native denies and **no** ceiling; `instructions.snapshot` had **zero** `:team-role`/`:role-ceiling` rows; the Instructions screen showed no Policy group | `fix(plus): resolve team policy rows from the filtered publish view` (`48b6af1`) |
| `Plus.SnapshotItem` carried neither `policy` nor `runID`, so a policy row arrived at the TUI and at `instructions_list`/`show` as an ordinary rule row | rows whose action has no tool row (`external_directory`, `question`, `subagent`, `task`, per-run `edit`) were invisible; `where:"run:<id>"` never matched | `fix(plus): carry policy and runID across the snapshot boundary` (`e9615a8`) |

A third gap is real, is **not** fixed here, and is stated plainly under 20i.

---

## A–D: items 1–19

| # | Claim | Where it is proven |
| --- | --- | --- |
| 1 | Two catalogues under every level; a team member inherits Teams, not Agents | **20a** (product); detail pane reads `catalogue: teams`; `test/catalogues.test.ts`, `test/tree.test.ts` |
| 2 | Pre-split customizations reach both catalogues, one logged revision | `test/catalogues.test.ts` — "a pre-split store migrates on load, persists once, and stays put afterwards" and "the plugin's first load migrates the catalogues and logs one migrate.catalogues revision". The lab home starts empty, so its log has nothing to migrate (`instructions.log` there shows only the `team.setEnabled` line) |
| 3 | Ceiling, native denies and per-run edit scope are rows: listable, showable, logged, overridable | **20b** (rows through `instructions_list`/`instructions_show`, and the Policy group in the product), **20d** step 3 (the run-scoped row), `test/teams/permissions.test.ts` (including a project-level record overriding a shipped answer) |
| 4 | A non-member sees no team tool; a member sees exactly its ceiling | **20c**, both surfaces |
| 5 | The namespace advertises only what works; ten names are gone | `test/teams/tools.test.ts` — "the team namespace advertises nothing it cannot do", "no registered team tool returns E_NOT_IMPLEMENTED"; `test/builtin-teams.test.ts` — "no built-in prompt names a tool that left the namespace". `diff` is implemented (D4); `review` is removed |
| 6 | Search is an MCP concern, narrowed per role | `perm:search:team-tavily` ships off for implementers, reviewers and scouts and resolves to `search_tavily_* * deny` — see **20b** and **20c**. Delivery needs a `search` MCP server in user config, which Plus cannot ship; noted for review |
| 7 | A planner/orchestrator chat gets a root run automatically; no `prepare` | **20i** (real chat: `team_status` from a fresh Fable-Planner chat answers with its own `main-…` run), **20d** step 1, `test/teams/tools.test.ts` |
| 8 | `stop` and `supersede` are the only halts, both idempotent | `test/teams/api-lifecycle.test.ts` — stop on idle/working/already-stopped/dead/ready, supersede on idle/dirty/working/already-superseded |
| 9 | No approval flag in any input; approval is an `ask` row; children never see `ask` | No `authorization` field survives (`test/teams/schema.test.ts` is the single schema source); the planner `ask` row is live (**20i**); `test/teams/roles.test.ts` — "effective permission at /api/agent for a child session is never ask". The fourth clause, "honoured by every team tool", is **not** true today — see 20i |
| 10 | One schema per tool, validated once; refusals carry `accepted:` | **20h** (two refusals), **20i** (a third, in a real chat), `test/teams/tools.test.ts` |
| 11 | `get_context` has no `conventions` | **21** — the root context has no such key; `test/teams/api.test.ts` |
| 12 | A turn that ends without `finish` is `idle`/`no_report` | **20e** |
| 13 | A followup queued while working is delivered on idle as a new attempt | **20f** |
| 14 | One notification per settled attempt, and only one | **20d** step 5 (the `child.settled` inbox item) and the run record's `"notified": true` on attempt 1 |
| 15 | `wait` says what it acknowledged; `status` agrees | **20d** step 6 — `acknowledged: ["w-…"]` and `acked: {attempt: 1, …}` |
| 16 | A landed child's worktree is removed; branch, records and receipts stay | **20d** step 7 |
| 17 | Stale stopped/superseded runs are reaped by the system; dirty stopped is skipped | **20g**; `test/teams/gc.test.ts` for the dirty-skip, the `--force` superseded case, and (after the review) a removal that fails not being reported reaped |
| 18 | An unclaimed worktree **under the team data root** is removed by the same sweep | **20g** (`orphansRemoved`); `test/teams/worktree.test.ts` — "orphans never reports a worktree outside the team's own root" |
| 19 | `list` and `status` report worktree presence | `test/teams/tools.test.ts` — "team_status reports each run's worktree state through the registered tool", and `test/teams/api-query.test.ts` for `list`. The 20d capture below predates the fix the review forced; see "What the independent review changed" |

---

## 20a — the Instructions screen shows both catalogues at the Defaults root

Real product. `tui-lab.sh up <worktree> r1`, then `team.setEnabled` for
`opencodeplus-team` at Defaults, then `ctrl+p` → `instructions` → Enter, then
expand **Defaults › Agents** and **Defaults › Teams**:

```
 Instructions                                                     Agents (group)
  - Project
    + Agents                                                      No item details
    + Teams
  - Global
    + Agents
    + Teams
  - Defaults
 ›  - Agents
      + Native
      + Plus
      + User
      + Models
      + Tools
      + Base
      + Skills
      + System
      + MCP
    - Teams
      + opencodeplus-team [on]
      + review [off]
      + starter [off]
      + Models
      + Tools
      + Base
      + Skills
      + System
      + MCP
arrows move · left/right expand · enter edit · a add · / filter · ? help · esc back
```

Each catalogue owns its own six inventory groups, in order, beside its own
agents or teams. The same two roots appear under Project and Global.

---

## 20b — a team member's ceiling and native denies are instructions rows

### In the product

`Defaults › Teams › opencodeplus-team › fable-planner › Tools › Policy`:

```
 Instructions                                                     Policy (group)
  - Defaults
    - Teams
      - opencodeplus-team [on]
        - fable-planner
          + Models
          - Tools
            + Native
            + OpenCodePlus
            + MCP
 ›          - Policy
                Read keys, env files and credentials [off]
                Start a subagent [off]
                Start a task [off]
                Ask the user a question [on]
                Shell commands [off]
                Directories outside the worktree [on]
                team_integrate [off]
                team_checkpoint [off]
                team_set_checks [off]
                team_check [off]
                team_delegate [on]
          + Base
```

Selecting `team_delegate [on]` — an ordinary row with an address, a state and a
provenance:

```
 Instructions                                                     team_delegate (item)
                                                                  Defaults · fable-planner · catalogue: teams · perm:
                                                                  team_delegate:team-role
                                                                  inherited from: upstream
                                                                  on
                                                                  tool: team_delegate · rule: team-role
                                                                  patterns: *
                                                                  keywords: (none)
                                                                  provenance: (curated)
                                                                  Sections:
                                                                    - team_delegate [included]
                                                                  team_delegate
                                                                  *
 ›              team_delegate [on]
```

Before the first fix this Policy group did not exist at all: `fable-planner`
expanded to `Models · Tools · Base · Skills · System`, and a filter for
`Directories outside` returned "No instructions found".

### Through `instructions_list` and `instructions_show`

The member's rows for `gemini-implementer`, queried with
`where: "item:perm agent:gemini-implementer"`. `total: 30` is fifteen rows at two
tree addresses each — the member's stand-alone Defaults address and its address
under the Defaults team — not thirty rules. The tail of the list, verbatim:

```
      "id": "item:defaults:opencodeplus-team/:gemini-implementer:perm:team_delegate:role-ceiling",
      "label": "team_delegate",
      "badges": "off",
      "source": "upstream"
    },
    {
      "id": "item:defaults:opencodeplus-team/:gemini-implementer:perm:team_followup:role-ceiling",
      "label": "team_followup",
      "badges": "off",
      "source": "upstream"
    },
    {
      "id": "item:defaults:opencodeplus-team/:gemini-implementer:perm:team_integrate:role-ceiling",
      "label": "team_integrate",
      "badges": "off",
      "source": "upstream"
    },
    {
      "id": "item:defaults:opencodeplus-team/:gemini-implementer:perm:team_set_checks:role-ceiling",
      "label": "team_set_checks",
      "badges": "off",
      "source": "upstream"
    },
    {
      "id": "item:defaults:opencodeplus-team/:gemini-implementer:perm:team_supersede:role-ceiling",
      "label": "team_supersede",
      "badges": "off",
      "source": "upstream"
    },
    {
      "id": "item:defaults:opencodeplus-team/:gemini-implementer:perm:team_stop:role-ceiling",
      "label": "team_stop",
      "badges": "off",
      "source": "upstream"
    },
    {
      "id": "item:defaults:opencodeplus-team/:gemini-implementer:perm:team_wait:role-ceiling",
      "label": "team_wait",
      "badges": "off",
      "source": "upstream"
    },
    {
      "id": "item:defaults:opencodeplus-team/:gemini-implementer:perm:team_list:role-ceiling",
      "label": "team_list",
      "badges": "off",
      "source": "upstream"
    },
    {
      "id": "item:defaults:opencodeplus-team/:gemini-implementer:perm:search:team-tavily",
      "label": "Tavily search (search MCP)",
      "badges": "off",
      "source": "upstream"
    }
  ],
  "total": 30
}

$ instructions_show {"id":"item:defaults:gemini-implementer:perm:team_delegate:role-ceiling"}
{
  "id": "item:defaults:gemini-implementer:perm:team_delegate:role-ceiling",
  "view": "resolved",
  "tool": "team_delegate",
  "rule": "role-ceiling",
  "label": "team_delegate",
  "patterns": [
    "*"
  ],
  "keywords": [],
  "provenance": [],
  "custom": false,
  "enabled": false,
  "source": "upstream",
  "scrub": {
    "hidden": 0,
    "preview": []
  }
}
```

The fifteen rows the window above cuts are the same shape at
`item:defaults:gemini-implementer:…`: six native denies
(`perm:shell:team-role`, `perm:question:team-role`, `perm:subagent:team-role`,
`perm:task:team-role`, `perm:read:team-role`,
`perm:external_directory:team-role`), eight out-of-ceiling
`perm:team_<tool>:role-ceiling` rows, and `perm:search:team-tavily`. The program
asserts every one of them by id, asserts that **no** row exists for a tool
inside the implementer ceiling, and fails if any is missing —
`test/teams/walkthrough.test.ts`, section `[20b]`. `team_wait` and `team_list`
are Code Mode tools with no tool row to hang under: they reach a caller only
through the Policy group, which is exactly what the `SnapshotItem.policy` fix
restored.

A capture limit worth stating plainly: a check receipt keeps the tail of a long
run, so the first ~150 lines of this section (the header, the banner, the
`instructions_list` call line and the first 21 rows) are not pasted above.
Re-running the program prints them; the assertions that cover them are in the
committed file.

---

## 20c — a `build` catalog with zero team tools next to a `gemini-implementer` catalog with exactly its ceiling

### In the product

`GET /api/agent` on the lab server, filtered to the rules that matter (the lab's
own port and credential; `build` is the host's default agent, the others are the
shipped team roles):

```
$ curl -s -u opencode:<pw> -H "x-opencode-directory: $T/proj" http://127.0.0.1:$PORT/api/agent   # AFTER the fix (48b6af1)
--- build: 11 rules
    {"action": "external_directory", "resource": "*", "effect": "ask"}
    {"action": "question", "resource": "*", "effect": "allow"}
    {"action": "team.*", "resource": "*", "effect": "deny"}
--- gemini-implementer: 26 rules
    {"action": "read", "resource": "*.key", "effect": "deny"}
    {"action": "read", "resource": "*.env*", "effect": "deny"}
    {"action": "read", "resource": "*/auth.json", "effect": "deny"}
    {"action": "subagent", "resource": "*", "effect": "deny"}
    {"action": "task", "resource": "*", "effect": "deny"}
    {"action": "question", "resource": "*", "effect": "deny"}
    {"action": "shell", "resource": "*", "effect": "deny"}
    {"action": "external_directory", "resource": "*", "effect": "deny"}
    {"action": "team.delegate", "resource": "*", "effect": "deny"}
    {"action": "team.followup", "resource": "*", "effect": "deny"}
    {"action": "team.integrate", "resource": "*", "effect": "deny"}
    {"action": "team.set_checks", "resource": "*", "effect": "deny"}
    {"action": "team.supersede", "resource": "*", "effect": "deny"}
    {"action": "team.stop", "resource": "*", "effect": "deny"}
    {"action": "team.wait", "resource": "*", "effect": "deny"}
    {"action": "team.list", "resource": "*", "effect": "deny"}
    {"action": "search_tavily_*", "resource": "*", "effect": "deny"}
--- fable-planner: 22 rules
    {"action": "shell", "resource": "*", "effect": "deny"}
    {"action": "question", "resource": "*", "effect": "allow"}
    {"action": "external_directory", "resource": "*", "effect": "allow"}
    {"action": "team.integrate", "resource": "*", "effect": "deny"}
    {"action": "team.checkpoint", "resource": "*", "effect": "deny"}
    {"action": "team.set_checks", "resource": "*", "effect": "deny"}
    {"action": "team.check", "resource": "*", "effect": "deny"}
    {"action": "team.delegate", "resource": "*", "effect": "ask"}
--- sol-orchestrator: 18 rules
    {"action": "shell", "resource": "*", "effect": "allow"}
    {"action": "external_directory", "resource": "*", "effect": "allow"}
    {"action": "question", "resource": "*", "effect": "deny"}
    {"action": "team.checkpoint", "resource": "*", "effect": "deny"}
```

`build` carries `team.* * deny`, which is what makes core drop every team tool
from its catalog. A member carries no `team.*` wildcard: it carries one deny per
tool **outside** its ceiling, so what remains is exactly the ceiling. The
planner's `team.delegate` is `ask` (D6) and the orchestrator's `team.checkpoint`
is denied (D7). Before the first fix, the three member rows here were empty.

### Through the real tool catalog

The same question asked of core's own tool registry, which is what an agent
actually sees:

```
=== [20c] a non-member catalog has zero team tools; a member's is exactly its ceiling ===

$ tool catalog for agent build (team entries)
{
  "native": [],
  "codemode": []
}

$ tool catalog for agent gemini-implementer (team entries)
{
  "native": [
    "team_checkpoint",
    "team_finish"
  ],
  "codemode": [
    "team.check",
    "team.diff",
    "team.get_context",
    "team.status"
  ]
}

```

---

## 20d — root bootstrap → delegate → get_context → checkpoint → finish → notification → wait → integrate → worktree gone

One continuous cycle, every step through the tool seam. Verbatim:

```
=== [20d] root bootstrap → delegate → get_context → checkpoint → finish → notification → wait → integrate → worktree gone ===

$ team_status {}
[
  {
    "run": "main-bee78832fde7b2b8",
    "role": "sol-orchestrator",
    "state": "working",
    "attempt": 1,
    "attemptState": "streaming",
    "task": null,
    "taskState": null,
    "head": "425c37dc6c562acbe09fdc9b4ac06128ac6825e0",
    "base": "425c37dc6c562acbe09fdc9b4ac06128ac6825e0",
    "dirty": false,
    "branch": "main",
    "checks": [],
    "report": null,
    "children": [],
    "parent": null,
    "acked": null,
    "budget": {
      "turnsUsed": 1,
      "turns": 0,
      "tokensUsed": 0,
      "tokens": 0,
      "overBy": {
        "turns": 0,
        "tokens": 0,
        "wallMs": 0
      },
      "exhausted": false
    }
  }
]

$ team_status {}
[
  {
    "run": "main-bee78832fde7b2b8",
    "role": "sol-orchestrator",
    "state": "working",
    "attempt": 1,
    "attemptState": "streaming",
    "task": null,
    "taskState": null,
    "head": "425c37dc6c562acbe09fdc9b4ac06128ac6825e0",
    "base": "425c37dc6c562acbe09fdc9b4ac06128ac6825e0",
    "dirty": false,
    "branch": "main",
    "checks": [],
    "report": null,
    "children": [],
    "parent": null,
    "acked": null,
    "budget": {
      "turnsUsed": 1,
      "turns": 0,
      "tokensUsed": 0,
      "tokens": 0,
      "overBy": {
        "turns": 0,
        "tokens": 0,
        "wallMs": 0
      },
      "exhausted": false
    }
  }
]

$ team_delegate {"requestID":"ev-1","role":"gemini-implementer","objective":"Add docs/note.md naming this run, commit it, and leave the note check green.","deliverable":{"kind":"commit"},"scope":{"paths":["docs/note.md"]},"checks":[{"id":"note","argv":["bun","test","note.test.ts"]}]}
{
  "run": "w-020a76e89fdeda2f",
  "session": "ses_child_1",
  "task": "T1",
  "state": "starting",
  "directory": "/home/bliss/OpenCodePlus/run/team/development-models/runs/w-8327252ad4d72db3/tmp/plus-team-walkthrough-w8503U/opencode/opencodeplus/teams/worktrees/repo/implementer/t1020a-20260921-1129",
  "branch": "team/implementer/t1020a-20260921-1129",
  "base": "425c37dc6c562acbe09fdc9b4ac06128ac6825e0",
  "briefPath": "/home/bliss/OpenCodePlus/run/team/development-models/runs/w-8327252ad4d72db3/tmp/plus-team-walkthrough-w8503U/opencode/opencodeplus/teams/runs/w-020a76e89fdeda2f/brief.md",
  "budget": {
    "turns": 60,
    "tokens": 1500000,
    "wallMs": 3600000
  }
}

$ instructions_list {"where":"run:w-020a76e89fdeda2f","fields":["id","label","text","badges","source"]}
{
  "rows": [
    {
      "id": "item:defaults:gemini-implementer:perm:edit:run:w-020a76e89fdeda2f",
      "label": "Edit scope for run w-020a76e89fdeda2f",
      "text": "Edit scope for run w-020a76e89fdeda2f\nOnly scope.paths [docs/note.md] are editable. Version-control and paused-tool state is never editable, even inside scope.paths. Report anything else in needs=[{kind:\"path\"...}].\n*\ndocs/note.md\n.git/**\n.opencodeplus/**",
      "badges": "on",
      "source": "upstream"
    },
    {
      "id": "item:defaults:opencodeplus-team/:gemini-implementer:perm:edit:run:w-020a76e89fdeda2f",
      "label": "Edit scope for run w-020a76e89fdeda2f",
      "text": "Edit scope for run w-020a76e89fdeda2f\nOnly scope.paths [docs/note.md] are editable. Version-control and paused-tool state is never editable, even inside scope.paths. Report anything else in needs=[{kind:\"path\"...}].\n*\ndocs/note.md\n.git/**\n.opencodeplus/**",
      "badges": "on",
      "source": "upstream"
    }
  ],
  "total": 2
}

$ instructions_show {"id":"item:defaults:gemini-implementer:perm:edit:run:w-020a76e89fdeda2f"}
{
  "id": "item:defaults:gemini-implementer:perm:edit:run:w-020a76e89fdeda2f",
  "view": "resolved",
  "tool": "edit",
  "rule": "run:w-020a76e89fdeda2f",
  "label": "Edit scope for run w-020a76e89fdeda2f",
  "patterns": [
    "*",
    "docs/note.md",
    ".git/**",
    ".opencodeplus/**"
  ],
  "keywords": [],
  "provenance": [],
  "custom": false,
  "enabled": true,
  "source": "upstream",
  "scrub": {
    "hidden": 0,
    "preview": []
  }
}

$ team_get_context {}
{
  "run": "w-020a76e89fdeda2f",
  "role": "gemini-implementer",
  "task": "T1",
  "directory": "/home/bliss/OpenCodePlus/run/team/development-models/runs/w-8327252ad4d72db3/tmp/plus-team-walkthrough-w8503U/opencode/opencodeplus/teams/worktrees/repo/implementer/t1020a-20260921-1129",
  "branch": "team/implementer/t1020a-20260921-1129",
  "base": "425c37dc6c562acbe09fdc9b4ac06128ac6825e0",
  "head": "425c37dc6c562acbe09fdc9b4ac06128ac6825e0",
  "brief": {
    "requestID": "ev-1",
    "role": "gemini-implementer",
    "objective": "Add docs/note.md naming this run, commit it, and leave the note check green.",
    "deliverable": {
      "kind": "commit"
    },
    "scope": {
      "paths": [
        "docs/note.md"
      ],
      "forbidden": []
    },
    "context": {
      "interfaces": [],
      "decisions": []
    },
    "checks": [
      {
        "id": "note",
        "argv": [
          "bun",
          "test",
          "note.test.ts"
        ]
      }
    ],
    "effort": "medium"
  },
  "briefPath": "/home/bliss/OpenCodePlus/run/team/development-models/runs/w-8327252ad4d72db3/tmp/plus-team-walkthrough-w8503U/opencode/opencodeplus/teams/runs/w-020a76e89fdeda2f/brief.md",
  "scope": {
    "paths": [
      "docs/note.md"
    ],
    "forbidden": []
  },
  "checks": [
    {
      "id": "note",
      "argv": [
        "bun",
        "test",
        "note.test.ts"
      ],
      "cwd": "",
      "lastPassedHead": null
    }
  ],
  "interfaces": [],
  "decisions": [],
  "siblings": [],
  "budget": {
    "turns": 60,
    "tokens": 1500000,
    "wallMs": 3600000,
    "used": {
      "turns": 1
    }
  },
  "inbox": []
}

$ team_checkpoint {"expectedHead":"425c37dc6c562acbe09fdc9b4ac06128ac6825e0","files":["docs/note.md"],"message":"docs: add the walkthrough note"}
{
  "head": "05ceea5f5dc15b12386b40869a7a4d95004879ff",
  "committed": true,
  "sha": "05ceea5f5dc15b12386b40869a7a4d95004879ff",
  "subject": "docs: add the walkthrough note"
}

$ team_finish {"status":"done","summary":"Added docs/note.md and left the note check green."}
{
  "run": "w-020a76e89fdeda2f",
  "attempt": 1,
  "status": "done",
  "summary": "Added docs/note.md and left the note check green.",
  "concerns": [],
  "needs": [],
  "findings": [],
  "deferred": [],
  "commits": [
    {
      "sha": "05ceea5f5dc15b12386b40869a7a4d95004879ff",
      "subject": "docs: add the walkthrough note"
    }
  ],
  "checks": [
    {
      "id": "note",
      "passed": true,
      "head": "05ceea5f5dc15b12386b40869a7a4d95004879ff",
      "at": 1789982957310
    }
  ],
  "head": "05ceea5f5dc15b12386b40869a7a4d95004879ff",
  "base": "425c37dc6c562acbe09fdc9b4ac06128ac6825e0",
  "dirty": false,
  "dirtyFiles": [],
  "reportPath": "/home/bliss/OpenCodePlus/run/team/development-models/runs/w-8327252ad4d72db3/tmp/plus-team-walkthrough-w8503U/opencode/opencodeplus/teams/runs/w-020a76e89fdeda2f/report-1.md",
  "at": "2026-09-21T09:29:17.314Z"
}

$ cat /home/bliss/OpenCodePlus/run/team/development-models/runs/w-8327252ad4d72db3/tmp/plus-team-walkthrough-w8503U/opencode/opencodeplus/teams/runs/main-bee78832fde7b2b8/inbox/01M31MRQR7E4680Q3F19C2D39F.json
{
  "id": "01M31MRQR7E4680Q3F19C2D39F",
  "kind": "child.settled",
  "from": "w-020a76e89fdeda2f",
  "text": "[team] w-020a76e89fdeda2f (gemini-implementer, T1) settled: done — attempt 1 succeeded.\nsummary: Added docs/note.md and left the note check green.\nreport: /home/bliss/OpenCodePlus/run/team/development-models/runs/w-8327252ad4d72db3/tmp/plus-team-walkthrough-w8503U/opencode/opencodeplus/teams/runs/w-020a76e89fdeda2f/report-1.md\nnext: read the report, then integrate or followup",
  "at": 1789982957319
}

$ team_wait {"runs":["w-020a76e89fdeda2f"],"timeoutMs":10000}
{
  "settled": [
    {
      "run": "w-020a76e89fdeda2f",
      "attemptState": "succeeded",
      "report": {
        "status": "done",
        "summary": "Added docs/note.md and left the note check green.",
        "path": "/home/bliss/OpenCodePlus/run/team/development-models/runs/w-8327252ad4d72db3/tmp/plus-team-walkthrough-w8503U/opencode/opencodeplus/teams/runs/w-020a76e89fdeda2f/report-1.json"
      }
    }
  ],
  "acknowledged": [
    "w-020a76e89fdeda2f"
  ],
  "timedOut": false,
  "stillOpen": [],
  "overBudget": []
}

$ team_status {"runs":["w-020a76e89fdeda2f"]}
[
  {
    "run": "w-020a76e89fdeda2f",
    "role": "gemini-implementer",
    "state": "idle",
    "attempt": 1,
    "attemptState": "succeeded",
    "task": "T1",
    "taskState": "open",
    "head": "05ceea5f5dc15b12386b40869a7a4d95004879ff",
    "base": "425c37dc6c562acbe09fdc9b4ac06128ac6825e0",
    "dirty": false,
    "branch": "team/implementer/t1020a-20260921-1129",
    "checks": [
      {
        "id": "note",
        "passed": true,
        "atHead": true
      }
    ],
    "report": {
      "status": "done",
      "summary": "Added docs/note.md and left the note check green.",
      "needs": [],
      "path": "/home/bliss/OpenCodePlus/run/team/development-models/runs/w-8327252ad4d72db3/tmp/plus-team-walkthrough-w8503U/opencode/opencodeplus/teams/runs/w-020a76e89fdeda2f/report-1.md"
    },
    "children": [],
    "parent": "main-bee78832fde7b2b8",
    "acked": {
      "attempt": 1,
      "at": "2026-09-21T09:29:17.321Z"
    },
    "budget": {
      "turnsUsed": 1,
      "turns": 60,
      "tokensUsed": 0,
      "tokens": 1500000,
      "overBy": {
        "turns": 0,
        "tokens": 0,
        "wallMs": 0
      },
      "exhausted": false
    }
  }
]

$ team_wait {"runs":["w-020a76e89fdeda2f"],"timeoutMs":10000}
{
  "settled": [
    {
      "run": "w-020a76e89fdeda2f",
      "attemptState": "succeeded",
      "report": {
        "status": "done",
        "summary": "Added docs/note.md and left the note check green.",
        "path": "/home/bliss/OpenCodePlus/run/team/development-models/runs/w-8327252ad4d72db3/tmp/plus-team-walkthrough-w8503U/opencode/opencodeplus/teams/runs/w-020a76e89fdeda2f/report-1.json"
      }
    }
  ],
  "acknowledged": [
    "w-020a76e89fdeda2f"
  ],
  "timedOut": false,
  "stillOpen": [],
  "overBudget": []
}

$ team_status {"runs":["w-020a76e89fdeda2f"]}
[
  {
    "run": "w-020a76e89fdeda2f",
    "role": "gemini-implementer",
    "state": "idle",
    "attempt": 1,
    "attemptState": "succeeded",
    "task": "T1",
    "taskState": "open",
    "head": "05ceea5f5dc15b12386b40869a7a4d95004879ff",
    "base": "425c37dc6c562acbe09fdc9b4ac06128ac6825e0",
    "dirty": false,
    "branch": "team/implementer/t1020a-20260921-1129",
    "checks": [
      {
        "id": "note",
        "passed": true,
        "atHead": true
      }
    ],
    "report": {
      "status": "done",
      "summary": "Added docs/note.md and left the note check green.",
      "needs": [],
      "path": "/home/bliss/OpenCodePlus/run/team/development-models/runs/w-8327252ad4d72db3/tmp/plus-team-walkthrough-w8503U/opencode/opencodeplus/teams/runs/w-020a76e89fdeda2f/report-1.md"
    },
    "children": [],
    "parent": "main-bee78832fde7b2b8",
    "acked": {
      "attempt": 1,
      "at": "2026-09-21T09:29:17.326Z"
    },
    "budget": {
      "turnsUsed": 1,
      "turns": 60,
      "tokensUsed": 0,
      "tokens": 1500000,
      "overBy": {
        "turns": 0,
        "tokens": 0,
        "wallMs": 0
      },
      "exhausted": false
    }
  }
]

$ team_integrate {"run":"w-020a76e89fdeda2f","expectedParentHead":"425c37dc6c562acbe09fdc9b4ac06128ac6825e0"}
{
  "entry": "01M31MRQRQM45DRG4RR2W989QX",
  "state": "landed",
  "head": "05ceea5f5dc15b12386b40869a7a4d95004879ff"
}

$ git worktree list
/home/bliss/OpenCodePlus/run/team/development-models/runs/w-8327252ad4d72db3/tmp/plus-walkthrough-repo-O371Om/repo  05ceea5 [main]

$ test -d /home/bliss/OpenCodePlus/run/team/development-models/runs/w-8327252ad4d72db3/tmp/plus-team-walkthrough-w8503U/opencode/opencodeplus/teams/worktrees/repo/implementer/t1020a-20260921-1129
false

$ git rev-parse team/implementer/t1020a-20260921-1129
05ceea5f5dc15b12386b40869a7a4d95004879ff

$ cat /home/bliss/OpenCodePlus/run/team/development-models/runs/w-8327252ad4d72db3/tmp/plus-team-walkthrough-w8503U/opencode/opencodeplus/teams/runs/w-020a76e89fdeda2f/run.json
{
  "id": "w-020a76e89fdeda2f",
  "role": "gemini-implementer",
  "kind": "w",
  "repo": "repo",
  "repoKey": "repo",
  "directory": "/home/bliss/OpenCodePlus/run/team/development-models/runs/w-8327252ad4d72db3/tmp/plus-team-walkthrough-w8503U/opencode/opencodeplus/teams/worktrees/repo/implementer/t1020a-20260921-1129",
  "paths": [
    "docs/note.md"
  ],
  "branch": "team/implementer/t1020a-20260921-1129",
  "base": "425c37dc6c562acbe09fdc9b4ac06128ac6825e0",
  "head": "05ceea5f5dc15b12386b40869a7a4d95004879ff",
  "state": "idle",
  "attempts": [
    {
      "n": 1,
      "state": "succeeded",
      "startedAt": "2026-09-21T09:29:17.239Z",
      "trigger": "delegate",
      "endedAt": "2026-09-21T09:29:17.315Z",
      "notified": true
    }
  ],
  "task": "T1",
  "parent": "main-bee78832fde7b2b8",
  "children": [],
  "briefSha": "3cfe2bacf9c40a2c1e86d86cf67a099fc4ae3b5ebe68d5817c534379e65d9ea8",
  "bundle": "root",
  "budget": {
    "turns": 60,
    "tokens": 1500000,
    "wallMs": 3600000
  },
  "createdAt": "2026-09-21T09:29:17.239Z",
  "lastUsed": "2026-09-21T09:29:17.315Z",
  "sessionID": "ses_child_1",
  "configDigest": null,
  "history": [
    {
      "at": "2026-09-21T09:29:17.315Z",
      "from": "starting",
      "to": "idle",
      "trigger": "connected"
    }
  ],
  "worktree": "removed"
}


$ ls /home/bliss/OpenCodePlus/run/team/development-models/runs/w-8327252ad4d72db3/tmp/plus-team-walkthrough-w8503U/opencode/opencodeplus/teams/runs/w-020a76e89fdeda2f
ack.json
brief.json
brief.md
checks.json
receipts
report-1.json
report-1.md
run.json

$ ls /home/bliss/OpenCodePlus/run/team/development-models/runs/w-8327252ad4d72db3/tmp/plus-team-walkthrough-w8503U/opencode/opencodeplus/teams/runs/w-020a76e89fdeda2f/receipts
note-05ceea5.json
note-05ceea5.log

```

Reading the cycle against the end state: the first `team_status` from a session
with no run **created** `main-bee78832fde7b2b8` and answered normally, and the
second call returned the same run (item 7); the child's per-run edit scope is an
ordinary row, listable by `run:<id>` and showable (item 3) — two addresses, one
rule; the settlement reached the parent's inbox exactly once and the attempt
records `"notified": true` (item 14); `wait` named what it acknowledged and
`status` showed the same `acked` attempt (item 15); after `integrate` the child
directory is gone, `git worktree list` has only the parent, the branch ref still
resolves, `run.json` reads `"worktree": "removed"`, and `brief.md`, `report-1.md`
and the check receipts are still on disk (items 16 and 19).

One honest note on the second `wait`: it re-acknowledges the same settled
attempt (`acknowledged` names the run again and `ack.json`'s timestamp moves).
The acknowledged **attempt** does not move, so `wait` and `status` still agree,
which is what item 15 requires. Making the second call a no-op is a small
improvement, recorded for review rather than changed here.

---

## 20e — a child that ended its turn without `finish` is `idle` / `no_report`

```
=== [20e] a turn that ends without finish is idle / no_report ===

$ team_status {"runs":["w-aaaaaaaaaaaaaaaa"]}
[
  {
    "run": "w-aaaaaaaaaaaaaaaa",
    "role": "gemini-implementer",
    "state": "idle",
    "attempt": 1,
    "attemptState": "no_report",
    "task": null,
    "taskState": null,
    "head": "425c37dc6c562acbe09fdc9b4ac06128ac6825e0",
    "base": "425c37dc6c562acbe09fdc9b4ac06128ac6825e0",
    "dirty": false,
    "branch": "team/implementer/walkthrough",
    "checks": [],
    "report": null,
    "children": [],
    "parent": null,
    "acked": null,
    "budget": {
      "turnsUsed": 1,
      "turns": 0,
      "tokensUsed": 0,
      "tokens": 0,
      "overBy": {
        "turns": 0,
        "tokens": 0,
        "wallMs": 0
      },
      "exhausted": false
    }
  }
]

```

No tool call from the child; the run moved because the host's `session.idle`
reached the lifecycle handler.

---

## 20f — a followup queued while the child is working is delivered when it goes idle

```
=== [20f] a followup queued while the child is working is delivered on idle ===

$ team_followup {"run":"w-bbbbbbbbbbbbbbbb","requestID":"ev-f1","prompt":"Also cover the empty-list case."}
{
  "attempt": 1,
  "state": "queued"
}

$ session.prompt recorded by the host double
[
  {
    "sessionID": "ses_walkthrough_followup_child",
    "text": "Also cover the empty-list case."
  }
]

$ team_status {"runs":["w-bbbbbbbbbbbbbbbb"]}
[
  {
    "run": "w-bbbbbbbbbbbbbbbb",
    "role": "gemini-implementer",
    "state": "working",
    "attempt": 2,
    "attemptState": "admitted",
    "task": null,
    "taskState": null,
    "head": "425c37dc6c562acbe09fdc9b4ac06128ac6825e0",
    "base": "425c37dc6c562acbe09fdc9b4ac06128ac6825e0",
    "dirty": false,
    "branch": "team/implementer/walkthrough",
    "checks": [],
    "report": null,
    "children": [],
    "parent": "main-0123456789abcdef",
    "acked": null,
    "budget": {
      "turnsUsed": 2,
      "turns": 0,
      "tokensUsed": 0,
      "tokens": 0,
      "overBy": {
        "turns": 0,
        "tokens": 0,
        "wallMs": 0
      },
      "exhausted": false
    }
  }
]

$ cat /home/bliss/OpenCodePlus/run/team/development-models/runs/w-8327252ad4d72db3/tmp/plus-team-walkthrough-hbSaAd/opencode/opencodeplus/teams/runs/w-bbbbbbbbbbbbbbbb/run.json .attempts
[
  {
    "n": 1,
    "state": "no_report",
    "startedAt": "2026-09-21T09:29:17.379Z",
    "trigger": "delegate",
    "endedAt": "2026-09-21T09:29:17.385Z",
    "notified": true
  },
  {
    "n": 2,
    "state": "admitted",
    "startedAt": "2026-09-21T09:29:17.387Z",
    "trigger": "followup",
    "prompt": "Also cover the empty-list case.",
    "inbox": [
      "01M31MRQT7CCJJB9GDXNW0FYYR"
    ]
  }
]

```

Attempt 1 settles `no_report`, attempt 2 opens with trigger `followup`, carrying
the queued prompt and the inbox id it came from, and the host session was
prompted once — with no further action by either side.

---

## 20g — one GC pass reaps a stale run and one orphan

```
=== [20g] one GC pass reaps a stale run and one orphan ===

$ git worktree list
/home/bliss/OpenCodePlus/run/team/development-models/runs/w-8327252ad4d72db3/tmp/plus-walkthrough-repo-ipYUkr/repo                                                           425c37d [main]
/home/bliss/OpenCodePlus/run/team/development-models/runs/w-8327252ad4d72db3/tmp/plus-team-walkthrough-G2Q56E/opencode/opencodeplus/teams/worktrees/repo/implementer/kept    425c37d [team/implementer/kept]
/home/bliss/OpenCodePlus/run/team/development-models/runs/w-8327252ad4d72db3/tmp/plus-team-walkthrough-G2Q56E/opencode/opencodeplus/teams/worktrees/repo/implementer/orphan  425c37d [team/implementer/orphan]
/home/bliss/OpenCodePlus/run/team/development-models/runs/w-8327252ad4d72db3/tmp/plus-team-walkthrough-G2Q56E/opencode/opencodeplus/teams/worktrees/repo/implementer/stale   425c37d [team/implementer/stale]

$ state before gc
{
  "staleRun": "stopped",
  "staleWorktree": true,
  "keptRun": "stopped",
  "keptWorktree": true,
  "orphanWorktree": true
}

$ gc(root, policy)
{
  "reaped": [
    "w-cccccccccccccccc"
  ],
  "skippedDirty": [],
  "orphansRemoved": [
    "/home/bliss/OpenCodePlus/run/team/development-models/runs/w-8327252ad4d72db3/tmp/plus-team-walkthrough-G2Q56E/opencode/opencodeplus/teams/worktrees/repo/implementer/orphan"
  ]
}

$ git worktree list
/home/bliss/OpenCodePlus/run/team/development-models/runs/w-8327252ad4d72db3/tmp/plus-walkthrough-repo-ipYUkr/repo                                                         425c37d [main]
/home/bliss/OpenCodePlus/run/team/development-models/runs/w-8327252ad4d72db3/tmp/plus-team-walkthrough-G2Q56E/opencode/opencodeplus/teams/worktrees/repo/implementer/kept  425c37d [team/implementer/kept]

$ state after gc
{
  "staleRun": "reaped",
  "staleWorktree": false,
  "keptRun": "stopped",
  "keptWorktree": true,
  "orphanWorktree": false
}

```

The stale `stopped` run is `reaped` and its worktree removed; the unclaimed
orphan directory is removed; the run an open merge entry still references is
kept. `test/teams/gc.test.ts` adds the dirty-stopped skip (visible as
`worktree: "dirty"`), the `--force` superseded case, and the sweep tick that
runs reconcile and gc together.

---

## 20h — a refusal carries its `accepted:` line, verbatim

```
=== [20h] a refusal carries the accepted line verbatim ===

$ team_set_checks {"checks":[{"id":"unit","argv":["bun","test"]}]}
E_CHECKS: Checks must be explicit bun test FILE or bun run SCRIPT commands. Whole-suite bun test is not permitted.
accepted: {"id":"plus-tests","argv":["bun","test","packages/plus/test/model.test.ts"]}

$ team_delegate {"requestID":"ev-h1","role":"gemini-implementer","objective":"Implement with empty paths so the refusal names the accepted scope shape.","deliverable":{"kind":"commit"},"scope":{"paths":[]},"checks":[{"id":"note","argv":["bun","test","note.test.ts"]}]}
E_PATHS: Implementers need scope.paths (files or dir/* they may edit).
accepted: ["packages/plus/src/*","packages/plus/test/*"]

```

Both are `CODE: message` followed by `accepted:` on its own line, formatted once
in the tool seam from the error's `accepted` value.

---

## 20i — an `ask` on a root-chat team tool, and what the TUI can actually do with it

This is the one item of E.20 I could not complete as written, and the reason is
a host capability, not a Plus behaviour. What is true, what is not, and the
decision taken.

**The row ships and is live.** `fable-planner` carries, at `/api/agent` in the
running lab, exactly the effect D6 specifies:

```
--- fable-planner: 22 rules
    {"action": "team.delegate", "resource": "*", "effect": "ask"}
```

and the row that produces it is visible, addressable and overridable in the
Instructions screen — the `team_delegate [on]` capture under **20b**.

**The child half is true.** A child run maps that `ask` to `deny`, so a headless
child never waits on a prompt that cannot come:
`test/teams/roles.test.ts` — "effective permission at /api/agent for a child
session is never ask", asserted through core's own `evaluate`.

**What does not happen: the prompt.** In a real Fable-Planner chat in the lab I
asked for exactly one `team_delegate` call. It ran, with no permission dialog:

```
Fable-Planner root chat in the lab TUI (fresh session, no prepare):

   Delegating demo task to gemin +
     ✗ team_delegate [requestID=demo-1, role=gemini-implementer, base=HEAD, repo=proj,
       objective=Demo delegation (taskRef demo): worker loads its brief, makes no
       changes, and reports done., prompt=Demo run (taskRef demo): call
       team_get_context, make no changes, then report done via team_finish.]
     The single team_delegate call was made as requested and was rejected by the
     server:
     E_ROLE: Planners may delegate only to opus-orchestrator or sol-orchestrator.
     accepted: {"role":"opus-orchestrator"}
     Per your instructions I have not retried and have called nothing else.
     Fable-Planner · claude-fable-5-1 · 43.0s · 96.3 tok/s
```

The reason is in the host, and it is not subtle. Core evaluates a permission
where a *built-in* tool asks it to: `Permission.assert` is called inside
`edit`, `glob`, `grep`, `patch`, `question`, `shell`, `skill`, `subagent`,
`webfetch` and the MCP bridge. There is no generic gate that evaluates a
registered tool's `options.permission` before running it — core uses that field
only to decide catalog visibility (`packages/core/src/tool.ts:224-226`). A
plugin tool therefore cannot raise a prompt, and the plugin API does not offer
one either: `PermissionDomain` in `packages/plugin/src/effect/permission.ts` is
`Pick<PermissionApi, "list" | "get" | "reply" | "rules">` — `create` is
deliberately excluded.

**Decision.** Item 9's "honoured by every team tool" needs either a core gate
keyed on `options.permission` or `create` on the plugin permission domain. Both
are outside this round's allowed surface: the plan's global constraints forbid
changing `packages/core` or `packages/plugin` unless a task names the exact file,
and no task does. I did not:

- fake it by turning `ask` into a refusal in `teams/tools.ts` — that would make
  `ask` behave as `deny` for the human's own chat and break the planner
  workflow the row exists to protect, and it would put a second permission
  decision inside `src/teams`, which the round's first global constraint forbids;
- change core or plugin anyway;
- claim the item.

So: the row, its effect and its child-side override ship and are proven; the
prompt does not exist for any plugin tool in this host; the one-line host change
that would complete it is named above and handed to review. Three of item 9's
four clauses are true on this branch, and the fourth is a host gap, stated here
rather than hidden.

**What the same chat does prove**, in the real product, with no `prepare` and no
setup: a fresh planner chat calling a team tool gets its own root run (item 7),
and a refusal reaches the model with its `accepted:` line (item 10):

```
Same Fable-Planner chat, next turn — team_status with no arguments:

     [
       {
         "run": "main-fbde867394e5996d",
         "role": "fable-planner",
         "state": "working",
         "attempt": 1,
         "attemptState": "streaming",
         "task": null,
         "taskState": null,
         "head": "14c6863fbe7a3fffa60eca142702b20377e47b97",
         "base": "14c6863fbe7a3fffa60eca142702b20377e47b97",
         "dirty": false,
         "branch": "master",
         "checks": [],
         "report": null,
         "children": [],
         "parent": null,
         "acked": null,
         "budget": {
           "turnsUsed": 1, "turns": 0, "tokensUsed": 0, "tokens": 0,
           "overBy": { "turns": 0, "tokens": 0, "wallMs": 0 },
           "exhausted": false
         }
       }
     ]
     In short: only this session's own run (main-fbde867394e5996d, role fable-planner)
     exists - it's working on attempt 1, on branch master at 14c6863, clean worktree,
     no checks, no report, and no children.
```

---

## 21 — `finish` on the root run

```
=== [21] finish on the root run ===

$ team_finish {"status":"done","summary":"Root run closed after the walkthrough cycle."}
{
  "run": "main-ae601d8bdaac5915",
  "attempt": 1,
  "status": "done",
  "summary": "Root run closed after the walkthrough cycle.",
  "concerns": [],
  "needs": [],
  "findings": [],
  "deferred": [],
  "commits": [],
  "checks": [],
  "head": "425c37dc6c562acbe09fdc9b4ac06128ac6825e0",
  "base": "425c37dc6c562acbe09fdc9b4ac06128ac6825e0",
  "dirty": false,
  "dirtyFiles": [],
  "reportPath": "/home/bliss/OpenCodePlus/run/team/development-models/runs/w-8327252ad4d72db3/tmp/plus-team-walkthrough-lcnQOf/opencode/opencodeplus/teams/runs/main-ae601d8bdaac5915/report-1.md",
  "at": "2026-09-21T09:29:17.461Z"
}

$ team_get_context {}
{
  "run": "main-ae601d8bdaac5915",
  "role": "sol-orchestrator",
  "task": null,
  "directory": "/home/bliss/OpenCodePlus/run/team/development-models/runs/w-8327252ad4d72db3/tmp/plus-walkthrough-repo-KV31UL/repo",
  "branch": "main",
  "base": "425c37dc6c562acbe09fdc9b4ac06128ac6825e0",
  "head": "425c37dc6c562acbe09fdc9b4ac06128ac6825e0",
  "brief": null,
  "briefPath": null,
  "scope": {
    "paths": [],
    "forbidden": []
  },
  "checks": [],
  "interfaces": [],
  "decisions": [],
  "siblings": [],
  "budget": {
    "turns": null,
    "tokens": null,
    "wallMs": null,
    "used": {
      "turns": 1
    }
  },
  "inbox": []
}

test/teams/walkthrough.test.ts:
(pass) [20b] a team member's ceiling and native denies are instructions rows [88.47ms]
(pass) [20c] a non-member catalog has zero team tools; a member's is exactly its ceiling [22.60ms]
(pass) [20d] root bootstrap, delegate, context, checkpoint, finish, notification, wait, integrate [165.63ms]
(pass) [20e] a turn that ends without finish is idle / no_report [12.12ms]
(pass) [20f] a followup queued while the child is working is delivered on idle [25.11ms]
(pass) [20g] one GC pass reaps a stale run and one orphan [36.52ms]
(pass) [20h] a refusal carries the accepted line verbatim [11.80ms]
(pass) [21] finish on the root run [19.52ms]

 8 pass
 0 fail
 86 expect() calls
Ran 8 tests across 1 file. [739.00ms]
```

The root run needs no brief to finish, and `get_context` on it returns the run
fields with `brief: null` and no `conventions` key (D8, item 11).

---

## Decisions taken while producing this walkthrough

These were decided from the plan's Decisions section and are recorded here, as
the plan requires, rather than raised as questions.

- **Surfaces.** 20a, 20c and 20i are proven in the real TUI; 20b and 20d–21 use
  the in-process harnesses the plan permits, and 20b and 20c are shown on both.
- **The evidence is a committed program, not a transcript.** `walkthrough.test.ts`
  asserts everything it prints, so this document cannot drift from the product
  without a check going red.
- **No projection was widened for `policy`.** `instructions_list` returns `text`
  and `instructions_show` returns `patterns`; between them a reader sees the
  whole rule. Adding a `policy` field to the tool surface is a new API this
  round did not plan, so 20d states the run scope with both calls instead.
- **Two addresses per member row.** A Defaults-level member is listed both as a
  stand-alone agent and under its team, so `instructions_list` returns each of
  its rows twice. That is the tree's shape, not a duplicated rule; the program
  asserts the exact pair.
- **A second `wait` re-acknowledging the same attempt** is left as it is, with
  the acknowledged attempt unchanged, because item 15's requirement — `wait` and
  `status` agreeing — holds either way.
- **`review` is absent and `diff` is implemented** (D4), and the plan's T2 step 6
  (dropping the `project.json` copy into child worktrees) was deliberately not
  taken by the earlier orchestrator, because Plus would not activate in a child
  worktree without it. Both decisions stand.

## What the independent review changed

`astra-reviewer` read this document, its evidence program and the source, and
returned five findings. It was right about all five. Four were fixed on this
branch, each with a test that fails on the commit before it
(`fix(plus): bound the orphan sweep, report real GC outcomes, add worktree to
status, union run scopes`):

1. **The orphan sweep could delete a developer's own worktrees.** `orphans()`
   listed *every* worktree of the repository and returned each one no run
   record claimed; `gc()` then force-removed them. The plan's item 18 says only
   "a worktree **under the team data root**". `orphans` now takes that boundary
   as an argument — `ownedRoot(workspaceRoot, repoKey)`, the same expression
   `create()` uses — and filters by real-path containment, so a caller cannot
   forget it. The regression test reproduces the data-loss case on the old
   code: a full `gc()` pass removing an unrelated checkout together with its
   uncommitted file.
2. **GC reported removals that never happened.** A `git worktree remove`
   failure (a locked worktree is the concrete case) was swallowed and the run
   was still saved `reaped` / `worktree: "removed"` — a lie that also dropped
   the directory out of the same pass's known list. Removal is now judged by
   the directory being gone afterwards; a failure keeps the run's state, keeps
   it claimed, and appears in `GcResult.removeFailed`.
3. **The registered `team_status` omitted `worktree`, so item 19 was half
   unmet.** The tool calls the private `statusOf` in `api.ts`; the green test
   exercised a *different*, exported `statusOf` in `api-query.ts` that the tool
   never calls. `team_status` now reports the same value `list` does, proven
   through the tool seam. The `team_status` outputs pasted in 20d above predate
   this fix and therefore do not show the field; the current tool does.
4. **Concurrent same-role edit scopes were last-run-wins, not the union this
   document claimed.** Every run's row carried its own `deny edit *`, so under
   core's last-match-wins evaluation a later run's row revoked an earlier run's
   own scope. A role's rows are now built as a group — the first carries the
   baseline deny, every row carries its own allows, the last carries the
   never-editable denies — so two live runs of one role resolve to the union,
   with each run keeping its own listable `perm:edit:run:<id>` row.

The fifth finding is the `ask` gap in 20i, which the reviewer agreed was
correctly out of scope to fix here and correctly disclosed, and which remains
an unmet clause of item 9.

Two decisions taken on that fix: the union is expressed once across a role's
rows rather than repeated in full on every row — repeating it is more robust if
a user disables one row of several, but duplicates the same rules N times in
the permission list a reader sees; and a run whose worktree cannot be removed
is now visible in `removeFailed` on every pass instead of being silently
reaped.

## Handed to review

1. `ask` on a plugin tool cannot reach the TUI in this host, so item 9's
   "honoured by every team tool" is unmet (20i). Completing it needs a core
   gate on `options.permission` or `create` on the plugin permission domain.
2. Per-run edit scope is an agent-level rule, so two concurrent runs of the
   same role share the union of their `scope.paths`. They are now genuinely a
   union; per-session isolation would need a row that belongs to a session
   rather than an agent.
3. Core rules carry no message, so the per-denial explanation the deleted hook
   used to show no longer reaches the model; the row's `text` carries it instead.
4. Search narrowing ships, but delivery needs a `search` MCP server in user
   config that Plus cannot ship.
5. A second `team_wait` re-acknowledges an already-acknowledged attempt. The
   acknowledged attempt does not move, so `wait` and `status` still agree.
