import { ReleaseRequestStore } from "@opencode/core/release/index"
import { ConflictError, ForbiddenError } from "@opencode/protocol/errors"
import { RELEASE_PERMIT_HEADER, ReleaseRequestNotFoundError } from "@opencode/protocol/groups/release"
import { Effect, Option, Schema } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

// Submitting records intent. A permit presented alongside it is verified by the
// store against the host's trusted issuers; nothing here inspects, trusts or
// forwards authority of its own, and no route performs the release itself.

const decodeHeaderJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

export const ReleaseHandler = HttpApiBuilder.group(Api, "server.release", (handlers) =>
  Effect.gen(function* () {
    const store = yield* ReleaseRequestStore.Service

    return handlers
      .handle("release.request", (ctx) =>
        Effect.gen(function* () {
          const submitted = yield* store.submit({ request: ctx.payload })
          if (!submitted.ok) return yield* Effect.fail(refused(submitted, ctx.payload.requestID))
          const presented = ctx.headers[RELEASE_PERMIT_HEADER]
          if (presented === undefined || presented.length === 0) return submitted.status
          // Unparseable permit material stays unparsed: the store decodes it against
          // the permit contract and refuses it, rather than this handler guessing.
          const authorized = yield* store.authorize({
            requestID: ctx.payload.requestID,
            permit: Option.getOrElse(decodeHeaderJson(presented), () => presented),
          })
          if (!authorized.ok) return yield* Effect.fail(refused(authorized, ctx.payload.requestID))
          return authorized.status
        }),
      )
      .handle("release.status", (ctx) =>
        Effect.gen(function* () {
          const read = yield* store.status(ctx.params.requestID)
          if (read.ok) return read.status
          // A read has nothing to conflict with and no authority to refuse.
          return yield* new ReleaseRequestNotFoundError({
            requestID: ctx.params.requestID,
            message: `${read.reason}: ${read.message}`,
          })
        }),
      )
  }),
)

const conflicting = new Set<ReleaseRequestStore.RefusalReason>([
  "request_conflict",
  "already_settled",
  "authority_conflict",
  "fence_unavailable",
])

function refused(refusal: ReleaseRequestStore.Refusal, requestID: string) {
  const message = `${refusal.reason}: ${refusal.message}`
  if (refusal.reason === "unknown_request") return new ReleaseRequestNotFoundError({ requestID, message })
  if (conflicting.has(refusal.reason)) return new ConflictError({ resource: requestID, message })
  // Everything else is a refusal of presented authority, not of the request shape.
  return new ForbiddenError({ message })
}
