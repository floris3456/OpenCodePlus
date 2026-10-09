# Switch source verification

Implementation: b93c710bef, continuing unverified checkpoint 0b2a6db20c.

- Real registered instructions_link/instructions_set schema and execute path, private store reload: either symmetric, oneway directional, bare-id toggle, one-hop/no cascade, off remains off, mixed text/state retains links. Mixed write increments the owning store revision exactly once and preserves rowlink records.
- Operations: section endpoints resolve their own states, already-off section records remain byte-identical, nearest inherited mask overrides an upstream live switch, unrelated owners do not fire, group enabling applies switches, boolean agent controls work.
- Safety control: protected-owner tool write refuses without changing records, durable revision or log presence. Missing synthetic upstream endpoint refuses atomically instead of silently skipping.
- Focused checks: ops.test.ts, tools.test.ts, group-toggle.test.ts, rowlinks.test.ts: 168 pass, 1 existing skipped instruction-delete test, 0 fail. Plus bun typecheck passed. Repository root bun run check: 37 successful typecheck tasks (36 cache hits). Workspace bun run check passed; only establishes workspace structure/pins.
- Receipts in checks/: focused-final.txt, typecheck-final.txt, root-check.txt, workspace-check.txt. Earlier focused/typecheck receipts preserve failures corrected before final verification.

Limits: no provider/live acceptance, release, promotion or push. No Instructions/config/runtime changes. Request-time enforcement was not introduced; switches only affect saved customization state. Model-specific synthetic setter integration is not claimed; missing upstream synthetic endpoints explicitly refuse. Gate assembly, legacy requires and upstream-marker defects remain outside this task.

Evidence remains inside this writable worktree. Parent may copy this directory to run/evidence/plus-1.2.0/switches-sol; the worker did not write shared evidence paths.
