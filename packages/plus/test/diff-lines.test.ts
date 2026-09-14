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
