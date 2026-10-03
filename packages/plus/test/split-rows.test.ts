// git merge and git worktree add moved out of their shell families ("Git
// working-tree changes", "Git branches, tags and worktrees") into rows of
// their own. A family switched off before the split refused them too, so the
// load-time migration carries the family's stored state onto the split-off row.
import { expect, test } from "bun:test"
import { fingerprint } from "../src/instructions/model.js"
import { catalogFor } from "../src/instructions/permission-catalog.js"
import { migrateSplitRows, type CustomizationRecord, type StoredRecord } from "../src/instructions/store.js"

const UPDATED = "2026-10-01T00:00:00.000Z"

const changesBefore = fingerprint(
  ["Git working-tree changes", "git add *", "git stash", "git stash *", "git clean *", "git restore *", "git switch *", "git merge *", "git cherry-pick *", "git revert *", "git rm *", "git mv *", "git apply *", "git am *", "git pull", "git pull *"].join("\n"),
)
const refsBefore = fingerprint(
  ["Git branches, tags and worktrees", "git branch -d *", "git branch -D *", "git branch -m *", "git branch -M *", "git branch -f *", "git tag *", "git update-ref *", "git worktree add *", "git worktree remove *", "git worktree prune *", "git worktree move *"].join("\n"),
)

function currentText(row: string): string {
  const entry = catalogFor("shell").find((category) => category.id === "commands")?.rows.find((candidate) => candidate.id === row)
  if (entry === undefined) throw new Error(`no row ${row}`)
  return fingerprint([entry.label, ...(entry.patterns ?? [])].join("\n"))
}

function customization(overrides: Partial<CustomizationRecord>): CustomizationRecord {
  return { type: "customization", level: "global", agent: "alpha", item: "perm:shell:commands.git-changes", section: null, state: "off", basedOn: changesBefore, basedOnState: "on", updated: UPDATED, ...overrides }
}

test("the split rows exist and the families no longer hold their commands", () => {
  const rows = catalogFor("shell").find((category) => category.id === "commands")?.rows ?? []
  const patterns = (id: string) => rows.find((row) => row.id === id)?.patterns ?? []
  expect(patterns("git-merge")).toEqual(["git merge *"])
  expect(patterns("git-worktree-add")).toEqual(["git worktree add *"])
  expect(patterns("git-changes")).not.toContain("git merge *")
  expect(patterns("git-refs")).not.toContain("git worktree add *")
})

test("a family's pre-split state carries onto its split-off row at the same address, and the family is re-based", () => {
  const records: StoredRecord[] = [
    customization({}),
    customization({ level: "preset", agent: "planner", team: { level: "preset", team: "basic" }, item: "perm:shell:commands.git-refs", state: "on", basedOn: refsBefore }),
  ]
  const migrated = migrateSplitRows(records)
  expect(migrated.migrated).toBe(true)
  expect(migrated.records).toEqual([
    customization({ basedOn: currentText("git-changes") }),
    customization({ item: "perm:shell:commands.git-merge", basedOn: currentText("git-merge") }),
    customization({ level: "preset", agent: "planner", team: { level: "preset", team: "basic" }, item: "perm:shell:commands.git-refs", state: "on", basedOn: currentText("git-refs") }),
    customization({ level: "preset", agent: "planner", team: { level: "preset", team: "basic" }, item: "perm:shell:commands.git-worktree-add", state: "on", basedOn: currentText("git-worktree-add") }),
  ])
  // Idempotent: the re-based family no longer names the pre-split text.
  expect(migrateSplitRows(migrated.records)).toEqual({ records: migrated.records, migrated: false })
})

test("a split-off row already stored at the address keeps its own state", () => {
  const own = customization({ item: "perm:shell:commands.git-merge", state: "on", basedOn: currentText("git-merge") })
  const migrated = migrateSplitRows([customization({}), own])
  expect(migrated.records).toEqual([customization({ basedOn: currentText("git-changes") }), own])
})

test("a record based on the current text, a customized text and other rows are left alone", () => {
  const records: StoredRecord[] = [
    customization({ basedOn: currentText("git-changes") }),
    customization({ state: undefined, text: "Git working-tree changes\ngit add *", basedOn: changesBefore }),
    customization({ item: "perm:shell:git-push" }),
  ]
  expect(migrateSplitRows(records)).toEqual({ records, migrated: false })
})
