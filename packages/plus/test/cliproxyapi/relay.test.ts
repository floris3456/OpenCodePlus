import { expect, test } from "bun:test"
import type { ProviderEditor } from "@opencode/plugin/effect/provider"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import type { Types } from "effect"
import { anthropicVariants, applyCatalogue, applyRelayToExistingModels, isClaude, spellVariants, type Catalogue } from "../../src/cliproxyapi/catalog.js"

function createTestEditor(initial: { provider: Provider.Info; models?: Model.Info[] }[]) {
  const store = new Map<string, { provider: Provider.Info; models: Map<string, Model.Info> }>()
  for (const item of initial) {
    const modelsMap = new Map<string, Model.Info>()
    for (const m of item.models ?? []) modelsMap.set(m.id, structuredClone(m))
    store.set(item.provider.id, { provider: structuredClone(item.provider), models: modelsMap })
  }
  const editor: ProviderEditor = {
    list: () =>
      [...store.values()].map((entry) => ({
        provider: entry.provider,
        models: entry.models,
      })),
    get: (id) => {
      const entry = store.get(id)
      return entry ? { provider: entry.provider, models: entry.models } : undefined
    },
    add: (input) => {
      const modelsMap = new Map<string, Model.Info>()
      for (const m of input.models) modelsMap.set(m.id, structuredClone(m))
      store.set(input.info.id, { provider: structuredClone(input.info), models: modelsMap })
    },
    update: (id, update) => {
      const entry = store.get(id)
      if (entry) update(entry.provider as never)
    },
    remove: (id) => {
      store.delete(id)
    },
    models: {
      set: (providerID, models) => {
        let entry = store.get(providerID)
        if (!entry) {
          entry = { provider: Provider.Info.empty(Provider.ID.make(providerID)), models: new Map() }
          store.set(providerID, entry)
        }
        entry.models.clear()
        for (const m of models) entry.models.set(m.id, structuredClone(m))
      },
      update: (providerID, modelID, update) => {
        let entry = store.get(providerID)
        if (!entry) {
          entry = { provider: Provider.Info.empty(Provider.ID.make(providerID)), models: new Map() }
          store.set(providerID, entry)
        }
        let model = entry.models.get(modelID)
        if (!model) {
          model = Model.Info.default(Provider.ID.make(providerID), Model.ID.make(modelID))
          entry.models.set(modelID, model)
        }
        update(model as never)
      },
      remove: (providerID, modelID) => {
        store.get(providerID)?.models.delete(modelID)
      },
    },
  }
  return {
    editor,
    getModel: (providerID: string, modelID: string) => store.get(providerID)?.models.get(modelID),
  }
}

test("isClaude identifies Claude models by id or owned_by", () => {
  expect(isClaude({ id: "claude-3-7-sonnet" })).toBe(true)
  expect(isClaude({ id: "claude-opus-4-5" })).toBe(true)
  expect(isClaude({ id: "claude-haiku-3-5-fast" })).toBe(true)
  expect(isClaude({ id: "custom-sonnet", owned_by: "anthropic" })).toBe(true)
  expect(isClaude({ id: "custom-sonnet", ownedBy: "Anthropic" })).toBe(true)
  expect(isClaude({ id: "gpt-4o", owned_by: "openai" })).toBe(false)
  expect(isClaude({ id: "deepseek-chat" })).toBe(false)
})

test("anthropicVariants is model-aware: adaptive for newer Claude, explicit budgets for 4.5 and 3.7", () => {
  const newer = anthropicVariants({ id: "claude-opus-4-8", limit: { output: 64_000 } }, ["low", "high"])
  expect(newer).toEqual([
    { id: "low", settings: { thinking: { type: "adaptive", display: "summarized" }, effort: "low" } },
    { id: "high", settings: { thinking: { type: "adaptive", display: "summarized" }, effort: "high" } },
  ])
  // Claude 3.7 and 4.5 reject `thinking: adaptive`; Core spells them as enabled+budgetTokens.
  const sonnet37 = anthropicVariants({ id: "claude-3-7-sonnet", limit: { output: 64_000 } }, ["low", "high"])
  expect(sonnet37).toEqual([
    { id: "low", settings: { thinking: { type: "enabled", budgetTokens: 16_000 } } },
    { id: "high", settings: { thinking: { type: "enabled", budgetTokens: 16_000 } } },
  ])
  const opus45 = anthropicVariants({ id: "claude-opus-4-5", limit: { output: 64_000 } }, ["high"])
  expect(opus45).toEqual([{ id: "high", settings: { thinking: { type: "enabled", budgetTokens: 16_000 }, effort: "high" } }])
  // Non-Anthropic packages keep the plain effort spelling.
  expect(spellVariants("@opencode/ai/providers/openai-compatible", ["high"])).toEqual([
    { id: "high", settings: { reasoningEffort: "high" } },
  ])
})

test("legacy route + catalogue off gives Claude models anthropic-compatible package, Anthropic variants and native compaction", () => {
  const provider = {
    ...Provider.Info.empty(Provider.ID.make("cpa")),
    package: "@opencode/ai/providers/openai-compatible",
  }
  const claudeModel: Model.Info = {
    ...Model.Info.default(Provider.ID.make("cpa"), Model.ID.make("claude-3-7-sonnet")),
    variants: [
      { id: Model.VariantID.make("low"), settings: { reasoningEffort: "low" } },
      { id: Model.VariantID.make("high"), settings: { reasoningEffort: "high" } },
    ],
  }
  const nonClaudeModel: Model.Info = {
    ...Model.Info.default(Provider.ID.make("cpa"), Model.ID.make("gpt-4o")),
    variants: [{ id: Model.VariantID.make("high"), settings: { reasoningEffort: "high" } }],
  }

  const { editor, getModel } = createTestEditor([{ provider, models: [claudeModel, nonClaudeModel] }])

  applyRelayToExistingModels(editor, { cpa: "https://cpa.example" }, undefined, { compaction: true })

  const updatedClaude = getModel("cpa", "claude-3-7-sonnet")!
  expect(updatedClaude.package).toBe("@opencode/ai/providers/anthropic-compatible")
  expect(updatedClaude.settings?.compaction).toEqual({ type: "native" })
  // Claude 3.7 must not get adaptive thinking; Core spells it enabled+budgetTokens.
  expect(updatedClaude.variants).toEqual([
    { id: Model.VariantID.make("low"), settings: { thinking: { type: "enabled", budgetTokens: 16_000 } } },
    { id: Model.VariantID.make("high"), settings: { thinking: { type: "enabled", budgetTokens: 16_000 } } },
  ])

  // Non-Claude model is completely unchanged
  const updatedNonClaude = getModel("cpa", "gpt-4o")!
  expect(updatedNonClaude.package).toBeUndefined()
  expect(updatedNonClaude.settings?.compaction).toBeUndefined()
  expect(updatedNonClaude.variants).toEqual([
    { id: Model.VariantID.make("high"), settings: { reasoningEffort: "high" } },
  ])
})

test("catalogue mode gives Claude models anthropic-compatible package, Anthropic variants and native compaction", () => {
  const provider = {
    ...Provider.Info.empty(Provider.ID.make("cpa")),
    package: "@opencode/ai/providers/openai-compatible",
  }
  const catalogue: Catalogue = {
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
        reasoning: { mode: "levels", levels: ["low", "high", "max"] },
        tiers: ["priority"],
      },
      {
        id: "gpt-5",
        name: "GPT 5",
        kind: "chat",
        ownedBy: "openai",
        input: ["text"],
        outputModalities: ["text"],
        reasoning: { mode: "levels", levels: ["low", "high"] },
        tiers: [],
      },
    ],
  }

  const { editor, getModel } = createTestEditor([{ provider }])

  applyCatalogue(editor, "cpa", catalogue, "@opencode/ai/providers/openai-compatible")
  // Compaction is applied by the relay's post-config pass, after config has merged settings.
  applyRelayToExistingModels(editor, { cpa: "https://cpa.example" }, undefined, { compaction: true })

  const opus = getModel("cpa", "claude-opus-4-5")!
  expect(opus.package).toBe("@opencode/ai/providers/anthropic-compatible")
  expect(opus.settings?.compaction).toEqual({ type: "native" })
  // Opus 4.5 must not get adaptive thinking.
  expect(opus.variants).toEqual([
    { id: Model.VariantID.make("low"), settings: { thinking: { type: "enabled", budgetTokens: 16_000 }, effort: "low" } },
    { id: Model.VariantID.make("high"), settings: { thinking: { type: "enabled", budgetTokens: 16_000 }, effort: "high" } },
    { id: Model.VariantID.make("max"), settings: { thinking: { type: "enabled", budgetTokens: 16_000 }, effort: "max" } },
  ])

  // Fast alias of Claude also gets the relay configuration
  const opusFast = getModel("cpa", "claude-opus-4-5-fast")!
  expect(opusFast.package).toBe("@opencode/ai/providers/anthropic-compatible")
  expect(opusFast.settings?.compaction).toEqual({ type: "native" })
  expect(opusFast.variants).toEqual([
    { id: Model.VariantID.make("low"), settings: { thinking: { type: "enabled", budgetTokens: 16_000 }, effort: "low" } },
    { id: Model.VariantID.make("high"), settings: { thinking: { type: "enabled", budgetTokens: 16_000 }, effort: "high" } },
    { id: Model.VariantID.make("max"), settings: { thinking: { type: "enabled", budgetTokens: 16_000 }, effort: "max" } },
  ])

  // Non-Claude model is unchanged (uses provider package and OpenAI variant spelling)
  const gpt5 = getModel("cpa", "gpt-5")!
  expect(gpt5.package).toBeUndefined()
  expect(gpt5.settings?.compaction).toBeUndefined()
  expect(gpt5.variants).toEqual([
    { id: Model.VariantID.make("low"), settings: { reasoningEffort: "low" } },
    { id: Model.VariantID.make("high"), settings: { reasoningEffort: "high" } },
  ])
})

test("catalogue mode leaves no relay compaction when config repackages the model", () => {
  const provider = {
    ...Provider.Info.empty(Provider.ID.make("cpa")),
    package: "@opencode/ai/providers/openai-compatible",
  }
  const catalogue: Catalogue = {
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
  }

  const { editor, getModel } = createTestEditor([{ provider }])
  // The catalogue's provider transform runs before config's model transform.
  applyCatalogue(editor, "cpa", catalogue, "@opencode/ai/providers/openai-compatible")
  expect(getModel("cpa", "claude-opus-4-5")!.settings?.compaction).toBeUndefined()

  // Config then applies the user's own per-model package; the relay pass runs after it.
  ;(getModel("cpa", "claude-opus-4-5") as Types.DeepMutable<Model.Info>).package = "custom-anthropic-package"
  applyRelayToExistingModels(editor, { cpa: "https://cpa.example" }, undefined, { compaction: true })

  const updated = getModel("cpa", "claude-opus-4-5")!
  expect(updated.package).toBe("custom-anthropic-package")
  expect(updated.settings?.compaction).toBeUndefined()
})

test("a user Anthropic package keeps native compaction", () => {
  const provider = {
    ...Provider.Info.empty(Provider.ID.make("cpa")),
    package: "@opencode/ai/providers/openai-compatible",
  }
  const claude: Model.Info = {
    ...Model.Info.default(Provider.ID.make("cpa"), Model.ID.make("claude-opus-4-5")),
    package: "@opencode/ai/providers/anthropic",
    settings: { compaction: { type: "native" } },
  }

  const { editor, getModel } = createTestEditor([{ provider, models: [claude] }])
  applyRelayToExistingModels(editor, { cpa: "https://cpa.example" })

  const updated = getModel("cpa", "claude-opus-4-5")!
  expect(updated.package).toBe("@opencode/ai/providers/anthropic")
  expect(updated.settings?.compaction).toEqual({ type: "native" })
})

test("user settings.compaction still wins when config repackages the model", () => {
  const provider = {
    ...Provider.Info.empty(Provider.ID.make("cpa")),
    package: "@opencode/ai/providers/openai-compatible",
  }
  const catalogue: Catalogue = {
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
  }

  const { editor, getModel } = createTestEditor([{ provider }])
  applyCatalogue(editor, "cpa", catalogue, "@opencode/ai/providers/openai-compatible")
  const model = getModel("cpa", "claude-opus-4-5") as Types.DeepMutable<Model.Info>
  model.package = "custom-anthropic-package"
  model.settings = { ...model.settings, compaction: { type: "summary" } }
  applyRelayToExistingModels(editor, { cpa: "https://cpa.example" }, undefined, { compaction: true })

  const updated = getModel("cpa", "claude-opus-4-5")!
  expect(updated.package).toBe("custom-anthropic-package")
  expect(updated.settings?.compaction).toEqual({ type: "summary" })
})

test("a user's explicit native compaction on a non-Anthropic package is never removed", () => {
  const provider = {
    ...Provider.Info.empty(Provider.ID.make("cpa")),
    package: "@opencode/ai/providers/openai-compatible",
  }
  const claude: Model.Info = {
    ...Model.Info.default(Provider.ID.make("cpa"), Model.ID.make("claude-opus-4-5")),
    package: "@opencode/ai/providers/openai/responses",
    settings: { compaction: { type: "native" } },
    variants: [{ id: Model.VariantID.make("high"), settings: { reasoningEffort: "high" } }],
  }

  const { editor, getModel } = createTestEditor([{ provider, models: [claude] }])
  applyRelayToExistingModels(editor, { cpa: "https://cpa.example" }, undefined, { compaction: true })

  const updated = getModel("cpa", "claude-opus-4-5")!
  expect(updated.package).toBe("@opencode/ai/providers/openai/responses")
  expect(updated.settings?.compaction).toEqual({ type: "native" })
  expect(updated.variants).toEqual([
    { id: Model.VariantID.make("high"), settings: { reasoningEffort: "high" } },
  ])
})

test("user package and compaction win over relay defaults", () => {
  const provider = {
    ...Provider.Info.empty(Provider.ID.make("cpa")),
    package: "@opencode/ai/providers/openai-compatible",
  }
  const claudeCustom: Model.Info = {
    ...Model.Info.default(Provider.ID.make("cpa"), Model.ID.make("claude-3-7-sonnet")),
    package: "custom-anthropic-package",
    settings: {
      compaction: { type: "summary" },
    },
    variants: [{ id: Model.VariantID.make("high"), settings: { reasoningEffort: "high" } }],
  }

  const { editor, getModel } = createTestEditor([{ provider, models: [claudeCustom] }])

  applyRelayToExistingModels(editor, { cpa: "https://cpa.example" })

  const updated = getModel("cpa", "claude-3-7-sonnet")!
  expect(updated.package).toBe("custom-anthropic-package")
  expect(updated.settings?.compaction).toEqual({ type: "summary" })
  // Variants are also preserved when custom package is set
  expect(updated.variants).toEqual([
    { id: Model.VariantID.make("high"), settings: { reasoningEffort: "high" } },
  ])
})

test("inert compaction: { mode: 'local' } is ignored and replaced with native compaction", () => {
  const provider = {
    ...Provider.Info.empty(Provider.ID.make("cpa")),
    package: "@opencode/ai/providers/openai-compatible",
  }
  const claudeInert: Model.Info = {
    ...Model.Info.default(Provider.ID.make("cpa"), Model.ID.make("claude-3-7-sonnet")),
    settings: {
      compaction: { mode: "local" } as never,
    },
  }

  const { editor, getModel } = createTestEditor([{ provider, models: [claudeInert] }])

  applyRelayToExistingModels(editor, { cpa: "https://cpa.example" }, undefined, { compaction: true })

  const updated = getModel("cpa", "claude-3-7-sonnet")!
  expect(updated.package).toBe("@opencode/ai/providers/anthropic-compatible")
  expect(updated.settings?.compaction).toEqual({ type: "native" })
})

test("opt-out restores old routing in legacy and catalogue modes", () => {
  const provider = {
    ...Provider.Info.empty(Provider.ID.make("cpa")),
    package: "@opencode/ai/providers/openai-compatible",
  }
  const claudeModel: Model.Info = {
    ...Model.Info.default(Provider.ID.make("cpa"), Model.ID.make("claude-3-7-sonnet")),
    variants: [{ id: Model.VariantID.make("high"), settings: { reasoningEffort: "high" } }],
  }

  // Legacy mode with anthropicRelay: false
  const legacy = createTestEditor([{ provider, models: [claudeModel] }])
  applyRelayToExistingModels(legacy.editor, { cpa: "https://cpa.example" }, { cpa: false })

  const legacyClaude = legacy.getModel("cpa", "claude-3-7-sonnet")!
  expect(legacyClaude.package).toBeUndefined()
  expect(legacyClaude.settings?.compaction).toBeUndefined()
  expect(legacyClaude.variants).toEqual([
    { id: Model.VariantID.make("high"), settings: { reasoningEffort: "high" } },
  ])

  // Catalogue mode with anthropicRelay: false
  const catalogue: Catalogue = {
    source: "details",
    hash: "h",
    models: [
      {
        id: "claude-3-7-sonnet",
        name: "Claude 3.7",
        kind: "chat",
        ownedBy: "anthropic",
        input: ["text"],
        outputModalities: ["text"],
        reasoning: { mode: "levels", levels: ["low", "high"] },
        tiers: [],
      },
    ],
  }
  const cat = createTestEditor([{ provider }])
  applyCatalogue(cat.editor, "cpa", catalogue, "@opencode/ai/providers/openai-compatible", {
    anthropicRelay: false,
  })

  const catClaude = cat.getModel("cpa", "claude-3-7-sonnet")!
  expect(catClaude.package).toBeUndefined()
  expect(catClaude.settings?.compaction).toBeUndefined()
  expect(catClaude.variants).toEqual([
    { id: Model.VariantID.make("low"), settings: { reasoningEffort: "low" } },
    { id: Model.VariantID.make("high"), settings: { reasoningEffort: "high" } },
  ])
})

test("cliproxyapiConfig parses anthropicRelay opt-out per-route and top-level", async () => {
  const fs = await import("node:fs/promises")
  const os = await import("node:os")
  const path = await import("node:path")
  const { cliproxyapiConfig } = await import("../../src/cliproxyapi/config.js")

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cpa-relay-config-"))
  try {
    await Bun.write(
      path.join(directory, "cliproxyapi.json"),
      JSON.stringify({
        routes: { cpa: { url: "https://cpa.invalid", anthropicRelay: false } },
      }),
    )
    expect(await cliproxyapiConfig(directory)).toMatchObject({
      routes: { cpa: "https://cpa.invalid" },
      anthropicRelay: { cpa: false },
    })

    await Bun.write(
      path.join(directory, "cliproxyapi.json"),
      JSON.stringify({
        routes: { cpa: "https://cpa.invalid" },
        anthropicRelay: false,
      }),
    )
    expect(await cliproxyapiConfig(directory)).toMatchObject({
      routes: { cpa: "https://cpa.invalid" },
      anthropicRelay: { cpa: false },
    })

    await Bun.write(
      path.join(directory, "quota-handoff.json"),
      JSON.stringify({
        routes: { cpa: "https://cpa.invalid" },
        anthropicRelay: false,
      }),
    )
    await fs.rm(path.join(directory, "cliproxyapi.json"))
    expect(await cliproxyapiConfig(directory)).toMatchObject({
      source: "quota-handoff.json",
      routes: { cpa: "https://cpa.invalid" },
      anthropicRelay: { cpa: false },
    })
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

