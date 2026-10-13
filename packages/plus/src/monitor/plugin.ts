// The monitor's server side: feed the host's session events to the collector,
// answer the TUI and tool queries, and keep the ledger within retention.
import type { Context } from "@opencode/plugin/effect/plugin"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { Session } from "@opencode/schema/session"
import { Effect, Option, Schema, Scope, Stream } from "effect"
import path from "node:path"
import { guidancePath, teachingFilePath, teamsDataDir } from "../instructions/paths.js"
import type { MonitorMark, MonitorQueryInput, MonitorReport, MonitorStepInput, MonitorStepResult } from "../rpc.js"
import { bySession, inferRunTeam, loadRun } from "../teams/run.js"
import { causeWords, isMiss } from "./cache.js"
import { createCollector, MonitorEvents, type Collector } from "./collector.js"
import { fingerprintWireBody, sha256, type NamedSystemPart } from "./fingerprint.js"
import { endRequestWindow, ledgerAt, RETENTION_DAYS, type ContextFact, type Ledger, type SessionFacts } from "./ledger.js"
import { queryMonitor } from "./query.js"
import { sessionFold } from "./report.js"
import { recordModelObservation } from "./model-observation.js"

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
      // Retention is a synchronous scan; keep it off the first monitored prompt.
      setTimeout(() => {
        try {
          ledger.prune(Date.now() - RETENTION_DAYS * DAY)
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
    yield* ctx.session.hook("model.observed", (event) => Effect.sync(() => recordModelObservation(open(), event, ctx.location.directory)).pipe(
      Effect.catchCause(() => {
        if (warning.emitted) return Effect.void
        warning.emitted = true
        return Effect.logWarning("plus model observation unavailable", { code: "storage-failed" })
      }),
    ))

    yield* hook("compaction.decide", (event) => Effect.sync(() => {
      if (event.compact && event.metadata?.["quota.switch"] === true)
        open().contextFact({ sessionID: event.sessionID, at: Date.now(), kind: "quota_handoff" })
    }))

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
        const parts = namedSystemParts.get(sessionID)
        const fp = fingerprintWireBody(wireBody, {
          url: event.request.url,
          namedSystemParts: parts,
        })

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
          l.requestFingerprint({ requestID, sessionID, ...fingerprintWireBody(await request.clone().text(), { url: request.url, namedSystemParts: parts }) })
        }).pipe(Effect.catchCause(() => failedHook("http.request"))))
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
        const started = event.started ?? Date.now()
        const requestID = event.requestID ?? `req_${sessionID}_${started}_${Math.random().toString(36).slice(2, 8)}`

        const parts = namedSystemParts.get(sessionID)
        const fp = fingerprintWireBody(event.frame, {
          namedSystemParts: parts,
        })

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
        event.observers.push((frame) => Effect.sync(() => {
          l.requestFingerprint({ requestID, sessionID, ...fingerprintWireBody(frame, { namedSystemParts: parts }) })
        }).pipe(Effect.catchCause(() => failedHook("experimental.ws.send"))))
        await pricing(l, sessionID, provider, model, started)
      }),
    )

    yield* hook("http.response", (event) =>
      Effect.sync(() => {
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
        if (event.response.status >= 400) {
          const l = open()
          const openReq = requestID ? l.getRequest(requestID) : undefined
          if (openReq) {
            l.requestEnded(openReq.id, {
              ended: Date.now(),
              status: "error",
              error: { type: "HttpError", status: event.response.status },
            })
          }
        }
      }),
    )

    yield* hook("experimental.ws.receive", (event) => Effect.sync(() => {
      const requestID = wsRequests.get(String(event.sessionID))
      if (requestID) responseId(requestID, event.frame)
    }))

    yield* hook("generated", (event) =>
      Effect.promise(async () => {
        if (event.invocationID !== undefined) return
        const sessionID = String(event.sessionID)
        const l = open()
        const kind = event.kind ?? "generate"
        const at = event.ended ?? Date.now()
        // A generate or title outcome is auxiliary: it must never rewrite the
        // chat's shown agent with the side call's identity.
        l.session({ id: sessionID, directory: ctx.location.directory }, at)
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
        const request = endRequestWindow(l, {
          id: `${kind}_${sessionID}_${event.started ?? at}_${at}`, sessionID, kind, isTitle: kind === "title",
          messageID: `${kind}:${event.started ?? at}:${at}`,
          agent: String(event.agent), provider: event.model.providerID, model: event.model.id, variant: event.model.variant,
          started: event.started ?? 0,
        }, { ended: at, status: event.error ? "error" : "completed", error: event.error, usage }, true)
        await pricing(l, sessionID, event.model.providerID, event.model.id, request?.started ?? at)
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
        }
      }),
    )
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("plus monitor hooks registration failed", { cause })),
  )

  const stream = ctx.event.subscribe().pipe(
    Stream.filter((event) => MonitorEvents.has(event.type)),
    Stream.runForEach((event) =>
      Effect.try(() => collector()?.observe(event)).pipe(
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
  const facts = input.view === "sessions" ? await hostSessionFacts(ctx, ledger) : undefined
  return queryMonitor(ledger, input, {
    directory: ctx.location.directory,
    ...(facts === undefined ? {} : { states: facts.states, agents: facts.agents }),
  })
}

export async function monitorStep(
  ctx: Context,
  input: MonitorStepInput,
  ledger: Ledger = ledgerAt(),
): Promise<MonitorStepResult> {
  const fold = sessionFold(ledger, input.sessionID)
  if (!fold.rows.length) return { status: "pending" }
  const index = fold.rows.findLastIndex((r) => r.kind !== "ping" && !r.isTitle)
  if (index < 0) return { status: "pending" }
  const row = fold.rows[index]!
  if (row.ended === undefined || row.status === "running") return { status: "pending" }
  const summary = fold.analysis.summaries[index]
  const detail = summary && fold.analysis.detail(summary.request.id)
  if (!detail) return { status: "pending" }
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
async function hostSessionFacts(ctx: Context, ledger: Ledger): Promise<HostSessionFacts> {
  const ids = ledger.db.query<{ id: string }, []>("select id from session").all().map((row) => row.id)
  const states = new Map<string, string>()
  const agents = new Map<string, string>()
  // A session is running while the host reports it active, or—when that read
  // fails—while it has an open request of its own. Both are current facts and
  // must beat the last completed execution's outcome.
  const running = await Effect.runPromise(Effect.suspend(() => ctx.session.active())).catch(() => undefined)
  for (const id of Object.keys(running ?? {})) states.set(id, "running")
  for (const id of ids) {
    if (!states.has(id) && ledger.getRequests(id).some((row) => row.ended === undefined)) states.set(id, "running")
  }
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
