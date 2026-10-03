import { Schema } from "effect"

export const Window = Schema.Struct({
  scope: Schema.String,
  seconds: Schema.Number,
  remaining: Schema.Number,
  reset: Schema.Number,
  held: Schema.Boolean,
})
export const Notice = Schema.Struct({
  cursor: Schema.Number,
  id: Schema.String,
  kind: Schema.String,
  text: Schema.String,
  generation: Schema.Number,
})
export const Snapshot = Schema.Struct({
  mode: Schema.optional(Schema.Literals(["off", "shadow", "enforce"])),
  primary_used: Schema.Boolean,
  consumed: Schema.String,
  protocol: Schema.Literal(1),
  cursor: Schema.Number,
  generation: Schema.Number,
  alias: Schema.String,
  intent: Schema.String,
  available: Schema.Boolean,
  windows: Schema.Array(Window),
  events: Schema.Array(Notice),
})
export type Snapshot = typeof Snapshot.Type
export const Binding = Schema.Struct({ protocol: Schema.Literal(1), generation: Schema.Number, alias: Schema.String })
export const Stored = Schema.Struct({
  replay: Schema.Boolean,
  capability: Schema.String,
  cursor: Schema.Number,
  generation: Schema.Number,
  retryIntent: Schema.String,
  /**
   * CPA refused to move this chat to another account until it compacts. The value is the checkpoint the
   * refused request carried ("" for none): a newer checkpoint is the compaction CPA waits for.
   */
  switching: Schema.optional(Schema.String),
})
export type Stored = typeof Stored.Type
export const Config = Schema.Struct({
  routes: Schema.Record(Schema.String, Schema.String),
  /** `provider/model[#variant]` that writes the summary when CPA moves a chat to another account. */
  compactionModel: Schema.optional(Schema.String),
})
export type Config = typeof Config.Type

export function endpoint(base: string) {
  const url = new URL(base)
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  )
    throw new Error("Quota coordination requires HTTPS or a loopback test endpoint")
  if (url.username || url.password || url.search || url.hash) throw new Error("Invalid quota endpoint")
  return new URL("/v0/resource/plugins/quota-handoff/events", url.origin).href
}
