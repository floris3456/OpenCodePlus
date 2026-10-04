# Prompt for the stand-alone `build` agent

Paste everything below the line into a chat with the native **`build`** agent
(not `Basic › Build`), opened in
`/home/bliss/OpenCodePlus/worktrees/plus-1.1.12/opencode`.

---

You have two jobs, in this order:
- **A:** set up the global team "Simple" exactly as planned.
- **B:** research the team-run bottlenecks further and write a fix plan.

Work without stopping between steps. Ask me only for a decision that only I can
make. Never push.

## Hard rules
- Live system:
  - Do not restart or control the service.
  - Do not open database shells.
  - Do not edit files under `~/.config/opencodeplus/` by hand; configuration
    changes go through `tools.instructions.*` only.
  - Never run `bun run dev:live` or `bun run dev`. A live experiment, if one is
    really needed, runs as `pilotty spawn --name <name> opencodeplus-dev .` in
    its own dev home, and you kill it afterwards.
- Do not change the Basic team, its members or any source file.
- Never print secrets. Frozen run configs and dev homes contain API keys.
- Commit only the files named in job B, with `git commit` and a conventional
  message.

## Job A: create the Simple team

The complete specification is `docs/plans/plus-1.1.12-simple-team.md`. Read all
of it first, then the `instructions-tools` skill. Execute §3 steps 1–8 with the
rows of §4 and the bodies of §5, then verify with §6.

To make it fast and reliable:
1. **One `execute` per plan step.**
   - Inside it, do the writes one after another (`for … of` with `await`, never
     `Promise.all`): the store is revisioned and parallel writes collide.
   - Return only compact results: id, state, and error per row. Do not return
     whole snapshots or trees.
2. **Ids come from results, not from your head.**
   - Use the `id` that `create` returns.
   - Find member rows with `list({ where: "team:Simple agent:<member> …", fields: ["id", "state", "from"], limit: 200 })`.
   - Member rows look like `item:global:Simple/:<member>:<itemId>`. The short
     `item:global:<member>:…` form may not exist while Simple is off.
3. **Models need `team: "Simple"`:**
   `create({ kind: "model", level: "global", team: "Simple", agent, providerID, modelID, variant })`,
   then `set({ id, active: true })`. For the three workers also
   `set({ id, warming: "off" })`. Copy provider, model and variant from §2
   exactly.
4. **Role bodies, verbatim.**
   - Each body is the plan's fenced blocks put together as §5 says, with the
     ```` ```markdown ```` fence lines removed.
   - Replace `[STOP BLOCK]` with the §5.2 text unchanged.
   - Set the whole `system:role` row with `set({ id, text })`.
   - Do not reword, shorten or "improve" any body. Read each one back with
     `show` and compare its first and last lines.
5. **Errors.**
   - A refused call names what it accepts: fix the input and retry once.
   - After `create.failed`, `list` before retrying, because a blind retry
     duplicates.
   - If a row cannot be set by tool (activating a model, a team toggle, a
     number row), finish everything else and give me the exact TUI path. Do
     not invent a workaround outside `tools.instructions.*`.
6. **Order matters.**
   - Turn the team on (step 6) only after every member, description, role,
     model and §4 row is in place.
   - Do the Delegate-to rows (step 7) after that, because they only exist once
     the team is on.
   - Turning Simple on switches Basic off. That is expected.
7. **Report A as one table:** member, model active (yes/no), role set, rows
   set, rows that failed with id and error. Then add the §6 results and what I
   must do in the TUI.

Target: about 15 minutes. If job A stalls on one row, report it and go on to
job B.

## Job B: research the bottlenecks, then write the fix plan

### Starting point
`docs/plans/plus-1.1.12-team-bottlenecks.md` is a report on why the
plus-1.1.12 team run lost 7–9 hours per part on 2026-10-04. Treat each claim as
a lead, not a fact. Confirm it, correct it, or close it, against the source at
`HEAD` and against the evidence:

| Evidence | Where |
|---|---|
| Team audit (JSON lines: `at`, `kind`, `tool`, `ok`, `code`, `durationMs`, run) | `/home/bliss/OpenCodePlus/run/plus/data/opencodeplus/teams/audit.log` |
| Run records: attempts, state history, provider errors | `…/teams/runs/<run>/run.json`, `brief.json` |
| Merge queue entries | `…/teams/runs/<parent>/merge/*.json` |
| Server log (`timestamp=… level=… message="…"`): `location services booted` / `evicted`, `plus team sweep failed`, `warming session`, `failed to warm session` | `/home/bliss/OpenCodePlus/run/plus/data/opencodeplus/log/opencode.log` (the service was restarted around 12:13 UTC; earlier lines are the incident) |
| Audit snapshot (TSV) | `/home/bliss/OpenCodePlus/run/plus/tmp/opencodeplus/audit.tsv` |

Source the report points at:
- `packages/core/src/session/model-transport.ts`: `IDLE_TIMEOUT` exists on the
  WebSocket path only.
- `packages/core/src/session/runner/retry.ts`: `RETRY_AFTER_MAX`.
- `packages/core/src/location-activity.ts`: the 60-minute eviction.
- `packages/core/src/plugin/warming.ts`.
- `packages/plus/src/index.ts`: `startSweep` per plugin instance, near line 172,
  and `decideWarmingFor`.
- `packages/plus/src/teams/lifecycle.ts`: `startSweep`, `gc`, `stopIdle`.
- `packages/plus/src/teams/store.ts`: `lock`.
- `packages/plus/src/teams/merge.ts`: `process`, `withRepoLock`.
- `packages/plus/src/teams/api-lifecycle.ts`: `stopHandler`.
- `packages/plus/src/teams/api-followup.ts`.
- `packages/plus/src/teams/schema.ts`: `timeouts.stallMs`, `sweep.tickMs`.
- `packages/plus/src/warming.ts`.

### Questions to close
1. Why did HTTP model streams go silent for up to 66 minutes?
   - Where exactly should a no-data timeout sit: the core `exchange.fallback()`
     path, or the `@opencode/ai` HTTP route?
   - Is there an existing timeout seam to reuse?
2. How does the rate-limit retry decide its waits?
   - What does a quota-exhausted 429 body look like?
   - What threshold separates "retry" from "fail now and tell the parent"?
   - How can `team_status` show "retrying until …"?
3. Why are workspaces never unloaded?
   - Do warming pings, the team sweep or something else keep publishing session
     events for finished runs?
   - Why do evicted orchestrator workspaces boot again within the same second?
4. Lock jam:
   - Confirm that one sweep runs per loaded workspace, and measure what one
     `gc` pass costs.
   - Design: one sweep per server process; the repo lock only when an orphan
     candidate exists; fair waiting; a landing that loses the lock retries the
     landing alone and keeps its verified checks; leftover merge worktrees are
     removed.
5. `team_stop` and `team_supersede`:
   - Make them end that session's cache warming and let its workspace unload.
   - Make `team_followup` refuse a run that its parent stopped.
6. Interrupted runs: should a team run interrupted by `inactivity` resume by
   itself, or be exempt from eviction once silent steps are bounded (fix 1)?
7. T41: why did `team_finish` report four checks red while `team_check` passed
   them at the same HEAD? Close it or mark it unexplained, with what you
   checked.
8. Anything else the evidence shows that the report missed.

**Research budget:**
- Prefer reading source and grepping the logs.
- Run only focused tests: `bun test <file>` from the package directory, never
  from the repository root, and never the whole suite.
- Run a live experiment only if a cause cannot be established otherwise.
- Stop researching a question after about 20 minutes. Record it as "not
  established", with what you tried.

### What to write
1. **Append** a section `## Follow-up research (2026-10-04)` to the report.
   - Per question: the answer, the evidence (file:line, log line or record),
     and any correction to the earlier text.
   - Mark a corrected claim in place with "(corrected below)" rather than
     deleting it.
2. **Write `docs/plans/plus-1.1.12-team-fixes.md`**, which a Simple
   orchestrator will execute with workers:
   - Start with a line `**Objective:**` that states the outcome.
   - Then the tasks. Each has:
     - its end state;
     - exact paths, tests included;
     - the interfaces it touches as `file#symbol`;
     - the decisions that close the questions above;
     - an effort (small, medium or large);
     - focused checks. The project names no checks, so give the
       `bun test <file>` and `bun typecheck` commands, with the package
       directory.
   - Split tasks only where one could be rejected while its neighbour is
     approved. Fold scaffolding into the task that needs it. No placeholders.
   - Give the order and the dependencies between tasks. Say which tasks can
     run in parallel.
   - Name overlaps with the unmerged plus-1.1.12 branches (instructions and
     monitor both touch `packages/plus`), listed in the appendix of
     `docs/plans/plus-1.1.12-simple-team.md`.
   - Put live tests in their tasks: what to start, the steps, what must be
     seen.
   - Say that the fixes take effect only after a release is built and
     activated. That is my job.
   - Leave out the Brief-friction items the Simple team configuration already
     handles (scopes, test files, worker shells, checks machinery). Keep the
     misleading error for a relative `briefFile` (it reports `E_PATHS` as a
     scope error).
3. Commit both files in one commit,
   `docs(plans): plus-1.1.12 team fixes plan and follow-up research`, on the
   current branch. Do not push.

## Final message to me
- Job A: the table, the §6 results, and my TUI steps.
- Job B, in at most 15 lines:
  - what the research changed in the report;
  - the task list with efforts;
  - the open decisions I must make;
  - the commit sha.
