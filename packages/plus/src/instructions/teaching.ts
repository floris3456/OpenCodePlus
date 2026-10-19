import type { Context } from "@opencode/plugin/effect/plugin"
import type { Registration } from "@opencode/plugin/effect/registration"
import { AbsolutePath } from "@opencode/schema/schema"
import { Skill } from "@opencode/schema/skill"
import fs from "node:fs/promises"
import path from "node:path"
import { runRegistration } from "./apply.js"
import { globalConfigDir, teachingFilePath, teachingSkillId } from "./paths.js"

export const teachingTitle = "OpenCodePlus"

// Per-session cost: roughly 100 tokens (under 600 characters). Names the tool
// namespace, the row-id shapes, list's row lines, the two happy flows, that
// create returns the row id its follow-ups take, the skill that carries the
// rest, and the permission pattern grammar. teaching.test.ts pins the
// character bound.
export const teachingContent =
  "`tools.instructions.*` edits agents/tools/base/skills/system/MCP/models/teams/perms. " +
  "Ids: `item:<level>:<agent|''>:<itemId>`, `section:…:<sectionId>`, `agent:<level>:<id>`, `team:<level>:<name>[:<member>]`. " +
  "`create` returns `{id,item}`; other ops take that `id`. `list` rows: `id | badges | from`. " +
  "`list({where:\"review:true\"})`→`show({id,view:\"diff\"})`→`set({id,resolve:\"keep\"})`. " +
  "`list({where:\"agent:X item:tool\"})`→`edit({id,oldString,newString})`. " +
  "Patterns are core wildcards, not regex; shell resource is the parsed command, so `git *` matches bare `git`. " +
  "More: skill `instructions-tools`."

// Detailed, on-demand guidance keeps the seed instruction within its size budget.
export const teachingSkillContent = `# instructions-tools

\`tools.instructions.*\` (Code Mode) reads and changes the Instructions tree: agent settings, models, compaction, tools, base prompts, skills, system rows, MCP servers, teams and members, and per-tool permission rules. Every write is logged with actor \`tool\`; \`log\` reads the history.

## Quick start

- Find rows: \`list({ where: "agent:alpha item:tool" })\` returns \`{ total, columns, rows }\`, one line per row: \`id | badges | from\`.
- Read one: \`show({ id })\` gives its \`text\` and where it comes from. On an agent or a group, \`show\` lists the rows under it.
- Change part of a text: \`edit({ id, oldString, newString })\`, like the edit tool for a file.
- Replace a whole text: \`set({ id, text })\`. Switch a row: \`set({ id, state: "off" })\`. Undo at this level: \`reset({ id })\`.
- Pass ids exactly as \`list\`, \`show\` or \`create\` returned them.

## Row ids

- \`item:<level>:<owner>:<itemId>\`: a whole row, e.g. \`item:project:alpha:tool:reader\`. Item ids: \`tool:<id>\`, \`param:<tool>:<name>\`, \`base:<id>\`, \`system:<id>\`, \`skill:<id>\`, \`mcp:<name>\`, \`setting:<field>\`, \`compaction:<field>\`, \`perm:<tool>:<rule>\` (e.g. \`perm:shell:git-push\`), \`model:<provider>/<model>[@variant]\` (e.g. \`model:openai/gpt-5@high\`).
- \`section:…:<sectionId>\`: one section of a row; \`show({ id, view: "sections" })\` lists them.
- \`agent:<level>:<id>\`: an agent. \`team:<level>:<name>\`: a team; \`team:<level>:<team>:<member>\`: one member.
- \`group:…\`: a group of rows (Tools, Models, Skills, Settings…); \`set({ id, state })\` on it switches every row in it.
- \`<level>\` is \`project\`, \`global\`, \`defaults\` or \`preset\` (the Presets root). \`<owner>\` is the agent id, \`<team>/:<member>\` for a team member's row, \`''\` for the Agents catalogue's shared Defaults row (\`item:defaults::tool:reader\`) and \`/teams\` for the Teams one (\`item:defaults:/teams:tool:reader\`).
- Defaults › Models rows: \`item:defaults:/models:modeldefault:*\` (every model) and \`…:modeldefault:<provider>/<model>\`; their fields are \`item:defaults:/models:modelsetting:<field>:<* or provider/model>\`. A model row's fields are the \`modelfield:<field>:<provider>/<model>[@variant]\` rows under it.

## Where a value comes from

An agent behaves exactly as its rows say; nothing is read from its name. A row it does not set comes, in order, from its own levels (project, global, defaults), its **preset** (linked, live), the **Defaults entries** matching its name, Defaults "for every agent", and last the fallback: OpenCode agents and agent-owned rows keep their upstream value, other tool and instruction rows are **off**; settings and compaction keep the configuration's values. No preset means unlinked, not exempt from Defaults. \`from\` says it in words: "set here", "from preset Basic › orchestrator", "from default *orchestrator*", "from Defaults (every agent)", "OpenCode", "off by default".

- Presets: \`agent:preset:<id>\` (OpenCode: build, plan, general, explore, title, summary, compaction; User: yours) and team presets \`team:preset:<team>\` with member presets \`team:preset:<team>:<member>\`. Plus ships the team preset \`basic\` (planner, orchestrator, implementer, reviewer, scout, build-seat). Shipped presets' rows are editable; the presets cannot be deleted.
- Name a preset \`"<id>"\` (agent preset) or \`"<team>/<member>"\` (member preset, e.g. \`"basic/planner"\`); a team takes a team preset id. \`set({ id, preset })\` links an agent, member, team, entry or user preset (live); \`preset: null\` unlinks.
- Defaults entries match agents by exact name or pattern (\`*\` or \`%\` = any text, ignoring case): \`agent:defaults:<name>\` for agents, \`team:defaults:<team pattern>:<name>\` for team members. An exact name beats a pattern.
- Catalogues: a stand-alone agent inherits the Agents catalogue's shared Defaults rows; a team member inherits the Teams catalogue's, then its team's, then its own.

## list

\`list({ where?, fields?, sort?, limit?, offset? })\`, \`limit\` defaults to 40. It returns \`{ total, columns, rows }\`: each row is one line in the order of \`columns\`, by default \`id | badges | from\`, with \`-\` for an empty value, so \`row.split(" | ")[0]\` is its id. \`fields\` picks the columns after \`id\`: \`label\`, \`badges\`, \`from\`, \`source\`, \`tokens\`, \`text\`, \`upstream\`, \`record\`, \`path\`, \`updated\`, \`sections\`. A Description row that only repeats its item row is left out.

\`where\` terms are ANDed; \`!key:value\` negates one; \`a,b\` is OR within one key; a bare word matches label or id, ignoring case; \`key:>7d\` and \`key:<N\` compare ages and counts.

Structural keys: \`kind\` (root|group|agent|team|item|section), \`item\` (tool|base|skill|system|mcp|model|modeldefault|modelsetting|perm|setting|compaction), \`tool\` (shell|edit|read|webfetch|subagent|skill), \`group\` (native|plus|mcp|project|none), \`server\`, \`namespace\`, \`level\` (project|global|defaults|preset), \`catalogue\` (agents|teams), \`agent\` (substring, ignoring case; \`_\` is the shared row), \`state\` (on|off), \`modified\`, \`review\`, \`source\`, \`overridden\`, \`active\`, \`inactive\`, \`unsupported\`, \`codemode\`, \`pinned\`, \`execute\`, \`can\`, \`has\`, \`id\`, \`label\`, \`updated\`, \`team\`, \`acked\`, \`excluded\`.

Slower keys that read row text: \`shadowed\`, \`orphan\`, \`dead\`, \`identical\`, \`tokens\`, \`delta\`, \`overriders\`, \`text\`, \`upstream\`.

## show

\`show({ id, view? })\`, \`view\` defaults to \`resolved\`: the row's \`text\` (a whole row includes its sections), \`enabled\` and \`from\`, plus \`assembled\` only when what reaches the model differs (a section off, a gate, a marker). On an agent, group or root, \`resolved\` lists the rows under it as \`id | badges | from\` lines. Other views: \`upstream\` (the text above yours), \`mine\` (your stored text), \`record\` (the raw override), \`sections\` (section ids), \`diff\` (original→mine and original→upstream unified diffs, a summary and merge units) and \`assembled\` (an agent's whole prompt; \`agent:\` ids at project, global or defaults only). A perm row shows its \`patterns\`, \`keywords\`, refusal \`message\` and the prompt lines it would scrub.

## edit

\`edit({ id, oldString, newString, replaceAll? })\` changes part of a row's text the way the edit tool changes a file. \`oldString\` must match the current text (\`show\`'s \`text\`) exactly once: add context to make it unique, or pass \`replaceAll: true\` to replace every match. Typographic quotes, dashes and spaces, and spaces at line ends, still match. It saves like \`set({ id, text })\` with the result (the same permissions, sections and review handling) and returns \`{ id, status, replacements }\`. A whole row's text includes its sections, so one edit can reach any of them. Rows without text (models, rules, teams, groups) change with \`set\`.

## set and reset

\`set({ id, text?, state?, pin?, active?, resolve?, warming?, interval?, prompt?, effort? })\` changes one row; several calls can run in one \`execute\`.

- \`text\` replaces the row's text (a whole row or one section; saving a whole row replaces this level's section texts inside it). \`state\` is \`on\`|\`off\`; a bare \`set({ id })\` toggles. \`pin\` (\`true\`|\`false\`) pins a Code Mode tool. When a more specific level hides the write, \`status\` names that row.
- Agent and member rows: \`set({ id, state: "off" })\` (the agent stays editable but cannot run) and \`set({ id, mode: "primary" })\` / \`"subagent"\` / \`"all"\`. \`set({ id, rename })\` renames a Project/Global user agent, team member or team; every record that names it follows.
- Settings \`item:<level>:<owner>:setting:<field>\`: \`enabled\` and \`hidden\` (pickers only) take \`state\`; \`mode\`, \`description\`, \`color\` (#RRGGBB) and \`steps\` (a positive integer) take \`text\`; empty \`color\`/\`steps\` clear.
- Agent-wide compaction rows take \`text\`: \`compaction:strategy\` (\`auto\`, \`local\` or \`remote\`; auto uses the provider's own compaction where it has one), \`compaction:model\` (\`provider/model#variant\`) and \`compaction:instructions\` (empty is an explicit empty prompt; \`reset\` inherits again).
- Skills: one row per skill in the owner's Skills group (\`group:<level>:<owner>:skills\`); \`state\` switches it for that agent, and changing its text gives that agent its own copy.
- System rows and their sections: \`requires: ["tool:<id>", "skill:<id>", "!perm:<tool>:<rule>"]\` sends it only while those rows are on (\`!\`: off) for the agent; \`[]\` always, \`null\` drops this level's condition. A model prompt row (\`system:model/<id>\`) takes \`models\`, the patterns of the models it is sent for.
- \`reset({ id })\` drops this level's override of the row (a model row: only this level's active flag; an agent row: its settings and compaction controls).

Code Mode tools: \`off\` denies the tool, \`text\` rewrites its catalog line (the first line, up to 120 characters), \`pin\` overrides the default; \`tool:execute\` off removes Code Mode. Filter with \`codemode:true\`, \`pinned:true|false\`, \`namespace:<name>\`.

## Models

Each agent has a Models group: the candidates down its chain plus its upstream model.

- \`set({ id, active: true })\` (or a bare \`set({ id })\`) makes that candidate the active one at that level; \`reset({ id })\` clears the flag there. \`create({ kind: "model", providerID, modelID, variant?, level?, agent? })\` adds a candidate and activates it (\`level\` defaults to \`project\`; project, global and preset need \`agent\`). \`delete({ id, confirm: true })\` removes it; the active model refuses until another is active. \`text\` on a model row replaces the candidate (\`provider/model[#variant]\`).
- A team member without a stand-alone agent is addressed through its member row, e.g. \`item:global:Basic/:Planner:model:acme/x\`; a flat \`item:global:Planner:model:…\` id is refused with the row to use.
- Field rows \`modelfield:<field>:<provider>/<model>[@variant]\` (model, effort, warming, interval, prompt and the compaction fields below) take \`text\` (empty inherits); \`reset\` clears just that field.
- Keep-alive: \`warming\` (\`off\`, \`on\`, or 1m–24h such as \`45m\` or \`2h\`, rounded up to whole intervals), \`interval\` (30s–24h, e.g. \`4m\`) and \`prompt\` (the keep-alive text); empty inherits. A Defaults › Models row also takes \`effort\` (the default variant) and \`state on|off\` for its warming switch; \`show\` gives each effective value and its source.

## Per-model compaction and images

Compaction, warming and the cold-cache list are model settings at any level; editing them does not itself rewrite an existing chat's prompt prefix — the next actual compaction does. Model and Defaults › Models rows take these typed \`set\` fields; null inherits:

- \`compactWarm\` (\`on\`|\`off\`): the model's default "Compact before cold". Each chat has its own switch (\`/compact-warm\`, \`<leader>j\`).
- \`coldModels\`: an ordered array (\`["a/one#high", "b/two"]\`) or a comma list; \`[]\` turns the list off. With Settings › OpenCodePlus › Compact cold chats first on (only the person sets it), the first message into a cold chat is summarized by the chat model's list first (#1 writes, #2… fall back). \`coldCompact\` is refused: there is no per-model cold switch. The list is a group: no \`modelsetting:coldModels\` field row is emitted.
- \`compactionStrategy\`: \`auto\`, \`local\` or \`remote\`. \`compactionModel\`: \`provider/model[#variant]\`. \`compactionInstructions\`: the summary prompt; \`""\` is an explicit empty summary prompt, unlike the other fields where \`""\` just clears the override, and \`reset\` resumes inheritance.
- \`compactionInput\` / \`compactionOutput\`: early compaction thresholds in tokens (positive whole numbers as strings), or \`"off"\` to suppress an inherited one.
- \`imageConvert\` (\`webp-90\` default, \`webp-75\`, \`webp-lossless\`, \`original\`), \`imageShrink\` (the longest edge in pixels, 256–65535, default \`2000\`) and \`imagesFull\` (\`compact\` default, \`leave-out\`, \`error\`) apply to images that arrive afterwards.
- Resolution: the agent's model row chain, then Defaults › this model, Every model and the built-in value; strategy, model and instructions also read the agent-wide \`compaction:*\` rows after the model chain, and Defaults for every agent before the built-in.

## Permission rules

\`perm:<tool>:<rule>\` rows hang under each tool (\`list({ where: "item:perm tool:shell" })\`). \`set({ id, state: "off" })\` refuses what the rule matches for that agent and scrubs matching lines from its prompts; \`set({ id, message })\` sets the refusal the model reads; \`label\`, \`patterns\` and \`keywords\` rewrite the rule. \`create({ kind: "rule", tool, id, label, patterns, keywords?, message?, level?, agent? })\` adds one (no \`agent\`: a shared Defaults rule); only user-created rules delete. Definitions are per owner: editing an inherited one makes a local copy. \`edit\` is decided by \`set\`'s rows (Rows it may change, Override text, approval).

Patterns are core wildcards, not regex: \`*\` is any run (including spaces), \`?\` one character. For shell the resource is the parsed command, so \`git *\` also matches a bare \`git\`; for file tools the path (\`*.env*\`, \`**/.git/**\`); for webfetch the URL; for subagent and skill the exact id. A \`team_*\` tool row that is off refuses the call.

## Review

A row whose upstream changed under your text is to review (\`list({ where: "review:true" })\`). \`show({ id, view: "diff" })\` gives \`mineDiff\`, \`upstreamDiff\`, a \`summary\` and \`merge: { units, text }\`: each unit is \`{ id, kind, yours, upstream, base, included }\` with \`kind\` \`yours\`, \`upstream\`, \`both\` or \`same\`; a \`both\` unit has a second id \`<id>:upstream\`, excluded by default. Then:

- \`set({ id, resolve: "keep" })\` keeps your text, \`resolve: "take"\` follows upstream, and \`resolve: "edit"\` with \`text\` stores new text against upstream;
- \`set({ id, resolve: "merge", include: [unit ids] })\` saves that merge (no \`include\` = the defaults; a merge equal to upstream is a take). A merge takes \`include\`, not \`text\`.

Texts compare without their final newline, and units without trailing whitespace.

## System order, sections, links, folders

- An owner's System list is its system prompt in the order the model receives it: Tools first, then Role/persona with the Base group, OpenCode's parts (\`system:opencode/*\`), OpenCodePlus, Tools and rules, and the System rows. \`move({ id, before | after })\` reorders a part for that owner; OpenCode's parts move but are not edited. An agent without its own order uses the first one down its chain. AGENTS.md files are rows under \`system:opencode/agents-md\`, switched or edited per agent. Model prompts \`system:model/<id>\` are sent right after the base prompt to the models their patterns name: \`create({ kind: "system", id, title, text, models: ["*opus-5-5*"] })\`.
- Instructions that belong to a tool, skill or rule go in \`system:tools-and-rules\`, one section per row, with a \`<!-- requires: … -->\` line under the heading so they follow that row.
- \`split({ id, boundaries?, add? })\`: \`boundaries\` \`[{ id, name, start }]\` sets manual sections by character offset; \`add: { name, text }\` appends one. \`move\` on a section reorders it within its item.
- \`link({ id, target?, type?, enabled? })\`: without \`target\` it lists the row's links; with it, stores one: \`either\` (turning one on switches the other off), \`shownWhenOn\` / \`shownWhenOff\` (the target is sent only while \`id\` is on / off). \`enabled: false\` masks the pair at this level.
- Folders are display only: \`create({ kind: "folder", name, id: "<tab or folder row id>" })\`, \`set({ id, rename })\`, \`move({ id, into | before | after })\`, \`delete({ id, confirm: true })\`.

## create and delete

\`create({ kind, ...fields })\` makes one row and returns \`{ id, item }\`; pass that \`id\` to \`show\`, \`set\`, \`edit\` and \`delete\`.

| kind | fields |
| agent | \`id\` (+ \`scope\` project\\|global, \`preset\`) |
| skill | \`name\`, \`body\` (+ \`scope\` project\\|global\\|defaults\\|preset, \`preset\`) |
| base | \`id\`, \`title\`, \`text\` |
| system | \`id\` (lowercase letters, digits, hyphens), \`text\` (+ \`title\`; \`models\` for a model prompt) |
| mcp | \`name\`, \`config\` |
| team | \`team\`, \`level\` project\\|global (+ \`preset\`: a team preset whose members are created) |
| member | \`team\`, \`level\` project\\|global\\|defaults, \`id\` (+ \`preset\`; at defaults, patterns) |
| entry | \`catalogue\` agents\\|teams, \`name\` (+ \`team\` pattern, \`preset\`) |
| preset, teamPreset, presetMember | \`id\` (+ \`from\`; presetMember also \`team\`) |
| model | \`providerID\`, \`modelID\` (+ \`variant\`, \`level\`, \`agent\`) |
| rule | \`tool\`, \`id\`, \`label\`, \`patterns\` (+ \`keywords\`, \`message\`, \`level\`, \`agent\`) |
| folder | \`name\`, \`id\` (the tab or folder row) |

\`create({ kind: "instruction" })\` fails with \`instruction.disabled\`. \`delete({ id, confirm: true })\` deletes a user-owned row (agent, team, member, file, entry, user preset, custom rule, folder); a preset still linked is refused.

## CLI

\`opencodeplus instructions <op> [<id>] [--<param> value …]\` runs the same operations: \`--json '<object>'\` for structured input, \`--text-file F\` or \`--text -\` for text; deletes need \`--confirm true\`. Logged as actor \`cli\`.

## Guards and errors

A tool's writes to an agent listed in \`.opencodeplus/project.json\` \`protectedAgents\` are refused; TUI writes are not.

| error | meaning |
| \`row.unknown\` | no row has that id: \`list\` again (for a member-only agent's model row the message names the member row to use) |
| \`agent.protected\` | that agent is in \`protectedAgents\` |
| \`delete.unconfirmed\` | retry with \`confirm: true\` |
| \`view.unsupported\` | that view needs another kind of row |
| \`create.failed\` | written, but the row is not listed yet: \`list\` before retrying, or you may create it twice |
| \`rename.invalid\` | built-ins, shipped Defaults rows, ancestor-backed agents and presets cannot be renamed |
| \`preset.invalid\` / \`preset.exists\` / \`preset.readonly\` / \`preset.inUse\` | no such preset or the wrong kind / it exists / shipped / still linked from the rows named |
| \`entry.invalid\` / \`entry.exists\` / \`entry.missing\` | bad name (no \`:\`) / duplicate / no such entry |
| \`link.invalid\` / \`link.cycle\` | the row takes no link / the link would loop back |

## Examples

1. Reword one sentence of a tool for one agent: \`list({ where: "agent:alpha item:tool" })\` → \`edit({ id, oldString: "Reads a file.", newString: "Reads one file at a time." })\`.
2. Switch a skill off for one agent, then undo: \`set({ id, state: "off" })\` → \`reset({ id })\`.
3. Work the review queue: \`list({ where: "review:true" })\` → \`show({ id, view: "diff" })\` → \`set({ id, resolve: "keep" })\`.
4. Switch an agent's model: \`list({ where: "agent:alpha item:model" })\` → \`set({ id, active: true })\`.
5. Warm Claude chats: \`list({ where: "level:defaults label:claude" })\` → \`set({ id, warming: "on", interval: "4m" })\`.
6. Scaffold a team: \`create({ kind: "team", team, level: "project", preset: "basic" })\`.
7. Change every orchestrator: \`create({ kind: "entry", catalogue: "agents", name: "*orchestrator*", preset: "basic/orchestrator" })\` → \`list({ where: "level:defaults agent:orchestrator item:tool" })\` → \`set({ id, state: "off" })\`.
`


const teachingSkillDescription =
  "Read and write the Instructions tree: filter grammar, views, create/delete, and error meanings for tools.instructions.*."

function teachingSkillLocation(): string {
  return path.join(globalConfigDir(), "opencodeplus", "skills", teachingSkillId, "SKILL.md")
}

// Writes the seeded file only when it is missing, so a user edit is never
// overwritten. A concurrent seeder winning the race reads back their copy.
export async function seedSystemInstruction(): Promise<{ path: string; content: string }> {
  const file = teachingFilePath()
  const existing = await fs.readFile(file, "utf8").catch(() => undefined)
  if (existing !== undefined) return { path: file, content: existing }
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, teachingContent, { flag: "wx" }).catch(() => undefined)
  const content = await fs.readFile(file, "utf8").catch(() => teachingContent)
  return { path: file, content }
}

// Registers the seeded file as a plugin instruction source (core keys its
// system part by the absolute path) and the skill beside it. Returns both
// registrations so the caller can dispose them together.
export async function installTeaching(ctx: Context): Promise<Registration[]> {
  const seeded = await seedSystemInstruction()
  const instruction = await runRegistration(ctx.instruction.transform, (editor) => {
    if (editor.list().some((file) => file.path === seeded.path)) {
      editor.update(seeded.path, (file) => {
        file.content = seeded.content
      })
      return
    }
    editor.add({ path: seeded.path, content: seeded.content })
  })
  const skill = await runRegistration(ctx.skill.transform, (editor) => {
    if (editor.get(teachingSkillId) !== undefined) {
      editor.update(teachingSkillId, (entry) => {
        entry.content = teachingSkillContent
      })
      return
    }
    editor.add(
      Skill.Info.make({
        id: Skill.ID.make(teachingSkillId),
        name: Skill.Name.make(teachingSkillId),
        description: teachingSkillDescription,
        path: AbsolutePath.make(teachingSkillLocation()),
        content: teachingSkillContent,
      }),
    )
  })
  return [instruction, skill]
}
