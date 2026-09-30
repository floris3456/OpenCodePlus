#!/usr/bin/env bun
/**
 * Native update gate: proves on the machine that built a target that installs of
 * that platform can update to this candidate, and that a failed update comes back.
 *
 *   bun packages/plus/script/release/update-gate.ts --target <platform> --version <version> \
 *     --archive <candidate archive> --meta <archive .meta.json>
 *
 * Everything runs in a scratch home with its own XDG folders, install prefix and
 * service port. A local release site shaped like GitHub's serves the candidate.
 *
 * 1. From the release marked Latest (when there is one in the 2.0.18-plus-1.0.0
 *    scheme): install it with its own install.sh, start its service, create a
 *    session, then run *its* `opencodeplus upgrade`, which must stage and switch
 *    to the candidate. This is exactly what every install on Latest will do.
 * 2. From the candidate: publish a release one patch newer whose binary answers
 *    --version but cannot serve. `opencodeplus upgrade` must fail and leave the
 *    candidate's pointer, running service and session in place.
 *
 * `--previous-site` replaces https://github.com/floris3456/OpenCodePlus for step 1.
 */
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { PlusVersion } from "@opencode/util/plus-version"
import type { ArtifactIdentity, ReleaseTarget } from "../../src/release/identity.js"
import { createReleaseManifest, generateSha256Sums, packageTarget, serializeReleaseManifest } from "../release.ts"

const args = parseArgs({
  options: {
    target: { type: "string" },
    version: { type: "string" },
    archive: { type: "string" },
    meta: { type: "string" },
    "previous-site": { type: "string", default: "https://github.com/floris3456/OpenCodePlus" },
    "site-port": { type: "string", default: "47911" },
    "service-port": { type: "string", default: "47912" },
  },
}).values
if (!args.target || !args.version || !args.archive || !args.meta)
  throw new Error("usage: update-gate.ts --target <t> --version <v> --archive <a> --meta <m>")
const target = args.target as ReleaseTarget
const version = args.version
const candidate = PlusVersion.parse(version)
if (!candidate) throw new Error(`${version} is not a release version`)

const repoRoot = join(import.meta.dir, "../../../..")
const root = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "ocp-update-gate-"))
const siteDir = join(root, "site")
const prefix = join(root, "prefix")
const project = join(root, "project")
const sitePort = Number(args["site-port"])
const servicePort = Number(args["service-port"])
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")
const log = (message: string) => console.log(`update-gate: ${message}`)
const fail = (message: string): never => {
  throw new Error(`update-gate: ${message}`)
}
let latest: string | undefined

const env = {
  HOME: join(root, "home"),
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_DATA_HOME: join(root, "data"),
  XDG_STATE_HOME: join(root, "state"),
  XDG_CACHE_HOME: join(root, "cache"),
  TMPDIR: join(root, "tmp"),
  PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
  OPENCODEPLUS_RELEASE_SITE: `http://127.0.0.1:${sitePort}/site`,
  OPENCODEPLUS_RELEASE_API: `http://127.0.0.1:${sitePort}/api`,
  OPENCODE_DISABLE_MODELS_FETCH: "1",
}
for (const dir of [env.HOME, env.TMPDIR, project, join(env.XDG_CONFIG_HOME, "opencodeplus")]) mkdirSync(dir, { recursive: true })
writeFileSync(join(env.XDG_CONFIG_HOME, "opencodeplus/service.json"), JSON.stringify({ port: servicePort }))
writeFileSync(join(env.XDG_CONFIG_HOME, "opencodeplus/opencode.json"), JSON.stringify({ update: "notify" }))

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: sitePort,
  fetch(request) {
    const path = new URL(request.url).pathname
    const latestAsset = /^\/site\/releases\/latest\/download\/([^/]+)$/.exec(path)
    const fixed = /^\/site\/releases\/download\/(v[^/]+)\/([^/]+)$/.exec(path)
    const file = latestAsset
      ? latest && join(siteDir, `v${latest}`, latestAsset[1])
      : fixed && join(siteDir, fixed[1], fixed[2])
    return file && existsSync(file) ? new Response(Bun.file(file)) : new Response("Not Found", { status: 404 })
  },
})

try {
  const previous = await previousRelease()
  if (previous) {
    log(`step 1: ${previous.version} (the release marked Latest) updates to ${version}`)
    await installFrom(previous.dir, previous.version)
  } else {
    log(`step 1 skipped: no release in the scheme is marked Latest at ${args["previous-site"]}, so no install can update yet`)
    publish(version, readFileSync(args.archive), JSON.parse(readFileSync(args.meta, "utf8")))
    await installFrom(join(siteDir, `v${version}`), version)
  }
  const service = await start()
  const canary = await api("POST", "/api/session", { title: "update-gate canary", location: { directory: project } })
  const canaryID = (canary as { data: { id: string } }).data.id

  if (previous) {
    publish(version, readFileSync(args.archive), JSON.parse(readFileSync(args.meta, "utf8")))
    latest = version
    const upgrade = await run([join(prefix, "bin/opencodeplus"), "upgrade"])
    if (upgrade.exitCode !== 0) fail(`${previous.version} could not update to ${version}:\n${upgrade.output}`)
    await expectRunning(version, service.pid, canaryID)
    log(`step 1 passed: ${previous.version} switched this install to ${version}`)
  }

  // Step 2: a release that stages but cannot serve must leave the candidate running.
  const broken = PlusVersion.format({ ...candidate, plus: [candidate.plus[0], candidate.plus[1], candidate.plus[2] + 1] })
  const script = `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "opencodeplus v${broken}"; exit 0; fi\necho "update-gate: this release cannot serve" >&2\nexit 1\n`
  const packaged = packageTarget({
    target,
    binaryContent: Buffer.from(script),
    version: broken,
    sourceSha: "0".repeat(40),
    recipeDigest: "0".repeat(64),
    toolchainDigest: "0".repeat(64),
  })
  publish(broken, packaged.archiveBuffer, packaged.artifact)
  latest = broken
  const before = (await info()).pid
  const failed = await run([join(prefix, "bin/opencodeplus"), "upgrade"])
  if (failed.exitCode === 0) fail(`the update to the broken ${broken} reported success`)
  if (!failed.output.includes("back on")) fail(`the failed update did not report returning:\n${failed.output}`)
  await expectRunning(version, before, canaryID)
  log(`step 2 passed: ${broken} did not start, and ${version} is running again with the session intact`)

  await run([join(prefix, "bin/opencodeplus"), "service", "stop"])
  log(`${target}: installs can update to ${version}, and a failed update returns`)
} finally {
  server.stop(true)
  await run([join(prefix, "bin/opencodeplus"), "service", "stop"])
  if (!process.env.OCP_UPDATE_GATE_KEEP) {
    Bun.spawnSync(["chmod", "-R", "u+w", root])
    rmSync(root, { recursive: true, force: true })
  }
}

/** The release marked Latest on the previous site, downloaded, when it is older and in the scheme. */
async function previousRelease() {
  const response = await fetch(`${args["previous-site"]}/releases/latest/download/release.json`)
  if (response.status === 404) return undefined
  if (!response.ok) fail(`reading the Latest release: HTTP ${response.status}`)
  const manifest = (await response.json()) as { release: { version: string }; artifacts: ArtifactIdentity[] }
  const previous = manifest.release.version
  const parsed = PlusVersion.parse(previous)
  if (!parsed) return undefined
  if (PlusVersion.compare(parsed, candidate!) >= 0) fail(`Latest ${previous} is not older than ${version}`)
  const artifact = manifest.artifacts.find((item) => item.target === target)
  if (!artifact) fail(`Latest ${previous} has no ${target} build`)
  const dir = join(root, "previous")
  mkdirSync(dir, { recursive: true })
  for (const name of ["release.json", "install.sh", "SHA256SUMS", artifact!.archiveName]) {
    const asset = await fetch(`${args["previous-site"]}/releases/download/v${previous}/${name}`)
    if (!asset.ok) fail(`downloading ${name} of ${previous}: HTTP ${asset.status}`)
    writeFileSync(join(dir, name), new Uint8Array(await asset.arrayBuffer()))
  }
  return { version: previous, dir }
}

/** Publishes one release on the local site as ocp-build's record-release job assembles it. */
function publish(release: string, archive: Uint8Array, artifact: ArtifactIdentity) {
  const dir = join(siteDir, `v${release}`)
  mkdirSync(dir, { recursive: true })
  const installer = readFileSync(join(repoRoot, "install.sh"))
  const manifest = serializeReleaseManifest(
    createReleaseManifest({
      release: {
        product: "opencodeplus",
        channel: "plus",
        version: release,
        sourceSha: "0".repeat(40),
        recipeDigest: "0".repeat(64),
        toolchainDigest: "0".repeat(64),
      },
      artifacts: [artifact],
      installerSha256: sha(installer),
    }),
  )
  writeFileSync(join(dir, artifact.archiveName), archive)
  writeFileSync(join(dir, "install.sh"), installer, { mode: 0o755 })
  writeFileSync(join(dir, "release.json"), manifest)
  writeFileSync(
    join(dir, "SHA256SUMS"),
    generateSha256Sums([
      { filename: artifact.archiveName, sha256: sha(archive) },
      { filename: "install.sh", sha256: sha(installer) },
      { filename: "release.json", sha256: sha(manifest) },
    ]),
  )
}

/** A first install, as a person makes it: the release's own install.sh from its assets. */
async function installFrom(dir: string, release: string) {
  const result = await run(["bash", join(dir, "install.sh"), "--offline", "--asset-dir", dir, "--prefix", prefix, "--no-modify-path", "--version", `v${release}`])
  if (result.exitCode !== 0) fail(`install.sh of ${release} failed:\n${result.output}`)
  if (readlinkSync(join(prefix, "bin/opencodeplus")) !== `../releases/${release}/bin/opencodeplus`)
    fail(`install.sh of ${release} did not point the install at it`)
}

async function start() {
  const result = await run([join(prefix, "bin/opencodeplus"), "service", "start"])
  if (result.exitCode !== 0) fail(`service start failed:\n${result.output}`)
  return info()
}

function registration() {
  return JSON.parse(readFileSync(join(env.XDG_STATE_HOME, "opencodeplus/service.json"), "utf8")) as {
    url: string
    pid: number
    password?: string
  }
}

async function api(method: string, route: string, body?: unknown) {
  const service = registration()
  const response = await fetch(new URL(route, service.url), {
    method,
    headers: {
      authorization: `Basic ${btoa(`opencode:${service.password ?? ""}`)}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) fail(`${method} ${route}: HTTP ${response.status} ${await response.text()}`)
  return response.json() as Promise<unknown>
}

async function info() {
  const answer = (await api("GET", "/api/info")) as { version: string; pid: number }
  if (answer.pid !== registration().pid) fail(`/api/info answers for pid ${answer.pid}, the registration names ${registration().pid}`)
  return answer
}

/** The install runs `release`: pointer, answering service and its process, with the session still there. */
async function expectRunning(release: string, earlierPid: number, sessionID: string) {
  const pointer = readlinkSync(join(prefix, "bin/opencodeplus"))
  if (pointer !== `../releases/${release}/bin/opencodeplus`) fail(`the install points at ${pointer}, not ${release}`)
  const answer = await info()
  if (answer.version !== release) fail(`the service answers as ${answer.version}, not ${release}`)
  if (answer.pid === earlierPid) fail(`the service is still the earlier process ${earlierPid}`)
  if (alive(earlierPid)) fail(`the earlier service ${earlierPid} is still running`)
  const sessions = (await api("GET", `/api/session?location%5Bdirectory%5D=${encodeURIComponent(project)}`)) as {
    data: { id: string }[]
  }
  if (!sessions.data.some((session) => session.id === sessionID)) fail(`session ${sessionID} is gone after the switch`)
  const backups = join(env.XDG_DATA_HOME, "opencodeplus/update-backups")
  if (!existsSync(backups) || readdirSync(backups).length === 0) fail("no database copy was kept")
}

function alive(pid: number) {
  return Bun.spawnSync(["kill", "-0", String(pid)]).exitCode === 0
}

// Asynchronous: the release site runs on this process's event loop, and a child
// that updates downloads from it.
async function run(command: string[]) {
  const child = Bun.spawn(command, { cwd: project, env, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { exitCode, output: `${stdout}${stderr}`.slice(-4000) }
}
