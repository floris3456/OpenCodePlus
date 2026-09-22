import fs from "node:fs/promises"
import { describe, expect, test } from "bun:test"
import { Effect, Exit, Fiber, PlatformError, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"
import { CrossSpawnSpawner } from "@opencode/util/cross-spawn-spawner"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { collectStream } from "@opencode/util/process"
import type { Watcher } from "../src/filesystem/watcher"
import {
  clientArgs,
  Failed,
  makeFiles,
  makeSshDriver,
  NotFound,
  SshUnreachable,
  WrongKind,
  type SshCarrier,
  type SshDriver,
} from "../src/environment/index"
import { remoteLine } from "../src/environment/ssh/exec"
import { tmpdir } from "./fixture/tmpdir"
import { environmentConformance } from "./lib/environment-conformance"

/**
 * The remote end of an ssh session.
 *
 * sshd hands the client's single command line to the account's login shell
 * (`$SHELL -c <line>`), connects the session streams to it, and gives a
 * terminal session a real pty instead. This endpoint does exactly that with the
 * system shell, the real process spawner and the real terminal backend, so
 * quoting, process groups, signals, flow control and terminal sizing are all
 * decided by the operating system rather than by test code. Nothing here knows
 * the exec protocol: it only carries the line.
 *
 * What the endpoint does not stand in for is the OpenSSH client and server
 * themselves — key exchange, authentication, multiplexing, and the client's own
 * argv are covered separately and are called out in the notes below.
 */
const endpoint = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) => {
  const sessions: ChildProcessHandle[] = []
  let reachable = true

  const carrier: SshCarrier = {
    destination: "endpoint",
    exec: (line, options) =>
      reachable
        ? spawner
            .spawn(
              ChildProcess.make("/bin/sh", ["-c", line], {
                stdin: options.stdin,
                stdout: options.stdout,
                stderr: "pipe",
              }),
            )
            .pipe(Effect.tap((handle) => Effect.sync(() => sessions.push(handle))))
        : Effect.fail(
            PlatformError.systemError({
              _tag: "Unknown",
              module: "TestEndpoint",
              method: "exec",
              description: "connection refused",
            }),
          ),
    pty: (line, options) =>
      Effect.promise(() => import("#pty")).pipe(
        Effect.map((backend) => backend.spawn("/bin/sh", ["-c", line], options)),
      ),
  }

  return {
    carrier,
    /** Kills the processes carrying the open sessions, the way a lost connection does. */
    drop: () =>
      Effect.forEach(sessions.slice(), (handle) => Effect.ignore(handle.kill({ killSignal: "SIGKILL" })), {
        discard: true,
      }),
    disconnect: () =>
      Effect.sync(() => {
        reachable = false
      }),
    reconnect: () =>
      Effect.sync(() => {
        reachable = true
      }),
  }
}

interface Harness {
  readonly driver: SshDriver
  readonly endpoint: ReturnType<typeof endpoint>
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]
  readonly root: string
}

const harness = <A, E>(body: (harness: Harness) => Effect.Effect<A, E, never>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir("opencode-ssh-")),
          (directory) => Effect.promise(() => directory[Symbol.asyncDispose]()),
        )
        const remote = endpoint(spawner)
        return yield* body({
          driver: makeSshDriver({ carrier: remote.carrier, watchIntervalMs: 50 }),
          endpoint: remote,
          spawner,
          root: tmp.path,
        })
      }),
    ).pipe(Effect.provide(LayerNode.compile(CrossSpawnSpawner.node))),
  )

const run = (driver: SshDriver, command: ChildProcess.Command) =>
  Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* driver.spawner.spawn(command)
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [collectStream(handle.stdout, undefined), collectStream(handle.stderr, undefined), handle.exitCode],
        { concurrency: "unbounded" },
      )
      return { stdout: text(stdout.buffer), stderr: text(stderr.buffer), exitCode: Number(exitCode) }
    }),
  )

const shell = (script: string, ...args: string[]) => ["-c", script, "opencode-test", ...args]

const bytes = (value: string) => new TextEncoder().encode(value)
const text = (value: Uint8Array) => new TextDecoder().decode(value)

/** Retries until the condition holds, for assertions about remote state that settles. */
const eventually = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt++) {
      const result = yield* Effect.exit(body)
      if (Exit.isSuccess(result)) return result.value
      yield* Effect.sleep("25 millis")
    }
    return yield* body
  })

describe("ssh transport", () => {
  test("quotes the whole remote command line instead of interpolating arguments", () => {
    const line = remoteLine({
      nonce: "abc",
      shell: "/bin/sh",
      command: ChildProcess.make("echo", ["a b", "c'd"], {}),
    })
    expect(line.startsWith("'/bin/sh' -c '")).toBe(true)
    expect(line.endsWith(` 'echo' 'a b' 'c'\\''d'`)).toBe(true)
  })

  test("carries argv and cwd across the session byte for byte", () =>
    harness(({ driver, root }) =>
      Effect.gen(function* () {
        const files = makeFiles(driver)
        const hostile = [
          "plain",
          "with space",
          "with 'single' quotes",
          'with "double" quotes',
          "with\nnewline\tand\ttabs",
          "with\\backslash\\",
          `$(touch ${root}/pwned)`,
          `\`touch ${root}/pwned\``,
          `; touch ${root}/pwned`,
          "*",
          "日本語 → ünïcødé 🎉",
          "",
          "-n",
        ]
        const result = yield* run(
          driver,
          ChildProcess.make(
            "/bin/sh",
            shell('for value in "$@"; do printf %s "$value" | base64 -w0; echo; done', ...hostile),
            { cwd: root },
          ),
        )

        expect(result.exitCode).toBe(0)
        expect(
          result.stdout
            .split("\n")
            .slice(0, -1)
            .map((line) => Buffer.from(line, "base64").toString()),
        ).toEqual(hostile)
        expect(yield* Effect.flip(files.stat(`${root}/pwned`))).toBeInstanceOf(NotFound)
      }),
    ))

  test("runs in the requested directory and refuses one the remote cannot reach", () =>
    harness(({ driver, root }) =>
      Effect.gen(function* () {
        const files = makeFiles(driver)
        const directory = `${root}/a directory with 'quotes'`
        yield* files.mkdir(directory)

        expect((yield* run(driver, ChildProcess.make("pwd", [], { cwd: directory }))).stdout.trim()).toBe(directory)

        const failure = yield* Effect.flip(
          Effect.scoped(driver.spawner.spawn(ChildProcess.make("pwd", [], { cwd: `${root}/missing` }))),
        )
        expect(failure.message).toContain("working directory")
      }),
    ))

  test("separates stdout from stderr, passes control bytes through, and reports the exit code", () =>
    harness(({ driver }) =>
      Effect.gen(function* () {
        const result = yield* run(
          driver,
          ChildProcess.make("/bin/sh", shell(`printf out; printf '\\001not-a-record\\n' >&2; exit 3`)),
        )

        expect(result.stdout).toBe("out")
        expect(result.stderr).toBe("\u0001not-a-record\n")
        expect(result.exitCode).toBe(3)
      }),
    ))

  test("carries stdin and applies environment overrides on the remote side", () =>
    harness(({ driver }) =>
      Effect.gen(function* () {
        const piped = yield* run(
          driver,
          ChildProcess.make("cat", [], { stdin: Stream.make(bytes("through the session")) }),
        )
        expect(piped.stdout).toBe("through the session")

        const probe = shell('printf "%s|%s" "$KEPT" "${HOME-none}"')
        const inherited = yield* run(driver, ChildProcess.make("/bin/sh", probe))
        expect(inherited.stdout.startsWith("|")).toBe(true)
        expect(inherited.stdout).not.toBe("|none")

        const overridden = yield* run(
          driver,
          ChildProcess.make("/bin/sh", shell('printf "%s|%s" "$KEPT" "${DROPPED-unset}"'), {
            env: { KEPT: "a b'c", DROPPED: undefined },
            extendEnv: true,
          }),
        )
        expect(overridden.stdout).toBe("a b'c|unset")

        // Without extendEnv the remote environment is replaced, not extended.
        const replaced = yield* run(driver, ChildProcess.make("/bin/sh", probe, { env: { KEPT: "only" } }))
        expect(replaced.stdout).toBe("only|none")
      }),
    ))

  test("streams large output under flow control without losing bytes", () =>
    harness(({ driver }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const total = 8 * 1024 * 1024
          const handle = yield* driver.spawner.spawn(
            ChildProcess.make("/bin/sh", shell(`head -c ${total} /dev/zero`)),
          )
          let received = 0
          let runningAtFirstChunk: boolean | undefined
          yield* Stream.runForEach(handle.stdout, (chunk) =>
            Effect.gen(function* () {
              if (received === 0) runningAtFirstChunk = yield* handle.isRunning
              received += chunk.length
            }),
          )

          // The remote cannot have finished writing 8 MiB while this side had read one
          // chunk, so the session really did push back instead of buffering the output.
          expect(runningAtFirstChunk).toBe(true)
          expect(received).toBe(total)
          expect(Number(yield* handle.exitCode)).toBe(0)
        }),
      ),
    ))

  test("cancellation terminates remote descendants, not just the command", () =>
    harness(({ driver, root }) =>
      Effect.gen(function* () {
        const files = makeFiles(driver)
        const marker = `${root}/descendant.pid`
        const fiber = yield* Effect.forkChild(
          Effect.scoped(
            Effect.gen(function* () {
              const handle = yield* driver.spawner.spawn(
                ChildProcess.make("/bin/sh", shell('sleep 30 & echo $! > "$1"; wait', marker)),
              )
              yield* handle.exitCode
            }),
          ),
        )
        const descendant = Number(text((yield* eventually(files.read(marker))).bytes).trim())
        expect(descendant).toBeGreaterThan(0)

        yield* Fiber.interrupt(fiber)
        yield* eventually(
          Effect.suspend(() => {
            try {
              process.kill(descendant, 0)
              return Effect.fail(new Error(`descendant ${descendant} is still running`))
            } catch {
              return Effect.void
            }
          }),
        )
      }),
    ))

  test("delivers a signal to the remote process group", () =>
    harness(({ driver, root }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const files = makeFiles(driver)
          const marker = `${root}/trapped`
          const handle = yield* driver.spawner.spawn(
            ChildProcess.make("/bin/sh", shell('trap "exit 42" TERM; : > "$1"; while :; do sleep 0.05; done', marker)),
          )
          yield* eventually(files.stat(marker))

          yield* handle.kill()
          expect(Number(yield* handle.exitCode)).toBe(42)
        }),
      ),
    ))

  test("allocates a remote terminal and resizes it", () =>
    harness(({ driver, root }) =>
      Effect.gen(function* () {
        const session = yield* driver.pty("/bin/sh", shell('echo "$TERM"; while :; do stty size; sleep 0.1; done'), {
          name: "xterm-256color",
          cols: 100,
          rows: 30,
          cwd: root,
        })
        const output: string[] = []
        const listener = session.onData((chunk) => output.push(chunk))
        const saw = (value: string) =>
          Effect.suspend(() =>
            output.join("").includes(value) ? Effect.void : Effect.fail(new Error(`missing ${value}`)),
          )

        yield* eventually(saw("xterm-256color")).pipe(
          Effect.andThen(eventually(saw("30 100"))),
          Effect.andThen(Effect.sync(() => session.resize(120, 40))),
          Effect.andThen(eventually(saw("40 120"))),
          Effect.ensuring(
            Effect.sync(() => {
              listener.dispose()
              session.kill()
            }),
          ),
        )
      }),
    ))

  test("reports a dropped session as retryable and never as success", () =>
    harness(({ driver, endpoint: remote }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* driver.spawner.spawn(ChildProcess.make("/bin/sh", shell("sleep 2")))
          yield* remote.drop()

          const failure = yield* Effect.flip(handle.exitCode)
          expect(failure._tag).toBe("PlatformError")
          const cause = failure.reason.cause
          expect(cause).toBeInstanceOf(SshUnreachable)
          if (cause instanceof SshUnreachable) expect(cause.retryable).toBe(true)

          // The transport itself is still usable: the next session re-establishes.
          expect((yield* run(driver, ChildProcess.make("printf", ["recovered"]))).stdout).toBe("recovered")
        }),
      ),
    ))

  test("fails closed instead of falling back to the host", () =>
    harness(({ driver, endpoint: remote, root, spawner }) =>
      Effect.gen(function* () {
        const files = makeFiles(driver)
        const pipeline = yield* Effect.flip(
          Effect.scoped(
            driver.spawner.spawn(ChildProcess.make("printf", ["x"]).pipe(ChildProcess.pipeTo(ChildProcess.make("cat")))),
          ),
        )
        expect(pipeline.message).toContain("pipeline")

        const descriptors = yield* Effect.flip(
          Effect.scoped(
            driver.spawner.spawn(
              ChildProcess.make("printf", ["x"], { additionalFds: { fd3: { type: "output" } } }),
            ),
          ),
        )
        expect(descriptors.message).toContain("file descriptors")

        yield* remote.disconnect()
        const refused = yield* Effect.flip(files.write(`${root}/never-written`, bytes("x")))
        expect(refused).toBeInstanceOf(Failed)
        expect(yield* Effect.promise(() => Bun.file(`${root}/never-written`).exists())).toBe(false)
        yield* remote.reconnect()

        // A client that cannot start is a transport failure, not a reason to run here.
        const offline = makeSshDriver({ target: { host: "executor.invalid", program: `${root}/no-ssh` }, spawner })
        const unreachable = yield* Effect.flip(
          Effect.scoped(offline.spawner.spawn(ChildProcess.make("/bin/sh", shell(`: > "$1"`, `${root}/leaked`)))),
        )
        expect(unreachable._tag).toBe("PlatformError")
        expect(yield* Effect.promise(() => Bun.file(`${root}/leaked`).exists())).toBe(false)

        const hostile = makeSshDriver({ target: { host: "-oProxyCommand=touch /tmp/owned" }, spawner })
        expect((yield* Effect.flip(Effect.scoped(hostile.spawner.spawn(ChildProcess.make("printf", ["x"]))))).message)
          .toContain('may not start with "-"')
      }),
    ))

  test("maps remote file failures to the environment's error contract", () =>
    harness(({ driver, root }) =>
      Effect.gen(function* () {
        const files = makeFiles(driver)
        yield* files.mkdir(`${root}/directory`)

        expect(yield* Effect.flip(files.read(`${root}/missing`))).toBeInstanceOf(NotFound)
        const kind = yield* Effect.flip(files.read(`${root}/directory`))
        expect(kind).toBeInstanceOf(WrongKind)
        expect((kind as WrongKind).actual).toBe("directory")

        if (process.getuid?.() === 0) return
        yield* files.write(`${root}/locked/secret`, bytes("secret"))
        yield* Effect.promise(() => fs.chmod(`${root}/locked`, 0o000))
        const denied = yield* Effect.flip(files.stat(`${root}/locked/secret`))
        yield* Effect.promise(() => fs.chmod(`${root}/locked`, 0o700))
        expect(denied).toBeInstanceOf(Failed)
        expect(String((denied as Failed).cause)).toContain("Permission denied")
      }),
    ))

  test("reads and writes binary content across the session", () =>
    harness(({ driver, root }) =>
      Effect.gen(function* () {
        const files = makeFiles(driver)
        const payload = new Uint8Array(4096)
        for (let index = 0; index < payload.length; index++) payload[index] = (index * 7) % 256

        yield* files.write(`${root}/binary`, payload)
        const result = yield* files.read(`${root}/binary`)

        expect(result.info.size).toBe(payload.length)
        expect(Buffer.from(result.bytes).equals(Buffer.from(payload))).toBe(true)
        expect(Buffer.from((yield* files.read(`${root}/binary`, { offset: 4090, length: 6 })).bytes)).toEqual(
          Buffer.from(payload.subarray(4090)),
        )
      }),
    ))

  test("reports remote filesystem changes like the host watcher", () =>
    harness(({ driver, root }) =>
      Effect.gen(function* () {
        const files = makeFiles(driver)
        const updates: Watcher.Update[] = []
        const subscription = yield* driver.watcher.subscribe({
          type: "directory",
          target: root,
          ignore: ["ignored"],
          publish: (update) => updates.push(update),
        })
        expect(subscription?.backend).toBe("ssh-poll")

        // The first snapshot is a baseline, so poke the directory until a change lands.
        let probe = 0
        yield* eventually(
          Effect.gen(function* () {
            yield* files.write(`${root}/probe-${probe++}`, bytes("x"))
            yield* Effect.sleep("150 millis")
            if (updates.length === 0) return yield* Effect.fail(new Error("watch is not live yet"))
          }),
        )
        updates.length = 0

        const saw = (update: Watcher.Update) =>
          Effect.suspend(() =>
            updates.some((seen) => seen.path === update.path && seen.type === update.type)
              ? Effect.void
              : Effect.fail(new Error(`missing ${update.type} ${update.path}`)),
          )
        yield* files.write(`${root}/watched`, bytes("one"))
        yield* eventually(saw({ path: `${root}/watched`, type: "create" }))
        yield* files.write(`${root}/watched`, bytes("two, longer"))
        yield* eventually(saw({ path: `${root}/watched`, type: "update" }))
        yield* files.remove(`${root}/watched`)
        yield* eventually(saw({ path: `${root}/watched`, type: "delete" }))

        yield* files.write(`${root}/ignored/file`, bytes("x"))
        yield* Effect.sleep("200 millis")
        expect(updates.some((update) => update.path.includes("/ignored"))).toBe(false)

        yield* Effect.promise(() => subscription?.unsubscribe() ?? Promise.resolve())
      }),
    ))

  test("builds the OpenSSH client arguments the transport is launched with", () => {
    expect(
      clientArgs(
        { host: "executor", user: "agent", port: 2222, identity: "/keys/id", controlPath: "/run/ssh/executor" },
        false,
      ),
    ).toEqual([
      "-T",
      "-p",
      "2222",
      "-i",
      "/keys/id",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "ControlMaster=auto",
      "-o",
      "ControlPath=/run/ssh/executor",
      "-o",
      "ControlPersist=60",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      "-o",
      "LogLevel=ERROR",
    ])
    expect(clientArgs({ host: "executor" }, true)[0]).toBe("-tt")
  })

  // Proves a real OpenSSH client parses the option set; it still connects to nothing.
  test.skipIf(!Bun.which("ssh"))("a real ssh client accepts the option set", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
          const target = { host: "127.0.0.1", user: "agent", port: 2222, controlPath: "/tmp/opencode-ssh-none" }
          const handle = yield* spawner.spawn(
            ChildProcess.make("ssh", [...clientArgs(target, false), "-G", "agent@127.0.0.1"], { stdin: "ignore" }),
          )
          const [output, exitCode] = yield* Effect.all([collectStream(handle.stdout, undefined), handle.exitCode], {
            concurrency: "unbounded",
          })
          expect(Number(exitCode)).toBe(0)
          expect(text(output.buffer)).toContain("batchmode yes")
        }),
      ).pipe(Effect.provide(LayerNode.compile(CrossSpawnSpawner.node))),
    ),
  )
})

environmentConformance(
  "ssh environment",
  () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const tmp = yield* Effect.promise(() => tmpdir("opencode-ssh-environment-"))
      return {
        files: makeFiles(makeSshDriver({ carrier: endpoint(spawner).carrier })),
        root: tmp.path,
        symlink: (target: string, link: string) =>
          Effect.tryPromise({
            try: () => fs.symlink(target, link),
            catch: (cause) => new Failed({ path: link, cause }),
          }),
        dispose: Effect.promise(() => tmp[Symbol.asyncDispose]()),
      }
    }).pipe(Effect.provide(LayerNode.compile(CrossSpawnSpawner.node))),
  process.platform !== "linux",
)

