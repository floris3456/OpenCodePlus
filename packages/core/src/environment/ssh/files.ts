import path from "node:path"
import { Cause, Effect, Fiber, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import type { Watcher } from "../../filesystem/watcher.js"
import { quote } from "./exec.js"

/**
 * Filesystem change notification over the transport.
 *
 * No remote kernel notification interface is reachable through an ssh session,
 * so one long-lived remote process emits a snapshot of the watched paths at a
 * fixed interval and this side reports the differences. The observable contract
 * matches the host watcher: `file` and `entries` targets report every change as
 * an update, `directory` targets report creations, updates and deletions, and
 * an unreachable target reports nothing rather than hanging its subscribers.
 *
 * Dropped sessions are re-established, and the snapshot survives the outage, so
 * changes made while the transport was down are reported once it returns.
 */

const SEPARATOR = 0x02
const FIELDS = 4
const RETRY = "1 second"

export const makeWatcher = (
  spawner: ChildProcessSpawner["Service"],
  options?: { readonly intervalMs?: number },
): Watcher.NativeInterface => ({
  subscribe: (input) =>
    Effect.sync(() => {
      const fiber = Effect.runFork(observe(spawner, input, options?.intervalMs ?? 1_000))
      return {
        backend: "ssh-poll",
        unsubscribe: () => Effect.runPromise(Fiber.interrupt(fiber)).then(() => undefined),
      }
    }),
})

type Target = Parameters<Watcher.NativeInterface["subscribe"]>[0]

const observe = (spawner: ChildProcessSpawner["Service"], input: Target, intervalMs: number) => {
  let previous: Map<string, string> | undefined
  return Effect.gen(function* () {
    const handle = yield* spawner.spawn(
      ChildProcess.make("sh", ["-c", script(input, intervalMs), "opencode-ssh"], {
        stdin: "ignore",
        stderr: "ignore",
      }),
    )
    let buffer = new Uint8Array(0)
    yield* Stream.runForEach(handle.stdout, (chunk) =>
      Effect.sync(() => {
        const merged = new Uint8Array(buffer.length + chunk.length)
        merged.set(buffer)
        merged.set(chunk, buffer.length)
        buffer = merged
        for (let end = buffer.indexOf(SEPARATOR); end >= 0; end = buffer.indexOf(SEPARATOR)) {
          const next = parse(buffer.subarray(0, end))
          if (previous) for (const update of diff(previous, next, input.type)) input.publish(update)
          previous = next
          buffer = buffer.slice(end + 1)
        }
      }),
    )
  }).pipe(
    Effect.scoped,
    Effect.catchCause((cause) =>
      Effect.logError("ssh watcher session ended", { target: input.target, cause: Cause.pretty(cause) }),
    ),
    Effect.andThen(Effect.sleep(RETRY)),
    Effect.forever,
  )
}

const script = (input: Target, intervalMs: number) => {
  const ignored = input.ignore.map((entry) => path.posix.resolve(input.target, entry))
  const find =
    input.type === "directory"
      ? [
          "find",
          "-H",
          quote(input.target),
          ...(ignored.length === 0
            ? []
            : ["'('", ...ignored.flatMap((entry) => ["-path", quote(entry), "-o"]).slice(0, -1), "')'", "-prune", "-o"]),
          "-printf",
          String.raw`'%p\0%y\0%T@\0%s\0'`,
        ]
      : [
          "find",
          "-H",
          ...(input.type === "entries"
            ? input.names.map((name) => quote(path.posix.join(input.target, name)))
            : [quote(input.target)]),
          "-maxdepth",
          "0",
          "-printf",
          String.raw`'%p\0%y\0%T@\0%s\0'`,
        ]
  return [
    "while :; do",
    `  ${find.join(" ")} 2>/dev/null`,
    `  printf '\\002'`,
    `  sleep ${intervalMs / 1_000}`,
    "done",
  ].join("\n")
}

const parse = (snapshot: Uint8Array) => {
  const fields = new TextDecoder().decode(snapshot).split("\0")
  fields.pop()
  const entries = new Map<string, string>()
  for (let index = 0; index + FIELDS <= fields.length; index += FIELDS) {
    entries.set(fields[index], fields.slice(index + 1, index + FIELDS).join("\0"))
  }
  return entries
}

const diff = (previous: Map<string, string>, next: Map<string, string>, type: Target["type"]) => {
  const single = type !== "directory"
  const updates: Watcher.Update[] = []
  for (const [target, value] of next) {
    if (!previous.has(target)) updates.push({ path: target, type: single ? "update" : "create" })
    else if (previous.get(target) !== value) updates.push({ path: target, type: "update" })
  }
  for (const target of previous.keys()) {
    if (!next.has(target)) updates.push({ path: target, type: single ? "update" : "delete" })
  }
  return updates
}

export * as EnvironmentSshFiles from "./files.js"
