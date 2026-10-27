export * as ToolOutput from "./tool-output.js"

import path from "path"
import type { Tool } from "./tool.js"
import { Context, Duration, Effect, Layer, Schedule } from "effect"
import { makeGlobalNode, makeLocationNode } from "@opencode/util/effect/app-node"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Identifier } from "@opencode/schema/identifier"
import { FileRetention } from "./file-retention.js"
import { State } from "./state.js"

export const MAX_LINES = 2_000
export const MAX_BYTES = 50 * 1024 // 50 KiB
/** A result that bounded itself still gets cut above this, in case its own limit was huge. */
export const SELF_BOUNDED_MAX_BYTES = 256 * 1024
export const RETENTION = Duration.days(7)
export const DIRECTORY = "tool-output"

export const fileName = (timestamp?: number) => "tool_" + Identifier.create(false, timestamp)

type Result = Tool.NormalizedResult

type Limits = {
  maxLines: number
  maxBytes: number
}

export type Editor = {
  configure: (limits: Partial<Limits>) => void
}

export interface Interface extends State.Transformable<Editor> {
  readonly truncate: (result: Result) => Effect.Effect<Result>
  /** Bounds bare text, such as a tool failure message, the same way tool output is bounded. */
  readonly truncateText: (text: string) => Effect.Effect<string>
  readonly cleanup: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ToolOutput") {}

const cleanup = Effect.fn("ToolOutput.cleanup")(function* (fs: FSUtil.Interface, directory: string) {
  const entries = yield* fs.readDirectory(directory).pipe(
    Effect.map((entries) => entries.filter((entry) => /^tool_[0-9a-f]{12}/.test(entry))),
    Effect.orElseSucceed(() => []),
  )
  yield* FileRetention.cleanup(
    fs,
    entries.map((entry) => path.join(directory, entry)),
    RETENTION,
  )
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const directory = path.join(global.data, DIRECTORY)
    const state = State.create<Limits, Editor>({
      name: "tool-output",
      initial: () => ({ maxLines: MAX_LINES, maxBytes: MAX_BYTES }),
      editor: (editor) => ({
        configure: (limits) => {
          if (limits.maxLines !== undefined) editor.maxLines = limits.maxLines
          if (limits.maxBytes !== undefined) editor.maxBytes = limits.maxBytes
        },
      }),
    })

    const exceeds = (text: string, limits: Limits) => {
      const lines = text.split("\n")
      if (text.endsWith("\n")) lines.pop()
      return lines.length > limits.maxLines || Buffer.byteLength(text, "utf-8") > limits.maxBytes
    }

    // Saves the full text and keeps its head; `truncate` and `truncateText` share the cut.
    const bound = Effect.fnUntraced(function* (text: string, limits: Limits) {
      const lines = text.split("\n")
      if (text.endsWith("\n")) lines.pop()
      const kept: string[] = []
      let bytes = 0
      for (const line of lines.slice(0, limits.maxLines)) {
        const size = Buffer.byteLength(line, "utf-8") + (kept.length > 0 ? 1 : 0)
        if (bytes + size > limits.maxBytes) break
        kept.push(line)
        bytes += size
      }
      // A first line over the byte limit (one long JSON value) still shows its start
      // instead of nothing.
      const cut = kept.length === 0 && lines[0] !== undefined
      if (cut) kept.push(Buffer.from(lines[0]!, "utf-8").subarray(0, limits.maxBytes).toString("utf-8").replace(/\uFFFD$/, ""))
      const file = path.join(directory, fileName())
      yield* fs.ensureDir(directory).pipe(Effect.orDie)
      yield* fs.writeFileString(file, text).pipe(Effect.orDie)
      const shown = cut ? `the first ${limits.maxBytes} bytes of line 1` : `lines 1-${kept.length}`
      return {
        text: kept.join("\n"),
        marker: `[showing ${shown} of ${lines.length}; full output saved to ${file}]`,
        file,
      }
    })

    const truncate = Effect.fnUntraced(function* (result: Result) {
      const content = result.content
      const text = content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n")
      const limits = state.get()
      const selfBounded = result.metadata?.truncated !== undefined
      // Read pages stay at most 50 KiB and shell bounds itself at maxBytes, so only a tool
      // whose own limit was set huge reaches this ceiling.
      if (selfBounded && Buffer.byteLength(text, "utf-8") <= Math.max(SELF_BOUNDED_MAX_BYTES, 2 * limits.maxBytes)) return result
      if (!selfBounded && !exceeds(text, limits)) return { ...result, metadata: { ...result.metadata, truncated: false } }

      const bounded = yield* bound(text, limits)
      const marker = bounded.marker
      const head: Tool.Content[] = []
      let remaining = bounded.text.length
      let seenText = false
      let marked = false
      for (const item of content) {
        if (item.type === "file") {
          head.push(item)
          continue
        }
        if (seenText && remaining > 0) remaining--
        seenText = true
        if (remaining >= item.text.length) {
          head.push(item)
          remaining -= item.text.length
          continue
        }
        if (remaining > 0) head.push({ ...item, text: item.text.slice(0, remaining) })
        if (!marked) head.push({ type: "text", text: marker })
        remaining = 0
        marked = true
      }
      if (!marked) head.push({ type: "text", text: marker })
      return {
        ...result,
        content: head,
        metadata: { ...result.metadata, truncated: true, outputPath: bounded.file },
      }
    })

    return Service.of({
      transform: state.transform,
      reload: state.reload,
      truncate,
      truncateText: Effect.fnUntraced(function* (text: string) {
        const limits = state.get()
        if (!exceeds(text, limits)) return text
        const bounded = yield* bound(text, limits)
        return `${bounded.text}\n${bounded.marker}`
      }),
      cleanup: () => cleanup(fs, directory),
    })
  }),
)

const cleanupLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    yield* cleanup(fs, path.join(global.data, DIRECTORY)).pipe(
      Effect.repeat(Schedule.spaced(Duration.hours(1))),
      Effect.forkScoped,
    )
  }),
)

const cleanupNode = makeGlobalNode({
  name: "tool-output-cleanup",
  layer: cleanupLayer,
  deps: [FSUtil.node, Global.node],
})

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [FSUtil.node, Global.node, cleanupNode],
})
