# T2 — tool state mutations preserve rule messages and catalogue identity

Task: close the remaining `packages/plus/src/tools.ts` serialization defect found
after the round-3 T2 landing. Base: `7071d51fbafe998b34f947ca669691ca3972a513`.
Scope: `packages/plus/src/tools.ts` plus this task's test and docs. No TUI
changes, no change to precedence.

## The defect

`toSnapshotRecords` (`src/tools.ts`, was lines 446–508) is the serializer every
tool write uses — `mutateWithRetry` (`src/tools.ts:607`) and
`mutateModelsWithRetry` (`src/tools.ts:648`) both build their `instructions.mutate`
payload with it. A state-only write (`instructions_set` with just `state`)
resubmits the whole record set: the edit's records plus every model and rule
record read from the snapshot.

The old mapping dropped two optional fields the rest of the pipeline carries:

- `message` on rule records, so the next state-only write erased the refusal
  text the model reads and the rule fell back to core's generic refusal.
- `catalogue` on all four record kinds, so a shared (`agent === null`) Defaults
  record written in the Teams catalogue was re-targeted to the Agents
  catalogue — and a Teams-catalogue state record no longer matched its own row.

`message` was already preserved on the round-trip paths that were covered
(`store.ts` `stable`/`parseV2`, `snapshot.ts` `ruleOf`, `tui/instructions/state.ts`
`toRpcRecords`), and `catalogue` was preserved by `toRecord`
(`src/index.ts:2694`) and `snapshot.ts` `recordOf`. Only the tool serializer
omitted them, so `instructions_create` + `instructions_set state:"off"` +
`instructions_show` returned a rule with no message and, for a Teams rule, the
wrong catalogue.

## The fix

`src/tools.ts:453` now spreads both optional fields the way the other
serializers do, absent keys staying absent:

- `...(record.catalogue === undefined ? {} : { catalogue: record.catalogue })`
  on customization (`:466`), split (`:484`), model (`:496`) and rule (`:510`).
- `...(record.message === undefined ? {} : { message: record.message })`
  on rule (`:516`).

Resolution, precedence, and ordering are untouched: only the RPC payload gains
keys the record already had.

## Tests — `test/tool-rule-state.test.ts`

New file, driven by the real tool handlers (`registerInstructionTools` +
`createPlusApi` + `createState` on `test/harness.ts`) and the real host publish
path; no mocks. Both tests create a file-backed project agent through
`api.createAgent({ scope: "project", id: "alpha", … })` and assert the snapshot
reports `scope: "project"` + `fileBacked: true`, so the installed-denial proof
does not depend on the separately corrected built-in scope path.

Test 1 (`:144`) — three rules, then a state-only write on two of them:

- A `perm:shell:no-force` for `alpha` at project level with message
  `force pushes are not allowed here`; `set state:"off"` on
  `item:project:alpha:perm:shell:no-force`.
- B `perm:shell:no-pull`, an unrelated shared Defaults rule in the Agents
  catalogue with message `pulls are not allowed here` (never edited).
- C `perm:shell:no-push`, a shared Defaults rule in the Teams catalogue with
  message `pushing is not allowed in this team`; `set state:"off"` on
  `item:defaults:/teams:perm:shell:no-push`.

Assertions: `instructions_show` returns each message and the right `enabled`
state (`:199`, `:202`, `:209`); `show view:"record"` on C returns
`catalogue: "teams"` and its message (`:215`, `:216`); the snapshot keeps every
rule message, A's owner, C's `catalogue: "teams"`, B's absent catalogue, and the
`catalogue: "teams"` on C's own state record (`:224`–`:240`); `load(project)`
and the raw JSONL lines in `projectRecordsPath` and `globalRecordsPath` carry
the optional keys verbatim (`:245`–`:263`).

Test 2 (`:267`) — the installed host denial: after `set state:"off"`, `api.refresh()`
publishes, and the agent the host actually installed
(`ctx.agent.list()` → `alpha.permissions`) denies
`evaluate("shell", "git push --force origin main", …)` with
`force pushes are not allowed here` (`:291`).

## Check receipts

### 1. `rule-state` — before the fix (exit 1)

`bun test test/tool-rule-state.test.ts test/tools.test.ts` (cwd `packages/plus`),
tree `7420f72272c4c944ba9b0094f9ee267f05549a03`. `tools.test.ts` stayed green
(57 pass); the two new tests failed, verbatim excerpt:

```
test/tool-rule-state.test.ts:
194 |       enabled?: boolean
195 |       message?: string
196 |     }
197 |     expect(shownA.rule).toBe("no-force")
198 |     expect(shownA.enabled).toBe(false)
199 |     expect(shownA.message).toBe("force pushes are not allowed here")
                                 ^
error: expect(received).toBe(expected)

Expected: "force pushes are not allowed here"
Received: undefined

      at <anonymous> (.../test/tool-rule-state.test.ts:199:28)
(fail) tool state mutations preserve rule messages and catalogue identity > set state off rewrites the snapshot without dropping stored rule messages or catalogue [127.80ms]
286 |     const listed = await Effect.runPromise(ctx.agent.list())
287 |     const installed = listed.data.find((entry) => String(entry.id) === "alpha")
288 |     if (installed === undefined) throw new Error("alpha missing from the installed agent list")
289 |     const denial = evaluate("shell", "git push --force origin main", installed.permissions ?? [])
290 |     expect(denial.effect).toBe("deny")
291 |     expect(denial.message).toBe("force pushes are not allowed here")
                                 ^
error: expect(received).toBe(expected)

Expected: "force pushes are not allowed here"
Received: undefined

      at <anonymous> (.../test/tool-rule-state.test.ts:291:28)
(fail) tool state mutations preserve rule messages and catalogue identity > the installed host denial keeps the message for a file-backed project agent [139.55ms]

2 tests failed:
(fail) tool state mutations preserve rule messages and catalogue identity > set state off rewrites the snapshot without dropping stored rule messages or catalogue [127.80ms]
(fail) tool state mutations preserve rule messages and catalogue identity > the installed host denial keeps the message for a file-backed project agent [139.55ms]

 57 pass
 1 skip
 2 fail
 424 expect() calls
Ran 60 tests across 2 files. [2.47s]
```

### 2. `rule-state` — after the fix (exit 0)

Same command after the fix (the at-commit run is recorded in the task Report),
verbatim excerpt:

```
test/tool-rule-state.test.ts:
(pass) tool state mutations preserve rule messages and catalogue identity > set state off rewrites the snapshot without dropping stored rule messages or catalogue [108.98ms]
(pass) tool state mutations preserve rule messages and catalogue identity > the installed host denial keeps the message for a file-backed project agent [95.64ms]

1 tests skipped:
(skip) delete instruction removes the project file

 59 pass
 1 skip
 0 fail
 451 expect() calls
Ran 60 tests across 2 files. [2.24s]
```

### 3. `typecheck` (exit 0)

`bun run typecheck` (cwd `packages/plus`):

```
$ tsgo --noEmit -p tsconfig.test.json
```

## SPEC / README

- `SPEC.md` "Tool permission rules" list: one bullet stating that a state-only
  `set` resubmits the whole record set through `toSnapshotRecords`, which
  carries `message` on every rule and `catalogue` on every shared record,
  exactly like `toRecord` and `toRpcRecords`.
- `README.md` "Permission rules" paragraph: one sentence with the same
  statement.

## Observation outside this task's scope

`tui/instructions/state.ts` `toRpcRecords` (`:101`) still omits `catalogue`
(while carrying `message`), so a TUI-originated whole-set `instructions.mutate`
can still re-target a Teams-catalogue shared record into the Agents catalogue.
That file is outside this task's edit scope (`tools.ts` only); reported to the
parent rather than changed here.

## Deferred

Nothing deferred inside this task's scope. Live lab verification and the
built-in scope path remain the parent's, per the Brief.