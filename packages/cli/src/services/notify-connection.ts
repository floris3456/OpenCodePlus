import { Service, type Endpoint } from "@opencode/client/effect/service"
import { ClientError, isUnauthorizedError, OpenCode } from "@opencode/client/promise"
import { Option, Schema } from "effect"
import { isBuiltInSound } from "../../../plus/src/attention-settings.js"
import { Attention, Definition, type Plus } from "../../../plus/src/rpc.js"
import { errorMessage } from "../util/error"
import type { Handled, Player } from "./notify-player"

// `opencodeplus notify` (docs/plans/plus-1.3.18-notifications.md): stay connected to one service
// and hand each `attention` event of its chats to the player. A service on another machine is
// reached through `ssh <target> opencodeplus notify --relay`: the relay there connects to its own
// service and writes the events to ssh as JSON lines, so no port is forwarded and the service's
// password never leaves that machine.

/** The player heartbeat: the server counts a player as connected for 45 s after each one. */
export const HEARTBEAT_MS = 20_000
/** The server sends an SSE heartbeat every 15 s; this long without any data means the connection is dead. */
export const IDLE_MS = 45_000
export const RECONNECT_FIRST_MS = 1_000
export const RECONNECT_MAX_MS = 30_000
/** A connection that stayed up this long starts the backoff over. */
export const STABLE_MS = 60_000
/** Long enough to type an ssh password or passphrase before the relay answers. */
const RELAY_WAIT_MS = 120_000
const TEST_WAIT_MS = 15_000
/** --once waits this long after the test sound, so exiting does not cut it off. */
const ONCE_LINGER_MS = 2_500
/** The relay's line format; its first line says which one it writes. */
export const RELAY_VERSION = 1
/** What the remote command prints when it finds no OpenCodePlus there. */
export const RELAY_NOT_FOUND = "opencodeplus-notify: OpenCodePlus is not installed here"

const ATTENTION_EVENT = `rpc.${Definition.id}.attention`
const decodeAttention = Schema.decodeUnknownOption(Attention)

export const RelayLine = Schema.Union([
  Schema.Struct({ type: Schema.Literal("hello"), version: Schema.Number }),
  /** The relay reached its service. */
  Schema.Struct({ type: Schema.Literal("connected"), label: Schema.String, version: Schema.String }),
  Schema.Struct({ type: Schema.Literal("status"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("debug"), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("attention"),
    attention: Attention,
    /** A sound file from the service, sent with the first event that names it. */
    sound: Schema.optionalKey(Schema.Union([Schema.Struct({ data: Schema.String }), Schema.Struct({ error: Schema.String })])),
  }),
])
export type RelayLine = typeof RelayLine.Type
const decodeRelayLine = Schema.decodeUnknownOption(Schema.fromJsonString(RelayLine))

/** A service reached over HTTP: on this machine or with --server. */
export interface ServiceConnection {
  readonly kind: "service"
  /** Where it is connected, for status lines; never the password. */
  readonly label: string
  readonly endpoint: Endpoint
  readonly ended: Promise<string>
  close(): void
}

/** `opencodeplus notify --relay` on another machine, through ssh: the lines it writes. */
export interface RelayConnection {
  readonly kind: "relay"
  readonly label: string
  readonly lines: AsyncIterable<string>
  /** Settles with why, when ssh ends. */
  readonly ended: Promise<string>
  close(): void
}

export type Connection = ServiceConnection | RelayConnection

export interface Source {
  readonly label: string
  /** `test`: the test event this connection asks for once connected, if any. */
  open(signal: AbortSignal, test: Plus.AttentionKind | undefined): Promise<Connection>
}

export interface NotifyRun {
  readonly source: Source
  /** Plays each event; a relay's passes it on to the other machine instead (relayPlayer). */
  readonly player: Player
  /** This player's id in the server's heartbeat count; random per run. */
  readonly playerID: string
  readonly test?: Plus.AttentionKind
  /** Exit after the test, or after the first failure, instead of running on. */
  readonly once: boolean
  /** Set when this is the relay of `notify <ssh-target>`: the other machine waits for its test. */
  readonly relay?: { readonly connected: (label: string, version: string) => void }
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

interface ListenState {
  reason: string
  exit: number | undefined
  connectedAt: number
  tested: boolean
  awaitingTest: boolean
}

async function session(run: NotifyRun, test: Plus.AttentionKind | undefined, signal: AbortSignal): Promise<SessionEnd> {
  const opened = await run.source.open(signal, test).then(
    (connection) => ({ connection }),
    (error: unknown) => ({ error: errorMessage(error) }),
  )
  if ("error" in opened) return { reason: opened.error, upMs: 0, label: run.source.label, tested: false }
  const end =
    opened.connection.kind === "relay"
      ? await listenRelay(run, opened.connection, test, signal)
      : await listen(run, opened.connection, test, signal)
  opened.connection.close()
  return end
}

// One connection's life: why and how it ended, the test, and handing events to the player.
function lifecycle(run: NotifyRun, connection: Connection, outer: AbortSignal) {
  const stop = new AbortController()
  const signal = AbortSignal.any([outer, stop.signal])
  const state: ListenState = { reason: "", exit: undefined, connectedAt: 0, tested: false, awaitingTest: false }
  const finish = (reason: string, exit?: number) => {
    if (state.reason !== "") return
    state.reason = reason
    state.exit = exit
    stop.abort()
  }
  void connection.ended.then((reason) => finish(reason))
  const ended = (): SessionEnd => ({
    reason: state.reason,
    upMs: state.connectedAt === 0 ? 0 : Date.now() - state.connectedAt,
    label: connection.label,
    tested: state.tested,
    ...(state.exit === undefined ? {} : { exit: state.exit }),
  })
  // The test was asked for: it must arrive in time.
  const awaitTest = async () => {
    state.tested = true
    state.awaitingTest = true
    await sleep(TEST_WAIT_MS, signal)
    if (!state.awaitingTest || signal.aborted) return
    state.awaitingTest = false
    run.log(`The test event did not arrive within ${TEST_WAIT_MS / 1_000} s.`)
    if (run.once) finish("the test event did not arrive", 1)
  }
  const received = async (attention: Plus.Attention, fetchSound: (sound: string) => Promise<Uint8Array>) => {
    const isTest = attention.test === true && state.awaitingTest
    if (isTest) state.awaitingTest = false
    const handled = await run.player.handle(attention, fetchSound)
    if (run.relay !== undefined) return
    if (isTest) run.log(`Test event arrived: ${describeEvent(attention, handled)}.`)
    if (!isTest) run.debug(`Event: ${describeEvent(attention, handled)}.`)
    if (!isTest || !run.once) return
    await sleep(ONCE_LINGER_MS, signal)
    finish("the test is done", handled.sound === "failed" ? 1 : 0)
  }
  return { signal, state, finish, ended, awaitTest, received }
}

async function listen(
  run: NotifyRun,
  connection: ServiceConnection,
  test: Plus.AttentionKind | undefined,
  outer: AbortSignal,
): Promise<SessionEnd> {
  const client = OpenCode.make({ baseUrl: connection.endpoint.url, headers: Service.headers(connection.endpoint) })
  const plus = client.rpc(Definition)
  const life = lifecycle(run, connection, outer)
  const signal = life.signal
  const activity = { at: Date.now() }

  const info = await client.server.info({ signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) }).then(
    (value) => ({ version: value.version }),
    (error: unknown) => ({ error: connectionError(error, connection) }),
  )
  if ("error" in info) {
    life.finish(info.error)
    return life.ended()
  }

  // The first heartbeat also proves the service has the player API; later ones may fail quietly.
  const beat = (first: boolean) =>
    plus["attention.player"]({ id: run.playerID }, { signal }).then(
      (result) => result.players,
      (error: unknown) => {
        if (first) life.finish(`the service has no sound player support (${errorMessage(error)}); update OpenCodePlus there`)
        if (!first) run.debug(`Heartbeat failed: ${errorMessage(error)}`)
        return undefined
      },
    )
  const fetchSound = (sound: string) =>
    plus["attention.sound"]({ sound }, { signal }).then((data) => Buffer.from(data.data, "base64"))

  const askForTest = async (kind: Plus.AttentionKind) => {
    life.state.tested = true
    const failed = await plus["attention.test"]({ kind }, { signal }).then(
      () => undefined,
      (error: unknown) => errorMessage(error),
    )
    if (failed !== undefined) {
      run.log(`The test failed: ${failed}.`)
      if (run.once) life.finish("the test failed", 1)
      return
    }
    run.debug(`Asked for a test "${kind}" event.`)
    // A relay's test is awaited on the other machine.
    if (run.relay === undefined) await life.awaitTest()
  }

  const connected = async () => {
    life.state.connectedAt = Date.now()
    const players = await beat(true)
    if (players === undefined) return
    if (run.relay !== undefined) run.relay.connected(connection.label, info.version)
    if (run.relay === undefined)
      run.log(`Connected to ${connection.label}, OpenCodePlus ${info.version}. Playing the sounds of the chats open in its TUIs.`)
    run.debug(`The service counts ${players} sound player${players === 1 ? "" : "s"} now.`)
    if (test !== undefined) void askForTest(test)
  }

  const heartbeat = setInterval(() => void beat(false), HEARTBEAT_MS)
  const watchdog = setInterval(() => {
    if (Date.now() - activity.at > IDLE_MS) life.finish(`no data from the service for ${IDLE_MS / 1_000} s`)
  }, 5_000)
  const events = client.event.subscribe({
    signal,
    onActivity: () => {
      activity.at = Date.now()
    },
  })
  const streamed = await (async () => {
    for await (const event of events) {
      activity.at = Date.now()
      if (event.type === "server.connected") void connected()
      if (event.type !== ATTENTION_EVENT) continue
      const attention = decodeAttention(event.data)
      if (Option.isNone(attention)) run.debug(`Ignored an attention event this version cannot read.`)
      if (Option.isSome(attention)) void life.received(attention.value, fetchSound)
    }
    return "the service closed the connection"
  })().catch((error: unknown) => (isTransport(error) ? "the connection broke" : connectionError(error, connection)))
  clearInterval(heartbeat)
  clearInterval(watchdog)
  if (life.state.reason === "") life.finish(streamed)
  return life.ended()
}

async function listenRelay(
  run: NotifyRun,
  connection: RelayConnection,
  test: Plus.AttentionKind | undefined,
  outer: AbortSignal,
): Promise<SessionEnd> {
  const life = lifecycle(run, connection, outer)
  const relay = { hello: false, connected: false }
  // Sound files arrive with the first event that names them.
  const sounds = new Map<string, Uint8Array | Error>()
  const fetchSound = async (sound: string) => {
    const known = sounds.get(sound)
    if (known instanceof Error) throw known
    if (known === undefined) throw new Error(`${connection.label} did not send this sound file`)
    return known
  }
  const silent = setTimeout(() => {
    if (!relay.hello) life.finish(`no answer from OpenCodePlus on ${connection.label} within ${RELAY_WAIT_MS / 1_000} s`)
  }, RELAY_WAIT_MS)
  const handle = (line: RelayLine) => {
    if (line.type === "hello") {
      relay.hello = true
      if (line.version !== RELAY_VERSION)
        life.finish(`OpenCodePlus on ${connection.label} writes notify relay version ${line.version}, this one reads ${RELAY_VERSION}: update both`)
      return
    }
    if (line.type === "connected") {
      // Counted as up from here: a relay whose service is down keeps retrying on its side.
      life.state.connectedAt = life.state.connectedAt === 0 ? Date.now() : life.state.connectedAt
      if (relay.connected) return
      relay.connected = true
      run.log(`Connected to ${connection.label}, OpenCodePlus ${line.version}. Playing the sounds of the chats open in its TUIs.`)
      run.debug(`${connection.label}: connected to ${line.label}.`)
      if (test !== undefined) void life.awaitTest()
      return
    }
    if (line.type === "status") return run.log(`${connection.label}: ${line.text}`)
    if (line.type === "debug") return run.debug(`${connection.label}: ${line.text}`)
    const sound = line.attention.sound
    if (sound !== undefined && line.sound !== undefined)
      sounds.set(sound, "data" in line.sound ? Buffer.from(line.sound.data, "base64") : new Error(line.sound.error))
    void life.received(line.attention, fetchSound)
  }
  // The session can end while the relay writes nothing (a test done, Ctrl+C): stop waiting then.
  const lines = connection.lines[Symbol.asyncIterator]()
  const stopped = new Promise<undefined>((resolve) => life.signal.addEventListener("abort", () => resolve(undefined), { once: true }))
  while (!life.signal.aborted) {
    const next = await Promise.race([lines.next(), stopped])
    if (next === undefined || next.done === true) break
    const line = decodeRelayLine(next.value)
    // Anything else is what a shell startup file on the other machine printed.
    if (Option.isNone(line)) run.debug(`${connection.label}: ${next.value}`)
    if (Option.isSome(line)) handle(line.value)
  }
  void lines.return?.()
  clearTimeout(silent)
  if (life.state.reason === "")
    life.finish(await Promise.race([connection.ended, sleep(2_000, outer).then(() => "the relay stopped writing")]))
  if (!relay.hello) life.state.reason = `${life.state.reason}${relayHint(life.state.reason)}`
  return life.ended()
}

// A relay that never said hello and was not refused by ssh or missing: most likely an older release.
function relayHint(reason: string) {
  if (reason === "" || reason.startsWith("ssh ") || reason.startsWith("OpenCodePlus is not installed") || reason.startsWith("no answer"))
    return ""
  return "; OpenCodePlus there may be older than 1.3.18, which has no notify relay"
}

function connectionError(error: unknown, connection: ServiceConnection) {
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
      return { kind: "service", label: `this machine's service (${found.url})`, endpoint: found, ended: pending(), close: () => {} }
    },
  }
}

/** `--server <url>`, with the password from OPENCODE_PASSWORD. */
export function serverSource(url: string, password: string | undefined): Source {
  const endpoint = {
    url,
    ...(password === undefined ? {} : { auth: { type: "basic" as const, username: "opencode", password } }),
  }
  return { label: url, open: async () => ({ kind: "service", label: url, endpoint, ended: pending(), close: () => {} }) }
}

/** The service on another machine, through `opencodeplus notify --relay` there. */
export function relaySource(target: string, options: { readonly verbose: boolean }): Source {
  return {
    label: target,
    open: async (signal, test) => {
      const flags = [...(options.verbose ? ["--verbose"] : []), ...(test === undefined ? [] : ["--test", test])]
      // Its stdin stays open: the relay there stops when it closes. ssh asks for passwords on the terminal.
      const child = Bun.spawn(relayCommand(target, flags), { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
      const state = { last: "" }
      void readLines(child.stderr, (line) => {
        state.last = line
      })
      // Stopped at once on Ctrl+C: the process may exit before the session unwinds.
      const close = () => {
        signal.removeEventListener("abort", close)
        child.kill()
      }
      signal.addEventListener("abort", close, { once: true })
      return {
        kind: "relay",
        label: target,
        lines: streamLines(child.stdout),
        ended: child.exited.then((code) => relayEnded(target, code, state.last)),
        close,
      }
    },
  }
}

export function relayCommand(target: string, flags: readonly string[]) {
  return ["ssh", "-T", "-o", "ConnectTimeout=20", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "--", target, remoteCommand(flags)]
}

/**
 * What runs there, under the target's login shell: OpenCodePlus from PATH, else where its installer
 * puts it, else ~/bin (where a launcher into a container goes). A non-interactive ssh shell often
 * has a shorter PATH than a terminal. `flags` are fixed words (--verbose, --test <event>).
 */
export function remoteCommand(flags: readonly string[]) {
  const args = ["notify", "--relay", ...flags].join(" ")
  return `sh -c 'for c in opencodeplus "$HOME/.opencodeplus/bin/opencodeplus" "$HOME/bin/opencodeplus"; do if command -v "$c" >/dev/null 2>&1; then exec "$c" ${args}; fi; done; echo "${RELAY_NOT_FOUND}" >&2; exit 127'`
}

/** Why `ssh <target> <remote command>` ended. */
export function relayEnded(target: string, code: number, last: string) {
  if (code === 127 && last.includes(RELAY_NOT_FOUND))
    return `OpenCodePlus is not installed on ${target} (looked on PATH, in ~/.opencodeplus/bin and in ~/bin)`
  // ssh's own failures: unknown host, refused, authentication.
  if (code === 255) return `ssh ${target} failed${last === "" ? "" : `: ${last}`}`
  return `the notify relay on ${target} ended (exit ${code}${last === "" ? "" : `: ${last}`})`
}

/**
 * The relay's side of the ssh connection (`notify --relay`): each event of its service as a line,
 * a sound file with the first event that names it. Nothing plays here.
 */
export function relayPlayer(write: (line: RelayLine) => void): Player {
  const sent = new Set<string>()
  const none: Handled = { sound: "none", desktop: "off" }
  return {
    async handle(attention, fetchSound) {
      const sound = attention.sound
      if (sound === undefined || isBuiltInSound(sound) || sent.has(sound)) {
        write({ type: "attention", attention })
        return none
      }
      const file = await fetchSound(sound).then(
        (bytes) => ({ data: Buffer.from(bytes).toString("base64") }),
        (error: unknown) => ({ error: errorMessage(error) }),
      )
      if ("data" in file) sent.add(sound)
      write({ type: "attention", attention, sound: file })
      return none
    },
  }
}

async function* streamLines(stream: ReadableStream<Uint8Array>) {
  const state = { rest: "" }
  const decoder = new TextDecoder()
  for await (const chunk of stream) {
    const lines = (state.rest + decoder.decode(chunk, { stream: true })).split(/\r?\n/)
    state.rest = lines.pop() ?? ""
    yield* lines.filter((line) => line.trim() !== "")
  }
  if (state.rest.trim() !== "") yield state.rest
}

async function readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void) {
  for await (const line of streamLines(stream)) onLine(line)
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
