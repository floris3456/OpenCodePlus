# Round 3 lab loopback model transport

`docs/round3-lab.ts` is lab-only evidence tooling: a tiny, deterministic,
credential-free OpenAI-compatible endpoint. It is **not an external LLM** and
not a product feature. It exists so round-3 live captures that need a model —
the model-visible permission refusal (item 4) and the `working` state capture
(item 9) — can run in an isolated `tui-lab` host with no keys and no network.

It is separate from `docs/round3-delegate.ts`: that driver creates real
delegated children and never builds a transport; this helper only serves the
model transport those sessions execute against.

## Safety rules (enforced, not configurable)

- It binds `127.0.0.1` only, on port `0` by default, and prints only the bound
  URL at startup.
- It uses no credentials and reads no key files. Any `Authorization` header is
  ignored.
- It never logs or stores prompts, tools, request bodies or auth headers. The
  only state kept is the counter object behind `GET /proof` and one boolean.
- `POST /shutdown` stops only the server this process started; nothing else is
  touched.

## Run it

From the task worktree:

```sh
cd packages/plus
bun docs/round3-lab.ts
# http://127.0.0.1:51000
```

The printed URL is the whole startup output. `--port <n>` fixes a port instead
of taking an ephemeral one; `--hold-ms <n>` shortens the `ROUND3_HOLD` stream
(default `90000`) for a quick manual check. `--help` prints the same contract.

## Exact V2 config

Put this in the isolated lab's **global** config file —
`opencode.json` or `opencode.jsonc` under that lab's
`$XDG_CONFIG_HOME/opencode/` (for example the lab home's own config root),
never the human's `~/.config/opencode`. Global scope is deliberate: every
Location in the lab, including delegated child Locations, then sees the
transport.

```jsonc title="opencode.jsonc"
{
  "$schema": "https://opencode.ai/config.json",
  "model": "round3/fixture",
  "providers": {
    "round3": {
      "name": "Round 3 loopback fixture",
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": {
        "baseURL": "http://127.0.0.1:51000/v1"
      },
      "models": {
        "fixture": {
          "name": "Round 3 fixture (deterministic transport)",
          "capabilities": { "tools": true, "input": ["text"], "output": ["text"] }
        }
      }
    }
  }
}
```

Replace the port with the one the helper printed. Facts this config relies on:

- `providers.<id>` accepts `name`, `package`, `settings`, `models` and friends
  (`packages/schema/src/config/provider.ts:64-75`); the documented custom
  provider example is `services/www/src/docs/content/providers.mdx:8-27` and
  `services/www/src/docs/content/models.mdx:266-296`.
- `@opencode/ai/providers/openai-compatible` turns `settings.baseURL` into the
  route endpoint (`packages/ai/src/providers/openai-compatible.ts:26-41`) and
  the route appends `/chat/completions`
  (`packages/ai/src/protocols/openai-compatible-chat.ts:16-22`), so the request
  URL is `<baseURL>/chat/completions`.
- Do **not** add `apiKey` or `env`. A configured provider is immediately
  `activation: "enabled"` (`packages/core/src/config/plugin/provider.ts:56`);
  with no credential connection and no configured auth for an API-key package
  the host resolves the route to `Auth.none`
  (`packages/core/src/model-resolver.ts:309-314`). The fixture ignores
  `Authorization` anyway.
- `model: "round3/fixture"` sets the lab's default model; otherwise select
  provider `round3`, model `fixture` in `/models`.
- The `name` lines are the honest label: deterministic model transport, not a
  real model.

If the lab process was already running, reload/restart it so the config and the
provider catalog pick the new entry up before capturing.

## What it answers

| Request body | Response |
| --- | --- |
| anything else | `Round3 fixture reply.` — SSE: `role`, `content`, `finish_reason: "stop"`, `[DONE]`; JSON: one `chat.completion` |
| newest user message contains `ROUND3_HOLD` | SSE: `Round3 fixture hold.` followed by short ` hold N` content tokens for ~90 s, then `finish_reason: "stop"` and `[DONE]` |
| newest user message contains `ROUND3_REFUSAL`, exchange has no matching tool result | one native `shell` tool call, `call_round3_refusal` with `{"command":"printf round3-denied"}`; `finish_reason: "tool_calls"` |
| newest user message contains `ROUND3_REFUSAL`, exchange carries that tool result | short text: sentinel present or absent (see below); no new tool call |

Non-streaming and streaming requests get the same decisions. `ROUND3_HOLD`
holds only the SSE response; a non-streaming hold request returns at once.
Tool calls use a proper OpenAI `tool_calls` delta (id/name first, arguments
split across a second delta) so a real client parses them.

### `ROUND3_HOLD`

A prompt containing `ROUND3_HOLD` keeps a streaming step alive for ~90 seconds.
That is the window for capturing a run in `working` state (item 9): the
session receives tokens and does not go idle until the hold ends. Nothing is
fabricated here either — it is real streamed content from this endpoint.

### `ROUND3_REFUSAL` and the item-4 proof

The fixture does not know about permissions and never pre-generates a refusal.
When the newest user message asks for `ROUND3_REFUSAL` and the exchange has no
result for `call_round3_refusal` yet, it calls the native `shell` tool with
`printf round3-denied` and stops its turn. The host then evaluates the
permission rules.

To make the model receive a specific message, create a **deny** rule for the
`shell` action whose `message` is exactly:

```text
Round3 sentinel command is denied.
```

A denying rule's message becomes the permission error reason
(`packages/core/src/permission.ts:76-78,232-238`); the tool failure carries it
into the model-visible tool result as a `permission.rejected` error
(`packages/core/src/session/to-session-error.ts:40`), JSON-encoded by the
provider lowering. The next provider request in that exchange therefore
contains the sentinel if and only if the host really delivered it.

The fixture then records only a boolean — `sentinelSeen` — and replies:

- `Round3 fixture: received the tool result with the refusal sentinel.` when
  the exact sentinel is present;
- `Round3 fixture: received the tool result without the refusal sentinel.`
  otherwise.

There is no once-per-process latch: the decision is made from the current
request's messages, so a new user prompt starts a new exchange and the refusal
can be proven again. `POST /reset` only clears counters.

### Endpoints

| Route | Purpose |
| --- | --- |
| `POST /v1/chat/completions` | OpenAI-compatible chat completions (SSE and JSON) |
| `GET /proof` | counters and the sentinel boolean |
| `POST /reset` | clear the counters |
| `POST /shutdown` | stop this owned server |

`GET /proof` returns:

```json
{
  "requests": 3,
  "streams": 2,
  "holds": 1,
  "refusals": 1,
  "refusalResults": 1,
  "sentinelSeen": true
}
```

`requests` counts every chat completion; `streams` the streaming ones;
`holds` the `ROUND3_HOLD` requests; `refusals` the shell calls emitted;
`refusalResults` the requests that carried a matching tool result;
`sentinelSeen` is sticky until `/reset` and can only become true from content
that arrived in a request body.

Direct check without any client:

```sh
curl -s http://127.0.0.1:51000/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"fixture","messages":[{"role":"user","content":"ROUND3_REFUSAL"}]}'
curl -s http://127.0.0.1:51000/proof
curl -s -X POST http://127.0.0.1:51000/shutdown
```

## What is real, what is fixture

- Real: the host's provider resolution and session execution, its permission
  evaluation, the tool result it produces, and every HTTP/SSE byte between the
  host and this endpoint.
- Fixture, and labeled as such: the model itself. There is no model, no
  sampling and no provider; replies are fixed short strings chosen from the
  markers above.
- Not proven by this helper alone: that the host delivered the sentinel. The
  helper can only report what it actually received; the walkthrough evidence
  is the model-visible text from the lab plus `sentinelSeen` from `/proof`.

## Self-check

```sh
cd packages/plus
bun test test/round3-lab.test.ts
bun run typecheck
```

The test drives the real server over loopback HTTP: deterministic JSON and SSE
replies, refusal selection and argument framing, a real supplied tool result
with and without the sentinel, a repeated refusal in a new exchange, the hold
stream, and `/proof`, `/reset` and `/shutdown`.