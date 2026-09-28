import fs from "node:fs/promises"
import path from "node:path"
import { Option, Schema } from "effect"

export interface ProjectConfig extends Schema.Schema.Type<typeof ProjectConfig> {}
export const ProjectConfig = Schema.Struct({
  version: Schema.Literal(1),
  protectedAgents: Schema.Array(Schema.String),
  // The legacy `enabled` key stays decodable and is ignored: a config carrying
  // it is just the nearest config, so it stops the upward walk like any other.
  enabled: Schema.optionalKey(Schema.Boolean),
}).annotate({ identifier: "Plus.ProjectConfig" })

const decodeProjectConfig = Schema.decodeUnknownOption(Schema.fromJsonString(ProjectConfig))

const DEFAULT_CONFIG: ProjectConfig = {
  version: 1,
  protectedAgents: [],
}

function filePath(directory: string): string {
  return path.join(directory, ".opencodeplus", "project.json")
}

async function readAt(directory: string): Promise<ProjectConfig | undefined> {
  const file = Bun.file(filePath(directory))
  const exists = await file.exists()
  if (!exists) return undefined
  const text = await file.text()
  return Option.getOrUndefined(decodeProjectConfig(text))
}

// The nearest `.opencodeplus/project.json` at or above `directory`, or
// undefined when there is none. Plus is always active, so `read` turns the
// miss into the defaults below.
async function findAbove(directory: string): Promise<ProjectConfig | undefined> {
  let current = path.resolve(directory)
  for (;;) {
    const config = await readAt(current)
    if (config !== undefined) return config
    const parent = path.dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

// Project customizations resolve upward: the nearest config at or above
// `directory` decides. A session opened in a subdirectory, and any location
// inside a checkout, therefore reads the same project as the repository root,
// and a directory with no config anywhere above reads the defaults. A team
// worktree outside the parent's tree carries no copy of its own and is
// activated through the run record's `projectDirectory` instead.
export async function read(directory: string): Promise<ProjectConfig> {
  return (await findAbove(directory)) ?? DEFAULT_CONFIG
}

// Create `<dir>/.opencodeplus/project.json` with the defaults, and only when no
// config exists at or above `directory`: an inherited project keeps its
// protectedAgents, and a child write never shadows them with a fresh default.
export async function ensure(directory: string): Promise<void> {
  if ((await findAbove(directory)) !== undefined) return
  await writeConfig(path.resolve(directory), DEFAULT_CONFIG)
}

async function writeConfig(directory: string, config: ProjectConfig): Promise<void> {
  const targetPath = filePath(directory)
  await fs.mkdir(path.dirname(targetPath), { recursive: true })
  await Bun.write(targetPath, JSON.stringify(config, null, 2) + "\n")
}
