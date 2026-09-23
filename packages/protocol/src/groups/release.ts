import { Release } from "@opencode/schema/release"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ConflictError, ForbiddenError } from "../errors.js"

// The whole public release vocabulary: record an intent, read its status, and settle
// the transition a controller authorized. There is deliberately no endpoint that
// promotes, rebuilds, activates or self-updates the running product — that decision
// belongs to an external controller, which reaches this process by presenting a
// separately signed permit, never by calling a route that performs the change.

/**
 * Carries one controller permit as JSON. Authority travels beside the request, not
 * inside it: the permit signs a digest of the exact request body, so it cannot be
 * part of the body it commits to.
 */
export const RELEASE_PERMIT_HEADER = "x-opencode-release-permit"

/**
 * The controller's reported outcome for one authorized transition. `token` is the
 * permit ID that authorized the request; it is untrusted material the store compares
 * against the recorded holder, so this route can neither inspect nor mint authority.
 */
export const ReleaseSettlePayload = Schema.Struct({
  token: Schema.String,
  outcome: Schema.Literals(["completed", "failed", "rejected"]),
  detail: Schema.optional(Schema.String),
})

export class ReleaseRequestNotFoundError extends Schema.TaggedError<ReleaseRequestNotFoundError>()(
  "ReleaseRequestNotFoundError",
  {
    requestID: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export const ReleaseGroup = HttpApiGroup.make("server.release")
  .add(
    HttpApiEndpoint.post("release.request", "/api/release/request", {
      payload: Release.Request,
      headers: Schema.Struct({ [RELEASE_PERMIT_HEADER]: Schema.optional(Schema.String) }),
      success: Release.RequestStatus,
      error: [ConflictError, ForbiddenError, ReleaseRequestNotFoundError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.release.request",
        summary: "Record a release request",
        description:
          "Record a release build or promotion intent durably and read back its status. Submitting grants no authority and activates nothing; resubmitting the same requestID with the same body reconciles the recorded request, while a changed body conflicts. A controller permit presented in the permit header is verified against the host's trusted issuers: an authentic permit bound to this exact request closes session admission for the transition it authorizes, and a forged, expired, replayed, out-of-scope or wrong-generation permit is refused.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("release.status", "/api/release/request/:requestID", {
      params: { requestID: Schema.String },
      success: Release.RequestStatus,
      error: ReleaseRequestNotFoundError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.release.status",
        summary: "Read a release request",
        description: "Read the recorded status of one release request. Reads never change a request.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("release.settle", "/api/release/request/:requestID/settle", {
      params: { requestID: Schema.String },
      payload: ReleaseSettlePayload,
      success: Release.RequestStatus,
      error: [ConflictError, ForbiddenError, ReleaseRequestNotFoundError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.release.settle",
        summary: "Settle a release request",
        description:
          "Record the outcome the external controller reports for the transition it authorized and release the session admission fence that transition engaged. The token must be the permit that authorized this exact request: an unknown request, a request that carries no authorized transition, a token that did not authorize it, or a second settle with a different outcome is refused, and a refused settle never reopens admission. Settling records an outcome; it never promotes, rebuilds or activates anything.",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "release",
      description:
        "Release request routes: record an intent, read its status, and settle a controller-authorized transition.",
    }),
  )
