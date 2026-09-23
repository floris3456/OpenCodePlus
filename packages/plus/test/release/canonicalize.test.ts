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
const OUT_MANY_LEFT = join(scratch, "many-left")
const OUT_MANY_RIGHT = join(scratch, "many-right")
const OUT_ARGV = join(scratch, "argv")
const OUT_BUILTIN_LEFT = join(scratch, "builtin-left")
const OUT_BUILTIN_RIGHT = join(scratch, "builtin-right")

const MANY_MODULES = 384

interface RealBuilds {
  readonly left: Buffer
  readonly right: Buffer
  readonly darwin: Buffer
  readonly manyLeft: Buffer
  readonly manyRight: Buffer
  readonly argv: Buffer
  readonly builtinLeft: Buffer
  readonly builtinRight: Buffer
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

  // A genuinely multi-module source tree: every module is a split chunk with
  // bytecode, so the graph tail must carry several hundred content hashes and
  // the model has to hold at that size, not only for a handful of modules.
  const manyEntry = join(SOURCE_DIR, "many-entry.ts")
  const lines: string[] = []
  for (let index = 0; index < MANY_MODULES; index += 1) {
    const name = `many-${String(index).padStart(4, "0")}`
    writeFileSync(
      join(SOURCE_DIR, `${name}.ts`),
      `import { sharedOne } from './shared-one.ts'\nexport const value${index} = sharedOne + ${index}\nexport const label${index} = '${name}'\n`,
    )
    lines.push(`import('./${name}.ts')`)
  }
  writeFileSync(
    manyEntry,
    `async function main() {\n  const mods = await Promise.all([\n    ${lines.join(",\n    ")},\n  ])\n  console.log(mods.length)\n}\nmain()\n`,
  )

  // A production-like graph: the entry imports several node: builtins, so the
  // payload carries the embedded builtin-bytecode record that the real release
  // binary has (a nonzero count followed by {id, offset, length} entries),
  // which is the shape the small fixtures never exercise.
  const builtinEntry = join(SOURCE_DIR, "builtin-entry.ts")
  writeFileSync(
    builtinEntry,
    "import { readFileSync } from 'node:fs'\nimport { join } from 'node:path'\nimport { createHash } from 'node:crypto'\nimport { platform, release } from 'node:os'\nimport process from 'node:process'\nasync function main() {\n  const [alpha, beta] = await Promise.all([import('./alpha.ts'), import('./beta.ts')])\n  console.log(typeof readFileSync, join('a', 'b'), typeof createHash, platform(), release(), process.pid, alpha.alpha, beta.beta)\n}\nmain()\n",
  )

  // Both rebuilds use the same output basename so the only difference Bun is
  // allowed to introduce is the per-build bundler key.
  builds = {
    left: compile(OUT_LEFT),
    right: compile(OUT_RIGHT),
    darwin: compile(OUT_DARWIN, { target: "bun-darwin-arm64" }),
    manyLeft: compile(OUT_MANY_LEFT, { entry: manyEntry }),
    manyRight: compile(OUT_MANY_RIGHT, { entry: manyEntry }),
    argv: compile(OUT_ARGV, { extra: ["--compile-exec-argv", "--smol"] }),
    builtinLeft: compile(OUT_BUILTIN_LEFT, { entry: builtinEntry }),
    builtinRight: compile(OUT_BUILTIN_RIGHT, { entry: builtinEntry }),
  }

  const parsed = parseBuildStructure({ bunVersion: BUN, bytes: builds.left })
  if (!parsed.ok) throw new Error(`fixture failed to parse: ${parsed.rejection.detail}`)
  leftStructure = parsed.structure
}, 240000)

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function compile(
  outDir: string,
  options: { target?: string; bytecode?: boolean; entry?: string; extra?: string[]; splitting?: boolean } = {},
): Buffer {
  mkdirSync(outDir, { recursive: true })
  const outfile = join(outDir, "app")
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "build",
      options.entry ?? ENTRY,
      "--compile",
      ...(options.bytecode === false ? [] : ["--bytecode"]),
      "--format=esm",
      ...(options.splitting === false ? [] : ["--splitting"]),
      ...(options.target ? [`--target=${options.target}`] : []),
      ...(options.extra ?? []),
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

// ---------------------------------------------------------------------------
// The graph tail model, measured against the pinned Bun 1.4.2 toolchain.
//
// A real `bun build --compile --bytecode --format=esm --splitting` output ends
// its graph with: one `u32` content hash per module (`rapidhash(contents) &
// 0xffffff`), the embedded builtin-bytecode record (a count plus that many
// 12-byte `{id, offset, length}` entries; count 0 when no builtins are
// embedded), a bytecode string-table {offset, length}, the startup module
// count, a module-info string-table {offset, length}, the
// `--compile-exec-argv` string, and its NUL terminator as the final byte. The
// tests below pin that arithmetic on a four-module build, on a
// several-hundred-module build, and on a build that embeds node: builtins, so
// the model cannot regress to the small case.
// ---------------------------------------------------------------------------

describe("graph tail model (measured against the pinned toolchain)", () => {
  test("the small build carries the measured per-module content hash array", () => {
    const layout = readGraphLayout(builds.left)
    // sentinel(4) + bytecode table(8) + startup count(4) + module-info table(8)
    expect(layout.tailLength).toBe(
      layout.moduleCount * 4 + 4 + layout.builtinCount * 12 + 8 + 4 + 8 + layout.argvLength + 1,
    )
    expect(builds.left.readUInt32LE(layout.tailStart + layout.moduleCount * 4)).toBe(0)
    for (let index = 0; index < layout.moduleCount; index += 1) {
      const contentHash = Number(
        Bun.hash.rapidhash(moduleContents(builds.left, layout, index)) & 0xffffffn,
      )
      expect(builds.left.readUInt32LE(layout.tailStart + index * 4)).toBe(contentHash)
    }
  })

  test("a genuinely multi-module build keeps the same tail shape and content hashes", () => {
    const layout = readGraphLayout(builds.manyLeft)
    expect(layout.moduleCount).toBeGreaterThanOrEqual(300)
    expect(layout.tailLength).toBe(
      layout.moduleCount * 4 + 4 + layout.builtinCount * 12 + 8 + 4 + 8 + layout.argvLength + 1,
    )
    expect(builds.manyLeft.readUInt32LE(layout.tailStart + layout.moduleCount * 4)).toBe(0)
    for (let index = 0; index < layout.moduleCount; index += 1) {
      const contentHash = Number(
        Bun.hash.rapidhash(moduleContents(builds.manyLeft, layout, index)) & 0xffffffn,
      )
      expect(builds.manyLeft.readUInt32LE(layout.tailStart + index * 4)).toBe(contentHash)
    }

    const parsed = parseBuildStructure({ bunVersion: BUN, bytes: builds.manyLeft })
    if (!parsed.ok) throw new Error(`unexpected rejection: ${parsed.rejection.detail}`)
    expect(parsed.structure.moduleCount).toBe(layout.moduleCount)
    expect(parsed.structure.graphLength).toBe(layout.byteCount)
    expect(parsed.structure.modulesStart).toBe(layout.payloadStart + layout.modulesOffset)
    expect(parsed.structure.entries.length).toBeGreaterThan(100)
  })

  test("parses the multi-module build and anchors every record in its string table", () => {
    const parsed = parseBuildStructure({ bunVersion: BUN, bytes: builds.manyLeft })
    if (!parsed.ok) throw new Error(`unexpected rejection: ${parsed.rejection.detail}`)
    const structure = parsed.structure
    const tableEnd = structure.stringTableStart + structure.stringTableLength

    const outcome = canonicalizeBuildOutput({ bunVersion: BUN, bytes: builds.manyLeft })
    if (!outcome.ok) throw new Error(`unexpected rejection: ${outcome.rejection.detail}`)
    expect(outcome.records.length).toBeGreaterThanOrEqual(1)
    expect(outcome.entriesParsed).toBe(structure.entries.length)

    for (const record of outcome.records) {
      const entry = structure.entries.find((item) => item.offset === record.offset)
      if (!entry) throw new Error(`record ${record.token} is not a parsed string-table entry`)
      expect(entry.length).toBe(25)
      expect(entry.storedHash).toBe(deriveRecordHash(entry.text))
      expect(record.offset).toBeGreaterThanOrEqual(structure.stringTableStart)
      expect(record.offset).toBeLessThan(tableEnd)
      for (const range of structure.moduleRanges) {
        expect(record.offset < range.start || record.offset >= range.end).toBe(true)
      }
    }
    for (const range of structure.moduleRanges) {
      expect(tableEnd <= range.start || range.end <= structure.stringTableStart).toBe(true)
    }
  })

  test("two independent multi-module rebuilds differ only inside normalized spans", () => {
    const left = builds.manyLeft
    const right = builds.manyRight
    expect(left.equals(right)).toBe(false)

    const comparison = compareRebuild({ bunVersion: BUN, left, right })
    if (!comparison.equivalent) throw new Error(`unexpected rejection: ${comparison.rejection.detail}`)
    expect(comparison.container).toBe("elf")
    expect(comparison.rawIdentical).toBe(false)
    expect(comparison.recordsRewritten).toBeGreaterThanOrEqual(1)
    expect(comparison.bundlerKeys.left).not.toBe(comparison.bundlerKeys.right)

    const parsed = parseBuildStructure({ bunVersion: BUN, bytes: left })
    if (!parsed.ok) throw new Error(`unexpected rejection: ${parsed.rejection.detail}`)
    const spans = normalizedSpans(parsed.structure)
    for (let index = 0; index < left.byteLength; index += 1) {
      if (left[index] !== right[index]) expect(spans.has(index)).toBe(true)
    }
  })

  test("a build carrying --compile-exec-argv is accepted with its argv bytes explained", () => {
    const layout = readGraphLayout(builds.argv)
    expect(layout.argvLength).toBe("--smol".length)
    expect(layout.tailLength).toBe(
      layout.moduleCount * 4 + 4 + layout.builtinCount * 12 + 8 + 4 + 8 + layout.argvLength + 1,
    )

    const parsed = parseBuildStructure({ bunVersion: BUN, bytes: builds.argv })
    if (!parsed.ok) throw new Error(`unexpected rejection: ${parsed.rejection.detail}`)
    const outcome = canonicalizeBuildOutput({ bunVersion: BUN, bytes: builds.argv })
    if (!outcome.ok) throw new Error(`unexpected rejection: ${outcome.rejection.detail}`)

    // The argv string is the last thing before the graph's final NUL byte, and
    // it sits exactly where the parsed offsets struct says it does.
    const argvStart = layout.tailStart + layout.tailLength - layout.argvLength - 1
    expect(argvStart - layout.payloadStart).toBe(layout.argvOffset)
    expect(builds.argv.toString("latin1", argvStart, argvStart + layout.argvLength)).toBe("--smol")
    expect(builds.argv[layout.tailStart + layout.tailLength - 1]).toBe(0)
  })

  test("a tampered argv length fails closed instead of sliding the tail", () => {
    const tampered = Buffer.from(builds.argv)
    const layout = readGraphLayout(builds.argv)
    const offsetsStart = layout.payloadStart + layout.byteCount
    tampered.writeUInt32LE(layout.argvLength - 1, offsetsStart + 24)

    const outcome = canonicalizeBuildOutput({ bunVersion: BUN, bytes: tampered })
    if (outcome.ok) throw new Error("expected the tampered argv length to be rejected")
    expect(outcome.rejection.code).toBe("string-table-locator-malformed")
  })

  test("a non-zero argv terminator fails closed", () => {
    const tampered = Buffer.from(builds.argv)
    const layout = readGraphLayout(builds.argv)
    tampered[layout.tailStart + layout.tailLength - 1] = 0x5a

    const outcome = canonicalizeBuildOutput({ bunVersion: BUN, bytes: tampered })
    if (outcome.ok) throw new Error("expected the tampered terminator to be rejected")
    expect(outcome.rejection.code).toBe("string-table-locator-malformed")
  })

  test("a changed argv byte is a residual difference, never normalised away", () => {
    const layout = readGraphLayout(builds.argv)
    const argvStart = layout.tailStart + layout.tailLength - layout.argvLength - 1
    const tampered = Buffer.from(builds.argv)
    tampered[argvStart] = tampered[argvStart] ^ 0x01

    const comparison = compareRebuild({ bunVersion: BUN, left: builds.argv, right: tampered })
    if (comparison.equivalent) throw new Error("expected a residual-difference rejection")
    expect(comparison.rejection.code).toBe("residual-difference")
    expect(comparison.rejection.offset).toBe(argvStart)
  })
})

describe("embedded builtin bytecode record (production-like graph)", () => {
  test("the builtin record is parsed, explains the tail, and its blobs are in the data region", () => {
    const layout = readGraphLayout(builds.builtinLeft)
    expect(layout.builtinCount).toBeGreaterThanOrEqual(40)
    expect(layout.tailLength).toBe(
      layout.moduleCount * 4 + 4 + layout.builtinCount * 12 + 8 + 4 + 8 + layout.argvLength + 1,
    )

    const parsed = parseBuildStructure({ bunVersion: BUN, bytes: builds.builtinLeft })
    if (!parsed.ok) throw new Error(`unexpected rejection: ${parsed.rejection.detail}`)
    expect(parsed.structure.builtinBytecodeCount).toBe(layout.builtinCount)

    const entryBase = layout.tailStart + layout.moduleCount * 4 + 4
    const seen = new Set<number>()
    for (let index = 0; index < layout.builtinCount; index += 1) {
      const id = builds.builtinLeft.readUInt32LE(entryBase + index * 12)
      const offset = builds.builtinLeft.readUInt32LE(entryBase + index * 12 + 4)
      const length = builds.builtinLeft.readUInt32LE(entryBase + index * 12 + 8)
      expect(id).toBeGreaterThanOrEqual(0)
      expect(seen.has(id)).toBe(false)
      seen.add(id)
      expect(offset + length).toBeLessThanOrEqual(layout.modulesOffset)
      expect(offset + length).toBeLessThanOrEqual(layout.byteCount)
      const start = layout.payloadStart + offset
      for (const range of parsed.structure.moduleRanges) {
        expect(start + length <= range.start || range.end <= start).toBe(true)
      }
    }
  })

  test("a production-like rebuild pair canonicalizes identically", () => {
    const left = builds.builtinLeft
    const right = builds.builtinRight
    const layout = readGraphLayout(left)

    const comparison = compareRebuild({ bunVersion: BUN, left, right })
    if (!comparison.equivalent) throw new Error(`unexpected rejection: ${comparison.rejection.detail}`)
    expect(comparison.recordsRewritten).toBeGreaterThanOrEqual(1)
    expect(comparison.bundlerKeys.left).not.toBe("")
    if (comparison.rawIdentical) {
      expect(left.equals(right)).toBe(true)
      expect(comparison.rawDifferingBytes).toBe(0)
      return
    }

    const parsed = parseBuildStructure({ bunVersion: BUN, bytes: left })
    if (!parsed.ok) throw new Error(`unexpected rejection: ${parsed.rejection.detail}`)
    const spans = normalizedSpans(parsed.structure)
    for (let index = 0; index < left.byteLength; index += 1) {
      if (left[index] !== right[index]) expect(spans.has(index)).toBe(true)
    }
    expect(layout.builtinCount).toBe(readGraphLayout(right).builtinCount)
  })

  test("a tampered builtin count fails closed instead of sliding the tail", () => {
    const layout = readGraphLayout(builds.builtinLeft)
    const tampered = Buffer.from(builds.builtinLeft)
    const countAt = layout.tailStart + layout.moduleCount * 4
    tampered.writeUInt32LE(layout.builtinCount + 1, countAt)

    const outcome = canonicalizeBuildOutput({ bunVersion: BUN, bytes: tampered })
    if (outcome.ok) throw new Error("expected the tampered builtin count to be rejected")
    expect(outcome.rejection.code).toBe("string-table-locator-malformed")
  })

  test("a builtin blob redirected outside the graph fails closed", () => {
    const layout = readGraphLayout(builds.builtinLeft)
    const tampered = Buffer.from(builds.builtinLeft)
    const countAt = layout.tailStart + layout.moduleCount * 4
    const firstOffsetField = countAt + 4 + 4
    tampered.writeUInt32LE(layout.byteCount, firstOffsetField)

    const outcome = canonicalizeBuildOutput({ bunVersion: BUN, bytes: tampered })
    if (outcome.ok) throw new Error("expected the redirected builtin blob to be rejected")
    expect(outcome.rejection.code).toBe("string-table-locator-malformed")
  })

  test("a builtin blob pointed at the module table fails closed", () => {
    const layout = readGraphLayout(builds.builtinLeft)
    const tampered = Buffer.from(builds.builtinLeft)
    const countAt = layout.tailStart + layout.moduleCount * 4
    const firstOffsetField = countAt + 4 + 4
    tampered.writeUInt32LE(layout.modulesOffset, firstOffsetField)

    const outcome = canonicalizeBuildOutput({ bunVersion: BUN, bytes: tampered })
    if (outcome.ok) throw new Error("expected the module-table-pointing builtin blob to be rejected")
    expect(outcome.rejection.code).toBe("string-table-locator-malformed")
  })
})

interface GraphLayout {
  readonly payloadStart: number
  readonly payloadLength: number
  readonly byteCount: number
  readonly modulesOffset: number
  readonly modulesLength: number
  readonly moduleCount: number
  readonly entryPointId: number
  readonly argvOffset: number
  readonly argvLength: number
  readonly flags: number
  readonly tailStart: number
  readonly tailLength: number
  readonly builtinCount: number
}

/**
 * Read the graph layout straight out of a real ELF `.bun` section. The tests
 * use this to pin the byte arithmetic the parser has to agree with; the parser
 * itself never takes this shortcut.
 */
function readGraphLayout(bytes: Buffer): GraphLayout {
  const sectionHeaderOffset = Number(bytes.readBigUInt64LE(0x28))
  const sectionHeaderSize = bytes.readUInt16LE(0x3a)
  const sectionCount = bytes.readUInt16LE(0x3c)
  const nameIndex = bytes.readUInt16LE(0x3e)
  const namesHeader = sectionHeaderOffset + nameIndex * sectionHeaderSize
  const namesStart = Number(bytes.readBigUInt64LE(namesHeader + 0x18))
  let sectionOffset = -1
  let sectionSize = -1
  for (let index = 0; index < sectionCount; index += 1) {
    const header = sectionHeaderOffset + index * sectionHeaderSize
    const nameOffset = bytes.readUInt32LE(header)
    const end = namesStart + nameOffset
    let stop = end
    while (bytes[stop] !== 0) stop += 1
    if (bytes.toString("latin1", end, stop) !== ".bun") continue
    sectionOffset = Number(bytes.readBigUInt64LE(header + 0x18))
    sectionSize = Number(bytes.readBigUInt64LE(header + 0x20))
  }
  if (sectionOffset < 0) throw new Error("fixture has no .bun section")

  const payloadStart = sectionOffset + 8
  const payloadLength = sectionSize - 8
  const offsetsStart = payloadStart + payloadLength - 16 - 32
  const byteCount = Number(bytes.readBigUInt64LE(offsetsStart))
  const modulesOffset = bytes.readUInt32LE(offsetsStart + 8)
  const modulesLength = bytes.readUInt32LE(offsetsStart + 12)
  const tailStart = payloadStart + modulesOffset + modulesLength
  return {
    payloadStart,
    payloadLength,
    byteCount,
    modulesOffset,
    modulesLength,
    moduleCount: modulesLength / 52,
    entryPointId: bytes.readUInt32LE(offsetsStart + 16),
    argvOffset: bytes.readUInt32LE(offsetsStart + 20),
    argvLength: bytes.readUInt32LE(offsetsStart + 24),
    flags: bytes.readUInt32LE(offsetsStart + 28),
    tailStart,
    tailLength: byteCount - (modulesOffset + modulesLength),
    builtinCount: bytes.readUInt32LE(tailStart + (modulesLength / 52) * 4),
  }
}

function moduleContents(bytes: Buffer, layout: GraphLayout, index: number): Buffer {
  const record = layout.payloadStart + layout.modulesOffset + index * 52
  const offset = bytes.readUInt32LE(record + 8)
  const length = bytes.readUInt32LE(record + 12)
  return bytes.subarray(layout.payloadStart + offset, layout.payloadStart + offset + length)
}