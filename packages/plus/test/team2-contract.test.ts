import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { formatMarkdown, parseFrontmatter, serializeFrontmatter, type AgentFields } from "../src/agents/files.js"
import { agentBody } from "../src/instructions/discover.js"
import { projectTeamsPath } from "../src/instructions/paths.js"
import { discoverTeams, resolveTeams } from "../src/instructions/teams.js"

const AGENT_FILE_CONTENT =
  '---\ndescription: "Lead the assigned work."\nmode: primary\n---\n\nBody line one.\n\nBody line two.\n'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-team2-contract-"))
  roots.push(root)
  return root
}

test("parseFrontmatter parses description and mode from external team2 agent format and body round-trips", () => {
  const fields = parseFrontmatter(AGENT_FILE_CONTENT)
  expect(fields).toEqual({
    description: "Lead the assigned work.",
    mode: "primary",
  })

  // parseFrontmatter extracts frontmatter fields only; body is parsed via markdown boundary or agentBody
  const bodyMatch = AGENT_FILE_CONTENT.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n\n?([\s\S]*)$/)
  expect(bodyMatch?.[1]).toBe("Body line one.\n\nBody line two.\n")

  expect(agentBody(AGENT_FILE_CONTENT)).toBe("Body line one.\n\nBody line two.")

  // Round-trip formatting with the parsed fields reproduces byte-identical agent file content
  const roundTripped = formatMarkdown(fields, "\nBody line one.\n\nBody line two.\n")
  expect(roundTripped).toBe(AGENT_FILE_CONTENT)
})

test("discoverTeams discovers project team agent under .opencodeplus/teams/<team>/<agentId>.md", async () => {
  const tmp = await tempDir()
  const teamName = "opencodeplus-team"
  const agentId = "lead"
  const agentFilePath = path.join(projectTeamsPath(tmp), teamName, `${agentId}.md`)

  await fs.mkdir(path.dirname(agentFilePath), { recursive: true })
  await Bun.write(agentFilePath, AGENT_FILE_CONTENT)

  const discovered = await discoverTeams("project", tmp)
  const team = discovered.find((item) => item.team === teamName)

  expect(team).toBeDefined()
  expect(team?.level).toBe("project")
  expect(team?.path).toBe(path.join(tmp, ".opencodeplus", "teams", teamName))
  expect(team?.agents).toHaveLength(1)
  expect(team?.agents[0]?.id).toBe(agentId)
  expect(team?.agents[0]?.path).toBe(agentFilePath)
})

test("resolveTeams with no TeamRecord marks team disabled and excludes agent from core-visible list", async () => {
  const tmp = await tempDir()
  const teamName = "opencodeplus-team"
  const agentId = "lead"
  const agentFilePath = path.join(projectTeamsPath(tmp), teamName, `${agentId}.md`)

  await fs.mkdir(path.dirname(agentFilePath), { recursive: true })
  await Bun.write(agentFilePath, AGENT_FILE_CONTENT)

  const discovered = await discoverTeams("project", tmp)
  const resolved = resolveTeams(discovered, [], [])

  const contribution = resolved.teams.find((item) => item.team === teamName)
  expect(contribution).toBeDefined()
  expect(contribution?.enabled).toBe(false)
  expect(contribution?.agents.map((agent) => agent.id)).toEqual([agentId])

  expect(resolved.agents.find((agent) => agent.id === agentId)).toBeUndefined()
  expect(resolved.agents).toHaveLength(0)
})

test("public serialization admits description and mode while dropping unknown keys (ALLOWED_KEYS contract)", () => {
  const dirtyFields = {
    description: "Lead the assigned work.",
    mode: "primary" as const,
    notakey: "should-be-dropped",
  } as AgentFields & { notakey: string }

  const serialized = serializeFrontmatter(dirtyFields)
  expect(serialized).toContain('description: "Lead the assigned work."')
  expect(serialized).toContain("mode: primary")
  expect(serialized.includes("notakey")).toBe(false)

  const formatted = formatMarkdown(dirtyFields, "Body line one.\n\nBody line two.\n")
  expect(formatted).toContain('description: "Lead the assigned work."')
  expect(formatted).toContain("mode: primary")
  expect(formatted.includes("notakey")).toBe(false)

  const roundTripped = parseFrontmatter(formatted)
  expect(roundTripped).toEqual({
    description: "Lead the assigned work.",
    mode: "primary",
  })
  expect((roundTripped as Record<string, unknown> | undefined)?.["notakey"]).toBeUndefined()
})
