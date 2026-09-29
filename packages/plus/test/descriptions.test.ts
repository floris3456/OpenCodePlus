// The inspector's structural descriptions (src/tui/instructions/descriptions.ts):
// every root, catalogue, origin subgroup and category group answers with its
// own line, keyed by the ids the real tree builds, while permission categories
// keep the permission catalog's summaries.
import { expect, test } from "bun:test"
import { fingerprint, type AgentSource, type Item } from "../src/instructions/model.js"
import { expandedTree, type TreeInput } from "../src/instructions/tree.js"
import { structureDetail } from "../src/tui/instructions/descriptions.js"

function item(id: string, overrides: Partial<Item> = {}): Item {
  return {
    id,
    kind: "tool",
    group: "native",
    title: id.slice(id.indexOf(":") + 1),
    text: `${id} text`,
    enabled: true,
    fingerprint: fingerprint(`${id} text`),
    ...overrides,
  }
}

const agents: AgentSource[] = [
  { id: "build", scope: "defaults", origin: "native" },
  { id: "compaction", scope: "defaults", origin: "special" },
  { id: "alice", scope: "project", origin: "user" },
  { id: "mate", scope: "project", origin: "user" },
  { id: "shipped", scope: "project", origin: "plus" },
  { id: "Helper", scope: "global", origin: "user" },
]

const items: Item[] = [
  item("tool:shell", { kind: "tool", group: "native", title: "shell", text: "shell tool" }),
  item("tool:coder", { kind: "tool", group: "native", title: "coder", text: "# Alpha\n\na\n\n# Beta\n\nb\n", codemode: true, namespace: "fs" }),
  item("tool:plus-one", { kind: "tool", group: "plus", title: "plus-one" }),
  item("tool:mcp-one", { kind: "tool", group: "mcp", server: "sample", title: "mcp-one" }),
  item("perm:shell:git-push", {
    kind: "perm",
    group: "none",
    title: "Git push",
    text: "Git push\ngit push *",
    permTool: "shell",
    ruleId: "git-push",
    patterns: ["git push *"],
    provenance: ["tool:shell"],
  }),
  item("perm:shell:mined", {
    kind: "perm",
    group: "none",
    title: "Push from instructions",
    text: "Push\ngit push origin *",
    permTool: "shell",
    ruleId: "push-origin",
    patterns: ["git push origin *"],
    provenance: ["instruction:AGENTS.md"],
  }),
  // A tool with no legacy category carries its own rules in "Rules".
  item("perm:coder:custom", {
    kind: "perm",
    group: "none",
    title: "Custom",
    text: "Custom",
    permTool: "coder",
    ruleId: "custom",
    patterns: ["x"],
  }),
  // Its tool is not in the inventory of a member built below, so it lists
  // under the member's Other permissions group.
  item("perm:edit:run:r1", {
    kind: "perm",
    group: "none",
    title: "Edit scope",
    text: "Edit scope",
    permTool: "edit",
    ruleId: "run:r1",
    policy: { on: [], off: [] },
  }),
  item("skill:native-one", { kind: "skill", group: "native", title: "native-one" }),
  item("skill:plus-one", { kind: "skill", group: "plus", title: "plus-one" }),
  item("skill:proj-one", { kind: "skill", group: "project", title: "proj-one" }),
  item("skill:mcp-one", { kind: "skill", group: "mcp", server: "sample", title: "mcp-one" }),
  item("base:gpt", { kind: "base", group: "none", title: "gpt.txt", text: "gpt base" }),
  item("system:role", { kind: "system", group: "none", title: "Role", text: "role" }),
  item("mcp:sample", { kind: "mcp", group: "none", title: "sample", text: "config" }),
]

const input: Omit<TreeInput, "expanded"> = {
  items,
  records: [],
  agents,
  teams: [{ level: "project", team: "crew", enabled: true, agents: ["mate"] }],
}

const nodes = expandedTree(input)

function detail(id: string): string | undefined {
  const node = nodes.find((row) => row.id === id)
  if (node === undefined) throw new Error(`missing tree row ${id}`)
  return structureDetail(node)
}

test("scope roots explain what they hold and what overrides what", () => {
  expect(detail("root:project")).toBe(
    "Customizations for this project: its agents and teams, and the rows they resolve to. Project rows override Global and Defaults.",
  )
  expect(detail("root:global")).toBe(
    "Customizations shared by every project on this machine. Global rows override Defaults, and a project's own rows override these.",
  )
  expect(detail("root:defaults")).toBe(
    "The fallback every agent and team resolves through, and where the shared 'everyone' rows live. Nothing more specific overrides it.",
  )
  expect(detail("root:preset")).toBe("Templates you create agents and teams from; a linked agent, member or team follows its preset live.")
})

test("catalogues describe their population and the Agents/Teams split", () => {
  expect(detail("group:project:agents")).toBe(
    "Agents defined for this project. Rows here override Global and Defaults for this project; a stand-alone agent resolves through this catalogue, a team member through Teams.",
  )
  expect(detail("group:project:teams")).toBe(
    "Teams defined for this project. Project rows override Global and Defaults, and their members resolve through the Teams catalogue only.",
  )
  for (const level of ["project", "global", "defaults"] as const) {
    for (const catalogue of ["agents", "teams"] as const) {
      expect(detail(`group:${level}:${catalogue}`)).toBeDefined()
    }
  }
  expect(detail("group:preset:agents")).toBe(
    "Agent presets, by origin: OpenCode's own agents and ones you created. An agent created from one follows it live.",
  )
  expect(detail("group:preset:teams")).toBe("Team presets, by origin. A team created from one copies its members, each linked to its source preset.")
})

test("origin subgroups describe each population at every level and in Presets", () => {
  for (const level of ["project", "global", "defaults"] as const) {
    for (const origin of ["native", "native:special", "plus", "user"] as const) {
      expect(detail(`group:${level}:agents:${origin}`)).toBeDefined()
    }
  }
  expect(detail("group:project:agents:native:special")).toBe(
    "OpenCode's maintenance agents: compaction, title and summary. They run internal work, not your chats.",
  )
  expect(detail("group:global:agents:plus")).toBe(
    "Agents produced by OpenCodePlus teams, including the shipped teams' members. A linked preset decides how a member behaves.",
  )
  expect(detail("group:defaults:agents:user")).toBe(
    "Agents you created, plus the Defaults entries — name patterns such as `*orchestrator*` — that set rows for every agent they match.",
  )
  for (const origin of ["native", "plus", "user"] as const) expect(detail(`group:preset:agents:${origin}`)).toBeDefined()
  expect(detail("group:preset:agents:plus")).toBe(
    "OpenCodePlus ships no agent presets: its roles are the members of the Basic team preset (Presets > Teams > Plus), and an agent can link to one of those members.",
  )
  for (const origin of ["plus", "user"] as const) expect(detail(`group:preset:teams:${origin}`)).toBeDefined()
  expect(detail("group:preset:teams:plus")).toBe(
    "Team presets shipped with OpenCodePlus: Basic (planner, orchestrator, implementer, reviewer, scout and build seat). A team created from one copies its members, each linked to its member preset.",
  )
})

test("every shared Defaults inventory category describes both catalogues", () => {
  for (const category of ["settings", "models", "compaction", "tools", "base", "skills", "system", "mcp"] as const) {
    expect(detail(`group:defaults::${category}`)).toBeDefined()
    expect(detail(`group:defaults:/teams:${category}`)).toBeDefined()
  }
  expect(detail("group:defaults::models")).toBe(
    "Model candidates shared by every stand-alone agent, unioned down each one's chain. The first active row down the chain wins, else the upstream model.",
  )
  expect(detail("group:defaults:/teams:mcp")).toBe("MCP servers every team member can call. `a` adds one; `d` removes it everywhere.")
  expect(detail("group:defaults::settings")).toContain("stand-alone agent")
  expect(detail("group:defaults:/teams:settings")).toContain("team member")
})

test("owner categories name the agent, member, preset or maintenance agent they belong to", () => {
  for (const category of ["settings", "models", "compaction", "tools", "base", "skills", "system"] as const) {
    expect(detail(`group:project:alice:${category}`)).toBeDefined()
    expect(detail(`group:project:crew/:mate:${category}`)).toBeDefined()
    expect(detail(`group:project:crew/:special:compaction:${category}`)).toBeDefined()
    expect(detail(`group:preset:basic/:implementer:${category}`)).toBeDefined()
  }
  expect(detail("group:project:alice:settings")).toBe(
    "This agent's settings: Enabled, Mode, Description, Hidden, Color and Steps. Space toggles Enabled; enter edits a value.",
  )
  expect(detail("group:project:crew/:mate:tools")).toBe(
    "Tools this team member may call, grouped by origin; each row expands to its Description and Permissions.",
  )
  expect(detail("group:project:crew/:special:compaction:models")).toBe(
    "Models this maintenance agent may use: the candidates down its chain plus its own model. The first active row down the chain wins; space activates one at this level, enter edits it (model, effort, warming), d removes or hides it here.",
  )
  expect(detail("group:preset:basic/:implementer:settings")).toBe(
    "This member preset's settings: Enabled, Mode, Description, Hidden, Color and Steps. Space toggles Enabled; enter edits a value.",
  )
})

test("tool subgroups describe origins, MCP servers, Code Mode and Other permissions", () => {
  expect(detail("group:project:alice:tools:native")).toBe("Tools that ship with OpenCode.")
  expect(detail("group:project:alice:tools:plus")).toBe("Tools that ship with OpenCodePlus; the team tools list only under the Teams catalogue.")
  expect(detail("group:project:alice:tools:mcp")).toBe("Tools from MCP servers, one group per server.")
  expect(detail("group:project:alice:tools:mcp:sample")).toBe(
    'Tools exposed by the sample MCP server. A rule cannot be added to an MCP tool: its resource is always "*".',
  )
  expect(detail("group:project:alice:tools:native:codemode")).toBe(
    "Code Mode tools, called inside `execute`. OpenCode and OpenCodePlus group them by tool namespace; an MCP server lists its own directly.",
  )
  expect(detail("group:project:alice:tools:native:codemode:fs")).toBe("Code Mode tools of the fs namespace, called inside `execute`.")
  expect(detail("group:project:crew/:special:compaction:tools:native")).toBe("Tools that ship with OpenCode.")
  expect(detail("group:project:crew/:mate:tools:policy")).toBe(
    "This member's own role rows whose tool is not in the inventory above; they still apply to it when it runs.",
  )
  expect(detail("group:defaults::tools:native:codemode:fs")).toBe("Code Mode tools of the fs namespace, called inside `execute`.")
  expect(detail("group:defaults:/teams:tools:native")).toBe("Tools that ship with OpenCode.")
  expect(detail("group:defaults:/teams:tools:native:codemode:fs")).toBe("Code Mode tools of the fs namespace, called inside `execute`.")
})

test("skill subgroups describe where each skill came from", () => {
  expect(detail("group:project:alice:skills")).toBe("Skills this agent can load, grouped by where they came from.")
  expect(detail("group:project:alice:skills:native")).toBe("Skills that ship with OpenCode.")
  expect(detail("group:project:alice:skills:plus")).toBe("Skills that ship with OpenCodePlus.")
  expect(detail("group:project:alice:skills:mcp")).toBe("Skills served by MCP servers, one group per server.")
  expect(detail("group:project:alice:skills:mcp:sample")).toBe("Skills served by the sample MCP server.")
  expect(detail("group:project:alice:skills:project")).toBe("Skills in this project's own skill directories (.opencode/skill*).")
  expect(detail("group:project:alice:skills:global")).toBe("Skills under the global skills directory, available in every project.")
  expect(detail("group:project:alice:skills:defaults")).toBe("Skills in the global skills directory's defaults folder, shared with every project.")
  expect(detail("group:project:alice:skills:preset")).toBe("Skills kept with this preset under the global skills presets folder.")
})

test("a tool's Description group, a team's Special group and permission categories", () => {
  expect(detail("group:project:alice:tool:coder:description")).toBe(
    "The tool's text — everything the model reads about it — grouped by its sections. A section can be excluded, edited or split.",
  )
  expect(detail("team:project:crew:special")).toBe(
    "The team's maintenance agents: compaction, title and summary, each with its own team-scoped rows.",
  )
  // The permission summaries are the pre-existing ones, unchanged.
  expect(detail("group:project:alice:tool:shell:permissions")).toBe(
    "Every permission of shell, one group per category. Rows are on/off; enter edits a rule's patterns or a limit's number.",
  )
  expect(detail("group:project:alice:tool:shell:permissions:commands")).toBe(
    "Command families. The shell's permission resource is each parsed command's text, so these are wildcard patterns over it.",
  )
  expect(detail("group:project:alice:tool:shell:permissions:suggested")).toBe(
    "Rules suggested by paths, commands and sites the instructions mention. They refuse what they match while off.",
  )
  // A category without a catalog summary still answers with its own line.
  expect(detail("group:project:alice:tool:coder:permissions:rules")).toBe(
    "Rules for this tool that fit no catalog category. Space switches one on or off.",
  )
})

test("only structural rows carry a description", () => {
  for (const id of ["agent:project:alice", "item:project:alice:tool:shell", "section:project:alice:tool:shell:whole", "team:project:crew"]) {
    expect(detail(id)).toBeUndefined()
  }
})