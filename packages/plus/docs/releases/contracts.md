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

This section records accepted, evidenced security residuals where host-plane isolation does not close an execution vector in this release. These are classified as accepted residuals per workspace owner decision (dated 2026-09-23), not as deferred mandatory gates or outstanding work.

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

