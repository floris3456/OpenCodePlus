import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createDeterministicArchive,
  createTarHeader,
  compressGzip,
  packageTarget,
  createReleaseManifest,
  serializeReleaseManifest,
  generateSha256Sums,
} from "../../script/release.js"
import { type ReleaseTarget, type ArtifactIdentity } from "../../src/release/identity.js"

let testDir: string
const repoRoot = join(import.meta.dirname, "../../../..")

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "installer-test-"))
})

afterEach(async () => {
  try {
    // Restore write permissions so rm can remove immutable release directories
    Bun.spawnSync(["chmod", "-R", "u+w", testDir])
    await rm(testDir, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

function getCurrentTarget(): ReleaseTarget {
  const os = process.platform === "darwin" ? "darwin" : "linux"
  const arch = process.arch === "arm64" ? "arm64" : "x64"
  return `${os}-${arch}` as ReleaseTarget
}

function computeSha256(buffer: Uint8Array | Buffer): string {
  return new Bun.CryptoHasher("sha256").update(buffer).digest("hex")
}

async function runInstaller(
  args: string[],
  options?: {
    env?: Record<string, string>
    cwd?: string
  },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const installerPath = join(repoRoot, "install.sh")
  const proc = Bun.spawn(["bash", installerPath, ...args], {
    cwd: options?.cwd ?? testDir,
    env: {
      ...process.env,
      ...options?.env,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}

async function setupReleaseAssets(
  assetDir: string,
  options?: {
    version?: string
    target?: ReleaseTarget
    binaryContent?: Buffer
    archiveBufferOverride?: Buffer
    tamperArchiveSha?: boolean
  },
): Promise<{
  version: string
  target: ReleaseTarget
  archiveName: string
  archiveSha256: string
  binarySha256: string
}> {
  await mkdir(assetDir, { recursive: true })
  const version = options?.version ?? "1.0.0"
  const target = options?.target ?? getCurrentTarget()
  const binaryContent =
    options?.binaryContent ?? Buffer.from(`#!/bin/sh\necho "opencodeplus-${version}"\n`)

  let archiveBuffer: Buffer
  let binarySha256 = computeSha256(binaryContent)

  if (options?.archiveBufferOverride) {
    archiveBuffer = options.archiveBufferOverride
  } else {
    const packaged = packageTarget({
      target,
      binaryContent,
      version,
      sourceSha: "0123456789abcdef0123456789abcdef01234567",
      recipeDigest: "0".repeat(64),
      toolchainDigest: "1".repeat(64),
      sourceDateEpoch: 1700000000,
    })
    archiveBuffer = packaged.archiveBuffer
    binarySha256 = packaged.artifact.binarySha256
  }

  const archiveName = `opencodeplus-${target}.tar.gz`
  let archiveSha256 = computeSha256(archiveBuffer)

  await writeFile(join(assetDir, archiveName), archiveBuffer)

  if (options?.tamperArchiveSha) {
    archiveSha256 = "f".repeat(64)
  }

  const artifact: ArtifactIdentity = {
    target,
    archiveName,
    archiveSha256,
    binarySha256,
    bytes: archiveBuffer.byteLength,
  }

  const manifest = createReleaseManifest({
    release: {
      product: "opencodeplus",
      channel: "plus",
      version,
      sourceSha: "0123456789abcdef0123456789abcdef01234567",
      recipeDigest: "0".repeat(64),
      toolchainDigest: "1".repeat(64),
    },
    artifacts: [artifact],
    installerSha256: "2".repeat(64),
  })

  await writeFile(join(assetDir, "release.json"), serializeReleaseManifest(manifest))

  const sums = generateSha256Sums([
    { filename: archiveName, sha256: archiveSha256 },
    { filename: "release.json", sha256: computeSha256(Buffer.from(serializeReleaseManifest(manifest))) },
  ])
  await writeFile(join(assetDir, "SHA256SUMS"), sums)

  return { version, target, archiveName, archiveSha256, binarySha256 }
}

describe("installer positive execution", () => {
  test("happy path: installs binary into prefix and activates in bin", async () => {
    const assetDir = join(testDir, "assets")
    const prefix = join(testDir, "opt/opencodeplus")
    const fakeHome = join(testDir, "fake-home")
    await mkdir(fakeHome, { recursive: true })
    await writeFile(join(fakeHome, ".bashrc"), "# existing bashrc\n")

    await setupReleaseAssets(assetDir, { version: "1.0.0" })

    const res = await runInstaller(
      ["--offline", "--asset-dir", assetDir, "--prefix", prefix],
      { env: { HOME: fakeHome } },
    )

    expect(res.exitCode).toBe(0)

    const releaseBinary = join(prefix, "releases/1.0.0/bin/opencodeplus")
    expect(await Bun.file(releaseBinary).exists()).toBe(true)

    const activeBinary = join(prefix, "bin/opencodeplus")
    expect(await Bun.file(activeBinary).exists()).toBe(true)

    // Execute active binary
    const runProc = Bun.spawn([activeBinary], { stdout: "pipe" })
    const runOutput = await new Response(runProc.stdout).text()
    expect(runOutput.trim()).toBe("opencodeplus-1.0.0")

    // Shell profile updated
    const bashrcContent = await Bun.file(join(fakeHome, ".bashrc")).text()
    expect(bashrcContent.includes(join(prefix, "bin"))).toBe(true)
  })

  test("idempotent reinstall: succeeds without rewriting immutable release directory", async () => {
    const assetDir = join(testDir, "assets")
    const prefix = join(testDir, "opt/opencodeplus")
    const fakeHome = join(testDir, "fake-home")
    await mkdir(fakeHome, { recursive: true })

    await setupReleaseAssets(assetDir, { version: "1.0.0" })

    // First install
    const res1 = await runInstaller(
      ["--offline", "--asset-dir", assetDir, "--prefix", prefix, "--no-modify-path"],
      { env: { HOME: fakeHome } },
    )
    expect(res1.exitCode).toBe(0)

    // Second install (same version)
    const res2 = await runInstaller(
      ["--offline", "--asset-dir", assetDir, "--prefix", prefix, "--no-modify-path"],
      { env: { HOME: fakeHome } },
    )
    expect(res2.exitCode).toBe(0)
    expect(res2.stdout.includes("already installed")).toBe(true)
  })

  test("existing release directory is immutable and preserved", async () => {
    const assetDir = join(testDir, "assets")
    const prefix = join(testDir, "opt/opencodeplus")

    await setupReleaseAssets(assetDir, { version: "1.0.0" })

    const res1 = await runInstaller([
      "--offline",
      "--asset-dir",
      assetDir,
      "--prefix",
      prefix,
      "--no-modify-path",
    ])
    expect(res1.exitCode).toBe(0)

    // Direct immutability proof: write into releases/1.0.0 fails with EACCES
    const canaryPath = join(prefix, "releases/1.0.0/canary.txt")
    expect(writeFile(canaryPath, "test")).rejects.toThrow()

    // Add canary file by temporarily enabling write permissions, then locking it back
    await chmod(join(prefix, "releases/1.0.0"), 0o755)
    await writeFile(canaryPath, "immutable canary\n")
    await chmod(join(prefix, "releases/1.0.0"), 0o555)

    // Reinstall
    const res2 = await runInstaller([
      "--offline",
      "--asset-dir",
      assetDir,
      "--prefix",
      prefix,
      "--no-modify-path",
    ])
    expect(res2.exitCode).toBe(0)

    // Canary must still exist untouched
    expect(await Bun.file(canaryPath).exists()).toBe(true)
    expect(await Bun.file(canaryPath).text()).toBe("immutable canary\n")
  })

  test("staging-only over an incumbent: stages new version without replacing active binary", async () => {
    const assetDirV1 = join(testDir, "assets-v1")
    const assetDirV2 = join(testDir, "assets-v2")
    const prefix = join(testDir, "opt/opencodeplus")

    await setupReleaseAssets(assetDirV1, { version: "1.0.0" })
    await setupReleaseAssets(assetDirV2, { version: "2.0.0" })

    // Install v1 (initial incumbent)
    const res1 = await runInstaller([
      "--offline",
      "--asset-dir",
      assetDirV1,
      "--prefix",
      prefix,
      "--no-modify-path",
    ])
    expect(res1.exitCode).toBe(0)

    // Active binary runs v1
    const activeBinary = join(prefix, "bin/opencodeplus")
    let proc = Bun.spawn([activeBinary], { stdout: "pipe" })
    expect((await new Response(proc.stdout).text()).trim()).toBe("opencodeplus-1.0.0")

    // Install v2 over incumbent
    const res2 = await runInstaller([
      "--offline",
      "--asset-dir",
      assetDirV2,
      "--prefix",
      prefix,
      "--no-modify-path",
    ])
    expect(res2.exitCode).toBe(0)
    expect(res2.stdout.includes("Incumbent release detected")).toBe(true)
    expect(res2.stdout.includes("without activating over incumbent")).toBe(true)

    // v2 release directory was staged
    expect(await Bun.file(join(prefix, "releases/2.0.0/bin/opencodeplus")).exists()).toBe(true)

    // Active binary STILL runs v1!
    proc = Bun.spawn([activeBinary], { stdout: "pipe" })
    expect((await new Response(proc.stdout).text()).trim()).toBe("opencodeplus-1.0.0")
  })

  test("read-only profile: prints PATH instructions and exits successfully", async () => {
    const assetDir = join(testDir, "assets")
    const prefix = join(testDir, "opt/opencodeplus")
    const fakeHome = join(testDir, "fake-home")
    await mkdir(fakeHome, { recursive: true })

    const bashrc = join(fakeHome, ".bashrc")
    await writeFile(bashrc, "# read-only bashrc\n")
    await chmod(bashrc, 0o444) // make read-only

    await setupReleaseAssets(assetDir, { version: "1.0.0" })

    const res = await runInstaller(
      ["--offline", "--asset-dir", assetDir, "--prefix", prefix],
      { env: { HOME: fakeHome } },
    )

    expect(res.exitCode).toBe(0)
    expect(res.stdout.includes("read-only")).toBe(true)
    expect(res.stdout.includes(`export PATH="${prefix}/bin:$PATH"`)).toBe(true)

    // Revert chmod so cleanup succeeds
    await chmod(bashrc, 0o644)
  })

  test("offline assets: succeeds with offline flag and no network", async () => {
    const assetDir = join(testDir, "assets")
    const prefix = join(testDir, "opt/opencodeplus")

    await setupReleaseAssets(assetDir, { version: "1.0.0" })

    const res = await runInstaller([
      "--offline",
      "--asset-dir",
      assetDir,
      "--prefix",
      prefix,
      "--no-modify-path",
      "--base-url",
      "https://127.0.0.1:1/invalid",
    ])

    expect(res.exitCode).toBe(0)
    expect(await Bun.file(join(prefix, "releases/1.0.0/bin/opencodeplus")).exists()).toBe(true)
  })

  test("release tag convention: v-prefixed tag installs under the unprefixed manifest version", async () => {
    const tag = "v0.0.0-plus-r4.1"
    const version = tag.replace(/^v/, "")
    const assetDir = join(testDir, "assets-tag-convention")

    // The build derives the manifest version from the git tag by stripping the
    // leading "v", so tag v0.0.0-plus-r4.1 produces a manifest whose version is
    // 0.0.0-plus-r4.1. install.sh has to accept both the tag spelling and the
    // canonical version spelling.
    await setupReleaseAssets(assetDir, { version })

    const tagPrefix = join(testDir, "opt/tag-form")
    const tagForm = await runInstaller([
      "--offline",
      "--asset-dir",
      assetDir,
      "--prefix",
      tagPrefix,
      "--no-modify-path",
      "--version",
      tag,
    ])
    expect(tagForm.exitCode).toBe(0)
    expect(await Bun.file(join(tagPrefix, `releases/${version}/bin/opencodeplus`)).exists()).toBe(true)

    const versionPrefix = join(testDir, "opt/version-form")
    const versionForm = await runInstaller([
      "--offline",
      "--asset-dir",
      assetDir,
      "--prefix",
      versionPrefix,
      "--no-modify-path",
      "--version",
      version,
    ])
    expect(versionForm.exitCode).toBe(0)
    expect(await Bun.file(join(versionPrefix, `releases/${version}/bin/opencodeplus`)).exists()).toBe(true)

    // A request that does not match the manifest still fails closed.
    const mismatch = await runInstaller([
      "--offline",
      "--asset-dir",
      assetDir,
      "--prefix",
      join(testDir, "opt/mismatch"),
      "--no-modify-path",
      "--version",
      "v9.9.9",
    ])
    expect(mismatch.exitCode).not.toBe(0)
    expect(mismatch.stderr.includes("does not match manifest version")).toBe(true)
  })
})

describe("installer download location and shell", () => {
  // A stub curl records each URL and serves the matching file from a local
  // asset directory, so the real download path runs without network.
  async function stubCurl(assetDir: string, log: string): Promise<string> {
    const bin = join(testDir, "stub-bin")
    await mkdir(bin, { recursive: true })
    await writeFile(
      join(bin, "curl"),
      [
        "#!/usr/bin/env bash",
        "url=''; out=''",
        'while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac; done',
        `echo "$url" >> ${JSON.stringify(log)}`,
        `cp ${JSON.stringify(assetDir)}/"$(basename "$url")" "$out"`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    )
    return bin
  }

  test("downloads the fixed-tag release.json and archive from the GitHub release by default", async () => {
    const assetDir = join(testDir, "assets")
    const log = join(testDir, "curl.log")
    const version = "0.0.0-plus-r4.1"
    const { archiveName } = await setupReleaseAssets(assetDir, { version })
    const bin = await stubCurl(assetDir, log)
    // An empty override counts as unset, so the built-in default is what runs.
    const res = await runInstaller(
      ["--prefix", join(testDir, "opt/opencodeplus"), "--no-modify-path", "--version", `v${version}`],
      { env: { PATH: `${bin}:${process.env.PATH ?? ""}`, OPENCODE_RELEASE_BASE_URL: "" } },
    )

    expect(res.exitCode).toBe(0)
    const base = `https://github.com/floris3456/OpenCodePlus/releases/download/v${version}`
    expect((await Bun.file(log).text()).trim().split("\n")).toEqual([`${base}/release.json`, `${base}/${archiveName}`])
    expect(await Bun.file(join(testDir, `opt/opencodeplus/releases/${version}/bin/opencodeplus`)).exists()).toBe(true)
  })

  test("a download without a version is refused instead of guessing a latest release", async () => {
    const res = await runInstaller(["--prefix", join(testDir, "opt/none"), "--no-modify-path"])
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toContain("a download needs a release version")
  })

  test("run by a non-bash sh it stops with instructions before any bash construct", async () => {
    const posixSh = Bun.which("dash")
    if (!posixSh) throw new Error("this check needs dash, the /bin/sh of Debian")
    const proc = Bun.spawn([posixSh, join(repoRoot, "install.sh"), "--version", "v1.0.0"], {
      cwd: testDir,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
    expect(exitCode).not.toBe(0)
    expect(stderr.trim()).toBe(
      "Error: install.sh requires bash. Run: curl -fsSL <install.sh URL> | bash -s -- --version <version>",
    )
  })

  test("bash started as sh (POSIX mode) still installs", async () => {
    const assetDir = join(testDir, "assets")
    await setupReleaseAssets(assetDir, { version: "1.0.0" })
    const proc = Bun.spawn(
      ["bash", "--posix", join(repoRoot, "install.sh"), "--offline", "--asset-dir", assetDir, "--no-modify-path"],
      { cwd: testDir, env: { ...process.env, PREFIX: join(testDir, "opt/posix") }, stdout: "pipe", stderr: "pipe" },
    )
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
    expect(stderr).toBe("")
    expect(exitCode).toBe(0)
    expect(await Bun.file(join(testDir, "opt/posix/releases/1.0.0/bin/opencodeplus")).exists()).toBe(true)
  })
})

describe("installer negative execution and hostile archive protection", () => {
  test("negative case: bad archive hash fails closed", async () => {
    const assetDir = join(testDir, "assets-bad-hash")
    const prefix = join(testDir, "opt/opencodeplus")

    await setupReleaseAssets(assetDir, {
      version: "1.0.0",
      tamperArchiveSha: true,
    })

    const res = await runInstaller([
      "--offline",
      "--asset-dir",
      assetDir,
      "--prefix",
      prefix,
      "--no-modify-path",
    ])

    expect(res.exitCode).not.toBe(0)
    expect(res.stderr.includes("checksum mismatch")).toBe(true)
    expect(await Bun.file(join(prefix, "releases/1.0.0")).exists()).toBe(false)
  })

  test("negative case: truncated archive fails closed", async () => {
    const assetDir = join(testDir, "assets-truncated")
    const prefix = join(testDir, "opt/opencodeplus")

    const fullArchive = createDeterministicArchive([
      { name: "bin/opencodeplus", content: "binary\n", mode: 0o755 },
      { name: "metadata.json", content: "{}\n", mode: 0o644 },
      { name: "LICENSE", content: "MIT\n", mode: 0o644 },
      { name: "NOTICE", content: "Notice\n", mode: 0o644 },
    ])
    // Truncate to first 40 bytes
    const truncatedBuffer = fullArchive.subarray(0, 40)

    await setupReleaseAssets(assetDir, {
      version: "1.0.0",
      archiveBufferOverride: Buffer.from(truncatedBuffer),
    })

    const res = await runInstaller([
      "--offline",
      "--asset-dir",
      assetDir,
      "--prefix",
      prefix,
      "--no-modify-path",
    ])

    expect(res.exitCode).not.toBe(0)
    expect(res.stderr.includes("Corrupt or truncated")).toBe(true)
    expect(await Bun.file(join(prefix, "releases/1.0.0")).exists()).toBe(false)
  })

  test("negative case: traversal member in archive fails closed", async () => {
    const assetDir = join(testDir, "assets-traversal")
    const prefix = join(testDir, "opt/opencodeplus")

    const hostileArchive = createDeterministicArchive([
      { name: "bin/opencodeplus", content: "binary\n", mode: 0o755 },
      { name: "metadata.json", content: "{}\n", mode: 0o644 },
      { name: "LICENSE", content: "MIT\n", mode: 0o644 },
      { name: "NOTICE", content: "Notice\n", mode: 0o644 },
      { name: "../evil.txt", content: "evil\n", mode: 0o644 },
    ])

    await setupReleaseAssets(assetDir, {
      version: "1.0.0",
      archiveBufferOverride: hostileArchive,
    })

    const res = await runInstaller([
      "--offline",
      "--asset-dir",
      assetDir,
      "--prefix",
      prefix,
      "--no-modify-path",
    ])

    expect(res.exitCode).not.toBe(0)
    expect(res.stderr.includes("path traversal")).toBe(true)
    expect(await Bun.file(join(prefix, "releases/1.0.0")).exists()).toBe(false)
  })

  test("negative case: symlink member in archive fails closed", async () => {
    const assetDir = join(testDir, "assets-symlink")
    const prefix = join(testDir, "opt/opencodeplus")

    const binaryContent = Buffer.from("binary\n")
    const h1 = createTarHeader("bin/opencodeplus", binaryContent.length, 0o755, 0, 0, 0, "0")
    const p1 = (512 - (binaryContent.length % 512)) % 512
    const hSym = createTarHeader("LICENSE", 0, 0o777, 0, 0, 0, "2", "bin/opencodeplus")
    const hMeta = createTarHeader("metadata.json", 3, 0o644, 0, 0, 0, "0")
    const metaPad = Buffer.alloc(509, 0)
    const hNot = createTarHeader("NOTICE", 7, 0o644, 0, 0, 0, "0")
    const notPad = Buffer.alloc(505, 0)
    const eof = Buffer.alloc(1024, 0)

    const tar = Buffer.concat([
      h1,
      binaryContent,
      Buffer.alloc(p1, 0),
      hSym,
      hMeta,
      Buffer.from("{}\n"),
      metaPad,
      hNot,
      Buffer.from("Notice\n"),
      notPad,
      eof,
    ])
    const hostileArchive = compressGzip(tar)

    await setupReleaseAssets(assetDir, {
      version: "1.0.0",
      archiveBufferOverride: hostileArchive,
    })

    const res = await runInstaller([
      "--offline",
      "--asset-dir",
      assetDir,
      "--prefix",
      prefix,
      "--no-modify-path",
    ])

    expect(res.exitCode).not.toBe(0)
    expect(res.stderr.includes("link member detected") || res.stderr.includes("non-regular")).toBe(true)
    expect(await Bun.file(join(prefix, "releases/1.0.0")).exists()).toBe(false)
  })

  test("negative case: duplicate member in archive fails closed", async () => {
    const assetDir = join(testDir, "assets-duplicate")
    const prefix = join(testDir, "opt/opencodeplus")

    const binaryContent = Buffer.from("binary\n")
    const h1 = createTarHeader("bin/opencodeplus", binaryContent.length, 0o755, 0, 0, 0, "0")
    const p1 = (512 - (binaryContent.length % 512)) % 512
    const hDup = createTarHeader("bin/opencodeplus", binaryContent.length, 0o755, 0, 0, 0, "0")
    const hMeta = createTarHeader("metadata.json", 3, 0o644, 0, 0, 0, "0")
    const metaPad = Buffer.alloc(509, 0)
    const hLic = createTarHeader("LICENSE", 4, 0o644, 0, 0, 0, "0")
    const licPad = Buffer.alloc(508, 0)
    const hNot = createTarHeader("NOTICE", 7, 0o644, 0, 0, 0, "0")
    const notPad = Buffer.alloc(505, 0)
    const eof = Buffer.alloc(1024, 0)

    const tar = Buffer.concat([
      h1,
      binaryContent,
      Buffer.alloc(p1, 0),
      hDup,
      binaryContent,
      Buffer.alloc(p1, 0),
      hMeta,
      Buffer.from("{}\n"),
      metaPad,
      hLic,
      Buffer.from("MIT\n"),
      licPad,
      hNot,
      Buffer.from("Notice\n"),
      notPad,
      eof,
    ])
    const hostileArchive = compressGzip(tar)

    await setupReleaseAssets(assetDir, {
      version: "1.0.0",
      archiveBufferOverride: hostileArchive,
    })

    const res = await runInstaller([
      "--offline",
      "--asset-dir",
      assetDir,
      "--prefix",
      prefix,
      "--no-modify-path",
    ])

    expect(res.exitCode).not.toBe(0)
    expect(res.stderr.includes("duplicate member")).toBe(true)
    expect(await Bun.file(join(prefix, "releases/1.0.0")).exists()).toBe(false)
  })

  test("negative case: oversized member in archive fails closed", async () => {
    const assetDir = join(testDir, "assets-oversized")
    const prefix = join(testDir, "opt/opencodeplus")

    const bigText = Buffer.alloc(11 * 1024 * 1024, 0x61) // 11MB of 'a'
    const hostileArchive = createDeterministicArchive([
      { name: "bin/opencodeplus", content: "binary\n", mode: 0o755 },
      { name: "metadata.json", content: "{}\n", mode: 0o644 },
      { name: "LICENSE", content: "MIT\n", mode: 0o644 },
      { name: "NOTICE", content: bigText, mode: 0o644 },
    ])

    await setupReleaseAssets(assetDir, {
      version: "1.0.0",
      archiveBufferOverride: hostileArchive,
    })

    const res = await runInstaller([
      "--offline",
      "--asset-dir",
      assetDir,
      "--prefix",
      prefix,
      "--no-modify-path",
    ])

    expect(res.exitCode).not.toBe(0)
    expect(res.stderr.includes("exceeds size bound")).toBe(true)
    expect(await Bun.file(join(prefix, "releases/1.0.0")).exists()).toBe(false)
  })

  test("negative case: unexpected member not in contract whitelist fails closed", async () => {
    const assetDir = join(testDir, "assets-unexpected")
    const prefix = join(testDir, "opt/opencodeplus")

    const hostileArchive = createDeterministicArchive([
      { name: "bin/opencodeplus", content: "binary\n", mode: 0o755 },
      { name: "metadata.json", content: "{}\n", mode: 0o644 },
      { name: "LICENSE", content: "MIT\n", mode: 0o644 },
      { name: "NOTICE", content: "Notice\n", mode: 0o644 },
      { name: "malicious.sh", content: "rm -rf /\n", mode: 0o755 },
    ])

    await setupReleaseAssets(assetDir, {
      version: "1.0.0",
      archiveBufferOverride: hostileArchive,
    })

    const res = await runInstaller([
      "--offline",
      "--asset-dir",
      assetDir,
      "--prefix",
      prefix,
      "--no-modify-path",
    ])

    expect(res.exitCode).not.toBe(0)
    expect(res.stderr.includes("not in contract whitelist")).toBe(true)
    expect(await Bun.file(join(prefix, "releases/1.0.0")).exists()).toBe(false)
  })
})
