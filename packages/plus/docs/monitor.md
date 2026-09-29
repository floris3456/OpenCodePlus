# Monitor — design and evidence

What tools each agent uses and what they cost, live, with a durable log for
later comparison. User-facing behaviour is in the README (`## Monitor`); this
file records why it is built this way and what was measured.

## Data source

One assistant message is one step (one LLM call). Core publishes every fact
the monitor needs as durable session events, which the Plus server plugin
receives through `ctx.event.subscribe()`:

| event | used for |
| --- | --- |
| `session.created`, `session.renamed` | session row: parent (subagents), agent, title, directory |
| `session.step.started` | step: agent, model, index, compaction epoch, instructions revision |
| `session.text.ended` | the step's visible text size (output split) |
| `session.tool.input.started` | the tool name of a call id |
| `session.tool.called` | call row: input size, target, running |
| `session.tool.success` / `.failed` | status, error, result size; Code Mode inner calls from `metadata.toolCalls` |
| `session.step.ended` / `.failed` | token usage and cost; attribution |
| `session.compaction.ended` | a compaction step and a new epoch (carried stops here) |
| `session.inbox.delivered`, `session.synthetic`, `session.instructions.updated` | the next step's prompt grew for other reasons: keep the estimate |

Core retains no event history here (the `event` table is empty on this
machine) and deleting a session deletes its messages, so the monitor keeps its
own ledger. The plugin API has no message-list read, so there is no backfill:
the ledger starts when the release that carries it starts.

The subscription is Location-scoped: each Location's Plus instance records the
sessions it sees into the one shared ledger. Every write is keyed by session
and message or call id, so an event seen by two instances writes the same row
twice. A team run's session is created in its worktree without a host parent;
the collector resolves its delegating session from the run records when it
first sees the session, so "this chat + delegated" includes team runs.

## Attribution

Providers bill per step. Per-tool numbers are therefore attributions, shown as
three columns (see the README): `call` (output split by size), `result`
(measured prompt growth, else an estimate at 2.5 characters per token) and
`carried` (result × later steps in the same compaction epoch, derived at query
time).

Calibration, on the last seven days of this workspace's real sessions (read
only, replayed through the real collector): 108 sessions, 11 079 steps,
14 475 calls. 96.2 % of results were measured; for clean tool steps the
measured growth per result character has median 1.58 tokens per 4 characters
(p25 1.20, p75 1.92), hence the 2.5 characters-per-token fallback. Step totals
matched the host's session totals to within 1 % (the difference is title
generation, which is not a step, and messages written while the replay ran).

## Storage

`monitor.db` (bun:sqlite, WAL, `synchronous = normal`) next to the teams data.
Tables: `session`, `step`, `call`, `epoch` (the last step index per session
epoch), `mark`, `meta`, and `call_hour`, an hourly rollup of `call` kept by
insert/update/delete triggers and keyed down to session and epoch so carried
tokens and the session scope stay exact. Queries read whole hours from the
rollup and the partial hours at a window's edges from `call`; a test checks the
two paths agree for odd edges, compactions, failures and pruning. Grouping by
target and "failed only" read `call` directly. Rows older than 90 days are
pruned once per process.

## Performance (measured)

- Ingest: 50–60 µs per event on this machine (≈ 6 events per tool step).
- Real ledger (7 days, 14 k calls): every query 1–5 ms.
- Synthetic 90-day ledger with 500 000 calls (≈ 3× this workspace's 90-day
  volume): this chat 0.4 ms, last 24 h 13 ms, 7 days vs previous 7 days 46 ms,
  everywhere 90 days ≈ 115 ms, this project 90 days ≈ 140 ms, grouped by target
  650 ms (raw calls by design).
- The TUI polls every second while calls are running or the newest is under a
  minute old, every five seconds otherwise, and only while the tab or route is
  visible.
