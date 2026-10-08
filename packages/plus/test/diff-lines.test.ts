import { expect, test } from "bun:test"
import { changedLines, unifiedDiff } from "../src/instructions/diff-lines.js"

test("identical texts change nothing and diff empty", () => {
  expect(changedLines("a\nb\n", "a\nb\n")).toBe(0)
  expect(unifiedDiff("a\nb\n", "a\nb\n", { from: "a", to: "b" })).toBe("")
})

test("pure insert counts added lines", () => {
  expect(changedLines("a\n", "a\nb\nc\n")).toBe(2)
  const diff = unifiedDiff("a\n", "a\nb\nc\n", { from: "old", to: "new" })
  expect(diff).toContain("--- old")
  expect(diff).toContain("+++ new")
  expect(diff).toContain("@@")
  expect(diff).toContain(" a")
  expect(diff).toContain("+b")
  expect(diff).toContain("+c")
})

test("pure delete counts removed lines", () => {
  expect(changedLines("a\nb\nc\n", "a\n")).toBe(2)
  const diff = unifiedDiff("a\nb\nc\n", "a\n", { from: "old", to: "new" })
  expect(diff).toContain("-b")
  expect(diff).toContain("-c")
  expect(diff).not.toContain("+b")
})

test("mixed edit counts deletions plus insertions", () => {
  expect(changedLines("line1\nline2\n", "line1\nlineX\n")).toBe(2)
  const diff = unifiedDiff("line1\nline2\n", "line1\nlineX\n", { from: "old", to: "new" })
  expect(diff).toContain(" line1")
  expect(diff).toContain("-line2")
  expect(diff).toContain("+lineX")
})

test("trailing newline alone changes nothing", () => {
  expect(changedLines("a", "a\n")).toBe(0)
  expect(changedLines("", "")).toBe(0)
  expect(unifiedDiff("a", "a\n", { from: "old", to: "new" })).toBe("")
})

test("blank lines survive as content", () => {
  expect(changedLines("a\n", "a\n\n")).toBe(1)
  expect(changedLines("a\n\n", "a\n")).toBe(1)
})

/** 120 numbered lines changed at opposite ends: lines 11 and 100. */
function twoDistantChanges(): { original: string; modified: string } {
  const lines = Array.from({ length: 120 }, (_, index) => `line${String(index + 1).padStart(3, "0")}`)
  const modified = lines.map((text, index) => (index === 10 || index === 99 ? `changed ${text}` : text))
  return { original: lines.join("\n") + "\n", modified: modified.join("\n") + "\n" }
}

test("distant changes keep the compact default context", () => {
  const { original, modified } = twoDistantChanges()
  const diff = unifiedDiff(original, modified, { from: "a", to: "b" })
  expect(diff.split("\n").filter((line) => line.startsWith("@@"))).toHaveLength(2)
  expect(diff).not.toContain("line050")
  expect(unifiedDiff(original, modified, { from: "a", to: "b" }, { context: 3 })).toBe(diff)
})

test("complete context keeps every line of both sides in one hunk", () => {
  const { original, modified } = twoDistantChanges()
  const diff = unifiedDiff(original, modified, { from: "a", to: "b" }, { context: Number.POSITIVE_INFINITY })
  expect(diff.split("\n").filter((line) => line.startsWith("@@"))).toHaveLength(1)
  expect(diff).toContain("@@ -1,120 +1,120 @@")
  expect(diff).toContain(" line050")
  expect(diff).toContain("-line011")
  expect(diff).toContain("+changed line011")
  expect(diff).toContain("-line100")
  expect(diff).toContain("+changed line100")
  const missing = [...original.split("\n"), ...modified.split("\n")].filter((line) => line !== "" && !diff.includes(line))
  expect(missing).toEqual([])
})

test("complete context has exact counts for empty-to-text and text-to-empty", () => {
  expect(unifiedDiff("", "a\nb\n", { from: "a", to: "b" }, { context: Number.POSITIVE_INFINITY })).toBe("--- a\n+++ b\n@@ -0,0 +1,2 @@\n+a\n+b\n")
  expect(unifiedDiff("a\nb\n", "", { from: "a", to: "b" }, { context: Number.POSITIVE_INFINITY })).toBe("--- a\n+++ b\n@@ -1,2 +0,0 @@\n-a\n-b\n")
})

test("complete context keeps insertions at the start and at the end", () => {
  expect(unifiedDiff("b\n", "a\nb\n", { from: "a", to: "b" }, { context: Number.POSITIVE_INFINITY })).toBe("--- a\n+++ b\n@@ -1,1 +1,2 @@\n+a\n b\n")
  expect(unifiedDiff("a\n", "a\nb\n", { from: "a", to: "b" }, { context: Number.POSITIVE_INFINITY })).toBe("--- a\n+++ b\n@@ -1,1 +1,2 @@\n a\n+b\n")
})

test("complete context ignores a missing final newline", () => {
  const expected = "--- a\n+++ b\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n"
  expect(unifiedDiff("a\nb", "a\nc", { from: "a", to: "b" }, { context: Number.POSITIVE_INFINITY })).toBe(expected)
  expect(unifiedDiff("a\nb\n", "a\nc\n", { from: "a", to: "b" }, { context: Number.POSITIVE_INFINITY })).toBe(expected)
})

test("complete context keeps patch-like content lines as content", () => {
  const original = "@@ -1 +1 @@\n--- old\n+++ new\n=======\n"
  const modified = "@@ -1 +1 @@\n--- older\n+++ newer\n=======\n"
  const diff = unifiedDiff(original, modified, { from: "x", to: "y" }, { context: Number.POSITIVE_INFINITY })
  expect(diff).toBe("--- x\n+++ y\n@@ -1,4 +1,4 @@\n @@ -1 +1 @@\n---- old\n-+++ new\n+--- older\n++++ newer\n =======\n")
})
