export * as ReleaseRequestStore from "./request.js"

import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Global } from "@opencode/util/global"
import {
  canonicalReleaseJson,
  ReleaseControllerPermit,
  releasePermitPayload,
  ReleaseRequest,
  ReleaseRequestStatus,
} from "@opencode/schema/release"
import { eq } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { createHash, createPublicKey, verify } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { Database } from "../database/database.js"
import { KVTable } from "../kv/sql.js"
import { SessionAdmission } from "../session/admission.js"

// The bounded release request surface, durable and host-side. A caller records a
// promotion or build intent and reads its status; that is the whole vocabulary
// this store offers. It never builds, never promotes and never activates:
// `authorize` only records an external controller's decision and closes the
// session admission fence, and `settle` only records the outcome the controller
// reports back. The product holds issuer *public* keys, so it can read a permit
// and refuse one, but it has no key that mints one.
//
// Durability is the point, not a nicety. A promotion replaces this process, so a
// consumed-permit record kept in process memory could not survive the one event
// this store exists to guard: the reconstructed store must still refuse a permit
// that was already spent.

export type RefusalReason =
  | "request_conflict"
  | "unknown_request"
  | "no_authority"
  | "malformed_permit"
  | "unknown_issuer"
  | "bad_signature"
  | "expired_permit"
  | "replayed_permit"
  | "request_mismatch"
  | "scope_widened"
  | "unsupported_request"
  | "artifact_mismatch"
  | "generation_mismatch"
  | "already_settled"
  | "authority_conflict"
  | "fence_unavailable"

export interface Refusal {
  readonly ok: false
  readonly reason: RefusalReason
  readonly message: string
}

export interface Settled {
  readonly ok: true
  readonly status: ReleaseRequestStatus
  /** True when this call found the recorded outcome instead of producing a new one. */
  readonly reconciled: boolean
}

export type RequestResult = Settled | Refusal

export interface SubmitInput {
  readonly request: ReleaseRequest
  readonly now?: number
}

export interface AuthorizeInput {
  readonly requestID: string
  /** Presented permit material. Untrusted: it is decoded and verified here, never before. */
  readonly permit: unknown
  readonly now?: number
}

export interface SettleInput {
  readonly requestID: string
  readonly token: string
  readonly outcome: "completed" | "failed" | "rejected"
  readonly detail?: string
  readonly now?: number
}

export interface Interface {
  readonly submit: (input: SubmitInput) => Effect.Effect<RequestResult>
  readonly status: (requestID: string) => Effect.Effect<RequestResult>
  readonly authorize: (input: AuthorizeInput) => Effect.Effect<RequestResult>
  readonly settle: (input: SettleInput) => Effect.Effect<RequestResult>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ReleaseRequestStore") {}

/**
 * The operator-owned controller anchor: which issuers this host trusts and which
 * generation it is running. It is read from the config directory, never from a
 * request, so a caller cannot present its own trust along with its own permit.
 * An absent or unreadable anchor trusts nobody.
 */
const ControllerAnchor = Schema.Struct({
  generation: Schema.Int,
  issuers: Schema.Record(Schema.String, Schema.String),
})
type ControllerAnchor = typeof ControllerAnchor.Type

const StoredRequest = Schema.Struct({
  request: ReleaseRequest,
  fingerprint: Schema.String,
  status: ReleaseRequestStatus,
  token: Schema.NullOr(Schema.String),
})
type StoredRequest = typeof StoredRequest.Type

const StoredRequestJson = Schema.fromJsonString(StoredRequest)
const AnchorJson = Schema.fromJsonString(ControllerAnchor)
const encodeStored = Schema.encodeSync(StoredRequestJson)
const decodeStored = Schema.decodeUnknownOption(StoredRequestJson)
const decodeAnchor = Schema.decodeUnknownOption(AnchorJson)
const decodePermit = Schema.decodeUnknownOption(ReleaseControllerPermit)

const untrusted: ControllerAnchor = { generation: 0, issuers: {} }

const requestKey = (requestID: string) => `release:request:${requestID}`
const permitKey = (permitID: string) => `release:permit:${permitID}`

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const global = yield* Global.Service
    const db = database.db
    const anchorFile = path.join(global.config, "release", "controller.json")

    // Both records live in the durable key-value table, so a store rebuilt in a
    // replacement process reads exactly what the previous one committed.
    const loadRequest = Effect.fn("ReleaseRequestStore.loadRequest")(function* (requestID: string) {
      const row = yield* db
        .select({ value: KVTable.value })
        .from(KVTable)
        .where(eq(KVTable.key, requestKey(requestID)))
        .get()
        .pipe(Effect.orDie)
      if (row === undefined) return undefined
      return Option.getOrUndefined(decodeStored(row.value))
    })

    const saveRequest = Effect.fn("ReleaseRequestStore.saveRequest")(function* (stored: StoredRequest) {
      const value = encodeStored(stored)
      yield* db
        .insert(KVTable)
        .values({ key: requestKey(stored.status.requestID), value })
        .onConflictDoUpdate({ target: KVTable.key, set: { value, time_updated: Date.now() } })
        .run()
        .pipe(Effect.orDie)
    })

    const permitOwner = Effect.fn("ReleaseRequestStore.permitOwner")(function* (permitID: string) {
      const row = yield* db
        .select({ value: KVTable.value })
        .from(KVTable)
        .where(eq(KVTable.key, permitKey(permitID)))
        .get()
        .pipe(Effect.orDie)
      if (row === undefined || typeof row.value !== "string") return undefined
      return row.value
    })

    /** Spends a permit exactly once. Reports false when another request already spent it. */
    const claimPermit = Effect.fn("ReleaseRequestStore.claimPermit")(function* (permitID: string, requestID: string) {
      const inserted = yield* db
        .insert(KVTable)
        .values({ key: permitKey(permitID), value: requestID })
        .onConflictDoNothing()
        .returning({ key: KVTable.key })
        .get()
        .pipe(Effect.orDie)
      return inserted !== undefined
    })

    const anchor = Effect.fn("ReleaseRequestStore.anchor")(function* () {
      const text = yield* Effect.promise(() => readFile(anchorFile, "utf8").catch(() => undefined))
      const decoded = decodeAnchor(text)
      return Option.getOrElse(decoded, () => untrusted)
    })

    const moment = (now: number | undefined) =>
      now === undefined ? Clock.currentTimeMillis : Effect.succeed(now)

    return Service.of({
      submit: Effect.fn("ReleaseRequestStore.submit")(function* (input) {
        const fingerprint = releaseRequestDigest(input.request)
        const existing = yield* loadRequest(input.request.requestID)
        if (existing !== undefined) {
          // A bounded retry reconciles the recorded request; only a changed body conflicts.
          if (existing.fingerprint === fingerprint) return recorded(existing.status, true)
          return refuse(
            "request_conflict",
            `Release request ${input.request.requestID} is already recorded with a different body`,
          )
        }
        const stored: StoredRequest = {
          request: input.request,
          fingerprint,
          status: {
            requestID: input.request.requestID,
            state: "accepted",
            // A build request replaces no running generation, so it records none.
            generation: input.request.kind === "promote" ? input.request.expectedCurrentGeneration : 0,
            detail: null,
            observedAt: new Date(yield* moment(input.now)).toISOString(),
          },
          token: null,
        }
        yield* saveRequest(stored)
        return recorded(stored.status, false)
      }),

      status: Effect.fn("ReleaseRequestStore.status")(function* (requestID) {
        const stored = yield* loadRequest(requestID)
        if (stored === undefined) return refuse("unknown_request", `Release request ${requestID} was never submitted`)
        return recorded(stored.status, true)
      }),

      /**
       * Records an external controller's authorization and fences session admission
       * for the transition it authorizes. Nothing here promotes or rebuilds anything:
       * the request moves to `running` only because the controller decided it would,
       * and the fence closes so no new work enters a session about to be replaced.
       */
      authorize: Effect.fn("ReleaseRequestStore.authorize")(function* (input) {
        const stored = yield* loadRequest(input.requestID)
        if (stored === undefined)
          return refuse("unknown_request", `Release request ${input.requestID} was never submitted`)

        const approvalRef = stored.request.approvalRef
        if (approvalRef === null || approvalRef.length === 0)
          return refuse("no_authority", `Release request ${input.requestID} carries no approval reference`)
        if (input.permit === undefined || input.permit === null)
          return refuse("no_authority", `Release request ${input.requestID} was presented without a controller permit`)

        const decoded = decodePermit(input.permit)
        if (Option.isNone(decoded)) return refuse("malformed_permit", "Presented value is not a controller permit")
        const permit = decoded.value

        if (approvalRef !== permit.permitID)
          return refuse(
            "no_authority",
            `Release request ${input.requestID} names approval ${approvalRef}, not ${permit.permitID}`,
          )

        const trust = yield* anchor()
        const key = trust.issuers[permit.issuer]
        if (key === undefined)
          return refuse("unknown_issuer", `Permit issuer ${permit.issuer} is not a trusted controller`)
        if (!verifyPermit(permit, key))
          return refuse("bad_signature", `Permit ${permit.permitID} is not signed by ${permit.issuer}`)

        const validity = validityWindow(permit)
        if (validity === undefined)
          return refuse("malformed_permit", `Permit ${permit.permitID} has an unreadable validity window`)
        const now = yield* moment(input.now)
        if (now < validity.from || now >= validity.until)
          return refuse("expired_permit", `Permit ${permit.permitID} is not valid at ${new Date(now).toISOString()}`)

        if (permit.requestID !== input.requestID)
          return refuse(
            "request_mismatch",
            `Permit ${permit.permitID} authorizes ${permit.requestID}, not ${input.requestID}`,
          )
        if (permit.requestDigest !== stored.fingerprint)
          return refuse(
            "scope_widened",
            `Release request ${input.requestID} no longer matches the body permit ${permit.permitID} authorized`,
          )

        // The permit is authentic and bound to this exact request, so a repeat is a
        // retry of a decided transition, never a second one.
        const owner = yield* permitOwner(permit.permitID)
        const replay = replayOf(stored, permit.permitID, owner)
        if (replay !== undefined) return replay

        const request = stored.request
        if (request.kind !== "promote")
          return refuse("unsupported_request", `Release request ${input.requestID} is a build intent and activates nothing`)
        if (permit.artifactSha256 !== request.artifact.binarySha256)
          return refuse(
            "artifact_mismatch",
            `Permit ${permit.permitID} authorizes artifact ${permit.artifactSha256}, not ${request.artifact.binarySha256}`,
          )
        if (permit.expectedGeneration !== request.expectedCurrentGeneration)
          return refuse(
            "generation_mismatch",
            `Permit ${permit.permitID} expects generation ${permit.expectedGeneration}, request expects ${request.expectedCurrentGeneration}`,
          )
        if (request.expectedCurrentGeneration !== trust.generation)
          return refuse(
            "generation_mismatch",
            `Release request ${input.requestID} expects generation ${request.expectedCurrentGeneration}, running generation is ${trust.generation}`,
          )

        // Fence first: an authorized transition that cannot close admission is not
        // authorized at all, so nothing is consumed and the retry stays available.
        const fenced = SessionAdmission.engage({
          token: permit.permitID,
          reason: `release promotion ${input.requestID}`,
        })
        if (!fenced.ok)
          return refuse(
            "fence_unavailable",
            `Session admission could not be fenced for release request ${input.requestID}: ${fenced.message}`,
          )

        // A permit another process spent between the read above and here is a replay.
        // The fence stays engaged: this process refuses, it does not reopen admission
        // on an outcome it cannot explain.
        const claimed = yield* claimPermit(permit.permitID, input.requestID)
        if (!claimed) return refuse("replayed_permit", `Permit ${permit.permitID} was already consumed`)

        const running: StoredRequest = {
          request: stored.request,
          fingerprint: stored.fingerprint,
          status: {
            requestID: input.requestID,
            state: "running",
            generation: permit.expectedGeneration,
            detail: `authorized by ${permit.issuer}`,
            observedAt: new Date(now).toISOString(),
          },
          token: permit.permitID,
        }
        yield* saveRequest(running)
        return recorded(running.status, false)
      }),

      /** Records the controller's reported outcome and releases the fence it engaged. */
      settle: Effect.fn("ReleaseRequestStore.settle")(function* (input) {
        const stored = yield* loadRequest(input.requestID)
        if (stored === undefined)
          return refuse("unknown_request", `Release request ${input.requestID} was never submitted`)
        if (isTerminal(stored.status.state)) {
          if (stored.token === input.token && stored.status.state === input.outcome)
            return recorded(stored.status, true)
          return refuse("already_settled", `Release request ${input.requestID} already settled as ${stored.status.state}`)
        }
        if (stored.status.state !== "running")
          return refuse("no_authority", `Release request ${input.requestID} has no authorized transition to settle`)
        if (stored.token !== input.token)
          return refuse("authority_conflict", `Release request ${input.requestID} was authorized by another permit`)

        const released = SessionAdmission.release(input.token)
        if (!released.ok)
          return refuse(
            "fence_unavailable",
            `Session admission could not be released for release request ${input.requestID}: ${released.message}`,
          )

        const settled: StoredRequest = {
          request: stored.request,
          fingerprint: stored.fingerprint,
          status: {
            requestID: input.requestID,
            state: input.outcome,
            generation: stored.status.generation,
            detail: input.detail ?? null,
            observedAt: new Date(yield* moment(input.now)).toISOString(),
          },
          token: stored.token,
        }
        yield* saveRequest(settled)
        return recorded(settled.status, false)
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, Global.node] })

/** The canonical digest a controller signs to bind a permit to one exact request body. */
export function releaseRequestDigest(request: ReleaseRequest): string {
  return createHash("sha256").update(canonicalReleaseJson(request)).digest("hex")
}

// A permit presented against the request that already consumed it never
// re-executes: the recorded outcome is returned as-is. A permit already spent on
// a different request is a replay, and a second permit on a live or decided
// transition is a conflict.
function replayOf(stored: StoredRequest, permitID: string, owner: string | undefined): RequestResult | undefined {
  if (owner !== undefined && owner !== stored.status.requestID)
    return refuse("replayed_permit", `Permit ${permitID} was already consumed by ${owner}`)
  if (isTerminal(stored.status.state)) {
    if (stored.token === permitID) return recorded(stored.status, true)
    return refuse("already_settled", `Release request ${stored.status.requestID} already settled as ${stored.status.state}`)
  }
  if (stored.status.state === "running") {
    if (stored.token === permitID) return recorded(stored.status, true)
    return refuse("authority_conflict", `Release request ${stored.status.requestID} is already running under another permit`)
  }
  if (owner !== undefined) return refuse("replayed_permit", `Permit ${permitID} was already consumed`)
  return undefined
}

function isTerminal(state: ReleaseRequestStatus["state"]): boolean {
  return state === "completed" || state === "failed" || state === "rejected"
}

// A malformed key or a signature over the wrong curve throws rather than
// returning false, and an unverifiable permit must never authorize anything.
function verifyPermit(permit: ReleaseControllerPermit, key: string): boolean {
  try {
    return verify(
      null,
      Buffer.from(releasePermitPayload(permit), "utf8"),
      createPublicKey(key),
      Buffer.from(permit.signature, "hex"),
    )
  } catch {
    return false
  }
}

function validityWindow(permit: ReleaseControllerPermit): { readonly from: number; readonly until: number } | undefined {
  const from = Date.parse(permit.issuedAt)
  const until = Date.parse(permit.expiresAt)
  if (Number.isNaN(from) || Number.isNaN(until) || until <= from) return undefined
  return { from, until }
}

function recorded(status: ReleaseRequestStatus, reconciled: boolean): Settled {
  return { ok: true, status, reconciled }
}

function refuse(reason: RefusalReason, message: string): Refusal {
  return { ok: false, reason, message }
}
