import { expect, test } from "bun:test"
import { fingerprint } from "../src/instructions/model.js"
import { LIST_WINDOW_MARGIN, listMountLog, resetListMountLog } from "../src/tui/instructions/route.js"
import { createSnapshot, renderInstructionsRoute } from "./tui.js"
import { dispatch, selectedRow } from "./instructions-nav.js"

// One project agent with thousands of tool rows: a level large enough that the
// list pane instantiating every row would exhaust the renderer.
function bigSnapshot(count: number) {
  const items = Array.from({ length: count }, (_, i) => {
    const index = String(i).padStart(4, "0")
    const text = `run ${index}\n`
    return {
      id: `tool:bulk-${index}`,
      kind: "tool" as const,
      group: "native" as const,
      title: `bulk-${index}`,
      text,
      enabled: true,
      fingerprint: fingerprint(text),
    }
  })
  return createSnapshot({
    agents: [{ id: "build", scope: "project" as const, fileBacked: true, origin: "user" as const }],
    items,
  })
}

test("a filtered list of thousands of rows instantiates only the viewport window", async () => {
  await using fixture = await renderInstructionsRoute({
    snapshots: [bigSnapshot(2000)],
    data: { agent: "build" },
    width: 130,
    height: 45,
  })
  await fixture.waitForFrame((frame) => frame.includes("Instructions") && selectedRow(frame).includes("build"))
  // Count only the rows the filter's result instantiates.
  resetListMountLog()
  expect(dispatch(fixture, "/")).toBe(true)
  await fixture.waitForFrame((frame) => frame.includes("words or key:value"))
  await fixture.typeText("bulk-")
  await fixture.waitForFrame((frame) => frame.includes("esc clear filter") && selectedRow(frame).includes("bulk-0000"))

  const landed = [...listMountLog.rows]
  const bound = Math.max(...landed.map((entry) => entry.height)) + LIST_WINDOW_MARGIN * 2
  expect(landed.length).toBeGreaterThan(0)
  // At most the viewport and its margin: never the 2000-row result.
  expect(landed.length).toBeLessThanOrEqual(bound)
  expect(landed.length).toBeLessThan(200)
  expect(landed.some((entry) => entry.key === "item:project:build:tool:bulk-1999")).toBe(false)

  // Navigating to the last row still works: clear, search for it and go to it.
  expect(dispatch(fixture, "escape")).toBe(true)
  await fixture.waitForFrame((frame) => !frame.includes("esc clear filter"))
  expect(dispatch(fixture, "/")).toBe(true)
  await fixture.waitForFrame((frame) => frame.includes("words or key:value"))
  await fixture.typeText("id:item:project:build:tool:bulk-1999")
  await fixture.waitForFrame((frame) => frame.includes("esc clear filter") && selectedRow(frame).includes("bulk-1999"))
  expect(dispatch(fixture, "return")).toBe(true)
  await fixture.waitForFrame((frame) => !frame.includes("esc clear filter") && selectedRow(frame).includes("bulk-1999"))

  // The row is rendered, the window moved, and the whole list never mounted:
  // even across the filter, the reveal and its window move, the mounts stay
  // within a few windows, not 2000 rows.
  expect(listMountLog.rows.some((entry) => entry.key === "item:project:build:tool:bulk-1999")).toBe(true)
  const total = [...listMountLog.rows].length
  expect(total).toBeLessThanOrEqual(bound * 4)
  expect(total).toBeLessThan(500)
})
