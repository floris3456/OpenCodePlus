import type { Context } from "@opencode/plugin/effect/plugin"
import type { Registration } from "@opencode/plugin/effect/registration"
import { AbsolutePath } from "@opencode/schema/schema"
import { Skill } from "@opencode/schema/skill"
import fs from "node:fs/promises"
import path from "node:path"
import { runRegistration } from "./apply.js"
import { globalConfigDir, teachingFilePath, teachingSkillId } from "./paths.js"

export const teachingTitle = "OpenCodePlus"

// Per-session cost: roughly 100 tokens (~450 characters). Names the tool
// namespace, the row-id shapes, the two happy flows, the skill that carries
// the rest, and the permission pattern grammar. teaching.test.ts pins the
// character bound.
export const teachingContent =
  "`tools.instructions.*` edits Instructions rows (tools/base/skills/system/MCP/models/teams/permissions). " +
  "Ids: `item:<level>:<agent|''>:<itemId>`, `section:…:<sectionId>`, `agent:<level>:<id>`, `team:<level>:<name>`. " +
  "`list({where:\"review:true\"})`→`show({id,view:\"diff\"})`→`set({id,resolve:\"keep\"})`. " +
  "`list({where:\"agent:X item:tool\"})`→`set({id,text})`. " +
  "Patterns are core wildcards, not regex; shell resource is the parsed command, so `git *` matches bare `git`. " +
  "Skill `instructions-tools`: filters, views, create/delete, errors."

// Roughly 1k tokens: the full filter grammar, every show view, create
// fields per kind, split boundaries, the error table, and worked examples.
export const teachingSkillContent = `# instructions-tools

Read and write the Instructions tree through \`tools.instructions.*\` (namespace \`instructions\`, all Code Mode). Rows cover tools, base prompts, skills, system files, MCP servers, models, teams, and per-tool permission rules. Every successful write is logged with actor \`tool\`; inspect history with \`log\`.

## Row ids

- \`item:<level>:<agent|''>:<itemId>\` — a whole row, e.g. \`item:project:alpha:tool:reader\`. An empty agent segment addresses the shared Defaults row. Model rows use \`model:<provider>/<model>[@variant]\`, e.g. \`item:project:alpha:model:openai/gpt-5@high\`. Permission rows use \`perm:<tool>:<rule>\`, e.g. \`item:project:alpha:perm:shell:git-push\`.
- \`section:…:<sectionId>\` — one section inside a row; list exact ids with \`show({ id, view: "sections" })\`.
- \`agent:<level>:<id>\` — one agent's subtree. Only these ids accept \`view: "assembled"\`.
- \`team:<level>:<name>\` — one team.

\`<level>\` is \`project\`, \`global\`, or \`defaults\`.

## list

\`list({ where?, fields?, sort?, limit?, offset? })\` — \`limit\` defaults to 40. \`where\` terms are ANDed; \`!key:value\` negates one term; \`a,b\` is OR within a single key; a bare word matches case-insensitively over label or id; \`key:>7d\` and \`key:<N\` compare ages and counts.

Structural keys: \`kind\` (root|group|agent|team|item|section), \`item\` (tool|base|skill|system|mcp|model|perm), \`tool\` (shell|edit|read|webfetch|subagent|skill), \`group\` (native|plus|mcp|project|none), \`server\`, \`namespace\`, \`level\`, \`agent\` (case-insensitive substring, \`_\` is the shared row), \`state\` (on|off), \`modified\`, \`review\`, \`source\`, \`overridden\`, \`active\` (base template active for the agent's model, or the resolved active model on model rows), \`inactive\`, \`unsupported\`, \`codemode\`, \`pinned\`, \`execute\`, \`can\`, \`has\`, \`id\`, \`label\`, \`updated\`, \`team\`, \`acked\`, \`excluded\`.

Text-dependent keys (resolve row text; slower): \`shadowed\`, \`orphan\`, \`dead\`, \`identical\`, \`tokens\`, \`delta\`, \`overriders\`, \`text\`, \`upstream\`.

Permission rows hang directly off each native/plus tool row (after its sections). Filter them with \`item:perm\` and \`tool:<id>\`, e.g. \`list({ where: "item:perm tool:shell" })\`.

## show

\`show({ id, view? })\` — \`view\` defaults to \`resolved\`. \`upstream\` is the text above your override, \`mine\` is your stored text, \`record\` is the raw override, \`sections\` lists section ids, \`diff\` returns two unified diffs (original→mine and original→upstream) plus a one-line summary, and \`assembled\` renders the full effective prompt (agent row ids only). On a perm row any view returns \`patterns\`, \`keywords\`, \`provenance\`, and a scrub preview (\`scrub.hidden\` lines would drop, \`scrub.preview\` shows up to 3).

## set and reset

\`set({ id, text?, state?, pin?, active?, resolve? })\` — \`state\` is \`on\`|\`off\`; \`pin\` is \`true\`|\`false\` for Code Mode tools; \`active\` is \`true\` to activate a model row exclusively at that level; \`resolve\` is \`keep\` (ack upstream, keep text), \`take\` (drop your text, follow upstream), or \`edit\` (store \`text\` against current upstream). \`reset({ id })\` deletes the override at that row (model rows clear only that level's active flag). On perm rows \`state\` toggles the rule (off installs core deny rules for that agent only); perm rows accept no text, pin, or resolve.

Code Mode tools are live: \`off\` denies the tool id, stored text rewrites that agent's catalog entry (first description line only, truncated at 120 characters), and \`pin\` overrides the registry default; the synthetic \`tool:execute\` row is toggle-only and \`off\` removes Code Mode entirely. Filter them with \`namespace:<name>\`, \`pinned:true|false\`, and \`execute:true|false\`, e.g. \`list({ where: "codemode:true pinned:true" })\`.

Models are live: each agent subtree opens with a \`Models\` group holding the union down the chain plus the agent's upstream model. \`set({ id, active:true })\` (or bare \`set({ id })\`) activates one candidate exclusively at that level; \`reset({ id })\` clears that level's active flag; \`create({ kind:"model", providerID, modelID, variant?, level?, agent? })\` adds a candidate; \`delete({ id, confirm:true })\` removes the candidate at that level. Filter with \`item:model\` and \`active:true|false\`.

Permission rules are live: turning a rule \`off\` installs core deny rules \`{ action, resource, effect: "deny" }\` for that agent only (appended; core evaluates last-match-wins) and scrubs matching lines from tool descriptions, system parts, the base part, and catalog descriptions. \`show\` on a perm row previews the scrub. \`create({ kind:"rule", tool, id, label, patterns, keywords?, level?, agent? })\` adds a custom rule; \`delete({ id, confirm:true })\` removes only user-created rules. An agent may change its own rules; only \`protectedAgents\`, \`confirm:true\`, and project mode guard writes.

Patterns are CORE WILDCARDS over the parsed command text — NOT regex. \`*\` spans any run (including empty and spaces), \`?\` matches exactly one character. For shell the resource is the parsed command text, so \`git *\` also matches a bare \`git\` (core rewrites a trailing " *" into an optional group). For file tools the resource is the file path (\`*.env*\`, \`**/.git/**\`); for webfetch the URL (\`*github.com*\`); for subagent/skill the exact agent/skill id. Keywords derive from the pattern (head plus subcommands, stopping at wildcards/flags: \`"git push *"\` scrubs lines mentioning "git push", not every "git" line).

## split

\`split({ id, boundaries?, add? })\` — \`boundaries\` is \`[{ id, name, start }]\` with character offsets into the row text; \`add: { name, text }\` appends a new trailing section. Perm rows cannot be split.

## create and delete

\`create({ kind, ...fields })\` — one row per call:

| kind | required fields |
| agent | \`id\`, \`prompt\` |
| skill | \`name\`, \`body\` |
| base | \`id\`, \`title\`, \`text\` |
| instruction | \`name\`, \`text\` |
| mcp | \`name\`, \`config\` |
| team | \`team\`, \`level\` |
| model | \`providerID\`, \`modelID\` (+ optional \`variant\`, \`level\`, \`agent\`) |
| rule | \`tool\`, \`id\`, \`label\`, \`patterns\` (+ optional \`keywords\`, \`level\`, \`agent\`) |

\`delete({ id, confirm: true })\` — refused without \`confirm: true\`. Only user-created rules can be deleted; curated/mined rule rows refuse with why.

## Guards and errors

- Writes are refused for agents listed in \`.opencodeplus/project.json\` \`protectedAgents\`.
- \`delete\` needs \`confirm: true\`.
- Project mode has no enable/disable tool.
- Every successful write is logged with actor \`tool\`.

| error | meaning |
| \`row.unknown\` | no row has that id; \`list\` again for the current id |
| \`agent.protected\` | that agent is in \`protectedAgents\` |
| \`delete.unconfirmed\` | retry with \`confirm: true\` |
| \`view.unsupported\` | that view needs another id kind (\`assembled\` needs an agent row) |
| \`agent.unknown\` | no agent has that id; \`list\` again for the current id |
| \`project.disabled\` | project mode is off and no tool changes that |

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
7. Grow the tree: \`create({ kind: "base", id, title, text })\`, then \`split({ id, boundaries })\`, and remove with \`delete({ id, confirm: true })\`.
8. Switch an agent's model: \`list({ where: "agent:alpha item:model" })\` → \`set({ id, active:true })\` → \`reset({ id })\` to fall back.
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
