// Every Models tab and Defaults › Models list their model rows in built-in
// groups: one per provider, and in it one per AI lab, read from the model's
// display name or else its id (model-labs.ts). These tests use the real tree
// builder, layout planner, query engine and workspace slicer.
import { expect, test } from "bun:test"
import { tabOfGroupId, type FolderRecord } from "../src/instructions/folders.js"
import { modelLab, modelLabGroupId, modelProviderGroupId, parseModelGroupId } from "../src/instructions/model-labs.js"
import { MODELS_GROUP_ID, type HostModel } from "../src/instructions/model-settings.js"
import type { AgentSource, ModelRecord } from "../src/instructions/model.js"
import { planRowMove } from "../src/instructions/ops.js"
import { matchedTree, query } from "../src/instructions/query.js"
import { buildTreeMemo, expandedTree, lazyPath, tree, type MemoInput, type TreeNode } from "../src/instructions/tree.js"
import { structureDetail } from "../src/tui/instructions/descriptions.js"
import { CATEGORY, workspaceOf, type WorkspaceInput } from "../src/tui/instructions/workspace.js"

const UPDATED = "2026-01-01T00:00:00.000Z"
const TAB = "group:project:alpha:models"

// The live catalogue as CLIProxyAPI, LithosAI, OpenCode and OpenCode Go list it
// (provider/model, with the display name where it differs from the id).
const LIVE: readonly (readonly [model: string, name: string | undefined, lab: string])[] = [
  ["cliproxyapi/Grok 4.6", undefined, "Grok"],
  ["cliproxyapi/Qwen/Qwen3.8-27B", undefined, "Qwen"],
  ["cliproxyapi/Qwen3.6-35B-A3B-NInfer-MTP3", undefined, "Qwen"],
  ["cliproxyapi/Qwen3.8-27B-Swift15-Uncensored-NInfer", undefined, "Qwen"],
  ["cliproxyapi/claude-fable-5-1", undefined, "Claude"],
  ["cliproxyapi/claude-haiku-5-5", undefined, "Claude"],
  ["cliproxyapi/claude-opus-4-6", undefined, "Claude"],
  ["cliproxyapi/claude-opus-5-5", undefined, "Claude"],
  ["cliproxyapi/claude-sonnet-4-6", "Claude Sonnet 4.6 (Thinking)", "Claude"],
  ["cliproxyapi/claude-sonnet-5-5", undefined, "Claude"],
  ["cliproxyapi/codex-auto-review", "Codex Auto Review", "ChatGPT"],
  ["cliproxyapi/commandcode/deepseek/deepseek-v4.1-flash", undefined, "DeepSeek"],
  ["cliproxyapi/deepseek-v4.1-flash-cheap", undefined, "DeepSeek"],
  ["cliproxyapi/gemini-3.1-flash-lite", undefined, "Gemini"],
  ["cliproxyapi/gemini-3.8-flash-high", undefined, "Gemini"],
  ["cliproxyapi/gemini-opus-4-6-thinking", "Claude Opus 4.6 (Thinking)", "Claude"],
  ["cliproxyapi/gemini-oss-120b-medium", "Gemini GPT-OSS 120B (Medium)", "ChatGPT"],
  ["cliproxyapi/gemini-sonnet-5-5-high", undefined, "Claude"],
  ["cliproxyapi/gpt-5.3-codex-spark", undefined, "ChatGPT"],
  ["cliproxyapi/gpt-5.6-luna", undefined, "ChatGPT"],
  ["cliproxyapi/gpt-5.6-sol", undefined, "ChatGPT"],
  ["cliproxyapi/gpt-6-astra", undefined, "ChatGPT"],
  ["cliproxyapi/gpt-6-astra-fast", undefined, "ChatGPT"],
  ["cliproxyapi/gpt-6-luna", undefined, "ChatGPT"],
  ["cliproxyapi/gpt-6-sol", undefined, "ChatGPT"],
  ["cliproxyapi/gpt-6.1-sol", undefined, "ChatGPT"],
  ["cliproxyapi/gpt-image-2", undefined, "ChatGPT"],
  ["cliproxyapi/llmfan46/Qwen3.8-27B-Ultra-Uncensored-Heretic-Native-MTP-Preserved-NVFP4", undefined, "Qwen"],
  ["cliproxyapi/opencode-go/deepseek-flash", undefined, "DeepSeek"],
  ["cliproxyapi/opencode-go/glm-5.3-flash", undefined, "GLM"],
  ["cliproxyapi/opencode-go/kimi-k3.1-pro", undefined, "Kimi"],
  ["cliproxyapi/opencode-go/minimax-m3.1-flash", undefined, "MiniMax"],
  ["lithosai/deepseek-ai/DeepSeek-V4.1-Flash", undefined, "DeepSeek"],
  ["opencode/beam-free", undefined, "Other"],
  ["opencode/big-pickle", undefined, "Other"],
  ["opencode/deepseek-v4.1-flash-free", undefined, "DeepSeek"],
  ["opencode/flint-40b-free", undefined, "Other"],
  ["opencode/glm-5.3-flash-free", undefined, "GLM"],
  ["opencode/mimo-v2.6-flash-free", undefined, "MiMo"],
  ["opencode/muse-spark-1.3-contributor-free", undefined, "Meta"],
  ["opencode/nemotron-3-ultra-free", undefined, "Nemotron"],
  ["opencode/nemotron-3.5-lightning-free", undefined, "Nemotron"],
  ["opencode/nemotron-3.5-super-vl-free", undefined, "Nemotron"],
  ["opencode-go/beam-free", undefined, "Other"],
  ["opencode-go/claude-haiku-5-5", undefined, "Claude"],
  ["opencode-go/deepseek-v4-pro", undefined, "DeepSeek"],
  ["opencode-go/deepseek-v4.1-flash", undefined, "DeepSeek"],
  ["opencode-go/gemini-4-argon", undefined, "Gemini"],
  ["opencode-go/glm-5.2", undefined, "GLM"],
  ["opencode-go/glm-5.3", undefined, "GLM"],
  ["opencode-go/glm-5.3-flash", undefined, "GLM"],
  ["opencode-go/gpt-5.6-luna", undefined, "ChatGPT"],
  ["opencode-go/gpt-6-luna", undefined, "ChatGPT"],
  ["opencode-go/grok-4.7", undefined, "Grok"],
  ["opencode-go/hy3", undefined, "Hunyuan"],
  ["opencode-go/hy4-preview", undefined, "Hunyuan"],
  ["opencode-go/iceman-contributor-free", undefined, "Other"],
  ["opencode-go/kimi-k2.7-code", undefined, "Kimi"],
  ["opencode-go/kimi-k3", undefined, "Kimi"],
  ["opencode-go/kimi-k3.1-pro", undefined, "Kimi"],
  ["opencode-go/longcat-2.0", "LongCat", "LongCat"],
  ["opencode-go/mimo-v2.5", undefined, "MiMo"],
  ["opencode-go/mimo-v2.5-pro", undefined, "MiMo"],
  ["opencode-go/mimo-v2.6-flash", undefined, "MiMo"],
  ["opencode-go/mimo-v2.6-pro", undefined, "MiMo"],
  ["opencode-go/minimax-m3", undefined, "MiniMax"],
  ["opencode-go/minimax-m3.1-flash", undefined, "MiniMax"],
  ["opencode-go/muse-spark-1.2-contributor", undefined, "Meta"],
  ["opencode-go/muse-spark-1.3-contributor", undefined, "Meta"],
  ["opencode-go/qwen3.7-plus", undefined, "Qwen"],
  ["opencode-go/qwen3.8-flash", undefined, "Qwen"],
  ["opencode-go/qwen3.8-max", undefined, "Qwen"],
  ["opencode-go/step-5-preview", "Step", "Step"],
]

const modelOf = (model: string) => ({
  providerID: model.slice(0, model.indexOf("/")),
  modelID: model.slice(model.indexOf("/") + 1),
})

test("every live model lands in the lab its display name, else its id, names", () => {
  const labs = LIVE.map(([model, name]) => [model, modelLab(modelOf(model).modelID, name)])
  expect(labs).toEqual(LIVE.map(([model, , lab]) => [model, lab]))
})

test("Claude and ChatGPT words win over a gemini- id; o-series, Llama and Mistral names have their labs", () => {
  // Without a display name the id alone still places CLIProxyAPI's gemini- aliases.
  expect(modelLab("gemini-opus-4-6-thinking", undefined)).toBe("Claude")
  expect(modelLab("gemini-oss-120b-medium", undefined)).toBe("ChatGPT")
  expect(modelLab("o3-mini", undefined)).toBe("ChatGPT")
  expect(modelLab("o4-mini-high", "OpenAI o4 mini")).toBe("ChatGPT")
  expect(modelLab("meta-llama/Llama-3.3-70B-Instruct", undefined)).toBe("Meta")
  expect(modelLab("nvidia/llama-3.1-nemotron-70b", undefined)).toBe("Nemotron")
  expect(modelLab("mistral-large-latest", undefined)).toBe("Mistral")
  expect(modelLab("google/gemma-3-27b", undefined)).toBe("Gemini")
  // A name that names no lab leaves the decision to the id.
  expect(modelLab("glm-5.3", "Zeta Flash")).toBe("GLM")
  // A lab's word inside a longer word is not that lab.
  expect(modelLab("pongrokit", undefined)).toBe("Other")
})

test("provider and lab group ids round-trip any provider id and never read as a tab", () => {
  for (const providerID of [
    "cliproxyapi",
    "opencode-go",
    "my provider",
    "org/sub",
    "host:8080",
    "a,b",
    "models",
    "tools",
    "system",
  ]) {
    const provider = modelProviderGroupId(TAB, providerID)
    const lab = modelLabGroupId(provider, "ChatGPT")
    expect(lab).toBe(`${provider}:lab=chatgpt`)
    expect(parseModelGroupId(provider)).toEqual({ models: TAB, providerID })
    expect(parseModelGroupId(lab)).toEqual({ models: TAB, providerID, lab: "chatgpt" })
    for (const id of [provider, lab]) {
      expect(id.slice(TAB.length + 1)).not.toMatch(/[:/ ,](?!lab=)/)
      expect(tabOfGroupId(id)).toBeUndefined()
      expect(CATEGORY.test(id)).toBe(false)
    }
  }
  expect(modelProviderGroupId(TAB, "cliproxyapi")).toBe(`${TAB}:provider=cliproxyapi`)
  expect(parseModelGroupId(TAB)).toBeUndefined()
  expect(tabOfGroupId(TAB)).toBe("models")
  expect(parseModelGroupId(`${MODELS_GROUP_ID}:provider=opencode:lab=other`)).toEqual({
    models: MODELS_GROUP_ID,
    providerID: "opencode",
    lab: "other",
  })
  expect(parseModelGroupId("group:project:alpha:tools:provider=opencode")).toBeUndefined()
})

const agents: AgentSource[] = [
  { id: "alpha", scope: "project", origin: "user", model: { providerID: "cliproxyapi", modelID: "claude-opus-5-5" } },
]

const hostModels: HostModel[] = [
  { providerID: "cliproxyapi", modelID: "gemini-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)", variants: [] },
  { providerID: "cliproxyapi", modelID: "gemini-oss-120b-medium", name: "Gemini GPT-OSS 120B (Medium)", variants: [] },
  { providerID: "cliproxyapi", modelID: "gemini-3.1-flash-lite", variants: [] },
  { providerID: "lithosai", modelID: "deepseek-ai/DeepSeek-V4.1-Flash", variants: [] },
  { providerID: "opencode", modelID: "big-pickle", variants: [] },
  { providerID: "opencode-go", modelID: "kimi-k3", variants: [] },
]

function model(providerID: string, modelID: string, overrides: Partial<ModelRecord> = {}): ModelRecord {
  return { type: "model", level: "project", agent: "alpha", providerID, modelID, updated: UPDATED, ...overrides }
}

// alpha's own rows, beside its upstream cliproxyapi/claude-opus-5-5.
const records: ModelRecord[] = [
  model("opencode-go", "glm-5.3", { active: true }),
  model("opencode-go", "kimi-k3"),
  model("cliproxyapi", "gpt-6-sol"),
  model("cliproxyapi", "gemini-opus-4-6-thinking"),
  model("cliproxyapi", "flint-40b"),
  model("opencode", "big-pickle"),
]

function input(extra: Partial<MemoInput> = {}): MemoInput {
  return { items: [], records, agents, hostModels, ...extra }
}

function childrenOf(nodes: readonly TreeNode[], id: string): TreeNode[] {
  const index = nodes.findIndex((node) => node.id === id)
  if (index === -1) throw new Error(`missing ${id}`)
  const depth = nodes[index]!.depth
  const out: TreeNode[] = []
  for (const node of nodes.slice(index + 1)) {
    if (node.depth <= depth) break
    if (node.depth === depth + 1) out.push(node)
  }
  return out
}

const provider = (id: string) => modelProviderGroupId(TAB, id)
const lab = (providerID: string, label: string) => modelLabGroupId(provider(providerID), label)
const row = (model: string) => `item:project:alpha:model:${model}`

test("an agent's Models tab holds provider groups, each holding lab groups, each holding the rows in their order", () => {
  const nodes = expandedTree(input())
  const tab = nodes.find((node) => node.id === TAB)!
  expect(childrenOf(nodes, TAB).map((node) => [node.id, node.label, node.depth])).toEqual([
    [provider("cliproxyapi"), "cliproxyapi", tab.depth + 1],
    [provider("opencode"), "opencode", tab.depth + 1],
    [provider("opencode-go"), "opencode-go", tab.depth + 1],
  ])
  expect(childrenOf(nodes, provider("cliproxyapi")).map((node) => [node.id, node.label, node.depth])).toEqual([
    [lab("cliproxyapi", "ChatGPT"), "ChatGPT", tab.depth + 2],
    [lab("cliproxyapi", "Claude"), "Claude", tab.depth + 2],
    [lab("cliproxyapi", "Other"), "Other", tab.depth + 2],
  ])
  // The display name puts gemini-opus-4-6-thinking with the upstream Claude row.
  expect(childrenOf(nodes, lab("cliproxyapi", "Claude")).map((node) => [node.id, node.depth])).toEqual([
    [row("cliproxyapi/claude-opus-5-5"), tab.depth + 3],
    [row("cliproxyapi/gemini-opus-4-6-thinking"), tab.depth + 3],
  ])
  expect(childrenOf(nodes, lab("cliproxyapi", "Other")).map((node) => node.id)).toEqual([row("cliproxyapi/flint-40b")])
  expect(childrenOf(nodes, provider("opencode-go")).map((node) => node.label)).toEqual(["GLM", "Kimi"])
  // The groups are built-in headings: no address, no actions, no switch.
  for (const id of [provider("cliproxyapi"), lab("cliproxyapi", "Claude")]) {
    const group = nodes.find((node) => node.id === id)!
    expect(group.kind).toBe("group")
    expect(group.address).toBeUndefined()
    expect(group.add).toBeUndefined()
    expect(group.actions).toEqual({ toggle: false, edit: false, reset: false, remove: false, split: false, pin: false })
  }
  // The rows keep their ids, addresses, actions and badges; only their depth changed.
  const active = nodes.find((node) => node.id === row("opencode-go/glm-5.3"))!
  expect(active.address).toEqual({ level: "project", agent: "alpha", item: "model:opencode-go/glm-5.3", section: null })
  expect(active.badges.active).toBe(true)
  expect(active.actions).toMatchObject({ toggle: true, edit: false, remove: true, split: false, pin: false })
  expect(nodes.find((node) => node.id === row("cliproxyapi/claude-opus-5-5"))?.badges.source).toBe("upstream")
  // A model row's fields sit right under it.
  expect(childrenOf(nodes, row("opencode-go/glm-5.3")).map((node) => [node.label, node.depth])).toEqual([
    ["Model", tab.depth + 4],
    ["Effort", tab.depth + 4],
    ["Warming", tab.depth + 4],
    ["Compaction", tab.depth + 4],
    ["Images", tab.depth + 4],
  ])
})

test("a row to review counts on its lab, its provider and the tab", () => {
  const nodes = expandedTree(
    input({
      records: [
        model("opencode-go", "glm-5.3", { active: true, basedOn: "acme/old" }),
        model("opencode", "big-pickle"),
      ],
    }),
  )
  const reviewed = nodes.find((node) => node.id === row("opencode-go/glm-5.3"))!
  expect(reviewed.badges.review).toBe(true)
  for (const id of [lab("opencode-go", "GLM"), provider("opencode-go"), TAB])
    expect(nodes.find((node) => node.id === id)?.badges.reviewCount).toBe(1)
  expect(nodes.find((node) => node.id === provider("opencode"))?.badges.reviewCount).toBe(0)
})

test("Defaults › Models lists Every model first, then the catalogue by provider and lab", () => {
  const nodes = expandedTree(input())
  expect(childrenOf(nodes, MODELS_GROUP_ID).map((node) => [node.id, node.depth])).toEqual([
    ["item:defaults:/models:modeldefault:*", 2],
    [`${MODELS_GROUP_ID}:provider=cliproxyapi`, 2],
    [`${MODELS_GROUP_ID}:provider=lithosai`, 2],
    [`${MODELS_GROUP_ID}:provider=opencode`, 2],
    [`${MODELS_GROUP_ID}:provider=opencode-go`, 2],
  ])
  expect(childrenOf(nodes, `${MODELS_GROUP_ID}:provider=cliproxyapi`).map((node) => node.label)).toEqual([
    "ChatGPT",
    "Claude",
    "Gemini",
    "Other",
  ])
  // gemini-oss-120b-medium is OpenAI's open-weight model by its display name.
  expect(childrenOf(nodes, `${MODELS_GROUP_ID}:provider=cliproxyapi:lab=chatgpt`).map((node) => node.id)).toEqual([
    "item:defaults:/models:modeldefault:cliproxyapi/gemini-oss-120b-medium",
    "item:defaults:/models:modeldefault:cliproxyapi/gpt-6-sol",
  ])
  expect(childrenOf(nodes, `${MODELS_GROUP_ID}:provider=lithosai`).map((node) => node.label)).toEqual(["DeepSeek"])
  const claude = childrenOf(nodes, `${MODELS_GROUP_ID}:provider=cliproxyapi:lab=claude`)
  expect(claude.map((node) => [node.id, node.depth])).toEqual([
    ["item:defaults:/models:modeldefault:cliproxyapi/claude-opus-5-5", 4],
    ["item:defaults:/models:modeldefault:cliproxyapi/gemini-opus-4-6-thinking", 4],
  ])
  // A Defaults › Models row and its fields keep their ids and open one level deeper each.
  expect(childrenOf(nodes, claude[1]!.id).map((node) => [node.label, node.depth])).toEqual([
    ["Effort", 5],
    ["Warming", 5],
    ["Compaction", 5],
    ["Images", 5],
  ])
  expect(
    childrenOf(nodes, "group:defaults:/models:modeldefault:cliproxyapi/gemini-opus-4-6-thinking:warming")[0],
  ).toMatchObject({
    id: "item:defaults:/models:modelsetting:warming:cliproxyapi/gemini-opus-4-6-thinking",
    depth: 6,
  })
  expect(childrenOf(nodes, "item:defaults:/models:modeldefault:*").map((node) => [node.label, node.depth])).toEqual([
    ["Effort", 3],
    ["Warming", 3],
    ["Compaction", 3],
    ["Images", 3],
  ])
  expect(structureDetail(nodes.find((node) => node.id === `${MODELS_GROUP_ID}:provider=cliproxyapi:lab=claude`)!)).toBe(
    "Claude models served by cliproxyapi: the lab is read from each model's display name, else its id.",
  )
})

const folder: FolderRecord = {
  type: "folder",
  level: "project",
  owner: TAB,
  tab: "models",
  id: `${TAB}:mine`,
  name: "Mine",
  items: ["model:opencode-go/kimi-k3", "model:opencode/big-pickle"],
  updated: UPDATED,
}

test("a folder takes its model rows out of their groups, and a group left empty is not shown", () => {
  const nodes = expandedTree(input({ folders: [folder] }))
  const tab = nodes.find((node) => node.id === TAB)!
  // The opencode provider held only big-pickle; opencode-go keeps GLM, not Kimi.
  expect(childrenOf(nodes, TAB).map((node) => node.id)).toEqual([
    `${TAB}:folder:${TAB}:mine`,
    provider("cliproxyapi"),
    provider("opencode-go"),
  ])
  expect(childrenOf(nodes, provider("opencode-go")).map((node) => node.label)).toEqual(["GLM"])
  expect(childrenOf(nodes, `${TAB}:folder:${TAB}:mine`).map((node) => [node.id, node.depth])).toEqual([
    [row("opencode-go/kimi-k3"), tab.depth + 2],
    [row("opencode/big-pickle"), tab.depth + 2],
  ])
  expect(childrenOf(nodes, row("opencode-go/kimi-k3"))[0]).toMatchObject({ label: "Model", depth: tab.depth + 3 })
  expect(nodes.filter((node) => node.id === row("opencode-go/kimi-k3"))).toHaveLength(1)
  expect(nodes.some((node) => node.id === provider("opencode") || node.id === lab("opencode-go", "Kimi"))).toBe(false)
})

test("a model row moves from its lab group into a folder, and back out to its group", () => {
  const empty = { ...folder, items: [] }
  const into = planRowMove(
    input({ folders: [empty] }),
    { folders: [empty], orders: [] },
    row("opencode-go/kimi-k3"),
    { into: `folder:${TAB}:mine` },
    UPDATED,
  )
  if ("refusal" in into) throw new Error(into.refusal)
  expect(into.layout.folders.find((entry) => entry.id === `${TAB}:mine`)?.items).toEqual(["model:opencode-go/kimi-k3"])
  const moved = expandedTree(input(into.layout))
  expect(childrenOf(moved, `${TAB}:folder:${TAB}:mine`).map((node) => node.id)).toEqual([row("opencode-go/kimi-k3")])
  const out = planRowMove(input(into.layout), into.layout, row("opencode-go/kimi-k3"), { into: "tab:models" }, UPDATED)
  if ("refusal" in out) throw new Error(out.refusal)
  expect(childrenOf(expandedTree(input(out.layout)), lab("opencode-go", "Kimi")).map((node) => node.id)).toEqual([
    row("opencode-go/kimi-k3"),
  ])
})

test("find lists the provider and lab groups, and the path and filter reach a row inside them", () => {
  const groups = query(input(), { where: `type:group in:${TAB}`, fields: ["id"], limit: 100 }).rows.map(
    (entry) => entry.id,
  )
  expect(groups.filter((id) => parseModelGroupId(id) !== undefined)).toEqual([
    provider("cliproxyapi"),
    lab("cliproxyapi", "ChatGPT"),
    lab("cliproxyapi", "Claude"),
    lab("cliproxyapi", "Other"),
    provider("opencode"),
    lab("opencode", "Other"),
    provider("opencode-go"),
    lab("opencode-go", "GLM"),
    lab("opencode-go", "Kimi"),
  ])
  expect(
    query(input(), { where: `in:${lab("opencode-go", "Kimi")}`, fields: ["id"] }).rows.map((entry) => entry.id),
  ).toContain(row("opencode-go/kimi-k3"))
  expect(
    lazyPath(buildTreeMemo(input()), row("opencode-go/kimi-k3"))
      .map((node) => node.id)
      .slice(-4),
  ).toEqual([TAB, provider("opencode-go"), lab("opencode-go", "Kimi"), row("opencode-go/kimi-k3")])
  const filtered = matchedTree(input(), "kimi-k3")
  expect(filtered.matched).toContain(row("opencode-go/kimi-k3"))
  const ids = filtered.rows.map((node) => node.id)
  expect(ids.slice(ids.indexOf(TAB), ids.indexOf(row("opencode-go/kimi-k3")) + 1)).toEqual([
    TAB,
    provider("opencode-go"),
    lab("opencode-go", "Kimi"),
    row("opencode-go/kimi-k3"),
  ])
})

test("the Models list opens its provider groups as headings and a lab group on request", () => {
  const rows = (open: ReadonlySet<string>) => tree({ ...input(), expanded: open })
  const base: WorkspaceInput = {
    rows,
    level: "project",
    navCollapsed: new Set(),
    listOpen: new Set(),
    listCollapsed: new Set(),
    owner: "agent:project:alpha",
    category: TAB,
  }
  const closed = workspaceOf(base)
  expect(closed.category?.id).toBe(TAB)
  expect(closed.list.map((entry) => [entry.label, entry.depth, entry.expanded])).toEqual([
    ["cliproxyapi", 0, true],
    ["ChatGPT", 1, false],
    ["Claude", 1, false],
    ["Other", 1, false],
    ["opencode", 0, true],
    ["Other", 1, false],
    ["opencode-go", 0, true],
    ["GLM", 1, false],
    ["Kimi", 1, false],
  ])
  const open = workspaceOf({ ...base, listOpen: new Set([lab("opencode-go", "Kimi")]) })
  expect(open.list.slice(-2).map((entry) => [entry.label, entry.depth, entry.role])).toEqual([
    ["Kimi", 1, "group"],
    ["opencode-go/kimi-k3", 2, "item"],
  ])
  const defaults = workspaceOf({
    ...base,
    level: "defaults",
    owner: `${MODELS_GROUP_ID}#models`,
    category: MODELS_GROUP_ID,
  })
  expect(defaults.list.filter((entry) => entry.depth === 0).map((entry) => entry.label)).toEqual([
    "Every model",
    "cliproxyapi",
    "lithosai",
    "opencode",
    "opencode-go",
  ])
})
