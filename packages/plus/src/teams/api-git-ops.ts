import path from "node:path"
import { teamsDataDir } from "../instructions/paths.js"
import { loadRun } from "./run.js"
import { SetChecksInput, validateChecks } from "./schema.js"
import { atomicJson } from "./store.js"
import type { TeamApiResult, TeamCaller } from "./api.js"

function succeeded(value: unknown): TeamApiResult {
  return { ok: true, value }
}

function fail(code: string, message: string, accepted?: unknown): TeamApiResult {
  if (accepted === undefined) return { ok: false, error: { code, message } }
  return { ok: false, error: { code, message, accepted } }
}

// validateChecks throws a toolError-shaped plain object; surface it unchanged
// (same code, message and accepted delegateHandler returns).
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

// Records integration checks in the caller's own run directory (the file
// readChecks and checks.ts read), replacing any previous list. An empty
// array is legal and clears the list.
export async function setChecksHandler(args: SetChecksInput, caller: TeamCaller): Promise<TeamApiResult> {
  const root = teamsDataDir()
  const checks = [...args.checks]
  try {
    validateChecks(checks)
  } catch (error) {
    return { ok: false, error: thrownError(error) }
  }
  const stored = await loadRun(root, caller.run.id)
  const record = stored ?? caller.run
  await atomicJson(path.join(root, "runs", record.id, "checks.json"), checks)
  return succeeded({ checks: checks.map((check) => check.id) })
}
