# Teams tools round 2 — walkthrough

This document records live verification of the round-2 end state on the integrated branch at HEAD `0823d8833682db15da59b212808efddcace3744e`. Everything marked LIVE was driven through the real OpenCodePlus TUI with pilotty in a throwaway lab home under `run/tmp-build/tui-lab-r2` (never the human's server on port 40374, never `~/.config/opencode`). `EXA_API_KEY` / `TAVILY_API_KEY` reached the lab only through the process environment. Later sections record work done after that first draft; every hash in this document is the hash that was current when the capture was taken.

## Table of Contents

- [Items 1–3 — The gate asks, allows, denies (LIVE)](#items-13--the-gate-asks-allows-denies-live)
- [Item 4 — A rule carries the message the model reads](#item-4--a-rule-carries-the-message-the-model-reads)
- [Item 5 — The generated client](#item-5--the-generated-client)
- [Items 6–7 — Search shipped and registered (LIVE)](#items-67--search-shipped-and-registered-live)
- [Item 8 — A missing key names the variable (LIVE)](#item-8--a-missing-key-names-the-variable-live)
- [Items 9–11 — Team tools under the gate, end to end (LIVE)](#items-911--team-tools-under-the-gate-end-to-end-live)
- [Decisions this round made](#decisions-this-round-made)
- [Known issue seen in the lab, not caused by this round](#known-issue-seen-in-the-lab-not-caused-by-this-round)

---

## Items 1–3 — The gate asks, allows, denies (LIVE)

BEFORE (base commit `85fafa55`, same lab recipe): a `fable-planner` asked to call `team_delegate` — the tool ran with no prompt at all, straight into the team runtime:

```
     ✗ team_delegate [requestID=probe, role=gemini-implementer, objective=Probe run:
       reply with a short greeting ("hi"). No code changes, no checks required.,
       prompt=say hi, effort=small]
     The delegate call was made once as requested, but it was rejected by the team
     runtime:
     E_ROLE: Planners may delegate only to opus-orchestrator or sol-orchestrator.
     accepted: {"role":"opus-orchestrator"}
```

AFTER (integrated branch): the same call now stops and asks the human first:

```
     ⠹ team_delegate [requestID=say-hi-opus-orchestrator-001, role=opus-orchestrator,
       objective=Respond with a simple greeting: say hi., prompt=say hi, effort=small]
  ┃  △ Permission required
  ┃    ⚙ Call tool team.delegate
  ┃  Tool: team.delegate
  ┃   Allow once   Always allow   Reject  ctrl+f fullscreen  ⇆ select  enter confirm
```

Allow once → the call proceeds into the handler (this attempt was then rejected by the tool's own argument validation, which is what the handler is for — the permission decision had already been made):

```
     The delegation was rejected by the tool: starting an orchestrator requires a
     reason field explaining why coordination (rather than direct implementation) is
     needed. Error returned:
     │ E_REASON: Delegating to an orchestrator needs reason (why coordination, not
     │ implementation).
```

The prompt appears again on every subsequent call while the rule says `ask` — it is not a once-per-session question.

Note for readers: the gate covers plugin-origin tools. MCP tools were deliberately left to the assert they already perform at their own leaf (`packages/core/src/tool/mcp.ts:59-71`, same action, `resources: ["*"]`, `save: ["*"]`); gating them twice would prompt twice for one call. Built-in tools are untouched and still assert exactly once at their leaf.

### Item 1, precisely

Item 1 of the plan says a deny "refuses it with `Permission denied: <action>`".
That is exactly what happens when a **rule** denies. It is not what happens
when a **human presses Reject without feedback**: core deliberately turns a
plain decline into a defect that interrupts the assistant turn, so the model
receives nothing at all rather than a refusal string
(`packages/core/src/permission.ts`, the "deliberate defect tunnel" comment
around :237-248). That behaviour is pre-existing, intentional, and was not
changed this round — changing it would have meant rewriting core's decline
contract and the tests that pin it.

So item 1 is met in full for rule denials and for allow, allow-and-save and
ask-blocks-execution; for a human Reject without feedback the round preserves
core's interruption instead of inventing a refusal string. This is recorded as
a deviation from the plan's literal wording, not as a claim of compliance.
A human Reject **is** now recorded in the team audit chain — see "Item 12 —
the refusal captures" below.

---

## Item 4 — A rule carries the message the model reads

Proven in-process against the real permission service (no mocks), in `packages/core/test/permission.test.ts` › "refuses with the denying rule's own message when it carries one" and `packages/plus/test/teams/permissions.test.ts` › "the rules a denial comes from carry the message the model reads". The messages the round-1 permission hook used to send are back, word for word, carried by the rules themselves:

```
"*" is outside your scope.paths [packages/plus/src/*]. Report it in needs=[{kind:"path"...}].
".git/**" is version-control or paused-tool state and is never editable, even inside scope.paths [packages/plus/src/*]. Report it in needs=[{kind:"path"...}].
shell is not available to muse-implementer; run checks with team_check
read "*.key" is not available to muse-implementer
team_delegate is outside the implementer ceiling
```

Record honestly that one word had to change: the round-1 hook saw the single file the agent asked for, while a rule answers for a pattern, so the quoted subject is now the rule's own resource and every other word is unchanged. Source of the recovered texts: `docs/team-v2/acceptance/2026-09-18-live-rounds.md` §R2, hook commit `c63cf4b4` "fix(plus): explain team scope denials to the agent".

An `ask` rule's message rides on the request as `metadata.message` so the TUI can say why it is asking; the planner `team.delegate` row carries no message, which is why the capture above shows no reason line.

---

## Item 5 — The generated client

`bun run generate` in `packages/client` produced `packages/client/src/promise/generated/types.ts:440`:

```ts
export type PermissionRule = { action: string; resource: string; effect: PermissionEffect; message?: string }
```

committed as `chore(sdk): regenerate types`. No generated file was hand-edited; `bun run check:generated` (`bun run generate && git diff --exit-code`) exits 0.

---

## Items 6–7 — Search shipped and registered (LIVE)

The MCP panel in the running TUI:

```
                                                                    MCP
                                                                    • search        Connected
```

The row Plus registered, read back live from `instructions.snapshot` — note the command is the bun binary plus the shipped `bin.ts`, and that no key appears anywhere in it:

```json
{
 "id": "mcp:search",
 "kind": "mcp",
 "title": "search",
 "text": "{\"type\":\"local\",\"command\":[\"/opt/ocp/releases/bun-1.4.2/package/bin/bun\",\"/home/bliss/OpenCodePlus/worktrees/team-development-models/main-f764696f1c2739c2/opencode/packages/plus/src/search/bin.ts\"]}",
 "enabled": true
}
```

Its tool rows, live in the same snapshot:

```
{'id': 'tool:search_exa_code_search', 'kind': 'tool', 'server': 'search', 'title': 'exa_code_search', 'enabled': True}
{'id': 'tool:search_tavily_search',   'kind': 'tool', 'server': 'search', 'title': 'tavily_search',   'enabled': True}
{'id': 'tool:search_tavily_extract',  'kind': 'tool', 'server': 'search', 'title': 'tavily_extract',  'enabled': True}
{'id': 'mcp:search', 'kind': 'mcp', 'title': 'search', 'enabled': True}
{'id': 'perm:search:team-tavily', 'kind': 'perm', 'title': 'Tavily search (search MCP)', 'enabled': False}
```

`tool:search_tavily_search` carries `"group": "mcp"` and `"namespace": "search"`, which is what puts it under the MCP group of both catalogues.

The round-1 per-role narrowing, resolved by core itself and read from the lab's `/api/agent` (this is core's own evaluation, not Plus's opinion):

```
agent                 tavily    exa       team.delegate
build                 allow     allow     deny
astra-planner         allow     allow     ask
astra-reviewer        deny      allow     deny
fable-planner         allow     allow     ask
gemini-implementer    deny      allow     deny
muse-implementer      deny      allow     deny
opus-orchestrator     allow     allow     allow
scout                 deny      allow     deny
```

Tavily is off for implementers, the reviewer and the scout; Exa stays on for everyone; the narrowing keys on the server name `search`, so it applies to whichever server is live. When the host already has a server named `search`, Plus leaves it alone and logs `search MCP already configured; not replacing`.

Real results, LIVE, from a team member (`fable-planner`) in the TUI — both tools called for real, keys taken only from the environment:

```
     ✓ execute
     › search.tavily_search [query=opencode AI coding agent]
     › search.exa_code_search [query=effect-ts Layer provide example]
     tavily_search — Best AI Coding Agents in 2026, Ranked - MightyBot — https://
     mightybot.ai/blog/coding-ai-agents-for-accelerating-engineering-workflows
     exa_code_search — Managing Layers — https://effect.website/docs/requirements-
     management/layers/
```

---

## Item 8 — A missing key names the variable (LIVE)

The shipped server spawned with both variables unset, driven over real stdio MCP:

```
id 2 isError= True -> {"error":"TAVILY_API_KEY is not set in the host environment"}
id 3 isError= True -> {"error":"EXA_API_KEY is not set in the host environment"}
```

No crash, no silent empty result.

---

## Items 9–11 — Team tools under the gate, end to end (LIVE)

One continuous session in the lab. `team_status` (rule says `allow`) ran with no prompt; `team_delegate` (rule says `ask`) stopped and asked; the human chose Allow once; the run was created; the child then used team tools itself without any request being created. The audit chain, read from the lab's `teams/audit.log`:

```
{'seq':  8, 'kind': 'tool.call', 'actor': 'fable-planner',    'tool': 'team_status',      'ok': True, 'code': None, 'outcome': 'allowed',     'durationMs': 15}
{'seq':  9, 'kind': 'run.created', 'run': 'w-7a2e1b5f49f28c0a'}
{'seq': 10, 'kind': 'tool.call', 'actor': 'fable-planner',    'tool': 'team_delegate',    'ok': True, 'code': None, 'outcome': 'asked:allow', 'durationMs': 121720}
{'seq': 11, 'kind': 'tool.call', 'actor': 'opus-orchestrator','tool': 'team_get_context', 'ok': True, 'code': None, 'outcome': 'allowed',     'durationMs': 8}
{'seq': 12, 'kind': 'tool.call', 'actor': 'opus-orchestrator','tool': 'team_finish',      'ok': True, 'code': None, 'outcome': 'allowed',     'durationMs': 13}
```

Read it line by line: seq 10's `asked:allow` and its 121-second duration are the human thinking in front of the prompt. seq 9 is the run created the moment they allowed. seqs 11 and 12 are the **child** calling team tools with `allowed` — never `asked` — which is round-1 D6 holding under the new gate.

`/api/agent` above shows the same thing statically: `team.delegate` resolves to `ask` only for the two planner roles, `allow` for the orchestrator, `deny` elsewhere. `packages/plus/test/teams/roles.test.ts` › "effective permission at /api/agent for a child session is never ask" pins it for every team tool.

The refusal outcomes are proven in-process with the real handlers, because they need no screen — `packages/plus/test/teams/tools.test.ts`:

- "planner delegate under ask: allow creates run and audit line with asked:allow, deny refuses and writes asked:deny"
- "child session calling team_status executes without creating a permission request and writes outcome: allowed"
- "partial deny: ceiling-denied team tool refuses at call time with E_PERMISSION and writes outcome: denied" — item 11: the tool is visible, the call is refused before the handler, the model reads the rule's own `team_delegate is outside the implementer ceiling`, and the audit line is written.

Audit `outcome` values and how each is reached:

| outcome | written by | when |
| --- | --- | --- |
| `allowed` | `runGated` | rules resolved to allow; no request was created |
| `asked:allow` | `runGated` | rules said ask and the human allowed |
| `asked:deny` | the `permission.replied` observer | the human rejected — **with or without feedback** |
| `denied` | the `tool.execute.after` observer | a rule denied at call time; core created no request, so no reply was published |

The two observers are disjoint by construction: `execute.after` returns early
when the failure's cause is a `Permission.CorrectedError`, which is the one
refusal both of them can see, so exactly one line is written per refused call.
`packages/plus/SPEC.md` and `packages/plus/README.md` carry the same table.

---

## Item 12 — the refusal captures (LIVE)

The first draft of this document described the refusal paths in prose and by
test name. A reviewer correctly called that an absent deliverable. Here are the
captures.

**A human Reject, in the TUI.** A `fable-planner` asked to delegate; the gate
raised the prompt; the human chose Reject with no feedback:

```
     ✗ team_delegate [requestID=lab-rejection-test-001, role=opus-orchestrator,
       objective=Lab test: respond to the prompt "say hi" so the parent can observe
       how an orchestrator handles an out-of-scope, plan-less request., prompt=say hi,
       reason=lab test of rejection]
     Fable-Planner · claude-fable-5-1 · 55.5s · 102.9 tok/s · interrupted
```

The turn ends `interrupted` and the model is given nothing — core's decline
contract, unchanged. What is new is the line below.

**The same rejection in the audit chain**, read live from the lab's
`teams/audit.log` immediately afterwards:

```
{'seq': 1, 'kind': 'run.created', 'run': 'main-a469efcdb0734d1e'}
{'seq': 2, 'kind': 'tool.call', 'actor': 'fable-planner', 'tool': 'team_get_context', 'ok': True,  'code': None,          'outcome': 'allowed',    'durationMs': 13}
{'seq': 3, 'kind': 'tool.call', 'actor': 'fable-planner', 'tool': 'team_delegate',    'ok': False, 'code': 'E_PERMISSION', 'outcome': 'asked:deny', 'durationMs': 44989}
```

Seq 3 is the refusal the first review found missing: a plain Reject, no
feedback, now recorded with `E_PERMISSION` and `asked:deny`, and the 45-second
duration is the human deciding. This is the live proof of the fix, not a test.

**A rule denial and its model-facing text.** This one needs no screen and is
proven in-process against the real handlers, in
`packages/plus/test/teams/tools.test.ts` › "partial deny: ceiling-denied team
tool refuses at call time with E_PERMISSION and writes outcome: denied". The
tool stays in the catalogue, the handler is never reached, the model reads the
denying rule's own words —

```
team_delegate is outside the implementer ceiling
```

— and the audit line written is:

```
{'kind': 'tool.call', 'tool': 'team_delegate', 'ok': False, 'code': 'E_PERMISSION', 'outcome': 'denied'}
```

Labelled honestly: the two captures above are live; this third one is an
in-process real-handler test, which the plan permits for proofs that need no
screen.

---

## Item 7 — both catalogues, from instructions_list (LIVE)

The earlier catalogue evidence in this document came from
`instructions.snapshot`. Item 7 asks for the rows under **both** catalogues, so
here is real `instructions_list` output, driven by a team member in the lab:

```
Agents catalogue:
┌────────────────────────────────────────────┬───────────┬──────────────────────┐
│ Raw id                                     │ Catalogue │ Agent                │
├────────────────────────────────────────────┼───────────┼──────────────────────┤
│ item:defaults::tool:search_tavily_search   │ Agents    │ shared Defaults ('') │
└────────────────────────────────────────────┴───────────┴──────────────────────┘

Teams catalogue:
┌────────────────────────────────────────┬───────────┬──────────────────────────┐
│ Raw id                                 │ Catalogue │ Agent                    │
├────────────────────────────────────────┼───────────┼──────────────────────────┤
│ item:defaults:/teams:tool:             │ Teams     │ shared Defaults (/teams) │
│ search_exa_code_search                 │           │                          │
├────────────────────────────────────────┼───────────┼──────────────────────────┤
│ item:defaults:/teams:tool:             │ Teams     │ shared Defaults (/teams) │
│ search_tavily_extract                  │           │                          │
├────────────────────────────────────────┼───────────┼──────────────────────────┤
│ item:defaults:/teams:tool:             │ Teams     │ shared Defaults (/teams) │
│ search_tavily_search                   │           │                          │
└────────────────────────────────────────┴───────────┴──────────────────────────┘
```

and the same agent's summary of the full fan-out:

```
kind:item item:tool namespace:search returns 186 item rows in total (372
including :whole sections): 96 in the Agents catalogue, 90 in the Teams
catalogue. The three tools are replicated for every agent at every level — e.g.
item:project:build:tool:search_tavily_search, item:global:plan:tool:…,
item:defaults:fable-planner:tool:… (Agents), and team-member rows like
item:defaults:opencodeplus-team/:fable-planner:tool:search_tavily_search,
item:defaults:review/:reviewer:tool:…, item:defaults:starter/:special:general:tool:… (Teams).
```

One oddity the same run surfaced, recorded for a later round: the filter
`item:mcp server:search` returns 0 rows while `item:mcp search` finds the 4
rows, so `server:` does not match the MCP row itself — it appears to apply only
to tool rows under a server. Pre-existing filter behaviour, untouched by this
round.

---

## Decisions this round made

Record these plainly, as decisions taken and why:

1. **The gate covers plugin origin, not MCP.** The plan assumed MCP tools were ungated; they were not (`core/src/tool/mcp.ts:59-71`). Gating them again would double-prompt and would have required weakening two existing assertions in `mcp.test.ts`, which the round forbids.
2. **`Permission.Service` is read from the calling fiber**, not taken as a Tool layer dependency: `Permission.node` depends on the unbound `Location.node`, so the dependency broke `tool-registry.test.ts` and four `packages/plus` build sites. When no permission service is in context the gate **refuses** the call; it never bypasses.
3. **The gate asserts the literal resource `"*"` for plugin tools**, so only rules whose resource pattern matches `"*"` take part in the decision. A deny narrower in its **action** pattern — `x.*`, which `packages/core/test/tool-permission-gate.test.ts` proves — refuses every call to the tools it matches. A deny narrower in its **resource** pattern does not: `Permission.evaluate` (`packages/core/src/permission.ts:87-95`) matches the asserted resource string against the rule's resource pattern, so a rule whose resource is `restricted/*` never matches `"*"`, never applies, and refuses nothing — with a preceding allow on `*`, the call is allowed. Per-tool resources were explicitly out of scope this round. That is the documented consequence of D2, not an accident.
4. **The rule message quotes the rule's resource**, not the file the agent asked for, as explained under item 4.
5. **`bun.lock` had to be updated.** The search server shipped with the SDK declared in `packages/plus/package.json` but absent from the lockfile, so a frozen install never linked it and the server could not start — the TUI showed `⊙ 1 MCP failed`. Lockfile entries added, `.js` subpath suffixes corrected to match `packages/core/src/mcp/client.ts`, and a regression test now spawns the server exactly as the registration does from a working directory outside the repository.
6. **The walkthrough was transcribed by a worker.** The orchestrator's session has no file-edit capability; every capture in this document was produced by the orchestrator driving the real lab, then handed to a scribe to commit.

---

## Known issue seen in the lab, not caused by this round

The first delegate attempt in the lab failed with `E_INTERNAL: NotFound: FileSystem.realPath (.../teams/worktrees/proj/orchestrator/t186ab-…)` on a first-ever worktree creation; a later delegate in the same lab succeeded and created `w-7a2e1b5f49f28c0a`. Worktree provisioning is untouched by this round. Noted so the next reader is not surprised.

---

# Final verification (T5)

An `astra-reviewer` verified this branch independently. It reviewed twice.

**First review** (at `aa2defb6`) settled `blocked` on procedure: the
orchestrator did not supply the plan's "Expected end state", and a stale
tooling bundle had left `team_review` unable to accept an attachment. It still
reviewed the substance and raised two findings, both since fixed: an ordinary
human Reject never reached the audit chain, and this document overstated what a
resource-narrow deny does.

**Second review** (at `6d6d6f98`, with the plan attached) assigned all fourteen
verdicts. Eleven passed. Three did not, and its three findings were:

1. **error** — item 4 was not met for MCP tools:
   `packages/core/src/tool/mcp.ts` replaced every non-`ToolFailure` with
   `Unable to execute <tool>`, so a message-bearing rule denial reached the
   model as a generic error. **Fixed**: that mapper now passes through a
   `BlockedError`'s `reason` when the rule carried one, and a
   `CorrectedError`'s feedback, and otherwise keeps the generic text byte for
   byte. Five new tests in `packages/core/test/mcp.test.ts` drive the **real**
   MCP leaf. The model-facing strings are now: a deny rule with a message →
   that message; a deny rule without one → `Unable to execute <tool>`; a
   non-permission failure → `Unable to execute <tool>`; a decline with
   feedback → the feedback; a plain decline → nothing, it stays a defect.
2. **error** — item 12's captures were missing from this document.
   **Fixed**: see "Item 12 — the refusal captures" and "Item 7 — both
   catalogues" above.
3. **warning** — the audit-writer table here contradicted the implementation.
   **Fixed**: see the corrected table above.

The reviewer also judged, independently, that leaving MCP authorization at its
own leaf is correct and avoids duplicate prompts; that item 2 holds on the
action-narrow reading and that this document now describes resource-narrow
denies accurately; that the core seam is minimal and appropriate for a fork
that must keep merging upstream; that no permission-decision hook or
`agent.permissions` write exists under `packages/plus/src/teams`; and that the
audit observers observe without deciding, with registration-local state.

It also noted two things worth carrying forward: preserving core's
no-feedback-Reject interruption is right, but item 1's literal wording does not
describe it (recorded under "Item 1, precisely" above); and the whole core diff
is not literally two files, because T2 necessarily changed
`packages/core/src/permission.ts` and `packages/core/src/tool/AGENTS.md` was
updated to stop contradicting the new gate.

## Weaknesses recorded for a later round

- The plus-side rejection test drives that file's `Permission.Interface`
  double rather than a core-built `Permission.Service` layer, because
  `packages/plus` deliberately does not depend on `@opencode/core`. Core's own
  `tool-permission-gate.test.ts` and `mcp.test.ts` pin the real service.
- Under Code Mode several inner team calls can share one tool CallID, so the
  per-call audit state can collide. Pre-existing.
- If the `execute.before` hook fails to register, a human rejection is not
  audited at all. Both hooks register together and a failure is logged at warn.
- `instructions_list`'s `server:` filter does not match an `mcp:` row.
- `packages/core/test/mcp.test.ts` › "terminates MCP descendants after the
  wrapper exits successfully" spawns `node`, which does not exist on this
  build host, so it failed at spawn before any assertion. Its existing
  `win32` skip guard was extended with `!Bun.which("node")`, matching four
  precedents in the same package (`sh`, `bash`, `hg`). The assertion is
  untouched and the test still runs wherever `node` exists.
- A first delegate in a brand-new lab home failed with
  `E_INTERNAL: NotFound: FileSystem.realPath` on the run's worktree directory;
  a later delegate in the same lab succeeded. Worktree provisioning is
  untouched by this round.
