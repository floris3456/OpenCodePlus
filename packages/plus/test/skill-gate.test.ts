// A skill an agent's rows leave off cannot be loaded by the skill tool, and the
// tool learns that from the same merged agent+Session rules the
// `<available_skills>` list is built from. A presetless team member (every row
// it has no record for resolves off) is the reported shape: the list showed 4
// skills while the tool loaded a fifth that no record turned on.
import { expect, test } from "bun:test"
import { Agent } from "@opencode/schema/agent"
import { AbsolutePath } from "@opencode/schema/schema"
import { Session } from "@opencode/schema/session"
import { Skill } from "@opencode/schema/skill"
import { SessionMessage } from "@opencode/schema/session-message"
import { Effect, Layer } from "effect"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { apply } from "../src/instructions/apply.js"
import type { CustomizationRecord, Item } from "../src/instructions/model.js"
import { agentHarness, agentInfo, context } from "./harness.js"
import { presetInput } from "./teams/preset-table.js"
// Plus must not depend on @opencode/core (core depends on Plus); this test
// reaches core's real skill tool, permission service and skill registry by
// path so the gate under test is the one a session runs, not a copy of it.
import { AppNodeBuilder } from "../../core/src/effect/app-node-builder.js"
import { Image } from "../../core/src/image.js"
import { Permission } from "../../core/src/permission.js"
import { Skill as CoreSkill } from "../../core/src/skill.js"
import { Tool } from "../../core/src/tool.js"
import { SkillTool } from "../../core/src/tool/plugin/skill.js"
import { registerToolPlugin } from "../../core/test/lib/tool.js"
import { FSUtil } from "../../util/src/fs-util.js"
import { makeLocationNode } from "../../util/src/effect/app-node.js"
import { LayerNode } from "../../util/src/effect/layer-node.js"

const UPDATED = "2026-01-01T00:00:00.000Z"
const SESSION = Session.ID.make("ses_skill_gate")
const MESSAGE = SessionMessage.ID.make("msg_skill_gate")
const MEMBER = "runner"
const SKILLS = ["blender-speed", "okf-docs", "playwright-cli", "render-check", "model-creation"]

const skillToolNode = makeLocationNode({
  name: "test/plus-skill-gate",
  layer: Layer.effectDiscard(registerToolPlugin(SkillTool.Plugin)),
  deps: [Tool.node, FSUtil.node, CoreSkill.node, Permission.node],
})

function skillItem(id: string): Item {
  return {
    id: `skill:${id}`,
    kind: "skill",
    group: "native",
    title: id,
    text: `${id} body`,
    enabled: true,
    fingerprint: `sha256:${id}`,
  }
}

function record(item: string, state: "on" | "off"): CustomizationRecord {
  return {
    type: "customization",
    level: "project",
    agent: MEMBER,
    item,
    section: null,
    state,
    basedOn: "sha256:upstream",
    updated: UPDATED,
  }
}

// A member with no preset link: every row no record sets resolves off, so a
// skill with no record is off for it (model.ts fallbackKind, DESIGN §3.3).
function memberInput(records: readonly CustomizationRecord[], items: readonly Item[]) {
  const input = presetInput({ members: [{ id: MEMBER, team: "theorysnap" }] })
  return { ...input, items: [...input.items, ...items], records }
}

// The skills the registry holds, each with a real file: a load that is not
// refused would really read content, so a refusal cannot pass by accident.
async function skillInfos(directory: string): Promise<Skill.Info[]> {
  return Promise.all(
    SKILLS.map(async (id) => {
      const file = path.join(directory, id, "SKILL.md")
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, `${id} body`)
      return Skill.Info.make({
        id: Skill.ID.make(id),
        name: Skill.Name.make(id),
        description: `${id} description`,
        path: AbsolutePath.make(file),
        content: `${id} body`,
      })
    }),
  )
}

// Core's real skill tool over core's real skill registry. The permission
// service answers `rules` with the ruleset Plus installed for the member —
// which is what core's own service returns as merge(agent, session) rules —
// and `assert` with the same evaluation core's service makes, so the test can
// reach the tool without a database and still exercise one rule set.
function runTool(skills: readonly Skill.Info[], rules: Agent.Info["permissions"]) {
  const permission = Layer.mock(Permission.Service, {
    rules: () => Effect.succeed(rules),
    assert: (input) =>
      input.resources.every(
        (resource) =>
          rules.findLast((rule) => rule.action === "skill" && rule.resource === resource)?.effect !== "deny",
      )
        ? Effect.void
        : Effect.fail(
            new Permission.BlockedError({ rules: [...rules], permission: "skill", resources: [...input.resources] }),
          ),
  })
  const layer = AppNodeBuilder.build(LayerNode.group([Tool.node, skillToolNode, CoreSkill.node, Image.node]), [
    CoreSkill.node.replace(
      Layer.mock(CoreSkill.Service, {
        get: (id) => Effect.succeed(skills.find((skill) => skill.id === id)),
        list: () => Effect.succeed([...skills]),
      }),
    ),
    Permission.node.replace(permission),
    Image.node.replace(Layer.mock(Image.Service, { normalize: (_resource, content) => Effect.succeed(content) })),
  ])
  return Effect.gen(function* () {
    const tools = yield* Tool.Service
    const snapshot = yield* tools.snapshot()
    return yield* snapshot.execute({
      sessionID: SESSION,
      agent: Agent.ID.make(MEMBER),
      messageID: MESSAGE,
      call: { type: "tool-call", id: "call_skill_gate", name: SkillTool.name, input: { id: "model-creation" } },
    })
  }).pipe(
    Effect.map((result) => ({ status: "completed" as const, ...result })),
    Effect.catchTag("Tool.Error", (error) => Effect.succeed({ status: "error" as const, message: error.message })),
    Effect.provide(layer),
  )
}

async function withSkills<T>(body: (skills: readonly Skill.Info[]) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(tmpdir(), "plus-skill-gate-"))
  try {
    return await body(await skillInfos(directory))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test("a skill with no row for a presetless member is off in the list and refused by the skill tool", () =>
  withSkills(async (skills) => {
    const agents = agentHarness([agentInfo(MEMBER, "upstream")])
    const ctx = context({ agent: agents.domain })
    // Four rows on, model-creation left with no record at all.
    const on = ["blender-speed", "okf-docs", "playwright-cli", "render-check"]
    await apply(ctx, memberInput(on.map((id) => record(`skill:${id}`, "on")), SKILLS.map(skillItem)))
    const installed = agents.state.get(MEMBER)?.permissions ?? []

    // The deny Plus installs for the row nothing sets.
    expect(installed).toContainEqual({ action: "skill", resource: "model-creation", effect: "deny" })

    // What `<available_skills>` shows the model: the four rows that are on.
    expect(CoreSkill.available(skills, installed).map((skill) => String(skill.id)).toSorted()).toEqual(on)

    // The tool refuses exactly what the list leaves out, and says which row
    // turned it off and what the member can load instead.
    const refused = await Effect.runPromise(runTool(skills, installed))
    expect(refused.status).toBe("error")
    if (refused.status !== "error") throw new Error("expected a refusal")
    expect(refused.message).toBe(
      'Skill "model-creation" is off for runner (row skill:model-creation). Skills you can load: blender-speed, okf-docs, playwright-cli, render-check.',
    )
  }))

test("a skill whose row is on loads", () =>
  withSkills(async (skills) => {
    const agents = agentHarness([agentInfo(MEMBER, "upstream")])
    const ctx = context({ agent: agents.domain })
    await apply(ctx, memberInput(SKILLS.map((id) => record(`skill:${id}`, "on")), SKILLS.map(skillItem)))
    const installed = agents.state.get(MEMBER)?.permissions ?? []
    expect(installed).not.toContainEqual({ action: "skill", resource: "model-creation", effect: "deny" })

    const loaded = await Effect.runPromise(runTool(skills, installed))
    expect(loaded.status).toBe("completed")
  }))
