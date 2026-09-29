# Monitor — proposal (not implemented)

Goal: see, live, which tools are called, by which agent, and what they cost in
tokens; filter by agent and tool; keep a durable log so periods, agents or
instruction revisions can be compared later.

## 1. What the data already gives us (measured, 2026-09-29)

One assistant message is one step (one LLM call). Its projected record carries
`agent`, `model`, `tokens {input, output, reasoning, cache.read, cache.write}`,
`cost`, and `content[]` with every tool call: `name`, `state.input`,
`state.status`, `state.content` (the result) and `time {created, ran,
completed}`. The same facts arrive live as durable session events:
`session.step.started` (agent, model), `session.tool.input.started` (name),
`session.tool.called` (input), `session.tool.success|failed` (result),
`session.step.ended` (tokens, cost).

The durable `event` table is empty on this machine (events are projected, not
retained), so history exists only as long as the session's messages exist;
deleting a session cascades its messages away. **A durable monitor therefore
needs its own ledger.**

A throwaway prototype over the last 7 days of the local database
(`run/plus/tmp/opencodeplus/q3.ts`, read-only) produced 106 sessions, 9 800
steps and these per-tool numbers:

| tool | calls | call tok | result tok | carried tok | failed |
| --- | ---: | ---: | ---: | ---: | ---: |
| read | 3 511 | 0.48 M | 10.2 M | 1 205 M | 61 |
| shell | 5 842 | 2.31 M | 5.3 M | 634 M | 2 |
| grep | 1 117 | 0.36 M | 1.0 M | 80 M | 30 |
| edit | 1 520 | 0.76 M | 0.31 M | 37 M | 24 |
| execute | 239 | 0.07 M | 0.50 M | 69 M | 0 |

("carried" in the prototype ignores compaction resets, so it is an upper bound.)

## 2. What "tokens a tool cost" means — three numbers, not one

Providers bill per step, never per tool, so a per-tool figure is an
attribution. Show three columns and label them honestly:

1. **Call** — the tokens the model spent writing the call: the step's
   `output + reasoning` split across its text/reasoning/tool-input parts by
   size. Exact when the step made one call and wrote no text.
2. **Result** — the tokens the result added to the next prompt, *measured*:
   `prompt(next step) − prompt(this step) − output(this step)`, where
   `prompt = input + cache.read + cache.write`, split across the step's
   parallel results by size. Falls back to a length estimate (marked `~`) when
   there is no next step (last step, interruption). The prototype measured this
   for 96.5 % of steps; the measured value averaged 1.38× the chars/4 estimate,
   so the estimate alone would under-report by about a quarter.
3. **Carried** — the result re-read on every later step until the next
   compaction (`result × later steps`), mostly billed as cache reads. This is
   what makes `read` the most expensive tool by far even though each call is
   cheap; it is derived at query time, never stored.

Cost in money is shown only when the step's `cost` is non-zero (the
CLIProxyAPI and LithosAI routes report 0 today).

## 3. Where it lives

**Live view: a `Monitor` tab in the session composer**, next to Subagents,
Shell, Terminals and Teams — the place you suggested. It fits: that panel is
already the "what is running under this chat" surface, Plus already registers
its Teams tab there through `context.ui.composer.tab`, and a monitor is most
useful scoped to "this chat and everything it delegated". Compact layout:

```
Monitor   scope: this chat + children   window: live   agent: all   tool: all
 12:41:03  deepseek-worker  shell  grep -n model tree.ts     call 91   result 1.2k  0.8s
 12:41:01  deepseek-worker  read   src/instructions/tree.ts  call 40   result 6.1k  0.1s
 ─ by tool ──────────── calls   call   result   carried  fail   avg
 read                     311    42k    1.02M     120M      2   4.2s
 shell                    204   118k     610k      71M      0   3.9s
 f filter  g group by  s scope  t window  enter details  M open monitor
```

**History and comparison: a full-screen `/monitor` route** (like
`/instructions`), because side-by-side comparison and long filter lists do not
fit the composer. Group by tool | agent | model | session | team run; compare
two selections (A/B columns with deltas).

**Tool access:** a read-only `monitor.query` tool (same shape as the
`instructions` tools) so agents and the build seat can ask "which tools cost
the most in run X" without scraping the TUI.

## 4. The ledger

A Plus-owned SQLite file next to the teams data (`<plus data>/monitor.db`),
append-only, storing irreducible facts only:

- `step`: session, parent session, message id, agent, provider/model/variant,
  team run + role (from the teams store), Plus instructions revision and the
  agent's resolved-profile fingerprint, tokens, cost, finish, start/end.
- `tool_call`: step, call id, tool, status, error class, duration, input and
  result sizes, call tokens, result tokens + `measured|estimated`, and a short
  **target** (shell: the command head; read/edit: the path; MCP: server/tool).

Never stored: tool outputs, full commands, file contents. Targets can be turned
off. Retention defaults to 90 days, configurable.

**Collection:** the Plus server plugin folds the durable session events above
(the plugin API has no message-list read, but the events carry every field).
A step is written at `step.ended`; its result tokens are finalized when the
next step of the same session ends. On startup, sessions updated since the
last watermark are reconciled through the server API so a restart loses
nothing.

**Why store the instructions revision and profile fingerprint:** it turns
"compare later" into "compare before and after I changed this agent's
instructions or model", which is the comparison that actually drives
decisions in this workspace. User marks (`m` in the tab: "before prompt
change") give named windows for everything else.

## 5. Open points to verify before building

1. Plus is instantiated per Location and `event.subscribe` is Location
   filtered. Team runs in worktrees must be proven to reach a collector (the
   team-run idle handler suggests they do, but that needs a real check).
2. A server-side read of session history for backfill/reconcile: the server
   HTTP API has it; the plugin context does not. Either add a narrow host API
   or run the reconcile from the TUI client.
3. Compaction resets for "carried": fold `session.compaction.ended` into the
   step sequence so carried stops at the checkpoint.
4. Subagent sessions: attribute a child's tokens to both the child agent and
   (rolled up) to the parent's `subagent` / `team_delegate` call, so the parent
   view shows the total cost of delegating.

## 6. Suggested build order

1. Ledger + collector + `monitor.query` tool (proves the numbers; tests over
   recorded event fixtures, one of them the prototype's real step shapes).
2. Composer `Monitor` tab: live feed + by-tool/by-agent table + filters.
3. `/monitor` route with history, grouping and A/B comparison, marks.
4. Backfill from existing sessions (one-shot import, so history starts today
   instead of from the release).
