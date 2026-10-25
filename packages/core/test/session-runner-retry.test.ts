import { describe, expect } from "bun:test"
import { AIError, ProviderInternalError, TransportError } from "@opencode/ai"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/core/provider"
import { SessionSchema } from "@opencode/core/session/schema"
import { SessionRunnerRetry } from "@opencode/core/session/runner/retry"
import { toSessionError } from "@opencode/core/session/to-session-error"
import { Effect } from "effect"
import { it } from "./lib/effect"

const timeout = new AIError({
  reason: new TransportError({ message: "Timed out", transport: "http", operation: "request", code: "Timeout" }),
})
const internal = new AIError({ reason: new ProviderInternalError({ message: "internal" }) })

const input = (cause: AIError) => ({
  cause,
  error: toSessionError(cause),
  agent: Agent.ID.make("build"),
  model: Model.Ref.make({ id: Model.ID.make("model"), providerID: Provider.ID.make("provider") }),
  hook: () => Effect.void,
  retry: SessionRunnerRetry.isRetryable(cause),
})

// Decisions for `count` consecutive failures of the same cause within one step.
const decisions = (cause: AIError, count: number) =>
  Effect.gen(function* () {
    const policy = yield* SessionRunnerRetry.policy(SessionSchema.ID.make("ses_retry"))
    const results: boolean[] = []
    for (let i = 0; i < count; i++) results.push((yield* policy(input(cause))).retry)
    return results
  })

describe("SessionRunnerRetry.policy", () => {
  it.effect("stops retrying transport timeouts after three attempts", () =>
    Effect.gen(function* () {
      expect(yield* decisions(timeout, 4)).toEqual([true, true, true, false])
    }),
  )

  it.effect("keeps the general allowance for other transient failures", () =>
    Effect.gen(function* () {
      expect(yield* decisions(internal, 11)).toEqual([...Array(10).fill(true), false])
    }),
  )

  it.effect("asks the retry hook once the schedule is used up, and follows it", () =>
    Effect.gen(function* () {
      const policy = yield* SessionRunnerRetry.policy(SessionSchema.ID.make("ses_retry"))
      const asked: { attempt: number; retry: boolean }[] = []
      const results = []
      for (let i = 0; i < 12; i++)
        results.push(
          yield* policy({
            ...input(internal),
            hook: (event) =>
              Effect.sync(() => {
                asked.push({ attempt: event.attempt, retry: event.decision.retry })
                if (!event.decision.retry) event.decision = { retry: true, delay: 15_000 }
              }),
          }),
        )
      expect(asked.map((entry) => entry.retry)).toEqual([...Array(10).fill(true), false, false])
      expect(asked.at(-1)?.attempt).toBe(13)
      expect(results.slice(10)).toEqual([
        { retry: true, attempt: 12, delay: 15_000 },
        { retry: true, attempt: 13, delay: 15_000 },
      ])
    }),
  )
})
