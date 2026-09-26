// The team namespace's tool lists: the data every team row is keyed by, and
// nothing else. What a member may do with them is its rows' answer
// (instructions/permission-catalog.ts and team-policy-rows.ts), resolved like
// every other row; nothing here reads a member's id.
export type Reach = "descendants" | "others"

// The team namespace advertises only tools that work. Every name here has a
// real handler in `teams/api.ts`; a tool with no implementation is absent, not
// registered-and-failing. Web and code search are not team tools at all: they
// come from the `search` MCP server, whose tool rows say who may use them.
// Direct tools are native (`codemode: false`); code tools reach the model
// through the Code Mode catalog.
export const directTools = [
  "delegate",
  "finish",
  "followup",
  "integrate",
  "checkpoint",
  "set_checks",
  "supersede",
  "stop",
] as const

export const codeTools = ["status", "wait", "get_context", "diff", "list", "check"] as const

export const toolSurfaces = {
  direct: directTools.map((name) => `team_${name}`),
  codeMode: codeTools.map((name) => `tools.team.${name}`),
}

export const toolGuidance =
  `Direct native tools: ${toolSurfaces.direct.join(", ")}. Call them directly; Code Mode search does not list them.\n` +
  `Code Mode tools: ${toolSurfaces.codeMode.join(", ")}. Discover their signatures with search, then call them inside execute.\n` +
  "Call get_context first. Its delegationTargets lists the current permitted member IDs for role; choose from that roster, not persona names in preset examples. An empty roster permits no delegation. Tool permissions and admission checks still apply."

export const teamTools = [...directTools, ...codeTools] as const
export type TeamTool = (typeof teamTools)[number]

// Tools whose runs a member addresses by id, and so carry Runs rows.
export const reachTools: readonly TeamTool[] = ["followup", "stop", "supersede", "status", "wait", "diff", "list"]
