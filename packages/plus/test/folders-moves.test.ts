// Folders and moves (plus-1.2.0 S1a): the tree arranges a tab by its folders and
// order records, the planners move rows and folders within their tab, and the
// instruction tools write each change as one layout write. These tests use the
// real tree builder, the real planners and the real store.
import { afterEach, expect, test } from "bun:test"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { Deferred, Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { FolderRecord, OrderRecord } from "../src/instructions/folders.js"
import type { AgentSource, Item } from "../src/instructions/model.js"
import { fingerprint } from "../src/instructions/model.js"
import {
  planFolderCreate,
  planFolderDelete,
  planFolderRename,
  planRowMove,
  type LayoutChange,
  type LayoutRecords,
} from "../src/instructions/ops.js"
import { memoInputOf } from "../src/instructions/snapshot.js"
import { expandedTree, tree, type MemoInput, type TreeInput, type TreeNode } from "../src/instructions/tree.js"
import { createPlusApi, createState, type PlusApi } from "../src/index.js"
import { registerInstructionTools } from "../src/tools.js"
import { agentInfo, fullContext } from "./harness.js"

const roots: string[] = []
const priorConfigDir = process.env.OPENCODE_CONFIG_DIR

afterEach(async () => {
  if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

const UPDATED = "2026-01-01T00:00:00.000Z"
const TOOLS = "group:project:Implementer:tools"
const NATIVE = `${TOOLS}:native`
const row = (item: string) => `item:project:Implementer:${item}`
const folderRow = (id: string) => `${TOOLS}:folder:${id}`

function item(overrides: Partial<Item> & Pick<Item, "id" | "kind" | "title">): Item {
  const text = overrides.text ?? "default text"
  return { group: "native", text, enabled: true, fingerprint: fingerprint(text), ...overrides }
}

function items(): Item[] {
  return [
    item({ id: "tool:bash", kind: "tool", title: "bash" }),
    item({ id: "tool:reader", kind: "tool", title: "reader", text: "# Reader\nintro\n## Details\nd\n" }),
    item({ id: "tool:skill", kind: "tool", title: "skill" }),
    item({ id: "base:gpt", kind: "base", group: "none", title: "gpt.txt", text: "gpt base" }),
    item({ id: "system:role", kind: "system", group: "none", title: "Role", text: "# Purpose\np\n" }),
  ]
}

function agents(): AgentSource[] {
  return [{ id: "Implementer", scope: "project", origin: "user" }]
}

function folder(id: string, name: string, folderItems: readonly string[], parent?: string): FolderRecord {
  return {
    type: "folder",
    level: "global",
    tab: id.split(":")[0] ?? "tools",
    id,
    name,
    items: folderItems,
    updated: UPDATED,
    ...(parent === undefined ? {} : { parent }),
  }
}

function order(scope: string, orderItems: readonly string[]): OrderRecord {
  return { type: "order", level: "global", scope, items: orderItems, updated: UPDATED }
}

function memoOf(folders: readonly FolderRecord[], orders: readonly OrderRecord[] = []): MemoInput {
  return { items: items(), records: [], agents: agents(), folders, orders }
}

function expandAll(input: MemoInput): TreeNode[] {
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
  const depth = nodes[index]?.depth ?? 0
  const out: TreeNode[] = []
  for (const node of nodes.slice(index + 1)) {
    if (node.depth <= depth) break
    if (node.depth === depth + 1) out.push(node)
  }
  return out
}

function layoutOf(folders: readonly FolderRecord[], orders: readonly OrderRecord[] = []): LayoutRecords {
  return { folders, orders }
}

function refusalOf(change: LayoutChange): string | undefined {
  return "refusal" in change ? change.refusal : undefined
}

function planned(change: LayoutChange): LayoutRecords {
  if ("refusal" in change) throw new Error(`expected a plan, got refusal: ${change.refusal}`)
  return change.layout
}

test("a folder lists its rows in items order, and the rows leave their home position", () => {
  const nodes = expandAll(memoOf([folder("tools:mine", "Mine", ["tool:reader", "tool:bash"])]))
  expect(childrenOf(nodes, folderRow("tools:mine")).map((node) => node.id)).toEqual([
    row("tool:reader"),
    row("tool:bash"),
  ])
  expect(childrenOf(nodes, NATIVE).some((node) => node.id === row("tool:reader") || node.id === row("tool:bash"))).toBe(
    false,
  )
})

test("folders nest: a child folder lists inside its parent with its own rows", () => {
  const nodes = expandAll(
    memoOf([
      folder("tools:outer", "Outer", ["folder:tools:inner", "tool:bash"]),
      folder("tools:inner", "Inner", ["tool:reader"], "tools:outer"),
    ]),
  )
  expect(childrenOf(nodes, folderRow("tools:outer")).map((node) => node.id)).toEqual([
    folderRow("tools:inner"),
    row("tool:bash"),
  ])
  expect(childrenOf(nodes, folderRow("tools:inner")).map((node) => node.id)).toEqual([row("tool:reader")])
})

test("a tab's order record sets its top level, and unknown ids are ignored", () => {
  const nodes = expandAll(
    memoOf(
      [folder("tools:mine", "Mine", ["tool:reader", "tool:gone"])],
      [order("tab:tools", ["folder:tools:mine", "tool:nothing"])],
    ),
  )
  const top = childrenOf(nodes, TOOLS).map((node) => node.id)
  expect(top[0]).toBe(folderRow("tools:mine"))
  expect(childrenOf(nodes, folderRow("tools:mine")).map((node) => node.id)).toEqual([row("tool:reader")])
})

test("a row moves into a folder, out of it, and before or after a sibling in the same folder", () => {
  const mine = folder("tools:mine", "Mine", ["tool:reader"])
  const into = planRowMove(memoOf([mine]), layoutOf([mine]), row("tool:bash"), { into: "folder:tools:mine" }, UPDATED)
  expect(planned(into).folders[0]?.items).toEqual(["tool:reader", "tool:bash"])

  const out = planRowMove(memoOf([mine]), layoutOf([mine]), row("tool:reader"), { into: "tab:tools" }, UPDATED)
  expect(planned(out).folders[0]?.items).toEqual([])

  const both = folder("tools:mine", "Mine", ["tool:reader", "tool:bash"])
  const before = planRowMove(
    memoOf([both]),
    layoutOf([both]),
    row("tool:bash"),
    { before: row("tool:reader") },
    UPDATED,
  )
  expect(planned(before).folders[0]?.items).toEqual(["tool:bash", "tool:reader"])
  const after = planRowMove(memoOf([both]), layoutOf([both]), row("tool:reader"), { after: row("tool:bash") }, UPDATED)
  expect(planned(after).folders[0]?.items).toEqual(["tool:bash", "tool:reader"])
})

test("a folder moves into another folder of its tab, and is reparented there", () => {
  const mine = folder("tools:mine", "Mine", [])
  const other = folder("tools:other", "Other", [])
  const orders = [order("tab:tools", ["folder:tools:mine", "folder:tools:other"])]
  const change = planRowMove(
    memoOf([mine, other], orders),
    layoutOf([mine, other], orders),
    folderRow("tools:mine"),
    { into: "folder:tools:other" },
    UPDATED,
  )
  const next = planned(change)
  expect(next.folders.find((record) => record.id === "tools:other")?.items).toEqual(["folder:tools:mine"])
  expect(next.folders.find((record) => record.id === "tools:mine")?.parent).toBe("tools:other")
})

test("moves are refused across tabs, into a folder's own descendant, and for built-in structure", () => {
  const outer = folder("tools:outer", "Outer", ["folder:tools:inner"])
  const inner = folder("tools:inner", "Inner", [], "tools:outer")
  const notes = folder("system:notes", "Notes", [])
  const folders = [outer, inner, notes]
  const memo = memoOf(folders)
  const layout = layoutOf(folders)
  expect(refusalOf(planRowMove(memo, layout, row("tool:bash"), { into: "folder:system:notes" }, UPDATED))).toContain(
    "only within tools",
  )
  expect(
    refusalOf(planRowMove(memo, layout, folderRow("tools:outer"), { into: "folder:tools:inner" }, UPDATED)),
  ).toContain("cannot move into itself")
  expect(refusalOf(planRowMove(memo, layout, TOOLS, { into: "folder:tools:inner" }, UPDATED))).toContain(
    "built-in structure",
  )
  expect(refusalOf(planRowMove(memo, layout, NATIVE, { into: "folder:tools:inner" }, UPDATED))).toContain(
    "built-in structure",
  )
})

test("a row whose home is an origin group cannot be placed beside a sibling at the tab's top level", () => {
  const mine = folder("tools:mine", "Mine", ["tool:reader"])
  const beside = planRowMove(
    memoOf([mine]),
    layoutOf([mine]),
    row("tool:reader"),
    { before: folderRow("tools:mine") },
    UPDATED,
  )
  expect(refusalOf(beside)).toContain("origin group")
  const top = planRowMove(
    memoOf([mine]),
    layoutOf([mine]),
    row("tool:reader"),
    { into: "tab:tools", after: folderRow("tools:mine") },
    UPDATED,
  )
  expect(refusalOf(top)).toContain("origin group")
})

test("folders are created at a tab's top level or inside a folder, renamed and deleted in place", () => {
  const created = planFolderCreate(memoOf([]), layoutOf([]), TOOLS, "Mine", UPDATED)
  expect("target" in created && created.target).toBe("folder:tools:mine")
  const top = planned(created)
  expect(top.orders.find((record) => record.scope === "tab:tools")?.items).toEqual(["folder:tools:mine"])

  const nested = planFolderCreate(memoOf(top.folders, top.orders), top, folderRow("tools:mine"), "Inner", UPDATED)
  const deep = planned(nested)
  expect(deep.folders.find((record) => record.id === "tools:inner")?.parent).toBe("tools:mine")

  const renamed = planned(planFolderRename(deep, "tools:mine", "Renamed", UPDATED))
  expect(renamed.folders.find((record) => record.id === "tools:mine")?.name).toBe("Renamed")

  const before = layoutOf(
    [folder("tools:mine", "Mine", ["tool:reader"])],
    [order("tab:tools", ["tool:skill", "folder:tools:mine"])],
  )
  const deleted = planned(planFolderDelete(before, "tools:mine", UPDATED))
  expect(deleted.folders).toEqual([])
  expect(deleted.orders[0]?.items).toEqual(["tool:skill", "tool:reader"])
})

test("the instruction tools create, move, rename and delete a folder through the store", async () => {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-folders-tools-"))
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
  const nodesNow = async () => {
    const envelope = await api.snapshot()
    if (!envelope.ok) throw new Error("snapshot failed")
    return { nodes: expandedTree(memoInputOf(envelope.value)), snapshot: envelope.value }
  }

  // The fixture's agent is an upstream (Defaults) agent, so its rows are owned by defaults:Implementer.
  const toolsTab = "group:defaults:Implementer:tools"
  const owned = (item: string) => `item:defaults:Implementer:${item}`
  const ownedFolder = (id: string) => `${toolsTab}:folder:${id}`
  const created = (await runOk(need("instructions_create"), { kind: "folder", name: "Mine", id: toolsTab })) as {
    id: string
  }
  expect(created.id).toBe("folder:tools:mine")

  const moved = (await runOk(need("instructions_move"), { id: owned("tool:reader"), into: "folder:tools:mine" })) as {
    status: string
  }
  expect(moved.status).toContain("Mine")
  expect(childrenOf((await nodesNow()).nodes, ownedFolder("tools:mine")).map((node) => node.id)).toEqual([
    owned("tool:reader"),
  ])

  await expect(
    Effect.runPromise(
      need("instructions_move").execute({ id: owned("tool:reader"), into: "system:none" }, toolContext()),
    ),
  ).rejects.toThrow()

  await runOk(need("instructions_set"), { id: ownedFolder("tools:mine"), rename: "Gear" })
  expect((await nodesNow()).snapshot.folders?.map((record) => record.name)).toEqual(["Gear"])

  await runOk(need("instructions_delete"), { id: "folder:tools:mine", confirm: true })
  const after = await nodesNow()
  expect(after.snapshot.folders ?? []).toEqual([])
  expect(childrenOf(after.nodes, `${toolsTab}:native`).some((node) => node.id === owned("tool:reader"))).toBe(true)
})

function toolContext(): Tool.Context {
  return {
    sessionID: Session.ID.make("ses_folders_test"),
    agent: Agent.ID.make("Implementer"),
    messageID: SessionMessage.ID.make("msg_folders_test"),
    id: Tool.CallID.make("call_folders_test"),
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
