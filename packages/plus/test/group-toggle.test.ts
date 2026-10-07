// Browser parent category plus group toggles (plan plus-1.1.17 WP categories):
// dotted Code Mode namespaces nest under their first segment, and every group
// row toggles its nearest toggleable rows in one write.
import { expect, test } from "bun:test"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { Deferred, Effect } from "effect"
import { fingerprint, type AgentSource, type CustomizationRecord, type Item } from "../src/instructions/model.js"
import { toggleGroup } from "../src/instructions/ops.js"
import { tree, type TreeInput, type TreeNode } from "../src/instructions/tree.js"
import { createPlusApi, createState, type PlusApi } from "../src/index.js"
import { registerInstructionTools } from "../src/tools.js"
import { glyphOf } from "../src/tui/instructions/row.js"
import { createSnapshot, renderInstructionsRoute } from "./tui.js"
import { agentInfo, fullContext } from "./harness.js"
import { dispatch, footer, reach, selectedRow } from "./instructions-nav.js"
import type { Context } from "@opencode/plugin/effect/plugin"

const UPDATED = "2026-01-01T00:00:00.000Z"

function makeItem(overrides: Partial<Item> & Pick<Item, "id" | "kind" | "title">): Item {
  const text = overrides.text ?? "default text"
  return {
    group: "native",
    text,
    enabled: true,
    fingerprint: fingerprint(text),
    ...overrides,
  }
}

function agents(): AgentSource[] {
  return [{ id: "Implementer", scope: "project", origin: "user" }]
}

// Six bare `browser` tools plus one per sub-namespace, plus an `image` tool
// that must keep today's flat group.
function browserItems(): Item[] {
  const bare = ["preview", "navigate", "click", "fill", "screenshot", "console"].map((name) =>
    makeItem({ id: `tool:browser-${name}`, kind: "tool", group: "native", title: name, codemode: true, namespace: "browser" }),
  )
  const subs: Record<string, string> = {
    cpu: "profile",
    files: "download",
    heap: "snapshot",
    network: "requests",
    tabs: "list",
    trace: "recording",
  }
  const nested = Object.entries(subs).map(([sub, name]) =>
    makeItem({ id: `tool:browser-${sub}-${name}`, kind: "tool", group: "native", title: `${sub}-${name}`, codemode: true, namespace: `browser.${sub}` }),
  )
  return [
    ...bare,
    ...nested,
    makeItem({ id: "tool:image", kind: "tool", group: "native", title: "image", codemode: true, namespace: "image" }),
  ]
}

function expandAll(input: Omit<TreeInput, "expanded">): TreeNode[] {
  const expanded = new Set<string>()
  let previous = -1
  let nodes: TreeNode[] = []
  while (previous !== expanded.size) {
    previous = expanded.size
    nodes = tree({ ...input, expanded })
    for (const node of nodes) expanded.add(node.id)
  }
  return nodes
}

function childrenOf(nodes: readonly TreeNode[], id: string): TreeNode[] {
  const index = nodes.findIndex((node) => node.id === id)
  if (index === -1) return []
  const depth = nodes[index]!.depth
  const out: TreeNode[] = []
  for (const node of nodes.slice(index + 1)) {
    if (node.depth <= depth) break
    if (node.depth === depth + 1) out.push(node)
  }
  return out
}

const NATIVE = "group:project:Implementer:tools:native"
const CODE = `${NATIVE}:codemode`
const BROWSER = `${CODE}:browser`

function offRecord(item: string): CustomizationRecord {
  return {
    type: "customization",
    level: "project",
    agent: "Implementer",
    item,
    section: null,
    state: "off",
    basedOn: fingerprint("default text"),
    updated: UPDATED,
  }
}

function onRecord(item: string): CustomizationRecord {
  return { ...offRecord(item), state: "on" }
}

function browserTools(): Item[] {
  return browserItems().filter((item) => item.namespace?.startsWith("browser") === true)
}

test("browser namespaces nest under one Browser group with Pages and sub-groups", () => {
  const nodes = expandAll({ items: browserItems(), records: [], agents: agents() })
  expect(childrenOf(nodes, CODE).map((node) => node.label)).toEqual(["Browser", "image"])
  const browser = nodes.find((node) => node.id === BROWSER)
  expect(browser?.label).toBe("Browser")
  expect(browser?.depth).toBe(7)
  expect(childrenOf(nodes, BROWSER).map((node) => node.label)).toEqual([
    "Pages",
    "CPU",
    "Files",
    "Heap",
    "Network",
    "Tabs",
    "Trace",
  ])
  const pages = nodes.find((node) => node.id === `${BROWSER}:pages`)
  expect(pages?.label).toBe("Pages")
  expect(pages?.depth).toBe(8)
  expect(childrenOf(nodes, `${BROWSER}:pages`).map((node) => node.label).sort()).toEqual(
    ["click", "console", "fill", "navigate", "preview", "screenshot"].sort(),
  )
  expect(childrenOf(nodes, `${BROWSER}:cpu`).map((node) => node.label)).toEqual(["cpu-profile"])
  expect(nodes.find((node) => node.id === "item:project:Implementer:tool:browser-preview")?.depth).toBe(9)
  // A first segment with no dotted siblings keeps today's flat group.
  const image = nodes.find((node) => node.id === `${CODE}:image`)
  expect(image?.label).toBe("image")
  expect(childrenOf(nodes, `${CODE}:image`).map((node) => node.label)).toEqual(["image"])
})

test("Browser group toggles with an on/off/n-m summary", () => {
  // Code Mode tools resolve off for an unlinked agent, so the on-states below
  // are stored records, not the items' upstream defaults.
  const allOn = expandAll({ items: browserItems(), records: browserTools().map((item) => onRecord(item.id)), agents: agents() })
  const browser = allOn.find((node) => node.id === BROWSER)
  expect(browser?.actions?.toggle).toBe(true)
  expect(browser?.badges.state).toBe("on")
  expect(browser?.badges.summary).toBeUndefined()
  expect(glyphOf(browser!)).toBe("●")

  const mixed = expandAll({
    items: browserItems(),
    records: [...browserTools().filter((item) => item.id !== "tool:browser-preview").map((item) => onRecord(item.id)), offRecord("tool:browser-preview")],
    agents: agents(),
  })
  const mixedBrowser = mixed.find((node) => node.id === BROWSER)
  expect(mixedBrowser?.actions?.toggle).toBe(true)
  expect(mixedBrowser?.badges.state).toBeUndefined()
  expect(mixedBrowser?.badges.summary).toBe("11/12")
  expect(glyphOf(mixedBrowser!)).toBe("11/12")

  const allOff = expandAll({
    items: browserItems(),
    records: browserTools().map((item) => offRecord(item.id)),
    agents: agents(),
  })
  const offBrowser = allOff.find((node) => node.id === BROWSER)
  expect(offBrowser?.badges.state).toBe("off")
  expect(glyphOf(offBrowser!)).toBe("○")
})

test("toggleGroup turns an all-on Browser off in one result", () => {
  const input = { items: browserItems(), records: browserTools().map((item) => onRecord(item.id)), agents: agents() }
  const result = toggleGroup(input, BROWSER)
  if ("refusal" in result) throw new Error(`expected success, got refusal: ${result.refusal}`)
  expect(result.status).toBe('Disabled 12 rows in "Browser"')
  const byItem = new Map(result.records.map((record) => [record.item, record]))
  for (const item of browserTools()) {
    expect(byItem.get(item.id)?.state).toBe("off")
  }
  // Nothing outside Browser is touched, and no section or permission rows are.
  expect([...byItem.keys()]).toHaveLength(12)
  expect(result.records.every((record) => record.section === null)).toBe(true)
})

test("toggleGroup turns a mixed Browser on and skips protected rows by name", () => {
  const input = {
    items: browserItems(),
    records: [...browserTools().filter((item) => item.id !== "tool:browser-preview").map((item) => onRecord(item.id)), offRecord("tool:browser-preview")],
    agents: agents(),
  }
  const result = toggleGroup(input, BROWSER)
  if ("refusal" in result) throw new Error(`expected success, got refusal: ${result.refusal}`)
  expect(result.status).toBe('Enabled 12 rows in "Browser"')
  expect(result.records.every((record) => record.state === "on")).toBe(true)

  const guarded = toggleGroup(input, BROWSER, undefined, undefined, (agent) => agent === "Implementer")
  expect("refusal" in guarded).toBe(true)
  if (!("refusal" in guarded)) throw new Error("expected a protected refusal")
  expect(guarded.refusal).toContain("click")
  expect(guarded.refusal).toContain("protected")
})

test("toggleGroup takes an explicit target state", () => {
  const input = { items: browserItems(), records: [], agents: agents() }
  const result = toggleGroup(input, BROWSER, undefined, false)
  if ("refusal" in result) throw new Error(`expected success, got refusal: ${result.refusal}`)
  expect(result.records.every((record) => record.state === "off")).toBe(true)
})

test("toggleGroup refuses models and teams groups", () => {
  const input = { items: browserItems(), records: [], agents: agents() }
  const models = toggleGroup(input, "group:project:Implementer:models")
  expect("refusal" in models).toBe(true)
  const teams = toggleGroup(
    { ...input, teams: [{ level: "project", team: "crew", enabled: true, agents: [] }] },
    "group:project:teams",
  )
  expect("refusal" in teams).toBe(true)
  if (!("refusal" in teams)) throw new Error("expected a teams refusal")
  expect(teams.refusal).toContain("teams")
  expect(toggleGroup(input, "group:project:Implementer:tools")).not.toHaveProperty("refusal")
})

test("toggleGroup skips a protected agent and names it", () => {
  const owned: AgentSource[] = [
    { id: "alpha", scope: "project", origin: "user" },
    { id: "beta", scope: "project", origin: "user" },
  ]
  // Snapshots always carry the shared Enabled control; without it no agent
  // row resolves (the same path single-row `toggle` takes).
  const enabled = makeItem({ id: "setting:enabled", kind: "setting", group: "none", title: "Enabled", text: "" })
  const result = toggleGroup({ items: [enabled], records: [], agents: owned }, "group:project:agents", undefined, undefined, (agent) => agent === "alpha")
  if ("refusal" in result) throw new Error(`expected partial success, got refusal: ${result.refusal}`)
  expect(result.status).toBe('Disabled 1 row in "Agents" (skipped: "alpha" — protected)')
  expect(result.records.map((record) => record.agent)).toEqual(["beta"])
})

// ---- TUI -------------------------------------------------------------------

function routeItem(id: string, title: string, namespace: string) {
  return { id, kind: "tool" as const, group: "native" as const, title, text: "default text", enabled: true, fingerprint: "fp", codemode: true, namespace }
}

function routeSnapshot(records: CustomizationRecord[] = []) {
  return createSnapshot({
    agents: [{ id: "Implementer", scope: "project" as const, fileBacked: true, origin: "user" as const }],
    items: [
      ...["preview", "navigate", "click", "fill", "screenshot", "console"].map((name) => routeItem(`tool:browser-${name}`, name, "browser")),
      ...["cpu", "files", "heap", "network", "tabs", "trace"].map((sub) => routeItem(`tool:browser-${sub}-x`, `${sub}-x`, `browser.${sub}`)),
      routeItem("tool:image", "image", "image"),
    ],
    records: records as never[],
  })
}

test("space on the Browser group toggles its rows and the footer offers toggle", async () => {
  const fixture = await renderInstructionsRoute({ snapshots: [routeSnapshot()], width: 160, height: 40 })
  try {
    await reach(fixture, BROWSER, "Browser")
    expect(footer(fixture.captureCharFrame())).toContain("toggle")
    dispatch(fixture, "space")
    await fixture.waitForFrame((frame) => frame.includes('Enabled 12 rows in "Browser"'))
    expect(fixture.fake.mutateInputs).toHaveLength(1)
    const records = fixture.fake.mutateInputs[0]!.records
    expect(records).toHaveLength(12)
    expect(records.every((record) => record.type === "customization" && record.state === "on")).toBe(true)
  } finally {
    fixture.destroy()
  }
})

test("a mixed Browser group shows its n/m summary", async () => {
  const ids = [
    ...["preview", "navigate", "click", "fill", "screenshot", "console"].map((name) => `tool:browser-${name}`),
    ...["cpu", "files", "heap", "network", "tabs", "trace"].map((sub) => `tool:browser-${sub}-x`),
  ]
  const snapshot = routeSnapshot([
    ...ids.filter((id) => id !== "tool:browser-preview").map((id) => ({ ...offRecord(id), agent: "Implementer", state: "on" as const })),
    offRecord("tool:browser-preview"),
  ])
  const fixture = await renderInstructionsRoute({ snapshots: [snapshot], width: 160, height: 40 })
  try {
    await reach(fixture, BROWSER, "Browser")
    expect(selectedRow(fixture.captureCharFrame())).toContain("11/12")
  } finally {
    fixture.destroy()
  }
})

// ---- agent tool ------------------------------------------------------------

function toolContext(): Tool.Context {
  return {
    sessionID: Session.ID.make("ses_browser_group_test"),
    agent: Agent.ID.make("alpha"),
    messageID: SessionMessage.ID.make("msg_browser_group_test"),
    id: Tool.CallID.make("call_browser_group_test"),
    progress: () => Effect.void,
  }
}

async function readTools(ctx: Context): Promise<Map<string, Tool.Info & { readonly id: string }>> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const deferred = yield* Deferred.make<readonly (Tool.Info & { readonly id: string })[], never>()
        yield* ctx.tool.transform((editor) => {
          Deferred.doneUnsafe(deferred, Effect.succeed([...editor.list()]))
        })
        const list = yield* Deferred.await(deferred)
        return new Map(list.map((tool) => [tool.id, tool]))
      }),
    ),
  )
}

async function runOk(tool: Tool.Info & { readonly id: string }, input: unknown): Promise<{ status: string }> {
  const outcome = await Effect.runPromise(
    tool.execute(input, toolContext()).pipe(
      Effect.map((result) => ({ ok: true as const, result })),
      Effect.catchTag("Tool.Error", (error) => Effect.succeed({ ok: false as const, error })),
    ),
  )
  if (!outcome.ok) throw new Error(`expected tool success, got error: ${outcome.error.message}`)
  return (outcome.result as { output: { status: string } }).output
}

test("instructions_set on a group id applies the explicit state", async () => {
  const ctx = fullContext({
    directory: "/tmp/browser-group-tool",
    agents: [agentInfo("alpha", "upstream role")],
    tools: [
      ...["preview", "navigate"].map((name) => ({ id: name, description: `${name} tool`, options: { codemode: true, namespace: "browser" } })),
      { id: "cpu-prof", description: "cpu tool", options: { codemode: true, namespace: "browser.cpu" } },
    ],
    session: { hook: () => Effect.succeed({ dispose: Effect.void }) },
  })
  const api: PlusApi = createPlusApi(ctx, createState())
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)
  const set = tools.get("instructions_set")
  if (set === undefined) throw new Error("missing instructions_set")
  const groupId = "group:defaults:alpha:tools:native:codemode:browser"
  const output = await runOk(set, { id: groupId, state: "off" })
  expect(output.status).toBe('Disabled 3 rows in "Browser"')
  const after = await api.snapshot()
  if (!after.ok) throw new Error("snapshot failed")
  const customs = after.value.records.filter((record) => record.type === "customization")
  // The three tool rows went off; their permission rows are untouched.
  expect(customs.filter((record) => record.state === "off").map((record) => record.item).sort()).toEqual(
    ["tool:browser_cpu_cpu-prof", "tool:browser_navigate", "tool:browser_preview"].sort(),
  )
  expect(customs.some((record) => record.item.startsWith("perm:"))).toBe(false)
})

test("a category toggles whole rows only: Role/persona sections stay untouched", () => {
  const items = [
    makeItem({ id: "system:role", kind: "system", title: "Role", text: "# Voice\nBe brief.\n\n# Duties\nReview code.", agents: ["Implementer"] }),
    makeItem({ id: "system:rules", kind: "system", title: "Rules", agents: ["Implementer"] }),
  ]
  const input = { items, records: [], agents: agents() }
  const nodes = expandAll(input)
  const system = nodes.find((node) => node.kind === "group" && node.label === "System" && node.id.includes("Implementer"))
  if (system === undefined) throw new Error("no System group for Implementer")
  // The Role/persona sections are toggleable on their own, but not rows of the category.
  expect(nodes.some((node) => node.kind === "section" && node.actions?.toggle === true)).toBe(true)
  const result = toggleGroup(input, system.id)
  if ("refusal" in result) throw new Error(`expected success, got refusal: ${result.refusal}`)
  expect(result.records.map((record) => [record.item, record.section, record.state])).toEqual([["system:rules", null, "off"]])
})
