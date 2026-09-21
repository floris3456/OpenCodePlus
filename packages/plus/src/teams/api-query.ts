import { readdir } from "node:fs/promises"
import path from "node:path"
import { teamsDataDir } from "../instructions/paths.js"
import { git } from "./git.js"
import { kindOf } from "./policy.js"
import { isTerminal, loadRun, type RunRecord } from "./run.js"
import { ListInput, toolError } from "./schema.js"
import { readJson } from "./store.js"
import type { TeamApiResult, TeamCaller } from "./api.js"

function succeeded(value: unknown): TeamApiResult {
  return { ok: true, value }
}

function fail(code: string, message: string, accepted?: unknown): TeamApiResult {
  if (accepted === undefined) return { ok: false, error: { code, message } }
  return { ok: false, error: { code, message, accepted } }
}

// Read-only listing: planners see every run in the namespace, every other
// role sees its own run plus its direct children. Never writes, never
// acknowledges, never transitions anything.
export async function listHandler(args: ListInput, caller: TeamCaller): Promise<TeamApiResult> {
  const root = teamsDataDir()
  const stored = await loadRun(root, caller.run.id)
  const self = stored ?? caller.run
  const visible = visibleTo(await listRuns(root), self)
  const showAll = args.all ?? false
  const filtered = visible.filter((record) => {
    if (!showAll && (record.state === "superseded" || record.state === "reaped")) return false
    if (args.role !== undefined && record.role !== args.role) return false
    if (args.state !== undefined && record.state !== args.state) return false
    if (args.parent !== undefined && record.parent !== args.parent) return false
    return true
  })
  const sorted = [...filtered].toSorted((a, b) => {
    if (a.lastUsed !== b.lastUsed) return a.lastUsed < b.lastUsed ? 1 : -1
    if (a.id === b.id) return 0
    return a.id < b.id ? -1 : 1
  })
  const entries = []
  for (const record of sorted) entries.push(await entryOf(root, record))
  return succeeded(entries)
}

function visibleTo(all: RunRecord[], self: RunRecord): RunRecord[] {
  const kind = kindOf(self.role)
  if (kind.ok && kind.kind === "planner") return all
  return all.filter((record) => record.id === self.id || record.parent === self.id)
}

// Output field names follow docs/team-v2/03-tools.md §list (run IS the id,
// task IS the task ref) plus runtime, the v1 team_list live/stopped
// indicator: "running" for a live session in a non-terminal, non-stopped,
// non-dead state, "stopped" for stopped/dead/superseded/reaped, else
// "pending".
async function entryOf(root: string, record: RunRecord) {
  // Live worktree read with a stored fallback, so a gone worktree still
  // lists (mirrors statusOf in ./api.ts).
  const head = await git(record.directory, ["rev-parse", "HEAD"]).catch(() => record.head)
  return {
    run: record.id,
    role: record.role,
    state: record.state,
    task: record.task,
    parent: record.parent,
    head,
    branch: record.branch,
    directory: record.directory,
    worktree: record.worktree ?? "present",
    reportStatus: await latestReportStatus(root, record.id),
    lastUsed: record.lastUsed,
    runtime: runtimeOf(record),
  }
}

export async function statusOf(root: string, id: string) {
  const record = await loadRun(root, id)
  if (record === undefined) {
    throw toolError("E_UNKNOWN_RUN", `Run ${id} not found in this namespace.`, "a run id from list{}")
  }
  const head = await git(record.directory, ["rev-parse", "HEAD"]).catch(() => record.head)
  return {
    run: record.id,
    role: record.role,
    state: record.state,
    task: record.task,
    parent: record.parent,
    head,
    branch: record.branch,
    directory: record.directory,
    worktree: record.worktree ?? "present",
    reportStatus: await latestReportStatus(root, record.id),
    lastUsed: record.lastUsed,
    runtime: runtimeOf(record),
  }
}

function runtimeOf(record: RunRecord): string {
  if (record.state === "stopped" || record.state === "dead" || isTerminal(record.state)) return "stopped"
  if (record.sessionID !== null) return "running"
  return "pending"
}

async function latestReportStatus(root: string, runID: string): Promise<string | null> {
  const dir = path.join(root, "runs", runID)
  const entries = await readdir(dir).catch(() => [])
  let best: { n: number; status: string } | undefined
  for (const name of entries) {
    const match = /^report-([0-9]+)\.json$/.exec(name)
    if (match === null) continue
    const data = await readJson<Record<string, unknown>>(path.join(dir, name))
    if (data === undefined || typeof data.status !== "string") continue
    const n = Number(match[1])
    if (best === undefined || n > best.n) best = { n, status: data.status }
  }
  return best?.status ?? null
}

async function listRuns(root: string): Promise<RunRecord[]> {
  const dir = path.join(root, "runs")
  const entries = await readdir(dir).catch(() => [])
  const out: RunRecord[] = []
  for (const name of entries) {
    if (name.startsWith(".")) continue
    const record = await readJson<RunRecord>(path.join(dir, name, "run.json"))
    if (record !== undefined && typeof record.id === "string") out.push(record)
  }
  return out
}

export interface NamespaceRunEntry {
  id: string
  role: string
  state: string
  task: string | null
  head: string
  worktree: string
  lastUsed: string
  sessionID: string | null
  parent: string | null
}

export async function listRunsForNamespace(root: string, args?: { all?: boolean }): Promise<NamespaceRunEntry[]> {
  const allRuns = await listRuns(root)
  const showAll = args?.all ?? false
  const filtered = allRuns.filter((record) => {
    if (!showAll && (record.state === "superseded" || record.state === "reaped")) return false
    return true
  })
  const sorted = [...filtered].toSorted((a, b) => {
    if (a.lastUsed !== b.lastUsed) return a.lastUsed < b.lastUsed ? 1 : -1
    if (a.id === b.id) return 0
    return a.id < b.id ? -1 : 1
  })
  const entries: NamespaceRunEntry[] = []
  for (const record of sorted) {
    const head = await git(record.directory, ["rev-parse", "HEAD"]).catch(() => record.head)
    entries.push({
      id: record.id,
      role: record.role,
      state: record.state,
      task: record.task,
      head,
      worktree: record.worktree ?? "present",
      lastUsed: record.lastUsed,
      sessionID: record.sessionID,
      parent: record.parent,
    })
  }
  return entries
}
