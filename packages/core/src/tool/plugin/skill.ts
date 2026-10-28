export * as SkillTool from "./skill.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { ToolFailure } from "@opencode/ai"
import { Effect, Schema } from "effect"
import { FSUtil } from "@opencode/util/fs-util"
import { Skill } from "../../skill.js"
import { Permission } from "../../permission.js"

export const name = "skill"

export const Input = Schema.Struct({
  id: Skill.ID.annotate({ description: "The ID of an available skill or a skill explicitly referenced by the user" }),
})

export const Output = Schema.Struct({
  name: Skill.Name,
  directory: Schema.String,
  output: Schema.String,
})
export const description = [
  "Load a specialized skill's instructions and resources into the current conversation when the task at hand matches its description.",
  "",
  "The skill ID must match an available skill or a skill explicitly referenced by the user.",
].join("\n")

export const toModelOutput = Skill.toModelOutput

const unableToLoad = (name: string, error?: unknown) =>
  new ToolFailure({ message: `Unable to load skill ${name}`, error })

// A skill the agent's own rules deny is off for it: Plus installs one
// `{ action: "skill", resource: <id>, effect: "deny" }` per row a member has
// off, and the `<available_skills>` list is filtered by the same merged
// agent+Session rules (SkillInstructions.load). The tool resolves its id from
// the whole registry, so without this check it can load a skill the list told
// the model it does not have. The message names the row that refuses and what
// the agent can load instead, because "Permission denied: skill" tells neither.
const skillOff = (id: string, agent: string, available: ReadonlyArray<Skill.Info>) =>
  new ToolFailure({
    message: `Skill "${id}" is off for ${agent} (row skill:${id}). Skills you can load: ${
      available.map((skill) => skill.id).join(", ") || "none"
    }.`,
  })

export const Plugin = {
  id: "opencode.tool.skill",
  effect: Effect.fn("SkillTool.Plugin")(function* (ctx: Context) {
    const fs = yield* FSUtil.Service
    const skills = yield* Skill.Service
    const permission = yield* Permission.Service
    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false },
          description,
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              const skill = yield* skills.get(input.id)
              if (!skill) return yield* unableToLoad(input.id)
              // The same merged rules the `<available_skills>` list is built from
              // decide whether this skill is on for the calling agent, before any
              // authorization or content read.
              const rules = yield* permission
                .rules(context.sessionID, context.agent)
                .pipe(Effect.mapError((error) => unableToLoad(input.id, error)))
              const available = Skill.available(yield* skills.list(), rules)
              if (!available.some((entry) => entry.id === skill.id))
                return yield* skillOff(skill.id, String(context.agent), available)
              return yield* Effect.gen(function* () {
                yield* permission.assert({
                  action: name,
                  resources: [skill.id],
                  save: [skill.id],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.messageID, id: context.id },
                })
                return { name: skill.name, ...(yield* Skill.prepare(fs, skill)) }
              }).pipe(Effect.mapError((error) => unableToLoad(input.id, error)))
            }).pipe(
              Effect.map((output) => ({
                output,
                content: output.output,
                metadata: { name: output.name, directory: output.directory },
              })),
            ),
        }),
      )
      .pipe(Effect.orDie)
  }),
}
