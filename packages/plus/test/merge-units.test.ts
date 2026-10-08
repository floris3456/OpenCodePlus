import { expect, test } from "bun:test"
import { defaultInclude, mergeUnits, renderMerge, segmentUnits, type MergeEntry } from "../src/instructions/merge-units.js"

function changes(entries: readonly MergeEntry[]): Extract<MergeEntry, { type: "change" }>[] {
  return entries.filter((entry) => entry.type === "change")
}

test("headings, lists, tables, fences and blank runs segment as their own units", () => {
  const text = "# Title\n\n- item one\n  continuation\n- item two\n\n| a | b |\n| c | d |\n\n```js\nconst x = 1;\n```\n"
  expect(segmentUnits(text)).toEqual([
    "# Title\n",
    "\n",
    "- item one\n  continuation\n",
    "- item two\n",
    "\n",
    "| a | b |\n",
    "| c | d |\n",
    "\n",
    "```js\nconst x = 1;\n```\n",
  ])
})

test("prose splits into sentences keeping whitespace with the preceding sentence", () => {
  expect(segmentUnits("First here. Second here! Third here?\n")).toEqual(["First here. ", "Second here! ", "Third here?\n"])
  expect(segmentUnits("One.\nTwo words here.\n")).toEqual(["One.\n", "Two words here.\n"])
})

test("abbreviations stay one sentence when a lowercase letter follows", () => {
  expect(segmentUnits("Use e.g. this style here.\n")).toEqual(["Use e.g. this style here.\n"])
  expect(segmentUnits("First e.g. apples. Second sentence.\n")).toEqual(["First e.g. apples. ", "Second sentence.\n"])
})

test("round trip holds: units joined equal the input", () => {
  const inputs = [
    "",
    "one line, no newline",
    "one line with newline\n",
    "\n\n\n",
    "# H\n\nPara one. Para two!\n\n- a\n  cont\n- b\n\n| x |\n\n```\ncode.\nmore\n```\nTail? Yes. e.g. this stays.\n",
    "No trailing newline paragraph. Last one here.",
  ]
  for (const input of inputs) expect(segmentUnits(input).join("")).toBe(input)
})

test("one-sided changes get yours and upstream kinds", () => {
  const entries = mergeUnits("a\nb\nc\n", "a\nB mine\nc\n", "a\nb\nc\n")
  expect(changes(entries).map((entry) => entry.kind)).toEqual(["yours"])
  const upstreamOnly = mergeUnits("a\nb\nc\n", "a\nb\nc\n", "a\nb\nC upstream\n")
  expect(changes(upstreamOnly).map((entry) => entry.kind)).toEqual(["upstream"])
})

test("identical changes from both sides collapse into one same entry", () => {
  const entries = mergeUnits("a\nb\nc\n", "a\nB\nc\n", "a\nB\nc\n")
  const found = changes(entries)
  expect(found).toHaveLength(1)
  expect(found[0]?.kind).toBe("same")
  expect(found[0]?.included).toBe(true)
  expect(renderMerge(entries, defaultInclude(entries))).toBe("a\nB\nc\n")
})

test("different changes to the same span give a both entry defaulting to yours", () => {
  const entries = mergeUnits("a\nb\nc\n", "a\nmine\nc\n", "a\ntheirs\nc\n")
  const found = changes(entries)
  expect(found).toHaveLength(1)
  expect(found[0]?.kind).toBe("both")
  expect(renderMerge(entries, defaultInclude(entries))).toBe("a\nmine\nc\n")
})

test("defaults include yours, upstream and same changes", () => {
  const base = "One here. Two here. Three here. Four here.\n"
  const yours = "One here. TWO mine. Three here. Four here.\n"
  const upstream = "One here. Two here. Three here. FOUR upstream.\n"
  const entries = mergeUnits(base, yours, upstream)
  expect(changes(entries).map((entry) => entry.kind)).toEqual(["yours", "upstream"])
  expect(renderMerge(entries, defaultInclude(entries))).toBe("One here. TWO mine. Three here. FOUR upstream.\n")
})

test("excluding a yours change restores the base text", () => {
  const entries = mergeUnits("a\nb\nc\n", "a\nB mine\nc\n", "a\nb\nc\n")
  expect(renderMerge(entries, new Set())).toBe("a\nb\nc\n")
})

test("excluding an upstream change keeps the base text", () => {
  const entries = mergeUnits("a\nb\nc\n", "a\nb\nc\n", "a\nb\nC upstream\n")
  expect(renderMerge(entries, new Set())).toBe("a\nb\nc\n")
  expect(renderMerge(entries, defaultInclude(entries))).toBe("a\nb\nC upstream\n")
})

test("a both entry with both sides included renders yours then upstream", () => {
  const entries = mergeUnits("# T\nb\n# U\n", "# T\nmine\n# U\n", "# T\ntheirs\n# U\n")
  const both = changes(entries)[0]
  if (both === undefined || both.upstreamId === undefined) throw new Error("missing both entry")
  expect(renderMerge(entries, new Set([both.id, both.upstreamId]))).toBe("# T\nmine\ntheirs\n# U\n")
  expect(renderMerge(entries, new Set([both.upstreamId]))).toBe("# T\ntheirs\n# U\n")
  expect(renderMerge(entries, new Set())).toBe("# T\nb\n# U\n")
})

test("default renders never contain conflict markers", () => {
  const cases: [string, string, string][] = [
    ["a\nb\nc\n", "a\nmine\nc\n", "a\ntheirs\nc\n"],
    ["First here. Second here.\n", "First MINE. Second here.\n", "First here. Second UPSTREAM.\n"],
    ["# T\n\nbody text here\n", "# T\n\nbody MINE here\n", "# T\n\nbody UPSTREAM here\n"],
    ["a\n", "a\nmine tail\n", "theirs head\na\n"],
  ]
  for (const [base, yours, upstream] of cases) {
    const text = renderMerge(mergeUnits(base, yours, upstream), defaultInclude(mergeUnits(base, yours, upstream)))
    expect(text).not.toContain("<<<<<<<")
    expect(text).not.toContain("=======")
    expect(text).not.toContain(">>>>>>>")
  }
})

test("two edits in one paragraph by each side no longer conflict", () => {
  const base = "First sentence here. Second sentence here.\n"
  const yours = "First sentence MINE. Second sentence here.\n"
  const upstream = "First sentence here. Second sentence UPSTREAM.\n"
  const entries = mergeUnits(base, yours, upstream)
  expect(changes(entries).map((entry) => entry.kind)).toEqual(["yours", "upstream"])
  expect(renderMerge(entries, defaultInclude(entries))).toBe("First sentence MINE. Second sentence UPSTREAM.\n")
})

test("both sides included on a final unit without a newline keeps upstream on its own line", () => {
  const entries = mergeUnits("One.\nTwo.", "One.\nTwo mine.", "One.\nTwo up.")
  const both = entries.find((entry) => entry.type === "change" && entry.kind === "both")
  if (both?.type !== "change" || both.upstreamId === undefined) throw new Error("expected a both entry")
  expect(renderMerge(entries, new Set([both.id, both.upstreamId]))).toBe("One.\nTwo mine.\nTwo up.")
  expect(renderMerge(entries, new Set([both.id]))).toBe("One.\nTwo mine.")
})
