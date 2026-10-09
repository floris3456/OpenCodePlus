import { expect, test } from "bun:test"
import { Effect, type Schema } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { SessionHooks, SessionWarming } from "@opencode/plugin/effect/session"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Session } from "@opencode/schema/session"
import { ProviderID } from "../../ai/src/schema/ids.js"
import { registerQuota } from "../../cliproxyapi/src/quota/register.js"
import { createWarmingStore } from "../src/warming.js"
import { context } from "./harness.js"

const MINUTE = 60_000
const sessionID = Session.ID.make("ses_quota_scope")
const agent = Agent.ID.make("build")
const astra = Model.Ref.parse("proxy/gpt-6-astra")

function fixture() {
  return Effect.gen(function* () {
    const pending = new Set(["proxy/old-model"])
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch: (request) => Response.json({
            protocol: 1,
            primary_used: true,
            consumed: "",
            cursor: 0,
            generation: 1,
            alias: "Fixture",
            intent: pending.has(new URL(request.url).searchParams.get("model") ?? "") ? "pending-handoff" : "",
            available: true,
            windows: [],
            events: [],
          }),
        }),
      ),
      (server) => Effect.sync(() => server.stop(true)),
    )
    const hooks = new Map<keyof SessionHooks, (event: never) => Effect.Effect<void>>()
    const storage = new Map<string, Schema.Json>()
    const base = context()
    yield* registerQuota(context({
      rpc: Object.assign(base.rpc, { register: () => Effect.succeed({ dispose: Effect.void }) }),
      storage: {
        ...base.storage,
        get: (key) => Effect.succeed(storage.get(key)),
        set: (key, value) => Effect.sync(() => { storage.set(key, value) }),
      },
      session: {
        hook: (name, callback) => Effect.sync(() => {
          hooks.set(name, callback)
          return { dispose: Effect.void }
        }),
      },
    }), () => ({ routes: { proxy: server.url.href } }))
    const trigger = <Name extends keyof SessionHooks>(name: Name, event: SessionHooks[Name]) => {
      const hook = hooks.get(name)
      if (!hook) throw new Error(`Missing quota hook: ${name}`)
      // The registration map erases the name/event correlation; the caller retains it.
      return Effect.runPromise(hook(event as never))
    }
    const decide = (model: Model.Ref, session = sessionID) => trigger("compaction.decide", {
      sessionID: session,
      agent,
      model,
      reason: "auto",
      auto: true,
      due: false,
      boundary: { fresh: false, portable: false },
    })
    return { pending, trigger, decide }
  })
}

test("quota hooks retain healthy Astra native context and reject opaque context for its own handoff", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const f = yield* fixture()
    yield* Effect.promise(async () => {
      await f.decide(Model.Ref.parse("proxy/old-model"))
      await f.decide(astra)
      await f.decide(Model.Ref.parse("proxy/old-model"), Session.ID.make("ses_unrelated"))
      const request = (model = astra): SessionHooks["compaction"] => ({
        sessionID,
        agent,
        model,
        system: [],
        tools: {},
        messages: [{
          role: "assistant",
          content: [{ type: "compaction", provider: ProviderID.make("openai"), encrypted: "fixture-opaque" }],
        }],
        options: { previous_response_id: "fixture-continuation" },
      })
      const primary = request()
      await f.trigger("context", primary)
      const native = request()
      await f.trigger("compaction", native)
      expect(native.messages).toEqual(primary.messages)
      expect(native.options.previous_response_id).toBe("fixture-continuation")

      f.pending.add("proxy/gpt-6-astra")
      await f.decide(astra)
      await expect(f.trigger("compaction", request())).rejects.toThrow("opaque checkpoint")
      // A different summary model must still honor the current chat's portability requirement.
      await expect(f.trigger("compaction", request(Model.Ref.parse("proxy/summary")))).rejects.toThrow("opaque checkpoint")
      const readable: SessionHooks["compaction"] = {
        ...request(),
        messages: [{
          role: "assistant",
          content: [{ type: "reasoning", text: "Readable fixture", providerMetadata: { test: { proof: "fixture" } } }],
        }],
      }
      await f.trigger("compaction", readable)
      expect(readable.messages).toEqual([{ role: "assistant", content: [{ type: "text", text: "Readable fixture" }] }])
      expect(readable.options.previous_response_id).toBeUndefined()

      // Off-CPA chat decisions also retire old decisions before a CPA summary request.
      await f.decide(Model.Ref.parse("uncoordinated/current"))
      await expect(f.trigger("compaction", request(Model.Ref.parse("proxy/summary")))).resolves.toBeUndefined()
    })
  }))))

test("quota then Plus warming preserves 90m/25m as a 100m window despite an old-model handoff", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const f = yield* fixture()
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "quota-warming-"))),
      (directory) => Effect.promise(() => fs.rm(directory, { recursive: true, force: true })),
    )
    const clock = { now: 1_000_000 }
    const timers = new Map<symbol, { run: () => void; at: number }>()
    const store = yield* Effect.acquireRelease(
      Effect.sync(() => createWarmingStore(path.join(directory, "chats.json"), {
        now: () => clock.now,
        setTimer: (run, delay) => {
          const id = Symbol()
          timers.set(id, { run, at: clock.now + delay })
          return id
        },
        clearTimer: (id) => { timers.delete(id as symbol) },
      })),
      (store) => Effect.sync(() => store.dispose()),
    )
    yield* Effect.promise(async () => {
      await f.decide(Model.Ref.parse("proxy/old-model"))
      await f.decide(astra)
      const since = clock.now
      await store.setCompact(sessionID, "on")
      const compacted = Promise.withResolvers<string>()
      const compact = async (session: string) => { compacted.resolve(session) }
      const event: SessionWarming = {
        sessionID,
        agent,
        model: astra,
        phase: "activity",
        kind: "primary",
        since,
        now: clock.now,
        settings: { prompt: "fixture ping", interval: 25 * MINUTE, duration: 90 * MINUTE },
      }
      // Production pre/post order: quota sees Core's settings, then Plus resolves and schedules them.
      await f.trigger("warming", event)
      await store.decide(event, {}, compact)
      expect(event.settings).toEqual({ prompt: "fixture ping", interval: 25 * MINUTE, duration: 100 * MINUTE })
      for (const minutes of [25, 50, 75]) {
        clock.now = since + minutes * MINUTE
        const ping = { ...event, phase: "warm" as const, now: clock.now }
        await f.trigger("warming", ping)
        await store.decide(ping, {}, compact)
        expect(await store.status(sessionID)).toMatchObject({
          active: true,
          interval: 25 * MINUTE,
          expires: since + 100 * MINUTE,
          compactAt: since + 100 * MINUTE,
        })
        expect([...timers.values()].map((timer) => timer.at)).toEqual([since + 100 * MINUTE])
      }
      clock.now = since + 100 * MINUTE
      for (const timer of timers.values()) timer.run()
      expect(await compacted.promise).toBe(sessionID)

      // Failure control: the same model's pending handoff still disables warming.
      f.pending.add("proxy/gpt-6-astra")
      await f.decide(astra)
      const blocked = { ...event, since: clock.now, now: clock.now }
      await f.trigger("warming", blocked)
      expect(blocked.settings).toBeUndefined()
      await store.decide(blocked, {}, compact)
      expect(await store.status(sessionID)).toMatchObject({ active: false, compactAt: clock.now + 4 * MINUTE })
    })
  }))))

test("checkpoint-handoff hooks distinguish source conversion from the target's summary and retain source guards", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const f = yield* fixture()
    yield* Effect.promise(async () => {
      await f.decide(astra)
      await f.trigger("compaction.decide", {
        sessionID,
        agent,
        model: Model.Ref.parse("proxy/old-model"),
        reason: "auto",
        auto: true,
        due: false,
        boundary: { fresh: false, portable: false },
        compactionModel: astra,
      })
      const request = (): SessionHooks["compaction"] => ({
        sessionID,
        agent,
        model: astra,
        checkpointHandoff: true,
        system: [],
        tools: {},
        messages: [{
          role: "assistant",
          content: [{ type: "compaction", provider: ProviderID.make("openai"), encrypted: "fixture-source-checkpoint" }],
        }],
        options: { previous_response_id: "fixture-source-continuation" },
      })
      const source = request()
      await f.trigger("compaction", source)
      expect(source.messages).toEqual(request().messages)
      expect(source.options.previous_response_id).toBe("fixture-source-continuation")
      // Same identities, different purpose: the target's ordinary quota summary still rejects opaque input.
      await expect(f.trigger("compaction", { ...request(), checkpointHandoff: undefined })).rejects.toThrow("opaque checkpoint")
      // The source itself becomes pending, with no new decision hook to announce it.
      f.pending.add("proxy/gpt-6-astra")
      await expect(f.trigger("compaction", request())).rejects.toThrow("opaque checkpoint")
    })
  }))))
