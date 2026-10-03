# Credential quota handoff

Create `quota-handoff.json` in the host's global config directory (normally
`~/.config/opencodeplus`, or `OPENCODE_CONFIG_DIR` when set):

```json
{
  "routes": {
    "YOUR_CPA_PROVIDER_ID": "https://cliproxy.boe.moe"
  }
}
```

Load it with the next controlled host start. Built-in plugin selectors do not
forward options in this OpenCode version. Embedders that instantiate Plus directly
may alternatively provide the same object as `options.quota`. Project-local files
cannot enable the feature. This file contains route origins only, never credentials.

The map uses OpenCode provider IDs; the origin must match the actual model route.
Set the managed provider's existing `settings.transport` to `"http"`. WebSocket
coordination is explicitly refused in this first version.

The CPA plugin controls the 20%/10% five-hour and 15%/5% seven-day thresholds.
Notices enter the affected chat with `resume: false` and appear above its composer.
Auto compaction uses Core's native safe-boundary decision hook. It requests a
local portable summary when an account change requires one; it never overrides
`auto: false`. A strict remote compaction policy refuses an automatic handoff
that cannot produce portable context.

Healthy existing bindings retain their normal compaction strategy. Auto-off
handoffs retain readable history and tool pairs, clearing account-bound proof;
that replay mode persists until a portable checkpoint replaces the old history.
An existing opaque checkpoint needs local compaction to enroll in quota routing.

Session capabilities, cursors, route generations and retry intent are in private
plugin storage. Provider ID and model ID together identify a route. Auxiliary
requests do not establish primary enrollment, so existing opaque history still
requires a local checkpoint. RPC exposes display text and credential quota summaries; raw capabilities stay private. No quota action depends on an LLM
following instructions in a notice. Polling stops when sessions stop executing.

When no replacement exists, the chat pauses. A confirmed reset can resume its
existing binding without a needless compaction. Returning from another account
still requires a fresh chat or a newly committed portable checkpoint.

This module is disabled unless this file or explicit `quota` options are present. Changing credentials
never changes the model. No CPAMP API, management key, or usage queue is used.

## Credential usage in the sidebar

Usage is a compact **Usage** section of the session sidebar, below its other
sections. It appears whenever the sidebar is visible and refreshes every five
seconds while it is shown; nothing polls while no usage view is mounted.

- `/usage` shows every bridge credential belonging to the selected model's resolved
  CPA provider, including general and applicable model-specific windows (five-hour,
  seven-day Sonnet, OAuth-app and other returned windows). Before the selected
  chat/model has made a request it shows all credentials, labelled
  "no request from this chat yet". If the chat has made requests but CPA has no
  binding for it (for example a credential the bridge does not track served it), the
  label says CPA is not tracking this chat and that the credential in use is unknown.
- `/usage --all` shows every configured bridge credential and every recorded
  window, including other providers and model scopes. The section's
  **● model / ○ all** control (clickable) and the palette's _Usage: show all
  credentials_ switch scope.
- `/usage` never opens a modal or changes the sidebar preference. With the sidebar
  visible (docked, or opened as an overlay with Ctrl+X then B) it scrolls the
  section into view and highlights its title. Otherwise — terminals narrower than
  the 120-column docking width, a hidden sidebar, child chats or the home screen —
  it opens a compact panel above the prompt (below the prompt on the home screen).
  The panel has a fixed height (40% of the terminal, 6–16 rows), scrolls with the
  mouse wheel, collapses to a one-line summary (click **▼ Usage** or _Usage: collapse
  panel_) and closes with **✕** or _Usage: close panel_. It stands aside while the
  sidebar is visible and returns when the terminal narrows again. Focus stays in the
  prompt throughout; typing, submitting and drafts are unaffected.
- **IN USE** (accent bar) identifies the exact credential CPA confirmed for this
  chat's running primary request. **LAST USED** identifies its most recent primary
  request while idle; CPA may choose another credential next time. Title
  generation and compaction do not overwrite that identity. Fresh chats show
  neither marker.
- Each credential shows its alias and `provider · exact auth ID`; long aliases and
  IDs wrap rather than truncate. **Shared quota with …** labels aliases sharing one
  account so their bars are not mistaken for additional capacity.
- Window rows are aligned: duration (`5h`, `7d`, `30d`…, with a scope line such as
  `sonnet` above scoped windows), a remaining-quota bar coloured by the CPA
  thresholds (≤20% warning, ≤10% error), the remaining percentage (rounded down) and
  a reset countdown. Text states accompany colour: `STALE` (reading older than the
  bridge's maximum age), `reset` (reset passed; awaiting a fresh reading),
  `dormant` and "No quota reading yet". Windows the provider reports as not
  applicable (for example no separate weekly Opus/Sonnet cap on the account) are
  hidden; a credential with only such windows shows "No limited quota windows". **○ details** (or
  _Usage: show exact resets and notes_) adds exact reset dates, full window names,
  exact percentages and reading age.
- A chat CPA has not bound yet is polled in the background at most every 30 seconds
  (each model request still checks immediately), and a transient bridge failure no
  longer leaves such a chat paused once the bridge answers again.
- A failed refresh keeps the last reading for the same chat/model/scope, marks the
  header `retrying` and explains the error; readings recover automatically. A
  changed chat, model or scope starts empty and discards late responses from the
  previous selection.

Requires CPA's `quota-handoff` plugin **0.1.2 or newer** and the existing host quota
configuration. An existing chat/model uses its private route capability. Before
its first request (including the home screen), the host uses the provider's
configured CPA API key to request all credentials, with no active credential
marker. CPA validates that key against its own authenticated loopback model-list
endpoint; this does not execute a model or enroll a chat. The model's base URL and
quota origin must match before the host sends the key. An unconfigured provider
gets setup guidance. Credentials outside the plugin's configured Claude/Codex
pool have no quota data in this view.

The read uses the existing GET event route with `view=usage`, `model` and `all`
query parameters. No additional Caddy route, CPAMP key or management API is needed.
It does not enroll a chat, acknowledge a notice, reserve capacity, start compaction,
or change credential selection. Valid reads may trigger the existing rate-limited
quota sampler; its refresh/backoff policy remains authoritative. Old CPA plugins
return explicit upgrade guidance rather than empty bars.

Plus palette commands are grouped under **OpenCodePlus**, including credential
usage (and its scope, details, collapse and close commands), instructions, tool
statistics, warming, agent management and team selection.
