export * as ServiceHandover from "./service-handover"

// What the Plus TUI does when the running background service has another
// version: replace it when no chat runs, ask before the TUI takes the screen
// when chats run, and never replace a busy service without a terminal. The
// stop path is the one /update uses (persistent terminals handed over); the
// active-session query below is shared with /update's wait.

import { Service, type Endpoint, type EnsureOptions, type Info } from "@opencode/client/effect/service"
import { Effect, Option, Schema } from "effect"
import { OPENCODE_VERSION } from "../version"

export type Choice = "replace" | "existing" | "quit"

export type Ask = (info: { readonly version: string; readonly active: number }) => Effect.Effect<Choice, unknown>

/** Thrown when the person quits instead of replacing or reusing the old service. Callers exit 0. */
export class HandoverQuit extends Error {
  override readonly name = "HandoverQuit"
  constructor() {
    super("Quit")
  }
}

const decodeActive = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ data: Schema.Record(Schema.String, Schema.Unknown) })),
)
const decodeServer = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ version: Schema.String, pid: Schema.Number })),
)

/** An endpoint for a known service registration, so shared queries take one shape. */
export function endpointFor(info: Pick<Info, "url" | "password">): Endpoint {
  if (info.password === undefined) return { url: info.url }
  return { url: info.url, auth: { type: "basic", username: "opencode", password: info.password } }
}

const fetchRoute = Effect.fn("cli.service-handover.fetch-route")(function* (endpoint: Endpoint, route: string) {
  return yield* Effect.tryPromise({
    try: () =>
      fetch(new URL(route, endpoint.url), {
        headers: Service.headers(endpoint),
        signal: AbortSignal.timeout(10_000),
      }).then(async (response) => ({ status: response.status, text: await response.text() })),
    catch: (cause) => new Error(`The background service did not answer ${route}`, { cause }),
  })
})

/** How many chats the service at `endpoint` reports as running. */
export const activeCount = Effect.fn("cli.service-handover.active-count")(function* (endpoint: Endpoint) {
  const answer = yield* fetchRoute(endpoint, "/api/session/active")
  if (answer.status !== 200) return yield* Effect.fail(new Error("Could not read which chats are running"))
  const active = decodeActive(answer.text)
  if (Option.isNone(active)) return yield* Effect.fail(new Error("Could not read which chats are running"))
  return Object.keys(active.value.data).length
})

/** The version and pid the service at `endpoint` reports for itself. */
export const serverInfo = Effect.fn("cli.service-handover.server-info")(function* (endpoint: Endpoint) {
  const answer = yield* fetchRoute(endpoint, "/api/info")
  if (answer.status !== 200) return yield* Effect.fail(new Error("Could not read the background service version"))
  const info = decodeServer(answer.text)
  if (Option.isNone(info)) return yield* Effect.fail(new Error("Could not read the background service version"))
  return info.value
})

/** The version the service at `endpoint` reports for itself. */
export const serverVersion = Effect.fn("cli.service-handover.server-version")(function* (endpoint: Endpoint) {
  return (yield* serverInfo(endpoint)).version
})

/** Stop the registered service the way a replacement does: persistent terminals are handed over. */
export const stopForReplacement = Effect.fn("cli.service-handover.stop-for-replacement")(function* (file?: string) {
  yield* Service.stop({ file, pty: "handoff" })
})

export type Decision = "replace" | "ask" | "busy-without-terminal"

/** The handover decision for a mismatched service: idle replaces, busy asks with a terminal. */
export function decide(input: { readonly active: number; readonly tty: boolean }): Decision {
  if (input.active === 0) return "replace"
  if (input.tty) return "ask"
  return "busy-without-terminal"
}

export const resolveTui = Effect.fn("cli.service-handover.resolve-tui")(function* (
  options: EnsureOptions,
  input: {
    readonly ask: Ask
    readonly tty?: boolean
    readonly notice?: (message: string) => void
  },
) {
  const tty = input.tty ?? (process.stdin.isTTY === true && process.stdout.isTTY === true)
  const notice = input.notice ?? ((message) => process.stderr.write(`${message}\n`))

  const matching = yield* Service.discover(options)
  if (matching !== undefined) return yield* Service.ensure(options)
  const existing = yield* Service.discover({ ...options, version: undefined })
  if (existing === undefined) return yield* Service.ensure(options)

  const running = yield* serverVersion(existing)
  const active = yield* activeCount(existing)
  const decision = decide({ active, tty })
  if (decision === "busy-without-terminal")
    return yield* Effect.fail(
      new Error(
        `A background service of version ${running} is running ${describeChats(active)}; not replacing it without a terminal. Stop it first with \`service stop\`, or connect to it with --server ${existing.url}.`,
      ),
    )
  if (decision === "ask") {
    const choice = yield* input.ask({ version: running, active })
    if (choice === "quit") return yield* Effect.fail(new HandoverQuit())
    if (choice === "existing") {
      notice(
        `Warning: Background service has version ${running}; this client is ${OPENCODE_VERSION}. Continuing anyway.`,
      )
      return existing
    }
  }
  yield* stopForReplacement(options.file)
  const endpoint = yield* Service.ensure({
    ...options,
    replace: true,
    onStart: (_reason, _previous) => options.onStart?.("version-mismatch", running),
  })
  notice(
    active === 0
      ? `Replaced the service ${running} with ${OPENCODE_VERSION} (no chats were running).`
      : `Replaced the service ${running} with ${OPENCODE_VERSION} (${describeChats(active)} pause and resume after the restart).`,
  )
  return endpoint
})

function describeChats(active: number) {
  return active === 1 ? "1 chat" : `${active} chats`
}
