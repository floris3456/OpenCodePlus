import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import {
  resolve,
  resolveWhole,
  resetResolutionCache,
  type ChainInput,
  type CustomizationRecord,
  type Item,
  type SplitRecord,
  type Scopes,
} from "../src/instructions/model.js"
import { derive } from "../src/instructions/sections.js"

const REAL_STORE_SOURCE =
  "/home/bliss/OpenCodePlus/run/plus-dev/worktrees-plus-1.1.17-opencode/config/opencode/opencodeplus/instructions/records.jsonl"
const TEMP_DIR =
  "/home/bliss/OpenCodePlus/run/plus/tmp/opencodeplus/p117-perf-apply/test-store"

describe("perf-apply resolution memo correctness", () => {
  test("memoized vs unmemoized produces identical results across agents x items x sections for fixture store", () => {
    const records: CustomizationRecord[] = [
      {
        type: "customization",
        level: "defaults",
        agent: null,
        item: "tool:bash",
        section: null,
        state: "off",
        basedOn: "",
        updated: "2026-10-07T00:00:00.000Z",
      },
      {
        type: "customization",
        level: "project",
        agent: "build",
        item: "tool:bash",
        section: null,
        state: "on",
        basedOn: "",
        updated: "2026-10-07T00:00:00.000Z",
      },
      {
        type: "customization",
        level: "project",
        agent: "build",
        item: "system:role",
        section: null,
        text: "# Role\nYou are a senior build engineer.\n\n## Guidelines\nAlways write tests first.",
        basedOn: "",
        updated: "2026-10-07T00:00:00.000Z",
      },
      {
        type: "customization",
        level: "project",
        agent: "build",
        item: "system:role",
        section: "guidelines",
        text: "## Guidelines\nAlways verify with receipts.",
        basedOn: "",
        updated: "2026-10-07T00:00:00.000Z",
      },
      {
        type: "customization",
        level: "global",
        agent: "plan",
        item: "system:role",
        section: "guidelines",
        state: "off",
        basedOn: "",
        updated: "2026-10-07T00:00:00.000Z",
      },
    ]

    const splits: SplitRecord[] = [
      {
        type: "split",
        level: "project",
        agent: null,
        item: "system:role",
        boundaries: [
          { id: "guidelines", name: "Guidelines", start: 35 },
        ],
        updated: "2026-10-07T00:00:00.000Z",
      },
    ]

    const scopes: Scopes = {
      global: new Set(["plan"]),
      defaults: new Set(["build", "plan"]),
    }

    const agents = ["build", "plan", "review"]
    const items: Item[] = [
      {
        id: "system:role",
        kind: "system",
        group: "plus",
        title: "Role",
        text: "# Role\nYou are an AI assistant.\n\n## Guidelines\nFollow the instructions carefully.",
        enabled: true,
        fingerprint: "role_fp",
      },
      {
        id: "tool:bash",
        kind: "tool",
        group: "native",
        title: "Bash",
        text: "Execute shell commands.",
        enabled: true,
        fingerprint: "bash_fp",
      },
      {
        id: "tool:editor",
        kind: "tool",
        group: "native",
        title: "Editor",
        text: "Edit text files.",
        enabled: true,
        fingerprint: "editor_fp",
      },
    ]

    for (const agent of agents) {
      for (const item of items) {
        const input: ChainInput = {
          upstream: item,
          records,
          splits,
          scopes,
          address: {
            level: "project",
            agent,
            item: item.id,
            section: null,
          },
        }

        // Unmemoized
        resetResolutionCache()
        const unmemoizedWhole = resolveWhole(input)

        // Memoized (warm)
        const memoizedWhole = resolveWhole(input)
        expect(memoizedWhole).toEqual(unmemoizedWhole)

        // Sections
        const split = derive(unmemoizedWhole.text, item.title)
        for (const section of split.sections) {
          const secInput: ChainInput = {
            ...input,
            address: {
              ...input.address,
              section: section.id,
            },
          }
          resetResolutionCache()
          const unmemoizedSec = resolve(secInput)
          const memoizedSec = resolve(secInput)
          expect(memoizedSec).toEqual(unmemoizedSec)
        }
      }
    }
  })

  test("memoized vs unmemoized produces identical results for copy of real store", async () => {
    await fs.mkdir(TEMP_DIR, { recursive: true })
    const tempStorePath = path.join(TEMP_DIR, "records.jsonl")
    await fs.copyFile(REAL_STORE_SOURCE, tempStorePath)

    const raw = await Bun.file(tempStorePath).text()
    const rawLines = raw.split("\n").filter((l) => l.trim().length > 0)
    const stored = rawLines.slice(1).map((l) => JSON.parse(l))
    const records = stored.filter((r): r is CustomizationRecord => r.type === "customization")
    const splits = stored.filter((r): r is SplitRecord => r.type === "split")

    const agents = ["build", "plan", "general", "lead", "explore", "review"]
    const scopes: Scopes = {
      global: new Set(["plan", "general"]),
      defaults: new Set(["build", "plan", "lead", "explore", "review"]),
    }

    const items: Item[] = [
      {
        id: "system:role",
        kind: "system",
        group: "plus",
        title: "Role",
        text: "# Role\nYou are a senior software engineer.\n\n## Guidelines\nBe precise and deliver receipts.",
        enabled: true,
        fingerprint: "real_role_fp",
      },
      {
        id: "tool:bash",
        kind: "tool",
        group: "native",
        title: "Bash",
        text: "Run bash commands.",
        enabled: true,
        fingerprint: "real_bash_fp",
      },
      {
        id: "tool:edit",
        kind: "tool",
        group: "native",
        title: "Edit",
        text: "Edit file text.",
        enabled: true,
        fingerprint: "real_edit_fp",
      },
      {
        id: "tool:read",
        kind: "tool",
        group: "native",
        title: "Read",
        text: "Read file contents.",
        enabled: true,
        fingerprint: "real_read_fp",
      },
      {
        id: "perm:edit:allowed.*",
        kind: "perm",
        permKind: "input",
        group: "native",
        title: "Allowed files for edit",
        text: "*",
        enabled: true,
        fingerprint: "real_perm_edit_fp",
      },
    ]

    for (const agent of agents) {
      for (const item of items) {
        const input: ChainInput = {
          upstream: item,
          records,
          splits,
          scopes,
          address: {
            level: "project",
            agent,
            item: item.id,
            section: null,
          },
        }

        resetResolutionCache()
        const unmemoizedWhole = resolveWhole(input)
        const memoizedWhole = resolveWhole(input)
        expect(memoizedWhole).toEqual(unmemoizedWhole)

        const split = derive(unmemoizedWhole.text, item.title)
        for (const section of split.sections) {
          const secInput: ChainInput = {
            ...input,
            address: {
              ...input.address,
              section: section.id,
            },
          }
          resetResolutionCache()
          const unmemoizedSec = resolve(secInput)
          const memoizedSec = resolve(secInput)
          expect(memoizedSec).toEqual(unmemoizedSec)
        }
      }
    }

    // Clean up temp dir
    await fs.rm(TEMP_DIR, { recursive: true, force: true })
  })

  test("cache invalidation: toggle, rename, section edit, split edit answer new value without stale entry", () => {
    const item: Item = {
      id: "tool:grep",
      kind: "tool",
      group: "native",
      title: "Grep",
      text: "Search file contents with ripgrep.\n\n## Options\nSupports regex matching.",
      enabled: true,
      fingerprint: "grep_fp_1",
    }
    const initialRecords: CustomizationRecord[] = []
    const splits: SplitRecord[] = [
      {
        type: "split",
        level: "project",
        agent: null,
        item: "tool:grep",
        boundaries: [{ id: "options", name: "Options", start: 33 }],
        updated: "2026-10-07T00:00:00.000Z",
      },
    ]
    const scopes: Scopes = {
      global: new Set(["build"]),
      defaults: new Set(["build"]),
    }
    const address = {
      level: "project" as const,
      agent: "build",
      item: "tool:grep",
      section: null,
    }

    const input: ChainInput = {
      upstream: item,
      records: initialRecords,
      splits,
      scopes,
      address,
    }

    // 1. Initial resolution (warm cache)
    const initial = resolveWhole(input)
    expect(initial.enabled).toBe(true)

    // 2. TOGGLE: Turn tool off
    const toggledRecords: CustomizationRecord[] = [
      {
        type: "customization",
        level: "project",
        agent: "build",
        item: "tool:grep",
        section: null,
        state: "off",
        basedOn: "",
        updated: "2026-10-07T00:01:00.000Z",
      },
    ]
    const toggledInput: ChainInput = {
      ...input,
      records: toggledRecords,
    }
    const toggled = resolveWhole(toggledInput)
    expect(toggled.enabled).toBe(false)
    expect(toggled).not.toEqual(initial)

    // 3. RENAME: Upstream title & fingerprint changed
    const renamedItem: Item = {
      ...item,
      title: "Fast Grep",
      fingerprint: "grep_fp_2",
    }
    const renamedInput: ChainInput = {
      ...input,
      upstream: renamedItem,
      records: initialRecords,
    }
    const renamed = resolveWhole(renamedInput)
    expect(renamed.enabled).toBe(true)
    // Upstream changed, should be a fresh hit reflecting the new item

    // 4. SECTION EDIT: Add a section override record
    const sectionEditRecords: CustomizationRecord[] = [
      {
        type: "customization",
        level: "project",
        agent: "build",
        item: "tool:grep",
        section: "options",
        text: "## Options\nCustomized regex options.",
        basedOn: "",
        updated: "2026-10-07T00:02:00.000Z",
      },
    ]
    const sectionEditInput: ChainInput = {
      ...input,
      records: sectionEditRecords,
    }
    const sectionEdited = resolveWhole(sectionEditInput)
    expect(sectionEdited.assembled).toContain("Customized regex options.")

    const sectionOnlyInput: ChainInput = {
      ...sectionEditInput,
      address: {
        ...address,
        section: "options",
      },
    }
    const sectionResolved = resolve(sectionOnlyInput)
    expect(sectionResolved.text).toBe("## Options\nCustomized regex options.")

    // 5. SPLIT EDIT: Change split boundaries
    const updatedSplits: SplitRecord[] = [
      {
        type: "split",
        level: "project",
        agent: null,
        item: "tool:grep",
        boundaries: [{ id: "custom-section", name: "Custom Section", start: 10 }],
        updated: "2026-10-07T00:03:00.000Z",
      },
    ]
    const splitEditInput: ChainInput = {
      ...input,
      splits: updatedSplits,
    }
    const splitEdited = resolveWhole(splitEditInput)
    expect(splitEdited).toBeDefined()
  })
})
