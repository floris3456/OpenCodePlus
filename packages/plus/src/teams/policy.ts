// The team namespace's tool lists: the data every team row is keyed by, and
// nothing else. What a member may do with them is its rows' answer
// (instructions/permission-catalog.ts and team-policy-rows.ts), resolved like
// every other row; nothing here reads a member's id.
export type Reach = "descendants" | "others"

// The team namespace advertises only tools that work. Every name here has a
// real handler in `teams/api.ts`; a tool with no implementation is absent, not
// registered-and-failing. Web and code search are not team tools at all: they
// come from the `search` MCP server, whose tool rows say who may use them.
//
// Every team tool is direct (`codemode: false`). The read tools (status,
// get_context, diff, list, check) were Code Mode ones; models called them by
// their direct names anyway (3 of 20 such calls in five live runs failed so), and a
// member has at most a dozen, so the catalog saved nothing worth that. A level
// can still move one into Code Mode with its Exposure row.
export const teamTools = [
  "delegate",
  "finish",
  "followup",
  "integrate",
  "checkpoint",
  "stop",
  "status",
  "get_context",
  "diff",
  "list",
  "check",
] as const
export type TeamTool = (typeof teamTools)[number]

// Tools whose runs a member addresses by id, and so carry Runs rows.
export const reachTools: readonly TeamTool[] = ["followup", "stop", "status", "diff", "list"]
