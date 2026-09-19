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
  type RunRecord,
} from "./run.js"
import { FollowupBudget, RunID, toolError } from "./schema.js"
import { atomicJson, readJson, sanitizeLockKey } from "./store.js"
import { io } from "./io.js"
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
  if (child === undefined || child.parent !== parent.id)
    return fail(
      "E_NOT_CHILD",
      `Run ${args.run} is not your direct child. Your children: [${parent.children.join(", ")}]. Use status to read others.`,
      parent.children,
    )
  if (isTerminal(child.state))
    return fail(
      "E_TERMINAL",
      `Run ${args.run} is superseded/reaped; delegate a fresh run.`,
      "delegate a fresh run",
    )

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
  if (delivery === "now") return followupNow(ctx, root, requestPath, signature, parent, child.id, args.prompt, args.budget)
  return followupQueue(ctx, root, requestPath, signature, parent, child.id, args.prompt, args.budget)
}

type FollowupBudgetInput = { turns?: number | undefined; tokens?: number | undefined; wallMs?: number | undefined } | undefined

async function followupQueue(
  ctx: Context,
  root: string,
  requestPath: string,
  signature: string,
  parent: RunRecord,
  childID: string,
  text: string,
  budget: FollowupBudgetInput,
): Promise<TeamApiResult> {
  const current = await loadRun(root, childID)
  if (current === undefined || current.parent !== parent.id)
    return fail(
      "E_NOT_CHILD",
      `Run ${childID} is not your direct child. Your children: [${parent.children.join(", ")}]. Use status to read others.`,
      parent.children,
    )
  if (isTerminal(current.state))
    return fail(
      "E_TERMINAL",
      `Run ${childID} is superseded/reaped; delegate a fresh run.`,
      "delegate a fresh run",
    )
  if (current.state !== "idle") {
    const record = budget === undefined ? current : { ...current, budget: { ...budget } }
    if (budget !== undefined) await saveRun(root, record)
    await put(root, childID, { kind: "followup", from: parent.id, text })
    // Delivery to a working child happens when it next goes idle; the sweeper that performs that handoff is not implemented yet (step 6).
    const last = record.attempts[record.attempts.length - 1]
    const output = { attempt: last?.n ?? 0, state: "queued" }
    await atomicJson(requestPath, { signature, output, run: childID })
    return succeeded(output)
  }
  await put(root, childID, { kind: "followup", from: parent.id, text })
  const admitted = await admitIdleChild(ctx, root, current, text, budget)
  const done = admitted.attempts[admitted.attempts.length - 1]
  const output = { attempt: done?.n ?? 1, state: "admitted" }
  await atomicJson(requestPath, { signature, output, run: childID })
  return succeeded(output)
}

async function followupNow(
  ctx: Context,
  root: string,
  requestPath: string,
  signature: string,
  parent: RunRecord,
  childID: string,
  text: string,
  budget: FollowupBudgetInput,
): Promise<TeamApiResult> {
  const current = await loadRun(root, childID)
  if (current === undefined || current.parent !== parent.id)
    return fail(
      "E_NOT_CHILD",
      `Run ${childID} is not your direct child. Your children: [${parent.children.join(", ")}]. Use status to read others.`,
      parent.children,
    )
  if (isTerminal(current.state))
    return fail(
      "E_TERMINAL",
      `Run ${childID} is superseded/reaped; delegate a fresh run.`,
      "delegate a fresh run",
    )
  const last = current.attempts[current.attempts.length - 1]
  if (current.state !== "idle")
    return fail(
      "E_BUSY",
      `Child is working (attempt ${last?.n ?? 1}). Use delivery:"queue" (default) or wait first.`,
      { delivery: "queue" },
    )
  const admitted = await admitIdleChild(ctx, root, current, text, budget)
  const done = admitted.attempts[admitted.attempts.length - 1]
  const output = { attempt: done?.n ?? 1, state: "admitted" }
  await atomicJson(requestPath, { signature, output, run: childID })
  return succeeded(output)
}

async function admitIdleChild(
  ctx: Context,
  root: string,
  current: RunRecord,
  text: string,
  budget: FollowupBudgetInput,
): Promise<RunRecord> {
  const open = current.attempts[current.attempts.length - 1]
  const started = open === undefined || isAttemptTerminal(open.state) ? startAttempt(current, { trigger: "followup", prompt: text }) : current
  const queued = started.attempts[started.attempts.length - 1]
  const admitted = queued !== undefined && queued.state === "queued" ? attemptTransition(started, "admitted", "admit") : started
  const budgeted = budget === undefined ? admitted : { ...admitted, budget: { ...budget } }
  const working = budgeted.state === "idle" ? transition(budgeted, "working", "prompt") : budgeted
  if (working.sessionID === null) throw toolError("E_INTERNAL", `Run ${working.id} has no session to prompt.`, working.id)
  const previous = current
  await saveRun(root, working)
  await Effect.runPromise(
    ctx.session.prompt({ sessionID: Session.ID.make(working.sessionID), text }).pipe(
      Effect.onError(() => Effect.ignore(io(() => saveRun(root, previous)))),
    ),
  )
  return working
}
