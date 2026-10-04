// The monitor's server side: feed the host's session events to the collector,
// answer the TUI and tool queries, and keep the ledger within retention.
import type { Context } from "@opencode/plugin/effect/plugin"
import { Session } from "@opencode/schema/session"
import { Effect, Scope, Stream } from "effect"
import path from "node:path"
import { guidancePath, teachingFilePath, teamsDataDir } from "../instructions/paths.js"
import type { MonitorMark, MonitorQueryInput, MonitorReport } from "../rpc.js"
import { bySession, loadRun } from "../teams/run.js"
import { createCollector, MonitorEvents, type Collector } from "./collector.js"
import { fingerprintWireBody, type NamedSystemPart } from "./fingerprint.js"
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

  const namedSystemParts = new Map<string, NamedSystemPart[]>()

  const registerHooks = Effect.gen(function* () {
    if (typeof ctx.session?.hook !== "function") return

    yield* ctx.session.hook("context", (event) =>
      Effect.sync(() => {
        const parts: NamedSystemPart[] = (event.system ?? []).map((part, index) => {
          const metadata = part.metadata as Record<string, unknown> | undefined
          const instr = metadata?.instruction as Record<string, unknown> | undefined
          const pathVal = instr?.path ?? metadata?.path ?? (part as { path?: unknown }).path
          let name: string
          if (typeof pathVal === "string") {
            if (pathVal === guidancePath()) name = "Plus guidance row"
            else if (pathVal === teachingFilePath()) name = "teaching"
            else name = path.basename(pathVal)
          } else if (index === 0) {
            name = "base template"
          } else if (part.text.includes("<env>") || part.text.includes("Today's date:") || part.text.includes("Platform:")) {
            name = "date/environment block"
          } else {
            name = `system:${index}`
          }
          return { name, text: part.text }
        })
        namedSystemParts.set(String(event.sessionID), parts)
      }),
    )

    yield* ctx.session.hook("http.request", (event) =>
      Effect.promise(async () => {
        const sessionID = String(event.sessionID)
        const agent = String(event.agent)
        const provider = event.model.providerID
        const model = event.model.id
        const variant = event.model.variant
        const kind = event.kind === "primary" ? "step" : event.kind
        const isTitle = event.kind === "title"
        const started = Date.now()
        const requestID = `req_${sessionID}_${started}_${Math.random().toString(36).slice(2, 8)}`

        let wireBody: unknown = ""
        try {
          const cloned = event.request.clone()
          wireBody = await cloned.text()
        } catch {
          // ignore
        }

        const parts = namedSystemParts.get(sessionID)
        const fp = fingerprintWireBody(wireBody, {
          url: event.request.url,
          namedSystemParts: parts,
        })

        try {
          const l = open()
          l.requestStarted({
            id: requestID,
            sessionID,
            kind,
            isTitle,
            agent,
            provider,
            model,
            variant,
            started,
          })
          l.requestFingerprint({
            requestID,
            sessionID,
            ...fp,
          })
          collector()?.setActiveRequest(sessionID, requestID)
        } catch {
          // ignore
        }
      }),
    )

    yield* ctx.session.hook("experimental.ws.send", (event) =>
      Effect.sync(() => {
        const sessionID = String(event.sessionID)
        const agent = String(event.agent)
        const provider = event.model.providerID
        const model = event.model.id
        const variant = event.model.variant
        const kind = event.kind === "primary" ? "step" : event.kind
        const isTitle = event.kind === "title"
        const started = Date.now()
        const requestID = `req_${sessionID}_${started}_${Math.random().toString(36).slice(2, 8)}`

        const parts = namedSystemParts.get(sessionID)
        const fp = fingerprintWireBody(event.frame, {
          namedSystemParts: parts,
        })

        try {
          const l = open()
          l.requestStarted({
            id: requestID,
            sessionID,
            kind,
            isTitle,
            agent,
            provider,
            model,
            variant,
            started,
          })
          l.requestFingerprint({
            requestID,
            sessionID,
            ...fp,
          })
          collector()?.setActiveRequest(sessionID, requestID)
        } catch {
          // ignore
        }
      }),
    )

    yield* ctx.session.hook("http.response", (event) =>
      Effect.sync(() => {
        if (event.response.status >= 400) {
          const sessionID = String(event.sessionID)
          const reqId = collector()?.getActiveRequest(sessionID)
          if (reqId) {
            try {
              open().requestEnded(reqId, {
                ended: Date.now(),
                status: "error",
                error: `HTTP ${event.response.status}`,
              })
            } catch {
              // ignore
            }
          }
        }
      }),
    )

    yield* ctx.session.hook("warming", (event) =>
      Effect.sync(() => {
        if (event.phase === "warmed") {
          const sessionID = String(event.sessionID)
          const c = collector()
          const activeReq = c?.getActiveRequest(sessionID)
          const reqId = activeReq && activeReq.length > 0 ? activeReq : `ping_${sessionID}_${Date.now()}`
          const at = event.now ?? Date.now()
          const usage = event.usage
            ? {
                input: event.usage.input,
                output: event.usage.output,
                reasoning: event.usage.reasoning,
                cacheRead: event.usage.cache.read,
                cacheWrite: event.usage.cache.write,
                cost: 0,
              }
            : undefined
          try {
            const l = open()
            l.requestStarted({
              id: reqId,
              sessionID,
              kind: "ping",
              isTitle: false,
              agent: String(event.agent),
              provider: event.model.providerID,
              model: event.model.id,
              variant: event.model.variant,
              started: at,
            })
            l.requestEnded(reqId, {
              ended: at,
              status: event.error ? "error" : "completed",
              error: event.error,
              usage,
            })
          } catch {
            // ignore
          }
          c?.setActiveRequest(sessionID, "")
        }
      }),
    )
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("plus monitor hooks registration failed", { cause })),
  )

  const stream = ctx.event.subscribe().pipe(
    Stream.filter((event) => MonitorEvents.has(event.type)),
    Stream.runForEach((event) =>
      Effect.try(() => collector()?.observe(event as { type: string; data?: unknown; created?: number })).pipe(
        Effect.catchCause((cause) => Effect.logWarning("plus monitor event failed", { cause, type: event.type })),
      ),
    ),
  )

  return Effect.gen(function* () {
    yield* registerHooks
    yield* stream
  }).pipe(
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
