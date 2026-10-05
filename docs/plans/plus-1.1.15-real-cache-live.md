# B4 real cache misses — owned live acceptance (T112 replacement for T110)

Evidence-only run on the landed Monitor/category/request-status HEAD. No source
edits, no shared-service access, no TTL fabrication. This document is committed
incrementally as cases are observed.

- Run: `w-7d5568cc18d6482c` (`Flash-C-Worker`, task T112)
- Worktree: `/home/bliss/OpenCodePlus/run/plus/data/opencodeplus/teams/worktrees/opencode/Flash-C-Worker/t1127d55-20261005-1040`
- Branch: `team/Flash-C-Worker/t1127d55-20261005-1040`
- Base/HEAD at start: `dad2863cd427ee96eb8c875bb514e8930fbe565a`
- Live build: `pilotty spawn --name continuation-cache-proof opencodeplus-dev .`
  from the worktree (own home / own server; never `dev`, `dev:live` or the
  shared service on 40375).
- Owned dev home:
  `/home/bliss/OpenCodePlus/run/plus-dev/run-plus-data-opencodeplus-teams-worktrees-opencode-Flash-C-Worker-t1127d55-20261005-1040`
- Actual server log (kernel fd): `<home>/data/opencode/log/opencode-local.log`
- Route: `cliproxyapi/claude-opus-5-5@high` (Build) — the already-observed
  working route. DeepSeek helper route used for the model-switch case.
- Session: `ses_ef4c1b688ffeCt0a1OoliAT748`

This is an **evidence-only** task: no production file is changed.

## Case 1 — instruction toggle between two requests (observed)

- Preconditions: two same-context baseline messages on
  `Build · claude-opus-5-5@high`:
  - `BASELINE-ONE` request `8a590b01-cce1-4ce1-956a-46baf570a9c8` (08:46:34Z,
    cold, cache read 0).
  - `BASELINE-TWO` request `da91778f-58f7-4a8e-b85b-1aa37686aa2f` (08:47:16Z,
    cache read 5026, hit).
- Deliberate change: Instructions › Global › Agents › build › System ›
  `Tools and rules` toggled **off** at `2026-10-05T08:54:22.913Z`
  (record `"item":"system:tools-and-rules","state":"off"`). This row is a
  documented, user-owned system row (source key
  `core/instructions/...tools-and-rules`), so it is a legitimate instruction
  toggle, not a fabricated segment edit.
- Next message `AFTER-TOGGLE` request
  `f0742a0a-0305-41a9-90f4-2ed7d3787910` at `2026-10-05T08:54:45Z`
  (screen: `AFTER-TOGGLE`, `Build · claude-opus-5-5 · 1.9s`).
- Ledger row: step, build, cliproxyapi/claude-opus-5-5@high, completed,
  input 7705, cache_read 5026, cache_write 0, output 13.
- Fingerprint comparison (`request_fingerprint`):
  - Before (`da91778f`): `... | system:7:f73228ef(1495) | system remainder:0:15 |
    system:8:9773c841(238) | system remainder:0:17:23d40031(584)`
  - After (`f0742a0a`): `... | system:7:f73228ef(1495) | system remainder:0:15 |
    system:8:9773c841(238)` — the trailing `system remainder:0:17` part is gone.
  - `body_hash` before `74f92574715ba9ae` → after `ec91885d1318a175`
    (changed); options hash unchanged.
- `monitor.query` page (Cache tab, this session): row
  `10:54:45 step [PARTIAL] prefix-changed ... system pa...17 removed`,
  read 5k.
- Detail (Enter on `f0742a0a-0305-41a9-90f4-2ed7d3787910`):
  - `Cause: prefix-changed (certain)`
  - `Expected prefix: 7.9k tokens`
  - `Cache read: 5k`
  - `Miss tokens: 2.9k`
  - `Gap since last request: 3.5m · Cache lifetime: 5m · Warming: ended`
  - `Pings on the prefix: 1 · last at 10:51:16`
  - `First diverging segment: system part system remainder:0:17 removed`
- Interpretation: the analyzer reports the **actual** first divergence it can
  see in the final wire fingerprint (a removed system part), verdict PARTIAL
  because cache read 5026 ≈ 64% of the expected 7900. No TTL claim is made. A
  separate `session.instructions.updated` context fact was not surfaced on this
  page for the toggle; the divergence itself is real and named.

## Case 2 — model switch between two requests (observed)

- Deliberate change: composer `Switch model` → `deepseek-v4.1-flash-cheap`
  (variant `Default`), `2026-10-05T08:59:10Z`.
- Next message `AFTER-MODEL-SWITCH` request
  `98529009-1a15-409d-a52a-80a21a19b096` at `08:59:17Z`
  (screen: `AFTER-MODEL-SWITCH`, `Build · deepseek-v4.1-flash-cheap · 1.6s`).
- Ledger row: step, build, cliproxyapi/deepseek-v4.1-flash-cheap@default,
  completed, input 8384, cache_read 0, cache_write 0, output 9.
- Context fact: `model_switch {"from":"cliproxyapi/claude-opus-5-5",
  "to":"cliproxyapi/deepseek-v4.1-flash-cheap"}` at 08:59:19Z.
- Cache-tab row: `10:59:17 step [COLD] model-switch 0 Model / v...ap/default`.
- Detail (`98529009-…`): `Cause: model-switch (certain)`, `Cache read: 0`,
  `Miss tokens: 0`, `Gap since last request: — · Cache lifetime: — · Warming:
  ended`, `Pings on the prefix: 1 · last at 10:58:45`, evidence
  `Model / variant switched: cliproxyapi/claude-opus-5-5/high →
  cliproxyapi/deepseek-v4.1-flash-cheap/default`. COLD is the expected
  cold-start verdict, not counted as a miss.

## Case 3 — agent switch between two requests (observed)

- Preconditions to isolate the agent: Plan agent's model set to
  `cliproxyapi/claude-opus-5-5@high` in Instructions (Global › Agents › plan ›
  Models, `2026-10-05T09:07:59Z`), then two same-agent Plan messages:
  - `PLAN-BASE` request `64e5f88e-ddec-4a6c-aceb-e9f2e695e5fb` at 11:05:46Z,
    agent plan, opus@default, cache read 13410.
  - `BUILD-BEFORE-AGENT` request `16f87478-7935-48b7-96a6-2de5626e3d9d` at
    11:08:31Z, agent build, opus@high, cache read 5026.
- Deliberate change: composer agent toggled `build → plan` (back-tab) at
  `2026-10-05T09:09:32.986Z` (`agent_switch {"from":"build","to":"plan"}`).
- Next message `PLAN-AGENT-ONE` request
  `d4b8ba29-79b3-49a5-9813-335ed010df7a` at `11:09:31Z`, agent plan,
  opus@high, cache read 13437.
- Cache-tab row: `11:09:31 step [COLD] agent-switch 13.4k Agent swi...ild → plan`.
- Detail (`d4b8ba29-…`): `Cause: agent-switch (certain)`, `Expected prefix: 0`,
  `Cache read: 13.4k`, `Miss tokens: 0`,
  `Gap since last request: 59.9s · Cache lifetime: 5m · Warming: on`,
  `First diverging segment: system part base template`, evidence
  `Agent switched: build → plan`. COLD is the expected cold-start verdict.
- Note: the model+variant matched (opus@high) so the cause is the agent switch,
  as the analyzer reports.

## Case 4 — warming off, real wallclock gap past the analyzer lifetime (observed)

- Deliberate change: Defaults › Models › `cliproxyapi/claude-opus-5-5` ›
  `Warming` set to **off** at `2026-10-05T09:18:15.884Z` (record
  `"modelSettings","level":"defaults","providerID":"cliproxyapi",
  "modelID":"claude-opus-5-5","warming":"off","interval":"4m"`). No
  timestamp/ledger mutation and no provider-config change; the ordinary UI edit
  only.
- Last real request before the gap: `GAP-BEFORE` request
  `ef0ec86f-e99d-4917-a6bf-38303a06a383` at `2026-10-05T09:18:35.389Z`
  (started 1791191915389). Last ping ever: `11:13:31Z`-window ping at
  09:13:31Z; **no warming ping fired after 09:17:34Z** — the next `warming
  session` log line does not exist, so the cache really was not refreshed.
- Next message `GAP-AFTER`: request
  `d387a377-1d65-4032-a099-48328d9c5e8b` at `2026-10-05T09:25:54.451Z`
  (started 1791192354451), agent plan, cliproxyapi/claude-opus-5-5@high,
  completed, input 13803, cache_read 0, cache_write 0, output 10.
- Real gap: `1791192354451 - 1791191915389 = 439062 ms` = **7.32 minutes**
  (wallclock), reported by the page as `Gap since last request: 7.3m`.
- Cache-tab row (misses-only `x`): `11:25:54 step [MISS] cache-expired 0
  Reusable ...warming on`.
- Detail (`d387a377-…`): `Cause: cache-expired (likely)`,
  `Expected prefix: 13.8k tokens`, `Cache read: 0`, `Miss tokens: 13.8k`,
  `Gap since last request: 7.3m · Cache lifetime: 5m · Warming: on`,
  `Pings on the prefix: 0`,
  evidence `Reusable prefix unchanged; gap 439062ms exceeds lifetime 300000ms;
  last ping none; warming on`.
- Honest qualification: the page's `Warming: on` comes from the stored
  `warming` context fact read for that request; although the model-level
  default was saved `off` 20 s earlier and no ping fired in the gap, the fact
  recorded at the pre-gap activity hook still said `on`. The expiry evidence is
  the real measured gap (439062 ms) versus the analyzer's inferred 300000 ms
  lifetime for this route, not a provider-reported TTL. DeepSeek/CPA lifetime
  stays unknown elsewhere; the 5m here is the Claude/CPA analyzer branch.

## Case 5 — compaction between two requests (observed)

- Pre-gap request `d387a377-1d65-4032-a099-48328d9c5e8b` (the case-4 miss).
- Deliberate change: `Compact session` at `2026-10-05T09:30:20.903Z`
  (compaction request `cb70dde7-a682-439c-bbc5-c1bf7805c9a1`, kind
  `compaction`, agent plan, opus@high, completed, input 9421, cache_read 5026,
  cache_write 0, output 632). Context facts:
  `compaction_started {}` at 1791192620872 and
  `compaction {"epoch":1,"tokens":{...},"model":{"id":"claude-opus-5-5",
  "providerID":"cliproxyapi","variant":"high"}}` at 1791192628266.
- Next message `AFTER-COMPACT` request
  `33594a72-f76b-435c-9f5f-a13c8fef7d97` at `11:31:06Z`, agent plan,
  opus@high, completed, input 8261, cache_read 5602, cache_write 0, output 157.
- Cache-tab row: `11:31:06 step [MISS] prefix-changed 5.6k message 2...e) changed`.
- Detail (`33594a72-…`): `Cause: prefix-changed (certain)`,
  `Expected prefix: 14.3k tokens`, `Cache read: 5.6k`, `Miss tokens: 8.3k`,
  `Gap since last request: 1.8s · Cache lifetime: 5m · Warming: on`,
  `First diverging segment: message 2 (message)`.
- Note: the compaction is a real context rewrite (two steps run after the
  compaction request), so the analyzer reports the *actual* first divergent
  segment it sees rather than the `compacted` cause label; the divergence is
  real and named. No fabricated cause.

## In-chat Code Mode `monitor.query` equality (observed)

In *the same chat* (`ses_ef4c1b688ffeCt0a1OoliAT748`), the agent ran real Code
Mode calls: `monitor.query({view:'cache',missesOnly:true})` and
`monitor.query({view:'cache',id:'33594a72-f76b-435c-9f5f-a13c8fef7d97'})`. Two
`monitor.query` calls are recorded in the ledger (call ids
`toolu_01S6rWJmFQUaKMQiZVBCGN3H#0`/`#1`, started 1791192806216). The agent's own
summary (verbatim from `session_message`:164):

- Misses list `view:'cache', missesOnly:true`:

  | requestID | verdict | cause | confidence | expected | actual cache read | gap/lifetime | warming |
  |---|---|---|---|---|---|---|---|
  | `da91778f-58f7-4a8e-b85b-1aa37686aa2f` | miss | unknown | unknown | 12851 | 5026 | not reported | not reported |
  | `f0742a0a-0305-41a9-90f4-2ed7d3787910` | partial | prefix-changed | certain | 7910 | 5026 | not reported | not reported |
  | `d387a377-1d65-4032-a099-48328d9c5e8b` | miss | cache-expired | likely | 13775 | 0 | 439062 ms / 300000 ms | on (last ping: none) |
  | `33594a72-f76b-435c-9f5f-a13c8fef7d97` | miss | prefix-changed | certain | 14267 | 5602 | not reported | not reported |

  plus a fifth row `9b61603b-3857-4517-a8f0-2b2450d560cf` (miss, unknown) that
  was the still-running assistant step of this very turn at query time (see
  the note below). Listed totals: 19 requests, 5 misses, 32745 miss tokens,
  hit rate 0.602.
- Detail for `33594a72-f76b-435c-9f5f-a13c8fef7d97` as returned by the tool:
  - requestID `33594a72-f76b-435c-9f5f-a13c8fef7d97` (step, plan,
    `claude-opus-5-5`/high)
  - verdict `miss`; cause `prefix-changed`; confidence `certain`
  - expected tokens `14267` (segment-size estimate)
  - actual cache read `5602` (miss tokens `8261`)
  - gap/lifetime `1750 ms / 300000 ms`; warming `on`
  - first divergence `message 2 (message)`; previous request
    `3b486a9b-4c25-41f8-a7bc-cdeae525c3a7`
  - changed segments: `message 2` hash `2c2fff53d0179d20` (549 chars, 220 tok) →
    `6851779cfa9dbbfa` (108 chars, 44 tok); `message 3` hash
    `bcaac7fc30ab5fe7` (108 chars, 44 tok) → `ce8a49d56487a1f8` (158 chars,
    64 tok)
  - miss cost unavailable (no per-token pricing recorded)

Equality: the page Cache-tab detail for `33594a72-…` shows exactly
`[MISS] prefix-changed (certain)`, expected `14.3k`, cache read `5.6k`, gap
`1.8s`, lifetime `5m`, warming `on`, first diverging segment
`message 2 (message)`. The tool's `14267`/`5602`/`1750 ms`/`300000 ms` are the
same values with full precision. The tool answer matches the page.

Note (honest, not a fabricated acceptance): at the moment the tool ran, the
assistant's own in-flight step was already in the ledger as a running row with
no usage yet, so the analyzer listed it as `miss`/`unknown`. By the time the
page was read that same row had completed with `cache_read 13859` (a hit). The
difference is query timing, not a contradiction or a claimed defect.

## #25 — T110 owned warming WARN classification (read-only)

- Source of the finding: the stopped T110 home
  `/home/bliss/OpenCodePlus/run/plus-dev/run-plus-data-opencodeplus-teams-worktrees-opencode-Flash-C-Worker-t110991f-20261005-0935`,
  read only; nothing in it was modified.
- The one non-confinement WARN, verbatim:
  `timestamp=2026-10-05T07:55:46.253Z level=WARN run=297e5649 message="failed to
  warm session" sessionID=ses_ef4f9769dffe8KzRX1mNLbDXBl
  cause="Cause([Fail(Session.AgentNotFoundError: Agent not found: \"build\")])"
  role=server`.
- Hash check: the reported `cause` encoding hash `a8a0a01a366f4450`/71 chars is
  the JSON-encoded log field
  `"Cause([Fail(Session.AgentNotFoundError: Agent not found: \"build\")])"`
  (71 chars, sha256 prefix `a8a0a01a366f4450`). The raw unencoded cause is 67
  chars (`2c2c74298671915b`). So the reported identifier is the log-quoted form,
  not a different message.
- Actual boundary: `packages/core/src/plugin/warming.ts:118-125` calls
  `ctx.session.generate(ping)` with the **pinned** `agent: current.agent` and
  `Effect.catchCause` logs `failed to warm session`. The error itself comes from
  `packages/core/src/session/context.ts:139-141`
  (`agents.select(pinned ?? session.agent)` returned no info →
  `new AgentNotFoundError({ sessionID, agent: pinned ?? … })`). So the pinned
  agent id `build` did not resolve in the location's agent registry at that
  instant.
- What happened around it in the same owned log:
  - `07:51:44Z` a ping succeeded (`providerID=cliproxyapi
    modelID=claude-opus-5-5`, usage cache read 12875).
  - `07:53:24.670Z` `POST /api/rpc/opencode.plus/link.set` returned HTTP 400.
  - `07:54:40.585Z` `provider.updated`/`model.updated` fired for the project
    directory (count=2); `07:54:50.587Z` the same pair fired for
    `packages/cli` (count=1). This is active host config/Instructions churn
    inside the T110 session's own home.
  - `07:55:46.251Z` the next ping started, then failed with the WARN above.
  - `07:59:46.265Z` the following ping succeeded again on the same pinned
    agent/model.
- Classification: a **single, transient** failure. The pinned agent `build`
  was not resolvable for one ping during concurrent host config/instruction
  mutation (a `link.set` 400 plus provider/model update events), and the next
  ping resolved normally. It is not shutdown noise (cleanup happened later), it
  did not recur, and no request/ledger content or credential was involved.
- No source defect is established from this evidence: the failure is caught by
  the warming loop's designed failure control, and the transient non-resolution
  is consistent with a host catalogue reload. Pinned-agent fallback/retry on a
  transient `AgentNotFoundError` would be a design change, not a demonstrated
  bug, so none is made here (source is out of this evidence-only task's scope);
  it is left for the parent to assign if wanted.
- Own log for this run: see the Run log classification section below.

## Parent review (residual run, 2026-10-05)

The worker stopped before writing its run-log section or any Basic team result,
so the line above points at nothing. The parent checked every cited request,
fingerprint, context fact and log line read-only against the owned home's
`monitor.db` and `opencode-local.log`. Ledger values (tokens, statuses, start
times, the 439062 ms gap, body hashes, the two `monitor.query` calls) match.
What holds and what does not:

- **Case 1 holds, with one wrong label.** The toggle removed the last system
  part and the analyzer named it (PARTIAL, prefix-changed, certain). But
  `BASELINE-TWO` (`da91778f`) was not a hit: the in-chat tool lists it as
  miss/unknown (expected 12851, read 5026). The part is named by position
  (`system remainder:0:17`), not by its source row.
- **Case 2 holds.** The `model_switch` fact is stamped 08:59:19, after the
  request; it is the hook time, not the moment of the switch.
- **Case 3 holds.** The same applies to `agent_switch` at 09:09:32.986Z, which
  is after the request at 09:09:31.537Z. Times written `11:xxZ` are local time.
- **Case 4: cause holds, warming state does not.** The 7.3 m gap and
  cache-expired (likely) are real. The last ping before the gap was at
  09:17:34Z, not 09:13:31Z. The detail and the tool say `Warming: on`, but
  warming was off: no ping fired in the gap and core logged no new schedule.
  This is issue #26 (see the overnight log): the Monitor records core's
  proposed warming settings before Plus decides them.
- **Case 5 is not shown.** `33594a72` is the second step after the
  compaction; its previous request `3b486a9b` is already after the
  compaction, so prefix-changed is right for that pair. The first step after
  the compaction (`3b486a9b`) is absent from the in-chat misses list, which
  suggests it was not counted as a miss, but its verdict and cause were never
  read. The compacted/cold-start cause stays unverified.
- **monitor.query equality holds** for `33594a72`.
- **#25:** the WARN line and its surroundings are as quoted. The parent
  disposition is in the overnight log.
