// The monitor's server side: feed the host's session events to the collector,
// answer the TUI and tool queries, and keep the ledger within retention.
import type { Context } from "@opencode/plugin/effect/plugin"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { Session } from "@opencode/schema/session"
import { Effect, Scope, Stream } from "effect"
import path from "node:path"
import { guidancePath, teachingFilePath, teamsDataDir } from "../instructions/paths.js"
import type { MonitorMark, MonitorQueryInput, MonitorReport } from "../rpc.js"
import { bySession, inferRunTeam, loadRun } from "../teams/run.js"
import { createCollector, MonitorEvents, type Collector } from "./collector.js"
import { fingerprintWireBody, type NamedSystemPart } from "./fingerprint.js"
import { ledgerAt, RETENTION_DAYS, type ContextFact, type Ledger, type SessionFacts } from "./ledger.js"
import { queryMonitor } from "./query.js"

const DAY = 86_400_000

// Retention runs once per ledger per process, not once per Location.
const pruned = new Set<string>()

/** Synchronous quota callbacks must not make credential selection fail. */
export function monitorFact(fact: ContextFact, open: () => Ledger = ledgerAt): void {
  Effect.runSync(Effect.sync(() => open().contextFact(fact)).pipe(
    Effect.catchCause(() => Effect.logWarning("plus monitor fact failed", { kind: fact.kind })),
  ))
}

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
      resolve: (sessionID) => resolveSession(ctx, sessionID, ledger),
    })
    lazy.failed = false
    return lazy.collector
  }

  const namedSystemParts = new Map<string, NamedSystemPart[]>()
  const prices = new Map<string, string>()
  const pricing = async (ledger: Ledger, sessionID: string, provider: string, model: string, at: number) => {
    const listed = await Effect.runPromise(ctx.model.list())
    const rates = listed.data.find((m) => m.providerID === provider && m.id === model)?.cost
    if (!rates?.length) return
    const key = `${sessionID}/${provider}/${model}`
    const signature = JSON.stringify(rates)
    if (prices.get(key) === signature) return
    ledger.contextFact({ sessionID, at, kind: "pricing", detail: { provider, model, rates } })
    prices.set(key, signature)
  }
  // Hooks run inside the provider request. Monitoring must never fail it,
  // including synchronous defects (e.g. SQLite could not open).
  const hook = <K extends keyof SessionHooks>(name: K, body: (event: SessionHooks[K]) => Effect.Effect<void>) =>
    ctx.session.hook(name, (event) => Effect.suspend(() => body(event)).pipe(
      Effect.catchCause(() => Effect.logWarning("plus monitor hook failed", { hook: name })),
    ))

  const registerHooks = Effect.gen(function* () {
    if (typeof ctx.session?.hook !== "function") return

    yield* hook("context", (event) =>
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

    yield* hook("http.request", (event) =>
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

        const wireBody = await event.request.clone().text().catch(() => "")
        const parts = namedSystemParts.get(sessionID)
        const fp = fingerprintWireBody(wireBody, {
          url: event.request.url,
          namedSystemParts: parts,
        })

        const l = open()
        l.session({ id: sessionID, agent, directory: ctx.location.directory }, started)
        l.retireOpenRequests(sessionID, kind)
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
        await pricing(l, sessionID, provider, model, started)
      }),
    )

    yield* hook("experimental.ws.send", (event) =>
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

        const parts = namedSystemParts.get(sessionID)
        const fp = fingerprintWireBody(event.frame, {
          namedSystemParts: parts,
        })

        const l = open()
        l.session({ id: sessionID, agent, directory: ctx.location.directory }, started)
        l.retireOpenRequests(sessionID, kind)
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
        await pricing(l, sessionID, provider, model, started)
      }),
    )

    yield* hook("http.response", (event) =>
      Effect.sync(() => {
        if (event.response.status >= 400) {
          const sessionID = String(event.sessionID)
          const kind = event.kind === "primary" ? "step" : event.kind
          const l = open()
          const openReq = l.oldestOpenRequest(sessionID, kind)
          if (openReq) {
            l.requestEnded(openReq.id, {
              ended: Date.now(),
              status: "error",
              error: `HTTP ${event.response.status}`.slice(0, 160),
            })
          }
        }
      }),
    )

    yield* hook("generated", (event) =>
      Effect.promise(async () => {
        const sessionID = String(event.sessionID)
        const l = open()
        const openReq = l.oldestOpenRequest(sessionID, "generate")
        const at = Date.now()
        l.session({ id: sessionID, agent: String(event.agent), directory: ctx.location.directory }, at)
        const usage = event.usage
          ? {
              input: event.usage.input,
              output: event.usage.output,
              reasoning: event.usage.reasoning,
              cacheRead: event.usage.cache.read,
              cacheWrite: event.usage.cache.write,
              cost: event.cost ?? 0,
            }
          : undefined
        const error = event.error ? event.error.slice(0, 160) : undefined
        if (openReq) {
          l.requestEnded(openReq.id, {
            ended: at,
            status: error ? "error" : "completed",
            error,
            usage,
          })
          l.retireOpenRequests(sessionID, "generate", openReq.id)
        } else {
          const reqId = `gen_${sessionID}_${at}`
          l.requestStarted({
            id: reqId,
            sessionID,
            kind: "generate",
            agent: String(event.agent),
            provider: event.model.providerID,
            model: event.model.id,
            variant: event.model.variant,
            started: at,
          })
          l.requestEnded(reqId, {
            ended: at,
            status: error ? "error" : "completed",
            error,
            usage,
          })
        }
        await pricing(l, sessionID, event.model.providerID, event.model.id, openReq?.started ?? at)
      }),
    )

    yield* hook("warming", (event) =>
      Effect.sync(() => {
        open().contextFact({ sessionID: String(event.sessionID), at: event.now ?? Date.now(), kind: "warming", detail: {
          state: event.error ? "failed" : event.settings === undefined ? event.phase === "activity" ? "off" : "ended" : "on",
          phase: event.phase,
          since: event.since,
          ...(event.settings === undefined ? {} : { until: event.since + event.settings.duration }),
        } })
        if (event.phase === "warmed") {
          const sessionID = String(event.sessionID)
          const l = open()
          l.relabelLatestRequest(sessionID, "generate", "ping")
          if (event.error) {
            const latestPing = l.oldestOpenRequest(sessionID, "ping")
            if (latestPing) {
              l.requestEnded(latestPing.id, {
                ended: event.now ?? Date.now(),
                status: "error",
                error: event.error.slice(0, 160),
              })
            }
          }
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

export async function monitorQuery(ctx: Context, input: MonitorQueryInput, ledger: Ledger = ledgerAt()): Promise<MonitorReport> {
  // Older, idle runs may never produce another event. Resolve their membership
  // for historical queries as well, retaining only unambiguous answers.
  const older = ledger.db.query<{ id: string; run_id: string | null; role: string; directory: string | null }, []>("select id, run_id, role, directory from session where team is null and role is not null").all()
  await Promise.all(older.map(async (row) => {
    const run = row.run_id === null ? undefined : await loadRun(teamsDataDir(), row.run_id).catch(() => undefined)
    const team = await inferRunTeam(run ?? { role: row.role, directory: row.directory ?? ctx.location.directory })
    if (team !== undefined) ledger.db.query("update session set team = ? where id = ? and team is null").run(team, row.id)
  }))
  ledger.db.exec(`with recursive inherited(id, team) as (
    select id, team from session where team is not null
    union select s.id, i.team from session s join inherited i on s.parent_id = i.id where s.team is null
  ) update session set team = (select team from inherited where inherited.id = session.id)
    where team is null and id in (select id from inherited)`)
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
async function resolveSession(ctx: Context, sessionID: string, ledger: Ledger, seen = new Set<string>()): Promise<SessionFacts | undefined> {
  if (seen.has(sessionID)) return undefined
  seen.add(sessionID)
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
  const parent = parentID === undefined ? undefined : await resolveSession(ctx, String(parentID), ledger, seen)
  if (parent) ledger.session(parent, Date.now())
  const team = run === undefined ? parent?.team : await inferRunTeam(run)
  return {
    id: sessionID,
    ...(parentID === undefined || parentID === null ? {} : { parentID: String(parentID) }),
    ...(info?.agent === undefined ? {} : { agent: String(info.agent) }),
    ...(info?.title === undefined ? {} : { title: info.title }),
    // Every host session has a location; a partial answer must not lose the rest.
    ...(info?.location?.directory === undefined ? {} : { directory: String(info.location.directory) }),
    ...(run === undefined ? {} : { runID: run.id, role: run.role }),
    ...(team === undefined ? {} : { team }),
  }
}
