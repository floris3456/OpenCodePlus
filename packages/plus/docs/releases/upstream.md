# Upstream Divergence and Core-Touch Inventory

This document tracks the fork divergence and core-touch inventory between OpenCodePlus mainline and upstream OpenCode (`anomalyco/opencode`). It defines the tested baseline, records empirical trial-merge probe results, outlines the forward-merge repair strategy, and documents reproduction using the read-only inventory tool.

---

## 1. Measured Facts Baseline (2026-09-22)

The baseline divergence figures were recorded on **2026-09-22** via orchestrator repository measurements and an overnight upstream probe:

| Attribute | Measured Value | Provenance / Method |
| :--- | :--- | :--- |
| **Fork Mainline Baseline** | `88a37d011dbaa2210578de77e87517a1e8cc0c91` | Orchestrator measurement of fork mainline ref |
| **Common Merge-Base (`origin/v2`)** | `cfa5ba700e11f9dcd5fb591b409c12ed5a861d0e` | Tested upstream ancestry retained for round 4 |
| **Fork Distance Ahead** | **846 commits** ahead of `origin/v2` | `git rev-list --count origin/v2..88a37d01...` |
| **Upstream Probe Reference** | `ad756ef09bbe5af0dc5ce71e0c1cc37faccc496d` | Measured commit of `anomalyco/opencode` `refs/heads/v2` on 2026-09-22 |
| **Upstream Distance Ahead** | **420 commits** ahead of fork base (`cfa5ba...`) | Recorded in overnight probe (`upstream-probe-2026-09-22.md` on branch `ocp-main8c339ddf41186743`) |
| **Trial Merge Conflicts** | **8 conflicting files / 11 conflicting hunks** | Overnight trial merge probe |
| **Trial Merged Tree Parse Status** | **Did not parse** | Syntax, TypeScript, and module resolution failure |
| **Behavioural Gates** | **UNRUN** | Tests could not be executed due to parse failure |
| **Core-Touch Status** | Textually clean, but **UNVERIFIED** | Core edits merged without git conflict markers, but gate verification never ran |

---

## 2. Separation of Measured Facts vs. Not Yet Measured

In accordance with OpenCodePlus verification standards, claims are strictly divided between what has been empirically verified and what remains unmeasured:

### Measured Facts
- The fork's merge-base against `origin/v2` is `cfa5ba700e11f9dcd5fb591b409c12ed5a861d0e`.
- The fork mainline (`88a37d011dbaa2210578de77e87517a1e8cc0c91`) contains 846 distinct commits not present on `origin/v2`.
- As of the 2026-09-22 overnight probe, upstream `refs/heads/v2` at `ad756ef09bbe5af0dc5ce71e0c1cc37faccc496d` was 420 commits ahead of the common merge-base.
- A trial merge between the fork base and the 2026-09-22 upstream head produces 8 conflicting files across 11 hunks.
- The trial merged tree failed to parse.

### Not Yet Measured / Pending Verification
- **Current live upstream ahead-count**: Not re-measured here. In accordance with task and isolation rules, network operations and remote fetching are disabled in this environment. The live upstream remote `anomalyco/opencode` has not been queried since the 2026-09-22 probe.
- **Semantic conflict repair**: The 8 conflicting files and 11 hunks have not yet been repaired.
- **Compilation / parsing resolution**: Tree parse errors on the forward merge have not yet been resolved.
- **Behavioural gate results**: The behavioural test gates remain **UNRUN**. **No behavioural test gate has passed** on the upstream-merged code.
- **Core-touch verification**: While the fork's core touches merge textually clean, they remain strictly **UNVERIFIED** until behavioural gate tests can execute and pass.

---

## 3. Integration Strategy: Independently Reviewed Forward Merge Repair

### The Decided Strategy
The project adopts an **independently reviewed forward merge repair**:
1. Merging upstream into the fork occurs in an isolated, dedicated task branch and worktree.
2. The 8 conflicting files and 11 hunks are repaired manually and reviewed by independent reviewers.
3. Syntax and compilation errors are resolved until the tree parses and typechecks cleanly.
4. The full suite of behavioural gate tests must run and pass before any merge commit is promoted.

### Why Rebase is Rejected
1. **Provenance Destruction**: Rebasing 846 commits rewrites fork history, destroys commit author timestamps and cryptographic hashes, and breaks traceability to past design decisions and task runs.
2. **Quadratic Conflict Resolution**: Rebasing replays each commit incrementally against evolving upstream changes, requiring repeated conflict resolutions across hundreds of commits rather than a single unified forward merge resolution.
3. **Worktree Invariants**: OpenCodePlus governance rules (§B and §C) forbid history rewrites, base branch changes, and remote force-pushes. Rebasing would break existing downstream worktrees and task branches.

### Why Automatic / Nightly Mainline Merges are Rejected
1. **Unparseable Merged Tree**: A nightly merge job is entirely pointless while the merged tree does not parse. Running an automated job against known semantic and syntactic breakage generates noise without forward progress.
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

# Specify an explicit repository path and output file:
bun packages/plus/script/upstream-inventory.ts \
  --base origin/v2 \
  --compare 88a37d011dbaa2210578de77e87517a1e8cc0c91 \
  --repo /path/to/opencode \
  --output inventory.json

# Positional arguments are also supported:
bun packages/plus/script/upstream-inventory.ts origin/v2 HEAD /path/to/opencode inventory.json
```

### Programmatic API

```ts
import { upstreamInventory } from "./packages/plus/script/upstream-inventory.js"

const report = await upstreamInventory({
  baseRef: "origin/v2",
  compareRef: "88a37d011dbaa2210578de77e87517a1e8cc0c91",
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
