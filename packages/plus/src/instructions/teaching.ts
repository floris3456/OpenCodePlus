import type { Context } from "@opencode/plugin/effect/plugin"
import type { Registration } from "@opencode/plugin/effect/registration"
import { AbsolutePath } from "@opencode/schema/schema"
import { Skill } from "@opencode/schema/skill"
import fs from "node:fs/promises"
import path from "node:path"
import { runRegistration } from "./apply.js"
import { fingerprint } from "./model.js"
import { globalConfigDir, teachingFilePath, teachingSkillId } from "./paths.js"

export const teachingTitle = "OpenCodePlus"

// Per-session cost: roughly 100 tokens (under 600 characters). Names the tool
// namespace, the row-id shapes, find's row lines, the two happy flows, that
// create returns the row id its follow-ups take, the skill that carries the
// rest, and the permission pattern grammar. teaching.test.ts pins the
// character bound. When this text changes, add the sha256 of the text it
// replaces to shippedTeachings, so files still holding that text upgrade.
export const teachingContent =
  "`tools.instructions.*` edits agents/tools/base/skills/system/MCP/models/teams/perms. " +
  "Ids: `item:<level>:<agent|''>:<itemId>`, `section:…:<sectionId>`, `agent:<level>:<id>`, `team:<level>:<name>[:<member>]`. " +
  "`create` returns `{id,item}`; other ops take that `id`. `find` rows: `id | badges | from`. " +
  "`find({is:\"review\"})`→`read({id,view:\"diff\"})`→`set({id,resolve:\"keep\"})`. " +
  "`find({agent:\"X\",type:\"tool\"})`→`edit({id,oldString,newString})`. " +
  "Patterns are core wildcards, not regex; shell resource is the parsed command, so `git *` matches bare `git`. " +
  "More: skill `instructions-tools`."

// Detailed, on-demand guidance keeps the seed instruction within its size budget.
export const teachingSkillContent = `# instructions-tools

\`tools.instructions.*\` (Code Mode) reads and changes the Instructions tree: agent settings, models, compaction, tools, base prompts, skills, system rows, MCP servers, teams and members, and per-tool permission rules. Every write is logged with actor \`tool\`; \`log\` reads the history.

## Quick start

- Find rows: \`find({ agent: "alpha", type: "tool" })\` returns \`{ total, columns, rows }\`, one line per row: \`id | badges | from\`.
- Read one: \`read({ id })\` gives its \`text\` and where it comes from. On an agent or a group, \`read\` lists the rows under it.
- Change part of a text: \`edit({ id, oldString, newString })\`, like the edit tool for a file.
- Replace a whole text: \`set({ id, text })\`. Switch a row: \`set({ id, state: "off" })\`. Undo at this level: \`reset({ id })\`.
- Pass ids exactly as \`find\`, \`read\` or \`create\` returned them.
- Several rows in one call: \`id\` takes a list (\`set({ id: [a, b], state: "off" })\`), or \`find\` takes find's filters instead of \`id\` (\`set({ find: { agent: "alpha", type: "rule", where: "tool:edit" }, state: "off" })\`). \`read\`, \`set\`, \`edit\`, \`reset\` and \`delete\` then answer \`{ total, failed, results }\` with one \`{ id, output }\` or \`{ id, error }\` per row, and every row that succeeded stays saved. Without \`agent\` or \`team\`, \`find\` reaches each agent's copy, the shared Defaults rows first; one call takes at most 200 rows.

## Row ids

- \`item:<level>:<owner>:<itemId>\`: a whole row, e.g. \`item:project:alpha:tool:reader\`. Item ids: \`tool:<id>\`, \`param:<tool>:<name>\`, \`base:<id>\`, \`system:<id>\`, \`skill:<id>\`, \`mcp:<name>\`, \`setting:<field>\`, \`compaction:<field>\`, \`perm:<tool>:<rule>\` (e.g. \`perm:shell:git-push\`), \`model:<provider>/<model>[@variant]\` (e.g. \`model:openai/gpt-5@high\`).
- \`section:…:<sectionId>\`: one section of a row; \`read({ id, view: "sections" })\` lists them.
- \`agent:<level>:<id>\`: an agent. \`team:<level>:<name>\`: a team; \`team:<level>:<team>:<member>\`: one member.
- \`group:…\`: a group of rows (Tools, Models, Skills, Settings…); \`set({ id, state })\` on it switches every row in it.
- \`<level>\` is \`project\`, \`global\`, \`defaults\` or \`preset\` (the Presets root). \`<owner>\` is the agent id, \`<team>/:<member>\` for a team member's row, \`''\` for the Agents catalogue's shared Defaults row (\`item:defaults::tool:reader\`) and \`/teams\` for the Teams one (\`item:defaults:/teams:tool:reader\`).
- Defaults › Models rows: \`item:defaults:/models:modeldefault:*\` (every model) and \`…:modeldefault:<provider>/<model>\`; their fields are \`item:defaults:/models:modelsetting:<field>:<* or provider/model>\`. A model row's fields are the \`modelfield:<field>:<provider>/<model>[@variant]\` rows under it.
- Model rows sit in built-in groups per provider and AI lab: \`<Models group id>:provider=<provider>\` and \`…:provider=<provider>:lab=<lab>\`, e.g. \`group:project:build:models:provider=opencode:lab=claude\` (\`find({ type: "group", in: "group:project:build:models" })\` lists them); row ids do not change.

## Where a value comes from

An agent behaves exactly as its rows say; nothing is read from its name. A row it does not set comes, in order, from its own levels (project, global, defaults), its **preset** (linked, live), the **Defaults entries** matching its name, Defaults "for every agent", and last the fallback: OpenCode agents and agent-owned rows keep their upstream value, other tool and instruction rows are **off**; settings and compaction keep the configuration's values. No preset means unlinked, not exempt from Defaults. A value equal to what the row inherits is no edit: setting it stores nothing (it removes the row's own copy), and one stored earlier stops counting. \`from\` says it in words: "set here", "from preset Basic › orchestrator", "from default *orchestrator*", "from Defaults (every agent)", "OpenCode", "off by default".

- Presets: \`agent:preset:<id>\` (OpenCode: build, plan, general, explore, title; User: yours) and team presets \`team:preset:<team>\` with member presets \`team:preset:<team>:<member>\`. Plus ships the team preset \`basic\` (planner, orchestrator, implementer, reviewer, scout, build-seat). Shipped presets' rows are editable; the presets cannot be deleted.
- Name a preset \`"<id>"\` (agent preset) or \`"<team>/<member>"\` (member preset, e.g. \`"basic/planner"\`); a team takes a team preset id. \`set({ id, preset })\` links an agent, member, team, entry or user preset (live); \`preset: null\` unlinks.
- Defaults entries match agents by exact name or pattern (\`*\` or \`%\` = any text, ignoring case): \`agent:defaults:<name>\` for agents, \`team:defaults:<team pattern>:<name>\` for team members. An exact name beats a pattern.
- Catalogues: a stand-alone agent inherits the Agents catalogue's shared Defaults rows; a team member inherits the Teams catalogue's, then its team's, then its own.

## find

\`find({ agent?, team?, level?, type?, name?, in?, state?, text?, is?, where?, fields?, sort?, limit?, offset? })\`: every parameter given must match; \`limit\` defaults to 40. It returns \`{ total, columns, rows }\`: each row is one line in the order of \`columns\`, by default \`id | badges | from\`, with \`-\` for an empty value, so \`row.split(" | ")[0]\` is its id. \`fields\` picks the columns after \`id\`: \`label\`, \`badges\`, \`from\`, \`source\`, \`tokens\`, \`text\`, \`upstream\`, \`record\`, \`path\`, \`updated\`, \`sections\`.

- \`agent\`: an agent or team member by name, ignoring case; \`*\` stands for any text; \`_\` is the shared rows. \`team\`: a team's rows and its members'.
- \`type\`: agent, team, member, preset, entry, tool, param, rule, skill, system, base, model, setting, compaction, mcp, section or group.
- \`name\`: a row's own name (\`reader\`, \`git-push\`, \`role\`, a section's name), ignoring case; \`*\` stands for any text.
- \`level\`: project, global, defaults or preset. \`in\`: only the rows under that row id (its sections, a tool's parameters and rules).
- \`state\`: on or off. \`text\`: the text contains it, ignoring case.
- \`is\`: rows holding an edit. \`review\`: what it was based on changed since (see Review); \`changed\`: any (\`reset\` drops it); \`overruled\`: an agent's edit a more specific level sets too, so it never applies; \`orphaned\`: its row is gone. And \`held-back\`: rows and sections that are on, but the agent does not get them because their "shown when" does not hold; \`badges\` names what it needs (\`held back (needs tool:shell on)\`).

One row per thing: a row appears once, at its most specific level (what runs here); \`level\` picks another. Without \`agent\` or \`team\`, agents' copies with the same on/off and text are one row whose \`from\` ends \`(+N agents)\`; \`agent: "*"\` lists each. Sections appear only with \`type: "section"\`, \`name\`, \`in\` or \`is: "held-back"\` (a text match shows on the item row), preset rows only with \`level\` or \`type\` \`preset\`. \`is\` keeps every level's own edit (\`held-back\`: one row per thing, like a plain find).

\`where\` adds terms in the Instructions filter's language (the parameters are these terms too): \`key:value\` terms are ANDed; \`!key:value\` negates one; \`a,b\` is OR within one key; \`key:"two words"\` quotes a value; a bare word matches label or id, ignoring case; \`key:>7d\` and \`key:<N\` compare ages and counts. More keys: \`tool\` (a tool's own rows: the tool, its parameters and rules), \`group\` (native|plus|mcp|project|none), \`server\`, \`namespace\`, \`catalogue\` (agents|teams), \`modified\`, \`review\`, \`source\`, \`overridden\`, \`active\`, \`inactive\`, \`unsupported\`, \`codemode\`, \`pinned\`, \`execute\`, \`can\`, \`has\`, \`id\` (an id prefix; every level and section), \`label\`, \`updated\`, \`acked\`, \`excluded\`; slower, reading row text: \`shadowed\`, \`orphan\`, \`dead\`, \`identical\`, \`tokens\`, \`delta\`, \`overriders\`, \`upstream\`.

The TUI filter takes the same terms (\`agent:build type:tool state:off\`) and shows every match in the tree; the CLI takes the parameters as flags (\`opencodeplus instructions find --agent build --type tool --state off\`).

## read

\`read({ id, view? })\`, \`view\` defaults to \`resolved\`: the row's \`text\` (a whole row includes its sections), \`enabled\` and \`from\`, plus \`assembled\` only when what reaches the model differs (a section off, a gate, a marker). On an agent, group or root, \`resolved\` lists the rows under it as \`id | badges | from\` lines. Other views: \`upstream\` (the text above yours), \`mine\` (your stored text), \`record\` (the raw override), \`sections\` (section ids), \`diff\` (original→mine and original→upstream unified diffs, a summary and merge units) and \`assembled\` (an agent's whole prompt; \`agent:\` ids at project, global or defaults only). A perm row shows its \`patterns\`, \`keywords\`, refusal \`message\` and the prompt lines it would scrub.

## edit

\`edit({ id, oldString, newString, replaceAll? })\` changes part of a row's text the way the edit tool changes a file. \`oldString\` must match the current text (\`read\`'s \`text\`) exactly once: add context to make it unique, or pass \`replaceAll: true\` to replace every match. Typographic quotes, dashes and spaces, and spaces at line ends, still match. It saves like \`set({ id, text })\` with the result (the same permissions, sections and review handling) and returns \`{ id, status, replacements }\`. A whole row's text includes its sections, so one edit can reach any of them. Rows without text (models, rules, teams, groups) change with \`set\`.

## set and reset

\`set({ id, text?, state?, pin?, active?, resolve?, warming?, interval?, waiting?, subagent?, prompt?, effort? })\` changes one row, or several (Quick start).

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
- Field rows \`modelfield:<field>:<provider>/<model>[@variant]\` (model, effort, warming, interval, waiting, subagent, prompt and the compaction fields below) take \`text\` (empty inherits); \`reset\` clears just that field.
- \`subagent\` (Warm as subagent) is \`off\`, \`on\` or its own time (1m–24h such as \`15m\`, rounded up to whole intervals), empty inherits; built-in off. It resolves from the agent's model row through Defaults › Models › this model, then Every model; \`on\` keeps the time below it, else the warming time. When on, sessions with a parent warm for that time with this tab's interval, waiting time and prompt, independently of \`warming\`. The chat's own on/off switch wins. Top-level chats and team members are unaffected.
- Keep-alive: \`warming\` (\`off\`, \`on\`, or 1m–24h such as \`45m\` or \`2h\`, rounded up to whole intervals), \`interval\` (30s–24h, e.g. \`4m\`), \`waiting\` (warm while waiting: while a chat waits on its own work — a running command or tool, a subagent, a team run — it stays warm at least this long when warming is on for it; \`off\` or 1m–24h, built-in \`2h\`) and \`prompt\` (the keep-alive text); empty inherits. With nothing set, warming is on for Claude and the models CLIProxyAPI serves through Antigravity (every 4m for 25m, 28m in whole intervals) and GPT-5.6 and later (every 25m for 1h40m) and off for other models. A Defaults › Models row also takes \`effort\` (the default variant) and \`state on|off\` for its warming switch; \`read\` gives each effective value and its source.

## Per-model compaction and images

Compaction, warming and the cold-cache list are model settings at any level; editing them does not itself rewrite an existing chat's prompt prefix — the next actual compaction does. Model and Defaults › Models rows take these typed \`set\` fields; null inherits:

- \`compactWarm\` (\`on\`|\`off\`): the model's default "Compact before cold". Each chat has its own switch (\`/compact-warm\`, \`<leader>j\`).
- \`coldFirst\` (\`on\`|\`off\`): "Compact cold chats first" for this model, overriding Settings › OpenCodePlus › Compact cold chats first (only the person sets that one) for chats on it, e.g. \`off\` for a cheap model. Where no row sets it, the row reads "as in Settings" and the global switch decides.
- \`coldModels\`: an ordered array (\`["a/one#high", "b/two"]\`) or a comma list; \`[]\` turns the list off. With Compact cold chats first on for the chat (its model's \`coldFirst\`, else the Settings switch), a step into a cold cache (a new message, or a running agent whose cache went cold) is first summarized by the chat model's list (#1 writes, #2… fall back), then the agent carries on. \`coldCompact\` is refused: the per-model cold switch is \`coldFirst\`. The list is a group: no \`modelsetting:coldModels\` field row is emitted.
- \`compactionStrategy\`: \`auto\`, \`local\` or \`remote\`. \`compactionModel\`: \`provider/model[#variant]\`. \`compactionInstructions\`: the summary prompt; \`""\` is an explicit empty summary prompt, unlike the other fields where \`""\` just clears the override, and \`reset\` resumes inheritance.
- \`compactionInput\` / \`compactionOutput\`: early compaction thresholds in tokens (positive whole numbers as strings), or \`"off"\` to suppress an inherited one.
- \`imageConvert\` (\`webp-90\` default, \`webp-75\`, \`webp-lossless\`, \`original\`), \`imageShrink\` (the longest edge in pixels, 256–65535, default \`2000\`) and \`imagesFull\` (\`compact\` default, \`leave-out\`, \`error\`) apply to images that arrive afterwards.
- Resolution: the agent's model row chain, then Defaults › this model, Every model and the built-in value; strategy, model and instructions also read the agent-wide \`compaction:*\` rows after the model chain, and Defaults for every agent before the built-in.

## Permission rules

\`perm:<tool>:<rule>\` rows hang under each tool (\`find({ type: "rule", where: "tool:shell" })\`). \`set({ id, state: "off" })\` refuses what the rule matches for that agent and scrubs matching lines from its prompts; \`set({ id, message })\` sets the refusal the model reads; \`label\`, \`patterns\` and \`keywords\` rewrite the rule. \`create({ kind: "rule", tool, id, label, patterns, keywords?, message?, level?, agent? })\` adds one (no \`agent\`: a shared Defaults rule); only user-created rules delete. Definitions are per owner: editing an inherited one makes a local copy. \`edit\` is decided by \`set\`'s rows (Rows it may change, Override text, approval).

A rule row that is off refuses what it matches, whether a level turned it off or nothing sets it: a member with no preset starts with every rule off ("off by default"), so its shell runs no command until \`perm:shell:commands.*\` (Every other command) is on, and its other rules (\`perm:shell:git\`, \`perm:read:git\`, …) refuse until they are on. A rule you \`create\` is a deny-list row: on, it refuses nothing — except a shell rule whose id starts with \`allow.\` (\`create({ kind: "rule", tool: "shell", id: "allow.<name>", … })\`), which is an allow row of Commands: while \`perm:shell:commands.*\` (Every other command) is off, it lets exactly its patterns through while it is on, and the rows that are off (git, rm, …) still refuse inside it. Patterns match the whole command, so a wrapper such as \`timeout *\` lets through any command run under it. Every refusal ends with the row that refused it, as \`(denied by <row id> "<label>": <state>, <where the state comes from>)\`; \`set\` that id to change it.

Patterns are core wildcards, not regex: \`*\` is any run (including spaces), \`?\` one character. For shell the resource is the parsed command, so \`git *\` also matches a bare \`git\`; for file tools the path (\`*.env*\`, \`**/.git/**\`); for opencode_fetch (permission \`webfetch\`) the URL; for subagent and skill the exact id. A \`team_*\` tool row that is off refuses the call.

## Review

A row whose upstream changed under your text is to review (\`find({ is: "review" })\`). \`read({ id, view: "diff" })\` gives \`mineDiff\`, \`upstreamDiff\`, a \`summary\` and \`merge: { units, text }\`: each unit is \`{ id, kind, yours, upstream, base, included }\` with \`kind\` \`yours\`, \`upstream\`, \`both\` or \`same\`; a \`both\` unit has a second id \`<id>:upstream\`, excluded by default. Then:

- \`set({ id, resolve: "keep" })\` keeps your text, \`resolve: "take"\` follows upstream, and \`resolve: "edit"\` with \`text\` stores new text against upstream;
- \`set({ id, resolve: "merge", include: [unit ids] })\` saves that merge (no \`include\` = the defaults; a merge equal to upstream is a take). A merge takes \`include\`, not \`text\`.

Texts compare without their final newline, and units without trailing whitespace.

## System order, sections, links, folders

- An owner's System list is its system prompt in the order the model receives it: Tools first, then Role/persona with the Base group, OpenCode's parts (\`system:opencode/*\`), OpenCodePlus, Tools and rules, and the System rows. \`move({ id, before | after })\` reorders a part for that owner; OpenCode's parts move but are not edited. An agent without its own order uses the first one down its chain. AGENTS.md files are rows under \`system:opencode/agents-md\`, switched or edited per agent. Model prompts \`system:model/<id>\` are sent right after the base prompt to the models their patterns name: \`create({ kind: "system", id, title, text, models: ["*opus-5-5*"] })\`.
- Instructions that belong to a tool, skill or rule go in \`system:tools-and-rules\`, one section per row, with a \`<!-- requires: … -->\` line under the heading so they follow that row.
- \`split({ id, boundaries?, add? })\`: \`boundaries\` \`[{ id, name, start }]\` sets manual sections by character offset; \`add: { name, text }\` appends one. \`move\` on a section reorders it within its item.
- \`link({ id, target?, type?, enabled? })\`: without \`target\` it lists the row's links; with it, stores one: \`either\` (turning one on switches the other off), \`shownWhenOn\` / \`shownWhenOff\` (the target is sent only while \`id\` is on / off). \`enabled: false\` masks the pair at this level.
- Folders are display only: \`create({ kind: "folder", name, id: "<tab or folder row id>" })\`, \`set({ id, rename })\`, \`move({ id, into | before | after })\`, \`delete({ id, confirm: true })\`. A tab without folders and order of its own shows the first ones down its chain (preset, Defaults, Global); its first change copies them. When they change above after that, the tab is to review (layout): \`set({ id: "<tab id>", resolve: "keep" })\` keeps yours, \`"take"\` drops yours.

## create and delete

\`create({ kind, ...fields })\` makes one row and returns \`{ id, item }\`; pass that \`id\` to \`read\`, \`set\`, \`edit\` and \`delete\`.

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
| \`row.unknown\` | no row has that id: \`find\` again (for a member-only agent's model row the message names the member row to use) |
| \`agent.protected\` | that agent is in \`protectedAgents\` |
| \`delete.unconfirmed\` | retry with \`confirm: true\` |
| \`view.unsupported\` | that view needs another kind of row |
| \`create.failed\` | written, but the row is not listed yet: \`find\` before retrying, or you may create it twice |
| \`rename.invalid\` | built-ins, shipped Defaults rows, ancestor-backed agents and presets cannot be renamed |
| \`preset.invalid\` / \`preset.exists\` / \`preset.readonly\` / \`preset.inUse\` | no such preset or the wrong kind / it exists / shipped / still linked from the rows named |
| \`entry.invalid\` / \`entry.exists\` / \`entry.missing\` | bad name (no \`:\`) / duplicate / no such entry |
| \`link.invalid\` / \`link.cycle\` | the row takes no link / the link would loop back |

## Examples

1. Reword one sentence of a tool for one agent: \`find({ agent: "alpha", type: "tool", name: "read" })\` → \`edit({ id, oldString: "Reads a file.", newString: "Reads one file at a time." })\`.
2. Switch a skill off for one agent, then undo: \`find({ agent: "alpha", type: "skill" })\` → \`set({ id, state: "off" })\` → \`reset({ id })\`.
3. Work the review queue: \`find({ is: "review" })\` → \`read({ id, view: "diff" })\` → \`set({ id, resolve: "keep" })\`.
4. Switch an agent's model: \`find({ agent: "alpha", type: "model" })\` → \`set({ id, active: true })\`.
5. Warm Claude chats: \`find({ level: "defaults", type: "model", name: "*claude*" })\` → \`set({ id, warming: "on", interval: "4m" })\`.
6. Scaffold a team: \`create({ kind: "team", team, level: "project", preset: "basic" })\`.
7. Change every orchestrator: \`create({ kind: "entry", catalogue: "agents", name: "*orchestrator*", preset: "basic/orchestrator" })\` → \`find({ level: "defaults", agent: "*orchestrator*", type: "tool" })\` → \`set({ id, state: "off" })\`.
8. See what anyone changed: \`find({ is: "changed" })\`; one tool's rows for one agent: \`find({ in: "<the tool row's id>" })\`.
`


const teachingSkillDescription =
  "Read and write the Instructions tree: filter grammar, views, create/delete, and error meanings for tools.instructions.*."

function teachingSkillLocation(): string {
  return path.join(globalConfigDir(), "opencodeplus", "skills", teachingSkillId, "SKILL.md")
}

// sha256 of every text an earlier release seeded. A file that still holds one
// was never edited, so seeding replaces it with the current text.
const shippedTeachings = new Set([
  "1d77592a056350239f81bdaa26dff07c424ee1848079031ba3aa907f71cf38c7",
  "cf8b591da8f65f450a16fe3a88a3fab4930da657026dfb3df5770cf3847ff759",
  "bf1782c5fb87716b2b5c8deba7c42760ecf613c26eb074531e41d96c87ba6bac",
  "9c401ae7e9375d0b8bef100809dfb93d88acdcdbbaa8837e6942643d29aa6150",
  "73e3c7ec25cdb2989b528453df09b679010d3fb4c1a6bb83465f38a7f852211e",
  "41b743f3c37a58fb1d77abc281a2c6198bf78718fd58879651005699c329d2fa",
  "ca2b4a5a3ec9bae7ee351dbb2a07152d7d5aa664d52cc662c52354c687e07003",
  "1cb80951995e864265e42549828092fd513b264814d5dbed58925bdeaf552255",
  "7b50e656566129528b31d92e681a2097212f133263f652fe0f947d563a323c8d",
])

// Writes the seeded file when it is missing or still holds a text an earlier
// release seeded, so a user edit is never overwritten. A concurrent seeder
// winning the race reads back their copy.
export async function seedSystemInstruction(): Promise<{ path: string; content: string }> {
  const file = teachingFilePath()
  const existing = await fs.readFile(file, "utf8").catch(() => undefined)
  if (existing !== undefined && !shippedTeachings.has(fingerprint(existing))) return { path: file, content: existing }
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, teachingContent, existing === undefined ? { flag: "wx" } : {}).catch(() => undefined)
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
