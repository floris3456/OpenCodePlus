# Instructions agent controls and compaction

## Goal

Bring Instructions Tool and Instructions TUI agent configuration into parity with
the existing OpenCode V2 agent capabilities, without maintaining a second agent
runtime or weakening permissions. Implement and verify this plan autonomously
with general sub-agents working in separate task worktrees.

## Analysis and decisions

- The current implementation lives primarily in `packages/plus`: Instructions
  discovery, chain resolution, persistent customizations, tool/RPC mutations,
  runtime transforms, and the TUI all share the same tree.
- V2 already supports agent mode (`primary`, `subagent`, `all`), disabled state,
  description, hidden state, color, positive step limits, model and system
  instructions. Instructions exposes models and prompt/tool editing, but not
  all of the ordinary agent settings. Reuse those V2 fields and semantics.
- Add the missing enabled, mode, description, hidden, color, and step-limit
  controls to both Tool and TUI. Do not expose request overlays as functional
  settings while the upstream runner does not send them.
- Only `title`, `compaction`, and `summary` are maintenance/Special agents.
  Other hidden agents are not automatically Special. Keep their origin intact.
- User-visible inherited-origin terminology becomes **OpenCode**, including
  preset pickers, tree labels, provenance, help, and current documentation.
  Preserve stored `native` identifiers and filters for compatibility; actual
  provider-native compaction is a different technical concept.
- Remove the empty OpenCode/Native **team preset** category, not OpenCode agent
  presets or ordinary team creation.
- Every agent, member, Defaults entry, and agent/member preset gets a
  Compaction group. Use the existing scoped resolution chain rather than a
  second persistence store. Reset removes only the current-level override.
- Compaction defaults to the session's active model for that agent; an explicit
  local compaction model and instructions override it. Support automatic,
  local, and remote strategy selection by reusing provider capabilities and
  the existing compaction pipeline. Remote mode must visibly disable local
  customization, retain its stored values for switching back, and report an
  unsupported provider clearly rather than silently pretending it is remote.
- Preserve existing global compaction-agent configuration as the inherited
  instruction fallback. Per-agent overrides take precedence. Keep existing
  recovery, token-budget, and durable-history behavior intact.

## Execution

1. **Plan checkpoint** — commit this plan before implementation. Record the
   starting revision and scoped verification evidence below.
2. **Backend parity (general sub-agent, isolated worktree)** — implement
   validated scoped agent and compaction settings, tool/RPC access, discovery,
   runtime application, reset/inheritance, and focused behavioral tests. Own
   Plus backend files, not the tree renderer or TUI.
3. **Core compaction (general sub-agent, isolated worktree)** — extend the
   canonical agent contract and existing local/remote compaction path only as
   needed. Prove model selection, custom instructions, provider capability
   selection, and preservation of legacy behavior in focused core tests.
4. **Terminology and classification (general sub-agent, isolated worktree)** —
   fix Special classification, inherited-origin terminology and team preset
   categories, with targeted tests. Integrate before UI work.
5. **TUI parity (general sub-agent, isolated worktree after contracts settle)**
   — render settings and Compaction categories using shared backend values;
   Enter cycles Primary → Subagent → All; agent toggles work on agent rows;
   provide edit/reset controls, inherited provenance, and semantic disabled
   styling for remote-only fields. Cover actual production tree/state behavior.
6. **Integration and review** — integrate local commits, regenerate the public
   client if the reachable API contract changes, run package-local typechecks
   and focused tests, and use an independent general sub-agent for review.
   Address material findings and repeat the affected checks.
7. **Evidence and final checkpoint** — update this plan with decisions,
   implemented behavior, commands/results and remaining limitations; commit
   material changes. Do not push, promote, restart the controller, mutate live
   Instructions settings, or change workspace team/agent definitions.

## Verification matrix

- On/off: ordinary and built-in agents; disabled agents stay editable and can
  be re-enabled; disabled agents disappear from host selection catalogues and
  cannot execute or launch as subagents. Preserve the existing low-level API's
  ability to store an explicit agent ID; reject missing agents at execution.
- Scope: project over global, linked presets and Defaults entries; shared
  Defaults; reset; standalone and team-member catalogues remain isolated.
- Parity: all three modes, hidden vs disabled, description, color, steps,
  boundary validation, protected-agent refusal and existing write guards.
- Tree: Special has exactly the three maintenance agents; no team preset
  OpenCode category; inherited-origin text says OpenCode; stable old row IDs.
- Compaction: inherited active model, explicit local model, custom prompt,
  automatic/local/remote selection, unsupported remote provider behavior,
  remote-disabled fields, switching back retains local settings.
- Focused Plus tree/tool/store/apply/TUI tests and core agent/compaction tests;
  package-local `bun typecheck`; generated-client reproducibility if changed.
- Required workspace structure/index smoke checks, without releasing code.

## Evidence and outcome

- Starting worktree: `worktrees/r4-7/opencode`, branch `r4-7`.
- Starting revision: `59069f781` (`feat(plus): add agent presets and tool permissions`).
- Initial working tree: clean (`git status --short`).
- Read workspace and repository operating instructions and V2 agent guide.
- Plan checkpoint: `77f1cbb1b`.
- Delegated implementation to general sub-agents on isolated `agent-settings`,
  `agent-compaction`, `opencode-origins`, and `instructions-controls` branches.
  UI work started against explicit agreed item IDs in parallel; integration
  will reconcile its contracts before verification.
- Baseline `bun typecheck` in `packages/plus`: passed.
- Baseline `bun run release:typecheck` in `packages/plus`: all ten package
  checks passed (cli/client/core/util/tui/plus/plugin/server/protocol/schema).
- Baseline TUI gate `bun test test/active-team.test.tsx test/route.test.tsx`:
  88 passed, one existing skip, zero failed.
- Workspace `./bin/bun run check`: structure and manifest valid (not a runtime
  readiness check). `./bin/team list`: index answered with 733 entries.
- Evidence directory:
  `run/team/instructions-controls/runs/ses_f227a73ceffe7EvvHwbH6pqkJk/checks/`
  in the workspace repository, outside source control.
- Implementation and final verification results will be appended as work completes.

### Core integration

- Integrated the compaction sub-agent's commit as `844323086`.
- Canonical contract: `Agent.Compaction` with optional `strategy` (`auto`,
  `local`, `remote`), `model` (`Model.Ref`), and `system` (`string`).
- Explicit local fields override the maintenance compaction agent; absent
  model values ultimately use the active session model, not a saved snapshot.
- Remote mode uses actual provider endpoint/trigger capability. Unsupported
  remote requests fail explicitly and cannot fall back to local compaction.
- Parent reruns: four core config/compaction/schema-identity test files,
  **62 passed**; eight new actual-runner scenarios, **8 passed**; three focused
  Schema files, **13 passed**; generated client byte-for-byte check, **passed**;
  ten-package affected typechecks, **passed**.
- Wider runner selection (`compaction|overflow`): **59 passed, 3 failed**. The
  three exact system-part assertions omit the existing empty Code Mode notice:
  `moves the epoch at compaction and narrates later changes`, `refreshes
  preparation after overflow compaction without promoting new input`, and
  `uses epoch values after compaction while a source is unavailable`. The core
  sub-agent reproduced these using baseline runner/compaction sources. They
  are recorded as pre-existing failures, not hidden by narrowing assertions.
- A separate general sub-agent is adding real embedded SDK/host verification
  because the Plus recording harness alone does not prove publication into
  the production agent registry or rejection by the actual subagent tool.
