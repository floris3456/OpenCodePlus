import { expect, test } from "bun:test"
import { fingerprint, resolve, threeWay, type Address, type CustomizationRecord, type Item } from "../src/instructions/model.js"
import { derive } from "../src/instructions/sections.js"
import { expandedTree, type MemoInput } from "../src/instructions/tree.js"
import { saveText } from "../src/instructions/ops.js"
import { migrateWholeRows } from "../src/instructions/store.js"

function makeItem(overrides: Partial<Item> = {}): Item {
  const text = overrides.text ?? "# Intro\n\nIntro text.\n\n# Body\n\nBody text.\n"
  return {
    id: "system:role",
    kind: "system",
    group: "none",
    title: "Role/persona",
    text,
    enabled: true,
    fingerprint: fingerprint(text),
    agents: ["orchestrator"],
    ...overrides,
  }
}

function baseInput(overrides?: Partial<MemoInput>): MemoInput {
  const item = makeItem()
  return {
    items: [
      item,
      {
        id: "tool:bash",
        kind: "tool",
        group: "native",
        title: "bash",
        text: "Run commands in the shell.",
        enabled: true,
        fingerprint: fingerprint("Run commands in the shell."),
      },
      {
        id: "system:prose",
        kind: "system",
        group: "none",
        title: "Guidelines",
        text: "Just plain prose without headings.",
        enabled: true,
        fingerprint: fingerprint("Just plain prose without headings."),
        agents: ["orchestrator"],
      },
    ],
    agents: [{ id: "orchestrator", scope: "project" }],
    records: [],
    ...overrides,
  }
}

function findNodeId(input: MemoInput, itemId: string, section?: string): string {
  const tree = expandedTree(input)
  const node = tree.find(
    (n) => n.address?.item === itemId && (section === undefined ? n.address?.section === null : n.address?.section === section),
  )
  if (!node) throw new Error(`Node not found for ${itemId} (section: ${section})`)
  return node.id
}

test("naming: the whole-body entry of an unsplit row is labelled 'Full text'", () => {
  const input = baseInput()
  const tree = expandedTree(input)

  // Unsplit tool row (tool:bash has no headings)
  const bashSection = tree.find((n) => n.address?.item === "tool:bash" && n.address?.section === "whole")
  expect(bashSection).toBeDefined()
  expect(bashSection?.label).toBe("Full text")

  // Unsplit non-tool row (system:prose has no headings)
  const proseSection = tree.find((n) => n.address?.item === "system:prose" && n.address?.section === "whole")
  expect(proseSection).toBeDefined()
  expect(proseSection?.label).toBe("Full text")

  // derive() on plain prose returns "Full text"
  const split = derive("plain text", "General")
  expect(split.sections[0]?.name).toBe("Full text")
})

test("edit a section, then the row: its view and the assembled prompt are equal", () => {
  const input = baseInput()
  const item = input.items.find((i) => i.id === "system:role")!
  const address: Address = { level: "project", agent: "orchestrator", item: "system:role", section: null }

  // 1. Edit section "intro"
  const introNodeId = findNodeId(input, "system:role", "intro")
  const editedIntro = "# Intro\n\nCustom intro text.\n"
  const step1 = saveText(input, introNodeId, editedIntro)
  if ("refusal" in step1) throw new Error(step1.refusal)

  const input1: MemoInput = { ...input, records: step1.records }
  const resolved1 = resolve({
    upstream: item,
    records: step1.records,
    splits: [],
    scopes: { global: new Set(), defaults: new Set() },
    address,
  })

  // The row's view text and assembled prompt must be equal
  expect(resolved1.text).toBe(resolved1.assembled)
  expect(resolved1.assembled).toContain("Custom intro text.")
  expect(resolved1.assembled).toContain("Body text.")

  // 2. Now edit the whole row
  const rowNodeId = findNodeId(input1, "system:role")
  const wholeEdit = `${editedIntro}\n# Body\n\nCustom body text.\n`
  const step2 = saveText(input1, rowNodeId, wholeEdit)
  if ("refusal" in step2) throw new Error(step2.refusal)

  const resolved2 = resolve({
    upstream: item,
    records: step2.records,
    splits: [],
    scopes: { global: new Set(), defaults: new Set() },
    address,
  })

  expect(resolved2.text).toBe(resolved2.assembled)
  expect(resolved2.assembled).toContain("Custom intro text.")
  expect(resolved2.assembled).toContain("Custom body text.")
})

test("edit the row: each changed section shows its change, and the unchanged ones keep following upstream", () => {
  const item3: Item = {
    id: "system:role",
    kind: "system",
    group: "none",
    title: "Role/persona",
    text: "# Alpha\n\nalpha upstream.\n\n# Beta\n\nbeta upstream.\n\n# Gamma\n\ngamma upstream.\n",
    enabled: true,
    fingerprint: fingerprint("abc"),
    agents: ["orchestrator"],
  }
  const input = baseInput({ items: [item3] })
  const address: Address = { level: "project", agent: "orchestrator", item: "system:role", section: null }

  // Edit whole row: change Alpha, leave Beta and Gamma untouched
  const rowNodeId = findNodeId(input, "system:role")
  const editedWhole = "# Alpha\n\nalpha CHANGED.\n\n# Beta\n\nbeta upstream.\n\n# Gamma\n\ngamma upstream.\n"
  const saved = saveText(input, rowNodeId, editedWhole)
  if ("refusal" in saved) throw new Error(saved.refusal)

  // Only Alpha should have a customization record stored
  const customRecords = saved.records.filter((r) => r.item === "system:role")
  expect(customRecords.length).toBe(1)
  expect(customRecords[0]?.section).toBe("alpha")
  expect(customRecords[0]?.text).toContain("alpha CHANGED.")

  // Changed section Alpha shows its change
  const resolvedAlpha = resolve({
    upstream: item3,
    records: saved.records,
    splits: [],
    scopes: { global: new Set(), defaults: new Set() },
    address: { ...address, section: "alpha" },
  })
  expect(resolvedAlpha.text).toContain("alpha CHANGED.")

  // Unchanged section Beta resolves from upstream
  const resolvedBeta1 = resolve({
    upstream: item3,
    records: saved.records,
    splits: [],
    scopes: { global: new Set(), defaults: new Set() },
    address: { ...address, section: "beta" },
  })
  expect(resolvedBeta1.text).toContain("beta upstream.")

  // Now change upstream Beta to new text
  const item3Updated: Item = {
    ...item3,
    text: "# Alpha\n\nalpha upstream.\n\n# Beta\n\nbeta upstream UPDATED.\n\n# Gamma\n\ngamma upstream.\n",
  }
  const resolvedBeta2 = resolve({
    upstream: item3Updated,
    records: saved.records,
    splits: [],
    scopes: { global: new Set(), defaults: new Set() },
    address: { ...address, section: "beta" },
  })
  // Beta keeps following upstream!
  expect(resolvedBeta2.text).toContain("beta upstream UPDATED.")

  // Alpha still shows its change
  const resolvedAlpha2 = resolve({
    upstream: item3Updated,
    records: saved.records,
    splits: [],
    scopes: { global: new Set(), defaults: new Set() },
    address: { ...address, section: "alpha" },
  })
  expect(resolvedAlpha2.text).toContain("alpha CHANGED.")
})

test("migrating Simple-Orchestrator shape (whole override plus five section overrides) gives byte-identical prompt", () => {
  const sections = [
    { id: "identity", title: "Identity", upstream: "You are the orchestrator." },
    { id: "rules", title: "Rules", upstream: "Follow standing rules." },
    { id: "tools", title: "Tools", upstream: "Use tools conservatively." },
    { id: "output", title: "Output", upstream: "Produce markdown output." },
    { id: "coordination", title: "Coordination", upstream: "Coordinate across agents." },
    { id: "safety", title: "Safety", upstream: "Ensure safety boundary." },
    { id: "context", title: "Context", upstream: "Maintain context window." },
  ]
  const upstreamText = sections.map((s) => `# ${s.title}\n\n${s.upstream}\n`).join("\n")
  const roleItem: Item = {
    id: "system:role",
    kind: "system",
    group: "none",
    title: "Role/persona",
    text: upstreamText,
    enabled: true,
    fingerprint: fingerprint(upstreamText),
    agents: ["Simple-Orchestrator"],
  }

  // 1 whole-row override with headings
  const wholeOverrideText = sections
    .map((s) => `# ${s.title}\n\n${s.upstream} [whole override edit]\n`)
    .join("\n")

  const wholeRecord: CustomizationRecord = {
    type: "customization",
    level: "global",
    agent: "Simple-Orchestrator",
    item: "system:role",
    section: null,
    text: wholeOverrideText,
    basedOn: fingerprint(upstreamText),
    basedOnText: upstreamText,
    updated: "2026-10-04T00:00:00.000Z",
  }

  // 5 section overrides (for identity, rules, tools, output, coordination)
  const sectionOverrides: CustomizationRecord[] = sections.slice(0, 5).map((s) => ({
    type: "customization",
    level: "global",
    agent: "Simple-Orchestrator",
    item: "system:role",
    section: s.id,
    text: `# ${s.title}\n\n${s.upstream} [specific section override]\n`,
    basedOn: fingerprint(`# ${s.title}\n\n${s.upstream} [whole override edit]\n`),
    basedOnText: `# ${s.title}\n\n${s.upstream} [whole override edit]\n`,
    updated: "2026-10-05T00:00:00.000Z",
  }))

  const recordsBefore = [wholeRecord, ...sectionOverrides]

  // Prompt assembled BEFORE migration
  const address: Address = { level: "global", agent: "Simple-Orchestrator", item: "system:role", section: null }
  const promptBefore = resolve({
    upstream: roleItem,
    records: recordsBefore,
    splits: [],
    scopes: { global: new Set(["Simple-Orchestrator"]), defaults: new Set() },
    address,
  }).assembled

  // Run migration
  const migrationResult = migrateWholeRows(recordsBefore)
  expect(migrationResult.migrated).toBe(true)

  // Verify: store holds ONLY section records for system:role
  const roleRecordsAfter = migrationResult.records.filter((r) => r.type === "customization" && r.item === "system:role") as CustomizationRecord[]
  expect(roleRecordsAfter.some((r) => r.section === null && r.text !== undefined)).toBe(false)
  expect(roleRecordsAfter.every((r) => r.section !== null)).toBe(true)

  // Verify: the 5 section overrides that were already stored stayed on top
  for (const origSec of sectionOverrides) {
    const afterSec = roleRecordsAfter.find((r) => r.section === origSec.section)
    expect(afterSec?.text).toBe(origSec.text)
    expect(afterSec?.updated).toBe(origSec.updated)
  }

  // Verify: safety and context (which only existed in whole override) now have section records
  const safetySec = roleRecordsAfter.find((r) => r.section === "safety")
  expect(safetySec).toBeDefined()
  expect(safetySec?.text).toContain("[whole override edit]")

  const contextSec = roleRecordsAfter.find((r) => r.section === "context")
  expect(contextSec).toBeDefined()
  expect(contextSec?.text).toContain("[whole override edit]")

  // Prompt assembled AFTER migration must be byte-identical
  const promptAfter = resolve({
    upstream: roleItem,
    records: migrationResult.records as CustomizationRecord[],
    splits: [],
    scopes: { global: new Set(["Simple-Orchestrator"]), defaults: new Set() },
    address,
  }).assembled

  expect(promptAfter).toBe(promptBefore)

  // Migration is idempotent
  const secondMigration = migrateWholeRows(migrationResult.records)
  expect(secondMigration.migrated).toBe(false)
})

test("migrating real Simple-Orchestrator shape (whole-row text with headings that upstream lacks, plus five section overrides) preserves assembled prompt", () => {
  const upstreamText = [
    "# Team member",
    "## Runs and messages",
    "Runs upstream.",
    "## Working",
    "Working upstream.",
    "# Orchestrator",
    "## Ownership",
    "Ownership upstream.",
    "## Worktrees",
    "Worktrees upstream.",
  ].join("\n\n")

  const roleItem: Item = {
    id: "system:role",
    kind: "system",
    group: "none",
    title: "Role/persona",
    text: upstreamText,
    enabled: true,
    fingerprint: fingerprint(upstreamText),
    agents: ["Simple-Orchestrator"],
  }

  const wholeText = [
    "# Team member",
    "## Runs and messages",
    "Runs customized in whole.",
    "## Working",
    "Working customized in whole.",
    "# Orchestrator",
    "## STOP EVERY RUN YOU ARE DONE WITH",
    "Stop runs rule.",
    "## Watching runs",
    "Watching runs rule.",
    "## Ownership",
    "Ownership customized in whole.",
    "## Briefs to workers",
    "Briefs to workers rule.",
    "## Choosing a worker",
    "Choosing worker rule.",
    "## Reviewing and landing",
    "Reviewing landing rule.",
    "## Worktrees",
    "Worktrees customized in whole.",
  ].join("\n\n")

  const wholeRecord: CustomizationRecord = {
    type: "customization",
    level: "global",
    agent: "Simple-Orchestrator",
    item: "system:role",
    section: null,
    text: wholeText,
    basedOn: fingerprint(upstreamText),
    basedOnText: upstreamText,
    updated: "2026-10-04T00:00:00.000Z",
  }

  const fiveSections = [
    { section: "orchestrator/stop-every-run-you-are-done-with", text: "## STOP EVERY RUN YOU ARE DONE WITH\n\nSpecific stop override." },
    { section: "orchestrator/watching-runs", text: "## Watching runs\n\nSpecific watch override." },
    { section: "orchestrator/briefs-to-workers", text: "## Briefs to workers\n\nSpecific briefs override." },
    { section: "orchestrator/choosing-a-worker", text: "## Choosing a worker\n\nSpecific worker choice override." },
    { section: "orchestrator/reviewing-and-landing", text: "## Reviewing and landing\n\nSpecific landing override." },
  ]

  const sectionOverrides: CustomizationRecord[] = fiveSections.map((s) => ({
    type: "customization",
    level: "global",
    agent: "Simple-Orchestrator",
    item: "system:role",
    section: s.section,
    text: s.text,
    basedOn: fingerprint("..."),
    updated: "2026-10-05T00:00:00.000Z",
  }))

  const recordsBefore = [wholeRecord, ...sectionOverrides]
  const address: Address = { level: "global", agent: "Simple-Orchestrator", item: "system:role", section: null }

  const promptBefore = resolve({
    upstream: roleItem,
    records: recordsBefore,
    splits: [],
    scopes: { global: new Set(["Simple-Orchestrator"]), defaults: new Set() },
    address,
  }).assembled

  const migrationResult = migrateWholeRows(recordsBefore)

  const promptAfter = resolve({
    upstream: roleItem,
    records: migrationResult.records as CustomizationRecord[],
    splits: [],
    scopes: { global: new Set(["Simple-Orchestrator"]), defaults: new Set() },
    address,
  }).assembled

  expect(promptAfter).toBe(promptBefore)
})

test("whole-row view, mine view, and threeWay diff reflect section overrides", () => {
  const item = makeItem()
  const address: Address = { level: "project", agent: "orchestrator", item: "system:role", section: null }
  const sectionRecord: CustomizationRecord = {
    type: "customization",
    level: "project",
    agent: "orchestrator",
    item: "system:role",
    section: "intro",
    text: "# Intro\n\nIntro edited.\n",
    basedOn: fingerprint("# Intro\n\nIntro text.\n"),
    basedOnText: "# Intro\n\nIntro text.\n",
    updated: "2026-10-06T00:00:00.000Z",
  }

  const resolved = resolve({
    upstream: item,
    records: [sectionRecord],
    splits: [],
    scopes: { global: new Set(), defaults: new Set() },
    address,
  })

  // The row's view text contains the section override and matches assembled prompt
  expect(resolved.text).toBe(resolved.assembled)
  expect(resolved.text).toContain("Intro edited.")
  expect(resolved.modified).toBe(true)
  expect(resolved.overriddenHere).toBe(true)

  // threeWay diff on the whole row
  const three = threeWay({
    upstream: item,
    records: [sectionRecord],
    splits: [],
    scopes: { global: new Set(), defaults: new Set() },
    address,
  })
  expect(three).toBeDefined()
  expect(three?.mine).toBe(resolved.assembled)
  expect(three?.original).toContain("Intro text.")
  expect(three?.upstream).toContain("Intro text.")
})
