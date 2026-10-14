# Monitor — design and evidence

What tools each agent uses and what they cost, live, with a durable log for
later comparison. User-facing behaviour is in the README (`## Tools`); this
file records why it is built this way and what was measured.

## Session filters

Opening `/monitor` from a chat starts with that chat selected (`filters 1`);
saved preferences are preserved underneath and Backspace reveals them. `s` is
one picker for the scope: this chat (`This chat · <title>`, one row), its tree,
the project, everything, or any session. `S` adds a session to a combined
report. Both pickers open at once from the last loaded list (refreshed in the
background on every opening) merged with the host's live sessions, so an active
chat is selectable before its first completed request. Every choice is a
temporary drill step; Backspace undoes it, Escape closes item content first,
then the screen.

The RPC and tool accept `sessionIDs` for combined `session` or `tree` scopes.
It takes precedence over `sessionID`; an explicit empty list reads no sessions.
Tree scope unions the selected sessions' complete delegation trees, without
double-counting overlapping roots or descendants.

## Data source

### Completion-time cache results

`model.observed` persists reported measurements and builds `cache_result` once.
The numeric detector is independent of explanations: read + write from the
latest completed predecessor in the same session/provider/model/history epoch,
capped at current inclusive input; a shortfall >= 128 is miss/partial. A new
epoch is cold. Compaction remains an annotation. Iteration-only Anthropic usage
arrives through the same core usage parser.

Final HTTP/WS observers store the full post-transform body in the item store
`monitor.db.transcripts/wire.db` (directory 0700, file 0600; see *Sent-body item
store* below). Completion compares full JSON fields with the predecessor,
retaining only bounded changed-field descriptions and usage comparisons in the
database.
Output budgets, on-demand controls and cache hints are distinguished from prompt
text changes. Linked Responses continuations are identified from the recorded
response ID; expanded server-held history is not claimed to be in the wire body.
Transcripts include thinking blocks and tool definitions; they are local runtime
data, never source/evidence fixtures. Retention removes their references and files
with the corresponding requests. HTTP authorization headers are not recorded.

`monitor.cache`, `monitor.query(view: cache)` and miss notifications read compact
saved results. They never load transcripts/fingerprints or fold session history.
Historical backfill runs in separate bounded batches; pending rows are counted,
not silently treated as hits. An unavailable diagnostic archive cannot suppress
a measured miss. General tool/accounting views retain the older analysis below.

The display compares inclusive input growth and uncached input. Providers do not
expose exact token attribution to each added field, so character counts are not
presented as measured tokens. Neither same-account routing nor cache eviction can
be inferred from an unchanged body; the cause remains explicitly unknown.

Measured focused first-load fixture: 3,001 saved request results, 100 returned,
13–31 ms on the development machine. This is not a production-database benchmark.

### Read speed

`cache_result` carries the summed numbers as columns (`CACHE_COLUMNS`, filled
from each result's JSON at insert and once by migration), covered by two
indexes keyed by time and by session. Totals, per-session sums and request
pages are index-only reads instead of `json_extract` over every result. A read
with no explicit end at an unchanged ledger revision returns the previous
answer. Tools and Sessions take their request totals from these results (plus
v1 steps that have no request row) instead of folding every session's history;
only the agent tool's overview/steps views still fold. Host session facts are
looked up for the rows on the returned page only, and team inference from run
files runs at most once a minute.

Measured on a copy of a live 2.5 GB ledger (32,657 requests, 364 sessions;
first read after a change / repeated read):

| Read | Before | After |
|---|---|---|
| Cache, all sessions | 370 ms every poll | 30–67 ms / ~1 ms |
| Cache, one 2,292-request chat | 23 ms | 4 ms / ~1 ms |
| Session picker list | 370 ms | ~50 ms, shown instantly from the last list |
| Tools, all sessions, all time | 7.1 s first, 86 ms after | 120 ms |
| Sessions, all, all time | ~1 s | ~105 ms |
| Prompt rows, 1 MB body (483 items) | — | 1–3 ms |
| Prompt poll, nothing new | — | < 0.1 ms |

The remaining all-scope cost is dominated by v1 steps (pre-request ledger rows,
~25 ms); they leave the 90-day window in early 2027.

### Sent-body item store

Each top-level field and each element of `system`, `tools`, `messages`,
`input` and `contents` is one item, keyed by the SHA-256 of its role and
compact JSON; a request is an ordered list of item hashes. Measured on 167
archived bodies: 33,954 item rows, 639 distinct items; 86.7 MB of bodies held
1.6 MB of distinct content (29 MB as whole-file gzip). Each item also stores a
hash with `cache_control` removed, so the Prompt tab tells a moved cache hint
(`*`) from changed content (`~`). Summaries are computed once per distinct item
from fixed rules (kind by role/type; a call shows its tool and first recognized
argument; a result its tool, size and first line; a `<system-reminder>` user
part is its own kind). They contain prompt text, so they stay in the private
store, never in `monitor.db`.

A body rebuilds byte-for-byte when it was compact JSON (every observed body
was); otherwise an exact gzip copy is kept beside it. Whole-file archives from
1.3.11 are not imported: only one ledger ever wrote them, their cache results
were already saved, and retention removes them. Multi-exchange invocations
alias the body of their final exchange.
Retention deletes requests older than 90 days, then items no request uses.

### General tool/accounting event ledger

One assistant message is one step (one LLM call). Core publishes every fact
the monitor needs as durable session events, which the Plus server plugin
receives through `ctx.event.subscribe()`:

| event                                                                          | used for                                                                    |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `session.created`, `session.renamed`                                           | session row: parent (subagents), agent, title, directory                    |
| `session.step.started`                                                         | step: agent, model, index, compaction epoch, instructions revision          |
| `session.text.ended`                                                           | the step's visible text size (output split)                                 |
| `session.tool.input.started`                                                   | the tool name of a call id                                                  |
| `session.tool.called`                                                          | call row: input size, target, running                                       |
| `session.tool.success` / `.failed`                                             | status, error, result size; Code Mode inner calls from `metadata.toolCalls` |
| `session.step.ended` / `.failed`                                               | token usage and cost; attribution                                           |
| `session.compaction.ended`                                                     | a compaction step and a new epoch (carried stops here)                      |
| `session.inbox.delivered`, `session.synthetic`, `session.instructions.updated` | the next step's prompt grew for other reasons: keep the estimate            |

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

# Request pages

Request Read cells use reported measurement presence: absent/running/legacy is
`—`, and explicit reported zero is `0`. Detail labels expose optional reported
write buckets independently as `Reported write 5m` and `Reported write 1h`;
missing buckets stay `—`, with no subtraction or TTL-price inference. The RPC
field is `measurement.writeByTTL?: { "5m"?: number; "1h"?: number }`.
Reuse percentages below one never round up to `100%`. Context retains legacy
`now` accounting, with `inputState` and optional `measuredNow` identifying
pending, unavailable, stored accounting, or measured input in the TUI.

`monitor.query` request arrays are bounded: the default is the latest 100 rows,
and `requestPage.limit` is clamped to 1–500. Rows within a page are chronological;
Cache displays them newest first. Follow `requestPage.older` or
`requestPage.newer` with `{ requestPage: { cursor, direction: "older" | "newer" } }`.
Cursors contain the request timestamp and ID, so equal timestamps and deletion
of the cursor row do not require offset-based navigation. This is a live keyset
view, not a snapshot across concurrent inserts/deletes.

Response `requestPage` reports `total` eligible rows, `returned`, `limit`, and
`complete`. Totals, coverage and facets describe the full scoped/windowed
population, independent of the request page. Explicit `id` detail lookup also
works outside the current page, subject to the scope, time and request filters.
An old consumer must not treat the bounded `requests` array as complete unless
`requestPage.complete` says so.

Other collections use `pages: { section: { limit?, cursor? } }`: `sessions`,
`context`, `agents`, `teams`, `unstable`, and `detail.lines`, `detail.segments`,
`detail.calls`, `detail.pings`, `detail.accounts`, `detail.instructions`,
`detail.reverts`. Defaults are 100 rows (50 for detail); limits clamp to 1–500.
Metadata in `report.pages[section]` gives `total`, `returned`, `offset`, `limit`,
`revision`, `complete`, `reset`, `next`, and `previous`. A stale content-revision
cursor resets visibly to the first page rather than applying an obsolete offset.
Instruction updates with multiple keys are represented as one key fact per row;
updates with no keys remain visible. All selected facts remain reachable.

Facet selections also paginate: `facets.agents`, `facets.tools`, `facets.models`
inputs use `pages`; continuation metadata is in `report.facets.pages`. Picker
searches apply only to the displayed page, and Previous/Next actions fetch more
only when explicitly selected. Top groups/feed and marks retain their existing
explicit top/feed/50-most-recent contracts, not an implied whole-history export.

Presentation text previews are limited to 512 characters and recorded in
`presentation.truncated`. `fullText: true` restores the original strings on the
selected bounded page; IDs/hashes and facet/team filter identities stay intact.
This is **not a hard response-byte bound**. Explicit full text and opaque identity
strings can be large. Request tool-name lists preview at most 20 unique names,
with `toolsTotal`/`toolsComplete`; the full attributed calls are independently
reachable via `detail.calls`. Tokens/coverage refer to full populations, never
the shortened presentation.

In Cache and Steps, `[` opens older rows, `]` opens newer rows, and `l` returns to
the latest page. Polling refreshes only the chosen page, never automatically
fetches every page, and follows the selected request ID while it remains present.
For Sessions/Overview and request evidence, `p` chooses the visible collection;
`[`/`]` fetch its previous/next page and `l` resets it. `v` toggles unabridged
selected-page facts. Overview scrolls all returned context/agent/unstable rows;
detail can inspect every named evidence collection. Text filtering is explicitly
**page-local**; agent/model/time/scope selections
are server-side population filters.
