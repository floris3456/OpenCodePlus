import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  agentPath,
  create,
  idFromPath,
  remove,
  rename,
  resolveDirectory,
  serializeFrontmatter,
  validateAgentId,
  type AgentFields,
  type AgentPermissionRule,
} from "../src/agents/files.js"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const preferred = "/home/bliss/OpenCodePlus/run/team/development-models/runs/main-fefb5cdf3bc86ba8/tmp/opencode"
  const parent = process.env.TMPDIR ?? preferred
  await fs.mkdir(parent, { recursive: true }).catch(() => undefined)
  const root = await fs.mkdtemp(path.join(parent, "agents-test-")).catch(async () => {
    return fs.mkdtemp(path.join(os.tmpdir(), "agents-test-"))
  })
  roots.push(root)
  return root
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseAgentFile(raw: string): { frontmatter: Record<string, unknown>; body: string; rawFrontmatter: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return { frontmatter: {}, body: raw, rawFrontmatter: "" }
  const rawFrontmatter = match[1]
  const parsed = Bun.YAML.parse(rawFrontmatter)
  const frontmatter = isRecord(parsed) ? parsed : {}
  return { frontmatter, body: match[2], rawFrontmatter }
}

test("create writes a file at the expected path, the body is exactly the prompt, and no system key appears in frontmatter", async () => {
  const projectDirectory = await tempDir()
  const prompt = "You are a code reviewer. Review changes carefully."
  const fields: AgentFields = {
    model: "claude-3-5-sonnet",
    mode: "subagent",
    description: "Reviews code changes",
    permissions: [
      { action: "read", resource: "**", effect: "allow" },
      { action: "edit", resource: "src/**", effect: "allow" },
    ],
  }

  const result = await create({
    scope: "project",
    projectDirectory,
    id: "reviewer",
    fields,
    prompt,
  })

  expect(result.ok).toBe(true)
  if (!result.ok) return

  const expectedPath = path.join(projectDirectory, ".opencode", "agent", "reviewer.md")
  expect(result.path).toBe(expectedPath)
  expect(await Bun.file(result.path).exists()).toBe(true)

  const content = await Bun.file(result.path).text()
  const parsed = parseAgentFile(content)

  expect(parsed.body).toBe(prompt)
  expect(parsed.frontmatter.model).toBe("claude-3-5-sonnet")
  expect(parsed.frontmatter.mode).toBe("subagent")
  expect(parsed.frontmatter.description).toBe("Reviews code changes")
  expect(parsed.frontmatter.permissions).toEqual([
    { action: "read", resource: "**", effect: "allow" },
    { action: "edit", resource: "src/**", effect: "allow" },
  ])

  // Assert explicitly that no system key appears in frontmatter (would trigger legacy V1 migration)
  expect("system" in parsed.frontmatter).toBe(false)
  expect(parsed.rawFrontmatter.includes("system")).toBe(false)
  // Ensure only provided known keys exist
  expect(Object.keys(parsed.frontmatter).sort()).toEqual(["description", "mode", "model", "permissions"])
})

test("created file idFromPath round-trips back to the id, including nested ids", async () => {
  const projectDirectory = await tempDir()
  const agentDir = await resolveDirectory("project", projectDirectory)
  const configDir = path.join(projectDirectory, ".opencode")

  // Flat id
  const flat = await create({
    scope: "project",
    projectDirectory,
    id: "reviewer",
    prompt: "Flat reviewer prompt",
  })
  expect(flat.ok).toBe(true)
  if (flat.ok) {
    expect(idFromPath(agentDir, flat.path)).toBe("reviewer")
    expect(idFromPath(configDir, flat.path)).toBe("reviewer")
  }

  // Nested id: team/lead
  const nested = await create({
    scope: "project",
    projectDirectory,
    id: "team/lead",
    prompt: "Lead prompt",
  })
  expect(nested.ok).toBe(true)
  if (nested.ok) {
    expect(nested.path).toBe(path.join(projectDirectory, ".opencode", "agent", "team", "lead.md"))
    expect(idFromPath(agentDir, nested.path)).toBe("team/lead")
    expect(idFromPath(configDir, nested.path)).toBe("team/lead")
  }

  // Deeply nested id: team/sub/worker
  const deeplyNested = await create({
    scope: "project",
    projectDirectory,
    id: "team/sub/worker",
    prompt: "Worker prompt",
  })
  expect(deeplyNested.ok).toBe(true)
  if (deeplyNested.ok) {
    expect(idFromPath(agentDir, deeplyNested.path)).toBe("team/sub/worker")
    expect(idFromPath(configDir, deeplyNested.path)).toBe("team/sub/worker")
  }
})

test("idFromPath strips leading agent, agents, mode, modes prefixes", () => {
  const config = "/path/to/project/.opencode"
  expect(idFromPath(config, "/path/to/project/.opencode/agent/reviewer.md")).toBe("reviewer")
  expect(idFromPath(config, "/path/to/project/.opencode/agents/reviewer.md")).toBe("reviewer")
  expect(idFromPath(config, "/path/to/project/.opencode/mode/reviewer.md")).toBe("reviewer")
  expect(idFromPath(config, "/path/to/project/.opencode/modes/reviewer.md")).toBe("reviewer")
  expect(idFromPath(config, "/path/to/project/.opencode/agent/team/lead.md")).toBe("team/lead")
  expect(idFromPath(config, "/path/to/project/.opencode/agents/team/lead.md")).toBe("team/lead")
})

test("create refuses to overwrite an existing file and leaves the original content intact", async () => {
  const projectDirectory = await tempDir()
  const originalPrompt = "Original prompt"
  const first = await create({
    scope: "project",
    projectDirectory,
    id: "agent-a",
    fields: { model: "model-v1" },
    prompt: originalPrompt,
  })
  expect(first.ok).toBe(true)

  const second = await create({
    scope: "project",
    projectDirectory,
    id: "agent-a",
    fields: { model: "model-v2" },
    prompt: "New prompt that should not overwrite",
  })

  expect(second.ok).toBe(false)
  if (second.ok) return
  expect(second.reason).toBe("already-exists")
  if (first.ok) {
    expect(second.path).toBe(first.path)
    const content = await Bun.file(first.path).text()
    const parsed = parseAgentFile(content)
    expect(parsed.body).toBe(originalPrompt)
    expect(parsed.frontmatter.model).toBe("model-v1")
  }
})

test("rename moves content and fails when the destination exists or source is missing", async () => {
  const projectDirectory = await tempDir()
  const prompt = "Prompt for rename test"
  const created = await create({
    scope: "project",
    projectDirectory,
    id: "source-agent",
    fields: { mode: "subagent", model: "test-model" },
    prompt,
  })
  expect(created.ok).toBe(true)
  if (!created.ok) return

  // Rename non-existent agent fails
  const missing = await rename({
    scope: "project",
    projectDirectory,
    from: "does-not-exist",
    to: "target-agent",
  })
  expect(missing.ok).toBe(false)
  if (!missing.ok) {
    expect(missing.reason).toBe("missing-source")
  }

  // Create another agent to cause a collision
  const collision = await create({
    scope: "project",
    projectDirectory,
    id: "existing-dest",
    prompt: "Existing dest prompt",
  })
  expect(collision.ok).toBe(true)

  // Rename onto existing destination fails
  const conflict = await rename({
    scope: "project",
    projectDirectory,
    from: "source-agent",
    to: "existing-dest",
  })
  expect(conflict.ok).toBe(false)
  if (!conflict.ok) {
    expect(conflict.reason).toBe("already-exists")
  }

  // Successful rename into a nested path
  const success = await rename({
    scope: "project",
    projectDirectory,
    from: "source-agent",
    to: "team/renamed-agent",
  })
  expect(success.ok).toBe(true)
  if (!success.ok) return

  expect(await Bun.file(success.fromPath).exists()).toBe(false)
  expect(await Bun.file(success.toPath).exists()).toBe(true)

  const content = await Bun.file(success.toPath).text()
  const parsed = parseAgentFile(content)
  expect(parsed.body).toBe(prompt)
  expect(parsed.frontmatter.mode).toBe("subagent")
  expect(parsed.frontmatter.model).toBe("test-model")
})

test("remove deletes an existing file, and removing a missing file reports that nothing was removed", async () => {
  const projectDirectory = await tempDir()
  const created = await create({
    scope: "project",
    projectDirectory,
    id: "to-remove",
    prompt: "Temporary prompt",
  })
  expect(created.ok).toBe(true)
  if (!created.ok) return

  const untouched = await create({
    scope: "project",
    projectDirectory,
    id: "untouched",
    prompt: "Untouched prompt",
  })
  expect(untouched.ok).toBe(true)
  if (!untouched.ok) return

  expect(await Bun.file(created.path).exists()).toBe(true)
  expect(await Bun.file(untouched.path).exists()).toBe(true)

  const removed = await remove({
    scope: "project",
    projectDirectory,
    id: "to-remove",
  })
  expect(removed.ok).toBe(true)
  if (removed.ok) {
    expect(removed.path).toBe(created.path)
  }
  expect(await Bun.file(created.path).exists()).toBe(false)
  expect(await Bun.file(untouched.path).exists()).toBe(true)

  // Removing again reports that nothing was removed and touches nothing
  const missing = await remove({
    scope: "project",
    projectDirectory,
    id: "to-remove",
  })
  expect(missing.ok).toBe(false)
  if (!missing.ok) {
    expect(missing.reason).toBe("missing")
    expect(missing.path).toBe(created.path)
  }
  expect(await Bun.file(created.path).exists()).toBe(false)
  expect(await Bun.file(untouched.path).exists()).toBe(true)
  expect(await Bun.file(untouched.path).text()).toContain("Untouched prompt")
})

test("permissions serialize as a YAML array of { action, resource, effect } and parse back to the same ordered array", async () => {
  const projectDirectory = await tempDir()
  const permissions: AgentPermissionRule[] = [
    { action: "read", resource: "**", effect: "allow" },
    { action: "edit", resource: "src/**", effect: "deny" },
    { action: "bash", resource: "git *", effect: "ask" },
    { action: "external_directory", resource: "/home/user/*", effect: "allow" },
  ]

  const created = await create({
    scope: "project",
    projectDirectory,
    id: "perm-agent",
    fields: {
      model: "claude-3-5-sonnet",
      mode: "subagent",
      permissions,
    },
    prompt: "Permission test prompt",
  })
  expect(created.ok).toBe(true)
  if (!created.ok) return

  const content = await Bun.file(created.path).text()
  const parsed = parseAgentFile(content)

  expect(parsed.frontmatter.permissions).toEqual(permissions)
  expect(Array.isArray(parsed.frontmatter.permissions)).toBe(true)
})

test("resolveDirectory prefers existing agents/ directory over agent/ defaulting to agent/", async () => {
  const projectDirectory = await tempDir()

  // Default when neither exists: agent
  const defaultDir = await resolveDirectory("project", projectDirectory)
  expect(defaultDir).toBe(path.join(projectDirectory, ".opencode", "agent"))

  // When only agent/ exists: agent
  await fs.mkdir(path.join(projectDirectory, ".opencode", "agent"), { recursive: true })
  const agentDir = await resolveDirectory("project", projectDirectory)
  expect(agentDir).toBe(path.join(projectDirectory, ".opencode", "agent"))

  // When agents/ is created: prefers agents/
  await fs.mkdir(path.join(projectDirectory, ".opencode", "agents"), { recursive: true })
  const agentsDir = await resolveDirectory("project", projectDirectory)
  expect(agentsDir).toBe(path.join(projectDirectory, ".opencode", "agents"))
})

test("global scope uses OPENCODE_CONFIG_DIR when set", async () => {
  const customGlobal = await tempDir()
  const previous = process.env.OPENCODE_CONFIG_DIR
  process.env.OPENCODE_CONFIG_DIR = customGlobal

  try {
    const dir = await resolveDirectory("global", "")
    expect(dir).toBe(path.join(customGlobal, "agent"))

    const created = await create({
      scope: "global",
      projectDirectory: "",
      id: "global-reviewer",
      fields: { mode: "primary" },
      prompt: "Global prompt",
    })
    expect(created.ok).toBe(true)
    if (created.ok) {
      expect(created.path).toBe(path.join(customGlobal, "agent", "global-reviewer.md"))
      expect(await Bun.file(created.path).exists()).toBe(true)
    }

    const renamed = await rename({ scope: "global", projectDirectory: "", from: "global-reviewer", to: "global-lead" })
    expect(renamed.ok).toBe(true)
    const removed = await remove({ scope: "global", projectDirectory: "", id: "global-lead" })
    expect(removed.ok).toBe(true)
  } finally {
    if (previous !== undefined) {
      process.env.OPENCODE_CONFIG_DIR = previous
    }
    if (previous === undefined) {
      delete process.env.OPENCODE_CONFIG_DIR
    }
  }
})

test("serializeFrontmatter produces expected exact YAML and omits undefined or unknown keys", () => {
  const fields: AgentFields = {
    model: "claude-3-5-sonnet",
    mode: "subagent",
    permissions: [{ action: "read", resource: "**", effect: "allow" }],
  }

  const yaml = serializeFrontmatter(fields)
  const expected = [
    "model: claude-3-5-sonnet",
    "mode: subagent",
    "permissions:",
    "  - action: read",
    '    resource: "**"',
    "    effect: allow",
  ].join("\n")

  expect(yaml).toBe(expected)

  // Verify unknown keys and system key are never emitted
  const dirty = {
    ...fields,
    system: "should not be emitted",
    unknownKey: "unknown",
  }
  const filteredYaml = serializeFrontmatter(dirty)
  expect(filteredYaml).toBe(expected)
  expect(filteredYaml.includes("system")).toBe(false)
  expect(filteredYaml.includes("unknownKey")).toBe(false)
})

test("traversal ids are rejected and confined to the agent root", async () => {
  const projectDirectory = await tempDir()
  const outside = path.join(projectDirectory, ".opencode", "AGENTS.md")
  await fs.mkdir(path.dirname(outside), { recursive: true })
  await Bun.write(outside, "keep me\n")

  const validated = validateAgentId("../../AGENTS")
  expect(validated.ok).toBe(false)
  if (validated.ok) return
  expect(validated.reason).toContain("..")

  await expect(agentPath("project", projectDirectory, "../../AGENTS")).rejects.toThrow()
  await expect(
    remove({ scope: "project", projectDirectory, id: "../../AGENTS" }),
  ).rejects.toThrow()
  expect(await Bun.file(outside).exists()).toBe(true)
  expect(await Bun.file(outside).text()).toBe("keep me\n")
})

test("rename and delete resolve the file in agent/ when an empty agents/ directory exists", async () => {
  const projectDirectory = await tempDir()
  const agentDir = path.join(projectDirectory, ".opencode", "agent")
  const agentsDir = path.join(projectDirectory, ".opencode", "agents")
  await fs.mkdir(agentDir, { recursive: true })
  await Bun.write(path.join(agentDir, "alpha.md"), "# alpha\n")
  await fs.mkdir(agentsDir, { recursive: true })

  const renamed = await rename({ scope: "project", projectDirectory, from: "alpha", to: "beta" })
  expect(renamed.ok).toBe(true)
  if (!renamed.ok) return
  expect(renamed.fromPath).toBe(path.join(agentDir, "alpha.md"))
  expect(await Bun.file(renamed.fromPath).exists()).toBe(false)
  expect(await Bun.file(renamed.toPath).exists()).toBe(true)

  const removed = await remove({ scope: "project", projectDirectory, id: "beta" })
  expect(removed.ok).toBe(true)
  expect(removed.path).toBe(renamed.toPath)
  expect(await Bun.file(renamed.toPath).exists()).toBe(false)
})

test("delete resolves the file in agent/ even when an empty agents/ directory exists", async () => {
  const projectDirectory = await tempDir()
  const agentDir = path.join(projectDirectory, ".opencode", "agent")
  await fs.mkdir(agentDir, { recursive: true })
  await Bun.write(path.join(agentDir, "alpha.md"), "# alpha\n")
  await fs.mkdir(path.join(projectDirectory, ".opencode", "agents"), { recursive: true })

  const removed = await remove({ scope: "project", projectDirectory, id: "alpha" })
  expect(removed.ok).toBe(true)
  expect(removed.path).toBe(path.join(agentDir, "alpha.md"))
  expect(await Bun.file(path.join(agentDir, "alpha.md")).exists()).toBe(false)
})
