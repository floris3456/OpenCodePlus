# plus-1.1.16: CLIProxyAPI as its own plugin, in /connect for everyone

**Where this comes from:** the user's request of 2026-10-06. CLIProxyAPI (CPA)
should be in `/connect` for every OpenCodePlus user. Models should sync on their
own, and quota should switch on by itself when the CPA supports it. The CPA
features should also become a separate project that ships by default and can be
removed.

Line numbers are at commit `cbbd89b6d1`. Re-check them before starting.

## Decisions

All made by the user on 2026-10-06 **(user)**. Decisions 5, 6 and 8 were
proposed here and confirmed the same day.

1. **(user)** Model sync is gated on the CPA side: full sync when the CPA answers
   `GET /v1/models?details=true` with schema `cliproxyapi.model-details/1`.
2. **(user)** A CPA without that endpoint keeps working as it does today.
3. **(user)** Quota coordination and the usage views switch on automatically
   when the CPA runs our `quota-handoff` plugin.
4. **(user)** The CPA features (`/connect`, quota handoff, model sync) become a
   separate project. It ships with OpenCodePlus by default and users can
   remove it.
5. **(user)** That project is an **OpenCode plugin package, not an MCP
   server**. MCP gives a model tools, resources and prompts. It cannot:
   - add an entry to `/connect` (the integration registry);
   - create a provider or change its model list;
   - hook every model request (quota claim headers, the `409
     quota_compact_required` refusal, retry and compaction decisions);
   - draw the sidebar Usage section.

   All four are plugin-host APIs. Only the image tool could also run as an MCP
   tool, and splitting it out gains nothing.
6. **(user)** For 1.1.16 the project is a separate package in this repo,
   `packages/cliproxyapi` (`@opencodeplus/cliproxyapi`). A separate repository
   and npm package can come later without code changes (see 1.4).
7. **(proposed)** The plugin ID stays `opencode.plus.cliproxyapi`. Plugin
   storage is keyed by plugin ID (`packages/core/src/plugin/host.ts:675`). The
   cached catalogue, quota bindings and installation identity live in that
   storage. The existing opt-out line also keeps working.
8. **(user)** As a last fallback, use the plain `/v1/models` list (see 3.1),
   so connecting never ends with an empty model picker.

## What exists today

- One built-in plugin, `opencode.plus.cliproxyapi`, lives inside
  `@opencode/plus`:
  - server half: `packages/plus/src/cliproxyapi/index.ts`;
  - TUI half: `cliproxyapi/tui.tsx`;
  - quota and usage: `packages/plus/src/quota/`.

  It is registered in `packages/core/src/plugin/internal.ts:256` and
  `packages/tui/src/plugin/builtins.ts:15,34`.
- It does nothing unless `~/.config/opencodeplus/cliproxyapi.json` (or the
  legacy `quota-handoff.json`) exists (`cliproxyapi/index.ts:43-53`,
  `cliproxyapi/config.ts:93-124`). Users also define the provider (package,
  `baseURL`, `apiKey`) by hand in `opencode.json`.
- `/connect` has no CLIProxyAPI entry. One appears only when the user's config
  already defines the provider, and then it uses the generic "Manually enter API
  Key" method (`packages/core/src/config/plugin/provider.ts:23-42`).
- Catalogue: `details=true` first, then the Codex catalogue
  (`?client_version=`) with approximate levels (`cliproxyapi/index.ts:200-205`).
  It retries every 15 s until every route has answered, then refreshes every
  5 min.
- Quota uses `<origin>/v0/resource/plugins/quota-handoff/events`
  (`quota/protocol.ts:54-63`). It requires provider `transport: "http"` and
  refuses WebSocket (`quota/register.ts:89-93`).
- Quota routes are fixed when the plugin starts (`cliproxyapi/index.ts:52`). The
  TUI asks `enabled` only during startup (`cliproxyapi/tui.tsx:17-27`,
  `quota/usage-register.ts:21`).
- It can already be turned off with
  `"plugins": ["-opencode.plus.cliproxyapi"]` (server:
  `core/src/plugin/supervisor.ts:38-44`; TUI: `tui/src/plugin/context.tsx:321-323`).
  When the server half is off, the TUI half shows nothing.
- It is tied to the rest of Plus in three places only. Everything else uses the
  public plugin API (`@opencode/plugin`, `@opencode/schema`, effect, solid,
  opentui).
  - `monitorFact`: account-switch and handoff facts go to the Plus monitor
    (`quota/register.ts:13,40-42`). The monitor reads them in
    `monitor/cache.ts:407`.
  - `globalConfigDir` from `plus/src/instructions/paths.ts`
    (`cliproxyapi/config.ts:3`).
  - The legacy storage bridge (`plus/src/index.ts:1,166-168`,
    `cliproxyapi/legacy.ts`).
- `quota/config.ts` is dead code. Only its own test uses it.

## Checked on the live CPA (2026-10-06, read-only)

All requests went to `cliproxy.boe.moe`; the key was never printed.

| Request | Result |
|---|---|
| `GET /v0/resource/plugins/quota-handoff/events`, no key | 200 `{"mode":"shadow","protocol":1}` |
| Control: `GET /v0/resource/plugins/does-not-exist/events`, no key | 302 to `/oauth2/start…`, so the probe must not follow redirects |
| `GET /v1/models?details=true`, with key | `schema: cliproxyapi.model-details/1`, 30 models |
| Same, without key | 401 |
| `GET /v1/models`, with key | 30 models (`id`, `owned_by` only) |
| `GET /v1/models?client_version=0.300.0`, with key | Codex catalogue, 30 models |

So the quota plugin can be detected without a key, and the probe tells "present"
apart from "absent" on this deployment.

## 1. Own package, no behavior change

Do this first, in its own commits, so that every later change lands in the new
package.

1. **Package.**
   - Create `packages/cliproxyapi`, named `@opencodeplus/cliproxyapi`, with its
     own README, tests and version.
   - Export `./server` and `./tui`, the subpaths `Host.resolve` looks for
     (`packages/plugin/src/host.ts:17-43`). The same package can then also load
     as an npm or local-directory plugin without changes.
   - Move into it:
     - `plus/src/cliproxyapi/*` and `plus/src/quota/*`, except the dead
       `quota/config.ts`, which is dropped;
     - their tests from `plus/test/cliproxyapi` and `plus/test/quota`.
   - `core/test/plugin/plus-cliproxyapi-*.test.ts` stays in core and only
     changes its import.
2. **Cut the three ties to Plus.**
   - Monitor facts: the package exports `onQuotaFact(listener)`, and the Plus
     monitor registers `monitorFact` with it. Plus depends on the package, never
     the other way round. Without the plugin, the monitor simply gets no
     account-switch facts.
   - Config directory: the package keeps its own small `globalConfigDir`, with
     the same `OPENCODE_CONFIG_DIR` rule.
   - Legacy storage: the package exports `provideLegacyQuotaStorage`, and Plus
     keeps calling it in 1.1.16. Drop it in a later release.
3. **Default install and removal.**
   - `core/src/plugin/internal.ts` and `tui/src/plugin/builtins.ts` import the
     new package in the same position as today. Its catalogue must still come
     before config, so `providers.<id>.models` overrides still apply on top.
   - Removing it takes one line in `~/.config/opencodeplus/opencode.json`:
     `"plugins": ["-opencode.plus.cliproxyapi"]`.
   - That removes the `/connect` entry, model sync, quota, the usage views and
     the image tool.
   - A provider written by hand in `opencode.json` still works as a plain
     provider.
4. **Boundary.**
   - `package.json` lists only `@opencode/plugin`, `@opencode/schema`,
     `@opencode/util` (if needed), effect, solid-js and `@opentui/*`.
   - A test fails when package source imports `@opencode/plus`, `@opencode/core`
     or a relative path outside the package. A fixture with such an import must
     fail as the control.
   - Later, not in 1.1.16: a separate repository and npm package, used by the
     release build as a pinned package input (workspace §A: an explicit
     package/build input, never a source path). Plain OpenCode V2 users could
     then add `"plugins": ["@opencodeplus/cliproxyapi"]`.

**Tests:**
- moved tests pass with only import changes;
- core catalogue and relay tests pass;
- `bun typecheck` passes in `cliproxyapi`, `plus`, `core` and `tui`;
- the boundary test passes, and so does its failing control;
- with `-opencode.plus.cliproxyapi` there is no `cliproxyapi` integration,
  provider or Usage UI.

## 2. CLIProxyAPI in /connect

1. **Integration.**
   - Integration `cliproxyapi`, named "CLIProxyAPI", with a key method labelled
     "CLIProxyAPI API key".
   - The method has one form field, `baseURL` ("CLIProxyAPI URL", placeholder
     `https://cpa.example.com/v1`). It follows the same pattern as
     `core/src/plugin/provider/cloudflare-ai-gateway.ts:40-49`.
   - Form answers are saved as the credential's `configuration`
     (`core/src/integration.ts:721`) and override provider settings at request
     time (`core/src/model-resolver.ts:204-205`).
   - The URL may be an origin or `origin/v1`; it is stored as `…/v1` with no
     trailing slash. It must be HTTPS, or HTTP to a loopback address, the same
     rule as `quota/protocol.ts:54-61`.
2. **Provider.**
   - Provider `cliproxyapi`, named "CLIProxyAPI", using package
     `@opencode/ai/providers/openai` (what the working setup on this host uses).
   - Activation is `auto`, so it is available only once connected.
   - Set `sourceConnection` to the active connection, as
     `core/src/plugin/provider/modal.ts:59-65` does. Reconnecting to another CPA
     must never show the previous CPA's models.
3. **Route.**
   - The origin of the connected credential's `baseURL` becomes the route for
     `cliproxyapi`, so no `cliproxyapi.json` is needed.
   - A route for the same provider ID in `cliproxyapi.json` takes precedence,
     so existing setups keep their behavior.
   - The key goes only to the origin the user entered it with. Project config
     cannot redirect it, because the credential's `configuration` wins over
     provider settings.
4. **Sync on connect.**
   - Refresh as soon as the integration's credential switches. Credentials
     publish `credential.switched` globally (`core/src/credential.ts:183`).
     Check that the plugin event stream carries it; if not, refresh when the
     active connection changes, as Modal does.
   - `/connect` opens the model picker right after connecting
     (`tui/src/app.tsx:964`), so the models must arrive quickly.
5. **Existing setups**, like this host's (provider in `opencode.json` plus
   `cliproxyapi.json`), keep working unchanged.
   - In `/connect`, CLIProxyAPI now shows the URL and key form instead of the
     generic key method. Config adds the generic method only when no
     integration exists (`config/plugin/provider.ts:26-31`).

**Tests** (against loopback stub CPAs):
- with no config, CLIProxyAPI is in the integration list and unavailable until
  connected;
- after connecting, the provider is available with the stub's models;
- after reconnecting to a second stub, the first stub's models are gone;
- the config-defined provider plus file route behaves as before;
- control: with `-opencode.plus.cliproxyapi`, there is no entry.

## 3. Sync and quota follow what the CPA supports

1. **Models** (decisions 1, 2 and 8). The plugin tries these in order and logs
   which source it used:
   1. `details=true`: full catalogue (unchanged).
   2. Codex catalogue (unchanged; "works as today").
   3. New: plain `/v1/models`, giving IDs and `owned_by` only, with no levels or
      limits. It is reached only when neither of the above is a catalogue. A CPA
      without them ignores both parameters and answers with this list, so the
      `details=true` answer is reused. A *failed* Codex request (5xx, timeout)
      still fails the refresh and keeps the last catalogue, so a brief outage never
      swaps a catalogue with levels for the bare list.
2. **Quota** (decision 3).
   - **Probe.** For each route whose `cliproxyapi.json` does not set `quota`:
     - send `GET <origin>/v0/resource/plugins/quota-handoff/events` with no
       key, `redirect: "error"` and a 5 s timeout;
     - 200 with `{ "protocol": 1 }` turns quota on; anything else leaves it off.
   - **When to probe:** at start, on connect, and with every catalogue refresh.
     Installing or removing the CPA plugin then takes effect without a restart.
   - **Overrides:** `"quota": false` still forces quota off, and `"quota": true`
     forces it on. `compactionModel` and `compactionFallback` stay file-only
     options.
   - **Live routes.** The quota controller reads the current route set instead
     of the one fixed at start. `enabled` answers from the current state. The
     TUI asks again (cheap local RPC, every 30 s while off), so Usage appears
     without a restart. The plugin API has no event publish
     (`plugin/src/effect/event.ts`), so the server cannot push the change.
   - **Transport.** Quota refuses WebSocket. *Dropped as a code change after
     checking:* only the `openai`, `xai` and Azure plugins default to WebSocket,
     each for its own provider ID or package
     (`core/src/plugin/provider/{openai,xai,azure}.ts`), and an omitted transport
     is HTTP (`core/src/model-resolver.ts:123`). The `cliproxyapi` provider is
     therefore already HTTP. Config-defined providers are left as the user set
     them, as today.

**Tests** (stub servers):
- the quota probe turns quota on for 200 with protocol 1;
- it leaves quota off for 302, 404, non-JSON, `protocol: 2` and a timeout;
- the file overrides beat the probe;
- quota turns on without a restart when the stub starts answering;
- transport is `http` only while quota is on;
- the TUI mounts Usage after the switch;
- the model source falls through details, then Codex, then the plain list, and
  each source produces models.

## 4. Docs, live acceptance, release

- **Package README:**
  - what the package does;
  - the three detection rules;
  - how to remove it;
  - that `cliproxyapi.json` holds advanced options only.

  The two current READMEs move with the code.
- **Live tests.** Run with
  `pilotty spawn --name <run> opencodeplus-dev .` from the worktree, in a fresh
  isolated home with no `opencode.json` and no `cliproxyapi.json`:
  1. `/connect` lists CLIProxyAPI. Connecting with URL and key opens the picker
     with the CPA's models and their levels (details source).
  2. The Usage section appears (`quota-handoff` present, mode `shadow`), and a
     chat runs over `http`.
  3. Control: connecting to a loopback stub with neither details nor quota gives
     fallback models and no Usage section.
  4. Removal control: with `-opencode.plus.cliproxyapi`, CLIProxyAPI is absent
     from `/connect` and there is no Usage UI.
  5. A copy of this host's config in a lab home, never the live one, behaves as
     before.
- **Evidence** goes in `run/evidence/plus-1.1.16-cliproxyapi/<run>/`. The lab
  home holds the API key, so never copy it into the tree, a document or a
  commit. *As done:* `run/evidence/cliproxyapi-package/` (`baseline`, `part1`
  to `part3`, `part4-live`).
- **Release** goes through the `opencodeplus-release` skill.

## Follow-ups (not in 1.1.16)

- **Startup refresh warning.** Each plugin start logs one `CPA catalogue
  refresh failed … has no API key` for a config-defined provider. The first
  refresh runs before config has merged the provider's settings; the 15 s
  retry succeeds and the restored catalogue applies meanwhile. This happens in
  the released build too: 333 of 335 warnings in the service log of
  2026-10-06 come within 5 s of a location start. Deferred by decision on
  2026-10-06.
- **Readable pattern error.** The `/connect` URL field shows the raw regex
  when refused. Core forms have no custom message for `pattern`; adding one
  is a public form-schema change.
