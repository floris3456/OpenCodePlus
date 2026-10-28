// The monitor's server side: feed the host's session events to the collector,
// answer the TUI and tool queries, and keep the ledger within retention.
import type { Context } from "@opencode/plugin/effect/plugin"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { Location } from "@opencode/schema/location"
import { AbsolutePath } from "@opencode/schema/schema"
import { Session } from "@opencode/schema/session"
import { Effect, Option, Schema, Scope, Stream } from "effect"
import path from "node:path"
import { guidancePath, teachingFilePath, teamsDataDir } from "../instructions/paths.js"
import type { MonitorMark, MonitorNotices, MonitorPrompt, MonitorPromptInput, MonitorQueryInput, MonitorReport, MonitorRequestDetail, MonitorSessionList, MonitorSessionsInput, MonitorStepInput, MonitorStepResult, PlusSettings } from "../rpc.js"
import { dismissNotice, queryNotices, sessionChecklist } from "./notices.js"
import { bySession, inferRunTeam, loadRun } from "../teams/run.js"
import { causeWords, isMiss } from "./cache.js"
import { createCollector, MonitorEvents, type Collector } from "./collector.js"
import { fingerprintWireBody, sha256, type NamedSystemPart } from "./fingerprint.js"
import { endRequestWindow, defaultLedgerPath, ledgerAt, RETENTION_DAYS, type ContextFact, type Ledger, type SessionFacts } from "./ledger.js"
import { queryMonitor } from "./query.js"
import { ledgerHeld, startLedgerCompaction, whileHeld } from "./compact.js"
import { recordModelObservation } from "./model-observation.js"
import { captureWire, queryCacheResults, scheduleCacheBackfill } from "./snapshot.js"
import { pruneWire, queryPrompt } from "./wire.js"

const DAY = 86_400_000

// Retention runs once per ledger per process, not once per Location.
const pruned = new Set<string>()

/** Synchronous quota callbacks must not make credential selection fail. */
export function monitorFact(fact: ContextFact, open: () => Ledger = ledgerAt): void {
  // A Monitor write, so it waits with the others while the ledger is rewritten.
  const write = () => Effect.runSync(Effect.sync(() => open().contextFact(fact)).pipe(
    Effect.catchCause(() => Effect.logWarning("plus monitor fact failed", { kind: fact.kind })),
  ))
  if (open === ledgerAt && whileHeld(defaultLedgerPath(), write)) return
  write()
}

export function watchMonitor(
  ctx: Context,
  config: () => string | undefined,
  open: () => Ledger = ledgerAt,
  file: () => string | undefined = () => (open === ledgerAt ? defaultLedgerPath() : undefined),
): Effect.Effect<void, never, Scope.Scope> {
  // Compaction runs off this thread, but its VACUUM rewrites the file, so
  // nothing here may open it meanwhile. Every monitored write goes through
  // `write`, which queues it in arrival order when the file is held; the queue
  // replays through these same paths when the worker finishes.
  const write = (task: () => void) => {
    const target = file()
    if (target !== undefined && whileHeld(target, task)) return
    task()
  }
  const held = () => {
    const target = file()
    return target !== undefined && ledgerHeld(target)
  }
  // Async writes (wire capture, pricing lookups) resolve after the replay, so a
  // held hook still returns a promise; a queued task resolves when it runs.
  const writeAsync = (task: () => Promise<void>) =>
    new Promise<void>((resolve) => {
      const fail = (cause: unknown) => {
        Effect.runSync(Effect.logWarning("plus monitor write failed", { cause }))
        resolve()
      }
      const target = file()
      if (target !== undefined && whileHeld(target, () => void task().then(resolve, fail))) return
      void task().then(resolve, fail)
    })
  // The ledger opens at the first monitored event, not at startup: a
  // directory that never runs a session never creates it. A ledger that
  // cannot open (a broken data directory) is reported once; the monitor then
  // stays off for this instance instead of failing on every event.
  const lazy = { collector: undefined as Collector | undefined, failed: false }
  const collector = (): Collector | undefined => {
    if (lazy.collector !== undefined || lazy.failed) return lazy.collector
    lazy.failed = true
    const ledger = open()
    scheduleCacheBackfill(ledger)
    if (!pruned.has(ledger.path)) {
      pruned.add(ledger.path)
      // Retention is a synchronous scan; keep it off the first monitored prompt.
      setTimeout(() => {
        try {
          ledger.prune(Date.now() - RETENTION_DAYS * DAY)
          pruneWire(ledger, Date.now() - RETENTION_DAYS * DAY)
        } catch (cause) {
          Effect.runFork(Effect.logWarning("plus monitor prune failed", { cause }))
        }
      }, 120_000).unref()
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
  const httpRequests = new WeakMap<Request, string>()
  const wsRequests = new Map<string, string>()
  const responseId = (requestID: string, body: string) => {
    const value = JSON.parse(body) as { type?: string; id?: string; response?: { id?: string } }
    if (value.type && value.type !== "response.created" && value.type !== "response.completed") return false
    const id = value.response?.id ?? value.id
    if (typeof id !== "string") return false
    const l = open()
    const fp = l.getFingerprint(requestID)
    if (fp) l.requestFingerprint({ ...fp, responseId: sha256(id) })
    return true
  }
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
  const warnedHooks = new Set<keyof SessionHooks>()
  const failedHook = (name: keyof SessionHooks) => {
    if (warnedHooks.has(name)) return Effect.void
    warnedHooks.add(name)
    return Effect.logWarning("plus monitor hook failed", { hook: name, code: "storage-or-observer-failed" })
  }
  const hook = <K extends keyof SessionHooks>(name: K, body: (event: SessionHooks[K]) => Effect.Effect<void>) =>
    ctx.session.hook(name, (event) => Effect.suspend(() => body(event)).pipe(
      Effect.catchCause(() => failedHook(name)),
    ))

  const registerHooks = Effect.gen(function* () {
    if (typeof ctx.session?.hook !== "function") return
    const warning = { emitted: false }
    yield* ctx.session.hook("model.observed", (event) => Effect.sync(() => write(() => recordModelObservation(open(), event, ctx.location.directory))).pipe(
      Effect.catchCause(() => {
        if (warning.emitted) return Effect.void
        warning.emitted = true
        return Effect.logWarning("plus model observation unavailable", { code: "storage-failed" })
      }),
    ))

    yield* hook("compaction.decide", (event) => Effect.sync(() => write(() => {
      if (event.compact && event.metadata?.["quota.switch"] === true)
        open().contextFact({ sessionID: event.sessionID, at: Date.now(), kind: "quota_handoff" })
    })))

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
        const started = event.started ?? Date.now()
        const requestID = event.requestID ?? `req_${sessionID}_${started}_${Math.random().toString(36).slice(2, 8)}`

        const wireBody = await event.request.clone().text().catch(() => "")
        const url = event.request.url
        const parts = namedSystemParts.get(sessionID)
        const fp = fingerprintWireBody(wireBody, {
          url,
          namedSystemParts: parts,
        })

        await writeAsync(async () => {
        const l = open()
        // Only a primary request's agent is the chat's shown agent; a title or
        // throwaway generate call shares the session but must not rewrite it.
        l.session(
          { id: sessionID, ...(kind === "step" ? { agent } : {}), directory: ctx.location.directory },
          started,
        )
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
        httpRequests.set(event.request, requestID)
        // Core runs these observers after ALL transforms, including later plugins.
        event.observers ??= []
        event.observers.push((request) => Effect.promise(async () => {
          httpRequests.set(request, requestID)
          const body = await request.clone().text()
          // No transform changed the body: the fingerprint stored above already describes it.
          if (body !== wireBody || request.url !== url)
            l.requestFingerprint({ requestID, sessionID, ...fingerprintWireBody(body, { url: request.url, namedSystemParts: parts }) })
          await captureWire(l, requestID, body, { sessionID, url: request.url, at: started })
        }).pipe(Effect.catchCause(() => failedHook("http.request"))))
        await pricing(l, sessionID, provider, model, started)
        })
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
        const started = event.started ?? Date.now()
        const requestID = event.requestID ?? `req_${sessionID}_${started}_${Math.random().toString(36).slice(2, 8)}`

        const parts = namedSystemParts.get(sessionID)
        const fp = fingerprintWireBody(event.frame, {
          namedSystemParts: parts,
        })

        await writeAsync(async () => {
        const l = open()
        l.session(
          { id: sessionID, ...(kind === "step" ? { agent } : {}), directory: ctx.location.directory },
          started,
        )
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
        wsRequests.set(sessionID, requestID)
        event.observers ??= []
        const sent = event.frame
        event.observers.push((frame) => Effect.promise(async () => {
          if (typeof frame !== "string" || frame !== sent)
            l.requestFingerprint({ requestID, sessionID, ...fingerprintWireBody(frame, { namedSystemParts: parts }) })
          await captureWire(l, requestID, typeof frame === "string" ? frame : JSON.stringify(frame), { sessionID, at: started })
        }).pipe(Effect.catchCause(() => failedHook("experimental.ws.send"))))
        await pricing(l, sessionID, provider, model, started)
        })
      }),
    )

    yield* hook("http.response", (event) =>
      Effect.sync(() => {
        // Wrapping the body stream has to happen before the hook returns, and
        // knowing whether to wrap it means reading this request's fingerprint.
        // While the ledger is held the read would open the file, so this one
        // best-effort capture (a hashed response id) waits for the next request.
        if (held()) return
        const requestID = httpRequests.get(event.request)
        const fp = requestID ? open().getFingerprint(requestID) : undefined
        if (requestID && fp?.protocol === "openai-responses" && event.response.body) {
          const decoder = new TextDecoder()
          let buffered = ""
          let captured = false
          const capture = () => {
            if (captured) return
            for (const line of buffered.split("\n")) {
              const json = line.startsWith("data: ") ? line.slice(6) : line
              try { if (responseId(requestID, json)) captured = true } catch { /* An incomplete SSE/JSON record. */ }
            }
          }
          event.response = new Response(event.response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              if (!captured && buffered.length < 65_536) {
                buffered += decoder.decode(chunk, { stream: true })
                capture()
              }
              controller.enqueue(chunk)
            },
            flush() { capture() },
          })), { status: event.response.status, statusText: event.response.statusText, headers: event.response.headers })
        }
        if (event.response.status >= 400) write(() => {
          const l = open()
          const openReq = requestID ? l.getRequest(requestID) : undefined
          if (openReq) {
            l.requestEnded(openReq.id, {
              ended: Date.now(),
              status: "error",
              error: { type: "HttpError", status: event.response.status },
            })
          }
        })
      }),
    )

    yield* hook("experimental.ws.receive", (event) => Effect.sync(() => write(() => {
      const requestID = wsRequests.get(String(event.sessionID))
      if (requestID) responseId(requestID, event.frame)
    })))

    yield* hook("generated", (event) =>
      Effect.promise(async () => {
        if (event.invocationID !== undefined) return
        const sessionID = String(event.sessionID)
        const kind = event.kind ?? "generate"
        const at = event.ended ?? Date.now()
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
        await writeAsync(async () => {
          const l = open()
          // A generate or title outcome is auxiliary: it must never rewrite the
          // chat's shown agent with the side call's identity.
          l.session({ id: sessionID, directory: ctx.location.directory }, at)
          const request = endRequestWindow(l, {
            id: `${kind}_${sessionID}_${event.started ?? at}_${at}`, sessionID, kind, isTitle: kind === "title",
            messageID: `${kind}:${event.started ?? at}:${at}`,
            agent: String(event.agent), provider: event.model.providerID, model: event.model.id, variant: event.model.variant,
            started: event.started ?? 0,
          }, { ended: at, status: event.error ? "error" : "completed", error: event.error, usage }, true)
          await pricing(l, sessionID, event.model.providerID, event.model.id, request?.started ?? at)
        })
      }),
    )

    yield* hook("warming", (event) =>
      Effect.sync(() => write(() => {
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
        }
      })),
    )
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("plus monitor hooks registration failed", { cause })),
  )

  const stream = ctx.event.subscribe().pipe(
    Stream.filter((event) => MonitorEvents.has(event.type)),
    Stream.runForEach((event) =>
      Effect.try(() => {
        // Collected events are the monitor's write path too: while the ledger
        // is held they wait in order and replay through this same collector.
        write(() => { collector()?.observe(event) })
      }).pipe(
        Effect.catchCause((cause) => Effect.logWarning("plus monitor event failed", { cause, type: event.type })),
      ),
    ),
  )

  return Effect.gen(function* () {
    // Compaction starts with the monitor, at service start, not at the first
    // monitored request: it then finishes long before a chat needs the ledger.
    // A failed rewrite is logged by the worker's promise; the ledger opens as
    // it is and the buffered work replays, so the monitor never stops.
    const target = file()
    if (target !== undefined) startLedgerCompaction(target)
    yield* registerHooks
    yield* stream
  }).pipe(
    Effect.forkScoped({ startImmediately: true }),
    Effect.asVoid,
  )
}

const TEAM_RESOLVE_MS = 60_000
const teamsResolved = new WeakMap<Ledger, number>()

/**
 * The ledger a query may read, or undefined while its file is being rewritten.
 * An explicitly passed ledger (tests, tools) is used as it is; the default one
 * is not opened, so a query during compaction never touches the file.
 */
function ledgerFor(ledger: Ledger | undefined): Ledger | undefined {
  if (ledger !== undefined) return ledger
  return ledgerHeld(defaultLedgerPath()) ? undefined : ledgerAt()
}

/** What the Monitor shows while the ledger is being rewritten: a status, not rows. */
function compactingReport(_input: MonitorQueryInput): MonitorReport {
  return {
    compacting: true,
    now: Date.now(),
    totals: {
      steps: 0, calls: 0, errors: 0, running: 0,
      input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0,
      callTokens: 0, resultTokens: 0, carried: 0,
    },
    groups: [],
    feed: [],
    facets: { agents: [], tools: [], models: [] },
    marks: [],
    requests: [],
  }
}

export async function monitorQuery(ctx: Context, input: MonitorQueryInput, ledger?: Ledger): Promise<MonitorReport> {
  const db = ledgerFor(ledger)
  if (db === undefined) return compactingReport(input)
  if (input.view === "cache") return monitorCache(ctx, input, db)
  // Older, idle runs may never produce another event. Resolve their membership
  // for historical queries as well, retaining only unambiguous answers. Run
  // files change rarely, so a polling screen re-reads them at most once a minute.
  if (Date.now() - (teamsResolved.get(db) ?? 0) > TEAM_RESOLVE_MS) {
    teamsResolved.set(db, Date.now())
    await resolveTeams(ctx, db)
  }
  const report = queryMonitor(db, input, { directory: ctx.location.directory })
  // Saved results back Tools and Sessions totals; a historical backlog fills in behind.
  scheduleCacheBackfill(db)
  if (input.view !== "sessions" || !report.sessions?.length) return report
  // Host facts only for the rows on this page, never for the whole ledger.
  const facts = await hostSessionFacts(ctx, db, report.sessions.map((row) => row.sessionID))
  return {
    ...report,
    sessions: report.sessions.map((row) => ({
      ...row,
      ...(facts.agents.has(row.sessionID) ? { agent: facts.agents.get(row.sessionID)! } : {}),
      ...(facts.states.has(row.sessionID) ? { state: facts.states.get(row.sessionID)! } : {}),
    })),
  }
}

async function resolveTeams(ctx: Context, ledger: Ledger) {
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
}

export function monitorCache(ctx: Context, input: MonitorQueryInput, ledger?: Ledger): MonitorReport {
  const db = ledgerFor(ledger)
  if (db === undefined) return compactingReport(input)
  const report = queryCacheResults(db, input, { directory: ctx.location.directory })
  if (report.cachePending) scheduleCacheBackfill(db)
  return report
}

export function monitorPrompt(input: MonitorPromptInput, ledger?: Ledger): MonitorPrompt {
  const db = ledgerFor(ledger)
  if (db === undefined) return { compacting: true }
  return queryPrompt(db, input)
}

export async function monitorStep(
  ctx: Context,
  input: MonitorStepInput,
  ledger?: Ledger,
): Promise<MonitorStepResult> {
  const db = ledgerFor(ledger)
  if (db === undefined) return { status: "compacting" }
  const row = db.db.query<{ ended: number | null; detail: string | null }, [string]>(`
    select r.ended, c.detail from request r left join cache_result c on c.request_id = r.id
    where r.session_id = ? and r.kind != 'ping' and r.is_title = 0
      and coalesce(json_extract(r.observation, '$.scope'), '') != 'exchange'
    order by r.started desc, r.id desc limit 1`).get(input.sessionID)
  if (!row || row.ended === null) return { status: "pending" }
  if (!row.detail) {
    scheduleCacheBackfill(db)
    return { status: "pending" }
  }
  const detail: MonitorRequestDetail = JSON.parse(row.detail)
  const req = detail.request
  const changedPart =
    detail.segments.find((c) => c.name !== "cache markers")?.name ?? detail.firstDivergence
  const notReused = req.missTokens ?? 0
  const miss = isMiss(req)
  const cause = req.cause
  const causeText = req.causeText ?? causeWords(cause, changedPart)
  return {
    status: "ready",
    stepID: req.messageID ?? req.id,
    requestID: req.id,
    miss,
    notReused,
    ...(cause === undefined ? {} : { cause }),
    causeText,
    ...(changedPart === undefined ? {} : { changedPart }),
    ...(req.droppedThinking === undefined ? {} : { droppedThinking: req.droppedThinking }),
  }
}

interface HostSessionFacts {
  readonly states: ReadonlyMap<string, string>
  readonly agents: ReadonlyMap<string, string>
}

// Real per-session state and agent, derived at query time from the host with the
// ledger as fallback, never persisted. A session's state is "running" when the
// host reports it active, else the last execution's recorded outcome; its agent
// comes from the host's session info, because a title or generate call's
// identity must not overwrite the chat's shown primary agent.
async function hostSessionFacts(ctx: Context, ledger: Ledger, ids: readonly string[]): Promise<HostSessionFacts> {
  const states = new Map<string, string>()
  const agents = new Map<string, string>()
  // A session is running while the host reports it active, or—when that read
  // fails—while it has an open request of its own. Both are current facts and
  // must beat the last completed execution's outcome.
  const running = await Effect.runPromise(Effect.suspend(() => ctx.session.active())).catch(() => undefined)
  const shown = new Set(ids)
  for (const id of Object.keys(running ?? {})) if (shown.has(id)) states.set(id, "running")
  // The few open requests, rather than every request of every listed session.
  ledger.db.query<{ session_id: string }, []>("select distinct session_id from request indexed by request_open where ended is null")
    .all()
    .forEach((row) => { if (shown.has(row.session_id) && !states.has(row.session_id)) states.set(row.session_id, "running") })
  // The outcome vocabulary is the host's; show its meaning plainly.
  const label = (outcome: string) =>
    outcome === "succeeded" ? "completed" : outcome === "failed" ? "error" : outcome
  await Promise.all(
    ids.map(async (id) => {
      // Ledger session ids can pre-date host validation; only a well-formed one
      // is looked up in the host.
      const decoded = Schema.decodeUnknownOption(Session.ID)(id)
      if (Option.isNone(decoded)) return
      const info = await Effect.runPromise(ctx.session.get({ sessionID: decoded.value })).catch(() => undefined)
      if (info?.agent !== undefined) agents.set(id, String(info.agent))
      if (!states.has(id) && info?.outcome !== undefined) states.set(id, label(info.outcome))
    }),
  )
  return { states, agents }
}

export function monitorNotices(settings: PlusSettings, ledger?: Ledger): MonitorNotices {
  const db = ledgerFor(ledger)
  return { notices: db === undefined ? [] : queryNotices(db, settings) }
}

export function monitorDismiss(requestID: string, ledger?: Ledger): void {
  const db = ledgerFor(ledger)
  if (db !== undefined) dismissNotice(db, requestID)
}

// Roughly when this server process started: what the monitor saw before it
// belongs to an earlier run, which the server no longer holds.
const serverStarted = Date.now() - process.uptime() * 1000

/**
 * The Sessions checklist. A session is active when the monitor saw it since
 * this server started and the server still has its folder loaded (a folder is
 * unloaded after an hour without activity), or when it is running now.
 */
export async function monitorSessions(ctx: Context, input: MonitorSessionsInput, ledger?: Ledger): Promise<MonitorSessionList> {
  const db = ledgerFor(ledger)
  // The checklist has no rows to show yet: an empty page reads as "compacting".
  if (db === undefined) return { sessions: [], roots: 0, offset: input.page?.offset ?? 0, limit: input.page?.limit ?? 0, inactive: 0, compacting: true }
  const recent = db.db
    .query<{ id: string; directory: string | null }, [number]>("select id, directory from session where last_seen >= ?")
    .all(serverStarted)
  const directories = [...new Set(recent.flatMap((row) => (row.directory ? [row.directory] : [])))]
  const loaded = new Set(
    (
      await Promise.all(
        directories.map(async (directory) => {
          const ref = Location.Ref.make({ directory: AbsolutePath.make(directory) })
          return (await Effect.runPromise(ctx.locations.loaded(ref)).catch(() => true)) ? [directory] : []
        }),
      )
    ).flat(),
  )
  const running = await Effect.runPromise(Effect.suspend(() => ctx.session.active())).catch(() => undefined)
  const active = new Set([
    ...recent.filter((row) => row.directory === null || loaded.has(row.directory)).map((row) => row.id),
    ...Object.keys(running ?? {}),
  ])
  const list = sessionChecklist(db, input, { directory: ctx.location.directory, active })
  const facts = await hostSessionFacts(ctx, db, list.sessions.map((row) => row.sessionID))
  return {
    ...list,
    sessions: list.sessions.map((row) => ({
      ...row,
      ...(facts.agents.has(row.sessionID) ? { agent: facts.agents.get(row.sessionID)! } : {}),
      ...(facts.states.has(row.sessionID) ? { state: facts.states.get(row.sessionID)! } : {}),
    })),
  }
}

export function monitorMark(label: string, ledger?: Ledger): MonitorMark {
  const at = Date.now()
  const trimmed = label.trim().slice(0, 80)
  const text = trimmed.length > 0 ? trimmed : new Date(at).toISOString()
  const db = ledgerFor(ledger)
  // A mark made during compaction is buffered and written in arrival order.
  if (db === undefined) {
    whileHeld(defaultLedgerPath(), () => { ledgerAt().mark(text, at) })
    return { id: 0, at, label: text }
  }
  return { id: db.mark(text, at), at, label: text }
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
