# plus-1.1.18 / 1.1.19: Monitor load, then model rows with Warming and Compaction, cold-cache compaction

1.1.18 = the Monitor fix (section 1, WP-A) and the warming-window fix
(section 1b, WP-W). 1.1.19 = sections 2–9 (WPs B–E, G). The split was decided
by the user; see Decisions.

Base: `aa1927c988` (= `v2.0.18-plus-1.1.17`). Integration branch `plus-1.1.18`
(worktree `worktrees/plus-1.1.18/opencode`). Work packages (WPs) run in
`worktrees/p118-<wp>/opencode`, branch `p118-<wp>`, cut from the integration
branch. Analysis evidence: `run/evidence/plus-1.1.18/analysis/`.

Requests (user, 2026-10-07, on the installed 1.1.17):

1. The Monitor window does not load.
2. In the model section, an option for "compact before cold" (today only
   `<leader>j` / `/compact-warm` per chat), so it can be on or off by default.
3. Compaction is no longer its own agent tab. It becomes a category inside each
   model row, so compaction follows the model. The same applies to
   Defaults › Models. Warming also becomes its own category there.
4. Under Warming: "Always compact cold caches with a different model", on or
   off. It holds a list of models that is empty by default. `a` adds one, and
   the list is numbered 1, 2, …, tried in that order (fallbacks).
5. "Ping every" asks for a typed value in a window. Elsewhere Instructions
   uses dropdowns and single values, so this is inconsistent.
6. A command that compacts now with the cold-cache model configured for the
   chat's model, at Project, Global or Defaults.
7. Why did warming show 1h15m when this chat's model is set to 50m? (section 1b)
8. When a credential runs out, the forced compaction must use the cheap models,
   and the chat must show which model wrote the summary. (sections 4 and 7)
9. A notification when a cache miss happens, which says to type `/monitor`.
   (section 9)

## 1. Monitor does not load (measured)

Evidence: `run/evidence/plus-1.1.18/analysis/monitor-load.md`.

- **Symptom.** The full Monitor opens in session scope on the chat it was
  opened from. On this build-seat chat (1,633 requests) `monitor.query`
  takes 37 s on the live service, so the view shows "Loading monitor data…"
  for that long. The same query within a second takes 30 ms (cached). Tree
  scope takes 5.5 s.
- **Reproduced offline** on a copy of `monitor.db` with this source: 34.9 s.
  99% of the profile is `analyzeSession → timingStep → findLast(refreshes) → prefixDiff`.
- **Causes:**
  1. `timingStep` diffs against *every* earlier request when the previous one
     does not refresh the prefix. That is always the case with rolling
     Anthropic breakpoints, so it is O(n²) diffs.
  2. The `prefixDiff` tail check (#13) is a nested linear search, O(m²) per
     diff, with about 1,500 message segments per request.
  3. The analysis cache is keyed on the whole ledger's revision. Any write,
     from any chat, invalidates it, and the Monitor polls every 1 s while
     live, so it recomputes back to back.
  4. From reading the code: `queryMonitor` is synchronous (bun:sqlite plus JS),
     so each recomputation blocks the shared service's event loop.
- **Fix:**
  - (a) In `timingStep`, search for a refreshing request only after `lastWarm`.
    An older match cannot change `max(refreshed, goodPing, lastWarm)`, so the
    result is the same.
  - (b) Per fingerprint, compute once a Set of segment keys and each segment's
    message index (no regex in the loop). Memoise `prefixDiff` per request
    pair within one analysis.
  - (c) Key the analysis cache per session: that session's request,
    fingerprint and fact change marks. Make it incremental: requests before
    the first changed one keep their verdicts, since a verdict depends only
    on earlier rows and its own.
  - (d) Measure again. If a cold analysis of the largest real session is
    still above about 250 ms, yield to the event loop between chunks.

  A temporary edit with (a) and the Set part of (b) took the query from 34.9 s
  to 2.2 s. The remaining time is the Set building and the regex that (b)
  removes.
- **Proof of the same results:** old against new verdicts, causes, expected
  and miss tokens for every session in a copy of the real `monitor.db`
  (offline, kept under `run/`, never committed). Also a golden test with a
  generated long Anthropic session (about 1,500 requests × 1,500 messages):
  the expected verdicts are recorded from the current code before the change,
  plus a generous time bound (the old code takes more than 30 s).
- **Later, separate WP:** `request_fingerprint` stores every message's prefix
  hash on every request. That is O(n²) bytes per chat: `monitor.db` is 2.06 GB,
  1.93 GB of it fingerprints. Store each row as a delta against the previous
  row of the same session.
- **Until it ships:** close the Monitor when not in use (it polls every 1 s).
  Opened from a short chat, or switched to Project scope, it loads quickly.

## 1b. Warming window stuck at 75 min after a turn (WP-W, 1.1.18)

- **Seen once on the live service.** After this chat's turn ended at 15:20:15Z,
  all five keep-alives up to 15:40 kept the 75-minute "chat is working" window.
  The chat's own setting is 50m, rounded up to 52m in whole 4-minute pings.
  Evidence: `run/evidence/plus-1.1.18/analysis/warming-75-after-turn.md`.
- **Not reproduced since.** It dropped correctly in each of these:
  - the dev server, with 1 folder and with 7 folders and a 5.5-minute turn;
  - the live service after 16:00:57 and after 16:37 (`livewatch*.txt`).
- **The only path to 75 when idle** is `waiting()`. So the busy flag that the
  `session.execution.*` events maintain stayed set after the turn ended. Each
  location's Plus instance maintains that flag in its own event stream. A
  delayed or out-of-order event, or a missed one, leaves the flag set until the
  chat's next turn ends.
- **Fix, independent of the cause:**
  - At each keep-alive, `waiting()` asks core whether the chat, or anything it
    started, is running now. Core already keeps that state for
    `/api/session/active`; the fix needs a small read in the plugin context
    (`session.active`).
  - The event-driven set stays as the fast path, but it can no longer keep a
    window at 75 min on its own.
- **Footer.** When a turn ends, Plus re-decides at once, so the footer shows
  the configured window then, not at the next keep-alive. Core applies the
  same window at that keep-alive, which always comes before either window
  ends.
- **Tests:**
  - Unit: a stale `started` without `succeeded` gives the configured window
    at the next keep-alive.
  - Live: three idle gaps on the dev server, each dropping to the configured
    window.

## 2. Model rows: Model, Effort, Warming ▸, Compaction ▸

Today an agent (or member, or preset) model row opens into Model, Effort,
Warming, Ping every and Keep-alive prompt. Compaction (Strategy, Model,
Instructions) is a tab per agent, so a different model keeps the agent's
compaction.

New layout, the same for agent, member and preset model rows and for
Defaults › Models rows (those have no Model field):

```
▾ cliproxyapi/claude-opus-5-5@xhigh          active · warm 50m · every 4m
    Model                cliproxyapi/claude-opus-5-5@xhigh
    Effort               xhigh
  ▾ Warming              50m · every 4m
      Warming            50m · global
      Ping every         4m · defaults
      Keep-alive prompt  This is a keep-alive…
      Compact before cold                       off · built-in
    ▾ Compact cold caches with another model    on
        1 cliproxyapi/gemini-3.8-flash-high
        2 cliproxyapi/deepseek-v4.1-flash-cheap
  ▾ Compaction           Auto
      Strategy           Auto
      Model              Inherited model
      Instructions       Empty prompt
```

- **Tabs.** The Compaction tab goes. Agent tabs become 1 Settings, 2 Models,
  3 Tools, 4 Base, 5 System (then MCP and user categories). The digits after
  Models shift by one; the help text and the hints say so.
- **Warming and Compaction are group rows.** The tree already has nested
  groups under an item: the 1.1.17 Parameters group under a tool row. A
  group's summary shows the effective values; Space on a group does nothing
  (its fields differ in kind).
- **Defaults › Models** rows (Every model and each model) get the same
  categories. `Effort` there becomes a dropdown, like the agent rows (today it
  is typed).

### Storage (no data migration)

New optional fields, stored as strings or lists like the existing warming fields:

| Field | `ModelRecord` (agent/member/preset row) | `ModelSettingsRecord` (Defaults › Models) |
| --- | --- | --- |
| `compactWarm` | `"on"` / `"off"` | same |
| `coldCompact` | `"on"` / `"off"` | same |
| `coldModels` | `["provider/model[#variant]", …]` in try order | same |
| `compactionStrategy` | `auto` / `local` / `remote` | same |
| `compactionModel` | `provider/model[#variant]` | same |
| `compactionInstructions` | text | same |

Absent means inherit. A store without these fields behaves exactly as 1.1.17,
and no request changes.

### Resolution, field by field (as warming does today)

- **Warming fields** (`compactWarm` and `coldCompact` join them): the agent's
  model row down its chain (project → global → defaults, presets as today),
  then Defaults › Models › this model, then Every model, then opencode.json,
  then built-in.
- **`coldModels`** inherits as a whole list: the first layer that sets a list
  wins. `a` on an inherited list copies it to this level and appends.
  `r` drops this level's list.
- **Compaction fields:** the agent's model row chain, then the agent's
  existing agent-wide `compaction:*` rows (the old tab's values, still
  applied), then Defaults › Models › this model, then Every model (also the
  existing shared Defaults `compaction:*` rows), then opencode.json or the
  compaction maintenance agent, then built-in.

  Old values show as the inherited source ("· agent-wide", "· every agent")
  and are not rewritten. The real global store holds one such row (preset
  planner, strategy auto). The UI no longer writes agent-wide compaction; the
  tools API still reads and resets it.

### Applying per-model compaction at run time (core change, WP-B)

Core reads compaction from `agent.info.compaction`, once per agent. Per model,
the `compaction.decide` hook (which already carries `agent` and `model`) gains:

- `strategy?` and `system?`, which override the agent's for this compaction.
- `compactionFallbacks?: Model.Ref[]`, tried in order after `compactionModel`
  fails. The single `compactionFallback` stays and means a list of one.
- `optional?: boolean`. When every model fails, the step continues without
  compacting (and records the failures) instead of failing the step. Cold
  compaction is a saving, not a precondition.

Plus resolves the fields above for (agent, chat model) at that hook. Core
tests: fallback order, strategy override, system override, the
portable-and-remote refusal, optional continuing.

## 3. Compact before cold as a model setting

- The new field `compactWarm`, shown as "Compact before cold" under Warming,
  sets the default for every chat on that model. Space toggles it; `r`
  inherits. Built-in default: off, as today.
- The per-chat switch becomes on, off or default (today it is a set of chats
  switched on, in `compact.json`; existing entries read as "on").
  - `<leader>j` / `/compact-warm` flips the effective value for this chat.
  - "Cache warming: follow the model settings" resets both chat switches to
    default.
- The footer and `warming.status` name the source: "compact before cold ·
  model setting" or "· this chat".

## 4. Compact cold caches with another model

- **Row.** "Compact cold caches with another model" is under Warming. Space
  turns it on or off. It opens into the numbered model list:
  - empty by default ("no models · a adds one");
  - `a` opens the catalogue picker (provider → model → variant);
  - `d` removes a model and `m` moves it; the numbers are the try order.
  - On with an empty list does nothing, and the row says so.
- **When it fires.** At the first step of a new prompt in a chat whose cache is cold:
  - **Cold** means the chat's warming window has ended (the same signal as the
    footer's "cache cold"). For a chat without a window, it means the time
    since its last request is longer than the model's cache lifetime
    (`cacheLifetime` from the monitor). An unknown lifetime is never treated
    as cold.
  - A running chat is never cold.
  - A chat compacted since its last request is skipped: compact before cold
    already did the work.
- **How.** Through `compaction.decide`, Plus sets `compact`, `portable` (a
  local text summary, as the team path does today), `compactionModel` = #1,
  `compactionFallbacks` = #2…, and `optional`.
  - The chat keeps its own model; only the summary is written by the cheap model.
  - If every model fails, the prompt still runs, uncompacted, with a notice in
    the chat.
- **TUI.** While cold, the footer names what happens next: "cache cold ·
  compacts with gemini-3.8-flash-high first".
- **Teams (small, proposed).** A followup to a stopped, cold child without
  `compactWith` uses the child's model list instead of refusing with
  `E_STOPPED`, and still refuses when that list is empty.
- **Account switch (CPA).** When CPA moves a chat to another account because a
  credential ran out, the new account's cache is cold, so this is the same case
  as a cold cache.
  - Today the CPA plugin (`packages/cliproxyapi`, `quota/controller.ts`) arms
    that compaction with its own `compactionModel` and `compactionFallback`
    and marks it `metadata["quota.switch"]`.
  - Plus's `compaction.decide` sees that mark. When the chat model's list is
    not empty, it replaces the models with #1, then #2… When the list is
    empty, CPA's own models stay, as today.
  - Plus must run after CPA in the hook order. Check the order and test it.
  - CPA's "Compacting with X (fallback Y) first" notice must name the models
    that are actually armed, so it is built after the decision.
  - Seen live on 2026-10-07 at 16:10:56: deepseek-v4.1-flash-cheap (429), then
    gemini-3.8-flash-high. Opus did not write the summary, but nothing in the
    chat said which model did (`run/evidence/plus-1.1.18/analysis/account-switch-compaction.md`).

## 5. `/compact-cold`: compact now with the cold-cache model

- Slash `compact-cold` with a palette entry; RPC `compaction.cold({ sessionID })`.
- It resolves the list for the chat's agent and current model (Project →
  Global → Defaults, as in section 2), arms it like section 4, and asks core
  for a manual compaction.
- It works on a warm or cold chat. On a running chat it lands at the next step
  boundary.
- No list: a toast names where to add one ("Instructions › … › Warming ›
  Compact cold caches with another model, a adds").
- The toast and the chat show which model wrote the summary, and any fallback.

## 6. Consistent controls (Ping every, Warming, Effort, Compaction model)

Today Warming, Ping every and the Defaults › Models Effort open a free-text
window with format rules ("30s to 24h, e.g. 4m or 3m30s"). Model and the agent
Effort open dropdowns, Strategy cycles, and on/off rows take Space.

Proposed, for the same kind of value everywhere:

- **Ping every:** a dropdown. "Inherit (now 4m · defaults)", then values
  below the model's cache lifetime when it is known:
  - 5m cache: 1m, 2m, 3m, 4m, 4m30s
  - 30m: up to 25m
  - 1h: up to 55m

  then "Custom…", which opens today's one-line prompt.
- **Warming:** a dropdown. Inherit, Off, On (keep the time below), 15m, 30m,
  45m, 1h, 1h30m, 2h, 4h, 8h, Custom…; the rounding note stays. Space toggles
  on and off.
- **Effort (Defaults › Models):** a dropdown, as on agent rows.
- **Compaction › Model:** the catalogue picker plus "Inherit" (today a typed
  `provider/model`).
- **Strategy** keeps cycling. **Keep-alive prompt** and **Instructions** keep
  their text editor.

## 7. Every compaction line names its model

- Today the chat's compaction line shows only "Compaction · 198,713 in · 1,666
  out", or "✗ Compaction · Go usage limit exceeded", while the footer shows the
  chat's own model. A summary written by a cheap model looks like the chat
  model wrote it.
- **Core (WP-B).** A failed compaction records the model it tried. Today only
  a completed one has `model`. Each fallback attempt is already its own
  compaction message.
- **TUI (WP-D).** Show the model on every compaction line, completed or failed:
  - "Compaction · gemini-3.8-flash-high · 198,713 in · 1,666 out"
  - "✗ Compaction · deepseek-v4.1-flash-cheap · Go usage limit exceeded"

## 9. Cache-miss notice (WP-G, 1.1.19)

When a step in the chat on screen misses the cache, the TUI shows a toast:

> Cache miss · 384,815 tokens not reused · account changed · type /monitor for details

- **What counts as a miss.** The Monitor's own test (`isMiss`: verdict
  `miss` or `partial`; a drop below 1,024 tokens is rounding). The toast and
  `/monitor` therefore always agree.
- **The cause** is the Monitor's cause for that step, in words:
  - after compaction (expected)
  - model switched
  - agent switched
  - prompt changed (with the first changed part)
  - cache expired
  - account changed
  - unknown

  Today the Monitor ranks "compacted" above "account changed"
  (`cache.ts`, the cause chain). So the 16:11:20Z step would read "after
  compaction". When that compaction was armed by an account switch (the
  compaction's `quota.switch` metadata), the cause is "account changed ·
  compacted first", in the toast and in `/monitor`.
- **When.** Once per step, when the step's usage is recorded. It analyzes only
  the new step, using WP-A's per-chat incremental analysis, never the whole
  history. It sends no request and does not touch the prompt.
- **Scope.** The chat on screen. A subagent's or team worker's miss shows when
  that chat is on screen, and always in `/monitor`.
- **Off switch.** It is on by default and can be turned off; WP-G decides where
  the switch lives.
- **Why.** Upstream's "turn token usage" developer view showed the
  16:11:20Z account switch as a plain 384,815-token bust. The Monitor knows the
  cause; the toast brings it up when it happens.

## Cache safety (every WP)

None of these settings may change a chat's request prefix. Edits are model
settings, not instructions, so no steered note and no rebuild. Check it the
way 1.1.17 checked Parameters: the request bodies the provider receives
before and after an edit, captured by a local endpoint, must be identical
until a compaction actually runs. A store with no new fields must send
byte-identical requests.

## Work packages

| WP | Release | Content | Depends on |
| --- | --- | --- | --- |
| A `p118-monitor` | 1.1.18 | Section 1 (a)–(d), the comparison over the real-DB copy, the golden test | none |
| W `p118-warming` | 1.1.18 | Section 1b: `waiting()` checks core's running state, plugin-context `session.active`, footer re-decides at turn end, tests | none |
| B `p119-core-compact` | 1.1.19 | Decision overrides `strategy`, `system`, `compactionFallbacks`, `optional`; a failed compaction records its model (section 7); core tests | none |
| C `p119-model-fields` | 1.1.19 | Record fields, validation, resolution, decide-hook application, per-chat compact switch, cold detection and arming, account switch uses the model's list (section 4), CPA notice names the armed models, `compaction.cold` RPC, team followup default | B |
| D `p119-model-tui` | 1.1.19 | Model row categories, Compaction tab removed, list rows (a/d/m), dropdowns (section 6), footer text, model on every compaction line (section 7), `/compact-cold` | C (types), can start on fixtures |
| E `p119-docs` | 1.1.19 | `tools.instructions` ids for the new fields (`modelfield:<field>:…`, `modelsetting:<field>:…`, list as comma text), `teaching.ts`, `tools.ts`, the `instructions-tools` skill, help and descriptions | C |
| G `p119-miss-toast` | 1.1.19 | Section 9: per-step miss verdict on record, toast in the chat on screen, the off switch | A |
| F (later) `monitor-store` | later | Fingerprint deltas, migrating as rows are read | A |

## Acceptance (live, as in 1.1.17)

1. **Monitor on this chat:**
   - opens in under 1 s cold, and refreshes at no cost while unchanged;
   - `/api/info` latency stays under 100 ms while the Monitor polls a running
     chat;
   - verdicts are identical to 1.1.17 over the real-DB copy.
2. **Tree layout:**
   - a model row shows Model, Effort, Warming ▸ and Compaction ▸;
   - there is no Compaction tab;
   - Defaults › Models is the same;
   - old agent-wide compaction shows as inherited.
3. **Controls:** dropdowns for Ping every, Warming, Effort and Compaction
   Model; Custom… still takes a typed value.
4. **Compact before cold:**
   - on for a model: a new chat counts down "compact cache warm" without
     `<leader>j`;
   - `<leader>j` turns it off for that chat;
   - follow resets it.
5. **Cold compaction (local Qwen, a 2-minute window; a fake 429 endpoint as
   model #1):**
   - after the window ends, a message compacts with #1 (shown in the Monitor);
   - #1 failing falls to #2;
   - all failing still sends uncompacted, with the notice;
   - the main request then carries the compacted prefix.
6. **`/compact-cold`:** on a warm chat it uses #1; with no list it shows the
   toast; it does not change the chat's model.
7. **Prefixes:** provider-received bodies are unchanged by every settings
   edit (cache-safety rule).
8. **Account switch:** a fake CPA switch on a chat whose model has a list:
   - the summary is written by #1, then #2 when #1 fails;
   - with an empty list, CPA's own models write it;
   - the notice and every compaction line, including failed ones, name the
     model.
9. **Warming after a turn (1.1.18):** in three idle gaps after a turn, the
   footer and the next keep-alive show the configured window, not 75 min.
10. **Cache-miss toast (local Qwen):**
    - an instruction edit mid-chat gives a toast with "prompt changed" and
      the changed part, and `/monitor` shows the same step as a miss;
    - a step that hits shows no toast;
    - with the switch off, no toast.

## Decisions (user, 2026-10-07)

1. **Monitor fix first.** WP-A ships alone as 1.1.18, from this branch. WPs B–E
   follow as 1.1.19 on a branch cut after it. WP-F comes later.
2. **Ping every and Warming:** a dropdown plus Custom…, as in section 6.
3. **Sending into a cold chat with cold compaction on:** keep the "enter again"
   confirmation; the footer says "cache cold · compacts with <model> first".
4. **Agent-wide compaction:** per model only. The old tab's values still apply
   and show as inherited; there is no "Every model" row per agent.
5. **Account switch (CPA):** uses the chat model's "Compact cold caches with
   another model" list first. When that list is empty, it uses CPA's own
   `compactionModel` and `compactionFallback`.
6. **Cache-miss notice:** a toast for each missed step that names the cause and
   says to type `/monitor` (section 9). The user turns off upstream's "turn
   token usage" view.
7. **Warming-window fix in 1.1.18** with the Monitor fix (section 1b), as
   reported to the user.
