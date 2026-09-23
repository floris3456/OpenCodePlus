/**
 * Structural canonicalizer for `bun build --compile` output.
 *
 * `bun build --compile` (esm + bytecode + splitting) is not byte-reproducible:
 * the bundler draws a random u64 "unique key" per build and prints it as 16
 * lowercase hex characters at the head of every chunk token. Each token is a
 * string-table entry inside the executable's shared bytecode string table, and
 * that table also stores a 24-bit hash derived from the token, so a new key
 * moves those bytes too.
 *
 *     [u32 LE: length word]           bit 31 is JavaScriptCore's `is8Bit` flag,
 *                                     bits 0..30 are the count
 *     [u32 LE: hash]                  low 24 bits used, top 8 bits always zero
 *     [count-based data bytes]        8-bit (latin1) entry: the count is a byte
 *                                     count; UTF-16 entry (flag clear): the count
 *                                     is a code-unit count, so count * 2 bytes
 *     [padding to 4 bytes]
 *
 * Bit 31 is not a required marker; it records the string width, and the real
 * table holds both widths. The stored hash is `rapidhash(raw entry bytes) &
 * 0xffffff` over the byte length in both cases. A chunk token is ASCII by
 * construction, so only 8-bit entries are ever eligible as records: a UTF-16
 * entry is parsed and validated but never normalized, and a difference inside
 * one surfaces as a residual difference like any other underivable byte.
 *
 * This module proves that difference set for a concrete pair of outputs rather
 * than assuming it. Eligibility is anchored in parsed structure, never in a
 * pattern match over raw bytes:
 *
 *   1. The buffer must be an executable with a Bun standalone payload:
 *      ELF64-LE with `e_type` `ET_EXEC` and a `.bun` section, or Mach-O64-LE
 *      with filetype `MH_EXECUTE` and a `__BUN,__bun` section.
 *      The section is bounds-checked and must lie inside a loadable segment
 *      that validates as one: an ELF `PT_LOAD` whose file range fits the file,
 *      or a Mach-O `__BUN` segment whose own name and file range say so and
 *      contain the section.
 *   2. The payload is `[u64 length][graph bytes][Offsets][trailer]`. The graph
 *      length, trailer, offsets struct and module table are parsed and
 *      bounds-checked against the section.
 *   3. The module table (52-byte `CompiledModuleGraphFile` records) yields the
 *      subranges owned by each module. The trailing records after the table are
 *      the pinned Bun 1.4.2 tail: one `u32` content hash per module, an
 *      embedded builtin-bytecode record (a `u32` count and that many 12-byte
 *      `{id, offset, length}` entries), an optional bytecode-string-table
 *      {offset, length}, the startup module count, an optional
 *      module-info-string-table {offset, length}, and the
 *      `--compile-exec-argv` string with its NUL terminator as the last byte of
 *      the graph. The argv string and the builtin ranges are located from the
 *      parsed bytes, so every tail byte is accounted for. The announced string
 *      tables must be in bounds, must end in the data region before the module
 *      table (the tail bytes are never a table region), and must be disjoint
 *      from every module subrange, the module table, the builtin ranges and
 *      each other.
 *   4. Only entries of that parsed string table are eligible, and only 8-bit
 *      ones: every entry is re-derived from its own bytes, reserved hash bits
 *      must be zero, the stored hash must equal `rapidhash(raw entry bytes) &
 *      0xffffff` over its byte length, padding must be zero, and the
 *      index/entry layout must be exact. A candidate token-shaped string
 *      outside the table is rejected, not normalized, and so is a UTF-16 entry
 *      whose decoded text happens to spell a token.
 *   5. The key is rewritten to zeros, every hash is recomputed from the
 *      canonical token, and then every remaining byte must be equal. Any byte
 *      the canonicalizer cannot explain is a rejection carrying its offset.
 *
 * Scope limit: this is valid ONLY for comparing two independently rebuilt
 * outputs. Publication, download, install and runtime integrity must keep using
 * exact raw equality against the recorded qualified artifact. Equivalence under
 * this canonicalizer is strictly weaker than raw binary reproducibility.
 *
 * Version pin: the record layout, graph tail and hash derivation below were
 * measured on Bun 1.4.2 output. An unrecognised toolchain or container is
 * refused, not guessed at.
 */

export const CANONICALIZER = {
  id: "bun-compile-chunk-token/v2",
  bunVersion: "1.4.2",
  scope: "rebuild-equivalence-only",
  strength: "weaker-than-raw-binary-reproducibility",
  containers: ["elf64-le:.bun", "macho64-le:__BUN,__bun"],
} as const

const TOKEN_BYTES = 25
const ENTRY_IS_8BIT_FLAG = 0x80000000
const HASH_WORD_OFFSET = 4
const HASH_WORD_BYTES = 4
const TOKEN_OFFSET = 8
const RECORD_ALIGNMENT = 4
const HASH_MASK = 0xffffffn
const KEY_HEX_LENGTH = 16
const TOKEN_PATTERN = /^[0-9a-f]{16}[ACSH][0-9]{8}$/

const TRAILER = "\n---- Bun! ----\n"
const OFFSETS_BYTES = 32
const MODULE_RECORD_BYTES = 52
const MODULE_POINTER_COUNT = 6
const MAX_MODULE_COUNT = 1_000_000
const BUILTIN_ENTRY_BYTES = 12
const MAX_BUILTIN_COUNT = 100_000

/**
 * Tail shapes measured on Bun 1.4.2 (the pinned release toolchain). Directly
 * after the module table come one `u32` source hash per module (`rapidhash(
 * contents) & 0xffffff`), then the embedded builtin-bytecode record: a `u32`
 * count followed by `count` 12-byte `{u32 builtinId, u32 bytecodeOffset, u32
 * bytecodeLength}` entries. A build that imports no `node:`/`bun:` builtins
 * has count 0, which is the four-byte zero word this module previously treated
 * as a sentinel. Then come an optional bytecode string-table {offset, length},
 * the startup module count, an optional module-info string-table {offset,
 * length}, and finally the `--compile-exec-argv` string with its NUL
 * terminator as the graph's last byte. The fixed part is therefore 20 bytes
 * with both tables and 12 with only the bytecode table, plus argv. Anything
 * else is a refusal, not a guess.
 */
const TAIL_FIXED_BYTES_NO_BYTECODE_TABLE = 4
const TAIL_FIXED_BYTES_BYTECODE_TABLE = 8 + 4
const TAIL_FIXED_BYTES_BOTH_TABLES = 8 + 4 + 8

const ELF_MAGIC = [0x7f, 0x45, 0x4c, 0x46] as const
const ELFCLASS64 = 2
const ELFDATA2LSB = 1
const ELF_FILE_TYPE_EXECUTE = 2
const ELF_PROGBITS = 1
const ELF_PT_LOAD = 1
const ELF64_HEADER_BYTES = 64
const ELF64_PROGRAM_HEADER_BYTES = 56
const ELF64_SECTION_HEADER_BYTES = 64
const ELF64_SECTION_NAME_OFFSET = 0x00
const ELF64_SECTION_TYPE_OFFSET = 0x04
const ELF64_SECTION_OFFSET = 0x18
const ELF64_SECTION_SIZE_OFFSET = 0x20
const ELF64_E_TYPE = 0x10
const ELF64_E_PHOFF = 0x20
const ELF64_E_PHENTSIZE = 0x36
const ELF64_E_PHNUM = 0x38
const ELF64_E_SHOFF = 0x28
const ELF64_E_SHENTSIZE = 0x3a
const ELF64_E_SHNUM = 0x3c
const ELF64_E_SHSTRNDX = 0x3e
const ELF64_PH_TYPE = 0x00
const ELF64_PH_OFFSET = 0x08
const ELF64_PH_FILESZ = 0x20

const MACHO64_MAGIC_LE = 0xfeedfacf
const MACHO_HEADER_BYTES = 32
const MACHO_LC_SEGMENT_64 = 0x19
const MACHO_BUN_SEGMENT_NAME = "__BUN"
const MACHO_FILE_TYPE_EXECUTE = 2
const MACHO_HEADER_NCMDS = 0x10
const MACHO_HEADER_SIZEOFCMDS = 0x14
const MACHO_SEGMENT_64_NAME = 0x08
const MACHO_SEGMENT_64_FILEOFF = 0x28
const MACHO_SEGMENT_64_FILESIZE = 0x30
const MACHO_SEGMENT_64_NSECTS = 0x40
const MACHO_SEGMENT_64_SECTIONS = 0x48
const MACHO_SECTION_64_BYTES = 80
const MACHO_SECTION_64_NAME = 0x00
const MACHO_SECTION_64_SEGNAME = 0x10
const MACHO_SECTION_64_SIZE = 0x28
const MACHO_SECTION_64_OFFSET = 0x30

export const CANONICAL_BUNDLER_KEY = "0".repeat(KEY_HEX_LENGTH)

/**
 * Constant fillers that occupy the key field of records emitted from unrelated
 * data. They are excluded by literal value, never by offset or ordinal.
 */
export const FILLER_BUNDLER_KEYS: ReadonlySet<string> = new Set([
  "3333333333333333",
  "7777777777777777",
])

export type RejectionCode =
  | "unsupported-toolchain"
  | "unsupported-executable-format"
  | "executable-structure-malformed"
  | "bun-payload-malformed"
  | "module-graph-malformed"
  | "string-table-locator-malformed"
  | "string-table-malformed"
  | "record-hash-word-reserved-bits"
  | "record-hash-underived"
  | "bundler-key-missing"
  | "bundler-key-ambiguous"
  | "size-mismatch"
  | "record-set-mismatch"
  | "container-mismatch"
  | "residual-difference"

export interface Rejection {
  readonly code: RejectionCode
  readonly detail: string
  readonly offset: number | null
}

export interface ChunkTokenRecord {
  readonly offset: number
  readonly token: string
  readonly key: string
  readonly kind: string
  readonly index: number
  readonly storedHash: number
  readonly bearsBundlerKey: boolean
}

export interface BuildStructure {
  readonly container: "elf" | "macho"
  readonly payloadStart: number
  readonly payloadLength: number
  readonly graphLength: number
  readonly moduleCount: number
  readonly builtinBytecodeCount: number
  readonly modulesStart: number
  readonly modulesLength: number
  readonly moduleRanges: readonly { readonly start: number; readonly end: number }[]
  readonly stringTableStart: number
  readonly stringTableLength: number
  readonly entries: readonly StringTableEntry[]
}

export interface StringTableEntry {
  readonly offset: number
  /**
   * The count stored in the length word: bytes for an 8-bit entry, UTF-16 code
   * units otherwise.
   */
  readonly length: number
  /** Bytes the entry's data occupies: `length`, or `length * 2` for UTF-16. */
  readonly byteLength: number
  /** JSC's `is8Bit` flag: latin1 data when set, UTF-16 code units when clear. */
  readonly is8Bit: boolean
  readonly text: string
  readonly storedHash: number
}

export type BuildStructureOutcome =
  | { readonly ok: true; readonly structure: BuildStructure }
  | { readonly ok: false; readonly rejection: Rejection }

export type CanonicalizationOutcome =
  | {
      readonly ok: true
      readonly container: "elf" | "macho"
      readonly canonical: Buffer
      readonly records: readonly ChunkTokenRecord[]
      readonly bundlerKey: string
      readonly recordsRewritten: number
      readonly stringTableStart: number
      readonly stringTableLength: number
      readonly entriesParsed: number
    }
  | { readonly ok: false; readonly rejection: Rejection }

export type RebuildEquivalence =
  | {
      readonly equivalent: true
      readonly container: "elf" | "macho"
      readonly canonical: Buffer
      readonly recordsParsed: number
      readonly recordsRewritten: number
      readonly bundlerKeys: { readonly left: string; readonly right: string }
      readonly rawIdentical: boolean
      readonly rawDifferingBytes: number
    }
  | { readonly equivalent: false; readonly rejection: Rejection }

/**
 * The frozen derivation for the ASCII token path, measured against real Bun
 * 1.4.2 output. A WTF/SuperFastHash hypothesis was tested and rejected before
 * this one was adopted. Every parsed entry is checked against
 * `deriveEntryHash` over its raw bytes; for an 8-bit entry this function is the
 * same rule spelled as its latin1 text.
 */
export function deriveRecordHash(token: string): number {
  return Number(Bun.hash.rapidhash(Buffer.from(token, "latin1")) & HASH_MASK)
}

/**
 * The same frozen derivation over an entry's raw bytes. 8-bit entries hash
 * `length` bytes; UTF-16 entries hash `length * 2`. Deriving from the bytes
 * rather than a re-encoded string is what makes a UTF-16 entry checkable at
 * all, since only its own bytes round-trip.
 */
function deriveEntryHash(bytes: Uint8Array, offset: number, byteLength: number): number {
  return Number(Bun.hash.rapidhash(bytes.subarray(offset, offset + byteLength)) & HASH_MASK)
}

/**
 * Parse and validate the executable and Bun/JSC container structures, then the
 * graph's module table, trailing records and shared bytecode string table.
 * Exposed so callers can inspect where records are allowed to live; it performs
 * no rewriting.
 */
export function parseBuildStructure(options: {
  readonly bunVersion: string
  readonly bytes: Uint8Array
}): BuildStructureOutcome {
  if (options.bunVersion !== CANONICALIZER.bunVersion) {
    return {
      ok: false,
      rejection: {
        code: "unsupported-toolchain",
        offset: null,
        detail: `${CANONICALIZER.id} is pinned to Bun ${CANONICALIZER.bunVersion}; refusing to guess at the structure of Bun ${options.bunVersion} output`,
      },
    }
  }

  const located = locateBunPayload(options.bytes)
  if (!located.ok) return located

  const parsed = parseGraph(options.bytes, located.payload)
  if (!parsed.ok) return parsed

  return { ok: true, structure: parsed.structure }
}

export function canonicalizeBuildOutput(options: {
  readonly bunVersion: string
  readonly bytes: Uint8Array
}): CanonicalizationOutcome {
  const parsed = parseBuildStructure(options)
  if (!parsed.ok) return parsed

  const structure = parsed.structure
  const records: ChunkTokenRecord[] = []
  for (const entry of structure.entries) {
    // A chunk token is ASCII by construction, so only an 8-bit entry can ever
    // be one. A UTF-16 entry is parsed and hash-checked but never eligible.
    if (!entry.is8Bit) continue
    if (entry.length !== TOKEN_BYTES) continue
    if (!TOKEN_PATTERN.test(entry.text)) continue
    records.push({
      offset: entry.offset,
      token: entry.text,
      key: entry.text.slice(0, KEY_HEX_LENGTH),
      kind: entry.text.slice(KEY_HEX_LENGTH, KEY_HEX_LENGTH + 1),
      index: Number(entry.text.slice(KEY_HEX_LENGTH + 1)),
      storedHash: entry.storedHash,
      bearsBundlerKey: false,
    })
  }

  const observedKeys = [...new Set(records.map((record) => record.key))].filter(
    (key) => !FILLER_BUNDLER_KEYS.has(key),
  )
  if (observedKeys.length === 0) {
    return {
      ok: false,
      rejection: {
        code: "bundler-key-missing",
        offset: null,
        detail: `no bundler unique key found across ${records.length} token(s) in ${structure.entries.length} string-table entr(ies); this is not a structure ${CANONICALIZER.id} recognises`,
      },
    }
  }
  if (observedKeys.length > 1) {
    return {
      ok: false,
      rejection: {
        code: "bundler-key-ambiguous",
        offset: null,
        detail: `expected exactly one bundler unique key, found ${observedKeys.length}: ${observedKeys.join(", ")}`,
      },
    }
  }

  const bundlerKey = observedKeys[0]
  const canonical = Buffer.from(options.bytes)
  const keyed = records.map((record) => ({ ...record, bearsBundlerKey: record.key === bundlerKey }))

  for (const record of keyed) {
    if (!record.bearsBundlerKey) continue
    const canonicalToken = `${CANONICAL_BUNDLER_KEY}${record.token.slice(KEY_HEX_LENGTH)}`
    canonical.write(canonicalToken, record.offset + TOKEN_OFFSET, TOKEN_BYTES, "latin1")
    canonical.writeUInt32LE(deriveRecordHash(canonicalToken), record.offset + HASH_WORD_OFFSET)
  }

  return {
    ok: true,
    container: structure.container,
    canonical,
    records: keyed,
    bundlerKey,
    recordsRewritten: keyed.filter((record) => record.bearsBundlerKey).length,
    stringTableStart: structure.stringTableStart,
    stringTableLength: structure.stringTableLength,
    entriesParsed: structure.entries.length,
  }
}

/**
 * Compare two independently rebuilt outputs. Equality is decided on the
 * canonical images, whose hashes are recomputed rather than copied from the
 * other side, so a byte this canonicalizer cannot derive can never be masked.
 *
 * Because canonicalization only ever touches the key field and the hash word of
 * table entries bearing the single observed bundler key, canonical equality
 * implies that every raw differing byte lies inside one of those spans.
 */
export function compareRebuild(options: {
  readonly bunVersion: string
  readonly left: Uint8Array
  readonly right: Uint8Array
}): RebuildEquivalence {
  if (options.bunVersion !== CANONICALIZER.bunVersion) {
    return {
      equivalent: false,
      rejection: {
        code: "unsupported-toolchain",
        offset: null,
        detail: `${CANONICALIZER.id} is pinned to Bun ${CANONICALIZER.bunVersion}; refusing to guess at the structure of Bun ${options.bunVersion} output`,
      },
    }
  }

  if (options.left.byteLength !== options.right.byteLength) {
    return {
      equivalent: false,
      rejection: {
        code: "size-mismatch",
        offset: null,
        detail: `rebuild outputs differ in size: left ${options.left.byteLength} bytes, right ${options.right.byteLength} bytes`,
      },
    }
  }

  const left = canonicalizeBuildOutput({ bunVersion: options.bunVersion, bytes: options.left })
  if (!left.ok) return { equivalent: false, rejection: labelSide(left.rejection, "left") }

  const right = canonicalizeBuildOutput({ bunVersion: options.bunVersion, bytes: options.right })
  if (!right.ok) return { equivalent: false, rejection: labelSide(right.rejection, "right") }

  if (left.container !== right.container) {
    return {
      equivalent: false,
      rejection: {
        code: "container-mismatch",
        offset: null,
        detail: `rebuild outputs are different containers: left ${left.container}, right ${right.container}`,
      },
    }
  }

  if (left.records.length !== right.records.length) {
    return {
      equivalent: false,
      rejection: {
        code: "record-set-mismatch",
        offset: null,
        detail: `chunk record counts differ: left ${left.records.length}, right ${right.records.length}`,
      },
    }
  }

  for (let index = 0; index < left.records.length; index += 1) {
    const leftOffset = left.records[index].offset
    const rightOffset = right.records[index].offset
    if (leftOffset === rightOffset) continue
    return {
      equivalent: false,
      rejection: {
        code: "record-set-mismatch",
        offset: Math.min(leftOffset, rightOffset),
        detail: `chunk record ${index} sits at ${leftOffset} on the left and ${rightOffset} on the right`,
      },
    }
  }

  if (!left.canonical.equals(right.canonical)) {
    const offset = firstDifference(left.canonical, right.canonical)
    return {
      equivalent: false,
      rejection: {
        code: "residual-difference",
        offset,
        detail: `byte ${offset} still differs after canonicalization (left ${formatByte(left.canonical[offset])}, right ${formatByte(right.canonical[offset])}); ${CANONICALIZER.id} cannot derive it`,
      },
    }
  }

  const rawIdentical = Buffer.compare(options.left, options.right) === 0
  return {
    equivalent: true,
    container: left.container,
    canonical: left.canonical,
    recordsParsed: left.records.length,
    recordsRewritten: left.recordsRewritten,
    bundlerKeys: { left: left.bundlerKey, right: right.bundlerKey },
    rawIdentical,
    rawDifferingBytes: rawIdentical ? 0 : countDifferences(options.left, options.right),
  }
}

interface ContainerPayload {
  readonly container: "elf" | "macho"
  readonly start: number
  readonly length: number
}

type Located = { readonly ok: true; readonly payload: ContainerPayload } | { readonly ok: false; readonly rejection: Rejection }

function locateBunPayload(bytes: Uint8Array): Located {
  if (isElf64Le(bytes)) return locateElfBunPayload(bytes)
  if (isMachO64Le(bytes)) return locateMachO64BunPayload(bytes)
  return {
    ok: false,
    rejection: rejection(
      "unsupported-executable-format",
      null,
      "buffer is not an ELF64-LE or Mach-O64-LE executable with a Bun standalone payload; the old unanchored scan accepted buffers like this and no longer does",
    ),
  }
}

function isElf64Le(bytes: Uint8Array): boolean {
  return (
    ELF_MAGIC.every((byte, index) => bytes[index] === byte) &&
    bytes[4] === ELFCLASS64 &&
    bytes[5] === ELFDATA2LSB
  )
}

function isMachO64Le(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 4 && readUint32LE(bytes, 0) === MACHO64_MAGIC_LE
}

function locateElfBunPayload(bytes: Uint8Array): Located {
  if (bytes.byteLength < ELF64_HEADER_BYTES) return malformedExecutable("ELF image is shorter than its header")
  if (bytes[6] !== 1) return malformedExecutable("ELF identification version is not the pinned layout")
  const fileType = readUint16LE(bytes, ELF64_E_TYPE)
  if (fileType !== ELF_FILE_TYPE_EXECUTE) {
    return malformedExecutable(`ELF file type is ${fileType}, expected ${ELF_FILE_TYPE_EXECUTE}`)
  }

  const programHeaderOffset = readUint64(bytes, ELF64_E_PHOFF)
  const programHeaderSize = readUint16LE(bytes, ELF64_E_PHENTSIZE)
  const programHeaderCount = readUint16LE(bytes, ELF64_E_PHNUM)
  const sectionHeaderOffset = readUint64(bytes, ELF64_E_SHOFF)
  const sectionHeaderSize = readUint16LE(bytes, ELF64_E_SHENTSIZE)
  const sectionHeaderCount = readUint16LE(bytes, ELF64_E_SHNUM)
  const sectionNameIndex = readUint16LE(bytes, ELF64_E_SHSTRNDX)

  if (programHeaderSize !== ELF64_PROGRAM_HEADER_BYTES) return malformedExecutable(`ELF program header size is ${programHeaderSize}, expected ${ELF64_PROGRAM_HEADER_BYTES}`)
  if (sectionHeaderSize !== ELF64_SECTION_HEADER_BYTES) return malformedExecutable(`ELF section header size is ${sectionHeaderSize}, expected ${ELF64_SECTION_HEADER_BYTES}`)
  if (sectionHeaderCount === 0) return malformedExecutable("ELF has no section headers")
  if (sectionNameIndex >= sectionHeaderCount) return malformedExecutable("ELF section name table index is out of range")
  if (!fits(bytes, programHeaderOffset, programHeaderCount * programHeaderSize)) return malformedExecutable("ELF program header table is out of bounds")
  if (!fits(bytes, sectionHeaderOffset, sectionHeaderCount * sectionHeaderSize)) return malformedExecutable("ELF section header table is out of bounds")

  const nameHeader = sectionHeaderOffset + sectionNameIndex * sectionHeaderSize
  const namesStart = readUint64(bytes, nameHeader + ELF64_SECTION_OFFSET)
  const namesLength = readUint64(bytes, nameHeader + ELF64_SECTION_SIZE_OFFSET)
  if (!fits(bytes, namesStart, namesLength)) return malformedExecutable("ELF section name table is out of bounds")

  let bunSection: { offset: number; size: number } | null = null
  for (let index = 0; index < sectionHeaderCount; index += 1) {
    const header = sectionHeaderOffset + index * sectionHeaderSize
    const nameOffset = readUint32LE(bytes, header + ELF64_SECTION_NAME_OFFSET)
    if (nameOffset >= namesLength) continue
    const name = cstringAt(bytes, namesStart + nameOffset, namesLength - nameOffset)
    if (name !== ".bun") continue
    if (bunSection !== null) return malformedExecutable("ELF contains more than one '.bun' section")
    const type = readUint32LE(bytes, header + ELF64_SECTION_TYPE_OFFSET)
    if (type !== ELF_PROGBITS) return malformedExecutable(`ELF '.bun' section has type ${type}, expected ${ELF_PROGBITS}`)
    bunSection = {
      offset: readUint64(bytes, header + ELF64_SECTION_OFFSET),
      size: readUint64(bytes, header + ELF64_SECTION_SIZE_OFFSET),
    }
  }
  if (bunSection === null) {
    return {
      ok: false,
      rejection: rejection(
        "unsupported-executable-format",
        null,
        "ELF image has no '.bun' section; it is not a Bun standalone executable",
      ),
    }
  }
  if (!fits(bytes, bunSection.offset, bunSection.size)) return malformedExecutable("ELF '.bun' section is out of bounds")

  let loadable = false
  for (let index = 0; index < programHeaderCount; index += 1) {
    const header = programHeaderOffset + index * programHeaderSize
    if (readUint32LE(bytes, header + ELF64_PH_TYPE) !== ELF_PT_LOAD) continue
    const segmentOffset = readUint64(bytes, header + ELF64_PH_OFFSET)
    const segmentSize = readUint64(bytes, header + ELF64_PH_FILESZ)
    // A PT_LOAD describes bytes the file must actually hold. Without this
    // bound an out-of-file range would contain the section trivially and pass
    // the containment test while describing nothing.
    if (!fits(bytes, segmentOffset, segmentSize)) {
      return malformedExecutable("ELF PT_LOAD segment file range is out of bounds")
    }
    if (segmentOffset <= bunSection.offset && bunSection.offset + bunSection.size <= segmentOffset + segmentSize) {
      loadable = true
      break
    }
  }
  if (!loadable) return malformedExecutable("ELF '.bun' section is not contained in any PT_LOAD segment")

  return readPayloadHeader(bytes, "elf", bunSection.offset, bunSection.size)
}

function locateMachO64BunPayload(bytes: Uint8Array): Located {
  if (bytes.byteLength < MACHO_HEADER_BYTES) return malformedExecutable("Mach-O image is shorter than its header")
  const fileType = readUint32LE(bytes, 0x0c)
  if (fileType !== MACHO_FILE_TYPE_EXECUTE) return malformedExecutable(`Mach-O file type is ${fileType}, expected ${MACHO_FILE_TYPE_EXECUTE}`)
  const commandCount = readUint32LE(bytes, MACHO_HEADER_NCMDS)
  const commandBytes = readUint32LE(bytes, MACHO_HEADER_SIZEOFCMDS)
  if (commandCount > 4096) return malformedExecutable(`Mach-O load command count ${commandCount} is implausible`)
  if (!fits(bytes, MACHO_HEADER_BYTES, commandBytes)) return malformedExecutable("Mach-O load commands are out of bounds")

  let cursor = MACHO_HEADER_BYTES
  const commandEnd = MACHO_HEADER_BYTES + commandBytes
  let bunSection: { offset: number; size: number } | null = null
  for (let index = 0; index < commandCount; index += 1) {
    if (!fits(bytes, cursor, 8)) return malformedExecutable("Mach-O load command header is out of bounds")
    const command = readUint32LE(bytes, cursor)
    const commandSize = readUint32LE(bytes, cursor + 4)
    if (commandSize < 8 || cursor + commandSize > commandEnd) return malformedExecutable("Mach-O load command size is invalid")
    if (command === MACHO_LC_SEGMENT_64) {
      if (commandSize < MACHO_SEGMENT_64_SECTIONS) return malformedExecutable("Mach-O segment command is too short")
      const sectionCount = readUint32LE(bytes, cursor + MACHO_SEGMENT_64_NSECTS)
      // Section records belong to the load command that declares them: the
      // array may not reach past the command's own size. Bounding it against
      // the whole buffer instead lets an inflated count read later load
      // commands as section headers.
      if (sectionCount * MACHO_SECTION_64_BYTES > commandSize - MACHO_SEGMENT_64_SECTIONS) {
        return malformedExecutable("Mach-O segment section records do not fit their load command")
      }
      for (let section = 0; section < sectionCount; section += 1) {
        const header = cursor + MACHO_SEGMENT_64_SECTIONS + section * MACHO_SECTION_64_BYTES
        const sectionName = fixedCstringAt(bytes, header + MACHO_SECTION_64_NAME, 16)
        const segmentName = fixedCstringAt(bytes, header + MACHO_SECTION_64_SEGNAME, 16)
        if (sectionName !== "__bun" || segmentName !== MACHO_BUN_SEGMENT_NAME) continue
        if (bunSection !== null) return malformedExecutable("Mach-O contains more than one '__BUN,__bun' section")
        // A section header's `segname` is self-asserted. The section is only a
        // Bun section if the load command it lives inside carries the expected
        // name and a file range that contains it.
        const enclosingSegmentName = fixedCstringAt(bytes, cursor + MACHO_SEGMENT_64_NAME, 16)
        if (enclosingSegmentName !== MACHO_BUN_SEGMENT_NAME) {
          return malformedExecutable(
            `Mach-O '__BUN,__bun' section is declared in segment '${enclosingSegmentName}', not the '${MACHO_BUN_SEGMENT_NAME}' segment`,
          )
        }
        const segmentFileOffset = readUint64(bytes, cursor + MACHO_SEGMENT_64_FILEOFF)
        const segmentFileSize = readUint64(bytes, cursor + MACHO_SEGMENT_64_FILESIZE)
        if (!fits(bytes, segmentFileOffset, segmentFileSize)) {
          return malformedExecutable("Mach-O segment file range is out of bounds")
        }
        const sectionOffset = readUint32LE(bytes, header + MACHO_SECTION_64_OFFSET)
        const sectionSize = readUint64(bytes, header + MACHO_SECTION_64_SIZE)
        if (sectionOffset < segmentFileOffset || sectionOffset + sectionSize > segmentFileOffset + segmentFileSize) {
          return malformedExecutable("Mach-O '__BUN,__bun' section is not contained in its segment's file range")
        }
        bunSection = { offset: sectionOffset, size: sectionSize }
      }
    }
    cursor += commandSize
  }
  if (cursor !== commandEnd) return malformedExecutable("Mach-O load commands do not fill the declared size")
  if (bunSection === null) {
    return {
      ok: false,
      rejection: rejection(
        "unsupported-executable-format",
        null,
        "Mach-O image has no '__BUN,__bun' section; it is not a Bun standalone executable",
      ),
    }
  }
  if (!fits(bytes, bunSection.offset, bunSection.size)) return malformedExecutable("Mach-O '__BUN,__bun' section is out of bounds")
  return readPayloadHeader(bytes, "macho", bunSection.offset, bunSection.size)
}

/**
 * The Bun payload is `[u64 LE length][payload]` inside its section. The length
 * must account for exactly the remaining section bytes.
 */
function readPayloadHeader(
  bytes: Uint8Array,
  container: "elf" | "macho",
  sectionOffset: number,
  sectionSize: number,
): Located {
  if (sectionSize < 8 + OFFSETS_BYTES + TRAILER.length) return malformedExecutable("Bun payload section is too small to hold a graph, offsets and trailer")
  const length = readUint64(bytes, sectionOffset)
  if (length !== sectionSize - 8) return malformedExecutable(`Bun payload length prefix is ${length}, section holds ${sectionSize - 8}`)
  return { ok: true, payload: { container, start: sectionOffset + 8, length } }
}

function parseGraph(
  bytes: Uint8Array,
  payload: ContainerPayload,
): { readonly ok: true; readonly structure: BuildStructure } | { readonly ok: false; readonly rejection: Rejection } {
  const payloadEnd = payload.start + payload.length
  const trailerStart = payloadEnd - TRAILER.length
  if (textAt(bytes, trailerStart, TRAILER.length) !== TRAILER) {
    return payloadMalformed(trailerStart, "Bun payload does not end with the pinned '---- Bun! ----' trailer")
  }
  const offsetsStart = trailerStart - OFFSETS_BYTES
  if (offsetsStart < payload.start) return payloadMalformed(null, "Bun payload is shorter than its offsets struct")

  const byteCount = readUint64(bytes, offsetsStart)
  if (byteCount === 0 || byteCount > payload.length) return payloadMalformed(offsetsStart, `graph byte count ${byteCount} does not fit the ${payload.length}-byte payload`)
  if (offsetsStart - payload.start !== byteCount) {
    return payloadMalformed(
      offsetsStart,
      `graph byte count ${byteCount} does not place the offsets struct at the end of the payload (payload holds ${payload.length} bytes)`,
    )
  }

  const modules = {
    offset: readUint32LE(bytes, offsetsStart + 8),
    length: readUint32LE(bytes, offsetsStart + 12),
  }
  const entryPointId = readUint32LE(bytes, offsetsStart + 16)
  const argv = {
    offset: readUint32LE(bytes, offsetsStart + 20),
    length: readUint32LE(bytes, offsetsStart + 24),
  }

  if (modules.length === 0 || modules.length % MODULE_RECORD_BYTES !== 0) {
    return payloadMalformed(offsetsStart + 12, `module table length ${modules.length} is not a non-zero multiple of ${MODULE_RECORD_BYTES}`)
  }
  if (!fitsGraph(modules.offset, modules.length, byteCount)) {
    return payloadMalformed(offsetsStart + 8, `module table (${modules.offset} + ${modules.length}) is outside the ${byteCount}-byte graph`)
  }
  if (!fitsGraph(argv.offset, argv.length, byteCount)) {
    return payloadMalformed(offsetsStart + 20, `compile argv pointer (${argv.offset} + ${argv.length}) is outside the ${byteCount}-byte graph`)
  }

  const moduleCount = modules.length / MODULE_RECORD_BYTES
  if (moduleCount > MAX_MODULE_COUNT) return payloadMalformed(offsetsStart + 12, `module count ${moduleCount} is implausible`)
  if (entryPointId >= moduleCount) {
    return payloadMalformed(offsetsStart + 16, `entry point id ${entryPointId} is not below the module count ${moduleCount}`)
  }

  const modulesStart = payload.start + modules.offset
  const moduleRanges: { start: number; end: number }[] = []
  for (let index = 0; index < moduleCount; index += 1) {
    const base = modulesStart + index * MODULE_RECORD_BYTES
    for (let pointer = 0; pointer < MODULE_POINTER_COUNT; pointer += 1) {
      const offset = readUint32LE(bytes, base + pointer * 8)
      const length = readUint32LE(bytes, base + pointer * 8 + 4)
      if (!fitsGraph(offset, length, byteCount)) {
        return graphMalformed(base + pointer * 8, `module ${index} pointer ${pointer} (${offset} + ${length}) is outside the ${byteCount}-byte graph`)
      }
      if (length > 0) moduleRanges.push({ start: payload.start + offset, end: payload.start + offset + length })
    }
    const encoding = bytes[base + 48]
    const loader = bytes[base + 49]
    const moduleFormat = bytes[base + 50]
    const side = bytes[base + 51]
    if (encoding > 2) return graphMalformed(base + 48, `module ${index} has unknown encoding ${encoding}`)
    if (loader > 20) return graphMalformed(base + 49, `module ${index} has unknown loader ${loader}`)
    if (moduleFormat > 2) return graphMalformed(base + 50, `module ${index} has unknown module format ${moduleFormat}`)
    if (side > 1) return graphMalformed(base + 51, `module ${index} has unknown side ${side}`)
  }

  const tailStart = payload.start + modules.offset + modules.length
  const tailLength = byteCount - (modules.offset + modules.length)
  if (tailLength < moduleCount * 4 + 4 + TAIL_FIXED_BYTES_NO_BYTECODE_TABLE + argv.length + 1) {
    return locatorMalformed(tailStart, `trailing records hold ${tailLength} bytes; at least ${moduleCount * 4 + 4 + TAIL_FIXED_BYTES_NO_BYTECODE_TABLE + argv.length + 1} are required for ${moduleCount} modules and ${argv.length} argv byte(s)`)
  }

  // The writer appends the compile argv string last, so its NUL terminator is
  // the final byte of the graph and the string itself ends one byte earlier.
  // That anchors the tail's end independently of the fixed fields below.
  if (argv.offset + argv.length + 1 !== byteCount) {
    return locatorMalformed(
      offsetsStart + 20,
      `compile argv (${argv.offset} + ${argv.length}) does not end at the last byte of the ${byteCount}-byte graph`,
    )
  }
  if (bytes[payload.start + byteCount - 1] !== 0) {
    return locatorMalformed(payload.start + byteCount - 1, "compile argv NUL terminator is not zero")
  }

  let cursor = tailStart + moduleCount * 4
  let remaining = tailLength - moduleCount * 4

  // Embedded builtin bytecode: `u32 count` plus `count` 12-byte entries. A
  // build without node:/bun: builtins writes count 0, so this word is present
  // in every pinned tail.
  const builtinBytecodeCount = readUint32LE(bytes, cursor)
  if (builtinBytecodeCount > MAX_BUILTIN_COUNT) {
    return locatorMalformed(cursor, `embedded builtin bytecode count ${builtinBytecodeCount} is implausible`)
  }
  cursor += 4
  remaining -= 4
  if (builtinBytecodeCount * BUILTIN_ENTRY_BYTES > remaining) {
    return locatorMalformed(
      cursor,
      `embedded builtin bytecode record (${builtinBytecodeCount} entries) does not fit the ${remaining} remaining tail bytes`,
    )
  }
  const builtinRanges: { start: number; end: number }[] = []
  for (let index = 0; index < builtinBytecodeCount; index += 1) {
    const offset = readUint32LE(bytes, cursor + 4)
    const length = readUint32LE(bytes, cursor + 8)
    if (!fitsGraph(offset, length, byteCount)) {
      return locatorMalformed(
        cursor + 4,
        `embedded builtin bytecode ${index} (${offset} + ${length}) is outside the ${byteCount}-byte graph`,
      )
    }
    if (offset + length > modules.offset) {
      return locatorMalformed(
        cursor + 4,
        `embedded builtin bytecode ${index} (${offset} + ${length}) is not in the data region before the module table at ${modules.offset}`,
      )
    }
    if (length > 0) builtinRanges.push({ start: payload.start + offset, end: payload.start + offset + length })
    cursor += BUILTIN_ENTRY_BYTES
    remaining -= BUILTIN_ENTRY_BYTES
  }

  let fixed = remaining - argv.length - 1
  let bytecodeTable: { offset: number; length: number } | null = null
  let moduleInfoTable: { offset: number; length: number } | null = null
  if (fixed === TAIL_FIXED_BYTES_BYTECODE_TABLE || fixed === TAIL_FIXED_BYTES_BOTH_TABLES) {
    bytecodeTable = { offset: readUint32LE(bytes, cursor), length: readUint32LE(bytes, cursor + 4) }
    cursor += 8
    remaining -= 8
    fixed -= 8
  } else if (fixed !== TAIL_FIXED_BYTES_NO_BYTECODE_TABLE) {
    return locatorMalformed(
      tailStart,
      `trailing records are ${tailLength} bytes for ${moduleCount} module(s) and ${argv.length} argv byte(s); the pinned Bun 1.4.2 tails are ${moduleCount * 4 + 4 + TAIL_FIXED_BYTES_NO_BYTECODE_TABLE + argv.length + 1}, ${moduleCount * 4 + 4 + TAIL_FIXED_BYTES_BYTECODE_TABLE + argv.length + 1} or ${moduleCount * 4 + 4 + TAIL_FIXED_BYTES_BOTH_TABLES + argv.length + 1} bytes`,
    )
  }

  const startupModuleCount = readUint32LE(bytes, cursor)
  if (startupModuleCount > moduleCount) {
    return locatorMalformed(cursor, `startup module count ${startupModuleCount} exceeds module count ${moduleCount}`)
  }
  cursor += 4
  remaining -= 4
  fixed -= 4

  if (fixed === 8) {
    moduleInfoTable = { offset: readUint32LE(bytes, cursor), length: readUint32LE(bytes, cursor + 4) }
    cursor += 8
    remaining -= 8
    fixed -= 8
  }
  if (fixed !== 0) {
    return locatorMalformed(cursor, `trailing records leave ${fixed} bytes unaccounted for after the pinned fields`)
  }
  if (remaining !== argv.length + 1) {
    return locatorMalformed(cursor, `trailing records leave ${remaining} bytes; the compile argv string and its terminator are ${argv.length + 1}`)
  }
  if (cursor !== payload.start + argv.offset) {
    return locatorMalformed(cursor, `the pinned tail ends at ${cursor - payload.start}, but the compile argv string starts at ${argv.offset}`)
  }
  const argvStart = payload.start + argv.offset
  const argvEnd = argvStart + argv.length
  const overlapsModule = moduleRanges.some((range) => argvStart < range.end && range.start < argvEnd)
  if (overlapsModule) return locatorMalformed(argvStart, "compile argv bytes overlap a module subrange")
  if (argvStart < modulesStart + modules.length && modulesStart < argvEnd) {
    return locatorMalformed(argvStart, "compile argv bytes overlap the module table")
  }
  const overlapsBuiltin = builtinRanges.some((range) => argvStart < range.end && range.start < argvEnd)
  if (overlapsBuiltin) return locatorMalformed(argvStart, "compile argv bytes overlap embedded builtin bytecode")
  if (bytecodeTable === null) {
    return {
      ok: false,
      rejection: rejection(
        "bundler-key-missing",
        null,
        "this Bun standalone payload carries no shared bytecode string table (it was not built with --bytecode), so it has no anchored place for chunk-token records",
      ),
    }
  }
  for (const table of [bytecodeTable, moduleInfoTable]) {
    if (table === null) continue
    if (table.length === 0) return locatorMalformed(tailStart, "announced string table region is empty")
    if (!fitsGraph(table.offset, table.length, byteCount)) {
      return locatorMalformed(tailStart, `announced string table (${table.offset} + ${table.length}) is outside the ${byteCount}-byte graph`)
    }
    const start = payload.start + table.offset
    const end = start + table.length
    // Every byte from the module table on is owned by the parsed module table
    // and the pinned trailing records (content hashes, builtin record, table
    // locators, startup count, argv and its NUL). A table that reaches into
    // that region aliases them: an argv string could be announced as a string
    // table and normalized. Measured on Bun 1.4.2 output, both tables always
    // end at or before the module table.
    if (table.offset + table.length > modules.offset) {
      return locatorMalformed(
        start,
        `announced string table (${table.offset} + ${table.length}) does not end in the ${modules.offset}-byte data region before the module table`,
      )
    }
    const overlapsModule = moduleRanges.some((range) => start < range.end && range.start < end)
    if (overlapsModule) return locatorMalformed(start, "announced string table region overlaps a module subrange")
    const overlapsModules = start < modulesStart + modules.length && modulesStart < end
    if (overlapsModules) return locatorMalformed(start, "announced string table region overlaps the module table")
    const overlapsBuiltin = builtinRanges.some((range) => start < range.end && range.start < end)
    if (overlapsBuiltin) return locatorMalformed(start, "announced string table region overlaps embedded builtin bytecode")
  }
  if (
    bytecodeTable !== null &&
    moduleInfoTable !== null &&
    bytecodeTable.offset < moduleInfoTable.offset + moduleInfoTable.length &&
    moduleInfoTable.offset < bytecodeTable.offset + bytecodeTable.length
  ) {
    return locatorMalformed(
      payload.start + bytecodeTable.offset,
      "announced bytecode and module-info string tables overlap",
    )
  }

  const stringTableStart = payload.start + bytecodeTable.offset
  const stringTableEnd = stringTableStart + bytecodeTable.length
  const entries = parseStringTable(bytes, stringTableStart, stringTableEnd)
  if (!entries.ok) return entries

  return {
    ok: true,
    structure: {
      container: payload.container,
      payloadStart: payload.start,
      payloadLength: payload.length,
      graphLength: byteCount,
      moduleCount,
      builtinBytecodeCount,
      modulesStart,
      modulesLength: modules.length,
      moduleRanges,
      stringTableStart,
      stringTableLength: bytecodeTable.length,
      entries: entries.entries,
    },
  }
}

/**
 * The shared bytecode string table is `[u32 count][u32 offsets[count]]` followed
 * by `count` entries at those table-relative offsets. Bit 31 of an entry's
 * length word is JSC's `is8Bit` flag, so an entry is either `length` latin1
 * bytes or `length` UTF-16 code units; the stored hash is derived over the raw
 * bytes either way. Every entry is re-derived from its own bytes and the table
 * must consume its region exactly.
 */
function parseStringTable(
  bytes: Uint8Array,
  start: number,
  end: number,
): { readonly ok: true; readonly entries: readonly StringTableEntry[] } | { readonly ok: false; readonly rejection: Rejection } {
  if (end - start < 8) return stringTableMalformed(start, "string table is too small for a count and one offset")
  const count = readUint32LE(bytes, start)
  if (count > (end - start - 4) / 4) return stringTableMalformed(start, `string table count ${count} does not fit the ${end - start}-byte region`)
  const indexEnd = start + 4 + count * 4

  const entries: StringTableEntry[] = []
  let expected = indexEnd
  for (let index = 0; index < count; index += 1) {
    const relative = readUint32LE(bytes, start + 4 + index * 4)
    if (relative % RECORD_ALIGNMENT !== 0) return stringTableMalformed(start + 4 + index * 4, `string table entry ${index} offset ${relative} is not ${RECORD_ALIGNMENT}-byte aligned`)
    const entryStart = start + relative
    if (entryStart !== expected) {
      return stringTableMalformed(entryStart, `string table entry ${index} starts at ${relative}, expected ${expected - start}`)
    }
    if (!fits(bytes, entryStart, 8)) return stringTableMalformed(entryStart, `string table entry ${index} length word is out of bounds`)
    const lengthWord = readUint32LE(bytes, entryStart)
    // Bit 31 is JSC's `is8Bit` flag, not a required marker: it selects the
    // width, so the count is bytes for an 8-bit entry and UTF-16 code units
    // (count * 2 bytes) otherwise.
    const is8Bit = (lengthWord & ENTRY_IS_8BIT_FLAG) !== 0
    const length = lengthWord & 0x7fffffff
    const byteLength = is8Bit ? length : length * 2
    if (byteLength === 0 || byteLength > end - entryStart - 8) {
      return stringTableMalformed(
        entryStart,
        `string table entry ${index} declares ${length} ${is8Bit ? "byte(s)" : "UTF-16 code unit(s)"}, which does not fit the table`,
      )
    }
    const storedHash = readUint32LE(bytes, entryStart + HASH_WORD_OFFSET)
    if (storedHash >>> 24 !== 0) {
      return {
        ok: false,
        rejection: {
          code: "record-hash-word-reserved-bits",
          offset: entryStart,
          detail: `string table entry at ${entryStart} carries hash word ${formatWord(storedHash)}; the top 8 bits must be zero`,
        },
      }
    }
    const dataStart = entryStart + TOKEN_OFFSET
    const text = is8Bit
      ? textAt(bytes, dataStart, byteLength)
      : utf16At(bytes, dataStart, length)
    const derived = deriveEntryHash(bytes, dataStart, byteLength)
    if (storedHash !== derived) {
      return {
        ok: false,
        rejection: {
          code: "record-hash-underived",
          offset: entryStart,
          detail: `string table entry at ${entryStart} stores hash ${formatWord(storedHash)} but its ${is8Bit ? "8-bit" : "UTF-16"} data (${byteLength} byte(s)) derives ${formatWord(derived)}`,
        },
      }
    }
    const unpadded = dataStart + byteLength
    expected = start + align4(unpadded - start)
    for (let pad = unpadded; pad < expected; pad += 1) {
      if (bytes[pad] !== 0) return stringTableMalformed(pad, `string table entry ${index} padding byte is ${formatByte(bytes[pad])}, expected 0x00`)
    }
    entries.push({ offset: entryStart, length, byteLength, is8Bit, text, storedHash })
  }

  if (expected !== end) return stringTableMalformed(expected, `string table entries end at ${expected - start}, table region ends at ${end - start}`)
  return { ok: true, entries }
}

function rejection(code: RejectionCode, offset: number | null, detail: string): Rejection {
  return { code, offset, detail }
}

function malformedExecutable(detail: string): Located {
  return { ok: false, rejection: rejection("executable-structure-malformed", null, detail) }
}

function payloadMalformed(offset: number | null, detail: string): { readonly ok: false; readonly rejection: Rejection } {
  return { ok: false, rejection: rejection("bun-payload-malformed", offset, detail) }
}

function graphMalformed(offset: number | null, detail: string): { readonly ok: false; readonly rejection: Rejection } {
  return { ok: false, rejection: rejection("module-graph-malformed", offset, detail) }
}

function locatorMalformed(offset: number | null, detail: string): { readonly ok: false; readonly rejection: Rejection } {
  return { ok: false, rejection: rejection("string-table-locator-malformed", offset, detail) }
}

function stringTableMalformed(offset: number | null, detail: string): { readonly ok: false; readonly rejection: Rejection } {
  return { ok: false, rejection: rejection("string-table-malformed", offset, detail) }
}

function labelSide(rejection: Rejection, side: "left" | "right"): Rejection {
  return { ...rejection, detail: `${side}: ${rejection.detail}` }
}

function fits(bytes: Uint8Array, offset: number, length: number): boolean {
  return offset >= 0 && length >= 0 && offset + length <= bytes.byteLength
}

function fitsGraph(offset: number, length: number, graphLength: number): boolean {
  return offset >= 0 && length >= 0 && offset + length <= graphLength
}

function align4(value: number): number {
  return (value + RECORD_ALIGNMENT - 1) & ~(RECORD_ALIGNMENT - 1)
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8)
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  )
}

function readUint64(bytes: Uint8Array, offset: number): number {
  let value = 0n
  for (let index = 7; index >= 0; index -= 1) value = (value << 8n) | BigInt(bytes[offset + index])
  // A legitimate offset or length always fits a safe integer; anything larger is
  // malformed and is clamped so every bounds check refuses it.
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value)
}

function textAt(bytes: Uint8Array, offset: number, length: number): string {
  return Buffer.from(bytes.subarray(offset, offset + length)).toString("latin1")
}

function utf16At(bytes: Uint8Array, offset: number, codeUnits: number): string {
  return Buffer.from(bytes.subarray(offset, offset + codeUnits * 2)).toString("utf16le")
}

function cstringAt(bytes: Uint8Array, offset: number, limit: number): string {
  let end = offset
  const stop = Math.min(offset + limit, bytes.byteLength)
  while (end < stop && bytes[end] !== 0) end += 1
  return textAt(bytes, offset, end - offset)
}

function fixedCstringAt(bytes: Uint8Array, offset: number, width: number): string {
  let end = offset + width
  while (end > offset && bytes[end - 1] === 0) end -= 1
  return textAt(bytes, offset, end - offset)
}

function firstDifference(left: Uint8Array, right: Uint8Array): number {
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return index
  }
  return -1
}

function countDifferences(left: Uint8Array, right: Uint8Array): number {
  let count = 0
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) count += 1
  }
  return count
}

function formatWord(value: number): string {
  return `0x${value.toString(16).padStart(HASH_WORD_BYTES * 2, "0")}`
}

function formatByte(value: number): string {
  return `0x${value.toString(16).padStart(2, "0")}`
}