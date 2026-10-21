import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/tui"
import type { UsageWindowInput } from "@opencode/plugin/tui/context"
import { createUsageWindow } from "../src/tui/usage-window.js"

// The TUI's context % against Compaction › Input token threshold: asked of the
// server once per agent and model, and again after an Instructions change.
function fixture(answers: (number | undefined | Error)[]) {
  const asked: unknown[] = []
  const listeners = new Map<string, () => void>()
  const provider = { current: undefined as ((input: UsageWindowInput) => number | undefined) | undefined }
  const context = {
    client: {
      rpc: () => ({
        "compaction.window": (input: unknown) => {
          asked.push(input)
          const answer = answers.length > 1 ? answers.shift() : answers[0]
          if (answer instanceof Error) return Promise.reject(answer)
          return Promise.resolve(answer === undefined ? {} : { input: answer })
        },
        events: {
          on: (name: string, listener: () => void) => {
            listeners.set(name, listener)
            return () => listeners.delete(name)
          },
        },
      }),
    },
    ui: {
      usage: {
        window: (next: (input: UsageWindowInput) => number | undefined) => {
          provider.current = next
          return () => (provider.current = undefined)
        },
      },
    },
  } as unknown as Plugin.Context
  const usage = createUsageWindow(context)
  return { usage, asked, listeners, read: (input: UsageWindowInput) => provider.current?.(input), provider }
}

const chat = { sessionID: "ses_1", agent: "build", providerID: "anthropic", modelID: "claude", variant: "high" }
const settle = async () => {
  for (let index = 0; index < 5; index++) await Promise.resolve()
}

test("the window is the threshold the server resolves, asked once per agent and model", async () => {
  const harness = fixture([160_000])
  expect(harness.read(chat)).toBeUndefined()
  expect(harness.read(chat)).toBeUndefined()
  await settle()
  expect(harness.asked).toEqual([{ agent: "build", providerID: "anthropic", modelID: "claude", variant: "high" }])
  expect(harness.read(chat)).toBe(160_000)
  // Another chat on the same agent and model reads the same answer.
  expect(harness.read({ ...chat, sessionID: "ses_2" })).toBe(160_000)
  expect(harness.asked).toHaveLength(1)
  harness.usage.dispose()
  expect(harness.provider.current).toBeUndefined()
})

test("an Instructions change asks again; no threshold and a failed call leave the model's window", async () => {
  const harness = fixture([undefined, 90_000, new Error("rpc.method_not_found")])
  harness.read(chat)
  await settle()
  expect(harness.read(chat)).toBeUndefined()
  harness.listeners.get("instructions.changed")?.()
  await settle()
  expect(harness.read(chat)).toBe(90_000)
  harness.listeners.get("instructions.changed")?.()
  await settle()
  expect(harness.read(chat)).toBeUndefined()
  expect(harness.asked).toHaveLength(3)
})
