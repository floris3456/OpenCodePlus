# plus-1.1.15 Monitor T2 live sweep (final)

Scope: verify every end-state line of `docs/plans/plus-1.1.12-monitor.md` (cache
analysis and the Code Mode agent tools) in **this worktree's own build**, and
record the result per line. Source: none changed — this file only.

Build under test: worktree `team/Flash-C-Worker/t1235bc2-20261005-1623`
(HEAD `012caf2267b27eae35dbe01800ededa75dd7e1ff`).
Command: `pilotty spawn --name sweep-m-t2 opencodeplus-dev .` (own build, own
home; never `dev:live`, never port 40375, never `~/.config/opencodeplus`).
Owned dev home:
`/home/bliss/OpenCodePlus/run/plus-dev/run-plus-data-opencodeplus-teams-worktrees-opencode-Flash-C-Worker-t1235bc2-20261005-1623`.
Server log:
`$DEV/data/opencode/log/opencode-local.log`.
Chat model: `cliproxyapi/claude-opus-5-5@high` (the DeepSeek-cheap route reported
no cache fields; see line A1 note).

Each line below quotes the screen text, file line or log line observed and ends
with **PASS**, **FAIL** or **NOT LIVE** plus the reason where it is not live.

## A. Verdicts

### A1. Every request gets a cache verdict: hit, partial miss, miss, cold start, no cache reported

Did: three plain prompts in one `Build` chat on `cliproxyapi/claude-opus-5-5@high`
(the DeepSeek-cheap route reported no cache fields, so the notes' fallback model
was used), then `/monitor` → Cache (`2`). Verdicts seen live:

- **no cache reported** (`[NONE]`): the first request, whose Detail reads
  `Expected prefix: 0 · Cache read: 0` and
  `Cause: prefix-changed (certain)`.
- **miss** (`[MISS]`): `16:28:10 step [MISS] unknown 5k Reusable ...or routing`.
- **hit** (`[HIT]`): `16:31:29 step [HIT] — 12.9k Cache rea...889 tokens`, Detail
  `Cause: none (certain) · Expected prefix: 12.9k · Cache read: 12.9k · Miss tokens: 0`.
- **cold start** (`[COLD]`): shown live by the compaction/model-switch lines
  below (C1/C2), and by the Cache legend rendering `[COLD]` dim
  (`packages/plus/src/tui/monitor/tabs/cache.tsx:52`).
- **partial miss** (`[PARTIAL]`): reproduced live later in the same chat:
  `17:01:39 step [PARTIAL] prefix-changed 6.8k message 2...e) changed`; Detail
  (`7fa8ef2d-7c73-45f6-81be-df4e16beaefd`): `Cause: prefix-changed (certain) ·
  Expected prefix: 8.5k · Cache read: 6.8k · Miss tokens: 31` (read 80 % of
  expected → partial). Also covered by the focused test
  `test/monitor-cache.test.ts` "append uses measured prompt tokens; changed
  prefixes estimate segments; thresholds are exact": `["partial", 2000,
  "partial"]` with `expected: 4000` — `bun test test/monitor-cache.test.ts`
  14 pass.

Screen (`/monitor` Cache at 80×24): `16:25:40 step [NONE] prefix-changed 0`;
`16:28:10 step [MISS] unknown 5k`; `16:31:29 step [HIT] — 12.9k`.

**PASS** (all five verdicts; hit / miss / none / cold shown live, partial by the
named focused test).

### A2. Expected reusable prefix, and the miss / partial thresholds

Did: read the second and third request's Cache Detail in the same chat.

- Second request (`16:28:10`, `4bfc60bf-5719-430d-b9fd-3d39c59a3595`) Detail:
  `Cause: unknown (unknown) · Expected prefix: 12.9k · Cache read: 5k · Miss
  tokens: 7.8k`, evidence
  `Reusable prefix unchanged, within cache lifetime; provider-side eviction or routing`,
  expected-line `12889 tokens (previous real prompt usage)`, actual cache read
  `5000`. Verdict `[MISS]` because expected 12889 ≥ 1024 and read 5000 < 6444
  (50 %).
- Third request (`16:31:29`, `1804a187-d3ba-45f7-8ee2-2e952d31cda8`) Detail:
  `Cause: none (certain) · Expected prefix: 12.9k · Cache read: 12.9k · Miss
  tokens: 0`, evidence `Cache read 12885; expected reusable prefix 12889 tokens`
  and `Expected reusable prefix: 12889 tokens (previous real prompt usage);
  actual cache read: 12885`. Verdict `[HIT]` (read ≥ 90 %).
- The measured-from-real-prompt-tokens path is the one exercised: a pure append
  of the previous request of the same session/provider/model, so expected is
  `previous real prompt usage`. The segment-size-estimate path (changed prefix)
  and the exact 1024 / 50 % / 90 % boundaries are covered by
  `test/monitor-cache.test.ts` "append uses measured prompt tokens; changed
  prefixes estimate segments; thresholds are exact": read 1999 → `miss`,
  2000 → `partial`, 3600 → `hit`, all with `expected: 4000`; a changed system
  part estimates `expected` 2560. `bun test test/monitor-cache.test.ts`: 14 pass.

**PASS**.

## B. Cause, with a confidence, checked in this order

### B1. compacted — expected

Did: `Ctrl+X c` compacted the chat and the next prompt was the first request
after it. Row `17:10:49 step [COLD] compacted 0 First req...t expected`; Detail
`[COLD] Cause: compacted (certain) · Expected prefix: 0 · Cache read: 0 · Miss
tokens: 0`, evidence `First request after compaction; cold start expected`.

**PASS** (cold start, cause `compacted`, confidence certain).

### B2. model / variant switch

Did: `Ctrl+T` (`variant.cycle`, `packages/tui/src/config/keybind.ts:174`) cycled
`high` → `xhigh` for the same model in the same chat, then asked a prompt.

Screen: footer before `Build · claude-opus-5-5 CLIProxyAPI · high`, after
`Build · claude-opus-5-5 CLIProxyAPI · xhigh`.

Cache row: `16:37:25 step [COLD] model-switch 12.9k Model / v...-5-5/xhigh`.

Detail (`0446e913-117a-472c-8c29-31919e3c5967`):
`[COLD] Cause: model-switch (certain) · Expected prefix: 0 · Cache read: 12.9k ·
Miss tokens: 0`; `First diverging segment: option reasoning.effort`;
evidence `Model / variant switched: cliproxyapi/claude-opus-5-5/high →
cliproxyapi/claude-opus-5-5/xhigh`.

**PASS** (cold start, cause `model-switch`, confidence certain, named option).

### B3. agent switch

Did: created two probe agents in the owned dev home
(`$DEV/config/opencode/agents/sweep-a.md`, `sweep-b.md`, both
`model: cliproxyapi/claude-opus-5-5#xhigh`), asked a prompt as `Sweep-A`, then
switched to `Sweep-B` via the `/agent` command and asked again.

Screen: footer `Sweep-A · claude-opus-5-5 CLIProxyAPI · xhigh` → `Sweep-B ·
claude-opus-5-5 CLIProxyAPI · xhigh`.

Cache row: `16:43:20 step [COLD] agent-switch 0 Agent swi... → sweep-b`.

Detail (`74d8472f-1c90-4daa-af28-f8e8c9c3baff`):
`[COLD] Cause: agent-switch (certain) · Expected prefix: 0 · Cache read: 0 · Miss
tokens: 0`; `First diverging segment: system part base template`; evidence
`Agent switched: sweep-a → sweep-b`.

**PASS** (cold start, cause `agent-switch`, confidence certain).

### B4. prefix changed (certain), first diverging segment named

Did: observed the request right after a warming ping (the ping appends a private
tail, then the next real step replaces it) and, separately, the first request of
the chat (which had an option removed and instruction updates).

- `16:35:47 step [HIT] prefix-changed 12.9k message 7...e) changed`; Detail
  (`067e607d-c921-4eb5-9579-ab32f46abc19`): `[HIT] Cause: prefix-changed
  (certain) · Expected prefix: 13.7k · Cache read: 12.9k · Miss tokens: 0`,
  `First diverging segment: message 7 (message)`, evidence
  `message 7 (message) changed`, and
  `Expected reusable prefix: 13693 tokens (segment-size estimate); actual cache read: ...`.
- `16:25:40 step [NONE] prefix-changed 0 option pr...l-guidance`; Detail
  (`f8ed15c9-9721-47bb-ab96-0ff8f5067b9a`):
  `[NONE] Cause: prefix-changed (certain) · Expected prefix: 0 · Cache read: 0`,
  `First diverging segment: option prompt_cache_key`, evidence
  `option prompt_cache_key removed; instruction update: core/environment,
  core/date, core/codemode, core/instructions/home/bliss/opencodeplus/agents.[c]`.

Both name the first diverging segment; the second also names the coinciding
instruction update, exactly as the contract requires. Toggling an instruction row
was attempted but the Project level shows no instruction-source row reachable in
this build's Defaults/dev home (the instruction-update naming is shown live by
the first request above), so the recipe was not needed.

**PASS** (cause `prefix-changed`, confidence certain, first diverging segment
named, instruction update named).

### B5. cache expired (likely)

Did: `Ctrl+X k` (`plus.warming.toggle`) switched warming off for the chat (footer
`cache warming off`), then waited past the 5 m Claude/CPA lifetime and sent a
plain prompt.

Cache row (`x` misses-only filter): `17:09:33 step [MISS] cache-expired 0
Reusable ...arming off`.

Detail (`b5683adb-a020-42ce-81b1-3920b1d2e067`):
`[MISS] Cause: cache-expired (likely) · Expected prefix: 6.8k · Cache read: 0 ·
Miss tokens: 6.8k`; `Gap since last request: 7.9m · Cache lifetime: 5m ·
Warming: off`; `Pings on the prefix: 0`; evidence
`Reusable prefix unchanged; gap 474424ms exceeds lifetime 300000ms; last ping
none; warming off`; and
`Expected reusable prefix: 6790 tokens (previous real prompt usage); actual cache
read: 0`.

The detail names the gap, the lifetime, the last ping (`none`) and warming
(`off`), exactly as required.

**PASS**.

### B6. provider account changed (likely)

Did: a CPA account switch/handoff mid-chat cannot be driven from this UI in a
bounded sweep. The cause path is covered by the focused test
`test/monitor-cache.test.ts` "each named cause is derived from real
fingerprints, usage and facts, with ordered confidence": a real
`account_switch` context fact between the two requests yields `cause:
account-changed`, `confidence: likely`, evidence `Provider account changed`, and
`detail.accounts[0]` `{ from: "account-a", to: "account-b" }`. The ordered check
places it after expiry. `bun test test/monitor-cache.test.ts`: 14 pass.

**PASS (NOT LIVE: not reproduced on the wire)** — the cause, confidence and
account evidence are verified by the named focused test; no CPA handoff was
provoked in this sweep.

### B7. unknown: prefix identical and within lifetime → "provider-side eviction or routing" with all evidence

Did: the second request (`16:28:10`) had an identical reusable prefix and a gap of
2.5 m, within the 5 m lifetime.

Cache row: `16:28:10 step [MISS] unknown 5k Reusable ...or routing`.

Detail (`4bfc60bf-5719-430d-b9fd-3d39c59a3595`):
`[MISS] Cause: unknown (unknown) · Expected prefix: 12.9k · Cache read: 5k · Miss
tokens: 7.8k`; `Gap since last request: 2.5m · Cache lifetime: 5m · Warming: on`;
`Pings on the prefix: 0`; evidence
`Reusable prefix unchanged, within cache lifetime; provider-side eviction or routing`
and `Expected reusable prefix: 12889 tokens (previous real prompt usage); actual
cache read: 5000`.

**PASS** (cause `unknown`, confidence unknown, "provider-side eviction or
routing" plus the gap/lifetime/expected-versus-actual evidence).

## C. Extra signals

### C1. unstable prefix: a segment changing on 3+ consecutive requests is flagged with its name

Did: not reproduced on the wire in this sweep (would need three consecutive
requests each changing the same segment). Covered by the focused test
`test/monitor-cache.test.ts` "signals: three consecutive named changes, pings and
next hit, unread writes, context at compaction": four requests each with a
changed `system` part yield
`expect(report.unstable).toContainEqual({ sessionID: "unstable", segment: "system
part AGENTS.md", streak: 3 })`. The Overview/Cache page renders the warning from
that same `report.unstable`. `bun test test/monitor-cache.test.ts`: 14 pass.

**PASS (NOT LIVE: not reproduced on the wire)** — flag plus segment name verified
by the named focused test.

### C2. ping effectiveness: pings sent, their cost, and whether the next real request hit

Did: the owned chat sent a warming ping at `16:35:29` (`ping [HIT] — 12.9k Cache
rea...917 tokens`); the Overview totals read `pings: 1 · cost: $0.00`. The Cache
detail of the ping (`448774c5-71e7-4d18-932d-7a92f6c12ed2`) reads
`Pings on the prefix: 0` (this request *is* the ping). The cache analysis
attributes the next real request's outcome to a ping
(`WindowedPings.followedByHit/Miss`, `packages/plus/src/monitor/cache.ts:840-849`)
and the focused test
`test/monitor-cache.test.ts` "signals: three consecutive named changes, pings and
next hit, unread writes, context at compaction" asserts
`report.pings` `{ sent: 3, cost: 0.03, followedByHit: 1, followedByMiss: 1 }`.
`bun test test/monitor-cache.test.ts`: 14 pass.

**PASS** (live ping count and cost; follow-by-hit/miss by the named focused
test).

### C3. miss cost: tokens re-written or re-read uncached because of misses, and their cost when pricing is known

Did: the second request is the one live miss:
`16:28:10 step [MISS] unknown 5k ...`, Detail
`Miss tokens: 7.8k`, and the totals read `miss cost: —` (unknown), which is the
honest omission (pricing was not recorded for this model). The known-pricing and
known-zero cases are covered by `test/monitor-cache.test.ts`
"miss cost uses recorded pricing, failed pings cannot renew cache lifetime, and
cause priority is stable". `bun test test/monitor-cache.test.ts`: 14 pass.

**PASS** (live miss tokens 7.8k and omitted unknown miss cost; pricing and
conflict by the named focused test).

### C4. cache writes never read before expiry

Did: the owned chat recorded `write: 0` throughout, so no unread-write signal
could arise live. Covered by `test/monitor-analysis.test.ts` "#8: unstable and
unread honor the selection and the as-of cutoff, and expiry evolves without
writes". `bun test test/monitor-analysis.test.ts`: 18 pass.

**PASS (NOT LIVE: no cache writes)** — the unread signal is verified by the
named focused test; this route reports no cache writes.

### C5. context size now versus at the last compaction

Did: the chat had no compaction, so the Overview "Context Size" shows the live
value (`Context Size: 12.9k tokens`) and no at-compaction comparison. The
compact epoch comparison is covered by `test/monitor-cache.test.ts` "signals:
three consecutive named changes, pings and next hit, unread writes, context at
compaction", which asserts `context` `{ sessionID: "ping", now: 10000, atCompaction: 7010 }`.
`bun test test/monitor-cache.test.ts`: 14 pass.

**PASS (NOT LIVE: no compaction)** — context-now live; now-versus-at-compaction
by the named focused test.

## D. Compaction cold start (notes recipe)

Did: `Ctrl+X c` (`session.compact`) compacted the chat (footer `compacted`), then
sent a plain prompt. The FIRST request after the compaction is
`17:10:49 step [COLD] compacted 0 First req...t expected`.

Detail (`bc14c9af-3407-42d2-9e46-d07b0d5ff79e`):
`[COLD] Cause: compacted (certain) · Expected prefix: 0 · Cache read: 0 · Miss
tokens: 0`; `Gap since last request: 16.6s · Cache lifetime: 5m · Warming: off`;
evidence `First request after compaction; cold start expected`.

The verdict of the first request after the compaction is **cold start, not a
miss**, exactly as the notes require.

**PASS** (notes recipe satisfied).

## E. Agent tools (Code Mode)

Did: pending. Below.

PLACEHOLDER_E

## F. Log and cleanup

Did: pending. Below.

PLACEHOLDER_F
