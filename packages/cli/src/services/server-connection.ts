import { Service, type Endpoint, type EnsureOptions } from "@opencode/client/effect/service"
import { ClientError, isUnauthorizedError, OpenCode } from "@opencode/client/promise"
import { OPENCODE_VERSION } from "../version"
import { Effect, Option, Redacted } from "effect"
import { Env } from "../env"
import { Product } from "@opencode/util/product"
import { ServiceConfig } from "./service-config"
import { ServiceHandover } from "./service-handover"
import { Standalone } from "./standalone"

export type Args = {
  readonly server?: string
  readonly standalone?: boolean
  readonly mismatch?: "replace" | "ignore" | "error" | "handover"
  readonly ask?: ServiceHandover.Ask
  readonly onStart?: EnsureOptions["onStart"]
}

const HEALTH_TIMEOUT_MS = 5_000

export type Resolved = {
  readonly endpoint: Endpoint
  readonly service?: ReturnType<typeof managedService>
}

export const resolve = Effect.fn("cli.server-connection.resolve")(function* (args: Args = {}) {
  if (args.server !== undefined && args.standalone)
    return yield* Effect.fail(new Error("--server and --standalone cannot be combined"))
  if (args.server !== undefined) {
    const password = yield* Env.password
    const endpoint = {
      url: args.server,
      auth: password ? { type: "basic" as const, username: "opencode", password: Redacted.value(password) } : undefined,
    } satisfies Endpoint
    const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
    const health = yield* Effect.tryPromise({
      try: () => client.server.info({ signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) }),
      catch: (cause) => connectError(endpoint, cause),
    })
    if (health.version !== OPENCODE_VERSION)
      process.stderr.write(
        `Warning: Server at ${endpoint.url} has version ${health.version}; this client is ${OPENCODE_VERSION}. Continuing anyway.\n`,
      )
    return { endpoint } satisfies Resolved
  }
  if (args.standalone || (yield* ServiceConfig.read()).disabled === true) {
    return { endpoint: yield* Standalone.start() } satisfies Resolved
  }

  const options = yield* ServiceConfig.options({ checkVersion: args.mismatch !== undefined && args.mismatch !== "ignore" })
  return {
    endpoint: yield* resolveManaged({ ...options, onStart: args.onStart }, args),
    service: managedService(options),
  } satisfies Resolved
})

function managedService(options: EnsureOptions) {
  const reconnectOptions = { ...options, version: undefined }
  return {
    reconnect: () => Service.ensure(reconnectOptions),
    restart: () =>
      Effect.gen(function* () {
        yield* Service.stop({ file: options.file, pty: "handoff" })
        yield* Service.ensure(reconnectOptions)
      }),
  }
}

export const shutdownPersistentPty = Effect.fn("cli.server-connection.shutdown-persistent-pty")(function* (
  options: EnsureOptions,
) {
  const endpoint = yield* Service.discover({ ...options, version: undefined })
  if (!endpoint) return
  const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
  yield* Effect.tryPromise(() => client.experimental.persistentPty.shutdown())
})

const resolveManaged = Effect.fnUntraced(function* (options: EnsureOptions, args: Args) {
  const mismatch = args.mismatch ?? "ignore"
  if (mismatch === "replace") return yield* Service.ensure(options)
  if (mismatch === "handover") {
    if (Product.namespace !== "opencodeplus") return yield* Service.ensure(options)
    if (args.ask === undefined) return yield* Effect.fail(new Error("A version-mismatched service needs a person to decide"))
    return yield* ServiceHandover.resolveTui(options, { ask: args.ask })
  }
  if (mismatch === "ignore") {
    const endpoint = yield* Service.ensure({ ...options, version: undefined })
    if (Product.namespace === "opencodeplus") {
      const running = yield* ServiceHandover.serverVersion(endpoint).pipe(Effect.option)
      if (Option.isSome(running) && running.value !== OPENCODE_VERSION)
        process.stderr.write(
          `Warning: Background service has version ${running.value}; this client is ${OPENCODE_VERSION}. Continuing anyway.\n`,
        )
    }
    return endpoint
  }

  const compatible = yield* Service.discover(options)
  if (compatible !== undefined) return compatible
  const existing = yield* Service.discover({ ...options, version: undefined })
  if (existing !== undefined)
    return yield* Effect.fail(new Error("Background server version does not match this client"))
  return yield* Service.ensure(options)
})

function connectError(endpoint: Endpoint, cause: unknown) {
  if (isUnauthorizedError(cause)) {
    return new Error(
      endpoint.auth === undefined
        ? `Server at ${endpoint.url} requires a password; set OPENCODE_PASSWORD`
        : `Server at ${endpoint.url} rejected the password`,
      { cause },
    )
  }
  // A server that accepted the connection but did not answer in time is up and
  // busy (a long operation holds its thread); telling it apart keeps a caller
  // from taking a running server for a dead one and retrying blindly.
  if (cause instanceof ClientError && cause.reason === "Transport" && cause.cause instanceof Error && cause.cause.name === "TimeoutError")
    return new Error(
      `Server at ${endpoint.url} is busy: it did not answer within ${HEALTH_TIMEOUT_MS / 1000} s, so this command was not sent. An operation it is running may still finish; try again once it is done.`,
      { cause },
    )
  if (cause instanceof ClientError && cause.reason === "Transport")
    return new Error(`Could not reach server at ${endpoint.url}`, { cause })
  return new Error(`Server at ${endpoint.url} did not provide a compatible V2 health response`, { cause })
}

export * as ServerConnection from "./server-connection"
