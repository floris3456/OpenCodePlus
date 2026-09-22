# Release Contracts and Verification Policy

This document defines the typed release contracts, hashing rules, and baseline check policy for OpenCode Plus releases.

## Core Types

All wire types are defined with Effect Schema in `@opencode/schema/release` (and re-exported by `@opencode/plus/src/release/identity.ts`).

| Type | Description | Producer | Consumer |
| --- | --- | --- | --- |
| `ReleaseTarget` | Literal union of qualified platforms (`linux-arm64`, `linux-x64`, `darwin-arm64`, `darwin-x64`). | Release configuration | Build runners, package manifests, installers |
| `ReleaseIdentity` | Irreducible provenance tuple (`product`, `channel`, `version`, `sourceSha`, `recipeDigest`, `toolchainDigest`). | Build seat / release coordinator | Promotion gate, updater, runtime server |
| `ArtifactIdentity` | Per-target binary and archive identity (`target`, `archiveName`, `archiveSha256`, `binarySha256`, `bytes`). | Build seat | Release manifest, installer, artifact verifiers |
| `ReleaseManifest` | Published `release.json` manifest (`contractVersion`, `release`, `artifacts`, `unqualifiedTargets`, `installerSha256`, `generatedAt`). | Release publisher | Installers, client updaters, package managers |
| `ReleaseBuildRequest` | Build trigger (`requestID`, `kind: "build"`, `sourceSha`, `version`, `recipeDigest`, `approvalRef`, `requestedAt`). | Team controller / orchestrator | Build runner |
| `ReleasePromotionRequest` | Host promotion trigger (`requestID`, `kind: "promote"`, `release`, `artifact`, `expectedCurrentGeneration`, `approvalRef`, `requestedAt`). | Promotion authority | Release server / host supervisor |
| `ReleaseRequest` | Discriminated union of `ReleaseBuildRequest` and `ReleasePromotionRequest` on `kind`. | Orchestration callers | Dispatcher / request handlers |
| `ReleaseRequestStatus` | Asynchronous status of a release request (`state: "accepted" \| "rejected" \| "running" \| "completed" \| "failed"`, `generation`, `detail`, `observedAt`). | Request handler | Orchestration monitor, CLI status commands |
| `ReleaseHostIdentity` | Active server process identity (`generation`, `releaseVersion`, `executableSha256`, `serverEpoch`, `pid`, `startedAt`). | Running server host | Host supervisor, health checks |
| `ReleaseCheckReceipt` | Execution outcome of an individual gate check (`id`, `argv`, `cwd`, `exitCode`, `head`, `dirty`). | Verification runner | Acceptance aggregator |
| `ReleaseAcceptanceReceipt` | Aggregate gate outcome (`receiptVersion`, `kind`, `sourceSha`, `release`, `artifact`, `policyDigest`, `harnessDigest`, `checks`, `verdict: "pass" \| "fail"`, `producedAt`). | Acceptance harness | Promotion gate, release auditor |

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
