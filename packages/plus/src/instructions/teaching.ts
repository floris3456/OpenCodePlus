import type { Context } from "@opencode/plugin/effect/plugin"
import type { Registration } from "@opencode/plugin/effect/registration"
import { AbsolutePath } from "@opencode/schema/schema"
import { Skill } from "@opencode/schema/skill"
import fs from "node:fs/promises"
import path from "node:path"
import { runRegistration } from "./apply.js"
import { globalConfigDir, teachingFilePath, teachingSkillId } from "./paths.js"

export const teachingTitle = "OpenCodePlus"

// Per-session cost: roughly 80 tokens (~350 characters). Names the tool
// namespace, the row-id shapes, the two happy flows, and the skill that
// carries the rest. teaching.test.ts pins the character bound.
export const teachingContent =
  "`tools.instructions.*` edits Instructions rows (tools/base/skills/system/MCP/teams). " +
  "Ids: `item:<level>:<agent|''>:<itemId>`, `section:…:<sectionId>`, `agent:<level>:<id>`, `team:<level>:<name>`. " +
  "`list({where:\"review:true\"})`→`show({id,view:\"diff\"})`→`set({id,resolve:\"keep\"})`. " +
  "`list({where:\"agent:X item:tool\"})`→`set({id,text})`. " +
  "Skill `instructions-tools`: filters, views, create/delete, errors."

// Roughly 1k tokens: the full filter grammar, every show view, create
// fields per kind, split boundaries, the error table, and worked examples.
export const teachingSkillContent = `# instructions-tools

Read and write the Instructions tree through \`tools.instructions.*\` (namespace \`instructions\`, all Code Mode). Rows cover tools, base prompts, skills, system files, MCP servers, and teams. Every successful write is logged with actor \`tool\`; inspect history with \`log\`.

## Row ids

- \`item:<level>:<agent|''>:<itemId>\` — a whole row, e.g. \`item:project:alpha:tool:reader\`. An empty agent segment addresses the shared Defaults row.
- \`section:…:<sectionId>\` — one section inside a row; list exact ids with \`show({ id, view: "sections" })\`.
- \`agent:<level>:<id>\` — one agent's subtree. Only these ids accept \`view: "assembled"\`.
- \`team:<level>:<name>\` — one team.

\`<level>\` is \`project\`, \`global\`, or \`defaults\`.

## list

\`list({ where?, fields?, sort?, limit?, offset? })\` — \`limit\` defaults to 40. \`where\` terms are ANDed; \`!key:value\` negates one term; \`a,b\` is OR within a single key; a bare word matches case-insensitively over label or id; \`key:>7d\` and \`key:<N\` compare ages and counts.

Structural keys: \`kind\` (tool|base|skill|system|mcp), \`item\`, \`group\` (native|plus|mcp|project|none), \`server\`, \`level\`, \`agent\` (\`_\` is the shared row), \`state\` (on|off), \`modified\`, \`review\`, \`source\`, \`overridden\`, \`active\`, \`inactive\`, \`unsupported\`, \`codemode\`, \`can\`, \`has\`, \`id\`, \`label\`, \`updated\`, \`team\`, \`acked\`, \`excluded\`.

Text-dependent keys (resolve row text; slower): \`shadowed\`, \`orphan\`, \`dead\`, \`identical\`, \`tokens\`, \`delta\`, \`overriders\`, \`text\`, \`upstream\`.

## show

\`show({ id, view? })\` — \`view\` defaults to \`resolved\`. \`upstream\` is the text above your override, \`mine\` is your stored text, \`record\` is the raw override, \`sections\` lists section ids, \`diff\` returns two unified diffs (original→mine and original→upstream) plus a one-line summary, and \`assembled\` renders the full effective prompt (agent row ids only).

## set and reset

\`set({ id, text?, state?, resolve? })\` — \`state\` is \`on\`|\`off\`; \`resolve\` is \`keep\` (ack upstream, keep text), \`take\` (drop your text, follow upstream), or \`edit\` (store \`text\` against current upstream). \`reset({ id })\` deletes the override at that row.

## split

\`split({ id, boundaries?, add? })\` — \`boundaries\` is \`[{ id, name, start }]\` with character offsets into the row text; \`add: { name, text }\` appends a new trailing section.

## create and delete

\`create({ kind, ...fields })\` — one row per call:

| kind | required fields |
| agent | \`id\`, \`prompt\` |
| skill | \`name\`, \`body\` |
| base | \`id\`, \`title\`, \`text\` |
| instruction | \`name\`, \`text\` |
| mcp | \`name\`, \`config\` |
| team | \`team\`, \`level\` |

\`delete({ id, confirm: true })\` — refused without \`confirm: true\`.

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
