import { Effect } from "effect"
import type { Opts } from "#pty"
import type { SshCarrier } from "./connection.js"
import { quote } from "./exec.js"

/**
 * Terminal sessions over the transport.
 *
 * A terminal session carries no control channel: stdout and stderr share the
 * terminal, so a status record written there would land in the user's screen
 * buffer. The session's own exit is the remote command's exit instead, and the
 * terminal hangup that follows it is what reaps the remote process group.
 *
 * `resize` reaches the remote terminal the way an interactive client does: the
 * carrier attaches a terminal to the ssh client, and resizing that terminal
 * makes the client send a window change for the remote one.
 */
export const makeRemotePty =
  (carrier: SshCarrier, shell: string) => (file: string, args: ReadonlyArray<string>, options: Opts) =>
    Effect.suspend(() => {
      const script = [
        options.cwd === undefined ? "" : `cd -- ${quote(options.cwd)} || exit 125`,
        `export TERM=${quote(options.name)}`,
        ...Object.entries(options.env ?? {}).map(([name, value]) => `export ${name}=${quote(value)}`),
        'exec "$@"',
      ]
        .filter((line) => line.length > 0)
        .join("\n")
      return carrier.pty(
        [quote(shell), "-c", quote(script), "opencode-ssh", quote(file), ...args.map(quote)].join(" "),
        options,
      )
    })

export * as EnvironmentSshPty from "./pty.js"
