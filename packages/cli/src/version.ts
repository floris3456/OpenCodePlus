declare const OPENCODE_VERSION: string
declare const OPENCODE_CHANNEL: string
declare const OPENCODE_ARTIFACT: string
declare const OPENCODE_UPSTREAM: string | null

const version = typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : "local"
const channel = typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : "local"
const artifact = typeof OPENCODE_ARTIFACT === "string" ? OPENCODE_ARTIFACT : "cli"
// Set only by derived builds (Plus): the OpenCode release their source contains.
const upstream = typeof OPENCODE_UPSTREAM === "string" ? OPENCODE_UPSTREAM : undefined

export {
  version as OPENCODE_VERSION,
  channel as OPENCODE_CHANNEL,
  artifact as OPENCODE_ARTIFACT,
  upstream as OPENCODE_UPSTREAM,
}
export const OPENCODE_LOCAL = channel === "local"
