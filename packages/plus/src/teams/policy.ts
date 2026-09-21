// Team role policy: the DATA a role's rules are made of, and nothing else.
//
// This file states the ceiling and the native answers; it never writes them
// onto an agent and never decides tool visibility. `instructions/team-policy-rows.ts`
// turns both into ordinary instructions rows and `instructions/apply.ts`
// installs whatever those rows resolve to, so a project or global override
// changes the answer with no code path here involved.
export type Kind = "planner" | "orchestrator" | "implementer" | "reviewer" | "scout"

const kindByRole: Record<string, Kind> = {
  "fable-planner": "planner",
  "astra-planner": "planner",
  "sol-orchestrator": "orchestrator",
  "opus-orchestrator": "orchestrator",
  "muse-implementer": "implementer",
  "gemini-implementer": "implementer",
  "spark-implementer": "implementer",
  "opus-implementer": "implementer",
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

// The team namespace advertises only tools that work. Every name here has a
// real handler in `teams/api.ts`; a tool with no implementation is absent, not
// registered-and-failing. Web and code search are not team tools at all: they
// come from the `search` MCP server, narrowed per role by a policy row.
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

export const teamTools = [...directTools, ...codeTools] as const
export type TeamTool = (typeof teamTools)[number]

// Hard ceiling in code per docs/team-v2/03-tools.md §Mode summary. Policy
// may only narrow this; attempts to widen are rejected by the caller.
export function toolsByServer(kind: Kind): { direct: string[]; code: string[] } {
  if (kind === "planner")
    return {
      direct: ["delegate", "followup", "supersede", "stop", "finish"],
      code: ["status", "diff", "list", "wait", "get_context"],
    }
  if (kind === "orchestrator")
    return {
      direct: ["delegate", "followup", "integrate", "checkpoint", "set_checks", "supersede", "stop", "finish"],
      code: ["status", "diff", "list", "wait", "get_context", "check"],
    }
  if (kind === "implementer")
    return {
      direct: ["checkpoint", "finish"],
      code: ["status", "diff", "get_context", "check"],
    }
  if (kind === "reviewer")
    return {
      direct: ["finish"],
      code: ["status", "diff", "get_context"],
    }
  return {
    direct: ["finish"],
    code: ["status", "diff", "get_context"],
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

// The role's native answers, as data. Per-run edit scope is absent here
// because it is not a property of the role: it comes from the run record and
// becomes its own run-scoped row in the same producer.
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
