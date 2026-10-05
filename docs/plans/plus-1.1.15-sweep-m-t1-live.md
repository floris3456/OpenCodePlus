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

_TODO_

### L3. Request fingerprint, as sent, protocol-aware

_TODO_

### L4. Context facts (account switch/handoff, instruction updates, compactions, agent/model switches, reverts)

_TODO_

### L5. Privacy: no contents stored, only hashes/sizes/names/ids/timings

_TODO_

### L6. Schema v2 migrates v1 in place; retention 90 days; idempotent writes

_TODO_

## Log and cleanup

_TODO_
