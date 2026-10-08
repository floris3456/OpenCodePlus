import { expect, test } from "bun:test"
import { agent, model, renderLocal, session } from "./fixture/local"
import { directory, json, worktree } from "./fixture/tui-client"

// An agent's configured model can change while the TUI runs (a pick,
// Ctrl+T, an Instructions activation, another project). Existing chats keep
// their model: only the new-chat default for that location follows the
// agent's model, and an agent switch inside a chat falls back to that chat's
// own history for the agent.

test("an agent model change does not change an open chat's selection", async () => {
  let agents = [agent("build"), agent("plan", { providerID: "provider", id: "second" })]
  let agentRequests = 0
  await using setup = await renderLocal({
    agents,
    models: [model("first"), model("second"), model("third")],
    sessions: [session("ses_first", { providerID: "provider", id: "second" }, "plan")],
    fetch: (url) => {
      if (url.pathname !== "/api/agent") return
      agentRequests++
      return json({
        location: { directory: url.searchParams.get("location[directory]") ?? directory },
        data: agents,
      })
    },
  })
  await setup.data.session.sync("ses_first")
  setup.route.navigate({ type: "session", sessionID: "ses_first" })
  expect(setup.local.model.current()?.modelID).toBe("second")

  // The durable model stays when the agent's configured model moves.
  agents = [agent("build"), agent("plan", { providerID: "provider", id: "first" })]
  const requested = agentRequests
  emitAgentUpdate(setup)
  await waitFor(
    () =>
      agentRequests > requested &&
      setup.data.location.agent.list()?.find((entry) => entry.id === "plan")?.model?.id === "first",
  )
  expect(setup.local.model.current()?.modelID).toBe("second")

  // A draft pick stays too when the agent's configured model moves again.
  setup.local.model.set({ providerID: "provider", modelID: "third" })
  expect(setup.local.model.current()?.modelID).toBe("third")
  agents = [agent("build"), agent("plan", { providerID: "provider", id: "second" })]
  const changed = agentRequests
  emitAgentUpdate(setup)
  await waitFor(
    () =>
      agentRequests > changed &&
      setup.data.location.agent.list()?.find((entry) => entry.id === "plan")?.model?.id === "second",
  )
  expect(setup.local.model.current()?.modelID).toBe("third")
})

test("an agent model change replaces the new-chat default for that agent in that location", async () => {
  let agents = [agent("build"), agent("plan", { providerID: "provider", id: "second" })]
  let agentRequests = 0
  await using setup = await renderLocal({
    agents,
    models: [model("first"), model("second"), model("third")],
    fetch: (url) => {
      if (url.pathname !== "/api/agent") return
      agentRequests++
      return json({
        location: { directory: url.searchParams.get("location[directory]") ?? directory },
        data: agents,
      })
    },
  })
  setup.local.agent.set("plan")
  expect(setup.local.model.current()?.modelID).toBe("second")
  setup.local.model.set({ providerID: "provider", modelID: "third" })
  expect(setup.local.model.current()?.modelID).toBe("third")

  agents = [agent("build"), agent("plan", { providerID: "provider", id: "first" })]
  const requested = agentRequests
  emitAgentUpdate(setup)
  await waitFor(
    () =>
      agentRequests > requested &&
      setup.data.location.agent.list()?.find((entry) => entry.id === "plan")?.model?.id === "first",
  )
  expect(setup.local.model.current()?.modelID).toBe("first")
})

test("an agent first appearing in a second location is not a change", async () => {
  const other = `${worktree}/other`
  let planModel = "first"
  await using setup = await renderLocal({
    agents: [agent("build"), agent("plan", { providerID: "provider", id: "first" })],
    models: [model("first"), model("second"), model("third")],
    fetch: (url) => {
      if (url.pathname !== "/api/agent") return
      const requested = url.searchParams.get("location[directory]") ?? directory
      return json({
        location: { directory: requested },
        data: [
          agent("build"),
          agent("plan", { providerID: "provider", id: requested === other ? "second" : planModel }),
        ],
      })
    },
  })
  setup.local.agent.set("plan")
  setup.local.model.set({ providerID: "provider", modelID: "third" })
  expect(setup.local.model.current()?.modelID).toBe("third")

  // The second location follows its own configured model on first sight.
  setup.location.set({ directory: other })
  await setup.data.location.agent.sync({ directory: other })
  await setup.data.location.model.sync({ directory: other })
  await waitFor(
    () => setup.data.location.agent.list({ directory: other })?.find((entry) => entry.id === "plan") !== undefined,
  )
  await Bun.sleep(50)
  expect(setup.local.model.current()?.modelID).toBe("second")

  // Returning keeps the first location's pick: the other location's
  // different model never cleared it.
  setup.location.set(undefined)
  await waitFor(
    () => setup.data.location.agent.list()?.find((entry) => entry.id === "plan")?.model?.id === planModel,
  )
  await Bun.sleep(50)
  expect(setup.local.model.current()?.modelID).toBe("third")
})

test("switching agents inside a chat uses that chat's last model for the agent", async () => {
  await using setup = await renderLocal({
    models: [model("first"), model("second", ["low", "high"]), model("third", ["low", "high"])],
    agents: [agent("build", { providerID: "provider", id: "first" }), agent("plan", { providerID: "provider", id: "second", variant: "low" })],
    sessions: [
      session("ses_first", { providerID: "provider", id: "first" }, "build"),
      session("ses_second", { providerID: "provider", id: "first" }, "build"),
    ],
    fetch: (url) => {
      if (url.pathname === "/api/session/ses_first/message")
        return json({
          data: [
            assistant("msg_plan_new", "plan", "third", "high", 3),
            assistant("msg_build", "build", "first", undefined, 2),
            assistant("msg_plan_old", "plan", "second", "low", 1),
          ],
          cursor: {},
        })
      if (url.pathname === "/api/session/ses_second/message")
        return json({
          data: [assistant("msg_build_only", "build", "first", undefined, 1)],
          cursor: {},
        })
    },
  })
  await Promise.all([
    setup.data.session.sync("ses_first"),
    setup.data.session.sync("ses_second"),
    setup.data.session.message.sync("ses_first"),
    setup.data.session.message.sync("ses_second"),
  ])

  // The chat's last assistant message by the agent wins over its configured model.
  setup.route.navigate({ type: "session", sessionID: "ses_first" })
  expect(setup.local.model.selection()).toEqual({ providerID: "provider", modelID: "first", variant: undefined })
  setup.local.agent.set("plan")
  expect(setup.local.model.selection()).toEqual({ providerID: "provider", modelID: "third", variant: "high" })

  // With no message by the agent, the agent's configured model wins.
  setup.route.navigate({ type: "session", sessionID: "ses_second" })
  setup.local.agent.set("plan")
  expect(setup.local.model.selection()).toEqual({ providerID: "provider", modelID: "second", variant: "low" })
})

function assistant(id: string, agentID: string, modelID: string, variant: string | undefined, created: number) {
  return {
    id,
    type: "assistant",
    agent: agentID,
    model: { providerID: "provider", id: modelID, ...(variant === undefined ? {} : { variant }) },
    content: [],
    time: { created },
  }
}

function emitAgentUpdate(setup: Awaited<ReturnType<typeof renderLocal>>) {
  setup.events.emit({
    id: `evt_${crypto.randomUUID()}`,
    type: "agent.updated",
    created: 1,
    data: {},
    location: { directory },
  })
}

async function waitFor(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}
