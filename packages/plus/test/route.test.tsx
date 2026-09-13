import { expect, test } from "bun:test"
import { createComponent } from "solid-js"
import { InstructionsRoute, WIDE_THRESHOLD } from "../src/tui/instructions/route.js"
import { createInstructionsState } from "../src/tui/instructions/state.js"
import { createSnapshot, renderInstructionsRoute, renderPlusFixture } from "./tui.js"

test("instructions route retries initial-agent selection across sequential snapshots", async () => {
  const targetAgentId = "target-agent"

  const firstSnapshot = createSnapshot({
    revision: 1,
    agents: [{ id: "alpha", scope: "project", fileBacked: true }],
  })

  const secondSnapshot = createSnapshot({
    revision: 2,
    agents: [
      { id: "alpha", scope: "project", fileBacked: true },
      { id: targetAgentId, scope: "project", fileBacked: true },
    ],
  })

  const fixture = await renderInstructionsRoute({
    snapshots: [firstSnapshot, secondSnapshot],
    data: { agent: targetAgentId },
  })

  try {
    await fixture.waitForFrame((frame) => frame.includes("alpha"))
    const initialFrame = fixture.captureCharFrame()
    expect(initialFrame).not.toContain(targetAgentId)
    expect(initialFrame).toContain("›- Project agents (1)")

    await fixture.emitChanged()

    await fixture.waitForFrame((frame) => frame.includes(targetAgentId))
    const updatedFrame = fixture.captureCharFrame()

    expect(updatedFrame).toContain(`›  + ${targetAgentId}`)
    expect(updatedFrame).not.toContain("›- Project agents")
    expect(updatedFrame).toContain(" - Project agents (2)")
  } finally {
    fixture.destroy()
  }
})

test("defect A: editing does not survive unmounting on terminal shrink below WIDE_THRESHOLD", async () => {
  const snapshot = createSnapshot({
    revision: 1,
    agents: [{ id: "alpha", scope: "project", fileBacked: true }],
    items: [
      {
        id: "item-1",
        kind: "prompt",
        owner: "alpha",
        title: "Prompt",
        text: "hello world",
        agents: ["alpha"],
        fingerprint: "fp-1",
        available: true,
      },
    ],
  })

  const fixture = await renderInstructionsRoute({
    snapshots: [snapshot],
    data: { agent: "alpha" },
    width: 120,
    height: 40,
  })

  function dispatch(key: string) {
    for (const cmd of fixture.commands()) {
      if (typeof cmd.bind === "string" && cmd.bind.split(",").includes(key)) {
        void cmd.run()
        return true
      }
    }
    return false
  }

  try {
    await fixture.waitForFrame((frame) => frame.includes("alpha"))
    // Expand alpha to reveal Prompt
    dispatch("return")
    await fixture.waitForFrame((frame) => frame.includes("Prompt"))
    // Move to Prompt
    dispatch("down")
    await fixture.waitForFrame((frame) => frame.includes("hello world"))
    // Start editing Prompt
    dispatch("e")
    await fixture.waitForFrame((frame) => frame.includes("ctrl+s save"))
    expect(fixture.captureCharFrame()).toContain("ctrl+s save · esc cancel")

    // Shrink below WIDE_THRESHOLD (100)
    fixture.resize(WIDE_THRESHOLD - 10, 40)
    await fixture.waitForFrame((frame) => frame.includes("Project agents") && !frame.includes("ctrl+s save"))

    const narrowFrame = fixture.captureCharFrame()
    expect(narrowFrame).not.toContain("ctrl+s save")
    // Footer should advertise regular narrow leaf hints instead
    expect(narrowFrame).toContain("up/down move")

    // Keymap should be restored (we can navigate again)
    const canMove = dispatch("up")
    expect(canMove).toBe(true)

    // Widen back above WIDE_THRESHOLD
    fixture.resize(120, 40)
    await fixture.waitForFrame((frame) => frame.includes("Scope: project"))
    const widenedFrame = fixture.captureCharFrame()
    // Fresh DetailPane should not carry active editing
    expect(widenedFrame).not.toContain("ctrl+s save")
  } finally {
    fixture.destroy()
  }
})

test("defect B: space, a, and x are registered in keymap only when honoured by row", async () => {
  const snapshot = createSnapshot({
    revision: 1,
    agents: [{ id: "alpha", scope: "project", fileBacked: true }],
    tools: [{ id: "alpha", native: true }],
    items: [
      {
        id: "prompt-1",
        kind: "prompt",
        owner: "alpha",
        title: "Prompt",
        text: "prompt text",
        agents: ["alpha"],
        fingerprint: "fp-prompt",
        available: true,
      },
      {
        id: "tool-1",
        kind: "tool",
        owner: "alpha",
        title: "Tool",
        text: "tool text",
        agents: ["alpha"],
        fingerprint: "fp-tool-revised",
        available: true,
      },
    ],
    customizations: [
      {
        item: "tool-1",
        agent: "alpha",
        state: "disabled",
        basedOn: "fp-tool-initial",
        updated: "2026-09-01T00:00:00Z",
      },
    ],
  })

  const fixture = await renderInstructionsRoute({
    snapshots: [snapshot],
    data: { agent: "alpha" },
    width: 120,
    height: 40,
  })

  function getRouteCommands() {
    return fixture.commands().map((c) => c.bind)
  }

  function dispatch(key: string) {
    for (const cmd of fixture.commands()) {
      if (typeof cmd.bind === "string" && cmd.bind.split(",").includes(key)) {
        void cmd.run()
        return true
      }
    }
    return false
  }

  try {
    // 1. Agent header selected (structural row)
    await fixture.waitForFrame((frame) => frame.includes("alpha"))
    const agentCommands = getRouteCommands()
    expect(agentCommands).toContain("up,k")
    expect(agentCommands).toContain("return")
    expect(agentCommands).not.toContain("space")
    expect(agentCommands).not.toContain("a")
    expect(agentCommands).not.toContain("x")

    // Expand agent
    dispatch("return")
    await fixture.waitForFrame((frame) => frame.includes("Prompt"))

    // 2. Prompt row selected (non-togglable, not customized, no review)
    dispatch("down")
    await fixture.waitForFrame((frame) => frame.includes("prompt text"))
    const promptCommands = getRouteCommands()
    expect(promptCommands).not.toContain("space")
    expect(promptCommands).not.toContain("a")
    expect(promptCommands).not.toContain("x")

    // 3. Tool row selected (togglable, needs review, customized)
    dispatch("down")
    await fixture.waitForFrame((frame) => frame.includes("tool text"))
    const toolCommands = getRouteCommands()
    expect(toolCommands).toContain("space")
    expect(toolCommands).toContain("a")
    expect(toolCommands).toContain("x")
  } finally {
    fixture.destroy()
  }
})

test("defect C: navigation hints advertise enter detail only for narrow leaf rows and left/right expand only when expandable", async () => {
  const snapshot = createSnapshot({
    revision: 1,
    agents: [{ id: "alpha", scope: "project", fileBacked: true }],
    items: [
      {
        id: "prompt-1",
        kind: "prompt",
        owner: "alpha",
        title: "Prompt",
        text: "prompt text",
        agents: ["alpha"],
        fingerprint: "fp-prompt",
        available: true,
      },
    ],
  })

  // Start in narrow mode (80 cols)
  const fixture = await renderInstructionsRoute({
    snapshots: [snapshot],
    data: { agent: "alpha" },
    width: 80,
    height: 40,
  })

  function dispatch(key: string) {
    for (const cmd of fixture.commands()) {
      if (typeof cmd.bind === "string" && cmd.bind.split(",").includes(key)) {
        void cmd.run()
        return true
      }
    }
    return false
  }

  try {
    // Narrow structural row (alpha agent header)
    await fixture.waitForFrame((frame) => frame.includes("alpha"))
    const narrowAgentFrame = fixture.captureCharFrame()
    expect(narrowAgentFrame).toContain("up/down move")
    expect(narrowAgentFrame).toContain("left/right expand")
    expect(narrowAgentFrame).not.toContain("enter detail")

    // Expand agent and move to Prompt (narrow leaf row)
    dispatch("return")
    await fixture.waitForFrame((frame) => frame.includes("Prompt"))
    dispatch("down")
    await fixture.waitForFrame((frame) => frame.includes("enter detail"))
    const narrowPromptFrame = fixture.captureCharFrame()
    expect(narrowPromptFrame).toContain("up/down move")
    expect(narrowPromptFrame).toContain("enter detail")
    expect(narrowPromptFrame).not.toContain("left/right expand")

    // Switch to wide mode
    fixture.resize(120, 40)
    await fixture.waitForFrame((frame) => frame.includes("prompt text"))
    const widePromptFrame = fixture.captureCharFrame()
    // Wide leaf row: up/down move, no left/right expand, no enter detail
    expect(widePromptFrame).toContain("up/down move")
    expect(widePromptFrame).not.toContain("left/right expand")
    expect(widePromptFrame).not.toContain("enter detail")

    // Move back up to agent header (wide structural row)
    dispatch("up")
    await fixture.waitForFrame((frame) => frame.includes("Scope: project"))
    const wideAgentFrame = fixture.captureCharFrame()
    expect(wideAgentFrame).toContain("up/down move")
    expect(wideAgentFrame).toContain("left/right expand")
    expect(wideAgentFrame).not.toContain("enter detail")
  } finally {
    fixture.destroy()
  }
})

test("defect D: MCP review flag can be acknowledged when toggle is allowed and edit is not", async () => {
  const mcpItem = {
    id: "mcp-server-1",
    kind: "mcp" as const,
    owner: "server",
    title: "MCPServer",
    text: "mcp-config",
    agents: [] as string[],
    fingerprint: "fp-mcp-revised",
    available: false,
  }

  const initialSnapshot = createSnapshot({
    revision: 1,
    items: [mcpItem],
    customizations: [
      {
        item: "mcp-server-1",
        agent: "*",
        state: "enabled",
        basedOn: "fp-mcp-initial",
        updated: "2026-09-01T00:00:00Z",
      },
    ],
  })

  const acknowledgedSnapshot = createSnapshot({
    revision: 2,
    items: [mcpItem],
    customizations: [
      {
        item: "mcp-server-1",
        agent: "*",
        state: "enabled",
        basedOn: "fp-mcp-initial",
        reviewed: "fp-mcp-revised",
        updated: "2026-09-01T00:00:00Z",
      },
    ],
  })

  const fixture = await renderInstructionsRoute({
    snapshots: [initialSnapshot, acknowledgedSnapshot],
    width: 120,
    height: 40,
  })

  function dispatch(key: string) {
    for (const cmd of fixture.commands()) {
      if (typeof cmd.bind === "string" && cmd.bind.split(",").includes(key)) {
        void cmd.run()
        return true
      }
    }
    return false
  }

  try {
    // Defaults is expanded by default; select Defaults -> Project
    await fixture.waitForFrame((frame) => frame.includes("Project"))
    // Navigate down to Project under Defaults
    // Nodes: Project agents (0), Global agents (0), Defaults, Project
    dispatch("down") // Global agents
    dispatch("down") // Defaults
    dispatch("down") // Project
    await fixture.waitForFrame((frame) => frame.includes("Project (default)"))

    // Expand Project under Defaults to reveal MCPServer
    dispatch("return")
    await fixture.waitForFrame((frame) => frame.includes("MCPServer"))

    // Move to MCPServer
    dispatch("down")
    await fixture.waitForFrame((frame) => frame.includes("MCPServer (mcp)"))

    const mcpFrame = fixture.captureCharFrame()
    expect(mcpFrame).toContain("needs review")
    expect(mcpFrame).toContain("a acknowledge")

    // Dispatch "a" to acknowledge
    dispatch("a")

    await fixture.waitForFrame((frame) => frame.includes('Acknowledged "MCPServer"'))
    const acknowledgedFrame = fixture.captureCharFrame()
    expect(acknowledgedFrame).toContain('Acknowledged "MCPServer"')
    expect(acknowledgedFrame).not.toContain("needs review")
    expect(acknowledgedFrame).not.toContain("a acknowledge")
  } finally {
    fixture.destroy()
  }
})

test("defect D: non-actionable rows still refuse acknowledgement in state", async () => {
  const instructionItem = {
    id: "inst-1",
    kind: "instruction" as const,
    owner: "project",
    title: "Project Instructions",
    text: "instructions text",
    agents: ["alpha"],
    fingerprint: "fp-inst-2",
    available: true,
  }

  const snapshot = createSnapshot({
    revision: 1,
    agents: [{ id: "alpha", scope: "project", fileBacked: true }],
    items: [instructionItem],
  })

  type InstructionsStateType = ReturnType<typeof createInstructionsState>
  let testState: InstructionsStateType | undefined
  const fixture = await renderPlusFixture({
    snapshots: [snapshot],
    render: (context) => {
      testState = createInstructionsState(context)
      return createComponent(InstructionsRoute, { context, onClose: () => {} })
    },
  })

  try {
    await fixture.waitForFrame((frame) => frame.includes("Project Instructions") || frame.includes("alpha"))
    const state = testState
    expect(state).toBeDefined()
    if (!state) return
    state.toggleExpanded("agent:alpha")
    const instNode = state.nodes().find((n) => n.itemId === "inst-1")
    expect(instNode).toBeDefined()
    if (!instNode) return
    await state.acknowledge(instNode)
    expect(state.status()).toContain('cannot be acknowledged: the public plugin API does not expose source-aware instruction customization')
  } finally {
    fixture.destroy()
  }
})

test("stops offering actions and keybindings when project mode is disabled", async () => {
  const snapshot = createSnapshot({
    revision: 1,
    agents: [{ id: "alpha", scope: "project", fileBacked: true }],
    tools: [{ id: "alpha", native: true }],
    items: [
      {
        id: "tool-1",
        kind: "tool",
        owner: "alpha",
        title: "Tool",
        text: "tool text",
        agents: ["alpha"],
        fingerprint: "fp-tool-revised",
        available: true,
      },
    ],
    customizations: [
      {
        item: "tool-1",
        agent: "alpha",
        state: "disabled",
        basedOn: "fp-tool-initial",
        updated: "2026-09-01T00:00:00Z",
      },
    ],
  })

  const fixture = await renderInstructionsRoute({
    snapshots: [snapshot],
    data: { agent: "alpha" },
    width: 120,
    height: 40,
  })

  function dispatch(key: string) {
    for (const cmd of fixture.commands()) {
      if (typeof cmd.bind === "string" && cmd.bind.split(",").includes(key)) {
        void cmd.run()
        return true
      }
    }
    return false
  }

  try {
    await fixture.waitForFrame((frame) => frame.includes("alpha"))
    dispatch("return")
    await fixture.waitForFrame((frame) => frame.includes("Tool"))
    dispatch("down")
    await fixture.waitForFrame((frame) => frame.includes("tool text"))

    const initialFrame = fixture.captureCharFrame()
    expect(initialFrame).toContain("space toggle")
    expect(initialFrame).toContain("a acknowledge")
    expect(initialFrame).toContain("x reset")

    const initialCommands = fixture.commands().map((cmd) => cmd.bind)
    expect(initialCommands).toContain("space")
    expect(initialCommands).toContain("a")
    expect(initialCommands).toContain("x")

    await fixture.emitProjectChanged({ enabled: false })

    await fixture.waitForFrame((frame) => frame.includes("Project mode is disabled for this directory"))

    const disabledFrame = fixture.captureCharFrame()
    expect(disabledFrame).not.toContain("space toggle")
    expect(disabledFrame).not.toContain("a acknowledge")
    expect(disabledFrame).not.toContain("x reset")

    const disabledCommands = fixture.commands().map((cmd) => cmd.bind)
    expect(disabledCommands).not.toContain("space")
    expect(disabledCommands).not.toContain("a")
    expect(disabledCommands).not.toContain("x")
  } finally {
    fixture.destroy()
  }
})
