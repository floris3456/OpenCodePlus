# plus-1.1.18: Monitor load, model rows with Warming and Compaction, cold-cache compaction

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

## Cache safety (every WP)

None of these settings may change a chat's request prefix. Edits are model
settings, not instructions, so no steered note and no rebuild. Check it the
way 1.1.17 checked Parameters: the request bodies the provider receives
before and after an edit, captured by a local endpoint, must be identical
until a compaction actually runs. A store with no new fields must send
byte-identical requests.

## Work packages

| WP | Content | Depends on |
| --- | --- | --- |
| A `p118-monitor` | Section 1 (a)–(d), the comparison over the real-DB copy, the golden test | none |
| B `p118-core-compact` | Decision overrides `strategy`, `system`, `compactionFallbacks`, `optional`; core tests | none |
| C `p118-model-fields` | Record fields, validation, resolution, decide-hook application, per-chat compact switch, cold detection and arming, `compaction.cold` RPC, team followup default | B |
| D `p118-model-tui` | Model row categories, Compaction tab removed, list rows (a/d/m), dropdowns (section 6), footer text, `/compact-cold` | C (types), can start on fixtures |
| E `p118-docs` | `tools.instructions` ids for the new fields (`modelfield:<field>:…`, `modelsetting:<field>:…`, list as comma text), `teaching.ts`, `tools.ts`, the `instructions-tools` skill, help and descriptions | C |
| F (later) `p118-monitor-store` | Fingerprint deltas, migrating as rows are read | A |

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

## Open decisions (asked 2026-10-07; answers recorded below)

1. Ship the Monitor fix (WP-A) on its own first, or with the rest.
2. Ping every and Warming: a dropdown plus Custom… (proposed), a dropdown
   only, or typing in the row.
3. Sending into a cold chat with cold compaction on: keep the "enter again"
   confirmation, with the footer saying it compacts first (proposed), or send
   at once.
4. Agent-wide compaction: per model only, with old values shown as inherited
   (proposed), or an "Every model" row in each agent's Models tab.
