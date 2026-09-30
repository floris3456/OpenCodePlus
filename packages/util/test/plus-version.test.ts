import { describe, expect, test } from "bun:test"
import { PlusVersion } from "../src/plus-version.js"

function info(version: string) {
  const parsed = PlusVersion.parse(version)
  if (!parsed) throw new Error(`expected ${version} to parse`)
  return parsed
}

describe("PlusVersion", () => {
  test("parses both parts and prints them back", () => {
    const version = info("2.0.18-plus-1.0.0")
    expect(version).toEqual({ opencode: [2, 0, 18], plus: [1, 0, 0] })
    expect(PlusVersion.format(version)).toBe("2.0.18-plus-1.0.0")
    expect(PlusVersion.tag(version)).toBe("v2.0.18-plus-1.0.0")
    expect(PlusVersion.display(version)).toBe("OpenCodePlus 1.0.0 (opencode 2.0.18)")
    expect(PlusVersion.fromTag("v2.0.18-plus-1.0.0")).toEqual(version)
  })

  test("refuses every other spelling", () => {
    const refused = [
      "0.0.0-plus-r5.3",
      "2.0.18-plus-1.0",
      "2.0.18-plus.1.0.0",
      "v2.0.18-plus-1.0.0",
      "2.0.18-plus-01.0.0",
      "02.0.18-plus-1.0.0",
      "2.0-plus-1.0.0",
      "2.0.18-plus-1.0.0-beta",
      "2.0.18-plus-1.0.0 ",
      "2.0.18-plus-1.0.1000000000",
      "0.0.0-0123456789abcdef0123456789abcdef01234567",
      "local",
      "",
    ]
    expect(refused.filter((version) => PlusVersion.parse(version) !== undefined)).toEqual([])
    expect(PlusVersion.fromTag("2.0.18-plus-1.0.0")).toBeUndefined()
  })

  test("orders by the Plus part first, then the opencode part, number by number", () => {
    const ordered = [
      "2.0.18-plus-1.0.0",
      "2.0.20-plus-1.0.0",
      "2.0.18-plus-1.0.1",
      "2.0.20-plus-1.0.9",
      "2.0.20-plus-1.0.10",
      "2.0.9-plus-1.1.0",
      "2.0.10-plus-1.1.0",
      "3.0.0-plus-1.1.0",
      "2.0.20-plus-2.0.0",
      "2.0.20-plus-10.0.0",
    ]
    const shuffled = [...ordered].reverse()
    expect(shuffled.sort((a, b) => PlusVersion.compare(info(a), info(b)))).toEqual(ordered)
    expect(PlusVersion.compare(info("2.0.18-plus-1.0.0"), info("2.0.18-plus-1.0.0"))).toBe(0)
  })

  test("accepts a release that follows the numbering rules", () => {
    const previous = info("2.0.18-plus-1.0.3")
    // Fixes, a new feature, a big change, and a newer opencode with no Plus changes.
    for (const next of ["2.0.18-plus-1.0.4", "2.0.18-plus-1.1.0", "2.0.18-plus-2.0.0", "2.0.20-plus-1.0.3"])
      expect(PlusVersion.refuseNext(previous, info(next))).toBeUndefined()
  })

  test("refuses a release that is not newer", () => {
    const previous = info("2.0.20-plus-1.1.0")
    expect(PlusVersion.refuseNext(previous, info("2.0.20-plus-1.1.0"))).toBe(
      "2.0.20-plus-1.1.0 is not newer than 2.0.20-plus-1.1.0",
    )
    expect(PlusVersion.refuseNext(previous, info("2.0.20-plus-1.0.9"))).toBe(
      "2.0.20-plus-1.0.9 is not newer than 2.0.20-plus-1.1.0",
    )
    // Only lowering opencode keeps the Plus part equal, so it is older, even when allowed.
    expect(PlusVersion.refuseNext(previous, info("2.0.18-plus-1.1.0"), { allowOlderOpencode: true })).toBe(
      "2.0.18-plus-1.1.0 is not newer than 2.0.20-plus-1.1.0",
    )
  })

  test("refuses an older opencode unless the owner allowed it", () => {
    const previous = info("2.0.20-plus-1.1.0")
    const next = info("2.0.18-plus-1.1.1")
    expect(PlusVersion.refuseNext(previous, next)).toBe(
      "2.0.18-plus-1.1.1 contains an older opencode (2.0.18) than 2.0.20-plus-1.1.0 (2.0.20)",
    )
    expect(PlusVersion.refuseNext(previous, next, { allowOlderOpencode: true })).toBeUndefined()
  })
})
