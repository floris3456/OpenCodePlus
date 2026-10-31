import { createHash } from "node:crypto"
import path from "node:path"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Effect } from "effect"
import { bySession, isAttemptTerminal, type RunRecord } from "./run.js"

// Core's compaction summarises everything older than its kept tail, so the
// Brief a child started from survives only as a summary. When a compaction
// completes in a delegated run's own session, the Brief is sent again whole as
// one steer, before the next step reads the condensed history.

export const BRIEF_RESEND_PREFIX =
  "[team] Your Brief, whole again after the condense (the summary above may shorten it):"

// One delivery per (run, compaction): the same durable event may reach the
// handler twice in a process, and the message id below makes a replay after a
// restart idempotent in the session inbox.
const resent = new Set<string>()

/** Test-only: forget the deliveries this process has made. */
export function resetBriefResends(): void {
  resent.clear()
}

/**
 * Sends a delegated run's Brief again after a compaction completed in its
 * session. Returns whether it sent one. A lead's own run and a run that is
 * stopped or settled are left alone: only a working run, or an idle one whose
 * attempt is still open, is steered.
 */
export async function resendBriefAfterCompaction(
  ctx: Context,
  root: string,
  event: { readonly id: string; readonly sessionID: string },
): Promise<boolean> {
  const run = await bySession(root, event.sessionID)
  if (run === undefined || run.kind === "main" || run.sessionID === null) return false
  if (!openTurn(run)) return false
  const brief = await Bun.file(path.join(root, "runs", run.id, "brief.md"))
    .text()
    .catch(() => undefined)
  if (brief === undefined || brief.trim().length === 0) return false
  const key = briefResendKey(run.id, event.id)
  if (resent.has(key)) return false
  resent.add(key)
  for (const old of [...resent].slice(0, Math.max(0, resent.size - 500))) resent.delete(old)
  await Effect.runPromise(
    ctx.session.prompt({
      id: briefResendMessageID(key),
      sessionID: Session.ID.make(run.sessionID),
      text: `${BRIEF_RESEND_PREFIX}\n\n${brief}`,
      delivery: "steer",
    }),
  )
  return true
}

/** A working run, or an idle one that still has an open attempt: its turn continues. */
function openTurn(run: RunRecord): boolean {
  if (run.state === "working") return true
  if (run.state !== "idle") return false
  const last = run.attempts.at(-1)
  return last !== undefined && !isAttemptTerminal(last.state)
}

export function briefResendKey(runID: string, compactionID: string): string {
  return `${runID}:${compactionID}`
}

/** The deterministic inbox id of one Brief re-send, so a replay cannot send it twice. */
export function briefResendMessageID(key: string): SessionMessage.ID {
  return SessionMessage.ID.make(`msg_${createHash("sha256").update(`team-brief:${key}`, "utf8").digest("hex").slice(0, 26)}`)
}
