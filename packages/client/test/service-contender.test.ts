import { expect, test } from "bun:test"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnServiceContender, type ServiceContender } from "../src/service-contender"

async function waitForClose(contender: ServiceContender) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (contender.closed()) return
    await Bun.sleep(10)
  }
  throw new Error("Timed out waiting for child process to close")
}

test("spawns a child with an explicit working directory", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "opencode-contender-test-")))
  const contender = spawnServiceContender(
    process.execPath,
    ["-e", "console.error(process.cwd())"],
    undefined,
    directory,
  )
  try {
    await waitForClose(contender)
    expect(contender.stderr()).toBe(directory)
  } finally {
    contender.release()
    await rm(directory, { recursive: true, force: true })
  }
})

test("spawns a child inheriting the parent working directory when no directory is supplied", async () => {
  const contender = spawnServiceContender(process.execPath, ["-e", "console.error(process.cwd())"])
  try {
    await waitForClose(contender)
    expect(contender.stderr()).toBe(process.cwd())
  } finally {
    contender.release()
  }
})
