# Pacer in OpenCodePlus

The release loads **`opencode-pacer`**, pinned to the upstream commit in
`package.json`, with the Plus adapter in `src/server.ts`. Its server and TUI
halves share that ID. Turn it off independently with
`"plugins": ["-opencode-pacer"]`; re-enable it with `"plugins": ["opencode-pacer"]`.
The bundled code stays in the executable when removed from the enabled plugins.

- Connect through `/connect` → CLIProxyAPI. No `cliproxyapi.json` is read.
- Pacer owns model discovery, Claude relay, pricing and quota observations.
- Replies update the meter; Pacer's usage view refreshes every minute. The old
  per-step/per-second quota-events polling is not enabled.
- `/usage --all` retains Plus's all-provider credentials, quota-window bars and
  reset countdowns, including the narrow-terminal panel. It reads the cached
  Pacer meter rather than making another proxy request.
- Plus's dedicated compaction decision hook replaces the stock plugin's
  context-overflow workaround. Summary selection stays per chat, supports a
  fallback, preserves portable checkpoint conversion and bounds switch retries.
  As in upstream Pacer, handoff claims apply to Claude relay models; other
  providers still contribute quota readings without receiving unsupported claims.
- The explicit warming hook suppresses pings while a switch is pending.
- Instructions UI, instructions storage and its compaction controls are unchanged.

Summary preferences now live in the ordinary global `opencode.json`:

```json
{
  "plugins": [{
    "package": "opencode-pacer",
    "options": {
      "compactionModel": "cliproxyapi/deepseek-v4.1-flash-cheap",
      "compactionFallback": "cliproxyapi/gemini-3.8-flash-high"
    }
  }]
}
```

`accountSwitch: false` disables the handoff integration without disabling the
meter. Existing provider-specific model settings remain ordinary OpenCode
configuration. New Fast aliases and the legacy CPA image tool are not registered
by the standalone Pacer plugin.

## Historical implementation (through Plus 1.3.1)

The remaining documentation describes `src/index.ts`, retained for legacy
regression coverage but no longer loaded by the release:

Every OpenCodePlus feature for [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
(CPA) lives in this one built-in plugin (server half `index.ts`, TUI half `tui.tsx`).
Hosts that do not use CPA see nothing from it.

## Turning it on and off

- **On, the normal way:** run `/connect` and choose **CLIProxyAPI** (first in Popular), then enter
  the CPA URL (ending in `/v1`) and an API key. The `cliproxyapi` integration,
  provider and model catalogue are always registered; connecting makes the
  provider available and its models sync immediately, with no
  `cliproxyapi.json` and no provider in `opencode.json`. The key is only ever
  sent to the origin of the URL it was entered with.
- **On, the advanced or existing way:** create
  `~/.config/opencodeplus/cliproxyapi.json` (host-owned; project config cannot
  enable it) and define the provider (package, `baseURL`, API key) in the normal
  `providers` config. Use this for options `/connect` does not set, or to keep an
  existing setup unchanged:

  ```json
  { "routes": { "cliproxyapi": "https://cpa.example" }, "quota": true, "catalog": true }
  ```

  `routes` maps OpenCode provider IDs to the CPA origin serving them. A file
  route for a provider ID overrides the connection-derived route for the same
  ID. The provider's `baseURL` origin must equal the route, and the key is only
  ever sent there. `catalog` defaults to `true`. `quota` forces quota
  coordination on (`true`) or off (`false`) for every route, connected ones
  included; without it, quota follows the CPA (see Features). A legacy
  `quota-handoff.json` (routes only) forces quota on, without the catalogue.

  Claude models routed through CPA default to CPA's Anthropic Messages relay with
  `settings.compaction: { "type": "native" }` (see Anthropic Messages relay below).
  Optional `"anthropicRelay": false` (per-route in `routes` or top-level in `cliproxyapi.json`
  or `quota-handoff.json`) opts out and restores the provider's default routing. User's
  explicit per-model `package` or `settings.compaction` in `opencode.json` always wins.
  Existing `opencode.json` configurations may carry `compaction: { "mode": "local" }`
  on Claude models; this key is inert because the schema only recognises
  `settings.compaction: { "type": "summary" | "native" }`, and is ignored.

  Optional `"compactionModel": "<provider>/<model>[#variant]"` (for example
  `"cliproxyapi/deepseek-v4.1-flash-cheap"`) writes the summary when CPA moves a chat
  to another account (see the quota README, "Account switches"); without it the
  agent's normal compaction model writes that summary. Optional
  `"compactionFallback"` (for example `"cliproxyapi/gemini-3.8-flash-high"`) writes it
  when the first model fails.

- **Off:** `"plugins": ["-opencode.plus.cliproxyapi"]` in `opencode.json` removes
  everything: the `/connect` entry, catalogue, relay, quota, Usage and the image
  tool. A provider you defined yourself keeps working, without them. The TUI
  half reads the TUI's own `cli.json`: it stays loaded but shows nothing and
  stops asking the server; the same line in `cli.json` unloads it as well.

## Features

- **Model catalogue.** Every model CPA serves appears under the routed provider:
  display name, context and output limits, input/output modalities, and reasoning
  variants for exactly the effort levels CPA accepts for that model (spelled like
  Core spells them for the provider package). Source: CPA's
  `GET /v1/models?details=true` (`cliproxyapi.model-details/1`); on CPA builds
  without it, the Codex model catalogue (`?client_version=`), whose levels are
  approximate and filtered to Core's efforts; on a CPA with neither, its plain
  model list (IDs only: no levels, limits or modalities). A failing Codex request
  keeps the last catalogue instead of falling to the plain list. The log says
  which source each provider got. Models CPA forwards unvalidated
  (`passthrough`) get no invented variants. Each Fast-capable model (CPA lists the
  `priority` service tier) also gets a `<id>-fast` model that sends
  `service_tier: "priority"`. The plugin registers before config, so
  `providers.<id>.models.<model>` entries refine discovered models (settings,
  variants, limits) instead of replacing their variants. The last good catalogue is
  stored and kept through CPA outages; refresh every 5 minutes (every 15 s until
  the first success).
- **Anthropic Messages relay.** For every provider routed to CPA, Claude models
  (CPA reports `owned_by: "anthropic"`, or model ID starts with `claude-`) go through
  CPA's Anthropic Messages relay (`/v1/messages`). They receive the
  `@opencode/ai/providers/anthropic-compatible` package, model-aware
  Anthropic-spelled effort variants (adaptive thinking for newer Claude,
  `enabled`+`budgetTokens` for 3.7 and 4.5), and
  `settings.compaction: { type: "native" }` (which enables remote
  compaction when strategy is Auto). This applies in catalogue mode and in legacy
  `quota-handoff.json` mode (catalogue off). The package and compaction are applied
  by the relay's post-config pass, so a user's per-model `package` or
  `settings.compaction` in `opencode.json` always wins. Warming pings, usage, cost,
  cache accounting, and quota handoff continue to work over the Anthropic relay.
- **Image models.** CPA serves `gpt-image-…` models only on `/v1/images/generations`.
  They are listed as "(images)" with image output, and the `image.generate` tool
  creates an image with them and saves a PNG in the project (default
  `generated-images/`). Selecting one as a chat model fails at CPA.
- **Quota coordination and usage** (`src/quota/`): CPA quota-handoff bindings, quota
  notices, `/usage` and the sidebar Usage section. On by themselves for each routed
  or connected CPA that runs CPA's quota-handoff plugin: the plugin asks its events
  endpoint (no key sent) at start, on connect and with every catalogue refresh, so
  installing or removing quota-handoff on CPA takes effect without a restart (within
  5 minutes; the TUI asks every 30 s while quota is off). `"quota"` in
  `cliproxyapi.json` overrides this. A provider created by `/connect` already uses
  HTTP, which quota requires; a config-defined provider must not set
  `settings.transport` to `"websocket"`. Bindings stored by earlier versions under
  `opencode.plus` are migrated on first read.
