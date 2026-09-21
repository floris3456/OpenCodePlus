# T2 — Rule messages everywhere: evidence and remaining scope

Base: `f0522d90f2537ebcd4a516b50122e951f4503fc6`. Initial T2 checkpoint commit
is `943db15974630eecbdf9fb185aa3714d4ec588d4`.

## Completed changes

### Initial T2 Implementation:
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
- `SPEC.md` / `README.md` — rule `message` in the record, RPC table, tool
  table, dialog flow, and rule-message semantics.

### Follow-up Persistence & Boundary Completion:
- `src/instructions/store.ts`:
  - `V2Rule`: added `message: Schema.optional(Schema.String)`.
  - `parseV2` rule branch: added `...(record.message === undefined ? {} : { message: record.message })`.
  - `stable()` rule branch: added `...(record.message === undefined ? {} : { message: record.message })`.
  Persists optional refusal message to disk JSONL; unchanged saves remain no-ops; changing message triggers revision bump.
- `src/instructions/snapshot.ts`:
  - `ruleOf`: added `...(record.message === undefined ? {} : { message: record.message })` and exported.
  Ensures internal memo (`memoInputOf`), `instructions_show`, and TUI record round-trip preserve rule message.
- `src/tui/instructions/state.ts`:
  - `toRpcRecords`: added `...(record.message === undefined ? {} : { message: record.message })` and exported.
  Ensures TUI `instructions.mutate` preserves rule messages across whole-set resubmissions.
- `src/instructions/teaching.ts`:
  - Updated `instructions-tools` skill text to document `message` in `set` for perm rows, `create kind:"rule"`, and rule fields table.
- `test/rule-message-persistence.test.ts`:
  - Dedicated real-handler test suite (no mocks, using real `test/harness.ts`) verifying:
    1. Store layer: save/load round-trips rule message, `stable()` preservation, JSONL serialization, unchanged no-op and revision bump on edit.
    2. Snapshot & TUI state: `ruleOf`, `memoInputOf`, and `toRpcRecords` preserve message.
    3. RPC handlers: `rule.add` persists to disk, `rule.update` (new message updates, blank clears, omission preserves), `instructions.mutate` cycle preservation.
    4. Tool handlers: `instructions_create kind:"rule"` with message, `instructions_show` (default & record views), `instructions_set` message update, omission preservation, blank clearing, curated override materialization and delete restoration.
    5. Core evaluate integration: `Permission.evaluate` receives custom refusal message.

## Checks at this checkpoint

### 1. `rule-persistence`
Command: `bun test test/rule-message-persistence.test.ts test/store.test.ts test/tools.test.ts` (cwd: `packages/plus`)
Output:
```
bun test v1.4.2 (744846f84)

test/store.test.ts:
(pass) load returns empty when both stores are absent [0.85ms]
(pass) save then load round-trips project and global records [3.58ms]
(pass) records route into project vs global files [0.79ms]
(pass) no-op save keeps the revision and leaves files untouched [0.83ms]
(pass) stale save is rejected without changing stored content [0.69ms]
(pass) split records round-trip [1.07ms]
(pass) v1 migration maps agents, states, and item ids [1.97ms]
(pass) load skips malformed v2 lines [0.76ms]
(pass) project-only save leaves the global revision untouched and vice versa [2.21ms]
(pass) two projects saving global records concurrently keep both records [1.05ms]
(pass) save reports per-store changed flags and a stale save reports none [0.72ms]
(pass) team records round-trip through save then load [0.42ms]
(pass) team records land in the project vs global files [0.30ms]
(pass) team-only save bumps only the store it wrote [0.38ms]
(pass) unchanged save containing teams is a no-op [0.45ms]
(pass) load skips malformed team lines but keeps defaults teams [0.39ms]
(pass) canonical order sorts mixed customization, split, and team records through save and load [0.44ms]
(pass) pin survives a save/load round trip and stable() keys it next to state [5.52ms]
(pass) unchanged save with a pin is a no-op and a changed pin writes [0.66ms]
(pass) model and rule records round-trip through save then load [0.92ms]
(pass) model and rule records land in the project vs global files by level [0.57ms]
(pass) unchanged save containing models and rules is a no-op [1.34ms]
(pass) stable() omits unset model keys and round-trips set ones [0.54ms]
(pass) model and rule records sort canonically and survive a load round-trip in order [0.68ms]
(pass) snapshot record schemas accept model and rule records over the RPC boundary [0.31ms]

test/tools.test.ts:
(pass) toggle through set matches the ops toggle records and status [47.51ms]
(pass) edit text through set matches saveText [18.56ms]
(pass) reset through the tool clears the override like ops reset [32.74ms]
(pass) split and add section match ops and persist boundaries and section records [44.08ms]
(pass) keep/take/edit resolve match ops and persist the resulting records [50.52ms]
(pass) a refused toggle produces the same refusal string the TUI shows [10.43ms]
(pass) create agent/skill/base/instruction/mcp write the same files as the api path [19.79ms]
(pass) delete agent removes a file-backed agent and reports the plan status [18.49ms]
(pass) delete skill removes a project skill and reports the plan status [16.75ms]
(pass) delete base removes a user template and its file is gone [15.04ms]
(skip) delete instruction removes the project file
(pass) delete mcp removes the server from the project config [16.58ms]
(pass) delete team member removes a project team member and reports the plan status [21.52ms]
(pass) delete shipped defaults team member is refused with shipped member wording and writes nothing [14.53ms]
(pass) delete team removes a project team directory and reports the plan status [21.86ms]
(pass) delete overlay defaults team member through instructions_delete unlinks file and updates snapshot [11.21ms]
(pass) team toggle through set matches teamPlan [26.08ms]
(pass) protectedAgents refusal on a write [15.15ms]
(pass) delete without confirm refuses and deletes nothing [6.74ms]
(pass) every tool carries the plugin origin, no pinned, and namespace/codemode/permission set [0.57ms]
(pass) every tool first description line is within 120 characters [0.36ms]
(pass) no instructions tool is registered while disabled, and disabling disposes them [11.06ms]
(pass) a tool write appends a log line with actor tool carrying agent/session/message [12.97ms]
(pass) a tool create appends a log line with actor tool [3.97ms]
(pass) a tool delete appends a log line with actor tool [17.00ms]
(pass) a tool team toggle appends a log line with actor tool [23.85ms]
(pass) instructions_create with kind team creates the directory disabled and logs actor tool [3.83ms]
(pass) the same file and team writes through the RPC handlers still log tui [7.57ms]
(pass) show with each view returns the right shape, diff returns two diffs plus summary [64.23ms]
(pass) registered list and log tools return persisted rows and history [23.38ms]
(pass) protected agent creation refuses before writing a file or log line [2.42ms]
(pass) team set honours explicit state and refuses text and resolve without writing [69.00ms]
(pass) a Code Mode text edit persists and show reports it [31.96ms]
(pass) pin through set matches ops.setPin records and status [30.64ms]
(pass) toggling the execute row through set succeeds and writes the state record [26.53ms]
(pass) a stale bare-id toggle reports the status that actually committed [19.01ms]
(pass) toolHarness exposes agent, skill, and hook state for parity checks [0.27ms]
(pass) create model, activate through set, list with item:model and active, then delete [45.44ms]
(pass) perm rules toggle, show, list by item:perm and tool, create custom, and delete only customs [151.97ms]
(pass) instructions_list returns a team member's policy rows for actions with no tool row [9.82ms]
(pass) deleting a protected agent's custom rule through another agent's row is refused [21.81ms]
(pass) removeRule refuses a protected owner's rule with no write and no log [2.80ms]
(pass) rule.remove RPC from another agent's row refuses with no write and no log (TUI state.ts path) [7.43ms]
(pass) updating a protected agent's custom rule through another agent's row is refused (tools API) [31.45ms]
(pass) rule.update RPC from another agent's row refuses with no write and no log [12.61ms]
(pass) updateRule creates a custom override for a curated row and updates it with a log line [6.78ms]
(pass) updateRule stale retry preserves the edit and the log agrees with what persisted [5.77ms]
(pass) updateRule retry preserves an unrelated concurrent deletion [4.57ms]
(pass) updateRule through a project row keeps a global rule in the global store [4.57ms]
(pass) concurrent updateRule creates for the same target never report false success [2.93ms]
(pass) updateRule preserves a shared agent:null owner instead of retargeting it [4.92ms]
(pass) instructions_set on a team-special row persists team-scoped record [20.02ms]

test/rule-message-persistence.test.ts:
(pass) rule message persistence across boundaries > store.ts persistence, serialization, and stability > rule with message round-trips through save and load [0.80ms]
(pass) rule message persistence across boundaries > store.ts persistence, serialization, and stability > stable() preserves optional message and disk JSON includes message key only when set [0.56ms]
(pass) rule message persistence across boundaries > store.ts persistence, serialization, and stability > unchanged save containing rule message is a no-op; changing message triggers save [0.96ms]
(pass) rule message persistence across boundaries > snapshot.ts ruleOf and state.ts toRpcRecords > ruleOf carries message from SnapshotRuleRecord and omits when absent [0.05ms]
(pass) rule message persistence across boundaries > snapshot.ts ruleOf and state.ts toRpcRecords > memoInputOf preserves rule message in converted records [0.05ms]
(pass) rule message persistence across boundaries > snapshot.ts ruleOf and state.ts toRpcRecords > toRpcRecords carries rule message and preserves undefined [0.07ms]
(pass) rule message persistence across boundaries > RPC handlers: rule.add, rule.update, and instructions.mutate > rule.add saves message to disk and exposes it in instructions.snapshot [3.18ms]
(pass) rule message persistence across boundaries > RPC handlers: rule.add, rule.update, and instructions.mutate > rule.update: new message updates, blank clears, omission preserves [11.56ms]
(pass) rule message persistence across boundaries > RPC handlers: rule.add, rule.update, and instructions.mutate > instructions.mutate preserves rule messages across mutation cycle [2.39ms]
(pass) rule message persistence across boundaries > tool surface: instructions_create, instructions_show, instructions_set > create kind: 'rule' with message, show display, and disk persistence [21.16ms]
(pass) rule message persistence across boundaries > tool surface: instructions_create, instructions_show, instructions_set > set on custom perm row: update message, blank clears, omission preserves [92.32ms]
(pass) rule message persistence across boundaries > tool surface: instructions_create, instructions_show, instructions_set > curated rule: show returns shipped message, set creates custom override, blank restores curated [83.32ms]
(pass) rule message persistence across boundaries > core Permission.evaluate integration > Permission.evaluate receives custom user rule message [71.88ms]

1 tests skipped:
(skip) delete instruction removes the project file

 89 pass
 1 skip
 0 fail
 458 expect() calls
Ran 90 tests across 3 files. [1.60s]
```

### 2. `typecheck`
Command: `bun run typecheck` (cwd: `packages/plus`)
Output:
```
$ tsgo --noEmit -p tsconfig.test.json
```
Exit code: 0

## Scope status

All previously uncompleted serialization and persistence boundaries identified in T2 are now complete, proven with real harness tests, and checked. Live lab verification (running interactive tui-lab) is owned by the orchestrator.