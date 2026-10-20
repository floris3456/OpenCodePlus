import { describe, expect, test } from "bun:test"
import type { Plus } from "../../plus/src/rpc.js"
import { DEFAULT_VOLUME, notifyInvocation, notifyUsage, parseNotifyArgs } from "../src/commands/handlers/notify"
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  nextReconnect,
  RECONNECT_MAX_MS,
  RELAY_NOT_FOUND,
  RELAY_VERSION,
  relayCommand,
  relayEnded,
  relayPlayer,
  remoteCommand,
  runNotify,
  STABLE_MS,
  type RelayLine,
  type Source,
} from "../src/services/notify-connection"
import { createPlayer, createSoundGate, desktopCommand, SOUND_GAP_MS, type Speaker } from "../src/services/notify-player"

describe("notify arguments", () => {
  test("defaults: this machine's service, volume 0.5, nothing else", () => {
    expect(parseNotifyArgs([])).toEqual({
      kind: "run",
      options: { volume: DEFAULT_VOLUME, desktop: false, once: false, verbose: false, relay: false },
    })
  })

  test("an ssh target and every option", () => {
    expect(parseNotifyArgs(["me@box", "--volume", "0.2", "--desktop", "--test", "error", "--once", "--verbose"])).toEqual({
      kind: "run",
      options: { target: "me@box", volume: 0.2, desktop: true, test: "error", once: true, verbose: true, relay: false },
    })
  })

  test("--test takes the next word only when it names an event", () => {
    const bare = parseNotifyArgs(["--test", "me@box"])
    expect(bare).toEqual({ kind: "run", options: expect.objectContaining({ target: "me@box", test: "done" }) })
    expect(parseNotifyArgs(["--test", "question"])).toEqual({
      kind: "run",
      options: expect.objectContaining({ test: "question" }),
    })
    expect(parseNotifyArgs(["--test=cacheMiss", "box"])).toEqual({
      kind: "run",
      options: expect.objectContaining({ target: "box", test: "cacheMiss" }),
    })
    expect(parseNotifyArgs(["--test"])).toEqual({ kind: "run", options: expect.objectContaining({ test: "done" }) })
  })

  test("--server with = or a separate value", () => {
    expect(parseNotifyArgs(["--server", "http://127.0.0.1:4096"])).toEqual({
      kind: "run",
      options: expect.objectContaining({ server: "http://127.0.0.1:4096" }),
    })
    expect(parseNotifyArgs(["--server=http://h:1", "--volume=1"])).toEqual({
      kind: "run",
      options: expect.objectContaining({ server: "http://h:1", volume: 1 }),
    })
  })

  test("refusals name the mistake", () => {
    const refused = (args: string[]) => {
      const parsed = parseNotifyArgs(args)
      return parsed.kind === "usage-error" ? parsed.message : `not refused: ${parsed.kind}`
    }
    expect(refused(["--test=nope"])).toContain("Option --test expects one of done, reply, child, question, error, cacheMiss")
    expect(refused(["--volume", "2"])).toContain("from 0 to 1")
    expect(refused(["--volume", "loud"])).toContain("from 0 to 1")
    expect(refused(["--volume"])).toContain("--volume expects")
    expect(refused(["--server"])).toContain("--server expects a URL")
    expect(refused(["--server="])).toContain("--server expects a URL")
    expect(refused(["box", "--server", "http://h:1"])).toContain("not both")
    expect(refused(["one", "two"])).toContain("one ssh target")
    expect(refused(["--once"])).toContain("--once goes with --test")
    expect(refused(["--standalone"])).toContain("--standalone")
    expect(refused(["-x"])).toContain("Unknown option -x")
    expect(refused(["--relay", "box"])).toContain("--relay listens to this machine's service")
  })

  test("--relay: the other end of notify <ssh-target>, with the test it is asked for", () => {
    expect(parseNotifyArgs(["--relay", "--test", "question", "--verbose"])).toEqual({
      kind: "run",
      options: expect.objectContaining({ relay: true, test: "question", verbose: true }),
    })
  })

  test("after -- a word is the target even when it looks like an option", () => {
    expect(parseNotifyArgs(["--", "-odd"])).toEqual({ kind: "run", options: expect.objectContaining({ target: "-odd" }) })
  })

  test("--help wins over everything else", () => {
    expect(parseNotifyArgs(["box", "--volume", "9", "--help"])).toEqual({ kind: "help" })
    expect(notifyUsage("opencodeplus")).toStartWith("Usage: opencodeplus notify [<ssh-target>] [options]")
  })

  test("the raw argv dispatch finds notify after leading --print-logs only", () => {
    expect(notifyInvocation(["bun", "plus.ts", "notify", "box"])).toEqual({
      kind: "run",
      options: expect.objectContaining({ target: "box" }),
    })
    expect(notifyInvocation(["bun", "plus.ts", "--print-logs", "notify"])?.kind).toBe("run")
    expect(notifyInvocation(["bun", "plus.ts", "run", "notify"])).toBeUndefined()
    expect(notifyInvocation(["bun", "plus.ts"])).toBeUndefined()
    expect(notifyInvocation(["bun", "plus.ts", "--print-logs"])).toBeUndefined()
  })
})

describe("notify relay over ssh", () => {
  const attention = (overrides: Partial<Plus.Attention> = {}): Plus.Attention => ({
    id: "e1",
    kind: "done",
    sessionID: "ses_1",
    rootID: "ses_1",
    depth: 0,
    title: "Fix the login",
    message: "Done",
    notify: true,
    sound: "bip-bop-01",
    player: true,
    at: 0,
    ...overrides,
  })

  test("ssh runs OpenCodePlus there, found on PATH, where its installer puts it, or in ~/bin", () => {
    const command = relayCommand("me@box", ["--test", "done"])
    expect(command.slice(0, -2)).toEqual([
      "ssh", "-T", "-o", "ConnectTimeout=20", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "--",
    ])
    expect(command.at(-2)).toBe("me@box")
    expect(command.at(-1)).toBe(
      `sh -c 'for c in opencodeplus "$HOME/.opencodeplus/bin/opencodeplus" "$HOME/bin/opencodeplus"; do if command -v "$c" >/dev/null 2>&1; then exec "$c" notify --relay --test done; fi; done; echo "${RELAY_NOT_FOUND}" >&2; exit 127'`,
    )
    expect(command.join(" ")).not.toContain("BatchMode")
    expect(command.join(" ")).not.toContain("-L")
  })

  test("the remote command finds OpenCodePlus in ~/bin when PATH has none, and says so when there is none", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "notify-relay-"))
    const env = { HOME: home, PATH: "/usr/bin:/bin" }
    const run = (script: string) => Bun.spawnSync(["sh", "-c", script.slice("sh -c '".length, -1)], { env })
    const missing = run(remoteCommand([]))
    expect(missing.exitCode).toBe(127)
    expect(relayEnded("box", missing.exitCode, missing.stderr.toString().trim())).toBe(
      "OpenCodePlus is not installed on box (looked on PATH, in ~/.opencodeplus/bin and in ~/bin)",
    )
    await mkdir(path.join(home, "bin"))
    await Bun.write(path.join(home, "bin/opencodeplus"), '#!/bin/sh\necho "ran: $*"\n')
    await chmod(path.join(home, "bin/opencodeplus"), 0o755)
    expect(run(remoteCommand(["--verbose"])).stdout.toString()).toBe("ran: notify --relay --verbose\n")
    await rm(home, { recursive: true, force: true })
  })

  test("why the relay ended: ssh's own failure, or the relay's", () => {
    expect(relayEnded("box", 255, "ssh: connect to host box port 22: Connection refused")).toBe(
      "ssh box failed: ssh: connect to host box port 22: Connection refused",
    )
    expect(relayEnded("box", 1, "")).toBe("the notify relay on box ended (exit 1)")
  })

  test("the relay passes events on and sends a sound file once, with the first event that names it", async () => {
    const lines: RelayLine[] = []
    const fetched: string[] = []
    const relay = relayPlayer((line) => lines.push(line))
    const fetch = async (sound: string) => {
      fetched.push(sound)
      if (sound.includes("missing")) throw new Error("No sound file at /missing.wav on the server")
      return new Uint8Array([7, 8])
    }
    await relay.handle(attention(), fetch)
    await relay.handle(attention({ sound: "/s/ding.wav" }), fetch)
    await relay.handle(attention({ sound: "/s/ding.wav" }), fetch)
    await relay.handle(attention({ sound: "/missing.wav" }), fetch)
    expect(fetched).toEqual(["/s/ding.wav", "/missing.wav"])
    expect(lines.map((line) => (line.type === "attention" ? (line.sound ?? null) : line.type))).toEqual([
      null,
      { data: Buffer.from([7, 8]).toString("base64") },
      null,
      { error: "No sound file at /missing.wav on the server" },
    ])
  })

  test("this machine plays what the relay passes on, with the sound file it sent, and the test arrives", async () => {
    const played: Array<{ attention: Plus.Attention; sound: Uint8Array | undefined }> = []
    const log: string[] = []
    const asked: Array<string | undefined> = []
    const out = [
      "Last login: yesterday",
      JSON.stringify({ type: "hello", version: RELAY_VERSION }),
      JSON.stringify({ type: "status", text: "Connecting to this machine's service..." }),
      JSON.stringify({ type: "connected", label: "this machine's service (http://127.0.0.1:40375)", version: "2.0.32-plus-1.3.18" }),
      JSON.stringify({ type: "attention", attention: attention({ sound: "/s/ding.wav", test: true }), sound: { data: Buffer.from([5]).toString("base64") } }),
    ]
    const stop = new AbortController()
    const source: Source = {
      label: "box",
      open: async (_signal, test) => {
        asked.push(test)
        return {
          kind: "relay",
          label: "box",
          lines: (async function* () {
            yield* out
            await new Promise(() => {})
          })(),
          ended: new Promise(() => {}),
          close: () => {},
        }
      },
    }
    const code = await runNotify(
      {
        source,
        player: {
          handle: async (event, fetch) => {
            played.push({ attention: event, sound: event.sound === undefined ? undefined : await fetch(event.sound) })
            // The test arrived: stop like Ctrl+C (--once would wait 2.5 s for the sound to end).
            queueMicrotask(() => stop.abort())
            return { sound: "played", desktop: "off" }
          },
        },
        playerID: "p",
        test: "done",
        once: false,
        log: (line) => log.push(line),
        debug: () => {},
      },
      stop.signal,
    )
    expect(code).toBe(0)
    expect(asked).toEqual(["done"])
    expect(played.map((entry) => [entry.attention.sound, [...(entry.sound ?? [])]])).toEqual([["/s/ding.wav", [5]]])
    expect(log).toContain("box: Connecting to this machine's service...")
    expect(log.find((line) => line.startsWith("Connected to box"))).toContain("OpenCodePlus 2.0.32-plus-1.3.18")
    expect(log.find((line) => line.startsWith("Test event arrived"))).toContain("played /s/ding.wav")
  })

  test("a relay that never says hello names the likely cause", async () => {
    const log: string[] = []
    const code = await runNotify(
      {
        source: {
          label: "old",
          open: async () => ({
            kind: "relay",
            label: "old",
            lines: (async function* () {})(),
            ended: Promise.resolve("the notify relay on old ended (exit 1: Unknown option --relay)"),
            close: () => {},
          }),
        },
        player: { handle: async () => ({ sound: "none", desktop: "off" }) },
        playerID: "p",
        once: true,
        log: (line) => log.push(line),
        debug: () => {},
      },
      new AbortController().signal,
    )
    expect(code).toBe(1)
    expect(log.at(-1)).toContain("may be older than 1.3.18")
  })
})

describe("notify reconnect policy", () => {
  test("doubles from 1 s up to 30 s while connections keep failing", () => {
    const delays = Array.from({ length: 8 }).reduce<{ failures: number; delays: number[] }>(
      (state) => {
        const next = nextReconnect(state.failures, 0)
        return { failures: next.failures, delays: [...state.delays, next.delayMs] }
      },
      { failures: 0, delays: [] },
    ).delays
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000])
    expect(Math.max(...delays)).toBe(RECONNECT_MAX_MS)
  })

  test("a connection that stayed up starts over at 1 s; a short one keeps backing off", () => {
    expect(nextReconnect(6, STABLE_MS)).toEqual({ failures: 1, delayMs: 1_000 })
    expect(nextReconnect(2, STABLE_MS - 1)).toEqual({ failures: 3, delayMs: 4_000 })
  })
})

describe("notify sound gate", () => {
  test("lets one sound through per gap", () => {
    const clock = { now: 1_000 }
    const gate = createSoundGate(SOUND_GAP_MS, () => clock.now)
    expect(gate.allow()).toBe(true)
    clock.now += SOUND_GAP_MS - 1
    expect(gate.allow()).toBe(false)
    clock.now += 1
    expect(gate.allow()).toBe(true)
  })
})

describe("notify player", () => {
  const event = (overrides: Partial<Plus.Attention> = {}): Plus.Attention => ({
    id: "e1",
    kind: "done",
    sessionID: "ses_1",
    rootID: "ses_1",
    depth: 0,
    title: "Fix the login",
    message: "Done",
    notify: true,
    sound: "bip-bop-01",
    player: true,
    at: 0,
    ...overrides,
  })

  const setup = (options: { readonly desktop?: boolean; readonly failPlay?: string; readonly failNotify?: string } = {}) => {
    const clock = { now: 0 }
    const calls = {
      loaded: [] as string[],
      played: [] as Array<{ key: string; volume: number }>,
      builtIn: [] as string[],
      fetched: [] as string[],
      notified: [] as Array<{ title: string; message: string }>,
      warnings: [] as string[],
    }
    const speaker: Speaker = {
      load: (key) => {
        calls.loaded.push(key)
      },
      play: (key, volume) => {
        if (options.failPlay !== undefined) throw new Error(options.failPlay)
        calls.played.push({ key, volume })
      },
      dispose: () => {},
    }
    const player = createPlayer({
      speaker,
      volume: 0.3,
      ...(options.desktop
        ? {
            notify: async (title: string, message: string) => {
              if (options.failNotify !== undefined) throw new Error(options.failNotify)
              calls.notified.push({ title, message })
            },
          }
        : {}),
      builtIn: async (sound) => {
        calls.builtIn.push(sound)
        return new Uint8Array([1])
      },
      warn: (message) => calls.warnings.push(message),
      now: () => clock.now,
    })
    const fetch = async (sound: string) => {
      calls.fetched.push(sound)
      if (sound.includes("missing")) throw { type: "rpc.internal", message: "RPC call failed" }
      return new Uint8Array([2])
    }
    const next = () => {
      clock.now += SOUND_GAP_MS
    }
    return { player, calls, fetch, next }
  }

  test("a built-in sound is loaded once and played at the chosen volume", async () => {
    const lab = setup()
    expect(await lab.player.handle(event(), lab.fetch)).toEqual({ sound: "played", desktop: "off" })
    lab.next()
    await lab.player.handle(event({ id: "e2" }), lab.fetch)
    expect(lab.calls.builtIn).toEqual(["bip-bop-01"])
    expect(lab.calls.loaded).toEqual(["bip-bop-01"])
    expect(lab.calls.played).toEqual([
      { key: "bip-bop-01", volume: 0.3 },
      { key: "bip-bop-01", volume: 0.3 },
    ])
    expect(lab.calls.fetched).toEqual([])
  })

  test("a sound file on the server is fetched through the connection once", async () => {
    const lab = setup()
    const sound = "/home/me/sounds/ding.mp3"
    await lab.player.handle(event({ sound }), lab.fetch)
    lab.next()
    await lab.player.handle(event({ sound }), lab.fetch)
    expect(lab.calls.fetched).toEqual([sound])
    expect(lab.calls.played.map((call) => call.key)).toEqual([sound, sound])
  })

  test("no sound: nothing is loaded or played", async () => {
    const lab = setup()
    expect(await lab.player.handle(event({ sound: undefined }), lab.fetch)).toEqual({ sound: "none", desktop: "off" })
    expect(lab.calls.loaded).toEqual([])
  })

  test("a burst plays one sound", async () => {
    const lab = setup()
    const results = await Promise.all(
      ["a", "b", "c", "d"].map((id) => lab.player.handle(event({ id }), lab.fetch)),
    )
    expect(results.map((result) => result.sound)).toEqual(["played", "too-soon", "too-soon", "too-soon"])
    expect(lab.calls.played).toHaveLength(1)
  })

  test("a failing sound warns once, keeps going, and is tried again later", async () => {
    const lab = setup()
    const sound = "/home/me/sounds/missing.mp3"
    const first = await lab.player.handle(event({ sound }), lab.fetch)
    lab.next()
    const second = await lab.player.handle(event({ sound }), lab.fetch)
    expect(first).toEqual({ sound: "failed", desktop: "off", reason: "RPC call failed" })
    expect(second.sound).toBe("failed")
    expect(lab.calls.fetched).toEqual([sound, sound])
    expect(lab.calls.warnings).toEqual([`Sound ${sound} did not play: RPC call failed`])
  })

  test("no sound device: the reason is reported once", async () => {
    const lab = setup({ failPlay: "no sound device could be opened (Audio start failed: -5)" })
    await lab.player.handle(event(), lab.fetch)
    lab.next()
    await lab.player.handle(event(), lab.fetch)
    expect(lab.calls.warnings).toEqual(["Sound bip-bop-01 did not play: no sound device could be opened (Audio start failed: -5)"])
  })

  test("--desktop shows events that ask for a notification, with their title and message", async () => {
    const lab = setup({ desktop: true })
    expect(await lab.player.handle(event(), lab.fetch)).toEqual({ sound: "played", desktop: "shown" })
    expect(await lab.player.handle(event({ notify: false, sound: undefined }), lab.fetch)).toEqual({
      sound: "none",
      desktop: "off",
    })
    expect(lab.calls.notified).toEqual([{ title: "Fix the login", message: "Done" }])
  })

  test("without --desktop nothing is shown, whatever the event asks", async () => {
    const lab = setup()
    expect((await lab.player.handle(event({ notify: true }), lab.fetch)).desktop).toBe("off")
    expect(lab.calls.notified).toEqual([])
  })

  test("a failing notifier warns once and the sound still plays", async () => {
    const lab = setup({ desktop: true, failNotify: "notify-send exited with 1" })
    expect(await lab.player.handle(event(), lab.fetch)).toEqual({
      sound: "played",
      desktop: "failed",
      reason: "notify-send exited with 1",
    })
    lab.next()
    await lab.player.handle(event(), lab.fetch)
    expect(lab.calls.warnings).toEqual(["Desktop notification failed: notify-send exited with 1"])
  })
})

describe("notify desktop command", () => {
  test("macOS passes the text as script arguments, never as AppleScript", () => {
    const command = desktopCommand("darwin", 'Say "hi"', 'Done" & do shell script "rm -rf ~')
    expect(command.slice(0, 7)).toEqual([
      "osascript",
      "-e",
      "on run argv",
      "-e",
      "display notification (item 2 of argv) with title (item 1 of argv)",
      "-e",
      "end run",
    ])
    expect(command.slice(7)).toEqual(['Say "hi"', 'Done" & do shell script "rm -rf ~'])
  })

  test("Linux uses notify-send with the body's markup characters escaped", () => {
    expect(desktopCommand("linux", "-title", "a <b> & c")).toEqual([
      "notify-send",
      "--app-name=OpenCodePlus",
      "--",
      "-title",
      "a &lt;b&gt; &amp; c",
    ])
  })
})
