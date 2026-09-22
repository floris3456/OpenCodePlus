export * as SessionAdmission from "./admission.js"

import { Effect, Schema } from "effect"

/**
 * Process-local admission fence for a controller-authorized transition.
 *
 * The product never decides to replace itself: an external controller issues the
 * authority, and the only thing this process does is stop admitting new work into
 * sessions that are about to go away. The hold is named by the controller's token,
 * so releasing is explicit and only the holder can do it. Every ambiguous outcome
 * — an unknown token, a release from a non-holder, a second transition arriving
 * over an existing hold — leaves the fence engaged and refuses the caller.
 */
export class AdmissionFencedError extends Schema.TaggedError<AdmissionFencedError>()("Session.AdmissionFencedError", {
  token: Schema.String,
  reason: Schema.String,
  message: Schema.String,
}) {}

export interface Hold {
  readonly token: string
  readonly reason: string
}

export interface Status {
  readonly fenced: boolean
  readonly hold: Hold | undefined
  readonly activeSessions: ReadonlyArray<string>
  readonly quiescent: boolean
}

export type EngageResult =
  | { readonly ok: true; readonly hold: Hold; readonly reconciled: boolean }
  | { readonly ok: false; readonly reason: "invalid_token" | "held_by_other"; readonly message: string }

export type ReleaseResult =
  | { readonly ok: true; readonly released: boolean }
  | { readonly ok: false; readonly reason: "invalid_token" | "not_holder"; readonly message: string }

/** Reports the keys a coordinator currently owns an execution for. */
type ActiveSource = () => Iterable<string>

const sources = new Set<ActiveSource>()
let held: Hold | undefined

export const isEngaged = () => held !== undefined

export const current = (): Hold | undefined => held

/** Engages the fence for one controller token. Re-engaging with the same token reconciles. */
export const engage = (request: { readonly token: string; readonly reason: string }): EngageResult => {
  if (request.token.length === 0)
    return { ok: false, reason: "invalid_token", message: "An admission fence hold needs a non-empty controller token" }
  if (held === undefined) {
    held = { token: request.token, reason: request.reason }
    return { ok: true, hold: held, reconciled: false }
  }
  if (held.token === request.token) return { ok: true, hold: held, reconciled: true }
  return {
    ok: false,
    reason: "held_by_other",
    message: `Session admission is already fenced by ${held.token}`,
  }
}

/** Releases the fence. A non-holder never opens it, so an unexpected token fails closed. */
export const release = (token: string): ReleaseResult => {
  if (token.length === 0)
    return { ok: false, reason: "invalid_token", message: "Releasing the admission fence needs the engaging token" }
  if (held === undefined) return { ok: true, released: false }
  if (held.token !== token)
    return {
      ok: false,
      reason: "not_holder",
      message: `Session admission is fenced by ${held.token}; ${token} cannot release it`,
    }
  held = undefined
  return { ok: true, released: true }
}

export const registerActiveSource = (source: ActiveSource) => {
  sources.add(source)
  return () => {
    sources.delete(source)
  }
}

export const status = (): Status => {
  const active = new Set<string>()
  for (const source of sources) {
    for (const key of source()) active.add(key)
  }
  return {
    fenced: held !== undefined,
    hold: held,
    activeSessions: Array.from(active),
    quiescent: held !== undefined && active.size === 0,
  }
}

/** Refuses durable admission while a controller-authorized transition holds the fence. */
export const check: Effect.Effect<void, AdmissionFencedError> = Effect.suspend(() => {
  if (held === undefined) return Effect.void
  return Effect.fail(
    new AdmissionFencedError({
      token: held.token,
      reason: held.reason,
      message: `Session admission is fenced: ${held.reason}`,
    }),
  )
})

/** Drops the hold without a token. Tests only; a real transition releases with its own token. */
export const reset = () => {
  held = undefined
}
