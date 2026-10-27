import { lstat, readdir, readFile, realpath, rm } from "node:fs/promises"
import path from "node:path"
import { Global } from "@opencode/util/global"
import { Hash } from "@opencode/util/hash"
import { errCode } from "./io.js"

// Core keeps one undo-snapshot store per worktree under the global data dir.
// Plus deletes a team worktree's store with the worktree and sweeps the stores
// of worktrees a previous host already removed, so a host does not fill up with
// stores of long-gone team runs.
export function snapshotRoot(): string {
  return path.join(Global.Path.data, "snapshot")
}

/** Whether `directory` is a worktree under the team data dir's `worktrees/` area. */
export async function isTeamWorktree(directory: string, teamsRoot: string): Promise<boolean> {
  return under(await real(path.join(teamsRoot, "worktrees")), await real(directory))
}

/** Removes the stores whose config names `worktree`, and returns the stores it removed. */
export async function removeSnapshotStores(worktree: string, root = snapshotRoot()): Promise<string[]> {
  const hash = Hash.fast(worktree)
  const stores = await children(root)
  const matching = await Promise.all(
    stores.map(async (project) => {
      const store = path.join(project, hash)
      return (await worktreeOf(store)) === worktree ? store : undefined
    }),
  )
  return discard(matching.filter((store): store is string => store !== undefined))
}

/**
 * Removes the stores of absent worktrees inside the team worktree area. A store
 * whose worktree still exists, or that lies outside that area, is kept.
 */
export async function removeLeftoverSnapshotStores(teamsRoot: string, root = snapshotRoot()): Promise<string[]> {
  const area = await real(path.join(teamsRoot, "worktrees"))
  const stores = (await Promise.all((await children(root)).map((project) => children(project)))).flat()
  const leftovers = await Promise.all(
    stores.map(async (store) => {
      const worktree = await worktreeOf(store)
      if (worktree === undefined || !under(area, await real(worktree))) return undefined
      if (!(await gone(worktree))) return undefined
      return store
    }),
  )
  return discard(leftovers.filter((store): store is string => store !== undefined))
}

// The `worktree` value a snapshot store's git config names, if it has one.
async function worktreeOf(store: string): Promise<string | undefined> {
  const config = await readFile(path.join(store, "config"), "utf8").catch(() => undefined)
  if (config === undefined) return undefined
  const values = config.split("\n").flatMap((line) => {
    const trimmed = line.trim()
    const at = trimmed.indexOf("=")
    if (at < 0 || trimmed.slice(0, at).trim() !== "worktree") return []
    return [trimmed.slice(at + 1).trim()]
  })
  return values[0]
}

async function discard(stores: readonly string[]): Promise<string[]> {
  const removed = await Promise.all(
    stores.map((store) => rm(store, { recursive: true, force: true }).then(() => store, () => undefined)),
  )
  return removed.filter((store): store is string => store !== undefined)
}

function children(directory: string): Promise<string[]> {
  return readdir(directory, { withFileTypes: true })
    .then((entries) => entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(directory, entry.name)))
    .catch(() => [])
}

function real(target: string): Promise<string> {
  return realpath(target).catch(() => target)
}

// Absent only when lstat says ENOENT: any other error leaves the worktree's
// store alone, since the worktree may still exist.
function gone(worktree: string): Promise<boolean> {
  return lstat(worktree).then(() => false, (error: unknown) => errCode(error) === "ENOENT")
}

function under(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate)
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
}
