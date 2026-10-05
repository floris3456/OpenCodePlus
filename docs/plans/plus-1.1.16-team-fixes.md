# plus-1.1.16: team and service fixes (after 1.1.15)

**Start condition:** `plus-1.1.15` is released. None of this blocks 1.1.15.

**Where this comes from:** the review of the 1.1.15 overnight run
(2026-10-05). The orchestrator started 37 worker runs; 11 produced nothing.
See `plus-1.1.15-halt-report.md`; run records are under
`run/plus/data/opencodeplus/teams/runs/` (parent `main-165a4a6fe1411f5f`).
Decisions marked **(user)** were made by the user on 2026-10-05.

Line numbers are at commit `c0fc4bef46`. Re-check them before starting.

## 1. Briefs stay short and correct

**What happened:**
- The brief text limit (`limits.brief`, 6,000 chars) counts only the objective,
  prompt, interfaces and decisions (`packages/plus/src/teams/api.ts:293-301`).
- Over the limit, the refusal says: "Move long material into a file and pass
  briefFile."
- That file is then pasted into the Brief whole, up to 40 KB
  (`teams/brief.ts:94-95`).
- Result: 26 of the 37 Briefs carried the whole 21 KB overnight plan; Briefs
  were 23–42 KB. The runs that delivered on the first try mostly had 3–6 KB
  Briefs.
- Two more cheap mistakes the product could have refused:
  - T93's checks named `test/instructions-workspace.test.ts`, which does not
    exist;
  - T81 and T84 were live tests with no writable path (`May edit: nothing`), so
    they could not save evidence and looked stuck.

**Change:**
1. The attachment counts toward the limit. A small attachment (up to about
   8,000 chars, a `limits.attachment` row) is pasted. A bigger one is not
   pasted: the Brief names its path, and the worker reads only what it needs.
2. The refusal text says to shorten the Brief (keep the outcome, the files, the
   decisions and the checks). It no longer suggests moving text into a file.
3. Before a run starts, every `bun test <file>` check is resolved against the
   child's base commit. A missing file refuses the delegation and names it.

**Tests:** attachment over and under the limit (pasted vs path only); refusal
text; missing check file refused with no run created; existing files pass.

## 2. Token budgets: count new tokens, notify the parent, never stop

**What happens today:**
- "Tokens used" is `TokenUsage.total`: input + output + reasoning + cache
  reads + cache writes (`packages/schema/src/token-usage.ts:16`, used by
  `teams/usage.ts`).
  - Cache reads are the conversation re-read on every step.
  - T92 "used" 10.4M tokens, of which 10.0M were cache reads.
- Going over the budget does nothing. It only shows as `exhausted` in
  `team_status`.
  - The comment in `teams/schema.ts` about `sweeper.ts notifyBudget` is stale:
    that sweeper came from `scripts/team` and was never ported.
- `team_followup({ budget })` replaces the budget without a reason.

**Decisions (user):**
- Count input, cache input and output. Cache reads do not count.
  - That means input + cache writes + output, with reasoning counted as
    output, because it is billed as output.
- A budget that runs out never stops or interrupts the worker. Stopping costs
  progress, and a restart re-reads its context.
- Instead, the parent gets a notification, repeated now and then, until it has
  looked. It then does one of these:
  - the overrun is warranted: it writes down why and sets a new budget;
  - it is not: it nudges the child with a message, or stops it if it truly went
    rogue.

**Change:**
1. `teams/usage.ts`: tokens used = input + cache writes + output + reasoning.
   `team_status` still shows cache reads, on their own line, for information.
2. **Notification.** When a working child passes its budget, the parent gets a
   `notify` message through the existing channel (`lifecycle.ts` `notifySafe`),
   from the existing reconcile tick (`lifecycle.ts:848`).
   - **Repeats:** every 15 minutes while the child is still working and no new
     budget has been set. The interval is a `limits.budget-ping` row.
   - **One message:** it lists every over-budget child of that parent, with
     used, budget and minutes over.
   - **Queued:** it is delivered at the parent's next turn boundary and never
     interrupts a running step.
   - **The child is not told:** nothing is sent to it, so its cache stays
     intact.
3. **No new tool: `team_followup` does both.** Today it requires `prompt`, and
   its `budget` input replaces the whole budget without a reason
   (`teams/schema.ts:796`). Change it to
   `team_followup({ run, prompt?, budget?, reason? })`:
   - **`prompt` only:** a nudge, as today. The child stays over budget, so the
     pings continue.
   - **`budget` only:** raises the budget and does not message the child.
     `reason` is required (1–300 chars, like `team_stop`). Only the dimensions
     given change.
   - **Both:** raises the budget and tells the child.
   - **Recorded:** a budget change writes `{ at, by, from, to, reason }` to the
     run's history, and `team_status` and the run report show it. Pings stop
     until the new budget is passed.
4. **Stop** is `team_stop` with its reason, as today. So there are two tools
   for a running child: act on it (`team_followup`) or end it (`team_stop`).
5. Turns and wall-clock budgets use the same mechanism.
6. Recalibrate the effort defaults (small/medium/large) for the new count, from
   the 1.1.15 night's runs. The Brief's budget line names what is counted.
7. Delete the stale `notifyBudget` comment.

**Tests:**
- The count leaves out cache reads, on a real session's tokens.
- **Notification:** the first one fires at the limit, repeats after the
  interval, and is merged into one message for several children. It is never
  sent to the child.
- `team_followup` with a budget:
  - refuses an empty reason;
  - with no prompt, sends nothing to the child;
  - changes only the dimensions given;
  - writes the history entry;
  - ends the pings until the new limit.
- A prompt-only followup does not end the pings.

**Live:** one owned team run with a tiny token budget. The parent gets the
ping, raises the budget with a reason, and the pings stop. In a second run the
parent stops the child instead.

## 3. Instructions: a row and its sections are one text

**What happens today:**
- A role row can hold two kinds of override at once:
  - a whole-row text record (`section: null`), which is what the row shows;
  - section records, which the prompt puts on top of it.
- Live example: Simple-Orchestrator's role at global, with yesterday's
  whole-row text plus five section edits from 2026-10-05.
  - The assembled prompt has the new sections.
  - `show` on the row, both the resolved and "mine" views, still returns the
    old text.
  - So what Instructions shows is not what the agent gets.
- An unsplit row has a single child section with id `whole` and the row's own
  label, for example "OpenCodePlus › OpenCodePlus". For a tool row it is
  labelled "Description".

**Decisions (user):**
- The whole row shows the changes made to its sections, by an agent or by the
  user, automatically.
- The whole-body entry stops carrying the same name as a section.

**Change:**
1. **The sections are the one source of truth.**
   - Editing the whole row is split by headings into section changes, and
     stored only for the sections that changed.
   - The row's view, its diff, its review state and the TUI all use the same
     assembly as the prompt.
2. **Migration:** when the store loads, an existing whole-row override becomes
   section overrides. Section overrides already stored stay on top, as today.
   The prompt must come out byte-identical before and after.
3. **Naming:** the whole-body entry of an unsplit row is labelled "Full text"
   (the user found "All" and "Combined" not quite right; "Full text" is the
   proposal). Section rows keep their heading names.

**Tests:**
- Edit a section, then the row: its view and the assembled prompt are equal.
- Edit the row: each changed section shows its change, and the unchanged ones
  keep following upstream.
- Migrating the Simple-Orchestrator shape (whole override plus five section
  overrides) gives a byte-identical prompt.
- The "Full text" label shows.

**Live:** in the TUI at 80 and 160 columns, edit a section and see it in the
row; edit the row and see it in the sections.

## 4. Service: stop loading worker folders continuously

**What happens today** (measured 2026-10-05 around 12:20):
- The shared service ran 51 `search-mcp` processes, about 2.8 GB in total: one
  for every finished worker folder.
- Core drops a folder after 60 idle minutes
  (`packages/core/src/location-activity.ts`).
  - Something then reopens it within seconds: the log shows evictions at
    10:11:07Z and new `search-mcp` processes at 10:11:10Z.
  - 28 of them started after the overnight halt.
- Instructions writes took about 36 s each, against 4–9 s the night before.
  - Suspected cause: each write is sent to every open folder.
  - Not proven.

**Decisions (user):**
- A folder's services load when a session there starts (its first message), not
  continuously.
- A command refreshes them, and the same refresh exists as a tool, so agents do
  not need the shell for it.

**Change:**
1. **First, find what reopens a dropped folder.** Suspects:
   - change events (Instructions, provider and model updates) delivered to
     every known folder;
   - cache-warming pings for sessions of finished runs (see F13 in
     `plus-1.1.13-team-fixes.md`).

   The fix: nothing opens a folder just to deliver an event or a ping. Only
   loaded folders get events, and a folder loaded later reads fresh state.
2. **Load on the first message.** A folder's MCP servers and plugin loops start
   at the first message of a session there. Opening a TUI or listing sessions
   reads only cheap config (agents, models).
3. **Unload on stop.** A team worker's folder unloads as soon as its run is
   stopped, without waiting 60 minutes.
4. **Refresh.** One command, `/refresh` (with a palette entry), and the same
   as a Code Mode tool, for example `tools.opencode.refresh()`, with its own
   permission row, on by default.
   - **One meaning:** rebuild what this chat sends from the current settings
     and files.
   - **What it reloads:** this folder's config, agents, skills, commands and MCP
     servers. It also applies the chat's pending Instructions changes
     (item 5).
   - **It reuses existing reloads:** the host already has them
     (`packages/core/src/plugin/host.ts`: agents, providers, models, commands,
     mcp, discovery).
   - **It names the cost first:** for example, "re-reads about 48k tokens
     without cache", from the chat's last request.
5. **No per-folder file watchers.** File changes inside a folder (skills, agent
   files, a project `opencode.json`) apply in the next chat or after
   `/refresh`.
   - **Keep one service-wide watcher** for the global config and one for the
     Instructions store. They are cheap and keep the pickers, the tree and new
     chats current (Instructions T2).
   - **They only mark changes.** They never push anything into a running chat's
     prompt (item 5).

6. **Search: use the hosted Tavily and Exa servers (user, 2026-10-05).**
   - **Why the change:** Plus ships its own search server
     (`packages/plus/src/search/`, about 300 lines). It calls the Tavily and Exa
     web APIs directly and offers three tools.
     - Core runs every local (stdio) tool server once per folder, upstream V2
       too (`core/src/mcp/stdio.ts`). That is where the 51 copies came from.
     - A hosted server runs no local process at all: core connects over HTTP
       (`type: "remote"`, `schema/src/mcp.ts:54`).
   - **Configure two hosted servers:**
     - `tavily`: `https://mcp.tavily.com/mcp/` with an
       `Authorization: Bearer` header;
     - `exa`: `https://mcp.exa.ai/mcp`, choosing its tools with the `tools=`
       parameter.
   - **Keys stay out of the config.** Each header reads its key with core's
     `{file:…}` substitution (`core/src/config/variable.ts`) from the existing
     0600 key files.
     - Check first how Exa's hosted server takes a key: a URL parameter or a
       header.
     - A key must never sit in a config file, a row, a log or a URL that gets
       logged.
   - **Tools by default:** only Tavily search, Tavily extract and Exa code search
     are on for every agent, through Defaults rows. Any agent or team can switch
     on others (Tavily crawl and map, Exa web search) in Instructions.
   - **Rename every reference** to the old `search_*` tool names: Tools and
     rules sections, `perm:search:team-tavily`, the permission catalogue's
     parameter rules, presets, guidance, `requires`, teaching and the README.
     That is 12 places in `packages/plus/src`.
     - User rows on the old names are mapped to the new ones, or flagged for
       review.
   - **Remove** `packages/plus/src/search/`, the `search` server registration
     and the `search-mcp` CLI subcommand.
   - **Measured 2026-10-05** with Anthropic's token count, through CLIProxyAPI:

     | Same three tools | Code Mode catalogue line | Native tool definition |
     |---|---|---|
     | Ours | 801 tokens | 1,510 tokens |
     | Hosted | 1,329 tokens | 2,077 tokens |
     | Hosted, all 8 tools | (not measured) | 4,430 tokens |

     - Nearly all of the difference is Tavily search: its schema has many
       parameters, so its Code Mode line is 900 tokens against 250 for ours.
     - Exa code search is smaller hosted: 175 tokens against 341.
     - Instructions can replace a description, but not the schema, so
       overrides barely shrink this.
     - In Code Mode the inline catalogue has a fixed 2,000-token budget
       (`core/src/codemode/catalog.ts`). If the cost matters, leave
       `tavily_search` unpinned: agents then find it through `search()`.
   - **Keys, tested 2026-10-05 with a wrong key, which costs nothing:**
     - Tavily answers 401 without a valid `Authorization: Bearer` header.
     - Exa reads `Authorization: Bearer` or `x-api-key` (it suggests these
       itself) as well as the `exaApiKey` URL parameter. Use a header, so the
       key never appears in a URL.
     - Without a key, Exa code search still works, on Exa's anonymous free
       tier.
     - Core's `{file:…}` substitution trims and escapes the key file
       (`core/src/config/variable.ts`), so it fits in a header value.
     - Use an absolute key path: a dev home has a different `~`.
     - Exa's Cloudflare front blocks clients without a normal User-Agent
       (error 1010). Check that core's MCP client sends one.

**Tests:**
- An event for a dropped folder does not reopen it.
- With the hosted search servers, no search process runs; search, extract and
  code search answer, and other tools are off until switched on.
- `team_stop` unloads the worker's folder.
- No MCP process exists before the first message, and one exists after it.
- `/refresh` and the tool reload a changed skill and report the cost.
- Pickers and the tree still update within 2 s after an Instructions change
  (T2).

**Live:**
1. Run one owned team with two workers and stop them.
2. Wait past the idle time.
3. The worker folders and their processes are gone and stay gone.
4. Instructions writes take as long as with no workers.

## 5. Instructions changes reach a running chat by themselves, without a cache miss

**What happens today:**
- A Plus Instructions change rewrites a running chat's system prompt or tool
  list at its next request.
  - The role text becomes `agent.system` (`packages/plus/src/instructions/apply.ts:430`).
  - System rows are pushed into the system parts on every request (`apply.ts:1271`).
- Measured in the 1.1.15 cache test (T112, 2026-10-05 08:54Z):
  - turning off build's "Tools and rules" row removed the last system part;
  - the next request read 5,026 of about 12,700 tokens from cache.
- A change earlier in the prompt misses everything. Providers cache by prefix,
  and the request order is tool definitions, then system, then messages.
- Without such changes, caching on 1.1.14 has been flawless in daily use. The
  only misses are about 10 tokens per turn on Gemini, provider-side and
  harmless.
- Core already has the cache-safe mechanism for its own instruction files
  (`core/src/session/instruction-state.ts`):
  - a session keeps an instruction baseline;
  - later changes are added as durable System messages at the end of the
    conversation;
  - a compaction moves the baseline.

  Plus's role and system rows bypass it.

**Must not change:** a chat without mid-chat changes sends byte-identical tool
definitions and system text to today.

**Cost of applying overrides on every request** (measured 2026-10-05, with the
real `apply()` and `context` hook in a temporary benchmark):
- the setup is 40 tools (20 overridden, 5 removed), 10 permission rules
  scrubbed, and a 44 KB system prompt;
- building the plans once, per Instructions change: 5.2 ms;
- applying them per request: 0.79 ms median, 1.05 ms p99.

Overrides add no noticeable latency next to a model's response time, and the
same input always gives the same bytes, so they do not disturb the cache.

**Decisions (user):**
- Changes apply automatically and seamlessly. No refresh step is needed in
  normal use.
- A compaction and a model switch apply everything, since they rebuild the
  cache anyway.
- Changes the human makes in the Instructions page take effect when the page
  closes, as one update, not one per keypress.

**Change ("add now, fold in later"):**
1. **System text.** Plus role text and system rows go through core's
   instruction mechanism. A change during a chat is added as one System
   message at the end: what changed, section by section, saying that it
   replaces the earlier text. The prefix is untouched, so only the change's
   own tokens are new.
2. **Tools.**
   - **Off:** only the permission changes at once: a call is refused with its
     message, and a one-line System note says so. The tool's definition and
     description stay in the prompt unchanged until the next rebuild moment, so
     nothing cached is lost.
   - **Code Mode tools:** core already sends a changed catalogue as an update
     message instead of rewriting the prefix (`core/src/codemode/instructions.ts`,
     `update`). Check that Plus's `catalog` hook changes go through it.
   - **A native tool switched on, a new MCP server, or a changed native tool
     description:** these sit in the tool definitions, which come first, so
     they wait for the next rebuild (item 3 below).
3. **Folded in at rebuild moments.** These rebuild the cache anyway, so at each
   one the prompt is re-rendered cleanly from the current settings, and the
   added notes drop out:
   - a compaction;
   - a model switch;
   - a new chat;
   - the cache having expired, where the Monitor knows the lifetime and the
     chat has been idle past it with keep-alive off.
4. **Instructions page.** Edits are saved as you make them, as today. A running
   chat gets them as one combined update when the page closes. Edits by an
   agent through `tools.instructions.*` apply at that agent's next step.
5. **Nothing to do for changes outside the prompt.** Model activation,
   keep-alive, budgets, team members, delegate permissions and colours apply at
   once.
6. **`/refresh` stays as an escape hatch:** apply everything now, including
   waiting tool changes, at the cost of one cache rebuild. It names that cost
   first. Normal use never needs it.

**Tests:**
- **Unchanged chat:** the tool and system fingerprints are identical to today,
  over several turns.
- **A system-row or role change:** the prefix fingerprints are unchanged, one
  System update message is added, and the model's next request contains it.
- **Folding in:** after a compaction, a model switch or a new chat, the change
  is part of the system text and the notes are gone.
- **A turned-off tool** is refused at once while still listed.
- **A native tool switched on** appears only after a rebuild moment.
- **Several page edits** produce one update message when the page closes.

**Live** (on `claude-opus-5-5`):
1. Send two messages.
2. Change one role section and turn off one system row.
3. The next message reads the whole prefix from cache, and the model follows
   the changed section.
4. After a compaction, the system text holds the change and the next message
   reads the new prefix.

## Open questions for the user

None. Settled on 2026-10-05:
- "cache input" means cache writes (item 2).
- A compaction and a model switch apply pending changes (item 5).
- Search uses the hosted Tavily and Exa servers instead of Plus's own
  (item 4.6).
