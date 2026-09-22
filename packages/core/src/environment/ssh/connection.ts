import { Effect, PlatformError, Schema } from "effect"
import type { Scope } from "effect"
import { ChildProcess } from "effect/unstable/process"
import type { ChildProcessHandle, ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import type { Opts, Proc } from "#pty"
import { lazy } from "../../util/lazy.js"

/**
 * Session management for the ssh transport.
 *
 * A carrier turns one remote command line into one local process that carries
 * that session: the OpenSSH client for a real executor. Everything above this
 * module speaks only in remote command lines, so the exec protocol never knows
 * how the session is carried and the wire layer never knows what the protocol
 * means.
 */

const pty = lazy(() => import("#pty"))

/**
 * The session could not be placed on, or was lost from, the transport. The
 * remote side may or may not have run; callers must never read this as success.
 * `retryable` marks the failures a fresh session can plausibly recover from.
 */
export class SshUnreachable extends Schema.TaggedError<SshUnreachable>()("Environment.SshUnreachable", {
  destination: Schema.String,
  retryable: Schema.Boolean,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface SshTarget {
  readonly host: string
  readonly user?: string
  readonly port?: number
  /** Private key file passed to the client with `-i`. */
  readonly identity?: string
  readonly knownHosts?: string
  readonly strictHostKeyChecking?: "yes" | "no" | "accept-new"
  /** Enables connection multiplexing; every session after the first reuses the master. */
  readonly controlPath?: string
  readonly controlPersist?: string
  readonly connectTimeout?: number
  readonly keepAlive?: number
  /** The ssh client program. Defaults to `ssh` resolved through PATH. */
  readonly program?: string
  /** Extra client arguments appended verbatim, e.g. `["-o", "IdentitiesOnly=yes"]`. */
  readonly options?: ReadonlyArray<string>
}

export interface SshCarrierExecOptions {
  readonly stdin: ChildProcess.CommandInput | ChildProcess.StdinConfig | undefined
  readonly stdout: ChildProcess.CommandOutput | ChildProcess.StdoutConfig | undefined
}

export interface SshCarrier {
  readonly destination: string
  /**
   * Carries one remote command line, the way `ssh host <line>` does. The
   * returned handle is the local end of the session: its stdio is the remote
   * command's stdio, and its own exit describes the session rather than the
   * remote command.
   */
  readonly exec: (
    line: string,
    options: SshCarrierExecOptions,
  ) => Effect.Effect<ChildProcessHandle, PlatformError.PlatformError, Scope.Scope>
  /** Carries one remote command line over a session with a terminal attached. */
  readonly pty: (line: string, options: Opts) => Effect.Effect<Proc, PlatformError.PlatformError>
}

export const destinationOf = (target: SshTarget) => (target.user ? `${target.user}@${target.host}` : target.host)

export const clientArgs = (target: SshTarget, tty: boolean): ReadonlyArray<string> => [
  tty ? "-tt" : "-T",
  ...(target.port === undefined ? [] : ["-p", String(target.port)]),
  ...(target.identity === undefined ? [] : ["-i", target.identity]),
  "-o",
  "BatchMode=yes",
  "-o",
  `StrictHostKeyChecking=${target.strictHostKeyChecking ?? "yes"}`,
  ...(target.knownHosts === undefined ? [] : ["-o", `UserKnownHostsFile=${target.knownHosts}`]),
  ...(target.controlPath === undefined
    ? []
    : [
        "-o",
        "ControlMaster=auto",
        "-o",
        `ControlPath=${target.controlPath}`,
        "-o",
        `ControlPersist=${target.controlPersist ?? "60"}`,
      ]),
  "-o",
  `ConnectTimeout=${target.connectTimeout ?? 10}`,
  "-o",
  `ServerAliveInterval=${target.keepAlive ?? 15}`,
  "-o",
  "ServerAliveCountMax=3",
  "-o",
  "LogLevel=ERROR",
  ...(target.options ?? []),
]

export const unreachable = (input: {
  readonly destination: string
  readonly method: string
  readonly retryable: boolean
  readonly detail: string
  readonly cause?: unknown
}) =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "EnvironmentSsh",
    method: input.method,
    pathOrDescriptor: input.destination,
    description: input.detail,
    cause: new SshUnreachable({
      destination: input.destination,
      retryable: input.retryable,
      detail: input.detail,
      cause: input.cause,
    }),
  })

/** Rejects work that cannot be placed on the transport; nothing ever falls back to the host. */
export const refuse = (destination: string, method: string, description: string) =>
  PlatformError.badArgument({
    module: "EnvironmentSsh",
    method,
    description: `${description} (${destination})`,
  })

export const openssh = (target: SshTarget, spawner: ChildProcessSpawner["Service"]): SshCarrier => {
  const destination = destinationOf(target)
  const program = target.program ?? "ssh"
  const rejected = validate(target)

  return {
    destination,
    exec: (line, options) =>
      rejected
        ? Effect.fail(refuse(destination, "exec", rejected))
        : spawner.spawn(
            ChildProcess.make(program, [...clientArgs(target, false), destination, line], {
              stdin: options.stdin,
              stdout: options.stdout,
              // The exec protocol multiplexes its status records onto stderr, so the
              // session's stderr always stays a pipe this process reads itself.
              stderr: "pipe",
            }),
          ),
    pty: (line, options) =>
      rejected
        ? Effect.fail(refuse(destination, "pty", rejected))
        : Effect.tryPromise({
            try: () => pty(),
            catch: (cause) =>
              unreachable({ destination, method: "pty", retryable: false, detail: "no terminal backend", cause }),
          }).pipe(
            Effect.flatMap((backend) =>
              Effect.try({
                try: () =>
                  backend.spawn(program, [...clientArgs(target, true), destination, line], {
                    name: options.name,
                    cols: options.cols,
                    rows: options.rows,
                    // The client forwards its own TERM and window size in the pty request.
                    env: { ...options.env, TERM: options.name },
                  }),
                catch: (cause) =>
                  unreachable({
                    destination,
                    method: "pty",
                    retryable: true,
                    detail: `failed to start ${program}`,
                    cause,
                  }),
              }),
            ),
          ),
  }
}

/** Anything the client would read as an option, or that cannot survive an argv slot, is refused up front. */
const validate = (target: SshTarget) => {
  if (target.host.length === 0) return "ssh target has no host"
  for (const [name, value] of [
    ["host", target.host],
    ["user", target.user],
    ["identity", target.identity],
    ["known hosts file", target.knownHosts],
  ] as const) {
    if (value === undefined) continue
    if (value.startsWith("-")) return `ssh ${name} may not start with "-": ${value}`
    if (/[\s\0]/.test(value)) return `ssh ${name} may not contain whitespace: ${value}`
  }
  if (target.port !== undefined && (!Number.isInteger(target.port) || target.port <= 0)) {
    return `ssh port must be a positive integer: ${target.port}`
  }
  return undefined
}

export * as EnvironmentSshConnection from "./connection.js"
