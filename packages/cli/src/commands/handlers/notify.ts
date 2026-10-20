// `opencodeplus notify [<ssh-target>] [options]`: the notification sound player for your own
// machine (Plus product only; docs/plans/plus-1.3.18-notifications.md). Like `instructions` it is
// dispatched from plus.ts before Effect CLI, because `--test [kind]` takes an optional value.

import { EOL } from "node:os"
import { Service } from "@opencode/client/effect/service"
import { Global } from "@opencode/util/global"
import { Product } from "@opencode/util/product"
import { Effect, FileSystem, Redacted } from "effect"
import { ATTENTION_KINDS } from "../../../../plus/src/attention-settings.js"
import type { Plus } from "../../../../plus/src/rpc.js"
import type { RelayLine } from "../../services/notify-connection"
import { Env } from "../../env"
import { Runtime } from "../../framework/runtime"
import { ServiceConfig } from "../../services/service-config"
import { NotifyCommand } from "../commands"

export interface NotifyOptions {
  readonly target?: string
  readonly server?: string
  readonly volume: number
  readonly desktop: boolean
  readonly test?: Plus.AttentionKind
  readonly once: boolean
  readonly verbose: boolean
  /** The other end of `notify <ssh-target>`, started there over ssh: events go to stdout as lines. */
  readonly relay: boolean
}

export type NotifyInvocation =
  | { readonly kind: "run"; readonly options: NotifyOptions }
  | { readonly kind: "help" }
  | { readonly kind: "usage-error"; readonly message: string }

export const DEFAULT_VOLUME = 0.5

export function notifyUsage(binary: string) {
  return [
    `Usage: ${binary} notify [<ssh-target>] [options]`,
    "",
    "Plays the notification sounds of one OpenCodePlus service on this machine: those",
    "of the chats open in its TUIs. Leave it running in a terminal of its own.",
    "",
    "  <ssh-target>      the machine the service runs on, as ssh takes it (user@host,",
    "                    or a Host from ~/.ssh/config). notify runs OpenCodePlus there",
    "                    over ssh, which passes the service's events back; its password",
    "                    stays there. Without it: the service on this machine.",
    "",
    "Options:",
    "  --server <url>    connect to this server instead (password: OPENCODE_PASSWORD)",
    `  --volume <0..1>   sound volume (default ${DEFAULT_VOLUME})`,
    "  --desktop         also show each notification on this desktop",
    "                    (notify-send on Linux, osascript on macOS)",
    "  --test [<event>]  once connected, ask the service for a test event:",
    `                    ${ATTENTION_KINDS.join(", ")} (default done)`,
    "  --once            with --test: exit after the test event (exit 1 if it failed)",
    "  --verbose         print every event and what was done with it",
    "  --help            show this help",
    "",
    "notify never starts a service. When none runs it says so and keeps retrying;",
    "it reconnects on its own. If ssh asks for a password, it asks here, also when",
    "notify reconnects later. Ctrl+C stops it. The other machine needs OpenCodePlus",
    "1.3.18 or later; notify runs it there as `notify --relay`.",
    "",
  ].join(EOL)
}

/** The `notify` command in a raw argv (after leading `--print-logs`), or undefined. */
export function notifyInvocation(argv: readonly string[]): NotifyInvocation | undefined {
  const rest = argv.slice(2)
  const start = rest.findIndex((arg) => arg !== "--print-logs")
  if (start === -1 || rest[start] !== "notify") return undefined
  return parseNotifyArgs(rest.slice(start + 1))
}

export function parseNotifyArgs(args: readonly string[]): NotifyInvocation {
  const queue = [...args]
  const found = {
    positionals: [] as string[],
    server: undefined as string | undefined,
    volume: undefined as string | undefined,
    test: undefined as string | undefined,
    desktop: false,
    once: false,
    verbose: false,
    relay: false,
    help: false,
    error: undefined as string | undefined,
  }
  // The value of `--name value` or `--name=value`; undefined when it is missing.
  const value = (name: string, arg: string) => {
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1)
    const next = queue[0]
    if (next === undefined || next.startsWith("-")) return undefined
    return queue.shift()
  }
  const named = (name: string, arg: string) => arg === name || arg.startsWith(`${name}=`)
  while (queue.length > 0 && found.error === undefined) {
    const arg = queue.shift() ?? ""
    if (arg === "--") {
      found.positionals.push(...queue.splice(0))
      continue
    }
    if (arg === "--help" || arg === "-h") {
      found.help = true
      continue
    }
    if (arg === "--desktop") {
      found.desktop = true
      continue
    }
    if (arg === "--once") {
      found.once = true
      continue
    }
    if (arg === "--verbose") {
      found.verbose = true
      continue
    }
    if (arg === "--relay") {
      found.relay = true
      continue
    }
    // Global flags Effect CLI would otherwise take; plus.ts has already applied --print-logs.
    if (arg === "--print-logs" || arg === "--no-print-logs") continue
    if (arg === "--standalone") {
      found.error =
        "notify listens to a service that runs already; --standalone would start a private one, which has no chats."
      continue
    }
    if (named("--server", arg)) {
      found.server = value("--server", arg)
      if (found.server === undefined || found.server === "") found.error = "Option --server expects a URL."
      continue
    }
    if (named("--volume", arg)) {
      found.volume = value("--volume", arg)
      if (found.volume === undefined || found.volume === "") found.error = "Option --volume expects a number from 0 to 1."
      continue
    }
    if (named("--test", arg)) {
      // A bare --test takes the next word only when it names an event, so `--test user@host` keeps the target.
      const next = queue[0]
      found.test = arg.startsWith("--test=")
        ? arg.slice("--test=".length)
        : next !== undefined && isKind(next)
          ? queue.shift()
          : "done"
      continue
    }
    if (arg.startsWith("-")) {
      found.error = `Unknown option ${arg}.`
      continue
    }
    found.positionals.push(arg)
  }
  if (found.help) return { kind: "help" }
  if (found.error !== undefined) return usageError(found.error)
  return validated(found)
}

function validated(found: {
  readonly positionals: readonly string[]
  readonly server: string | undefined
  readonly volume: string | undefined
  readonly test: string | undefined
  readonly desktop: boolean
  readonly once: boolean
  readonly verbose: boolean
  readonly relay: boolean
}): NotifyInvocation {
  if (found.positionals.length > 1) return usageError(`Give one ssh target, not ${found.positionals.length}.`)
  const target = found.positionals[0]
  if (found.relay && (target !== undefined || found.server !== undefined))
    return usageError("--relay listens to this machine's service; it takes no ssh target or --server.")
  if (target !== undefined && found.server !== undefined) return usageError("Give an ssh target or --server, not both.")
  const volume = found.volume === undefined ? DEFAULT_VOLUME : Number(found.volume)
  if (!Number.isFinite(volume) || volume < 0 || volume > 1)
    return usageError(`Option --volume expects a number from 0 to 1, got: ${found.volume}.`)
  if (found.test !== undefined && !isKind(found.test))
    return usageError(`Option --test expects one of ${ATTENTION_KINDS.join(", ")}, got: ${found.test}.`)
  if (found.once && found.test === undefined) return usageError("Option --once goes with --test.")
  return {
    kind: "run",
    options: {
      ...(target === undefined ? {} : { target }),
      ...(found.server === undefined ? {} : { server: found.server }),
      volume,
      desktop: found.desktop,
      ...(found.test === undefined ? {} : { test: found.test }),
      once: found.once,
      verbose: found.verbose,
      relay: found.relay,
    },
  }
}

function isKind(value: string): value is Plus.AttentionKind {
  return (ATTENTION_KINDS as readonly string[]).includes(value)
}

function usageError(message: string): NotifyInvocation {
  return { kind: "usage-error", message }
}

export const runNotifyCli = Effect.fn("cli.notify")(function* (invocation: NotifyInvocation) {
  if (invocation.kind === "help") {
    process.stdout.write(notifyUsage(Product.binaryName))
    return
  }
  if (invocation.kind === "usage-error") {
    process.stderr.write(`${invocation.message}${EOL}See ${Product.binaryName} notify --help.${EOL}`)
    process.exitCode = 2
    return
  }
  const options = invocation.options
  const { localSource, relayPlayer, relaySource, runNotify, serverSource, RELAY_VERSION } = yield* Effect.promise(
    () => import("../../services/notify-connection"),
  )
  const run = Effect.runPromiseWith(yield* Effect.context<FileSystem.FileSystem | Global.Service>())
  if (options.relay) {
    const write = (line: RelayLine) => process.stdout.write(`${JSON.stringify(line)}\n`)
    write({ type: "hello", version: RELAY_VERSION })
    // The other machine went away: ssh closed this end's stdin.
    const gone = new AbortController()
    void Bun.stdin.stream().pipeTo(new WritableStream()).finally(() => gone.abort())
    process.exitCode = yield* Effect.promise((signal) =>
      runNotify(
        {
          source: localSource(() => run(discoverLocal)),
          player: relayPlayer(write),
          playerID: crypto.randomUUID(),
          ...(options.test === undefined ? {} : { test: options.test }),
          once: false,
          relay: { connected: (label, version) => write({ type: "connected", label, version }) },
          log: (text) => write({ type: "status", text }),
          debug: options.verbose ? (text) => write({ type: "debug", text }) : () => {},
        },
        AbortSignal.any([signal, gone.signal]),
      ),
    )
    return
  }
  const { createPlayer, desktopNotifier, openTuiSpeaker } = yield* Effect.promise(
    () => import("../../services/notify-player"),
  )
  const { builtInSoundPaths } = yield* Effect.promise(() => import("@opencode/tui/attention-sounds"))
  const password = yield* Env.password
  const log = (line: string) => process.stdout.write(`${new Date().toTimeString().slice(0, 8)} ${line}${EOL}`)
  const debug = options.verbose ? log : () => {}
  const desktop = options.desktop ? desktopNotifier() : undefined
  if (desktop !== undefined && "error" in desktop) log(`Desktop notifications are off: ${desktop.error}.`)
  const speaker = openTuiSpeaker()
  const player = createPlayer({
    speaker,
    volume: options.volume,
    ...(desktop !== undefined && "notify" in desktop ? { notify: desktop.notify } : {}),
    builtIn: (sound) => Bun.file(builtInSoundPaths[sound]).bytes(),
    warn: log,
  })
  const source =
    options.target !== undefined
      ? relaySource(options.target, { verbose: options.verbose })
      : options.server !== undefined
        ? serverSource(options.server, password === undefined ? undefined : Redacted.value(password))
        : localSource(() => run(discoverLocal))
  const code = yield* Effect.promise((signal) => {
    // Ctrl+C: the process exits once this fiber is interrupted, so release the device right away.
    signal.addEventListener(
      "abort",
      () => {
        speaker.dispose()
        log("Stopped.")
      },
      { once: true },
    )
    return runNotify(
      {
        source,
        player,
        playerID: crypto.randomUUID(),
        ...(options.test === undefined ? {} : { test: options.test }),
        once: options.once,
        log,
        debug,
      },
      signal,
    ).finally(() => speaker.dispose())
  })
  process.exitCode = code
})

// This machine's service, as the other commands find it, but never started: listening alone is no
// reason to run one.
const discoverLocal = Effect.gen(function* () {
  const config = yield* ServiceConfig.read()
  if (config.disabled === true) return 'the service on this machine is turned off (its service.json says "disabled": true)'
  const options = yield* ServiceConfig.options()
  const endpoint = yield* Service.discover({ file: options.file })
  return endpoint ?? "no OpenCodePlus service is running here"
})

export default Runtime.handler(
  NotifyCommand,
  Effect.fn("cli.notify.handler")(function* () {
    yield* runNotifyCli(notifyInvocation(process.argv) ?? parseNotifyArgs(process.argv.slice(process.argv.indexOf("notify") + 1)))
  }),
)
