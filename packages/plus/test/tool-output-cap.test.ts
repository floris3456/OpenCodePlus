// The per-agent cap on tool-result text: the `setting:tool-output` row, the
// resolved caps for each agent, and the execute.after hook that saves an
// oversized result to a file. Plus's own code runs unstubbed; only the host's
// tool seam is a recorder.
import { afterAll, expect, test } from "bun:test"
import type { ToolDomain, ToolHooks } from "@opencode/plugin/effect/tool"
import type { Agent } from "@opencode/schema/agent"
import type { SessionMessage } from "@opencode/schema/session-message"
import type { Tool } from "@opencode/schema/tool"
import { Global } from "@opencode/util/global"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { controlItems, controlRecordError } from "../src/instructions/agent-controls.js"
import { controlPlans, toolOutputCapsOf, type ApplyAgent, type ApplyInput } from "../src/instructions/apply.js"
import {
  capToolResult,
  DEFAULT_MEMBER_CAP,
  installToolOutputCap,
  toolOutputCapError,
} from "../src/instructions/tool-output-cap.js"
import { estimateTokens } from "../src/monitor/attribution.js"
import { context } from "./harness.js"

const root = path.join(Global.Path.tmp, "tool-output")
afterAll(() => fs.rm(root, { recursive: true, force: true }))

const member: ApplyAgent = { id: "helper", level: "project", team: { level: "project", team: "crew" } }
const plain: ApplyAgent = { id: "build", level: "project" }

function input(agents: readonly ApplyAgent[], text?: string): ApplyInput {
  const row = controlItems("helper").find((item) => item.id === "setting:tool-output")!
  return {
    items: [...controlItems("helper"), ...controlItems()],
    agents,
    records:
      text === undefined
        ? []
        : [
            {
              type: "customization",
              level: "project",
              agent: "helper",
              item: "setting:tool-output",
              section: null,
              team: { level: "project", team: "crew" },
              text,
              basedOn: row.fingerprint,
              updated: "2026-10-28T00:00:00.000Z",
            },
          ],
    splits: [],
    scopes: { global: new Set(), defaults: new Set() },
  }
}

type After = (event: ToolHooks["execute.after"]) => Effect.Effect<void>

async function installed(applyInput: ApplyInput) {
  const after: After[] = []
  const registration = () => Effect.succeed({ dispose: Effect.void })
  const hook: ToolDomain["hook"] = ((name: string, callback: never) => {
    if (name === "execute.after") after.push(callback as unknown as After)
    return registration()
  }) as never
  const ctx = context({ tool: { transform: () => registration(), reload: () => Effect.void, list: () => Effect.succeed([]), hook } })
  const caps = toolOutputCapsOf(applyInput)
  const handle = await installToolOutputCap(ctx, caps)
  return { after, caps, handle }
}

function completed(tool: string, text: string, input: unknown = {}, agent = "helper") {
  return {
    tool,
    sessionID: "ses_cap" as never,
    agent: agent as Agent.ID,
    messageID: "msg_cap" as SessionMessage.ID,
    id: "call_cap" as Tool.CallID,
    input,
    status: "completed" as const,
    result: { content: [{ type: "text" as const, text }] } as Tool.Result,
  }
}

function textOf(result: Tool.Result): string {
  const content = result.content
  if (content === undefined) return ""
  if (typeof content === "string") return content
  return content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n")
}

// 2 000 lines of 100 characters: 200 000 characters, about 80 000 tokens.
const huge = Array.from({ length: 2_000 }, (_, index) => `${String(index + 1).padStart(4, "0")} ${"x".repeat(95)}`).join("\n")

test("a team member with no row is capped at 10 000 tokens and the whole text is saved", async () => {
  const { after, caps } = await installed(input([member]))
  expect(caps.get("helper")).toBe(DEFAULT_MEMBER_CAP)
  const event = completed("shell", huge)
  await Effect.runPromise(after[0]!(event))
  const shown = textOf(event.result)
  const notice = shown.slice(shown.lastIndexOf("[Tool result capped"))
  const file = notice.match(/The full result is in (\S+);/)?.[1]
  expect(file).toBe(`${root}/ses_cap/shell-call_cap.txt`)
  expect(await fs.readFile(file!, "utf8")).toBe(huge)
  expect(notice).toContain("capped at 10000 tokens (setting:tool-output)")
  expect(notice).toContain(`read({ path: "${file}", offset, limit })`)
  const head = shown.slice(0, shown.indexOf("\n[Tool result capped"))
  expect(estimateTokens(head.length)).toBeLessThanOrEqual(DEFAULT_MEMBER_CAP)
  expect(head.split("\n").length).toBeLessThan(2_000)
  expect(head.startsWith("0001 ")).toBe(true)
  expect(event.result.metadata).toMatchObject({ truncated: true, outputPath: file, capTokens: DEFAULT_MEMBER_CAP })
})

test("a member's own row caps at its own value", async () => {
  const { after, caps } = await installed(input([member], "2000"))
  expect(caps.get("helper")).toBe(2_000)
  const event = completed("shell", huge)
  await Effect.runPromise(after[0]!(event))
  const shown = textOf(event.result)
  expect(shown).toContain("capped at 2000 tokens (setting:tool-output)")
  const head = shown.slice(0, shown.indexOf("\n[Tool result capped"))
  expect(estimateTokens(head.length)).toBeLessThanOrEqual(2_000)
})

test("off and an agent with no row leave the result whole", async () => {
  const off = await installed(input([member], "off"))
  expect(off.caps.size).toBe(0)
  expect(off.after.length).toBe(0)
  const other = await installed(input([plain]))
  expect(other.caps.size).toBe(0)
  const event = completed("shell", huge, {}, "build")
  if (other.after[0] !== undefined) await Effect.runPromise(other.after[0](event))
  expect(textOf(event.result)).toBe(huge)
  expect(event.result.metadata).toBeUndefined()
})

test("a read page is capped in place and continues by offset, with no file written", async () => {
  const page = [
    "Read file /work/notes.md, lines 1-200",
    ...Array.from({ length: 200 }, (_, index) => `${index + 1}: ${"line ".repeat(11)}`),
  ].join("\n")
  const { after } = await installed(input([member], "2000"))
  const event = completed("read", page, { path: "/work/notes.md" })
  await Effect.runPromise(after[0]!(event))
  const shown = textOf(event.result)
  expect(shown).toContain("[Read capped at 2000 tokens (setting:tool-output): showing lines 1-")
  expect(shown).toMatch(/Continue with read\(\{ path: "\/work\/notes\.md", offset: \d+, limit \}\)\.\]$/)
  const last = Number(shown.match(/showing lines 1-(\d+)\./)?.[1])
  const offset = Number(shown.match(/offset: (\d+), limit/)?.[1])
  expect(offset).toBe(last + 1)
  expect(shown).toContain(`Read file /work/notes.md`)
  expect(event.result.metadata?.outputPath).toBeUndefined()
  await expect(fs.readFile(`${root}/ses_cap/read-call_cap.txt`, "utf8")).rejects.toThrow()
})

test("a read page that starts at an offset names the lines it shows", async () => {
  const page = ["Read file /work/notes.md, lines 40-99", ...Array.from({ length: 60 }, (_, index) => `${40 + index}: ${"line ".repeat(20)}`)].join("\n")
  const result = await capToolResult({
    tool: "read",
    input: { path: "/work/notes.md", offset: 40 },
    result: { content: [{ type: "text", text: page }] },
    cap: 1_000,
    root,
    sessionID: "ses_offset",
    callID: "call_offset",
  })
  const shown = textOf(result!)
  expect(shown).toContain("showing lines 40-")
  expect(shown).toMatch(/offset: \d+, limit/)
})

test("a skill or team tool result is never capped", async () => {
  const { after } = await installed(input([member], "2000"))
  for (const tool of ["skill", "team_finish", "team_get_context", "instructions_read"]) {
    const event = completed(tool, huge)
    await Effect.runPromise(after[0]!(event))
    expect(textOf(event.result)).toBe(huge)
    expect(event.result.metadata).toBeUndefined()
  }
})

test("an error is not touched", async () => {
  const { after } = await installed(input([member], "2000"))
  const event = {
    tool: "shell",
    sessionID: "ses_cap" as never,
    agent: "helper" as Agent.ID,
    messageID: "msg_cap" as SessionMessage.ID,
    id: "call_cap" as Tool.CallID,
    input: {},
    status: "error" as const,
    error: new Error("boom"),
  }
  await Effect.runPromise(after[0]!(event as never))
  expect((event as { error: Error }).error.message).toBe("boom")
})

test("the cap is refused below 1000, as a non-integer, and otherwise accepted", () => {
  expect(toolOutputCapError("abc")).toBeDefined()
  expect(toolOutputCapError("10")).toBeDefined()
  expect(toolOutputCapError("999")).toBeDefined()
  expect(toolOutputCapError("2.5")).toBeDefined()
  expect(toolOutputCapError("1000")).toBeUndefined()
  expect(toolOutputCapError("off")).toBeUndefined()
  expect(toolOutputCapError("")).toBeUndefined()
})

test("the row is a control and the mutation boundary refuses a bad cap", () => {
  const row = controlItems().find((item) => item.id === "setting:tool-output")
  expect(row?.title).toBe("tool result cap (tokens)")
  expect(row?.text).toBe("")
  const record = (text: string) => ({ type: "customization" as const, level: "project" as const, agent: "build", item: "setting:tool-output", section: null, text, basedOn: row!.fingerprint, updated: "" })
  expect(controlRecordError(record("abc"))).toContain("Tool result cap")
  expect(controlRecordError(record("10"))).toContain("Tool result cap")
  expect(controlRecordError(record("2000"))).toBeUndefined()
  expect(controlRecordError(record("off"))).toBeUndefined()
})

test("the cap never reaches an agent field: controlPlans skip it", () => {
  const plans = controlPlans(input([member], "2000"))
  expect(plans.flatMap((plan) => plan.rows).some((row) => row.id === "setting:tool-output")).toBe(false)
  expect(toolOutputCapsOf(input([member], "2000")).get("helper")).toBe(2_000)
})
