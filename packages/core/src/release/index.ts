export * as Release from "./index.js"

import {
  ReleaseControllerPermit,
  ReleaseRequest,
  ReleaseRequestState,
  ReleaseRequestStatus,
} from "@opencode/schema/release"

export { ReleaseRequestStore, releaseRequestDigest } from "./request.js"
export type { AuthorizeInput, Refusal, RefusalReason, RequestResult, Settled, SettleInput, SubmitInput } from "./request.js"

// The request, permit and status contracts are public wire contracts owned by
// @opencode/schema. This facade re-exports the exact canonical values, so Core and
// Protocol never see a second schema identity for the same contract.
export const Request = ReleaseRequest
export type Request = ReleaseRequest
export const RequestState = ReleaseRequestState
export type RequestState = ReleaseRequestState
export const RequestStatus = ReleaseRequestStatus
export type RequestStatus = ReleaseRequestStatus
export const ControllerPermit = ReleaseControllerPermit
export type ControllerPermit = ReleaseControllerPermit
