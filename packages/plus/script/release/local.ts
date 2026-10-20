#!/usr/bin/env bun
/**
 * A local release: this checkout's committed source, built for this machine, installed beside the
 * running release and switched to as soon as no chat runs; and built for the other release targets
 * (from linux-arm64: linux-x64, darwin-arm64 and darwin-x64) as archives to install on another
 * machine, which are not installed here. It runs no tests; a typecheck keeps a broken build from
 * replacing a working one. Its version adds a preview number to the release it leads up to
 * (2.0.26-plus-1.3.11.2), so it never takes the name a published release will have.
 *
 *   bun packages/plus/script/release/local.ts [--plus 1.3.11] [--prefix <install>] [--launcher <cmd>] [--detach]
 *     [--no-cross] [--build-only]
 *
 *   --plus        the release this previews; default: the one the newest installed preview leads up to
 *   --prefix      the install made by install.sh (default ~/.opencodeplus)
 *   --launcher    a command that runs the install with its own environment and runs
 *                 $OPENCODEPLUS_EXEC instead of the active release; default: the new binary itself
 *   --detach      switch in the background, logging to <prefix>/local/<version>/switch.log. A chat
 *                 on the same service must use it: the switch waits for that chat to end.
 *   --no-cross    build for this machine only
 *   --build-only  build every target and keep all their archives in <prefix>/local/<version>;
 *                 install and switch nothing (the next local release takes the same version)
 *
 * One fixed-path build (fixed-path-build.ts, which the public release's Linux builds run; its macOS
 * builds run the same build-plus.ts) makes this machine's target first and then the others from the
 * same checkout; each of those takes seconds, as they reuse the first one's packages and web UI.
 * This machine's build is installed and the switch starts as soon as it is out, while the others
 * build. Their archives stay in <prefix>/local/<version>/ with the release.json and install.sh that
 * cover them, and the script ends by printing how to install one on another machine. A build for
 * another machine that fails never holds up or undoes this machine's install and switch: it is
 * reported, the build's output stays in build.log there, and the exit status is 1.
 *
 * The switch is the new release's own `opencodeplus upgrade`: it waits until no chat runs, stops
 * the service, copies the database, moves the pointer, starts the new release, checks it, and
 * returns to the previous release and database if anything fails.
 */
import { mkdir, readdir, readlink, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { $ } from "bun"
import { PlusVersion } from "@opencode/util/plus-version"
import { ReleaseTarget } from "../../src/release/identity.js"
import { packageRelease } from "../release.js"

if (import.meta.main) await main()

async function main() {
  const args = parseArgs({
    options: {
      plus: { type: "string" },
      prefix: { type: "string" },
      launcher: { type: "string" },
      detach: { type: "boolean", default: false },
      cross: { type: "boolean", default: true },
      "build-only": { type: "boolean", default: false },
    },
    allowNegative: true,
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
  const others = args.cross ? ReleaseTarget.literals.filter((other) => other !== target) : []
  const built = (item: ReleaseTarget) => path.join(out, "build", `cli-${item}`, "bin/opencodeplus")
  console.log(`Local release ${version} from ${commit.slice(0, 10)}`)

  step("Typecheck")
  await quiet($`${process.execPath} run typecheck`.cwd(repoRoot))

  step(others.length > 0 ? `Build for ${target}, then for ${others.join(", ")}` : `Build for ${target}`)
  await mkdir(out, { recursive: true })
  const log = path.join(out, "build.log")
  const build = Bun.spawn(
    [
      ...["sh", "-c", 'exec "$@" >"$0" 2>&1', log],
      ...[process.execPath, "packages/plus/script/release/fixed-path-build.ts"],
      ...[target, ...others].flatMap((item) => ["--target", item]),
      ...(others.length > 0 ? ["--cross"] : []),
      ...["--out", path.join(out, "build")],
    ],
    { cwd: repoRoot, env: { ...process.env, OPENCODE_VERSION: version } },
  )
  if (!(await appeared(built(target), build.exited))) {
    console.error(tail(await Bun.file(log).text()))
    fail(`the build failed (exit ${await build.exited}); nothing was switched. Its output is in ${log}`)
  }
  const sourceDateEpoch = Number((await $`git log -1 --format=%ct ${commit}`.cwd(repoRoot).text()).trim())
  const release = { version, sourceSha: commit, outDir: out, repoRoot, sourceDateEpoch }

  const switched = args["build-only"]
    ? 0
    : await installAndSwitch({
        ...release,
        target,
        binary: await Bun.file(built(target)).bytes(),
        prefix,
        launcher: args.launcher,
        detach: args.detach,
        started,
        build: build.exited,
      })

  if (others.length > 0) step(`Finish the builds for ${others.join(", ")}`)
  const status = await build.exited
  const ready = (
    await Promise.all(others.map(async (item) => ((await Bun.file(built(item)).exists()) ? [item] : [])))
  ).flat()
  const missing = others.filter((item) => !ready.includes(item))
  const kept = args["build-only"] ? [target, ...ready] : ready
  const packaged =
    kept.length > 0
      ? await packageRelease({
          ...release,
          binaries: new Map(
            await Promise.all(kept.map(async (item) => [item, await Bun.file(built(item)).bytes()] as const)),
          ),
        })
      : undefined
  await rm(path.join(out, "build"), { recursive: true, force: true })
  if (packaged) {
    console.log(`${args["build-only"] ? "Builds" : "Builds for other machines"}, in ${out}:`)
    packaged.manifest.artifacts.forEach((artifact) =>
      console.log(`  ${artifact.target.padEnd(13)} ${artifact.archiveName} (${Math.round(artifact.bytes / 1e6)} MB)`),
    )
    console.log(
      [
        "To install one, copy install.sh, release.json and that machine's archive there and run, in their directory:",
        "  bash install.sh --manifest release.json --archive opencodeplus-<target>.tar.gz",
        "Where OpenCodePlus is installed already, that stages it beside the active release; switch to it with",
        `  ~/.opencodeplus/releases/${version}/bin/opencodeplus upgrade v${version}`,
      ].join("\n"),
    )
  }
  if (missing.length === 0 && status === 0) await rm(log)
  if (missing.length > 0 || status !== 0)
    console.error(
      `local release: ${missing.length > 0 ? `no build for ${missing.join(", ")}` : `the build ended with exit ${status}`}; the build's output is in ${log}`,
    )
  console.log(`Done in ${Math.round((Date.now() - started) / 1000)} s.`)
  process.exit(switched !== 0 ? switched : missing.length > 0 || status !== 0 ? 1 : 0)
}

/**
 * Installs this machine's build beside the running release and switches to it: in the background
 * with `detach`, else here, returning the switch's exit status.
 */
async function installAndSwitch(input: {
  version: string
  sourceSha: string
  outDir: string
  repoRoot: string
  sourceDateEpoch: number
  target: ReleaseTarget
  binary: Uint8Array
  prefix: string
  launcher: string | undefined
  detach: boolean
  started: number
  build: Promise<number>
}) {
  const packaged = await packageRelease({ ...input, binaries: new Map([[input.target, input.binary]]) })
  const archive = path.join(input.outDir, packaged.manifest.artifacts[0].archiveName)
  step(`Install beside the running release in ${input.prefix}`)
  await quiet(
    $`bash ${path.join(input.outDir, "install.sh")} --manifest ${path.join(input.outDir, "release.json")} --archive ${archive} --prefix ${input.prefix} --version v${input.version} --stage --no-modify-path`,
    input.build,
  )
  await rm(archive)

  const executable = path.join(input.prefix, "releases", input.version, "bin/opencodeplus")
  const command = [input.launcher ?? executable, "upgrade", `v${input.version}`]
  const env = { ...process.env, OPENCODEPLUS_EXEC: executable }
  console.log(`Built and installed in ${Math.round((Date.now() - input.started) / 1000)} s.`)
  if (input.detach) {
    const log = path.join(input.outDir, "switch.log")
    await $`setsid -f sh -c ${'exec "$@" >>"$0" 2>&1'} ${log} ${command}`.env(env)
    console.log(`Switching as soon as no chat runs (this one included); progress in ${log}`)
    return 0
  }
  step("Switch when no chat runs")
  return await Bun.spawn(command, { env, stdio: ["inherit", "inherit", "inherit"] }).exited
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
    Math.max(
      0,
      ...installed.filter((info) => PlusVersion.compareTriple(info.plus, base) === 0).map((info) => info.preview ?? 0),
    ) + 1
  const next = { opencode, plus: base, preview }
  const pointer = await readlink(path.join(prefix, "bin/opencodeplus")).catch(() => "")
  const active = PlusVersion.parse(/^\.\.\/releases\/([^/]+)\/bin\/opencodeplus$/.exec(pointer)?.[1] ?? "")
  if (active && PlusVersion.compare(next, active) <= 0)
    fail(
      `${PlusVersion.format(next)} would not be newer than the active ${PlusVersion.format(active)}; pass a higher --plus`,
    )
  return PlusVersion.format(next)
}

function triple(text: string) {
  const info = PlusVersion.parse(`0.0.0-plus-${text}`)
  return info && info.preview === undefined ? info.plus : undefined
}

/** Whether `file` exists by the time `ended` resolves; it is checked every quarter second until then. */
async function appeared(file: string, ended: Promise<unknown>) {
  const done = ended.then(() => true)
  while (!(await Bun.file(file).exists())) {
    if (await Promise.race([done, Bun.sleep(250).then(() => false)])) return Bun.file(file).exists()
  }
  return true
}

/**
 * Runs a step silently; on failure shows the end of what it printed and stops, once `running` has
 * ended: the build removes its checkout at the fixed build path when it ends, and a local release
 * started again before that could not build.
 */
async function quiet(shell: ReturnType<typeof $>, running?: Promise<unknown>) {
  const result = await shell.nothrow().quiet()
  if (result.exitCode === 0) return
  console.error(tail(`${result.stdout.toString()}${result.stderr.toString()}`))
  await running
  fail(`the step above failed (exit ${result.exitCode}); nothing was switched`)
}

function tail(text: string) {
  return text.trim().split("\n").slice(-40).join("\n")
}

function step(name: string) {
  console.log(`· ${name}…`)
}

function fail(message: string): never {
  console.error(`local release: ${message}`)
  process.exit(1)
}
