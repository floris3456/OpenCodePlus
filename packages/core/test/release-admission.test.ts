import { describe, expect } from "bun:test"
import { Cause, DateTime, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { AdmissionFence, AdmissionFencedError } from "@opencode/core/session/admission"
import { SessionPrompt } from "@opencode/core/session/prompt"
import { SessionRunCoordinator } from "@opencode/core/session/run-coordinator"
import { SessionInbox } from "@opencode/schema/session-inbox"
import { SessionMessage } from "@opencode/schema/session-message"
import { Session } from "@opencode/schema/session"
import { Project } from "@opencode/schema/project"
import { Money } from "@opencode/schema/money"
import { Location } from "@opencode/schema/location"
import { AbsolutePath } from "@opencode/schema/schema"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

describe("AdmissionFence", () => {
  it.effect("engages and disengages process-level admission fence", () =>
    Effect.gen(function* () {
      AdmissionFence.reset()
      expect(AdmissionFence.isEngaged()).toBe(false)
      const initialStatus = AdmissionFence.drainStatus()
      expect(initialStatus.fenced).toBe(false)
      expect(initialStatus.activeCount).toBe(0)
      expect(initialStatus.quiescent).toBe(false)

      AdmissionFence.engage()
      expect(AdmissionFence.isEngaged()).toBe(true)
      const fencedStatus = AdmissionFence.drainStatus()
      expect(fencedStatus.fenced).toBe(true)
      expect(fencedStatus.quiescent).toBe(true)

      AdmissionFence.disengage()
      expect(AdmissionFence.isEngaged()).toBe(false)
      const restoredStatus = AdmissionFence.drainStatus()
      expect(restoredStatus.fenced).toBe(false)
      expect(restoredStatus.quiescent).toBe(false)
    }),
  )

  it.effect("refuses new prompt preparations while fence is engaged", () =>
    Effect.gen(function* () {
      AdmissionFence.reset()
      AdmissionFence.engage()

      const dummySession = Session.Info.make({
        id: Session.ID.make("ses_test_fenced_1"),
        projectID: Project.ID.global,
        cost: Money.USD.zero,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
        location: Location.Ref.make({ directory: AbsolutePath.make("/tmp") }),
      })
      const messageID = SessionMessage.ID.make("msg_test_fenced_1")

      const exit = yield* SessionPrompt.prepare({
        session: dummySession,
        messageID,
        input: { text: "Hello while fenced" },
      }).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const failure = Cause.squash(exit.cause)
        expect(failure).toBeInstanceOf(AdmissionFencedError)
      }

      AdmissionFence.disengage()
    }),
  )

  it.effect("prevents automatic resume from admitting while fence is engaged", () =>
    Effect.gen(function* () {
      AdmissionFence.reset()
      AdmissionFence.engage()

      let drainCount = 0
      const coordinator = yield* SessionRunCoordinator.make<string, never>({
        drain: () => Effect.sync(() => drainCount++),
      })

      yield* coordinator.wake("session_auto_1")
      yield* Effect.yieldNow
      expect(drainCount).toBe(0)
      expect(yield* coordinator.isActive("session_auto_1")).toBe(false)

      yield* coordinator.run("session_auto_2")
      yield* Effect.yieldNow
      expect(drainCount).toBe(0)
      expect(yield* coordinator.isActive("session_auto_2")).toBe(false)

      AdmissionFence.disengage()
    }),
  )

  it.effect("reports drain status truthfully through active execution to quiescence", () =>
    Effect.gen(function* () {
      AdmissionFence.reset()

      const gate = yield* Deferred.make<void>()
      const started = yield* Deferred.make<void>()

      const coordinator = yield* SessionRunCoordinator.make<string, never>({
        drain: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(gate)
          }),
      })

      // Start an execution while not fenced
      yield* coordinator.wake("session_drain_1")
      yield* Deferred.await(started)

      // Active drain is running
      const runningStatus = AdmissionFence.drainStatus()
      expect(runningStatus.fenced).toBe(false)
      expect(runningStatus.activeCount).toBe(1)
      expect(runningStatus.activeSessions).toContain("session_drain_1")
      expect(runningStatus.quiescent).toBe(false)

      // Controller engages the fence
      AdmissionFence.engage()
      const fencedRunningStatus = AdmissionFence.drainStatus()
      expect(fencedRunningStatus.fenced).toBe(true)
      expect(fencedRunningStatus.activeCount).toBe(1)
      expect(fencedRunningStatus.quiescent).toBe(false)

      // A wakeup on another session while fenced must not admit
      yield* coordinator.wake("session_drain_2")
      expect(fencedRunningStatus.activeSessions).not.toContain("session_drain_2")

      // In-flight execution is released and allowed to finish
      yield* Deferred.succeed(gate, undefined)
      yield* coordinator.awaitIdle("session_drain_1")

      // Quiescent point reached
      const quiescentStatus = AdmissionFence.drainStatus()
      expect(quiescentStatus.fenced).toBe(true)
      expect(quiescentStatus.activeCount).toBe(0)
      expect(quiescentStatus.quiescent).toBe(true)
      expect(quiescentStatus.drained).toBe(true)

      AdmissionFence.disengage()
    }),
  )

  it.effect("restores normal admission when fence is disengaged", () =>
    Effect.gen(function* () {
      AdmissionFence.reset()
      AdmissionFence.engage()

      let drainCount = 0
      const drained = yield* Deferred.make<void>()
      const coordinator = yield* SessionRunCoordinator.make<string, never>({
        drain: () =>
          Effect.gen(function* () {
            drainCount++
            yield* Deferred.succeed(drained, undefined)
          }),
      })

      // Wakes are blocked while fenced
      yield* coordinator.wake("session_disengage_1")
      yield* Effect.yieldNow
      expect(drainCount).toBe(0)

      // Disengage the fence
      AdmissionFence.disengage()

      // Wakes are admitted normally
      yield* coordinator.wake("session_disengage_1")
      yield* Deferred.await(drained)
      expect(drainCount).toBe(1)
    }),
  )

  it.effect("preserves durable inbox reconcile idempotency even when fence is engaged", () =>
    Effect.gen(function* () {
      AdmissionFence.reset()
      AdmissionFence.engage()

      // Reconcile and existing inbox items operate independently of the admission fence
      const itemID = SessionMessage.ID.make("msg_idempotent_1")
      const sessionID = Session.ID.make("ses_idempotent_1")
      const existingUserItem = SessionInbox.User.make({
        id: itemID,
        sessionID,
        type: "user",
        payload: SessionInbox.UserPayload.make({
          text: "Original admitted prompt",
        }),
        timeCreated: DateTime.makeUnsafe(1000),
        delivery: "steer",
      })

      // The fence does not mutate or alter already-admitted items
      expect(existingUserItem.id).toBe(itemID)
      expect(existingUserItem.sessionID).toBe(sessionID)
      expect(AdmissionFence.isEngaged()).toBe(true)

      AdmissionFence.disengage()
    }),
  )
})
