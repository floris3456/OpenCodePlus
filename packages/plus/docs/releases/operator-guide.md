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

Outcome 9 mandates that rolling back to a previously installed release is **one controlled transition and never a `git reset`**.

However, on a live system running background services, rollback **cannot** be performed by an unfenced local symlink replacement and service restart. Performing an unfenced switch cuts off active sessions mid-execution, ignores controller generation invariants, and bypasses session admission fencing.

### Production Transition Requirements

A safe production rollback requires a coordinated five-phase transition:

1. **Identity**: The target release directory `<prefix>/releases/<target-version>/` must exist in immutable local storage, with valid `metadata.json` and a matching binary SHA-256 hash.
2. **Authorization**: An artifact-specific `ReleaseControllerPermit` must be issued and signed by a trusted issuer public key configured in the host's trust anchor (`<config>/release/controller.json`).
3. **Quiescence and Fencing**: The permit is submitted alongside the request to the controller authorization seam via the `x-opencode-release-permit` HTTP header (`POST /api/release/request`), engaging Core session admission fencing (`SessionAdmission.engage`) to block new session requests and allowing in-flight session work to drain to an idle boundary.
4. **Fenced Activation**: While the admission fence is held and active sessions are drained, the activation symlink `<prefix>/bin/opencodeplus` is atomically updated and the background daemon is restarted with the rolled-back binary.
5. **Settlement**: After verifying that the new daemon is healthy and running the target version, the controller calls `POST /api/release/request/:requestID/settle` with the authorization token (`token`) to mark the request completed and release the session admission fence.

### Operational Status in This Source Repository

**Direct Operator Rollback on a Live Service Is Unavailable**:
This source repository (`repos/opencode`) does not contain an automated standalone local CLI command for operators to execute a fenced, drained transition directly against a live running server. Standalone unfenced symlink replacement (`ln -sfn`) combined with an uncoordinated service restart (`opencodeplus service restart`) on a live daemon is **unsafe and prohibited** by workspace standing rules.

**Escalation**:
Live rollback operations must be escalated to the **workspace controller operator**, who holds the controller signing keys and drives the authorized, fenced, and drained transition via workspace controller tooling (`bin/team`).

### Cold Rollback Procedure (Service Confirmed Stopped Only)

If and only if the daemon is completely stopped and confirmed idle (for example, disaster recovery or initial deployment repair where kernel state confirms no background process is running):

1. **Verify daemon quiescence via kernel state**:
   Cold rollback requires affirmative proof that no daemon process is running and no service port remains bound. Absent or unreadable evidence fails the check immediately rather than being assumed quiescent.

   ```bash
   STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/opencodeplus"
   CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencodeplus"
   REG="$STATE_DIR/service.json"
   CONFIG="$CONFIG_DIR/service.json"

   # 1. Require registration evidence; missing or corrupt registration fails
   if [ ! -f "$REG" ]; then
     echo "ERROR: Service registration file ($REG) is absent. Cannot verify daemon quiescence from absent evidence."
     exit 1
   fi
   if ! jq -e '.pid and .url' "$REG" >/dev/null 2>&1; then
     echo "ERROR: Service registration file ($REG) is corrupt or unreadable. Cannot verify daemon quiescence."
     exit 1
   fi

   PID=$(jq -r .pid "$REG")
   REG_URL=$(jq -r .url "$REG")

   # 2. Derive configured service port (fail if configuration file exists but is unreadable/corrupt)
   PORT=""
   if [ -f "$CONFIG" ]; then
     if ! jq -e . "$CONFIG" >/dev/null 2>&1; then
       echo "ERROR: Service configuration file ($CONFIG) is corrupt or unreadable."
       exit 1
     fi
     PORT=$(jq -r '.port // empty' "$CONFIG")
   fi
   if [ -z "$PORT" ]; then
     PORT=$(echo "$REG_URL" | grep -oE '[0-9]+$')
   fi
   PORT="${PORT:-49374}"

   # 3. Verify daemon PID is absent from kernel state
   if [ -d "/proc/$PID" ]; then
     echo "ERROR: Service daemon is still running (PID $PID). Cold rollback is forbidden on a running system."
     exit 1
   fi

   # 4. Verify derived service port is not bound
   if ss -tulpn 2>/dev/null | grep -qE ":$PORT\b"; then
     echo "ERROR: Service port $PORT is still bound. Cold rollback is forbidden while port is in use."
     exit 1
   fi
   ```

2. **Verify target release integrity**:
   ```bash
   TARGET_DIR="$HOME/.opencodeplus/releases/<target-version>"
   [ -x "$TARGET_DIR/bin/opencodeplus" ] || { echo "Target binary missing or non-executable"; exit 1; }
   BIN_HASH=$(sha256sum "$TARGET_DIR/bin/opencodeplus" | awk '{print $1}')
   META_HASH=$(jq -r .binarySha256 "$TARGET_DIR/metadata.json")
   [ "$BIN_HASH" = "$META_HASH" ] || { echo "Binary hash mismatch"; exit 1; }
   ```

3. **Atomic symlink pointer update**:
   ```bash
   ln -sf "../releases/<target-version>/bin/opencodeplus" "$HOME/.opencodeplus/bin/opencodeplus.tmp" && \
   mv -Tf "$HOME/.opencodeplus/bin/opencodeplus.tmp" "$HOME/.opencodeplus/bin/opencodeplus"
   ```

4. **Start the service cleanly**:
   ```bash
   opencodeplus service start
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
- Once the controller finishes activating the binary and restarting the daemon, it issues `POST /api/release/request/:requestID/settle` with the authorization token to mark the request `"completed"` and release the admission fence.

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
  1. **Deriving process liveness and identity strictly from kernel state**:
     The workspace standing rules (workspace `AGENTS.md` §C "Processes") strictly govern process interactions:
     > Derive liveness from kernel state — `/proc/<pid>/{cwd,fd,maps,environ}` — never from a registration file, which can outlive the process it describes, and never kill by name. Stop only owned, confirmed-idle test or worker runtimes.

     Do not rely on `kill -0 "$PID"` or the registration file to establish identity; operating systems recycle process IDs. If a previous daemon died and the OS assigned its PID to an unrelated user process, signaling that PID harms an innocent process.

     Inspect the kernel state for the recorded PID:
     ```bash
     REG="$HOME/.local/state/opencodeplus/service.json"
     PID=$(jq -r .pid "$REG" 2>/dev/null || true)

     # 1. Check if the process exists in kernel state
     if [ -z "$PID" ] || [ ! -d "/proc/$PID" ]; then
       echo "PID $PID does not exist: registration is stale."
     else
       # 2. Verify process ownership (must match current user UID)
       OWNER_UID=$(stat -c %u "/proc/$PID" 2>/dev/null || echo -1)
       if [ "$OWNER_UID" != "$(id -u)" ]; then
         echo "PID $PID is owned by UID $OWNER_UID, not $(id -u): PID was recycled by an unrelated process."
       fi

       # 3. Verify executable path points to an opencodeplus binary
       EXE_TARGET=$(readlink -f "/proc/$PID/exe" 2>/dev/null || true)
       echo "Executable for PID $PID: $EXE_TARGET"

       # 4. Verify command line and environment
       tr '\0' ' ' < "/proc/$PID/cmdline" 2>/dev/null; echo ""

       # 5. Check if this process holds the service port
       PORT=$(jq -r .url "$REG" 2>/dev/null | grep -oE '[0-9]+$' || echo "49374")
       ss -tulpn 2>/dev/null | grep "$PID" | grep -q ":$PORT" && echo "PID $PID holds port $PORT"
     fi
     ```

  2. **Corrupt registration file**:
     The registration file contains truncated or malformed JSON:
     ```bash
     jq . "$REG" 2>&1
     # "parse error: Invalid numeric literal..."
     ```

  3. **Ground truth behavior in code**:
     - **Self-eviction on file corruption or deletion**: The running service daemon polls its registration file every 5 seconds (`packages/cli/src/services/service-registration.ts` lines 61–66). If the file is deleted or modified so `owns(found)` fails, the server logs a warning and initiates shutdown (`packages/cli/test/service.test.ts` lines 155–189: *"deleting a managed service registration stops its owner"* and *"corrupting a managed service registration stops its owner"*).
     - **Dead owner replacement**: When a new service starts and binds the port, `ServiceRegistration.register` automatically overwrites a stale registration belonging to a dead process (`packages/cli/test/service.test.ts` line 488: *"service registration replaces a stale owner with the bound address"*).
     - **No auto-replacement in Plus**: OpenCode Plus explicitly disables auto-killing unresponsive or unexpected peers (`packages/client/src/effect/service.ts` lines 56, 91, 113: `allowReplacement = false`). It fails with `ServiceRefusalError("timeout")` or `ServiceRefusalError("unexpected-peer")` to prevent rogue terminations.

- **Remediation**:
  1. **Case 1: Process is confirmed dead (`/proc/$PID` does not exist)**:
     Kernel state confirms the process no longer exists. The registration file is stale:
     ```bash
     rm -f "$HOME/.local/state/opencodeplus/service.json"
     opencodeplus service start
     ```

  2. **Case 2: Process exists but fails ownership or executable identity checks (PID recycled)**:
     The process at `$PID` is NOT an owned OpenCode Plus process.
     **Signaling or killing this PID is STRICTLY FORBIDDEN.**
     Because kernel state proves the process at `$PID` is unrelated, the registration file is an orphaned artifact. Remove the registration file directly without touching the unrelated process:
     ```bash
     rm -f "$HOME/.local/state/opencodeplus/service.json"
     opencodeplus service start
     ```

  3. **Case 3: Process is unresponsive or wedged**:
     - Attempt clean shutdown via CLI first:
       ```bash
       opencodeplus service stop
       ```
     - **Direct Signaling of an Unresponsive Daemon Is Unavailable and Prohibited**:
       If `opencodeplus service stop` fails and the process remains running, an operator shell cannot establish authoritative task ownership and idleness. Verifying a UID match and matching executable pathname substrings (`*opencodeplus*`) proves only that a process belongs to the current user and executes an OpenCode binary; it does **not** establish task ownership in the workspace nor that the runtime is confirmed idle.
       Sending `SIGTERM` or `SIGKILL` without authoritative proof of task ownership and idleness violates workspace standing rules (§C Processes: *"Stop only owned, confirmed-idle test or worker runtimes. Never kill by executable name, and never restart unrelated hosts"*).
     - **Escalation**:
       Wedged service daemon incidents must be escalated to the **workspace controller operator** (or host supervisor). The controller operator holds supervisor context across runs, can inspect active task ownership, drain or fence dependent work, and perform an authorized, controlled process termination via workspace supervisor tooling (`bin/team`).
     - Once the controller operator has resolved the wedged process and kernel state confirms `/proc/$PID` is absent, remove the stale registration file and start the service:
       ```bash
       [ ! -d "/proc/$PID" ] && rm -f "$HOME/.local/state/opencodeplus/service.json"
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
  2. Identify which process has bound the port:
     ```bash
     CONFIG="$HOME/.config/opencodeplus/service.json"
     PORT=$(jq -r '.port // 49374' "$CONFIG" 2>/dev/null || echo "49374")
     lsof -i :"$PORT" || ss -tulpn | grep ":$PORT"
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
  - **Option 2 (Escalate for Occupant Resolution)**:
    Terminating a port occupant from an operator shell is **unavailable and prohibited**. An operator shell cannot authoritatively prove task ownership or idleness of an occupant process; matching executable paths or substrings (`*opencodeplus*`, `*bun*`, `*node*`) does not establish an owned, idle runtime.
    If the occupant cannot be identified or if port reconfiguration (Option 1) is not viable, escalate to the **workspace controller operator** to verify task ownership across workspace runs and safely stop the occupant.

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
  1. **Rollback to a valid release**:
     - *If the background service is running*: Manual symlink replacement combined with `service restart` is unsafe and prohibited because it performs an unfenced transition without session draining or admission fencing. Operators must escalate to the **workspace controller operator** to execute an authorized, fenced transition.
     - *If the background service is stopped*: Follow the [Cold Rollback Procedure](#cold-rollback-procedure-service-confirmed-stopped-only): verify that the daemon is stopped via `/proc`, verify the target release integrity, update the symlink atomically using a temporary link (`mv -Tf`), and start the service.

  2. **Remove damaged release directory (Live References Check Mandatory)**:
     Release directories are locked read-only (`chmod a-w`). Removing a release directory while any process holds open references or while active symlinks point to it violates workspace rules and causes running processes to crash.

     **Prerequisites before directory modification or removal**:
     - **Active symlink check**: Verify the active binary symlink does not resolve to the directory being removed:
       ```bash
       DAMAGED_DIR="$HOME/.opencodeplus/releases/<damaged-version>"
       ACTIVE_TARGET=$(readlink -f "$HOME/.opencodeplus/bin/opencodeplus" 2>/dev/null || true)
       if [ "$ACTIVE_TARGET" = "$DAMAGED_DIR/bin/opencodeplus" ]; then
         echo "ERROR: Active symlink still points to $DAMAGED_DIR. Must repoint or remove active symlink before deleting directory."
         exit 1
       fi
       ```
     - **Kernel live references check**: Verify that no process on the host holds open file descriptors, active working directories, or memory-mapped files inside the directory:
       ```bash
       # 1. Check for open file handles via lsof
       lsof +D "$DAMAGED_DIR" 2>/dev/null
       # 2. Check kernel memory maps across /proc
       grep -l "$DAMAGED_DIR" /proc/[0-9]*/maps 2>/dev/null
       ```
     - **Unavailability**: If any process still holds open references, memory mappings, or working directory handles into `$DAMAGED_DIR`, directory removal is **UNAVAILABLE AND FORBIDDEN**. The operator must stop or restart the referencing processes cleanly before attempting deletion.
     - **Destructive cleanup**: Only after proving zero active symlinks and zero live kernel references exist:
       ```bash
       chmod -R u+w "$DAMAGED_DIR"
       rm -rf "$DAMAGED_DIR"
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
     PARTIAL_DIR="$HOME/.opencodeplus/releases/<version>"
     if [ -d "$PARTIAL_DIR" ]; then
       # Verify all four required contract members exist
       for f in bin/opencodeplus metadata.json LICENSE NOTICE; do
         [ -f "$PARTIAL_DIR/$f" ] || echo "Missing $f"
       done
     fi
     ```
  2. If missing members or broken, perform live-reference verification before cleanup:
     ```bash
     # Verify no active installer process is running
     pgrep -f "install.sh" | while read -r p; do
       [ "$(stat -c %u "/proc/$p" 2>/dev/null)" = "$(id -u)" ] && echo "Active installer process: $p"
     done
     # Verify zero open references in kernel state
     lsof +D "$PARTIAL_DIR" 2>/dev/null
     grep -l "$PARTIAL_DIR" /proc/[0-9]*/maps 2>/dev/null
     ```
     Only when confirmed that no installer is active, zero live references exist, and the active symlink does not point to `$PARTIAL_DIR`:
     ```bash
     chmod -R u+w "$PARTIAL_DIR"
     rm -rf "$PARTIAL_DIR"
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
