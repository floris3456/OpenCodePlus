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
`request`, `request_fingerprint`, `context_fact`, `step` present. The error path
is exercised below (L1e). **PASS** (L1e still to add).

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

Did: read `request_fingerprint` for the chat's five wire requests. All are
`openai-responses` (the protocol in use for CLIProxyAPI here), each with a
`body_hash`, and every key the contract names:

```
systemParts (18 entries, 5 requests): base template (892 chars), system:1,
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
rolling prefix divergence, cache-control markers and the fallback), which
passed in the run recorded under L6. **PASS**.

### L4. Context facts (account switch/handoff, instruction updates, compactions, agent/model switches, reverts)

_TODO_

### L5. Privacy: no contents stored, only hashes/sizes/names/ids/timings

_TODO_

### L6. Schema v2 migrates v1 in place; retention 90 days; idempotent writes

_TODO_

## Log and cleanup

_TODO_
