import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/tui"
import { createTestRenderer } from "@opentui/core/testing"
import { render, type JSX } from "@opentui/solid"
import { createSignal } from "solid-js"
import { createQuota } from "../src/quota/tui.js"

test("quota notices bind their RPC to the displayed session's location", async () => {
  const calls: unknown[] = []
  const claim = { current: undefined as undefined | { render: (input: { sessionID: string }) => JSX.Element } }
  const context = {
    client: {
      rpc: () => ({
        status: async (input: unknown, options: unknown) => {
          calls.push({ input, options })
          return []
        },
      }),
    },
    data: { session: { get: (id: string) => id === "ses_project" ? { location: { directory: "/private/project" } } : undefined } },
    ui: { slot: (value: typeof claim.current) => { claim.current = value; return () => {} } },
  } as unknown as Plugin.Context
  const [session, setSession] = createSignal("ses_project")
  const output = await createTestRenderer({ width: 80, height: 3 })
  const dispose = createQuota(context)
  try {
    render(() => claim.current!.render({ get sessionID() { return session() } }), output.renderer)
    await output.renderOnce()
    expect(calls[0]).toEqual({ input: { sessionID: "ses_project" }, options: { location: { directory: "/private/project" } } })
    // A not-yet-synced legacy session retains the existing default-location fallback.
    setSession("ses_legacy")
    await output.renderOnce()
    expect(calls.at(-1)).toEqual({ input: { sessionID: "ses_legacy" }, options: { location: undefined } })
  } finally {
    output.renderer.destroy()
    dispose()
  }
})
