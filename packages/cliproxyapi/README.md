# Pacer in OpenCodePlus

The release loads **`opencode-pacer`**, pinned to the upstream commit in
`package.json` and patched by the root `patchedDependencies`
(`patches/opencode-pacer@493706c.patch`, the usage watch of its local branch
`gentle-watch`, until the pin moves to that work), with the Plus adapter in
`src/server.ts`. Its server and TUI
halves share that ID. Turn it off independently with
`"plugins": ["-opencode-pacer"]`; re-enable it with `"plugins": ["opencode-pacer"]`.
The bundled code stays in the executable when removed from the enabled plugins.

- Connect through `/connect` → CLIProxyAPI. No `cliproxyapi.json` is read.
- Pacer owns model discovery, Claude relay, pricing and quota observations.
- The Plus adapter normalizes legacy `body.reasoning: { effort }` overrides for
  models whose final package uses Anthropic Messages, after ordinary config
  transforms. This runs on startup, catalogue refresh and config/plugin reload;
  it preserves the requested effort and unrelated settings without rewriting
  the config file. Explicit OpenAI/custom packages keep their original bodies.
  Unknown `reasoning` shapes are left intact rather than silently discarded.
- Replies update the meter immediately. A shared Pacer change subscription also
  updates idle viewers when any caller uses the credential: one held request per
  process for a CPA and key, asked again 10-15 s after each answer, later after
  errors, a 503 or 429 and its `Retry-After`. Older servers fall back to
  cached-view reads at the same pace; provider polling stays in Pacer.
- `/usage` opens a compact popup on the first Enter; `/usage --all` inspects all providers there.
  Left/right pages fit the terminal without scrolling; `a` changes scope and `d`
  shows reset details. The sidebar displays the selected model's providers from
  Pacer's cached catalogue, even before the first request and after a response ends.
- `/usage --all` retains Plus's all-provider credentials, quota-window bars and
  reset countdowns, including the narrow-terminal panel. It reads the cached
  Pacer meter. **IN USE** arrives with primary response headers and replaces
  **LAST USED** until execution ends. Auxiliary replies only update percentages.
- **NEXT USE** displays Pacer's per-chat proposal, explicitly labelled in dry-run.
  Plus uses its own existing claim capability for this read-only preview. Reads
  are coalesced for 15 seconds per chat/model, with at most one in flight (10 s
  timeout); after a failure the chat/model is not read again for 15 s, doubling
  to 2 minutes, nor before Pacer's `Retry-After`. They read Pacer's stored evidence,
  never a provider quota endpoint. Expired previews and changed models clear the
  marker. The live Pacer server must support `next_use`; older servers omit it.
- The same read answers Plus through `pacerCache` (the chat's cache warmth) and
  `pacerUsedUp` (`src/pacer-cache.ts`): the preview's `force_reason: "now"`, a
  forced move off an account that cannot serve, shows under the prompt as
  `out of usage · compacts to next account`, with `serves_at_ms` (when the
  account serves again, moved onto this clock); Plus stops warming such a chat
  unless that is at most 10 minutes away.
- Plus's dedicated compaction decision hook replaces the stock plugin's
  context-overflow workaround. Summary selection stays per chat, supports a
  fallback, preserves portable checkpoint conversion and bounds switch retries.
  As in upstream Pacer, handoff claims apply to Claude relay models; other
  providers still contribute quota readings without receiving unsupported claims.
- The explicit warming hook suppresses pings while a switch is pending.
- Every handoff claim names the chat's newest checkpoint, native (Anthropic's own
  compaction) or local, also after replies follow it, so Pacer places the chat again
  at the first request after each compaction, manual or automatic, and only then.
- **CPA outages** (`src/outage.ts`): a request to the `cliproxyapi` provider that is
  refused, reset, timed out or answered 502/503/504 keeps retrying every 15 s once
  Core's own retries (about 84 s) are used up, for up to 30 minutes from the first
  failure. Agents and their subagents wait out a CPA restart (CT104's `cpa-watch`
  restarts a CPA that stops answering) instead of stopping. Each retry runs the
  compaction decision first, marked `cpa.outage`: with Compact cold chats first on,
  Plus then counts a cache that goes cold within a minute as cold and summarizes
  with the cold-cache models before the step continues.
- One prompt cache key per chat: requests to the `cliproxyapi` provider carry
  `prompt_cache_key` set to the chat's own session ID (a fork: the session it was
  forked from, whose history it starts with), on Chat Completions as well as
  Responses. CPA makes that key the upstream cache key; for Codex it is also the
  `Session-Id` ChatGPT groups its prompt cache by. Without a body key CPA used one
  key for every request on the API key, and Core's default gives subagents their
  parent's key, so a whole subagent tree shared one cache group and lost its cache
  together whenever ChatGPT moved that group. Account affinity is unchanged: the
  `X-Session-Id` / `x-session-affinity` headers still carry the parent's ID.
  `"compatibility": { "supportsPromptCacheKey": false }` on the provider in
  `opencode.json` stops sending the key.
- **Usage for agents** (`src/usage-tool.ts`): the `pacer.usage` tool (Code Mode
  `tools.pacer.usage({ model?, all? })`) returns what the Usage sidebar shows: each account's
  windows (percent left, when they reset), the account serving the chat (IN USE, else LAST
  USED), NEXT USE and FORCE USE, as structured output plus a short text. `model` defaults to
  the chat's model; `all` lists every account Pacer meters. Read-only: no model request.
- Instructions UI, instructions storage and its compaction controls are unchanged.
- **Web search** (`src/web.ts`): three tools in Code Mode's `web` namespace (beside
  OpenCode's `web.opencode_search` and `web.opencode_fetch`), for every chat model,
  on the `/connect` login's CPA with the models Pacer's catalogue lists. The searches
  use the `websearch` permission and `chatgpt_fetch` the `webfetch` one, so the rules
  for web search and fetch apply to them.
  A chat's searches run under its ID plus `-search`: they stay on one account, and
  Pacer never counts them as the chat's own requests.
  - `web.chatgpt_search` and `web.chatgpt_fetch`: ChatGPT's search engine through
    CPA's `/v1/alpha/search` (the endpoint Codex clients use) on a Codex account.
    Search returns the found pages' text with their titles and URLs; fetch returns
    a page from the top as numbered lines with its total line count. `tokens`
    caps the text (default 2000, about 8000 characters). The endpoint takes a
    start line but ignores it, so a larger cap is how to read further down. The
    model sent is `gpt-6-luna`, else the first chat model from Codex accounts.
  - `web.claude_search`: Anthropic's server-side web search on `/v1/messages`.
    Its results arrive encrypted for Claude, so a Claude model (`claude-haiku-5-5`,
    else the first chat model from Claude accounts, never one served through
    Antigravity) searches with thinking off and answers. The tool returns that
    answer, the pages it cited and the queries it ran. One question costs that
    Claude account roughly 10-20k input tokens.
  - In Code Mode a script gets the declared output: `{ text, model, sources }` for
    the ChatGPT tools, `{ answer, model, queries, sources, searches, tokens }` for
    Claude.

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

The mandatory `core-contracts` release gate covers the **shipped Pacer adapter**
with legacy configuration, including real HTTP request bodies, reloads and a
rejection control (`test/plugin/pacer-compatibility.test.ts`). Legacy relay tests
alone do not verify the currently bundled integration.

The adapter uses `ctx.model.transform(normalizeLegacyReasoning, { phase: "final" })`.
Both Promise and Effect plugins support this model-only option. Ordinary
transforms run first; final transforms run in registration order before the
snapshot is published, and retain normal scope disposal and failure handling.

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
