import { expect, test } from "bun:test"
import { createAppFixture } from "./fixture/app"
import { createEventStream, createFetch, directory, json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"

// #29: ctrl+x n starts a new chat on the current agent's active model as the
// host reports it, not on the composer's leftover (which can be an earlier
// manual pick superseded since, for example by an Instructions activation).

function model(id: string, name: string, variants: string[] = []) {
  return {
    id,
    modelID: id,
    providerID: "demo",
    name,
    status: "active" as const,
    enabled: true,
    capabilities: { input: ["text"], output: ["text"], tools: true },
    cost: [],
    limit: { context: 10000, output: 1000 },
    time: { released: 0 },
    variants: variants.map((id) => ({ id })),
  }
}

const STALE = model("stale-pick", "Stale Pick Alpha")
const ACTIVE = model("active-model", "Active Model Beta", ["ultra"])

function agent(id: string, selected?: { providerID: string; id: string; variant?: string }) {
  return {
    id,
    name: id,
    model: selected,
    mode: "primary" as const,
    hidden: false,
    permissions: [],
    request: { settings: {}, headers: {}, body: {} },
  }
}

function session(selected: { providerID: string; id: string; variant?: string }) {
  return {
    id: "ses_newchat",
    agent: "build",
    model: selected,
    title: "ses_newchat",
    location: { directory },
    projectID: "project",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
}

async function boot(state: string, options: { agents: unknown[]; sessionModel: { providerID: string; id: string; variant?: string } }) {
  const events = createEventStream()
  const calls = createFetch(async (url) => {
    if (url.pathname === "/api/session") return json({ data: [session(options.sessionModel)] })
    if (url.pathname === "/api/session/ses_newchat") return json({ data: session(options.sessionModel) })
    if (/^\/api\/session\/ses_newchat\/(message|inbox|permission)$/.test(url.pathname))
      return json({ data: [], cursor: {} })
    if (url.pathname === "/api/agent") return json({ location: { directory }, data: options.agents })
    if (url.pathname === "/api/model") return json({ location: { directory }, data: [STALE, ACTIVE] })
    if (url.pathname === "/api/provider") return json({ location: { directory }, data: [{ id: "demo", name: "Demo" }] })
    if (url.pathname === "/api/rpc/opencode.plus.quota.usage/enabled")
      return json({ output: { enabled: false } })
    if (url.pathname === "/api/rpc/opencode.plus/team.list") return json({ output: { teams: [] } })
    if (url.pathname === "/api/rpc/opencode.plus/team.runs.list") return json({ output: { runs: [] } })
    if (url.pathname === "/api/rpc/opencode.plus/warming.status")
      return json({ output: { sessionID: "ses_newchat", chat: "off", active: false, now: 0 } })
    return undefined
  }, events)
  return createAppFixture({
    state,
    args: { sessionID: "ses_newchat" },
    config: { animations: false, tabs: { mode: "off" }, keybinds: { "session.new": "f6" } },
    fetch: calls.fetch,
  })
}

test("session.new starts the new chat on the agent's active model, not the composer's leftover", async () => {
  await using state = await tmpdir()
  await using setup = await boot(state.path, {
    agents: [agent("build", { providerID: "demo", id: "active-model" })],
    sessionModel: { providerID: "demo", id: "stale-pick" },
  })
  await setup.ready
  // The open chat's composer still shows its own (stale) pick.
  await setup.waitForFrame((frame) => frame.includes("Stale Pick Alpha"))
  setup.mockInput.pressKey("F6")
  // The logo marks the home route: the new chat is open now.
  const home = await setup.waitForFrame(
    (frame) => frame.includes("█▀▀█") && frame.includes("Active Model Beta"),
  )
  expect(home).not.toContain("Stale Pick Alpha")
}, 30_000)

test("session.new keeps the composer's variant when it picked the same model", async () => {
  await using state = await tmpdir()
  await using setup = await boot(state.path, {
    // The agent reports no variant; the composer's ultra pick survives only
    // because it was picked for this same model.
    agents: [agent("build", { providerID: "demo", id: "active-model" })],
    sessionModel: { providerID: "demo", id: "active-model", variant: "ultra" },
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("Active Model Beta") && frame.includes("ultra"))
  setup.mockInput.pressKey("F6")
  const home = await setup.waitForFrame(
    (frame) => frame.includes("█▀▀█") && frame.includes("Active Model Beta"),
  )
  expect(home).toContain("ultra")
}, 30_000)

test("resolveNewChatModel prefers the agent model and keeps the variant only for the same model", async () => {
  const { resolveNewChatModel } = await import("../src/app")
  expect(
    resolveNewChatModel({
      agentModel: { providerID: "demo", id: "active-model" },
      composer: { providerID: "demo", modelID: "stale-pick" },
      variant: "ultra",
    }),
  ).toEqual({ model: { providerID: "demo", modelID: "active-model" }, variant: undefined })
  expect(
    resolveNewChatModel({
      agentModel: { providerID: "demo", id: "active-model" },
      composer: { providerID: "demo", modelID: "active-model" },
      variant: "ultra",
    }),
  ).toEqual({ model: { providerID: "demo", modelID: "active-model" }, variant: "ultra" })
  expect(
    resolveNewChatModel({
      agentModel: undefined,
      composer: { providerID: "demo", modelID: "stale-pick" },
      variant: "ultra",
    }),
  ).toEqual({ model: { providerID: "demo", modelID: "stale-pick" }, variant: undefined })
  expect(resolveNewChatModel({ agentModel: undefined, composer: undefined, variant: undefined })).toBeUndefined()
})
