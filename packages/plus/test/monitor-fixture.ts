// Monitor test fixtures: a temporary ledger and scripts of host session
// events shaped exactly as core publishes them (type, data, created).
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createCollector } from "../src/monitor/collector.js"
import { createLedger, type Ledger, type SessionFacts } from "../src/monitor/ledger.js"

const dirs: string[] = []
const ledgers: Ledger[] = []

export async function cleanupLedgers(): Promise<void> {
  ledgers.splice(0).forEach((ledger) => ledger.close())
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
}

export async function ledger(): Promise<Ledger> {
  const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "plus-monitor-"))
  dirs.push(dir)
  const created = createLedger(path.join(dir, "monitor.db"))
  ledgers.push(created)
  return created
}

// The host's session events, shaped as core publishes them (type + data).
export type Event = { type: string; data: Record<string, unknown>; created: number }
export const usage = (input: number, output: number, read = 0, write = 0, reasoning = 0) => ({
  input,
  output,
  reasoning,
  cache: { read, write },
})

export function script(sessionID: string, clock: { now: number }) {
  const events: Event[] = []
  const at = (ms: number) => {
    clock.now += ms
  }
  const push = (type: string, data: Record<string, unknown>) =>
    events.push({ type, data: { sessionID, ...data }, created: clock.now })
  return {
    events,
    at,
    step(message: string, agent = "build", model = { id: "m1", providerID: "p" }) {
      push("session.step.started", { assistantMessageID: message, agent, model, started: clock.now })
    },
    text(message: string, text: string) {
      push("session.text.ended", { assistantMessageID: message, ordinal: 0, text })
    },
    call(message: string, id: string, name: string, input: Record<string, unknown>) {
      push("session.tool.input.started", { assistantMessageID: message, id, name })
      push("session.tool.called", { assistantMessageID: message, id, input, executed: false })
    },
    ok(message: string, id: string, text: string, metadata?: Record<string, unknown>) {
      push("session.tool.success", {
        assistantMessageID: message,
        id,
        content: [{ type: "text", text }],
        executed: false,
        ...(metadata === undefined ? {} : { metadata }),
      })
    },
    fail(message: string, id: string, message2: string) {
      push("session.tool.failed", {
        assistantMessageID: message,
        id,
        error: { type: "tool", message: message2 },
        executed: false,
      })
    },
    end(message: string, finish: string, tokens: ReturnType<typeof usage>, cost = 0) {
      push("session.step.ended", { assistantMessageID: message, finish, cost, tokens })
    },
    user() {
      push("session.inbox.delivered", { inboxID: "msg_user" })
    },
    compact(tokens: ReturnType<typeof usage>) {
      push("session.compaction.ended", {
        reason: "auto",
        model: { id: "m1", providerID: "p" },
        text: "summary",
        recent: "",
        cost: 0,
        tokens,
      })
    },
    created(extra: Record<string, unknown>) {
      push("session.created", {
        projectID: "prj",
        slug: "s",
        version: "v",
        location: { directory: "/work/project" },
        ...extra,
      })
    },
  }
}

export function collect(
  target: Ledger,
  clock: { now: number },
  options: { resolve?: (id: string) => Promise<SessionFacts | undefined>; config?: string } = {},
) {
  return createCollector({
    ledger: target,
    directory: "/work/project",
    now: () => clock.now,
    ...(options.config === undefined ? {} : { config: () => options.config }),
    ...(options.resolve === undefined ? {} : { resolve: options.resolve }),
  })
}
