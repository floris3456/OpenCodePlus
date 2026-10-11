import Pacer from "opencode-pacer/v2/server"
import { Meter, type MeterSnapshot } from "opencode-pacer/core"
import { PacerRpc } from "opencode-pacer/rpc"
import { Plugin } from "@opencode/plugin"
import { Model } from "@opencode/schema/model"
import { Schema } from "effect"
import { randomBytes } from "node:crypto"
import { QuotaController } from "./quota/controller.js"
import { portableMessages } from "./quota/portable.js"
import { Definition } from "./quota/rpc.js"
import { UsageDefinition } from "./quota/usage.js"
import { pacerSnapshot } from "./quota/pacer-snapshot.js"
import { createNextUse } from "./quota/next-use.js"

export const ID = "opencode-pacer"

const Options = Schema.Struct({
  accountSwitch: Schema.optional(Schema.Boolean),
  compactionModel: Schema.optional(Schema.String),
  compactionFallback: Schema.optional(Schema.String),
})

/** The pinned Pacer plugin owns connection, catalogue and quota observations.
 * Plus replaces only stock v2's overflow workaround and adapts the Usage view.
 */
export default Plugin.define({
  id: ID,
  async setup(ctx) {
    const options = Schema.decodeUnknownSync(Options)(ctx.options)
    if (options.compactionModel) Model.Ref.parse(options.compactionModel)
    if (options.compactionFallback) Model.Ref.parse(options.compactionFallback)
    const stop = await Pacer.setup({ ...ctx, options: { ...ctx.options, accountSwitch: false } })
    const state = {
      routes: {} as Record<string, string>,
      pacer: false,
      providers: new Map<string, readonly string[]>(),
    }
    const refresh = async () => {
      const saved = await ctx.storage.get("catalogue")
      const catalogue = Schema.decodeUnknownOption(
        Schema.Struct({
          baseURL: Schema.String,
          pacer: Schema.Boolean,
          catalogue: Schema.optional(
            Schema.Struct({
              models: Schema.Array(
                Schema.Struct({
                  id: Schema.String,
                  providers: Schema.Array(Schema.String),
                  ownedBy: Schema.optional(Schema.String),
                }),
              ),
            }),
          ),
        }),
      )(saved)
      state.pacer = catalogue._tag === "Some" && catalogue.value.pacer
      state.providers = new Map(
        catalogue._tag === "Some"
          ? catalogue.value.catalogue?.models.map((model) => [
              model.id,
              model.providers.length ? model.providers : model.ownedBy ? [model.ownedBy] : [],
            ])
          : [],
      )
      state.routes =
        options.accountSwitch !== false && catalogue._tag === "Some" && catalogue.value.pacer
          ? { cliproxyapi: catalogue.value.baseURL }
          : {}
    }
    await refresh()
    const stored = await ctx.storage.get("plus.installation")
    const installation = typeof stored === "string" ? stored : randomBytes(24).toString("hex")
    if (!stored) await ctx.storage.set("plus.installation", installation)
    const controller = new QuotaController(() => ({ ...options, routes: state.routes, reactive: true }), installation, {
      read: (key) => ctx.storage.get(key),
      write: (key, value) => ctx.storage.set(key, JSON.parse(JSON.stringify(value))),
      notify: async () => {},
      fetch,
      now: Date.now,
    })
    // Match upstream Pacer's switch contract: only the Claude Messages relay.
    // Other CPA providers expose quota but may not acknowledge handoff claims.
    const coordinated = (model: Model.Ref) =>
      controller.enabled(model.providerID) && model.id.toLowerCase().startsWith("claude-")
    await ctx.rpc.register(Definition, { status: (input) => controller.status(input.sessionID) })
    await ctx.session.hook("compaction.decide", async (event) => {
      await refresh()
      controller.observe(event)
      if (!coordinated(event.model)) return
      await controller.decide(event)
    })
    await ctx.session.hook("model.request", async (event) => {
      if (!coordinated(event.model) || !event.headers["X-Pacer-Client"]) return
      Object.assign(
        event.headers,
        await controller.headers(event.sessionID, event.model.providerID, event.model.id, event.kind, event.baseURL),
      )
    })
    await ctx.session.hook("http.response", async (event) => {
      if (!event.request.headers.has("X-Quota-Handoff")) return
      await controller.response(event.sessionID, event.model.providerID, event.model.id, event.response, event.kind)
    })
    await ctx.session.hook("retry", async (event) => {
      if (!coordinated(event.model)) return
      const decision = await controller.retry(event.sessionID, event.model.providerID, event.model.id)
      if (decision !== undefined)
        event.decision =
          typeof decision === "number"
            ? { retry: true, delay: decision }
            : decision
              ? { retry: true, delay: 0 }
              : { retry: false }
    })
    await ctx.session.hook("warming", async (event) => {
      if (
        coordinated(event.model) &&
        !(await controller.warming(event.sessionID, event.model.providerID, event.model.id))
      )
        event.settings = undefined
    })
    await ctx.session.hook("experimental.ws.handshake", (event) => {
      if (coordinated(event.model)) throw new Error("Pacer account switching requires transport:http")
    })
    for (const kind of ["context", "compaction", "generate", "title"] as const) {
      await ctx.session.hook(kind, async (event) => {
        if (kind !== "compaction" && !controller.enabled(event.model.providerID)) return
        const handoff = "checkpointHandoff" in event ? event.checkpointHandoff : undefined
        if (await controller.requiresPortable(event.sessionID, event.model.providerID, event.model.id, kind, handoff)) {
          event.messages = portableMessages(event.messages)
          delete event.options.previous_response_id
        }
        if (kind === "compaction") await controller.compacting(event.sessionID, handoff)
      })
    }
    // Percentages/catalogue are cached. The separate read-only routing preview
    // uses Plus's existing capability and is coalesced across visible clients.
    const meter = new Meter()
    const nextUse = createNextUse({ read: (key) => ctx.storage.get(key), fetch, now: Date.now })
    await ctx.rpc.register(UsageDefinition, {
      enabled: async () => {
        await refresh()
        return { enabled: state.pacer }
      },
      read: async (input) => {
        await refresh()
        if (!state.pacer)
          return {
            status: "disabled" as const,
            message: "Connect CLIProxyAPI with Pacer through /connect to inspect credential usage.",
          }
        const cached = (await ctx.rpc(PacerRpc).usage({ providerID: input.providerID, modelID: input.modelID })) as {
          snapshot: MeterSnapshot
          providers: string[]
        }
        meter.restore(cached.snapshot, true)
        const providers = cached.providers.length ? cached.providers : input.providerID === "cliproxyapi" ? (state.providers.get(input.modelID) ?? []) : []
        const snapshot = pacerSnapshot(meter, input, Date.now(), providers)
        const next = await nextUse(state.routes[input.providerID], input)
        return { status: "ready" as const, snapshot: { ...snapshot, ...(next ? { next_use: next } : {}) } }
      },
    })
    return stop
  },
})
