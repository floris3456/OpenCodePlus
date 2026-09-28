import { createTestRenderer } from "@opentui/core/testing"
import { render, type JSX } from "@opentui/solid"
import type { Plugin } from "@opencode/plugin/tui"
import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { manual } from "../src/instructions/sections.js"
import { DiffPane } from "../src/tui/instructions/diff-pane.js"
import { Splitter } from "../src/tui/instructions/splitter.js"
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
  function destroy() {
    if (!output.renderer.isDestroyed) output.renderer.destroy()
  }
  return {
    renderer: output.renderer,
    commands: () => [...layers].reverse().flatMap((fn) => fn().commands ?? []),
    captureCharFrame: () => output.captureCharFrame(),
    waitForFrame: (predicate) => output.waitForFrame(predicate),
    destroy,
  }
}

function send(fixture: Fixture, key: string): boolean {
  for (const cmd of fixture.commands()) {
    if (typeof cmd.bind === "string" && cmd.bind.split(",").includes(key)) {
      cmd.run()
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

const threeWay = {
  original: "original upstream text",
  mine: "my customized text",
  upstream: "new upstream text",
}

test("diff pane renders each comparison as a real diff", async () => {
  const fixture = await mount((context) => (
    <DiffPane context={context} title="Demo item" threeWay={threeWay} active={() => true} onResolve={async () => {}} />
  ))
  try {
    await fixture.waitForFrame((frame) => frame.includes("Upstream change"))
    const first = fixture.captureCharFrame()
    expect(first).toContain("Upstream change")
    expect(first).toContain("Your change")
    expect(first).toContain("Take result")
    // 1: original upstream → new upstream, both lines of the diff.
    expect(first).toContain("original upstream → new upstream")
    expect(first).toContain("original upstream text")
    expect(first).toContain("new upstream text")
    expect(first).not.toContain("my customized text")
    // 2: original upstream → yours.
    expect(send(fixture, "2")).toBe(true)
    await fixture.waitForFrame((frame) => frame.includes("my customized text"))
    expect(fixture.captureCharFrame()).toContain("original upstream → yours")
    // 3: yours → merged result, the three-way merge take would accept. Both
    // sides changed the same line, so the proposal carries conflict markers.
    expect(send(fixture, "3")).toBe(true)
    await fixture.waitForFrame((frame) => frame.includes("yours → merged result"))
    expect(fixture.captureCharFrame()).toContain("my customized text")
    expect(fixture.captureCharFrame()).toContain("new upstream text")
    expect(fixture.captureCharFrame()).toContain("<<<<<<< yours")
    expect(fixture.captureCharFrame()).toContain("needs review")
  } finally {
    fixture.destroy()
  }
})

test("a compare that is not a review shows your change only and offers no keep or take", async () => {
  const fixture = await mount((context) => (
    <DiffPane
      context={context}
      title="Demo item"
      threeWay={{ original: "same upstream", mine: "my text", upstream: "same upstream" }}
      review={false}
      active={() => true}
      onResolve={async () => {}}
    />
  ))
  try {
    await fixture.waitForFrame((frame) => frame.includes("Your change"))
    const frame = fixture.captureCharFrame()
    expect(frame).not.toContain("Upstream change")
    expect(frame).toContain("compare")
    expect(frame).toContain("my text")
    expect(fixture.commands().some((cmd) => cmd.bind === "k")).toBe(false)
    expect(fixture.commands().some((cmd) => cmd.bind === "t")).toBe(false)
  } finally {
    fixture.destroy()
  }
})

test("diff pane resolution callbacks fire for keep and a clean take result", async () => {
  const seen: { resolution: string; edited?: string }[] = []
  const fixture = await mount((context) => (
    <DiffPane
      context={context}
      title="Demo item"
      threeWay={{ original: "one\ntwo\n", mine: "one\ntwo mine\n", upstream: "one upstream\ntwo\n" }}
      active={() => true}
      onResolve={async (resolution, edited) => {
        seen.push({ resolution, edited })
      }}
    />
  ))
  try {
    await fixture.waitForFrame((frame) => frame.includes("Upstream change"))
    expect(send(fixture, "k")).toBe(true)
    expect(send(fixture, "t")).toBe(true)
    await waitFor(() => seen.length === 2)
    // A clean merge persists the merged text, not raw upstream.
    expect(seen).toEqual([
      { resolution: "keep", edited: undefined },
      { resolution: "merge", edited: "one upstream\ntwo mine\n" },
    ])
  } finally {
    fixture.destroy()
  }
})

test("diff pane edit starts from the upstream change merged onto yours and saves on ctrl+s", async () => {
  const saved: { resolution: string; edited?: string }[] = []
  const fixture = await mount((context) => (
    <DiffPane
      context={context}
      title="Demo item"
      threeWay={{ original: "alpha\nbeta\n", mine: "alpha\nBETA mine\n", upstream: "ALPHA upstream\nbeta\n" }}
      active={() => true}
      onResolve={async (resolution, edited) => {
        saved.push({ resolution, edited })
      }}
    />
  ))
  try {
    await fixture.waitForFrame((frame) => frame.includes("Upstream change"))
    expect(send(fixture, "e")).toBe(true)
    await fixture.waitForFrame((frame) => frame.includes("ctrl+s save"))
    const editor = fixture.renderer.currentFocusedEditor
    expect(editor?.plainText).toBe("ALPHA upstream\nBETA mine\n")
    expect(send(fixture, "ctrl+s")).toBe(true)
    await waitFor(() => saved.length === 1)
    expect(saved[0]).toEqual({ resolution: "edit", edited: "ALPHA upstream\nBETA mine\n" })
  } finally {
    fixture.destroy()
  }
})

test("diff pane marks conflicting changes and refuses to save while markers remain", async () => {
  const saved: { resolution: string; edited?: string }[] = []
  const fixture = await mount((context) => (
    <DiffPane
      context={context}
      title="Demo item"
      threeWay={threeWay}
      active={() => true}
      onResolve={async (resolution, edited) => {
        saved.push({ resolution, edited })
      }}
    />
  ))
  try {
    await fixture.waitForFrame((frame) => frame.includes("Upstream change"))
    expect(send(fixture, "e")).toBe(true)
    await fixture.waitForFrame((frame) => frame.includes("ctrl+s save"))
    const editor = fixture.renderer.currentFocusedEditor
    expect(editor?.plainText).toBe("<<<<<<< yours\nmy customized text\n=======\nnew upstream text\n>>>>>>> upstream")
    expect(fixture.captureCharFrame()).toContain("1 conflicting region")
    expect(send(fixture, "ctrl+s")).toBe(true)
    await fixture.waitForFrame((frame) => frame.includes("Conflict markers remain"))
    expect(saved).toEqual([])
    editor?.setText("merged resolution text")
    expect(send(fixture, "ctrl+s")).toBe(true)
    await waitFor(() => saved.length === 1)
    expect(saved[0]).toEqual({ resolution: "edit", edited: "merged resolution text" })
  } finally {
    fixture.destroy()
  }
})

test("diff pane registers no route keys while inactive", async () => {
  const [active, setActive] = createSignal(true)
  const fixture = await mount((context) => (
    <DiffPane context={context} title="Demo item" threeWay={threeWay} active={active} onResolve={async () => {}} />
  ))
  try {
    await fixture.waitForFrame((frame) => frame.includes("Upstream change"))
    expect(fixture.commands().some((cmd) => cmd.bind === "k")).toBe(true)
    setActive(false)
    await waitFor(() => !fixture.commands().some((cmd) => cmd.bind === "k"))
    expect(fixture.commands().some((cmd) => cmd.bind === "e")).toBe(false)
  } finally {
    fixture.destroy()
  }
})

test("diff pane escape cancels editing without saving", async () => {
  let saves = 0
  const fixture = await mount((context) => (
    <DiffPane
      context={context}
      title="Demo item"
      threeWay={threeWay}
      active={() => true}
      onResolve={async () => {
        saves += 1
      }}
    />
  ))
  try {
    await fixture.waitForFrame((frame) => frame.includes("Upstream change"))
    expect(send(fixture, "e")).toBe(true)
    await fixture.waitForFrame((frame) => frame.includes("ctrl+s save"))
    expect(send(fixture, "escape")).toBe(true)
    await fixture.waitForFrame((frame) => frame.includes("k keep mine"))
    expect(saves).toBe(0)
    expect(fixture.captureCharFrame()).toContain("new upstream text")
  } finally {
    fixture.destroy()
  }
})

test("splitter saves two named section boundaries compatible with manual()", async () => {
  const text = "Purpose tells when.\n\nQuoting details here.\n"
  const saved: { name: string; start: number }[][] = []
  const fixture = await mount((context) => (
    <Splitter
      context={context}
      title="Bash tool"
      text={text}
      active={() => true}
      onSave={async (boundaries) => {
        saved.push(boundaries.map((boundary) => ({ name: boundary.name, start: boundary.start })))
      }}
    />
  ))
  try {
    await fixture.waitForFrame((frame) => frame.includes("split into sections"))
    expect(send(fixture, "b")).toBe(true)
    await fixture.waitForFrame((frame) => frame.includes("Name section"))
    const first = fixture.renderer.currentFocusedEditor
    expect(first).toBeDefined()
    first?.setText("Purpose")
    expect(send(fixture, "ctrl+s")).toBe(true)
    await fixture.waitForFrame((frame) => frame.includes("Purpose") && !frame.includes("Name section"))

    expect(send(fixture, "down")).toBe(true)
    expect(send(fixture, "down")).toBe(true)
    expect(send(fixture, "b")).toBe(true)
    await fixture.waitForFrame((frame) => frame.includes("Name section"))
    const second = fixture.renderer.currentFocusedEditor
    expect(second).toBeDefined()
    second?.setText("Quoting and preference")
    expect(send(fixture, "ctrl+s")).toBe(true)
    await fixture.waitForFrame((frame) => frame.includes("Quoting and preference"))

    const preview = fixture.captureCharFrame()
    expect(preview).toContain("Purpose")
    expect(preview).toContain("Quoting and preference")
    expect(send(fixture, "ctrl+s")).toBe(true)
    await waitFor(() => saved.length === 1)
    expect(saved[0]).toHaveLength(2)
    expect(saved[0]?.[0]?.start).toBe(0)
    expect(saved[0]?.[1]?.start).toBe(text.indexOf("Quoting"))
    const split = manual(
      text,
      (saved[0] ?? []).map((entry, index) => ({ id: `s${index}`, ...entry })),
    )
    expect(split.kind).toBe("manual")
    expect(split.sections.map((section) => section.name)).toEqual(["Purpose", "Quoting and preference"])
  } finally {
    fixture.destroy()
  }
})

test("diff pane shows visible keep take edit labels", async () => {
  const fixture = await mount((context) => (
    <DiffPane context={context} title="Demo item" threeWay={threeWay} active={() => true} onResolve={async () => {}} />
  ))
  try {
    await fixture.waitForFrame((frame) => frame.includes("keep mine"))
    const frame = fixture.captureCharFrame()
    expect(frame).toContain("k keep mine")
    expect(frame).toContain("t take merged")
    expect(frame).toContain("e edit merged")
  } finally {
    fixture.destroy()
  }
})

test("splitter save builds sections.manual-compatible boundaries", async () => {  const text = "Alpha line.\n\nBeta line.\n"
  const saved: { id: string; name: string; start: number }[][] = []
  const fixture = await mount((context) => (
    <Splitter
      context={context}
      title="Sample"
      text={text}
      active={() => true}
      onSave={async (boundaries) => {
        saved.push(boundaries.map((boundary) => ({ ...boundary })))
      }}
    />
  ))
  try {
    await fixture.waitForFrame((frame) => frame.includes("split into sections"))
    expect(send(fixture, "b")).toBe(true)
    await fixture.waitForFrame((frame) => frame.includes("Name section"))
    fixture.renderer.currentFocusedEditor?.setText("Alpha")
    expect(send(fixture, "ctrl+s")).toBe(true)
    await fixture.waitForFrame((frame) => frame.includes("Alpha") && !frame.includes("Name section"))
    expect(send(fixture, "down")).toBe(true)
    expect(send(fixture, "down")).toBe(true)
    expect(send(fixture, "b")).toBe(true)
    await fixture.waitForFrame((frame) => frame.includes("Name section"))
    fixture.renderer.currentFocusedEditor?.setText("Beta")
    expect(send(fixture, "ctrl+s")).toBe(true)
    await fixture.waitForFrame((frame) => frame.includes("Beta"))
    expect(send(fixture, "ctrl+s")).toBe(true)
    await waitFor(() => saved.length === 1)
    // sections.manual sorts by start and names each slice from its boundary.
    const split = manual(text, saved[0] ?? [])
    expect(split.kind).toBe("manual")
    expect(split.sections.map((section) => section.name)).toEqual(["Alpha", "Beta"])
  } finally {
    fixture.destroy()
  }
})
