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

## Rebuild Equivalence Contract (D3-B Standard)

This section documents the reproducibility contract for OpenCode Plus compiled binary artifacts, its structural canonicalizer, empirical verification evidence, and known operational limits.

### Standard Definition and Honest Weakening

OpenCode Plus release packages achieve raw byte equality for release archives: two independent packaging runs over identical inputs yield byte-identical archives (`packages/plus/test/release/reproducibility.test.ts:20`). However, standalone executables compiled via `bun build --compile` (using ESM, bytecode compilation, and code splitting) are measurably **not raw-byte reproducible**. The Bun bundler generates a random 64-bit unsigned integer per build and embeds it across compiled chunk tokens.

To verify binary reproducibility without making false assertions of raw byte identity, the release pipeline adopts the **D3-B rebuild equivalence** standard:
1. **Deliberately Weaker than Raw Byte Equality**: Two independent rebuilds of the exact same source tree are compared only after normalizing a strictly bounded, structurally identified class of bytes. Equivalence under this standard is strictly weaker than raw binary reproducibility.
2. **Explicit Declaration in Verification Reports**: The verification report (`RebuildEquivalenceReport` in `packages/plus/script/release/verify.ts:41-58`) explicitly sets `weakerThanRawReproducibility: true`. It records both raw SHA-256 digests (`leftRawSha256` and `rightRawSha256`), reports `rawIdentical: false` whenever raw bytes differ, and provides the derived `canonicalSha256` digest solely as an internal equivalence receipt.
3. **Manifest Boundary Invariant**: The canonical digest **never** enters the release manifest (`ReleaseManifest`) or artifact identity (`ArtifactIdentity.binarySha256`). Publication, distribution, installer verification (`verifyReleaseDirectory` in `packages/plus/script/release/verify.ts:120`), and client update checks verify exact raw byte equality against recorded artifacts. This invariant is directly enforced by unit tests in `packages/plus/test/release/reproducibility.test.ts:278` (`"the canonical digest never replaces the raw binary identity in the manifest"`).

### Normalized Bytes and Structural Anchoring

Canonicalization (`canonicalizeBuildOutput` in `packages/plus/script/release/canonicalize.ts:306-378`) normalizes **only** the per-build bundler unique key and its derived hash word inside chunk-token records within JavaScriptCore's shared bytecode string table:

1. **Token Layout**: A chunk token is a 25-byte ASCII string matching `^[0-9a-f]{16}[ACSH][0-9]{8}$`. The first 16 characters are the hexadecimal bundler unique key. The token is preceded by an 8-byte header:
   - `[u32 LE: length word]`: Bit 31 is JavaScriptCore's `is8Bit` flag (`0x80000000`); bits 0..30 encode the length.
   - `[u32 LE: hash word]`: Low 24 bits store `rapidhash(token) & 0xffffff`; top 8 bits are reserved and must be `0x00`.
   - `[25 bytes]`: Chunk token character data.
   - `[3 bytes]`: Zero padding to align the record to 4 bytes.
2. **Normalization Operation**: The canonicalizer identifies the unique non-filler bundler key across all parsed tokens, rewrites the 16-hex-digit key prefix to canonical zeros (`0000000000000000`), and recomputes the 24-bit rapidhash hash word over the canonical token. Constant filler keys (`3333333333333333` and `7777777777777777`) emitted from unrelated data are excluded from detection.
3. **Strict Structural Anchoring**: Normalization eligibility is anchored strictly in parsed, validated container and payload structure, never in an unanchored scan or regex match across raw binary bytes:
   - *Container validation*: The binary must parse as a valid ELF64-LE executable containing a loadable `.bun` section in a `PT_LOAD` segment, or a Mach-O64-LE executable containing a `__BUN,__bun` section in a `__BUN` segment.
   - *Payload validation*: The section must contain a valid Bun payload prefix (`[u64 length]`), the pinned trailer `\n---- Bun! ----\n`, and a valid 32-byte offsets structure.
   - *Graph and Module validation*: The module table (52-byte `CompiledModuleGraphFile` records) is parsed to bound every module subrange.
   - *String table validation*: The shared bytecode string table must be located via the graph tail, bounds-checked, confirmed disjoint from all module subranges and builtin bytecode ranges, and parsed entry-by-entry.
4. **String-Table Width Rule (JSC `is8Bit` Flag)**: Only 8-bit (latin1) entries with bit 31 set in the length word are eligible chunk-token records. UTF-16 entries (bit 31 clear, length in code units, byte length `length * 2`) are parsed, bounds-checked, and hash-validated against their raw bytes, but are **never** normalized even if their decoded text matches the token pattern. Any difference in a UTF-16 entry remains unnormalized and is reported as a `residual-difference`.

### Rejection Codes and Fail-Closed Policy

The canonicalizer fails closed on any malformed structure, unexpected field, or underivable byte. Unknown or unparsed binary shapes are refused, never guessed or silently accepted. The complete set of 15 rejection codes defined in `packages/plus/script/release/canonicalize.ts:161-177` (`RejectionCode`) comprises:

| Rejection Code | Trigger Condition |
| --- | --- |
| `unsupported-toolchain` | Binary built with a Bun version other than the pinned release toolchain (`1.4.2`). |
| `unsupported-executable-format` | Buffer is not an ELF64-LE or Mach-O64-LE standalone Bun binary (e.g. PE/Win32 binary or raw filler data). |
| `executable-structure-malformed` | ELF or Mach-O headers, segments, section tables, or payload container bounds are corrupt or inconsistent. |
| `bun-payload-malformed` | Bun payload length prefix, `\n---- Bun! ----\n` trailer, or offsets struct is missing, invalid, or out of bounds. |
| `module-graph-malformed` | Module table records, module formats, loaders, or module-owned bytecode subranges are invalid or out of bounds. |
| `string-table-locator-malformed` | Graph tail fields, argv layout, builtin bytecode counts, or string table locators are inconsistent or overlap module data. |
| `string-table-malformed` | Shared string table header, entry offsets, entry alignment, declared lengths, or padding bytes are corrupted. |
| `record-hash-word-reserved-bits` | Upper 8 bits of a string table entry hash word are non-zero (must be `0x00`). |
| `record-hash-underived` | Stored hash in a string table entry does not match `rapidhash(raw bytes) & 0xffffff`. |
| `bundler-key-missing` | String table contains no chunk tokens bearing a bundler key (e.g. build compiled without `--bytecode`). |
| `bundler-key-ambiguous` | String table contains multiple conflicting candidate bundler keys. |
| `size-mismatch` | Two rebuild outputs differ in byte length. |
| `record-set-mismatch` | Rebuild outputs have differing token counts or token record offsets. |
| `container-mismatch` | Rebuild outputs use different container formats (e.g. comparing ELF against Mach-O). |
| `residual-difference` | Any byte outside the normalized bundler key and hash word spans differs between rebuilds. |

### Toolchain Pinning

The canonicalizer specification and parser arithmetic are strictly pinned to Bun `1.4.2` (`CANONICALIZER.bunVersion = "1.4.2"` and `CANONICALIZER.id = "bun-compile-chunk-token/v2"` in `packages/plus/script/release/canonicalize.ts:69-75`). If either binary in a rebuild pair declares or was compiled with any other toolchain version, `compareRebuild` immediately refuses the comparison as `unsupported-toolchain` without attempting structural recovery.

### Measured Verification Evidence

Empirical rebuild equivalence was measured on production-like release binaries at source commit `274013bd899c09b2d22cbda21e732e8ff9261ca9`. Two independent local rebuilds of the release binary produced:

```
equivalent true, container elf, rawIdentical false
recordsParsed 189, recordsRewritten 189, rawDifferingBytes 3401
bundler keys 0cf5d472ba4a2d96 and 0f6ec238c7a0a049
canonicalSha256 634d042c11502b7af91f1d0bd232111c20fe06bf86633e93a2038539c14eefa3
```

Every one of the 3,401 raw differing bytes fell strictly within the 189 rewritten token records (16 key bytes plus 4 hash word bytes per record); zero differences existed outside those spans.

The gate was proven non-vacuous through active tamper rejection tests:
- A single byte flipped in module bytecode is rejected with `residual-difference` reporting the exact byte offset (`test/release/canonicalize.test.ts:692`).
- A corrupted or tampered ELF header is rejected with `unsupported-executable-format` or `executable-structure-malformed`.
- A truncated or extended binary is rejected with `size-mismatch` (`test/release/canonicalize.test.ts:801`).
- Building with a mismatched Bun version is rejected with `unsupported-toolchain` (`test/release/canonicalize.test.ts:293`).
- A forged token hash or modified chunk index is rejected with `record-hash-underived` or `residual-difference` (`test/release/canonicalize.test.ts:705, 741`).

### Known Equivalence Limitations

This section documents four structural limitations of the D3-B canonicalizer implementation. Following the standard set in the security residuals sections, each entry records the exact mechanism, reachability, risk direction, and disposition.

#### L1 — PE / Win32 Payloads Are Not Parsed

1. **Exact Mechanism**: Container dispatch in `locateBunPayload` (`packages/plus/script/release/canonicalize.ts:491-502`) parses only ELF64-LE (using `isElf64Le`) and Mach-O64-LE (using `isMachO64Le`). Windows PE/COFF executable formats (`PE32+`) are not recognized and are rejected as `unsupported-executable-format`.
2. **Scope and Target Qualification**: In `release/contract.json:11-21`, all four qualified release targets (`linux-arm64`, `linux-x64`, `darwin-arm64`, `darwin-x64`) produce ELF or Mach-O binaries and are fully supported. Windows targets (`win32-x64`, `win32-arm64`) are explicitly listed under `unqualifiedTargets` with `unqualifiedReason: "Windows is explicitly not qualified for OpenCode Plus releases."`
3. **Risk Direction**: The limitation cannot cause a false acceptance. If a Windows binary is evaluated, the gate fails closed with `unsupported-executable-format`. If Windows targets are qualified in a future release, rebuild equivalence cannot be established for Windows binaries until a PE parser is implemented.

#### L2 — Graph-Tail Field Order Is Measured, Not Derived

1. **Exact Mechanism**: The trailing record layout following the module table (module content hashes, embedded builtin bytecode records, bytecode string table locators, startup module count, optional module-info string table locators, and `--compile-exec-argv` NUL-terminated string) was determined by empirical byte measurement against Bun 1.4.2 compilation output, rather than derived from published Bun compiler specifications or formal schemas (`packages/plus/script/release/canonicalize.ts:96-112`).
2. **Risk Direction**: The risk is strictly a **false refusal, never a false accept**. Any divergence in field ordering, tail size, or padding introduced by compiler modifications causes `parseGraph` to fail closed with `string-table-locator-malformed`, `module-graph-malformed`, or `bun-payload-malformed`. This fail-closed guarantee is what makes reliance on empirical layout measurement safe for release verification.

#### L3 — Module-Info Table Is Bounds- and Overlap-Checked but Not Otherwise Parsed

1. **Exact Mechanism**: When an optional module-info string table locator is present in the graph tail, `parseGraph` (`packages/plus/script/release/canonicalize.ts:834-859`) verifies that the table fits within the graph, has non-zero length, and does not overlap module subranges, the module table, embedded builtin bytecode blobs, or the bytecode string table. However, individual string entries within the module-info table are not parsed or validated.
2. **Risk Direction**: Chunk tokens are normalized solely from the shared bytecode string table. Because the module-info string table is not parsed for normalization, any differing bytes within it cannot be masked or normalized; they remain untouched and fail closed as `residual-difference`.

#### L4 — Builtin Bytecode Blob Ranges Are Not Required Disjoint from Module Subranges

1. **Exact Mechanism**: Embedded builtin bytecode records (a `u32` count followed by 12-byte `{builtinId, bytecodeOffset, bytecodeLength}` entries) are validated by `parseGraph` (`packages/plus/script/release/canonicalize.ts:756-775`) to ensure each blob lies within the graph, resides in the data region before the module table (`offset + length <= modules.offset`), and does not overlap the argv string or announced string tables. However, `parseGraph` does not programmatically check that builtin bytecode ranges are disjoint from individual module-owned subranges (`moduleRanges`).
2. **Risk Direction**: Unit test coverage (`test/release/canonicalize.test.ts:1021-1023`) verifies that in real Bun 1.4.2 builds, builtin bytecode blobs and module subranges are mutually disjoint allocations. Furthermore, neither builtin bytecode blobs nor module subranges are eligible for chunk-token normalization. Any differing byte in either region is treated as non-derivable and rejected with `residual-difference`.

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

