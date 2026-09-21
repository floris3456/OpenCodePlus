# T2 — Rule messages everywhere: evidence and remaining scope

Base: `f0522d90f2537ebcd4a516b50122e951f4503fc6`. The T2 checkpoint commit
is `943db15974630eecbdf9fb185aa3714d4ec588d4`; this file ships with it.

## What this worker changed

Source (all inside `scope.paths`):

- `src/instructions/model.ts` — `RuleRecord.message?: string`.
- `src/instructions/tool-permissions.ts` — `CuratedRule.message?`; every
  `RawRule` now requires a short one-line message and `curatedRules` carries
  it; `mergeRules` keeps the curated message on a pattern-set collision;
  `validateRuleInput` accepts and trims `message` (blank → absent);
  `curatedRuleMessage(tool, ruleId)` is the one lookup for a shipped message.
- `src/instructions/apply.ts` — `ApplyInput.rules?: readonly RuleRecord[]`;
  `permDenials` installs `message` on every core deny a row emits, preferring
  the user record's own message for a `custom` row and falling back to the
  curated message; `pushRule` already encoded the field.
- `src/rpc.ts` — `SnapshotRuleRecord.message?`; `RuleAddInput.message?`;
  `RuleUpdateInput.message?`.
- `src/index.ts` — `rule.add`/`rule.update` validate and store the message (a
  blank one clears it, an omitted one on update preserves the stored text);
  `validateRuleRef` passes it through; `toSnapshot` and `toRecord` carry it;
  the publish call passes `rules: rulesOf(stored.records)` into `apply`.
- `src/tools.ts` — `create kind:"rule"` and `set` on a perm row accept
  `message`; a message-only `set` derives label and patterns from the rule it
  edits; `instructions_show` on a perm row returns `message`.
- `src/tui/instructions/dialogs.tsx` — the rule dialog prompts "Message shown
  on refusal (optional)" after keywords for both add and edit; edit prefills
  from the stored rule record and sends the (possibly blank) field.
- `src/tui/instructions/detail-pane.tsx` — the perm detail prints
  `message: …` under `provenance`.

Tests:

- `test/tool-permissions.test.ts` — every curated rule ships a non-empty
  one-line message, `curatedRuleMessage` resolves and misses correctly,
  `mergeRules` keeps the curated message, `validateRuleInput` trims/clears.
- `test/apply.test.ts` — the curated deny now carries
  `message: "pushing is not allowed here"` and core `evaluate` returns it; a
  new test drives a user `RuleRecord` message through `apply` into core
  `evaluate`, including a user rule with no message keeping the generic
  refusal.
- `test/rpc.test.ts` — `rule.add`/`rule.update` accept the message field at
  the RPC boundary.
- `test/route.test.tsx` — the add dialog sends the message; the edit dialog
  sends a changed message; the detail pane renders a curated and a user-set
  message; existing rule-dialog prompt queues account for the new prompt and
  a cancel at that prompt writes nothing.
- `test/tools.test.ts` — curated `instructions_show` returns the shipped
  message; `create kind:"rule"` and a message-only `set` are accepted.
- `SPEC.md` / `README.md` — rule `message` in the record, RPC table, tool
  table, dialog flow, and rule-message semantics.

## Checks at this checkpoint

- `rules` (`bun test test/tool-permissions.test.ts test/apply.test.ts
  test/rpc.test.ts test/route.test.tsx`, cwd `packages/plus`): **pass** —
  175 pass, 6 skip, 0 fail.
- `typecheck` (`bun run typecheck`, cwd `packages/plus`): **pass**.

`test/tools.test.ts` is not part of this worker's assigned check set, so the
two assertions added there were not executed in-session; they are verified by
inspection only and must run in the integration check.

## Required files outside `scope.paths` (the end-state item is blocked on these)

The message cannot persist or reach a user rule's deny without three existing
files. Each change is small and named here so the follow-up can apply it
verbatim.

1. `src/instructions/store.ts`
   - `V2Rule`: add `message: Schema.optional(Schema.String)`.
   - `parseV2` rule branch: add
     `...(record.message === undefined ? {} : { message: record.message })`.
   - `stable()` rule branch: add the same spread.
   Without `stable()`, `serialize` strips the message before it reaches disk;
   without the schema and `parseV2`, `load` drops it on read. Either half
   alone leaves a user rule message lost on the next snapshot, so `show`, the
   TUI prefill, and a live refusal cannot see it.
2. `src/instructions/snapshot.ts`
   - `ruleOf`: add `...(record.message === undefined ? {} : { message: record.message })`.
   Without it the internal memo (`memoInputOf`) drops the message for
   `instructions_show view:"record"` and for the TUI record round-trip.
3. `src/tui/instructions/state.ts`
   - `toRpcRecords` rule branch: add the same spread. Without it any TUI
     `instructions.mutate` (toggling any row resubmits the whole record set)
     rewrites rules without their message and clears it.

Optional, not required by the end-state: `src/instructions/teaching.ts`'s
`instructions-tools` skill text documents `create kind:"rule"` and `set` and
should mention `message` for in-product help.

## Deferred until those paths are in scope

- `test/tools.test.ts`: assert a user rule's message round-trips through
  `create`/`show` (today only the curated message is asserted there).
- `test/rpc.test.ts`: assert the stored record keeps `message` across a
  save/load.
- Live lab evidence (the T2 brief's "create a rule with a message in the lab,
  trigger the refusal, paste the model-visible text"): this worker has no
  shell tool, and the user-rule half of that flow cannot work before item 1
  above lands. The curated half is already provable in-session (curated
  message → `apply` → `Permission.evaluate`), which
  `test/apply.test.ts` covers without a lab.

Status: in-scope work complete and checked; the end-state item remains
blocked on the three files named above.