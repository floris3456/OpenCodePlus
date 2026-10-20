export * as ConfigWarming from "./warming.js"

import { Schema } from "effect"
import { optional } from "../schema.js"

export class Info extends Schema.Class<Info>("Config.Warming")({
  prompt: Schema.String.pipe(optional).annotate({
    description: "Prompt sent for keep-alive requests",
  }),
  interval: Schema.DurationFromString.pipe(optional).annotate({
    description: 'Idle time between keep-alive requests (default: "4 minutes"; "25 minutes" for GPT-5.6 and later)',
  }),
  duration: Schema.DurationFromString.pipe(optional).annotate({
    description:
      'Time after the last active request to keep a session warm (default: "30 minutes"; "90 minutes" for GPT-5.6 and later)',
  }),
}) {}

export const Warming = Schema.Union([Schema.Boolean, Info])

/**
 * Provider- and model-scoped warming. Provider and model settings travel through
 * JSON settings overlays, which cannot carry decoded `Duration` instances, so
 * scoped durations stay in their configuration string form until resolution.
 */
export const Scoped = Schema.toEncoded(Warming)

/**
 * Warming that is on when nothing configures it, where the model's prompt cache lifetime is known:
 * Claude keeps it 5 minutes (a keep-alive every 4 minutes for 30 minutes), GPT-5.6 and later 30
 * minutes (every 25 minutes for 1h30m). Times in milliseconds; undefined for every other model,
 * which stays off. These are also the model's defaults when warming is turned on without times.
 */
export function builtIn(
  modelID: string,
): { readonly lifetime: number; readonly interval: number; readonly duration: number } | undefined {
  const id = modelID.toLowerCase()
  if (id.includes("claude")) return { lifetime: 5 * 60_000, interval: 4 * 60_000, duration: 30 * 60_000 }
  if (/gpt-(?:[6-9]|5\.[6-9])/.test(id)) return { lifetime: 30 * 60_000, interval: 25 * 60_000, duration: 90 * 60_000 }
}
