/**
 * Structural canonicalizer for `bun build --compile` output.
 *
 * `bun build --compile` (esm + bytecode + splitting) is not byte-reproducible:
 * the bundler draws a random u64 "unique key" per build and prints it as 16
 * lowercase hex characters at the head of every chunk token. Each token is
 * stored in a packed, 4-byte-aligned record that also carries a 24-bit hash
 * derived from the token, so a new key moves those bytes too.
 *
 *     [u32 LE: 0x80000000 | 25]   length word, flag set, length always 25
 *     [u32 LE: hash]              low 24 bits used, top 8 bits always zero
 *     [25 bytes: token]           {key:16 hex}{KIND:1 upper}{index:08 digits}
 *     [3 bytes: padding]
 *
 * This module proves that difference set for a concrete pair of outputs rather
 * than assuming it. Every record is re-derived from its own bytes, the key is
 * rewritten to zeros, every hash is recomputed from the canonical token, and
 * then every remaining byte must be equal. Any byte it cannot explain is a
 * rejection carrying its offset.
 *
 * Scope limit: this is valid ONLY for comparing two independently rebuilt
 * outputs. Publication, download, install and runtime integrity must keep using
 * exact raw equality against the recorded qualified artifact. Equivalence under
 * this canonicalizer is strictly weaker than raw binary reproducibility.
 *
 * Version pin: the record layout and the hash derivation below were measured on
 * Bun 1.4.2 output. An unrecognised toolchain is refused, not guessed at.
 */

export const CANONICALIZER = {
  id: "bun-compile-chunk-token/v1",
  bunVersion: "1.4.2",
  scope: "rebuild-equivalence-only",
  strength: "weaker-than-raw-binary-reproducibility",
} as const

const TOKEN_BYTES = 25
const RECORD_LENGTH_FLAG = 0x80000000
const RECORD_HEADER_WORD = (RECORD_LENGTH_FLAG | TOKEN_BYTES) >>> 0
const RECORD_HEADER_LEAD_BYTE = RECORD_HEADER_WORD & 0xff
const HASH_WORD_OFFSET = 4
const HASH_WORD_BYTES = 4
const TOKEN_OFFSET = 8
const RECORD_PADDING_BYTES = 3
const RECORD_BYTES = TOKEN_OFFSET + TOKEN_BYTES + RECORD_PADDING_BYTES
const RECORD_ALIGNMENT = 4
const HASH_MASK = 0xffffffn
const KEY_HEX_LENGTH = 16
const TOKEN_PATTERN = /^[0-9a-f]{16}[A-Z][0-9]{8}$/

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
  | "record-hash-word-reserved-bits"
  | "record-hash-underived"
  | "bundler-key-missing"
  | "bundler-key-ambiguous"
  | "size-mismatch"
  | "record-set-mismatch"
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

export type CanonicalizationOutcome =
  | {
      readonly ok: true
      readonly canonical: Buffer
      readonly records: readonly ChunkTokenRecord[]
      readonly bundlerKey: string
      readonly recordsRewritten: number
    }
  | { readonly ok: false; readonly rejection: Rejection }

export type RebuildEquivalence =
  | {
      readonly equivalent: true
      readonly canonical: Buffer
      readonly recordsParsed: number
      readonly recordsRewritten: number
      readonly bundlerKeys: { readonly left: string; readonly right: string }
      readonly rawIdentical: boolean
      readonly rawDifferingBytes: number
    }
  | { readonly equivalent: false; readonly rejection: Rejection }

/**
 * The frozen derivation, measured against real Bun 1.4.2 output on 376/376
 * records across two independent builds. A WTF/SuperFastHash hypothesis was
 * tested and rejected (0/184) before this one was adopted.
 */
export function deriveRecordHash(token: string): number {
  return Number(Bun.hash.rapidhash(Buffer.from(token, "latin1")) & HASH_MASK)
}

export function canonicalizeBuildOutput(options: {
  readonly bunVersion: string
  readonly bytes: Uint8Array
}): CanonicalizationOutcome {
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

  const records: Omit<ChunkTokenRecord, "bearsBundlerKey">[] = []
  const bytes = options.bytes
  const limit = bytes.byteLength - RECORD_BYTES

  for (let offset = 0; offset <= limit; offset += RECORD_ALIGNMENT) {
    if (bytes[offset] !== RECORD_HEADER_LEAD_BYTE) continue
    if (readUint32LE(bytes, offset) !== RECORD_HEADER_WORD) continue

    const token = Buffer.from(
      bytes.subarray(offset + TOKEN_OFFSET, offset + TOKEN_OFFSET + TOKEN_BYTES),
    ).toString("latin1")
    if (!TOKEN_PATTERN.test(token)) continue

    const storedHash = readUint32LE(bytes, offset + HASH_WORD_OFFSET)
    if (storedHash >>> 24 !== 0) {
      return {
        ok: false,
        rejection: {
          code: "record-hash-word-reserved-bits",
          offset,
          detail: `chunk record at ${offset} carries hash word ${formatWord(storedHash)}; the top 8 bits must be zero`,
        },
      }
    }

    const derived = deriveRecordHash(token)
    if (storedHash !== derived) {
      return {
        ok: false,
        rejection: {
          code: "record-hash-underived",
          offset,
          detail: `chunk record at ${offset} stores hash ${formatWord(storedHash)} but token '${token}' derives ${formatWord(derived)}`,
        },
      }
    }

    records.push({
      offset,
      token,
      key: token.slice(0, KEY_HEX_LENGTH),
      kind: token.slice(KEY_HEX_LENGTH, KEY_HEX_LENGTH + 1),
      index: Number(token.slice(KEY_HEX_LENGTH + 1)),
      storedHash,
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
        detail: `no bundler unique key found across ${records.length} chunk record(s); this is not a structure ${CANONICALIZER.id} recognises`,
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
  const canonical = Buffer.from(bytes)
  const keyed = records.map((record) => ({
    ...record,
    bearsBundlerKey: record.key === bundlerKey,
  }))

  for (const record of keyed) {
    if (!record.bearsBundlerKey) continue
    const canonicalToken = `${CANONICAL_BUNDLER_KEY}${record.token.slice(KEY_HEX_LENGTH)}`
    canonical.write(canonicalToken, record.offset + TOKEN_OFFSET, TOKEN_BYTES, "latin1")
    canonical.writeUInt32LE(deriveRecordHash(canonicalToken), record.offset + HASH_WORD_OFFSET)
  }

  return {
    ok: true,
    canonical,
    records: keyed,
    bundlerKey,
    recordsRewritten: keyed.filter((record) => record.bearsBundlerKey).length,
  }
}

/**
 * Compare two independently rebuilt outputs. Equality is decided on the
 * canonical images, whose hashes are recomputed rather than copied from the
 * other side, so a byte this canonicalizer cannot derive can never be masked.
 *
 * Because canonicalization only ever touches the key field and the hash word of
 * records bearing the single observed bundler key, canonical equality implies
 * that every raw differing byte lies inside one of those spans.
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
    canonical: left.canonical,
    recordsParsed: left.records.length,
    recordsRewritten: left.recordsRewritten,
    bundlerKeys: { left: left.bundlerKey, right: right.bundlerKey },
    rawIdentical,
    rawDifferingBytes: rawIdentical ? 0 : countDifferences(options.left, options.right),
  }
}

function labelSide(rejection: Rejection, side: "left" | "right"): Rejection {
  return { ...rejection, detail: `${side}: ${rejection.detail}` }
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
