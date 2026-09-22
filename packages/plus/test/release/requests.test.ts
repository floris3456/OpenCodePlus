import { beforeEach, describe, expect, test } from "bun:test"
import { generateKeyPairSync, sign } from "node:crypto"
import { Agent } from "@opencode/schema/agent"
import { ReleaseRequest } from "@opencode/schema/release"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"
import {
  authorizeReleaseRequest,
  getReleaseRequestStatus,
  permitSigningPayload,
  releaseRequestDigest,
  resetReleaseStore,
  settleReleaseRequest,
  submitReleaseRequest,
  type AdmissionFencePort,
  type ControllerTrust,
  type PermitBody,
} from "../../src/release/request.js"
import { registerReleaseTools } from "../../src/release/tools.js"
import { context, toolHarness } from "../harness.js"

const decodeRequest = Schema.decodeUnknownSync(ReleaseRequest)

const controllerKeys = generateKeyPairSync("ed25519")
const strangerKeys = generateKeyPairSync("ed25519")
const controllerPem = controllerKeys.publicKey.export({ type: "spki", format: "pem" }).toString()
const strangerPem = strangerKeys.publicKey.export({ type: "spki", format: "pem" }).toString()

const trust: ControllerTrust = { issuers: { "controller.release": controllerPem } }

const NOW = Date.parse("2026-09-23T12:00:00.000Z")
const CURRENT_GENERATION = 7

const release = {
  product: "opencodeplus",
  channel: "plus",
  version: "1.2.3",
  sourceSha: "0123456789abcdef0123456789abcdef01234567",
  recipeDigest: "c".repeat(64),
  toolchainDigest: "d".repeat(64),
}

const artifact = {
  target: "linux-x64",
  archiveName: "opencodeplus-linux-x64.tar.gz",
  archiveSha256: "a".repeat(64),
  binarySha256: "b".repeat(64),
  bytes: 4096,
}

function promotion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestID: "rel_req_1",
    kind: "promote",
    release,
    artifact,
    expectedCurrentGeneration: CURRENT_GENERATION,
    approvalRef: "permit_controller_1",
    requestedAt: "2026-09-23T11:59:00.000Z",
    ...overrides,
  }
}

function bodyDigest(raw: Record<string, unknown>): string {
  return releaseRequestDigest(decodeRequest(raw))
}

function permitBody(overrides: Partial<PermitBody> = {}): PermitBody {
  return {
    permitID: "permit_controller_1",
    requestID: "rel_req_1",
    requestDigest: bodyDigest(promotion()),
    artifactSha256: artifact.binarySha256,
    expectedGeneration: CURRENT_GENERATION,
    issuer: "controller.release",
    issuedAt: "2026-09-23T11:00:00.000Z",
    expiresAt: "2026-09-23T13:00:00.000Z",
    ...overrides,
  }
}

function issue(body: PermitBody, key = controllerKeys.privateKey): Record<string, unknown> {
  return {
    ...body,
    signature: sign(null, Buffer.from(permitSigningPayload(body), "utf8"), key).toString("hex"),
  }
}

interface FenceDouble {
  readonly port: AdmissionFencePort
  readonly engaged: string[]
  readonly released: string[]
  readonly held: () => string | undefined
}

function fenceDouble(behaviour?: { readonly engages?: boolean; readonly releases?: boolean }): FenceDouble {
  const engaged: string[] = []
  const released: string[] = []
  let held: string | undefined
  return {
    engaged,
    released,
    held: () => held,
    port: {
      engage: (hold) => {
        if (behaviour?.engages === false) return false
        if (held !== undefined && held !== hold.token) return false
        held = hold.token
        engaged.push(hold.token)
        return true
      },
      release: (token) => {
        if (behaviour?.releases === false) return false
        if (held !== token) return false
        held = undefined
        released.push(token)
        return true
      },
    },
  }
}

function authorize(
  fence: FenceDouble,
  permit: unknown,
  overrides?: { readonly requestID?: string; readonly now?: number; readonly currentGeneration?: number },
) {
  return authorizeReleaseRequest({
    requestID: overrides?.requestID ?? "rel_req_1",
    permit,
    trust,
    fence: fence.port,
    currentGeneration: overrides?.currentGeneration ?? CURRENT_GENERATION,
    now: overrides?.now ?? NOW,
  })
}

beforeEach(() => {
  resetReleaseStore()
})

describe("release request surface", () => {
  test("submitting records an intent and activates nothing", () => {
    const fence = fenceDouble()
    const submitted = submitReleaseRequest(promotion(), { now: NOW })

    expect(submitted.ok).toBe(true)
    if (!submitted.ok) return
    expect(submitted.reconciled).toBe(false)
    expect(submitted.status).toMatchObject({ requestID: "rel_req_1", state: "accepted", generation: 7, detail: null })
    expect(fence.engaged).toEqual([])

    const read = getReleaseRequestStatus("rel_req_1")
    expect(read.ok).toBe(true)
    if (read.ok) expect(read.status.state).toBe("accepted")
  })

  test("a bounded retry reconciles instead of creating a second request", () => {
    const first = submitReleaseRequest(promotion(), { now: NOW })
    const retry = submitReleaseRequest(promotion(), { now: NOW + 5_000 })

    expect(first.ok && retry.ok).toBe(true)
    if (!first.ok || !retry.ok) return
    expect(retry.reconciled).toBe(true)
    // The reconciled retry returns the first recording, not a fresh one.
    expect(retry.status).toEqual(first.status)
  })

  test("a retry that changes the request body conflicts rather than replacing it", () => {
    submitReleaseRequest(promotion(), { now: NOW })
    const widened = submitReleaseRequest(
      promotion({ artifact: { ...artifact, binarySha256: "e".repeat(64) } }),
      { now: NOW },
    )

    expect(widened.ok).toBe(false)
    if (widened.ok) return
    expect(widened.reason).toBe("request_conflict")

    const read = getReleaseRequestStatus("rel_req_1")
    expect(read.ok && read.status.state).toBe("accepted")
  })

  test("a malformed submission and an unknown status read are refused", () => {
    const malformed = submitReleaseRequest({ requestID: "rel_req_1", kind: "promote" })
    expect(malformed.ok).toBe(false)
    if (!malformed.ok) expect(malformed.reason).toBe("malformed_request")

    const missing = getReleaseRequestStatus("rel_req_missing")
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.reason).toBe("unknown_request")
  })
})

describe("controller authority", () => {
  test("a candidate-written approval flag grants nothing", () => {
    const fence = fenceDouble()
    // The candidate writes its own approval into the request body.
    const submitted = submitReleaseRequest(promotion({ approved: true, approvalRef: null }), { now: NOW })
    expect(submitted.ok && submitted.status.state).toBe("accepted")

    const refused = authorize(fence, undefined)
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.reason).toBe("no_authority")
    expect(fence.engaged).toEqual([])
    expect(getReleaseRequestStatus("rel_req_1")).toMatchObject({ ok: true, status: { state: "accepted" } })
  })

  test("an empty approval reference is not authority", () => {
    const fence = fenceDouble()
    submitReleaseRequest(promotion({ approvalRef: "" }), { now: NOW })

    const refused = authorize(fence, issue(permitBody()))
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.reason).toBe("no_authority")
    expect(fence.engaged).toEqual([])
  })

  test("a valid request without a presented permit is refused", () => {
    const fence = fenceDouble()
    submitReleaseRequest(promotion(), { now: NOW })

    const refused = authorize(fence, undefined)
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.reason).toBe("no_authority")
    expect(fence.engaged).toEqual([])
  })

  test("a model-signed blob from an untrusted issuer is refused", () => {
    const fence = fenceDouble()
    submitReleaseRequest(promotion(), { now: NOW })

    const unknownIssuer = authorize(fence, issue(permitBody({ issuer: "candidate.self" }), strangerKeys.privateKey))
    expect(unknownIssuer.ok).toBe(false)
    if (!unknownIssuer.ok) expect(unknownIssuer.reason).toBe("unknown_issuer")

    // Same issuer name, wrong key: only the controller's key verifies.
    const forged = authorize(fence, issue(permitBody(), strangerKeys.privateKey))
    expect(forged.ok).toBe(false)
    if (!forged.ok) expect(forged.reason).toBe("bad_signature")
    expect(fence.engaged).toEqual([])
  })

  test("a permit whose body was edited after signing is refused", () => {
    const fence = fenceDouble()
    submitReleaseRequest(promotion(), { now: NOW })

    const tampered = { ...issue(permitBody()), expectedGeneration: 99 }
    const refused = authorize(fence, tampered)
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.reason).toBe("bad_signature")
    expect(fence.engaged).toEqual([])
  })

  test("an expired permit is refused", () => {
    const fence = fenceDouble()
    submitReleaseRequest(promotion(), { now: NOW })

    const expired = authorize(fence, issue(permitBody()), { now: Date.parse("2026-09-23T13:00:00.000Z") })
    expect(expired.ok).toBe(false)
    if (!expired.ok) expect(expired.reason).toBe("expired_permit")

    const early = authorize(fence, issue(permitBody()), { now: Date.parse("2026-09-23T10:59:59.000Z") })
    expect(early.ok).toBe(false)
    if (!early.ok) expect(early.reason).toBe("expired_permit")
    expect(fence.engaged).toEqual([])
  })

  test("a permit bound to another request is refused", () => {
    const fence = fenceDouble()
    submitReleaseRequest(promotion(), { now: NOW })

    const refused = authorize(fence, issue(permitBody({ requestID: "rel_req_other" })))
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.reason).toBe("request_mismatch")
    expect(fence.engaged).toEqual([])
  })

  test("a request that widened its scope after the permit was issued is refused", () => {
    const fence = fenceDouble()
    // The controller signed the 1.2.3 promotion; the recorded request promotes 9.9.9.
    const narrow = permitBody({ requestDigest: bodyDigest(promotion()) })
    submitReleaseRequest(promotion({ release: { ...release, version: "9.9.9" } }), { now: NOW })

    const refused = authorize(fence, issue(narrow))
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.reason).toBe("scope_widened")
    expect(fence.engaged).toEqual([])
  })

  test("a permit naming a different artifact is refused", () => {
    const fence = fenceDouble()
    const raw = promotion()
    submitReleaseRequest(raw, { now: NOW })

    const refused = authorize(
      fence,
      issue(permitBody({ artifactSha256: "f".repeat(64), requestDigest: bodyDigest(raw) })),
    )
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.reason).toBe("artifact_mismatch")
    expect(fence.engaged).toEqual([])
  })

  test("a wrong expected generation is refused on both sides", () => {
    const fence = fenceDouble()
    submitReleaseRequest(promotion(), { now: NOW })

    const permitDisagrees = authorize(fence, issue(permitBody({ expectedGeneration: 6 })))
    expect(permitDisagrees.ok).toBe(false)
    if (!permitDisagrees.ok) expect(permitDisagrees.reason).toBe("generation_mismatch")

    // Permit and request agree on 7, but this process is already generation 9.
    const processMoved = authorize(fence, issue(permitBody()), { currentGeneration: 9 })
    expect(processMoved.ok).toBe(false)
    if (!processMoved.ok) expect(processMoved.reason).toBe("generation_mismatch")
    expect(fence.engaged).toEqual([])
  })

  test("a build intent authorizes no activation", () => {
    const fence = fenceDouble()
    const build = {
      requestID: "rel_req_build",
      kind: "build",
      sourceSha: release.sourceSha,
      version: "1.2.3",
      recipeDigest: release.recipeDigest,
      approvalRef: "permit_controller_1",
      requestedAt: "2026-09-23T11:59:00.000Z",
    }
    submitReleaseRequest(build, { now: NOW })

    const refused = authorize(
      fence,
      issue(permitBody({ requestID: "rel_req_build", requestDigest: bodyDigest(build) })),
      { requestID: "rel_req_build" },
    )
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.reason).toBe("unsupported_request")
    expect(fence.engaged).toEqual([])
  })
})

describe("authorized transition", () => {
  test("authorizing fences admission and settling releases it", () => {
    const fence = fenceDouble()
    submitReleaseRequest(promotion(), { now: NOW })

    const authorized = authorize(fence, issue(permitBody()))
    expect(authorized.ok).toBe(true)
    if (!authorized.ok) return
    expect(authorized.status.state).toBe("running")
    expect(fence.engaged).toEqual(["permit_controller_1"])
    expect(fence.held()).toBe("permit_controller_1")

    const settled = settleReleaseRequest({
      requestID: "rel_req_1",
      token: "permit_controller_1",
      outcome: "completed",
      fence: fence.port,
      now: NOW + 1_000,
    })
    expect(settled.ok).toBe(true)
    if (settled.ok) expect(settled.status.state).toBe("completed")
    expect(fence.released).toEqual(["permit_controller_1"])
    expect(fence.held()).toBeUndefined()
  })

  test("fencing fails closed: an unfenceable transition is not authorized", () => {
    const refusing = fenceDouble({ engages: false })
    submitReleaseRequest(promotion(), { now: NOW })

    const refused = authorize(refusing, issue(permitBody()))
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.reason).toBe("fence_unavailable")
    expect(getReleaseRequestStatus("rel_req_1")).toMatchObject({ ok: true, status: { state: "accepted" } })

    // The permit was not consumed, so the same retry succeeds once the fence works.
    const working = fenceDouble()
    const authorized = authorize(working, issue(permitBody()))
    expect(authorized.ok).toBe(true)
    expect(working.engaged).toEqual(["permit_controller_1"])
  })

  test("a settle that cannot release the fence leaves it closed", () => {
    const fence = fenceDouble()
    submitReleaseRequest(promotion(), { now: NOW })
    authorize(fence, issue(permitBody()))

    const stuck = settleReleaseRequest({
      requestID: "rel_req_1",
      token: "permit_controller_1",
      outcome: "completed",
      fence: { engage: () => false, release: () => false },
      now: NOW + 1_000,
    })
    expect(stuck.ok).toBe(false)
    if (!stuck.ok) expect(stuck.reason).toBe("fence_unavailable")
    expect(getReleaseRequestStatus("rel_req_1")).toMatchObject({ ok: true, status: { state: "running" } })
    expect(fence.held()).toBe("permit_controller_1")
  })

  test("settling with another token is refused and keeps the fence closed", () => {
    const fence = fenceDouble()
    submitReleaseRequest(promotion(), { now: NOW })
    authorize(fence, issue(permitBody()))

    const refused = settleReleaseRequest({
      requestID: "rel_req_1",
      token: "permit_other_9",
      outcome: "completed",
      fence: fence.port,
      now: NOW + 1_000,
    })
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.reason).toBe("authority_conflict")
    expect(fence.released).toEqual([])
    expect(fence.held()).toBe("permit_controller_1")
  })

  test("settling without an authorized transition is refused", () => {
    const fence = fenceDouble()
    submitReleaseRequest(promotion(), { now: NOW })

    const refused = settleReleaseRequest({
      requestID: "rel_req_1",
      token: "permit_controller_1",
      outcome: "completed",
      fence: fence.port,
      now: NOW,
    })
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.reason).toBe("no_authority")
  })
})

describe("replay", () => {
  test("replaying a settled request returns the outcome without re-executing", () => {
    const fence = fenceDouble()
    submitReleaseRequest(promotion(), { now: NOW })
    const permit = issue(permitBody())

    authorize(fence, permit)
    settleReleaseRequest({
      requestID: "rel_req_1",
      token: "permit_controller_1",
      outcome: "completed",
      detail: "generation 8 running",
      fence: fence.port,
      now: NOW + 1_000,
    })

    const replayed = authorize(fence, permit)
    expect(replayed.ok).toBe(true)
    if (!replayed.ok) return
    expect(replayed.reconciled).toBe(true)
    expect(replayed.status).toMatchObject({ state: "completed", detail: "generation 8 running" })
    // Nothing ran a second time: the fence was engaged and released exactly once.
    expect(fence.engaged).toEqual(["permit_controller_1"])
    expect(fence.released).toEqual(["permit_controller_1"])
    expect(fence.held()).toBeUndefined()
  })

  test("a settled request cannot be re-settled", () => {
    const fence = fenceDouble()
    submitReleaseRequest(promotion(), { now: NOW })
    authorize(fence, issue(permitBody()))
    settleReleaseRequest({
      requestID: "rel_req_1",
      token: "permit_controller_1",
      outcome: "completed",
      fence: fence.port,
      now: NOW + 1_000,
    })

    const again = settleReleaseRequest({
      requestID: "rel_req_1",
      token: "permit_controller_1",
      outcome: "failed",
      fence: fence.port,
      now: NOW + 2_000,
    })
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.reason).toBe("already_settled")
    expect(fence.released).toEqual(["permit_controller_1"])
  })

  test("a consumed permit cannot authorize a second request", () => {
    const fence = fenceDouble()
    submitReleaseRequest(promotion(), { now: NOW })
    authorize(fence, issue(permitBody()))
    settleReleaseRequest({
      requestID: "rel_req_1",
      token: "permit_controller_1",
      outcome: "completed",
      fence: fence.port,
      now: NOW + 1_000,
    })

    const second = promotion({ requestID: "rel_req_2" })
    submitReleaseRequest(second, { now: NOW + 2_000 })
    const replayed = authorize(
      fence,
      issue(permitBody({ requestID: "rel_req_2", requestDigest: bodyDigest(second) })),
      { requestID: "rel_req_2", now: NOW + 2_000 },
    )

    expect(replayed.ok).toBe(false)
    if (!replayed.ok) expect(replayed.reason).toBe("replayed_permit")
    expect(fence.engaged).toEqual(["permit_controller_1"])
  })

  test("a second permit for a live transition is refused", () => {
    const fence = fenceDouble()
    const raw = promotion({ approvalRef: "permit_controller_1" })
    submitReleaseRequest(raw, { now: NOW })
    authorize(fence, issue(permitBody()))

    const rival = authorize(fence, issue(permitBody({ permitID: "permit_controller_2" })))
    expect(rival.ok).toBe(false)
    // The recorded request names permit_controller_1, so a rival permit is not its authority.
    if (!rival.ok) expect(rival.reason).toBe("no_authority")
    expect(fence.engaged).toEqual(["permit_controller_1"])
  })
})

describe("release tool surface", () => {
  test("registers exactly a request and a status tool", async () => {
    const harness = toolHarness()
    await registerReleaseTools(context({ tool: harness.domain }))

    // Submit and read, nothing more: no tool promotes, rebuilds, approves or activates.
    expect(Array.from(harness.tools.keys()).toSorted()).toEqual(["release_request", "release_status"])
    for (const tool of harness.tools.values()) {
      expect(tool.name).not.toMatch(/promote|activate|approve|authorize|install|restart|build/i)
      expect(tool.options?.permission).toBe("release")
    }
  })

  test("the request tool records intent and the status tool reads it back", async () => {
    const harness = toolHarness()
    await registerReleaseTools(context({ tool: harness.domain }))

    const request = harness.tools.get("release_request")
    const status = harness.tools.get("release_status")
    expect(request).toBeDefined()
    expect(status).toBeDefined()
    if (request === undefined || status === undefined) return

    const submitted = await Effect.runPromise(
      request.execute(decodeRequest(promotion()), toolContext()).pipe(Effect.map((result) => result.output)),
    )
    expect(submitted).toMatchObject({ requestID: "rel_req_1", state: "accepted", reconciled: false })

    const read = await Effect.runPromise(
      status.execute({ requestID: "rel_req_1" }, toolContext()).pipe(Effect.map((result) => result.output)),
    )
    expect(read).toMatchObject({ requestID: "rel_req_1", state: "accepted" })
  })

  test("the status tool refuses an unknown request", async () => {
    const harness = toolHarness()
    await registerReleaseTools(context({ tool: harness.domain }))

    const status = harness.tools.get("release_status")
    expect(status).toBeDefined()
    if (status === undefined) return

    const error = await Effect.runPromise(
      status.execute({ requestID: "rel_req_missing" }, toolContext()).pipe(Effect.flip),
    )
    expect(error).toBeInstanceOf(Tool.Error)
    expect(error.message).toContain("unknown_request")
  })
})

function toolContext(): Tool.Context {
  return {
    sessionID: Session.ID.make("ses_release_test"),
    agent: Agent.ID.make("build"),
    messageID: SessionMessage.ID.make("msg_release_test"),
    id: Tool.CallID.make("call_release_test"),
    progress: () => Effect.void,
  }
}
