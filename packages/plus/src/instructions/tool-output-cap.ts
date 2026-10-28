// A per-agent cap on the text a tool result carries back, set by the
// `setting:tool-output` control row (agent-controls.ts).
//
// Core bounds every finished result at 2 000 lines / 50 KiB after the tool ran
// (core/session/runner/step.ts, core/src/tool-output.ts); that stays as it is.
// This hook runs earlier, in `execute.after`, and saves an oversized text
// result to a file, leaving the model its head and where to read the rest. A
// `read` result is not saved: the file it shows is already on disk, so it keeps
// a head plus the offset that continues it. Skills, Briefs, settlements and
// Instructions arrive whole.
import type { Context } from "@opencode/plugin/effect/plugin"
import type { Registration } from "@opencode/plugin/effect/registration"
import type { Tool } from "@opencode/schema/tool"
import { Global } from "@opencode/util/global"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { CHARS_PER_TOKEN, estimateTokens } from "../monitor/attribution.js"
import { hook } from "./permission-enforce.js"

/** A team member's cap when its row is empty: the owner's default. */
export const DEFAULT_MEMBER_CAP = 10_000
/** Below this a cap would mostly report itself; a smaller value is refused. */
export const MIN_TOOL_OUTPUT_CAP = 1_000

/** Validation at the shared mutation boundary (Tool and TUI both call it). */
export function toolOutputCapError(text: string): string | undefined {
  const value = text.trim()
  if (value === "" || value === "off") return undefined
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < MIN_TOOL_OUTPUT_CAP)
    return `Tool result cap must be an integer of at least ${MIN_TOOL_OUTPUT_CAP}, off, or empty (${DEFAULT_MEMBER_CAP} for team members, no cap otherwise)`
  return undefined
}

/**
 * The cap a row's text sets: a token count, or undefined for no cap. Empty
 * means the member default; on any other agent it means no cap. `off` is none.
 */
export function toolOutputCap(text: string, member: boolean): number | undefined {
  const value = text.trim()
  if (value === "off") return undefined
  if (value === "") return member ? DEFAULT_MEMBER_CAP : undefined
  const cap = Number(value)
  if (!Number.isSafeInteger(cap) || cap < MIN_TOOL_OUTPUT_CAP) return undefined
  return cap
}

/** Results that must reach the model whole: skills, team tools, instructions. */
export function keepsWholeResult(tool: string): boolean {
  return tool === "skill" || tool.startsWith("team_") || tool.startsWith("instructions_")
}

export interface CapTarget {
  readonly tool: string
  readonly input: unknown
  readonly result: Tool.Result
  readonly cap: number
  /** Plus's tmp directory (Global.Path.tmp); files land under `tool-output/`. */
  readonly root: string
  readonly sessionID: string
  readonly callID: string
}

/**
 * Cap one finished result, or undefined when it is under the cap (or carries no
 * text at all). File parts (images, PDFs) are always kept and never counted.
 */
export async function capToolResult(target: CapTarget): Promise<Tool.Result | undefined> {
  const content =
    typeof target.result.content === "string"
      ? [{ type: "text" as const, text: target.result.content }]
      : target.result.content
  if (content === undefined || content.length === 0) return undefined
  const text = content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n")
  if (estimateTokens(text.length) <= target.cap) return undefined
  if (target.tool === "read") return readResult(target, content, text)
  return savedResult(target, content, text)
}

function splitLines(text: string): string[] {
  const lines = text.split("\n")
  if (text.endsWith("\n")) lines.pop()
  return lines
}

// Whole lines from the start, as many as fit in the cap's character budget; a
// first line longer than that is cut at the budget.
function headOfLines(lines: readonly string[], cap: number): string[] {
  const budget = Math.floor(cap * CHARS_PER_TOKEN)
  const kept: string[] = []
  let chars = 0
  for (const line of lines) {
    const size = line.length + (kept.length > 0 ? 1 : 0)
    if (chars + size > budget) break
    kept.push(line)
    chars += size
  }
  if (kept.length === 0 && lines[0] !== undefined) kept.push(lines[0].slice(0, budget))
  return kept
}

// The text parts become the head plus one notice; file parts keep their place.
function withHead(content: ReadonlyArray<Tool.Content>, text: string): Tool.Content[] {
  const replaced: Tool.Content[] = []
  let placed = false
  for (const item of content) {
    if (item.type === "file") {
      replaced.push(item)
      continue
    }
    if (placed) continue
    replaced.push({ type: "text", text })
    placed = true
  }
  if (!placed) replaced.push({ type: "text", text })
  return replaced
}

async function savedResult(target: CapTarget, content: ReadonlyArray<Tool.Content>, text: string): Promise<Tool.Result> {
  const lines = splitLines(text)
  const kept = headOfLines(lines, target.cap)
  const directory = path.join(target.root, safeName(target.sessionID))
  const file = path.join(directory, `${safeName(target.tool)}-${safeName(target.callID)}.txt`)
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(file, text)
  const notice = `[Tool result capped at ${target.cap} tokens (setting:tool-output): showing lines 1-${kept.length} of ${lines.length} (~${estimateTokens(text.length)} tokens). The full result is in ${file}; read it with read({ path: "${file}", offset, limit }) or grep it.]`
  return {
    ...target.result,
    content: withHead(content, `${kept.join("\n")}\n${notice}`),
    metadata: { ...target.result.metadata, truncated: true, outputPath: file, capTokens: target.cap },
  }
}

// Read's page opens with a header ("Read file …, lines A-B"); numbered lines
// follow. The head keeps the header and whole numbered lines, so the notice can
// name the last line shown. A keeps the call's offset, as read numbers it.
function readResult(target: CapTarget, content: ReadonlyArray<Tool.Content>, text: string): Tool.Result {
  const [header, ...body] = splitLines(text)
  const first = offsetOf(target.input)
  const kept = headOfLines(body, target.cap - Math.ceil(((header?.length ?? 0) + 1) / CHARS_PER_TOKEN))
  const last = first + kept.length - 1
  const shown = [...(header === undefined ? [] : [header]), ...kept].join("\n")
  const notice = `[Read capped at ${target.cap} tokens (setting:tool-output): showing lines ${first}-${last}. Continue with read({ path: "${pathOf(target.input)}", offset: ${last + 1}, limit }).]`
  return {
    ...target.result,
    content: withHead(content, `${shown}\n${notice}`),
    metadata: { ...target.result.metadata, truncated: true, capTokens: target.cap },
  }
}

// Read's page starts at 1 when the call gave no positive offset (read numbers
// lines from `offset || 1`).
function offsetOf(input: unknown): number {
  const offset = field(input, "offset")
  return typeof offset === "number" && offset > 0 ? offset : 1
}

function pathOf(input: unknown): string {
  const file = field(input, "path")
  return typeof file === "string" ? file : ""
}

function field(input: unknown, name: string): unknown {
  if (typeof input !== "object" || input === null) return undefined
  return (input as Record<string, unknown>)[name]
}

function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9_.-]/g, "_")
}

/**
 * Install the cap hook. Only called when some agent has one: with no cap there
 * is no hook and no cost.
 */
export async function installToolOutputCap(
  ctx: Context,
  caps: ReadonlyMap<string, number>,
): Promise<Registration | undefined> {
  if (caps.size === 0) return undefined
  return hook(() =>
    ctx.tool.hook("execute.after", (event) =>
      Effect.promise(async () => {
        if (event.status !== "completed" || keepsWholeResult(event.tool)) return
        const cap = caps.get(String(event.agent))
        if (cap === undefined) return
        const capped = await capToolResult({
          tool: event.tool,
          input: event.input,
          result: event.result,
          cap,
          root: path.join(Global.Path.tmp, "tool-output"),
          sessionID: String(event.sessionID),
          callID: String(event.id),
        })
        if (capped !== undefined) event.result = capped
      }).pipe(Effect.catchCause(() => Effect.void)),
    ),
  )
}
