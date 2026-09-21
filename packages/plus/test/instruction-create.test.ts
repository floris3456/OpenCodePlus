import { afterEach, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Location } from "@opencode/schema/location"
import { Project } from "@opencode/schema/project"
import { AbsolutePath } from "@opencode/schema/schema"
import { createHandlers, createState } from "../src/index.js"
import { enable } from "../src/project.js"
import { context, fullContext } from "./harness.js"

const roots: string[] = []
const priorConfigDir = process.env.OPENCODE_CONFIG_DIR

afterEach(async () => {
  if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function tempRoot(): Promise<{ root: string; project: string; config: string }> {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-instruction-create-"))
  roots.push(root)
  const config = path.join(root, "config")
  process.env.OPENCODE_CONFIG_DIR = config
  return { root, project: path.join(root, "project"), config }
}

interface CapturedError {
  type: string
  message: string
  data?: unknown
}

function throwingContext(captured: { current?: CapturedError }): {
  error: (type: string, message: string, data?: unknown) => never
} {
  return {
    error: (type, message, data) => {
      const failure: CapturedError = data === undefined ? { type, message } : { type, message, data }
      captured.current = failure
      throw failure
    },
  }
}

async function expectDeclaredError(
  effect: Effect.Effect<unknown, unknown>,
  captured: { current?: CapturedError },
  type: string,
): Promise<CapturedError> {
  const exit = await Effect.runPromiseExit(effect)
  expect(Exit.isFailure(exit)).toBe(true)
  expect(captured.current?.type).toBe(type)
  return captured.current as CapturedError
}

function acceptedNamesMessage(failure: CapturedError): string {
  const data = failure.data as { reason?: string } | undefined
  return `${failure.message} ${data?.reason ?? ""}`
}

test("a non-AGENTS.md name is refused with instruction.invalid and no file is written", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const handlers = createHandlers(fullContext({ directory: project }), createState())
  for (const name of ["STYLE.md", "STYLE"]) {
    const captured: { current?: CapturedError } = {}
    const failure = await expectDeclaredError(
      handlers["instruction.create"]({ name, text: "Style guide." }, throwingContext(captured)),
      captured,
      "instruction.invalid",
    )
    expect(acceptedNamesMessage(failure)).toContain("AGENTS.md")
    expect(await Bun.file(path.join(project, "STYLE.md")).exists()).toBe(false)
  }
})

// OpenCodePlus: AGENTS.md handling is disabled pending the Context catalogue
// (src/instructions/discover.ts). Tests that exist only to exercise AGENTS.md
// rows, their apply, or instruction.create/delete are skipped, not deleted, so
// the rework re-enables them with the feature.
test.skip("a valid creation appears in a real instructions.snapshot as system:AGENTS.md", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const handlers = createHandlers(fullContext({ directory: project }), createState())
  const created = await Effect.runPromise(
    handlers["instruction.create"]({ name: "AGENTS.md", text: "Follow the guide." }, throwingContext({})),
  )
  expect(created).toEqual({ id: "system:AGENTS.md", path: path.join(project, "AGENTS.md") })
  expect(await Bun.file(created.path).text()).toContain("Follow the guide.")
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const item = snapshot.items.find((entry) => entry.id === "system:AGENTS.md")
  expect(item).toBeDefined()
  expect(item?.text).toContain("Follow the guide.")
})

test.skip("AGENTS.md outside the session ancestor path is refused, on the path it is accepted and discovered", async () => {
  const { project } = await tempRoot()
  const nested = path.join(project, "nested")
  await fs.mkdir(nested, { recursive: true })
  await enable(project)
  await enable(nested)
  const base = fullContext({ directory: nested })
  const location = new Location.Info({
    directory: AbsolutePath.make(nested),
    project: {
      id: Project.ID.global,
      directory: AbsolutePath.make(project),
      canonical: AbsolutePath.make(project),
    },
  })
  const handlers = createHandlers(context({ ...base, location } as never), createState())
  const refused: { current?: CapturedError } = {}
  const failure = await expectDeclaredError(
    handlers["instruction.create"]({ name: "sub/AGENTS.md", text: "Sibling guide." }, throwingContext(refused)),
    refused,
    "instruction.invalid",
  )
  expect(acceptedNamesMessage(failure)).toContain("AGENTS.md")
  expect(await Bun.file(path.join(nested, "sub", "AGENTS.md")).exists()).toBe(false)
  const before = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  expect(before.items.some((entry) => entry.id === "system:sub/AGENTS.md")).toBe(false)
  const created = await Effect.runPromise(
    handlers["instruction.create"]({ name: "AGENTS.md", text: "Nested guide." }, throwingContext({})),
  )
  expect(created.path).toBe(path.join(nested, "AGENTS.md"))
  const after = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const item = after.items.find((entry) => entry.id === "system:AGENTS.md")
  expect(item).toBeDefined()
  expect(item?.text).toContain("Nested guide.")
})

test.skip("traversal, empty, NUL, and duplicate refusals still hold", async () => {
  const { root, project } = await tempRoot()
  await enable(project)
  const handlers = createHandlers(fullContext({ directory: project }), createState())
  for (const name of ["", "   ", "a\0b", "../evil", "sub/../../evil", "/tmp/plus-instruction-create-escape"]) {
    const captured: { current?: CapturedError } = {}
    await expectDeclaredError(handlers["instruction.create"]({ name, text: "x" }, throwingContext(captured)), captured, "instruction.invalid")
  }
  expect(await Bun.file(path.join(root, "evil.md")).exists()).toBe(false)
  expect(await Bun.file(path.join(project, "evil.md")).exists()).toBe(false)
  expect(await Bun.file("/tmp/plus-instruction-create-escape.md").exists()).toBe(false)
  const created = await Effect.runPromise(
    handlers["instruction.create"]({ name: "AGENTS.md", text: "Original." }, throwingContext({})),
  )
  const duplicate: { current?: CapturedError } = {}
  await expectDeclaredError(
    handlers["instruction.create"]({ name: "AGENTS.md", text: "Again." }, throwingContext(duplicate)),
    duplicate,
    "instruction.exists",
  )
  expect(await Bun.file(created.path).text()).toContain("Original.")
})
