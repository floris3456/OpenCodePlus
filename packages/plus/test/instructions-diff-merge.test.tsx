// The Take result is a real three-way merge proposal: comparison 3 shows
// yours → merged result, `t` accepts it (clean merge), fast-forwards when the
// merge equals upstream, and refuses to auto-resolve a conflicted proposal.
// `e` opens the identical proposal.
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

// Mine appended a custom tail; upstream changed the middle line: no overlap.
const clean = {
  original: "one\ntwo\nthree\n",
  mine: "one\ntwo\nthree\ncustom tail\n",
  upstream: "one\ntwo upstream\nthree\n",
}
const cleanMerged = "one\ntwo upstream\nthree\ncustom tail\n"

// Mine and upstream changed the same middle line; mine still appended a tail.
const conflicted = {
  original: "one\ntwo\nthree\n",
  mine: "one\nmine two\nthree\ncustom tail\n",
  upstream: "one\nupstream two\nthree\n",
}
const conflictedMerged = "one\n<<<<<<< yours\nmine two\n=======\nupstream two\n>>>>>>> upstream\nthree\ncustom tail\n"

test("comparisonsOf Take result contains the clean changes of both sides", () => {
  const comparisons = comparisonsOf(clean, true)
  expect(comparisons.map((comparison) => comparison.label)).toEqual(["Upstream change", "Your change", "Take result"])
  const take = comparisons[2]
  if (take === undefined) throw new Error("missing Take result")
  expect(take.from).toBe("yours")
  expect(take.to).toBe("merged result")
  expect(take.left).toBe(clean.mine)
  expect(take.right).toBe(cleanMerged)
  expect(take.right).toContain("custom tail")
  expect(take.right).toContain("two upstream")
  expect(take.merged).toEqual({ text: cleanMerged, conflicts: 0 })
})

test("comparisonsOf keeps markers only around the conflicting region", () => {
  const take = comparisonsOf(conflicted, true)[2]
  if (take === undefined) throw new Error("missing Take result")
  expect(take.right).toBe(conflictedMerged)
  expect(take.merged?.conflicts).toBe(1)
  // The clean appended text survives; only the overlap is fenced.
  expect(take.right).toContain("custom tail")
  expect(take.right.split("<<<<<<< yours")).toHaveLength(2)
})

test("Take result shows yours → merged result and t accepts a clean merge", async () => {
  const saved: { resolution: string; edited?: string }[] = []
  const fixture = await mount((context) => (
    <DiffPane
      context={context}
      title="Demo item"
      threeWay={clean}
      active={() => true}
      onResolve={async (resolution, edited) => {
        saved.push({ resolution, edited })
      }}
    />
  ))
  try {
    await fixture.waitForFrame((frame) => frame.includes("Upstream change"))
    expect(send(fixture, "3")).toBe(true)
    await fixture.waitForFrame((frame) => frame.includes("yours → merged result"))
    // Merely computing and showing the merge resolves nothing.
    expect(saved).toEqual([])
    const frame = fixture.captureCharFrame()
    expect(frame).toContain("custom tail")
    expect(frame).toContain("two upstream")
    expect(frame).toContain("needs review")
    expect(send(fixture, "t")).toBe(true)
    await waitFor(() => saved.length === 1)
    expect(saved[0]).toEqual({ resolution: "merge", edited: cleanMerged })
  } finally {
    fixture.destroy()
  }
})

test("t fast-forwards when the merged result equals upstream, but only after t", async () => {
  const saved: { resolution: string; edited?: string }[] = []
  const fixture = await mount((context) => (
    <DiffPane
      context={context}
      title="Demo item"
      threeWay={{ original: "one\ntwo\n", mine: "one\ntwo\n", upstream: "one\ntwo upstream\n" }}
      active={() => true}
      onResolve={async (resolution, edited) => {
        saved.push({ resolution, edited })
      }}
    />
  ))
  try {
    await fixture.waitForFrame((frame) => frame.includes("Upstream change"))
    // The review stays until t is pressed.
    expect(fixture.captureCharFrame()).toContain("needs review")
    expect(saved).toEqual([])
    expect(send(fixture, "t")).toBe(true)
    await waitFor(() => saved.length === 1)
    expect(saved[0]).toEqual({ resolution: "take", edited: undefined })
  } finally {
    fixture.destroy()
  }
})

test("t on a conflicted proposal opens the merged editor and resolves nothing automatically", async () => {
  const saved: { resolution: string; edited?: string }[] = []
  const fixture = await mount((context) => (
    <DiffPane
      context={context}
      title="Demo item"
      threeWay={conflicted}
      active={() => true}
      onResolve={async (resolution, edited) => {
        saved.push({ resolution, edited })
      }}
    />
  ))
  try {
    await fixture.waitForFrame((frame) => frame.includes("Upstream change"))
    expect(send(fixture, "t")).toBe(true)
    await fixture.waitForFrame((frame) => frame.includes("ctrl+s save"))
    const editor = fixture.renderer.currentFocusedEditor
    expect(editor?.plainText).toBe(conflictedMerged)
    const notice = fixture.captureCharFrame()
    expect(notice).toContain("1 conflicting region")
    expect(notice).toContain("cannot be applied automatically")
    expect(saved).toEqual([])
    // Failure control: saving the markers is refused; zero mutations.
    expect(send(fixture, "ctrl+s")).toBe(true)
    await fixture.waitForFrame((frame) => frame.includes("Conflict markers remain"))
    expect(saved).toEqual([])
    editor?.setText("one\nresolved two\nthree\ncustom tail\n")
    expect(send(fixture, "ctrl+s")).toBe(true)
    await waitFor(() => saved.length === 1)
    expect(saved[0]).toEqual({ resolution: "edit", edited: "one\nresolved two\nthree\ncustom tail\n" })
  } finally {
    fixture.destroy()
  }
})

test("e opens the identical proposal comparison 3 shows", async () => {
  const expected = comparisonsOf(conflicted, true)[2]?.right
  expect(expected).toBe(conflictedMerged)
  const fixture = await mount((context) => (
    <DiffPane context={context} title="Demo item" threeWay={conflicted} active={() => true} onResolve={async () => {}} />
  ))
  try {
    await fixture.waitForFrame((frame) => frame.includes("Upstream change"))
    expect(send(fixture, "e")).toBe(true)
    await fixture.waitForFrame((frame) => frame.includes("ctrl+s save"))
    expect(fixture.renderer.currentFocusedEditor?.plainText).toBe(expected)
  } finally {
    fixture.destroy()
  }
})