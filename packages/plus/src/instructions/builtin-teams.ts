// Shipped built-in teams: source data, not files on disk.
//
// `packages/plus/package.json` declares `"files": ["dist"]` and the build is
// plain `tsc`, so a markdown directory under `src/` would not be published
// and would break at runtime. Built-ins live here as exported source
// constants, following the `teaching.ts` pattern. They are read-only: no
// filesystem path, never written, never created or deleted. Enablement is a
// `TeamRecord` at level `defaults` routed to the global store.
//
// Placeholder product content: minimal, obvious, and easy to replace. Tests
// must not couple to this roster; behaviour tests supply fixture registries
// and only `builtin-teams.test.ts` asserts over the real one.
export interface BuiltinTeamMember {
  readonly id: string
  readonly body: string
}

export interface BuiltinTeam {
  readonly name: string
  readonly members: readonly BuiltinTeamMember[]
}

export const builtinTeams: readonly BuiltinTeam[] = [
  {
    name: "starter",
    members: [
      {
        id: "planner",
        body: "You are a planner. Break the task into small steps and list them before acting.",
      },
      {
        id: "helper",
        body: "You are a helper. Answer concisely and cite the files you read.",
      },
    ],
  },
  {
    name: "review",
    members: [
      {
        id: "reviewer",
        body: "You are a reviewer. Check the change for correctness and list issues first.",
      },
      {
        id: "editor",
        body: "You are an editor. Tighten the wording without changing the meaning.",
      },
    ],
  },
]
