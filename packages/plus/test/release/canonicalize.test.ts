import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  CANONICALIZER,
  CANONICAL_BUNDLER_KEY,
  canonicalizeBuildOutput,
  compareRebuild,
  deriveRecordHash,
  parseBuildStructure,
  type BuildStructure,
} from "../../script/release/canonicalize.js"

const BUN = CANONICALIZER.bunVersion

const KEY_A = "a1b2c3d4e5f60718"
const KEY_B = "b0b0b0b0b0b0b0b0"
const FILLER_3 = "3333333333333333"

/**
 * The exact fixture the previous, unanchored implementation accepted: a plain
 * 320-byte buffer that is not an executable at all, holding two record-shaped
 * blobs. It must now be rejected before any record is considered.
 */
function legacyFillerBinary(key: string): Buffer {
  const binary = Buffer.alloc(320)
  for (let index = 0; index < binary.length; index += 1) binary[index] = (index * 31 + 7) & 0xff
  ;[64, 192].forEach((offset, position) => {
    const token = `${key}C${String(position).padStart(8, "0")}`
    binary.writeUInt32LE(0x80000019, offset)
    binary.writeUInt32LE(deriveRecordHash(token), offset + 4)
    binary.write(token, offset + 8, 25, "latin1")
    binary.fill(0, offset + 33, offset + 36)
  })
  return binary
}

const scratch = mkdtempSync(join(tmpdir(), "ocp-canonicalize-"))
const SOURCE_DIR = join(scratch, "src")
const ENTRY = join(SOURCE_DIR, "entry.ts")
const OUT_LEFT = join(scratch, "left")
const OUT_RIGHT = join(scratch, "right")
const OUT_DARWIN = join(scratch, "darwin")

interface RealBuilds {
  readonly left: Buffer
  readonly right: Buffer
  readonly darwin: Buffer
}

let builds: RealBuilds
let leftStructure: BuildStructure

beforeAll(() => {
  mkdirSync(SOURCE_DIR, { recursive: true })
  writeFileSync(join(SOURCE_DIR, "shared-one.ts"), "export const sharedOne = 11\n")
  writeFileSync(join(SOURCE_DIR, "shared-two.ts"), "export const sharedTwo = 22\n")
  writeFileSync(
    join(SOURCE_DIR, "alpha.ts"),
    "import { sharedOne } from './shared-one.ts'\nimport { sharedTwo } from './shared-two.ts'\nexport const alpha = sharedOne + sharedTwo + 1\nexport { sharedOne, sharedTwo }\n",
  )
  writeFileSync(
    join(SOURCE_DIR, "beta.ts"),
    "import { sharedOne } from './shared-one.ts'\nimport { sharedTwo } from './shared-two.ts'\nexport const beta = sharedOne + sharedTwo + 2\nexport { sharedOne, sharedTwo }\n",
  )
  writeFileSync(
    ENTRY,
    "async function main() {\n  const [alpha, beta] = await Promise.all([import('./alpha.ts'), import('./beta.ts')])\n  console.log(alpha.alpha, beta.beta)\n}\nmain()\n",
  )

  // Both rebuilds use the same output basename so the only difference Bun is
  // allowed to introduce is the per-build bundler key.
  builds = {
    left: compile(OUT_LEFT),
    right: compile(OUT_RIGHT),
    darwin: compile(OUT_DARWIN, { target: "bun-darwin-arm64" }),
  }

  const parsed = parseBuildStructure({ bunVersion: BUN, bytes: builds.left })
  if (!parsed.ok) throw new Error(`fixture failed to parse: ${parsed.rejection.detail}`)
  leftStructure = parsed.structure
}, 120000)

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function compile(outDir: string, options: { target?: string; bytecode?: boolean } = {}): Buffer {
  mkdirSync(outDir, { recursive: true })
  const outfile = join(outDir, "app")
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "build",
      ENTRY,
      "--compile",
      ...(options.bytecode === false ? [] : ["--bytecode"]),
      "--format=esm",
      "--splitting",
      ...(options.target ? [`--target=${options.target}`] : []),
      "--outfile",
      outfile,
    ],
    cwd: SOURCE_DIR,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  })
  if (result.exitCode !== 0) {
    throw new Error(`bun build --compile failed for ${outfile}: ${result.stderr.toString()}`)
  }
  return readFileSync(outfile)
}

function normalizedSpans(structure: BuildStructure): Set<number> {
  const spans = new Set<number>()
  for (const entry of structure.entries) {
    if (entry.length !== 25) continue
    if (!/^[0-9a-f]{16}[ACSH][0-9]{8}$/.test(entry.text)) continue
    if (entry.text.startsWith(FILLER_3)) continue
    for (let index = 0; index < 16; index += 1) spans.add(entry.offset + 8 + index)
    for (let index = 0; index < 4; index += 1) spans.add(entry.offset + 4 + index)
  }
  return spans
}

// ---------------------------------------------------------------------------

describe("chunk record hash derivation is frozen", () => {
  test("reproduces hashes measured against real Bun 1.4.2 output", () => {
    expect(deriveRecordHash("0000000000000000C00000000")).toBe(3444399)
    expect(deriveRecordHash("0000000000000000C00000001")).toBe(3503819)
    expect(deriveRecordHash("0000000000000000C00000003")).toBe(4884440)
    expect(deriveRecordHash("a1b2c3d4e5f60718C00000000")).toBe(6003058)
    expect(deriveRecordHash("a1b2c3d4e5f60718C00000001")).toBe(2262727)
    expect(deriveRecordHash("a1b2c3d4e5f60718C00000003")).toBe(13872871)
    expect(deriveRecordHash("3333333333333333C00000002")).toBe(7364482)
    expect(deriveRecordHash("7777777777777777C00000004")).toBe(5492551)
    expect(deriveRecordHash("b0b0b0b0b0b0b0b0C00000001")).toBe(1708673)
  })

  test("is exactly rapidhash masked to 24 bits", () => {
    for (let index = 0; index < 64; index += 1) {
      const token = `${KEY_A}C${String(index).padStart(8, "0")}`
      const expected = Number(Bun.hash.rapidhash(Buffer.from(token, "latin1")) & 0xffffffn)
      expect(deriveRecordHash(token)).toBe(expected)
      expect(deriveRecordHash(token) >>> 24).toBe(0)
    }
  })
})

describe("version pinning", () => {
  test("declares the Bun version it was measured against", () => {
    expect(CANONICALIZER.bunVersion).toBe("1.4.2")
    expect(CANONICALIZER.scope).toBe("rebuild-equivalence-only")
    expect(CANONICALIZER.strength).toBe("weaker-than-raw-binary-reproducibility")
  })

  test("refuses an unsupported toolchain instead of guessing", () => {
    const outcome = canonicalizeBuildOutput({ bunVersion: "1.4.3", bytes: builds.left })
    if (outcome.ok) throw new Error("expected an unsupported-toolchain rejection")
    expect(outcome.rejection.code).toBe("unsupported-toolchain")

    const comparison = compareRebuild({
      bunVersion: "1.5.0",
      left: builds.left,
      right: builds.right,
    })
    if (comparison.equivalent) throw new Error("expected an unsupported-toolchain rejection")
    expect(comparison.rejection.code).toBe("unsupported-toolchain")
  })
})

describe("container anchoring", () => {
  test("rejects the non-executable filler buffer the old scan accepted", () => {
    const left = legacyFillerBinary(KEY_A)
    const right = legacyFillerBinary(KEY_B)

    const outcome = canonicalizeBuildOutput({ bunVersion: BUN, bytes: left })
    if (outcome.ok) throw new Error("expected the filler buffer to be rejected")
    expect(outcome.rejection.code).toBe("unsupported-executable-format")

    const comparison = compareRebuild({ bunVersion: BUN, left, right })
    if (comparison.equivalent) throw new Error("expected the filler pair to be rejected")
    expect(comparison.rejection.code).toBe("unsupported-executable-format")
  })

  test("parses a real ELF build and anchors every record in the parsed string table", () => {
    const outcome = canonicalizeBuildOutput({ bunVersion: BUN, bytes: builds.left })
    if (!outcome.ok) throw new Error(`unexpected rejection: ${outcome.rejection.detail}`)
    expect(outcome.container).toBe("elf")
    expect(outcome.entriesParsed).toBeGreaterThan(0)
    expect(outcome.records.length).toBeGreaterThanOrEqual(1)
    expect(outcome.stringTableStart).toBe(leftStructure.stringTableStart)
    expect(outcome.stringTableLength).toBe(leftStructure.stringTableLength)

    const tableEnd = leftStructure.stringTableStart + leftStructure.stringTableLength
    for (const record of outcome.records) {
      const entry = leftStructure.entries.find((item) => item.offset === record.offset)
      if (!entry) throw new Error(`record ${record.token} is not a parsed string-table entry`)
      expect(entry.length).toBe(25)
      expect(entry.text).toBe(record.token)
      expect(entry.storedHash).toBe(deriveRecordHash(entry.text))
      expect(record.offset).toBeGreaterThanOrEqual(leftStructure.stringTableStart)
      expect(record.offset).toBeLessThan(tableEnd)
      for (const range of leftStructure.moduleRanges) {
        expect(record.offset < range.start || record.offset >= range.end).toBe(true)
      }
    }

    // The table itself may not overlap any module-owned subrange.
    for (const range of leftStructure.moduleRanges) {
      expect(tableEnd <= range.start || range.end <= leftStructure.stringTableStart).toBe(true)
    }
    expect(leftStructure.stringTableStart).toBeGreaterThanOrEqual(leftStructure.payloadStart)
    expect(tableEnd).toBeLessThanOrEqual(leftStructure.payloadStart + leftStructure.graphLength)
  })

  test("a real build without --bytecode has no anchored record table and is refused", () => {
    const noBytecode = compile(join(scratch, "no-bytecode"), { bytecode: false })
    const outcome = canonicalizeBuildOutput({ bunVersion: BUN, bytes: noBytecode })
    if (outcome.ok) throw new Error("expected a bundler-key-missing rejection")
    expect(outcome.rejection.code).toBe("bundler-key-missing")
  })

  test("parses a real Mach-O build (darwin arm64) and reports raw identity against itself", () => {
    const parsed = parseBuildStructure({ bunVersion: BUN, bytes: builds.darwin })
    if (!parsed.ok) throw new Error(`unexpected rejection: ${parsed.rejection.detail}`)
    expect(parsed.structure.container).toBe("macho")

    const outcome = canonicalizeBuildOutput({ bunVersion: BUN, bytes: builds.darwin })
    if (!outcome.ok) throw new Error(`unexpected rejection: ${outcome.rejection.detail}`)
    expect(outcome.records.length).toBeGreaterThanOrEqual(1)

    const comparison = compareRebuild({
      bunVersion: BUN,
      left: builds.darwin,
      right: builds.darwin,
    })
    if (!comparison.equivalent) throw new Error(`unexpected rejection: ${comparison.rejection.detail}`)
    expect(comparison.container).toBe("macho")
    expect(comparison.rawIdentical).toBe(true)
    expect(comparison.rawDifferingBytes).toBe(0)
  })
})

describe("rebuild equivalence (positive, real builds)", () => {
  test("two independent builds differ only inside the normalized spans", () => {
    const left = builds.left
    const right = builds.right
    expect(left.equals(right)).toBe(false)

    const comparison = compareRebuild({ bunVersion: BUN, left, right })
    if (!comparison.equivalent) throw new Error(`unexpected rejection: ${comparison.rejection.detail}`)

    expect(comparison.container).toBe("elf")
    expect(comparison.rawIdentical).toBe(false)
    expect(comparison.rawDifferingBytes).toBeGreaterThan(0)
    expect(comparison.rawDifferingBytes).toBeLessThanOrEqual(comparison.recordsRewritten * 20)
    expect(comparison.recordsRewritten).toBeGreaterThanOrEqual(1)
    expect(comparison.bundlerKeys.left).not.toBe(comparison.bundlerKeys.right)

    // Every raw difference between two real rebuilds must lie inside a span the
    // canonicalizer is allowed to normalize; nothing else may move.
    const spans = normalizedSpans(leftStructure)
    for (let index = 0; index < left.byteLength; index += 1) {
      if (left[index] !== right[index]) expect(spans.has(index)).toBe(true)
    }
  })

  test("identical rebuilds report raw identity, not just equivalence", () => {
    const comparison = compareRebuild({
      bunVersion: BUN,
      left: builds.left,
      right: builds.left,
    })
    if (!comparison.equivalent) throw new Error(`unexpected rejection: ${comparison.rejection.detail}`)
    expect(comparison.rawIdentical).toBe(true)
    expect(comparison.rawDifferingBytes).toBe(0)
  })

  test("rewrites only the key field and the hash word of keyed records", () => {
    const raw = builds.left
    const outcome = canonicalizeBuildOutput({ bunVersion: BUN, bytes: raw })
    if (!outcome.ok) throw new Error(`unexpected rejection: ${outcome.rejection.detail}`)

    const changed = new Set<number>()
    for (let index = 0; index < raw.length; index += 1) {
      if (raw[index] !== outcome.canonical[index]) changed.add(index)
    }

    const expected = new Set<number>()
    for (const record of outcome.records) {
      if (!record.bearsBundlerKey) continue
      const canonicalToken = `${CANONICAL_BUNDLER_KEY}${record.token.slice(16)}`
      expect(
        outcome.canonical.toString("latin1", record.offset + 8, record.offset + 33),
      ).toBe(canonicalToken)
      expect(outcome.canonical.readUInt32LE(record.offset + 4)).toBe(deriveRecordHash(canonicalToken))
      for (let index = 0; index < 4; index += 1) expected.add(record.offset + 4 + index)
      for (let index = 0; index < 16; index += 1) expected.add(record.offset + 8 + index)
    }

    for (const offset of changed) expect(expected.has(offset)).toBe(true)
    expect(changed.size).toBeLessThanOrEqual(outcome.recordsRewritten * 20)
  })
})

describe("adversarial: record-shaped data outside eligible structures", () => {
  /**
   * Pick a module-owned span that is large enough for a record-shaped blob and
   * is not the string table, then splice the blob from an actual record into it.
   * The blob is byte-for-byte what the canonicalizer normalizes elsewhere.
   */
  function injectRecordOutsideTable(binary: Buffer, key: string): number {
    const range = leftStructure.moduleRanges.find((item) => item.end - item.start >= 36)
    if (!range) throw new Error("fixture has no module subrange large enough for an injected record")
    const offset = range.start
    const token = `${key}C${String(4321).padStart(8, "0")}`
    binary.writeUInt32LE(0x80000019, offset)
    binary.writeUInt32LE(deriveRecordHash(token), offset + 4)
    binary.write(token, offset + 8, 25, "latin1")
    binary.fill(0, offset + 33, offset + 36)
    return offset
  }

  test("a record-shaped blob outside the string table is not parsed as a record", () => {
    const tampered = Buffer.from(builds.left)
    const injectedAt = injectRecordOutsideTable(tampered, KEY_B)

    const outcome = canonicalizeBuildOutput({ bunVersion: BUN, bytes: tampered })
    if (!outcome.ok) throw new Error(`unexpected rejection: ${outcome.rejection.detail}`)
    for (const record of outcome.records) expect(record.offset).not.toBe(injectedAt)
    expect(outcome.records.some((record) => record.offset === injectedAt)).toBe(false)
  })

  test("a foreign key outside the table is never normalized away", () => {
    const tampered = Buffer.from(builds.left)
    const injectedAt = injectRecordOutsideTable(tampered, KEY_B)
    const comparison = compareRebuild({ bunVersion: BUN, left: builds.left, right: tampered })
    if (comparison.equivalent) throw new Error("expected a residual-difference rejection")
    expect(comparison.rejection.code).toBe("residual-difference")
    expect(comparison.rejection.offset).toBe(injectedAt)
  })

  test("a tail pointer redirected at record-shaped data outside the table fails closed", () => {
    const binary = Buffer.from(builds.left)
    const injectedAt = injectRecordOutsideTable(binary, KEY_A)

    // ESM + bytecode tail: per-module values, sentinel, then the bytecode table
    // {offset,length}. Redirect that pointer at the injected blob.
    const tableOffsetField =
      leftStructure.modulesStart + leftStructure.modulesLength + leftStructure.moduleCount * 4 + 4
    const graphRelative = injectedAt - leftStructure.payloadStart
    const currentOffset = binary.readUInt32LE(tableOffsetField)
    expect(currentOffset).toBe(leftStructure.stringTableStart - leftStructure.payloadStart)
    binary.writeUInt32LE(graphRelative, tableOffsetField)

    const outcome = canonicalizeBuildOutput({ bunVersion: BUN, bytes: binary })
    if (outcome.ok) throw new Error("expected a locator/table rejection")
    expect(["string-table-locator-malformed", "string-table-malformed"]).toContain(
      outcome.rejection.code,
    )
  })

  test("a tampered table entry length word fails closed", () => {
    const binary = Buffer.from(builds.left)
    const entry = leftStructure.entries.find((item) => item.length === 25)
    if (!entry) throw new Error("fixture has no 25-byte string-table entry")
    binary.writeUInt32LE((0x80000000 | 24) >>> 0, entry.offset)

    const outcome = canonicalizeBuildOutput({ bunVersion: BUN, bytes: binary })
    if (outcome.ok) throw new Error("expected a rejection")
    expect(["record-hash-underived", "string-table-malformed"]).toContain(outcome.rejection.code)
  })

  test("a tampered table entry padding byte fails closed", () => {
    const binary = Buffer.from(builds.left)
    const entry = leftStructure.entries.find((item) => item.length === 25)
    if (!entry) throw new Error("fixture has no 25-byte string-table entry")
    binary[entry.offset + 8 + 25] = 0x5a

    const outcome = canonicalizeBuildOutput({ bunVersion: BUN, bytes: binary })
    if (outcome.ok) throw new Error("expected a string-table-malformed rejection")
    expect(outcome.rejection.code).toBe("string-table-malformed")
  })

  test("tampering with any parsed entry's hash fails closed even when it is not token-shaped", () => {
    const binary = Buffer.from(builds.left)
    const entry = leftStructure.entries.find((item) => item.length !== 25)
    if (!entry) throw new Error("fixture has no non-token string-table entry")
    binary.writeUInt32LE(binary.readUInt32LE(entry.offset + 4) ^ 0x01, entry.offset + 4)

    const outcome = canonicalizeBuildOutput({ bunVersion: BUN, bytes: binary })
    if (outcome.ok) throw new Error("expected a record-hash-underived rejection")
    expect(outcome.rejection.code).toBe("record-hash-underived")
    expect(outcome.rejection.offset).toBe(entry.offset)
  })
})

describe("tamper rejection", () => {
  test("rejects a changed code byte outside any record, reporting its offset", () => {
    const right = Buffer.from(builds.right)
    const range = leftStructure.moduleRanges.find((item) => item.end - item.start >= 8)
    if (!range) throw new Error("fixture has no module subrange to tamper with")
    const tamperAt = range.start + 4
    right[tamperAt] = right[tamperAt] ^ 0xff

    const comparison = compareRebuild({ bunVersion: BUN, left: builds.left, right })
    if (comparison.equivalent) throw new Error("expected a residual-difference rejection")
    expect(comparison.rejection.code).toBe("residual-difference")
    expect(comparison.rejection.offset).toBe(tamperAt)
  })

  test("rejects a forged hash word on one record", () => {
    const binary = Buffer.from(builds.left)
    const entry = leftStructure.entries.find((item) => item.length === 25)
    if (!entry) throw new Error("fixture has no 25-byte string-table entry")
    binary.writeUInt32LE(binary.readUInt32LE(entry.offset + 4) ^ 0x01, entry.offset + 4)

    const outcome = canonicalizeBuildOutput({ bunVersion: BUN, bytes: binary })
    if (outcome.ok) throw new Error("expected a record-hash-underived rejection")
    expect(outcome.rejection.code).toBe("record-hash-underived")
    expect(outcome.rejection.offset).toBe(entry.offset)
  })

  test("rejects a hash word with a non-zero top byte", () => {
    const binary = Buffer.from(builds.left)
    const entry = leftStructure.entries.find((item) => item.length === 25)
    if (!entry) throw new Error("fixture has no 25-byte string-table entry")
    binary[entry.offset + 7] = 0x01

    const outcome = canonicalizeBuildOutput({ bunVersion: BUN, bytes: binary })
    if (outcome.ok) throw new Error("expected a record-hash-word-reserved-bits rejection")
    expect(outcome.rejection.code).toBe("record-hash-word-reserved-bits")
    expect(outcome.rejection.offset).toBe(entry.offset)
  })

  test("rejects a changed chunk index inside a token", () => {
    const binary = Buffer.from(builds.left)
    const entry = leftStructure.entries.find((item) => item.length === 25)
    if (!entry) throw new Error("fixture has no 25-byte string-table entry")
    binary.write("9", entry.offset + 8 + 24, 1, "latin1")

    const outcome = canonicalizeBuildOutput({ bunVersion: BUN, bytes: binary })
    if (outcome.ok) throw new Error("expected a record-hash-underived rejection")
    expect(outcome.rejection.code).toBe("record-hash-underived")
    expect(outcome.rejection.offset).toBe(entry.offset)
  })

  test("rejects a chunk index that changed on one side even with a consistent hash", () => {
    const right = Buffer.from(builds.right)
    const entry = leftStructure.entries.find((item) => item.length === 25)
    if (!entry) throw new Error("fixture has no 25-byte string-table entry")
    const replacement = `${right.toString("latin1", entry.offset + 8, entry.offset + 8 + 16)}C${String(99999999).padStart(8, "0")}`
    right.write(replacement, entry.offset + 8, 25, "latin1")
    right.writeUInt32LE(deriveRecordHash(replacement), entry.offset + 4)

    const comparison = compareRebuild({ bunVersion: BUN, left: builds.left, right })
    if (comparison.equivalent) throw new Error("expected a residual-difference rejection")
    expect(comparison.rejection.code).toBe("residual-difference")
    expect(comparison.rejection.offset).toBeGreaterThanOrEqual(entry.offset)
    expect(comparison.rejection.offset).toBeLessThan(entry.offset + 33)
  })

  test("rejects a second forged key even when its hash is internally consistent", () => {
    const binary = Buffer.from(builds.left)
    const entry = leftStructure.entries.find((item) => item.length === 25)
    if (!entry) throw new Error("fixture has no 25-byte string-table entry")

    // Rebuild the table region in place as a well-formed two-entry table with
    // two distinct keys, and point the tail's table length at exactly that.
    const secondToken = `${KEY_B}${entry.text.slice(16)}`
    const tableStart = leftStructure.stringTableStart
    const tableLengthField =
      leftStructure.modulesStart + leftStructure.modulesLength + leftStructure.moduleCount * 4 + 4 + 4
    const entryBytes = 36
    binary.writeUInt32LE(2, tableStart)
    binary.writeUInt32LE(12, tableStart + 4)
    binary.writeUInt32LE(12 + entryBytes, tableStart + 8)
    for (const [index, text] of [entry.text, secondToken].entries()) {
      const entryStart = tableStart + 12 + index * entryBytes
      binary.writeUInt32LE((0x80000000 | text.length) >>> 0, entryStart)
      binary.writeUInt32LE(deriveRecordHash(text), entryStart + 4)
      binary.write(text, entryStart + 8, 25, "latin1")
      binary.fill(0, entryStart + 33, entryStart + 36)
    }
    binary.writeUInt32LE(12 + 2 * entryBytes, tableLengthField)

    const outcome = canonicalizeBuildOutput({ bunVersion: BUN, bytes: binary })
    if (outcome.ok) throw new Error("expected a bundler-key-ambiguous rejection")
    expect(outcome.rejection.code).toBe("bundler-key-ambiguous")
    expect(outcome.rejection.detail).toContain(KEY_B)
  })

  test("rejects a binary whose only tokens use the constant filler keys", () => {
    const binary = Buffer.from(builds.left)
    const tokens = leftStructure.entries.filter((item) => item.length === 25)
    if (!tokens.length) throw new Error("fixture has no 25-byte string-table entry")
    for (const entry of tokens) {
      const filler = `${FILLER_3}${entry.text.slice(16)}`
      binary.write(filler, entry.offset + 8, 25, "latin1")
      binary.writeUInt32LE(deriveRecordHash(filler), entry.offset + 4)
    }

    const outcome = canonicalizeBuildOutput({ bunVersion: BUN, bytes: binary })
    if (outcome.ok) throw new Error("expected a bundler-key-missing rejection")
    expect(outcome.rejection.code).toBe("bundler-key-missing")
  })

  test("rejects truncation and any other size mismatch", () => {
    const truncated = compareRebuild({
      bunVersion: BUN,
      left: builds.left,
      right: builds.right.subarray(0, builds.left.length - 1),
    })
    if (truncated.equivalent) throw new Error("expected a size-mismatch rejection")
    expect(truncated.rejection.code).toBe("size-mismatch")

    const extended = compareRebuild({
      bunVersion: BUN,
      left: builds.left,
      right: Buffer.concat([builds.right, Buffer.alloc(16)]),
    })
    if (extended.equivalent) throw new Error("expected a size-mismatch rejection")
    expect(extended.rejection.code).toBe("size-mismatch")
  })

  test("recomputes each side's hashes instead of copying the other side's bytes", () => {
    const right = Buffer.from(builds.right)
    const entry = leftStructure.entries.find((item) => item.length === 25)
    if (!entry) throw new Error("fixture has no 25-byte string-table entry")
    right.writeUInt32LE(builds.left.readUInt32LE(entry.offset + 4), entry.offset + 4)

    const comparison = compareRebuild({ bunVersion: BUN, left: builds.left, right })
    if (comparison.equivalent) throw new Error("expected a record-hash-underived rejection")
    expect(comparison.rejection.code).toBe("record-hash-underived")
    expect(comparison.rejection.detail.startsWith("right: ")).toBe(true)
  })
})