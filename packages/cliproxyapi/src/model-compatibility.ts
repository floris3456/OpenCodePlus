import type { ModelEditor } from "@opencode/plugin/promise/model"
import type { Model } from "@opencode/schema/model"
import { Schema, type Types } from "effect"
import { anthropicVariants, type AnthropicModel } from "./catalog.js"

const legacyEffort = Schema.decodeUnknownOption(Schema.Struct({ effort: Schema.String }), {
  onExcessProperty: "error",
})

/** Older Plus configs used Responses body overrides before CPA's Claude Messages relay. */
export function normalizeLegacyReasoning(models: ModelEditor) {
  for (const model of models.list("cliproxyapi")) {
    const pkg = model.package ?? models.provider.get("cliproxyapi")?.provider.package
    if (pkg !== "@opencode/ai/providers/anthropic-compatible" && pkg !== "@opencode/ai/providers/anthropic") continue
    models.update(String(model.providerID), String(model.id), (draft) => {
      const facts = {
        id: String(draft.id),
        modelID: draft.modelID === undefined ? undefined : String(draft.modelID),
        limit: draft.limit,
      }
      normalize(facts, draft)
      for (const variant of draft.variants) normalize(facts, variant)
    })
  }
}

function normalize(model: AnthropicModel, overlay: Types.DeepMutable<Pick<Model.Info, "body" | "settings">>) {
  const legacy = legacyEffort(overlay.body?.reasoning)
  if (legacy._tag === "None") return
  const native = anthropicVariants(model, [legacy.value.effort])[0]?.settings
  if (!native) return
  // Raw body overrides had precedence over catalogue defaults. Keep that effort,
  // explicit native thinking, headers and all unrelated provider body fields.
  overlay.settings = {
    ...native,
    ...overlay.settings,
    ...(native.effort === undefined ? {} : { effort: native.effort }),
  }
  delete overlay.body?.reasoning
}
