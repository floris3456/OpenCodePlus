import type { Catalogue, Level } from "../../instructions/model.js"
import { MODELS_GROUP_ID, MODELS_OWNER } from "../../instructions/model-settings.js"
import { categorySummary } from "../../instructions/permission-catalog.js"
import type { TreeNode } from "../../instructions/tree.js"

// The inspector's note line for a structural row: a scope root, a catalogue,
// an origin group, a category group or one of a tool's subgroups. The ids are
// the ones tree.ts builds (README "Layout"); item rows describe themselves
// through their resolved text and provenance instead. Permission categories
// keep the permission catalog's own summaries, so those stay in one place.
export function structureDetail(node: TreeNode): string | undefined {
  if (node.kind === "root") return ROOTS[node.id]
  if (node.kind !== "group") return undefined
  const permissions = node.id.match(/:tool:([^:]+):permissions(?::(.+))?$/)
  if (permissions !== null) return permissionDetail(permissions[1] ?? "", permissions[2])
  if (/:tool:[^:]+:description$/.test(node.id)) return TOOL_DESCRIPTION
  if (/^team:(project|global|defaults):.+:special$/.test(node.id)) return TEAM_SPECIAL
  const presetCatalogue = node.id.match(/^group:preset:(agents|teams)$/)
  if (presetCatalogue !== null) return presetCatalogueDetail(presetCatalogue[1] as Catalogue)
  const catalogue = node.id.match(/^group:(project|global|defaults):(agents|teams)$/)
  if (catalogue !== null) return catalogueDetail(catalogue[1] as Level, catalogue[2] as Catalogue)
  const presetOrigin = node.id.match(/^group:preset:(agents|teams):(native|plus|user)$/)
  if (presetOrigin !== null) return presetOriginDetail(presetOrigin[1] as Catalogue, presetOrigin[2] as Origin)
  const origin = node.id.match(/^group:(project|global|defaults):agents:(native(?::special)?|plus|user)$/)
  if (origin !== null) return originDetail(origin[1] as Level, origin[2] ?? "")
  if (node.id === MODELS_GROUP_ID) return MODELS_SECTION
  const shared = node.id.match(/^group:defaults:(:|\/teams:)(settings|models|compaction|tools|base|skills|system|mcp)$/)
  if (shared !== null) return sharedDetail(shared[1] === ":" ? "agents" : "teams", shared[2] ?? "")
  const parts = parseOwnerGroup(node.id)
  if (parts === undefined) return undefined
  if (parts.category === "tools") return toolsDetail(parts)
  if (parts.category === "skills") return skillsDetail(parts)
  return ownerCategoryDetail(parts)
}

type Origin = "native" | "plus" | "user"

const MODELS_SECTION = `The model settings every agent falls back to when its own model row does not set them: how long to keep the prompt cache warm, how often to ping it, the keep-alive text, and the default effort (variant). "Every model" sits below the per-model rows and above opencode.json and the built-in defaults.`

const ROOTS: Record<string, string> = {
  "root:project": "Customizations for this project: its agents and teams, and the rows they resolve to. Project rows override Global and Defaults.",
  "root:global": "Customizations shared by every project on this machine. Global rows override Defaults, and a project's own rows override these.",
  "root:defaults": "The fallback every agent and team resolves through, and where the shared 'everyone' rows live. Nothing more specific overrides it.",
  "root:preset": "Templates you create agents and teams from; a linked agent, member or team follows its preset live.",
}

function catalogueDetail(level: Level, catalogue: Catalogue): string {
  // The catalogue decides what an addressed row inherits: a stand-alone agent
  // never reads the Teams catalogue, a team member never reads the Agents one.
  if (catalogue === "agents" && level === "project")
    return "Agents defined for this project. Rows here override Global and Defaults for this project; a stand-alone agent resolves through this catalogue, a team member through Teams."
  if (catalogue === "agents" && level === "global")
    return "Agents defined for every project. Global rows override Defaults, and a project's own rows override these; only stand-alone agents resolve through this catalogue."
  if (catalogue === "agents")
    return "The template agents plus the shared rows every stand-alone agent falls back to. An agent launched as a team member reads the Teams catalogue instead."
  if (level === "project")
    return "Teams defined for this project. Project rows override Global and Defaults, and their members resolve through the Teams catalogue only."
  if (level === "global") return "Teams defined for every project. Global rows override Defaults, and a project's own teams override these."
  return "The built-in teams plus the shared rows every team member falls back to: Settings, Models, Compaction, Tools, Base, Skills, System and MCP."
}

function presetCatalogueDetail(catalogue: Catalogue): string {
  if (catalogue === "agents")
    return "Agent presets, by origin: OpenCode's own agents and ones you created. An agent created from one follows it live."
  return "Team presets, by origin. A team created from one copies its members, each linked to its source preset."
}

function originDetail(level: Level, origin: string): string {
  if (origin === "native")
    return "OpenCode's own agents (build, plan, general, explore), projected under every level so their rows can be edited there. They cannot be deleted; the maintenance agents sit in the nested Special group."
  if (origin === "native:special")
    return "OpenCode's maintenance agents: compaction, title and summary. They run internal work, not your chats."
  if (origin === "plus") return "Agents produced by OpenCodePlus teams, including the shipped teams' members. A linked preset decides how a member behaves."
  if (level === "defaults")
    return "Agents you created, plus the Defaults entries — name patterns such as `*orchestrator*` — that set rows for every agent they match."
  return "Agents you created. `a` adds one here, optionally linked to a preset."
}

function presetOriginDetail(catalogue: Catalogue, origin: Origin): string {
  if (catalogue === "teams" && origin === "plus")
    return "Team presets shipped with OpenCodePlus: Basic (planner, orchestrator, implementer, reviewer, scout and build seat). A team created from one copies its members, each linked to its member preset."
  if (catalogue === "teams") return "Team presets you created. `a` creates one from a shipped or your own team preset, or empty."
  if (origin === "native") return "Presets for OpenCode's own agents (build, plan, general, explore)."
  if (origin === "plus") return "OpenCodePlus ships no agent presets: its roles are the members of the Basic team preset (Presets > Teams > Plus), and an agent can link to one of those members."
  return "Agent presets you created. `a` creates one, optionally from a base preset."
}

function sharedDetail(catalogue: Catalogue, category: string): string {
  const noun = catalogue === "agents" ? "stand-alone agent" : "team member"
  if (category === "settings")
    return `Settings shared by every ${noun} unless a more specific row overrides them: Enabled, Mode, Description, Hidden, Color and Steps.`
  if (category === "models")
    return `Model candidates shared by every ${noun}, unioned down each one's chain. The first active row down the chain wins, else the upstream model.`
  if (category === "compaction")
    return `How every ${noun} compacts a long session by default: strategy, local model and instructions. A more specific row overrides these.`
  if (category === "tools") return `Tools every ${noun} may call, grouped by origin; each row expands to its Description and Permissions.`
  if (category === "base") return `Base prompt templates every ${noun} can follow; the one matching its active Plus model is used automatically.`
  if (category === "skills") return `Skills every ${noun} can load, grouped by where they came from.`
  if (category === "system") return `System instructions every ${noun} receives, headed by Role/persona.`
  return `MCP servers every ${noun} can call. \`a\` adds one; \`d\` removes it everywhere.`
}

function permissionDetail(tool: string, category?: string): string {
  if (category === undefined)
    return `Every permission of ${tool}, one group per category. Rows are on/off; enter edits a rule's patterns or a limit's number.`
  const summary = categorySummary(tool, category)
  if (summary !== undefined) return summary
  if (category === "rules") return "Rules for this tool that fit no catalog category. Space switches one on or off."
  return "One category of this tool's permission rows; space switches a row on or off."
}

const TOOL_DESCRIPTION =
  "The tool's text — everything the model reads about it — grouped by its sections. A section can be excluded, edited or split."

const TEAM_SPECIAL =
  "The team's maintenance agents: compaction, title and summary, each with its own team-scoped rows."

// group:<level>:<ownerPath>:<category>[:<tail>]. The owner is an agent id, a
// `<team>/:<member>` (or `<team>/:special:<id>`) path, or the shared `/teams`
// segment; an agent id never contains `:` and a team name never contains `/`,
// so the first `/:` is the member separator.
interface OwnerGroup {
  readonly level: Level
  readonly owner: string
  readonly category: string
  readonly tail: readonly string[]
}

function parseOwnerGroup(id: string): OwnerGroup | undefined {
  const head = id.match(/^group:(project|global|defaults|preset):/)
  if (head === null) return undefined
  const level = head[1] as Level
  const rest = id.slice(head[0].length)
  if (rest.startsWith("/teams:")) return { level, ...splitShared(rest.slice("/teams:".length)), owner: "/teams" }
  if (rest.startsWith(":")) return { level, ...splitShared(rest.slice(1)), owner: "" }
  const memberAt = rest.indexOf("/:")
  if (memberAt === -1) return { level, ...splitFirst(rest) }
  const team = rest.slice(0, memberAt)
  const segments = rest.slice(memberAt + 2).split(":")
  const [member = "", category = "", ...tail] = segments
  if (member !== "special") return { level, owner: `${team}/:${member}`, category, tail }
  const [special = "", specialCategory = "", ...specialTail] = segments.slice(1)
  return { level, owner: `${team}/:special:${special}`, category: specialCategory, tail: specialTail }
}

function splitFirst(rest: string): { owner: string; category: string; tail: readonly string[] } {
  const [owner = "", category = "", ...tail] = rest.split(":")
  return { owner, category, tail }
}

// The shared Defaults forms (`::<category>` and `:/teams:<category>`) start at
// the category: the owner segment is the catalogue discriminator itself.
function splitShared(rest: string): { category: string; tail: readonly string[] } {
  const [category = "", ...tail] = rest.split(":")
  return { category, tail }
}

function subjectOf(part: OwnerGroup): string {
  if (part.owner.includes("/:special:")) return part.level === "preset" ? "this maintenance preset" : "this maintenance agent"
  if (part.owner.includes("/:")) return part.level === "preset" ? "this member preset" : "this team member"
  return part.level === "preset" ? "this preset" : "this agent"
}

function ownerCategoryDetail(part: OwnerGroup): string | undefined {
  if (part.tail.length > 0) return undefined
  const subject = subjectOf(part)
  if (part.category === "settings")
    return `${capitalize(subject)}'s settings: Enabled, Mode, Description, Hidden, Color and Steps. Space toggles Enabled; enter edits a value.`
  if (part.category === "models")
    return `Models ${subject} may use: the candidates down its chain plus its own model. The first active row down the chain wins; space activates one at this level, enter edits it (model, effort, warming), d removes or hides it here.`
  if (part.category === "compaction")
    return `How ${subject} compacts a long session: strategy, local model and instructions. Remote uses the provider instead and locks the local fields.`
  if (part.category === "tools") return `Tools ${subject} may call, grouped by origin; each row expands to its Description and Permissions.`
  if (part.category === "base") return `Base prompt templates ${subject} can follow. The one matching its active Plus model is used automatically.`
  if (part.category === "skills") return `Skills ${subject} can load, grouped by where they came from.`
  if (part.category === "system") return `System instructions ${subject} receives. Role/persona is always first; sections can be excluded.`
  return undefined
}

function toolsDetail(part: OwnerGroup): string | undefined {
  const head = part.tail[0]
  const rest = part.tail.slice(1)
  if (head === undefined) return ownerCategoryDetail(part)
  if (head === "policy") return "This member's own role rows whose tool is not in the inventory above; they still apply to it when it runs."
  if (head === "native" && rest.length === 0) return "Tools that ship with OpenCode."
  if (head === "plus" && rest.length === 0) return "Tools that ship with OpenCodePlus; the team tools list only under the Teams catalogue."
  if (head === "mcp" && rest.length === 0) return "Tools from MCP servers, one group per server."
  if (head === "mcp" && rest.length === 1)
    return `Tools exposed by the ${rest[0]} MCP server. A rule cannot be added to an MCP tool: its resource is always "*".`
  if (head === "mcp" && rest.length === 2 && rest[1] === "codemode") return "This server's Code Mode tools, called inside `execute`."
  if (head !== "mcp" && rest[0] === "codemode") return codemodeDetail(rest.slice(1))
  return undefined
}

function codemodeDetail(namespace: readonly string[]): string {
  if (namespace.length === 0)
    return "Code Mode tools, called inside `execute`. OpenCode and OpenCodePlus group them by tool namespace; an MCP server lists its own directly."
  return `Code Mode tools of the ${namespace.join(":")} namespace, called inside \`execute\`.`
}

function skillsDetail(part: OwnerGroup): string | undefined {
  const head = part.tail[0]
  const rest = part.tail.slice(1)
  if (head === undefined) return ownerCategoryDetail(part)
  if (head === "native") return "Skills that ship with OpenCode."
  if (head === "plus") return "Skills that ship with OpenCodePlus."
  if (head === "project") return "Skills in this project's own skill directories (.opencode/skill*)."
  if (head === "global") return "Skills under the global skills directory, available in every project."
  if (head === "defaults") return "Skills in the global skills directory's defaults folder, shared with every project."
  if (head === "preset") return "Skills kept with this preset under the global skills presets folder."
  if (head === "mcp" && rest.length === 0) return "Skills served by MCP servers, one group per server."
  if (head === "mcp") return `Skills served by the ${rest.join(":")} MCP server.`
  return undefined
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}