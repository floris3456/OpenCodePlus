# Upstream Divergence and Core-Touch Inventory

This document tracks the fork divergence and core-touch inventory between OpenCodePlus mainline and upstream OpenCode (`anomalyco/opencode`). It defines the tested baseline, records empirical trial-merge probe results, outlines the forward-merge repair strategy, and documents reproduction using the read-only inventory tool.

---

## 1. Measured Facts Baseline (2026-09-23)

The baseline divergence figures were updated on **2026-09-23** reflecting the round-4 source baseline (`36c75b1db6f499a97a40b531d56aede8f8da9df3`) and host probe measurements of upstream OpenCode (`anomalyco/opencode`):

| Attribute | Measured Value | Provenance / Method |
| :--- | :--- | :--- |
| **Fork Mainline Baseline (Round 4 Base)** | `36c75b1db6f499a97a40b531d56aede8f8da9df3` | Current round-4 integration base and worktree HEAD, measured 2026-09-23 |
| **Common Merge-Base (`origin/v2`)** | `cfa5ba700e11f9dcd5fb591b409c12ed5a861d0e` | Tested upstream ancestry retained for round 4; confirmed common ancestor |
| **Fork Distance Ahead** | **846 commits** ahead on 2026-09-22 baseline (`88a37d01...`); pending re-count for `36c75b1d...` | `git rev-list --count origin/v2..88a37d01...` measured 2026-09-22; re-count for `36c75b1d` pending seat execution |
| **Upstream Probe Reference** | `9c8a63e852722a9bced4a0de1179de58a85dfa20` | Measured commit of `anomalyco/opencode` `refs/heads/v2` on 2026-09-23 via `git ls-remote` |
| **Upstream Distance Ahead** | **420 commits** ahead on 2026-09-22 probe (`ad756ef...`); pending re-count for `9c8a63e8...` | Measured against 2026-09-22 upstream probe commit `ad756ef09bbe5af0dc5ce71e0c1cc37faccc496d` |
| **Trial Merge Conflicts** | **8 conflicting files / 11 conflicting hunks** (measured against `ad756ef...`) | Overnight trial merge probe against 2026-09-22 upstream probe; re-measurement against `9c8a63e8...` pending |
| **Trial Merged Tree Parse Status** | **Did not parse** (measured against `ad756ef...`) | Syntax, TypeScript, and module resolution failure |
| **Behavioural Gates** | **UNRUN** | Tests could not be executed due to parse failure; unrun on merged tree |
| **Core-Touch Status** | Textually clean, but **UNVERIFIED** | Core edits merged without git conflict markers on 2026-09-22 probe, but gate verification remains unrun |
| **Network Reachability** | **Active / Reachable** | Verified functional on 2026-09-23 (github.com reachability and remote probes enabled) |

---

## 2. Separation of Measured Facts vs. Not Yet Measured

In accordance with OpenCodePlus verification standards and the Honest Provenance Rule, claims are strictly divided between what has been empirically verified and what remains unmeasured:

### Measured Facts
- **Retained Ancestry**: The fork retains the tested `cfa5ba700e11f9dcd5fb591b409c12ed5a861d0e` upstream ancestry as its common merge-base with `origin/v2`.
- **Round-4 Fork Baseline**: The current round-4 worktree base and HEAD is `36c75b1db6f499a97a40b531d56aede8f8da9df3` (measured 2026-09-23).
- **Upstream Probe Head**: The live upstream remote `anomalyco/opencode` `refs/heads/v2` resolved to `9c8a63e852722a9bced4a0de1179de58a85dfa20` (measured on 2026-09-23 via `git ls-remote https://github.com/anomalyco/opencode refs/heads/v2`).
- **Network Reachability**: Network operations to github.com are confirmed active and reachable in this environment as of 2026-09-23. The previous claim that network operations are disabled in this environment was accurate for the 2026-09-22 session but is now superseded.
- **Historical Fork Divergence (2026-09-22)**: Fork mainline commit `88a37d011dbaa2210578de77e87517a1e8cc0c91` contained 846 distinct commits not present on `origin/v2`.
- **Historical Upstream Divergence (2026-09-22)**: Upstream `refs/heads/v2` at `ad756ef09bbe5af0dc5ce71e0c1cc37faccc496d` was 420 commits ahead of the common merge-base `cfa5ba700...`.
- **Historical Trial Merge (2026-09-22)**: A trial merge between the fork base and the 2026-09-22 upstream head `ad756ef...` produced 8 conflicting files across 11 hunks.
- **Trial Merged Tree Parse Failure**: The merged tree produced in the 2026-09-22 trial merge failed to parse (TypeScript, syntax, and module resolution failures).

### Not Yet Measured / Pending Verification
- **Current Commit Distances for `36c75b1d` / `9c8a63e8`**: Direct execution of `git rev-list --count cfa5ba700e11f9dcd5fb591b409c12ed5a861d0e..36c75b1db6f499a97a40b531d56aede8f8da9df3` and `git rev-list --count cfa5ba700e11f9dcd5fb591b409c12ed5a861d0e..9c8a63e852722a9bced4a0de1179de58a85dfa20` has not yet been executed in this implementer worktree session (native shell execution disabled by runtime governance). These counts remain pending measurement via `packages/plus/script/upstream-inventory.ts` or git plumbing from a shell-enabled seat.
- **Trial Merge Conflicts against `9c8a63e852722a9bced4a0de1179de58a85dfa20`**: To preserve worktree cleanliness and protect the shared integration base, no trial merge was executed in this worktree against the 2026-09-23 upstream head. Re-measurement of conflicting files and hunks against `9c8a63e8` remains pending read-only measurement (e.g. via `git merge-tree --write-tree`).
- **Semantic conflict repair**: The 8 conflicting files and 11 hunks identified against `ad756ef...` (and any new conflicts against `9c8a63e8...`) have not yet been repaired.
- **Compilation / parsing resolution**: Tree parse errors on the forward merge have not yet been resolved.
- **Behavioural gate results**: The behavioural test gates remain strictly **UNRUN**. **No behavioural test gate has passed** on the upstream-merged code.
- **Core-touch verification**: While the fork's core touches merge textually clean, they remain strictly **UNVERIFIED** until behavioural gate tests can execute and pass.

---

## 3. Integration Strategy: Independently Reviewed Forward Merge Repair

### The Decided Strategy
The project explicitly rejects git rebase and explicitly rejects automatic or nightly mainline merges. Instead, OpenCodePlus adopts an **independently reviewed forward merge repair**:
1. Merging upstream into the fork occurs in an isolated, dedicated task branch and worktree.
2. The conflicting files and hunks are repaired manually and reviewed by independent reviewers.
3. Syntax and compilation errors are resolved until the tree parses and typechecks cleanly.
4. The full suite of behavioural gate tests must run and pass before any merge commit is promoted.

### Why Rebase is Rejected
1. **Provenance Destruction**: Rebasing hundreds of fork commits rewrites fork history, destroys commit author timestamps and cryptographic hashes, and breaks traceability to past design decisions and task runs.
2. **Quadratic Conflict Resolution**: Rebasing replays each commit incrementally against evolving upstream changes, requiring repeated conflict resolutions across hundreds of commits rather than a single unified forward merge resolution.
3. **Worktree Invariants**: OpenCodePlus governance rules (§B and §C) forbid history rewrites, base branch changes, and remote force-pushes. Rebasing would break existing downstream worktrees and task branches.

### Why Automatic / Nightly Mainline Merges are Rejected
1. **Unparseable Merged Tree**: An automated or nightly merge job is entirely pointless while the merged tree does not parse. Running an automated job against known semantic and syntactic breakage generates noise without forward progress.
2. **Silent Breakage Risk**: Automated merges that attempt automatic conflict resolution can introduce subtle logic regressions that bypass basic merge markers while altering program semantics.
3. **Requirement for Verified Behavioural Gates**: Upstream integration cannot be considered complete without passing behavioural gates. Because gate execution requires a parsing tree and deliberate human/developer semantic alignment, automated mainline mergers cannot substitute for reviewed forward repair.

---

## 4. Reproducing the Inventory

The divergence and core-touch inventory is reproducible using the read-only tool `packages/plus/script/upstream-inventory.ts`.

### Invariants
- **Strictly read-only**: The script runs only non-mutating git plumbing queries (`rev-parse`, `merge-base`, `rev-list`, `diff --name-only`). It never performs `fetch`, `merge`, `rebase`, `checkout`, `reset`, or writes into the repository.
- **Explicit parameters**: Base reference, comparison reference, repository directory, and output destination are explicit parameters, allowing execution against any clone.
- **Clear typed errors**: If a requested git reference is missing or invalid, the tool throws a typed `MissingRefError` instead of falling back to default branches.

### CLI Usage

```sh
# Run from repository root comparing origin/v2 against fork HEAD:
bun packages/plus/script/upstream-inventory.ts --base origin/v2 --compare HEAD

# Specify an explicit repository path and output file with the round-4 base:
bun packages/plus/script/upstream-inventory.ts \
  --base origin/v2 \
  --compare 36c75b1db6f499a97a40b531d56aede8f8da9df3 \
  --repo /path/to/opencode \
  --output inventory.json

# Compare upstream probe reference against round-4 fork baseline:
bun packages/plus/script/upstream-inventory.ts \
  --base 9c8a63e852722a9bced4a0de1179de58a85dfa20 \
  --compare 36c75b1db6f499a97a40b531d56aede8f8da9df3 \
  --output inventory-upstream-probe.json

# Positional arguments are also supported:
bun packages/plus/script/upstream-inventory.ts origin/v2 HEAD /path/to/opencode inventory.json
```

### Programmatic API

```ts
import { upstreamInventory } from "./packages/plus/script/upstream-inventory.js"

const report = await upstreamInventory({
  baseRef: "origin/v2",
  compareRef: "36c75b1db6f499a97a40b531d56aede8f8da9df3",
  repoDir: ".",
  outputPath: "inventory.json",
})

console.log(`Merge-base: ${report.mergeBase}`)
console.log(`Ahead: ${report.ahead}, Behind: ${report.behind}`)
console.log(`Core-touch conflict candidates: ${report.coreTouch.length} files`)
```

### Structured Output Schema

The tool outputs structured JSON:

```json
{
  "baseRef": "origin/v2",
  "compareRef": "HEAD",
  "mergeBase": "cfa5ba700e11f9dcd5fb591b409c12ed5a861d0e",
  "ahead": 846,
  "behind": 0,
  "commitCounts": {
    "ahead": 846,
    "behind": 0
  },
  "forkFiles": [
    "packages/plus/script/upstream-inventory.ts",
    "packages/plus/test/release/upstream-inventory.test.ts"
  ],
  "groupedByPackage": {
    "packages/plus": [
      "packages/plus/script/upstream-inventory.ts",
      "packages/plus/test/release/upstream-inventory.test.ts"
    ]
  },
  "coreTouch": [],
  "upstreamFiles": []
}
```

- **`mergeBase`**: Common ancestor commit SHA between the two refs.
- **`ahead` / `behind`**: Commit divergence counts between comparison and base refs.
- **`forkFiles`**: All files modified on the comparison branch since the merge-base.
- **`groupedByPackage`**: Fork-changed files categorized by package directory or repository root.
- **`coreTouch`**: Intersection of files changed by the fork and files changed by upstream since the merge-base; these represent forward-merge conflict candidates.
