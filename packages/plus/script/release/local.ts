#!/usr/bin/env bun
/**
 * A local release: this checkout's committed source, built for this machine only, installed
 * beside the running release and switched to as soon as no chat runs. It runs no tests; a
 * typecheck keeps a broken build from replacing a working one. Its version adds a preview
 * number to the release it leads up to (2.0.26-plus-1.3.11.2), so it never takes the name a
 * published release will have.
 *
 *   bun packages/plus/script/release/local.ts [--plus 1.3.11] [--prefix <install>] [--launcher <cmd>] [--detach]
 *
 *   --plus      the release this previews; default: the one the newest installed preview leads up to
 *   --prefix    the install made by install.sh (default ~/.opencodeplus)
 *   --launcher  a command that runs the install with its own environment and runs
 *               $OPENCODEPLUS_EXEC instead of the active release; default: the new binary itself
 *   --detach    switch in the background, logging to <prefix>/local/<version>/switch.log. A chat
 *               on the same service must use it: the switch waits for that chat to end.
 *
 * The switch is the new release's own `opencodeplus upgrade`: it waits until no chat runs, stops
 * the service, copies the database, moves the pointer, starts the new release, checks it, and
 * returns to the previous release and database if anything fails.
 */
import { readdir, readlink, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { $ } from "bun"
import { PlusVersion } from "@opencode/util/plus-version"
import type { ReleaseTarget } from "../../src/release/identity.js"
import { packageRelease } from "../release.js"

if (import.meta.main) await main()

async function main() {
  const args = parseArgs({
    options: {
      plus: { type: "string" },
      prefix: { type: "string" },
      launcher: { type: "string" },
      detach: { type: "boolean", default: false },
    },
  }).values
  const started = Date.now()
  const repoRoot = path.resolve(import.meta.dir, "../../../..")
  const prefix = path.resolve(args.prefix ?? path.join(os.homedir(), ".opencodeplus"))
  const dirty = (await $`git status --porcelain --untracked-files=no`.cwd(repoRoot).text()).trim()
  if (dirty) fail(`commit first; a local release builds only committed source:\n${dirty}`)

  const version = await nextVersion(repoRoot, prefix, args.plus)
  const commit = (await $`git rev-parse HEAD`.cwd(repoRoot).text()).trim()
  const out = path.join(prefix, "local", version)
  const target = `${process.platform}-${process.arch}` as ReleaseTarget
  console.log(`Local release ${version} from ${commit.slice(0, 10)}`)

  step("Typecheck")
  await quiet($`${process.execPath} run typecheck`.cwd(repoRoot))

  step(`Build for ${target}`)
  await quiet(
    $`${process.execPath} packages/plus/script/release/fixed-path-build.ts --target ${target} --out ${path.join(out, "build")}`
      .cwd(repoRoot)
      .env({ ...process.env, OPENCODE_VERSION: version }),
  )
  const binary = await Bun.file(path.join(out, "build", `cli-${target}`, "bin/opencodeplus")).bytes()
  const packaged = await packageRelease({
    version,
    sourceSha: commit,
    binaries: new Map([[target, binary]]),
    outDir: out,
    repoRoot,
    sourceDateEpoch: Number((await $`git log -1 --format=%ct ${commit}`.cwd(repoRoot).text()).trim()),
  })
  const archive = path.join(out, packaged.manifest.artifacts[0].archiveName)

  step(`Install beside the running release in ${prefix}`)
  await quiet(
    $`bash ${path.join(out, "install.sh")} --manifest ${path.join(out, "release.json")} --archive ${archive} --prefix ${prefix} --version v${version} --stage --no-modify-path`,
  )
  await rm(path.join(out, "build"), { recursive: true })
  await rm(archive)

  const executable = path.join(prefix, "releases", version, "bin/opencodeplus")
  const command = args.launcher ? [args.launcher, "upgrade", `v${version}`] : [executable, "upgrade", `v${version}`]
  const env = { ...process.env, OPENCODEPLUS_EXEC: executable }
  console.log(`Built and installed in ${Math.round((Date.now() - started) / 1000)} s.`)
  if (args.detach) {
    const log = path.join(out, "switch.log")
    await $`setsid -f sh -c ${'exec "$@" >>"$0" 2>&1'} ${log} ${command}`.env(env)
    console.log(`Switching as soon as no chat runs (this one included); progress in ${log}`)
    return
  }
  step("Switch when no chat runs")
  const switched = Bun.spawnSync(command, { env, stdio: ["inherit", "inherit", "inherit"] })
  process.exit(switched.exitCode)
}

/** The next preview of the release it leads up to, newer than the active release. */
async function nextVersion(repoRoot: string, prefix: string, plus: string | undefined) {
  const opencode = triple((await Bun.file(path.join(repoRoot, "packages/cli/package.json")).json()).version)
  if (!opencode) fail("packages/cli/package.json has no three-number version")
  const installed = (await readdir(path.join(prefix, "releases")).catch(() => [])).flatMap((name) => {
    const info = PlusVersion.parse(name)
    return info ? [info] : []
  })
  const published = (info: PlusVersion.Info) =>
    installed.some((other) => other.preview === undefined && PlusVersion.compareTriple(other.plus, info.plus) === 0)
  const base = plus
    ? triple(plus)
    : installed
        .filter((info) => info.preview !== undefined && !published(info))
        .toSorted(PlusVersion.compare)
        .at(-1)?.plus
  if (!base) fail("pass --plus <x.y.z>: the release this local release leads up to, e.g. --plus 1.3.11")
  const preview =
    Math.max(0, ...installed.filter((info) => PlusVersion.compareTriple(info.plus, base) === 0).map((info) => info.preview ?? 0)) + 1
  const next = { opencode, plus: base, preview }
  const pointer = await readlink(path.join(prefix, "bin/opencodeplus")).catch(() => "")
  const active = PlusVersion.parse(/^\.\.\/releases\/([^/]+)\/bin\/opencodeplus$/.exec(pointer)?.[1] ?? "")
  if (active && PlusVersion.compare(next, active) <= 0)
    fail(`${PlusVersion.format(next)} would not be newer than the active ${PlusVersion.format(active)}; pass a higher --plus`)
  return PlusVersion.format(next)
}

function triple(text: string) {
  const info = PlusVersion.parse(`0.0.0-plus-${text}`)
  return info && info.preview === undefined ? info.plus : undefined
}

/** Runs a step silently; on failure shows the end of what it printed and stops. */
async function quiet(shell: ReturnType<typeof $>) {
  const result = await shell.nothrow().quiet()
  if (result.exitCode === 0) return
  console.error(`${result.stdout.toString()}${result.stderr.toString()}`.trim().split("\n").slice(-40).join("\n"))
  fail(`the step above failed (exit ${result.exitCode}); nothing was switched`)
}

function step(name: string) {
  console.log(`· ${name}…`)
}

function fail(message: string): never {
  console.error(`local release: ${message}`)
  process.exit(1)
}
