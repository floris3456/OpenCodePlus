import fs from "node:fs/promises"
import path from "node:path"
import { Option, Schema } from "effect"

export interface ProjectConfig extends Schema.Schema.Type<typeof ProjectConfig> {}
export const ProjectConfig = Schema.Struct({
  version: Schema.Literal(1),
  protectedAgents: Schema.Array(Schema.String),
}).annotate({ identifier: "Plus.ProjectConfig" })

const decodeProjectConfig = Schema.decodeUnknownOption(Schema.fromJsonString(ProjectConfig))

const DEFAULT_CONFIG: ProjectConfig = {
  version: 1,
  protectedAgents: [],
}

function filePath(directory: string): string {
  return path.join(directory, ".opencodeplus", "project.json")
}

export async function read(directory: string): Promise<ProjectConfig | undefined> {
  const file = Bun.file(filePath(directory))
  const exists = await file.exists()
  if (!exists) return undefined
  const text = await file.text()
  return Option.getOrUndefined(decodeProjectConfig(text))
}

export async function enable(directory: string): Promise<ProjectConfig> {
  const existing = await read(directory)
  if (existing) return existing
  const targetPath = filePath(directory)
  await fs.mkdir(path.dirname(targetPath), { recursive: true })
  await Bun.write(targetPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n")
  return DEFAULT_CONFIG
}

export async function disable(directory: string): Promise<void> {
  const targetPath = filePath(directory)
  const file = Bun.file(targetPath)
  const exists = await file.exists()
  if (!exists) return
  await fs.rm(targetPath, { force: true })
}
