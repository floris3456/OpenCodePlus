# plus-1.1.15 Monitor T1 live sweep (final)

Scope: verify every end-state line of the Monitor T1 contract
(`docs/plans/plus-1.1.12-monitor.md`, copied into the task brief m-t1.md) in
**this worktree's own build**, and record the result per line. Source: none
changed — this file only.

Build under test: worktree
`team/Flash-C-Worker/t1311ea8-20261005-1727` (HEAD `ea00079e31`).
Command: `pilotty spawn --name sweep-m-t1 opencodeplus-dev .` (own build, own
home; never `dev:live`, never port 40375, never `~/.config/opencodeplus`).
Owned dev home (`$DEV`):
`/home/bliss/OpenCodePlus/run/plus-dev/run-plus-data-opencodeplus-teams-worktrees-opencode-Flash-C-Worker-t1311ea8-20261005-1727`.
Server log: `$DEV/data/opencode/log/opencode-local.log`.
Chat model: `cliproxyapi/claude-opus-5-5` at variant `high` (the notes'
fallback; the home default `claude-fable-5-1` route is rejected).

Each line below quotes what was done, the screen text / db rows / log lines
seen, and ends with **PASS**, **FAIL** or **NOT LIVE** plus the reason.

## End-state lines

### L1. Every provider request recorded (time, session, kind, agent, provider/model/variant, usage or error)

Did: one `Build` chat in the owned home, model
`cliproxyapi/claude-opus-5-5@high` (the notes' fallback), with a first
sentinel prompt, a second prompt, and one compaction. Read the owned
`monitor.db` read-only. Requests seen:

```
{"id":"c8f05bf7-…","session_id":"ses_ef351470cffe7zANSBNCCogS9V","kind":"title","is_title":1,
 "agent":"title","provider":"cliproxyapi","model":"claude-opus-5-5","variant":"high",
 "started":1791214139772,"ended":1791214144331,"duration":4559,"status":"completed","error":null,
 "input_tokens":940,"output_tokens":316,"reasoning_tokens":0,"cache_read_tokens":0,
 "cache_write_tokens":0,"cost":0,"message_id":"title:…"}
{"id":"6ec41e7e-…","kind":"step","is_title":0,"agent":"build","provider":"cliproxyapi",
 "model":"claude-opus-5-5","variant":"high", … "input_tokens":8031,"output_tokens":17,
 "reasoning_tokens":0,"cache_read_tokens":4837,"cache_write_tokens":0,"cost":0}
{"id":"8cf5e4be-…","kind":"compaction","is_title":0,"agent":"build", … "input_tokens":8506,
 "output_tokens":216,"cache_read_tokens":5041}
```

Kinds agent step, compaction and title (flagged `is_title=1`) are present,
each with time/session/agent/provider/model/variant and full usage; `step`
rows keep all their fields. `$DEV/.../monitor.db` schema `meta.schema=2`, tables
`request`, `request_fingerprint`, `context_fact`, `step` present.

The error path was exercised live: switching to the `plan` agent (its route
`claude-fable-5-1` is rejected by CLIProxyAPI) produced a refused request,
recorded with its hashed error instead of usage:

```
{"id":"0a2223d8-…","kind":"step","agent":"plan","provider":"cliproxyapi",
 "model":"claude-fable-5-1","variant":"xhigh","started":1791214970905,
 "duration":25,"status":"error",
 "error":"{\"type\":\"provider.invalid-request\",\"status\":400,
 \"hash\":\"0dd35a2328c29e26\",\"chars\":43}",
 "input_tokens":0,"output_tokens":0,…,"cost":0,
 "message_id":"msg_10cbb67fd001raBkN7pCdkoMR6"}
```

The TUI showed `Error: unknown provider for model claude-fable-5-1`. Kinds
agent step, compaction, ping, title and generate (`generate` before the warming
`warmed` relabel to `ping`) are all in the ledger. Live kind counts at sweep
end:

```
{"kind":"compaction","is_title":0,"n":1}
{"kind":"ping","is_title":0,"n":3}
{"kind":"step","is_title":0,"n":8}
{"kind":"title","is_title":1,"n":1}
```

The `generate` kind for non-ping generate calls is covered by the focused test
`test/monitor-requests.test.ts` "generate usage hook records request and warming
warmed relabels it to ping, hashing errors without text" (passed, recorded under
L6). **PASS**.

### L2. Keep-alive pings recorded with their usage

Did: set `Defaults › Models › cliproxyapi/claude-opus-5-5` to `warming 4m ·
ping every 1m` (Inspector for that row; screen read `warming 4m · every 1m ◆`,
`window 4 × 1m pings`) and waited; the chat sent three keep-alive pings. After
each `warming` hook's `warmed` phase the row is relabelled `ping`. Requests
read from the ledger:

```
{"id":"514fe771-…","kind":"ping","agent":"build","provider":"cliproxyapi",
 "model":"claude-opus-5-5","variant":"high","started":1791214671623,
 "duration":1399,"status":"completed","input_tokens":7873,"output_tokens":4,
 "reasoning_tokens":0,"cache_read_tokens":5352,"cache_write_tokens":0,"cost":0,
 "message_id":"generate:1791214671614:1791214673022"}
{"id":"6d26f04a-…","kind":"ping", … "input_tokens":4,"cache_read_tokens":13221}
{"id":"f12c3bcd-…","kind":"ping", … "input_tokens":4,"cache_read_tokens":13221}
```

`request.kind` is `ping` (not `generate`), each with its usage. The warming
context facts include `phase":"warm"` then `phase":"warmed"` for each ping. The
core seam is `packages/core/src/plugin/warming.ts`: the `generate` call's usage
lands on the request row and the `warming` hook (`phase: "warmed"`) relabels
`generate`→`ping` (`packages/plus/src/monitor/plugin.ts:288-302`). Monitor
totals read `pings: 3 · cost: $0.00` and the Steps tab shows three `ping` rows
with their tokens. **PASS**.

### L3. Request fingerprint, as sent, protocol-aware

Did: read `request_fingerprint` for the chat's wire requests. All are
`openai-responses` (the protocol in use for CLIProxyAPI here), each with a
`body_hash`, and every key the contract names:

```
systemParts (18 entries on the main steps): base template (892 chars), system:1,
 date/environment block (777, 29), system:4 (8633), AGENTS.md (6799),
 teaching (792), system:7 (1495), system:8 (238), plus "system remainder"
 separators; each has hash/chars/estimatedTokens.
tools (12): edit, glob, grep, question, … each {name, descHash, schemaHash,
 chars, estimatedTokens} with descHash ≠ schemaHash.
options_keys: {"prompt_cache_key":"95a5fc414bef302b","reasoning":"1450e0b1f50c56ac",
 "reasoning.effort":"b57c4299afe3cda1","max_output_tokens":"8eda794b86cb7092"}
messagePrefixes (rolling): idx/role/kind/messageId/prefixHash per message, e.g.
 request 6ec41e7e: idx0 user "9ff24bc0…"; request dc19aaf7: idx0 user
 "9ff24bc0…", idx1 assistant "77a2a47f…" (messageId msg_msg_011CfjKx…).
cache_key: 606ee8ed66884079 on every request (sha256 of the prompt cache key).
```

The per-protocol `fingerprintWireBody` covers `openai-responses`,
`openai-chat` and `anthropic-messages`, with a chunked whole-body prefix
fallback (`packages/plus/src/monitor/fingerprint.ts:164-234`). The live
Responses body is fully fingerprinted; the other protocols and the fallback are
covered by the named focused test "fingerprints from real request bodies for
each protocol with short hashes" (asserts each protocol, per-part/tool hashes,
rolling prefix divergence, cache-control markers and the fallback). The
after-every-transform final body (including WebSocket frames) is covered by
"final wire observers capture later HTTP and WebSocket transforms and hashed
response lineage" (both passed, recorded under L6). **PASS**.

### L4. Context facts (account switch/handoff, instruction updates, compactions, agent/model switches, reverts)

Did: within the same chat, sent prompts, compacted (`Ctrl+X c`), switched
agent (`Ctrl+X a` → Plan) and model with it, then reverted a message
(`Ctrl+X g` → the sentinel prompt → Message Actions → Revert). Read
`context_fact`:

```
1  instruction_update {"keys":["core/environment","core/date","core/codemode",
   "core/instructions/home/bliss/opencodeplus/agents.md-3bc15f0e6a06",
   "core/instructions/…/config/opencode/opencodeplus/instructions/opencodeplus.md-b129a6b0603a",
   "core/skill-guidance"]}
5  compaction_started {}
7  compaction {"epoch":1,"tokens":{…},"model":{"id":"claude-opus-5-5",…}}
16 agent_switch {"from":"build","to":"plan"}
17 model_switch {"from":"cliproxyapi/claude-opus-5-5","to":"cliproxyapi/claude-fable-5-1"}
18 revert {"to":"msg_10cb511c7001Qy5DOlujlJtsVp"}
19 instruction_update {"keys":[…]}
21 agent_switch {"from":"plan","to":"build"}
22 model_switch {"from":"cliproxyapi/claude-fable-5-1","to":"cliproxyapi/claude-opus-5-5"}
```

Instruction updates (with the changed source keys), compactions (with epoch and
tokens), agent/model switches and a revert are all recorded live. The revert
names the boundary message id exactly (`session.revert.committed` →
`packages/plus/src/monitor/collector.ts:468-477`).

CLIProxyAPI **account switches and quota handoffs** cannot be provoked from the
TUI in a bounded sweep; they are written by `monitorFact` from
`src/quota/controller.ts`. They are covered by the focused test
`test/monitor-requests.test.ts` "context facts recorded and idempotent across
multiple observations", which inserts a real `account_switch` and a
`quota_handoff` fact and asserts them present exactly once (the run's result is
recorded under L6). **PASS (account switch/handoff NOT LIVE: covered by the
named focused test)**.

### L5. Privacy: no contents stored, only hashes/sizes/names/ids/timings

Did: sent unique sentinels in the wire prompts
(`zqxjwvmonitort1sentinel`, `OK2`, `POSTCOMPACT`, `PLANAGENT`, `AFTERREVERT`),
then scanned every column of every table of the owned `monitor.db` read-only for
each sentinel and listed every text column:

```
session 1 sentinels: none
step 6 sentinels: none
call 0 sentinels: none
call_hour 0 sentinels: none
epoch 2 sentinels: none
mark 0 sentinels: none
meta 1 sentinels: none
request 11 sentinels: none
request_fingerprint 11 sentinels: none
context_fact 23 sentinels: none
```

Stored text columns are only ids, kinds, agents, providers, models, variants,
paths/targets, statuses, hashed fingerprints (`body_hash`, per-part/tool hashes,
rolling message hashes), option-key hashes, cache key hash, and the JSON
hash/size records — no message or prompt text. The provider error row stores a
hash, not the message:

```
request 0a2223d8-…: status "error",
 error = {"type":"provider.invalid-request","status":400,"hash":"0dd35a2328c29e26","chars":43}
```

The focused test `test/monitor-requests.test.ts` "privacy: no content stored
(asserting on stored columns)" additionally asserts the forbidden column names
and a secret user prompt/API key absent from `request`, `request_fingerprint`
and `context_fact` (passed, recorded under L6). **PASS**.

### L6. Schema v2 migrates v1 in place; retention 90 days; idempotent writes

Did: read `meta` from the owned live ledger: `[{"key":"schema","value":"2"}]`.
Retention is `RETENTION_DAYS = 90` (`packages/plus/src/monitor/ledger.ts:21`)
and `watchMonitor` prunes `Date.now() - 90d` once per ledger per process
(`plugin.ts:44-45`); the live ledger is minutes old, so pruning cannot be
observed live. Writes are keyed by request id / `(session_id, message_id)` and
upsert, so re-observing the same event is inert.

Focused tests run from `packages/plus`:

- `bun test test/monitor-requests.test.ts test/monitor.test.ts
  test/monitor-plugin.test.ts test/monitor-ledger.test.ts` → **47 pass, 0 fail,
  386 expect() calls** (1.4 s). Includes
  "v1 to v2 migration keeps v1 rows while creating empty v2 tables" (asserts
  `schema=2`, v1 `session`/`step`/`call` rows intact, new tables empty),
  "privacy: no content stored (asserting on stored columns)",
  "context facts recorded and idempotent across multiple observations",
  "observing every event twice writes the same ledger", and "the hourly rollup
  answers exactly what the raw calls answer, through updates and pruning".
- `bun test test/monitor-ledger.test.ts` → **10 pass, 0 fail**, including
  "an older monitor.db migrates in place and keeps its rows readable"
  (adds the `team`, `finish`, `response_id` columns; `schema` becomes `2`; old
  rows still query and `getFingerprint("req_old")` still readable) and
  "two handles share the same durable facts and the revision tracks the other's
  writes" (idempotent shared writes).

**PASS (migration, retention and idempotency by the named focused tests;
schema 2 seen live)**.

## Result

Every end-state line of Monitor T1 verified in this worktree's own build:

1. **L1 PASS** — step, compaction, title and ping requests recorded with time,
   session, kind, agent, provider/model/variant and usage; the refused
   `claude-fable-5-1` request recorded with a hashed error.
2. **L2 PASS** — three keep-alive pings recorded with usage and relabelled from
   `generate` to `ping`.
3. **L3 PASS** — the live `openai-responses` wire body fingerprinted
   (system parts, tools, options, rolling message prefixes, cache key); the chat
   and Anthropic protocols and the fallback by the named focused test.
4. **L4 PASS** — instruction updates, compactions, agent/model switches and a
   revert live; CLIProxyAPI account switch/handoff by the named focused test.
5. **L5 PASS** — no sentinel prompt text in any table; only hashes, sizes,
   names, ids and timings, and the provider error is a hash.
6. **L6 PASS** — live `schema=2`; v1→v2 migration, 90-day retention and
   idempotent writes by the named focused tests.

No source file was changed; only this evidence file.

## Log and cleanup

### Server log

`$DEV/data/opencode/log/opencode-local.log` at cleanup: **232 lines — 225 INFO,
6 WARN, 1 ERROR.**

Every WARN (6 lines, 2 runs of the same refusal) is the expected
`executor-controlled plugin source refused`; no other WARN text:

```
timestamp=2026-10-05T15:28:40.919Z level=WARN run=8a6c78f4 message="executor-controlled plugin source refused" path=/home/bliss/OpenCodePlus/.opencode/opencode.json type=document http.span=91 role=server
timestamp=2026-10-05T15:28:40.919Z level=WARN run=8a6c78f4 message="executor-controlled plugin source refused" path=/home/bliss/OpenCodePlus/.opencode type=directory http.span=91 role=server
timestamp=2026-10-05T15:28:42.643Z level=WARN run=8a6c78f4 message="executor-controlled plugin source refused" path=/home/bliss/OpenCodePlus/.opencode/opencode.json type=document http.span=82 role=server
timestamp=2026-10-05T15:28:42.643Z level=WARN run=8a6c78f4 message="executor-controlled plugin source refused" path=/home/bliss/OpenCodePlus/.opencode type=directory http.span=82 role=server
timestamp=2026-10-05T15:28:42.643Z level=WARN run=8a6c78f4 message="executor-controlled plugin source refused" path=/home/bliss/OpenCodePlus/run/plus/data/opencodeplus/teams/worktrees/opencode/Flash-C-Worker/t1311ea8-20261005-1727/.opencode/opencode.jsonc type=document http.span=82 role=server
timestamp=2026-10-05T15:28:42.643Z level=WARN run=8a6c78f4 message="executor-controlled plugin source refused" path=/home/bliss/OpenCodePlus/run/plus/data/opencodeplus/teams/worktrees/opencode/Flash-C-Worker/t1311ea8-20261005-1727/.opencode type=directory http.span=82 role=server
```

The single ERROR is the deliberately attempted `claude-fable-5-1` request (the
plan-agent line / L1), which the notes say that route rejects:

```
timestamp=2026-10-05T15:42:50.933Z level=ERROR run=8a6c78f4 message="Failed to drain Session" cause="AI.Error: unknown provider for model claude-fable-5-1 … [cause]: AI.Error.InvalidRequest: unknown provider for model claude-fable-5-1" role=server sessionID=ses_ef351470cffe7zANSBNCCogS9V
```

No Monitor or Plus ERROR/WARN in the log (no `plus monitor` line).

### Cleanup

Killed only the session I started:
`pilotty kill -s sweep-m-t1` → `Session 53cd3f4f-9475-4d03-afc8-1154e95e79ef
killed`. `pilotty list-sessions` afterwards:
`['w-f15454a0a1ed9809-b', 'w-1e01-story', 'sweep-i-t7a', 'sweep-m-t3',
'sweep-i-t4b', 'w-f15454a0a1ed9809-a', 'sweep-i-t6', 'ux1', 'rt-t6']` —
`sweep-m-t1` is gone; every remaining session belongs to another run and was
left alone. A kernel scan (`/proc/<pid>/environ` and `/proc/<pid>/cwd`) for
processes pointing into the owned dev home found 0, so no owned launcher or
server survived.

