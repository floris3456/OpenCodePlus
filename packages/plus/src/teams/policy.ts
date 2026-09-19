// Team role policy ported from scripts/team2/agent-policy.ts.
//
// Hard ceiling per docs/team-v2/03-tools.md §Mode summary "Registration per
// role" table. Policy may only narrow this ceiling; the built-in team emits a
// deny for every team tool outside it. Static denies mirror the reference
// nativePermissions without per-run edit scope (a later permission hook owns
// assigned-path edit allows, so none are emitted here).
export type Kind = "planner" | "orchestrator" | "implementer" | "reviewer" | "scout"

const kindByRole: Record<string, Kind> = {
  "fable-planner": "planner",
  "astra-planner": "planner",
  "sol-orchestrator": "orchestrator",
  "opus-orchestrator": "orchestrator",
  "muse-implementer": "implementer",
  "gemini-implementer": "implementer",
  "spark-implementer": "implementer",
  "astra-reviewer": "reviewer",
  scout: "scout",
}

// Boundary validation owns the unknown-role check once; callers pass the
// unwrapped Kind inward. Unknown roles are a typed failure, never a throw.
export function kindOf(role: string): { ok: true; kind: Kind } | { ok: false; reason: string } {
  if (role === "planner" || role === "orchestrator" || role === "implementer" || role === "reviewer" || role === "scout")
    return { ok: true, kind: role }
  const kind = kindByRole[role]
  if (kind === undefined) return { ok: false, reason: `Unknown role "${role}"` }
  return { ok: true, kind }
}

// v2 tool set per docs/team-v2/03-tools.md §Mode summary. Direct tools live
// on MCP server `team`; code tools live on MCP server `team-query`.
export const directTools = [
  "delegate",
  "finish",
  "followup",
  "review",
  "integrate",
  "checkpoint",
  "set_checks",
  "supersede",
  "shutdown_request",
  "stop",
  "resume",
  "prepare",
  "plan_handoff",
] as const

export const codeTools = [
  "status",
  "wait",
  "get_context",
  "diff",
  "list",
  "check",
  "metrics",
  "exa_code_search",
  "tavily_search",
  "tavily_extract",
] as const

export const teamTools = [...directTools, ...codeTools] as const
export type TeamTool = (typeof teamTools)[number]

// Hard ceiling in code per docs/team-v2/03-tools.md §Mode summary. Policy
// may only narrow this; attempts to widen are rejected by the caller.
export function toolsByServer(kind: Kind): { direct: string[]; code: string[] } {
  if (kind === "planner")
    return {
      direct: ["plan_handoff", "delegate", "followup", "supersede", "shutdown_request", "stop", "resume", "finish"],
      code: ["status", "diff", "list", "wait", "get_context", "metrics", "tavily_search", "tavily_extract", "exa_code_search"],
    }
  if (kind === "orchestrator")
    // checkpoint stays in the ceiling so policy can enable it; the default
    // path leaves it denied through the ceiling rule.
    return {
      direct: [
        "delegate",
        "followup",
        "review",
        "integrate",
        "checkpoint",
        "set_checks",
        "supersede",
        "shutdown_request",
        "stop",
        "resume",
        "prepare",
        "finish",
      ],
      code: ["status", "diff", "list", "wait", "get_context", "check", "metrics", "exa_code_search"],
    }
  if (kind === "implementer")
    return {
      direct: ["checkpoint", "prepare", "finish"],
      code: ["status", "diff", "get_context", "check", "exa_code_search"],
    }
  if (kind === "reviewer")
    return {
      direct: ["finish"],
      code: ["status", "diff", "get_context", "exa_code_search"],
    }
  return {
    direct: ["finish"],
    code: ["status", "diff", "get_context", "exa_code_search"],
  }
}

export function allowedTeamTools(kind: Kind): readonly TeamTool[] {
  const ceiling = toolsByServer(kind)
  return [...ceiling.direct, ...ceiling.code] as TeamTool[]
}

export interface PolicyPermission {
  readonly action: string
  readonly resource: string
  readonly effect: "allow" | "deny" | "ask"
}

// Static agent permission rules. Edit scope is intentionally absent: assigned
// paths are granted per run by a later permission hook, never here.
export function nativePermissions(kind: Kind): readonly PolicyPermission[] {
  // Implementers are denied rather than asked because a headless ask never
  // returns and the child blocks silently with no pending permission entry.
  const shell = kind === "orchestrator" ? "allow" : "deny"
  const external = kind === "planner" || kind === "orchestrator" ? "allow" : "deny"
  const question = kind === "planner" ? "allow" : "deny"
  return [
    { action: "read", resource: "*.key", effect: "deny" },
    { action: "read", resource: "*.env*", effect: "deny" },
    { action: "read", resource: "*/auth.json", effect: "deny" },
    { action: "subagent", resource: "*", effect: "deny" },
    { action: "task", resource: "*", effect: "deny" },
    { action: "question", resource: "*", effect: question },
    { action: "shell", resource: "*", effect: shell },
    { action: "external_directory", resource: "*", effect: external },
  ]
}
