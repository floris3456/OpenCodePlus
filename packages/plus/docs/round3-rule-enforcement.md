# T2 — a permission row turned off for a built-in agent installs a real host deny

Task: correct the permission-row resolution scope in
`packages/plus/src/instructions/apply.ts` so a rule a user turns off for a host
built-in agent reaches core as an actual deny carrying its refusal message.
Base: `f1b7cf67fee57a15ed979a1e5bb265235f70f30c`. Scope: `apply.ts` plus this
task's two test files and docs. No change to precedence for any other row kind,
no change to team-scoped resolution, no TUI change.

## The defect

Three facts already true on the branch combine into a silent no-op.

1. A host built-in agent has Defaults scope. `sourceFor`
   (`src/instructions/discover.ts:435`) returns `{scope: "defaults"}` for any id
   with no project or global agent file, which is every entry of
   `builtinAgentIds` (`discover.ts:403`: `build`, `general`, `explore`,
   `compaction`, `title`, `summary`, `plan`).
2. The tree shows that agent at *every* level. `nativeAgentsForLevel`
   (`src/instructions/tree.ts:606`) and `specialAgentsForLevel` (`:628`) append
   the Defaults-scope agents to the Project and Global agent groups, so `build`
   owns the rows `item:project:build:perm:shell:git-push`,
   `item:global:build:perm:shell:git-push` and
   `item:defaults:build:perm:shell:git-push`.
3. A write lands at the address of the row the user pressed. `toggle`
   (`src/instructions/ops.ts:392`) and `setEnabled` (`:410`) call
   `merge(..., chain.address, ...)`, so turning the rule off from the Project
   view saves `{level: "project", agent: "build", item:
   "perm:shell:git-push", state: "off"}`.

`apply` then resolved that agent's rows at its *discovered* scope:
`resolvedFor` (`apply.ts`) addressed `{level: "defaults", agent: "build"}`, for
which `resolutionChain` (`src/instructions/model.ts:1071`) builds only
`defaults/build → shared`. The project-level record — the record the user
actually saved — was never on the chain, so `permDenials` saw the row resolve
`enabled`, installed no `Permission.Rule` and no `message`, and
`scrubKeywordsByAgent` scrubbed nothing. The rule looked off in the TUI and was
fully on in the model's world. A record saved from the Global view was dropped
the same way.

This only ever bit Defaults-scope agents. A project-scope or global-scope agent
appears in the tree at its own level only, so its records were already on its
chain.

## The fix

`resolvedFor` (`src/instructions/apply.ts:179`) resolves a `perm` item for a
non-team Defaults-scope agent from the Project level, with that agent id present
in both higher scope sets, which is exactly the chain `resolutionChain` then
builds — `project → global → defaults → shared`:

```ts
const fromProject = item.kind === "perm" && agent.team === undefined && agent.level === "defaults"
```

```ts
scopes: fromProject
  ? { global: new Set(args.scopes.global).add(agent.id), defaults: new Set(args.scopes.defaults).add(agent.id) }
  : args.scopes,
address: {
  level: fromProject ? "project" : agent.level,
  ...
}
```

Boundaries the correction does not cross:

- **Other item kinds keep the discovered scope.** `item.kind === "perm"` gates
  the whole thing, so tool, base, skill, system, mcp and model rows resolve
  exactly as before.
- **Every team-scoped agent keeps its established chain and the Teams
  catalogue.** `agent.team === undefined` gates it, so a member's address keeps
  its `team` key, `catalogueForAddress` (`model.ts:36`) still answers `"teams"`,
  and the chain still ends in the Teams shared inventory rather than the Agents
  one.
- **Precedence is unchanged.** The widened chain is `resolutionChain`'s own
  ordering; most specific still wins, so a Project ON over a Defaults OFF leaves
  the tool alone.
- Because only the resolution input changes, `permDenials`, `policyRules`,
  `pushRule` and the scrub path are untouched: the message a deny carries still
  comes from `ruleDenialMessage` (user record for a `custom` row, else
  `curatedRuleMessage`).

## Tests

### `test/apply.test.ts` — four unit regressions

- `a Defaults-scope agent's perm row saved off at project level installs the
  core deny` — `build` and `plan` at `level: "defaults"`, one project-level OFF
  record for `build`; asserts the installed rule is
  `{action: "shell", resource: "git push *", effect: "deny", message: "pushing
  is not allowed here"}`, that core's own `evaluate` (imported from
  `../../core/src/permission.js`, not a local matcher) denies `git push origin`
  with that message, and that `plan` keeps the tool.
- `a Defaults-scope agent resolves perm rows project -> global -> defaults ->
  shared` — one record per chain step, each applied on its own harness: project,
  global, defaults and the Agents shared inventory all deny; a
  `catalogue: "teams"` shared record does not. Then a Defaults OFF plus a
  Project ON leaves the tool alone, proving precedence survives.
- `only perm rows widen: a Defaults-scope agent's tool row keeps the discovered
  scope` — a project-level OFF for `tool:coder` on a Defaults-scope agent still
  installs nothing (`registrations` is `[]`).
- `a team-scoped agent keeps its established chain and the Teams catalogue` — a
  member at `level: "defaults"` with `team: {level: "defaults", team:
  "alphateam"}`: the team record, the member record and the Teams shared record
  deny; a project-level record and an Agents shared record do not.

### `test/rule-message-persistence.test.ts`

- New real-handler publish test (`core Permission.evaluate integration` → `a
  built-in agent's project-level row off installs the host deny through the real
  publish path`). No mocks: `fullContext` + `createPlusApi` + `createState` +
  `registerInstructionTools` from `test/harness.ts`, a real project enabled by
  `enable()`. It asserts the snapshot reports `build` with `scope: "defaults"`,
  finds the real `item:project:build:perm:shell:git-push` row in
  `expandedTree`, drives `instructions_set {state: "off"}` through the real
  tool, re-reads the store to confirm the record persisted is
  `{level: "project", agent: "build", state: "off"}`, calls `api.refresh()` to
  publish, and then reads the agent the host actually installed through
  `ctx.agent.list()` and evaluates it with core's `evaluate`: `git push origin
  main` denies with `pushing is not allowed here`, `git status` does not.
- Stale D1 assertion corrected. `create kind:"rule"` returns the row id the tree
  shows for what it wrote (decision D1), so
  `expect(created).toMatchObject({tool: "shell", id: "no-force-push"})` was
  asserting a value the tool has not returned since D1 landed. It now expects
  the canonical visible row id — for an `agent: null` rule the one visible row
  is the Defaults Agents-catalogue inventory row,
  `item:defaults::perm:shell:no-force-push` — plus `item:
  "perm:shell:no-force-push"`, and asserts that row id actually exists in
  `expandedTree`. Every other assertion in that test is kept, and no other test
  assertion anywhere was weakened or removed.

## Check receipts

### 1. `rules` — before the fix (exit 1)

`bun test test/apply.test.ts test/rule-message-persistence.test.ts test/rpc.test.ts`
(cwd `packages/plus`), tree `a52626e063c57f4a529ceaef235d74827bd077c8`, produced
by neutralising the one predicate in `resolvedFor` (`const fromProject = false`)
with the tests already in place. The three new regressions fail; the team-scoped
regression and the other-kinds guard pass on both sides, so they are guards and
not tautologies. Verbatim excerpts:

```
1427 |       records,
1428 |       agents: [{ id: "build", level: "defaults" }, { id: "plan", level: "defaults" }],
1429 |       scopes: { global: new Set<string>(), defaults: new Set(["build", "plan"]) },
1430 |     }),
1431 |   )
1432 |   expect(applied.registrations.length).toBeGreaterThan(0)
                                             ^
error: expect(received).toBeGreaterThan(expected)

Expected: > 0
Received: 0

      at <anonymous> (.../test/apply.test.ts:1432:40)
(fail) a Defaults-scope agent's perm row saved off at project level installs the core deny [1.87ms]
1467 |     const installed = agents.state.get("build")?.permissions ?? []
1468 |     expect([entry.label, installed.some((rule) => rule.action === "shell" && rule.effect === "deny")]).toEqual([entry.label, entry.denies])
                                                                                                             ^
error: expect(received).toEqual(expected)

  [
    "project",
-   true,
+   false,
  ]

- Expected  - 1
+ Received  + 1

      at <anonymous> (.../test/apply.test.ts:1468:104)
(fail) a Defaults-scope agent resolves perm rows project -> global -> defaults -> shared [0.93ms]
```

```
766 |       const listed = await Effect.runPromise(ctx.agent.list())
767 |       const installed = listed.data.find((entry) => String(entry.id) === "build")
768 |       if (installed === undefined) throw new Error("build missing from the installed agent list")
769 |       const permissions = installed.permissions ?? []
770 |       const denial = evaluate("shell", "git push origin main", permissions)
771 |       expect(denial.effect).toBe("deny")
                                 ^
error: expect(received).toBe(expected)

Expected: "deny"
Received: "allow"

      at <anonymous> (.../test/rule-message-persistence.test.ts:771:29)
(fail) rule message persistence across boundaries > core Permission.evaluate integration > a built-in agent's project-level row off installs the host deny through the real publish path [27.54ms]

3 tests failed:
(fail) a Defaults-scope agent's perm row saved off at project level installs the core deny [1.87ms]
(fail) a Defaults-scope agent resolves perm rows project -> global -> defaults -> shared [0.93ms]
(fail) rule message persistence across boundaries > core Permission.evaluate integration > a built-in agent's project-level row off installs the host deny through the real publish path [27.54ms]

 106 pass
 5 skip
 3 fail
 775 expect() calls
Ran 114 tests across 3 files. [868.00ms]
```

`Received: "allow"` on the real publish path is the user-visible defect stated
exactly: the row reads off in the TUI, the record is on disk, and core lets the
command through.

### 2. `rules` — after the fix (exit 0)

Same command, tree `2723640dfed3c02157f0a0df6efebd3e7b014aef` (the at-commit run
is recorded in the task Report). Verbatim excerpts:

```
test/apply.test.ts:
(pass) a perm rule off installs a core deny proved by Permission.evaluate (not a local matcher) [82.26ms]
(pass) a user rule's own message reaches Permission.evaluate through apply [0.74ms]
(pass) a Defaults-scope agent's perm row saved off at project level installs the core deny [0.36ms]
(pass) a Defaults-scope agent resolves perm rows project -> global -> defaults -> shared [1.01ms]
(pass) only perm rows widen: a Defaults-scope agent's tool row keeps the discovered scope [3.03ms]
(pass) a team-scoped agent keeps its established chain and the Teams catalogue [1.25ms]

test/rule-message-persistence.test.ts:
(pass) rule message persistence across boundaries > tool surface: instructions_create, instructions_show, instructions_set > create kind: 'rule' with message, show display, and disk persistence [42.80ms]
(pass) rule message persistence across boundaries > core Permission.evaluate integration > Permission.evaluate receives custom user rule message [0.69ms]
(pass) rule message persistence across boundaries > core Permission.evaluate integration > a built-in agent's project-level row off installs the host deny through the real publish path [26.46ms]

 109 pass
 5 skip
 0 fail
 786 expect() calls
Ran 114 tests across 3 files. [931.00ms]
```

### 3. `typecheck` (exit 0)

`bun run typecheck` (cwd `packages/plus`):

```
$ tsgo --noEmit -p tsconfig.test.json
```

## SPEC / README

- `SPEC.md` "Permission rules" list: one bullet, first in the list, stating the
  resolution scope — perm rows resolve `project/A → global/A → defaults/A →
  shared` for a non-team Defaults-scope agent, why (rows visible at every level,
  writes landing at the row's own address), and the two boundaries (other item
  kinds keep the discovered scope; a team-scoped agent keeps its chain and the
  Teams catalogue).
- `README.md` "Permission rules": one paragraph with the same statement in
  product terms. The existing paragraph is untouched, so its tool-serializer
  guarantee — a state-only `set` resubmits the whole record set through the tool
  serializer, which preserves every rule's `message` — still reads exactly as it
  did.

## Related, already integrated

The tool serializer defect that dropped `message` and `catalogue` from a
state-only write is fixed and documented separately in
[`round3-tool-rule-state.md`](round3-tool-rule-state.md); nothing about
`src/tools.ts` is open for this task. That document's own note about
`tui/instructions/state.ts` `toRpcRecords` omitting `catalogue` is the parent's
to route — it is outside both tasks' edit scope.

## Deferred

Nothing deferred inside this task's scope. Live lab verification (creating the
rule in a lab TUI, triggering the refusal and pasting the model-visible text)
remains the parent's, per the Brief.
