# Team preset field verification

## Assignment

Use real Instructions tools to create team presets and instantiate global teams,
give those teams bounded tasks through product team tools, verify behavior, and
identify practical improvements and missing capabilities. This is a field test
and assessment, not authority to deploy a new release or alter unrelated teams.

## Guardrails and baseline

- Source baseline: `24c5f2dc66dc65ffbf49bea97b33aa38f43f7aff`, branch `r4-7`.
- Existing untracked `.opencodeplus/instructions` state is not part of the
  source changes and must not be committed, reset, or deleted.
- Use uniquely named User presets/global teams and a disposable, bounded git
  fixture. Independent writers get product-managed separate worktrees.
- Keep the live immutable host unchanged. Do not promote the preceding task's
  candidate, restart the controller, invoke Cairn/Beads, or change workspace
  `agents/*.json` or delegation tooling.
- Stop only test-owned, confirmed-idle runs through their ownership-aware tools.
  Do not exercise destructive cleanup, foreign-run mutation, or busy interrupts.
- Keep credentials and runtime records out of Git. Store sanitized receipts in
  `run/team/team-fieldwork/runs/ses_f227a73ceffe7EvvHwbH6pqkJk/`.
- Initial live capability probe: `instructions.list({where:"item:setting"})`
  rejects the item kind; `instructions.set` lacks `mode`. The running release
  therefore does not yet expose the preceding source task's new agent controls.
  Test the actual available surface; do not claim those features are loaded.

## Execution plan

1. Discover live Instructions and team tool schemas, available presets, runtime
   identity, and the safe public session bootstrap path. Use a read-only general
   sub-agent to review team ownership, role policies, and lifecycle contracts.
2. Create at least two User team presets; configure distinct bounded roles and
   scoped instruction/tool overrides. Instantiate them as global teams. Verify
   save, resolved inheritance, registration, and guard failures independently.
3. Seed a tiny git fixture with a small implementation task and deterministic
   focused checks. Launch a test lead on the existing immutable host through
   its matching public client/SDK surface; do not import candidate executable
   code into that host.
4. Exercise as many of the fourteen product team tools as applicable:
   `get_context`, `set_checks`, `delegate`, `status`, `list`, `wait`, `check`,
   `checkpoint`, `finish`, `diff`, `followup`, `integrate`, `stop`, `supersede`.
   Cover normal work, a read-only review, a correction, and safe idle lifecycle
   transitions. Use invalid-input probes only on test-owned entities.
5. Verify outcomes from saved rows, actual host publication, tool results,
   committed diffs, and executed check receipts—not worker claims alone.
   Separate provider-backed execution from deterministic or source-only proof.
6. Independently review the evidence and document demonstrated defects,
   optimization opportunities, missing features, severity, reproduction, and
   suggested acceptance tests. Do not silently implement speculative features.
7. Leave reusable presets/global teams in a safe documented state, with no
   test workers executing. Preserve useful run evidence and authored commits.
   Commit the sanitized assessment and report exactly what was exercised,
   blocked, retained, or changed.

## Outcome

In progress. Final results will be recorded in a companion assessment.
