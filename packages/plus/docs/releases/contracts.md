# Release Contracts and Verification Policy

This document defines the typed release contracts, hashing rules, and baseline check policy for OpenCode Plus releases. For operational procedures, rollback, offline verification, and recovery, see the [Release Operator Guide](operator-guide.md).

## Core Types

All wire types are defined with Effect Schema in `@opencode/schema/release` (and re-exported by `@opencode/plus/src/release/identity.ts`).

| Type | Description | Producer | Consumer |
| --- | --- | --- | --- |
| `ReleaseTarget` | Literal union of qualified platforms (`linux-arm64`, `linux-x64`, `darwin-arm64`, `darwin-x64`). | Release configuration | Build runners, package manifests, installers |
| `ReleaseIdentity` | Irreducible provenance tuple (`product`, `channel`, `version`, `sourceSha`, `recipeDigest`, `toolchainDigest`). | Build seat / release coordinator | Promotion gate, updater, runtime server |
| `ArtifactIdentity` | Per-target binary and archive identity (`target`, `archiveName`, `archiveSha256`, `binarySha256`, `bytes`). | Build seat | Release manifest, installer, artifact verifiers |
| `ReleaseManifest` | Published `release.json` manifest (`contractVersion`, `release`, `artifacts`, `unqualifiedTargets`, `installerSha256`, `generatedAt`). | Release publisher | Installers, client updaters, package managers |
| `ReleaseBuildRequest` | Build trigger (`requestID`, `kind: "build"`, `sourceSha`, `version`, `recipeDigest`, `approvalRef`, `requestedAt`). | Release tool / HTTP request route callers | Durable release store (`submit`); recorded only — nothing here builds it, and `authorize` refuses it as `unsupported_request` |
| `ReleasePromotionRequest` | Host promotion trigger (`requestID`, `kind: "promote"`, `release`, `artifact`, `expectedCurrentGeneration`, `approvalRef`, `requestedAt`). | Release tool / HTTP request route callers | Durable release store (`submit`); a controller permit bound to it closes session admission for the transition it authorizes |
| `ReleaseRequest` | Discriminated union of `ReleaseBuildRequest` and `ReleasePromotionRequest` on `kind`. | Release tool / HTTP `POST /api/release/request` callers | `ReleaseRequestStore.submit`, through the plugin host seam or the HTTP route |
| `ReleaseRequestStatus` | Asynchronous status of a release request (`state: "accepted" \| "rejected" \| "running" \| "completed" \| "failed"`, `generation`, `detail`, `observedAt`). | Durable release store | Release status tool, HTTP status/settle callers, orchestration monitors |
| `ReleaseHostIdentity` | Active server process identity (`generation`, `releaseVersion`, `executableSha256`, `serverEpoch`, `pid`, `startedAt`). | Running server host | Host supervisor, health checks |
| `ReleaseCheckReceipt` | Execution outcome of an individual gate check (`id`, `argv`, `cwd`, `exitCode`, `head`, `dirty`). | Verification runner | Acceptance aggregator |
| `ReleaseAcceptanceReceipt` | Aggregate gate outcome (`receiptVersion`, `kind`, `sourceSha`, `release`, `artifact`, `policyDigest`, `harnessDigest`, `checks`, `verdict: "pass" \| "fail"`, `producedAt`). | Acceptance harness | Promotion gate, release auditor |

## Request State Ownership and Durable Boundary

Release request state does not live in Plus. Core owns the durable `ReleaseRequestStore` (`packages/core/src/release/request.ts`) and exposes it two ways: to plugins as the bounded `Plugin.Context.release` seam (`submit` and `status` only) through the plugin host (`packages/core/src/plugin/host.ts`), and to operators through the HTTP release routes (`packages/server/src/handlers/release.ts`). `authorize` and `settle` stay on the host store and are deliberately absent from the plugin seam. Plus keeps the controller permit helpers (`releaseRequestDigest`, `permitSigningPayload`) and refusal vocabulary in `packages/plus/src/release/request.ts`; the model-facing `release_request` and `release_status` tools in `packages/plus/src/release/tools.ts` hold no request state of their own and submit and read through that seam.

The durable boundary is the host database key-value table, not plugin or process memory: one `release:request:<requestID>` record per request, and an authorized transition commits the request's transition together with its `release:permit:<permitID>` permit record. The controller trust anchor (`release/controller.json` under the host config directory) is operator-owned and read by the store, never taken from a request. A replacement process rebuilds the store from those records and re-engages session admission for a request still running.

## Canonical JSON Rule

Cryptographic digests and manifest serialization require strict determinism:
- Object keys are recursively sorted lexicographically at every level.
- Undefined properties in objects are omitted.
- Undefined elements in arrays are normalized to `null`.
- Output contains no trailing newline.
- Helper implementation: `Release.canonicalJson(value)`.
- SHA-256 digests use `Release.digest(value)` which computes the lowercase 64-character hex hash over `Release.canonicalJson(value)`.

## Honest Provenance Rule

"No invented hashes; unmeasured facts are null with `measuredBy`":
- Never fabricate or guess versions, hashes, upstream beta identifiers, or container digests.
- If an external fact has not been directly measured, it must remain `null`.
- The measurement responsibility is tracked explicitly via a `measuredBy` string attribute (e.g. `"build-seat"`).

## Baseline Source Gate

Release acceptance requires executing the twelve baseline checks specified in `release/checks.json`:
1. `plus-typecheck` (`bun run typecheck` in `packages/plus`)
2. `soak-regressions` (`bun test ...` in `packages/plus`)
3. `release-unit` (`bun test ...` in `packages/plus`)
4. `release-bindings` (`bun test ...` in `packages/plus`)
5. `service-clients` (`bun test ...` in `packages/client`)
6. `cli-release` (`bun test ...` in `packages/cli`)
7. `core-contracts` (`bun run test ...` in `packages/core`)
8. `product-roots` (`bun test ...` in `packages/util`)
9. `release-server` (`bun test test/release.test.ts` in `packages/server`)
10. `affected-typechecks` (`bun run release:typecheck` in `packages/plus`)
11. `generated-client` (`bun run check:generated` in `packages/client`)
12. `tui-regressions` (`bun test test/active-team.test.tsx test/route.test.tsx` in `packages/plus`)

A `ReleaseAcceptanceReceipt` emits `verdict: "pass"` only when all required checks succeed with exit code 0 on a clean git HEAD.

## Known Security Residuals

This section records accepted, evidenced security residuals where host-plane isolation does not close an execution vector in this release. These are classified as accepted residuals per workspace owner decision (dated 2026-09-23), not as deferred mandatory gates or outstanding work. Exactly three vectors are covered by this acceptance: repository-local git filter execution, remote transport program execution, and attribute-selected merge driver execution.

### Repository-Local Git Filter Execution (`filter.<driver>`)

1. **Exact Mechanism**: A repository-local `filter.<driver>.clean` or `filter.<driver>.smudge` configuration, selected by a `.gitattributes` file in the working tree or by `$GIT_DIR/info/attributes` in the Git directory, causes git to execute the named program on the host plane. The vector is triggered by standard git commands: `git add` and `git status` invoke `.clean` filters; `git checkout --` and the checkout step performed by `git worktree add` invoke `.smudge` filters. This execution vector was independently reproduced and verified by the build seat prior to the release decision: a repository-local `filter.evil.clean` / `filter.evil.smudge` executed on `git add` and on `git checkout --`, and passing `-c core.hooksPath=/dev/null` did not block the smudge run.

2. **Hook Neutralization Boundary**: The host-plane git execution boundary defines `NO_REPOSITORY_PROGRAMS` (`packages/plus/src/teams/worktree.ts` and `packages/core/src/git.ts`), which injects `-c core.hooksPath=/dev/null`, `-c core.fsmonitor=false`, and `-c commit.gpgSign=false`. While this neutralization successfully closes git hooks, fsmonitor processes, and commit signing binaries, it does **not** close git filters. Git provides no command-line flag that globally suppresses filter execution:
   - Passing `--attr-source=<empty tree>` does not cover attributes defined in `$GIT_DIR/info/attributes`, and it would drop this repository's own `text eol=lf` handling.
   - An empty per-driver override (e.g. `-c filter.<driver>.smudge=`) requires knowing the specific driver name in advance, which an attacker chooses arbitrarily.

3. **Precondition**: Exploiting this vector requires an already-malicious implementer writing repository-local configuration into the shared `.git`. This is a real precondition and is stated plainly without being dressed up as a mitigation: team worktrees share a single common `.git` repository directory, so an implementer in an assigned worktree can reach and modify that shared repository configuration.

4. **Candidate Fixes and Owner Decision**: Two remediation strategies were evaluated and deliberately deferred by workspace owner decision on 2026-09-23:
   - *Detect-and-refuse*: Before invoking host-plane git operations on an executor-owned repository, verify repository state and refuse execution if any repository-local `filter.*` configuration key or an `$GIT_DIR/info/attributes` file exists. While complete, this approach breaks legitimate repository-local filters, such as `git lfs install --local`.
   - *Host-plane Git Sandboxing*: Enclosing all host-plane git invocations entirely within an isolated sandbox.
   The workspace owner deliberately deferred both candidates, accepting the filter execution vector as a documented residual for this release (decision reference: 2026-09-23).

### Remote Transport Program Execution (`core.sshCommand`, `protocol.ext.allow`)

A related repository-local execution vector exists for remote transport operations. Configuration keys such as `core.sshCommand` and `protocol.ext.allow` with an `ext::` remote URL cause git to invoke external programs when executing remote transport commands (`fetch` and `clone`).

In the standard team workflow, worktrees are created locally using `git worktree add` against local refs rather than cloning or fetching from executor-controlled remote repositories. Real-flow reachability in production is therefore narrower than in synthetic fixtures. However, this narrower reachability does not imply that the vector is closed: if host-plane operations perform a `fetch` or `clone` against a repository containing executor-controlled transport configuration, the named program executes on the host plane. Addressing this vector was likewise deferred under the 2026-09-23 workspace owner decision, and it is recorded here as an accepted security residual.

### Attribute-Selected Merge Driver Execution (`merge.<driver>.driver`)

1. **Exact Mechanism**: An attribute-selected `merge.<driver>.driver`, configured in repository-local git config and selected by a `.gitattributes` merge attribute (or `$GIT_DIR/info/attributes`), causes git to execute the named program on the host plane when a three-way file merge is required.

2. **Reachability**: This vector is reachable on the integrate path's rebase step: specifically, the `gitRaw(tempDir, [...NO_REPOSITORY_PROGRAMS, "rebase", rebaseBase])` invocation at `packages/plus/src/teams/merge.ts:281` inside `process()`. When replaying child commits onto the parent HEAD (`rebaseBase`) in the temporary worktree (`tempDir`), git executes the configured driver command if and only if replay actually needs a three-way merge of the same file. It does not fire on every rebase: if child and parent commits touch disjoint files or replay resolves without requiring a three-way file merge, git never invokes the driver. However, this narrower reachability condition does not imply that the vector is closed.

3. **Neutralization Boundary**: The host-plane git execution boundary defines `NO_REPOSITORY_PROGRAMS` (`packages/plus/src/teams/worktree.ts` and `packages/core/src/git.ts`), which injects `-c core.hooksPath=/dev/null`, `-c core.fsmonitor=false`, and `-c commit.gpgSign=false`. While this neutralization successfully disables git hooks, fsmonitor processes, and commit signing binaries, it does not disable or override a configured merge driver. Git provides no global command-line flag to disable merge driver execution during rebase.

4. **Test Suite Coverage Gap in Canaries**: The integrate canaries in `packages/plus/test/release/canaries.test.ts` (specifically `integrateFixture` and `assertIntegrateNeutralizesHooks`) do not exercise this vector. In `integrateFixture`, the child worktree modifies `child.txt` while the parent worktree advances with changes to `parent.txt`. Because the parent and child modify disjoint files, the rebase never needs a three-way merge and the driver never fires. This is a real coverage gap in our own test suite: passing integrate canaries verify hook neutralization, but a future reader must not mistake the passing integrate canaries for coverage or neutralization of this vector.

5. **Precondition**: Exploiting this vector requires an already-malicious implementer writing repository-local configuration (`merge.<driver>.driver`) into the shared `.git`. Like the filter vector, this is a real precondition and is stated plainly without being dressed up as a mitigation: team worktrees share a single common `.git` repository directory, so an implementer in an assigned worktree can reach and modify that shared repository configuration.

6. **Owner Disposition**: By workspace owner decision dated 2026-09-23, this execution vector is dispositioned and classified as an **accepted residual, not a deferred mandatory gate** or outstanding work for this release.

## Owner-Dispositioned Deferred Findings (Accepted Residuals)

This section records security findings that the workspace owner has explicitly dispositioned as deferred work items by formal decision dated 2026-09-23.

These entries are **accepted residuals, not mandatory deferred items**. Outcome 12 of the round-4 plan requires that the mandatory deferred list remain empty and that no unresolved mandatory gate is concealed as a deferred item. What makes these residuals rather than hidden gates is that the workspace owner has explicitly dispositioned them: their classification as accepted residuals rests on that auditable 2026-09-23 owner decision, allowing any reader to independently verify the claim rather than taking it on assertion.

Crucially, these entries are **not** accepted vectors and are kept strictly distinct from the "Known Security Residuals" above. The three Git vectors were accepted as configuration vectors sharing a common precondition (an attacker or malicious implementer with write access to repository-local configuration in the shared `.git`). In contrast, the three entries below are deferred *work items* with fundamentally different triggers and execution paths. Most notably, **F1 and F3 need no malicious repository configuration at all**: they arise in ordinary, legitimate developer workflows and operations.

### F1 — Host Execution of Team Check Commands

1. **Exact Mechanism**: When running assigned focused checks, `execute()` in `packages/plus/src/teams/checks.ts` (lines 208-233) constructs an environment containing the host `PATH`, host `HOME` (`process.env.HOME`), and `BUN_INSTALL_CACHE_DIR`, and calls `spawnAndWait()`. Inside `spawnAndWait()` (lines 117-137), the check argv is passed directly to `node:child_process.spawn` detached on the host plane under the task worktree directory. `ExecuteOptions` carries no placement capability whatsoever. Furthermore, `packages/plus/src/teams/merge.ts` (around line 300) invokes this exact same `execute()` function to run parent checks in a temporary worktree during landing verification.

2. **Absence of Containment and Trigger**: This execution vector **needs no malicious repository configuration at all**. Unlike the Git vectors that require manipulating `.git/config` or `.gitattributes`, check execution is the normal, expected path for running candidate-authored tests and their imports during team check runs and integrate landing. Any ordinary incorrect or buggy test code, or dependency imported by candidate tests, executes directly on the host plane with host privileges and can read or mutate host state.

3. **Astra Closure**: Route check execution through the owned executor plane and fail closed when required placement is unavailable.

4. **Owner Disposition**: By workspace owner decision dated 2026-09-23, this finding is dispositioned as a deferred work item and classified as an **accepted residual, not a mandatory deferred gate** for this release.

### F3 — Host PTY Allocation

1. **Exact Mechanism**: When creating an interactive terminal session, `Pty.create` in `packages/core/src/pty.ts` (lines 164-182) merges the host environment (`process.env`) with requested environment variables and invokes `spawn()` from the host native PTY binding (`@opencode-ai/pty`) without consulting workspace placement. In `packages/server/src/handlers/pty.ts` (lines 41-55), the authenticated HTTP `pty.create` handler passes ordinary client PTY creation requests directly to this `Pty.create` service.

2. **Absence of Containment and Trigger**: **No malicious repository configuration and no task edits are required** to trigger host execution. An ordinary client opening an interactive terminal session in a placed Location receives a process spawned directly on the host plane with host environment variables.

3. **Test Suite Coverage Gap in Canaries**: The existing canary assertions in `packages/plus/test/release/canaries.test.ts` verify that the workerd PTY binding refuses allocation when no PTY plane exists and that the PTY allocation environment seam carries no host environment. However, these tests do not test the native production binding (`@opencode-ai/pty`), which executes directly on the host plane when invoked.

4. **Astra Closure**: Route placed PTY allocation to the executor plane, or refuse allocation before host spawning when placed PTY capabilities are unavailable.

5. **Owner Disposition**: Formerly tracked as an open security finding barring publication, this finding was dispositioned by workspace owner decision dated 2026-09-23 as a deferred work item and classified as an **accepted residual, not a mandatory deferred gate** for this release.

### F8 — Admission Can Commit After Observed Quiescence

1. **Exact Mechanism**: When a prompt is submitted, `SessionPrompt.prepare` in `packages/core/src/session/prompt.ts` (lines 30-56) calls `SessionAdmission.check` to evaluate the admission fence once before starting asynchronous preparation (plugin hooks and file attachment materialization). Later, `Session.prompt` in `packages/core/src/session/session.ts` (lines 152-164) executes `SessionRevert.commit` and `admission.admit` without holding a counted admission lease or performing a fence-coordinated commit. Meanwhile, `SessionAdmission.status` in `packages/core/src/session/admission.ts` (lines 89-99) determines quiescence (`quiescent: held !== undefined && active.size === 0`) by counting only registered execution keys (`sources`). Consequently, `engage` and `status` can report quiescent while an in-flight prompt preparation is still proceeding and will subsequently write durable message and inbox records.

2. **Honest Scope and Trigger**: The owner explicitly defined the exact operational scope: **publishing an inert archive does not trigger this, no data loss is claimed, and it requires a real generation switch with adverse timing.** The condition is narrow and arises only when an active generation transition is engaged concurrently with an in-flight prompt that passed the initial fence check before preparation completed.

3. **Plan Status and Owner Disposition**: The round-4 plan initially scheduled fence coordination under finish-first T7 wording. By explicit workspace owner decision dated 2026-09-23, this item is formally deferred rather than silently skipped, and is classified as an **accepted residual, not a mandatory deferred gate** for this release.

4. **Astra Closure**: Hold counted admissions through durable commit and coordinate the admission fence with all required in-flight counters before declaring quiescence.

## Open Security Findings (Unaccepted Vectors Barring Publication)

There are currently no open, unaccepted security findings barring release publication.

> **Note (Closed Findings)**: Dynamic host-plane executable plugin loading (formerly tracked as an open finding barring publication) was closed in source by enforcing host-plane provenance on executable plugin configuration and refusing executor-controlled configuration discovered during upward project directory walks. Host PTY allocation is tracked as owner-dispositioned accepted residual [F3](#f3--host-pty-allocation) above.

