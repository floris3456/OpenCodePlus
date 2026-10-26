import { expect, test } from "bun:test"
import { switchedOffMinedRules } from "../src/instructions/mined-legacy.js"
import { fingerprint, type CustomizationRecord, type Item } from "../src/instructions/model.js"

function off(item: string, owner: Partial<CustomizationRecord> = {}): CustomizationRecord {
  return {
    type: "customization",
    level: "project",
    agent: "alpha",
    item,
    section: null,
    state: "off",
    basedOn: fingerprint("generated"),
    updated: "2026-10-24T00:00:00.000Z",
    ...owner,
  }
}

const tools = new Set(["shell", "edit", "web_opencode_fetch"])
const text = "Never `git rebase main`. Edits src/foo.c. See https://docs.example.org/guide."

test("a switched-off generated rule comes back with the patterns it had, at its own owner", () => {
  const rules = switchedOffMinedRules({
    records: [
      off("perm:shell:git-rebase"),
      off("perm:edit:src-foo-c", { level: "global", agent: null, catalogue: "teams" }),
      off("perm:web_opencode_fetch:docs-example-org", { team: { level: "project", team: "Basic" }, agent: "Planner" }),
    ],
    rows: [],
    tools,
    texts: [text],
  })
  expect(rules).toEqual([
    {
      type: "rule",
      level: "project",
      agent: "alpha",
      tool: "shell",
      id: "git-rebase",
      label: "git rebase",
      patterns: ["git rebase *"],
      keywords: ["git rebase"],
    },
    {
      type: "rule",
      level: "global",
      agent: null,
      catalogue: "teams",
      tool: "edit",
      id: "src-foo-c",
      label: "src/foo.c",
      patterns: ["src/foo.c"],
      keywords: ["src/foo.c"],
    },
    {
      type: "rule",
      level: "project",
      agent: "Planner",
      team: { level: "project", team: "Basic" },
      tool: "web_opencode_fetch",
      id: "docs-example-org",
      label: "docs.example.org",
      patterns: ["*docs.example.org*"],
      keywords: ["docs.example.org"],
    },
  ])
})

test("nothing comes back for a listed row, a rule switched on, a tool outside the generator or a mention that is gone", () => {
  const listed: Item = {
    id: "perm:shell:git-rebase",
    kind: "perm",
    group: "none",
    title: "Rebase",
    text: "",
    enabled: true,
    fingerprint: fingerprint(""),
  }
  expect(
    switchedOffMinedRules({ records: [off("perm:shell:git-rebase")], rows: [listed], tools, texts: [text] }),
  ).toEqual([])
  expect(
    switchedOffMinedRules({
      records: [{ ...off("perm:shell:git-rebase"), state: "on" }],
      rows: [],
      tools,
      texts: [text],
    }),
  ).toEqual([])
  expect(
    switchedOffMinedRules({
      records: [off("perm:shell:git-rebase")],
      rows: [],
      tools: new Set(["edit"]),
      texts: [text],
    }),
  ).toEqual([])
  expect(
    switchedOffMinedRules({ records: [off("perm:shell:git-rebase")], rows: [], tools, texts: ["No commands here."] }),
  ).toEqual([])
})

test("a mentioned command equal to a shipped rule was that rule, never one of its own", () => {
  // `git push *` is the shipped git-push rule, so the generator never listed it apart.
  expect(
    switchedOffMinedRules({
      records: [off("perm:shell:git-push")],
      rows: [],
      tools,
      texts: ["Run `git push origin`."],
    }),
  ).toEqual([])
})

test("of two candidates with one id, the one more texts mention had the row", () => {
  const rules = switchedOffMinedRules({
    records: [off("perm:shell:git-rebase")],
    rows: [],
    tools,
    texts: ["git Rebase main", "git rebase main", "git rebase dev"],
  })
  expect(rules.map((rule) => rule.patterns)).toEqual([["git rebase *"]])
})
