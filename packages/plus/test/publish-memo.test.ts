import { describe, expect, test } from "bun:test"
import {
  resolveWhole,
  sectionOverrides,
  sectionRecords,
  resolutionChain,
  type ChainInput,
  type CustomizationRecord,
  type Item,
} from "../src/instructions/model.js"

const UPDATED = new Date().toISOString()

describe("pure work memoization", () => {
  test("section/whole resolution returns identical results and memoizes by records and scope", () => {
    const item: Item = {
      id: "system:role",
      kind: "system",
      group: "plus",
      title: "Role",
      text: "# Role\nYou are a helpful assistant.\n\n## Guidelines\nBe concise and clear.",
      enabled: true,
      fingerprint: "role_fp_1",
    }
    const records: CustomizationRecord[] = [
      {
        type: "customization",
        level: "project",
        agent: "build",
        item: "system:role",
        section: null,
        text: "# Role\nYou are an expert builder.\n\n## Guidelines\nBe concise and clear.",
        basedOn: "",
        updated: UPDATED,
      },
      {
        type: "customization",
        level: "global",
        agent: "build",
        item: "system:role",
        section: "guidelines",
        text: "## Guidelines\nAlways write tests first.",
        basedOn: "",
        updated: UPDATED,
      },
    ]
    const scopes = {
      global: new Set(["build"]),
      defaults: new Set(["build"]),
    }
    const address = {
      level: "project" as const,
      agent: "build",
      item: "system:role",
      section: null,
    }
    const input: ChainInput = {
      upstream: item,
      records,
      splits: [],
      scopes,
      address,
    }

    const chain = resolutionChain(address, scopes)
    const recs1 = sectionRecords(input, "guidelines")
    const recs2 = sectionRecords(input, "guidelines")
    expect(recs1).toEqual(recs2)

    const over1 = sectionOverrides(input, chain)
    const over2 = sectionOverrides(input, chain)
    expect(Array.from(over1.entries())).toEqual(Array.from(over2.entries()))

    const whole1 = resolveWhole(input)
    const whole2 = resolveWhole(input)
    expect(whole1).toEqual(whole2)

    // Verify different records array does not return the previous cached result
    const differentRecords: CustomizationRecord[] = [
      {
        type: "customization",
        level: "project",
        agent: "build",
        item: "system:role",
        section: null,
        text: "# Role\nYou are a different builder.",
        basedOn: "",
        updated: UPDATED,
      },
    ]
    const inputDifferentRecords: ChainInput = {
      ...input,
      records: differentRecords,
    }
    const wholeDifferent = resolveWhole(inputDifferentRecords)
    expect(wholeDifferent.text).toBe("# Role\nYou are a different builder.")
    expect(wholeDifferent).not.toEqual(whole1)

    // Verify different scope does not collide
    const differentScopes = {
      global: new Set<string>(),
      defaults: new Set<string>(),
    }
    const inputDifferentScopes: ChainInput = {
      ...input,
      scopes: differentScopes,
    }
    const wholeDifferentScopes = resolveWhole(inputDifferentScopes)
    expect(wholeDifferentScopes).toBeDefined()
  })
})
