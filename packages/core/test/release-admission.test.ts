import { describe, expect } from "bun:test"
import { Cause, DateTime, Deferred, Effect, Exit, Layer } from "effect"
import { SessionAdmission, AdmissionFencedError } from "@opencode/core/session/admission"
import { SessionPrompt } from "@opencode/core/session/prompt"
import { SessionRunCoordinator } from "@opencode/core/session/run-coordinator"
import { SessionMessage } from "@opencode/schema/session-message"
import { Session } from "@opencode/schema/session"
import { Project } from "@opencode/schema/project"
import { Money } from "@opencode/schema/money"
import { Location } from "@opencode/schema/location"
import { AbsolutePath } from "@opencode/schema/schema"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

const controller = { token: "permit_controller_1", reason: "release promotion permit_controller_1" }

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
      }).pipe(Effect.exit)

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
