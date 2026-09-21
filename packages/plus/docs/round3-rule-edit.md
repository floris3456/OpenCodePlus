# Round 3 — rule identity survives create and message edits

Scope: `packages/plus`. The narrow fix that keeps a permission rule's
`catalogue` and `team` when it is edited through `rule.update`, the tools, or
the TUI rule dialog, and that lets a newly materialised shared rule land in the
catalogue of the row it was addressed from.

## The bug

A shared Defaults rule written through the Teams catalogue lost its catalogue
the moment its message was edited. Lab reproduction, run through the TUI lab's
`rpc` command:

```
rule.add {"level":"defaults","agent":null,"catalogue":"teams","tool":"shell",
          "id":"round3-team-edit","label":"Round3 team edit",
          "patterns":["printf round3-team-edit"],
          "message":"Round3 team edit refuses."}
```

succeeded, and the next snapshot showed the rule with `catalogue: "teams"`.
Then:

```
rule.update {"level":"defaults","agent":null,"tool":"shell",
             "id":"round3-team-edit","label":"Round3 team edit",
             "patterns":["printf round3-team-edit"],
             "message":"Round3 team edit revised."}
```

succeeded, but the next snapshot's record lost the catalogue:

```
{type:"rule",level:"defaults",agent:null,tool:"shell",id:"round3-team-edit",
 label:"Round3 team edit",patterns:["printf round3-team-edit"],
 keywords:["printf round3-team-edit"],message:"Round3 team edit revised.",
 updated:"..."}
```

`RuleRecord.updated` rebuilds the row from the request's `level`/`agent` only,
so a Teams rule silently became an Agents rule just by editing its message.
`RuleUpdateInput` also had no `catalogue`, so a first write through
`rule.update` (the curated/mined override the tools and the TUI materialise)
could not name the addressed row's catalogue either.

## The fix

- `src/index.ts` `updateRule`: `RuleRecord.updated` keeps the matched record's
  stored `catalogue` and `team`; with no match it materialises at the caller's
  address through `catalogueField({ agent, catalogue })`, which keeps
  agent-qualified rows keyless.
- `src/rpc.ts` `RuleUpdateInput`: optional `catalogue` (`agents | teams`),
  matching `RuleAddInput`. The `rule.update` handler already forwards its input
  unchanged.
- `src/tools.ts` `updateRuleRow` (behind `set` on a perm row): forwards
  `address.catalogue`, so a `set` addressed at a Teams-catalogue row writes a
  Teams override.
- `src/tui/instructions/dialogs.tsx`: `scopeFromToolOrPermRow` and `editRule`
  now carry the row address's catalogue when the row is shared
  (`agent === null`); `addRule` forwards it to `rule.add`, `editRule` to
  `rule.update`. Agent-qualified rows stay keyless.

Unchanged, deliberately: lookup is still globally unique by `tool` + `id`
(`RuleUpdateInput`'s `level`/`agent` do not participate), and T3 protection
still follows the matched record's effective owner.

## Tests

Real handlers, real stores, no mocks:

- `test/rpc.test.ts` — "rule.update keeps a matched Teams rule's catalogue on a
  message edit and materialises the addressed catalogue for a new override":
  the lab shape (Teams rule, message revised, address silent about the
  catalogue) keeps `catalogue: "teams"` and the revised message; a first write
  with `catalogue: "teams"` materialises a Teams override; an Agents-catalogue
  first write stays keyless.
- `test/tools.test.ts` — "a Teams-catalogue rule keeps its catalogue through a
  message set, and a curated Teams row materialises a Teams override": drives
  `instructions_create kind:"rule"` and `instructions_set` (message-only) on
  the returned Teams row id, then a message write from the shared curated
  `item:defaults:/teams:perm:shell:git-push` row, and reads the catalogue and
  message back from the snapshot and the global store.
- `test/route.test.tsx` — two route tests over the real dialog path: `a` on a
  Defaults › Teams tool row sends `catalogue: "teams"` with `rule.add`, and
  `enter` on a Defaults › Teams perm row sends `catalogue: "teams"` with
  `rule.update`.

## Checks

Run from `packages/plus` at this task's HEAD:

```
bun test test/rpc.test.ts test/tools.test.ts test/route.test.tsx \
         test/tui-rule-state.test.ts test/tool-rule-state.test.ts
bun run typecheck
```

Both passed: 180 pass / 5 skip / 0 fail across the five test files, and
`tsgo --noEmit -p tsconfig.test.json` exited 0.

## Live capture

The lab `rule.add` / `rule.update` reproduction above is the reported live
behaviour this fix targets, and the parent run owns the real before/after TUI
dialog capture. No live TUI was driven from this worktree, and this document
claims none.