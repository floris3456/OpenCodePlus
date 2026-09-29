# Cache warming per agent, model and chat — evidence

Branch `cache-warming`, based on local `instructions-fast` (`2bc1ffbd8`). Local only: not pushed, released or installed.

## Request

Core's cache warming ("pinging") sends keep-alive requests after a chat's latest real request so the provider prompt
cache stays warm. The request asked for:

1. a countdown in the UI showing how long until warming stops;
2. a keyboard shortcut to switch it on or off for one chat;
3. a setting on the Models tab that goes with each agent's model, so that projects, models and agents can differ,
   including two agents on the same model in one project with different total times.

## What changed

- **Core** (`packages/core/src/plugin/warming.ts`, `packages/plugin/src/effect/session.ts`): a new mutable session
  hook `warming` (`SessionWarming { sessionID, agent, model, phase: "activity" | "warm", since, now, settings }`).
  Core runs it when a real request starts the window and again before each keep-alive request. A plugin can switch
  warming off, turn it on where the configuration leaves it off, or change the total time; at `warm` the window is
  re-timed from `since`. With no hook registered, behaviour is unchanged: all 13 existing warming tests pass.
- **Plus model rows** (`instructions/model.ts`, `ops.ts`, `tree.ts`, `store.ts`, `rpc.ts`, `tools.ts`): a
  `ModelRecord.warming` value (`off`, `on`, or a total time from 1m to 24h such as `45m`, `2h` or `1h30m`), set with
  `w` on a Models row, or with `instructions.set({ id, warming })`. It is stored at the level you are on and resolved
  down the agent's chain, like the active model. The row shows `warm 2h`; the inspector shows
  `warming  2h · set at Project`.
- **Plus decision** (`src/warming.ts`, `index.ts`): the per-chat switch wins, then the agent's model row, then the host
  configuration. The per-chat switch persists in `$XDG_DATA_HOME/opencodeplus/warming/chats.json`. RPC
  `warming.status` / `warming.set` and event `warming.changed` were added.
- **TUI** (`src/tui/warming.tsx`, `tui/index.tsx`): under the prompt, `cache warm · 23:41 left`,
  `cache warming off`, or `cache warming on · starts after the next reply`. `ctrl+x k` (`plus.warming.toggle`)
  switches the current chat; the palette command `plus.warming.follow` returns the chat to its model settings.

## Tests (observed)

- `packages/core`: `test/plugin/warming.test.ts test/config/warming.test.ts test/plugin/supervisor.test.ts
  test/plugin/supervisor-reload.test.ts` → 39 pass, 0 fail. Six new hook tests cover: off at activity (with an
  on-control on the same session), enabling where the configuration is off, a raised total time, a stop before a
  keep-alive request, a shortened total time before a keep-alive request, and the phase/since/agent/model the hook
  sees. Failure control: with the hook result ignored in core, 5 of the 6 fail (the observation-only test passes).
- `packages/plus`: `test/warming.test.ts` (11 tests) covers parsing and its refusals, the switch > row > config order,
  two agents on one model with 45m and 2h, a project row over the global row while another project keeps the global
  value, variant fallback, planting and clearing a row, `w` on a real tree row and its refusals, the hook's row lookup
  per agent, the store window and countdown, the switch persisting across a new store instance, and the footer text.
  Failure control: letting the model row beat an `off` switch makes 2 of these fail. `test/tools.test.ts` adds
  `set warming` through the real store (value, row badge, record view, refusals leaving the store unchanged, clearing).
- Whole `packages/plus` test files plus `test/teams`: 1517 pass, 13 skip, 8 fail. All 8 fail the same way on
  `instructions-fast`:
  - `teaching.test.ts`: 2;
  - `test/teams`: 3 (followup ×2, run state machine);
  - `apply.test.ts` "a model update for a current team agent missing from the registry still lands";
  - `permission-enforce.test.ts` "tableActive installs the hooks only while…";
  - `team-query-off.test.ts` "off on team.diff for a defaults-level team agent…".
- Test harness adjustments, not weakened checks: the plugin-commands harness passes slot props, the RPC contract
  lists the two methods and the event, and the child-worktree activation test gives the entrypoint a session-hook
  stub, since the plugin now registers the warming hook.
- `bun typecheck` (plus, core, plugin) clean; `TURBO_FORCE=true bun run check`: oxlint 0 warnings / 0 errors, 36/36
  tasks.

## Live lab (owned, throwaway)

`run/plus/tmp/opencodeplus/warming/lab-up.sh` starts this worktree's server and TUI in `run/tmp-build/warm-lab`. It
copies no user configuration or credentials, and it talks to a local mock OpenAI-compatible provider
(`mock-provider.ts`) that logs every request. Configuration: `warming: { interval: "20 seconds", duration: "3 minutes" }`.
The live service was not used. Steps and observations (mock log kept as `lab-mock.log`):

1. A message in a new chat: the footer showed `cache warm · 2:55 left`, and the mock log showed a keep-alive request
   20 s later. 25 s later the footer read `2:27 left`.
2. `ctrl+x k`: toast `Cache warming off for this chat`, footer `cache warming off`. One keep-alive request was already
   in flight 0.3 s before the key press. After that, no request arrived in the next 45 s, where the schedule would have
   sent two.
3. `ctrl+x k` again: footer `cache warming on · starts after the next reply`. The next message showed `2:56 left`.
4. Instructions → build → Models → add `mock/m1`, then `w` → `1m`. The row showed `warm 1m ◆` and the inspector
   `1m · set at Project`. After `Cache warming: follow the model settings`, a message showed `0:57 left`. RPC
   `warming.status` reported `source: model, level: project`, with `expires − since = 60000`.
5. The same for plan on the same model with `2m`. A message as Plan showed `1:57 left`, and `expires − since = 120000`.
   Keep-alive requests arrived at 20 s steps and stopped at the 2-minute end: the last was at 08:16:09, and the window
   ended at 08:16:28.
6. The footer stayed after opening and closing the palette and after visiting Instructions (0:56 → 0:54 → 0:48).
7. The chat switch was written to `chats.json`, and it read back as `chat: "on"` from `warming.status` after the lab
   server was stopped and restarted.

All lab processes were stopped by PID after their environment was checked against the lab home (none remain).

## Limits and risks

- A window only starts with a real request: switching a chat on does not send a request by itself, and the footer
  says so. Switching off takes effect before the next keep-alive request; a request already in flight still completes.
- Keep-alive requests are real provider requests and cost tokens; longer total times allow more of them. Totals are
  limited to 1m–24h.
- The countdown shows the window from the last decision seen by the Plus instance serving the TUI's directory. A
  session running in another directory is refreshed by a 15 s poll, not by events.
- The live service still runs r4.8; nothing here is active until a release is built and installed through
  `opencodeplus-release`.
