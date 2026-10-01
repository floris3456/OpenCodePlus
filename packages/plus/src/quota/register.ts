import type { Context } from "@opencode/plugin/effect/plugin"
import type { SessionRequest } from "@opencode/plugin/effect/session"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { createHash } from "node:crypto"
import { Effect, Schema, Stream } from "effect"
import { quotaConfig } from "./config.js"
import { QuotaController } from "./controller.js"
import { Definition } from "./rpc.js"
import { installationIdentity } from "./identity.js"
import { portableMessages } from "./portable.js"

export function registerQuota(ctx: Context) {
  return Effect.gen(function* () {
    const config = yield* Effect.promise(() => quotaConfig(ctx.options.quota))
    if (config === undefined) return
    const installation = yield* Effect.promise(() => installationIdentity(ctx))
    const controller = new QuotaController(config, installation, {
      read: (key) => Effect.runPromise(ctx.storage.get(key)),
      write: (key, value) => Effect.runPromise(ctx.storage.set(key, value)),
      notify: async (session, id, text) => {
        await Effect.runPromise(
          ctx.session.synthetic({
            sessionID: Session.ID.make(session),
            id: SessionMessage.ID.make(`msg_${createHash("sha256").update(`${session}/${id}`).digest("hex")}`),
            text,
            description: "Credential quota",
            resume: false,
            delivery: "steer",
            metadata: { "quota.notice": true },
          }),
        )
      },
      fetch,
      now: Date.now,
    })
    yield* ctx.rpc
      .register(Definition, {
        status: (input) => Effect.promise(() => controller.status(input.sessionID)),
      })
      .pipe(Effect.orDie)
    yield* ctx.session.hook("compaction.decide", (event) =>
      controller.enabled(event.model.providerID) ? Effect.promise(() => controller.decide(event)) : Effect.void,
    )
    yield* ctx.session.hook("model.request", (event) =>
      Effect.promise(async () => {
        if (!controller.enabled(event.model.providerID)) return
        Object.assign(
          event.headers,
          await controller.headers(event.sessionID, event.model.providerID, event.model.id, event.kind, event.baseURL),
        )
      }),
    )
    yield* ctx.session.hook("http.response", (event) =>
      controller.enabled(event.model.providerID)
        ? Effect.promise(() =>
            controller.response(event.sessionID, event.model.providerID, event.model.id, event.response),
          )
        : Effect.void,
    )
    yield* ctx.session.hook("retry", (event) =>
      Effect.promise(async () => {
        if (!controller.enabled(event.model.providerID)) return
        const retry = await controller.retry(event.sessionID, event.model.providerID, event.model.id)
        if (retry !== undefined) event.decision = retry ? { retry: true, delay: 0 } : { retry: false }
      }),
    )
    yield* ctx.session.hook("warming", (event) =>
      Effect.promise(async () => {
        if (controller.enabled(event.model.providerID) && !(await controller.warming(event.sessionID)))
          event.settings = undefined
      }),
    )
    // Version 1 requires the existing provider transport:http setting. Refuse
    // a socket before opening it; per-frame checkpoint coordination is not proven.
    yield* ctx.session.hook("experimental.ws.handshake", (event) =>
      controller.enabled(event.model.providerID)
        ? Effect.die(new Error("Credential quota handoff requires provider transport:http"))
        : Effect.void,
    )
    const portable = (event: SessionRequest, kind: string) =>
      Effect.promise(async () => {
        if (!controller.enabled(event.model.providerID)) return
        if (!(await controller.requiresPortable(event.sessionID, event.model.providerID, event.model.id, kind))) return
        event.messages = portableMessages(event.messages)
        delete event.options.previous_response_id
      })
    yield* ctx.session.hook("context", (event) => portable(event, "context"))
    yield* ctx.session.hook("compaction", (event) => portable(event, "compaction"))
    yield* ctx.session.hook("generate", (event) => portable(event, "generate"))
    yield* ctx.session.hook("title", (event) => portable(event, "title"))
    yield* ctx.event.subscribe().pipe(
      Stream.runForEach((event) => {
        if (!event.type.startsWith("session.execution.")) return Effect.void
        const data = Schema.decodeUnknownOption(Schema.Struct({ sessionID: Schema.String }))(event.data)
        if (data._tag === "None") return Effect.void
        return Effect.promise(() =>
          controller.activity(data.value.sessionID, event.type === "session.execution.started"),
        )
      }),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* Effect.forever(
      Effect.promise(() => controller.tick()).pipe(
        Effect.catchCause(() =>
          Effect.logWarning("Quota polling failed; request-boundary coordination remains required"),
        ),
        Effect.andThen(Effect.sleep("1 second")),
      ),
    ).pipe(Effect.forkScoped({ startImmediately: true }))
  })
}
