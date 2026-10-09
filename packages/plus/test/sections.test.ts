import { expect, test } from "bun:test"
import { assemble, assembleWithOverrides, assembleWithSpans, derive, manual, ownBody, slice, wrappingSection } from "../src/instructions/sections.js"

const GPT = [
  "# Harness",
  "",
  "You are the harness.",
  "",
  "# Communication",
  "",
  "Talk well.",
  "",
  "## Intermediate Commentary",
  "",
  "Narrate progress.",
  "",
  "## Final Answer",
  "",
  "Answer crisply.",
  "",
  "# Working in codebases",
  "",
  "Read before editing.",
  "",
  "# Delegation",
  "",
  "Delegate wisely.",
  "",
  "# Destructive actions",
  "",
  "Ask first.",
  "",
  "# Autonomy",
  "",
  "Act with judgment.",
  "",
].join("\n")

test("derive splits nested headings with slug paths", () => {
  const split = derive(GPT, "General")
  expect(split.kind).toBe("heading")
  const ids = split.sections.map((section) => section.id)
  expect(ids).toEqual([
    "harness",
    "communication",
    "communication/intermediate-commentary",
    "communication/final-answer",
    "working-in-codebases",
    "delegation",
    "destructive-actions",
    "autonomy",
  ])
  const nested = split.sections.find((section) => section.id === "communication/intermediate-commentary")
  expect(nested?.depth).toBe(1)
  expect(nested?.name).toBe("Intermediate Commentary")
  const section = split.sections.find((entry) => entry.id === "communication")
  expect(section !== undefined && slice(GPT, section)).toContain("## Intermediate Commentary")
})

test("derive treats a parent range as running to the next same-or-shallower heading", () => {
  const split = derive(GPT, "General")
  const communication = split.sections.find((section) => section.id === "communication")
  const codebases = split.sections.find((section) => section.id === "working-in-codebases")
  if (codebases === undefined) throw new Error("expected working-in-codebases section")
  expect(communication !== undefined && communication.end).toBe(codebases.start)
})

test("derive adds a Preamble for text before the first heading", () => {
  const split = derive(`Intro line.\n\n# Harness\n\nBody.\n`, "General")
  expect(split.sections[0].id).toBe("preamble")
  expect(split.sections[0].depth).toBe(0)
  expect(slice(`Intro line.\n\n# Harness\n\nBody.\n`, split.sections[0])).toBe("Intro line.\n\n")
})

test("derive prefers headings over xml blocks", () => {
  const text = `# Title\n\n<system_reminder>note</system_reminder>\n`
  expect(derive(text, "T").kind).toBe("heading")
})

test("derive splits xml blocks at line start", () => {
  const text = [
    "<system_reminder>",
    "first",
    "</system_reminder>",
    "<system_reminder>",
    "second",
    "</system_reminder>",
    "",
  ].join("\n")
  const split = derive(text, "Reminders")
  expect(split.kind).toBe("block")
  expect(split.sections.map((section) => section.id)).toEqual(["system_reminder", "system_reminder-2"])
  expect(split.sections.every((section) => section.depth === 0)).toBe(true)
})

test("derive routes stray text into the preceding block, else Preamble", () => {
  const trailing = "<a>\nx\n</a>\ntail\n"
  const split = derive(trailing, "T")
  expect(split.sections).toHaveLength(1)
  expect(slice(trailing, split.sections[0])).toBe(trailing)
  const leading = "hello\n<a>\nx\n</a>\n"
  const lead = derive(leading, "T")
  expect(lead.sections.map((section) => section.id)).toEqual(["preamble", "a"])
})

test("derive falls back to whole", () => {
  const text = "Just plain prose.\nAcross lines.\n"
  const split = derive(text, "General")
  expect(split).toEqual({
    kind: "whole",
    sections: [{ id: "whole", name: "Full text", depth: 0, start: 0, end: text.length }],
  })
})

const BASH = [
  "Run commands in the shell.",
  "",
  "Purpose tells when bash is the right tool.",
  "",
  "Quoting and preference",
  "Prefer single quotes for literals.",
  "",
  "Large output",
  "Page through large output instead of dumping it.",
  "",
  "Timeouts and background",
  "Use timeouts for slow commands.",
  "",
].join("\n")

function bashBoundaries() {
  const at = (label: string): number => BASH.indexOf(label)
  return [
    { id: "purpose", name: "Purpose", start: 0 },
    { id: "quoting-and-preference", name: "Quoting and preference", start: at("Quoting and preference") },
    { id: "large-output", name: "Large output", start: at("Large output") },
    { id: "timeouts-and-background", name: "Timeouts and background", start: at("Timeouts and background") },
  ]
}

test("manual splits the bash description into four labeled sections", () => {
  const split = manual(BASH, bashBoundaries())
  expect(split.kind).toBe("manual")
  expect(split.sections.map((section) => section.id)).toEqual([
    "purpose",
    "quoting-and-preference",
    "large-output",
    "timeouts-and-background",
  ])
  expect(split.sections.every((section) => section.depth === 0)).toBe(true)
  expect(slice(BASH, split.sections[2])).toContain("Page through large output")
})

test("manual adds Preamble for leading text before the first boundary", () => {
  const text = "intro\nbody\n"
  const split = manual(text, [{ id: "body", name: "Body", start: 6 }])
  expect(split.sections.map((section) => section.id)).toEqual(["preamble", "body"])
  expect(slice(text, split.sections[1])).toBe("body\n")
})

test("excluding a parent drops its children", () => {
  const split = derive(GPT, "General")
  const out = assemble(GPT, split, new Set(["communication"]))
  expect(out).not.toContain("Talk well.")
  expect(out).not.toContain("Narrate progress.")
  expect(out).not.toContain("Answer crisply.")
  expect(out).toContain("You are the harness.")
  expect(out).toContain("Read before editing.")
})

test("excluding one child keeps the parent text and siblings", () => {
  const split = derive(GPT, "General")
  const out = assemble(GPT, split, new Set(["communication/intermediate-commentary"]))
  expect(out).toContain("Talk well.")
  expect(out).toContain("Answer crisply.")
  expect(out).not.toContain("Narrate progress.")
})

test("assemble emits leaf ranges only and collapses blank runs", () => {
  const split = derive(GPT, "General")
  const out = assemble(GPT, split, new Set(["communication/final-answer", "delegation"]))
  const occurrences = out.split("Talk well.").length - 1
  expect(occurrences).toBe(1)
  expect(out).not.toMatch(/\n{3,}/)
  expect(out).toBe(out.trim())
})

test("slug collisions get numeric suffixes", () => {
  const text = "# Setup\n\na\n\n# Setup\n\nb\n\n## Setup\n\nc\n"
  const split = derive(text, "T")
  expect(split.sections.map((section) => section.id)).toEqual(["setup", "setup-2", "setup-2/setup"])
})

test("wrappingSection finds the lone top-level heading that wraps the document", () => {
  const wrapped = "# Title\nintro\n## A\na\n## B\nb\n"
  const split = derive(wrapped, "T")
  const wrapper = wrappingSection(split)
  expect(wrapper?.id).toBe("title")
  expect(ownBody(wrapped, split, wrapper!)).toBe("intro")
  // No body beyond the heading: nothing to present as Introduction.
  const bare = "# Title\n\n## A\na\n"
  expect(ownBody(bare, derive(bare, "T"), wrappingSection(derive(bare, "T"))!)).toBe("")
  // A single heading with no children is not a wrapper: it is the document.
  expect(wrappingSection(derive("# Title\nbody\n", "T"))).toBeUndefined()
  // Several top-level sections stay exactly as they are.
  expect(wrappingSection(derive("# A\na\n# B\nb\n", "T"))).toBeUndefined()
  expect(wrappingSection(derive("## A\na\n## B\nb\n", "T"))).toBeUndefined()
  expect(wrappingSection(derive("plain prose", "T"))).toBeUndefined()
})

test("assembleWithOverrides separates section overrides with a blank line before headings", () => {
  const text = "# Part One\n\nBody one.\n\n# Part Two\n\nBody two.\n"
  const split = derive(text, "Doc")
  // Override without trailing newlines
  const overrides = new Map([["part-one", "# Part One\n\nCustom body one without trailing newlines."]])
  const out = assembleWithOverrides(text, split, new Set(), overrides)
  expect(out).toContain("Custom body one without trailing newlines.\n\n# Part Two")
})

test("assembled spans stay on their sections when blank-line runs collapse before them", () => {
  const text = "# Alpha\n\nalpha\n\n\n\n\nmore\n\n# Beta\n\nbeta\n"
  const split = derive(text, "Doc")
  const assembled = assembleWithSpans(text, split, new Map())
  expect(assembled.text).toBe(assembleWithOverrides(text, split, new Set(), new Map()))
  const beta = split.sections.find((section) => section.name === "Beta")
  if (beta === undefined) throw new Error("no Beta section")
  const span = assembled.spans.get(beta.id)
  expect(span).toEqual({ start: assembled.text.indexOf("# Beta"), end: assembled.text.length })
  expect(assembled.text.slice(span?.start, span?.end)).toBe("# Beta\n\nbeta")
})

test("manual split with depth preserves hierarchy in assemble and parentIndexes, while without depth behaves as golden", () => {
  const text = "Alpha content.\nChild content.\nBeta content.\n"
  const goldenBoundaries = [
    { id: "alpha", name: "Alpha", start: 0 },
    { id: "beta", name: "Beta", start: text.indexOf("Beta content.") },
  ]
  const goldenSplit = manual(text, goldenBoundaries)
  expect(goldenSplit.sections).toHaveLength(2)
  expect(goldenSplit.sections[0].depth).toBe(0)
  expect(goldenSplit.sections[1].depth).toBe(0)
  expect(goldenSplit.sections[0].end).toBe(goldenBoundaries[1].start)
  expect(goldenSplit.sections[1].end).toBe(text.length)
  const goldenAssembled = assemble(text, goldenSplit, new Set())
  expect(goldenAssembled).toBe("Alpha content.\nChild content.\nBeta content.")

  // With depth
  const nestedBoundaries = [
    { id: "alpha", name: "Alpha", start: 0, depth: 0 },
    { id: "child", name: "Child", start: text.indexOf("Child content."), depth: 1 },
    { id: "beta", name: "Beta", start: text.indexOf("Beta content."), depth: 0 },
  ]
  const nestedSplit = manual(text, nestedBoundaries)
  expect(nestedSplit.sections[0].depth).toBe(0)
  expect(nestedSplit.sections[0].end).toBe(nestedBoundaries[2].start)
  expect(nestedSplit.sections[1].depth).toBe(1)
  expect(nestedSplit.sections[1].end).toBe(nestedBoundaries[2].start)
  expect(nestedSplit.sections[2].depth).toBe(0)
  expect(nestedSplit.sections[2].end).toBe(text.length)

  const nestedAssembled = assemble(text, nestedSplit, new Set(["child"]))
  expect(nestedAssembled).not.toContain("Child content.")
  expect(nestedAssembled).toContain("Alpha content.")
  expect(nestedAssembled).toContain("Beta content.")
})
