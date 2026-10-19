// The order of an agent's system prompt parts. A slot is one movable position
// in the request's system array: the first part (Role/persona, or the base
// prompt it replaces), the model prompts, each of OpenCode's own parts, and
// each Plus System row.
// The System list shows the slots in the order the model receives them, and an
// order stored for a System group (a layout OrderRecord whose items are slot
// ids) reorders the request the same way. With no stored order nothing moves.
import path from "node:path"
import { groupScope, orderOf, ownerGroupIds, type OrderRecord } from "./folders.js"
import type { ChainNode, Item } from "./model.js"
import { guidanceItemId, guidancePath, isModelPromptFile, isUserSystemFile, teachingFilePath, teachingItemId } from "./paths.js"

export const firstSlot = "first"

/** The model prompts (System › Model prompts): one slot, right after the base prompt unless moved. */
export const modelPromptsSlot = "model-prompts"

export const modelPromptMoveRefusal = `A model prompt does not move on its own: move "Model prompts" to move them all`

/** OpenCode's own parts, in the order the request carries them: the rows the System list shows for them. */
export const opencodeParts = [
  { name: "identity", slot: "core/identity", title: "Your model", text: "OpenCode names the model this request goes to: its name, provider ID and model ID." },
  { name: "codemode", slot: "core/codemode", title: "Code Mode", text: "OpenCode explains how to call tools through `execute` and lists the Code Mode tools this agent can reach." },
  { name: "mcp", slot: "core/mcp-guidance", title: "MCP servers", text: "OpenCode passes on the instructions of the MCP servers this agent can use." },
  { name: "references", slot: "core/reference-guidance", title: "References", text: "OpenCode lists the project references this session can read." },
  { name: "skills", slot: "core/skill-guidance", title: "Skills", text: "OpenCode lists the skills this agent may load, with their descriptions." },
  { name: "agents-md", slot: "core/instructions", title: "AGENTS.md files", text: "OpenCode adds the AGENTS.md files it finds globally and up the project tree, one part per file. Open this row to see each file by its path from here, and switch it off or edit it for this agent." },
  { name: "date", slot: "core/date", title: "Date", text: "OpenCode adds today's date." },
  { name: "environment", slot: "core/environment", title: "Environment", text: "OpenCode describes where it runs: the working directory, the workspace root, whether it is a git repository, and the platform." },
  { name: "entries", slot: "api", title: "Session entries", text: "OpenCode adds the instructions a client attached to this session." },
  { name: "tools-note", slot: "core/tools-note", title: "Worktree note", text: "OpenCode reminds the model to move the session into a worktree it created and wants to work in." },
] as const

export function opencodePartItemId(name: string): string {
  return `system:opencode/${name}`
}

// The tool definitions are a request field of their own, outside the system
// array, and Anthropic's API reads them before the whole system prompt. Their
// row heads every System list and is no slot: no stored order can move it.
export const toolsPart = {
  name: "tools",
  slot: "tools",
  title: "Tools",
  text: "OpenCode sends the definitions of the tools this agent calls directly (with Code Mode on, `execute` among them): each tool's name, description and parameters. They are a field of the request of their own, not part of the system prompt. Claude receives them before the whole system prompt, so this row stays first and doesn't move; other providers place them themselves. The tools reached through Code Mode are listed in the Code Mode part instead. Switch tools on or off in the Tools category.",
} as const

export const toolsItemId = opencodePartItemId(toolsPart.name)

export const agentsMdItemId = opencodePartItemId("agents-md")

/** A model prompt row (`system:model/<id>`). */
export function isModelPrompt(item: string): boolean {
  return item.startsWith("system:model/")
}

/** An AGENTS.md file row (`system:<relative path>`); System row ids are slugs, which never hold a dot. */
export function isAgentsFile(item: string): boolean {
  return item.startsWith("system:") && path.basename(item.slice("system:".length)) === "AGENTS.md"
}

export const agentsFileMoveRefusal = `An AGENTS.md file keeps core's order (the global file, then nearest to farthest); move "AGENTS.md files" to move them all`

export const toolsMoveRefusal = `"Tools" always comes first: the model receives the tool definitions before the whole system prompt, so nothing moves above them`

const coreSlots: readonly string[] = opencodeParts.map((part) => part.slot)

/** The default order: exactly the order the request carries the parts in when nothing is stored. */
export function defaultSystemOrder(userRows: readonly string[]): string[] {
  // The OpenCodePlus teaching file reaches core as the last discovered instruction file.
  const files = coreSlots.indexOf("core/instructions") + 1
  return [firstSlot, modelPromptsSlot, ...coreSlots.slice(0, files), teachingItemId, ...coreSlots.slice(files), guidanceItemId, ...userRows]
}

/** A slot id: the first part, the model prompts, one of OpenCode's parts, or a Plus System row (`system:<id>`). */
export function isSlot(id: string): boolean {
  if (id === firstSlot || id === modelPromptsSlot || coreSlots.includes(id)) return true
  return /^system:[a-z0-9][a-z0-9-]*$/.test(id) && id !== "system:role"
}

/** The slot an item row stands for in the System list; undefined for rows outside it. */
export function slotOfItem(item: Pick<Item, "id" | "kind" | "opencodePart" | "userSystem" | "models">): string | undefined {
  if (item.kind === "base" || item.id === "system:role") return firstSlot
  if (item.kind !== "system") return undefined
  if (item.models !== undefined) return modelPromptsSlot
  if (item.opencodePart === toolsPart.slot) return undefined
  if (item.opencodePart !== undefined) return item.opencodePart
  if (item.id === teachingItemId || item.id === guidanceItemId || item.userSystem === true) return item.id
  // An instruction file row (`system:<path>`) edits one of the AGENTS.md parts.
  return "core/instructions"
}

interface PartLike {
  readonly metadata?: Readonly<Record<string, unknown>>
}

/**
 * The slot of one part of a request's system array. The part at index 0 is
 * the first slot whatever it carries; the rest are told apart by the
 * `metadata.instruction` key and path core and Plus give them. A part none of
 * them names (a third-party plugin's) has no slot.
 */
export function slotOfPart(part: PartLike, index: number): string | undefined {
  if (index === 0) return firstSlot
  const instruction = part.metadata?.["instruction"] as { readonly key?: unknown; readonly path?: unknown } | undefined
  const file = typeof instruction?.path === "string" ? instruction.path : undefined
  const key = typeof instruction?.key === "string" ? instruction.key : undefined
  if (file === teachingFilePath()) return teachingItemId
  if (file === guidancePath()) return guidanceItemId
  if (file !== undefined && isModelPromptFile(file)) return modelPromptsSlot
  if (file !== undefined && isUserSystemFile(file)) return `system:${path.basename(file, ".md")}`
  // A file part without a key is an instruction file row Plus planned in.
  if (key === undefined) return file === undefined ? undefined : "core/instructions"
  if (key.startsWith("core/instructions")) return "core/instructions"
  if (key.startsWith("api/")) return "api"
  return coreSlots.includes(key) ? key : undefined
}

/**
 * `listed` with every slot of `defaults` it lacks put back where the default
 * order places it: right after its nearest default predecessor that is
 * listed, or first when none is. A stored order written before a System row
 * existed so takes the new row in its default place.
 */
export function completeOrder(listed: readonly string[], defaults: readonly string[]): string[] {
  return defaults
    .filter((slot) => !listed.includes(slot))
    .reduce((order, slot) => {
      const before = defaults.slice(0, defaults.indexOf(slot)).findLast((candidate) => order.includes(candidate))
      const at = before === undefined ? 0 : order.indexOf(before) + 1
      return [...order.slice(0, at), slot, ...order.slice(at)]
    }, [...new Set(listed)])
}

/**
 * The parts in `order`. Parts that share a slot keep their relative order,
 * and a part without a slot travels right after the part before it. A slot
 * `order` does not name keeps its place relative to its neighbours.
 */
export function arrangeBySlot<T>(parts: readonly T[], slotOf: (part: T, index: number) => string | undefined, order: readonly string[]): T[] {
  const units = parts.reduce<{ readonly slot: string; readonly parts: readonly T[] }[]>((list, part, index) => {
    const slot = slotOf(part, index)
    const last = list.at(-1)
    if (slot === undefined && last !== undefined) return [...list.slice(0, -1), { slot: last.slot, parts: [...last.parts, part] }]
    return [...list, { slot: slot ?? firstSlot, parts: [part] }]
  }, [])
  const complete = completeOrder(order, [...new Set(units.map((unit) => unit.slot))])
  return complete.flatMap((slot) => units.filter((unit) => unit.slot === slot).flatMap((unit) => unit.parts))
}

/** The slots of the first System order stored along the chain; undefined when none is (the default order). */
export function storedSystemOrder(orders: readonly OrderRecord[], chain: readonly ChainNode[]): readonly string[] | undefined {
  return chain
    .flatMap((node) => ownerGroupIds(node, "system"))
    .map((id) => orderOf(orders, groupScope(id))?.items.filter(isSlot) ?? [])
    .find((items) => items.length > 0)
}

/** A stored order made complete for the System rows `items` holds; undefined when nothing is stored. */
export function effectiveSystemOrder(stored: readonly string[] | undefined, items: readonly Item[]): string[] | undefined {
  if (stored === undefined) return undefined
  return completeOrder(stored, defaultSystemOrder(userSystemRows(items)))
}

/** The user-created System rows' slots, in item order (model prompts share theirs). */
export function userSystemRows(items: readonly Item[]): string[] {
  return [...new Set(items.filter((item) => item.kind === "system" && item.userSystem === true && item.models === undefined).map((item) => item.id))]
}
