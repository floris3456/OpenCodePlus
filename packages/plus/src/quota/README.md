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

## Credential usage command (1.1.2)

- `/usage` opens quota bars for every bridge credential belonging to the selected
  model's resolved CPA provider. It includes general and applicable model-specific
  windows, such as five-hour, seven-day Sonnet, and OAuth-app quotas. Before the
  selected chat/model has made a request, it defaults to `/usage --all`.
- `/usage --all` shows every configured bridge credential and every recorded
  window, including other providers and model scopes.
- **IN USE** identifies the exact credential CPA confirmed for this chat's running
  primary request. **LAST USED** identifies its most recent primary request while
  idle; CPA may choose another credential on the next request. Title generation
  and compaction do not overwrite that identity.
- Each row includes the credential alias and exact auth ID. Aliases sharing one
  account are labelled so their bars are not mistaken for additional capacity.
- Bars show remaining quota, reset date/countdown and stale evidence. Missing,
  dormant and non-applicable windows are labelled rather than given invented data.
  Use the mouse wheel or navigation keys to scroll, `r` to refresh, `a` to switch
  scope, and Escape to close. The open view refreshes every five seconds.

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
usage, instructions, tool statistics, warming, agent management and team selection.
