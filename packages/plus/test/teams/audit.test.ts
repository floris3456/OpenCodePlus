import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { append, exportChain, verify } from "../../src/teams/audit.js"

let dir = ""

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "teams-audit-"))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex")
}

async function logLines(): Promise<string[]> {
  const content = await readFile(join(dir, "audit.log"), "utf8")
  return content.split("\n").filter((line) => line.length > 0)
}

describe("audit chain", () => {
  test("three appends chain, verify ok, export strips hmac", async () => {
    await append(dir, "tool.call", { tool: "a", n: 1 })
    await append(dir, "tool.call", { tool: "b", n: 2 })
    await append(dir, "run.created", { run: "w-abc" })
    const raws = await logLines()
    expect(raws.length).toBe(3)
    const lines = raws.map((r) => JSON.parse(r) as Record<string, unknown>)
    expect(lines[1].prev).toBe(sha256(raws[0]))
    expect(lines[2].prev).toBe(sha256(raws[1]))
    for (const l of lines) expect(typeof l.hmac).toBe("string")

    const v = await verify(dir)
    expect(v.ok).toBe(true)
    expect(v.lines).toBe(3)

    const exported = await exportChain(dir)
    const outLines = exported.split("\n").filter((l) => l.length > 0)
    expect(outLines.length).toBe(3)
    for (const l of outLines) {
      expect(l).not.toContain('"hmac"')
      const parsed = JSON.parse(l) as Record<string, unknown>
      expect("hmac" in parsed).toBe(false)
      expect(typeof parsed.prev).toBe("string")
    }
  })

  test("rewriting one line payload fails verify with badLine", async () => {
    await append(dir, "tool.call", { tool: "a", n: 1 })
    await append(dir, "tool.call", { tool: "b", n: 2 })
    await append(dir, "tool.call", { tool: "c", n: 3 })
    const raws = await logLines()
    const tampered = JSON.parse(raws[1]) as Record<string, unknown>
    tampered.tool = "tampered"
    raws[1] = JSON.stringify(tampered)
    await writeFile(join(dir, "audit.log"), raws.join("\n") + "\n")
    const v = await verify(dir)
    expect(v.ok).toBe(false)
    expect(v.badLine).toBe(2)
  })

  test("key file exists with mode 0600 and never enters the log", async () => {
    await append(dir, "tool.call", { tool: "a" })
    const st = await stat(join(dir, "audit.key"))
    expect(st.mode & 0o777).toBe(0o600)
    const key = (await readFile(join(dir, "audit.key"), "utf8")).trim()
    const content = await readFile(join(dir, "audit.log"), "utf8")
    expect(content.includes(key)).toBe(false)
  })

  test("verify on an empty root is ok with zero lines", async () => {
    expect(await verify(dir)).toEqual({ ok: true, lines: 0 })
    expect(await exportChain(dir)).toBe("")
  })
})
