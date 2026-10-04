import { expect, test } from "bun:test"
import { agent, model, renderLocal, session } from "./fixture/local"
import { directory, json } from "./fixture/tui-client"

// T4: after Instructions activates a model for an agent, the running TUI must
// drop its remembered picks for that agent and follow the new configured model.
// `agent.updated` carries no payload, so the local model context compares the
// re-listed agents and reseeds.

test("an agent model change replaces the new-session pick for that agent", async () => {
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

  // A later manual pick wins until the agent's model changes again.
  setup.local.model.set({ providerID: "provider", modelID: "third" })
  expect(setup.local.model.current()?.modelID).toBe("third")
  const unchanged = agentRequests
  emitAgentUpdate(setup)
  await waitFor(() => agentRequests > unchanged)
  expect(setup.local.model.current()?.modelID).toBe("third")
})

test("an agent model change replaces the per-session pick for that agent", async () => {
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
  setup.local.agent.set("plan")
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

  // The durable session model also follows the activation until a later pick.
  setup.local.agent.set("build")
  setup.local.agent.set("plan")
  expect(setup.local.model.current()?.modelID).toBe("first")
  setup.local.model.set({ providerID: "provider", modelID: "third" })
  expect(setup.local.model.current()?.modelID).toBe("third")
})

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