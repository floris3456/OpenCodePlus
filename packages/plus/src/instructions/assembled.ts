import type { Context } from "@opencode/plugin/effect/plugin"
import type { Transform } from "@opencode/plugin/effect/registration"
import type { Agent } from "@opencode/schema/agent"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import { Deferred, Effect } from "effect"
import { copyName } from "./apply.js"
import { resolve, type CustomizationRecord, type Item, type Level, type Scopes, type SplitRecord } from "./model.js"
import type { Plus } from "../rpc.js"

interface AssembledInput {
  readonly ctx: Context
  readonly agent: string
  readonly items: readonly Item[]
  readonly agents: readonly { readonly id: string; readonly level: Level }[]
  readonly records: readonly CustomizationRecord[]
  readonly splits: readonly SplitRecord[]
  readonly scopes: Scopes
}

// Assembled view for one agent: the agent's installed system text read back
// from the host (agent transforms are registry-level, so agent.list reflects
// application), plus the skill and tool domains filtered to what this agent
// can use. Tool descriptions are a registry-level read: per-agent tool text
// installs through a session context hook, which is session-scoped for a
// specific agent, so assembled reports the registry (upstream) description
// even when the override applies correctly inside that agent's sessions.
// Tool membership reflects resolved enablement and registry visibility.
export async function assembled(input: AssembledInput): Promise<Plus.Assembled | { ok: false; agent: string }> {
  const owner = input.agents.find((entry) => entry.id === input.agent)
  if (owner === undefined) return { ok: false, agent: input.agent }
  const addressOf = (item: Item) => ({ level: owner.level, agent: owner.id, item: item.id, section: null })
  const resolved = new Map(input.items.map((item) => [item.id, resolve({
    upstream: item,
    records: input.records,
    splits: input.splits,
    scopes: input.scopes,
    address: addressOf(item),
  })]))
  const system = await readSystem(input.ctx, input.agent)
  const tools = await listTools(input.ctx)
  const visibleTools = input.items
    .filter((item) => item.kind === "tool")
    .flatMap((item) => {
      const state = resolved.get(item.id)
      if (state === undefined || !state.enabled) return []
      const live = tools.get(item.id.slice("tool:".length))
      if (live === undefined) return []
      return [{ id: live.id, description: live.description }]
    })
  const skills = await listSkills(input.ctx)
  const visibleSkills = input.items
    .filter((item) => item.kind === "skill")
    .flatMap((item) => {
      const state = resolved.get(item.id)
      if (state === undefined || !state.enabled) return []
      const id = item.id.slice("skill:".length)
      // Prefer the agent's private copy: Plus never removes the original from
      // the registry, it only denies it for that agent and allows the
      // plus/<agent>/<skill> copy, so reading the original first would always
      // win and the copy would never be consulted.
      const current = skillContent(skills, input.agent, id)
      if (current === undefined) return []
      return [{ id, content: current }]
    })
  return { agent: input.agent, system, tools: visibleTools, skills: visibleSkills }
}

async function readSystem(ctx: Context, agent: string): Promise<string[]> {
  const output = await Effect.runPromise(ctx.agent.list())
  const current = output.data.find((entry) => String(entry.id) === agent) as Agent.Info | undefined
  if (current?.system === undefined) return []
  return [current.system]
}

async function listTools(ctx: Context): Promise<Map<string, { id: string; description: string }>> {
  return readTransform(ctx.tool.transform, (editor: ToolEditor) => {
    const live = new Map<string, { id: string; description: string }>()
    for (const tool of editor.list()) live.set(tool.id, { id: tool.id, description: tool.description })
    return live
  })
}

async function listSkills(ctx: Context): Promise<Map<string, string>> {
  const output = await Effect.runPromise(ctx.skill.list())
  return new Map(output.data.map((skill) => [String(skill.id), skill.content]))
}

// Prefer the agent's private copy: Plus never removes the original from the
// registry, it only denies it for that agent and allows the
// plus/<agent>/<skill> copy, so reading the original first would always win
// and the copy would never be consulted. When no copy exists, report the
// registry original: that is what the host holds. A missing copy alongside a
// customization means the customization is not live (apply never ran, failed,
// or skipped it); returning the local projection here would conflate saved
// with loaded. Discovery excludes copies from inventory
// (packages/plus/src/instructions/discover.ts:285 backed by isSkillCopyId at
// :380-382), but that filter never touches this readback: ctx.skill.list()
// returns the full registry including installed copies (core/src/skill.ts
// :123-125), so a missing copy is genuinely absent, not a view limitation.
function skillContent(skills: ReadonlyMap<string, string>, agent: string, id: string): string | undefined {
  const copy = skills.get(copyName(agent, id))
  if (copy !== undefined) return copy
  return skills.get(id)
}

function readTransform<Editor, Value>(transform: Transform<Editor>, read: (editor: Editor) => Value): Promise<Value> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const deferred = yield* Deferred.make<Value, never>()
        yield* transform((editor) => {
          Deferred.doneUnsafe(deferred, Effect.succeed(read(editor)))
        })
        return yield* Deferred.await(deferred)
      }),
    ),
  )
}
