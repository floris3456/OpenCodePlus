import path from "node:path"
import { Schema } from "effect"
import { globalConfigDir } from "../instructions/paths.js"
import { Config } from "./protocol.js"

// Built-in plugin selectors in this host do not forward options. Keep activation
// in a dedicated host-owned file; project config cannot enroll other users.
export async function quotaConfig(options: unknown, directory = globalConfigDir()) {
  if (options !== undefined) return Schema.decodeUnknownSync(Config)(options)
  const file = Bun.file(path.join(directory, "quota-handoff.json"))
  if (!(await file.exists())) return undefined
  return Schema.decodeUnknownSync(Schema.fromJsonString(Config))(await file.text())
}
