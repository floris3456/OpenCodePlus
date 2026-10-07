import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import fs from "node:fs/promises"
import { activate, createHandlers, createState } from "../src/index.js"
import { agentHarness, agentInfo, context, fullContext } from "./harness.js"

const throwing = {
  error: (type: string, message: string, data?: unknown): never => {
    throw { type, message, data }
  },
}

const UPDATED = new Date().toISOString()

async function tempDir(): Promise<string> {
  const dir = path.join("/tmp", `test-publish-parts-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

describe("publish parts replacement", () => {
  test("toggling one tool keeps the roles/models/skills registrations (same object) and does not call agent.reload", async () => {
    const root = await tempDir()
    process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
    const project = path.join(root, "project")

    const harness = agentHarness([agentInfo("build", "build role")], project)
    const ctx = context({
      ...fullContext({
        directory: project,
        tools: [{ id: "grep", description: "grep tool", options: { codemode: false } }],
        hooks: { current: 0 },
      }),
      agent: harness.domain,
    })
    const state = createState()
    await Effect.runPromise(activate(ctx, state))
    const handlers = createHandlers(ctx, state)

    const snap0 = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing))
    expect(snap0).toBeDefined()

    // Find the initial registrations for roles, models, skills
    const rolesBefore = state.appliedParts.get("roles")?.registrations
    const modelsBefore = state.appliedParts.get("models")?.registrations
    const skillsBefore = state.appliedParts.get("skills")?.registrations

    expect(rolesBefore).toBeDefined()
    expect(modelsBefore).toBeDefined()
    expect(skillsBefore).toBeDefined()

    const reloadsBefore = harness.reloads

    // Toggle one tool (e.g. grep)
    const mutated = await Effect.runPromise(
      handlers["instructions.mutate"](
        {
          expectedRevision: snap0.revision,
          expectedGlobalRevision: snap0.globalRevision,
          records: [
            ...snap0.records,
            {
              type: "customization",
              level: "project",
              agent: "build",
              item: "tool:grep",
              section: null,
              state: "off",
              basedOn: "",
              updated: UPDATED,
            },
          ],
        },
        throwing,
      ),
    )
    expect(mutated.ok).toBe(true)

    // Verify registrations are kept (exact same object reference)
    const rolesAfter = state.appliedParts.get("roles")?.registrations
    const modelsAfter = state.appliedParts.get("models")?.registrations
    const skillsAfter = state.appliedParts.get("skills")?.registrations

    expect(rolesAfter).toBe(rolesBefore)
    expect(modelsAfter).toBe(modelsBefore)
    expect(skillsAfter).toBe(skillsBefore)

    // agent.reload was NOT called
    expect(harness.reloads).toBe(reloadsBefore)
  })
})
