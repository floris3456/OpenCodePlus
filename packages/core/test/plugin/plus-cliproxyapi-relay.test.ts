import { Config } from "@opencode/core/config"
import { ConfigProviderPlugin } from "@opencode/core/config/plugin/provider"
import { Model } from "@opencode/core/model"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { Provider } from "@opencode/core/provider"
import { applyRelayToModels } from "@opencode/plus/cliproxyapi"
import { Document, Info, type Entry } from "@opencode/schema/config"
import { describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

// T6 legacy path: quota-handoff.json route, catalogue off. The relay must reach
// the Claude models that ConfigProviderPlugin creates after the cliproxyapi
// plugin's transforms, and must respell the user's variants for the Anthropic
// relay once config has merged them.
const it = testEffect(PluginTestLayer)
const decode = Schema.decodeUnknownSync(Info)
const providerID = Provider.ID.make("cliproxyapi")

const entries: Entry[] = [
  new Document({
    type: "document",
    info: decode({
      providers: {
        cliproxyapi: {
          name: "CLIProxyAPI",
          package: "@opencode/ai/providers/openai",
          settings: { baseURL: "https://cpa.invalid/v1", apiKey: "fixture-key" },
          models: {
            "claude-opus-5-5": {
              variants: [
                { id: "low", body: { reasoning: { effort: "low" } } },
                { id: "high", body: { reasoning: { effort: "high" } } },
              ],
            },
            "gpt-5.3-codex-spark": { variants: [{ id: "high", body: { reasoning: { effort: "high" } } }] },
          },
        },
      },
    }),
  }),
]

describe("opencode.plus.cliproxyapi legacy relay", () => {
  it.live("relays config-only Claude models and respells their variants", () =>
    Effect.gen(function* () {
      const plugin = yield* Plugin.Service
      const host = yield* PluginHost.make(plugin)
      // The cliproxyapi plugin registers a model transform before config and
      // another after activation; calling it around ConfigProviderPlugin
      // reproduces that transform order.
      const relay = () =>
        host.model.transform((models) => applyRelayToModels(models, { cliproxyapi: "https://cpa.invalid" }))
      yield* relay()
      yield* ConfigProviderPlugin.Plugin.effect(host).pipe(Effect.provide(Config.testLayer(entries)))
      yield* relay()
      const models = yield* Model.Service

      const claude = yield* models.get(providerID, Model.ID.make("claude-opus-5-5"))
      expect(claude?.package).toBe("@opencode/ai/providers/anthropic-compatible")
      // The CPA provider's baseURL and key still reach the relayed model.
      expect(claude?.settings).toMatchObject({
        baseURL: "https://cpa.invalid/v1",
        apiKey: "fixture-key",
        compaction: { type: "native" },
      })
      expect(claude?.variants).toEqual([
        {
          id: Model.VariantID.make("low"),
          settings: { thinking: { type: "adaptive", display: "summarized" }, effort: "low" },
        },
        {
          id: Model.VariantID.make("high"),
          settings: { thinking: { type: "adaptive", display: "summarized" }, effort: "high" },
        },
      ])

      const other = yield* models.get(providerID, Model.ID.make("gpt-5.3-codex-spark"))
      expect(other?.package).toBe("@opencode/ai/providers/openai")
      expect(other?.settings?.compaction).toBeUndefined()
      expect(other?.variants).toEqual([
        { id: Model.VariantID.make("high"), body: { reasoning: { effort: "high" } } },
      ])
    }),
  )
})