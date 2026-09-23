import { expect, test } from "bun:test"
import { SessionAdmission } from "@opencode/core/session/admission"
import { releasePermitPayload, type ReleasePermitBody } from "@opencode/schema/release"
import { RELEASE_PERMIT_HEADER } from "@opencode/protocol/groups/release"
import { Effect } from "effect"
import { HttpApi } from "effect/unstable/httpapi"
import { generateKeyPairSync, createHash, sign } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { Api } from "../src/api"
import { startServer } from "./fixture/server"

// The public HTTP surface of a running product must never be able to replace the
// product. These tests read the real `Api` and talk to a real server process, so a
// route that promotes, activates or installs a release cannot appear unnoticed, and
// the bounded request/status/settle routes that do exist are exercised end to end: a
// request records intent, a permit is verified against the host's trusted issuers,
// the authorized transition closes the real admission fence until the controller
// settles it, and every refusal is observed over the wire rather than in a unit double.

interface RouteFact {
  readonly group: string
  readonly name: string
  readonly method: string
  readonly path: string
}

function routes(): RouteFact[] {
  const found: RouteFact[] = []
  HttpApi.reflect(Api, {
    onGroup() {},
    onEndpoint({ group, endpoint }) {
      found.push({
        group: group.identifier,
        name: endpoint.identifier,
        method: endpoint.method,
        path: endpoint.path,
      })
    },
  })
  return found
}

const controllerKeys = generateKeyPairSync("ed25519")
const strangerKeys = generateKeyPairSync("ed25519")
const controllerPem = controllerKeys.publicKey.export({ type: "spki", format: "pem" }).toString()

const GENERATION = 7

const releaseIdentity = {
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
    release: releaseIdentity,
    artifact,
    expectedCurrentGeneration: GENERATION,
    approvalRef: "permit_controller_1",
    requestedAt: "2026-09-23T11:59:00.000Z",
    ...overrides,
  }
}

// The wire body is the request itself, so the digest a permit commits to is taken
// from exactly the bytes the server decodes.
function bodyDigest(request: Record<string, unknown>): string {
  return createHash("sha256").update(canonical(request)).digest("hex")
}

function canonical(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (typeof value === "object") {
    const record = value as Record<string, unknown>
    const entries = Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    return `{${entries.join(",")}}`
  }
  return JSON.stringify(value)
}

function permitBody(overrides: Partial<ReleasePermitBody> = {}): ReleasePermitBody {
  return {
    permitID: "permit_controller_1",
    requestID: "rel_req_1",
    requestDigest: bodyDigest(promotion()),
    artifactSha256: artifact.binarySha256,
    expectedGeneration: GENERATION,
    issuer: "controller.release",
    // The server reads its own clock, so a permit meant to be valid here spans any
    // plausible wall-clock time rather than a fixed instant.
    issuedAt: "2020-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    ...overrides,
  }
}

function issue(body: ReleasePermitBody, key = controllerKeys.privateKey): string {
  return JSON.stringify({
    ...body,
    signature: sign(null, Buffer.from(releasePermitPayload(body), "utf8"), key).toString("hex"),
  })
}

interface Server {
  readonly base: string
  readonly headers: Record<string, string>
}

const submit = (server: Server, request: Record<string, unknown>, permit?: string) =>
  Effect.promise(() =>
    fetch(new URL("/api/release/request", server.base), {
      method: "POST",
      headers: {
        ...server.headers,
        "content-type": "application/json",
        ...(permit === undefined ? {} : { [RELEASE_PERMIT_HEADER]: permit }),
      },
      body: JSON.stringify(request),
    }),
  )

const read = (server: Server, requestID: string) =>
  Effect.promise(() => fetch(new URL(`/api/release/request/${requestID}`, server.base), { headers: server.headers }))

const settle = (server: Server, requestID: string, body: { token: string; outcome: string; detail?: string }) =>
  Effect.promise(() =>
    fetch(new URL(`/api/release/request/${requestID}/settle`, server.base), {
      method: "POST",
      headers: { ...server.headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  )

/** Writes the operator-owned controller anchor this host will trust. */
const anchor = (directory: string) =>
  Effect.promise(async () => {
    await mkdir(path.join(directory, "release"), { recursive: true })
    await writeFile(
      path.join(directory, "release", "controller.json"),
      JSON.stringify({ generation: GENERATION, issuers: { "controller.release": controllerPem } }),
      "utf8",
    )
  })

test("the real API exposes no route that promotes or activates a release", () => {
  const found = routes()
  expect(found.length).toBeGreaterThan(0)

  const activating = found.filter((route) => /promote|self-?update|upgrade/i.test(`${route.name} ${route.path}`))
  expect(activating).toEqual([])

  // `credential.activate` activates a stored credential, not a release build.
  const releaseActivating = found.filter(
    (route) => /release/i.test(`${route.group} ${route.name} ${route.path}`) && /activate|install/i.test(route.name),
  )
  expect(releaseActivating).toEqual([])
})

test("the release group is exactly a request route, a status route and a settle route", () => {
  const found = routes()

  expect(found.filter((route) => route.group === "server.release")).toEqual([
    { group: "server.release", name: "release.request", method: "POST", path: "/api/release/request" },
    { group: "server.release", name: "release.status", method: "GET", path: "/api/release/request/:requestID" },
    { group: "server.release", name: "release.settle", method: "POST", path: "/api/release/request/:requestID/settle" },
  ])
  // No other group may reach under /api/release either.
  expect(found.filter((route) => route.path.startsWith("/api/release")).map((route) => route.group)).toEqual([
    "server.release",
    "server.release",
    "server.release",
  ])
})

it.live("records a request durably and reads its status back over HTTP", () =>
  Effect.gen(function* () {
    SessionAdmission.reset()
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-release-endpoint-")))
    const server = yield* startServer(tmp.path)

    const submitted = yield* submit(server, promotion())
    expect(submitted.status).toBe(200)
    const recorded = yield* Effect.promise(() => submitted.json())
    expect(recorded).toMatchObject({ requestID: "rel_req_1", state: "accepted", generation: GENERATION, detail: null })

    const status = yield* read(server, "rel_req_1")
    expect(status.status).toBe(200)
    expect(yield* Effect.promise(() => status.json())).toEqual(recorded)

    // A request grants no authority: nothing was activated and nothing was fenced.
    expect(SessionAdmission.isEngaged()).toBe(false)
  }),
)

it.live("refuses an unknown release request", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-release-missing-")))
    const server = yield* startServer(tmp.path)

    const missing = yield* read(server, "rel_req_missing")
    expect(missing.status).toBe(404)
    expect(yield* Effect.promise(() => missing.json())).toMatchObject({
      _tag: "ReleaseRequestNotFoundError",
      requestID: "rel_req_missing",
    })
  }),
)

it.live("conflicts when the same request ID is resubmitted with a different body", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-release-conflict-")))
    const server = yield* startServer(tmp.path)

    expect((yield* submit(server, promotion())).status).toBe(200)
    // A bounded retry of the same body reconciles rather than creating a second request.
    expect((yield* submit(server, promotion())).status).toBe(200)

    const widened = yield* submit(server, promotion({ artifact: { ...artifact, binarySha256: "e".repeat(64) } }))
    expect(widened.status).toBe(409)

    const status = yield* read(server, "rel_req_1")
    expect(yield* Effect.promise(() => status.json())).toMatchObject({ state: "accepted" })
  }),
)

it.live("refuses a forged, expired or wrong-generation permit over HTTP", () =>
  Effect.gen(function* () {
    SessionAdmission.reset()
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-release-permit-")))
    yield* anchor(tmp.path)
    const server = yield* startServer(tmp.path)

    yield* submit(server, promotion())

    // Signed by a stranger under the trusted issuer's name.
    const forged = yield* submit(server, promotion(), issue(permitBody(), strangerKeys.privateKey))
    expect(forged.status).toBe(403)

    // Authentic, but its validity window closed long ago.
    const expired = yield* submit(
      server,
      promotion(),
      issue(permitBody({ issuedAt: "2020-01-01T00:00:00.000Z", expiresAt: "2020-01-02T00:00:00.000Z" })),
    )
    expect(expired.status).toBe(403)

    // Authentic and in date, but for a generation this host is not running.
    const moved = promotion({ requestID: "rel_req_moved", expectedCurrentGeneration: 9 })
    yield* submit(server, moved)
    const generation = yield* submit(
      server,
      moved,
      issue(
        permitBody({ requestID: "rel_req_moved", requestDigest: bodyDigest(moved), expectedGeneration: 9 }),
      ),
    )
    expect(generation.status).toBe(403)

    // Permit-shaped garbage never reaches verification as authority.
    expect((yield* submit(server, promotion(), "not-a-permit")).status).toBe(403)

    // Every refusal left the request exactly as recorded, and fenced nothing.
    const status = yield* read(server, "rel_req_1")
    expect(yield* Effect.promise(() => status.json())).toMatchObject({ state: "accepted" })
    expect(SessionAdmission.isEngaged()).toBe(false)
  }),
)

it.live("spends a controller permit once: the replay is refused over HTTP", () =>
  Effect.gen(function* () {
    SessionAdmission.reset()
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-release-replay-")))
    yield* anchor(tmp.path)
    const server = yield* startServer(tmp.path)

    yield* submit(server, promotion())
    const authorized = yield* submit(server, promotion(), issue(permitBody()))
    expect(authorized.status).toBe(200)
    expect(yield* Effect.promise(() => authorized.json())).toMatchObject({
      requestID: "rel_req_1",
      state: "running",
      generation: GENERATION,
    })
    // The route closed the real admission fence; it did not promote anything.
    expect(SessionAdmission.current()).toEqual({
      token: "permit_controller_1",
      reason: "release promotion rel_req_1",
    })

    const second = promotion({ requestID: "rel_req_2" })
    yield* submit(server, second)
    const replayed = yield* submit(
      server,
      second,
      issue(permitBody({ requestID: "rel_req_2", requestDigest: bodyDigest(second) })),
    )
    expect(replayed.status).toBe(403)
    expect(yield* Effect.promise(() => replayed.json())).toMatchObject({ _tag: "ForbiddenError" })

    const stillAccepted = yield* read(server, "rel_req_2")
    expect(yield* Effect.promise(() => stillAccepted.json())).toMatchObject({ state: "accepted" })

    // This test is the only one that engages the process-wide fence; reopen it so
    // the rest of the suite runs against an admitting process.
    expect(SessionAdmission.release("permit_controller_1")).toEqual({ ok: true, released: true })
  }),
)

it.live("settles an authorized request over HTTP and releases the admission fence", () =>
  Effect.gen(function* () {
    SessionAdmission.reset()
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-release-settle-")))
    yield* anchor(tmp.path)
    const server = yield* startServer(tmp.path)

    yield* submit(server, promotion())
    const authorized = yield* submit(server, promotion(), issue(permitBody()))
    expect(authorized.status).toBe(200)
    // The route closed the real admission fence; it did not promote anything.
    expect(SessionAdmission.current()).toEqual({
      token: "permit_controller_1",
      reason: "release promotion rel_req_1",
    })

    const completed = yield* settle(server, "rel_req_1", {
      token: "permit_controller_1",
      outcome: "completed",
      detail: "generation 8 running",
    })
    expect(completed.status).toBe(200)
    expect(yield* Effect.promise(() => completed.json())).toMatchObject({
      requestID: "rel_req_1",
      state: "completed",
      generation: GENERATION,
      detail: "generation 8 running",
    })
    expect(SessionAdmission.isEngaged()).toBe(false)

    // Repeating the same reported outcome reconciles the recorded one; a different
    // outcome from the same holder is a double settle and conflicts.
    const repeated = yield* settle(server, "rel_req_1", { token: "permit_controller_1", outcome: "completed" })
    expect(repeated.status).toBe(200)
    const changed = yield* settle(server, "rel_req_1", { token: "permit_controller_1", outcome: "failed" })
    expect(changed.status).toBe(409)
    expect(yield* Effect.promise(() => changed.json())).toMatchObject({ _tag: "ConflictError" })

    const status = yield* read(server, "rel_req_1")
    expect(yield* Effect.promise(() => status.json())).toMatchObject({ state: "completed" })
  }),
)

it.live("refuses a settle for an unknown release request", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-release-settle-missing-")))
    const server = yield* startServer(tmp.path)

    const missing = yield* settle(server, "rel_req_missing", { token: "permit_controller_1", outcome: "completed" })
    expect(missing.status).toBe(404)
    expect(yield* Effect.promise(() => missing.json())).toMatchObject({
      _tag: "ReleaseRequestNotFoundError",
      requestID: "rel_req_missing",
    })
  }),
)

it.live("refuses a settle without the authorizing token and never reopens admission", () =>
  Effect.gen(function* () {
    SessionAdmission.reset()
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-release-settle-token-")))
    yield* anchor(tmp.path)
    const server = yield* startServer(tmp.path)

    yield* submit(server, promotion())
    expect((yield* submit(server, promotion(), issue(permitBody()))).status).toBe(200)

    const stranger = yield* settle(server, "rel_req_1", { token: "permit_other_9", outcome: "completed" })
    expect(stranger.status).toBe(409)
    expect(yield* Effect.promise(() => stranger.json())).toMatchObject({ _tag: "ConflictError" })

    // The refused settle left both the recorded transition and the fence untouched.
    expect(SessionAdmission.current()).toEqual({
      token: "permit_controller_1",
      reason: "release promotion rel_req_1",
    })
    const status = yield* read(server, "rel_req_1")
    expect(yield* Effect.promise(() => status.json())).toMatchObject({ state: "running" })

    // The holder can still report the real outcome, which reopens admission.
    const holder = yield* settle(server, "rel_req_1", { token: "permit_controller_1", outcome: "failed" })
    expect(holder.status).toBe(200)
    expect(SessionAdmission.isEngaged()).toBe(false)
  }),
)

it.live("refuses a settle for a request that was never authorized", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-release-settle-unfenced-")))
    const server = yield* startServer(tmp.path)

    yield* submit(server, promotion())
    const refused = yield* settle(server, "rel_req_1", { token: "permit_controller_1", outcome: "completed" })
    expect(refused.status).toBe(403)
    expect(yield* Effect.promise(() => refused.json())).toMatchObject({ _tag: "ForbiddenError" })

    const status = yield* read(server, "rel_req_1")
    expect(yield* Effect.promise(() => status.json())).toMatchObject({ state: "accepted" })
  }),
)

it.live("every route on this surface is fenced by the real authorization middleware", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-release-auth-")))
    const server = yield* startServer(tmp.path)

    const anonymousSubmit = yield* Effect.promise(() =>
      fetch(new URL("/api/release/request", server.base), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(promotion()),
      }),
    )
    expect(anonymousSubmit.status).toBe(401)
    expect(anonymousSubmit.headers.get("www-authenticate")).toBe('Basic realm="Secure Area"')

    const anonymousRead = yield* Effect.promise(() =>
      fetch(new URL("/api/release/request/rel_req_1", server.base)),
    )
    expect(anonymousRead.status).toBe(401)

    const anonymousSettle = yield* Effect.promise(() =>
      fetch(new URL("/api/release/request/rel_req_1/settle", server.base), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "permit_controller_1", outcome: "completed" }),
      }),
    )
    expect(anonymousSettle.status).toBe(401)

    // An anonymous submission never reached the store.
    const authorized = yield* read(server, "rel_req_1")
    expect(authorized.status).toBe(404)

    const refused = yield* Effect.promise(() => fetch(new URL("/api/server", server.base)))
    expect(refused.status).toBe(401)

    const allowed = yield* Effect.promise(() => fetch(new URL("/api/server", server.base), { headers: server.headers }))
    expect(allowed.status).toBe(200)
  }),
)
