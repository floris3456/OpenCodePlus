import { expect, test } from "bun:test"
import { StdinParser } from "@opentui/core"
import { ManualClock } from "@opentui/core/testing"

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
