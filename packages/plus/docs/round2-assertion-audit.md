# Instructions Round 2 — Assertion Preservation Audit

Captured at commit `d8aaf0de67c2678d985073a17c40fe219b867afd` across the series `5374d3f4..d8aaf0de`.

This document records the assertion-preservation audit verifying plan R7 of the Round 2 series. An independent reviewer without shell or Git execution can verify from this record that no test assertion was removed or weakened across the changes spanning `5374d3f4..d8aaf0de`.

---

## 1. Scope of the Series

The series `5374d3f4..d8aaf0de` modifies only `packages/plus`. Changes outside `packages/plus` are strictly empty:

- `git diff --stat 5374d3f4..d8aaf0de -- . ':(exclude)packages/plus'` produces empty output.
- `git diff --stat 5374d3f4..d8aaf0de -- packages/plus` shows 20 files changed, with 2038 insertions and 104 deletions.

Test files modified across the series:
- `packages/plus/test/discover.test.ts`
- `packages/plus/test/ops.test.ts`
- `packages/plus/test/route.test.tsx`
- `packages/plus/test/rpc-contract.test.ts`
- `packages/plus/test/rpc.test.ts`
- `packages/plus/test/teams-rpc.test.ts`
- `packages/plus/test/tools.test.ts`
- `packages/plus/test/tree.test.ts`

---

## 2. Line-by-Line Audit of Removed Test Lines

Across all modified test files in `packages/plus/test`, exactly 9 removed lines exist in `git diff 5374d3f4..d8aaf0de -- packages/plus/test` (excluding diff file header lines beginning with `---`).

Categorized by nature of change:
- **6 assertion and fixture lines** (each replaced by an equal or strictly stronger check)
- **1 test name** (renamed to reflect expanded behavior)
- **1 comment line** (updated to reflect template-driven creation)
- **1 import statement** (widened to bring in test fixtures)

Total: 9 lines removed.

### Line 1: `test/tree.test.ts` — Member row action flags
- **Test:** `"member rows are informational: no address, no actions, depth 3"`
- **Removed line:**
  ```ts
  -    expect(member?.actions).toEqual({ toggle: false, edit: false, reset: false, remove: false, split: false, pin: false })
  ```
- **Replacing line:**
  ```ts
  +    expect(member?.actions).toEqual({ toggle: false, edit: false, reset: false, remove: true, split: false, pin: false })
  ```
- **Preservation Analysis:** Required by R4, where team member rows became deletable. The assertion remains an exhaustive `toEqual` covering all six action flags (`toggle`, `edit`, `reset`, `remove`, `split`, `pin`). No coverage is lost; the expected state was updated to reflect specified deletion capabilities.

### Line 2: `test/tree.test.ts` — Test rename for member add affordance
- **Test:** Rename of `"team rows carry add agent while member rows carry no add"`
- **Removed line:**
  ```ts
  -test("team rows carry add agent while member rows carry no add", () => {
  ```
- **Replacing line:**
  ```ts
  +test("team rows and member rows carry add agent", () => {
  ```
- **Preservation Analysis:** Test title updated to match the new behavior specified by R2 (member rows now offer the add-agent affordance).

### Line 3: `test/tree.test.ts` — Member row add affordance assertion
- **Test:** `"team rows and member rows carry add agent"`
- **Removed line:**
  ```ts
  -  expect(nodes.find((node) => node.id === "team:project:crew:alpha")?.add).toBeUndefined()
  ```
- **Replacing line:**
  ```ts
  +  expect(nodes.find((node) => node.id === "team:project:crew:alpha")?.add).toBe("agent")
  ```
- **Preservation Analysis:** Required by R2. The assertion remains an exact equality check on `node.add`. The expected value changed from `undefined` to `"agent"` per the R2 specification.

### Line 4: `test/tree.test.ts` — Member subtree actions and add affordance
- **Test:** `"team member rows expand to full agent subtrees with team-prefixed groups"`
- **Removed line:**
  ```ts
  -  expect(member?.actions).toEqual({ toggle: false, edit: false, reset: false, remove: false, split: false, pin: false })
  ```
- **Replacing lines:**
  ```ts
  +  expect(member?.add).toBe("agent")
  +  expect(member?.actions).toEqual({ toggle: false, edit: false, reset: false, remove: true, split: false, pin: false })
  ```
- **Preservation Analysis:** Same `remove: false` -> `remove: true` change required by R4 on the exhaustive action flags map. In addition, an explicit `expect(member?.add).toBe("agent")` assertion was added. Strictly stronger.

### Line 5: `test/tree.test.ts` — Defaults team fixture and overlay member assertions
- **Test:** `"Defaults lists built-in team rows with toggles and member rows"`
- **Removed line:**
  ```ts
  -      { level: "defaults", team: "ship", enabled: true, agents: ["mate", "nested/solo"] },
  ```
- **Replacing lines:**
  ```ts
  +      { level: "defaults", team: "ship", enabled: true, agents: ["mate", "nested/solo", "ovl"], overlay: ["ovl"] },
  ```
- **Preservation Analysis:** The Defaults team test fixture was extended to include an overlay agent member (`"ovl"`). The children equality expectation gained `"team:defaults:ship:ovl"`. The existing loop continues to assert `remove: false` for the shipped members `"mate"` and `"nested/solo"`, and a new assertion was added requiring `remove: true` for the overlay member (`ovlMember?.actions`). This provides strictly more coverage (verifying A3/R4 overlay identity).

### Line 6: `test/tree.test.ts` — Group add affordances map check
- **Test:** `"add affordances land on exactly the listed groups"`
- **Removed line:**
  ```ts
  -  expect(adds.get("team:project:crew:alpha")).toBeUndefined()
  ```
- **Replacing line:**
  ```ts
  +  expect(adds.get("team:project:crew:alpha")).toBe("agent")
  ```
- **Preservation Analysis:** Follows the R2 change where member rows provide the add-agent affordance. Every other entry in the exhaustive group-and-row `adds` map check remains untouched.

### Line 7: `test/route.test.tsx` — Dialog sequence in team creation
- **Test:** `"a on the Teams group creates through the real team.create and the rebuilt tree shows the disabled row"`
- **Removed line:**
  ```ts
  -    dialogs: { prompts: ["fresh"], selects: ["", "project"] },
  ```
- **Replacing line:**
  ```ts
  +    dialogs: { prompts: ["fresh"], selects: [""] },
  ```
- **Preservation Analysis:** Required by R1. Creating a team under a specific Teams group infers scope directly from the cursor position rather than prompting for a redundant scope selection. Two new assertions were added in the test:
  1. `expect(fixture.fake.dialogSelects.map(([title]) => title)).toEqual(["Team template"])` verifying exactly one template select was presented.
  2. `expect(fixture.captureCharFrame()).not.toContain("Team scope")` verifying no scope dialog was rendered.
  The new assertions are strictly stronger than the removed second select entry; the previous test could not have caught an unexpected scope prompt.

### Line 8: `test/route.test.tsx` — Test comment
- **Test:** `"a on the Teams group creates through the real team.create and the rebuilt tree shows the disabled row"`
- **Removed line:**
  ```ts
  -    // prompts for a name then a project/global scope.
  ```
- **Replacing line:**
  ```ts
  +    // prompts for a template then a name, taking project scope from the cursor.
  ```
- **Preservation Analysis:** Comment update documenting the new template flow and cursor-derived scope behavior. Not an assertion.

### Line 9: `test/teams-rpc.test.ts` — Harness imports
- **File:** `test/teams-rpc.test.ts`
- **Removed line:**
  ```ts
  -import { fullContext } from "./harness.js"
  ```
- **Replacing line:**
  ```ts
  +import { agentInfo, fullContext, modelInfo } from "./harness.js"
  ```
- **Preservation Analysis:** Widened import to bring in `agentInfo` and `modelInfo` helpers for new R5 model candidate tests. Not an assertion.

---

## 3. Conclusion and Test Counts

The audit establishes:
1. **No test assertion was removed without an equal or stronger replacement.**
2. **No `toEqual` was relaxed to a partial match or weaker assertion.**
3. **No test case was deleted or disabled.**
4. **Test counts increased across the series:**
   - In `discover` + `apply`, test count increased from 143 to 145 in round B alone.
   - All five assigned focused checks report passing with 0 failures at commit `d8aaf0de67c2678d985073a17c40fe219b867afd`:
     - `plus-tree-route`: **114 pass**, 0 fail across 3 files (896 `expect()` calls)
     - `plus-teams`: **63 pass**, 0 fail across 4 files (620 `expect()` calls)
     - `plus-discover-apply`: **145 pass**, 0 fail across 4 files (1336 `expect()` calls)
     - `plus-query-tools-ops`: **132 pass**, 0 fail across 3 files (2116 `expect()` calls)
     - `plus-typecheck`: **0 errors** (`tsgo --noEmit -p tsconfig.test.json`)
   - Total test suite count across focused checks: **454 tests passing, 0 failures, 4968 expect() calls**.

---

## 4. How to Re-derive

A reviewer or developer with shell and Git access can independently reproduce this audit using the following four commands:

```sh
# 1. Verify that the series touches only packages/plus (output must be empty):
git diff --stat 5374d3f4..d8aaf0de -- . ':(exclude)packages/plus'

# 2. View file statistics for packages/plus (20 files, 2038 insertions, 104 deletions):
git diff --stat 5374d3f4..d8aaf0de -- packages/plus

# 3. Inspect full context around all test diffs:
git diff -U6 5374d3f4..d8aaf0de -- packages/plus/test

# 4. List all removed lines across test files (excluding --- diff headers):
git diff 5374d3f4..d8aaf0de -- packages/plus/test | grep -E '^-' | grep -vE '^---'
```
