import { expect, test } from "bun:test"
import { entrySpecificity, matchesName, type EntryName } from "../src/instructions/model.js"

test("* matches any run, whole name, ignoring case", () => {
  expect(matchesName("*Orchestrator*", "Opus-orchestrator")).toBe(true)
  expect(matchesName("*Orchestrator*", "opus-Orchestrator-Max")).toBe(true)
  expect(matchesName("*Orchestrator*", "orchestrator")).toBe(true)
  expect(matchesName("*Orchestrator*", "orchestra")).toBe(false)
  expect(matchesName("planner", "Planner")).toBe(true)
  // Whole name: an exact pattern is not a substring match.
  expect(matchesName("planner", "planner-2")).toBe(false)
  expect(matchesName("plan*", "planner-2")).toBe(true)
  expect(matchesName("*", "")).toBe(true)
})

test("% means the same as *", () => {
  for (const name of ["Opus-orchestrator", "opus-Orchestrator-Max", "orchestrator", "orchestra"])
    expect(matchesName("%Orchestrator%", name)).toBe(matchesName("*Orchestrator*", name))
  expect(matchesName("a%c", "abbbc")).toBe(true)
  expect(matchesName("a%c", "ac")).toBe(true)
})

test("regex metacharacters are literal", () => {
  expect(matchesName("a.b", "axb")).toBe(false)
  expect(matchesName("a.b", "a.b")).toBe(true)
  expect(matchesName("a+", "aa")).toBe(false)
  expect(matchesName("a+", "a+")).toBe(true)
  expect(matchesName("(x)|y", "y")).toBe(false)
  expect(matchesName("(x)|y", "(x)|y")).toBe(true)
  expect(matchesName("[ab]", "a")).toBe(false)
  expect(matchesName("a?b", "ab")).toBe(false)
  expect(matchesName("a\\b", "a\\b")).toBe(true)
  expect(matchesName("^a$", "^a$")).toBe(true)
})

test("specificity: exact first, then more literal characters, then name order", () => {
  const entries: EntryName[] = [
    { name: "*" },
    { name: "*orchestrator*" },
    { name: "opus-*" },
    { name: "opus-orchestrator" },
    { name: "*-orchestrator" },
  ]
  expect(entries.toSorted(entrySpecificity).map((entry) => entry.name)).toEqual([
    "opus-orchestrator",
    "*-orchestrator",
    "*orchestrator*",
    "opus-*",
    "*",
  ])
})

test("specificity ties on literal count fall back to name order, and equal names are equal", () => {
  expect(entrySpecificity({ name: "b*" }, { name: "a*" })).toBe(1)
  expect(entrySpecificity({ name: "a*" }, { name: "b*" })).toBe(-1)
  // `%` and `*` count the same: no literal characters either way.
  expect([{ name: "x%" }, { name: "x*" }].toSorted(entrySpecificity).map((entry) => entry.name)).toEqual(["x%", "x*"])
  expect(entrySpecificity({ name: "a*" }, { name: "a*" })).toBe(0)
  // Name order ignores case first.
  expect([{ name: "B*" }, { name: "a*" }].toSorted(entrySpecificity).map((entry) => entry.name)).toEqual(["a*", "B*"])
})

test("Teams specificity: member exactness, team exactness, member literals, team literals", () => {
  const entries: EntryName[] = [
    { team: "*", name: "*" },
    { team: "crew", name: "*" },
    { team: "*", name: "scout" },
    { team: "crew", name: "scout" },
    { team: "*", name: "sc*" },
    { team: "cr*", name: "sc*" },
    { team: "c*", name: "sco*" },
  ]
  expect(entries.toSorted(entrySpecificity).map((entry) => `${entry.team}/${entry.name}`)).toEqual([
    "crew/scout",
    "*/scout",
    "crew/*",
    "c*/sco*",
    "cr*/sc*",
    "*/sc*",
    "*/*",
  ])
})
