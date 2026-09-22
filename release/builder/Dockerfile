# Canonical Linux Builder for OpenCode Plus
# Contract: release/toolchain.json
# Note: Base image digest is intentionally unmeasured in this repository worktree.
# Per workspace honesty rules, unmeasured external facts must remain null / TODO-measured-by-build-seat
# rather than inventing a synthetic digest.
FROM debian:bookworm-slim@TODO-measured-by-build-seat

# Pinned build environment parameters
ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=UTC
ENV LC_ALL=C.UTF-8
ENV LANG=C.UTF-8

# Fixed compilation path per release/toolchain.json
WORKDIR /build/opencodeplus

# System build dependencies required for compiling Bun and native bindings
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    unzip \
    build-essential \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# Pinned Bun runtime (1.4.2 per release/toolchain.json)
# During online preparation, the raw native Bun executable and assets are verified by SHA-256.
ENV BUN_VERSION=1.4.2
ENV BUN_INSTALL=/usr/local

# Builder must run with --network=none during compilation.
# Pre-fetched dependencies from the online stage must be mounted or copied to /build/opencodeplus.

# Required compilation environment variables for bit-for-bit reproducibility:
# - SOURCE_DATE_EPOCH: Unix timestamp derived from source commit (git log -1 --pretty=%ct)
# - OPENCODE_VERSION: Explicitly pinned version string (prevents wall-clock timestamp fallback)
# - OPENCODE_CHANNEL: Set to "plus"
ENV OPENCODE_CHANNEL=plus
ENV SOURCE_DATE_EPOCH=0

ENTRYPOINT ["/bin/bash"]
