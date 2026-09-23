#!/usr/bin/env bun
/**
 * Release build at the fixed build path pinned in release/toolchain.json.
 *
 * `bun build --compile` embeds absolute source paths in the executable (bundled
 * CommonJS modules keep their build-time __dirname and __filename), so one commit
 * built from two different directories yields binaries that differ in module bytes
 * and in the shared bytecode string table, and rebuild equivalence refuses the pair.
 * Every Linux release build, in CI and on a local machine, therefore checks the exact
 * commit out at the one pinned path and builds there.
 *
 *   OPENCODE_VERSION=<version> bun packages/plus/script/release/fixed-path-build.ts \
 *     --target linux-arm64 --out <dir> [--cross]
 *
 * The parent of the fixed path must exist and be writable by the building user; the
 * fixed path itself must not exist. It is created as a git worktree of this checkout's
 * HEAD for the duration of the build and removed afterwards, so no build runs on top of
 * an earlier tree. The identity the binary embeds (source SHA, SOURCE_DATE_EPOCH, recipe
 * and toolchain digests, target) is derived from that commit; a value already present in
 * the environment, as CI sets them, must agree or the build is refused. The channel,
 * compile template, timezone and locale are set from release/toolchain.json whatever the
 * calling shell has.
 *
 * A target other than the host's is refused unless --cross is given, so CI, which never
 * passes it, can only produce its runner's native target.
 */
import { constants } from "node:fs"
import { access, cp, lstat, mkdir, stat } from "node:fs/promises"
import path from "node:path"
import { parseArgs } from "node:util"
import { $ } from "bun"
import { Release } from "../../src/release/identity.js"
import { computeRecipeDigest, loadRecipeInputs } from "./recipe.js"

if (import.meta.main) await main()

async function main() {
  const args = parseArgs({
    options: {
      target: { type: "string" },
      out: { type: "string" },
      cross: { type: "boolean", default: false },
    },
  }).values
  if (!args.target || !args.out) throw new Error("usage: fixed-path-build.ts --target <platform> --out <dir> [--cross]")
  const version = process.env.OPENCODE_VERSION
  if (!version) throw new Error("OPENCODE_VERSION is required: the version is part of the build's identity")

  const repoRoot = (await $`git rev-parse --show-toplevel`.cwd(import.meta.dir).text()).trim()
  const dirty = (await $`git status --porcelain --untracked-files=no`.cwd(repoRoot).text()).trim()
  if (dirty) throw new Error(`the checkout has tracked modifications; build only committed source:\n${dirty}`)

  const toolchain = await Bun.file(path.join(repoRoot, "release/toolchain.json")).json()
  const contract = await Bun.file(path.join(repoRoot, "release/contract.json")).json()
  if (Bun.version !== toolchain.bun.version) {
    throw new Error(`the release toolchain is Bun ${toolchain.bun.version}; this is Bun ${Bun.version}`)
  }
  checkTarget({
    target: args.target,
    host: `${process.platform}-${process.arch}`,
    cross: args.cross,
    qualified: contract.qualifiedTargets,
  })
  const fixed = fixedBuildPathOf(toolchain)
  await checkBuildLocation(fixed)
  const out = path.resolve(args.out)
  if (out === fixed || out.startsWith(`${fixed}${path.sep}`)) throw new Error(`--out ${out} is inside ${fixed}`)
  const produced = path.join(out, `cli-${args.target}`)
  if (await Bun.file(path.join(produced, "bin/opencodeplus")).exists()) throw new Error(`${produced} already exists`)

  const commit = (await $`git rev-parse HEAD`.cwd(repoRoot).text()).trim()
  await $`git worktree add --detach ${fixed} ${commit}`.cwd(repoRoot)
  try {
    const identity = agreeingIdentity(process.env, {
      OPENCODE_VERSION: version,
      OPENCODE_SOURCE_SHA: commit,
      SOURCE_DATE_EPOCH: (await $`git log -1 --format=%ct ${commit}`.cwd(fixed).text()).trim(),
      OPENCODE_RECIPE_DIGEST: computeRecipeDigest(await loadRecipeInputs({ repoRoot: fixed, version })),
      OPENCODE_TOOLCHAIN_DIGEST: Release.computeToolchainDigest(
        await Bun.file(path.join(fixed, "release/toolchain.json")).json(),
      ),
      OPENCODE_TARGET: args.target,
    })
    // The build environment is pinned, not asserted: whatever the calling shell
    // has, the build runs with the toolchain's compile template, timezone and locale.
    const pinned = {
      OPENCODE_CHANNEL: "plus",
      BUN_COMPILE_RELEASE: `bun-v${toolchain.bun.version}`,
      TZ: toolchain.timezone,
      LC_ALL: toolchain.locale,
    }
    const env = { ...process.env, ...identity, ...pinned }
    await $`${process.execPath} install --frozen-lockfile`.cwd(fixed).env(env)
    const selection = args.cross ? `--target=${args.target}` : "--single"
    await $`${process.execPath} packages/cli/script/build-plus.ts ${selection}`.cwd(fixed).env(env)
    // Installing or building must not change the source that was built.
    const changed = (await $`git status --porcelain --untracked-files=all`.cwd(fixed).text()).trim()
    if (changed) throw new Error(`the build changed the source tree at ${fixed}:\n${changed}`)
    await mkdir(out, { recursive: true })
    await cp(path.join(fixed, "packages/cli/dist", `cli-${args.target}`), produced, { recursive: true })
    const binary = path.join(produced, "bin/opencodeplus")
    const bytes = await Bun.file(binary).bytes()
    const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
    console.log(
      JSON.stringify(
        { fixedBuildPath: fixed, commit, cross: args.cross, binary, size: bytes.byteLength, sha256, identity, pinned },
        null,
        2,
      ),
    )
  } finally {
    await $`git worktree remove --force ${fixed}`.cwd(repoRoot)
  }
}

/** The pinned build directory: absolute and already in normal form, or the toolchain is refused. */
export function fixedBuildPathOf(toolchain: { fixedBuildPath?: unknown }) {
  const fixed = toolchain.fixedBuildPath
  if (typeof fixed !== "string" || !path.isAbsolute(fixed) || path.resolve(fixed) !== fixed || fixed === "/") {
    throw new Error(
      `release/toolchain.json fixedBuildPath must be an absolute, normalized path; got ${JSON.stringify(fixed)}`,
    )
  }
  return fixed
}

/** The fixed path must be free and its parent a writable directory the build can create it in. */
export async function checkBuildLocation(fixed: string) {
  const existing = await lstat(fixed).catch(() => undefined)
  if (existing) {
    throw new Error(`${fixed} already exists; a fixed-path build owns that path for its duration (remove it first)`)
  }
  const parent = path.dirname(fixed)
  const parentStat = await stat(parent).catch(() => undefined)
  if (!parentStat?.isDirectory()) {
    throw new Error(
      `${parent} does not exist; create it once, writable by the building user (e.g. sudo install -d -o "$(id -u)" -g "$(id -g)" ${parent})`,
    )
  }
  await access(parent, constants.W_OK).catch(() => {
    throw new Error(
      `${parent} is not writable by this user; make it so once (e.g. sudo chown "$(id -u):$(id -g)" ${parent})`,
    )
  })
}

/** Only a qualified target builds, and only the host's own unless a cross build is requested explicitly. */
export function checkTarget(input: { target: string; host: string; cross: boolean; qualified: readonly string[] }) {
  if (!input.qualified.includes(input.target)) {
    throw new Error(`${input.target} is not a qualified target (${input.qualified.join(", ")})`)
  }
  if (input.target !== input.host && !input.cross) {
    throw new Error(`${input.target} is not this host's target (${input.host}); pass --cross to cross-build it`)
  }
}

/** Identity values the build embeds; a caller-supplied value that disagrees is a refusal, not an override. */
export function agreeingIdentity(env: Record<string, string | undefined>, derived: Record<string, string>) {
  const conflicts = Object.entries(derived).filter(([key, value]) => env[key] !== undefined && env[key] !== value)
  if (conflicts.length > 0) {
    throw new Error(
      `the environment disagrees with the build's derived identity: ${conflicts
        .map(([key, value]) => `${key}=${env[key]} (derived ${value})`)
        .join("; ")}`,
    )
  }
  return derived
}
