# Canonical Linux Builder Recipe

This directory contains the canonical container specification for building deterministic, bit-for-bit reproducible OpenCode Plus release binaries.

## 1. Pinned Toolchain & Environment

All parameters match the repository release contract defined in `release/toolchain.json`:

- **Operating System Base**: Debian 12 (Bookworm) `debian:bookworm-slim`.
- **Base Image Digest**: The base image platform digest is intentionally marked as `TODO-measured-by-build-seat` in `Dockerfile` and `null` in `release/toolchain.json`. Under project honesty rules, unmeasured external facts remain `null` or explicitly marked until measured by the designated build seat; no synthetic hash or digest may be invented.
- **Fixed Build Path**: `/build/opencodeplus`. Pinned to ensure any embedded debug symbols or path metadata are invariant across build machines.
- **Locale & Timezone**: Pinned to `LC_ALL=C.UTF-8`, `LANG=C.UTF-8`, and `TZ=UTC`.
- **Runtime & Compiler**: Bun `1.4.2` (linux-x64 and linux-arm64). The raw native Bun compiler executable is pinned and verified against its known SHA-256 before compilation.

## 2. Two-Phase Build Architecture: Online Prep vs. Offline Compilation

Compilation determinism requires eliminating network-induced variations, transient upstream failures, and non-deterministic package resolution:

1. **Phase 1: Online Dependency Preparation**:
   - Downloads Bun runtime and frozen dependencies using `bun install --frozen-lockfile --ignore-scripts`.
   - Downloads and verifies the raw native Bun compiler release binary into `.bun/<release>/...`.
   - Fetches and verifies native bindings (`@opentui/core`, `@opencode-ai/pty`, `@parcel/watcher`).
   - Verifies the integrity of all fetched inputs against recipe digests.

2. **Phase 2: Offline Compilation**:
   - The builder container is invoked with network access disabled (`docker run --network=none`).
   - The pre-populated worktree and caches are mounted into `/build/opencodeplus`.
   - Compilation runs fully offline, executing `packages/cli/script/build.ts` with `--skip-install` and `--skip-web-ui`.

## 3. Determinism Hazards & Mitigations

- **Version Resolution Hazard**: `packages/script` dynamically falls back to `0.0.0-<branch>-<timestamp>` when `OPENCODE_VERSION` is unset. To prevent wall-clock timestamps from entering the binary or manifest, `OPENCODE_VERSION` and `OPENCODE_CHANNEL=plus` **must** be set explicitly before invoking the build.
- **Timestamp Normalization**: `SOURCE_DATE_EPOCH` is derived from the source commit timestamp (`git log -1 --pretty=%ct`) and exported into the environment. All file creation dates and archive member modification times use this epoch.
- **Archive Normalization**: Output archives are generated via `packages/plus/script/release/archive.ts`, ensuring sorted member order, fixed uid/gid 0, normalized permissions (`0755` for `bin/opencodeplus`, `0644` for others), and normalized gzip mtime.
