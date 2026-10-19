export * as ConfigWatch from "./watch.js"

import path from "path"
import { FSUtil } from "@opencode/util/fs-util"
import type { Watcher } from "../filesystem/watcher.js"
import type { AbsolutePath } from "../schema.js"
import type { ConfigDiscovery } from "./discovery.js"

/**
 * What this Location watches for config changes. Only service-wide sources:
 * the system config directory, the global config directory, the global `~/.claude` and `~/.agents` roots,
 * and the explicit CLI file. Project sources (a project's `opencode.json`
 * files, `.opencode` directories, `.claude`/`.agents` directories) are read
 * at boot and re-read on demand (the next chat, or `/refresh`): with one
 * watcher per loaded folder those project watches scaled with the team, while
 * every location shares the same global targets. Callers pass the global
 * roots so project lookalikes (a `<project>/home/.agents` when the global
 * home points elsewhere) are never mistaken for global config.
 */
export function plan(
  sources: ConfigDiscovery.Sources,
  global: { readonly config?: AbsolutePath; readonly home: AbsolutePath },
) {
  const globalRoots = [
    ...(global.config === undefined ? [] : [global.config]),
    path.join(global.home, ".claude"),
    path.join(global.home, ".agents"),
  ]
  const isGlobal = (candidate: string) =>
    globalRoots.some((root) => candidate === root || FSUtil.contains(root, candidate))
  const directories = [
    ...(sources.system?.present ? [sources.system.path] : []),
    ...(sources.global ? [sources.global] : []),
  ]
  const files = [
    ...(sources.system ? [sources.system.path] : []),
    ...(sources.explicit ? [sources.explicit] : []),
    ...sources.claude.filter(isGlobal),
    ...sources.agents.filter(isGlobal),
  ]
  // Keep a parent watch for each root so deletion/recreation is observable.
  const parents = Map.groupBy(
    files.filter((file) => !directories.some((directory) => file !== directory && FSUtil.contains(directory, file))),
    (file) => path.dirname(file),
  )
  return new Map(
    [
      ...directories.map((path) => ({
        path,
        type: "directory" as const,
        ignore: FSUtil.ignoreGlobs,
      })),
      ...Array.from(parents, ([parent, files]) => ({
        path: parent,
        type: "entries" as const,
        names: [...new Set(files.map((file) => path.basename(file)))].toSorted(),
      })),
    ].map((target) => [JSON.stringify(target), target satisfies Watcher.WatchInput]),
  )
}
