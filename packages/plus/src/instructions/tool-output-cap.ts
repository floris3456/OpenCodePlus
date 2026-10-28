// The per-agent cap on the text a tool result carries back, set by the
// `setting:tool-output` control row (agent-controls.ts).
//
// The value never reaches an agent field: it is Plus's own setting, resolved
// per agent (apply.ts toolOutputCapsOf) and handed to the execute.after hook
// (installToolOutputCap), which saves an oversized result to a file and leaves
// the model its head and where to read the rest.

/** A team member's cap when its row is empty: the owner's default. */
export const DEFAULT_MEMBER_CAP = 10_000
/** Below this a cap would mostly report itself; a smaller value is refused. */
export const MIN_TOOL_OUTPUT_CAP = 1_000

/** Validation at the shared mutation boundary (Tool and TUI both call it). */
export function toolOutputCapError(text: string): string | undefined {
  const value = text.trim()
  if (value === "" || value === "off") return undefined
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < MIN_TOOL_OUTPUT_CAP)
    return `Tool result cap must be an integer of at least ${MIN_TOOL_OUTPUT_CAP}, off, or empty (${DEFAULT_MEMBER_CAP} for team members, no cap otherwise)`
  return undefined
}

/**
 * The cap a row's text sets: a token count, or undefined for no cap. Empty
 * means the member default; on any other agent it means no cap. `off` is none.
 */
export function toolOutputCap(text: string, member: boolean): number | undefined {
  const value = text.trim()
  if (value === "off") return undefined
  if (value === "") return member ? DEFAULT_MEMBER_CAP : undefined
  const cap = Number(value)
  if (!Number.isSafeInteger(cap) || cap < MIN_TOOL_OUTPUT_CAP) return undefined
  return cap
}
