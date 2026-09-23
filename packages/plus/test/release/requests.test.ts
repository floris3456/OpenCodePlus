import { describe, expect, test } from "bun:test"
import type { ReleaseDomain, ReleaseResult, ReleaseSubmitInput } from "@opencode/plugin/effect/plugin"
import type { ReleasePromotionRequest, ReleaseRequestStatus } from "@opencode/schema/release"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
import { permitSigningPayload, releaseRequestDigest, type PermitBody } from "../../src/release/request.js"
import { registerReleaseTools } from "../../src/release/tools.js"
import { context, toolHarness, type ToolHarness } from "../harness.js"

const CURRENT_GENERATION = 7
const ACCEPTED_AT = "2026-09-23T12:00:00.000Z"

function promotion(): ReleasePromotionRequest {
  return {
    requestID: "rel_req_1",
    kind: "promote",
    release: {
      product: "opencodeplus",
      channel: "plus",
      version: "1.2.3",
      sourceSha: "0123456789abcdef0123456789abcdef01234567",
      recipeDigest: "c".repeat(64),
      toolchainDigest: "d".repeat(64),
    },
    artifact: {
      target: "linux-x64",
      archiveName: "opencodeplus-linux-x64.tar.gz",
      archiveSha256: "a".repeat(64),
      binarySha256: "b".repeat(64),
      bytes: 4096,
    },
    expectedCurrentGeneration: CURRENT_GENERATION,
    approvalRef: "permit_controller_1",
    requestedAt: "2026-09-23T11:59:00.000Z",
  }
}

function acceptedStatus(requestID: string): ReleaseRequestStatus {
  return { requestID, state: "accepted", generation: CURRENT_GENERATION, detail: null, observedAt: ACCEPTED_AT }
}

interface SeamSpy {
  readonly seam: ReleaseDomain
  readonly submits: ReleaseSubmitInput[]
  readonly reads: string[]
}

// A delegation double, not a second store: it records the calls the tools make
// and answers in the host contract's shape. Request, permit and fence semantics
// are covered by the durable store in packages/core/test/release-admission.test.ts.
function seamSpy(readStatus?: (requestID: string) => ReleaseResult): SeamSpy {
  const submits: ReleaseSubmitInput[] = []
  const reads: string[] = []
  return {
    submits,
    reads,
    seam: {
      submit: (input) =>
        Effect.sync(() => {
          submits.push(input)
          return { ok: true as const, status: acceptedStatus(input.request.requestID), reconciled: false }
        }),
      status: (requestID) =>
        Effect.sync(() => {
          reads.push(requestID)
          if (readStatus === undefined) return { ok: true as const, status: acceptedStatus(requestID), reconciled: true }
          return readStatus(requestID)
        }),
    },
  }
}

// The host hands the plugin an object with submit and status only. Standing in
// for that wiring with a proxy that rejects any other property makes a tool
// that reaches for authority fail loudly instead of silently no-oping.
function guardSeam(seam: ReleaseDomain): ReleaseDomain {
  return new Proxy(seam, {
    get: (target, property, receiver) => {
      if (property === "submit" || property === "status") return Reflect.get(target, property, receiver)
      throw new Error(`plugin reached release seam operation ${String(property)}`)
    },
  })
}

async function registerWith(release: ReleaseDomain): Promise<ToolHarness> {
  const harness = toolHarness()
  await registerReleaseTools({ ...context({ tool: harness.domain }), release })
  return harness
}

async function registerWithoutSeam(): Promise<ToolHarness> {
  const harness = toolHarness()
  await registerReleaseTools(context({ tool: harness.domain }))
  return harness
}

interface ReleaseTools {
  readonly request: Tool.Info
  readonly status: Tool.Info
}

function releaseTools(harness: ToolHarness): ReleaseTools | undefined {
  const request = harness.tools.get("release_request")
  const status = harness.tools.get("release_status")
  if (request === undefined || status === undefined) return undefined
  return { request, status }
}

describe("release tool surface", () => {
  test("registers exactly a request and a status tool", async () => {
    const harness = await registerWithoutSeam()

    // Submit and read, nothing more: no tool promotes, rebuilds, approves or activates.
    expect(Array.from(harness.tools.keys()).toSorted()).toEqual(["release_request", "release_status"])
    for (const tool of harness.tools.values()) {
      expect(tool.name).not.toMatch(/promote|activate|approve|authorize|install|restart|build/i)
      expect(tool.options?.permission).toBe("release")
    }
  })

  test("the request tool submits through the host seam", async () => {
    const spy = seamSpy()
    const tools = releaseTools(await registerWith(spy.seam))
    expect(tools).toBeDefined()
    if (tools === undefined) return

    const output = await Effect.runPromise(
      tools.request.execute(promotion(), toolContext()).pipe(Effect.map((result) => result.output)),
    )
    expect(output).toMatchObject({ requestID: "rel_req_1", state: "accepted", reconciled: false })
    expect(spy.submits).toHaveLength(1)
    expect(spy.submits[0]?.request.requestID).toBe("rel_req_1")
    expect(spy.reads).toEqual([])
  })

  test("the status tool reads through the host seam", async () => {
    const spy = seamSpy()
    const tools = releaseTools(await registerWith(spy.seam))
    expect(tools).toBeDefined()
    if (tools === undefined) return

    const output = await Effect.runPromise(
      tools.status.execute({ requestID: "rel_req_1" }, toolContext()).pipe(Effect.map((result) => result.output)),
    )
    expect(output).toMatchObject({ requestID: "rel_req_1", state: "accepted", reconciled: true })
    expect(spy.reads).toEqual(["rel_req_1"])
    expect(spy.submits).toEqual([])
  })

  test("the status tool refuses an unknown request", async () => {
    const spy = seamSpy((requestID): ReleaseResult => ({
      ok: false,
      reason: "unknown_request",
      message: `Release request ${requestID} was never submitted`,
    }))
    const tools = releaseTools(await registerWith(spy.seam))
    expect(tools).toBeDefined()
    if (tools === undefined) return

    const error = await Effect.runPromise(
      tools.status.execute({ requestID: "rel_req_missing" }, toolContext()).pipe(Effect.flip),
    )
    expect(error).toBeInstanceOf(Tool.Error)
    expect(error.message).toContain("unknown_request")
    expect(spy.reads).toEqual(["rel_req_missing"])
  })

  test("the tools refuse when the host has no release seam", async () => {
    const tools = releaseTools(await registerWithoutSeam())
    expect(tools).toBeDefined()
    if (tools === undefined) return

    const error = await Effect.runPromise(
      tools.request.execute(promotion(), toolContext()).pipe(Effect.flip),
    )
    expect(error).toBeInstanceOf(Tool.Error)
    expect(error.message).toContain("unsupported_host")
  })
})

// Compile-time gate: the seam is exactly submit and status. Adding `authorize`
// or `settle` to Plugin.Context["release"] makes this type false and the
// assignment stops compiling, so the decision has to be made deliberately.
const seamIsBounded: Exclude<keyof ReleaseDomain, "submit" | "status"> extends never ? true : false = true

describe("release seam authority", () => {
  test("the seam exposes submit and status only", () => {
    const spy = seamSpy()
    expect(Object.keys(spy.seam).toSorted()).toEqual(["status", "submit"])
    expect(seamIsBounded).toBe(true)

    // @ts-expect-error The seam has no authorize: granting authority is not a plugin operation.
    spy.seam.authorize
    // @ts-expect-error The seam has no settle: fence transitions are not plugin operations.
    spy.seam.settle
  })

  test("the tools reach nothing but submit and status", async () => {
    const spy = seamSpy()
    const tools = releaseTools(await registerWith(guardSeam(spy.seam)))
    expect(tools).toBeDefined()
    if (tools === undefined) return

    await Effect.runPromise(tools.request.execute(promotion(), toolContext()))
    await Effect.runPromise(tools.status.execute({ requestID: "rel_req_1" }, toolContext()))
    expect(spy.submits).toHaveLength(1)
    expect(spy.reads).toEqual(["rel_req_1"])
  })
})

describe("retained permit helpers", () => {
  test("the request digest and signing payload are canonical", () => {
    const requested = promotion()
    const reordered: ReleasePromotionRequest = {
      requestedAt: requested.requestedAt,
      approvalRef: requested.approvalRef,
      expectedCurrentGeneration: requested.expectedCurrentGeneration,
      artifact: requested.artifact,
      release: requested.release,
      kind: requested.kind,
      requestID: requested.requestID,
    }
    expect(releaseRequestDigest(reordered)).toBe(releaseRequestDigest(requested))

    const body: PermitBody = {
      permitID: "permit_controller_1",
      requestID: "rel_req_1",
      requestDigest: releaseRequestDigest(requested),
      artifactSha256: requested.artifact.binarySha256,
      expectedGeneration: CURRENT_GENERATION,
      issuer: "controller.release",
      issuedAt: "2026-09-23T11:00:00.000Z",
      expiresAt: "2026-09-23T13:00:00.000Z",
    }
    const reorderedBody: PermitBody = {
      expiresAt: body.expiresAt,
      issuedAt: body.issuedAt,
      issuer: body.issuer,
      expectedGeneration: body.expectedGeneration,
      artifactSha256: body.artifactSha256,
      requestDigest: body.requestDigest,
      requestID: body.requestID,
      permitID: body.permitID,
    }
    expect(permitSigningPayload(reorderedBody)).toBe(permitSigningPayload(body))
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