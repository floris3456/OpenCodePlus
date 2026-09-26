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
// namespace, the row-id shapes, the two happy flows, that create returns the
// row id its follow-ups take, the skill that carries the rest, and the
// permission pattern grammar. teaching.test.ts pins the character bound.
export const teachingContent =
  "`tools.instructions.*` edits agents/tools/base/skills/system/MCP/models/teams/perms. " +
  "Ids: `item:<level>:<agent|''>:<itemId>`, `section:…:<sectionId>`, `agent:<level>:<id>`, `team:<level>:<name>[:<member>]`. " +
  "`create` returns `{id,item}`; `show`/`set`/`delete` take that `id`. " +
  "`list({where:\"review:true\"})`→`show({id,view:\"diff\"})`→`set({id,resolve:\"keep\"})`. " +
  "`list({where:\"agent:X item:tool\"})`→`set({id,text})`. " +
  "Patterns are core wildcards, not regex; shell resource is the parsed command, so `git *` matches bare `git`. " +
  "Skill `instructions-tools`: filters, views, presets, create/delete, errors."

// Detailed, on-demand guidance keeps the seed instruction within its size budget.
export const teachingSkillContent = `# instructions-tools

Read and write the Instructions tree through \`tools.instructions.*\` (namespace \`instructions\`, all Code Mode). Rows cover agent settings, compaction, tools, base prompts, skills, system files, MCP servers, models, teams and their members, and per-tool permission rules. Every successful write is logged with actor \`tool\`; inspect history with \`log\`.

## Row ids

- \`item:<level>:<owner>:<itemId>\` — a whole row, e.g. \`item:project:alpha:tool:reader\`. Model rows use \`model:<provider>/<model>[@variant]\`, e.g. \`item:project:alpha:model:openai/gpt-5@high\`. Permission rows use \`perm:<tool>:<rule>\`, e.g. \`item:project:alpha:perm:shell:git-push\`.
- \`section:…:<sectionId>\` — one section inside a row; list exact ids with \`show({ id, view: "sections" })\`.
- \`agent:<level>:<id>\` — one agent's subtree. Only project/global/defaults agent ids accept \`view: "assembled"\`.
- \`team:<level>:<name>\` — one team; \`team:<level>:<team>:<member>\` — one member of it.

\`<level>\` is \`project\`, \`global\`, \`defaults\`, or \`preset\` (the Presets root).

## Presets, Defaults entries and links

An agent behaves exactly as its rows say; nothing is read from its name. What a row does not set comes, in order, from the agent's own levels, its **preset** (the one it is linked to, live), the **Defaults entries** matching its name, Defaults "for every agent", and last the fallback: OpenCode agents keep their upstream value, everything else is **off**. \`show\` answers \`from\` in words ("from preset Orchestrator", "from default *orchestrator*", "from Defaults (every agent)", "OpenCode", "off by default"); \`list({ fields: ["id", "from"] })\` projects it.

- Presets live under the Presets root: \`agent:preset:<id>\` (OpenCode: build, plan, general, explore, title, summary, compaction; Plus: planner, orchestrator, implementer, reviewer, scout, build-seat; User: yours) and team presets \`team:preset:<team>\` (Plus or User only) with member presets \`team:preset:<team>:<member>\`. OpenCode and Plus presets ship with the release: their rows are editable (your edits win), the presets themselves cannot be deleted. Their rows are not an agent's, so \`protectedAgents\` does not guard them.
- Name a preset as \`"<id>"\` (an agent preset) or \`"<team>/<member>"\` (a member preset), or as \`{ kind: "agent", id }\` / \`{ kind: "member", team, id }\`; a team takes a team preset id.
- Defaults entries are rows named by an exact name or a pattern: \`*\` and \`%\` match any text, case-insensitively, on the whole name (\`*orchestrator*\` matches \`Opus-Orchestrator-max\`). Agents entries are \`agent:defaults:<name>\` (Defaults → Agents → User); Teams entries are \`team:defaults:<team pattern>:<name>\` and match a member of a matching team. An exact name beats a pattern, then more literal characters win.
- \`set({ id, preset })\` on an agent, member, team, entry or user preset row links it (live); \`preset: null\` unlinks. A preset that would come back to itself is refused (\`link.cycle\`). A preset anything links to cannot be deleted (\`preset.inUse\` names who).
- A \`team_*\` tool row that is off refuses the call (core deny on \`team.<tool>\`), not only hides it.

## Catalogues

OpenCode → Special contains only the maintenance agents \`title\`, \`compaction\`, and \`summary\`. Hidden agents keep their origin; \`general\` and \`explore\` are ordinary OpenCode agents. The displayed OpenCode origin retains \`native\` in stored row ids, API discriminators, and \`group:native\` filters for compatibility.

The tree splits into two catalogues under every level: **Agents** and **Teams**. A stand-alone agent inherits only the Agents catalogue's shared Defaults rows; an agent launched as a team member inherits only the Teams catalogue's, then its team, then itself. \`<owner>\` names both the agent and the catalogue: the agent id or \`<team>/:<member>\` for a member's row, \`''\` for the Agents shared Defaults row (\`item:defaults::tool:reader\`) and \`/teams\` for the Teams one (\`item:defaults:/teams:tool:reader\`). Filter with \`catalogue:agents|teams\`. A member's row and its stand-alone row address the same record; only the shared tier they inherit differs.

## list

\`list({ where?, fields?, sort?, limit?, offset? })\` — \`limit\` defaults to 40. \`where\` terms are ANDed; \`!key:value\` negates one term; \`a,b\` is OR within a single key; a bare word matches case-insensitively over label or id; \`key:>7d\` and \`key:<N\` compare ages and counts.

Structural keys: \`kind\` (root|group|agent|team|item|section), \`item\` (tool|base|skill|system|mcp|model|perm|setting|compaction), \`tool\` (shell|edit|read|webfetch|subagent|skill), \`group\` (native|plus|mcp|project|none), \`server\`, \`namespace\`, \`level\` (project|global|defaults|preset), \`catalogue\` (agents|teams), \`agent\` (case-insensitive substring, \`_\` is the shared row), \`state\` (on|off), \`modified\`, \`review\`, \`source\`, \`overridden\`, \`active\` (base template active for the agent's model, or the resolved active model on model rows), \`inactive\`, \`unsupported\`, \`codemode\`, \`pinned\`, \`execute\`, \`can\`, \`has\`, \`id\`, \`label\`, \`updated\`, \`team\`, \`acked\`, \`excluded\`.

Text-dependent keys (resolve row text; slower): \`shadowed\`, \`orphan\`, \`dead\`, \`identical\`, \`tokens\`, \`delta\`, \`overriders\`, \`text\`, \`upstream\`.

Permission rows hang directly off each OpenCode/Plus tool row (after its sections). Filter them with \`item:perm\` and \`tool:<id>\`, e.g. \`list({ where: "item:perm tool:shell" })\`. \`server:<name>\` matches a server's own \`mcp:<name>\` row as well as the rows under it, e.g. \`list({ where: "server:search" })\`.

## show

\`show({ id, view? })\` — \`view\` defaults to \`resolved\`. \`upstream\` is the text above your override, \`mine\` is your stored text, \`record\` is the raw override, \`sections\` lists section ids, \`diff\` returns two unified diffs (original→mine and original→upstream) plus a one-line summary, and \`assembled\` renders the full effective prompt (agent row ids only). On a perm row any view returns \`patterns\`, \`keywords\`, \`provenance\`, and a scrub preview (\`scrub.hidden\` lines would drop, \`scrub.preview\` shows up to 3).

## set and reset

Agent and member rows accept \`set({ id, state: "off" })\` / \`"on"\` without deleting the agent, and \`set({ id, mode: "primary" })\` / \`"subagent"\` / \`"all"\`. Off agents remain editable in Instructions but cannot execute. Authoritatively config-disabled agents are not recreated. On an agent or member row, \`reset({ id })\` clears only its nine agent/compaction controls at that level; its other instruction overrides remain.

\`set({ id, text?, state?, pin?, active?, resolve? })\` (or \`set({ id, preset })\` to relink, above) — \`state\` is \`on\`|\`off\`; \`pin\` is \`true\`|\`false\` for Code Mode tools; \`active\` is \`true\` to activate a model row exclusively at that level; \`resolve\` is \`keep\` (ack upstream, keep text), \`take\` (drop your text, follow upstream), or \`edit\` (store \`text\` against current upstream). \`reset({ id })\` deletes the override at that row (model rows clear only that level's active flag). On perm rows \`state\` toggles the rule (off installs core deny rules for that agent only); \`message\` (or \`label\`/\`patterns\`/\`keywords\`) edits the rule; perm rows accept no text, pin, or resolve.

Code Mode tools are live: \`off\` denies the tool id, stored text rewrites that agent's catalog entry (first description line only, truncated at 120 characters), and \`pin\` overrides the registry default; the synthetic \`tool:execute\` row is toggle-only and \`off\` removes Code Mode entirely. Filter them with \`namespace:<name>\`, \`pinned:true|false\`, and \`execute:true|false\`, e.g. \`list({ where: "codemode:true pinned:true" })\`.

Models are live: each agent subtree opens with a \`Models\` group holding the union down the chain plus the agent's upstream model. \`set({ id, active:true })\` (or bare \`set({ id })\`) activates one candidate exclusively at that level; \`reset({ id })\` clears that level's active flag; \`create({ kind:"model", providerID, modelID, variant?, level?, agent? })\` adds a candidate — \`level\` defaults to \`project\`, and \`project\` and \`global\` rows need \`agent\`; \`delete({ id, confirm:true })\` removes the candidate at that level. Filter with \`item:model\` and \`active:true|false\`.

Agent settings use \`item:<level>:<owner>:setting:<field>\`: \`enabled\` and \`hidden\` accept \`state\`; \`mode\`, \`description\`, \`color\`, and \`steps\` accept \`text\`. Mode is primary/subagent/all, color is six-digit #RRGGBB, steps is a positive integer; empty color/steps clear that field. Hidden changes discovery, not permissions. These controls use the same preset/Defaults/scope chain, but their fallback is the agent's configuration, not the off-by-default tool policy. They do not support sections or pins. Filter with \`item:setting\`.

Compaction rows are \`compaction:strategy\`, \`compaction:model\`, and \`compaction:instructions\`, all accepting \`text\`. Strategy is auto/local/remote. Auto follows the active model's policy; local uses the per-agent model (provider/model#variant), otherwise a configured maintenance compaction model, otherwise the active session model. Instructions inherit the maintenance compaction agent unless overridden; empty instructions explicitly clear the prompt, while Reset resumes inheritance. Remote uses provider capabilities and ignores local model/instruction values without discarding them; unsupported remote compaction fails explicitly. All scopes and agent/member presets support these rows. Filter with \`item:compaction\`.

Permission rules are live: turning a rule \`off\` installs core deny rules \`{ action, resource, effect: "deny" }\` for that agent only (appended; core evaluates last-match-wins) and scrubs matching lines from tool descriptions, system parts, the base part, and catalog descriptions. \`show\` on a perm row previews the scrub and displays any refusal \`message\`. \`create({ kind:"rule", tool, id, label, patterns, keywords?, message?, level?, agent? })\` adds a custom rule — \`level\` defaults to \`project\`, and a rule with no \`agent\` is shared: it displays as the canonical Defaults row \`item:defaults::perm:<tool>:<id>\` without changing where it is stored; \`delete({ id, confirm:true })\` removes only user-created rules. \`set({ id, message })\` updates the refusal message shown to the model. An agent may change its own rules; only \`protectedAgents\` (enforced again at the shared API boundary when the actor is a tool), \`confirm:true\`, and project mode guard writes.

Patterns are CORE WILDCARDS over the parsed command text — NOT regex. \`*\` spans any run (including empty and spaces), \`?\` matches exactly one character. For shell the resource is the parsed command text, so \`git *\` also matches a bare \`git\` (core rewrites a trailing " *" into an optional group). For file tools the resource is the file path (\`*.env*\`, \`**/.git/**\`); for webfetch the URL (\`*github.com*\`); for subagent/skill the exact agent/skill id. Keywords derive from the pattern (head plus subcommands, stopping at wildcards/flags: \`"git push *"\` scrubs lines mentioning "git push", not every "git" line).

## split

\`split({ id, boundaries?, add? })\` — \`boundaries\` is \`[{ id, name, start }]\` with character offsets into the row text; \`add: { name, text }\` appends a new trailing section. Perm rows cannot be split.

## create and delete

\`create({ kind, ...fields })\` — one row per call. Every enabled kind returns \`{ id, item, … }\`: \`id\` is the tree row id — the id \`show\`, \`set\`, and \`delete\` accept for that row — and \`item\` is the stored item id. Pass the returned \`id\` to follow-up calls rather than rebuilding it.

| kind | required fields |
| agent | \`id\` (+ optional \`scope\` project\|global, \`preset\`; no preset = tools off, not the agent itself) |
| skill | \`name\`, \`body\` |
| base | \`id\`, \`title\`, \`text\` |
| instruction | disabled: fails with \`instruction.disabled\` |
| mcp | \`name\`, \`config\` |
| team | \`team\`, \`level\` project\|global (+ optional \`preset\`, a team preset: its members are created, each linked to its member preset) |
| member | \`team\`, \`level\` project\|global\|defaults, \`id\` (+ optional \`preset\`; at defaults \`team\` and \`id\` are patterns and it adds a Teams entry) |
| entry | \`catalogue\` agents\|teams, \`name\` (+ \`team\` pattern for teams, optional \`preset\`) |
| preset | \`id\` (+ optional \`from\`, the agent or member preset it is linked to) |
| teamPreset | \`id\` (+ optional \`from\`, a team preset whose members are copied) |
| presetMember | \`team\` (a User team preset), \`id\` (+ optional \`from\`) |
| model | \`providerID\`, \`modelID\` (+ optional \`variant\`, \`level\` project\|global\|defaults\|preset, \`agent\`; \`level\` defaults to \`project\`, and project/global/preset rows need \`agent\`) |
| rule | \`tool\`, \`id\`, \`label\`, \`patterns\` (+ optional \`keywords\`, \`message\`, \`level\` project\|global\|defaults, \`agent\`; \`level\` defaults to \`project\`) |

Returned \`id\`s follow the row grammar above: \`item:<level>:<owner>:<itemId>\` for file, model, and rule rows; \`agent:<level>:<id>\` for an agent, an Agents entry or an agent preset; \`team:<level>:<team>\` for a team or team preset; \`team:<level>:<team>:<member>\` for a member, a Teams entry or a member preset. An agent or member file carries its preset's mode and description and an empty body; everything else follows the preset.

\`delete({ id, confirm: true })\` — refused without \`confirm: true\`; pass the \`id\` a \`create\` returned. Only user-created rules can be deleted; curated/mined rule rows refuse with why. Entries and User presets delete too (a Teams team-pattern row deletes all its member entries); a preset in use is refused.

## Guards and errors

- Only tool-actor writes are refused for agents listed in \`.opencodeplus/project.json\` \`protectedAgents\`; the refusal is enforced at the shared API boundary, not only in the tool wrapper, and \`instructions.mutate\` with a caller-supplied actor gets the same rule. TUI writes are unaffected.
- \`delete\` needs \`confirm: true\`.
- Project mode has no enable/disable tool.
- Every successful write is logged with actor \`tool\`.

| error | meaning |
| \`row.unknown\` | no row has that id; \`list\` again for the current id |
| \`create.failed\` | the write landed but its row is still missing from the published tree after a short watcher wait, so no id can be returned; \`list\` (or re-read the row) before retrying, because a blind retry can write a duplicate |
| \`instruction.disabled\` | \`create kind:"instruction"\` is disabled for now; OpenCode applies AGENTS.md files |
| \`agent.protected\` | that agent is in \`protectedAgents\` |
| \`delete.unconfirmed\` | retry with \`confirm: true\` |
| \`view.unsupported\` | that view needs another id kind (\`assembled\` needs an agent row) |
| \`agent.unknown\` | no agent has that id; \`list\` again for the current id |
| \`project.disabled\` | project mode is off and no tool changes that |
| \`preset.invalid\` | no preset answers to that name, or it is the wrong kind (an agent takes an agent or member preset, a team a team preset) |
| \`preset.exists\` | a preset of that kind already has that id |
| \`preset.readonly\` | OpenCode and Plus presets are not changed or deleted; create a User preset from one |
| \`preset.inUse\` | something is linked to the preset; relink or delete the listed rows first |
| \`entry.invalid\` / \`entry.exists\` / \`entry.missing\` | bad entry name (\`:\` is not allowed), a duplicate (same catalogue, team pattern and name, or an OpenCode agent's own Defaults row), or no such entry |
| \`link.invalid\` / \`link.cycle\` | the row takes no link, or the link would bring a preset back to itself |

## Examples

1. Work the review queue, keeping your text:
\`list({ where: "review:true" })\` → \`show({ id, view: "diff" })\` → \`set({ id, resolve: "keep" })\`.
2. Reword one tool for one agent:
\`list({ where: "agent:alpha item:tool" })\` → \`set({ id, text })\`.
3. Silence a noisy skill for one agent, then undo:
\`set({ id, state: "off" })\` → \`reset({ id })\`.
4. Edit a single section:
\`show({ id, view: "sections" })\` → \`set({ id: "section:…:publishing", text })\`.
5. Accept upstream after drift:
\`show({ id, view: "diff" })\` → \`set({ id, resolve: "take" })\`.
6. One \`execute\` updates three rows: acknowledge a review, reword a tool, and switch a server off — pass one \`set\` per row in the same call.
7. Grow the tree: \`create({ kind: "base", id, title, text })\` → \`split({ id: result.id, boundaries })\` → \`delete({ id: result.id, confirm: true })\`.
8. Switch an agent's model: \`list({ where: "agent:alpha item:model" })\` → \`set({ id, active:true })\` → \`reset({ id })\` to fall back.
9. Scaffold a team: \`create({ kind: "team", team, level: "project", preset: "starter" })\` creates the team preset's members, each linked; \`create({ kind: "member", team, level: "project", id, preset: "planner" })\` adds one member.
10. Give every orchestrator a setting: \`create({ kind: "entry", catalogue: "agents", name: "*orchestrator*", preset: "orchestrator" })\`, then \`list({ where: "level:defaults agent:orchestrator item:tool" })\` → \`set({ id, state: "off" })\`.
11. Relink an agent: \`set({ id: "agent:project:alpha", preset: "review/editor" })\`; \`set({ id, preset: null })\` unlinks.
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
        location: AbsolutePath.make(teachingSkillLocation()),
        content: teachingSkillContent,
      }),
    )
  })
  return [instruction, skill]
}
