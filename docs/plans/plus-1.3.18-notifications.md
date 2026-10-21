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
| `child` | A subagent's or team member's final reply, down to `depth` levels below the chat (1 = its own subagents and team members); none while work it started still runs. A team member's message says how its report settled (`scout needs context: Find …`, `implementer is done: …`) |
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
- Per agent: Instructions › agent › Settings › Notifications, text rows
  `setting:attention.<event>.notify` (on/off, cycled), `setting:attention.<event>.sound` and
  `setting:attention.child.depth` (1–9, cycled); empty ("As in Settings") is the upstream value, so
  a row inherits down the agent's chain and then the global value. Defaults has none (the global
  values are /settings). They change no agent field: Plus resolves them at each publish
  (`attentionRowsOf`). `done`, `reply`, `question`, `error` and
  `cacheMiss` use the agent of the chat they happen in; `child` uses the chat's (root) agent.
- Defaults: `done` notify + `bip-bop-01`, `question` notify + `bip-bop-03`, `error` notify +
  `nope-03`; `reply`, `child` (depth 1) and `cacheMiss` off. The TUI's Alerts switches
  (Notifications, Sounds, Volume) stay the per-machine master switches.

## Delivery

The server decides each occurrence and emits Plus RPC event `attention`:

```ts
{ id, kind, sessionID, rootID, depth, agent?, title, message, notify, sound?, player, test?, at }
```

emitted only when `notify` or `sound` applies; `player` is true while a sound player is connected.

- TUI: a desktop notification for `notify` events of the chats it has open (the current chat, its
  tabs and the chats above them), when the terminal window is unfocused and Alerts › Notifications
  is on; the sound when Alerts › Sounds is on and `player` is false. A test event is shown only by
  the TUI that asked for it. The built-in notifications stay quiet while the server has Plus.
- A chat's first turn ends before it has a title: the event's title is then its folder's name. A
  chat on the default agent names none: it resolves as Plus does for models (the first agent).
- A refused setting or sound file is a typed RPC error with its reason (`settings.invalid`,
  `sound.invalid`).
- Only chats open in a TUI notify (owner, 2026-10-21): each TUI reports its open chats (the chat
  on screen, its tabs and the chats above them) with `attention.open` when they change and every
  20 s, counted for 45 s, none once it closes. An occurrence is raised only when its chat or a
  chat above it is reported, so a subagent or team member notifies only under an open chat, and
  the sound player follows the same rule.
- `opencodeplus notify [<ssh-target>]`: the sound player on your PC. Without a target it uses the
  service on that machine (never started by it); with one it runs
  `ssh -T <target> sh -c '…'`, which finds OpenCodePlus there (PATH, ~/.opencodeplus/bin, ~/bin)
  and runs `opencodeplus notify --relay`. The relay connects to its own service, heartbeats as
  the player, and writes JSON lines (hello, connected, status, debug, attention with a sound file
  the first time it names one); it ends when ssh closes its stdin. No port is forwarded and the
  password stays on that machine. A launcher into a container works when it passes `notify`
  through without a terminal (the workspace's docker/opencodeplus does). `--test [<event>]` is
  asked once per run; `--once` exits after it (1 if the sound failed); sounds are dropped within
  300 ms of the last one; `--desktop` also shows OS notifications (notify-send / osascript);
  `--standalone` is refused (a private server has no chats).
- Alerts › Notification protocol (auto, OSC 99, OSC 777, OSC 9): sets
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
