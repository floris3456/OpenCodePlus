import { createTestRenderer } from "@opentui/core/testing"
import { render, type JSX } from "@opentui/solid"
import type { Plugin } from "@opencode/plugin/tui"
import { expect, test } from "bun:test"
import { unifiedDiff } from "../src/instructions/diff-lines.js"
import { DiffPane } from "../src/tui/instructions/diff-pane.js"
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
  readonly flush: () => Promise<void>
  readonly destroy: () => void
}

const OPEN_MARKER = "<<<<<<< yours"
const SEPARATOR_MARKER = "======="
const CLOSE_MARKER = ">>>>>>> upstream"

// Self-contained mount: only theme + keymap, no route/state/backend imports.
async function mount(
  element: (context: Plugin.Context) => JSX.Element,
  size?: { width?: number; height?: number },
): Promise<Fixture> {
  const output = await createTestRenderer({
    width: size?.width ?? 130,
    height: size?.height ?? 24,
    remote: true,
    useThread: false,
  })
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
    flush: () => output.flush(),
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

/** Pages down until the marker is visible, returning every frame seen on the way. */
async function scrollUntil(fixture: Fixture, marker: string): Promise<string[]> {
  const frames = [fixture.captureCharFrame()]
  for (let step = 0; step < 20 && !frames[frames.length - 1]!.includes(marker); step++) {
    expect(send(fixture, "pagedown")).toBe(true)
    await fixture.flush()
    frames.push(fixture.captureCharFrame())
  }
  return frames
}

async function scrollToTop(fixture: Fixture): Promise<void> {
  for (let step = 0; step < 20; step++) {
    expect(send(fixture, "pageup")).toBe(true)
    await fixture.flush()
  }
}

const TOTAL_LINES = 120
const numbered = (line: number) => `line${String(line).padStart(3, "0")}`
const sourceLines = Array.from({ length: TOTAL_LINES }, (_, index) => numbered(index + 1))
const mineLines = sourceLines.map((text, index) => {
  const line = index + 1
  return line === 11 || (line >= 40 && line <= 90) ? `MINE ${numbered(line)}` : text
})
const upstreamLines = sourceLines.map((text, index) => (index + 1 === 100 ? `UPSTREAM ${numbered(100)}` : text))

/** The reproduction text: `mine` changes lines 11 and 40-90, `upstream` line 100. */
const reviewText = {
  original: sourceLines.join("\n") + "\n",
  mine: mineLines.join("\n") + "\n",
  upstream: upstreamLines.join("\n") + "\n",
}

/** Every content line either side of a comparison can show. */
function expectedLinesOf(tab: number): string[] {
  if (tab === 1) return [...sourceLines, ...upstreamLines]
  if (tab === 2) return [...sourceLines, ...mineLines]
  return [...mineLines, ...upstreamLines]
}

async function selectTab(fixture: Fixture, tab: number): Promise<void> {
  expect(send(fixture, String(tab))).toBe(true)
  await fixture.flush()
}

test("each review comparison renders both sides in full, far from the changes", async () => {
  const fixture = await mount((context) => (
    <DiffPane context={context} title="Long item" threeWay={reviewText} active={() => true} onResolve={async () => {}} />
  ))
  try {
    await fixture.waitForFrame((frame) => frame.includes("Upstream change"))
    for (let tab = 1; tab <= 3; tab++) {
      if (tab > 1) await selectTab(fixture, tab)
      await scrollToTop(fixture)
      expect(fixture.captureCharFrame()).toContain("line001")
      const frames = await scrollUntil(fixture, "line120")
      expect(frames[frames.length - 1]).toContain("line120")
      const rendered = frames.join("\n")
      expect(rendered).toContain("line060")
      const missing = expectedLinesOf(tab).filter((line) => !rendered.includes(line))
      expect(missing).toEqual([])
    }
  } finally {
    fixture.destroy()
  }
})

test("switching comparisons at one scroll offset keeps the unchanged text visible", async () => {
  const fixture = await mount((context) => (
    <DiffPane context={context} title="Long item" threeWay={reviewText} active={() => true} onResolve={async () => {}} />
  ))
  try {
    await fixture.waitForFrame((frame) => frame.includes("Upstream change"))
    const frames = await scrollUntil(fixture, "line060")
    expect(frames[frames.length - 1]).toContain("line060")
    await selectTab(fixture, 2)
    expect(fixture.captureCharFrame()).toContain("line060")
    await selectTab(fixture, 3)
    expect(fixture.captureCharFrame()).toContain("line060")
  } finally {
    fixture.destroy()
  }
})

test("narrow unified mode is complete for every comparison and v still toggles", async () => {
  const fixture = await mount(
    (context) => <DiffPane context={context} title="Long item" threeWay={reviewText} active={() => true} onResolve={async () => {}} />,
    { width: 100, height: 30 },
  )
  try {
    await fixture.waitForFrame((frame) => frame.includes("Upstream change"))
    const unified = fixture.captureCharFrame()
    expect(send(fixture, "v")).toBe(true)
    await fixture.flush()
    expect(fixture.captureCharFrame()).not.toBe(unified)
    expect(send(fixture, "v")).toBe(true)
    await fixture.flush()
    expect(fixture.captureCharFrame()).toBe(unified)
    for (let tab = 1; tab <= 3; tab++) {
      if (tab > 1) await selectTab(fixture, tab)
      await scrollToTop(fixture)
      expect(fixture.captureCharFrame()).toContain("line001")
      const frames = await scrollUntil(fixture, "line120")
      expect(frames[frames.length - 1]).toContain("line120")
      const rendered = frames.join("\n")
      const missing = expectedLinesOf(tab).filter((line) => !rendered.includes(line))
      expect(missing).toEqual([])
    }
  } finally {
    fixture.destroy()
  }
})

test("a long line wraps in narrow unified mode with its tail visible", async () => {
  const longLine = "long ".repeat(64) + "TAIL"
  const text = { original: `start\n${longLine}\nend\n`, mine: `start\n${longLine}\nend mine\n`, upstream: `start\n${longLine}\nend upstream\n` }
  const fixture = await mount(
    (context) => <DiffPane context={context} title="Wrapped item" threeWay={text} active={() => true} onResolve={async () => {}} />,
    { width: 100, height: 30 },
  )
  try {
    await fixture.waitForFrame((frame) => frame.includes("Upstream change"))
    const frame = fixture.captureCharFrame()
    expect(frame).toContain("start")
    expect(frame).toContain("TAIL")
    expect(frame).not.toContain("Error parsing diff")
  } finally {
    fixture.destroy()
  }
})

test("text without a final newline renders its last line in every comparison", async () => {
  const text = { original: "alpha\nbeta", mine: "alpha\nBETA", upstream: "ALPHA\nbeta" }
  const fixture = await mount((context) => (
    <DiffPane context={context} title="No newline" threeWay={text} active={() => true} onResolve={async () => {}} />
  ))
  try {
    await fixture.waitForFrame((frame) => frame.includes("Upstream change"))
    expect(fixture.captureCharFrame()).toContain("beta")
    await selectTab(fixture, 2)
    expect(fixture.captureCharFrame()).toContain("BETA")
    await selectTab(fixture, 3)
    const frame = fixture.captureCharFrame()
    expect(frame).toContain("BETA")
    expect(frame).toContain("beta")
    expect(frame).not.toContain("Error parsing diff")
  } finally {
    fixture.destroy()
  }
})

test("literal conflict-marker content renders completely in every comparison", async () => {
  const original = `top\n${OPEN_MARKER}\nmiddle\n${SEPARATOR_MARKER}\nbottom\n${CLOSE_MARKER}\ntail\n`
  const text = {
    original,
    mine: original.replace("middle", "middle mine"),
    upstream: original.replace("bottom", "bottom upstream"),
  }
  const fixture = await mount(
    (context) => <DiffPane context={context} title="Marked item" threeWay={text} active={() => true} onResolve={async () => {}} />,
    { height: 30 },
  )
  try {
    await fixture.waitForFrame((frame) => frame.includes("Upstream change"))
    for (let tab = 1; tab <= 3; tab++) {
      if (tab > 1) await selectTab(fixture, tab)
      const frame = fixture.captureCharFrame()
      expect(frame).toContain(OPEN_MARKER)
      expect(frame).toContain(SEPARATOR_MARKER)
      expect(frame).toContain(CLOSE_MARKER)
      expect(frame).toContain("tail")
      expect(frame).not.toContain("Error parsing diff")
    }
  } finally {
    fixture.destroy()
  }
})

test("a complete patch with marker-like content mounts in the raw diff renderer", async () => {
  const lines = Array.from({ length: 30 }, (_, index) => numbered(index + 1))
  lines[4] = OPEN_MARKER
  lines[5] = SEPARATOR_MARKER
  lines[6] = CLOSE_MARKER
  const original = lines.join("\n") + "\n"
  const modified = lines.map((text, index) => (index === 2 || index === 25 ? `edited ${text}` : text)).join("\n") + "\n"
  const patch = unifiedDiff(original, modified, { from: "a", to: "b" }, { context: Number.POSITIVE_INFINITY })
  const fixture = await mount(
    (context) => (
      <box flexDirection="column" width="100%" height="100%">
        <diff diff={patch} view="unified" showLineNumbers={true} width="100%" wrapMode="word" fg={context.theme.text.base} />
      </box>
    ),
    { width: 120, height: 44 },
  )
  try {
    const frame = await fixture.waitForFrame((next) => next.includes("line001"))
    expect(frame).not.toContain("Error parsing diff")
    const missing = [...lines, "edited line003", "edited line026"].filter((line) => !frame.includes(line))
    expect(missing).toEqual([])
  } finally {
    fixture.destroy()
  }
})