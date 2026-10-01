# Credential quota handoff

Enable through the existing Plus plugin options:

```json
{
  "quota": {
    "routes": {
      "YOUR_CPA_PROVIDER_ID": "https://cliproxy.boe.moe"
    }
  }
}
```

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
requires a local checkpoint. RPC exposes only display text. No quota action depends on an LLM
following instructions in a notice. Polling stops when sessions stop executing.

When no replacement exists, the chat pauses. A confirmed reset can resume its
existing binding without a needless compaction. Returning from another account
still requires a fresh chat or a newly committed portable checkpoint.

This module is disabled unless `quota` options are present. Changing credentials
never changes the model. No CPAMP API, management key, or usage queue is used.
