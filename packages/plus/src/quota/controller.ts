import { createHash, randomBytes } from "node:crypto"
import { Schema } from "effect"
import type { SessionCompactionDecision } from "@opencode/plugin/compaction-decision"
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
}

/** Owns polling and admission claims. Compaction itself remains entirely in Core. */
export class QuotaController {
  private readonly routes = new Map<string, Promise<Route>>()
  private readonly running = new Set<string>()

  constructor(
    readonly config: Config,
    readonly installation: string,
    private readonly io: QuotaIO,
  ) {
    Object.values(config.routes).forEach(endpoint)
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
      Schema.decodeUnknownSync(Schema.Struct({ protocol: Schema.Literal(1) }))(data)
      if (!health.ok) throw new Error("Quota plugin is unavailable")
      return
    }
    if (!response.ok) throw new Error(`Quota coordination unavailable (${response.status}); generation is paused`)
    const snapshot = Schema.decodeUnknownSync(Snapshot)(await response.json())
    route.snapshot = snapshot
    route.stored = { ...route.stored, generation: snapshot.generation }
    for (const event of snapshot.events) {
      // Cursor only advances after durable idempotent admission of the notice.
      await this.notice(
        route,
        event.kind,
        `${this.installation}/${route.provider}/${route.model}/${event.id}`,
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
    const snapshot = route.snapshot
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
      installation: this.installation,
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
    }
    return { "X-Quota-Handoff": Buffer.from(JSON.stringify(claim)).toString("base64url") }
  }
  async response(session: string, provider: string, model: string, response: Response) {
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
    return !routes.some((route) => route.session === session && (route.snapshot?.intent || route.refusal))
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
      })
  }
  async tick() {
    const routes = await Promise.all(this.routes.values())
    await Promise.all(
      routes
        .filter((route) => route.active || this.io.now() - route.touched < 5000)
        .map((route) =>
          this.poll(route).catch((error: unknown) => {
            route.refusal = error instanceof Error ? error.message : String(error)
            route.notices = [{ sessionID: route.session, kind: "paused", text: route.refusal }]
          }),
        ),
    )
  }
}
