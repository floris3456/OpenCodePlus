import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect, FileSystem } from "effect"
import { Global } from "@opencode/util/global"
import { createEventStream, createFetch, directory, json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"

const tokens = (input: number, output: number) => ({ input, output, reasoning: 0, cache: { read: 0, write: 0 } })

// Every compaction line names the model that wrote (or tried to write) the
// summary: "Compaction · <model> · N in · M out" and
// "✗ Compaction · <model> · <error>". A row without a model keeps the old line.
test("compaction lines name their model", async () => {
  await using state = await tmpdir()
  const setup = await createTestRenderer({ width: 120, height: 40, useThread: false, kittyKeyboard: true })
  setup.renderer.start()
  const ready = Promise.withResolvers<void>()
  const events = createEventStream()
  const sessionID = "ses_compaction_line"
  const location = { directory, project: { id: "project", directory, canonical: directory } }
  const calls = createFetch(async (url) => {
    if (url.pathname === `/api/session/${sessionID}`)
      return json({
        data: {
          id: sessionID,
          projectID: "project",
          title: "Compaction fixture",
          model: { providerID: "demo", id: "model" },
          location: { directory },
          cost: 0,
          tokens: tokens(0, 0),
          time: { created: 0, updated: 0 },
        },
      })
    if (url.pathname === `/api/session/${sessionID}/message`)
      return json({
        data: [
          {
            id: "msg_failed_old",
            type: "compaction",
            time: { created: 3 },
            status: "failed",
            reason: "auto",
            error: { type: "provider", message: "Old quota failure" },
          },
          {
            id: "msg_failed",
            type: "compaction",
            time: { created: 2 },
            status: "failed",
            reason: "auto",
            model: { providerID: "demo", id: "cheap" },
            error: { type: "provider", message: "Go usage limit exceeded" },
          },
          {
            id: "msg_completed",
            type: "compaction",
            time: { created: 1 },
            status: "completed",
            reason: "manual",
            model: { providerID: "demo", id: "summary", variant: "high" },
            summary: "Summary text",
            recent: "",
            tokens: tokens(198713, 1666),
          },
        ],
        cursor: {},
      })
    if (url.pathname === `/api/session/${sessionID}/inbox` || url.pathname === `/api/session/${sessionID}/permission`)
      return json({ data: [] })
    if (url.pathname === "/api/agent")
      return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
    if (url.pathname === "/api/provider") return json({ location, data: [{ id: "demo", name: "Demo" }] })
    if (url.pathname === "/api/model")
      return json({ location, data: [{ id: "model", providerID: "demo", name: "Demo Model", variants: [] }] })
    return undefined
  }, events)
  const server = Bun.serve({ port: 0, fetch: (request) => calls.fetch(request) })
  const { run } = await import("../src/app")
  const task = Effect.runPromise(
    run({
      app: { name: "test", version: "test", channel: "test" },
      server: { endpoint: { url: server.url.toString() } },
      config: { get: async () => ({ animations: false }), update: async () => ({}) },
      packages: { prepare: async () => ({ directory: "" }) },
      terminalHandoff: async () => ({ renderer: setup.renderer, mode: "dark", complete: ready.resolve }),
      args: { sessionID },
      log: () => {},
    }).pipe(Effect.provide(Global.layerWith({ state: state.path })), Effect.provide(FileSystem.layerNoop({}))),
  )
  try {
    await ready.promise
    const frame = await setup.waitForFrame((frame) => frame.includes("Summary text") && frame.includes("Old quota"))
    // A completed compaction: its model (the id when the catalogue has no such
    // model) and variant, then its usage.
    expect(frame).toContain("Compaction · summary (high) · 198.7K in · 1.7K out")
    // A failed compaction from an older store has no model: the error stays on the line.
    expect(frame).toContain("✗ Compaction · Old quota failure")
    // A failed compaction that recorded the model it tried names it.
    expect(frame).toContain("✗ Compaction · cheap · Go usage limit exceeded")
  } finally {
    setup.renderer.destroy()
    await task
    await server.stop()
  }
})
