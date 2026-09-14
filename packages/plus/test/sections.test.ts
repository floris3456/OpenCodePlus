import { expect, test } from "bun:test"
import { assemble, derive, manual, slice } from "../src/instructions/sections.js"

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
  expect(communication !== undefined && codebases !== undefined && communication.end).toBe(codebases.start)
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
    sections: [{ id: "whole", name: "General", depth: 0, start: 0, end: text.length }],
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
