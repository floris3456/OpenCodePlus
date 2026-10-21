// The Instructions route: teams and their members, permission rules.
import { afterEach, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/tui"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createComponent } from "solid-js"
import { formatMarkdown } from "../src/agents/files.js"
import { createHandlers, createPlusApi, createState } from "../src/index.js"
import { fingerprint } from "../src/instructions/model.js"
import { projectTeamsPath } from "../src/instructions/paths.js"
import { save } from "../src/instructions/store.js"
import { type TreeNode } from "../src/instructions/tree.js"
import type { PresetRef, Snapshot } from "../src/rpc.js"
import { Definition } from "../src/rpc.js"
import { createInstructionsDialogs } from "../src/tui/instructions/dialogs.js"
import { InstructionsRoute } from "../src/tui/instructions/route.js"
import { createInstructionsState } from "../src/tui/instructions/state.js"
import { createSnapshotCache } from "../src/tui/snapshot-cache.js"
import { createSnapshot, renderInstructionsRoute, renderPlusFixture } from "./tui.js"
import { agentInfo, fullContext } from "./harness.js"
import { binds, breadcrumb, dispatch, expand, footer, moveTo, reach, reachCategory, selectedRow, sleep } from "./instructions-nav.js"
import { goto, filter, until, sidebarRow, navTo, listPane, inspector, flat, projectAgent, linkAlphaToBuild } from "./route-helpers.js"

const e2eRoots: string[] = []
const priorConfigDir = process.env.OPENCODE_CONFIG_DIR

afterEach(async () => {
  if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
  await Promise.all(e2eRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

test("team row toggles through the real team.setEnabled and the rebuilt tree shows the new state", async () => {
  // End to end through the production path: a real team on disk, a real
  // snapshot carrying `teams`, the real route rendering it, the real
  // team.setEnabled handler toggling it, and the refreshed snapshot
  // rebuilding the tree. The fixture has no team RPC mock, so the route's
  // `team.setEnabled` call is wired to the real handlers and every wire is
  // asserted: the call arguments, the stored record, and the rebuilt row.
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-route-teams-e2e-"))
  e2eRoots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  const project = path.join(root, "project")
  const teamDir = path.join(projectTeamsPath(project), "crew")
  await fs.mkdir(path.join(teamDir, "nested"), { recursive: true })
  await Bun.write(
    path.join(teamDir, "alpha.md"),
    formatMarkdown({ description: "crew/alpha" }, "alpha role"),
  )
  await Bun.write(
    path.join(teamDir, "nested", "beta.md"),
    formatMarkdown({ description: "crew/nested/beta" }, "beta role"),
  )
  const ctx = fullContext({ directory: project })
  // Empty built-in registry: this test pins the disk-only team universe, not
  // the shipped roster (covered by the dedicated well-formedness test).
  const handlers = createHandlers(ctx, createState(), { builtins: [] })
  const throwing = { error: (type: string, message: string, data?: unknown) => { throw { type, message, data } } }
  const teamToggles: { level: string; team: string; enabled: boolean }[] = []
  const wrappedTeamSetEnabled = async (input: { level: "project" | "global"; team: string; enabled: boolean }) => {
    teamToggles.push({ ...input })
    return Effect.runPromise(handlers["team.setEnabled"](input, throwing))
  }
  const liveSnapshots: Snapshot[] = [await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing))]
  expect(liveSnapshots[0].teams).toEqual([{ level: "project", team: "crew", enabled: false, agents: ["alpha", "nested/beta"] }])
  const fixture = await renderPlusFixture({
    snapshots: [],
    width: 120,
    height: 40,
    render: (context) => {
      const rpc = context.client.rpc(Definition)
      const wired = {
        ...rpc,
        "instructions.snapshot": async () => liveSnapshots[liveSnapshots.length - 1],
        "instructions.refresh": async () => {
          liveSnapshots.push(await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing)))
          return liveSnapshots[liveSnapshots.length - 1]
        },
        "team.setEnabled": wrappedTeamSetEnabled,
      }
      context.client.rpc = (() => wired) as unknown as typeof context.client.rpc
      return createComponent(InstructionsRoute, { context, onClose: () => {} })
    },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    // The sidebar's Teams catalogue lists the crew container and its members.
    await goto(fixture, "team:project:crew", "crew")
    // The disabled row renders its glyph in the visible frame.
    expect(sidebarRow(fixture.captureCharFrame())).toContain("○ crew")
    expect(binds(fixture)).toContain("space")
    await expand(fixture)
    await fixture.waitForFrame((frame) => frame.includes("nested/beta"))
    expect(fixture.captureCharFrame()).toContain("alpha")
    // Space calls the real team.setEnabled with the inverted state.
    dispatch(fixture, "space")
    await fixture.waitForFrame((frame) => frame.includes('Enabled team "crew"'))
    expect(teamToggles).toEqual([{ level: "project", team: "crew", enabled: true }])
    // The toggle republishes: refresh pulls a fresh snapshot whose teams
    // entry reads enabled, and the rebuilt tree shows the new badge.
    await fixture.waitForFrame((frame) => sidebarRow(frame).includes("● crew"))
    expect(sidebarRow(fixture.captureCharFrame())).toContain("● crew")
    expect(liveSnapshots[liveSnapshots.length - 1].teams).toEqual([
      { level: "project", team: "crew", enabled: true, agents: ["alpha", "nested/beta"] },
    ])
    // Toggle back off through the same path: the call inverts again.
    dispatch(fixture, "space")
    await fixture.waitForFrame((frame) => frame.includes('Disabled team "crew"'))
    expect(teamToggles).toEqual([
      { level: "project", team: "crew", enabled: true },
      { level: "project", team: "crew", enabled: false },
    ])
    await fixture.waitForFrame((frame) => sidebarRow(frame).includes("○ crew"))
  } finally {
    fixture.destroy()
  }
})

test("a on the Teams group creates through the real team.create and the rebuilt tree shows the disabled row", async () => {
  // End to end through the production path: no team on disk, the always-
  // present Teams group still offers `a`, the real team.create handler makes
  // the directory DISABLED, and the refreshed snapshot rebuilds the tree with
  // the new off row. Mirrors the add-agent picker test (name then scope) and
  // the team-toggle rebuild test (real RPC plus live snapshots).
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-route-team-create-"))
  e2eRoots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  const project = path.join(root, "project")
  const ctx = fullContext({ directory: project })
  // Empty built-in registry: this test pins the disk-only team universe, not
  // the shipped roster (covered by the dedicated well-formedness test).
  const handlers = createHandlers(ctx, createState(), { builtins: [] })
  const throwing = { error: (type: string, message: string, data?: unknown) => { throw { type, message, data } } }
  const teamCreates: { level: string; team: string; preset?: string }[] = []
  const wrappedTeamCreate = async (input: { level: "project" | "global"; team: string; preset?: string }) => {
    teamCreates.push({ ...input })
    return Effect.runPromise(handlers["team.create"](input, throwing))
  }
  const liveSnapshots: Snapshot[] = [await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing))]
  expect(liveSnapshots[0].teams ?? []).toEqual([])
  const fixture = await renderPlusFixture({
    snapshots: [],
    width: 120,
    height: 40,
    dialogs: { prompts: ["fresh"], selects: [""] },
    render: (context) => {
      const rpc = context.client.rpc(Definition)
      const wired = {
        ...rpc,
        "instructions.snapshot": async () => liveSnapshots[liveSnapshots.length - 1],
        "instructions.refresh": async () => {
          liveSnapshots.push(await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing)))
          return liveSnapshots[liveSnapshots.length - 1]
        },
        "team.create": wrappedTeamCreate,
      }
      context.client.rpc = (() => wired) as unknown as typeof context.client.rpc
      return createComponent(InstructionsRoute, { context, onClose: () => {} })
    },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    // The empty Teams catalogue is always present beside Agents: `a` on it
    // prompts for a name then a team preset, taking project scope from the cursor.
    await goto(fixture, "group:project:teams", "Teams")
    expect(dispatch(fixture, "a")).toBe(true)
    await until(fixture, () => teamCreates.length === 1)
    const call = teamCreates[0]
    expect(teamCreates).toEqual([{ level: "project", team: "fresh" }])
    expect("preset" in call).toBe(false)
    expect(fixture.fake.dialogPrompts.map(([title]) => title)).toEqual(["Team name"])
    expect(fixture.fake.dialogSelects.map(([title]) => title)).toEqual(["Team preset"])
    expect(fixture.captureCharFrame()).not.toContain("Team scope")
    // The create republishes: refresh pulls a fresh snapshot whose teams
    // entry reads disabled, and the rebuilt tree reveals and selects the new
    // off row.
    await until(fixture, () => (liveSnapshots[liveSnapshots.length - 1].teams ?? []).length === 1)
    expect(liveSnapshots[liveSnapshots.length - 1].teams).toEqual([
      { level: "project", team: "fresh", enabled: false, agents: [] },
    ])
    await until(fixture, (frame) => sidebarRow(frame).includes("○ fresh"))
    expect(sidebarRow(fixture.captureCharFrame())).toContain("○ fresh")
  } finally {
    fixture.destroy()
  }
})

test("reviewer persona shows its own prompt and saves only its record", async () => {
  const snapshot = createSnapshot({
    agents: [projectAgent("Implementer"), projectAgent("Reviewer")],
    items: [
      {
        id: "system:role",
        kind: "system" as const,
        group: "none" as const,
        title: "Role/persona",
        text: "implementer-prompt",
        enabled: true,
        fingerprint: "fp-implementer",
        agents: ["Implementer"],
      },
      {
        id: "system:role",
        kind: "system" as const,
        group: "none" as const,
        title: "Role/persona",
        text: "reviewer-prompt",
        enabled: true,
        fingerprint: "fp-reviewer",
        agents: ["Reviewer"],
      },
    ],
  })
  const fixture = await renderInstructionsRoute({ snapshots: [snapshot], width: 120, height: 40 })
  try {
    // Reviewer › System › Role item (Implementer has its own Role row).
    await goto(fixture, "item:project:Reviewer:system:role", "Role/persona")
    await fixture.waitForFrame((frame) => frame.includes("reviewer-prompt"))
    expect(breadcrumb(fixture.captureCharFrame())).toContain("Reviewer › System")
    dispatch(fixture, "return")
    await fixture.waitForFrame((frame) => frame.includes("ctrl+s save"))
    const editor = fixture.renderer.currentFocusedEditor
    expect(editor).toBeDefined()
    expect(editor?.plainText).toBe("reviewer-prompt")
    editor?.setText("reviewer-prompt v2")
    dispatch(fixture, "ctrl+s")
    await fixture.waitForFrame((frame) => frame.includes('Saved "Role/persona"'))
    expect(fixture.fake.mutateInputs.length).toBe(1)
    const records = fixture.fake.mutateInputs[0].records
    expect(records.length).toBe(1)
    expect(records[0]).toMatchObject({ agent: "Reviewer", item: "system:role", text: "reviewer-prompt v2" })
  } finally {
    fixture.destroy()
  }
})

test("a on a tool row offers Section or Permission rule and creates without scope prompts", async () => {
  const snapshot = createSnapshot({
    agents: [projectAgent("Implementer")],
    items: [
      {
        id: "tool:shell",
        kind: "tool" as const,
        group: "native" as const,
        title: "shell",
        text: "run shell commands",
        enabled: true,
        fingerprint: "fp-shell",
      },
      {
        id: "perm:shell:git-push",
        kind: "perm" as const,
        group: "none" as const,
        title: "Git push",
        text: "Git push\ngit push *",
        enabled: true,
        fingerprint: "fp-push",
        permTool: "shell",
        ruleId: "git-push",
        patterns: ["git push *"],
        keywords: ["git push"],
        provenance: [],
      },
    ],
  })
  const fixture = await renderInstructionsRoute({
    snapshots: [snapshot],
    width: 120,
    height: 40,
    dialogs: { selects: ["rule"], prompts: ["No force pushes", "git push --force *", "", "force pushes are not allowed here"] },
  })
  try {
    await goto(fixture, "item:project:Implementer:tool:shell", "shell")
    expect(dispatch(fixture, "a")).toBe(true)
    await until(fixture, () => fixture.fake.ruleAdds.length === 1)
    expect(fixture.fake.ruleAdds[0]).toMatchObject({
      level: "project",
      agent: "Implementer",
      tool: "shell",
      label: "No force pushes",
      message: "force pushes are not allowed here",
    })
    expect(fixture.fake.ruleAdds[0]?.patterns).toEqual(["git push --force *"])
    expect(fixture.fake.dialogPrompts.map((entry) => entry[0])).toContain("Message shown on refusal (optional)")
    expect(fixture.fake.dialogSelects.length).toBe(1)
  } finally {
    fixture.destroy()
  }
})

test("a on a generic row prompts for rule scope and creates a per-agent rule", async () => {
  const fixture = await renderInstructionsRoute({
    snapshots: [createSnapshot()],
    width: 120,
    height: 40,
    dialogs: {
      selects: ["rule", "project"],
      prompts: ["shell", "No force pushes", "git push --force *", "", "", "my-agent"],
    },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    await reachCategory(fixture, "group:defaults::tools", "Tools")
    expect(dispatch(fixture, "a")).toBe(true)
    await until(fixture, () => fixture.fake.ruleAdds.length === 1)
    expect(fixture.fake.ruleAdds[0]).toMatchObject({
      level: "project",
      agent: "my-agent",
      tool: "shell",
      label: "No force pushes",
    })
    expect(fixture.fake.ruleAdds[0]?.patterns).toEqual(["git push --force *"])
  } finally {
    fixture.destroy()
  }
})

test("zero-parameter permission rows list directly, and enter opens the rule editor", async () => {
  const snapshot = createSnapshot({
    agents: [projectAgent("Implementer")],
    items: [
      {
        id: "tool:shell",
        kind: "tool" as const,
        group: "native" as const,
        title: "shell",
        text: "run shell commands",
        enabled: true,
        fingerprint: "fp-shell",
      },
      {
        id: "perm:shell:git-push",
        kind: "perm" as const,
        group: "none" as const,
        title: "Git push",
        text: "Git push\ngit push *",
        enabled: true,
        fingerprint: "fp-push",
        permTool: "shell",
        ruleId: "git-push",
        patterns: ["git push *"],
        keywords: ["git push"],
        provenance: [],
      },
    ],
  })
  const liveSnapshots: Snapshot[] = [snapshot]
  const ruleUpdates: { level: string; agent: string | null; tool: string; id: string; label: string; patterns: string[]; message?: string }[] = []
  const fixture = await renderPlusFixture({
    snapshots: [],
    width: 120,
    height: 40,
    dialogs: { prompts: ["No force pushes", "git push --force *", "", "force pushes are not allowed here"] },
    render: (context) => {
      const rpc = context.client.rpc(Definition)
      const wired = {
        ...rpc,
        "instructions.snapshot": async () => liveSnapshots[liveSnapshots.length - 1],
        "instructions.refresh": async () => liveSnapshots[liveSnapshots.length - 1],
        "rule.update": async (input: { level: "project" | "global" | "defaults"; agent: string | null; tool: string; id: string; label: string; patterns: string[]; keywords?: string[]; message?: string }) => {
          ruleUpdates.push({
            level: input.level,
            agent: input.agent,
            tool: input.tool,
            id: input.id,
            label: input.label,
            patterns: [...input.patterns],
            ...(input.message === undefined ? {} : { message: input.message }),
          })
          return { level: input.level, agent: input.agent, tool: input.tool, id: input.id, label: input.label }
        },
      }
      context.client.rpc = (() => wired) as unknown as typeof context.client.rpc
      return createComponent(InstructionsRoute, { context, onClose: () => {} })
    },
  })
  try {
    await goto(fixture, "item:project:Implementer:tool:shell", "shell")
    // With no parameter schema in this fixture, rules are direct editable leaves.
    await reach(fixture, "item:project:Implementer:perm:shell:git-push", "Git push")
    expect(listPane(fixture.captureCharFrame())).not.toContain("Permissions")
    expect(breadcrumb(fixture.captureCharFrame())).toContain("shell › Git push")
    await fixture.waitForFrame((frame) => footer(frame).includes("enter edit rule"))
    expect(footer(fixture.captureCharFrame())).toContain("enter edit rule")
    expect(dispatch(fixture, "return")).toBe(true)
    await until(fixture, () => ruleUpdates.length === 1)
    expect(ruleUpdates[0]).toMatchObject({
      level: "project",
      agent: "Implementer",
      tool: "shell",
      id: "git-push",
      label: "No force pushes",
      message: "force pushes are not allowed here",
    })
    expect(ruleUpdates[0]?.patterns).toEqual(["git push --force *"])
  } finally {
    fixture.destroy()
  }
})

test("a on a Defaults Teams tool row creates the rule in the Teams catalogue", async () => {
  const snapshot = createSnapshot({
    items: [
      {
        id: "tool:shell",
        kind: "tool" as const,
        group: "native" as const,
        title: "shell",
        text: "run shell commands",
        enabled: true,
        fingerprint: "fp-shell",
      },
    ],
  })
  const fixture = await renderInstructionsRoute({
    snapshots: [snapshot],
    width: 120,
    height: 40,
    dialogs: { selects: ["rule"], prompts: ["No force pushes", "git push --force *", "", "force pushes are not allowed here"] },
  })
  try {
    // Defaults › Every member › Tools › OpenCode › shell.
    await goto(fixture, "item:defaults:/teams:tool:shell", "shell")
    expect(breadcrumb(fixture.captureCharFrame())).toContain("Defaults › Teams › Tools")
    expect(dispatch(fixture, "a")).toBe(true)
    await until(fixture, () => fixture.fake.ruleAdds.length === 1)
    expect(fixture.fake.ruleAdds[0]).toMatchObject({
      level: "defaults",
      agent: null,
      catalogue: "teams",
      tool: "shell",
      label: "No force pushes",
      message: "force pushes are not allowed here",
    })
    // The shared Defaults row addressed the scope: the only select is the
    // Section/Permission-rule choice.
    expect(fixture.fake.dialogSelects.length).toBe(1)
    expect(fixture.fake.dialogPrompts.map((entry) => entry[0])).toEqual([
      "Rule label",
      "Rule patterns",
      "Rule keywords",
      "Message shown on refusal (optional)",
    ])
  } finally {
    fixture.destroy()
  }
})

test("enter on a Defaults Teams perm row sends the Teams catalogue with rule.update", async () => {
  const snapshot = createSnapshot({
    items: [
      {
        id: "tool:shell",
        kind: "tool" as const,
        group: "native" as const,
        title: "shell",
        text: "run shell commands",
        enabled: true,
        fingerprint: "fp-shell",
      },
      {
        id: "perm:shell:git-push",
        kind: "perm" as const,
        group: "none" as const,
        title: "Git push",
        text: "Git push\ngit push *",
        enabled: true,
        fingerprint: "fp-push",
        permTool: "shell",
        ruleId: "git-push",
        patterns: ["git push *"],
        keywords: ["git push"],
        provenance: [],
      },
    ],
  })
  const liveSnapshots: Snapshot[] = [snapshot]
  const ruleUpdates: {
    level: string
    agent: string | null
    catalogue?: string
    tool: string
    id: string
    label: string
    patterns: string[]
    message?: string
  }[] = []
  const fixture = await renderPlusFixture({
    snapshots: [],
    width: 120,
    height: 40,
    dialogs: { prompts: ["No force pushes", "git push --force *", "", "force pushes are not allowed here"] },
    render: (context) => {
      const rpc = context.client.rpc(Definition)
      const wired = {
        ...rpc,
        "instructions.snapshot": async () => liveSnapshots[liveSnapshots.length - 1],
        "instructions.refresh": async () => liveSnapshots[liveSnapshots.length - 1],
        "rule.update": async (input: { level: "project" | "global" | "defaults"; agent: string | null; catalogue?: "agents" | "teams"; tool: string; id: string; label: string; patterns: string[]; keywords?: string[]; message?: string }) => {
          ruleUpdates.push({
            level: input.level,
            agent: input.agent,
            ...(input.catalogue === undefined ? {} : { catalogue: input.catalogue }),
            tool: input.tool,
            id: input.id,
            label: input.label,
            patterns: [...input.patterns],
            ...(input.message === undefined ? {} : { message: input.message }),
          })
          return { level: input.level, agent: input.agent, tool: input.tool, id: input.id, label: input.label }
        },
      }
      context.client.rpc = (() => wired) as unknown as typeof context.client.rpc
      return createComponent(InstructionsRoute, { context, onClose: () => {} })
    },
  })
  try {
    await goto(fixture, "item:defaults:/teams:tool:shell", "shell")
    await reach(fixture, "item:defaults:/teams:perm:shell:git-push", "Git push")
    expect(dispatch(fixture, "return")).toBe(true)
    await until(fixture, () => ruleUpdates.length === 1)
    expect(ruleUpdates[0]).toMatchObject({
      level: "defaults",
      agent: null,
      catalogue: "teams",
      tool: "shell",
      id: "git-push",
      label: "No force pushes",
      message: "force pushes are not allowed here",
    })
    expect(ruleUpdates[0]?.patterns).toEqual(["git push --force *"])
  } finally {
    fixture.destroy()
  }
})

test("e starts text editing on a tool row but not on a permission rule", async () => {
  const snapshot = createSnapshot({
    agents: [projectAgent("Implementer")],
    items: [
      {
        id: "tool:shell",
        kind: "tool" as const,
        group: "native" as const,
        title: "shell",
        text: "run shell commands",
        enabled: true,
        fingerprint: "fp-shell",
      },
      {
        id: "perm:shell:git-push",
        kind: "perm" as const,
        group: "none" as const,
        title: "Git push",
        text: "Git push\ngit push *",
        enabled: true,
        fingerprint: "fp-push",
        permTool: "shell",
        ruleId: "git-push",
        patterns: ["git push *"],
        keywords: ["git push"],
        provenance: [],
      },
    ],
  })
  const fixture = await renderInstructionsRoute({
    snapshots: [snapshot],
    width: 120,
    height: 40,
  })
  try {
    await goto(fixture, "item:project:Implementer:tool:shell", "shell")
    // Tool row: 'e' is bound and starts text editing.
    expect(binds(fixture)).toContain("e")
    expect(dispatch(fixture, "e")).toBe(true)
    await fixture.waitForFrame((frame) => frame.includes("ctrl+s save"))
    expect(fixture.captureCharFrame()).toContain("ctrl+s save")
    // Cancel editing to return to navigation.
    expect(dispatch(fixture, "escape")).toBe(true)
    await fixture.waitForFrame((frame) => !frame.includes("ctrl+s save"))

    // Navigate to the permission rule under Permissions → Commands.
    await fixture.waitForFrame((frame) => selectedRow(frame).includes("shell"))
    await reach(fixture, "item:project:Implementer:perm:shell:git-push", "Git push")
    // Permission row: 'e' is unavailable and does not start text editing.
    expect(binds(fixture)).not.toContain("e")
    expect(dispatch(fixture, "e")).toBe(false)
    expect(fixture.captureCharFrame()).not.toContain("ctrl+s save")
  } finally {
    fixture.destroy()
  }
})

test("inspector shows a rule's refusal message, curated or user-set", async () => {
  const snapshot = createSnapshot({
    agents: [projectAgent("Implementer")],
    items: [
      {
        id: "tool:shell",
        kind: "tool" as const,
        group: "native" as const,
        title: "shell",
        text: "run shell commands",
        enabled: true,
        fingerprint: "fp-shell",
      },
      {
        id: "perm:shell:git-push",
        kind: "perm" as const,
        group: "none" as const,
        title: "Git push",
        text: "Git push\ngit push *",
        enabled: true,
        fingerprint: "fp-push",
        permTool: "shell",
        ruleId: "git-push",
        patterns: ["git push *"],
        keywords: ["git push"],
        provenance: [],
      },
      {
        id: "perm:shell:my-rule",
        kind: "perm" as const,
        group: "none" as const,
        title: "My rule",
        text: "My rule\nmine *",
        enabled: true,
        fingerprint: "fp-mine",
        permTool: "shell",
        ruleId: "my-rule",
        patterns: ["mine *"],
        keywords: ["mine"],
        provenance: [],
        custom: true,
      },
    ],
    records: [
      {
        type: "rule" as const,
        level: "project" as const,
        agent: "Implementer",
        tool: "shell",
        id: "my-rule",
        label: "My rule",
        patterns: ["mine *"],
        keywords: ["mine"],
        message: "mine is not allowed here",
        updated: "2026-01-01T00:00:00.000Z",
      },
    ],
  })
  const fixture = await renderInstructionsRoute({
    snapshots: [snapshot],
    width: 120,
    height: 40,
  })
  try {
    await goto(fixture, "item:project:Implementer:tool:shell", "shell")
    await reach(fixture, "item:project:Implementer:perm:shell:git-push", "Git push")
    await fixture.waitForFrame((frame) => inspector(frame).includes(flat("message pushing is not allowed here")))
    expect(inspector(fixture.captureCharFrame())).toContain(flat("message pushing is not allowed here"))
    await moveTo(fixture, "My rule")
    await fixture.waitForFrame((frame) => inspector(frame).includes(flat("message mine is not allowed here")))
    expect(inspector(fixture.captureCharFrame())).toContain(flat("message mine is not allowed here"))
  } finally {
    fixture.destroy()
  }
})

test("addRule cancelling any prompt writes nothing, blank keywords saves with defaults", async () => {
  async function runAdd(prompts: readonly (string | undefined)[]) {
    const parent = process.env.TMPDIR ?? os.tmpdir()
    const root = await fs.mkdtemp(path.join(parent, "plus-add-cancel-"))
    e2eRoots.push(root)
    process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
    const project = path.join(root, "project")
    await linkAlphaToBuild(project)
    const realCtx = fullContext({
      directory: project,
      agents: [agentInfo("alpha", "upstream role")],
      tools: [{ id: "shell", description: "Run shell.", options: { codemode: false } }],
    })
    const state = createState()
    const handlers = createHandlers(realCtx, state)
    const throwing = { error: (type: string, message: string, data?: unknown): never => { throw { type, message, data } } }
    const promptQueue = [...prompts]
    let addCalls = 0
    let refreshCalls = 0
    const fakeContext = {
      location: realCtx.location,
      client: {
        rpc: () => ({
          events: { on: () => () => {} },
          "instructions.snapshot": () => Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing)),
          "rule.add": async (input: never) => {
            addCalls++
            return Effect.runPromise(handlers["rule.add"](input, throwing))
          },
        }),
      },
      ui: {
        dialog: {
          prompt: async () => promptQueue.shift(),
          select: async () => undefined,
          clear: () => {},
        },
        toast: { show: () => {} },
        router: { navigate: () => {} },
      },
    } as unknown as Plugin.Context
    const fakeState = {
      ...createInstructionsState(fakeContext),
      refresh: async () => {
        refreshCalls++
      },
    }
    const dialogs = createInstructionsDialogs(fakeContext, fakeState)
    const toolNode = {
      id: "tool-node",
      kind: "item",
      label: "shell",
      depth: 0,
      address: { level: "project", agent: "my-agent", item: "tool:shell", section: null },
      badges: {},
    } satisfies TreeNode
    await dialogs.addRule(toolNode)
    dialogs.dispose()
    fakeState.dispose()
    const api = createPlusApi(realCtx, state)
    const snap = await api.snapshot()
    if (!snap.ok) throw new Error("snapshot failed")
    const logged = await api.log({})
    if (!logged.ok) throw new Error("log failed")
    return { addCalls, refreshCalls, records: snap.value.records, logTotal: logged.value.total }
  }
  for (const prompts of [[undefined], ["My Rule", undefined], ["My Rule", "git push *", undefined], ["My Rule", "git push *", "", undefined]] as const) {
    const result = await runAdd(prompts)
    expect(result.addCalls).toBe(0)
    expect(result.records).toEqual([])
    expect(result.logTotal).toBe(0)
    expect(result.refreshCalls).toBe(0)
  }
  const saved = await runAdd(["My Rule", "git push --force *", "", ""])
  expect(saved.addCalls).toBe(1)
  expect(saved.records).toHaveLength(1)
  const rule = saved.records.find((record) => record.type === "rule")
  if (rule === undefined || rule.type !== "rule") throw new Error("expected rule")
  expect(rule.keywords.length).toBeGreaterThan(0)
  expect(saved.logTotal).toBe(1)
  expect(saved.refreshCalls).toBe(1)
})

test("editRule cancelling any prompt writes nothing, blank keywords saves with defaults", async () => {
  async function runEdit(prompts: readonly (string | undefined)[]) {
    const parent = process.env.TMPDIR ?? os.tmpdir()
    const root = await fs.mkdtemp(path.join(parent, "plus-edit-cancel-"))
    e2eRoots.push(root)
    process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
    const project = path.join(root, "project")
    await linkAlphaToBuild(project)
    const realCtx = fullContext({
      directory: project,
      agents: [agentInfo("alpha", "upstream role")],
      tools: [{ id: "shell", description: "Run shell.", options: { codemode: false } }],
    })
    const state = createState()
    const handlers = createHandlers(realCtx, state)
    const throwing = { error: (type: string, message: string, data?: unknown): never => { throw { type, message, data } } }
    await Effect.runPromise(
      handlers["rule.add"](
        { level: "project", agent: "alpha", tool: "shell", id: "my-rule", label: "Original", patterns: ["orig *"], keywords: ["old-key"] },
        throwing,
      ),
    )
    const fresh = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing))
    const promptQueue = [...prompts]
    let updateCalls = 0
    let refreshCalls = 0
    const fakeContext = {
      location: realCtx.location,
      client: {
        rpc: () => ({
          events: { on: () => () => {} },
          "instructions.snapshot": () => Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing)),
          "rule.update": async (input: never) => {
            updateCalls++
            return Effect.runPromise(handlers["rule.update"](input, throwing))
          },
        }),
      },
      ui: {
        dialog: {
          prompt: async () => promptQueue.shift(),
          select: async () => undefined,
          clear: () => {},
        },
        toast: { show: () => {} },
        router: { navigate: () => {} },
      },
    } as unknown as Plugin.Context
    const cache = createSnapshotCache()
    cache.put(project, fresh)
    const fakeState = {
      ...createInstructionsState(fakeContext, cache),
      refresh: async () => {
        refreshCalls++
      },
    }
    const dialogs = createInstructionsDialogs(fakeContext, fakeState)
    const permNode = {
      id: "perm-node",
      kind: "item",
      label: "My rule",
      depth: 0,
      address: { level: "project", agent: "alpha", item: "perm:shell:my-rule", section: null },
      badges: {},
    } satisfies TreeNode
    await dialogs.editRule(permNode)
    dialogs.dispose()
    fakeState.dispose()
    const api = createPlusApi(realCtx, state)
    const snap = await api.snapshot()
    if (!snap.ok) throw new Error("snapshot failed")
    const persisted = snap.value.records.find((record) => record.type === "rule" && record.tool === "shell" && record.id === "my-rule")
    if (persisted === undefined || persisted.type !== "rule") throw new Error("expected rule to persist")
    const logged = await api.log({ where: "op:rule.update" })
    if (!logged.ok) throw new Error("log failed")
    return { updateCalls, refreshCalls, persisted, logTotal: logged.value.total }
  }
  for (const prompts of [[undefined], ["New label", undefined], ["New label", "new *", undefined], ["New label", "new *", "", undefined]] as const) {
    const result = await runEdit(prompts)
    expect(result.updateCalls).toBe(0)
    expect(result.persisted.label).toBe("Original")
    expect(result.persisted.patterns).toEqual(["orig *"])
    expect(result.persisted.keywords).toEqual(["old-key"])
    expect(result.logTotal).toBe(0)
    expect(result.refreshCalls).toBe(0)
  }
  const saved = await runEdit(["New label", "new pattern *", "", ""])
  expect(saved.updateCalls).toBe(1)
  expect(saved.persisted.label).toBe("New label")
  expect(saved.persisted.patterns).toEqual(["new pattern *"])
  expect(saved.persisted.keywords).not.toEqual(["old-key"])
  expect(saved.persisted.keywords.length).toBeGreaterThan(0)
  expect(saved.logTotal).toBe(1)
  expect(saved.refreshCalls).toBe(1)
})

test("retries agent selection when the agent arrives in a later snapshot", async () => {
  const without = createSnapshot({ agents: [] })
  const withAgent = createSnapshot({ agents: [projectAgent("LateAgent")] })
  const toasts: { variant?: string; message: string }[] = []
  const fixture = await renderPlusFixture({
    snapshots: [without, withAgent],
    width: 120,
    height: 40,
    render: (context) => {
      const original = context.ui.toast.show
      context.ui.toast.show = ((toast: { variant?: string; message: string }) => {
        toasts.push(toast)
        return (original as (toast: unknown) => unknown)(toast)
      }) as typeof original
      return createComponent(InstructionsRoute, { context, onClose: () => {}, data: { agent: "LateAgent" } })
    },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Project"))
    expect(fixture.captureCharFrame()).not.toContain("LateAgent")
    await fixture.emitChanged()
    await fixture.waitForFrame((frame) => frame.includes("LateAgent") && selectedRow(frame).includes("LateAgent"))
    expect(selectedRow(fixture.captureCharFrame())).toContain("LateAgent")
    expect(toasts.length).toBe(0)
  } finally {
    fixture.destroy()
  }
})

test("gives up waiting for a missing agent and toasts once", async () => {
  const toasts: { variant?: string; message: string }[] = []
  const fixture = await renderPlusFixture({
    snapshots: [createSnapshot({ agents: [] })],
    width: 120,
    height: 40,
    render: (context) => {
      const original = context.ui.toast.show
      context.ui.toast.show = ((toast: { variant?: string; message: string }) => {
        toasts.push(toast)
        return (original as (toast: unknown) => unknown)(toast)
      }) as typeof original
      return createComponent(InstructionsRoute, {
        context,
        onClose: () => {},
        data: { agent: "Missing" },
        initialAgentTimeoutMs: 50,
      })
    },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    for (let i = 0; i < 20 && toasts.length === 0; i++) await sleep(20)
    expect(toasts.length).toBe(1)
    expect(toasts[0]).toMatchObject({ variant: "warning", message: "Agent Missing not visible yet" })
    await sleep(100)
    expect(toasts.length).toBe(1)
  } finally {
    fixture.destroy()
  }
})

test("a on a team row adds through the real team.addAgent without the generic picker", async () => {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-route-team-add-agent-"))
  e2eRoots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  const project = path.join(root, "project")
  const ctx = fullContext({ directory: project })
  const handlers = createHandlers(ctx, createState(), { builtins: [] })
  const throwing = { error: (type: string, message: string, data?: unknown) => { throw { type, message, data } } }
  await Effect.runPromise(handlers["team.create"]({ level: "project", team: "crew" }, throwing))
  const teamAdds: { level: string; team: string; id: string; preset?: PresetRef }[] = []
  const wrappedTeamAddAgent = async (input: { level: "project"; team: string; id: string; preset?: PresetRef }) => {
    teamAdds.push({ ...input })
    return Effect.runPromise(handlers["team.addAgent"](input, throwing))
  }
  const liveSnapshots: Snapshot[] = [await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing))]
  expect(liveSnapshots[0].teams).toEqual([{ level: "project", team: "crew", enabled: false, agents: [] }])
  const fixture = await renderPlusFixture({
    snapshots: [],
    width: 120,
    height: 40,
    dialogs: { selects: ["__none__"], prompts: ["newbie"] },
    render: (context) => {
      const rpc = context.client.rpc(Definition)
      const wired = {
        ...rpc,
        "instructions.snapshot": async () => liveSnapshots[liveSnapshots.length - 1],
        "instructions.refresh": async () => {
          liveSnapshots.push(await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing)))
          return liveSnapshots[liveSnapshots.length - 1]
        },
        "team.addAgent": wrappedTeamAddAgent,
      }
      context.client.rpc = (() => wired) as unknown as typeof context.client.rpc
      return createComponent(InstructionsRoute, { context, onClose: () => {} })
    },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    await goto(fixture, "team:project:crew", "crew")
    expect(dispatch(fixture, "a")).toBe(true)
    await until(fixture, () => teamAdds.length === 1)
    expect(teamAdds[0]).toMatchObject({ level: "project", team: "crew", id: "newbie" })
    expect("preset" in (teamAdds[0] as Record<string, unknown>)).toBe(false)
    await until(fixture, () =>
      (liveSnapshots[liveSnapshots.length - 1].teams?.find((team) => team.team === "crew")?.agents ?? []).includes("newbie"),
    )
    expect(liveSnapshots[liveSnapshots.length - 1].teams?.find((team) => team.team === "crew")).toEqual({
      level: "project",
      team: "crew",
      enabled: false,
      agents: ["newbie"],
    })
    // The member row appears in the sidebar under its team.
    await until(fixture, (frame) => frame.includes("newbie"))
    await navTo(fixture, "newbie")
    expect(selectedRow(fixture.captureCharFrame())).toContain("newbie")
    const titles = fixture.fake.dialogSelects.map(([title]) => title)
    expect(titles).toContain("Preset")
    expect(titles.some((title) => title === "Add")).toBe(false)
  } finally {
    fixture.destroy()
  }
})

test("a on a colon team row calls team.addAgent with the full name", async () => {
  // Team names allow colons; the old `[^:]+` dispatch fell through to the
  // ordinary agent flow. The row identity (kind team + add:agent) must route
  // to team.addAgent with the entire remainder as the team name.
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-route-team-colon-"))
  e2eRoots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  const project = path.join(root, "project")
  const ctx = fullContext({ directory: project })
  const handlers = createHandlers(ctx, createState(), { builtins: [] })
  const throwing = { error: (type: string, message: string, data?: unknown) => { throw { type, message, data } } }
  await Effect.runPromise(handlers["team.create"]({ level: "project", team: "release:review" }, throwing))
  const teamAdds: { level: string; team: string; id: string; preset?: PresetRef }[] = []
  const wrappedTeamAddAgent = async (input: { level: "project"; team: string; id: string; preset?: PresetRef }) => {
    teamAdds.push({ ...input })
    return Effect.runPromise(handlers["team.addAgent"](input, throwing))
  }
  const liveSnapshots: Snapshot[] = [await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing))]
  expect(liveSnapshots[0].teams).toEqual([{ level: "project", team: "release:review", enabled: false, agents: [] }])
  const fixture = await renderPlusFixture({
    snapshots: [],
    width: 120,
    height: 40,
    dialogs: { selects: ["__none__"], prompts: ["newbie"] },
    render: (context) => {
      const rpc = context.client.rpc(Definition)
      const wired = {
        ...rpc,
        "instructions.snapshot": async () => liveSnapshots[liveSnapshots.length - 1],
        "instructions.refresh": async () => {
          liveSnapshots.push(await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing)))
          return liveSnapshots[liveSnapshots.length - 1]
        },
        "team.addAgent": wrappedTeamAddAgent,
      }
      context.client.rpc = (() => wired) as unknown as typeof context.client.rpc
      return createComponent(InstructionsRoute, { context, onClose: () => {} })
    },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    await goto(fixture, "team:project:release:review", "release:review")
    expect(dispatch(fixture, "a")).toBe(true)
    await until(fixture, () => teamAdds.length === 1)
    expect(teamAdds[0]).toMatchObject({ level: "project", team: "release:review", id: "newbie" })
    // Never opened the ordinary agent-creation flow.
    expect(fixture.fake.agentCreates.length).toBe(0)
    const titles = fixture.fake.dialogSelects.map(([title]) => title)
    expect(titles).toContain("Preset")
    expect(titles.some((title) => title === "Add")).toBe(false)
  } finally {
    fixture.destroy()
  }
})

test("a on a team row with an internal newline calls team.addAgent with the multiline name", async () => {
  // Team names allow internal newlines; validateTeamName accepts them as valid
  // single path segments. The row identity (kind team + add:agent) must route
  // to team.addAgent with the entire multiline name, not ordinary agent creation.
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-route-team-newline-"))
  e2eRoots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  const project = path.join(root, "project")
  const ctx = fullContext({ directory: project })
  const handlers = createHandlers(ctx, createState(), { builtins: [] })
  const throwing = { error: (type: string, message: string, data?: unknown) => { throw { type, message, data } } }
  await Effect.runPromise(handlers["team.create"]({ level: "project", team: "release\nreview" }, throwing))
  const teamAdds: { level: string; team: string; id: string; preset?: PresetRef }[] = []
  const wrappedTeamAddAgent = async (input: { level: "project"; team: string; id: string; preset?: PresetRef }) => {
    teamAdds.push({ ...input })
    return Effect.runPromise(handlers["team.addAgent"](input, throwing))
  }
  const liveSnapshots: Snapshot[] = [await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing))]
  expect(liveSnapshots[0].teams).toEqual([{ level: "project", team: "release\nreview", enabled: false, agents: [] }])
  const fixture = await renderPlusFixture({
    snapshots: [],
    width: 120,
    height: 40,
    dialogs: { selects: ["__none__"], prompts: ["newbie"] },
    render: (context) => {
      const rpc = context.client.rpc(Definition)
      const wired = {
        ...rpc,
        "instructions.snapshot": async () => liveSnapshots[liveSnapshots.length - 1],
        "instructions.refresh": async () => {
          liveSnapshots.push(await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing)))
          return liveSnapshots[liveSnapshots.length - 1]
        },
        "team.addAgent": wrappedTeamAddAgent,
      }
      context.client.rpc = (() => wired) as unknown as typeof context.client.rpc
      return createComponent(InstructionsRoute, { context, onClose: () => {} })
    },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    // The id holds a newline the filter input cannot take: walk the sidebar.
    await goto(fixture, "group:project:teams", "Teams")
    await navTo(fixture, "release")
    expect(dispatch(fixture, "a")).toBe(true)
    await until(fixture, () => teamAdds.length === 1)
    expect(teamAdds[0]).toMatchObject({ level: "project", team: "release\nreview", id: "newbie" })
    // Never opened the ordinary agent-creation flow.
    expect(fixture.fake.agentCreates.length).toBe(0)
    const titles = fixture.fake.dialogSelects.map(([title]) => title)
    expect(titles).toContain("Preset")
    expect(titles.some((title) => title === "Add")).toBe(false)
  } finally {
    fixture.destroy()
  }
})

// DESIGN §5: a on a Teams group → team name → team preset → done; the
// cursor's root decides the level, so no scope question.
test("team create on group:project:teams asks the name, then a grouped team preset, at the cursor level", async () => {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-route-team-template-project-"))
  e2eRoots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  const project = path.join(root, "project")
  const ctx = fullContext({ directory: project })
  const handlers = createHandlers(ctx, createState())
  const throwing = { error: (type: string, message: string, data?: unknown) => { throw { type, message, data } } }
  const teamCreates: { level: string; team: string; preset?: string }[] = []
  const wrappedTeamCreate = async (input: { level: "project" | "global"; team: string; preset?: string }) => {
    teamCreates.push({ ...input })
    return Effect.runPromise(handlers["team.create"](input, throwing))
  }
  const liveSnapshots: Snapshot[] = [await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing))]
  const fixture = await renderPlusFixture({
    snapshots: [],
    width: 120,
    height: 40,
    dialogs: { prompts: ["crew"], selects: ["basic"] },
    render: (context) => {
      const rpc = context.client.rpc(Definition)
      const wired = {
        ...rpc,
        "instructions.snapshot": async () => liveSnapshots[liveSnapshots.length - 1],
        "instructions.refresh": async () => {
          liveSnapshots.push(await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing)))
          return liveSnapshots[liveSnapshots.length - 1]
        },
        "team.create": wrappedTeamCreate,
      }
      context.client.rpc = (() => wired) as unknown as typeof context.client.rpc
      return createComponent(InstructionsRoute, { context, onClose: () => {} })
    },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    await goto(fixture, "group:project:teams", "Teams")
    expect(dispatch(fixture, "a")).toBe(true)
    await until(fixture, () => teamCreates.length === 1)
    expect(teamCreates).toEqual([{ level: "project", team: "crew", preset: "basic" }])
    expect(fixture.fake.promptInputs.map((input) => input.title)).toEqual(["Team name"])
    expect(fixture.fake.dialogSelects.map(([title]) => title)).toEqual(["Team preset"])
    // Grouped by origin, Plus team presets first here (OpenCode ships none);
    // the empty team is the last option, without a group.
    const picker = fixture.fake.selectInputs[0]
    expect(picker.options.filter((option) => option.category === "Plus").map((option) => option.value)).toContain("basic")
    expect(picker.options.some((option) => option.category === "OpenCode" || option.category === "Native")).toBe(false)
    expect(picker.options.at(-1)).toEqual({ title: "Empty team", value: "" })
    expect(fixture.captureCharFrame()).not.toContain("Team scope")
    await until(fixture, () =>
      (liveSnapshots[liveSnapshots.length - 1].teams ?? []).some((t) => t.level === "project" && t.team === "crew" && !t.enabled),
    )
    // The new team row is revealed and selected.
    await until(fixture, (frame) => sidebarRow(frame).includes("○ crew"))
  } finally {
    fixture.destroy()
  }
})

// DESIGN §4/§5: Defaults → Teams takes team entries. A team pattern is a row
// only while it has a member entry, so the flow asks both patterns, then the
// preset; `a` on the entry rows then adds member entries to that PATTERN.
test("a on Defaults Teams asks team pattern, member pattern, preset; a on its entry rows adds to the pattern", async () => {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-route-team-entry-"))
  e2eRoots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  const project = path.join(root, "project")
  // A native tool, so a member linked to a preset that turns Code Mode off still has tools.
  const ctx = fullContext({ directory: project, tools: [{ id: "read", description: "Read a file" }] })
  const handlers = createHandlers(ctx, createState(), { builtins: [] })
  const throwing = { error: (type: string, message: string, data?: unknown) => { throw { type, message, data } } }
  const teamAdds: { level: string; team: string; id: string; preset?: PresetRef }[] = []
  const wrappedTeamAddAgent = async (input: { level: "defaults"; team: string; id: string; preset?: PresetRef }) => {
    teamAdds.push({ ...input })
    return Effect.runPromise(handlers["team.addAgent"](input, throwing))
  }
  const liveSnapshots: Snapshot[] = [await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing))]
  const fixture = await renderPlusFixture({
    snapshots: [],
    width: 120,
    height: 40,
    dialogs: { prompts: ["*review*", "*orchestrator*", "*reviewer*", "*editor*"], selects: ["member:basic/orchestrator", "__none__", "member:basic/reviewer"] },
    render: (context) => {
      const rpc = context.client.rpc(Definition)
      const wired = {
        ...rpc,
        "instructions.snapshot": async () => liveSnapshots[liveSnapshots.length - 1],
        "instructions.refresh": async () => {
          liveSnapshots.push(await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing)))
          return liveSnapshots[liveSnapshots.length - 1]
        },
        "team.addAgent": wrappedTeamAddAgent,
      }
      context.client.rpc = (() => wired) as unknown as typeof context.client.rpc
      return createComponent(InstructionsRoute, { context, onClose: () => {} })
    },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    await goto(fixture, "group:defaults:teams", "Teams")
    expect(dispatch(fixture, "a")).toBe(true)
    await until(fixture, () => teamAdds.length === 1)
    expect(teamAdds[0]).toEqual({ level: "defaults", team: "*review*", id: "*orchestrator*", preset: { kind: "member", team: "basic", id: "orchestrator" } })
    expect(fixture.fake.promptInputs.map((input) => input.title)).toEqual(["Team name or pattern", "Member name or pattern"])
    expect(fixture.fake.promptInputs[0]?.description).toContain("* and % match any text, case-insensitive")
    expect(fixture.fake.dialogSelects.map(([title]) => title)).toEqual(["Preset"])
    // The member entry row is revealed and selected under its team pattern.
    await until(fixture, (frame) => sidebarRow(frame).includes("*orchestrator*"))
    // a on the member entry row: the team is the PATTERN, never "<pattern>:<member>".
    expect(dispatch(fixture, "a")).toBe(true)
    await until(fixture, () => teamAdds.length === 2)
    expect(teamAdds[1]).toEqual({ level: "defaults", team: "*review*", id: "*reviewer*" })
    await until(fixture, (frame) => sidebarRow(frame).includes("*reviewer*"))
    // a on the team pattern row itself adds to the same pattern.
    dispatch(fixture, "up")
    dispatch(fixture, "up")
    await fixture.waitForFrame((frame) => sidebarRow(frame).includes("*review*") && !sidebarRow(frame).includes("*reviewer*") && !sidebarRow(frame).includes("*orch"))
    expect(dispatch(fixture, "a")).toBe(true)
    await until(fixture, () => teamAdds.length === 3)
    expect(teamAdds[2]).toEqual({ level: "defaults", team: "*review*", id: "*editor*", preset: { kind: "member", team: "basic", id: "reviewer" } })
    expect(fixture.fake.promptInputs.slice(2).map((input) => input.title)).toEqual(["Member name or pattern", "Member name or pattern"])
    expect(fixture.fake.dialogSelects.map(([title]) => title)).not.toContain("Team scope")
    await until(fixture, () => (liveSnapshots.at(-1)?.entries ?? []).length === 3)
    expect((liveSnapshots.at(-1)?.entries ?? []).map((entry) => `${entry.team} ${entry.name}`).toSorted()).toEqual([
      "*review* *editor*",
      "*review* *orchestrator*",
      "*review* *reviewer*",
    ])
  } finally {
    fixture.destroy()
  }
})

test("a on a team member row adds through the real team.addAgent without the generic picker", async () => {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-route-team-member-add-agent-"))
  e2eRoots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  const project = path.join(root, "project")
  const ctx = fullContext({ directory: project })
  const handlers = createHandlers(ctx, createState(), { builtins: [] })
  const throwing = { error: (type: string, message: string, data?: unknown) => { throw { type, message, data } } }
  await Effect.runPromise(handlers["team.create"]({ level: "project", team: "crew" }, throwing))
  await Effect.runPromise(
    handlers["team.addAgent"]({ level: "project", team: "crew", id: "alpha" }, throwing),
  )
  const teamAdds: { level: string; team: string; id: string; preset?: PresetRef }[] = []
  const wrappedTeamAddAgent = async (input: { level: "project"; team: string; id: string; preset?: PresetRef }) => {
    teamAdds.push({ ...input })
    return Effect.runPromise(handlers["team.addAgent"](input, throwing))
  }
  const liveSnapshots: Snapshot[] = [await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing))]
  expect(liveSnapshots[0].teams).toEqual([{ level: "project", team: "crew", enabled: false, agents: ["alpha"] }])
  const fixture = await renderPlusFixture({
    snapshots: [],
    width: 120,
    height: 40,
    dialogs: { selects: ["__none__"], prompts: ["bravo"] },
    render: (context) => {
      const rpc = context.client.rpc(Definition)
      const wired = {
        ...rpc,
        "instructions.snapshot": async () => liveSnapshots[liveSnapshots.length - 1],
        "instructions.refresh": async () => {
          liveSnapshots.push(await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing)))
          return liveSnapshots[liveSnapshots.length - 1]
        },
        "team.addAgent": wrappedTeamAddAgent,
      }
      context.client.rpc = (() => wired) as unknown as typeof context.client.rpc
      return createComponent(InstructionsRoute, { context, onClose: () => {} })
    },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    await goto(fixture, "team:project:crew:alpha", "alpha")
    expect(selectedRow(fixture.captureCharFrame())).toContain("alpha")
    expect(dispatch(fixture, "a")).toBe(true)
    await until(fixture, () => teamAdds.length === 1)
    expect(teamAdds[0]).toMatchObject({ level: "project", team: "crew", id: "bravo" })
    expect("preset" in (teamAdds[0] as Record<string, unknown>)).toBe(false)
    expect(fixture.fake.agentCreates.length).toBe(0)
    const titles = fixture.fake.dialogSelects.map(([title]) => title)
    expect(titles).toContain("Preset")
    expect(titles.some((title) => title === "Add")).toBe(false)
    expect(fixture.captureCharFrame()).not.toContain("Select what to add")
    await until(fixture, () =>
      (liveSnapshots[liveSnapshots.length - 1].teams?.find((team) => team.team === "crew")?.agents ?? []).includes("bravo"),
    )
    expect(liveSnapshots[liveSnapshots.length - 1].teams?.find((team) => team.team === "crew")).toEqual({
      level: "project",
      team: "crew",
      enabled: false,
      agents: ["alpha", "bravo"],
    })
  } finally {
    fixture.destroy()
  }
})

test("a on a colon team member row calls team.addAgent with the full team name", async () => {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-route-team-colon-member-"))
  e2eRoots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  const project = path.join(root, "project")
  const ctx = fullContext({ directory: project })
  const handlers = createHandlers(ctx, createState(), { builtins: [] })
  const throwing = { error: (type: string, message: string, data?: unknown) => { throw { type, message, data } } }
  await Effect.runPromise(handlers["team.create"]({ level: "project", team: "crew" }, throwing))
  await Effect.runPromise(handlers["team.create"]({ level: "project", team: "crew:alpha" }, throwing))
  await Effect.runPromise(
    handlers["team.addAgent"]({ level: "project", team: "crew:alpha", id: "firstmate" }, throwing),
  )
  const teamAdds: { level: string; team: string; id: string; preset?: PresetRef }[] = []
  const wrappedTeamAddAgent = async (input: { level: "project"; team: string; id: string; preset?: PresetRef }) => {
    teamAdds.push({ ...input })
    return Effect.runPromise(handlers["team.addAgent"](input, throwing))
  }
  const liveSnapshots: Snapshot[] = [await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing))]
  const fixture = await renderPlusFixture({
    snapshots: [],
    width: 120,
    height: 40,
    dialogs: { selects: ["__none__"], prompts: ["secondmate"] },
    render: (context) => {
      const rpc = context.client.rpc(Definition)
      const wired = {
        ...rpc,
        "instructions.snapshot": async () => liveSnapshots[liveSnapshots.length - 1],
        "instructions.refresh": async () => {
          liveSnapshots.push(await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing)))
          return liveSnapshots[liveSnapshots.length - 1]
        },
        "team.addAgent": wrappedTeamAddAgent,
      }
      context.client.rpc = (() => wired) as unknown as typeof context.client.rpc
      return createComponent(InstructionsRoute, { context, onClose: () => {} })
    },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    await goto(fixture, "team:project:crew:alpha:firstmate", "firstmate")
    expect(selectedRow(fixture.captureCharFrame())).toContain("firstmate")
    expect(dispatch(fixture, "a")).toBe(true)
    await until(fixture, () => teamAdds.length === 1)
    expect(teamAdds[0]).toMatchObject({ level: "project", team: "crew:alpha", id: "secondmate" })
    expect(fixture.fake.agentCreates.length).toBe(0)
    const titles = fixture.fake.dialogSelects.map(([title]) => title)
    expect(titles).toContain("Preset")
    expect(titles.some((title) => title === "Add")).toBe(false)
  } finally {
    fixture.destroy()
  }
})

test("a on ambiguous team member row surfaces error toast and calls no team.addAgent", async () => {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-route-team-ambiguous-"))
  e2eRoots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  const project = path.join(root, "project")
  const ctx = fullContext({ directory: project })
  const handlers = createHandlers(ctx, createState(), { builtins: [] })
  const throwing = { error: (type: string, message: string, data?: unknown) => { throw { type, message, data } } }
  await Effect.runPromise(handlers["team.create"]({ level: "project", team: "crew" }, throwing))
  await Effect.runPromise(handlers["team.create"]({ level: "project", team: "crew:alpha" }, throwing))
  await Effect.runPromise(
    handlers["team.addAgent"]({ level: "project", team: "crew", id: "alpha" }, throwing),
  )
  const teamAdds: { level: string; team: string; id: string; preset?: PresetRef }[] = []
  const wrappedTeamAddAgent = async (input: { level: "project"; team: string; id: string; preset?: PresetRef }) => {
    teamAdds.push({ ...input })
    return Effect.runPromise(handlers["team.addAgent"](input, throwing))
  }
  const toasts: { variant?: string; message: string }[] = []
  const liveSnapshots: Snapshot[] = [await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing))]
  const fixture = await renderPlusFixture({
    snapshots: [],
    width: 120,
    height: 40,
    dialogs: { selects: ["__none__"], prompts: ["secondmate"] },
    render: (context) => {
      const originalToastShow = context.ui.toast.show
      context.ui.toast.show = ((toast: { variant?: string; message: string }) => {
        toasts.push(toast)
        return (originalToastShow as (t: unknown) => unknown)(toast)
      }) as unknown as typeof context.ui.toast.show
      const rpc = context.client.rpc(Definition)
      const wired = {
        ...rpc,
        "instructions.snapshot": async () => liveSnapshots[liveSnapshots.length - 1],
        "instructions.refresh": async () => {
          liveSnapshots.push(await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing)))
          return liveSnapshots[liveSnapshots.length - 1]
        },
        "team.addAgent": wrappedTeamAddAgent,
      }
      context.client.rpc = (() => wired) as unknown as typeof context.client.rpc
      return createComponent(InstructionsRoute, { context, onClose: () => {} })
    },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    // team:project:crew:alpha names both the team crew:alpha and crew's
    // member alpha: walk the sidebar to the member row under crew.
    await goto(fixture, "team:project:crew", "crew")
    await navTo(fixture, "alpha")
    expect(sidebarRow(fixture.captureCharFrame())).toMatch(/^\s+● alpha/)
    expect(dispatch(fixture, "a")).toBe(true)
    await until(fixture, () => toasts.length >= 1)
    expect(toasts).toContainEqual({
      variant: "error",
      message: '"crew:alpha" is ambiguous: it matches both a team and a member of team "crew". Rename one to continue.',
    })
    expect(teamAdds.length).toBe(0)
  } finally {
    fixture.destroy()
  }
})

test("d on a member row with the real handler wired removes the row", async () => {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-route-team-member-remove-"))
  e2eRoots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  const project = path.join(root, "project")
  const ctx = fullContext({ directory: project })
  const handlers = createHandlers(ctx, createState(), { builtins: [] })
  const throwing = { error: (type: string, message: string, data?: unknown) => { throw { type, message, data } } }
  await Effect.runPromise(handlers["team.create"]({ level: "project", team: "crew" }, throwing))
  await Effect.runPromise(
    handlers["team.addAgent"]({ level: "project", team: "crew", id: "alpha" }, throwing),
  )
  const teamRemoves: { level: string; team: string; id: string }[] = []
  const wrappedTeamRemoveAgent = async (input: { level: "project" | "global" | "defaults"; team: string; id: string }) => {
    teamRemoves.push({ ...input })
    return Effect.runPromise(handlers["team.removeAgent"](input, throwing))
  }
  const liveSnapshots: Snapshot[] = [await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing))]
  expect(liveSnapshots[0].teams).toEqual([{ level: "project", team: "crew", enabled: false, agents: ["alpha"] }])
  const fixture = await renderPlusFixture({
    snapshots: [],
    width: 120,
    height: 40,
    dialogs: { confirms: [true] },
    render: (context) => {
      const rpc = context.client.rpc(Definition)
      const wired = {
        ...rpc,
        "instructions.snapshot": async () => liveSnapshots[liveSnapshots.length - 1],
        "instructions.refresh": async () => {
          liveSnapshots.push(await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing)))
          return liveSnapshots[liveSnapshots.length - 1]
        },
        "team.removeAgent": wrappedTeamRemoveAgent,
      }
      context.client.rpc = (() => wired) as unknown as typeof context.client.rpc
      return createComponent(InstructionsRoute, { context, onClose: () => {} })
    },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    await goto(fixture, "team:project:crew:alpha", "alpha")
    expect(selectedRow(fixture.captureCharFrame())).toContain("alpha")
    expect(binds(fixture)).toContain("d")
    expect(dispatch(fixture, "d")).toBe(true)
    await until(fixture, () => teamRemoves.length === 1)
    expect(teamRemoves[0]).toEqual({ level: "project", team: "crew", id: "alpha" })
    await fixture.waitForFrame((frame) => frame.includes("Deleted team member alpha"))
    await until(fixture, () =>
      (liveSnapshots[liveSnapshots.length - 1].teams?.find((team) => team.team === "crew")?.agents ?? []).length === 0,
    )
    expect(liveSnapshots[liveSnapshots.length - 1].teams?.find((team) => team.team === "crew")?.agents).toEqual([])
    expect(selectedRow(fixture.captureCharFrame())).not.toContain("alpha")
  } finally {
    fixture.destroy()
  }
})

test("d on a team row with the real handler wired removes the row and wires team.delete", async () => {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-route-team-remove-"))
  e2eRoots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  const project = path.join(root, "project")
  const ctx = fullContext({ directory: project })
  const handlers = createHandlers(ctx, createState(), { builtins: [] })
  const throwing = { error: (type: string, message: string, data?: unknown) => { throw { type, message, data } } }
  await Effect.runPromise(handlers["team.create"]({ level: "project", team: "crew" }, throwing))
  await Effect.runPromise(
    handlers["team.addAgent"]({ level: "project", team: "crew", id: "alpha" }, throwing),
  )
  const teamDeletes: { level: "project" | "global"; team: string }[] = []
  const wrappedTeamDelete = async (input: { level: "project" | "global"; team: string }) => {
    teamDeletes.push({ ...input })
    return Effect.runPromise(handlers["team.delete"](input, throwing))
  }
  let confirmOptions: unknown = undefined
  const liveSnapshots: Snapshot[] = [await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing))]
  expect(liveSnapshots[0].teams).toEqual([{ level: "project", team: "crew", enabled: false, agents: ["alpha"] }])
  const fixture = await renderPlusFixture({
    snapshots: [],
    width: 120,
    height: 40,
    dialogs: { confirms: [true] },
    render: (context) => {
      const rpc = context.client.rpc(Definition)
      const wired = {
        ...rpc,
        "instructions.snapshot": async () => liveSnapshots[liveSnapshots.length - 1],
        "instructions.refresh": async () => {
          liveSnapshots.push(await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing)))
          return liveSnapshots[liveSnapshots.length - 1]
        },
        "team.delete": wrappedTeamDelete,
      }
      context.client.rpc = (() => wired) as unknown as typeof context.client.rpc
      const baseConfirm = context.ui.dialog.confirm
      context.ui.dialog.confirm = async (input) => {
        confirmOptions = input
        return baseConfirm(input)
      }
      return createComponent(InstructionsRoute, { context, onClose: () => {} })
    },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    await goto(fixture, "team:project:crew", "crew")
    expect(selectedRow(fixture.captureCharFrame())).toContain("crew")
    expect(binds(fixture)).toContain("d")
    expect(dispatch(fixture, "d")).toBe(true)
    await until(fixture, () => teamDeletes.length === 1)
    expect(teamDeletes[0]).toEqual({ level: "project", team: "crew" })
    expect(confirmOptions).toMatchObject({
      title: "Delete team crew?",
      message: 'Delete project team "crew" and its 1 member file(s)? It is currently disabled. This cannot be undone.',
    })
    await fixture.waitForFrame((frame) => frame.includes("Deleted team crew"))
    await until(fixture, () =>
      (liveSnapshots[liveSnapshots.length - 1].teams?.find((team) => team.team === "crew")) === undefined,
    )
    expect(liveSnapshots[liveSnapshots.length - 1].teams?.find((team) => team.team === "crew")).toBeUndefined()
    expect(selectedRow(fixture.captureCharFrame())).not.toContain("crew")
  } finally {
    fixture.destroy()
  }
})

test("defaults team row offers no d delete", async () => {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-route-defaults-team-refusal-"))
  e2eRoots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  const project = path.join(root, "project")
  const registry = [{ name: "starter", members: [{ id: "planner", body: "planner body" }] }]
  const ctx = fullContext({ directory: project })
  const handlers = createHandlers(ctx, createState(), { builtins: registry })
  const throwing = { error: (type: string, message: string, data?: unknown) => { throw { type, message, data } } }
  const liveSnapshots: Snapshot[] = [await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing))]
  const fixture = await renderPlusFixture({
    snapshots: [],
    width: 120,
    height: 40,
    render: (context) => {
      const rpc = context.client.rpc(Definition)
      const wired = {
        ...rpc,
        "instructions.snapshot": async () => liveSnapshots[liveSnapshots.length - 1],
        "instructions.refresh": async () => {
          liveSnapshots.push(await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing)))
          return liveSnapshots[liveSnapshots.length - 1]
        },
      }
      context.client.rpc = (() => wired) as unknown as typeof context.client.rpc
      return createComponent(InstructionsRoute, { context, onClose: () => {} })
    },
  })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    await goto(fixture, "team:defaults:starter", "starter")
    expect(selectedRow(fixture.captureCharFrame())).toContain("starter")
    // `d` is bound on every row so undeletable rows answer with the honest
    // refusal instead of swallowing the key; the hint line still offers
    // `d delete` only where the row can actually be deleted.
    expect(binds(fixture)).toContain("d")
    expect(footer(fixture.captureCharFrame())).not.toContain("d delete")
    dispatch(fixture, "d")
    await fixture.waitForFrame((frame) => frame.includes('"starter" cannot be deleted: team "starter" is built in'))
  } finally {
    fixture.destroy()
  }
})

test("a on a Special row or special-agent row under a team shows status refusal", async () => {
  const snapshot: Snapshot = {
    ...createSnapshot({
      agents: [
        { id: "alpha", scope: "project" as const, fileBacked: true },
        { id: "title", scope: "defaults" as const, origin: "special" as const, fileBacked: false },
      ],
    }),
    teams: [{ level: "project" as const, team: "crew", enabled: true, agents: ["alpha"] }],
  }
  const fixture = await renderInstructionsRoute({ snapshots: [snapshot], width: 120, height: 40 })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    await goto(fixture, "team:project:crew:special", "Special")
    expect(dispatch(fixture, "a")).toBe(true)
    await fixture.waitForFrame((frame) => frame.includes("Special agents are built in; add is not available here"))
    expect(fixture.fake.dialogSelects.length).toBe(0)

    await expand(fixture)
    await navTo(fixture, "title")
    expect(dispatch(fixture, "a")).toBe(true)
    await fixture.waitForFrame((frame) => frame.includes("Special agents are built in; add is not available here"))
    expect(fixture.fake.dialogSelects.length).toBe(0)
  } finally {
    fixture.destroy()
  }
})

test("space on a Models row under a team special persists the team-scoped record", async () => {
  const snapshot: Snapshot = {
    ...createSnapshot({
      agents: [
        { id: "alpha", scope: "project" as const, fileBacked: true },
        { id: "title", scope: "defaults" as const, origin: "special" as const, fileBacked: false },
      ],
      items: [
        {
          id: "model:acme/nova-2",
          kind: "model" as const,
          group: "none" as const,
          title: "acme/nova-2",
          text: "acme/nova-2",
          enabled: true,
          fingerprint: "fp-nova-2",
          agents: ["title"],
        },
      ],
      records: [
        {
          type: "model" as const,
          level: "defaults" as const,
          agent: null,
          providerID: "acme",
          modelID: "nova-2",
          updated: "2026-09-14T00:00:00.000Z",
        },
        // A team special agent resolves through the Teams catalogue, which is
        // where the store migration puts the second copy of every shared row.
        {
          type: "model" as const,
          level: "defaults" as const,
          agent: null,
          catalogue: "teams" as const,
          providerID: "acme",
          modelID: "nova-2",
          updated: "2026-09-14T00:00:00.000Z",
        },
      ],
    }),
    teams: [{ level: "project" as const, team: "crew", enabled: true, agents: ["alpha"] }],
  }
  const fixture = await renderInstructionsRoute({ snapshots: [snapshot], width: 120, height: 40 })
  try {
    await fixture.waitForFrame((frame) => frame.includes("Instructions"))
    // Teams › crew › Special › title (sidebar) › Models › the candidate.
    await goto(fixture, "item:project:crew/:special:title:model:acme/nova-2", "acme/nova-2")
    expect(breadcrumb(fixture.captureCharFrame())).toContain("crew › Special › title › Models")
    expect(binds(fixture)).toContain("space")
    dispatch(fixture, "space")
    await fixture.waitForFrame((frame) => frame.includes('Activated "acme/nova-2"'))
    expect(fixture.fake.mutateInputs.length).toBe(1)
    const models = fixture.fake.mutateInputs[0].records.filter((record) => record.type === "model")
    expect(models.length).toBeGreaterThan(0)
    const teamModel = models.find((m) => m.type === "model" && m.agent === "title" && m.team?.team === "crew")
    expect(teamModel).toBeDefined()
    expect(teamModel?.team).toEqual({ level: "project", team: "crew" })
    expect(teamModel?.active).toBe(true)
  } finally {
    fixture.destroy()
  }
})

test("ctrl+space selects an Agents-group agent through the core picker, never special or team member rows", async () => {
  const snapshot: Snapshot = {
    ...createSnapshot({
      agents: [
        { id: "alpha", scope: "project" as const, origin: "user" as const, fileBacked: true },
        { id: "title", scope: "defaults" as const, origin: "special" as const, fileBacked: false },
      ],
    }),
    teams: [{ level: "project" as const, team: "crew", enabled: true, agents: ["mate"] }],
  }
  const fixture = await renderInstructionsRoute({ snapshots: [snapshot], agents: [agentInfo("alpha")], width: 120, height: 40 })
  try {
    await goto(fixture, "agent:project:alpha", "alpha")
    expect(binds(fixture)).toContain("ctrl+space")
    expect(footer(fixture.captureCharFrame())).toContain("ctrl+space select")
    expect(dispatch(fixture, "ctrl+space")).toBe(true)
    expect(fixture.fake.agentSelects).toEqual(["alpha"])
    expect(fixture.fake.mutateInputs.length).toBe(0)

    // Team member rows keep their own (non-select) behaviour.
    await goto(fixture, "team:project:crew:mate", "mate")
    expect(binds(fixture)).toContain("space")
    expect(binds(fixture)).not.toContain("ctrl+space")
    expect(fixture.fake.agentSelects).toEqual(["alpha"])

    // Special agents are not offered by the picker: no select bind. They sit
    // under Defaults → Agents → OpenCode → Special.
    await goto(fixture, "agent:defaults:title", "title")
    expect(breadcrumb(fixture.captureCharFrame())).toContain("Defaults › Agents › OpenCode › Special › title")
    expect(binds(fixture)).toContain("space")
    expect(binds(fixture)).not.toContain("ctrl+space")
    expect(fixture.fake.agentSelects).toEqual(["alpha"])
  } finally {
    fixture.destroy()
  }
})

// ---------------------------------------------------------------------------
// Phase 4: create flows (a → name → preset → done), relink (l), delete of
// presets and entries, from-labels, and state/pin/model review choices.
