# opencode.plus.cliproxyapi

Every OpenCodePlus feature for [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
(CPA) lives in this one built-in plugin (server half `index.ts`, TUI half `tui.tsx`).
Hosts that do not use CPA see nothing from it.

## Turning it on and off

- **On:** create `~/.config/opencodeplus/cliproxyapi.json` (host-owned; project
  config cannot enable it):

  ```json
  { "routes": { "cliproxyapi": "https://cpa.example" }, "quota": true, "catalog": true }
  ```

  `routes` maps OpenCode provider IDs to the CPA origin serving them. The provider
  itself (package, `baseURL`, API key) stays in the normal `providers` config; its
  `baseURL` origin must equal the route, and the key is only ever sent there.
  `quota` and `catalog` default to `true`. A legacy `quota-handoff.json` (routes
  only) still enables quota and usage, without the catalogue.

- **Off:** `"plugins": ["-opencode.plus.cliproxyapi"]` in `opencode.json`, or delete
  the file. Without the server half (or without configuration) the TUI half shows no
  Usage UI.

## Features

- **Model catalogue.** Every model CPA serves appears under the routed provider:
  display name, context and output limits, input/output modalities, and reasoning
  variants for exactly the effort levels CPA accepts for that model (spelled like
  Core spells them for the provider package). Source: CPA's
  `GET /v1/models?details=true` (`cliproxyapi.model-details/1`); on CPA builds
  without it, the Codex model catalogue (`?client_version=`), whose levels are
  approximate and filtered to Core's efforts. Models CPA forwards unvalidated
  (`passthrough`) get no invented variants. Each Fast-capable model (CPA lists the
  `priority` service tier) also gets a `<id>-fast` model that sends
  `service_tier: "priority"`. The plugin registers before config, so
  `providers.<id>.models.<model>` entries refine discovered models (settings,
  variants, limits) instead of replacing their variants. The last good catalogue is
  stored and kept through CPA outages; refresh every 5 minutes (every 15 s until
  the first success).
- **Image models.** CPA serves `gpt-image-…` models only on `/v1/images/generations`.
  They are listed as "(images)" with image output, and the `image.generate` tool
  creates an image with them and saves a PNG in the project (default
  `generated-images/`). Selecting one as a chat model fails at CPA.
- **Quota coordination and usage** (`../quota/`): CPA quota-handoff bindings, quota
  notices, `/usage` and the sidebar Usage section. Bindings stored by earlier
  versions under `opencode.plus` are migrated on first read.
