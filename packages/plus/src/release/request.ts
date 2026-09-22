import { Schema } from "effect"
import {
  ReleaseRequest,
  ReleaseRequestStatus,
} from "@opencode/schema/release"
import { canonicalJson } from "./identity.js"

export class ReleaseRequestConflictError extends Schema.TaggedError<ReleaseRequestConflictError>()(
  "ReleaseRequestConflictError",
  {
    requestID: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 409 },
) {}

export class ReleaseRequestNotFoundError extends Schema.TaggedError<ReleaseRequestNotFoundError>()(
  "ReleaseRequestNotFoundError",
  {
    requestID: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

interface StoredRequest {
  readonly request: ReleaseRequest
  readonly status: ReleaseRequestStatus
}

const store = new Map<string, StoredRequest>()

export function resetReleaseStore(): void {
  store.clear()
}

export function submitReleaseRequest(raw: unknown): ReleaseRequest {
  const request = Schema.decodeUnknownSync(ReleaseRequest)(raw)
  const existing = store.get(request.requestID)
  if (existing !== undefined) {
    if (canonicalJson(existing.request) === canonicalJson(request)) {
      return existing.request
    }
    throw new ReleaseRequestConflictError({
      requestID: request.requestID,
      message: `Release request ${request.requestID} already exists with differing payload`,
    })
  }

  const generation = request.kind === "promote" ? request.expectedCurrentGeneration : 0
  const status: ReleaseRequestStatus = {
    requestID: request.requestID,
    state: "accepted",
    generation,
    detail: null,
    observedAt: new Date().toISOString(),
  }
  store.set(request.requestID, { request, status })
  return request
}

export function getReleaseRequestStatus(requestID: string): ReleaseRequestStatus {
  const existing = store.get(requestID)
  if (existing === undefined) {
    throw new ReleaseRequestNotFoundError({
      requestID,
      message: `Release request ${requestID} not found`,
    })
  }
  return existing.status
}

export function findReleaseRequestStatus(requestID: string): ReleaseRequestStatus | null {
  const existing = store.get(requestID)
  if (existing === undefined) return null
  return existing.status
}
