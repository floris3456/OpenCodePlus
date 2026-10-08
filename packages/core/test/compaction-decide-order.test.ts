import { expect } from "bun:test"
import type { SessionCompactionDecision } from "@opencode/plugin/compaction-decision"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Session } from "@opencode/schema/session"
import { Effect } from "effect"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { testEffect } from "./lib/effect"
import { PluginTestLayer } from "./plugin/fixture"

// C3a depends on the plugin load order: CPA (an internal `pre` plugin) registers
// its `compaction.decide` hook before Plus (an internal `post` plugin), and
// PluginHooks.trigger runs registrations in registration order. This proves the
// order with both plugins registered, so Plus sees and can replace CPA's models.
const it = testEffect(PluginTestLayer)

const event = (): SessionCompactionDecision => ({
  sessionID: Session.ID.make("ses_order"),
  agent: Agent.ID.make("build"),
  model: Model.Ref.make({ id: Model.ID.make("model"), providerID: Model.ID.make("proxy") as never }),
  reason: "auto",
  auto: true,
  due: false,
  boundary: { fresh: true, portable: true },
})

it.live("compaction.decide hooks run in plugin activation order, so Plus decides after CPA", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const hooks = yield* PluginHooks.Service
    const order: string[] = []
    // The load order supervisor builds: pre (CPA) before post (Plus).
    yield* plugins.activate(
      ["opencode.plus.cliproxyapi", "opencode.plus"].map((id) => ({
        id,
        revision: "1",
        effect: (ctx) =>
          ctx.session.hook("compaction.decide", (decision) =>
            Effect.sync(() => {
              order.push(id)
              if (id === "opencode.plus.cliproxyapi") {
                decision.compact = true
                decision.portable = true
                decision.compactionModel = Model.Ref.parse("proxy/cpa-model")
                decision.metadata = { ...decision.metadata, "quota.switch": true }
              }
              // Plus replaces the models CPA armed only because it runs second.
              if (id === "opencode.plus" && decision.metadata?.["quota.switch"] === true) {
                decision.compactionModel = Model.Ref.parse("proxy/plus-model")
              }
            }),
          ),
      })),
    )
    const decided = yield* hooks.trigger("session", "compaction.decide", event())
    expect(order).toEqual(["opencode.plus.cliproxyapi", "opencode.plus"])
    expect(decided.compactionModel).toEqual(Model.Ref.parse("proxy/plus-model"))
  }),
)