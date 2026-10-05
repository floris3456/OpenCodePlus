# A6 — the two stale mainline tests of the Instructions area

Decision evidence for `plus-1.1.15-overnight.md` A6. Both failures are stale
tests; the implementation matches the contract, so the tests were corrected and
no source was changed.

## `descriptions.test.ts` — shell `Commands` summary

**Seen:** `detail("group:project:alice:tool:shell:permissions:commands")`
expected `"Command families. … wildcard patterns over it."` but the catalog
returns the same sentence plus `"With Every other command off, only the allowed
rows run, each command of a pipeline or list checked on its own."`

**Cause:** commit `d29111888a` ("a shell allow-list for driving terminals with
pilotty") extended the `shell.commands` summary in
`src/instructions/permission-catalog.ts:505` to describe the allow-list, and did
not update this test (nor the walkthrough quote). The added sentence is the
contract: while `Every other command` is off, only allow rows run and core
checks each part of a pipeline/list separately — the behaviour `apply.ts`
(`shellAllowList`, lines 565–585) and `permission-enforce.ts` implement.

**Decision:** test is stale → updated to the production text. The
`docs/tui-walkthrough.md` quote of the same summary was updated to match.

## `team-query-off.test.ts` — 2 vs 3 registrations

**Seen:** "off on team.diff for a defaults-level team agent …" expected
`applied.registrations` length 2, got 3.

**Cause:** commit `eba7b41c67` ("repair run admission scope and usage
reporting") added `if (table.teamMembers.size > 0) return true` to
`tableActive` (`src/instructions/permission-enforce.ts:974`). A publish that
holds enabled team members therefore always installs the enforcement
registrations; `apply` (`src/instructions/apply.ts:109`) pushes them. The test
passes `teamAgents: ["muse-implementer"]`, so three registrations land: the
Code Mode denial, the `team.diff` core refusal, and the enforcement hook
(instrumentation: only the `listen` replies registration installs in this
harness; the four seam hooks fail to install with "plus permission hook not
installed", which is the documented no-seam path).

**Decision:** test is stale → expected count corrected to 3, comment names the
enforcement registration. The two permission assertions
(`team_diff` deny, `team.diff` deny) are unchanged, and the catalog assertions
(`team.status` present, `team.diff` absent) are unchanged: no permission or
catalog assertion was weakened.

## Checks (from `packages/plus`)

- `bun test test/descriptions.test.ts` — 9 pass, 0 fail
- `bun test test/team-query-off.test.ts` — 3 pass, 0 fail
- `bun run typecheck` — exit 0

No live test was required: both repairs are expectation-only and the two
boundaries (catalog summary text, applied registrations) are exercised directly
by the tests. No runtime change needs a fresh live run.
