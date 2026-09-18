import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  addAdhoc,
  adhoc,
  byState,
  claim,
  create,
  load,
  open,
  reworkTask,
  setState,
  unblock,
} from "../../src/teams/tasks.js"
import type { TaskInput } from "../../src/teams/tasks.js"

let dir = ""

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "teams-tasks-"))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function task(id: string, dependsOn: string[] = [], overrides?: Partial<TaskInput>): TaskInput {
  return {
    id,
    title: `Task ${id}`,
    dependsOn,
    role: "muse-implementer",
    effort: "small",
    deliverable: { kind: "commit" },
    paths: [`src/${id}.ts`],
    checks: [{ id: "unit", argv: ["bun", "test", "packages/plus/test/model.test.ts"] }],
    ...overrides,
  }
}

function asErr(e: unknown): { code?: unknown; message: string; accepted?: unknown } {
  if (typeof e === "object" && e !== null && "message" in e) {
    const o = e as { code?: unknown; message: unknown; accepted?: unknown }
    return { code: o.code, message: String(o.message), accepted: o.accepted }
  }
  return { message: String(e) }
}

describe("diamond dependencies", () => {
  test("T1 open, rest blocked; unblock cascades only when all parents done", async () => {
    await create(dir, "plan-diamond", [task("T1"), task("T2", ["T1"]), task("T3", ["T1"]), task("T4", ["T2", "T3"])])
    const g = await load(dir, "plan-diamond")
    expect(g.tasks["T1"].state).toBe("open")
    expect(g.tasks["T2"].state).toBe("blocked")
    expect(await unblock(dir, "plan-diamond")).toEqual([])
    await setState(dir, "plan-diamond", "T1", "done", "test")
    expect((await unblock(dir, "plan-diamond")).sort()).toEqual(["T2", "T3"])
    await setState(dir, "plan-diamond", "T2", "done", "test")
    expect(await unblock(dir, "plan-diamond")).toEqual([])
    await setState(dir, "plan-diamond", "T3", "done", "test")
    expect(await unblock(dir, "plan-diamond")).toEqual(["T4"])
    expect((await open(dir, "plan-diamond")).map((t) => t.id).sort()).toEqual(["T4"])
    expect((await byState(dir, "plan-diamond", "done")).map((t) => t.id).sort()).toEqual(["T1", "T2", "T3"])
  })
})

describe("claim", () => {
  test("two concurrent claims: exactly one wins with E_TASK_CLAIMED", async () => {
    await create(dir, "plan-race", [task("T1")])
    const a = "w-aaaaaaaaaaaaaaaa"
    const b = "w-bbbbbbbbbbbbbbbb"
    const results = await Promise.allSettled([claim(dir, "plan-race", "T1", a), claim(dir, "plan-race", "T1", b)])
    const won = results.filter((r) => r.status === "fulfilled")
    const lost = results.filter((r) => r.status === "rejected")
    expect(won.length).toBe(1)
    expect(lost.length).toBe(1)
    const winner = won[0].status === "fulfilled" ? won[0].value.run : undefined
    expect(winner === a || winner === b).toBe(true)
    const err = asErr((lost[0] as PromiseRejectedResult).reason)
    expect(err.code).toBe("E_TASK_CLAIMED")
    expect(err.message).toContain(winner ?? "")
    const back = await load(dir, "plan-race")
    expect(back.tasks["T1"].state).toBe("claimed")
    expect(back.tasks["T1"].run).toBe(winner)
  })

  test("claiming a blocked task throws E_TASK_BLOCKED", async () => {
    await create(dir, "plan-blocked", [task("T1"), task("T2", ["T1"]), task("T3", ["T1"])])
    let err: ReturnType<typeof asErr> | undefined
    try {
      await claim(dir, "plan-blocked", "T3", "w-cccccccccccccccc")
    } catch (e) {
      err = asErr(e)
    }
    expect(err?.code).toBe("E_TASK_BLOCKED")
    expect(err?.message).toContain("T3")
    expect(err?.accepted).toBeDefined()
  })
})

describe("create validation", () => {
  test("unknown dependency and cycles throw E_DEPS", async () => {
    let unknown: ReturnType<typeof asErr> | undefined
    try {
      await create(dir, "plan-unknown", [task("T4", ["T9"])])
    } catch (e) {
      unknown = asErr(e)
    }
    expect(unknown?.code).toBe("E_DEPS")
    let cycle: ReturnType<typeof asErr> | undefined
    try {
      await create(dir, "plan-cycle", [task("T1", ["T2"]), task("T2", ["T1"])])
    } catch (e) {
      cycle = asErr(e)
    }
    expect(cycle?.code).toBe("E_DEPS")
    expect(cycle?.message).toContain("cycle")
  })
})

describe("reworkTask", () => {
  test("produces T1.rework.1 and moves T1 to rework", async () => {
    await create(dir, "plan-rework", [task("T1")])
    const files = ["src/conflict-a.ts", "src/conflict-b.ts"]
    const checks = [{ id: "unit", argv: ["bun", "test", "packages/plus/test/model.test.ts"] }]
    const id = await reworkTask(dir, "plan-rework", "T1", files, checks)
    expect(id).toBe("T1.rework.1")
    const g = await load(dir, "plan-rework")
    expect(g.tasks[id].state).toBe("open")
    expect(g.tasks[id].paths).toEqual(files)
    expect(g.tasks["T1"].state).toBe("rework")
  })

  test("refuses beyond .rework.8 with E_REWORK_LIMIT", async () => {
    await create(dir, "plan-limit", [task("T1")])
    const checks = [{ id: "unit", argv: ["bun", "test", "packages/plus/test/model.test.ts"] }]
    for (let n = 1; n <= 8; n++) {
      const id = await reworkTask(dir, "plan-limit", "T1", [`src/f${n}.ts`], checks)
      expect(id).toBe(`T1.rework.${n}`)
      await setState(dir, "plan-limit", "T1", "queued_merge", "test")
    }
    let err: ReturnType<typeof asErr> | undefined
    try {
      await reworkTask(dir, "plan-limit", "T1", ["src/f9.ts"], checks)
    } catch (e) {
      err = asErr(e)
    }
    expect(err?.code).toBe("E_REWORK_LIMIT")
  })
})

describe("adhoc and setState", () => {
  test("addAdhoc returns fresh ids and illegal transitions throw", async () => {
    const base = {
      title: "adhoc work",
      role: "scout",
      effort: "small" as const,
      paths: ["src/a.ts"],
      checks: [{ id: "unit", argv: ["bun", "test", "packages/plus/test/model.test.ts"] }],
    }
    expect(await addAdhoc(dir, base)).toBe("T1")
    expect(await addAdhoc(dir, { ...base, title: "more" })).toBe("T2")
    expect((await adhoc(dir)).tasks["T1"].state).toBe("open")
    await create(dir, "plan-trans", [task("T1")])
    let err: ReturnType<typeof asErr> | undefined
    try {
      await setState(dir, "plan-trans", "T1", "blocked", "test")
    } catch (e) {
      err = asErr(e)
    }
    expect(err?.code).toBe("E_TASK_TRANSITION")
  })
})
