import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createData, settleMs, type CreateDataInput, type Data } from "../src/solid"
import { OpenCode, type OpenCodeEvent, type SessionInfo } from "../src/promise"

test("config reads and update refreshes are opt-in", async () => {
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const requests: string[] = []
  const location = { directory: "/project" }
  let model = "provider/first"
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      const url = new URL(request.url)
      requests.push(url.pathname)
      if (url.pathname === "/api/location") return Response.json(location)
      if (url.pathname === "/api/config") return Response.json([{ type: "document", info: { model } }])
      if (url.pathname === "/api/mcp/resource")
        return Response.json({ location, data: { resources: [], templates: [] } })
      return Response.json({ location, data: [] })
    },
  })
  const setup = createRoot((dispose) => ({
    data: createData({
      api: () => api,
      directory: location.directory,
      event: {
        on: () => () => {},
        listen(handler) {
          listeners.add(handler)
          return () => listeners.delete(handler)
        },
      },
    }),
    dispose,
  }))
  const event: OpenCodeEvent = { id: "evt_config", created: 1, type: "config.updated", location, data: {} }
  try {
    await setup.data.location.sync()
    listeners.forEach((listener) => listener({ name: event.type, details: event }))
    expect(requests).not.toContain("/api/config")

    await setup.data.location.config.sync()
    expect(requests.filter((path) => path === "/api/config")).toHaveLength(1)
    model = "provider/second"
    listeners.forEach((listener) => listener({ name: event.type, details: event }))
    await setup.data.location.config.sync()
    expect(requests.filter((path) => path === "/api/config")).toHaveLength(2)
    expect(setup.data.location.config.list()).toEqual([{ type: "document", info: { model } }])
  } finally {
    setup.dispose()
  }
})

test.each(["agent", "command"] as const)("%s.updated refreshes only a location the store already loaded", async (kind) => {
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const requests: string[] = []
  const location = { directory: "/project" }
  const catalog = `/api/${kind}`
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      requests.push(new URL(request.url).pathname)
      if (new URL(request.url).pathname === "/api/location") return Response.json(location)
      return Response.json({ location, data: [] })
    },
  })
  const setup = createRoot((dispose) => ({
    data: createData({
      api: () => api,
      directory: location.directory,
      event: {
        on: () => () => {},
        listen(handler) {
          listeners.add(handler)
          return () => listeners.delete(handler)
        },
      },
    }),
    dispose,
  }))
  const event: OpenCodeEvent = { id: `evt_${kind}`, created: 1, type: `${kind}.updated`, location, data: {} }
  try {
    listeners.forEach((listener) => listener({ name: event.type, details: event }))
    expect(requests).not.toContain(catalog)

    await setup.data.location[kind].sync()
    expect(requests.filter((path) => path === catalog)).toHaveLength(1)
    expect(setup.data.location[kind].list()).toBeDefined()
    listeners.forEach((listener) => listener({ name: event.type, details: event }))
    for (let i = 0; i < 200 && requests.filter((path) => path === catalog).length < 2; i++) await Bun.sleep(5)
    expect(requests.filter((path) => path === catalog)).toHaveLength(2)
  } finally {
    setup.dispose()
  }
})

function createTestSetup(location = { directory: "/project" }) {
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const requests: string[] = []
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      const url = new URL(request.url)
      requests.push(url.pathname)
      if (url.pathname === "/api/location") return Response.json(location)
      if (url.pathname === "/api/mcp/resource")
        return Response.json({ location, data: { resources: [], templates: [] } })
      return Response.json({ location, data: [] })
    },
  })
  const setup = createRoot((dispose) => ({
    data: createData({
      api: () => api,
      directory: location.directory,
      event: {
        on: () => () => {},
        listen(handler) {
          listeners.add(handler)
          return () => listeners.delete(handler)
        },
      },
    }),
    dispose,
  }))
  const emit = (event: OpenCodeEvent) => listeners.forEach((listener) => listener({ name: event.type, details: event }))
  return { setup, requests, location, emit }
}

type GuardedTestCase = {
  type: OpenCodeEvent["type"]
  catalog: string
  load: (data: Data) => Promise<unknown>
  list: (data: Data) => unknown
  eventData?: Record<string, unknown>
  settled?: boolean
}

const guardedLocationEvents: GuardedTestCase[] = [
  {
    type: "skill.updated",
    catalog: "/api/skill",
    load: (data) => data.location.skill.sync(),
    list: (data) => data.location.skill.list(),
  },
  {
    type: "reference.updated",
    catalog: "/api/reference",
    load: (data) => data.location.reference.sync(),
    list: (data) => data.location.reference.list(),
  },
  {
    type: "integration.updated",
    catalog: "/api/integration",
    load: (data) => data.location.integration.sync(),
    list: (data) => data.location.integration.list(),
  },
  {
    type: "websearch.updated",
    catalog: "/api/websearch/provider",
    load: (data) => data.location.websearch.refresh(),
    list: (data) => data.location.websearch.list(),
  },
  {
    type: "mcp.status.changed",
    catalog: "/api/mcp",
    load: (data) => data.location.mcp.server.sync(),
    list: (data) => data.location.mcp.server.list(),
    eventData: { server: "test" },
    settled: true,
  },
  {
    type: "mcp.resources.changed",
    catalog: "/api/mcp/resource",
    load: (data) => data.location.mcp.resource.sync(),
    list: (data) => data.location.mcp.resource.list(),
  },
]

test.each(guardedLocationEvents)("$type never-loaded location sends no request", async (c) => {
  const { setup, requests, location, emit } = createTestSetup()
  try {
    const event = { id: `evt_${c.type}`, created: 1, type: c.type, location, data: c.eventData ?? {} } as OpenCodeEvent
    emit(event)
    if (c.settled) {
      await Bun.sleep(settleMs * 2)
    } else {
      await Bun.sleep(20)
    }
    expect(requests).not.toContain(c.catalog)
  } finally {
    setup.dispose()
  }
})

test.each(guardedLocationEvents)("$type loaded location refetches from the event itself", async (c) => {
  const { setup, requests, location, emit } = createTestSetup()
  try {
    await c.load(setup.data)
    expect(requests.filter((path) => path === c.catalog)).toHaveLength(1)
    expect(c.list(setup.data)).toBeDefined()

    const event = { id: `evt_${c.type}`, created: 1, type: c.type, location, data: c.eventData ?? {} } as OpenCodeEvent
    emit(event)
    for (let i = 0; i < 200 && requests.filter((path) => path === c.catalog).length < 2; i++) await Bun.sleep(5)
    expect(requests.filter((path) => path === c.catalog)).toHaveLength(2)
  } finally {
    setup.dispose()
  }
})

test("config.updated never-loaded websearch sends no request", async () => {
  const { setup, requests, location, emit } = createTestSetup()
  try {
    const event: OpenCodeEvent = { id: "evt_config", created: 1, type: "config.updated", location, data: {} }
    emit(event)
    await Bun.sleep(20)
    expect(requests).not.toContain("/api/websearch/provider")
  } finally {
    setup.dispose()
  }
})

test("config.updated loaded websearch refetches from the event itself", async () => {
  const { setup, requests, location, emit } = createTestSetup()
  try {
    await setup.data.location.websearch.refresh()
    expect(requests.filter((path) => path === "/api/websearch/provider")).toHaveLength(1)
    expect(setup.data.location.websearch.list()).toBeDefined()

    const event: OpenCodeEvent = { id: "evt_config", created: 1, type: "config.updated", location, data: {} }
    emit(event)
    for (let i = 0; i < 200 && requests.filter((path) => path === "/api/websearch/provider").length < 2; i++)
      await Bun.sleep(5)
    expect(requests.filter((path) => path === "/api/websearch/provider")).toHaveLength(2)
  } finally {
    setup.dispose()
  }
})

test("integration.updated refetches model and provider only when their catalogs are already loaded", async () => {
  const { setup, requests, location, emit } = createTestSetup()
  const event: OpenCodeEvent = { id: "evt_integration", created: 1, type: "integration.updated", location, data: {} }
  try {
    emit(event)
    await Bun.sleep(20)
    expect(requests).not.toContain("/api/integration")
    expect(requests).not.toContain("/api/model")
    expect(requests).not.toContain("/api/provider")

    await setup.data.location.model.sync()
    expect(requests.filter((path) => path === "/api/model")).toHaveLength(1)
    emit(event)
    for (let i = 0; i < 200 && requests.filter((path) => path === "/api/model").length < 2; i++) await Bun.sleep(5)
    expect(requests.filter((path) => path === "/api/model")).toHaveLength(2)
    expect(requests).not.toContain("/api/integration")
    expect(requests).not.toContain("/api/provider")

    await setup.data.location.provider.sync()
    expect(requests.filter((path) => path === "/api/provider")).toHaveLength(1)
    emit(event)
    for (let i = 0; i < 200 && requests.filter((path) => path === "/api/provider").length < 2; i++) await Bun.sleep(5)
    expect(requests.filter((path) => path === "/api/provider")).toHaveLength(2)
    expect(requests.filter((path) => path === "/api/model")).toHaveLength(3)
    expect(requests).not.toContain("/api/integration")
  } finally {
    setup.dispose()
  }
})

test("event refreshes report failures, remain retryable, and preserve explicit read errors", async () => {
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const reported = Promise.withResolvers<unknown>()
  const errors: unknown[] = []
  const state = { offline: true, requests: 0 }
  const session: SessionInfo = {
    id: "ses_refresh_failure",
    projectID: "project",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0, idle: 2 },
    location: { directory: "/project" },
  }
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async () => {
      state.requests++
      if (state.offline) throw new TypeError("Failed to fetch")
      return Response.json({ data: { ...session, title: "Recovered" } })
    },
  })
  const setup = createRoot((dispose) => ({
    data: createData({
      api: () => api,
      directory: "/project",
      event: {
        on: () => () => {},
        listen(handler) {
          listeners.add(handler)
          return () => listeners.delete(handler)
        },
      },
      onError(error) {
        errors.push(error)
        reported.resolve(error)
      },
    }),
    dispose,
  }))
  const event: OpenCodeEvent = {
    id: "evt_refresh_failure",
    created: 2,
    type: "session.viewed",
    durable: { aggregateID: session.id, seq: 1, version: 1 },
    data: { sessionID: session.id, idle: 2 },
  }
  try {
    setup.data.session.remember(session)
    setup.data.session.invalidate(session.id)
    await expect(setup.data.session.sync(session.id)).rejects.toThrow("Transport")
    expect(errors).toEqual([])
    listeners.forEach((listener) => listener({ name: event.type, details: event }))
    expect(String(await reported.promise)).toContain("Transport")
    expect(errors).toHaveLength(1)
    expect(setup.data.session.get(session.id)?.title).toBeUndefined()
    state.offline = false
    listeners.forEach((listener) => listener({ name: event.type, details: event }))
    await setup.data.session.sync(session.id)
    expect(setup.data.session.get(session.id)?.title).toBe("Recovered")
    expect(state.requests).toBe(3)
  } finally {
    setup.dispose()
  }
})

test.each(["reconnecting", "disposed"] as const)("background reads respect %s owners", async (mode) => {
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const pending = Promise.withResolvers<Response>()
  const errors: unknown[] = []
  const state = { requests: 0 }
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: () => {
      state.requests++
      return pending.promise
    },
  })
  const setup = createRoot((dispose) => ({
    data: createData({
      api: () => api,
      directory: "/project",
      event: {
        on: () => () => {},
        listen(handler) {
          listeners.add(handler)
          return () => listeners.delete(handler)
        },
      },
      connection: { status: () => (mode === "reconnecting" ? "reconnecting" : "connected") },
      onError: (error) => errors.push(error),
    }),
    dispose,
  }))
  const event: OpenCodeEvent = {
    id: "evt_refresh_owner",
    type: "command.updated",
    location: { directory: "/project" },
    data: {},
  }
  listeners.forEach((listener) => listener({ name: event.type, details: event }))
  if (mode === "reconnecting") {
    expect(state.requests).toBe(0)
    setup.dispose()
    return
  }
  const joined = setup.data.location.command.sync()
  setup.dispose()
  pending.reject(new TypeError("Failed to fetch"))
  await expect(joined).rejects.toThrow("Transport")
  expect(state.requests).toBe(1)
  expect(errors).toEqual([])
})

test("a burst of mcp.status.changed events refetches the server list once it settles", async () => {
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const requests: string[] = []
  const location = { directory: "/project" }
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      requests.push(new URL(request.url).pathname)
      return Response.json({ location, data: [] })
    },
  })
  const setup = createRoot((dispose) => ({
    data: createData({
      api: () => api,
      directory: location.directory,
      event: {
        on: () => () => {},
        listen(handler) {
          listeners.add(handler)
          return () => listeners.delete(handler)
        },
      },
    }),
    dispose,
  }))
  try {
    await setup.data.location.mcp.server.sync()
    expect(requests.filter((path) => path === "/api/mcp")).toHaveLength(1)
    for (const server of ["a", "b", "c", "d", "e"]) {
      const event: OpenCodeEvent = { id: `evt_${server}`, created: 1, type: "mcp.status.changed", location, data: { server } }
      listeners.forEach((listener) => listener({ name: event.type, details: event }))
    }
    expect(requests.filter((path) => path === "/api/mcp")).toHaveLength(1)
    await new Promise((resolve) => setTimeout(resolve, settleMs * 2))
    expect(requests.filter((path) => path === "/api/mcp")).toHaveLength(2)
  } finally {
    setup.dispose()
  }
})

test("invalidations that land before a queued reload starts are absorbed by it", async () => {
  const pending: Array<PromiseWithResolvers<Response>> = []
  const location = { directory: "/project" }
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: () => {
      const deferred = Promise.withResolvers<Response>()
      pending.push(deferred)
      return deferred.promise
    },
  })
  const setup = createRoot((dispose) => ({
    data: createData({
      api: () => api,
      directory: location.directory,
      event: { on: () => () => {}, listen: () => () => {} },
    }),
    dispose,
  }))
  try {
    const first = setup.data.location.agent.sync()
    expect(pending).toHaveLength(1)
    setup.data.location.agent.invalidate()
    const second = setup.data.location.agent.sync()
    setup.data.location.agent.invalidate()
    const third = setup.data.location.agent.sync()
    setup.data.location.agent.invalidate()
    expect(pending).toHaveLength(1)
    pending[0].resolve(Response.json({ location, data: [] }))
    await first
    await Promise.resolve()
    expect(pending).toHaveLength(2)
    pending[1].resolve(Response.json({ location, data: [{ name: "reviewer" }] }))
    await Promise.all([second, third])
    expect(pending).toHaveLength(2)
    await setup.data.location.agent.sync()
    expect(pending).toHaveLength(2)
  } finally {
    setup.dispose()
  }
})
