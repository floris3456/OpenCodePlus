import pkg from "../package.json"

declare const OPENCODE_VERSION: string
declare const OPENCODE_CHANNEL: string
declare const OPENCODE_ARTIFACT: string
declare const OPENCODE_UPSTREAM: string | null

const version = typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : "local"
const channel = typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : "local"
const artifact = typeof OPENCODE_ARTIFACT === "string" ? OPENCODE_ARTIFACT : "cli"
// The OpenCode release a derived build (Plus) contains; upstream builds leave it unset. A source run has no
// release number of its own and reports its source's OpenCode version, as a Plus build of that source
// would: Zen's free tier reads the OpenCode release from the user agent and refuses "local".
const upstream =
  typeof OPENCODE_UPSTREAM === "string" ? OPENCODE_UPSTREAM : version === "local" ? pkg.version : undefined

export {
  version as OPENCODE_VERSION,
  channel as OPENCODE_CHANNEL,
  artifact as OPENCODE_ARTIFACT,
  upstream as OPENCODE_UPSTREAM,
}
export const OPENCODE_LOCAL = channel === "local"
