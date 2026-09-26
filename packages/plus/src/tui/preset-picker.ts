import type { Plugin } from "@opencode/plugin/tui"
import { presetKey } from "../instructions/model.js"
import { listingOfSnapshot } from "../instructions/snapshot.js"
import type { PresetListEntry, PresetRef, Snapshot } from "../rpc.js"

const none = "__none__"

export interface AgentPresetPick {
  /** Dialog title; "Preset" in the create flows. */
  readonly title?: string
  /** The owner's current link, preselected (relink). */
  readonly current?: PresetRef
  /** The last option: "None — everything off" when creating, "None — unlink" when relinking. */
  readonly none?: string
}

// DESIGN §5's preset step, grouped: Agent presets (OpenCode, Plus, User), Team
// preset members (`<team> › <member>`), then the None option. Undefined =
// cancelled, null = None.
export async function pickAgentPreset(
  context: Plugin.Context,
  snapshot: Snapshot,
  pick: AgentPresetPick = {},
): Promise<PresetRef | null | undefined> {
  const choices = listingOfSnapshot(snapshot).filter((entry) => entry.ref.kind !== "team")
  const picked = await context.ui.dialog.select<string>({
    title: pick.title ?? "Preset",
    placeholder: pick.current === undefined ? "Create from a preset" : "Follow a preset live",
    ...(pick.current === undefined ? {} : { current: presetKey(pick.current) }),
    options: [
      ...choices.map((entry) => ({
        title: entry.label,
        value: presetKey(entry.ref),
        category: agentCategory(entry),
        ...(entry.description === undefined || entry.description === "" ? {} : { description: entry.description }),
      })),
      { title: pick.none ?? "None — everything off", value: none },
    ],
  })
  if (picked === undefined) return undefined
  if (picked === none) return null
  return choices.find((entry) => presetKey(entry.ref) === picked)?.ref
}

export interface TeamPresetPick {
  readonly title?: string
  /** The team's current team preset id, preselected (relink). */
  readonly current?: string
  /** "Empty team" when creating, "None — unlink" when relinking. */
  readonly none?: string
}

// A team preset, grouped Plus / User; "" = the None option (an empty
// team, or unlink). Undefined = cancelled.
export async function pickTeamPreset(context: Plugin.Context, snapshot: Snapshot, pick: TeamPresetPick = {}): Promise<string | undefined> {
  const teams = listingOfSnapshot(snapshot).filter((entry) => entry.ref.kind === "team" && entry.origin !== "native")
  return context.ui.dialog.select<string>({
    title: pick.title ?? "Team preset",
    placeholder: pick.current === undefined ? "Create from a team preset" : "Follow a team preset live",
    ...(pick.current === undefined ? {} : { current: pick.current }),
    options: [
      ...teams.map((entry) => ({ title: entry.label, value: entry.ref.id, category: originLabel(entry.origin) })),
      { title: pick.none ?? "Empty team", value: "" },
    ],
  })
}

export function originLabel(origin: "native" | "plus" | "user"): string {
  if (origin === "native") return "OpenCode"
  if (origin === "plus") return "Plus"
  return "User"
}

/** "Orchestrator (Plus)" for a preset the snapshot lists, else its key. */
export function presetName(snapshot: Snapshot, ref: PresetRef): string {
  const entry = listingOfSnapshot(snapshot).find((candidate) => presetKey(candidate.ref) === presetKey(ref))
  return entry === undefined ? presetKey(ref) : `${entry.label} (${originLabel(entry.origin)})`
}

function agentCategory(entry: PresetListEntry): string {
  if (entry.ref.kind === "member") return "Team preset members"
  return `Agent presets · ${originLabel(entry.origin)}`
}
