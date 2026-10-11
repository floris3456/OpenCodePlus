import { fingerprint, type CustomizationRecord, type Item } from "./model.js"

export const toolModes = ["direct", "codemode"] as const
export type ToolMode = (typeof toolModes)[number]

export function toolModeItem(tool: Item): Item {
  const text = tool.codemode === true ? "codemode" : "direct"
  return {
    id: `toolmode:${tool.id.slice("tool:".length)}`,
    kind: "setting",
    group: "none",
    title: "Exposure",
    text,
    fingerprint: fingerprint(text),
    enabled: true,
  }
}

export function toolModeError(record: Pick<CustomizationRecord, "item" | "section" | "text" | "state" | "pin">): string | undefined {
  if (!record.item.startsWith("toolmode:")) return undefined
  if (record.item === "toolmode:execute") return "The host-owned execute entry point cannot change exposure"
  if (record.section !== null || record.state !== undefined || record.pin !== undefined) return "Tool exposure accepts a mode, not sections, on/off state or pins"
  if (record.text !== undefined && !toolModes.some((mode) => mode === record.text)) return "Tool exposure must be direct or codemode"
  return undefined
}
