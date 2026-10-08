import { afterEach, expect, test } from "bun:test"
import { CodeRenderable, MarkdownRenderable, SyntaxStyle } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { batch, createSignal } from "solid-js"
import { holdBackPartialListMarker, streamedText } from "../src/routes/session/message-parts"

const renderers: Awaited<ReturnType<typeof testRender>>["renderer"][] = []
const syntaxStyle = SyntaxStyle.fromStyles({ default: { fg: "#ffffff" } })

afterEach(() => {
  renderers.splice(0).forEach((renderer) => renderer.destroy())
})

test("holdBackPartialListMarker keeps a trailing marker-only line out while streaming", () => {
  expect(holdBackPartialListMarker("41. alpha river\n42. beta river\n4")).toBe("41. alpha river\n42. beta river\n")
  expect(holdBackPartialListMarker("41. alpha river\n  12)")).toBe("41. alpha river\n")
  expect(holdBackPartialListMarker("some text\n- ")).toBe("some text\n")
  expect(holdBackPartialListMarker("some text\n*")).toBe("some text\n")
  expect(holdBackPartialListMarker("some text\n+")).toBe("some text\n")
})

test("holdBackPartialListMarker passes a marker that has grown its text", () => {
  expect(holdBackPartialListMarker("41. alpha river\n42. The")).toBe("41. alpha river\n42. The")
  expect(holdBackPartialListMarker("41. alpha river\n42.")).toBe("41. alpha river\n")
  expect(holdBackPartialListMarker("text without a trailing marker")).toBe("text without a trailing marker")
  expect(holdBackPartialListMarker("1. alpha river\n2. beta river\n\nA closing paragraph.")).toBe(
    "1. alpha river\n2. beta river\n\nA closing paragraph.",
  )
})

test("streamedText holds only a trailing marker line back while streaming", () => {
  const text = "41. alpha river\n42. beta river\n4"
  expect(streamedText(text, true)).toBe("41. alpha river\n42. beta river\n")
  expect(streamedText(text, false)).toBe(text)
  expect(streamedText("41. alpha river\n42. The", true)).toBe("41. alpha river\n42. The")
})

test("draws a completed markdown's text in its first rendered frame", async () => {
  const output = await testRender(
    () => (
      <markdown
        syntaxStyle={syntaxStyle}
        content={"1. alpha river\n2. beta river\n\nA closing paragraph."}
        streaming={false}
        internalBlockMode="top-level"
      />
    ),
    { width: 80, height: 12, remote: true, useThread: false },
  )
  renderers.push(output.renderer)
  await output.renderOnce()

  const frame = output.captureCharFrame()
  expect(frame).toContain("alpha river")
  expect(frame).toContain("A closing paragraph")
})

test.each(["completion-first", "content-first"])("applies final fence text in a Solid batch: %s", async (order) => {
  const [content, setContent] = createSignal("```text\ninitial")
  const [streaming, setStreaming] = createSignal(true)
  const output = await testRender(
    () => (
      <markdown syntaxStyle={syntaxStyle} content={content()} streaming={streaming()} internalBlockMode="top-level" />
    ),
    { width: 80, height: 12, remote: true, useThread: false },
  )
  renderers.push(output.renderer)
  await output.renderOnce()

  batch(() => {
    if (order === "completion-first") setStreaming(false)
    setContent("```text\ninitial final\n```")
    if (order === "content-first") setStreaming(false)
  })
  await output.renderOnce()

  const markdown = output.renderer.root.getChildren()[0]
  expect(markdown).toBeInstanceOf(MarkdownRenderable)
  const block = markdown?.getChildren()[0]
  expect(block).toBeInstanceOf(CodeRenderable)
  if (!(block instanceof CodeRenderable)) throw new Error("Expected a code fence")
  expect(block.content).toBe("initial final")
  expect(markdown?.getChildren()).toHaveLength(1)
})
