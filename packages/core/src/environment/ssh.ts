import type { Effect, PlatformError } from "effect"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import type { Opts, Proc } from "#pty"
import type { Driver } from "./driver.js"
import type { Watcher } from "../filesystem/watcher.js"
import { openssh, type SshCarrier, type SshTarget } from "./ssh/connection.js"
import { makeSpawner } from "./ssh/exec.js"
import { makeWatcher } from "./ssh/files.js"
import { makeRemotePty } from "./ssh/pty.js"

export {
  clientArgs,
  openssh,
  SshUnreachable,
  type SshCarrier,
  type SshCarrierExecOptions,
  type SshTarget,
} from "./ssh/connection.js"

/**
 * An `Environment` whose execution plane is a separate host reached over
 * OpenSSH, so agent-controlled work runs where the product's secrets are not.
 *
 * Nothing is served locally. `files` is the process-backed implementation the
 * `Environment` seam already defines, running its scripts through the remote
 * spawner, so the same protocol that a container executes also crosses the
 * session. Work that cannot be placed on a session — a pipeline, an extra file
 * descriptor, an unreachable host — fails; it never runs on the host instead.
 *
 * Beyond the `Driver` contract this exposes the two facilities that live
 * outside the `Environment` interface but still need a placement: terminal
 * sessions, shaped like the host `Pty` backend, and a watcher backend shaped
 * like `Watcher.Native`.
 */
export interface SshDriver extends Driver {
  readonly destination: string
  readonly pty: (
    file: string,
    args: ReadonlyArray<string>,
    options: Opts,
  ) => Effect.Effect<Proc, PlatformError.PlatformError>
  readonly watcher: Watcher.NativeInterface
}

export type SshOptions = {
  /** The remote shell used to interpret the session's command line. */
  readonly shell?: string
  readonly watchIntervalMs?: number
} & (
  | { readonly target: SshTarget; readonly spawner: ChildProcessSpawner["Service"] }
  /**
   * Replaces the wire layer, which otherwise launches the OpenSSH client. The
   * replacement carries a command line to an endpoint that runs it the way
   * sshd does; everything above it stays the same code.
   */
  | { readonly carrier: SshCarrier }
)

export const makeSshDriver = (options: SshOptions): SshDriver => {
  const carrier = "carrier" in options ? options.carrier : openssh(options.target, options.spawner)
  const shell = options.shell ?? "/bin/sh"
  const spawner = makeSpawner(carrier, shell)

  return {
    spawner,
    destination: carrier.destination,
    pty: makeRemotePty(carrier, shell),
    watcher: makeWatcher(spawner, { intervalMs: options.watchIntervalMs }),
  }
}

export * as EnvironmentSsh from "./ssh.js"
