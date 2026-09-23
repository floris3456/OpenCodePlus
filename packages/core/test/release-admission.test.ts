import { describe, expect } from "bun:test"
import { Cause, DateTime, Deferred, Effect, Exit, Layer, Schema } from "effect"
import { SessionAdmission, AdmissionFencedError } from "@opencode/core/session/admission"
import { SessionPrompt } from "@opencode/core/session/prompt"
import { SessionRunCoordinator } from "@opencode/core/session/run-coordinator"
import { Database } from "@opencode/core/database/database"
import { Instance } from "@opencode/core/instance/service"
import { ReleaseRequestStore } from "@opencode/core/release/index"
import { FSUtil } from "@opencode/util/fs-util"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { SessionMessage } from "@opencode/schema/session-message"
import { Session } from "@opencode/schema/session"
import { Project } from "@opencode/schema/project"
import { Money } from "@opencode/schema/money"
import { Location } from "@opencode/schema/location"
import { ReleaseRequest, releasePermitPayload, type ReleasePermitBody } from "@opencode/schema/release"
import { AbsolutePath } from "@opencode/schema/schema"
import { generateKeyPairSync, sign } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

const controller = { token: "permit_controller_1", reason: "release promotion permit_controller_1" }

// `SessionPrompt.prepare` reads the fence before it touches a file or selects any
// Session capability, so a fenced prompt reaches neither of these. The filesystem
// is the real one; the selector dies instead of standing in for a Location, so a
// prompt that got past the fence fails this test rather than quietly passing it.
const promptServices = Layer.mergeAll(
  LayerNode.compile(FSUtil.node),
  Layer.succeed(Instance.Service, {
    provide: () => () => Effect.die("SessionPrompt.prepare selected Session capabilities while fenced"),
  }),
)

const session = (id: string) =>
  Session.Info.make({
    id: Session.ID.make(id),
    projectID: Project.ID.global,
    cost: Money.USD.zero,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
    location: Location.Ref.make({ directory: AbsolutePath.make("/tmp") }),
  })

describe("SessionAdmission", () => {
  it.effect("engages for one controller token and reconciles a bounded retry", () =>
    Effect.gen(function* () {
      SessionAdmission.reset()
      expect(SessionAdmission.isEngaged()).toBe(false)
      expect(SessionAdmission.status()).toMatchObject({ fenced: false, hold: undefined, quiescent: false })

      const engaged = SessionAdmission.engage(controller)
      expect(engaged).toEqual({ ok: true, hold: controller, reconciled: false })
      expect(SessionAdmission.isEngaged()).toBe(true)

      const retried = SessionAdmission.engage(controller)
      expect(retried).toEqual({ ok: true, hold: controller, reconciled: true })
      expect(SessionAdmission.current()).toEqual(controller)

      expect(SessionAdmission.release(controller.token)).toEqual({ ok: true, released: true })
      expect(SessionAdmission.isEngaged()).toBe(false)
      expect(SessionAdmission.release(controller.token)).toEqual({ ok: true, released: false })
    }),
  )

  it.effect("fails closed: a non-holder and an empty token never open the fence", () =>
    Effect.gen(function* () {
      SessionAdmission.reset()
      SessionAdmission.engage(controller)

      const stranger = SessionAdmission.release("permit_other_9")
      expect(stranger.ok).toBe(false)
      if (!stranger.ok) expect(stranger.reason).toBe("not_holder")
      expect(SessionAdmission.isEngaged()).toBe(true)

      const blank = SessionAdmission.release("")
      expect(blank.ok).toBe(false)
      if (!blank.ok) expect(blank.reason).toBe("invalid_token")
      expect(SessionAdmission.isEngaged()).toBe(true)

      const second = SessionAdmission.engage({ token: "permit_other_9", reason: "second transition" })
      expect(second.ok).toBe(false)
      if (!second.ok) expect(second.reason).toBe("held_by_other")
      expect(SessionAdmission.current()).toEqual(controller)

      const untokened = SessionAdmission.engage({ token: "", reason: "no authority" })
      expect(untokened.ok).toBe(false)
      if (!untokened.ok) expect(untokened.reason).toBe("invalid_token")

      expect(SessionAdmission.release(controller.token)).toEqual({ ok: true, released: true })
    }),
  )

  it.effect("refuses durable prompt admission while the fence is engaged", () =>
    Effect.gen(function* () {
      SessionAdmission.reset()

      const admitted = yield* SessionAdmission.check.pipe(Effect.exit)
      expect(Exit.isSuccess(admitted)).toBe(true)

      SessionAdmission.engage(controller)

      const exit = yield* SessionPrompt.prepare({
        session: session("ses_test_fenced_1"),
        messageID: SessionMessage.ID.make("msg_test_fenced_1"),
        input: { text: "Hello while fenced" },
      }).pipe(Effect.provide(promptServices), Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const failure = Cause.squash(exit.cause)
        expect(failure).toBeInstanceOf(AdmissionFencedError)
        expect(failure).toMatchObject({ token: controller.token, reason: controller.reason })
      }

      SessionAdmission.release(controller.token)
    }),
  )

  it.effect("does not admit a wake or an explicit resume while the fence is engaged", () =>
    Effect.gen(function* () {
      SessionAdmission.reset()
      SessionAdmission.engage(controller)

      let drains = 0
      const coordinator = yield* SessionRunCoordinator.make<string, never>({
        drain: () => Effect.sync(() => drains++),
      })

      yield* coordinator.wake("ses_auto_1")
      yield* Effect.yieldNow
      expect(drains).toBe(0)
      expect(yield* coordinator.isActive("ses_auto_1")).toBe(false)

      yield* coordinator.run("ses_auto_2")
      yield* Effect.yieldNow
      expect(drains).toBe(0)
      expect(yield* coordinator.isActive("ses_auto_2")).toBe(false)

      SessionAdmission.release(controller.token)
    }),
  )

  it.effect("reports the in-flight execution through to quiescence", () =>
    Effect.gen(function* () {
      SessionAdmission.reset()

      const gate = yield* Deferred.make<void>()
      const started = yield* Deferred.make<void>()
      const coordinator = yield* SessionRunCoordinator.make<string, never>({
        drain: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(gate)
          }),
      })

      yield* coordinator.wake("ses_drain_1")
      yield* Deferred.await(started)

      const running = SessionAdmission.status()
      expect(running.fenced).toBe(false)
      expect(running.activeSessions).toContain("ses_drain_1")
      expect(running.quiescent).toBe(false)

      SessionAdmission.engage(controller)
      const fenced = SessionAdmission.status()
      expect(fenced.fenced).toBe(true)
      expect(fenced.activeSessions).toEqual(["ses_drain_1"])
      expect(fenced.quiescent).toBe(false)

      // A wake for another session while fenced never becomes an execution.
      yield* coordinator.wake("ses_drain_2")
      yield* Effect.yieldNow
      expect(SessionAdmission.status().activeSessions).toEqual(["ses_drain_1"])

      yield* Deferred.succeed(gate, undefined)
      yield* coordinator.awaitIdle("ses_drain_1")

      const quiescent = SessionAdmission.status()
      expect(quiescent.fenced).toBe(true)
      expect(quiescent.activeSessions).toEqual([])
      expect(quiescent.quiescent).toBe(true)

      SessionAdmission.release(controller.token)
    }),
  )

  it.effect("restores admission only after the holder releases", () =>
    Effect.gen(function* () {
      SessionAdmission.reset()
      SessionAdmission.engage(controller)

      let drains = 0
      const drained = yield* Deferred.make<void>()
      const coordinator = yield* SessionRunCoordinator.make<string, never>({
        drain: () =>
          Effect.gen(function* () {
            drains++
            yield* Deferred.succeed(drained, undefined)
          }),
      })

      yield* coordinator.wake("ses_release_1")
      yield* Effect.yieldNow
      expect(drains).toBe(0)

      // A stranger's release leaves the fence closed, so admission stays refused.
      SessionAdmission.release("permit_other_9")
      yield* coordinator.wake("ses_release_1")
      yield* Effect.yieldNow
      expect(drains).toBe(0)

      SessionAdmission.release(controller.token)
      yield* coordinator.wake("ses_release_1")
      yield* Deferred.await(drained)
      expect(drains).toBe(1)

      const prepared = yield* SessionAdmission.check.pipe(Effect.exit)
      expect(Exit.isSuccess(prepared)).toBe(true)
    }),
  )
})

const decodeRequest = Schema.decodeUnknownSync(ReleaseRequest)

const controllerKeys = generateKeyPairSync("ed25519")
const controllerPem = controllerKeys.publicKey.export({ type: "spki", format: "pem" }).toString()

const NOW = Date.parse("2026-09-23T12:00:00.000Z")
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

function promotion(overrides: Record<string, unknown> = {}) {
  return decodeRequest({
    requestID: "rel_req_1",
    kind: "promote",
    release: releaseIdentity,
    artifact,
    expectedCurrentGeneration: GENERATION,
    approvalRef: "permit_controller_1",
    requestedAt: "2026-09-23T11:59:00.000Z",
    ...overrides,
  })
}

function permitBody(overrides: Partial<ReleasePermitBody> = {}): ReleasePermitBody {
  return {
    permitID: "permit_controller_1",
    requestID: "rel_req_1",
    requestDigest: ReleaseRequestStore.releaseRequestDigest(promotion()),
    artifactSha256: artifact.binarySha256,
    expectedGeneration: GENERATION,
    issuer: "controller.release",
    issuedAt: "2026-09-23T11:00:00.000Z",
    expiresAt: "2026-09-23T13:00:00.000Z",
    ...overrides,
  }
}

function issue(body: ReleasePermitBody): Record<string, unknown> {
  return {
    ...body,
    signature: sign(null, Buffer.from(releasePermitPayload(body), "utf8"), controllerKeys.privateKey).toString("hex"),
  }
}

// One "process": a fresh Database connection over the same file and a fresh store
// service. Nothing survives between two of these except what was committed, so a
// second block is exactly the replacement process a promotion produces.
function withStore<A, E>(
  directory: string,
  body: (store: ReleaseRequestStore.Interface) => Effect.Effect<A, E>,
) {
  return Effect.gen(function* () {
    const store = yield* ReleaseRequestStore.Service
    return yield* body(store)
  }).pipe(
    Effect.provide(
      ReleaseRequestStore.layer.pipe(
        Layer.provide(Database.layer({ path: path.join(directory, "release.db") })),
        Layer.provide(Global.layerWith({ config: directory })),
      ),
    ),
  )
}

const anchor = (directory: string, issuers: Record<string, string>) =>
  Effect.promise(async () => {
    await mkdir(path.join(directory, "release"), { recursive: true })
    await writeFile(
      path.join(directory, "release", "controller.json"),
      JSON.stringify({ generation: GENERATION, issuers }),
      "utf8",
    )
  })

describe("durable release request store", () => {
  it.live("records a request durably and reads it back from a rebuilt store", () =>
    Effect.gen(function* () {
      SessionAdmission.reset()
      const tmp = yield* tmpdirScoped("opencode-release-store-")

      const submitted = yield* withStore(tmp.path, (store) => store.submit({ request: promotion(), now: NOW }))
      expect(submitted.ok).toBe(true)
      if (!submitted.ok) return
      expect(submitted.reconciled).toBe(false)
      expect(submitted.status).toMatchObject({ requestID: "rel_req_1", state: "accepted", generation: GENERATION })
      // Recording an intent activates nothing and fences nothing.
      expect(SessionAdmission.isEngaged()).toBe(false)

      const read = yield* withStore(tmp.path, (store) => store.status("rel_req_1"))
      expect(read.ok).toBe(true)
      if (read.ok) expect(read.status).toEqual(submitted.status)

      const missing = yield* withStore(tmp.path, (store) => store.status("rel_req_missing"))
      expect(missing.ok).toBe(false)
      if (!missing.ok) expect(missing.reason).toBe("unknown_request")
    }),
  )

  it.live("trusts nobody without an operator-provided controller anchor", () =>
    Effect.gen(function* () {
      SessionAdmission.reset()
      const tmp = yield* tmpdirScoped("opencode-release-anchor-")

      const refused = yield* withStore(tmp.path, (store) =>
        Effect.gen(function* () {
          yield* store.submit({ request: promotion(), now: NOW })
          return yield* store.authorize({ requestID: "rel_req_1", permit: issue(permitBody()), now: NOW })
        }),
      )

      expect(refused.ok).toBe(false)
      if (!refused.ok) expect(refused.reason).toBe("unknown_issuer")
      expect(SessionAdmission.isEngaged()).toBe(false)
    }),
  )

  it.live("authorizing engages the real session admission fence and settling releases it", () =>
    Effect.gen(function* () {
      SessionAdmission.reset()
      const tmp = yield* tmpdirScoped("opencode-release-fence-")
      yield* anchor(tmp.path, { "controller.release": controllerPem })

      const authorized = yield* withStore(tmp.path, (store) =>
        Effect.gen(function* () {
          yield* store.submit({ request: promotion(), now: NOW })
          return yield* store.authorize({ requestID: "rel_req_1", permit: issue(permitBody()), now: NOW })
        }),
      )
      expect(authorized.ok).toBe(true)
      if (authorized.ok) expect(authorized.status.state).toBe("running")

      // Not a double: the same process fence that refuses durable prompt admission.
      expect(SessionAdmission.current()).toEqual({
        token: "permit_controller_1",
        reason: "release promotion rel_req_1",
      })
      const fenced = yield* SessionAdmission.check.pipe(Effect.exit)
      expect(Exit.isFailure(fenced)).toBe(true)

      const settled = yield* withStore(tmp.path, (store) =>
        store.settle({
          requestID: "rel_req_1",
          token: "permit_controller_1",
          outcome: "completed",
          detail: "generation 8 running",
          now: NOW + 1_000,
        }),
      )
      expect(settled.ok).toBe(true)
      if (settled.ok) expect(settled.status).toMatchObject({ state: "completed", detail: "generation 8 running" })
      expect(SessionAdmission.isEngaged()).toBe(false)
    }),
  )

  it.live("re-engages the fence for a running request when the store is rebuilt after a restart", () =>
    Effect.gen(function* () {
      SessionAdmission.reset()
      const tmp = yield* tmpdirScoped("opencode-release-recover-")
      yield* anchor(tmp.path, { "controller.release": controllerPem })

      // The process that authorizes: it closes the fence and commits the running request.
      yield* withStore(tmp.path, (store) =>
        Effect.gen(function* () {
          yield* store.submit({ request: promotion(), now: NOW })
          const authorized = yield* store.authorize({ requestID: "rel_req_1", permit: issue(permitBody()), now: NOW })
          expect(authorized.ok).toBe(true)
        }),
      )
      expect(SessionAdmission.current()).toEqual({
        token: "permit_controller_1",
        reason: "release promotion rel_req_1",
      })

      // The promotion replaces the process, so the replacement starts with no fence at all.
      SessionAdmission.reset()
      expect(SessionAdmission.isEngaged()).toBe(false)

      // Rebuilding the store over the same durable records re-engages the fence with the
      // same token the original authorize used, before the replacement admits anything.
      const settled = yield* withStore(tmp.path, (store) =>
        Effect.gen(function* () {
          expect(SessionAdmission.current()).toEqual({
            token: "permit_controller_1",
            reason: "release promotion rel_req_1",
          })
          const fenced = yield* SessionAdmission.check.pipe(Effect.exit)
          expect(Exit.isFailure(fenced)).toBe(true)

          const read = yield* store.status("rel_req_1")
          expect(read.ok && read.status.state).toBe("running")

          return yield* store.settle({
            requestID: "rel_req_1",
            token: "permit_controller_1",
            outcome: "completed",
            detail: "release completed",
            now: NOW + 1_000,
          })
        }),
      )
      expect(settled.ok).toBe(true)
      if (settled.ok) expect(settled.status).toMatchObject({ state: "completed", detail: "release completed" })
      // The recovered hold is the same hold: the controller's settle released it.
      expect(SessionAdmission.isEngaged()).toBe(false)
      const admitted = yield* SessionAdmission.check.pipe(Effect.exit)
      expect(Exit.isSuccess(admitted)).toBe(true)
    }),
  )

  it.live("leaves admission open when a rebuilt store finds no running authorized request", () =>
    Effect.gen(function* () {
      SessionAdmission.reset()
      const tmp = yield* tmpdirScoped("opencode-release-terminal-")
      yield* anchor(tmp.path, { "controller.release": controllerPem })

      yield* withStore(tmp.path, (store) =>
        Effect.gen(function* () {
          yield* store.submit({ request: promotion(), now: NOW })
          const authorized = yield* store.authorize({ requestID: "rel_req_1", permit: issue(permitBody()), now: NOW })
          expect(authorized.ok).toBe(true)
          const settled = yield* store.settle({
            requestID: "rel_req_1",
            token: "permit_controller_1",
            outcome: "rejected",
            now: NOW + 1_000,
          })
          expect(settled.ok).toBe(true)
          // A second request records intent but is never authorized.
          yield* store.submit({ request: promotion({ requestID: "rel_req_2" }), now: NOW + 2_000 })
        }),
      )
      SessionAdmission.reset()

      const states = yield* withStore(tmp.path, (store) =>
        Effect.gen(function* () {
          const first = yield* store.status("rel_req_1")
          const second = yield* store.status("rel_req_2")
          return [first.ok ? first.status.state : "missing", second.ok ? second.status.state : "missing"]
        }),
      )
      expect(states).toEqual(["rejected", "accepted"])
      // Neither a settled request nor one that only recorded intent holds the fence.
      expect(SessionAdmission.isEngaged()).toBe(false)
      const admitted = yield* SessionAdmission.check.pipe(Effect.exit)
      expect(Exit.isSuccess(admitted)).toBe(true)
    }),
  )

  it.live("refuses to construct a store when a running request cannot re-engage its fence", () =>
    Effect.gen(function* () {
      SessionAdmission.reset()
      const tmp = yield* tmpdirScoped("opencode-release-fail-closed-")
      yield* anchor(tmp.path, { "controller.release": controllerPem })

      yield* withStore(tmp.path, (store) =>
        Effect.gen(function* () {
          yield* store.submit({ request: promotion(), now: NOW })
          const authorized = yield* store.authorize({ requestID: "rel_req_1", permit: issue(permitBody()), now: NOW })
          expect(authorized.ok).toBe(true)
        }),
      )

      // A restart finds the durable transition but the fence belongs to another live
      // holder. Re-engaging would require two holders, so the rebuilt store refuses to
      // construct rather than admit sessions that are still being replaced.
      SessionAdmission.release("permit_controller_1")
      SessionAdmission.engage({ token: "permit_other_9", reason: "another transition" })
      const refused = yield* withStore(tmp.path, (store) => store.status("rel_req_1")).pipe(Effect.exit)
      expect(Exit.isFailure(refused)).toBe(true)
      expect(SessionAdmission.current()).toEqual({ token: "permit_other_9", reason: "another transition" })

      SessionAdmission.release("permit_other_9")
    }),
  )

  it.live("still refuses a consumed permit after the store is rebuilt from durable state", () =>
    Effect.gen(function* () {
      SessionAdmission.reset()
      const tmp = yield* tmpdirScoped("opencode-release-replay-")
      yield* anchor(tmp.path, { "controller.release": controllerPem })

      // The process that spends the permit.
      yield* withStore(tmp.path, (store) =>
        Effect.gen(function* () {
          yield* store.submit({ request: promotion(), now: NOW })
          const authorized = yield* store.authorize({ requestID: "rel_req_1", permit: issue(permitBody()), now: NOW })
          expect(authorized.ok).toBe(true)
          yield* store.settle({
            requestID: "rel_req_1",
            token: "permit_controller_1",
            outcome: "completed",
            now: NOW + 1_000,
          })
        }),
      )

      // The replacement process: a new store, a new connection, no memory of the
      // first. Only the committed records carry the consumed permit forward.
      SessionAdmission.reset()
      const second = promotion({ requestID: "rel_req_2" })
      const replayed = yield* withStore(tmp.path, (store) =>
        Effect.gen(function* () {
          const recorded = yield* store.status("rel_req_1")
          expect(recorded.ok && recorded.status.state).toBe("completed")

          yield* store.submit({ request: second, now: NOW + 2_000 })
          return yield* store.authorize({
            requestID: "rel_req_2",
            permit: issue(
              permitBody({ requestID: "rel_req_2", requestDigest: ReleaseRequestStore.releaseRequestDigest(second) }),
            ),
            now: NOW + 2_000,
          })
        }),
      )

      expect(replayed.ok).toBe(false)
      if (!replayed.ok) expect(replayed.reason).toBe("replayed_permit")
      // A refused replay authorizes nothing, so it fences nothing either.
      expect(SessionAdmission.isEngaged()).toBe(false)

      // The original request replays to its recorded outcome instead of re-running.
      const reconciled = yield* withStore(tmp.path, (store) =>
        store.authorize({ requestID: "rel_req_1", permit: issue(permitBody()), now: NOW + 3_000 }),
      )
      expect(reconciled.ok).toBe(true)
      if (reconciled.ok) {
        expect(reconciled.reconciled).toBe(true)
        expect(reconciled.status.state).toBe("completed")
      }
      expect(SessionAdmission.isEngaged()).toBe(false)
    }),
  )

  it.live("refuses a forged, expired, out-of-scope or wrong-generation permit", () =>
    Effect.gen(function* () {
      SessionAdmission.reset()
      const tmp = yield* tmpdirScoped("opencode-release-refusals-")
      yield* anchor(tmp.path, { "controller.release": controllerPem })

      const reasons = yield* withStore(tmp.path, (store) =>
        Effect.gen(function* () {
          yield* store.submit({ request: promotion(), now: NOW })
          const forged = yield* store.authorize({
            requestID: "rel_req_1",
            permit: { ...issue(permitBody()), expectedGeneration: 99 },
            now: NOW,
          })
          const expired = yield* store.authorize({
            requestID: "rel_req_1",
            permit: issue(permitBody()),
            now: Date.parse("2026-09-23T13:00:00.000Z"),
          })
          const widened = yield* store.authorize({
            requestID: "rel_req_1",
            permit: issue(permitBody({ requestDigest: "f".repeat(64) })),
            now: NOW,
          })
          const generation = yield* store.authorize({
            requestID: "rel_req_1",
            permit: issue(permitBody({ expectedGeneration: 6 })),
            now: NOW,
          })
          const garbage = yield* store.authorize({ requestID: "rel_req_1", permit: "not-a-permit", now: NOW })
          return [forged, expired, widened, generation, garbage].map((result) =>
            result.ok ? "authorized" : result.reason,
          )
        }),
      )

      expect(reasons).toEqual([
        "bad_signature",
        "expired_permit",
        "scope_widened",
        "generation_mismatch",
        "malformed_permit",
      ])
      expect(SessionAdmission.isEngaged()).toBe(false)
    }),
  )

  it.live("conflicts on a changed body instead of replacing the recorded request", () =>
    Effect.gen(function* () {
      SessionAdmission.reset()
      const tmp = yield* tmpdirScoped("opencode-release-conflict-")

      const results = yield* withStore(tmp.path, (store) =>
        Effect.gen(function* () {
          yield* store.submit({ request: promotion(), now: NOW })
          const retry = yield* store.submit({ request: promotion(), now: NOW + 5_000 })
          const widened = yield* store.submit({
            request: promotion({ artifact: { ...artifact, binarySha256: "e".repeat(64) } }),
            now: NOW,
          })
          return { retry, widened, read: yield* store.status("rel_req_1") }
        }),
      )

      expect(results.retry.ok && results.retry.reconciled).toBe(true)
      expect(results.widened.ok).toBe(false)
      if (!results.widened.ok) expect(results.widened.reason).toBe("request_conflict")
      expect(results.read.ok && results.read.status.state).toBe("accepted")
    }),
  )
})
