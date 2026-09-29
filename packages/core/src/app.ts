export * as App from "./app.js"

import { Context, Layer } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"

export interface Info {
  readonly name: string
  readonly version: string
  readonly channel: string
  /** The OpenCode release a derived build is based on, when its own version numbers differ. */
  readonly upstream?: string
}

export const Metadata = Context.Reference<Info>("@opencode/App", {
  defaultValue: () => make(),
})

export function make(input: Partial<Info> = {}): Info {
  return {
    name: input.name ?? "opencode",
    version: input.version ?? "unknown",
    channel: input.channel ?? "unknown",
    ...(input.upstream === undefined ? {} : { upstream: input.upstream }),
  }
}

// A derived build reports the OpenCode release it contains, with its own version as
// semver build metadata, so services that require a minimum OpenCode version see the
// OpenCode it actually runs while the channel and suffix still name the build.
export function useragent(app: Info) {
  const version = app.upstream === undefined ? app.version : `${app.upstream}+${app.version}`
  return `opencode/${app.channel}/${version}/${app.name}`
}

export const layer = (input?: Partial<Info>) => Layer.succeed(Metadata, make(input))

export const configured = (input?: Partial<Info>) =>
  makeGlobalNode({ service: Metadata, layer: layer(input), deps: [] })

export const node = configured()
