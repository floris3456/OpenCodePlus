# Upstream Divergence and Core-Touch Inventory

This document tracks the fork divergence and core-touch inventory between OpenCodePlus mainline and upstream OpenCode (`anomalyco/opencode`). It records the current merge base, outlines the forward-merge repair strategy, and documents reproduction using the read-only inventory tool.

---

## 1. Current State (2026-10-19)

- **Upstream line:** OpenCode V2 lives on `anomalyco/opencode` `dev` (the `upstream` remote in `repos/opencode`). Upstream promoted V2 to `dev` on 2026-10-10 (`5caf1f9f6f`); `v2` stays frozen at `4617210822`.
- **Last forward merge:** `dd6f4cf26d` merged `dev` at `501b15af26` (OpenCode 2.0.32, 2026-10-18) into the Plus line. It is the merge base for the next merge. 64 files conflicted; the merge commit message lists the resolution rules.
- **Earlier merges:** `bec528b637` (upstream `v2`, 2026-10-11) and `9c29e5f282` (upstream `v2`, 2026-09-28).
- **Gates for a merge:** root `bun run check`, then the full release suite (`packages/plus/script/release/suite.ts --baseline <previous suite.json>`); every failure it marks NEW is explained or fixed before the merge is released.

The round-4 measurements this section replaced (2026-09-22/23: a trial merge that did not parse and never ran its gates) are in this file's Git history.

---

## 2. Integration Strategy: Independently Reviewed Forward Merge Repair

### The Decided Strategy
The project explicitly rejects git rebase and explicitly rejects automatic or nightly mainline merges. Instead, OpenCodePlus adopts an **independently reviewed forward merge repair**:
1. Merging upstream into the fork occurs in an isolated, dedicated task branch and worktree.
2. The conflicting files and hunks are repaired manually and reviewed by independent reviewers.
3. Syntax and compilation errors are resolved until the tree parses and typechecks cleanly.
4. The full release suite runs on the merged tree; every failure it marks NEW is explained or fixed before the merge is promoted.

### Why Rebase is Rejected
1. **Provenance Destruction**: Rebasing hundreds of fork commits rewrites fork history, destroys commit author timestamps and cryptographic hashes, and breaks traceability to past design decisions and task runs.
2. **Quadratic Conflict Resolution**: Rebasing replays each commit incrementally against evolving upstream changes, requiring repeated conflict resolutions across hundreds of commits rather than a single unified forward merge resolution.
3. **Worktree Invariants**: OpenCodePlus governance rules (§B and §C) forbid history rewrites, base branch changes, and remote force-pushes. Rebasing would break existing downstream worktrees and task branches.

### Why Automatic / Nightly Mainline Merges are Rejected
1. **Decisions, not text**: Each merge decides which side's behaviour wins where both changed the same thing (for example the watcher policy or a retry path). A job cannot make those decisions; the merge commit records them.
2. **Silent Breakage Risk**: Automated merges that attempt automatic conflict resolution can introduce subtle logic regressions that bypass basic merge markers while altering program semantics.
3. **Requirement for Verified Behavioural Gates**: Upstream integration cannot be considered complete without passing behavioural gates. Because gate execution requires a parsing tree and deliberate human/developer semantic alignment, automated mainline mergers cannot substitute for reviewed forward repair.

---

## 3. Reproducing the Inventory

The divergence and core-touch inventory is reproducible using the read-only tool `packages/plus/script/upstream-inventory.ts`.

### Invariants
- **Strictly read-only**: The script runs only non-mutating git plumbing queries (`rev-parse`, `merge-base`, `rev-list`, `diff --name-only`). It never performs `fetch`, `merge`, `rebase`, `checkout`, `reset`, or writes into the repository.
- **Explicit parameters**: Base reference, comparison reference, repository directory, and output destination are explicit parameters, allowing execution against any clone.
- **Clear typed errors**: If a requested git reference is missing or invalid, the tool throws a typed `MissingRefError` instead of falling back to default branches.

### CLI Usage

```sh
# Run from repository root, comparing upstream dev against the fork HEAD:
bun packages/plus/script/upstream-inventory.ts --base upstream/dev --compare HEAD

# Specify an explicit repository path and output file:
bun packages/plus/script/upstream-inventory.ts \
  --base upstream/dev \
  --compare v2-plus-1 \
  --repo /path/to/opencode \
  --output inventory.json

# Positional arguments are also supported:
bun packages/plus/script/upstream-inventory.ts upstream/dev HEAD /path/to/opencode inventory.json
```

### Programmatic API

```ts
import { upstreamInventory } from "./packages/plus/script/upstream-inventory.js"

const report = await upstreamInventory({
  baseRef: "upstream/dev",
  compareRef: "HEAD",
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
  "baseRef": "upstream/dev",
  "compareRef": "HEAD",
  "mergeBase": "501b15af26915ba52682e20e220e7e137e89e92f",
  "ahead": 2082,
  "behind": 0,
  "commitCounts": {
    "ahead": 2082,
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
