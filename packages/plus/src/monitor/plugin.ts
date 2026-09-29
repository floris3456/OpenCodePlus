// The monitor's server side: feed the host's session events to the collector,
// answer the TUI and tool queries, and keep the ledger within retention.
import type { Context } from "@opencode/plugin/effect/plugin"
import { Session } from "@opencode/schema/session"
import { Effect, Scope, Stream } from "effect"
import { teamsDataDir } from "../instructions/paths.js"
import type { MonitorMark, MonitorQueryInput, MonitorReport } from "../rpc.js"
import { bySession, loadRun } from "../teams/run.js"
import { createCollector, MonitorEvents, type Collector } from "./collector.js"
import { ledgerAt, RETENTION_DAYS, type Ledger, type SessionFacts } from "./ledger.js"
import { queryMonitor } from "./query.js"

const DAY = 86_400_000

// Retention runs once per ledger per process, not once per Location.
const pruned = new Set<string>()

export function watchMonitor(
  ctx: Context,
  config: () => string | undefined,
  open: () => Ledger = ledgerAt,
): Effect.Effect<void, never, Scope.Scope> {
  // The ledger opens at the first monitored event, not at startup: a
  // directory that never runs a session never creates it. A ledger that
  // cannot open (a broken data directory) is reported once; the monitor then
  // stays off for this instance instead of failing on every event.
  const lazy = { collector: undefined as Collector | undefined, failed: false }
  const collector = (): Collector | undefined => {
    if (lazy.collector !== undefined || lazy.failed) return lazy.collector
    lazy.failed = true
    const ledger = open()
    if (!pruned.has(ledger.path)) {
      pruned.add(ledger.path)
      ledger.prune(Date.now() - RETENTION_DAYS * DAY)
    }
    lazy.collector = createCollector({
      ledger,
      directory: ctx.location.directory,
      config,
      resolve: (sessionID) => resolveSession(ctx, sessionID),
    })
    lazy.failed = false
    return lazy.collector
  }
  return ctx.event.subscribe().pipe(
    Stream.filter((event) => MonitorEvents.has(event.type)),
    Stream.runForEach((event) =>
      Effect.try(() => collector()?.observe(event as { type: string; data?: unknown; created?: number })).pipe(
        Effect.catchCause((cause) => Effect.logWarning("plus monitor event failed", { cause, type: event.type })),
      ),
    ),
    Effect.forkScoped({ startImmediately: true }),
    Effect.asVoid,
  )
}

export function monitorQuery(ctx: Context, input: MonitorQueryInput, ledger: Ledger = ledgerAt()): MonitorReport {
  return queryMonitor(ledger, input, { directory: ctx.location.directory })
}

export function monitorMark(label: string, ledger: Ledger = ledgerAt()): MonitorMark {
  const at = Date.now()
  const trimmed = label.trim().slice(0, 80)
  const text = trimmed.length > 0 ? trimmed : new Date(at).toISOString()
  return { id: ledger.mark(text, at), at, label: text }
}

// A session met mid-life: its parent, agent and title from the host, and, for
// a team run (created without a host parent in its own worktree), the run
// that owns it and the session of the run that delegated it.
async function resolveSession(ctx: Context, sessionID: string): Promise<SessionFacts | undefined> {
  const info = await Effect.runPromise(ctx.session.get({ sessionID: Session.ID.make(sessionID) })).catch(
    () => undefined,
  )
  // A host child (subagent) already names its parent; only parentless sessions can be team runs.
  const run =
    info?.parentID !== undefined ? undefined : await bySession(teamsDataDir(), sessionID).catch(() => undefined)
  const parentRun =
    run?.parent === null || run?.parent === undefined
      ? undefined
      : await loadRun(teamsDataDir(), run.parent).catch(() => undefined)
  const parentID = info?.parentID ?? parentRun?.sessionID ?? undefined
  return {
    id: sessionID,
    ...(parentID === undefined || parentID === null ? {} : { parentID: String(parentID) }),
    ...(info?.agent === undefined ? {} : { agent: String(info.agent) }),
    ...(info?.title === undefined ? {} : { title: info.title }),
    // Every host session has a location; a partial answer must not lose the rest.
    ...(info?.location?.directory === undefined ? {} : { directory: String(info.location.directory) }),
    ...(run === undefined ? {} : { runID: run.id, role: run.role }),
  }
}
