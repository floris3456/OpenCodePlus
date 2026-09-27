import { expect, test } from "bun:test"
import { changedLines, merge3, unifiedDiff } from "../src/instructions/diff-lines.js"

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

test("merge3 applies an upstream change to an untouched region of yours", () => {
  const original = "one\ntwo\nthree\nfour\nfive\n"
  const mine = "one\nTWO mine\nthree\nfour\nfive\n"
  const upstream = "one\ntwo\nthree\nfour\nFIVE upstream\n"
  expect(merge3(original, mine, upstream)).toEqual({ text: "one\nTWO mine\nthree\nfour\nFIVE upstream\n", conflicts: 0 })
})

test("merge3 takes an identical change from both sides once", () => {
  const merged = merge3("a\nb\nc\n", "a\nB\nc\n", "a\nB\nc\n")
  expect(merged).toEqual({ text: "a\nB\nc\n", conflicts: 0 })
})

test("merge3 fences a region both sides changed differently", () => {
  const merged = merge3("a\nb\nc\n", "a\nmine\nc\n", "a\ntheirs\nc\n")
  expect(merged.conflicts).toBe(1)
  expect(merged.text).toBe("a\n<<<<<<< yours\nmine\n=======\ntheirs\n>>>>>>> upstream\nc\n")
})

test("merge3 keeps insertions from both sides at different places", () => {
  const merged = merge3("a\nb\nc\nd\ne\n", "top\na\nb\nc\nd\ne\n", "a\nb\nc\nd\ne\nbottom\n")
  expect(merged).toEqual({ text: "top\na\nb\nc\nd\ne\nbottom\n", conflicts: 0 })
})

test("merge3 with no upstream change returns yours", () => {
  expect(merge3("a\nb\n", "a\nx\n", "a\nb\n")).toEqual({ text: "a\nx\n", conflicts: 0 })
})

test("merge3 merges changes to neighbouring lines without a conflict", () => {
  expect(merge3("alpha\nbeta\n", "alpha\nBETA mine\n", "ALPHA upstream\nbeta\n")).toEqual({ text: "ALPHA upstream\nBETA mine\n", conflicts: 0 })
})

test("merge3 fences insertions both sides made at the same place", () => {
  const merged = merge3("a\nb\n", "a\nmine\nb\n", "a\ntheirs\nb\n")
  expect(merged.conflicts).toBe(1)
  expect(merged.text).toBe("a\n<<<<<<< yours\nmine\n=======\ntheirs\n>>>>>>> upstream\nb\n")
})
