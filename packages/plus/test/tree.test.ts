import { expect, test } from "bun:test"
import { fingerprint, type Customization, type Item, type Snapshot } from "../src/instructions/model.js"
import type { AgentSource } from "../src/instructions/discover.js"
import { tree } from "../src/instructions/tree.js"

const TEST_TIMESTAMP = "2026-01-01T00:00:00.000Z"

function createItem(overrides?: Partial<Item>): Item {
  const text = overrides?.text ?? "base item text"
  return {
    id: "item-gen-100",
    kind: "prompt",
    owner: "owner-gen-100",
    title: "title-gen-100",
    text,
    agents: [],
    fingerprint: fingerprint(text),
    available: true,
    ...overrides,
  }
}

function createCustomization(overrides?: Partial<Customization>): Customization {
  return {
    item: "item-gen-100",
    agent: "*",
    state: "inherit",
    basedOn: fingerprint("base item text"),
    updated: TEST_TIMESTAMP,
    ...overrides,
  }
}

function createSnapshot(items: Item[] = [], customizations: Customization[] = []): Snapshot {
  return { revision: 1, items, customizations }
}

test("agents are grouped into Project / Global / Defaults by their scope, with correct counts", () => {
  const agents: AgentSource[] = [
    { id: "agent-prj-101", scope: "project" },
    { id: "agent-prj-102", scope: "project" },
    { id: "agent-glo-201", scope: "global" },
    { id: "agent-def-301", scope: "builtin" },
  ]

  const nodes = tree({
    snapshot: createSnapshot(),
    agents,
    expanded: new Set(["group:project", "group:global", "group:defaults"]),
  })

  const projectHeader = nodes.find((node) => node.id === "group:project")
  const globalHeader = nodes.find((node) => node.id === "group:global")
  const defaultsHeader = nodes.find((node) => node.id === "group:defaults")

  expect(projectHeader?.label).toBe("Project agents (2)")
  expect(projectHeader?.depth).toBe(0)

  expect(globalHeader?.label).toBe("Global agents (1)")
  expect(globalHeader?.depth).toBe(0)

  expect(defaultsHeader?.label).toBe("Defaults")
  expect(defaultsHeader?.depth).toBe(0)

  const projectAgentNodes = nodes.filter((node) => node.kind === "agent" && node.scope === "project")
  expect(projectAgentNodes.map((node) => node.agentId)).toEqual(["agent-prj-101", "agent-prj-102"])
  expect(projectAgentNodes.every((node) => node.depth === 1)).toBe(true)

  const globalAgentNodes = nodes.filter((node) => node.kind === "agent" && node.scope === "global")
  expect(globalAgentNodes.map((node) => node.agentId)).toEqual(["agent-glo-201"])
  expect(globalAgentNodes.every((node) => node.depth === 1)).toBe(true)

  const builtinAgentNodes = nodes.filter((node) => node.kind === "agent" && node.scope === "builtin")
  expect(builtinAgentNodes.map((node) => node.agentId)).toEqual(["agent-def-301"])
  expect(builtinAgentNodes.every((node) => node.depth === 1)).toBe(true)

  const defaultTargetNodes = nodes.filter((node) => node.kind === "default")
  expect(defaultTargetNodes.map((node) => node.label)).toEqual(["Project"])
  expect(defaultTargetNodes.every((node) => node.depth === 1)).toBe(true)
})

test("an agent listed in protectedAgents is marked protected and read-only, and one not listed is not", () => {
  const agents: AgentSource[] = [
    { id: "agent-locked-401", scope: "project" },
    { id: "agent-open-402", scope: "project" },
  ]

  const nodes = tree({
    snapshot: createSnapshot(),
    agents,
    project: {
      version: 1,
      protectedAgents: ["agent-locked-401"],
    },
    expanded: new Set(["group:project"]),
  })

  const lockedNode = nodes.find((node) => node.id === "agent:agent-locked-401")
  const openNode = nodes.find((node) => node.id === "agent:agent-open-402")

  expect(lockedNode?.badges.protected).toBe(true)
  expect(lockedNode?.badges.readOnly).toBe(true)

  expect(openNode?.badges.protected).toBe(false)
  expect(openNode?.badges.readOnly).toBe(false)

  const childTool = createItem({
    id: "tool-child-sub-401",
    kind: "tool",
    title: "tool-child-sub-title",
  })
  const childNodes = tree({
    snapshot: createSnapshot([childTool]),
    agents,
    project: {
      version: 1,
      protectedAgents: ["agent-locked-401"],
    },
    expanded: new Set(["group:project", "agent:agent-locked-401"]),
  })
  const childItemNode = childNodes.find((node) => node.itemId === "tool-child-sub-401")
  expect(childItemNode?.badges.readOnly).toBe(true)
})

test("a customized row carries the customized badge and an untouched row does not", () => {
  const agentId = "agent-subj-501"
  const skillCustom = createItem({
    id: "skill-custom-501",
    kind: "skill",
    title: "skill-custom-title",
  })
  const skillUntouched = createItem({
    id: "skill-untouched-502",
    kind: "skill",
    title: "skill-untouched-title",
  })

  const customization = createCustomization({
    item: "skill-custom-501",
    agent: agentId,
    text: "specialized skill override",
  })

  const nodes = tree({
    snapshot: createSnapshot([skillCustom, skillUntouched], [customization]),
    agents: [{ id: agentId, scope: "project" }],
    expanded: new Set(["group:project", `agent:${agentId}`]),
  })

  const customNode = nodes.find((node) => node.itemId === "skill-custom-501")
  const untouchedNode = nodes.find((node) => node.itemId === "skill-untouched-502")

  expect(customNode?.badges.customized).toBe(true)
  expect(untouchedNode?.badges.customized).toBe(false)
})

test("a row whose upstream fingerprint changed after authoring carries the review badge, and it clears once reviewed", () => {
  const agentId = "agent-subj-601"
  const initialText = "version one upstream text"
  const revisedText = "version two upstream text"
  const toolItem = createItem({
    id: "tool-rev-601",
    kind: "tool",
    title: "tool-rev-title",
    text: revisedText,
    fingerprint: fingerprint(revisedText),
  })

  const unreviewedCustomization = createCustomization({
    item: "tool-rev-601",
    agent: agentId,
    text: "user customized tool",
    basedOn: fingerprint(initialText),
  })

  const unreviewedNodes = tree({
    snapshot: createSnapshot([toolItem], [unreviewedCustomization]),
    agents: [{ id: agentId, scope: "project" }],
    expanded: new Set(["group:project", `agent:${agentId}`]),
  })

  const unreviewedNode = unreviewedNodes.find((node) => node.itemId === "tool-rev-601")
  expect(unreviewedNode?.badges.customized).toBe(true)
  expect(unreviewedNode?.badges.review).toBe(true)

  const reviewedCustomization = createCustomization({
    item: "tool-rev-601",
    agent: agentId,
    text: "user customized tool",
    basedOn: fingerprint(initialText),
    reviewed: fingerprint(revisedText),
  })

  const reviewedNodes = tree({
    snapshot: createSnapshot([toolItem], [reviewedCustomization]),
    agents: [{ id: agentId, scope: "project" }],
    expanded: new Set(["group:project", `agent:${agentId}`]),
  })

  const reviewedNode = reviewedNodes.find((node) => node.itemId === "tool-rev-601")
  expect(reviewedNode?.badges.customized).toBe(true)
  expect(reviewedNode?.badges.review).toBe(false)
})

test("a disabled row reports enabled: false", () => {
  const agentId = "agent-subj-701"
  const activeItem = createItem({
    id: "inst-active-701",
    kind: "instruction",
    title: "inst-active-title",
  })
  const disabledItem = createItem({
    id: "inst-disabled-702",
    kind: "instruction",
    title: "inst-disabled-title",
  })

  const disableRecord = createCustomization({
    item: "inst-disabled-702",
    agent: agentId,
    state: "disabled",
  })

  const nodes = tree({
    snapshot: createSnapshot([activeItem, disabledItem], [disableRecord]),
    agents: [{ id: agentId, scope: "project" }],
    expanded: new Set(["group:project", `agent:${agentId}`]),
  })

  const activeNode = nodes.find((node) => node.itemId === "inst-active-701")
  const disabledNode = nodes.find((node) => node.itemId === "inst-disabled-702")

  expect(activeNode?.badges.enabled).toBe(true)
  expect(disabledNode?.badges.enabled).toBe(false)
})

test("collapsing works: with no expanded ids only the top-level headers are emitted; expanding an agent emits its Prompt / Skills / Tools / Instructions children", () => {
  const agentId = "agent-subj-801"
  const promptItem = createItem({
    id: `prompt:${agentId}`,
    kind: "prompt",
    owner: agentId,
    title: agentId,
    agents: [agentId],
  })
  const skillItem = createItem({
    id: "skill-child-801",
    kind: "skill",
    title: "skill-child-title",
  })
  const toolItem = createItem({
    id: "tool-child-802",
    kind: "tool",
    title: "tool-child-title",
  })
  const instructionItem = createItem({
    id: "inst-child-803",
    kind: "instruction",
    title: "inst-child-title",
  })

  const snapshot = createSnapshot([promptItem, skillItem, toolItem, instructionItem])
  const agents: AgentSource[] = [{ id: agentId, scope: "project" }]

  const collapsedNodes = tree({
    snapshot,
    agents,
    expanded: new Set(),
  })

  expect(collapsedNodes.map((node) => node.id)).toEqual([
    "group:project",
    "group:global",
    "group:defaults",
  ])
  expect(collapsedNodes.every((node) => node.depth === 0)).toBe(true)

  const expandedNodes = tree({
    snapshot,
    agents,
    expanded: new Set(["group:project", `agent:${agentId}`]),
  })

  expect(expandedNodes.map((node) => node.id)).toEqual([
    "group:project",
    `agent:${agentId}`,
    `agent:${agentId}:${promptItem.id}`,
    `agent:${agentId}:${skillItem.id}`,
    `agent:${agentId}:${toolItem.id}`,
    `agent:${agentId}:${instructionItem.id}`,
    "group:global",
    "group:defaults",
  ])

  const promptNode = expandedNodes.find((node) => node.kind === "prompt")
  const skillNode = expandedNodes.find((node) => node.kind === "skill")
  const toolNode = expandedNodes.find((node) => node.kind === "tool")
  const instructionNode = expandedNodes.find((node) => node.kind === "instruction")

  expect(promptNode?.label).toBe("Prompt")
  expect(promptNode?.depth).toBe(2)
  expect(skillNode?.label).toBe("skill-child-title")
  expect(skillNode?.depth).toBe(2)
  expect(toolNode?.label).toBe("tool-child-title")
  expect(toolNode?.depth).toBe(2)
  expect(instructionNode?.label).toBe("inst-child-title")
  expect(instructionNode?.depth).toBe(2)
})

test("an empty group still emits its header with a zero count", () => {
  const nodes = tree({
    snapshot: createSnapshot(),
    agents: [],
  })

  expect(nodes).toHaveLength(3)
  expect(nodes[0]).toEqual({
    id: "group:project",
    kind: "group",
    label: "Project agents (0)",
    depth: 0,
    badges: {},
  })
  expect(nodes[1]).toEqual({
    id: "group:global",
    kind: "group",
    label: "Global agents (0)",
    depth: 0,
    badges: {},
  })
  expect(nodes[2]).toEqual({
    id: "group:defaults",
    kind: "group",
    label: "Defaults",
    depth: 0,
    badges: {},
  })
})

test("expanding defaults emits project target with shared item customizations", () => {
  const sharedSkill = createItem({
    id: "skill-shared-901",
    kind: "skill",
    title: "skill-shared-title",
  })
  const customization = createCustomization({
    item: "skill-shared-901",
    agent: "*",
    text: "custom shared skill text",
  })

  const nodes = tree({
    snapshot: createSnapshot([sharedSkill], [customization]),
    agents: [],
    expanded: new Set(["group:defaults", "defaults:project"]),
  })

  expect(nodes.map((node) => node.id)).toContain("group:defaults")
  expect(nodes.map((node) => node.id)).toContain("defaults:project")
  expect(nodes.map((node) => node.id)).not.toContain("defaults:global")

  const sharedNode = nodes.find((node) => node.id === "defaults:project:skill-shared-901")
  expect(sharedNode).toBeDefined()
  expect(sharedNode?.depth).toBe(2)
  expect(sharedNode?.badges.customized).toBe(true)
})

test("supports discovered snapshot input with separate stored customizations and array expanded set", () => {
  const agentId = "agent-disc-901"
  const skillItem = createItem({
    id: "skill-disc-901",
    kind: "skill",
    title: "skill-disc-title",
  })
  const agents: AgentSource[] = [{ id: agentId, scope: "project" }]
  const customization = createCustomization({
    item: "skill-disc-901",
    agent: agentId,
    state: "disabled",
  })

  const nodes = tree({
    snapshot: createSnapshot([skillItem], [customization]),
    agents,
    project: { version: 1, protectedAgents: [] },
    expanded: new Set(["group:project", `agent:${agentId}`]),
  })

  const skillNode = nodes.find((node) => node.itemId === "skill-disc-901")
  expect(skillNode?.badges.enabled).toBe(false)
  expect(skillNode?.badges.customized).toBe(true)
})

test("prompt rows stay editable but refuse toggle with an accurate reason", () => {
  const agentId = "agent-toggle-1001"
  const promptItem = createItem({
    id: `prompt:${agentId}`,
    kind: "prompt",
    owner: agentId,
    title: agentId,
    agents: [agentId],
  })

  const nodes = tree({
    snapshot: createSnapshot([promptItem]),
    agents: [{ id: agentId, scope: "project" }],
    expanded: new Set(["group:project", `agent:${agentId}`]),
  })

  const promptNode = nodes.find((node) => node.kind === "prompt")
  expect(promptNode?.action?.edit).toEqual({ allowed: true })
  expect(promptNode?.action?.toggle.allowed).toBe(false)
  if (promptNode?.action?.toggle.allowed === false)
    expect(promptNode.action.toggle.reason).toBe("an agent always needs a system prompt")
})

test("skill and tool rows stay toggleable and editable", () => {
  const agentId = "agent-action-1002"
  const skillItem = createItem({ id: "skill-action-1002", kind: "skill", title: "skill-action-title" })
  const toolItem = createItem({
    id: "tool-action-1002",
    kind: "tool",
    owner: "tool-native-1002",
    title: "tool-action-title",
  })

  const nodes = tree({
    snapshot: createSnapshot([skillItem, toolItem]),
    agents: [{ id: agentId, scope: "project" }],
    tools: [{ id: "tool-native-1002", native: true }],
    expanded: new Set(["group:project", `agent:${agentId}`]),
  })

  const skillNode = nodes.find((node) => node.itemId === "skill-action-1002")
  const toolNode = nodes.find((node) => node.itemId === "tool-action-1002")
  expect(skillNode?.action?.toggle).toEqual({ allowed: true })
  expect(skillNode?.action?.edit).toEqual({ allowed: true })
  expect(toolNode?.action?.toggle).toEqual({ allowed: true })
  expect(toolNode?.action?.edit).toEqual({ allowed: true })
})

test("code mode tool rows refuse toggle and edit in per-agent and shared views", () => {
  const agentId = "agent-codemode-1006"
  const toolItem = createItem({
    id: "tool-codemode-1006",
    kind: "tool",
    owner: "tool-codemode-1006",
    title: "tool-codemode-title",
  })

  const agentNodes = tree({
    snapshot: createSnapshot([toolItem]),
    agents: [{ id: agentId, scope: "project" }],
    tools: [{ id: "tool-codemode-1006", native: false }],
    expanded: new Set(["group:project", `agent:${agentId}`]),
  })
  const agentNode = agentNodes.find((node) => node.itemId === "tool-codemode-1006")
  expect(agentNode?.action?.toggle.allowed).toBe(false)
  expect(agentNode?.action?.edit.allowed).toBe(false)

  const sharedNodes = tree({
    snapshot: createSnapshot([toolItem]),
    agents: [],
    tools: [{ id: "tool-codemode-1006", native: false }],
    expanded: new Set(["group:defaults", "defaults:project"]),
  })
  const sharedNode = sharedNodes.find((node) => node.id === "defaults:project:tool-codemode-1006")
  expect(sharedNode?.action?.toggle.allowed).toBe(false)
  expect(sharedNode?.action?.edit.allowed).toBe(false)
  if (sharedNode?.action?.toggle.allowed === false)
    expect(sharedNode.action.toggle.reason).toContain("execute inventory")
})

test("instruction rows refuse toggle and edit without using the protected badge", () => {
  const agentId = "agent-inst-1003"
  const instructionItem = createItem({
    id: "inst-blocked-1003",
    kind: "instruction",
    title: "inst-blocked-title",
  })

  const nodes = tree({
    snapshot: createSnapshot([instructionItem]),
    agents: [{ id: agentId, scope: "project" }],
    expanded: new Set(["group:project", `agent:${agentId}`]),
  })

  const instructionNode = nodes.find((node) => node.itemId === "inst-blocked-1003")
  expect(instructionNode?.badges.readOnly).toBe(false)
  expect(instructionNode?.action?.toggle.allowed).toBe(false)
  expect(instructionNode?.action?.edit.allowed).toBe(false)
  if (instructionNode?.action?.toggle.allowed === false)
    expect(instructionNode.action.toggle.reason).toBe(
      "the public plugin API does not expose source-aware instruction customization",
    )
  if (instructionNode?.action?.edit.allowed === false)
    expect(instructionNode.action.edit.reason).toBe(
      "the public plugin API does not expose source-aware instruction customization",
    )
})

test("per-agent children never include MCP rows; shared MCP rows toggle but refuse edit", () => {
  const agentId = "agent-mcp-1004"
  const mcpItem = createItem({ id: "mcp-shared-1004", kind: "mcp", owner: "server", title: "server" })

  const agentNodes = tree({
    snapshot: createSnapshot([mcpItem]),
    agents: [{ id: agentId, scope: "project" }],
    expanded: new Set(["group:project", `agent:${agentId}`]),
  })
  expect(agentNodes.some((node) => node.kind === "mcp")).toBe(false)

  const sharedNodes = tree({
    snapshot: createSnapshot([mcpItem]),
    agents: [],
    expanded: new Set(["group:defaults", "defaults:project"]),
  })
  const sharedNode = sharedNodes.find((node) => node.id === "defaults:project:mcp-shared-1004")
  expect(sharedNode?.action?.toggle).toEqual({ allowed: true })
  expect(sharedNode?.action?.edit.allowed).toBe(false)
})

test("shared instruction rows refuse toggle and edit", () => {
  const instructionItem = createItem({
    id: "inst-shared-1005",
    kind: "instruction",
    title: "inst-shared-title",
  })

  const nodes = tree({
    snapshot: createSnapshot([instructionItem]),
    agents: [],
    expanded: new Set(["group:defaults", "defaults:project"]),
  })

  const sharedNode = nodes.find((node) => node.id === "defaults:project:inst-shared-1005")
  expect(sharedNode?.action?.toggle.allowed).toBe(false)
  expect(sharedNode?.action?.edit.allowed).toBe(false)
  if (sharedNode?.action?.toggle.allowed === false)
    expect(sharedNode.action.toggle.reason).toBe(
      "the public plugin API does not expose source-aware instruction customization",
    )
  if (sharedNode?.action?.edit.allowed === false)
    expect(sharedNode.action.edit.reason).toBe(
      "the public plugin API does not expose source-aware instruction customization",
    )
})

test("rows offer reset only when their own record deviates", () => {
  const agentId = "agent-reset-1101"
  const customSkill = createItem({ id: "skill-reset-1101", kind: "skill", title: "skill-reset-title" })
  const untouchedSkill = createItem({ id: "skill-plain-1102", kind: "skill", title: "skill-plain-title" })
  const sharedSkill = createItem({ id: "skill-shared-1103", kind: "skill", title: "skill-shared-title" })
  const customized = createCustomization({ item: "skill-reset-1101", agent: agentId, text: "custom skill text" })
  const shared = createCustomization({ item: "skill-shared-1103", agent: "*", text: "shared skill text" })

  const nodes = tree({
    snapshot: createSnapshot([customSkill, untouchedSkill, sharedSkill], [customized, shared]),
    agents: [{ id: agentId, scope: "project" }],
    expanded: new Set(["group:project", `agent:${agentId}`]),
  })

  expect(nodes.find((node) => node.itemId === "skill-reset-1101")?.action?.reset).toEqual({ allowed: true })
  expect(nodes.find((node) => node.itemId === "skill-plain-1102")?.action?.reset.allowed).toBe(false)
  expect(nodes.find((node) => node.itemId === "skill-shared-1103")?.action?.reset.allowed).toBe(false)
})

test("prompt rows offer reset through edit even though toggle is refused", () => {
  const agentId = "agent-reset-1104"
  const promptItem = createItem({
    id: `prompt:${agentId}`,
    kind: "prompt",
    owner: agentId,
    title: agentId,
    agents: [agentId],
  })
  const customized = createCustomization({ item: promptItem.id, agent: agentId, text: "custom prompt text" })

  const nodes = tree({
    snapshot: createSnapshot([promptItem], [customized]),
    agents: [{ id: agentId, scope: "project" }],
    expanded: new Set(["group:project", `agent:${agentId}`]),
  })

  const promptNode = nodes.find((node) => node.kind === "prompt")
  expect(promptNode?.action?.toggle.allowed).toBe(false)
  expect(promptNode?.action?.reset).toEqual({ allowed: true })
})

test("instruction and code mode rows refuse reset with the row's own reason", () => {
  const agentId = "agent-reset-1105"
  const instructionItem = createItem({ id: "inst-reset-1105", kind: "instruction", title: "inst-reset-title" })
  const codeModeItem = createItem({
    id: "tool-reset-1106",
    kind: "tool",
    owner: "tool-reset-1106",
    title: "tool-reset-title",
  })
  const instructionCustom = createCustomization({ item: "inst-reset-1105", agent: agentId, text: "custom" })
  const codeModeCustom = createCustomization({ item: "tool-reset-1106", agent: agentId, text: "custom" })

  const nodes = tree({
    snapshot: createSnapshot([instructionItem, codeModeItem], [instructionCustom, codeModeCustom]),
    agents: [{ id: agentId, scope: "project" }],
    tools: [{ id: "tool-reset-1106", native: false }],
    expanded: new Set(["group:project", `agent:${agentId}`]),
  })

  const instructionNode = nodes.find((node) => node.itemId === "inst-reset-1105")
  expect(instructionNode?.action?.reset.allowed).toBe(false)
  if (instructionNode?.action?.reset.allowed === false)
    expect(instructionNode.action.reset.reason).toBe(
      "the public plugin API does not expose source-aware instruction customization",
    )

  const codeModeNode = nodes.find((node) => node.itemId === "tool-reset-1106")
  expect(codeModeNode?.action?.reset.allowed).toBe(false)
  if (codeModeNode?.action?.reset.allowed === false)
    expect(codeModeNode.action.reset.reason).toContain("execute inventory")
})

test("shared rows offer reset only for their own shared record", () => {
  const skillItem = createItem({ id: "skill-reset-1107", kind: "skill", title: "skill-reset-title" })
  const plainItem = createItem({ id: "skill-plain-1108", kind: "skill", title: "skill-plain-title" })
  const customized = createCustomization({ item: "skill-reset-1107", agent: "*", text: "shared skill text" })

  const nodes = tree({
    snapshot: createSnapshot([skillItem, plainItem], [customized]),
    agents: [],
    expanded: new Set(["group:defaults", "defaults:project"]),
  })

  expect(nodes.find((node) => node.id === "defaults:project:skill-reset-1107")?.action?.reset).toEqual({
    allowed: true,
  })
  expect(nodes.find((node) => node.id === "defaults:project:skill-plain-1108")?.action?.reset.allowed).toBe(false)
})

test("per-agent enable over shared disable carries the customized badge", () => {
  const agentId = "agent-subj-1201"
  const item = createItem({
    id: "tool-custom-badge-1201",
    kind: "tool",
    title: "tool-custom-title",
    available: true,
  })
  const shared = createCustomization({
    item: "tool-custom-badge-1201",
    agent: "*",
    state: "disabled",
  })
  const own = createCustomization({
    item: "tool-custom-badge-1201",
    agent: agentId,
    state: "enabled",
  })

  const nodes = tree({
    snapshot: createSnapshot([item], [shared, own]),
    agents: [{ id: agentId, scope: "project" }],
    expanded: new Set(["group:project", `agent:${agentId}`]),
  })

  const node = nodes.find((entry) => entry.itemId === "tool-custom-badge-1201")
  expect(node?.badges.customized).toBe(true)
  expect(node?.badges.enabled).toBe(true)
})

