import { RGBA } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { render, type JSX } from "@opentui/solid"
import type { Plugin } from "@opencode/plugin/tui"
import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { manual } from "../src/instructions/sections.js"
import { DiffPane } from "../src/tui/instructions/diff-pane.js"
import { Splitter } from "../src/tui/instructions/splitter.js"

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

function createTheme() {
  const white = RGBA.fromHex("#ffffff")
  const black = RGBA.fromHex("#000000")
  const gray = RGBA.fromHex("#888888")
  const yellow = RGBA.fromHex("#ffff00")
  return {
    text: {
      default: white,
      subdued: gray,
      formfield: { default: white, selected: white, focused: white, hovered: white, disabled: gray },
      feedback: {
        info: { default: white, subdued: gray },
        warning: { default: yellow, subdued: gray },
        error: { default: yellow, subdued: gray },
        success: { default: white, subdued: gray },
      },
    },
    background: {
      default: black,
      formfield: { default: black, selected: black, focused: black, hovered: black, disabled: black },
      feedback: {
        info: { default: black },
        warning: { default: black },
        error: { default: black },
        success: { default: black },
      },
    },
  }
}

// Self-contained mount: only theme + keymap, no route/state/backend imports.
async function mount(element: (context: Plugin.Context) => JSX.Element): Promise<Fixture> {
  const output = await createTestRenderer({ width: 120, height: 40, remote: true, useThread: false })
  const layers: Array<() => { commands?: readonly TestCommand[] }> = []
  const rawContext = {
    theme: createTheme(),
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

test("diff pane shows original, yours, and new upstream panes", async () => {
  const fixture = await mount((context) => (
    <DiffPane context={context} title="Demo item" threeWay={threeWay} active={() => true} onResolve={async () => {}} />
  ))
  try {
    await fixture.waitForFrame((frame) => frame.includes("Original upstream"))
    const frame = fixture.captureCharFrame()
    expect(frame).toContain("Original upstream")
    expect(frame).toContain("original upstream text")
    expect(frame).toContain("Yours")
    expect(frame).toContain("my customized text")
    expect(frame).toContain("New upstream")
    expect(frame).toContain("new upstream text")
    expect(frame).toContain("k keep mine")
    expect(frame).toContain("t take new")
    expect(frame).toContain("e edit")
  } finally {
    fixture.destroy()
  }
})

test("diff pane resolution callbacks fire for keep and take", async () => {
  const seen: string[] = []
  const fixture = await mount((context) => (
    <DiffPane
      context={context}
      title="Demo item"
      threeWay={threeWay}
      active={() => true}
      onResolve={async (resolution) => {
        seen.push(resolution)
      }}
    />
  ))
  try {
    await fixture.waitForFrame((frame) => frame.includes("Original upstream"))
    expect(send(fixture, "k")).toBe(true)
    expect(send(fixture, "t")).toBe(true)
    await waitFor(() => seen.length === 2)
    expect(seen).toEqual(["keep", "take"])
  } finally {
    fixture.destroy()
  }
})

test("diff pane edit prefills mine and saves on ctrl+s", async () => {
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
    await fixture.waitForFrame((frame) => frame.includes("Original upstream"))
    expect(send(fixture, "e")).toBe(true)
    await fixture.waitForFrame((frame) => frame.includes("ctrl+s save"))
    const editor = fixture.renderer.currentFocusedEditor
    expect(editor).toBeDefined()
    expect(editor?.plainText).toBe("my customized text")
    editor?.setText("merged resolution text")
    expect(send(fixture, "ctrl+s")).toBe(true)
    await waitFor(() => saved.length === 1)
    expect(saved[0]?.resolution).toBe("edit")
    expect(saved[0]?.edited).toBe("merged resolution text")
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
    await fixture.waitForFrame((frame) => frame.includes("Original upstream"))
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
    await fixture.waitForFrame((frame) => frame.includes("Original upstream"))
    expect(send(fixture, "e")).toBe(true)
    await fixture.waitForFrame((frame) => frame.includes("ctrl+s save"))
    expect(send(fixture, "escape")).toBe(true)
    await fixture.waitForFrame((frame) => frame.includes("k keep mine"))
    expect(saves).toBe(0)
    expect(fixture.captureCharFrame()).toContain("New upstream")
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
    await fixture.waitForFrame((frame) => frame.includes("k keep mine"))
    const frame = fixture.captureCharFrame()
    expect(frame).toContain("k keep mine")
    expect(frame).toContain("t take new")
    expect(frame).toContain("e edit")
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
