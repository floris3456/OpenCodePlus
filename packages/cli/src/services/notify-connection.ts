import { Service, type Endpoint } from "@opencode/client/effect/service"
import { ClientError, isUnauthorizedError, OpenCode } from "@opencode/client/promise"
import { Option, Schema } from "effect"
import { Attention, Definition, type Plus } from "../../../plus/src/rpc.js"
import { errorMessage } from "../util/error"
import type { Handled, Player } from "./notify-player"
import { ServiceConfig } from "./service-config"

// `opencodeplus notify` (docs/plans/plus-1.3.18-notifications.md): stay connected to one service,
// here or through an ssh tunnel, and hand each `attention` event of every chat there to the player.

/** The player heartbeat: the server counts a player as connected for 45 s after each one. */
export const HEARTBEAT_MS = 20_000
/** The server sends an SSE heartbeat every 15 s; this long without any data means the connection is dead. */
export const IDLE_MS = 45_000
export const RECONNECT_FIRST_MS = 1_000
export const RECONNECT_MAX_MS = 30_000
/** A connection that stayed up this long starts the backoff over. */
export const STABLE_MS = 60_000
/** Long enough to type an ssh password or passphrase. */
const TUNNEL_WAIT_MS = 120_000
const TEST_WAIT_MS = 15_000
/** --once waits this long after the test sound, so exiting does not cut it off. */
const ONCE_LINGER_MS = 2_500

const ATTENTION_EVENT = `rpc.${Definition.id}.attention`
const decodeAttention = Schema.decodeUnknownOption(Attention)
const decodeServiceConfig = Schema.decodeUnknownOption(Schema.fromJsonString(ServiceConfig.Info))

export interface Connection {
  /** Where it is connected, for status lines; never the password. */
  readonly label: string
  readonly endpoint: Endpoint
  /** Settles with why, when the transport ends on its own (the ssh tunnel). */
  readonly ended: Promise<string>
  close(): void
}

/** Where the service is. `open` reads its address and password anew on every connection. */
export interface Source {
  readonly label: string
  open(signal: AbortSignal): Promise<Connection>
}

export interface NotifyRun {
  readonly source: Source
  readonly player: Player
  /** This player's id in the server's heartbeat count; random per run. */
  readonly playerID: string
  readonly test?: Plus.AttentionKind
  /** Exit after the test, or after the first failure, instead of running on. */
  readonly once: boolean
  readonly log: (line: string) => void
  /** Only with --verbose. */
  readonly debug: (line: string) => void
}

/** Runs until the signal aborts (Ctrl+C), or with --once until the test is done; returns the exit code. */
export async function runNotify(run: NotifyRun, signal: AbortSignal): Promise<number> {
  const state = { failures: 0, tested: false, reported: "" }
  run.log(`Connecting to ${run.source.label}...`)
  while (!signal.aborted) {
    const end = await session(run, state.tested ? undefined : run.test, signal)
    if (end.exit !== undefined) return end.exit
    if (signal.aborted) return 0
    if (run.once) {
      run.log(`Stopped: ${end.reason}.`)
      return 1
    }
    const next = nextReconnect(state.failures, end.upMs)
    const wait = `${next.delayMs / 1_000} s`
    // The same failure again is only shown with --verbose: a service that stays down prints one line.
    const repeated = end.upMs === 0 && end.reason === state.reported
    const line =
      end.upMs > 0
        ? `Lost the connection to ${end.label}: ${end.reason}. Reconnecting in ${wait}.`
        : `Not connected to ${run.source.label}: ${end.reason}. Retrying in ${wait}${repeated ? "" : `, then at most every ${RECONNECT_MAX_MS / 1_000} s`}.`
    if (repeated) run.debug(line)
    if (!repeated) run.log(line)
    state.failures = next.failures
    state.tested = state.tested || end.tested
    state.reported = end.upMs > 0 ? "" : end.reason
    await sleep(next.delayMs, signal)
  }
  return 0
}

/** After a connection ends: failures in a row so far, and the wait before the next try. */
export function nextReconnect(failures: number, upMs: number) {
  const next = upMs >= STABLE_MS ? 1 : failures + 1
  return { failures: next, delayMs: Math.min(RECONNECT_MAX_MS, RECONNECT_FIRST_MS * 2 ** (next - 1)) }
}

interface SessionEnd {
  readonly reason: string
  /** How long it was connected; 0 when it never was. */
  readonly upMs: number
  readonly label: string
  /** Whether the test was asked for. */
  readonly tested: boolean
  readonly exit?: number
}

async function session(run: NotifyRun, test: Plus.AttentionKind | undefined, signal: AbortSignal): Promise<SessionEnd> {
  const opened = await run.source.open(signal).then(
    (connection) => ({ connection }),
    (error: unknown) => ({ error: errorMessage(error) }),
  )
  if ("error" in opened) return { reason: opened.error, upMs: 0, label: run.source.label, tested: false }
  const end = await listen(run, opened.connection, test, signal)
  opened.connection.close()
  return end
}

async function listen(
  run: NotifyRun,
  connection: Connection,
  test: Plus.AttentionKind | undefined,
  outer: AbortSignal,
): Promise<SessionEnd> {
  const client = OpenCode.make({ baseUrl: connection.endpoint.url, headers: Service.headers(connection.endpoint) })
  const plus = client.rpc(Definition)
  const stop = new AbortController()
  const signal = AbortSignal.any([outer, stop.signal])
  const state = {
    reason: "",
    exit: undefined as number | undefined,
    connectedAt: 0,
    activity: Date.now(),
    tested: false,
    awaitingTest: false,
  }
  const finish = (reason: string, exit?: number) => {
    if (state.reason !== "") return
    state.reason = reason
    state.exit = exit
    stop.abort()
  }
  void connection.ended.then((reason) => finish(reason))
  const ended = () => ({
    reason: state.reason,
    upMs: state.connectedAt === 0 ? 0 : Date.now() - state.connectedAt,
    label: connection.label,
    tested: state.tested,
    ...(state.exit === undefined ? {} : { exit: state.exit }),
  })

  const info = await client.server.info({ signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) }).then(
    (value) => ({ version: value.version }),
    (error: unknown) => ({ error: connectionError(error, connection) }),
  )
  if ("error" in info) {
    finish(info.error)
    return ended()
  }

  // The first heartbeat also proves the service has the player API; later ones may fail quietly.
  const beat = (first: boolean) =>
    plus["attention.player"]({ id: run.playerID }, { signal }).then(
      (result) => result.players,
      (error: unknown) => {
        if (first) finish(`the service has no sound player support (${errorMessage(error)}); update OpenCodePlus there`)
        if (!first) run.debug(`Heartbeat failed: ${errorMessage(error)}`)
        return undefined
      },
    )
  const fetchSound = (sound: string) =>
    plus["attention.sound"]({ sound }, { signal }).then((data) => Buffer.from(data.data, "base64"))

  const askForTest = async (kind: Plus.AttentionKind) => {
    state.tested = true
    state.awaitingTest = true
    const failed = await plus["attention.test"]({ kind }, { signal }).then(
      () => undefined,
      (error: unknown) => errorMessage(error),
    )
    if (failed !== undefined) {
      state.awaitingTest = false
      run.log(`The test failed: ${failed}.`)
      if (run.once) finish("the test failed", 1)
      return
    }
    run.debug(`Asked for a test "${kind}" event.`)
    await sleep(TEST_WAIT_MS, signal)
    if (!state.awaitingTest || signal.aborted) return
    state.awaitingTest = false
    run.log(`The test event did not arrive within ${TEST_WAIT_MS / 1_000} s.`)
    if (run.once) finish("the test event did not arrive", 1)
  }

  const connected = async () => {
    state.connectedAt = Date.now()
    const players = await beat(true)
    if (players === undefined) return
    run.log(`Connected to ${connection.label}, OpenCodePlus ${info.version}. Playing the sounds of every chat there.`)
    run.debug(`The service counts ${players} sound player${players === 1 ? "" : "s"} now.`)
    if (test !== undefined) void askForTest(test)
  }

  const received = async (attention: Plus.Attention) => {
    const isTest = attention.test === true && state.awaitingTest
    if (isTest) state.awaitingTest = false
    const handled = await run.player.handle(attention, fetchSound)
    if (isTest) run.log(`Test event arrived: ${describeEvent(attention, handled)}.`)
    if (!isTest) run.debug(`Event: ${describeEvent(attention, handled)}.`)
    if (!isTest || !run.once) return
    await sleep(ONCE_LINGER_MS, signal)
    finish("the test is done", handled.sound === "failed" ? 1 : 0)
  }

  const heartbeat = setInterval(() => void beat(false), HEARTBEAT_MS)
  const watchdog = setInterval(() => {
    if (Date.now() - state.activity > IDLE_MS) finish(`no data from the service for ${IDLE_MS / 1_000} s`)
  }, 5_000)
  const events = client.event.subscribe({
    signal,
    onActivity: () => {
      state.activity = Date.now()
    },
  })
  const streamed = await (async () => {
    for await (const event of events) {
      state.activity = Date.now()
      if (event.type === "server.connected") void connected()
      if (event.type !== ATTENTION_EVENT) continue
      const attention = decodeAttention(event.data)
      if (Option.isNone(attention)) run.debug(`Ignored an attention event this version cannot read.`)
      if (Option.isSome(attention)) void received(attention.value)
    }
    return "the service closed the connection"
  })().catch((error: unknown) => (isTransport(error) ? "the connection broke" : connectionError(error, connection)))
  clearInterval(heartbeat)
  clearInterval(watchdog)
  // A dying ssh tunnel breaks the stream a moment before it exits; its own reason says more.
  if (state.reason === "") finish(await Promise.race([connection.ended, sleep(500, outer).then(() => streamed)]))
  return ended()
}

function connectionError(error: unknown, connection: Connection) {
  if (isUnauthorizedError(error)) return "the service rejected the password"
  if (isTransport(error)) return `no answer from ${connection.endpoint.url}`
  return errorMessage(error)
}

function isTransport(error: unknown) {
  return error instanceof ClientError && error.reason === "Transport"
}

function describeEvent(attention: Plus.Attention, handled: Handled) {
  const sound =
    attention.sound === undefined
      ? "no sound is set for it"
      : handled.sound === "played"
        ? `played ${attention.sound}`
        : handled.sound === "too-soon"
          ? `skipped ${attention.sound}, another sound just played`
          : `${attention.sound} did not play (${handled.reason})`
  const desktop = handled.desktop === "shown" ? ", desktop notification shown" : ""
  return `${attention.kind} "${attention.title}": ${attention.message}; ${sound}${desktop}`
}

/** The service on this machine, found through its registration file; never started. */
export function localSource(discover: () => Promise<Endpoint | string>): Source {
  return {
    label: "this machine's service",
    open: async () => {
      const found = await discover()
      if (typeof found === "string") throw new Error(found)
      return { label: `this machine's service (${found.url})`, endpoint: found, ended: pending(), close: () => {} }
    },
  }
}

/** `--server <url>`, with the password from OPENCODE_PASSWORD. */
export function serverSource(url: string, password: string | undefined): Source {
  const endpoint = {
    url,
    ...(password === undefined ? {} : { auth: { type: "basic" as const, username: "opencode", password } }),
  }
  return { label: url, open: async () => ({ label: url, endpoint, ended: pending(), close: () => {} }) }
}

// The remote end: whatever login shell the target has runs sh, which prints a marker (so anything
// a shell startup file prints is skipped) and then the service config. The password in it only
// ever passes through this pipe.
const MARKER = "opencodeplus-service-json"
const REMOTE_CONFIG = "${XDG_CONFIG_HOME:-$HOME/.config}/opencodeplus/service.json"
const REMOTE_READ = `sh -c 'echo ${MARKER}; cat "${REMOTE_CONFIG}"'`

/** The service on another machine, through an ssh tunnel. */
export function sshSource(target: string, debug: (line: string) => void): Source {
  return {
    label: target,
    open: async (signal) => {
      const child = Bun.spawn(sshReadCommand(target), { stdin: "ignore", stdout: "pipe", stderr: "pipe", signal })
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      const remote = parseRemoteService(target, { stdout, stderr, code })
      if ("error" in remote) throw new Error(remote.error)
      const local = freePort()
      const tunnel = startTunnel(sshTunnelCommand(target, local, remote.host, remote.port), debug)
      // Stopped at once on Ctrl+C: the process may exit before the session unwinds.
      const close = () => {
        signal.removeEventListener("abort", close)
        tunnel.close()
      }
      signal.addEventListener("abort", close, { once: true })
      const url = `http://127.0.0.1:${local}`
      const where = `${remote.host}:${remote.port}`
      const ready = await waitForTunnel(url, tunnel, signal, Date.now() + TUNNEL_WAIT_MS)
      if (ready !== "ready") close()
      if (ready === "ended") throw new Error(await tunnel.ended)
      if (ready === "refused") throw new Error(`nothing listens at ${where} on ${target}: its service is not running`)
      if (ready === "timeout") throw new Error(`the ssh tunnel did not come up within ${TUNNEL_WAIT_MS / 1_000} s`)
      if (ready === "stopped") throw new Error("stopped")
      return {
        label: `${target} (its service at ${where})`,
        endpoint: {
          url,
          ...(remote.password === undefined
            ? {}
            : { auth: { type: "basic" as const, username: "opencode", password: remote.password } }),
        },
        ended: tunnel.ended,
        close,
      }
    },
  }
}

export function sshReadCommand(target: string) {
  return ["ssh", "-T", "-o", "ConnectTimeout=20", "--", target, REMOTE_READ]
}

export function sshTunnelCommand(target: string, localPort: number, host: string, port: number) {
  return [
    "ssh",
    "-N",
    "-T",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "ConnectTimeout=20",
    // A connection of its own, never a shared ControlMaster one, so the tunnel ends with notify.
    "-o",
    "ControlPath=none",
    "-L",
    `127.0.0.1:${localPort}:${host.includes(":") ? `[${host}]` : host}:${port}`,
    "--",
    target,
  ]
}

export interface RemoteService {
  readonly host: string
  readonly port: number
  readonly password?: string
}

/** What `ssh <target> <REMOTE_READ>` answered: the remote service's address and password, or why not. */
export function parseRemoteService(
  target: string,
  read: { readonly stdout: string; readonly stderr: string; readonly code: number },
): RemoteService | { readonly error: string } {
  const detail = read.stderr.trim().split("\n").at(-1)?.trim() ?? ""
  const at = read.stdout.indexOf(`${MARKER}\n`)
  if (at === -1) return { error: `ssh ${target} failed${detail === "" ? ` (exit ${read.code})` : `: ${detail}`}` }
  if (read.code !== 0)
    return { error: `${target} has no OpenCodePlus service config at ~/.config/opencodeplus/service.json${detail === "" ? "" : ` (${detail})`}` }
  const config = decodeServiceConfig(read.stdout.slice(at + MARKER.length + 1))
  if (Option.isNone(config)) return { error: `the service config on ${target} (~/.config/opencodeplus/service.json) is not valid` }
  if (config.value.disabled === true) return { error: `the service on ${target} is turned off (its service.json says "disabled": true)` }
  const hostname = config.value.hostname ?? ""
  return {
    // A service listening on every address also listens on loopback, which is all the tunnel needs.
    host: hostname === "" || hostname === "0.0.0.0" || hostname === "::" ? "127.0.0.1" : hostname,
    port: config.value.port ?? ServiceConfig.defaultPort("plus", "linux"),
    ...(config.value.password === undefined ? {} : { password: config.value.password }),
  }
}

type Tunnel = ReturnType<typeof startTunnel>

function startTunnel(command: string[], debug: (line: string) => void) {
  const child = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "pipe" })
  const state = { last: "", refused: false, done: false }
  void readLines(child.stderr, (line) => {
    state.last = line
    // ssh's answer when nothing listens at the forwarded address on the remote side.
    if (line.includes("open failed")) state.refused = true
    debug(`ssh: ${line}`)
  })
  const ended = child.exited.then((code) => {
    state.done = true
    return `the ssh tunnel ended (exit ${code}${state.last === "" ? "" : `: ${state.last}`})`
  })
  return { state, ended, close: () => child.kill() }
}

async function waitForTunnel(
  url: string,
  tunnel: Tunnel,
  signal: AbortSignal,
  deadline: number,
): Promise<"ready" | "ended" | "refused" | "timeout" | "stopped"> {
  if (signal.aborted) return "stopped"
  if (tunnel.state.done) return "ended"
  if (tunnel.state.refused) return "refused"
  const answered = await fetch(new URL("/api/info", url), { signal: AbortSignal.any([signal, AbortSignal.timeout(3_000)]) }).then(
    (response) => response.arrayBuffer().then(() => true, () => true),
    () => false,
  )
  if (answered) return "ready"
  if (Date.now() >= deadline) return "timeout"
  await sleep(250, signal)
  return waitForTunnel(url, tunnel, signal, deadline)
}

async function readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void) {
  const state = { rest: "" }
  const decoder = new TextDecoder()
  for await (const chunk of stream) {
    const lines = (state.rest + decoder.decode(chunk, { stream: true })).split(/\r?\n/)
    state.rest = lines.pop() ?? ""
    lines.filter((line) => line.trim() !== "").forEach(onLine)
  }
  if (state.rest.trim() !== "") onLine(state.rest)
}

// A free port for the tunnel's local end; ExitOnForwardFailure catches the rare one taken meanwhile.
function freePort() {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
  const port = listener.port
  listener.stop(true)
  return port
}

function pending() {
  return new Promise<string>(() => {})
}

function sleep(ms: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener("abort", done, { once: true })
  })
}
