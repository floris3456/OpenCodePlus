import type { Effect } from "effect"

export interface PromptDomain {
  readonly templates: () => Effect.Effect<readonly { id: string; title: string; text: string }[]>
  readonly active: (model: { readonly id: string; readonly name: string }) => Effect.Effect<string>
  readonly raw: (model: { readonly id: string; readonly name: string }) => Effect.Effect<string | undefined>
}
