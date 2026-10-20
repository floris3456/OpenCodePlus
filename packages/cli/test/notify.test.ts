import { describe, expect, test } from "bun:test"
import type { Plus } from "../../plus/src/rpc.js"
import { DEFAULT_VOLUME, notifyInvocation, notifyUsage, parseNotifyArgs } from "../src/commands/handlers/notify"
import {
  nextReconnect,
  parseRemoteService,
  RECONNECT_MAX_MS,
  sshReadCommand,
  sshTunnelCommand,
  STABLE_MS,
} from "../src/services/notify-connection"
import { createPlayer, createSoundGate, desktopCommand, SOUND_GAP_MS, type Speaker } from "../src/services/notify-player"

describe("notify arguments", () => {
  test("defaults: this machine's service, volume 0.5, nothing else", () => {
    expect(parseNotifyArgs([])).toEqual({
      kind: "run",
      options: { volume: DEFAULT_VOLUME, desktop: false, once: false, verbose: false },
    })
  })

  test("an ssh target and every option", () => {
    expect(parseNotifyArgs(["me@box", "--volume", "0.2", "--desktop", "--test", "error", "--once", "--verbose"])).toEqual({
      kind: "run",
      options: { target: "me@box", volume: 0.2, desktop: true, test: "error", once: true, verbose: true },
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

describe("notify remote service.json", () => {
  const answer = (json: string, extra: { readonly code?: number; readonly stderr?: string; readonly before?: string } = {}) => ({
    stdout: `${extra.before ?? ""}opencodeplus-service-json\n${json}`,
    stderr: extra.stderr ?? "",
    code: extra.code ?? 0,
  })

  test("address and password, skipping whatever a shell startup file printed first", () => {
    expect(
      parseRemoteService("box", answer('{ "hostname": "127.0.0.1", "port": 40375, "password": "secret" }', { before: "Welcome!\n" })),
    ).toEqual({ host: "127.0.0.1", port: 40375, password: "secret" })
  })

  test("missing fields fall back to what the service itself defaults to", () => {
    expect(parseRemoteService("box", answer("{}"))).toEqual({ host: "127.0.0.1", port: 0xc0de })
  })

  test("a service on every address is reached through loopback; other hosts are kept", () => {
    expect(parseRemoteService("box", answer('{ "hostname": "0.0.0.0", "port": 1 }'))).toEqual({ host: "127.0.0.1", port: 1 })
    expect(parseRemoteService("box", answer('{ "hostname": "::", "port": 1 }'))).toEqual({ host: "127.0.0.1", port: 1 })
    expect(parseRemoteService("box", answer('{ "hostname": "::1", "port": 1 }'))).toEqual({ host: "::1", port: 1 })
    expect(parseRemoteService("box", answer('{ "hostname": "10.0.0.5", "port": 1 }'))).toEqual({ host: "10.0.0.5", port: 1 })
  })

  test("failures say what went wrong and never echo the file", () => {
    const error = (read: { stdout: string; stderr: string; code: number }) => {
      const parsed = parseRemoteService("box", read)
      return "error" in parsed ? parsed.error : "parsed"
    }
    expect(error({ stdout: "", stderr: "ssh: connect to host box port 22: Connection refused\n", code: 255 })).toBe(
      "ssh box failed: ssh: connect to host box port 22: Connection refused",
    )
    expect(error({ stdout: "", stderr: "", code: 255 })).toBe("ssh box failed (exit 255)")
    expect(error(answer("", { code: 1, stderr: "cat: /home/me/.config/opencodeplus/service.json: No such file or directory" }))).toContain(
      "box has no OpenCodePlus service config",
    )
    expect(error(answer('{ "password": "secret", '))).toBe(
      "the service config on box (~/.config/opencodeplus/service.json) is not valid",
    )
    expect(error(answer('{ "port": 70000, "password": "secret" }'))).toContain("is not valid")
    expect(error(answer('{ "disabled": true }'))).toContain("the service on box is turned off")
  })
})

describe("notify ssh commands", () => {
  test("the read runs sh on the remote side and keeps the target from being taken as an option", () => {
    const command = sshReadCommand("me@box")
    expect(command.slice(0, -2)).toEqual(["ssh", "-T", "-o", "ConnectTimeout=20", "--"])
    expect(command.at(-2)).toBe("me@box")
    expect(command.at(-1)).toBe(`sh -c 'echo opencodeplus-service-json; cat "\${XDG_CONFIG_HOME:-$HOME/.config}/opencodeplus/service.json"'`)
    expect(command.join(" ")).not.toContain("BatchMode")
  })

  test("the tunnel forwards a loopback port, dies with its connection, and carries no password", () => {
    expect(sshTunnelCommand("box", 51234, "127.0.0.1", 40375)).toEqual([
      "ssh",
      "-N",
      "-T",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      "-o",
      "ConnectTimeout=20",
      "-o",
      "ControlPath=none",
      "-L",
      "127.0.0.1:51234:127.0.0.1:40375",
      "--",
      "box",
    ])
    expect(sshTunnelCommand("box", 1, "::1", 2)).toContain("127.0.0.1:1:[::1]:2")
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
