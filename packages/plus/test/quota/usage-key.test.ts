import { expect, test } from "bun:test"
import { Effect } from "effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { usageKey } from "../../src/quota/usage-key.js"

function fixture() {
  const state = {
    baseURL: "https://cpa.example/v1",
    credential: undefined as { type: "key"; key: string } | undefined,
    requested: "",
  }
  const context = {
    provider: { get: () => Effect.succeed({ data: { id: "proxy", integrationID: "proxy-key", settings: {} } }) },
    model: {
      list: () =>
        Effect.succeed({
          data: [{ providerID: "proxy", id: "sonnet", settings: { baseURL: state.baseURL, apiKey: "settings-key" } }],
        }),
    },
    integration: {
      connection: {
        active: (id: string) => {
          state.requested = id
          return Effect.succeed(state.credential ? { id: "connection" } : undefined)
        },
        resolve: () => Effect.succeed(state.credential),
      },
    },
  } as unknown as Context
  const read = (modelID = "sonnet") =>
    Effect.runPromise(usageKey(context, { providerID: "proxy", modelID, all: true }, "https://cpa.example"))
  return { state, read }
}

test("usage resolves the existing provider connection, with settings-key fallback", async () => {
  const f = fixture()
  expect(await f.read()).toBe("settings-key")
  f.state.credential = { type: "key", key: "connected-key" }
  expect(await f.read()).toBe("connected-key")
  expect(f.state.requested).toBe("proxy-key")
})

test("usage does not disclose the provider key to a different quota origin or unknown model", async () => {
  const f = fixture()
  f.state.baseURL = "https://another-provider.example/v1"
  expect(await f.read()).toBeUndefined()
  expect(await f.read("unknown")).toBeUndefined()
})
