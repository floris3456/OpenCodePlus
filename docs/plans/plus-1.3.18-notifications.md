# Notifications and sounds that reach you over SSH (1.3.18)

Owner's request, 2026-10-20: desktop notifications and sounds while working inside SSH on the
remote (Konsole, and other popular terminals); six events with their own sounds, set globally in
/settings and per agent in Instructions; a sound player that runs on your own PC, built into
opencodeplus; local releases also build Linux x64 and macOS.

## Findings that shape it

- The TUI's desktop notifications are escape sequences (OpenTUI: OSC 99, 777 or 9). OpenTUI picks
  a protocol from the terminal's replies; over SSH that works when the terminal answers. Konsole
  answers OpenTUI's OSC 99 query and XTVERSION (`Konsole <version>`); replaying Konsole's replies
  into OpenTUI 0.5.17 selected OSC 99 over SSH (`notifications: true`). Konsole's OSC 99 and
  OSC 777 raise one KDE event, `ProcessNotification`: one sound for every notification.
- herdr emulates its panes' terminals and forwards no notification sequence (measured).
- No escape sequence plays a chosen sound on the client. herdr plays sounds in its client; its
  log on this host has 2,572 failed sounds (no audio player). The TUI plays sounds where it runs.

## Events

| Event | When |
| --- | --- |
| `done` | A chat's final reply (its turn succeeded) while nothing it started still runs: no subagent, no team run, no background shell |
| `reply` | Every final reply of a chat, also while such work runs. A reply that is also `done` fires only `done`; with `done` off it fires `reply` |
| `child` | A subagent's or team member's final reply, down to `depth` levels below the chat (1 = its own subagents and team members) |
| `question` | A question, form or permission prompt, at any depth |
| `error` | A failed turn of the chat, or of a child within `depth` when `child` is on |
| `cacheMiss` | A cache notice (the monitor's notice settings decide which misses count) |

An interrupted turn fires nothing. Running work: the warming store's busy chain (subagents and
team runs, via `parentChatOf`) plus background shells (`shell.created` with
`metadata.sessionID`, until `shell.exited`).

## Settings

Per event: `notify` (desktop notification) and `sound` (`off`, a built-in sound id such as
`bip-bop-01`, or an absolute file path on the server); `child` also `depth` (1–9).

- Global: Plus settings (`PlusSettings.attention`), /settings › Notifications.
- Per agent: Instructions › agent › Settings rows `setting:attention.<event>.notify` (state),
  `setting:attention.<event>.sound` (text) and `setting:attention.child.depth` (text), inheriting
  down the agent's chain and then the global value. `done`, `reply`, `question`, `error` and
  `cacheMiss` use the agent of the chat they happen in; `child` uses the chat's (root) agent.
- Defaults: `done` notify + `bip-bop-01`, `question` notify + `bip-bop-03`, `error` notify +
  `nope-03`; `reply`, `child` (depth 1) and `cacheMiss` off. The TUI's Alerts switches
  (Notifications, Sounds, Volume) stay the per-machine master switches.

## Delivery

The server decides each occurrence and emits Plus RPC event `attention`:

```ts
{ id, kind, sessionID, rootID, depth, agent?, title, message, notify, sound?, player, at }
```

emitted only when `notify` or `sound` applies; `player` is true while a sound player is connected.

- TUI: a desktop notification for `notify` events of the chat it has open (its root), when the
  terminal window is unfocused and Alerts › Notifications is on; the sound when Alerts › Sounds is
  on and `player` is false. It replaces the built-in notifications for sessions with Plus.
- `opencodeplus notify [<ssh-target>]`: the sound player on your PC. Connects to the service
  (through `ssh -L`, reading the remote endpoint and password over SSH, never stored), calls
  `attention.player` every 20 s, plays each event's sound for every chat of the server (built-in
  sounds are bundled; a file path is fetched once with `attention.sound`), reconnects on its own.
  `--desktop` also shows each `notify` event as an OS notification (notify-send / osascript).
  Built (packages/cli/src/commands/handlers/notify.ts, services/notify-*.ts): the remote end is
  read with `ssh <target> "sh -c '…cat ${XDG_CONFIG_HOME:-$HOME/.config}/opencodeplus/service.json'"`
  (missing hostname/port: the service's own defaults); no BatchMode, so ssh may ask for a password
  in notify's terminal; the tunnel is its own connection (`ControlPath=none`). Without a target it
  only discovers the local service's registration and never starts one; `--standalone` is
  refused (a private server has no chats). `--test [<event>]` asks once per run; `--once` exits
  after it (1 if the sound failed). Sounds are dropped within 300 ms of the last one.
- Alerts › Notification protocol (auto, OSC 99, OSC 777, OSC 9, off): sets
  `OPENTUI_NOTIFICATION_PROTOCOL` at TUI start, for terminals OpenTUI cannot detect over SSH
  (Windows Terminal).

## Builds

`packages/plus/script/release/local.ts` also cross-builds linux-x64, darwin-arm64 and darwin-x64
tarballs (not installed) next to this machine's build. Public releases already build all four.

## Parts

1. Contract: RPC schemas, settings, built-in sound ids (head).
2. Server: attention module, settings resolution, per-agent rows (head).
3. TUI: consume `attention`, /settings rows, protocol setting (head).
4. `opencodeplus notify` (feature worktree `-notify`).
5. Local release cross-builds (feature worktree `-builds`).
