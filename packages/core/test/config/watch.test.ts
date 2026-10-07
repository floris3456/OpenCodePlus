import path from "path"
import { describe, expect, test } from "bun:test"
import type { ConfigDiscovery } from "@opencode/core/config/discovery"
import { ConfigWatch } from "@opencode/core/config/watch"
import { AbsolutePath } from "@opencode/core/schema"

const project = path.resolve("watch-plan-project")
const root = AbsolutePath.make(path.join(project, ".opencode"))
const home = path.resolve("watch-plan-home")
const globalConfig = AbsolutePath.make(path.join(home, ".config", "opencode"))
const sources: ConfigDiscovery.Sources = {
  global: globalConfig,
  direct: ["opencode.json", "opencode.jsonc"].map((name) => AbsolutePath.make(path.join(project, name))),
  project: [{ path: root, present: false }],
  claude: [AbsolutePath.make(path.join(project, ".claude")), AbsolutePath.make(path.join(home, ".claude"))],
  agents: [AbsolutePath.make(path.join(project, ".agents")), AbsolutePath.make(path.join(home, ".agents"))],
}
const scope = { config: globalConfig, home: AbsolutePath.make(home) }

describe("ConfigWatch.plan", () => {
  test("watches only service-wide sources, never a project's files", () => {
    // Item 4.6: a project's opencode.json files, .opencode directories and
    // .claude/.agents directories load at boot and on demand, but are never
    // watched. Every loaded folder shares the same global targets instead.
    expect(Array.from(ConfigWatch.plan(sources, scope).values())).toEqual([
      { path: globalConfig, type: "directory", ignore: ["node_modules", ".git", "**/{node_modules,.git}/**"] },
      { path: home, type: "entries", names: [".agents", ".claude"] },
    ])
  })

  test("a present project directory adds no watch", () => {
    const present = ConfigWatch.plan({ ...sources, project: [{ path: root, present: true }] }, scope)
    expect(Array.from(present.values())).toEqual(Array.from(ConfigWatch.plan(sources, scope).values()))
  })

  test("adds an exact watch for the explicit file only when not already covered", () => {
    // Project files are never covered, so an explicit project file always
    // adds its parent watch. An explicit file inside the global config dir
    // is already covered by the directory watch.
    const explicitProject = ConfigWatch.plan(
      { ...sources, explicit: AbsolutePath.make(path.join(project, "custom.json")) },
      scope,
    )
    expect(Array.from(explicitProject.values())).toContainEqual({ path: project, type: "entries", names: ["custom.json"] })
    expect(
      ConfigWatch.plan({ ...sources, explicit: AbsolutePath.make(path.join(globalConfig, "custom.json")) }, scope),
    ).toEqual(ConfigWatch.plan(sources, scope))
    const directory = path.resolve("watch-plan-external")
    expect(
      Array.from(
        ConfigWatch.plan({ ...sources, explicit: AbsolutePath.make(path.join(directory, "custom.json")) }, scope).values(),
      ),
    ).toContainEqual({ path: directory, type: "entries", names: ["custom.json"] })
  })

  test("with global config off there is nothing service-wide to watch", () => {
    const scoped = {
      ...sources,
      global: undefined,
      claude: [AbsolutePath.make(path.join(project, ".claude"))],
      agents: [AbsolutePath.make(path.join(project, ".agents"))],
    }
    expect(Array.from(ConfigWatch.plan(scoped, { home: AbsolutePath.make(home) }).values())).toEqual([])
  })
})
