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
const OUT_ARGV_LONG = join(scratch, "argv-long")
const OUT_BUILTIN_LEFT = join(scratch, "builtin-left")
const OUT_BUILTIN_RIGHT = join(scratch, "builtin-right")
const OUT_MIXED_LEFT = join(scratch, "mixed-left")
const OUT_MIXED_RIGHT = join(scratch, "mixed-right")

const MANY_MODULES = 384

/**
 * A 44-byte `--compile-exec-argv` string: exactly the size of the one-entry
 * string table the alias regression below needs (`u32 count` + `u32 offset` +
 * one 36-byte 8-bit record).
 */
const ARGV_44 = "--smol --no-warnings --max-semi-space-size=1"

interface RealBuilds {
  readonly left: Buffer
  readonly right: Buffer
  readonly darwin: Buffer
  readonly manyLeft: Buffer
  readonly manyRight: Buffer
  readonly argv: Buffer
  readonly argvLong: Buffer
  readonly builtinLeft: Buffer
  readonly builtinRight: Buffer
  readonly mixedLeft: Buffer
  readonly mixedRight: Buffer
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

  // A source whose string literals are not latin1. This is the mixed-width
  // neighbourhood measured in the real release binary: the six-character ASCII
  // spellings JSC records for U+2028/U+2029, the separator characters
  // themselves (one UTF-16 code unit each), CJK text, and an emoji, which is a
  // surrogate pair and so a two-code-unit UTF-16 entry. The ordinary strings of
  // the graph stay 8-bit, so one table holds both widths.
  const mixedEntry = join(SOURCE_DIR, "mixed-entry.ts")
  writeFileSync(
    join(SOURCE_DIR, "mixed.ts"),
    "export const spelled = '\\\\u2028\\\\u2029'\nexport const separators = '\u2028\u2029'\nexport const wide = '\u65e5\u672c\u8a9e'\nexport const emoji = '\ud83d\ude80'\nexport const narrow = 'plain ascii'\n",
  )
  writeFileSync(
    mixedEntry,
    "async function main() {\n  const [alpha, beta, mixed] = await Promise.all([import('./alpha.ts'), import('./beta.ts'), import('./mixed.ts')])\n  console.log(alpha.alpha, beta.beta, mixed.spelled, mixed.separators, mixed.wide, mixed.emoji, mixed.narrow)\n}\nmain()\n",
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
    argvLong: compile(OUT_ARGV_LONG, { extra: ["--compile-exec-argv", ARGV_44] }),
    builtinLeft: compile(OUT_BUILTIN_LEFT, { entry: builtinEntry }),
    builtinRight: compile(OUT_BUILTIN_RIGHT, { entry: builtinEntry }),
    mixedLeft: compile(OUT_MIXED_LEFT, { entry: mixedEntry }),
    mixedRight: compile(OUT_MIXED_RIGHT, { entry: mixedEntry }),
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
    if (!entry.is8Bit) continue
    if (entry.length !== 25) continue
    if (!/^[0-9a-f]{16}[ACSH][0-9]{8}$/.test(entry.text)) continue
    if (entry.text.startsWith(FILLER_3)) continue
    for (let index = 0; index < 16; index += 1) spans.add(entry.offset + 8 + index)
    for (let index = 0; index < 4; index += 1) spans.add(entry.offset + 4 + index)
  }
  return spans
}

const WIDE_TOKEN = "0123456789abcdefA00000000"
const WIDE_TOKEN_CHANGED = "1123456789abcdefA00000000"

function pad4(value: number): number {
  return (value + 3) & ~3
}

/** The tail field holding the bytecode string table's length. */
function bytecodeTableLengthField(structure: BuildStructure): number {
  return (
    structure.modulesStart +
    structure.modulesLength +
    structure.moduleCount * 4 +
    4 +
    structure.builtinBytecodeCount * 12 +
    4
  )
}

/**
 * Rewrite the shared string table of `binary` in place as a valid two-entry
 * mixed-width table: one ordinary 8-bit record bearing KEY_A, and one UTF-16
 * entry whose decoded characters spell a well-formed chunk token. The UTF-16
 * entry is structurally exact (contiguous, hash over its raw bytes, zero
 * padding, region consumed exactly), so it must parse while never being
 * eligible as a record. Returns the prefix offset of the UTF-16 entry.
 */
function craftWideTokenTable(binary: Buffer, wideToken: string): number {
  const tableStart = leftStructure.stringTableStart
  const narrowBytes = Buffer.from(`${KEY_A}C00000000`, "latin1")
  const wideBytes = Buffer.from(wideToken, "utf16le")
  const narrowSize = pad4(8 + narrowBytes.length)
  const wideSize = pad4(8 + wideBytes.length)
  const tableBytes = 4 + 8 + narrowSize + wideSize
  if (tableBytes > leftStructure.stringTableLength) {
    throw new Error(
      `fixture string table holds ${leftStructure.stringTableLength} bytes; the crafted table needs ${tableBytes}`,
    )
  }

  binary.writeUInt32LE(2, tableStart)
  binary.writeUInt32LE(12, tableStart + 4)
  binary.writeUInt32LE(12 + narrowSize, tableStart + 8)

  const narrowStart = tableStart + 12
  binary.writeUInt32LE((0x80000000 | narrowBytes.length) >>> 0, narrowStart)
  binary.writeUInt32LE(Number(Bun.hash.rapidhash(narrowBytes) & 0xffffffn), narrowStart + 4)
  narrowBytes.copy(binary, narrowStart + 8)
  binary.fill(0, narrowStart + 8 + narrowBytes.length, narrowStart + narrowSize)

  const wideStart = narrowStart + narrowSize
  // Flag clear: the count is UTF-16 code units, not bytes.
  binary.writeUInt32LE(wideToken.length, wideStart)
  binary.writeUInt32LE(Number(Bun.hash.rapidhash(wideBytes) & 0xffffffn), wideStart + 4)
  wideBytes.copy(binary, wideStart + 8)
  binary.fill(0, wideStart + 8 + wideBytes.length, wideStart + wideSize)

  binary.writeUInt32LE(tableBytes, bytecodeTableLengthField(leftStructure))
  return wideStart
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

// ---------------------------------------------------------------------------
// The container gate has two failure vocabularies. Corrupting an identification
// byte fails the ELF64-LE/Mach-O dispatch outright as
// `unsupported-executable-format`; corrupting a structural field inside an
// otherwise identified ELF fails `locateElfBunPayload` as
// `executable-structure-malformed`. Every case below mutates a real compiled
// fixture and pins the exact branch through its detail string, so the two codes
// are shown to be reachable through different corruptions.
// ---------------------------------------------------------------------------

/**
 * Assert the buffer is refused by the ELF container checks (not the graph or
 * string-table checks) and pin the exact `malformedExecutable` branch by a
 * distinctive fragment of its detail.
 */
function expectMalformedElf(bytes: Uint8Array, detail: string): void {
  const outcome = canonicalizeBuildOutput({ bunVersion: BUN, bytes })
  if (outcome.ok) throw new Error(`expected executable-structure-malformed: ${detail}`)
  expect(outcome.rejection.code).toBe("executable-structure-malformed")
  expect(outcome.rejection.offset).toBeNull()
  expect(outcome.rejection.detail).toContain(detail)
}

/** The Mach-O analogue of `expectMalformedElf`. */
function expectMalformedMachO(bytes: Uint8Array, detail: string): void {
  const outcome = canonicalizeBuildOutput({ bunVersion: BUN, bytes })
  if (outcome.ok) throw new Error(`expected executable-structure-malformed: ${detail}`)
  expect(outcome.rejection.code).toBe("executable-structure-malformed")
  expect(outcome.rejection.offset).toBeNull()
  expect(outcome.rejection.detail).toContain(detail)
}

/** Assert the buffer fails container identification before any structure is read. */
function expectUnsupportedFormat(bytes: Uint8Array, detail: string): void {
  const outcome = canonicalizeBuildOutput({ bunVersion: BUN, bytes })
  if (outcome.ok) throw new Error(`expected unsupported-executable-format: ${detail}`)
  expect(outcome.rejection.code).toBe("unsupported-executable-format")
  expect(outcome.rejection.offset).toBeNull()
  expect(outcome.rejection.detail).toContain(detail)
}

describe("container identification bytes", () => {
  test("rejects a corrupted ELF magic as unsupported-executable-format", () => {
    const binary = Buffer.from(builds.left)
    binary[0] = 0x00
    expectUnsupportedFormat(binary, "not an ELF64-LE or Mach-O64-LE")
  })

  test("rejects a 32-bit class byte as unsupported-executable-format", () => {
    const binary = Buffer.from(builds.left)
    binary[4] = 1
    expectUnsupportedFormat(binary, "not an ELF64-LE or Mach-O64-LE")
  })

  test("rejects a big-endian data byte as unsupported-executable-format", () => {
    const binary = Buffer.from(builds.left)
    binary[5] = 2
    expectUnsupportedFormat(binary, "not an ELF64-LE or Mach-O64-LE")
  })

  test("rejects an ELF64-LE image with no '.bun' section as unsupported-executable-format", () => {
    const binary = Buffer.from(builds.left)
    const bun = requireElfSection(binary, ".bun")
    // Rename the only `.bun` header to the empty name at name-table offset 0.
    binary.writeUInt32LE(0, bun.header)
    expectUnsupportedFormat(binary, "has no '.bun' section")
  })
})

describe("ELF container structure rejection (executable-structure-malformed)", () => {
  test("rejects an ELF image shorter than its header", () => {
    expectMalformedElf(builds.left.subarray(0, 63), "shorter than its header")
  })

  test("rejects an ELF identification version that is not the pinned layout", () => {
    const binary = Buffer.from(builds.left)
    binary[6] = 2
    expectMalformedElf(binary, "identification version is not the pinned layout")
  })

  test("rejects a mismatched ELF program header entry size", () => {
    const binary = Buffer.from(builds.left)
    binary.writeUInt16LE(55, 0x36)
    expectMalformedElf(binary, "program header size is 55")
  })

  test("rejects a mismatched ELF section header entry size", () => {
    const binary = Buffer.from(builds.left)
    binary.writeUInt16LE(63, 0x3a)
    expectMalformedElf(binary, "section header size is 63")
  })

  test("rejects an ELF with no section headers", () => {
    const binary = Buffer.from(builds.left)
    binary.writeUInt16LE(0, 0x3c)
    expectMalformedElf(binary, "no section headers")
  })

  test("rejects an out-of-range ELF section name table index", () => {
    const binary = Buffer.from(builds.left)
    binary.writeUInt16LE(binary.readUInt16LE(0x3c), 0x3e)
    expectMalformedElf(binary, "section name table index is out of range")
  })

  test("rejects an ELF program header table outside the file", () => {
    const binary = Buffer.from(builds.left)
    binary.writeBigUInt64LE(BigInt(binary.byteLength), 0x20)
    expectMalformedElf(binary, "program header table is out of bounds")
  })

  test("rejects an ELF section header table outside the file", () => {
    const binary = Buffer.from(builds.left)
    binary.writeBigUInt64LE(BigInt(binary.byteLength), 0x28)
    expectMalformedElf(binary, "section header table is out of bounds")
  })

  test("rejects a section header count that cannot fit the file", () => {
    // Every representable u16 count (65535 * 64 = 4 MiB) fits the real
    // fixture, so this prefix keeps the ELF and program headers valid while the
    // count becomes the term the section-table bounds check refuses.
    const programEnd =
      Number(builds.left.readBigUInt64LE(0x20)) +
      builds.left.readUInt16LE(0x38) * builds.left.readUInt16LE(0x36)
    const binary = Buffer.from(builds.left.subarray(0, Math.max(programEnd, 64)))
    binary.writeBigUInt64LE(0n, 0x28)
    binary.writeUInt16LE(0xffff, 0x3c)
    expectMalformedElf(binary, "section header table is out of bounds")
  })

  test("rejects an ELF section name string table outside the file", () => {
    const binary = Buffer.from(builds.left)
    const names = requireElfSection(binary, ".shstrtab")
    binary.writeBigUInt64LE(BigInt(binary.byteLength), names.header + 0x18)
    expectMalformedElf(binary, "section name table is out of bounds")
  })

  test("rejects an ELF with more than one '.bun' section", () => {
    const binary = Buffer.from(builds.left)
    const bun = requireElfSection(binary, ".bun")
    const other = elfSections(binary).find(
      (section) => section.name !== ".bun" && section.type === 1,
    )
    if (!other) throw new Error("fixture has no second PROGBITS section")
    // Point a second PROGBITS header at the existing `.bun` name string. The
    // duplicate is detected whichever of the two comes first in table order.
    binary.writeUInt32LE(bun.nameOffset, other.header)
    expectMalformedElf(binary, "more than one '.bun' section")
  })

  test("rejects a '.bun' section that is not PROGBITS", () => {
    const binary = Buffer.from(builds.left)
    const bun = requireElfSection(binary, ".bun")
    binary.writeUInt32LE(8, bun.header + 4)
    expectMalformedElf(binary, "'.bun' section has type 8, expected 1")
  })

  test("rejects a '.bun' section whose bounds escape the file", () => {
    const binary = Buffer.from(builds.left)
    const bun = requireElfSection(binary, ".bun")
    binary.writeBigUInt64LE(BigInt(binary.byteLength), bun.header + 0x18)
    expectMalformedElf(binary, "'.bun' section is out of bounds")
  })

  test("rejects a '.bun' section outside every PT_LOAD segment", () => {
    const binary = Buffer.from(builds.left)
    const programHeaderOffset = Number(binary.readBigUInt64LE(0x20))
    const programHeaderSize = binary.readUInt16LE(0x36)
    const programHeaderCount = binary.readUInt16LE(0x38)
    for (let index = 0; index < programHeaderCount; index += 1) {
      const header = programHeaderOffset + index * programHeaderSize
      if (binary.readUInt32LE(header) === 1) binary.writeUInt32LE(0, header)
    }
    expectMalformedElf(binary, "'.bun' section is not contained in any PT_LOAD segment")
  })

  test("rejects a PT_LOAD segment whose file range escapes the file", () => {
    const binary = Buffer.from(builds.left)
    const bun = requireElfSection(binary, ".bun")
    const load = elfProgramHeaders(binary).find(
      (header) =>
        header.type === 1 &&
        header.offset <= bun.offset &&
        bun.offset + bun.size <= header.offset + header.fileSize,
    )
    if (!load) throw new Error("fixture has no PT_LOAD segment containing the '.bun' section")
    // An out-of-file range contains the section trivially; without a file bound
    // on the segment it satisfies the containment check while describing no
    // bytes the file actually has.
    binary.writeBigUInt64LE(BigInt(binary.byteLength) * 2n, load.header + 0x20)
    expectMalformedElf(binary, "PT_LOAD segment file range is out of bounds")
  })

  test("rejects a '.bun' section too small for a graph, offsets and trailer", () => {
    const binary = Buffer.from(builds.left)
    const bun = requireElfSection(binary, ".bun")
    binary.writeBigUInt64LE(48n, bun.header + 0x20)
    expectMalformedElf(binary, "too small to hold a graph, offsets and trailer")
  })

  test("rejects a Bun payload length prefix that disagrees with its section", () => {
    const binary = Buffer.from(builds.left)
    const bun = requireElfSection(binary, ".bun")
    binary.writeBigUInt64LE(binary.readBigUInt64LE(bun.offset) + 8n, bun.offset)
    expectMalformedElf(binary, "length prefix is")
  })
})

// ---------------------------------------------------------------------------
// The Mach-O container checks read a section's `segname` from the section
// header, which is self-asserted, and bounded the section array against the
// whole buffer rather than the load command that owns it. The corruptions
// below exercise each gap on the real Darwin fixture: an inflated section
// count that reaches outside its load command (with a forged
// `__BUN,__bun` planted in the escaped slot), a zeroed enclosing-segment file
// size, a renamed enclosing segment, and an out-of-file segment file range.
// ---------------------------------------------------------------------------

describe("Mach-O container structure rejection (executable-structure-malformed)", () => {
  test("rejects a segment whose inflated section count reaches outside its load command", () => {
    const binary = Buffer.from(builds.darwin)
    const bun = machoBunSection(binary)
    // Rename the genuine section, then forge the only candidate in a slot the
    // inflated count places past the segment command, in bytes owned by no
    // load command at all.
    binary.write("__was", bun.header, 5, "latin1")
    const forgedAt = plantEscapedMachoSection(binary, bun.command, bun.header)
    const forged = machoSectionAt(binary, forgedAt)
    expect(forged.sectionName).toBe("__bun")
    expect(forged.segmentName).toBe("__BUN")

    expectMalformedMachO(binary, "section records do not fit their load command")
  })

  test("rejects a '__BUN,__bun' section whose enclosing segment declares no file range", () => {
    const binary = Buffer.from(builds.darwin)
    const bun = machoBunSection(binary)
    binary.writeBigUInt64LE(0n, bun.command.offset + MACHO_SEGMENT_64_FILESIZE)
    expectMalformedMachO(binary, "not contained in its segment's file range")
  })

  test("rejects a '__BUN,__bun' section whose enclosing segment is not __BUN", () => {
    const binary = Buffer.from(builds.darwin)
    const bun = machoBunSection(binary)
    binary.write("__NOT_BUN", bun.command.offset + MACHO_SEGMENT_64_SEGNAME, 9, "latin1")
    expectMalformedMachO(binary, "not the '__BUN' segment")
  })

  test("rejects a segment whose file range escapes the file", () => {
    const binary = Buffer.from(builds.darwin)
    const bun = machoBunSection(binary)
    binary.writeBigUInt64LE(BigInt(binary.byteLength) * 2n, bun.command.offset + MACHO_SEGMENT_64_FILESIZE)
    expectMalformedMachO(binary, "segment file range is out of bounds")
  })
})

// ---------------------------------------------------------------------------
// Entry widths: bit 31 of the length word is JSC's `is8Bit` flag, not a
// required marker. The mixed fixture's non-latin1 literals put both widths in
// one table; the crafted tables below put a token-shaped UTF-16 entry into a
// real build to prove it parses and validates but is never a record.
// ---------------------------------------------------------------------------

describe("string-table entry widths (JSC is8Bit flag)", () => {
  test("a build with non-latin1 literals carries both widths in one table", () => {
    const parsed = parseBuildStructure({ bunVersion: BUN, bytes: builds.mixedLeft })
    if (!parsed.ok) throw new Error(`unexpected rejection: ${parsed.rejection.detail}`)
    const entries = parsed.structure.entries

    expect(entries.filter((entry) => entry.is8Bit).length).toBeGreaterThan(0)
    expect(entries.filter((entry) => !entry.is8Bit).length).toBeGreaterThan(0)

    // Every entry, either width, is re-derived over its own bytes, and a wide
    // entry's byte length is twice its code-unit count.
    for (const entry of entries) {
      expect(entry.byteLength).toBe(entry.is8Bit ? entry.length : entry.length * 2)
      const raw = builds.mixedLeft.subarray(entry.offset + 8, entry.offset + 8 + entry.byteLength)
      expect(entry.storedHash).toBe(Number(Bun.hash.rapidhash(raw) & 0xffffffn))
    }

    const spelled = entries.find((entry) => entry.is8Bit && entry.text === "\\u2028\\u2029")
    const separators = entries.find((entry) => !entry.is8Bit && entry.text === "\u2028\u2029")
    const cjk = entries.find((entry) => !entry.is8Bit && entry.text === "\u65e5\u672c\u8a9e")
    const emoji = entries.find((entry) => !entry.is8Bit && entry.text === "\ud83d\ude80")
    if (!spelled || !separators || !cjk || !emoji) {
      throw new Error("the fixture did not put every non-latin1 literal in the shared string table")
    }
    expect(spelled.length).toBe(12)
    expect(spelled.byteLength).toBe(12)
    expect(separators.length).toBe(2)
    expect(separators.byteLength).toBe(4)
    expect(cjk.length).toBe(3)
    expect(cjk.byteLength).toBe(6)
    // An emoji is a surrogate pair: two UTF-16 code units, four bytes.
    expect(emoji.length).toBe(2)
    expect(emoji.byteLength).toBe(4)

    const outcome = canonicalizeBuildOutput({ bunVersion: BUN, bytes: builds.mixedLeft })
    if (!outcome.ok) throw new Error(`unexpected rejection: ${outcome.rejection.detail}`)
    for (const record of outcome.records) {
      const entry = entries.find((item) => item.offset === record.offset)
      if (!entry) throw new Error(`record ${record.token} is not a parsed string-table entry`)
      expect(entry.is8Bit).toBe(true)
    }
    for (const entry of entries) {
      if (entry.is8Bit) continue
      expect(outcome.records.some((record) => record.offset === entry.offset)).toBe(false)
    }
  })

  test("two independent mixed-width rebuilds are equivalent and move only keyed 8-bit records", () => {
    const left = builds.mixedLeft
    const right = builds.mixedRight

    const comparison = compareRebuild({ bunVersion: BUN, left, right })
    if (!comparison.equivalent) throw new Error(`unexpected rejection: ${comparison.rejection.detail}`)
    expect(comparison.container).toBe("elf")
    expect(comparison.recordsRewritten).toBeGreaterThanOrEqual(1)
    expect(comparison.rawDifferingBytes).toBeLessThanOrEqual(comparison.recordsRewritten * 20)

    const parsed = parseBuildStructure({ bunVersion: BUN, bytes: left })
    if (!parsed.ok) throw new Error(`unexpected rejection: ${parsed.rejection.detail}`)
    expect(parsed.structure.entries.some((entry) => !entry.is8Bit)).toBe(true)

    // No byte of a UTF-16 entry can ever be inside a normalized span.
    const spans = normalizedSpans(parsed.structure)
    for (const entry of parsed.structure.entries) {
      if (entry.is8Bit) continue
      for (let index = 0; index < entry.byteLength; index += 1) {
        expect(spans.has(entry.offset + 8 + index)).toBe(false)
      }
    }
    if (comparison.rawIdentical) return
    for (let index = 0; index < left.byteLength; index += 1) {
      if (left[index] !== right[index]) expect(spans.has(index)).toBe(true)
    }
  })

  test("a UTF-16 entry spelling a well-formed token is parsed but never eligible", () => {
    const crafted = Buffer.from(builds.left)
    const wideEntryOffset = craftWideTokenTable(crafted, WIDE_TOKEN)

    const parsed = parseBuildStructure({ bunVersion: BUN, bytes: crafted })
    if (!parsed.ok) throw new Error(`unexpected rejection: ${parsed.rejection.detail}`)
    const entry = parsed.structure.entries.find((item) => item.offset === wideEntryOffset)
    if (!entry) throw new Error("the crafted UTF-16 entry was not parsed")
    expect(entry.is8Bit).toBe(false)
    expect(entry.text).toBe(WIDE_TOKEN)
    expect(entry.length).toBe(25)
    expect(entry.byteLength).toBe(50)
    expect(/^[0-9a-f]{16}[ACSH][0-9]{8}$/.test(entry.text)).toBe(true)

    const outcome = canonicalizeBuildOutput({ bunVersion: BUN, bytes: crafted })
    if (!outcome.ok) throw new Error(`unexpected rejection: ${outcome.rejection.detail}`)
    expect(outcome.records.some((record) => record.offset === wideEntryOffset)).toBe(false)
    expect(outcome.records.some((record) => record.token === WIDE_TOKEN)).toBe(false)
    // The canonical image leaves the UTF-16 entry's bytes exactly as they were.
    expect(
      outcome.canonical
        .subarray(wideEntryOffset + 8, wideEntryOffset + 58)
        .equals(Buffer.from(WIDE_TOKEN, "utf16le")),
    ).toBe(true)
  })

  test("a difference inside a UTF-16 token-shaped entry is a residual difference", () => {
    const left = Buffer.from(builds.left)
    const right = Buffer.from(builds.left)
    const wideEntryOffset = craftWideTokenTable(left, WIDE_TOKEN)
    craftWideTokenTable(right, WIDE_TOKEN_CHANGED)

    const comparison = compareRebuild({ bunVersion: BUN, left, right })
    if (comparison.equivalent) throw new Error("expected a residual-difference rejection")
    expect(comparison.rejection.code).toBe("residual-difference")
    expect(comparison.rejection.offset).toBeGreaterThanOrEqual(wideEntryOffset)
    expect(comparison.rejection.offset).toBeLessThan(wideEntryOffset + 58)
  })

  test("a UTF-16 entry whose stored hash does not derive is rejected", () => {
    const crafted = Buffer.from(builds.left)
    const wideEntryOffset = craftWideTokenTable(crafted, WIDE_TOKEN)
    crafted.writeUInt32LE(crafted.readUInt32LE(wideEntryOffset + 4) ^ 0x01, wideEntryOffset + 4)

    const outcome = canonicalizeBuildOutput({ bunVersion: BUN, bytes: crafted })
    if (outcome.ok) throw new Error("expected a record-hash-underived rejection")
    expect(outcome.rejection.code).toBe("record-hash-underived")
    expect(outcome.rejection.offset).toBe(wideEntryOffset)
  })

  test("a UTF-16 entry whose length * 2 overruns the region is rejected", () => {
    const absurd = Buffer.from(builds.left)
    const absurdOffset = craftWideTokenTable(absurd, WIDE_TOKEN)
    // Flag clear, 0x7fffffff code units: 4 GiB of data in a 108-byte region.
    absurd.writeUInt32LE(0x7fffffff, absurdOffset)

    const absurdOutcome = canonicalizeBuildOutput({ bunVersion: BUN, bytes: absurd })
    if (absurdOutcome.ok) throw new Error("expected a string-table-malformed rejection")
    expect(absurdOutcome.rejection.code).toBe("string-table-malformed")
    expect(absurdOutcome.rejection.offset).toBe(absurdOffset)

    // A count a byte-oriented reader would accept: 30 as bytes would fit the
    // 52-byte remainder, but 30 code units (60 bytes) does not.
    const subtle = Buffer.from(builds.left)
    const subtleOffset = craftWideTokenTable(subtle, WIDE_TOKEN)
    subtle.writeUInt32LE(30, subtleOffset)

    const subtleOutcome = canonicalizeBuildOutput({ bunVersion: BUN, bytes: subtle })
    if (subtleOutcome.ok) throw new Error("expected a string-table-malformed rejection")
    expect(subtleOutcome.rejection.code).toBe("string-table-malformed")
    expect(subtleOutcome.rejection.offset).toBe(subtleOffset)
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
    // builtin count(4, zero) + bytecode table(8) + startup count(4) + module-info table(8)
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

  test("announced string tables sit in the data region before the module table", () => {
    // Every byte after the module table is owned by the pinned trailing-record
    // shape, so an announced table can only be a real table if it ends where
    // the module table begins. Both real containers are checked, for the
    // bytecode table and for the optional module-info table.
    for (const fixture of [builds.left, builds.darwin, builds.builtinLeft]) {
      const parsed = parseBuildStructure({ bunVersion: BUN, bytes: fixture })
      if (!parsed.ok) throw new Error(`unexpected rejection: ${parsed.rejection.detail}`)
      const structure = parsed.structure
      const modulesOffset = structure.modulesStart - structure.payloadStart
      expect(
        structure.stringTableStart - structure.payloadStart + structure.stringTableLength,
      ).toBeLessThanOrEqual(modulesOffset)

      const moduleInfoLocator =
        structure.modulesStart +
        structure.modulesLength +
        structure.moduleCount * 4 +
        4 +
        structure.builtinBytecodeCount * 12 +
        8 +
        4
      const moduleInfoOffset = fixture.readUInt32LE(moduleInfoLocator)
      const moduleInfoLength = fixture.readUInt32LE(moduleInfoLocator + 4)
      expect(moduleInfoLength).toBeGreaterThan(0)
      expect(moduleInfoOffset + moduleInfoLength).toBeLessThanOrEqual(modulesOffset)
    }
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

// ---------------------------------------------------------------------------
// R1 (reviewer counterexample): the announced-table checks never compared the
// string table regions against the argv / trailing-record region. A one-entry
// table (4 + 4 + 36 = 44 bytes) can therefore be announced over a 44-byte
// `--compile-exec-argv` string and canonicalization will rewrite the argv bytes
// as if they were a chunk-token record, masking a real difference between two
// binaries. These bytes are exactly what the pinned toolchain writes for the
// argv string, so the check is a false accept, not a hypothetical shape.
// ---------------------------------------------------------------------------

/**
 * Overwrite the 44-byte argv string with a structurally exact one-entry string
 * table and redirect one announced-table locator at it. The argv pointer and
 * length, the final NUL terminator and every other byte stay unchanged, so the
 * only thing wrong with the image is that one announced region aliases the
 * tail. Both announced locators are exercised: the bytecode table (which the
 * canonicalizer parses for records) and the module-info table (which it does
 * not).
 */
function craftArgvAliasedTable(source: Buffer, key: string, target: "bytecode" | "moduleInfo"): Buffer {
  const layout = readGraphLayout(source)
  if (layout.argvLength !== ARGV_44.length) {
    throw new Error(`argv fixture holds ${layout.argvLength} argv byte(s), expected ${ARGV_44.length}`)
  }
  const binary = Buffer.from(source)
  const argvStart = layout.tailStart + layout.tailLength - layout.argvLength - 1
  if (argvStart - layout.payloadStart !== layout.argvOffset) {
    throw new Error("argv bytes are not where the offsets struct says they are")
  }

  const token = `${key}C00000000`
  binary.writeUInt32LE(1, argvStart)
  binary.writeUInt32LE(8, argvStart + 4)
  binary.writeUInt32LE((0x80000000 | token.length) >>> 0, argvStart + 8)
  binary.writeUInt32LE(deriveRecordHash(token), argvStart + 12)
  binary.write(token, argvStart + 16, token.length, "latin1")
  binary.fill(0, argvStart + 16 + token.length, argvStart + ARGV_44.length)

  // Bytecode-table locator, or the module-info locator after the startup count.
  const locator =
    target === "bytecode"
      ? layout.tailStart + layout.moduleCount * 4 + 4 + layout.builtinCount * 12
      : layout.tailStart + layout.moduleCount * 4 + 4 + layout.builtinCount * 12 + 8 + 4
  binary.writeUInt32LE(layout.argvOffset, locator)
  binary.writeUInt32LE(layout.argvLength, locator + 4)
  return binary
}

describe("adversarial: announced string tables may not alias the graph tail", () => {
  test("a table announced over the argv bytes cannot mask an argv difference", () => {
    const left = craftArgvAliasedTable(builds.argvLong, KEY_A, "bytecode")
    const right = craftArgvAliasedTable(builds.argvLong, KEY_B, "bytecode")

    const layout = readGraphLayout(builds.argvLong)
    const argvStart = layout.tailStart + layout.tailLength - layout.argvLength - 1
    // The two copies differ only inside the 44 argv bytes.
    expect(left.equals(right)).toBe(false)
    expect(left.subarray(0, argvStart).equals(right.subarray(0, argvStart))).toBe(true)
    expect(left.subarray(argvStart + ARGV_44.length).equals(right.subarray(argvStart + ARGV_44.length))).toBe(true)

    // Neither copy may be accepted, because the announced table is not a table,
    // and the comparison may not call two different binaries equivalent.
    const outcome = canonicalizeBuildOutput({ bunVersion: BUN, bytes: left })
    const comparison = compareRebuild({ bunVersion: BUN, left, right })
    if (outcome.ok || comparison.equivalent) {
      const accepted = outcome.ok
        ? `adopted the argv bytes as a ${outcome.records.length}-record string table`
        : "rejected the aliased table"
      const equivalent = comparison.equivalent
        ? `two binaries with different argv bytes compared equivalent (rawDifferingBytes ${comparison.rawDifferingBytes})`
        : "rejected the comparison"
      throw new Error(`FALSE ACCEPT: ${accepted}; ${equivalent}`)
    }
    expect(outcome.rejection.code).toBe("string-table-locator-malformed")
    expect(comparison.rejection.code).toBe("string-table-locator-malformed")
    expect(comparison.rejection.offset).not.toBeNull()
  })

  test("a module-info table announced over the argv bytes is rejected too", () => {
    const aliased = craftArgvAliasedTable(builds.argvLong, KEY_A, "moduleInfo")
    const outcome = canonicalizeBuildOutput({ bunVersion: BUN, bytes: aliased })
    if (outcome.ok) {
      throw new Error(`FALSE ACCEPT: argv bytes were adopted as an announced module-info region (${outcome.entriesParsed} entries)`)
    }
    expect(outcome.rejection.code).toBe("string-table-locator-malformed")
    expect(outcome.rejection.offset).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Embedded builtin bytecode: the record the real release binary carries.
//
// The product binary's tail is 3296 bytes for 402 modules: 402*4 = 1608 bytes
// of content hashes, a count word (132) and 132 twelve-byte entries (1584),
// the bytecode table, startup count, module-info table (20), a 79-byte
// `--compile-exec-argv` string and its NUL. The fixture below embeds node:
// builtins, which produces the same shape with 40+ entries, so the model is
// exercised on the structure that the small fixtures never reach.
// ---------------------------------------------------------------------------

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

interface ElfSection {
  readonly header: number
  readonly nameOffset: number
  readonly name: string
  readonly offset: number
  readonly size: number
  readonly type: number
}

/**
 * Read every section header of a real ELF fixture. The container rejection
 * tests corrupt these fields, so the arithmetic below locates the headers the
 * same way the parser bounds-checks them instead of a second private copy.
 */
function elfSections(bytes: Buffer): ElfSection[] {
  const sectionHeaderOffset = Number(bytes.readBigUInt64LE(0x28))
  const sectionHeaderSize = bytes.readUInt16LE(0x3a)
  const sectionCount = bytes.readUInt16LE(0x3c)
  const nameIndex = bytes.readUInt16LE(0x3e)
  const namesHeader = sectionHeaderOffset + nameIndex * sectionHeaderSize
  const namesStart = Number(bytes.readBigUInt64LE(namesHeader + 0x18))
  const namesLength = Number(bytes.readBigUInt64LE(namesHeader + 0x20))
  const sections: ElfSection[] = []
  for (let index = 0; index < sectionCount; index += 1) {
    const header = sectionHeaderOffset + index * sectionHeaderSize
    const nameOffset = bytes.readUInt32LE(header)
    const end = namesStart + nameOffset
    let stop = end
    while (stop < namesStart + namesLength && bytes[stop] !== 0) stop += 1
    sections.push({
      header,
      nameOffset,
      name: bytes.toString("latin1", end, stop),
      offset: Number(bytes.readBigUInt64LE(header + 0x18)),
      size: Number(bytes.readBigUInt64LE(header + 0x20)),
      type: bytes.readUInt32LE(header + 4),
    })
  }
  return sections
}

function requireElfSection(bytes: Buffer, name: string): ElfSection {
  const section = elfSections(bytes).find((item) => item.name === name)
  if (!section) throw new Error(`fixture has no ${name} section`)
  return section
}

interface ElfProgramHeader {
  readonly header: number
  readonly type: number
  readonly offset: number
  readonly fileSize: number
}

/** Read the program headers of a real ELF fixture the way the parser does. */
function elfProgramHeaders(bytes: Buffer): ElfProgramHeader[] {
  const tableOffset = Number(bytes.readBigUInt64LE(0x20))
  const entrySize = bytes.readUInt16LE(0x36)
  const count = bytes.readUInt16LE(0x38)
  const headers: ElfProgramHeader[] = []
  for (let index = 0; index < count; index += 1) {
    const header = tableOffset + index * entrySize
    headers.push({
      header,
      type: bytes.readUInt32LE(header),
      offset: Number(bytes.readBigUInt64LE(header + 0x08)),
      fileSize: Number(bytes.readBigUInt64LE(header + 0x20)),
    })
  }
  return headers
}

const MACHO_LC_SEGMENT_64 = 0x19
const MACHO_SEGMENT_64_SECTIONS = 0x48
const MACHO_SECTION_64_BYTES = 80
const MACHO_SEGMENT_64_NSECTS = 0x40
const MACHO_SEGMENT_64_SEGNAME = 0x08
const MACHO_SEGMENT_64_FILESIZE = 0x30
const MACHO_SECTION_64_SEGNAME = 0x10
const MACHO_SECTION_64_SIZE = 0x28
const MACHO_SECTION_64_OFFSET = 0x30

interface MachoCommand {
  readonly offset: number
  readonly cmd: number
  readonly size: number
  readonly sectionCount: number
}

interface MachoSection {
  readonly header: number
  readonly sectionName: string
  readonly segmentName: string
  readonly offset: number
  readonly size: number
}

/** Read the load commands of a real Mach-O fixture the way the parser does. */
function machoCommands(bytes: Buffer): MachoCommand[] {
  const count = bytes.readUInt32LE(0x10)
  const commandBytes = bytes.readUInt32LE(0x14)
  const commands: MachoCommand[] = []
  let cursor = 32
  for (let index = 0; index < count; index += 1) {
    const cmd = bytes.readUInt32LE(cursor)
    const size = bytes.readUInt32LE(cursor + 4)
    commands.push({
      offset: cursor,
      cmd,
      size,
      sectionCount: cmd === MACHO_LC_SEGMENT_64 ? bytes.readUInt32LE(cursor + MACHO_SEGMENT_64_NSECTS) : 0,
    })
    cursor += size
  }
  if (cursor !== 32 + commandBytes) throw new Error("fixture load commands do not fill sizeofcmds")
  return commands
}

function machoCstring(bytes: Buffer, offset: number, width: number): string {
  let end = offset + width
  while (end > offset && bytes[end - 1] === 0) end -= 1
  return bytes.toString("latin1", offset, end)
}

function machoSectionAt(bytes: Buffer, header: number): MachoSection {
  return {
    header,
    sectionName: machoCstring(bytes, header, 16),
    segmentName: machoCstring(bytes, header + MACHO_SECTION_64_SEGNAME, 16),
    offset: bytes.readUInt32LE(header + MACHO_SECTION_64_OFFSET),
    size: Number(bytes.readBigUInt64LE(header + MACHO_SECTION_64_SIZE)),
  }
}

function machoBunSection(bytes: Buffer): { readonly header: number; readonly command: MachoCommand } {
  for (const command of machoCommands(bytes)) {
    if (command.cmd !== MACHO_LC_SEGMENT_64) continue
    for (let index = 0; index < command.sectionCount; index += 1) {
      const header = command.offset + MACHO_SEGMENT_64_SECTIONS + index * MACHO_SECTION_64_BYTES
      const section = machoSectionAt(bytes, header)
      if (section.sectionName !== "__bun" || section.segmentName !== "__BUN") continue
      return { header, command }
    }
  }
  throw new Error("fixture has no '__BUN,__bun' section")
}

/**
 * Inflate a segment command's section count so its last slot starts past the
 * load commands, write a forged `__BUN,__bun` header there (copying the real
 * payload's size and offset), and return the forged header's offset. Nothing
 * inside the declared load-command region changes.
 */
function plantEscapedMachoSection(binary: Buffer, command: MachoCommand, source: number): number {
  const commandEnd = 32 + binary.readUInt32LE(0x14)
  const sectionsStart = command.offset + MACHO_SEGMENT_64_SECTIONS
  const escapedSlots = Math.ceil((commandEnd - sectionsStart) / MACHO_SECTION_64_BYTES)
  const forgedAt = sectionsStart + escapedSlots * MACHO_SECTION_64_BYTES
  if (forgedAt + MACHO_SECTION_64_BYTES > binary.byteLength) {
    throw new Error("fixture has no room past its load commands for an escaped section")
  }
  binary.writeUInt32LE(escapedSlots + 1, command.offset + MACHO_SEGMENT_64_NSECTS)
  binary.fill(0, forgedAt, forgedAt + MACHO_SECTION_64_BYTES)
  binary.write("__bun", forgedAt, 5, "latin1")
  binary.write("__BUN", forgedAt + MACHO_SECTION_64_SEGNAME, 5, "latin1")
  binary.writeBigUInt64LE(binary.readBigUInt64LE(source + MACHO_SECTION_64_SIZE), forgedAt + MACHO_SECTION_64_SIZE)
  binary.writeUInt32LE(binary.readUInt32LE(source + MACHO_SECTION_64_OFFSET), forgedAt + MACHO_SECTION_64_OFFSET)
  return forgedAt
}

/**
 * Read the graph layout straight out of a real ELF `.bun` section. The tests
 * use this to pin the byte arithmetic the parser has to agree with; the parser
 * itself never takes this shortcut.
 */
function readGraphLayout(bytes: Buffer): GraphLayout {
  const bun = requireElfSection(bytes, ".bun")
  const payloadStart = bun.offset + 8
  const payloadLength = bun.size - 8
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