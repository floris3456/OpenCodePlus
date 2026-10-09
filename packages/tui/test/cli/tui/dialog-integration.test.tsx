/** @jsxImportSource @opentui/solid */
import { InputRenderable, TextareaRenderable } from "@opentui/core"
import type { FormFields, IntegrationInfo, LocationRef } from "@opencode/client"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onMount } from "solid-js"
import { DialogIntegration } from "../../../src/component/dialog-integration"
import { ConfigProvider } from "../../../src/config"
import { ClientProvider } from "../../../src/context/client"
import { DataProvider, useData } from "../../../src/context/data"
import { Keymap } from "../../../src/context/keymap"
import { LocationProvider, useLocation } from "../../../src/context/location"
import { ThemeProvider } from "../../../src/context/theme"
import { DialogProvider, useDialog } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"
import { emptyThemeSource } from "../../fixture/fixture"
import { createApi, createEventStream, createFetch, json } from "../../fixture/tui-client"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

test("renders account management with an uncategorized add row and marks the active credential", async () => {
  const fixture = await renderIntegration()

  try {
    const frame = fixture.app.captureCharFrame()
    const lines = frame.split("\n")

    expect(frame.indexOf("Add account")).toBeLessThan(frame.indexOf("Connected accounts"))
    expect(frame.indexOf("Connected accounts")).toBeLessThan(frame.indexOf("Personal"))
    expect(frame.indexOf("Personal")).toBeLessThan(frame.indexOf("Work"))
    expect(lines.find((line) => line.includes("Personal"))).toContain("\u25cf")
    expect(lines.find((line) => line.includes("Work"))).not.toContain("\u25cf")
    expect(frame).not.toContain("OPENAI_API_KEY")
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("opens the key connection prompt from the initially focused add account row", async () => {
  const fixture = await renderIntegration()

  try {
    fixture.app.mockInput.pressEnter()
    await fixture.app.waitForFrame((frame) => frame.includes("API key") && !frame.includes("Connected accounts"))

    expect(fixture.requests).toEqual([])
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("skips hidden authentication fields and sends their defaults", async () => {
  const fixture = await renderIntegration(undefined, [
    { type: "string", key: "server", title: "Console URL", hidden: true, default: "https://example.com/console" },
    { type: "string", key: "optional", hidden: true },
  ])

  try {
    fixture.app.mockInput.pressEnter()
    await fixture.app.waitFor(() => fixture.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    expect(fixture.app.captureCharFrame()).not.toContain("Console URL")
    await fixture.app.mockInput.typeText("test-key")
    fixture.app.mockInput.pressEnter()
    await fixture.app.waitFor(() => fixture.requests.length === 1)
    expect(fixture.requests).toEqual([
      {
        method: "POST",
        path: "/api/integration/openai/connect/key",
        body: { key: "test-key", answer: { server: "https://example.com/console" } },
      },
    ])
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("switches the selected account with enter and keeps the reactive account manager open", async () => {
  const fixture = await renderIntegration()

  try {
    fixture.app.mockInput.pressArrow("down")
    fixture.app.mockInput.pressArrow("down")
    fixture.app.mockInput.pressEnter()

    await fixture.app.waitForFrame((frame) => {
      const line = frame.split("\n").find((entry) => entry.includes("Work"))
      return frame.includes("Connected accounts") && line?.includes("\u25cf") === true
    })

    expect(fixture.requests).toEqual([{ method: "POST", path: "/api/credential/cred_work/activate" }])
    expect(fixture.accounts.map((account) => account.id)).toEqual(["cred_work", "cred_personal"])
    const frame = fixture.app.captureCharFrame()
    expect(frame.indexOf("Personal")).toBeLessThan(frame.indexOf("Work"))
    expect(fixture.reads.integration).toBe(1)
    expect(fixture.reads.model).toBeGreaterThan(0)
    expect(fixture.reads.provider).toBeGreaterThan(0)
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("does not refetch when selecting the already-active account", async () => {
  const fixture = await renderIntegration()

  try {
    fixture.app.mockInput.pressArrow("down")
    fixture.app.mockInput.pressEnter()

    expect(fixture.requests).toEqual([])
    expect(fixture.reads.model).toBe(0)
    expect(fixture.reads.provider).toBe(0)
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("renames the selected account through a prefilled prompt and reopens the account manager", async () => {
  const fixture = await renderIntegration()

  try {
    fixture.app.mockInput.pressArrow("down")
    fixture.app.mockInput.pressArrow("down")
    fixture.app.mockInput.pressKey("r", { ctrl: true })
    await fixture.app.waitFor(() => fixture.app.renderer.currentFocusedEditor instanceof TextareaRenderable)

    const textarea = fixture.app.renderer.currentFocusedEditor
    if (!(textarea instanceof TextareaRenderable)) throw new Error("expected focused rename prompt")
    expect(textarea.plainText).toBe("Work")

    await fixture.app.mockInput.typeText(" Account")
    fixture.app.mockInput.pressEnter()
    await fixture.app.waitForFrame((frame) => frame.includes("Connected accounts") && frame.includes("Work Account"))

    expect(fixture.requests).toEqual([
      { method: "PATCH", path: "/api/credential/cred_work", body: { label: "Work Account" } },
    ])
    expect(fixture.accounts.find((account) => account.id === "cred_work")?.label).toBe("Work Account")
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("requires delete confirmation and preserves the account manager when another credential remains", async () => {
  const fixture = await renderIntegration()

  try {
    fixture.app.mockInput.pressArrow("down")
    fixture.app.mockInput.pressArrow("down")
    fixture.app.mockInput.pressKey("d", { ctrl: true })

    expect(fixture.requests).toEqual([])

    fixture.app.mockInput.pressKey("d", { ctrl: true })
    await fixture.app.waitForFrame((frame) => frame.includes("Connected accounts") && !frame.includes("Work"))

    expect(fixture.requests).toEqual([{ method: "DELETE", path: "/api/credential/cred_work" }])
    expect(fixture.accounts).toEqual([{ type: "credential", method: "key", id: "cred_personal", label: "Personal" }])
    expect(fixture.reads.model).toBe(0)
    expect(fixture.reads.provider).toBe(0)
    expect(fixture.app.captureCharFrame()).toContain("Add account")
    expect(fixture.app.captureCharFrame()).toContain("Personal")
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("renames the account label rather than its delete-confirmation message", async () => {
  const fixture = await renderIntegration()

  try {
    fixture.app.mockInput.pressArrow("down")
    fixture.app.mockInput.pressArrow("down")
    fixture.app.mockInput.pressKey("d", { ctrl: true })
    await fixture.app.waitForFrame((frame) => frame.includes("again to confirm"))

    fixture.app.mockInput.pressKey("r", { ctrl: true })
    await fixture.app.waitFor(() => fixture.app.renderer.currentFocusedEditor instanceof TextareaRenderable)

    const textarea = fixture.app.renderer.currentFocusedEditor
    if (!(textarea instanceof TextareaRenderable)) throw new Error("expected focused rename prompt")
    expect(textarea.plainText).toBe("Work")
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("marks the remaining account active after deleting the active credential", async () => {
  const fixture = await renderIntegration()

  try {
    fixture.app.mockInput.pressArrow("down")
    fixture.app.mockInput.pressKey("d", { ctrl: true })
    fixture.app.mockInput.pressKey("d", { ctrl: true })

    await fixture.app.waitForFrame((frame) => {
      const line = frame.split("\n").find((entry) => entry.includes("Work"))
      return !frame.includes("Personal") && line?.includes("\u25cf") === true
    })

    expect(fixture.requests).toEqual([{ method: "DELETE", path: "/api/credential/cred_personal" }])
    expect(fixture.accounts).toEqual([{ type: "credential", method: "key", id: "cred_work", label: "Work" }])
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("hides account rename and delete actions while the add account row is selected", async () => {
  const fixture = await renderIntegration()

  try {
    expect(fixture.app.captureCharFrame()).not.toContain("rename")
    expect(fixture.app.captureCharFrame()).not.toContain("delete")

    fixture.app.mockInput.pressKey("r", { ctrl: true })
    fixture.app.mockInput.pressKey("d", { ctrl: true })
    fixture.app.mockInput.pressKey("d", { ctrl: true })

    expect(fixture.requests).toEqual([])
    expect(fixture.app.renderer.currentFocusedEditor).toBeInstanceOf(InputRenderable)
    expect(fixture.app.captureCharFrame()).toContain("Connected accounts")

    fixture.app.mockInput.pressArrow("down")
    await fixture.app.waitForFrame((frame) => frame.includes("rename") && frame.includes("delete"))

    fixture.app.mockInput.pressArrow("up")
    await fixture.app.waitForFrame((frame) => !frame.includes("rename") && !frame.includes("delete"))
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("uses the active location for integration data without scoping credential requests", async () => {
  const location = { directory: "/remote/project" }
  const fixture = await renderIntegration(location)

  try {
    fixture.app.mockInput.pressArrow("down")
    fixture.app.mockInput.pressArrow("down")
    fixture.app.mockInput.pressEnter()

    await fixture.app.waitFor(() => fixture.requests.length === 1)
    expect(fixture.locations).toContainEqual(location)
    expect(fixture.locations.at(-1)).toEqual(location)
    expect(fixture.credentialQueries).toEqual([""])
  } finally {
    fixture.app.renderer.destroy()
  }
})

test.each([
  { width: 80, height: 24 },
  { width: 140, height: 42 },
])("native CLIProxyAPI forwards URL and key to its integration at %j", async (size) => {
  const fixture = await renderIntegration(
    undefined,
    undefined,
    {
      id: "cliproxyapi",
      name: "CLIProxyAPI",
      connections: [],
      methods: [
        {
          type: "key",
          label: "CLIProxyAPI API key",
          form: [
            {
              type: "string",
              key: "baseURL",
              title: "CLIProxyAPI URL",
              required: true,
              placeholder: "https://cpa.example.com/v1",
            },
          ],
        },
      ],
    },
    size,
  )
  try {
    const frame = fixture.app.captureCharFrame()
    expect(frame).toContain("Popular")
    expect(frame).toContain("CLIProxyAPI")
    fixture.app.mockInput.pressEnter()
    await fixture.app.waitForFrame((frame) => frame.includes("CLIProxyAPI URL"))
    await fixture.app.mockInput.typeText("http://127.0.0.1:8317/v1")
    fixture.app.mockInput.pressEnter()
    await fixture.app.waitForFrame((frame) => frame.includes("API key") && !frame.includes("CLIProxyAPI URL"))
    await fixture.app.mockInput.typeText("synthetic-cpa-key")
    fixture.app.mockInput.pressEnter()
    await fixture.app.waitFor(() => fixture.requests.length === 1)
    expect(fixture.requests).toEqual([
      {
        method: "POST",
        path: "/api/integration/cliproxyapi/connect/key",
        body: { key: "synthetic-cpa-key", answer: { baseURL: "http://127.0.0.1:8317/v1" } },
      },
    ])
  } finally {
    fixture.app.renderer.destroy()
  }
})

async function renderIntegration(
  activeLocation?: LocationRef,
  form?: FormFields,
  native?: IntegrationInfo,
  size = { width: 100, height: 30 },
) {
  const events = createEventStream()
  const requests: Array<{ method: string; path: string; body?: unknown }> = []
  const locations: LocationRef[] = []
  const credentialQueries: string[] = []
  const reads = { integration: 0, model: 0, provider: 0 }
  let accounts = [
    { type: "credential" as const, method: "key" as const, id: "cred_personal", label: "Personal" },
    { type: "credential" as const, method: "key" as const, id: "cred_work", label: "Work" },
  ]

  const calls = createFetch(async (url, request) => {
    const directory =
      url.searchParams.get("location[directory]") ??
      decodeURIComponent(request.headers.get("x-opencode-directory") ?? process.cwd())
    const requestedLocation = { directory }
    const location = {
      ...requestedLocation,
      project: { id: "proj_test", directory, canonical: directory },
    }

    if (url.pathname === "/api/integration") {
      locations.push(requestedLocation)
      reads.integration++
      return json({
        location,
        data: [
          native ?? {
            id: "openai",
            name: "OpenAI",
            methods: [{ type: "key", label: "API key", form }],
            connections: [...accounts, { type: "env", name: "OPENAI_API_KEY" }],
          },
        ],
      })
    }

    if (request.method === "POST" && url.pathname === `/api/integration/${native?.id ?? "openai"}/connect/key`) {
      requests.push({ method: request.method, path: url.pathname, body: await request.json() })
      return new Response(null, { status: 204 })
    }

    if (url.pathname === "/api/model") {
      reads.model++
      return json({ location, data: [] })
    }

    if (url.pathname === "/api/provider") {
      reads.provider++
      return json({ location, data: [] })
    }

    if (request.method === "POST" && /^\/api\/credential\/[^/]+\/activate$/.test(url.pathname)) {
      credentialQueries.push(url.search)
      const id = url.pathname.split("/")[3]
      const active = accounts.find((account) => account.id === id)
      if (!active) throw new Error(`unknown credential: ${id}`)
      accounts = [active, ...accounts.filter((account) => account.id !== id)]
      requests.push({ method: request.method, path: url.pathname })
      events.emit({
        id: `evt_switched_${id}`,
        created: Date.now(),
        type: "credential.switched",
        data: { integrationID: "openai", credentialID: id },
      })
      return new Response(null, { status: 204 })
    }

    if (request.method === "PATCH" && /^\/api\/credential\/[^/]+$/.test(url.pathname)) {
      const id = url.pathname.split("/")[3]
      const body = (await request.json()) as { label: string }
      accounts = accounts.map((account) => (account.id === id ? { ...account, label: body.label } : account))
      requests.push({ method: request.method, path: url.pathname, body })
      events.emit({ id: `evt_updated_${id}`, created: Date.now(), type: "credential.updated", data: {} })
      return new Response(null, { status: 204 })
    }

    if (request.method === "DELETE" && /^\/api\/credential\/[^/]+$/.test(url.pathname)) {
      const id = url.pathname.split("/")[3]
      const active = accounts[0]?.id === id
      accounts = accounts.filter((account) => account.id !== id)
      requests.push({ method: request.method, path: url.pathname })
      events.emit({ id: `evt_deleted_${id}`, created: Date.now(), type: "credential.updated", data: {} })
      if (active)
        events.emit({
          id: `evt_switched_${id}`,
          created: Date.now(),
          type: "credential.switched",
          data: { integrationID: "openai", credentialID: accounts[0]?.id ?? null },
        })
      return new Response(null, { status: 204 })
    }

    return undefined
  }, events)

  function Probe() {
    const data = useData()
    const dialog = useDialog()
    const location = useLocation()
    onMount(() => {
      location.set(activeLocation)
      void data.location.integration
        .sync(activeLocation)
        .then(() =>
          dialog.replace(() => (
            <DialogIntegration integrationID={native ? undefined : "openai"} autoConnect={!native} />
          )),
        )
    })
    return null
  }

  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ToastProvider>
              <ClientProvider api={createApi(calls.fetch)}>
                <DataProvider directory={process.cwd()}>
                  <LocationProvider>
                    <ThemeProvider mode="dark" source={emptyThemeSource}>
                      <DialogProvider>
                        <Probe />
                      </DialogProvider>
                    </ThemeProvider>
                  </LocationProvider>
                </DataProvider>
              </ClientProvider>
            </ToastProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { ...size, kittyKeyboard: true },
  )

  app.renderer.start()
  await app.waitForFrame((frame) =>
    native
      ? frame.includes("Connect an integration") && frame.includes(native.name)
      : frame.includes("Add account") && frame.includes("Personal") && frame.includes("Work"),
  )
  await app.waitFor(() => app.renderer.currentFocusedEditor instanceof InputRenderable)

  return {
    app,
    reads,
    requests,
    locations,
    credentialQueries,
    get accounts() {
      return accounts
    },
  }
}
