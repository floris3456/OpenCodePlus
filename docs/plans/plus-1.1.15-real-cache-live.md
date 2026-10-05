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

Status of remaining cases: **in progress** (warming-off delay, compaction). The
`monitor.query` in-chat Code Mode equality proof and the basic Project team
delegation are recorded further below when observed.
