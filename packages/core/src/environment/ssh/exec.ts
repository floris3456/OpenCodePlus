import { Cause, Deferred, Effect, Exit, PlatformError, Queue, Sink, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import {
  ExitCode,
  make,
  makeHandle,
  ProcessId,
  type ChildProcessSpawner,
} from "effect/unstable/process/ChildProcessSpawner"
import { refuse, unreachable, type SshCarrier } from "./connection.js"

/**
 * The remote exec protocol.
 *
 * ssh carries exactly one command *string* per session, which the remote login
 * shell splits again, so every argument and the working directory are POSIX
 * quoted here and never interpolated. The remote wrapper starts the command
 * through `setsid`, which gives it a session of its own and therefore a process
 * group that a signal reaches as a whole, and reports what happened on a
 * nonce-marked control channel multiplexed onto stderr. The control channel is
 * what makes a lost session distinguishable from a remote exit: the ssh client
 * reports 255 for both a transport failure and a remote death by signal, so a
 * session that ends without a status record is reported as `SshUnreachable`,
 * never as success.
 *
 * Like the process-backed `Files` implementation this runs, the remote image
 * must be a GNU userland; `setsid` comes from util-linux.
 */

const MARK = 0x01
const NEWLINE = 0x0a
const EMPTY = new Uint8Array(0)
const STDERR_CHUNKS = 64
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const TEARDOWN_GRACE = "5 seconds"
const TEARDOWN_LIMIT = "15 seconds"

/** POSIX single-quoting: every byte survives, including quotes, newlines and non-ASCII. */
export const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

export const remoteLine = (input: {
  readonly nonce: string
  readonly shell: string
  readonly command: ChildProcess.StandardCommand
}) =>
  [
    quote(input.shell),
    "-c",
    quote(wrapper(input.nonce, input.shell, input.command.options)),
    "opencode-ssh",
    quote(input.command.command),
    ...input.command.args.map(quote),
  ].join(" ")

export const makeSpawner = (carrier: SshCarrier, shell: string): ChildProcessSpawner["Service"] =>
  make(
    Effect.fnUntraced(function* (command: ChildProcess.Command) {
      if (command._tag !== "StandardCommand") {
        return yield* Effect.fail(
          refuse(carrier.destination, "spawn", "a command pipeline cannot be placed on an ssh session"),
        )
      }
      const rejected = unsupported(command.options)
      if (rejected) return yield* Effect.fail(refuse(carrier.destination, "spawn", rejected))
      const nonce = crypto.randomUUID().replaceAll("-", "")
      const ready = Deferred.makeUnsafe<number, PlatformError.PlatformError>()
      const status = Deferred.makeUnsafe<number, PlatformError.PlatformError>()
      const session = yield* carrier.exec(remoteLine({ nonce, shell, command }), {
        stdin: command.options.stdin,
        stdout: command.options.stdout,
      })
      const stderr = yield* Queue.bounded<Uint8Array, PlatformError.PlatformError | Cause.Done>(STDERR_CHUNKS)
      const scanner = makeScanner(nonce)
      const lost = (detail: string) =>
        unreachable({ destination: carrier.destination, method: "exitCode", retryable: true, detail })

      yield* Effect.forkScoped(
        Stream.runForEach(session.stderr, (chunk) =>
          Effect.forEach(
            scanner.push(chunk, (fields) => record(carrier.destination, fields, ready, status)),
            (part) => Queue.offer(stderr, part),
            { discard: true },
          ),
        ).pipe(
          Effect.andThen(Effect.forEach(scanner.flush(), (part) => Queue.offer(stderr, part), { discard: true })),
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              // Reaching the end of the session's stderr without a status record means the
              // session died under the command; the remote fate is unknown, so both waiters
              // fail rather than resolve.
              const detail = yield* Effect.timeoutOption(session.exitCode, "2 seconds").pipe(
                Effect.match({
                  onFailure: () => "",
                  onSuccess: (code) => (code._tag === "Some" ? ` (session exit ${code.value})` : ""),
                }),
              )
              const dropped = lost(`ssh session ended without a status record${detail}`)
              Deferred.doneUnsafe(ready, Exit.fail(dropped))
              Deferred.doneUnsafe(status, Exit.fail(dropped))
              yield* Exit.isSuccess(exit) ? Queue.end(stderr) : Queue.failCause(stderr, exit.cause)
            }),
          ),
        ),
      )

      const pid = yield* Deferred.await(ready)
      const terminate = (options: ChildProcess.KillOptions | undefined) => {
        const settle = signal(carrier, pid, options?.killSignal ?? "SIGTERM").pipe(
          Effect.andThen(Deferred.await(status)),
          Effect.asVoid,
        )
        if (options?.forceKillAfter === undefined) return settle
        return Effect.timeoutOrElse(settle, {
          duration: options.forceKillAfter,
          orElse: () => signal(carrier, pid, "SIGKILL").pipe(Effect.andThen(Deferred.await(status)), Effect.asVoid),
        })
      }
      const kill = (options?: ChildProcess.KillOptions) =>
        Deferred.isDone(status).pipe(Effect.flatMap((done) => (done ? Effect.void : terminate(options))))

      // Registered after the session so it releases first: the remote group dies before
      // the session carrying it is torn down, otherwise the descendants outlive the client.
      yield* Effect.addFinalizer(() =>
        kill({
          killSignal: command.options.killSignal,
          forceKillAfter: command.options.forceKillAfter ?? TEARDOWN_GRACE,
        }).pipe(Effect.timeoutOption(TEARDOWN_LIMIT), Effect.ignore),
      )

      const output = Stream.fromQueue(stderr)
      return makeHandle({
        pid: ProcessId(pid),
        stdin: session.stdin,
        stdout: session.stdout,
        stderr: output,
        all: Stream.merge(session.stdout, output),
        // ssh carries stdin, stdout and stderr and nothing else; extra descriptors are
        // refused at spawn rather than silently dropped here.
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        isRunning: Deferred.isDone(status).pipe(Effect.map((done) => !done)),
        exitCode: Deferred.await(status).pipe(Effect.map(ExitCode)),
        kill,
        unref: session.unref,
      })
    }),
  )

const unsupported = (options: ChildProcess.CommandOptions) => {
  if (options.additionalFds !== undefined) return "additional file descriptors cannot be placed on an ssh session"
  if (options.shell) return "shell interpretation cannot be placed on an ssh session"
  const invalid = Object.keys(options.env ?? {}).find((name) => !ENV_NAME.test(name))
  if (invalid) return `environment variable name cannot be placed on an ssh session: ${invalid}`
  return undefined
}

/**
 * The command runs in the foreground of the wrapper, so it inherits the
 * session's streams and reports a real wait status, and under `setsid`, so it
 * leads a process group of its own that a signal reaches together with its
 * descendants while the wrapper survives to report the outcome. The inner shell
 * announces the group before replacing itself with the command, so the
 * announced identifier is the command's own.
 */
const wrapper = (nonce: string, shell: string, options: ChildProcess.CommandOptions) => {
  const assignments = Object.entries(options.env ?? {})
  const replace = options.extendEnv !== true && options.env !== undefined
  const mark = `\\001${nonce}`
  return [
    options.cwd === undefined ? "" : `cd -- ${quote(options.cwd)} || { printf '${mark} cwd\\n' >&2; exit 125; }`,
    ...(replace
      ? []
      : assignments.map(([name, value]) => (value === undefined ? `unset ${name}` : `export ${name}=${quote(value)}`))),
    [
      "setsid",
      quote(shell),
      "-c",
      quote(`printf '${mark} ready %s\\n' "$$" >&2\nexec "$@"`),
      "opencode-ssh",
      ...(replace ? ["env", "-i", ...assignments.map(([name, value]) => quote(`${name}=${value ?? ""}`))] : []),
      '"$@"',
    ].join(" "),
    "__opencode=$?",
    `printf '${mark} exit %s\\n' "$__opencode" >&2`,
    'exit "$__opencode"',
  ]
    .filter((line) => line.length > 0)
    .join("\n")
}

const record = (
  destination: string,
  fields: ReadonlyArray<string>,
  ready: Deferred.Deferred<number, PlatformError.PlatformError>,
  status: Deferred.Deferred<number, PlatformError.PlatformError>,
) => {
  if (fields[0] === "ready") {
    Deferred.doneUnsafe(ready, Exit.succeed(Number(fields[1])))
    return
  }
  if (fields[0] === "exit") {
    // A status without a start means the wrapper itself failed, so the spawn fails too.
    Deferred.doneUnsafe(
      ready,
      Exit.fail(refuse(destination, "spawn", `the remote command never started (wrapper exit ${fields[1]})`)),
    )
    Deferred.doneUnsafe(status, Exit.succeed(Number(fields[1])))
    return
  }
  if (fields[0] === "cwd") {
    const failure = refuse(destination, "spawn", "working directory is not reachable on the remote host")
    Deferred.doneUnsafe(ready, Exit.fail(failure))
    Deferred.doneUnsafe(status, Exit.fail(failure))
  }
}

/**
 * Signals the remote process group over its own session. The result is
 * advisory: a group that already exited reports an error the caller does not
 * need, while a transport that is really gone surfaces through the status
 * record the caller is waiting on.
 */
const signal = (carrier: SshCarrier, pgid: number, name: ChildProcess.Signal) =>
  Effect.scoped(
    carrier
      .exec(`kill -s ${name.replace("SIG", "")} -- -${pgid}`, { stdin: "ignore", stdout: "ignore" })
      .pipe(Effect.flatMap((handle) => handle.exitCode)),
  ).pipe(Effect.ignore)

/**
 * Splits the control records the remote wrapper writes out of the command's own
 * stderr. Records carry a per-session nonce the remote command cannot guess and
 * are written in one sub-PIPE_BUF write, so they never interleave with command
 * output; a partial record is held back until the rest of it arrives.
 */
const makeScanner = (nonce: string) => {
  const marker = new TextEncoder().encode(`\u0001${nonce} `)
  const decoder = new TextDecoder()
  let carry = EMPTY

  return {
    push: (chunk: Uint8Array, onRecord: (fields: ReadonlyArray<string>) => void) => {
      const buffer = carry.length === 0 ? chunk : concat(carry, chunk)
      const parts: Uint8Array[] = []
      let start = 0
      while (start < buffer.length) {
        const found = buffer.indexOf(MARK, start)
        if (found < 0) {
          parts.push(buffer.subarray(start))
          break
        }
        if (found > start) parts.push(buffer.subarray(start, found))
        const rest = buffer.subarray(found)
        if (!startsWith(rest, marker)) {
          parts.push(rest.subarray(0, 1))
          start = found + 1
          continue
        }
        if (rest.length < marker.length) {
          carry = rest.slice()
          return parts
        }
        const newline = rest.indexOf(NEWLINE, marker.length)
        if (newline < 0) {
          carry = rest.slice()
          return parts
        }
        onRecord(decoder.decode(rest.subarray(marker.length, newline)).split(" "))
        start = found + newline + 1
      }
      carry = EMPTY
      return parts
    },
    flush: () => {
      const rest = carry
      carry = EMPTY
      return rest.length === 0 ? [] : [rest]
    },
  }
}

const startsWith = (value: Uint8Array, prefix: Uint8Array) => {
  const length = Math.min(value.length, prefix.length)
  for (let index = 0; index < length; index++) {
    if (value[index] !== prefix[index]) return false
  }
  return true
}

const concat = (left: Uint8Array, right: Uint8Array) => {
  const merged = new Uint8Array(left.length + right.length)
  merged.set(left)
  merged.set(right, left.length)
  return merged
}

export * as EnvironmentSshExec from "./exec.js"
