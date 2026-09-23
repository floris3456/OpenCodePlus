# OpenCode Plus Release Operator Guide

This reference document defines standard operating procedures for human operators managing, diagnosing, and repairing OpenCode Plus releases and services. It provides checkable, concrete procedures grounded directly in this repository's contracts, scripts, and runtime services.

For formal data structures, cryptographic hashing invariants, and gate definitions, see [Release Contracts and Verification Policy](contracts.md).

---

## 1. Identify the Current Release

An operator inspecting a live system must distinguish between three distinct application states:

| State | Definition | Where It Lives |
| --- | --- | --- |
| **Installed** | Validated, unpacked release artifacts residing in immutable local storage. Multiple versions can be installed simultaneously. | `<prefix>/releases/<version>/` |
| **Staged** | An installed release present on disk whose binary is **not** currently referenced by the active symlink pointer. | `<prefix>/releases/<staged-version>/` |
| **Running** | The active background server daemon currently executing in memory and bound to a local TCP port. | In-memory process identified by `<state>/service.json` |

### Install Prefix and Directory Layout

The default install prefix `<prefix>` is `$HOME/.opencodeplus` (overridable during installation via `-p, --prefix <path>` or the `PREFIX` environment variable).

The installation filesystem follows this structure:

```
<prefix>/
├── bin/
│   └── opencodeplus -> ../releases/<version>/bin/opencodeplus  # Active symlink pointer
└── releases/
    ├── <version-A>/                                           # Read-only immutable release
    │   ├── bin/opencodeplus                                   # Executable binary (mode 0755)
    │   ├── metadata.json                                      # Canonical inner provenance
    │   ├── LICENSE                                            # License text (mode 0644)
    │   └── NOTICE                                             # Notice text (mode 0644)
    └── <version-B>/
        └── ...
```

The immutable record for any version is the `<prefix>/releases/<version>` directory itself. During installation, `install.sh` locks this directory with `chmod -R a-w` (`chmod 755` on the binary). Existing releases are immutable; reinstalling an existing version exits immediately without rewriting disk contents (`install.sh` lines 440–451).

### Identification Commands

Execute the following commands to determine the current system identity:

1. **Locate the active binary and its target release directory**:
   ```bash
   which opencodeplus
   # e.g. /home/user/.opencodeplus/bin/opencodeplus

   readlink -f "$(which opencodeplus)"
   # e.g. /home/user/.opencodeplus/releases/1.0.0/bin/opencodeplus
   ```

2. **Inspect executable version and build identity**:
   ```bash
   opencodeplus --version
   # Prints the version string, e.g. "1.0.0"

   opencodeplus build-info --json
   ```
   The `build-info --json` command (`packages/cli/src/commands/handlers/build-info.ts`) prints the exact build provenance:
   ```json
   {
     "product": "opencodeplus",
     "channel": "plus",
     "version": "1.0.0",
     "sourceSha": "36c75b1db6f499a97a40b531d56aede8f8da9df3",
     "recipeDigest": "31548e65e638efcbaec6dd7381ffcebe7f465053cfb97d19ca7b5eb9725f0e1f",
     "toolchainDigest": "4dae2d93eefaeaf7ba36239bc7a61d1558efdf3c51ef634dc4c6439be9b646c0",
     "target": "linux-arm64"
   }
   ```

3. **Verify the immutable inner metadata on disk**:
   ```bash
   cat "$HOME/.opencodeplus/releases/<version>/metadata.json" | jq .
   ```
   Verify that `binarySha256` in `metadata.json` matches the actual binary hash:
   ```bash
   sha256sum "$HOME/.opencodeplus/releases/<version>/bin/opencodeplus"
   ```

4. **Identify the running server daemon**:
   Managed service state lives in the XDG state directory `<state>`, defaulting to `$HOME/.local/state/opencodeplus/` (or `$XDG_STATE_HOME/opencodeplus/`):
   ```bash
   # Check service status via CLI
   opencodeplus service status
   # Prints the active URL (e.g. "http://127.0.0.1:49374") or "stopped"

   # Read the live service registration file directly
   cat "$HOME/.local/state/opencodeplus/service.json" | jq .
   ```
   The registration file (`packages/client/src/effect/service.ts`, `Service.Info`) records:
   ```json
   {
     "id": "<service-id>",
     "version": "1.0.0",
     "url": "http://127.0.0.1:49374",
     "pid": 12345,
     "password": "<daemon-password>"
   }
   ```

5. **Query live server health and epoch**:
   ```bash
   # Extract URL and password from registration, then query health endpoint
   URL=$(jq -r .url "$HOME/.local/state/opencodeplus/service.json")
   PASS=$(jq -r .password "$HOME/.local/state/opencodeplus/service.json")
   curl -s -u "opencode:${PASS}" "${URL}/api/health" | jq .
   # Returns: {"healthy": true, "version": "1.0.0", "pid": 12345}
   ```

---

## 2. Rollback

Outcome 9 mandates that rolling back to a previously installed release is **one operation and never a `git reset`**.

Rollback repoints the activation pointer `<prefix>/bin/opencodeplus` to an already-installed, immutable release directory under `<prefix>/releases/<target-version>/`.

### The Single Operation

To activate a target version `<target-version>` (for example, `1.0.0`):

```bash
# Atomic symlink replacement to the target immutable release
ln -sfn "../releases/<target-version>/bin/opencodeplus" "<prefix>/bin/opencodeplus"
```

*Note on atomic replacement:* If operating in environments requiring strict atomic link replacement across concurrent readers, use:
```bash
ln -sf "../releases/<target-version>/bin/opencodeplus" "<prefix>/bin/opencodeplus.tmp" && \
mv -Tf "<prefix>/bin/opencodeplus.tmp" "<prefix>/bin/opencodeplus"
```

After updating the pointer, restart the background service so the running server adopts the rolled-back binary:
```bash
opencodeplus service restart
# (Equivalent to: opencodeplus service stop && opencodeplus service start)
```

### What Rollback Changes and What It Preserves

- **What it changes**:
  - The symlink `<prefix>/bin/opencodeplus` points to the chosen release.
  - The running daemon process is replaced with a process running `<target-version>`, producing a new PID, new startup timestamp, and new server epoch.
- **What it preserves**:
  - All directory trees under `<prefix>/releases/` remain completely untouched. Both the newer and older releases remain intact in read-only storage.
  - No Git history, commits, or worktrees are touched.
  - Durable database state (`$XDG_DATA_HOME/opencodeplus/opencode.db`) and session event history remain preserved.

### Verifying Rollback Success

Operators must verify rollback by measuring actual process and binary facts, **never by exit codes alone**:

1. **Executable link verification**:
   ```bash
   readlink -f "<prefix>/bin/opencodeplus"
   # Must point to <prefix>/releases/<target-version>/bin/opencodeplus

   "<prefix>/bin/opencodeplus" --version
   # Must report <target-version>
   ```

2. **Running service verification**:
   ```bash
   cat "$HOME/.local/state/opencodeplus/service.json" | jq '{version, pid, url}'
   ```
   Verify that `version` matches `<target-version>` and `pid` reflects the new process.

3. **Live health query**:
   ```bash
   PASS=$(jq -r .password "$HOME/.local/state/opencodeplus/service.json")
   URL=$(jq -r .url "$HOME/.local/state/opencodeplus/service.json")
   curl -s -u "opencode:${PASS}" "${URL}/api/health" | jq .
   ```
   Verify that the response returns HTTP 200 with `"healthy": true` and `"version": "<target-version>"`.

4. **Host identity and server epoch**:
   The server's identity contract (`ReleaseHostIdentity` in `@opencode/schema/release`) tracks `{ generation, releaseVersion, executableSha256, serverEpoch, pid, startedAt }`. Ensure the running server's `executableSha256` matches the target release binary's hash (`sha256sum <prefix>/releases/<target-version>/bin/opencodeplus`) and that `serverEpoch` reflects the new startup epoch.

### Signed Authority Requirements for Promotions and Rollbacks

Submitting a promotion or rollback intent via the model-facing `release.request` tool or HTTP endpoint (`POST /api/release/request`) **grants no authority and activates nothing**.

- A submitted `ReleasePromotionRequest` is recorded durably in Core's `ReleaseRequestStore` (key `release:request:<requestID>`) in state `"accepted"`.
- It moves to state `"running"` only when presented with an artifact-specific `ReleaseControllerPermit` signed by a trusted issuer public key configured in the host's trust anchor:
  `<config>/release/controller.json` (under `$HOME/.config/opencodeplus/release/controller.json` or `$XDG_CONFIG_HOME/opencodeplus/release/controller.json`).
- Core verifies the permit's cryptographic signature, expiration window, `requestID`, `requestDigest`, `expectedGeneration`, and `artifactSha256` (`packages/core/src/release/request.ts` lines 304–358).
- Upon authorization, Core engages session admission fencing (`SessionAdmission.engage`) to block new session work during the transition.
- Once the controller finishes activating the binary and restarting the daemon, it issues `POST /api/release/settle` with the authorization token to mark the request `"completed"` and release the admission fence.

---

## 3. Recovery

The following procedures cover cold recovery scenarios. Each procedure pairs diagnostic checks with the corresponding remediation.

### Scenario A: Service Will Not Start (Crash or Boot Failure)

- **Diagnostic**:
  1. Inspect the service registration file:
     ```bash
     REG="$HOME/.local/state/opencodeplus/service.json"
     [ -f "$REG" ] && cat "$REG" | jq .
     ```
  2. If the service crashed during boot, `packages/cli/test/service.test.ts` (line 520, *"a failed service stays registered and owns the selected port until stopped"*) pins the behavior: a failed server holds the registration and answers `/api/health` with HTTP 500.
     ```bash
     URL=$(jq -r .url "$REG")
     PASS=$(jq -r .password "$REG")
     curl -i -s -u "opencode:${PASS}" "${URL}/api/health"
     # Returns HTTP/1.1 500 Internal Server Error
     ```
  3. Run the service in the foreground to observe diagnostic stderr directly:
     ```bash
     opencodeplus serve --service
     ```
- **Remediation**:
  1. Stop the failed service cleanly:
     ```bash
     opencodeplus service stop
     ```
     `Service.stop` removes the registration file upon shutdown (`packages/cli/test/service.test.ts` line 204).
  2. Check database write permissions:
     ```bash
     DB_PATH="${OPENCODE_DB:-$HOME/.local/share/opencodeplus/opencode.db}"
     ls -ld "$(dirname "$DB_PATH")" "$DB_PATH"
     ```
     Ensure the database directory is writable by the running user.
  3. Start the service:
     ```bash
     opencodeplus service start
     ```

### Scenario B: Registration Is Stale or Corrupt

- **Diagnostic**:
  1. Stale registration: The file `$HOME/.local/state/opencodeplus/service.json` exists, but the recorded PID is dead:
     ```bash
     PID=$(jq -r .pid "$HOME/.local/state/opencodeplus/service.json")
     kill -0 "$PID" 2>/dev/null || echo "PID $PID is dead (stale registration)"
     ```
  2. Corrupt registration: The file contains truncated or invalid JSON:
     ```bash
     jq . "$HOME/.local/state/opencodeplus/service.json" 2>&1
     # "parse error: Invalid numeric literal..."
     ```
  3. Ground truth behavior in code:
     - **Self-eviction on file corruption or deletion**: The running service daemon polls its registration file every 5 seconds (`packages/cli/src/services/service-registration.ts` lines 61–66). If the file is deleted or modified so `owns(found)` fails, the server logs a warning and initiates shutdown (`packages/cli/test/service.test.ts` lines 155–189: *"deleting a managed service registration stops its owner"* and *"corrupting a managed service registration stops its owner"*).
     - **Dead owner replacement**: When a new service starts and binds the port, `ServiceRegistration.register` automatically overwrites a stale registration belonging to a dead process (`packages/cli/test/service.test.ts` line 488: *"service registration replaces a stale owner with the bound address"*).
     - **No auto-replacement in Plus**: OpenCode Plus explicitly disables auto-killing unresponsive or unexpected peers (`packages/client/src/effect/service.ts` lines 56, 91, 113: `allowReplacement = false`). It fails with `ServiceRefusalError("timeout")` or `ServiceRefusalError("unexpected-peer")` to prevent rogue terminations.
- **Remediation**:
  1. If the PID is dead, remove the stale registration:
     ```bash
     rm -f "$HOME/.local/state/opencodeplus/service.json"
     ```
  2. If the PID is alive but wedged/unresponsive:
     ```bash
     kill -TERM "$PID"
     sleep 2
     kill -0 "$PID" 2>/dev/null && kill -KILL "$PID"
     rm -f "$HOME/.local/state/opencodeplus/service.json"
     ```
  3. Start the service cleanly:
     ```bash
     opencodeplus service start
     ```

### Scenario C: Port Is Occupied by an Unrelated Process

- **Diagnostic**:
  1. Contender startup fails with exit code 1, emitting:
     ```
     Managed service port <port> on 127.0.0.1 is already in use by another process.
     To configure a different port: opencode service set port <port>
     ```
     (Pinned by `packages/cli/test/service.test.ts` line 359: *"unrelated managed port occupancy reports an actionable conflict"*).
  2. Identify which process has bound the port (default port is `49374` / `0xc0de`):
     ```bash
     lsof -i :49374 || ss -tulpn | grep :49374
     ```
- **Remediation**:
  - **Option 1 (Reconfigure OpenCode Plus port)**:
    Assign OpenCode Plus to an available port:
    ```bash
    opencodeplus service set port <new-port>
    # Writes { "port": <new-port> } to $HOME/.config/opencodeplus/service.json
    opencodeplus service start
    ```
    (Pinned by `packages/cli/test/service.test.ts` lines 290–315: *"configured managed service port overrides the channel default"*).
  - **Option 2 (Terminate rogue occupant)**:
    If the occupant is an orphaned process from a previous test run, terminate the specific PID:
    ```bash
    kill -TERM <occupant-pid>
    opencodeplus service start
    ```

### Scenario D: Active Release Directory Is Damaged

- **Diagnostic**:
  1. The symlink `<prefix>/bin/opencodeplus` points to a missing or damaged binary.
  2. Verifying the binary hash fails against `metadata.json`:
     ```bash
     TARGET_BIN=$(readlink -f "$HOME/.opencodeplus/bin/opencodeplus")
     [ ! -x "$TARGET_BIN" ] && echo "Active binary missing or not executable"
     sha256sum "$TARGET_BIN"
     cat "$(dirname "$TARGET_BIN")/../metadata.json" | jq -r .binarySha256
     ```
- **Remediation**:
  1. **Immediate rollback**: If an older valid release exists, switch the symlink pointer immediately:
     ```bash
     ln -sfn "../releases/<previous-version>/bin/opencodeplus" "$HOME/.opencodeplus/bin/opencodeplus"
     opencodeplus service restart
     ```
  2. **Remove damaged release directory**: Release directories are read-only (`chmod a-w`). To delete the corrupted directory:
     ```bash
     chmod -R u+w "$HOME/.opencodeplus/releases/<damaged-version>"
     rm -rf "$HOME/.opencodeplus/releases/<damaged-version>"
     ```
  3. **Re-stage the release**:
     Reinstall the release using offline assets without touching the running incumbent:
     ```bash
     ./install.sh --offline --asset-dir <asset-dir> --prefix "$HOME/.opencodeplus" --stage
     ```

### Scenario E: Installer Interrupted Mid-Install

- **Diagnostic**:
  - `install.sh` uses a scratch directory created via `mktemp -d` and installs an exit trap (`trap cleanup EXIT` at `install.sh` lines 118–123).
  - Checksum validation, tarball safety checks, member size bounds, and binary hash verification happen entirely within the sandbox before the release directory `<prefix>/releases/<version>` is created.
  - If interrupted during download, check, or extraction, the sandbox is removed automatically, leaving no partial directory under `<prefix>/releases/`.
- **Remediation**:
  1. Check if a partial directory was left during the final directory move:
     ```bash
     if [ -d "$HOME/.opencodeplus/releases/<version>" ]; then
       # Verify all four required contract members exist
       for f in bin/opencodeplus metadata.json LICENSE NOTICE; do
         [ -f "$HOME/.opencodeplus/releases/<version>/$f" ] || echo "Missing $f"
       done
     fi
     ```
  2. If missing members or broken:
     ```bash
     chmod -R u+w "$HOME/.opencodeplus/releases/<version>"
     rm -rf "$HOME/.opencodeplus/releases/<version>"
     ```
  3. Re-run `install.sh`:
     ```bash
     ./install.sh --offline --asset-dir <asset-dir> --prefix "$HOME/.opencodeplus"
     ```

---

## 4. Verifying Integrity Offline

Operators can verify the full integrity and provenance of release assets on disk without network access.

### Asset Bundle Contents

An offline asset directory `<asset-dir>` contains:

| File | Purpose | Immutable Contract Member |
| --- | --- | --- |
| `release.json` | Release manifest defining release identity, artifact hashes, and installer hash | Yes (`manifestFile`) |
| `SHA256SUMS` | Checksums for all bundle assets (must **not** list itself) | Yes (`sumsFile`) |
| `install.sh` | Deterministic installer script | Yes (`installerFile`) |
| `opencodeplus-<target>.tar.gz` | Target archives (`linux-arm64`, `linux-x64`, `darwin-arm64`, `darwin-x64`) | Yes (Qualified targets) |
| `acceptance-receipt.json` | (Optional) Aggregate acceptance gate receipt with check receipts | Generated by acceptance harness |

### Manual Verification Procedure

1. **Verify asset checksums**:
   ```bash
   cd <asset-dir>
   sha256sum -c SHA256SUMS
   ```
   *Rule*: `SHA256SUMS` must verify all tarballs, `install.sh`, and `release.json`. It must never list `SHA256SUMS` itself (`checksums_cover_self`).

2. **Verify manifest structure and contract version**:
   ```bash
   jq . release.json
   ```
   Confirm `contractVersion == 1`, `release.product == "opencodeplus"`, `release.channel == "plus"`.

3. **Verify archive safety and structure without extracting**:
   ```bash
   tar -tzf opencodeplus-<target>.tar.gz
   ```
   Must list exactly four entries in strictly sorted lexicographical order:
   ```
   LICENSE
   NOTICE
   bin/opencodeplus
   metadata.json
   ```
   Confirm no path traversal (`..`), no symlinks/hardlinks, and regular file modes (`0755` for binary, `0644` for text files).

4. **Verify inner metadata identity**:
   ```bash
   tar -xzf opencodeplus-<target>.tar.gz metadata.json -O | jq .
   ```
   Confirm that `product`, `channel`, `version`, `sourceSha`, `recipeDigest`, `toolchainDigest`, `target`, and `binarySha256` agree byte-for-byte with `release.json`.

### Programmatic Offline Verifier (`verify-release.ts`)

Run the offline verifier directly via Bun:
```bash
bun -e '
  import { verifyRelease } from "./packages/plus/script/verify-release.ts";
  const result = await verifyRelease(process.argv[1]);
  if (!result.ok) {
    console.error(`Verification failed: [${result.reason}] ${result.message}`);
    process.exit(1);
  }
  console.log(`Verified release ${result.version} (${result.artifactsVerified} artifacts, sums: ${result.sumsVerified})`);
' <asset-dir>
```

### Complete Rejection Reasons Reference

The verifier in `packages/plus/script/verify-release.ts` emits the following rejection reasons (`ReleaseVerificationRejectionReason`):

| Rejection Reason | Condition Detected | Operator Meaning / Remedy |
| --- | --- | --- |
| `missing_manifest` | `release.json` does not exist in asset directory. | Asset bundle is incomplete. Ensure `release.json` is copied into the directory. |
| `invalid_manifest` | `release.json` failed JSON or schema decoding. | The manifest is corrupt or malformed. Re-fetch or regenerate manifest. |
| `unsupported_contract_version` | `contractVersion` is not `1`. | Manifest format version is unsupported by this verifier. |
| `missing_installer` | `install.sh` does not exist in asset directory. | Installer script missing from bundle. |
| `installer_hash_mismatch` | SHA-256 of `install.sh` differs from `manifest.installerSha256`. | Installer script was modified, truncated, or tampered with. |
| `missing_checksums` | `SHA256SUMS` file not found when expected. | Checksum file is missing. |
| `checksums_cover_self` | `SHA256SUMS` contains an entry for `SHA256SUMS`. | Contract violation: checksum files must never list their own hash. |
| `missing_asset` | An archive or file listed in `manifest.artifacts` or `SHA256SUMS` is missing on disk. | The bundle has missing files. Check that all target archives are present. |
| `checksum_hash_mismatch` | File SHA-256 does not match `SHA256SUMS`. | File corruption or tampering detected for non-archive asset. |
| `archive_byte_size_mismatch` | Archive byte length does not match `artifact.bytes` in manifest. | Tarball is truncated or padded. |
| `archive_hash_mismatch` | Archive SHA-256 does not match `artifact.archiveSha256`. | Archive contents were modified or corrupted in transit. |
| `archive_parse_failed` | Failed to parse tar/gzip structure. | Archive is corrupted, incomplete, or not a valid gzip tarball. |
| `archive_safety_violation` | Archive contains non-regular files, symlinks, path traversal, or unwhitelisted files. | Hostile archive detected! The archive violates security constraints. Do not extract. |
| `archive_members_not_sorted` | Archive entries are not in strictly sorted lexicographical order. | Archive normalization failure: entries must be sorted for reproducible packaging. |
| `archive_member_ownership_violation` | Member entry has non-zero `uid` or `gid`. | Normalization failure: archive entries must be normalized to `uid=0`, `gid=0`. |
| `archive_member_mode_violation` | Member file permission mode does not match `0755` (binary) or `0644` (text). | File modes were altered. |
| `archive_missing_binary` | Member `bin/opencodeplus` missing from archive. | Required executable missing from archive payload. |
| `binary_hash_mismatch` | Extracted binary SHA-256 does not match `artifact.binarySha256`. | Extracted binary does not match the manifest's declared binary hash. |
| `archive_missing_metadata` | Member `metadata.json` missing from archive. | Inner provenance metadata missing from archive payload. |
| `invalid_inner_metadata` | `metadata.json` cannot be parsed as valid JSON. | Inner metadata corrupted. |
| `inner_metadata_contains_own_hash` | `metadata.json` contains forbidden self-referential keys (`metadataSha256`, `sha256`). | Provenance contract violation: metadata must exclude its own hash. |
| `inner_metadata_contains_build_timestamp` | `metadata.json` contains forbidden timestamp keys (`builtAt`, `timestamp`, `buildTime`, etc.). | Provenance contract violation: inner metadata must exclude non-deterministic build timestamps. |
| `inner_metadata_identity_mismatch` | Attributes in `metadata.json` (`version`, `sourceSha`, `target`, `recipeDigest`, `toolchainDigest`) disagree with `release.json`. | Provenance split: the archive contains metadata from a different build than the manifest claims. |
| `unknown_error` | Unhandled exception encountered during verification. | Check verifier error stack for filesystem or system errors. |

### Offline Acceptance Receipt Verification (`acceptance.ts`)

If an `acceptance-receipt.json` is present, verify it offline with:
```bash
bun -e '
  import { verifyAcceptanceOffline } from "./packages/plus/script/acceptance.ts";
  const result = await verifyAcceptanceOffline({ exportDir: process.argv[1] });
  if (!result.ok) {
    console.error(`Acceptance verification failed: [${result.reason}] ${result.message}`);
    process.exit(1);
  }
  console.log(`Verified acceptance receipt for source ${result.sourceSha} (verdict: ${result.verdict}, checks: ${result.checksVerified})`);
' <export-dir>
```

Possible rejection reasons (`OfflineVerificationRejectionReason`):
- `missing_receipt`: `acceptance-receipt.json` missing.
- `invalid_receipt`: Receipt fails JSON or schema decoding.
- `source_sha_mismatch`: Receipt `sourceSha` does not match manifest or expected SHA.
- `release_identity_mismatch`: Release identity in receipt differs from manifest.
- `artifact_identity_mismatch`: Artifact in receipt not found in manifest.
- `policy_digest_mismatch`: Digest of `checks.json` differs from receipt.
- `harness_digest_mismatch`: Digest of acceptance harness code differs from receipt.
- `check_receipt_invalid`: A check receipt has invalid schema structure.
- `check_head_mismatch`: A check was executed against a git HEAD differing from receipt `sourceSha`.
- `check_failed_in_pass_verdict`: A check has non-zero exit code in a passing receipt.
- `check_dirty_in_pass_verdict`: A check was run against a dirty working tree in a passing receipt.
- `missing_required_policy_check`: One of the 12 required checks from `release/checks.json` is missing.
- `asset_verification_failed`: Underlying asset verification (`verifyRelease`) failed.

---

## 5. Preserved v1 History

Round 4 does not delete anything from the previous generation:

1. **Intact Historical Runs and Rescue Paths**:
   - Existing v1 runs and one frozen rescue path remain intact until they are separately dispositioned.
   - No historical worktree, run directory, or bundle deletion is authorized by this release.

2. **In-Repository Compatibility Bridges**:
   - Legacy V1 contracts remain preserved under `packages/schema/src/v1/` (`session.ts`, `question.ts`, `permission.ts`, `legacy-event.ts`, `filesystem.ts`).
   - The CLI retains the non-interactive V1 execution bridge (`packages/cli/src/run/v1.ts`).
   - These entrypoints remain available for reading historical state and backward compatibility.

3. **Workspace Historical Evidence**:
   - In the workspace repository (`OpenCodePlus`), historical execution run records live under `run/team/<namespace>/runs/<run>/`:
     - `owner.json`: Run status and ownership report.
     - `checks/`: Historical check execution receipts.
     - `config/`: Frozen configuration and environment.
     - `data/`: Complete interaction transcript.

4. **Open Item — External v1 Storage Physical Inventory**:
   - **Open Item**: The physical filesystem storage paths, retention policies, and formal disposition schedule for historical v1 workspaces and external previous-generation bundles reside in workspace-level controller administration (outside `repos/opencode`). An operator requiring physical access or disposal of v1 historical runs must coordinate with workspace administration tooling (`bin/team`).

---

## 6. What This Guide Does Not Cover

This operational guide enforces strict administrative boundaries:

- **External Controller Authority**: All external controller workflows (including private key management for controller permits, minting `ReleaseControllerPermit` signatures, scheduling runs across isolated worktrees, and running supervisor commands) live in the workspace repository (`OpenCodePlus`), not in `repos/opencode`.
- **No Minting Authority**: This guide does not grant or describe authority to generate private signing keys or issue grants. Trust anchors in `$HOME/.config/opencodeplus/release/controller.json` are operator-maintained public keys.
- **Model Release Tool Limits**: The model-facing release tools (`release.request` and `release.status` in `packages/plus/src/release/tools.ts`) only record intent and query request status. They hold no execution authority, cannot authorize requests, and cannot trigger binary promotion or rollback on their own.
