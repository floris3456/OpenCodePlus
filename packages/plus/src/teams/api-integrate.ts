import path from "node:path"
import { readdir } from "node:fs/promises"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Option, Schema } from "effect"
import { teamsDataDir } from "../instructions/paths.js"
import { drain, enqueue } from "./merge.js"
import type { MergeContext } from "./merge.js"
import { gitRaw } from "./git.js"
import { loadRun } from "./run.js"
import { Head, RunID } from "./schema.js"
import type { Check } from "./schema.js"
import { readJson } from "./store.js"
import type { TeamApiResult, TeamCaller } from "./api.js"

const IntegrateInput = Schema.Struct({
  run: RunID,
  expectedParentHead: Head,
})

function succeeded(value: unknown): TeamApiResult {
  return { ok: true, value }
}

function fail(code: string, message: string, accepted?: unknown): TeamApiResult {
  if (accepted === undefined) return { ok: false, error: { code, message } }
  return { ok: false, error: { code, message, accepted } }
}

function thrownError(error: unknown): { code: string; message: string; accepted?: unknown } {
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>
    if (typeof record.code === "string" && typeof record.message === "string") {
      if (record.accepted === undefined) return { code: record.code, message: record.message }
      return { code: record.code, message: record.message, accepted: record.accepted }
    }
    if (error instanceof Error) return { code: "E_INTERNAL", message: error.message }
  }
  return { code: "E_INTERNAL", message: String(error) }
}

async function latestReport(root: string, runID: string): Promise<{ n: number; status: string } | undefined> {
  const dir = path.join(root, "runs", runID)
  const entries = await readdir(dir).catch(() => [] as string[])
  let best: { n: number; status: string } | undefined
  for (const name of entries) {
    const match = /^report-([0-9]+)\.json$/.exec(name)
    if (match === null) continue
    const data = await readJson<Record<string, unknown>>(path.join(dir, name))
    if (data === undefined) continue
    const n = Number(match[1])
    const status = typeof data.status === "string" ? data.status : "unknown"
    if (best === undefined || n > best.n) best = { n, status }
  }
  return best
}

export async function integrateHandler(ctx: Context, input: unknown, caller: TeamCaller): Promise<TeamApiResult> {
  void ctx
  const root = teamsDataDir()
  const decoded = Schema.decodeUnknownOption(IntegrateInput)(input)
  if (Option.isNone(decoded)) return fail("E_INPUT", "Invalid integrate input.")
  const args = decoded.value
  const stored = await loadRun(root, caller.run.id)
  const parent = stored ?? caller.run
  const child = await loadRun(root, args.run)
  if (child === undefined || child.parent !== parent.id)
    return fail(
      "E_NOT_CHILD",
      `Run ${args.run} is not your direct child. Your children: [${parent.children.join(", ")}]. Use status to read others.`,
      parent.children,
    )
  if (child.state === "working") return fail("E_BUSY", "Child is working; wait first.")
  const report = await latestReport(root, child.id)
  const status = report?.status ?? "none"
  const lastAttempt = child.attempts[child.attempts.length - 1]?.n ?? 0
  const attempt = report?.n ?? lastAttempt
  if (status !== "done" && status !== "done_with_concerns")
    return fail(
      "E_NOT_DONE",
      `Child ${child.id} last report is "${status}" (attempt ${attempt}). Only done/done_with_concerns can be integrated. Send a followup or supersede.`,
    )
  const top = await gitRaw(parent.directory, ["rev-parse", "--show-toplevel"])
  if (top.code !== 0) return fail("E_INTERNAL", top.err || top.out || `Cannot resolve repository from ${parent.directory}.`)
  const repoRoot = top.out
  const checks = (await readJson<Check[]>(path.join(root, "runs", parent.id, "checks.json"))) ?? []
  const mergeCtx: MergeContext = {
    repoRoot,
    repoKey: parent.repoKey,
    workspaceRoot: root,
    parentWorktree: parent.directory,
    checks,
  }
  const live = await gitRaw(child.directory, ["rev-parse", "HEAD"])
  const childHead = live.code === 0 ? live.out : child.head
  const enqueued = await enqueue(root, {
    parentRun: parent.id,
    parentWorktree: parent.directory,
    childRun: child.id,
    childBranch: child.branch,
    childHead,
    expectedParentHead: args.expectedParentHead,
  }).then(
    (entry) => ({ ok: true as const, entry }),
    (error) => ({ ok: false as const, error: thrownError(error) }),
  )
  if (!enqueued.ok) return { ok: false, error: enqueued.error }
  const entry = enqueued.entry
  const drained = await drain(root, parent.id, mergeCtx).then(
    (result) => ({ ok: true as const, result }),
    (error) => ({ ok: false as const, error: thrownError(error) }),
  )
  if (!drained.ok) return { ok: false, error: drained.error }
  const ours = drained.result.processed.find((item) => item.id === entry.id)
  if (ours !== undefined && ours.state === "landed") {
    const landedHead =
      ours.landedHead ??
      (await gitRaw(parent.directory, ["rev-parse", "HEAD"]).then((r) => (r.code === 0 ? r.out : childHead)))
    return succeeded({ entry: entry.id, state: "landed", head: landedHead })
  }
  return succeeded({ entry: entry.id, state: "pending", head: null })
}
