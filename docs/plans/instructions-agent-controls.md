# Instructions agent controls and compaction

**Status: completed and verified in the task worktree; not deployed.**

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
  reconciled its contracts before verification.
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
- Implementation, review fixes, and final verification are recorded below.

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
- A separate general sub-agent added real embedded SDK/host verification
  because the Plus recording harness alone does not prove publication into
  the production agent registry or rejection by the actual subagent tool.

### Backend and origin integration

- Integrated backend settings as `0b1897df3` and OpenCode/Special presentation
  as `cc027ad5e`; replaced the temporary backend compaction type with the
  canonical `Agent.Compaction` in `30ec773e2`.
- Settings persist as existing whole-item customization records:
  `setting:enabled`, `mode`, `description`, `hidden`, `color`, `steps`, and
  `compaction:strategy`, `model`, `instructions`. Boolean fields use state;
  scalar fields use text. Model syntax is `provider/model#variant`.
- Empty compaction instructions are an explicit empty prompt; Reset restores
  inheritance. An agent-row Reset clears only its nine agent/compaction
  controls, not its other Instructions customizations.
- Plus-disabled agents retain an upstream inventory entry for re-enabling.
  Authoritatively config-disabled agents are not recreated by retained Plus
  settings. Final control transforms run after team-agent upserts.
- Parent backend regression check: **176 passed, 6 existing skips** across
  controls/apply/Tool/RPC. Canonical-type follow-up: Plus typecheck and **9
  controls tests passed**. Agent/subagent catalogue checks: **20 passed**.
- Independent core review found mixed legacy Markdown frontmatter was treating
  the new compaction object as provider options. Fixed in `28991e0a1` using the
  canonical schema in compatibility decoding and migration. Parent config
  regressions: **69 passed**; independent reviewer confirmed the finding
  closed, including malformed-input rejection and no provider-body leakage.
- Additional compaction admission/transport checks: **6 passed**.
- Desktop screenshot attempt was unavailable: this API session has no desktop
  browser connection and `termctrl` is not installed. Do not claim interactive
  screenshots; use production OpenTUI renderer tests for layout verification.
- Merged backend/origin checks: **214 passed, 2 existing skips** across the
  discovery/tree/presets/query/ops/teaching/chain files; rendered route/escape/
  panes regression selection: **97 passed, 1 existing skip**.

### Real embedded host verification

- Integrated `f29d599cb`: `packages/sdk/test/instructions-agent-controls.test.ts`.
- Parent rerun: **3 passed, 103 assertions**. Uses the production embedded SDK,
  Instructions tools through Code Mode, isolated HOME/config/data, memory DB,
  TestLLM provider boundary, and rejects external HTTP requests.
- Verified disable/re-enable changes the real host list/get results and
  execution/subagent admission; disabled agents remain editable; all three
  modes reach the host and primary-only mode rejects subagent launch.
- Verified compaction settings pass through public SDK metadata into the local
  summary request, and Reset restores inherited model behavior. This proves
  host publication and request assembly in the fixture, not provider receipt
  or deployment into the user's running release.

### Independent review and follow-up

- Independent backend review found three concrete issues before final
  acceptance: an agent-wide Reset bypassed the compaction-model target
  permission; an explicit hidden-off value could be suppressed against a
  synthetic team baseline; member-preset entity aliases incorrectly depended
  on row depth. The backend sub-agent implemented focused regression fixes;
  independent re-review closed all three, as recorded below.
- Documentation validation additionally exposed that the query parser still
  rejected `item:setting` and `item:compaction`. Added those canonical kinds,
  documented settings in the shipped teaching skill and the new
  `packages/plus/docs/agent-controls.md`, and kept the seed instruction within
  its existing 600-character budget. Teaching/query checks: **65 passed**.

### Integrated TUI and final checks

- Integrated `655378592`: Settings and Compaction for all owner kinds; Enter
  cycles Mode/Strategy; Space toggles Enabled and Ctrl+Space selects; remote
  local fields use disabled form-field tokens and reject stale edit/review
  actions without dropping saved values. Tests render the production route at
  80 and 120 columns.
- Backend review fixes landed in `28f7afa0e`; the independent reviewer closed
  all three findings after retesting inherited permissions, atomic mixed
  aliases, team hidden reset, and live member-preset aliases.
- Updated the team-role test to identify actual system-writing callbacks,
  rather than assume the first registered transform is a writer. It retains
  the exact per-pass identity and text assertions. This was a fixture assumption
  exposed by this task's new read-only upstream observer, not a baseline product
  failure. Backend/permissions/team regression selection: **172 passed,
  1 existing skip**.
- Combined tree/TUI/query/presets/teaching selection before the last UI fix:
  **256 passed, 1 existing skip** across 12 files. Real SDK tests now include live
  Defaults/preset/project precedence: **4 passed, 138 assertions**.
- Final core agent/config/compaction/transport selection: **120 passed** across
  nine files. The eight new runner scenarios and schema checks also passed as
  recorded above. The three unrelated baseline runner assertions remain a
  separately recorded limitation.
- Ten-package affected typechecks, SDK typecheck, Plus build, and generated
  client byte-for-byte verification passed on the integrated source.
- Independent UI review found a selector issue: Ctrl+Space used
  the edited Global/Defaults tier instead of current-location availability.
  Fixed in `ebec7d9e8` by reading the same reactive effective host catalogue as
  the core picker. Tier-specific editing and badges remain intact. Twelve
  override-direction scenarios failed before the repair and passed afterward.
- Removed the stale member-preset entity Reset restriction now that the backend
  resolves that owner correctly. Its production-route regression removes all
  nine scoped controls while preserving unrelated preset records.
- Independent UI re-review closed the finding: **24 focused route tests passed**,
  including effective host updates, stale commands, entity exclusions, both
  override directions, and member-preset Reset.
- Final parent rerun after the last UI fix: **279 passed, 1 existing skip,
  0 failed** across the same 12 tree/TUI/query/presets/teaching files, with
  **15,458 assertions**. Plus package-local typecheck and build passed again.
- Final real SDK rerun: **4 passed, 138 assertions**. Workspace structure and
  manifest checks passed; the team index answered with **733 entries**. These
  workspace checks do not establish runtime readiness or deployment.

### Completion and verification receipts

All seven execution steps are complete. General sub-agents implemented the
backend, core, origins, UI, and embedded-host tests in isolated worktrees;
separate general reviewers checked core, backend, UI, and documentation.

The final focused receipts in the evidence directory are:

| Area | Receipt | Result |
| --- | --- | --- |
| TUI/tree/query/presets/teaching | `post-review-tui.txt` | 279 pass, 1 existing skip |
| Backend/permissions/teams | `plus-review-fixes.txt` | 172 pass, 1 existing skip |
| Embedded SDK host | `post-review-sdk.txt` | 4 pass, 138 assertions |
| Core agent/config/compaction/transport | `final-core-controls.txt` | 120 pass |
| New runner scenarios | `core-agent-runner.txt` | 8 pass |
| Schema | `schema-agent.txt` | 13 pass |
| Ten affected package typechecks and Plus build | `final-typechecks-build.txt` | passed |
| SDK typecheck | `final-sdk-typecheck.txt` | passed |
| Final Plus typecheck/build after UI fix | `post-review-plus-build.txt` | passed |
| Generated client reproducibility | `final-generated-client.txt` | byte-for-byte match |
| Workspace/index smoke | `final-workspace-smoke.txt` | structure valid, index answered |

Known limitations remain explicit: the wider runner selection has the three
baseline Code Mode system-part assertion failures listed above; no assertion or
safety gate was weakened. No desktop connection or `termctrl` was available, so
layout evidence is from the production OpenTUI renderer, not interactive
screenshots. TestLLM proves host behavior and request assembly, not receipt by
a real provider. Low-level V2 agent-ID admission remains upstream behavior, as
documented in `packages/plus/docs/agent-controls.md`.

Changes are locally committed on `r4-7`. No remote push, release promotion,
controller restart, workspace team-code/agent-definition edit, or live
Instructions mutation was performed. The user guide is
`packages/plus/docs/agent-controls.md`.
