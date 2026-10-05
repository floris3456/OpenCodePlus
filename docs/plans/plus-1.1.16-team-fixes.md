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
3. **New tool** `team_budget({ run, tokens?, turns?, wallMs?, reason })`.
   - `reason` is required, 1–300 chars, like `team_stop`.
   - It records `{ at, by, from, to, reason }` in the run's history, and
     `team_status` and the run report show it.
   - Pings stop until the new budget is passed.
   - `team_followup` loses its `budget` input.
4. **Nudge** is `team_followup`: a message only, so the child stays over budget
   and the pings continue. **Stop** is `team_stop` with its reason, as today.
5. Turns and wall-clock budgets use the same mechanism.
6. Recalibrate the effort defaults (small/medium/large) for the new count, from
   the 1.1.15 night's runs. The Brief's budget line names what is counted.
7. Delete the stale `notifyBudget` comment.

**Tests:**
- The count leaves out cache reads, on a real session's tokens.
- **Notification:** the first one fires at the limit, repeats after the
  interval, and is merged into one message for several children. It is never
  sent to the child.
- `team_budget`:
  - refuses an empty reason;
  - writes the history entry;
  - ends the pings until the new limit.
- A nudge does not end the pings.

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
2. **Load on the first message.** A folder's MCP servers, file watchers and
   plugin loops start at the first message of a session there. Opening a TUI
   or listing sessions reads only cheap config (agents, models).
3. **Unload on stop.** A team worker's folder unloads as soon as its run is
   stopped, without waiting 60 minutes.
4. **Refresh.** A `/refresh` command (with a palette entry) and a Code Mode
   tool, for example `tools.opencode.refresh({ parts? })`.
   - It reloads this session's folder: config, agents, skills, commands and MCP
     servers.
   - It reuses the host's existing reloads
     (`packages/core/src/plugin/host.ts`: agents, providers, models, commands,
     mcp, discovery).
   - It has its own permission row, on by default.
5. **No per-folder file watchers.** File changes inside a folder (skills,
   agent files, a project `opencode.json`) show after `/refresh` or in the next
   session.

**Tests:**
- An event for a dropped folder does not reopen it.
- `team_stop` unloads the worker's folder.
- No MCP process exists before the first message, and one exists after it.
- The refresh tool and command reload a changed skill.
- Instructions edits still reach a loaded folder.

**Live:**
1. Run one owned team with two workers and stop them.
2. Wait past the idle time.
3. The worker folders and their processes are gone and stay gone.
4. Instructions writes take as long as with no workers.

## Open questions for the user

1. Item 2: "cache input" is read as cache writes. If it meant cache reads, the
   count changes by little (T92: 10.0M of 10.4M were cache reads).
2. Item 4: keep two process-wide watchers, one for the global config and one
   for the Instructions store? They are cheap, and they keep Instructions edits
   live without `/refresh`. Without them, every edit needs a refresh.
3. Item 4: folder-independent MCP servers such as `search-mcp` could run once
   for the whole service instead of once per folder. That alone would have
   turned 51 processes into 1.
