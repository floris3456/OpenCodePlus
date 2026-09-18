import { createHash } from "node:crypto"
import path from "node:path"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Session } from "@opencode/schema/session"
import { Effect, Option, Schema } from "effect"
import { teamsDataDir } from "../instructions/paths.js"
import { put } from "./inbox.js"
import { kindOf } from "./policy.js"
import {
  attemptTransition,
  isAttemptTerminal,
  isTerminal,
  loadRun,
  saveRun,
  startAttempt,
  transition,
} from "./run.js"
import { FollowupBudget, RunID } from "./schema.js"
import { atomicJson, readJson, sanitizeLockKey } from "./store.js"
import type { TeamApiResult, TeamCaller } from "./api.js"

const FollowupInput = Schema.Struct({
  run: RunID,
  requestID: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  prompt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000)),
  delivery: Schema.optional(Schema.Literals(["now", "queue"])),
  budget: Schema.optional(FollowupBudget),
})

function succeeded(value: unknown): TeamApiResult {
  return { ok: true, value }
}

function fail(code: string, message: string, accepted?: unknown): TeamApiResult {
  if (accepted === undefined) return { ok: false, error: { code, message } }
  return { ok: false, error: { code, message, accepted } }
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? ""
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
    .join(",")}}`
}

function signatureOf(input: unknown): string {
  const record = (input ?? {}) as Record<string, unknown>
  const rest: Record<string, unknown> = {}
  for (const key of Object.keys(record)) {
    if (key !== "requestID") rest[key] = record[key]
  }
  return createHash("sha256").update(stable(rest), "utf8").digest("hex")
}

export async function followupHandler(ctx: Context, input: unknown, caller: TeamCaller): Promise<TeamApiResult> {
  const root = teamsDataDir()
  const decoded = Schema.decodeUnknownOption(FollowupInput)(input)
  if (Option.isNone(decoded)) return fail("E_INPUT", "Invalid followup input.")
  const args = decoded.value
  const stored = await loadRun(root, caller.run.id)
  const parent = stored ?? caller.run
  const child = await loadRun(root, args.run)
  if (child === undefined)
    return fail("E_UNKNOWN_RUN", `Run ${args.run} not found in this namespace.`, "a run id from list{}")
  if (child.parent !== parent.id)
    return fail("E_NOT_VISIBLE", `Run ${args.run} is not in this namespace.`, "a run id from list{}")
  if (isTerminal(child.state))
    return fail("E_NOT_VISIBLE", `Run ${args.run} is terminal (${child.state}).`, "a run id from list{}")

  const childKind = kindOf(child.role)
  if (childKind.ok && childKind.kind === "reviewer")
    return fail(
      "E_REVIEWER",
      `Reviewers take re-review via team_review(previous:"latest"), not followups.`,
      { previous: "latest" },
    )

  const signature = signatureOf(input)
  const requestPath = path.join(root, "requests", `${sanitizeLockKey(parent.id)}__${sanitizeLockKey(args.requestID)}.json`)
  const replay = await readJson<{ signature?: string; output?: Record<string, unknown> }>(requestPath)
  if (replay?.signature !== undefined) {
    if (replay.signature !== signature)
      return fail(
        "E_REQUEST_ID",
        `requestID "${args.requestID}" was used with different arguments; reuse only to retry the identical call, else pick a new requestID.`,
        "pick a new requestID",
      )
    if (replay.output !== undefined) return succeeded(replay.output)
  }

  const delivery = args.delivery ?? "queue"
  if (delivery === "now") return followupNow(ctx, root, requestPath, signature, parent.id, child.id, args.prompt, args.budget)
  return followupQueue(root, requestPath, signature, parent.id, child.id, args.prompt, args.budget)
}

async function followupQueue(
  root: string,
  requestPath: string,
  signature: string,
  parentID: string,
  childID: string,
  text: string,
  budget: { turns?: number | undefined; tokens?: number | undefined; wallMs?: number | undefined } | undefined,
): Promise<TeamApiResult> {
  const current = await loadRun(root, childID)
  if (current === undefined)
    return fail("E_UNKNOWN_RUN", `Run ${childID} not found in this namespace.`, "a run id from list{}")
  const record = budget === undefined ? current : { ...current, budget: { ...budget } }
  if (budget !== undefined) await saveRun(root, record)
  await put(root, childID, { kind: "followup", from: parentID, text })
  const last = record.attempts[record.attempts.length - 1]
  const output = { attempt: (last?.n ?? 0) + 1, state: "queued" }
  await atomicJson(requestPath, { signature, output, run: childID })
  return succeeded(output)
}

async function followupNow(
  ctx: Context,
  root: string,
  requestPath: string,
  signature: string,
  parentID: string,
  childID: string,
  text: string,
  budget: { turns?: number | undefined; tokens?: number | undefined; wallMs?: number | undefined } | undefined,
): Promise<TeamApiResult> {
  const current = await loadRun(root, childID)
  if (current === undefined)
    return fail("E_UNKNOWN_RUN", `Run ${childID} not found in this namespace.`, "a run id from list{}")
  const last = current.attempts[current.attempts.length - 1]
  if (current.state !== "idle")
    return fail(
      "E_BUSY",
      `Child is working (attempt ${last?.n ?? 1}). Use delivery:"queue" (default) or wait first.`,
      { delivery: "queue" },
    )
  void parentID
  let record = current
  const open = record.attempts[record.attempts.length - 1]
  if (open === undefined || isAttemptTerminal(open.state)) record = startAttempt(record, { trigger: "followup", prompt: text })
  const queued = record.attempts[record.attempts.length - 1]
  if (queued !== undefined && queued.state === "queued") record = attemptTransition(record, "admitted", "admit")
  if (budget !== undefined) record = { ...record, budget: { ...budget } }
  if (record.state === "idle") record = transition(record, "working", "prompt")
  if (record.sessionID === null) return fail("E_INTERNAL", `Run ${record.id} has no session to prompt.`, record.id)
  await saveRun(root, record)
  const sessions = ctx.session
  await Effect.runPromise(sessions.prompt({ sessionID: Session.ID.make(record.sessionID), text }))
  const done = record.attempts[record.attempts.length - 1]
  const output = { attempt: done?.n ?? 1, state: "admitted" }
  await atomicJson(requestPath, { signature, output, run: childID })
  return succeeded(output)
}
