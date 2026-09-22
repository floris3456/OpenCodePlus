import { describe, expect, test } from "bun:test"
import {
  CANONICALIZER,
  CANONICAL_BUNDLER_KEY,
  canonicalizeBuildOutput,
  compareRebuild,
  deriveRecordHash,
} from "../../script/release/canonicalize.js"

const BUN = CANONICALIZER.bunVersion

// The measured wire form, restated here so the tests pin the layout rather than
// inherit it from the implementation under test.
const HEADER_WORD = 0x80000019
const HASH_WORD_AT = 4
const TOKEN_AT = 8
const TOKEN_BYTES = 25
const RECORD_BYTES = 36
const RECORD_PITCH = 64
const PREAMBLE = 128

const KEY_A = "a1b2c3d4e5f60718"
const KEY_B = "b0b0b0b0b0b0b0b0"
const FILLER_3 = "3333333333333333"
const FILLER_7 = "7777777777777777"

interface RecordSpec {
  readonly key: string
  readonly index: number
  readonly kind?: string
  readonly hash?: number
  readonly headerWord?: number
}

function tokenFor(spec: RecordSpec): string {
  return `${spec.key}${spec.kind ?? "C"}${String(spec.index).padStart(8, "0")}`
}

function recordOffset(position: number): number {
  return PREAMBLE + position * RECORD_PITCH
}

function buildBinary(specs: readonly RecordSpec[]): Buffer {
  const binary = Buffer.alloc(PREAMBLE * 2 + specs.length * RECORD_PITCH)
  // Deterministic non-zero filler standing in for surrounding machine code. The
  // stride never produces two consecutive zero bytes, so it cannot accidentally
  // spell a header word.
  for (let index = 0; index < binary.length; index += 1) binary[index] = (index * 31 + 7) & 0xff

  specs.forEach((spec, position) => {
    const offset = recordOffset(position)
    const token = tokenFor(spec)
    binary.writeUInt32LE(spec.headerWord ?? HEADER_WORD, offset)
    binary.writeUInt32LE(spec.hash ?? deriveRecordHash(token), offset + HASH_WORD_AT)
    binary.write(token, offset + TOKEN_AT, TOKEN_BYTES, "latin1")
    binary.fill(0, offset + TOKEN_AT + TOKEN_BYTES, offset + RECORD_BYTES)
  })

  return binary
}

const GRAPH: readonly RecordSpec[] = [
  { key: FILLER_3, index: 0 },
  { key: KEY_A, index: 1 },
  { key: KEY_A, index: 2, kind: "A" },
  { key: FILLER_7, index: 3 },
  { key: KEY_A, index: 4 },
]

function rebuildWith(key: string): Buffer {
  return buildBinary(GRAPH.map((spec) => (spec.key === KEY_A ? { ...spec, key } : spec)))
}

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
    const outcome = canonicalizeBuildOutput({ bunVersion: "1.4.3", bytes: rebuildWith(KEY_A) })
    if (outcome.ok) throw new Error("expected an unsupported-toolchain rejection")
    expect(outcome.rejection.code).toBe("unsupported-toolchain")

    const comparison = compareRebuild({
      bunVersion: "1.5.0",
      left: rebuildWith(KEY_A),
      right: rebuildWith(KEY_B),
    })
    if (comparison.equivalent) throw new Error("expected an unsupported-toolchain rejection")
    expect(comparison.rejection.code).toBe("unsupported-toolchain")
  })
})

describe("record parsing", () => {
  test("parses every record and derives its stored hash", () => {
    const outcome = canonicalizeBuildOutput({ bunVersion: BUN, bytes: rebuildWith(KEY_A) })
    if (!outcome.ok) throw new Error(`unexpected rejection: ${outcome.rejection.detail}`)

    expect(outcome.records.length).toBe(GRAPH.length)
    outcome.records.forEach((record, position) => {
      expect(record.offset).toBe(recordOffset(position))
      expect(record.token).toBe(tokenFor(GRAPH[position]))
      expect(record.key).toBe(GRAPH[position].key)
      expect(record.index).toBe(GRAPH[position].index)
      expect(record.storedHash).toBe(deriveRecordHash(record.token))
    })
    expect(outcome.records.map((record) => record.kind)).toEqual(["C", "C", "A", "C", "C"])
  })

  test("identifies exactly one bundler key and excludes the constant fillers by value", () => {
    const outcome = canonicalizeBuildOutput({ bunVersion: BUN, bytes: rebuildWith(KEY_A) })
    if (!outcome.ok) throw new Error(`unexpected rejection: ${outcome.rejection.detail}`)

    expect(outcome.bundlerKey).toBe(KEY_A)
    expect(outcome.recordsRewritten).toBe(3)
    expect(outcome.records.map((record) => record.bearsBundlerKey)).toEqual([
      false,
      true,
      true,
      false,
      true,
    ])
  })

  test("rewrites only the key field and the hash word of keyed records", () => {
    const raw = rebuildWith(KEY_A)
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
      expect(outcome.canonical.toString("latin1", record.offset + TOKEN_AT, record.offset + TOKEN_AT + TOKEN_BYTES)).toBe(canonicalToken)
      expect(outcome.canonical.readUInt32LE(record.offset + HASH_WORD_AT)).toBe(
        deriveRecordHash(canonicalToken),
      )
      for (let index = 0; index < 4; index += 1) expected.add(record.offset + HASH_WORD_AT + index)
      for (let index = 0; index < 16; index += 1) expected.add(record.offset + TOKEN_AT + index)
    }

    for (const offset of changed) expect(expected.has(offset)).toBe(true)
    expect(outcome.canonical.readUInt32LE(recordOffset(0))).toBe(HEADER_WORD)
    expect(
      outcome.canonical.toString("latin1", recordOffset(0) + TOKEN_AT, recordOffset(0) + TOKEN_AT + 16),
    ).toBe(FILLER_3)
  })
})

describe("rebuild equivalence (positive)", () => {
  test("two builds differing only in key and derived hashes are equivalent", () => {
    const left = rebuildWith(KEY_A)
    const right = rebuildWith(KEY_B)
    expect(left.equals(right)).toBe(false)

    const comparison = compareRebuild({ bunVersion: BUN, left, right })
    if (!comparison.equivalent) throw new Error(`unexpected rejection: ${comparison.rejection.detail}`)

    expect(comparison.rawIdentical).toBe(false)
    expect(comparison.rawDifferingBytes).toBeGreaterThan(0)
    expect(comparison.rawDifferingBytes).toBeLessThanOrEqual(comparison.recordsRewritten * 20)
    expect(comparison.recordsParsed).toBe(GRAPH.length)
    expect(comparison.recordsRewritten).toBe(3)
    expect(comparison.bundlerKeys).toEqual({ left: KEY_A, right: KEY_B })
  })

  test("identical rebuilds report raw identity, not just equivalence", () => {
    const comparison = compareRebuild({
      bunVersion: BUN,
      left: rebuildWith(KEY_A),
      right: rebuildWith(KEY_A),
    })
    if (!comparison.equivalent) throw new Error(`unexpected rejection: ${comparison.rejection.detail}`)

    expect(comparison.rawIdentical).toBe(true)
    expect(comparison.rawDifferingBytes).toBe(0)
  })
})

describe("tamper rejection", () => {
  test("rejects a changed code byte outside any record, reporting its offset", () => {
    const left = rebuildWith(KEY_A)
    const right = rebuildWith(KEY_B)
    const tamperAt = recordOffset(1) + RECORD_BYTES + 8
    right[tamperAt] = right[tamperAt] ^ 0xff

    const comparison = compareRebuild({ bunVersion: BUN, left, right })
    if (comparison.equivalent) throw new Error("expected a residual-difference rejection")
    expect(comparison.rejection.code).toBe("residual-difference")
    expect(comparison.rejection.offset).toBe(tamperAt)
  })

  test("rejects a changed byte in a record's padding, which is never canonicalized", () => {
    const left = rebuildWith(KEY_A)
    const right = rebuildWith(KEY_B)
    const tamperAt = recordOffset(1) + TOKEN_AT + TOKEN_BYTES + 1
    right[tamperAt] = 0x5a

    const comparison = compareRebuild({ bunVersion: BUN, left, right })
    if (comparison.equivalent) throw new Error("expected a residual-difference rejection")
    expect(comparison.rejection.code).toBe("residual-difference")
    expect(comparison.rejection.offset).toBe(tamperAt)
  })

  test("rejects a forged hash on one record", () => {
    const binary = rebuildWith(KEY_A)
    const offset = recordOffset(2)
    binary.writeUInt32LE(binary.readUInt32LE(offset + HASH_WORD_AT) ^ 0x01, offset + HASH_WORD_AT)

    const outcome = canonicalizeBuildOutput({ bunVersion: BUN, bytes: binary })
    if (outcome.ok) throw new Error("expected a record-hash-underived rejection")
    expect(outcome.rejection.code).toBe("record-hash-underived")
    expect(outcome.rejection.offset).toBe(offset)
  })

  test("rejects a hash word with a non-zero top byte", () => {
    const binary = rebuildWith(KEY_A)
    const offset = recordOffset(1)
    binary[offset + HASH_WORD_AT + 3] = 0x01

    const outcome = canonicalizeBuildOutput({ bunVersion: BUN, bytes: binary })
    if (outcome.ok) throw new Error("expected a record-hash-word-reserved-bits rejection")
    expect(outcome.rejection.code).toBe("record-hash-word-reserved-bits")
    expect(outcome.rejection.offset).toBe(offset)
  })

  test("rejects a changed chunk index inside a token", () => {
    const binary = rebuildWith(KEY_A)
    const offset = recordOffset(4)
    binary.write("9", offset + TOKEN_AT + TOKEN_BYTES - 1, 1, "latin1")

    const outcome = canonicalizeBuildOutput({ bunVersion: BUN, bytes: binary })
    if (outcome.ok) throw new Error("expected a record-hash-underived rejection")
    expect(outcome.rejection.code).toBe("record-hash-underived")
    expect(outcome.rejection.offset).toBe(offset)
  })

  test("rejects a chunk index that changed on one side even with a consistent hash", () => {
    const left = rebuildWith(KEY_A)
    const right = buildBinary(
      GRAPH.map((spec) =>
        spec.key === KEY_A
          ? { ...spec, key: KEY_B, index: spec.index === 4 ? 44 : spec.index }
          : spec,
      ),
    )

    const comparison = compareRebuild({ bunVersion: BUN, left, right })
    if (comparison.equivalent) throw new Error("expected a residual-difference rejection")
    expect(comparison.rejection.code).toBe("residual-difference")
    expect(comparison.rejection.offset).toBeGreaterThanOrEqual(recordOffset(4))
    expect(comparison.rejection.offset).toBeLessThan(recordOffset(4) + RECORD_BYTES)
  })

  test("rejects a second forged key even when its hash is internally consistent", () => {
    const binary = buildBinary(
      GRAPH.map((spec, position) =>
        spec.key === KEY_A && position === 4 ? { ...spec, key: KEY_B } : spec,
      ),
    )

    const outcome = canonicalizeBuildOutput({ bunVersion: BUN, bytes: binary })
    if (outcome.ok) throw new Error("expected a bundler-key-ambiguous rejection")
    expect(outcome.rejection.code).toBe("bundler-key-ambiguous")
    expect(outcome.rejection.detail).toContain(KEY_A)
    expect(outcome.rejection.detail).toContain(KEY_B)
  })

  test("rejects a binary with no bundler key at all", () => {
    const fillerOnly = canonicalizeBuildOutput({
      bunVersion: BUN,
      bytes: buildBinary([
        { key: FILLER_3, index: 0 },
        { key: FILLER_7, index: 1 },
      ]),
    })
    if (fillerOnly.ok) throw new Error("expected a bundler-key-missing rejection")
    expect(fillerOnly.rejection.code).toBe("bundler-key-missing")

    const noRecords = canonicalizeBuildOutput({ bunVersion: BUN, bytes: buildBinary([]) })
    if (noRecords.ok) throw new Error("expected a bundler-key-missing rejection")
    expect(noRecords.rejection.code).toBe("bundler-key-missing")
  })

  test("rejects truncation and any other size mismatch", () => {
    const left = rebuildWith(KEY_A)
    const truncated = compareRebuild({
      bunVersion: BUN,
      left,
      right: rebuildWith(KEY_B).subarray(0, left.length - 1),
    })
    if (truncated.equivalent) throw new Error("expected a size-mismatch rejection")
    expect(truncated.rejection.code).toBe("size-mismatch")

    const extended = compareRebuild({
      bunVersion: BUN,
      left,
      right: Buffer.concat([rebuildWith(KEY_B), Buffer.alloc(16)]),
    })
    if (extended.equivalent) throw new Error("expected a size-mismatch rejection")
    expect(extended.rejection.code).toBe("size-mismatch")
  })

  test("rejects a malformed length word, which removes the record from the set", () => {
    const right = rebuildWith(KEY_B)
    const offset = recordOffset(2)
    right.writeUInt32LE(0x80000018, offset)

    const outcome = canonicalizeBuildOutput({ bunVersion: BUN, bytes: right })
    if (!outcome.ok) throw new Error(`unexpected rejection: ${outcome.rejection.detail}`)
    expect(outcome.records.length).toBe(GRAPH.length - 1)

    const comparison = compareRebuild({ bunVersion: BUN, left: rebuildWith(KEY_A), right })
    if (comparison.equivalent) throw new Error("expected a record-set-mismatch rejection")
    expect(comparison.rejection.code).toBe("record-set-mismatch")
  })

  test("recomputes each side's hashes instead of copying the other side's bytes", () => {
    const left = rebuildWith(KEY_A)
    const right = rebuildWith(KEY_B)
    const offset = recordOffset(1)
    right.writeUInt32LE(left.readUInt32LE(offset + HASH_WORD_AT), offset + HASH_WORD_AT)

    const comparison = compareRebuild({ bunVersion: BUN, left, right })
    if (comparison.equivalent) throw new Error("expected a record-hash-underived rejection")
    expect(comparison.rejection.code).toBe("record-hash-underived")
    expect(comparison.rejection.detail.startsWith("right: ")).toBe(true)
  })
})
