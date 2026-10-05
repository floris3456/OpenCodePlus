// User categories (plan plus-1.1.12 T8): a global, revisioned record kind whose
// assignments are keyed by item id and move a whole row (with its children)
// under a user tab in every owner. These tests exercise the real store, the
// real tree/workspace builders and the real instruction tools.
import { afterEach, expect, test } from "bun:test"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { Deferred, Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { AgentSource, Item } from "../src/instructions/model.js"
import { fingerprint } from "../src/instructions/model.js"
import {
  categorySlug,
  createCategoryRecord,
  deleteCategoryRecord,
  type CategoryRecord,
} from "../src/instructions/categories.js"
import { query } from "../src/instructions/query.js"
import { memoInputOf } from "../src/instructions/snapshot.js"
import { expandedTree, tree, type TreeInput, type TreeNode } from "../src/instructions/tree.js"
import { load, save } from "../src/instructions/store.js"
import { createPlusApi, createState, type PlusApi } from "../src/index.js"
import { registerInstructionTools } from "../src/tools.js"
import { workspaceOf } from "../src/tui/instructions/workspace.js"
import { agentInfo, fullContext } from "./harness.js"
import type { Context } from "@opencode/plugin/effect/plugin"

const roots: string[] = []
const priorConfigDir = process.env.OPENCODE_CONFIG_DIR
const priorDataHome = process.env.XDG_DATA_HOME

afterEach(async () => {
  if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
  if (priorDataHome === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = priorDataHome
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

const UPDATED = "2026-01-01T00:00:00.000Z"

function item(overrides: Partial<Item> & Pick<Item, "id" | "kind" | "title">): Item {
  const text = overrides.text ?? "default text"
  return {
    group: "native",
    text,
    enabled: true,
    fingerprint: fingerprint(text),
    ...overrides,
  }
}

function items(): Item[] {
  return [
    item({ id: "tool:bash", kind: "tool", title: "bash" }),
    item({ id: "tool:reader", kind: "tool", title: "reader", text: "# Reader\nintro\n## Details\nd\n" }),
    item({ id: "tool:skill", kind: "tool", title: "skill" }),
    item({ id: "base:gpt", kind: "base", group: "none", title: "gpt.txt", text: "gpt base" }),
    item({ id: "system:role", kind: "system", group: "none", title: "Role", text: "# Purpose\np\n" }),
    item({ id: "mcp:sample", kind: "mcp", group: "none", title: "sample" }),
  ]
}

function agents(): AgentSource[] {
  return [{ id: "Implementer", scope: "project", origin: "user" }]
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

function categoryRecords(name: string, items: readonly string[]): CategoryRecord[] {
  return createCategoryRecord([], name, UPDATED).map((record) => ({ ...record, items: [...items] }))
}

test("a category record round-trips through the global store", async () => {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-categories-store-"))
  roots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  const project = path.join(root, "project")
  const record: CategoryRecord = {
    type: "category",
    level: "global",
    name: "Mine",
    order: 3,
    items: ["tool:bash", "system:role"],
    updated: UPDATED,
  }
  const before = await load(project)
  const saved = await save(project, {
    expectedProjectRevision: before.projectRevision,
    expectedGlobalRevision: before.globalRevision,
    records: [record],
  })
  expect(saved.ok).toBe(true)
  const loaded = await load(project)
  expect(loaded.records).toEqual([record])
  expect(loaded.globalRevision).toBe(1)
})

test("a row assigned to a category moves with its children and delete returns it home", () => {
  const records = categoryRecords("Mine", ["tool:reader"])
  const input = { items: items(), records: [], agents: agents(), categories: records }
  const nodes = expandAll(input)
  const agent = "agent:project:Implementer"
  expect(childrenOf(nodes, agent).map((node) => node.label)).toEqual([
    "Settings",
    "Models",
    "Compaction",
    "Tools",
    "Base",
    "System",
    "Mine",
  ])
  const categoryGroup = `group:project:Implementer:category:${categorySlug("Mine")}`
  const moved = nodes.find((node) => node.id === "item:project:Implementer:tool:reader")
  expect(moved).toBeDefined()
  expect(childrenOf(nodes, categoryGroup).map((node) => node.id)).toEqual(["item:project:Implementer:tool:reader"])
  // Its children (the Description group) come with it.
  expect(childrenOf(nodes, "item:project:Implementer:tool:reader").some((node) => node.label === "Description")).toBe(true)
  // And it left its home Tools subtree.
  expect(
    childrenOf(nodes, "group:project:Implementer:tools:native").some((node) => node.id === "item:project:Implementer:tool:reader"),
  ).toBe(false)

  const returned = expandAll({ ...input, categories: deleteCategoryRecord(records, "Mine") })
  expect(returned.some((node) => node.id === categoryGroup)).toBe(false)
  expect(
    childrenOf(returned, "group:project:Implementer:tools:native").some((node) => node.id === "item:project:Implementer:tool:reader"),
  ).toBe(true)
})

test("filter category:<name> lists the moved rows and no others", () => {
  const categories = categoryRecords("Mine", ["tool:reader"])
  const snapshot = { items: items(), records: [], agents: agents(), categories }
  const inMine = query(snapshot, { where: "category:Mine" })
  expect(inMine.rows.map((row) => row.id)).toContain("item:project:Implementer:tool:reader")
  // Assignments are global by item id, so every owner that lists the row
  // (the Native presets, Defaults inventories, the project agent) matches.
  expect(inMine.total).toBeGreaterThan(1)
  expect(query(snapshot, { where: "category:Other" }).total).toBe(0)
})

test("the workspace shows the user category tab and lists its rows", () => {
  const categories = categoryRecords("Mine", ["tool:reader"])
  const input = { items: items(), records: [], agents: agents(), categories }
  const rows = (open: ReadonlySet<string>): TreeNode[] => tree({ ...input, expanded: open })
  const workspace = workspaceOf({
    rows,
    level: "project",
    navCollapsed: new Set(),
    owner: "agent:project:Implementer",
    listOpen: new Set(),
    listCollapsed: new Set(),
  })
  expect(workspace.categories.map((category) => category.label)).toEqual([
    "Settings",
    "Models",
    "Compaction",
    "Tools",
    "Base",
    "System",
    "Mine",
  ])
  const mine = workspace.categories.find((category) => category.label === "Mine")
  expect(mine).toBeDefined()
  const selected = workspaceOf({
    rows,
    level: "project",
    navCollapsed: new Set(),
    owner: "agent:project:Implementer",
    category: mine!.id,
    listOpen: new Set(),
    listCollapsed: new Set(),
  })
  expect(selected.list.map((row) => row.node.id)).toContain("item:project:Implementer:tool:reader")
})

// ---- the instruction tools -------------------------------------------------

test("category create and rename refuse another category's row id without a write", async () => {
  const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "plus-category-identity-"))
  roots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  const project = path.join(root, "project")
  const api = createPlusApi(fullContext({ directory: project }), createState())
  const first = await api.category({ action: "create", name: "One Two" })
  expect(first.ok).toBe(true)
  const beforeCreate = await load(project)
  const duplicate = await api.category({ action: "create", name: "One-Two" })
  expect(duplicate.ok).toBe(false)
  if (!duplicate.ok) expect(duplicate.error.message).toContain("already exists")
  expect(await load(project)).toEqual(beforeCreate)

  const second = await api.category({ action: "create", name: "Other" })
  expect(second.ok).toBe(true)
  const beforeRename = await load(project)
  const collision = await api.category({ action: "rename", name: "Other", to: "One_Two" })
  expect(collision.ok).toBe(false)
  if (!collision.ok) expect(collision.error.message).toContain("already exists")
  expect(await load(project)).toEqual(beforeRename)

  // Renaming the same category's punctuation/case retains its unambiguous id.
  const renamed = await api.category({ action: "rename", name: "category:one-two", to: "ONE-TWO" })
  expect(renamed.ok).toBe(true)
  if (renamed.ok) expect(renamed.value.id).toBe("category:one-two")
  expect((await load(project)).records.filter((record) => record.type === "category").map((record) => record.name)).toEqual(["ONE-TWO", "Other"])
})

function toolContext(): Tool.Context {
  return {
    sessionID: Session.ID.make("ses_categories_test"),
    agent: Agent.ID.make("Implementer"),
    messageID: SessionMessage.ID.make("msg_categories_test"),
    id: Tool.CallID.make("call_categories_test"),
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

async function runOk(tool: Tool.Info & { readonly id: string }, input: unknown): Promise<unknown> {
  const outcome = await Effect.runPromise(
    tool.execute(input, toolContext()).pipe(
      Effect.map((result) => ({ ok: true as const, result })),
      Effect.catchTag("Tool.Error", (error) => Effect.succeed({ ok: false as const, error })),
    ),
  )
  if (!outcome.ok) throw new Error(`expected tool success, got error: ${outcome.error.message}`)
  return (outcome.result as { output: unknown }).output
}

test("tools create, set, list and delete a category", async () => {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-categories-tools-"))
  roots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  const project = path.join(root, "project")
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("Implementer", "upstream role")],
    tools: [{ id: "reader", description: "read things", options: { codemode: false } }],
    session: { hook: () => Effect.succeed({ dispose: Effect.void }) },
  })
  const api: PlusApi = createPlusApi(ctx, createState())
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)
  const need = (id: string) => {
    const tool = tools.get(id)
    if (tool === undefined) throw new Error(`missing tool ${id}`)
    return tool
  }

  const created = (await runOk(need("instructions_create"), { kind: "category", name: "Mine" })) as {
    id: string
    item: string
  }
  expect(created.id).toBe("category:mine")
  expect(created.item).toBe("Mine")

  const envelope = await api.snapshot()
  if (!envelope.ok) throw new Error("snapshot failed")
  const memo = memoInputOf(envelope.value)
  const row = expandedTree(memo).find(
    (node) => node.address?.item === "tool:reader" && node.address?.agent === "Implementer",
  )
  if (row === undefined) throw new Error("missing tool row")

  const moved = (await runOk(need("instructions_set"), { id: row.id, category: "Mine" })) as { status: string }
  expect(moved.status).toContain("Mine")

  const listed = (await runOk(need("instructions_list"), { where: "category:Mine", fields: ["id"] })) as {
    rows: { id: string }[]
    total: number
  }
  expect(listed.rows.map((entry) => entry.id)).toContain(row.id)
  // The assignment is global by item id: the row lists under Mine in every
  // owner where it appears, not only the one it was moved from.
  expect(listed.total).toBeGreaterThan(1)

  await runOk(need("instructions_delete"), { id: "category:mine", confirm: true })
  const after = (await runOk(need("instructions_list"), { where: "category:Mine" })) as { total: number }
  expect(after.total).toBe(0)
  const empty = await api.snapshot()
  if (!empty.ok) throw new Error("snapshot failed")
  expect(empty.value.categories ?? []).toEqual([])
})
