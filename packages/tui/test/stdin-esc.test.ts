import { expect, test } from "bun:test"
import { createCliRenderer, StdinParser } from "@opentui/core"
import { ManualClock } from "@opentui/core/testing"
import { Readable, Writable } from "node:stream"

// Red-test for the lone-ESC stdin parser ambiguity ("Cause 1") in the
// unmodified @opentui/core 0.5.10 bundled parser
// (node_modules/.bun/@opentui+core@0.5.10+*/node_modules/@opentui/core/chunk-bun-9gqvxy8c.js).
// A bare Escape is the single byte 0x1b, which is also the first byte of every
// arrow/function/mouse sequence. The parser holds a lone 0x1b pending and only
// emits `escape` when a 20 ms timer fires (DEFAULT_TIMEOUT_MS = 20), so bytes
// arriving inside the window turn the ESC into a sequence prefix, and a `[`
// arriving just after the flush lands in the `justFlushedEsc` / `esc_recovery`
// path instead of being delivered as text. Cases 1 and 2 below are expected
// to FAIL on the unmodified base; case 3 is the regression guard.
function drainKeyNames(parser: StdinParser, names: string[]) {
  parser.drain((event) => {
    if (event.type === "key") names.push(event.key.name)
  })
}

function setup(useKittyKeyboard: boolean, protocolContext?: { kittyKeyboardEnabled: boolean }) {
  const clock = new ManualClock()
  const names: string[] = []
  const parser = new StdinParser({
    timeoutMs: 20,
    armTimeouts: true,
    useKittyKeyboard,
    ...(protocolContext === undefined ? {} : { protocolContext }),
    clock,
    onTimeoutFlush: () => {
      drainKeyNames(parser, names)
    },
  })
  return { clock, names, parser }
}

// Production parity (`packages/tui/src/app.tsx`): 50 ms ESC timeout, kitty
// parsing ON, armed timeouts, and the REAL clock. Nothing here calls
// `flushTimeout()` or advances a manual clock by hand: the lone ESC must
// arrive via the armed real timer, or the test fails.
function setupRealClock(useKittyKeyboard: boolean, timeoutMs = 50) {
  const names: string[] = []
  const parser = new StdinParser({
    timeoutMs,
    armTimeouts: true,
    useKittyKeyboard,
    onTimeoutFlush: () => {
      drainKeyNames(parser, names)
    },
  })
  return { names, parser }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test("lone ESC flushes on the real timer with kitty parsing on", async () => {
  const { names, parser } = setupRealClock(true)
  try {
    parser.push(new Uint8Array([0x1b]))
    drainKeyNames(parser, names)
    await sleep(150)
    drainKeyNames(parser, names)
    expect(names).toEqual(["escape"])
  } finally {
    parser.destroy()
  }
})

test("lone ESC pending across pause/resume still flushes on the real timer", async () => {
  const { names, parser } = setupRealClock(true)
  try {
    parser.push(new Uint8Array([0x1b]))
    drainKeyNames(parser, names)
    parser.pausePendingTimeout()
    parser.resumePendingTimeout()
    await sleep(150)
    drainKeyNames(parser, names)
    expect(names).toEqual(["escape"])
  } finally {
    parser.destroy()
  }
})

test("pixel reply completing across pause/resume still lets a later lone ESC flush", async () => {
  const names: string[] = []
  const parser = new StdinParser({
    timeoutMs: 50,
    armTimeouts: true,
    useKittyKeyboard: true,
    protocolContext: { pixelResolutionQueryActive: true },
    onTimeoutFlush: () => {
      drainKeyNames(parser, names)
    },
  })
  try {
    // Partial pixel-resolution reply: the production entry condition for
    // pausePendingTimeout() on the renderer's suspend/resume paths.
    parser.push(new Uint8Array([0x1b, 0x5b, 0x34, 0x3b, 0x31]))
    drainKeyNames(parser, names)
    expect(parser.hasPendingPixelResolutionResponse()).toBe(true)
    expect(names).toEqual([])
    parser.pausePendingTimeout()
    // The reply completes while paused, then the user taps ESC: at resume
    // the pixel response is gone but the lone ESC is still pending.
    parser.push(new Uint8Array([0x3b, 0x32, 0x30, 0x30, 0x74]))
    drainKeyNames(parser, names)
    parser.push(new Uint8Array([0x1b]))
    drainKeyNames(parser, names)
    expect(names).toEqual([])
    parser.resumePendingTimeout()
    await sleep(150)
    drainKeyNames(parser, names)
    expect(names).toEqual(["escape"])
  } finally {
    parser.destroy()
  }
})

test("lone ESC flushes on the real timer while a pixel query is active", async () => {
  const names: string[] = []
  const parser = new StdinParser({
    timeoutMs: 50,
    armTimeouts: true,
    useKittyKeyboard: true,
    protocolContext: { pixelResolutionQueryActive: true },
    onTimeoutFlush: () => {
      drainKeyNames(parser, names)
    },
  })
  try {
    parser.push(new Uint8Array([0x1b]))
    drainKeyNames(parser, names)
    await sleep(150)
    drainKeyNames(parser, names)
    expect(names).toEqual(["escape"])
  } finally {
    parser.destroy()
  }
})

test("incomplete pixel prefix stays paused across resume instead of flushing", async () => {
  const names: string[] = []
  const parser = new StdinParser({
    timeoutMs: 50,
    armTimeouts: true,
    useKittyKeyboard: true,
    protocolContext: { pixelResolutionQueryActive: true },
    onTimeoutFlush: () => {
      drainKeyNames(parser, names)
    },
  })
  try {
    parser.push(new Uint8Array([0x1b, 0x5b, 0x34, 0x3b, 0x31]))
    drainKeyNames(parser, names)
    expect(parser.hasPendingPixelResolutionResponse()).toBe(true)
    parser.pausePendingTimeout()
    parser.resumePendingTimeout()
    await sleep(150)
    drainKeyNames(parser, names)
    expect(names).toEqual([])
    expect(parser.hasPendingPixelResolutionResponse()).toBe(true)
  } finally {
    parser.destroy()
  }
})

test("lone ESC inside the 20 ms window is swallowed by a following arrow", () => {
  const { clock, names, parser } = setup(false)
  try {
    parser.push(new Uint8Array([0x1b]))
    drainKeyNames(parser, names)
    clock.advance(10)
    parser.push(new Uint8Array([0x1b, 0x5b, 0x41]))
    drainKeyNames(parser, names)
    clock.advance(40)
    parser.flushTimeout()
    drainKeyNames(parser, names)
    expect(names).toEqual(["escape", "up"])
  } finally {
    parser.destroy()
  }
})

test("bracket arriving after the ESC flush is held by esc_recovery", () => {
  const { clock, names, parser } = setup(false)
  try {
    parser.push(new Uint8Array([0x1b]))
    drainKeyNames(parser, names)
    clock.advance(25)
    parser.flushTimeout()
    drainKeyNames(parser, names)
    parser.push(new Uint8Array([0x5b]))
    drainKeyNames(parser, names)
    expect(names).toEqual(["escape", "["])
  } finally {
    parser.destroy()
  }
})

test("kitty CSI 27 u emits escape immediately", () => {
  const { names, parser } = setup(true)
  try {
    parser.push(new Uint8Array([0x1b, 0x5b, 0x32, 0x37, 0x75]))
    drainKeyNames(parser, names)
    expect(names).toEqual(["escape"])
  } finally {
    parser.destroy()
  }
})

// Contract from upstream anomalyco/opentui issue #818 (closed by PR #819):
// a split escape sequence must not flush as lone ESC plus text.
test("split arrow arrives as one up, never escape plus text", () => {
  const { clock, names, parser } = setup(false)
  try {
    parser.push(new Uint8Array([0x1b]))
    drainKeyNames(parser, names)
    clock.advance(2)
    parser.push(new Uint8Array([0x5b, 0x41]))
    drainKeyNames(parser, names)
    clock.advance(60)
    parser.flushTimeout()
    drainKeyNames(parser, names)
    expect(names).toEqual(["up"])
  } finally {
    parser.destroy()
  }
})

// Contract from upstream anomalyco/opentui issue #818 (closed by PR #819):
// a split CSI-u sequence must reassemble into one kitty event.
test("split CSI-u arrives as one kitty event", () => {
  const { clock, names, parser } = setup(true, { kittyKeyboardEnabled: true })
  try {
    parser.push(new Uint8Array([0x1b, 0x5b, 0x31, 0x31, 0x38]))
    drainKeyNames(parser, names)
    clock.advance(2)
    parser.push(new Uint8Array([0x3b, 0x35, 0x75]))
    drainKeyNames(parser, names)
    clock.advance(60)
    parser.flushTimeout()
    drainKeyNames(parser, names)
    expect(names).toHaveLength(1)
    expect(names[0]!.length).toBeGreaterThan(0)
  } finally {
    parser.destroy()
  }
})

// ---------------------------------------------------------------------------
// Renderer-level contract (F5.4). The parser above is only ever as correct as
// the mode the renderer constructs it in. opentui pushes the kitty keyboard
// protocol at the terminal from the native side: `setupTerminal()` writes the
// kitty query `CSI ? u` inside its capability block, and when any answer comes
// back it replies by pushing kitty on (`CSI > <flags> u`, measured: flags 5).
// The answer reports the flags in effect BEFORE that push, so a freshly opened
// kitty-capable terminal answers `CSI ? 0 u` — a positive capability signal
// with a zero payload. A parser that reads the zero as "no kitty" and drops to
// legacy while the terminal has just been switched to kitty decodes every
// keypress (`CSI <code>;<mods> u`) into a key with an EMPTY name, no keybinding
// matches, and the TUI takes no keyboard input at all — not even ctrl+c.
// Rule: parse in the protocol that was pushed; downgrade only on a refusal or
// a query timeout, and clear the pushed flags when downgrading.
class FakeTerminal extends Writable {
  isTTY = true
  columns = 80
  rows = 24
  output = ""
  override _write(chunk: Buffer | string, _encoding: BufferEncoding, done: (error?: Error | null) => void) {
    this.output += Buffer.isBuffer(chunk) ? chunk.toString("latin1") : chunk
    done()
  }
  getColorDepth() {
    return 24
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 15))

// The renderer options are the ones packages/tui/src/app.tsx passes to
// createCliRenderer, with the two streams and the clock injected so the test
// can drive the terminal side. Nothing here reaches into the parser: the
// renderer constructs it exactly as it does in production.
async function startRenderer() {
  const clock = new ManualClock()
  const stdin = new Readable({ read() {} })
  const terminal = new FakeTerminal()
  const renderer = await createCliRenderer({
    externalOutputMode: "passthrough",
    targetFps: 60,
    gatherStats: false,
    exitOnCtrlC: false,
    useKittyKeyboard: {},
    stdinParserEscTimeoutMs: 50,
    autoFocus: false,
    openConsoleOnError: false,
    useMouse: false,
    consoleMode: "disabled",
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: terminal as unknown as NodeJS.WriteStream,
    clock,
  })
  const keys: string[] = []
  renderer.keyInput.on("keypress", (key) => keys.push(`${key.name}${key.ctrl ? "+ctrl" : ""}`))
  return {
    renderer,
    keys,
    terminal,
    async feed(bytes: number[] | string) {
      stdin.push(typeof bytes === "string" ? Buffer.from(bytes, "latin1") : Buffer.from(bytes))
      await settle()
    },
    async advance(ms: number) {
      clock.advance(ms)
      await settle()
    },
  }
}

test("kitty answered: the renderer that pushed kitty decodes CSI-u keys", async () => {
  const { renderer, keys, terminal, feed } = await startRenderer()
  try {
    terminal.output = ""
    await feed("\x1b[?0u")
    expect(terminal.output).toMatch(/\x1b\[>\d+u/)
    await feed([0x1b, 0x5b, 0x39, 0x39, 0x3b, 0x35, 0x75])
    await feed([0x1b, 0x5b, 0x32, 0x37, 0x75])
    await feed([0x1b, 0x5b, 0x39, 0x37, 0x75])
    expect(keys).toEqual(["c+ctrl", "escape", "a"])
  } finally {
    renderer.destroy()
  }
})

test("kitty query unanswered: CSI-u keys decode until the 300 ms downgrade, legacy after it", async () => {
  const { renderer, keys, terminal, feed, advance } = await startRenderer()
  try {
    await feed([0x1b, 0x5b, 0x39, 0x39, 0x3b, 0x35, 0x75])
    expect(keys).toEqual(["c+ctrl"])
    // Parsing kitty while the terminal is still legacy costs nothing: legacy
    // bytes decode either way. That asymmetry is why the downgrade may lag the
    // answer but the upgrade may never lag the push.
    keys.length = 0
    await feed([0x1b, 0x5b, 0x41])
    expect(keys).toEqual(["up"])
    keys.length = 0
    terminal.output = ""
    await advance(300)
    expect(terminal.output).not.toMatch(/\x1b\[>\d+u/)
    keys.length = 0
    await feed([0x03])
    expect(keys).toEqual(["c+ctrl"])
    keys.length = 0
    await feed([0x1b])
    await advance(30)
    expect(keys).toEqual([])
    await advance(30)
    expect(keys).toEqual(["escape"])
  } finally {
    renderer.destroy()
  }
})

test("a kitty answer after the downgrade re-pushes kitty, so parsing follows it back up", async () => {
  const { renderer, keys, terminal, feed, advance } = await startRenderer()
  try {
    await advance(300)
    terminal.output = ""
    await feed("\x1b[?0u")
    expect(terminal.output).toMatch(/\x1b\[>\d+u/)
    await feed([0x1b, 0x5b, 0x39, 0x39, 0x3b, 0x35, 0x75])
    expect(keys).toEqual(["c+ctrl"])
  } finally {
    renderer.destroy()
  }
})

// ---------------------------------------------------------------------------
// Legacy tolerant reader for the kitty Escape encoding. A terminal left in
// kitty mode while the parser downgraded to legacy (the 300 ms query timeout
// fired, but the pushed flags were never popped) keeps sending `CSI 27 u`.
// Legacy parsing must still decode that Escape subset — and nothing else of
// the CSI-u space — with press and repeat delivering an escape and release
// delivering nothing, matching kitty mode. `CSI 27 u` has no legacy meaning,
// so decoding it cannot regress legacy terminals.
test("legacy decodes kitty CSI 27 u as one escape", () => {
  const { names, parser } = setup(false)
  try {
    parser.push(new Uint8Array([0x1b, 0x5b, 0x32, 0x37, 0x75]))
    drainKeyNames(parser, names)
    expect(names).toEqual(["escape"])
  } finally {
    parser.destroy()
  }
})

test("legacy decodes back-to-back kitty CSI 27 u as one escape each", () => {
  const { names, parser } = setup(false)
  try {
    parser.push(
      new Uint8Array([0x1b, 0x5b, 0x32, 0x37, 0x75, 0x1b, 0x5b, 0x32, 0x37, 0x75]),
    )
    drainKeyNames(parser, names)
    expect(names).toEqual(["escape", "escape"])
  } finally {
    parser.destroy()
  }
})

test("legacy decodes kitty escape with modifiers present as escape", () => {
  const { names, parser } = setup(false)
  try {
    // CSI 27 ; 5 u — ctrl modifier, press.
    parser.push(new Uint8Array([0x1b, 0x5b, 0x32, 0x37, 0x3b, 0x35, 0x75]))
    drainKeyNames(parser, names)
    expect(names).toEqual(["escape"])
  } finally {
    parser.destroy()
  }
})

test("legacy delivers kitty escape press (:1) as escape", () => {
  const { names, parser } = setup(false)
  try {
    parser.push(new Uint8Array([0x1b, 0x5b, 0x32, 0x37, 0x3b, 0x31, 0x3a, 0x31, 0x75]))
    drainKeyNames(parser, names)
    expect(names).toEqual(["escape"])
  } finally {
    parser.destroy()
  }
})

test("legacy delivers kitty escape repeat (:2) as escape", () => {
  const { names, parser } = setup(false)
  try {
    parser.push(new Uint8Array([0x1b, 0x5b, 0x32, 0x37, 0x3b, 0x31, 0x3a, 0x32, 0x75]))
    drainKeyNames(parser, names)
    expect(names).toEqual(["escape"])
  } finally {
    parser.destroy()
  }
})

test("legacy ignores kitty escape release (:3)", () => {
  const { names, parser } = setup(false)
  try {
    parser.push(new Uint8Array([0x1b, 0x5b, 0x32, 0x37, 0x3b, 0x31, 0x3a, 0x33, 0x75]))
    drainKeyNames(parser, names)
    expect(names).toEqual([])
  } finally {
    parser.destroy()
  }
})

// Narrowness guard: the legacy safety net decodes Escape only. A non-Escape
// CSI-u sequence must keep its pre-existing legacy behaviour (an unnamed
// legacy fallthrough, never a named key), while kitty parsing still decodes
// the same bytes — proving the input is real kitty traffic that legacy
// deliberately leaves alone rather than a general legacy CSI-u decoder.
test("legacy leaves non-escape CSI-u undecided while kitty decodes it", () => {
  // CSI 99 ; 5 u — ctrl+c in the kitty encoding.
  const bytes = new Uint8Array([0x1b, 0x5b, 0x39, 0x39, 0x3b, 0x35, 0x75])
  const legacy = setup(false)
  try {
    legacy.parser.push(bytes)
    drainKeyNames(legacy.parser, legacy.names)
    expect(legacy.names).toEqual([""])
  } finally {
    legacy.parser.destroy()
  }
  const kitty = setup(true)
  try {
    kitty.parser.push(bytes)
    drainKeyNames(kitty.parser, kitty.names)
    expect(kitty.names).toEqual(["c"])
  } finally {
    kitty.parser.destroy()
  }
})
