import { createHash, randomBytes } from "node:crypto"
import { Schema } from "effect"
import type { SessionCompactionDecision } from "@opencode/plugin/compaction-decision"
import { Model } from "@opencode/schema/model"
import { Binding, endpoint, Snapshot, Stored, type Config } from "./protocol.js"

export interface QuotaIO {
  read(key: string): Promise<unknown>
  write(key: string, value: Stored): Promise<void>
  notify(session: string, id: string, text: string): Promise<void>
  fetch: typeof fetch
  now(): number
}
export type Status = { sessionID: string; text: string; kind: string }
type Route = {
  session: string
  model: string
  provider: string
  endpoint: string
  stored: Stored
  snapshot?: Snapshot
  decision?: SessionCompactionDecision
  active: boolean
  touched: number
  notices: Status[]
  reading?: Promise<void>
  refusal?: string
  retryCode?: string
  budgetWaits?: number
  mode?: "off" | "shadow" | "enforce"
  /** CPA has no binding for this chat yet; background ticks wait until this time. */
  unenrolledUntil?: number
  /** CPA's explanation with its latest `quota_compact_required` refusal. */
  switchText?: string
  /** Immediate retries of one account switch; bounds a refusal loop. */
  switchRetries?: number
}

/** Background polling interval for a chat CPA has not bound yet. */
export const UNENROLLED_BACKOFF = 30_000
/** Retries of one account switch before its refusal reaches the chat as an error. */
const SWITCH_RETRIES = 3

/**
 * The model that writes the summary when CPA moves a chat to another account. Without one (or with a
 * value that is not `provider/model[#variant]`) the agent's own compaction model writes it.
 */
function summaryModel(value: string | undefined): { ref?: Model.Ref; label: string; problem?: string } {
  const fallback = "the agent's compaction model"
  if (!value) return { label: fallback }
  try {
    return { ref: Model.Ref.parse(value), label: value }
  } catch {
    return { label: fallback, problem: `compactionModel "${value}" is not provider/model; ` }
  }
}

/** Owns polling and admission claims. Compaction itself remains entirely in Core. */
export class QuotaController {
  private readonly routes = new Map<string, Promise<Route>>()
  private readonly running = new Set<string>()

  private readonly identity: Promise<string>
  private readonly summary: ReturnType<typeof summaryModel>

  constructor(
    readonly config: Config,
    installation: string | Promise<string>,
    private readonly io: QuotaIO,
  ) {
    Object.values(config.routes).forEach(endpoint)
    this.identity = Promise.resolve(installation)
    // Rejections surface at the first request that needs the identity.
    this.identity.catch(() => {})
    this.summary = summaryModel(config.compactionModel)
  }
  enabled(provider: string) {
    return this.config.routes[provider] !== undefined
  }
  private key(session: string, provider: string, model: string) {
    return `${session}/${provider}/${model}`
  }
  private route(session: string, provider: string, model: string) {
    const key = this.key(session, provider, model)
    const previous = this.routes.get(key)
    if (previous) return previous
    const created = this.io
      .read(`quota/${key}`)
      .then(
        (raw): Route => ({
          session,
          provider,
          model,
          endpoint: endpoint(this.config.routes[provider]!),
          stored:
            raw === undefined
              ? {
                  replay: false,
                  capability: randomBytes(32).toString("base64url"),
                  cursor: 0,
                  generation: 0,
                  retryIntent: "",
                }
              : Schema.decodeUnknownSync(Stored)(raw),
          active: this.running.has(session),
          touched: this.io.now(),
          notices: [],
        }),
      )
      .then(async (route) => {
        await this.save(route)
        return route
      })
    this.routes.set(key, created)
    return created
  }
  private save(route: Route) {
    return this.io.write(`quota/${this.key(route.session, route.provider, route.model)}`, route.stored)
  }
  private async notice(route: Route, kind: string, id: string, text: string) {
    const status = { sessionID: route.session, kind, text }
    route.notices = [status]
    await this.io.notify(route.session, id, text)
  }
  private poll(route: Route): Promise<void> {
    if (route.reading) return route.reading
    const reading = this.read(route).finally(() => {
      route.reading = undefined
    })
    route.reading = reading
    return reading
  }
  private async read(route: Route) {
    const url = new URL(route.endpoint)
    url.searchParams.set("after", String(route.stored.cursor))
    url.searchParams.set("model", `${route.provider}/${route.model}`)
    const response = await this.io.fetch(url, {
      headers: { Authorization: `Bearer ${route.stored.capability}` },
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    })
    if (response.status === 401 && route.stored.generation === 0) {
      const health = await this.io.fetch(route.endpoint, { signal: AbortSignal.timeout(5000), redirect: "error" })
      const data: unknown = await health.json()
      const status = Schema.decodeUnknownSync(
        Schema.Struct({
          protocol: Schema.Literal(1),
          mode: Schema.optional(Schema.Literals(["off", "shadow", "enforce"])),
        }),
      )(data)
      if (!health.ok) throw new Error("Quota plugin is unavailable")
      route.mode = status.mode
      // The bridge is reachable again: an earlier transient failure must not keep
      // an unenrolled chat paused (it never reaches the snapshot path below).
      route.refusal = undefined
      route.notices = route.notices.filter((notice) => notice.kind !== "paused")
      // Enrollment happens on a model request, which polls again from response().
      route.unenrolledUntil = this.io.now() + UNENROLLED_BACKOFF
      return
    }
    if (!response.ok) throw new Error(`Quota coordination unavailable (${response.status}); generation is paused`)
    const snapshot = Schema.decodeUnknownSync(Snapshot)(await response.json())
    route.snapshot = snapshot
    route.mode = snapshot.mode
    route.unenrolledUntil = undefined
    route.stored = { ...route.stored, generation: snapshot.generation }
    for (const event of snapshot.events) {
      // Cursor only advances after durable idempotent admission of the notice.
      await this.notice(
        route,
        event.kind,
        `${await this.identity}/${route.provider}/${route.model}/${event.id}`,
        event.text,
      )
    }
    route.stored = { ...route.stored, cursor: snapshot.cursor }
    route.refusal = undefined
    await this.save(route)
  }
  async decide(event: SessionCompactionDecision) {
    const route = await this.route(event.sessionID, event.model.providerID, event.model.id)
    route.decision = event
    route.touched = this.io.now()
    await this.poll(route).catch((error: unknown) => {
      route.refusal = error instanceof Error ? error.message : String(error)
    })
    if (route.refusal) {
      event.refusal = { type: "quota.unavailable", message: route.refusal }
      return
    }
    const switching = route.stored.switching
    if (switching !== undefined && event.reason !== "overflow") {
      // CPA moves this chat to another account only with a checkpoint newer than the one its refused
      // request carried. The summary uses the configured model: the old account is used up, and the new
      // one should not receive the full history. The session keeps its own model for the next step.
      if ((event.boundary.checkpoint ?? "") === switching) {
        event.compact = true
        event.portable = true
        if (this.summary.ref) event.compactionModel = this.summary.ref
        event.metadata = { ...event.metadata, "quota.switch": true }
      }
      return
    }
    const snapshot = route.snapshot
    // Shadow enrollment observes the existing route without forcing a portable
    // checkpoint. Native context-length/manual compaction remains unchanged.
    if (route.mode === "shadow") return
    if (!snapshot?.primary_used && !event.boundary.portable) {
      if (event.auto || event.reason === "manual") {
        event.compact = true
        event.portable = true
      } else
        event.refusal = {
          type: "quota.context-unavailable",
          message: "This existing account-bound checkpoint cannot enroll in quota routing without a local compaction.",
        }
      return
    }
    if (event.boundary.checkpoint && event.boundary.checkpoint !== snapshot?.consumed) {
      route.stored = { ...route.stored, replay: false }
      await this.save(route)
    }
    if (!snapshot?.primary_used && !event.boundary.fresh && !event.boundary.checkpoint) {
      route.stored = { ...route.stored, replay: true }
      await this.save(route)
    }
    if (!snapshot?.intent) return
    if (!snapshot.available) {
      event.refusal = {
        type: "quota.no-capacity",
        message:
          "No compatible replacement credential has verified capacity. Generation is paused; quota resets will be checked before the next attempt.",
      }
      await this.notice(route, "paused", `paused/${snapshot.intent}`, event.refusal.message)
      return
    }
    if (!event.auto && event.reason !== "manual") {
      if (!event.boundary.portable)
        event.refusal = {
          type: "quota.context-unavailable",
          message:
            "Automatic compaction is off and this chat has an account-bound checkpoint. Create a local compaction before switching credentials.",
        }
      route.stored = { ...route.stored, replay: true }
      await this.save(route)
      return
    }
    if (
      !event.boundary.checkpoint ||
      event.boundary.checkpoint === snapshot.consumed ||
      event.reason !== "auto" ||
      event.due
    ) {
      event.compact = true
      event.portable = true
      event.metadata = { ...event.metadata, "quota.handoff": snapshot.intent }
    }
  }
  async headers(session: string, provider: string, model: string, kind: string, baseURL: string | undefined) {
    const route = await this.route(session, provider, model)
    if (!baseURL || new URL(baseURL).origin !== new URL(route.endpoint).origin)
      throw new Error("Quota route does not match the model endpoint")
    if (route.refusal) throw new Error(route.refusal)
    // Auxiliary requests can happen before the first primary decision.
    if (!route.decision) await this.poll(route)
    route.touched = this.io.now()
    const event = route.decision
    const claim = {
      protocol: 1,
      installation: await this.identity,
      session,
      route: `${provider}/${model}`,
      request: randomBytes(16).toString("hex"),
      kind,
      capability: createHash("sha256").update(route.stored.capability).digest("hex"),
      auto: event?.auto ?? true,
      fresh: event?.boundary.fresh ?? false,
      portable: event?.boundary.portable ?? true,
      checkpoint: event?.boundary.checkpoint ?? "",
      generation: route.stored.generation,
      intent: route.snapshot?.intent ?? "",
      // This client compacts when CPA refuses an account switch with quota_compact_required.
      compact_on_switch: true,
    }
    return { "X-Quota-Handoff": Buffer.from(JSON.stringify(claim)).toString("base64url") }
  }
  async response(session: string, provider: string, model: string, response: Response, kind = "primary") {
    const route = await this.route(session, provider, model)
    if (!response.ok) {
      // Only CPA's own distinct pre-admission errors may authorize a native retry.
      const text = await response.clone().text()
      const parsed = Schema.decodeUnknownOption(
        Schema.fromJsonString(
          Schema.Struct({
            error: Schema.Struct({
              code: Schema.optionalKey(Schema.String),
              message: Schema.optionalKey(Schema.String),
            }),
          }),
        ),
      )(text)
      // CPA 7.3.20 wraps scheduler codes in the message prefix and uses
      // internal_server_error as the HTTP envelope code. Interceptor refusals
      // carry the code directly. Accept only the exact namespaced prefix.
      const detail = parsed._tag === "Some" ? parsed.value.error : undefined
      const code = detail?.code?.startsWith("quota_") ? detail.code : detail?.message?.match(/^(quota_[a-z_]+): /)?.[1]
      route.retryCode = code?.startsWith("quota_") ? code : undefined
      if (route.retryCode === "quota_compact_required") route.switchText = detail?.message
      return
    }
    route.retryCode = undefined
    route.budgetWaits = 0
    const header = response.headers.get("X-Quota-Binding")
    if (response.headers.get("X-Quota-Protocol") !== "1" || !header) {
      route.refusal = "Quota plugin did not acknowledge this request. Generation is paused."
      throw new Error(route.refusal)
    }
    const binding = Schema.decodeUnknownSync(Schema.fromJsonString(Binding))(
      Buffer.from(header, "base64url").toString(),
    )
    route.stored = { ...route.stored, generation: binding.generation }
    if (kind === "primary" && route.stored.switching !== undefined) {
      // CPA admitted the compacted chat: on the new account, or on the old one if it recovered meanwhile.
      route.stored = { ...route.stored, switching: undefined }
      route.switchRetries = 0
      route.notices = [
        {
          sessionID: session,
          kind: "switched",
          text: `Continuing on ${binding.alias} after compacting with ${this.summary.label}.`,
        },
      ]
    }
    await this.save(route)
    await this.poll(route)
  }
  async retry(session: string, provider: string, model: string) {
    const route = await this.route(session, provider, model)
    if (!route.retryCode) return undefined
    const code = route.retryCode
    route.retryCode = undefined
    if (code === "quota_budget_wait") {
      route.budgetWaits = (route.budgetWaits ?? 0) + 1
      if (route.budgetWaits > 120) return false
      await this.poll(route)
      if (route.budgetWaits === 1)
        await this.notice(
          route,
          "waiting",
          `budget-wait/${route.snapshot?.generation ?? 0}/${route.stored.cursor}`,
          "Waiting for running requests to settle their shared quota reservations before continuing or compacting.",
        )
      // Core owns the interruptible delay and rebuilds the next physical request.
      return 500
    }
    if (code === "quota_compact_required") {
      // CPA moves this chat off a used-up account only after a compaction. The checkpoint the refused
      // request carried is the one a new compaction has to replace.
      const carried = route.decision?.boundary.checkpoint ?? ""
      const pending = route.stored.switching
      route.switchRetries = (route.switchRetries ?? 0) + 1
      // A checkpoint made for this switch was refused as well, or retries keep failing: stop here so the
      // refusal reaches the chat instead of compacting in a loop.
      if ((pending !== undefined && carried !== pending) || route.switchRetries > SWITCH_RETRIES) {
        route.stored = { ...route.stored, switching: undefined }
        route.switchRetries = 0
        await this.save(route)
        return false
      }
      if (pending === undefined) {
        route.stored = { ...route.stored, switching: carried }
        await this.save(route)
      }
      route.notices = [
        {
          sessionID: session,
          kind: "switching",
          text: `${route.switchText ?? "CPA is moving this chat to another account."} ${this.summary.problem ?? ""}Compacting with ${this.summary.label} first.`,
        },
      ]
      // Core runs its compaction decision before rebuilding the request; decide() asks for the summary.
      return true
    }
    if (code !== "quota_checkpoint_required" && code !== "quota_generation_changed") return false
    await this.poll(route)
    const token = `${route.snapshot?.generation}/${route.snapshot?.intent}`
    if (!route.snapshot || route.stored.retryIntent === token) return false
    route.stored = { ...route.stored, retryIntent: token }
    await this.save(route)
    return true
  }
  async requiresPortable(session: string, provider: string, model: string, kind: string) {
    const route = await this.route(session, provider, model)
    if (kind === "compaction") {
      const routes = await Promise.all(this.routes.values())
      return routes.some((value) => value.session === session && value.decision?.portable === true)
    }
    return route.stored.replay || !!route.decision?.boundary.checkpoint
  }
  async warming(session: string) {
    const routes = await Promise.all(this.routes.values())
    return !routes.some(
      (route) =>
        route.session === session && (route.snapshot?.intent || route.refusal || route.stored.switching !== undefined),
    )
  }
  async status(session: string) {
    const routes = await Promise.all(this.routes.values())
    return routes.filter((route) => route.session === session).flatMap((route) => route.notices)
  }
  async activity(session: string, active: boolean) {
    if (active) this.running.add(session)
    else this.running.delete(session)
    const routes = await Promise.all(this.routes.values())
    routes
      .filter((route) => route.session === session)
      .forEach((route) => {
        route.active = active
        if (!active) route.budgetWaits = 0
        // The switch notice stays until the next run of this chat starts.
        if (active) route.notices = route.notices.filter((notice) => notice.kind !== "switched")
      })
  }
  async tick() {
    const routes = await Promise.all(this.routes.values())
    await Promise.all(
      routes
        .filter((route) => route.active || this.io.now() - route.touched < 5000)
        .filter((route) => (route.unenrolledUntil ?? 0) <= this.io.now())
        .map((route) =>
          this.poll(route).catch((error: unknown) => {
            route.refusal = error instanceof Error ? error.message : String(error)
            route.notices = [{ sessionID: route.session, kind: "paused", text: route.refusal }]
          }),
        ),
    )
  }
}
