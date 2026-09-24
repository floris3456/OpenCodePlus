import { describe, expect, test } from "bun:test"
import { isCleanReceipt } from "../../src/teams/checks.js"
import type { Receipt } from "../../src/teams/checks.js"

function receipt(overrides: Partial<Receipt> = {}): Receipt {
  return {
    id: "unit",
    argv: ["bun", "test"],
    cwd: "",
    head: "0123456789abcdef0123456789abcdef01234567",
    exitCode: 0,
    passed: true,
    at: 1,
    durationMs: 1,
    outputPath: "/receipts/unit.log",
    tree: "89abcdef0123456789abcdef0123456789abcdef",
    dirty: false,
    ...overrides,
  }
}

describe("isCleanReceipt", () => {
  test("dirty false with a non-empty tree and no code is clean", () => {
    expect(isCleanReceipt(receipt())).toBe(true)
  })

  test("dirty true is not clean", () => {
    expect(isCleanReceipt(receipt({ dirty: true }))).toBe(false)
  })

  test("dirty undefined is not clean", () => {
    expect(isCleanReceipt(receipt({ dirty: undefined }))).toBe(false)
  })

  test("an empty tree string is not clean", () => {
    expect(isCleanReceipt(receipt({ tree: "" }))).toBe(false)
  })

  test("a missing tree is not clean", () => {
    expect(isCleanReceipt(receipt({ tree: undefined }))).toBe(false)
  })

  test("code E_CHECK_MUTATED is not clean", () => {
    expect(isCleanReceipt(receipt({ code: "E_CHECK_MUTATED" }))).toBe(false)
  })
})
