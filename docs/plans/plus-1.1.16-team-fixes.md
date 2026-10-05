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
  - Read here as: input + cache writes + output, with reasoning counted as
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

**Tests:**
- An event for a dropped folder does not reopen it.
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

## 5. A running chat keeps its prompt until a refresh

**What happens today:**
- A Plus Instructions change rewrites a running chat's system prompt and tool
  list at its next request.
- Measured in the 1.1.15 cache test (T112, 2026-10-05 08:54Z):
  - turning off build's "Tools and rules" row removed the last system part of
    the next request;
  - it read 5,026 of about 12,700 tokens from cache.
- A change earlier in the prompt misses everything. Providers cache by prefix,
  and the request order is tool definitions, then system, then messages. A tool
  or role change therefore costs the whole conversation, for Anthropic, OpenAI,
  DeepSeek and Gemini alike.
- Without such changes, caching on 1.1.14 has been flawless in daily use. The
  only misses are about 10 tokens per turn on Gemini, provider-side and
  harmless.

**Must not change:** a chat without mid-chat changes sends byte-identical tool
definitions and system text to today.

**Decisions (user):**
- An explicit `/refresh` keeps this simple and makes the cache cost a
  deliberate choice.
- Changes that cannot affect the cache must not need a refresh.

**Change:**
1. **A chat keeps its prompt.** It keeps the Plus-rendered system parts and
   tool definitions it started with, stored with the session, until one of:
   - `/refresh`;
   - a compaction, which rebuilds the cache anyway (core already moves its
     instruction epoch there);
   - a model switch, which starts a new cache anyway.

   A new chat always starts from the current settings.
2. **What waits is computed, not listed.** After an Instructions write, render
   each running chat's tools and system from the new settings and compare them
   with what it sends now, using the Monitor's segment fingerprints.
   - Equal: nothing to do.
   - Different: the change is pending for that chat.
3. **Everything outside the prompt applies at once.** That includes model
   activation, keep-alive, budgets, team members, delegate permissions and
   colours. When such a change also shows in a tool description (for example a
   worker list), only that description waits.
4. **Safety first.** A permission that turns something off is enforced at once
   at the call, refusing with its message, even while the old tool description
   is still in the prompt. Turning a tool on waits for the refresh.
5. **Visible.** The TUI shows pending changes in that chat's footer, for
   example "Instructions changed · /refresh re-reads ~48k tokens". An agent
   that changes Instructions gets the same note in the tool's result, so it can
   call refresh when it wants the change now.
6. **Instruction files are untouched.** Core's own instruction files
   (`AGENTS.md` and the like) already add changes as messages without touching
   the prefix. They stay as they are.

**Tests:**
- **Unchanged chat:** the tool and system fingerprints are identical to today,
  over several turns.
- **Pending:** set only when the rendered prefix differs; a keep-alive or
  model-activation change sets none.
- **Applying:** `/refresh`, a compaction and a model switch each apply pending
  changes and clear them. A new chat gets the new prompt.
- **Deny:** a turned-off tool is refused at once while still listed.

**Live** (on `claude-opus-5-5`):
1. Send two messages.
2. Turn off a system row.
3. The next message still reads the whole prefix from cache, and the footer
   shows the pending change.
4. Run `/refresh`: the next message rebuilds the cache once, and the one after
   reads it again.
5. Change a keep-alive time: nothing is shown as pending.

## Open questions for the user

1. Item 2: "cache input" is read as cache writes. If it meant cache reads, the
   count changes by little (T92: 10.0M of 10.4M were cache reads).
2. Item 4: run folder-independent MCP servers such as `search-mcp` once for the
   whole service instead of once per folder? That alone would have turned 51
   processes into 1.
3. Item 5: should a compaction and a model switch apply pending changes by
   themselves, since the cache is rebuilt then anyway? Or only `/refresh`?
