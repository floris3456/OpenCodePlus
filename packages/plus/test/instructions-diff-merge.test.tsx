// The Take result is the merge proposal as rows (B13): one row per change
// (both-changed units give yours and upstream rows), defaults from
// defaultInclude, ↑/↓ over change rows, Space to include or exclude, t saves
// the render, u takes upstream, k keeps yours, e edits the render. No markers.
import { createTestRenderer } from "@opentui/core/testing"
import { render, type JSX } from "@opentui/solid"
import type { Plugin } from "@opencode/plugin/tui"
import { expect, test } from "bun:test"
import { comparisonsOf, DiffPane } from "../src/tui/instructions/diff-pane.js"
import { createTestTheme } from "./tui.js"

interface TestCommand {
  readonly bind?: string
  readonly run: () => void
}

interface Fixture {
  readonly renderer: Awaited<ReturnType<typeof createTestRenderer>>["renderer"]
  readonly commands: () => readonly TestCommand[]
  readonly captureCharFrame: () => string
  readonly waitForFrame: (predicate: (frame: string) => boolean) => Promise<string>
  readonly destroy: () => void
}

// Self-contained mount: only theme + keymap, no route/state/backend imports.
async function mount(element: (context: Plugin.Context) => JSX.Element): Promise<Fixture> {
  const output = await createTestRenderer({ width: 120, height: 40, remote: true, useThread: false })
  const layers: Array<() => { commands?: readonly TestCommand[] }> = []
  const rawContext = {
    theme: createTestTheme(),
    themeMode: "dark",
    keymap: {
      layer: (fn: () => { commands?: readonly TestCommand[] }) => {
        layers.push(fn)
      },
    },
  }
  const context = rawContext as unknown as Plugin.Context
  await render(() => element(context), output.renderer)
  output.renderer.start()
  return {
    renderer: output.renderer,
    commands: () => [...layers].reverse().flatMap((fn) => fn().commands ?? []),
    captureCharFrame: () => output.captureCharFrame(),
    waitForFrame: (predicate) => output.waitForFrame(predicate),
    destroy: () => {
      if (!output.renderer.isDestroyed) output.renderer.destroy()
    },
  }
}

function send(fixture: Fixture, key: string): boolean {
  for (const command of fixture.commands()) {
    if (typeof command.bind === "string" && command.bind.split(",").includes(key)) {
      command.run()
      return true
    }
  }
  return false
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

// Five change units on five sentences, separated by unchanged sentences:
// Alpha (yours only), Gamma (upstream only), Epsilon (both, differently), Eta
// (both, the same).
const sides = {
  original: "Alpha one.\nBeta two.\nGamma three.\nDelta four.\nEpsilon five.\nZeta six.\nEta seven.\n",
  mine: "Alpha mine.\nBeta two.\nGamma three.\nDelta four.\nEpsilon yours.\nZeta six.\nEta same.\n",
  upstream: "Alpha one.\nBeta two.\nGamma upstream.\nDelta four.\nEpsilon upstream.\nZeta six.\nEta same.\n",
}
// Defaults: yours and upstream-only units in; the both unit takes yours.
const defaultMerged = "Alpha mine.\nBeta two.\nGamma upstream.\nDelta four.\nEpsilon yours.\nZeta six.\nEta same.\n"

function paneFor(threeWay: typeof sides, saved: { resolution: string; edited?: string }[]) {
  return (context: Plugin.Context) => (
    <DiffPane
      context={context}
      title="Demo item"
      threeWay={threeWay}
      active={() => true}
      onResolve={async (resolution, edited) => {
        saved.push({ resolution, edited })
      }}
    />
  )
}

test("comparisonsOf Take result is the default merge with no conflict markers", () => {
  const comparisons = comparisonsOf(sides, true)
  expect(comparisons.map((comparison) => comparison.label)).toEqual(["Upstream change", "Your change", "Take result"])
  const take = comparisons[2]
  if (take === undefined) throw new Error("missing Take result")
  expect(take.from).toBe("yours")
  expect(take.to).toBe("merged result")
  expect(take.right).toBe(defaultMerged)
  expect(take.right).not.toContain("<<<<<<<")
})

test("Take result rows show the defaults; Space on the upstream row of a both unit includes it; t saves the render", async () => {
  const saved: { resolution: string; edited?: string }[] = []
  const fixture = await mount(paneFor(sides, saved))
  try {
    await fixture.waitForFrame((frame) => frame.includes("Upstream change"))
    expect(send(fixture, "3")).toBe(true)
    const frame = await fixture.waitForFrame((text) => text.includes("yours → merged result"))
    expect(frame).toContain("[x] yours  Alpha mine.")
    expect(frame).toContain("[x] upstream  Gamma upstream.")
    expect(frame).toContain("[x] yours  Epsilon yours.")
    expect(frame).toContain("[ ] upstream (conflicts with yours)  Epsilon upstream.")
    expect(frame).toContain("[x] same  Eta same.")
    expect(frame).not.toContain("<<<<<<<")
    // Merely showing the proposal resolves nothing.
    expect(saved).toEqual([])
    // The cursor starts on the first change row; three ↓ reach the upstream row of Epsilon.
    for (let step = 0; step < 3; step += 1) expect(send(fixture, "down")).toBe(true)
    expect(send(fixture, "space")).toBe(true)
    await fixture.waitForFrame((text) => text.includes("[x] upstream (conflicts with yours)  Epsilon upstream."))
    expect(send(fixture, "t")).toBe(true)
    await waitFor(() => saved.length === 1)
    expect(saved[0]).toEqual({
      resolution: "merge",
      edited: "Alpha mine.\nBeta two.\nGamma upstream.\nDelta four.\nEpsilon yours.\nEpsilon upstream.\nZeta six.\nEta same.\n",
    })
  } finally {
    fixture.destroy()
  }
})

test("u takes upstream outright and k keeps yours", async () => {
  const saved: { resolution: string; edited?: string }[] = []
  const fixture = await mount(paneFor(sides, saved))
  try {
    await fixture.waitForFrame((frame) => frame.includes("Upstream change"))
    expect(send(fixture, "3")).toBe(true)
    await fixture.waitForFrame((frame) => frame.includes("yours → merged result"))
    expect(send(fixture, "u")).toBe(true)
    await waitFor(() => saved.length === 1)
    expect(saved[0]).toEqual({ resolution: "take", edited: undefined })
    expect(send(fixture, "k")).toBe(true)
    await waitFor(() => saved.length === 2)
    expect(saved[1]).toEqual({ resolution: "keep", edited: undefined })
  } finally {
    fixture.destroy()
  }
})

test("t saves a merge that equals upstream as take", async () => {
  const saved: { resolution: string; edited?: string }[] = []
  const fixture = await mount(paneFor(sides, saved))
  try {
    await fixture.waitForFrame((frame) => frame.includes("Upstream change"))
    expect(send(fixture, "3")).toBe(true)
    await fixture.waitForFrame((frame) => frame.includes("yours → merged result"))
    // Exclude yours on Alpha; on Epsilon exclude yours and include upstream: the render is upstream.
    expect(send(fixture, "space")).toBe(true)
    for (let step = 0; step < 2; step += 1) expect(send(fixture, "down")).toBe(true)
    expect(send(fixture, "space")).toBe(true)
    expect(send(fixture, "down")).toBe(true)
    expect(send(fixture, "space")).toBe(true)
    expect(send(fixture, "t")).toBe(true)
    await waitFor(() => saved.length === 1)
    expect(saved[0]).toEqual({ resolution: "take", edited: undefined })
  } finally {
    fixture.destroy()
  }
})

test("e opens the editor on the rendered text the include set makes", async () => {
  const saved: { resolution: string; edited?: string }[] = []
  const fixture = await mount(paneFor(sides, saved))
  try {
    await fixture.waitForFrame((frame) => frame.includes("Upstream change"))
    expect(send(fixture, "3")).toBe(true)
    await fixture.waitForFrame((frame) => frame.includes("yours → merged result"))
    // Exclude yours on Epsilon: the both unit then renders its base.
    for (let step = 0; step < 2; step += 1) expect(send(fixture, "down")).toBe(true)
    expect(send(fixture, "space")).toBe(true)
    expect(send(fixture, "e")).toBe(true)
    await fixture.waitForFrame((frame) => frame.includes("ctrl+s save"))
    expect(fixture.renderer.currentFocusedEditor?.plainText).toBe(
      "Alpha mine.\nBeta two.\nGamma upstream.\nDelta four.\nEpsilon five.\nZeta six.\nEta same.\n",
    )
    expect(saved).toEqual([])
    expect(send(fixture, "ctrl+s")).toBe(true)
    await waitFor(() => saved.length === 1)
    expect(saved[0]).toEqual({
      resolution: "edit",
      edited: "Alpha mine.\nBeta two.\nGamma upstream.\nDelta four.\nEpsilon five.\nZeta six.\nEta same.\n",
    })
  } finally {
    fixture.destroy()
  }
})

test("the Take result keys are named in the footer", async () => {
  const fixture = await mount(paneFor(sides, []))
  try {
    await fixture.waitForFrame((frame) => frame.includes("Upstream change"))
    expect(send(fixture, "3")).toBe(true)
    const frame = await fixture.waitForFrame((text) => text.includes("space"))
    expect(frame).toContain("u")
    expect(frame).toContain("take upstream")
    expect(frame).toContain("save merged")
  } finally {
    fixture.destroy()
  }
})
