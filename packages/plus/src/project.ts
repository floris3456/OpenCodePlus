import fs from "node:fs/promises"
import path from "node:path"
import { Option, Schema } from "effect"

export interface ProjectConfig extends Schema.Schema.Type<typeof ProjectConfig> {}
export const ProjectConfig = Schema.Struct({
  version: Schema.Literal(1),
  protectedAgents: Schema.Array(Schema.String),
  // `disable` writes an explicit marker instead of deleting the file: a config
  // with enabled:false stops the upward walk, so a directory inside an enabled
  // checkout can opt out instead of inheriting. Absent means enabled.
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

// Project mode resolves upward: the nearest `.opencodeplus/project.json` at or
// above `directory` decides. A session opened in a subdirectory, and any
// location inside an enabled checkout, therefore reads the same project as the
// repository root. A config carrying `enabled: false` is an explicit opt-out:
// it stops the walk and reports disabled, so a nested directory can leave an
// enabled ancestor's project. A team worktree outside the parent's tree carries
// no copy of its own and is activated through the run record's
// `projectDirectory` instead.
export async function read(directory: string): Promise<ProjectConfig | undefined> {
  let current = path.resolve(directory)
  for (;;) {
    const config = await readAt(current)
    if (config !== undefined) return config.enabled === false ? undefined : config
    const parent = path.dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

export async function enable(directory: string): Promise<ProjectConfig> {
  const existing = await read(directory)
  if (existing) return existing
  const resolved = path.resolve(directory)
  await writeConfig(resolved, DEFAULT_CONFIG)
  return DEFAULT_CONFIG
}

// `disable` writes the explicit marker at this directory rather than deleting
// the file: with upward resolution, removing a nested directory's own config
// would silently re-enable it through an ancestor. The marker keeps the
// directory (and its descendants, until one enables again) disabled.
export async function disable(directory: string): Promise<void> {
  const resolved = path.resolve(directory)
  const inherited = await read(resolved)
  await writeConfig(resolved, { ...(inherited ?? DEFAULT_CONFIG), enabled: false })
}

async function writeConfig(directory: string, config: ProjectConfig): Promise<void> {
  const targetPath = filePath(directory)
  await fs.mkdir(path.dirname(targetPath), { recursive: true })
  await Bun.write(targetPath, JSON.stringify(config, null, 2) + "\n")
}
