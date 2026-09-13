import { expect, test } from "bun:test"
import { createSnapshot, renderInstructionsRoute } from "./tui.js"

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
