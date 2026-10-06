import { Config } from "@opencode/core/config"
import { ConfigProviderPlugin } from "@opencode/core/config/plugin/provider"
import { Model } from "@opencode/core/model"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { Provider } from "@opencode/core/provider"
import type { ProviderEditor } from "@opencode/plugin/effect/provider"
import { applyCatalogue, applyRelayToExistingModels, applyRelayToModels } from "@opencodeplus/cliproxyapi/server"
import { Document, Info, type Entry } from "@opencode/schema/config"
import { Model as ModelSchema } from "@opencode/schema/model"
import { Provider as ProviderSchema } from "@opencode/schema/provider"
import { describe, expect, test } from "bun:test"
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
      const relay = (options?: { readonly compaction?: boolean }) =>
        host.model.transform((models) =>
          applyRelayToModels(models, { cliproxyapi: "https://cpa.invalid" }, undefined, options),
        )
      yield* relay()
      yield* ConfigProviderPlugin.Plugin.effect(host).pipe(Effect.provide(Config.testLayer(entries)))
      yield* relay({ compaction: true })
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

  it.live("relay's post-config pass re-applies after config re-activates", () =>
    Effect.gen(function* () {
      const plugin = yield* Plugin.Service
      const host = yield* PluginHost.make(plugin)
      const relay = (options?: { readonly compaction?: boolean }) =>
        host.model.transform((models) =>
          applyRelayToModels(models, { cliproxyapi: "https://cpa.invalid" }, undefined, options),
        )
      yield* relay()
      yield* ConfigProviderPlugin.Plugin.effect(host).pipe(Effect.provide(Config.testLayer(entries)))
      yield* relay({ compaction: true })
      // Config re-activates (for example after its file changes) and appends its
      // transform after the relay's. The relay re-registers its pass so that it
      // still runs last and respells the merged user variants for the relay.
      yield* ConfigProviderPlugin.Plugin.effect(host).pipe(Effect.provide(Config.testLayer(entries)))
      yield* relay({ compaction: true })

      const models = yield* Model.Service
      const claude = yield* models.get(providerID, Model.ID.make("claude-opus-5-5"))
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
      expect(claude?.settings).toMatchObject({ compaction: { type: "native" } })
    }),
  )
})

// Minimal ProviderEditor over one provider, for the relay's provider-level entry points.
function providerEditor(provider: ProviderSchema.Info, models: Model.Info[]) {
  const store = { provider, models: new Map(models.map((model) => [String(model.id), structuredClone(model)])) }
  const editor: ProviderEditor = {
    list: () => [{ provider: store.provider, models: store.models }],
    get: () => ({ provider: store.provider, models: store.models }),
    add: () => {},
    update: (_id, update) => update(store.provider as never),
    remove: () => {},
    models: {
      set: (_id, values) => {
        store.models = new Map(values.map((model) => [String(model.id), structuredClone(model)]))
      },
      update: (_id, modelID, update) => {
        const current = store.models.get(String(modelID))
        const model =
          current ?? Model.Info.default(Provider.ID.make("cpa"), Model.ID.make(String(modelID)))
        store.models.set(String(modelID), model)
        update(model as never)
      },
      remove: (_id, modelID) => {
        store.models.delete(String(modelID))
      },
    },
  }
  return { editor, get: (id: string) => store.models.get(id) }
}

describe("opencode.plus.cliproxyapi relay entry points", () => {
  test("legacy relay never invents variants for a Claude model that had none", () => {
    const provider = {
      ...ProviderSchema.Info.empty(ProviderSchema.ID.make("cpa")),
      package: "@opencode/ai/providers/openai-compatible",
    }
    const claude = ModelSchema.Info.default(ProviderSchema.ID.make("cpa"), ModelSchema.ID.make("claude-3-7-sonnet"))
    const { editor, get } = providerEditor(provider, [claude])

    applyRelayToExistingModels(editor, { cpa: "https://cpa.invalid" }, undefined, { compaction: true })

    const updated = get("claude-3-7-sonnet")!
    expect(updated.package).toBe("@opencode/ai/providers/anthropic-compatible")
    expect(updated.settings?.compaction).toEqual({ type: "native" })
    // Core fills the spelling later from the package; the relay does not invent ids.
    expect(updated.variants).toEqual([])
  })

  test("catalogue relay keeps a user's own package, variants and compaction", () => {
    const provider = {
      ...ProviderSchema.Info.empty(ProviderSchema.ID.make("cpa")),
      package: "@opencode/ai/providers/openai-compatible",
    }
    const userModel: Model.Info = {
      ...Model.Info.default(Provider.ID.make("cpa"), Model.ID.make("claude-opus-4-5")),
      package: "custom-anthropic-package",
      settings: { compaction: { type: "summary" } },
      variants: [{ id: Model.VariantID.make("high"), settings: { effort: "high" } }],
    }
    const { editor, get } = providerEditor(provider, [userModel])

    applyCatalogue(
      editor,
      "cpa",
      {
        source: "details",
        hash: "h",
        models: [
          {
            id: "claude-opus-4-5",
            name: "Claude Opus 4.5",
            kind: "chat",
            ownedBy: "anthropic",
            input: ["text"],
            outputModalities: ["text"],
            reasoning: { mode: "levels", levels: ["low", "high"] },
            tiers: [],
          },
        ],
      },
      "@opencode/ai/providers/openai-compatible",
    )

    const updated = get("claude-opus-4-5")!
    expect(updated.package).toBe("custom-anthropic-package")
    expect(updated.settings?.compaction).toEqual({ type: "summary" })
    expect(updated.variants).toEqual([{ id: Model.VariantID.make("high"), settings: { effort: "high" } }])
  })
})
