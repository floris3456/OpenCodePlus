import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

interface ActionStep {
  name?: string
  id?: string
  if?: string
  uses?: string
  with?: Record<string, unknown>
  run?: string
  shell?: string
  env?: Record<string, string>
  "working-directory"?: string
  "timeout-minutes"?: number
}

interface WorkflowJob {
  name?: string
  "runs-on"?: string | string[]
  environment?: string | { name: string }
  strategy?: {
    matrix?: {
      include?: Array<{
        target?: string
        runner?: string
        bun_sha256?: string | null
      }>
    }
  }
  steps?: ActionStep[]
  env?: Record<string, string>
}

interface WorkflowDoc {
  name?: string
  on?: Record<string, unknown>
  permissions?: Record<string, string>
  env?: Record<string, string>
  jobs?: Record<string, WorkflowJob>
}

interface ActionDoc {
  name?: string
  description?: string
  inputs?: Record<string, { description?: string; required?: boolean; default?: unknown }>
  runs?: {
    using?: string
    steps?: ActionStep[]
  }
}

interface CheckEntry {
  id: string
  argv: string[]
  cwd: string
}

interface ChecksJson {
  policyVersion: number
  checks: CheckEntry[]
}

interface ContractJson {
  contractVersion: number
  product: string
  channel: string
  targets: string[]
  qualifiedTargets: string[]
  unqualifiedTargets: string[]
}

interface ToolchainJson {
  bun: {
    version: string
    executableSha256: string | null
    source: string | null
    measuredBy: string
  }
}

const repoRoot = join(import.meta.dirname, "../../../..")

async function loadYaml<T>(relPath: string): Promise<T> {
  const filePath = join(repoRoot, relPath)
  const text = await Bun.file(filePath).text()
  return Bun.YAML.parse(text) as T
}

async function loadJson<T>(relPath: string): Promise<T> {
  const filePath = join(repoRoot, relPath)
  return (await Bun.file(filePath).json()) as T
}

interface GuardScenario {
  tagName: string
  /** The refs/tags answer: null means GitHub reports the tag does not exist. */
  tagRef: { ref: string; type: string; sha: string } | null
  /** The /git/tags/{sha} answer used when the tag object must be peeled. */
  tagObject?: { type: string; sha: string }
  /** What the ambiguous /commits/{ref} endpoint would have answered. */
  ambiguousRefSha: string
  run: {
    repository: string
    name: string
    path: string
    conclusion: string
    head_sha: string
    head_branch: string
    event: string
  }
}

/**
 * Runs the real guard script extracted from ocp-release.yml against a stub `gh`
 * on PATH. The stub answers the paths the guard actually calls; the scenario
 * also supplies what the ambiguous /commits/{ref} endpoint would answer, so a
 * rejection can be shown to come from tag resolution alone rather than from a
 * stub that fails everything.
 */
async function runVerificationGuard(
  script: string,
  scenario: GuardScenario,
): Promise<{ exitCode: number; output: string; githubEnv: string }> {
  const dir = await mkdtemp(join(tmpdir(), "release-guard-"))
  try {
    const stubBin = join(dir, "bin")
    await mkdir(stubBin, { recursive: true })

    const tagRefCase = scenario.tagRef
      ? `printf '%s\\n' ${JSON.stringify(scenario.tagRef.ref)} ${JSON.stringify(scenario.tagRef.type)} ${JSON.stringify(scenario.tagRef.sha)}`
      : `echo "gh: Not Found (HTTP 404)" >&2; exit 1`
    const tagObjectCase = scenario.tagObject
      ? `printf '%s\\n' ${JSON.stringify(scenario.tagObject.type)} ${JSON.stringify(scenario.tagObject.sha)}`
      : `echo "gh: Not Found (HTTP 404)" >&2; exit 1`
    const runCase = [
      scenario.run.repository,
      scenario.run.name,
      scenario.run.path,
      scenario.run.conclusion,
      scenario.run.head_sha,
      scenario.run.head_branch,
      scenario.run.event,
      "https://github.com/acme/opencodeplus/actions/runs/1",
    ]
      .map((field) => JSON.stringify(field))
      .join(" ")

    const stub = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'case "$2" in',
      `  */git/ref/tags/*) ${tagRefCase} ;;`,
      `  */git/tags/*) ${tagObjectCase} ;;`,
      `  */commits/*) printf '%s\\n' ${JSON.stringify(scenario.ambiguousRefSha)} ;;`,
      `  */actions/runs/*) printf '%s\\n' ${runCase} ;;`,
      '  *) echo "unexpected gh api path: $2" >&2; exit 1 ;;',
      "esac",
      "",
    ].join("\n")
    await writeFile(join(stubBin, "gh"), stub, { mode: 0o755 })

    const scriptPath = join(dir, "guard.sh")
    await writeFile(scriptPath, script)
    const githubEnvPath = join(dir, "github-env")
    await writeFile(githubEnvPath, "")

    const proc = Bun.spawn(["bash", scriptPath], {
      cwd: dir,
      env: {
        PATH: `${stubBin}:${process.env.PATH ?? ""}`,
        REPOSITORY: "acme/opencodeplus",
        RELEASE_TAG: scenario.tagName,
        BUILD_RUN_ID: "35800607403",
        GITHUB_ENV: githubEnvPath,
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return {
      exitCode,
      output: `${stdout}${stderr}`,
      githubEnv: await Bun.file(githubEnvPath).text(),
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * Runs the real setup-ocp "Verify Bun executable SHA256" shell step against a
 * stub `bun` on PATH. The stub lets a scenario choose what the step will hash,
 * so the fail-closed behaviour is proven by executing the step rather than by
 * matching its text.
 */
async function runBunShaVerification(
  script: string,
  expectedShaInput: string,
): Promise<{ exitCode: number; output: string; actualSha: string }> {
  const dir = await mkdtemp(join(tmpdir(), "setup-ocp-sha-"))
  try {
    const stubBin = join(dir, "bin")
    await mkdir(stubBin, { recursive: true })
    const stubPath = join(stubBin, "bun")
    await writeFile(stubPath, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 })
    const actualSha = createHash("sha256")
      .update(Buffer.from(await Bun.file(stubPath).arrayBuffer()))
      .digest("hex")

    const proc = Bun.spawn(["bash", "-c", script], {
      cwd: dir,
      env: {
        PATH: `${stubBin}:${process.env.PATH ?? ""}`,
        EXPECTED_SHA_INPUT: expectedShaInput,
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { exitCode, output: `${stdout}${stderr}`, actualSha }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe("native build workflow (ocp-build.yml)", () => {
  test("defines native build matrix with exact runner-to-target mapping for all qualified targets", async () => {
    const [doc, contract] = await Promise.all([
      loadYaml<WorkflowDoc>(".github/workflows/ocp-build.yml"),
      loadJson<ContractJson>("release/contract.json"),
    ])

    const buildJob = doc.jobs?.build
    expect(buildJob).toBeDefined()

    const matrixInclude = buildJob?.strategy?.matrix?.include
    expect(matrixInclude).toBeDefined()
    expect(matrixInclude?.length).toBe(4)

    // Labels verified 2026-09-23 against the "Available Images" table in
    // actions/runner-images@main README and the GitHub-hosted runners reference.
    // macos-15 (arm64) and macos-15-intel (x64) are the current non-deprecated
    // standard macOS labels; both Darwin targets therefore build on macOS 15.
    const expectedMapping: Record<string, string> = {
      "linux-arm64": "ubuntu-24.04-arm",
      "linux-x64": "ubuntu-24.04",
      "darwin-arm64": "macos-15",
      "darwin-x64": "macos-15-intel",
    }

    const actualTargets = matrixInclude?.map((entry) => entry.target).sort()
    const expectedTargets = Object.keys(expectedMapping).sort()
    expect(actualTargets).toEqual(expectedTargets)
    expect(actualTargets).toEqual(contract.qualifiedTargets.slice().sort())

    for (const entry of matrixInclude ?? []) {
      const target = entry.target as string
      expect(expectedMapping[target]).toBeDefined()
      expect(entry.runner).toBe(expectedMapping[target])
    }
  })

  test("gates every qualified target with a native cold-runtime step on that target's own runner", async () => {
    const [doc, contract] = await Promise.all([
      loadYaml<WorkflowDoc>(".github/workflows/ocp-build.yml"),
      loadJson<ContractJson>("release/contract.json"),
    ])

    const buildJob = doc.jobs?.build
    // The gate is a step of the matrix build job, so it necessarily executes on the
    // runner selected for that matrix entry. A job pinned to a fixed label, or a gate
    // placed in a separate job, would qualify a target from a foreign host.
    expect(buildJob?.["runs-on"]).toBe("${{ matrix.runner }}")

    const matrixInclude = buildJob?.strategy?.matrix?.include ?? []
    expect(matrixInclude.map((entry) => entry.target).sort()).toEqual(contract.qualifiedTargets.slice().sort())

    const steps = buildJob?.steps ?? []
    const gateIndex = steps.findIndex((step) => step.name?.includes("cold-runtime gate"))
    expect(gateIndex).toBeGreaterThan(-1)

    const buildIndex = steps.findIndex((step) => step.name === "Build target binary")
    const uploadIndex = steps.findIndex((step) => step.uses?.includes("upload-artifact"))
    expect(buildIndex).toBeGreaterThan(-1)
    expect(uploadIndex).toBeGreaterThan(-1)
    expect(gateIndex).toBeGreaterThan(buildIndex)
    expect(gateIndex).toBeLessThan(uploadIndex)

    const gate = steps[gateIndex]
    // No condition may let a target skip its own gate, the gate must be scoped to the
    // matrix target, and a binary that hangs must fail the job rather than stall it.
    expect(gate.if).toBeUndefined()
    expect(gate.env?.TARGET).toBe("${{ matrix.target }}")
    expect(gate["timeout-minutes"]).toBeGreaterThan(0)
  })

  test("cold-runtime gate executes the shipped binary and proves version, identity, and search-mcp stdio", async () => {
    const doc = await loadYaml<WorkflowDoc>(".github/workflows/ocp-build.yml")
    const gate = doc.jobs?.build?.steps?.find((step) => step.name?.includes("cold-runtime gate"))
    expect(gate).toBeDefined()

    const run = gate?.run ?? ""

    // Runs the packaged artifact rather than a source-tree entrypoint.
    expect(run).toContain("tar -xzf")
    expect(run).toContain("bin/opencodeplus")

    expect(run).toContain("--version")
    expect(run).toContain("OPENCODE_VERSION")

    // build-info must carry this commit and must not report unmeasured fields.
    expect(run).toContain("build-info --json")
    expect(run).toContain("GITHUB_SHA")
    expect(run).toMatch(/grep[^\n]*null/)

    // JSON-RPC initialize over stdio, protocol on stdout, silence on stderr.
    expect(run).toContain("search-mcp")
    expect(run).toContain('"method":"initialize"')
    expect(run).toContain("jsonrpc")

    // stdin is an ordinary pipe, as a spawning MCP client provides. On macOS Bun never
    // sees a named pipe's EOF (oven-sh/bun#40099), so a FIFO fails the gate there for a
    // reason no real client meets.
    expect(run).not.toContain("mkfifo")
    expect(run).toMatch(/mcp_client \| cold "\$bin" search-mcp/)

    // Coldness is proven in the step, not assumed: the runner has Bun installed.
    expect(run).toContain("env -i")
    expect(run).toMatch(/command -v bun/)
    expect(run).toMatch(/command -v node/)
    expect(run).toContain("node_modules")
    expect(run).toContain("HOME=")
    expect(run).toContain("RUNNER_TEMP")
  })

  test("each qualified target builds and gates on a runner of its own operating system", async () => {
    const doc = await loadYaml<WorkflowDoc>(".github/workflows/ocp-build.yml")
    const matrixInclude = doc.jobs?.build?.strategy?.matrix?.include ?? []
    expect(matrixInclude.length).toBeGreaterThan(0)

    // Cross-compilation is unacceptable, so a Darwin target may never be produced or
    // qualified from a Linux host and vice versa.
    for (const entry of matrixInclude) {
      const runner = entry.runner ?? ""
      const runnerOs = runner.startsWith("macos") ? "darwin" : runner.startsWith("ubuntu") ? "linux" : runner
      expect(runnerOs).toBe((entry.target ?? "").split("-")[0])
    }
  })

  test("pins no retired or deprecated GitHub-hosted runner label", async () => {
    const doc = await loadYaml<WorkflowDoc>(".github/workflows/ocp-build.yml")

    // Verified 2026-09-23: macos-13 was fully retired on 2025-12-04 and the macOS 14
    // images are marked deprecated with removal scheduled for 2026-11-02. A job pinned
    // to a retired label cannot start, so it can never produce a qualification run.
    const retiredOrDeprecated = [
      "macos-11",
      "macos-12",
      "macos-13",
      "macos-13-large",
      "macos-13-xlarge",
      "macos-14",
      "macos-14-large",
      "macos-14-xlarge",
      "ubuntu-20.04",
    ]

    const labels = Object.values(doc.jobs ?? {}).flatMap((job) => {
      const runsOn = job["runs-on"]
      const matrixRunners = (job.strategy?.matrix?.include ?? [])
        .map((entry) => entry.runner)
        .filter((runner): runner is string => typeof runner === "string")
      if (typeof runsOn === "string" && !runsOn.includes("${{")) return [runsOn, ...matrixRunners]
      return matrixRunners
    })

    expect(labels.length).toBeGreaterThan(0)
    for (const label of labels) {
      expect(retiredOrDeprecated).not.toContain(label)
    }
  })

  test("pins a measured Bun executable SHA256 for every qualified target", async () => {
    const [doc, contract, toolchain] = await Promise.all([
      loadYaml<WorkflowDoc>(".github/workflows/ocp-build.yml"),
      loadJson<ContractJson>("release/contract.json"),
      loadJson<ToolchainJson>("release/toolchain.json"),
    ])

    // Recorded 2026-09-23 from Bun's official bun-v1.4.2 release archives. For
    // each platform the archive sha256 was checked against that release's
    // SHASUMS256.txt before the extracted `bun` executable was hashed, so the
    // value is the sha256 of the binary setup-ocp actually verifies. On x64 the
    // plain and -baseline archives carry the same executable bytes, so the pin
    // holds however setup-bun resolves AVX2.
    const expected: Record<string, string> = {
      "linux-arm64": "616f267a34278ff5ac282df37ffdfba1d7141f4f6926bca99af2cd6ef3ad32b1",
      "linux-x64": "a83d263767d839e4d2649ca8e35d07159c7afc99afdc96d731ced29e056dda0c",
      "darwin-arm64": "35d20dd0263e5c950194434b925454fdfa9ba6e4467da960410fa05b08a7a5b5",
      "darwin-x64": "2fa513af22ac59e03aae640cad302e73cb1ddb0f6398501e2ddccf7dcd613596",
    }

    const buildJob = doc.jobs?.build
    const matrixInclude = buildJob?.strategy?.matrix?.include ?? []
    expect(matrixInclude.map((entry) => entry.target).sort()).toEqual(contract.qualifiedTargets.slice().sort())

    for (const entry of matrixInclude) {
      const target = entry.target as string
      expect(expected[target]).toBeDefined()
      expect(entry.bun_sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(entry.bun_sha256).toBe(expected[target])
    }

    // Four platforms are four different binaries; a copied pin would verify nothing.
    expect(new Set(Object.values(expected)).size).toBe(4)
    // The seat's recorded measurement and the matrix pin cannot drift apart.
    expect(toolchain.bun.executableSha256).toBe(expected["linux-arm64"])

    const buildSetup = (buildJob?.steps ?? []).find((step) => step.uses?.includes("setup-ocp"))
    expect(buildSetup?.with?.["expected-sha256"]).toBe("${{ matrix.bun_sha256 }}")

    // record-release runs on ubuntu-24.04, so it pins the linux-x64 identity.
    const recordJob = doc.jobs?.["record-release"]
    expect(recordJob?.["runs-on"]).toBe("ubuntu-24.04")
    const recordSetup = (recordJob?.steps ?? []).find((step) => step.uses?.includes("setup-ocp"))
    expect(recordSetup?.with?.["expected-sha256"]).toBe(expected["linux-x64"])
  })

  test("pins OPENCODE_VERSION, OPENCODE_CHANNEL, TZ=UTC, LC_ALL=C.UTF-8, and SOURCE_DATE_EPOCH", async () => {
    const doc = await loadYaml<WorkflowDoc>(".github/workflows/ocp-build.yml")

    expect(doc.env?.OPENCODE_CHANNEL).toBe("plus")
    expect(doc.env?.TZ).toBe("UTC")
    expect(doc.env?.LC_ALL).toBe("C.UTF-8")
    expect(doc.env?.BUN_COMPILE_RELEASE).toBe("bun-v1.4.2")

    const buildJob = doc.jobs?.build
    // The version is supplied by the "Resolve release version" step instead of a
    // job-level env, because a job-level env can only copy github.ref_name and
    // that is the v-prefixed tag form install.sh cannot match.
    expect(buildJob?.env?.OPENCODE_VERSION).toBeUndefined()
    expect(buildJob?.steps?.find((s) => s.name === "Resolve release version")).toBeDefined()

    const epochStep = buildJob?.steps?.find((s) => s.name?.includes("SOURCE_DATE_EPOCH"))
    expect(epochStep).toBeDefined()
    expect(epochStep?.run).toContain("git log -1 --pretty=%ct")
    expect(epochStep?.run).toContain("SOURCE_DATE_EPOCH=")
  })

  test("derives the manifest version from the tag with the leading v stripped in every identity job", async () => {
    const doc = await loadYaml<WorkflowDoc>(".github/workflows/ocp-build.yml")

    for (const jobName of ["build", "record-release"]) {
      const job = doc.jobs?.[jobName]
      expect(job).toBeDefined()

      // The tag keeps its "v" (v0.0.0-plus-r4.1); the version does not
      // (0.0.0-plus-r4.1). No job-level env may reintroduce the tag form.
      expect(job?.env?.OPENCODE_VERSION).toBeUndefined()

      const steps = job?.steps ?? []
      const versionIndex = steps.findIndex((step) => step.name === "Resolve release version")
      expect(versionIndex).toBeGreaterThan(-1)

      const run = steps[versionIndex].run ?? ""
      expect(run).toContain('"${GITHUB_REF_TYPE}" = "tag"')
      expect(run).toContain("${GITHUB_REF_NAME#v}")
      expect(run).toContain("0.0.0-${GITHUB_SHA}")
      expect(run).toContain('echo "OPENCODE_VERSION=${version}" >> "$GITHUB_ENV"')

      // Every step that consumes the version must run after the strip.
      const consumers = steps
        .map((step, index) => ({ step, index }))
        .filter(({ step }) => step.name !== "Resolve release version" && step.run?.includes("OPENCODE_VERSION"))
      expect(consumers.length).toBeGreaterThan(0)
      for (const consumer of consumers) expect(consumer.index).toBeGreaterThan(versionIndex)
    }

    // The cold-runtime gate compares the packaged binary against the resolved
    // (unprefixed) version and still accepts a printed leading "v" token.
    const gateRun = doc.jobs?.build?.steps?.find((step) => step.name?.includes("cold-runtime gate"))?.run ?? ""
    expect(gateRun).toContain('awk -v want="$OPENCODE_VERSION"')
    expect(gateRun).toContain('$i == ("v" want)')
  })

  test("Linux targets build natively at the fixed build path pinned in release/toolchain.json", async () => {
    const [doc, toolchain] = await Promise.all([
      loadYaml<WorkflowDoc>(".github/workflows/ocp-build.yml"),
      loadJson<{ fixedBuildPath: string }>("release/toolchain.json"),
    ])
    const run = doc.jobs?.build?.steps?.find((step) => step.name === "Build target binary")?.run ?? ""
    const [linux, other] = run.split(/^\s*else\s*$/m)

    // The compiler embeds absolute source paths, so a local rebuild can only be
    // compared with the CI binary when both ran at the same pinned directory.
    expect(toolchain.fixedBuildPath).toBe("/build/opencodeplus")
    expect(linux).toContain('if [ "${RUNNER_OS}" = "Linux" ]; then')
    expect(linux).toContain('Bun.file("release/toolchain.json").json()).fixedBuildPath')
    expect(linux).toContain('sudo install -d -o "$(id -u)" -g "$(id -g)" "$(dirname "$fixed")"')
    expect(linux).toContain('bun packages/plus/script/release/fixed-path-build.ts --target "$TARGET" --out packages/cli/dist')
    // CI never cross-builds: without --cross the script refuses a non-host target.
    const commands = run.split("\n").filter((line) => !line.trim().startsWith("#"))
    expect(commands.filter((line) => line.includes("--cross"))).toEqual([])
    expect(other).toContain("bun packages/cli/script/build-plus.ts --single")
  })

  test("builds never publish and reference no publication or model secrets", async () => {
    const doc = await loadYaml<WorkflowDoc>(".github/workflows/ocp-build.yml")
    const yamlText = await Bun.file(join(repoRoot, ".github/workflows/ocp-build.yml")).text()

    expect(doc.permissions).toEqual({ contents: "read" })

    // Ensure no gh release create or publish steps in build workflow
    for (const job of Object.values(doc.jobs ?? {})) {
      expect(job.environment).toBeUndefined()
      for (const step of job.steps ?? []) {
        if (step.run) {
          expect(step.run).not.toContain("gh release")
          expect(step.run).not.toContain("npm publish")
        }
      }
    }

    // No secret references anywhere in the file
    expect(yamlText).not.toContain("secrets.")
  })
})

describe("source gate CI workflow (ocp-ci.yml)", () => {
  test("check IDs and argv exactly match release/checks.json", async () => {
    const [doc, checksDoc] = await Promise.all([
      loadYaml<WorkflowDoc>(".github/workflows/ocp-ci.yml"),
      loadJson<ChecksJson>("release/checks.json"),
    ])

    const job = doc.jobs?.["focused-checks"]
    expect(job).toBeDefined()

    const steps = job?.steps ?? []
    const checkSteps = steps.filter((step) => step.id && step.id !== "setup-ocp" && step.id !== "checkout")

    expect(checkSteps.length).toBe(checksDoc.checks.length)

    for (let i = 0; i < checksDoc.checks.length; i++) {
      const expected = checksDoc.checks[i]
      const step = checkSteps[i]

      expect(step.id).toBe(expected.id)
      expect(step["working-directory"]).toBe(expected.cwd)

      const actualArgv = (step.run ?? "").trim().split(/\s+/)
      expect(actualArgv).toEqual(expected.argv)
    }
  })

  test("every test file named in a check argv exists on disk", async () => {
    const checksDoc = await loadJson<ChecksJson>("release/checks.json")

    const namedTestFiles = checksDoc.checks.flatMap((check) =>
      check.argv
        .filter((arg) => /\.test\.tsx?$/.test(arg))
        .map((arg) => join(check.cwd, arg)),
    )
    expect(namedTestFiles.length).toBeGreaterThan(0)

    // `bun test` accepts an argv path that does not exist and still exits 0, so a
    // check can name a missing test file and pass silently. The manifest must not.
    const missing: string[] = []
    for (const relPath of namedTestFiles) {
      if (!(await Bun.file(join(repoRoot, relPath)).exists())) missing.push(relPath)
    }

    expect(missing).toEqual([])
  })

  test("runs only focused checks: never a whole-suite test and never a root test", async () => {
    const doc = await loadYaml<WorkflowDoc>(".github/workflows/ocp-ci.yml")
    const job = doc.jobs?.["focused-checks"]
    const steps = job?.steps ?? []

    for (const step of steps) {
      if (step.run) {
        expect(step.run).not.toBe("bun test")
        expect(step["working-directory"]).toBeDefined()
        expect(step["working-directory"]).not.toBe(".")
        expect(step["working-directory"]).not.toBe("./")
      }
    }
  })

  test("references no publication credentials and no model/provider credentials", async () => {
    const yamlText = await Bun.file(join(repoRoot, ".github/workflows/ocp-ci.yml")).text()
    expect(yamlText).not.toContain("secrets.")
    expect(yamlText).not.toContain("OPENCODE_API_KEY")
    expect(yamlText).not.toContain("ANTHROPIC")
    expect(yamlText).not.toContain("OPENAI")
    expect(yamlText).not.toContain("NPM_TOKEN")
  })
})

describe("release publication workflow (ocp-release.yml)", () => {
  test("requires explicit manual trigger with approval input", async () => {
    const doc = await loadYaml<WorkflowDoc>(".github/workflows/ocp-release.yml")

    expect(doc.on?.workflow_dispatch).toBeDefined()
    const dispatch = doc.on?.workflow_dispatch as { inputs?: Record<string, { required?: boolean }> }
    expect(dispatch.inputs?.approval).toBeDefined()
    expect(dispatch.inputs?.approval?.required).toBe(true)

    expect(doc.on?.push).toBeUndefined()
    expect(doc.on?.pull_request).toBeUndefined()
    expect(doc.on?.schedule).toBeUndefined()
  })

  test("runs in a separately protected environment", async () => {
    const doc = await loadYaml<WorkflowDoc>(".github/workflows/ocp-release.yml")
    const publishJob = doc.jobs?.publish
    expect(publishJob).toBeDefined()
    expect(publishJob?.environment).toBe("ocp-release")
  })

  test("does not check out application source or install/execute candidate code", async () => {
    const doc = await loadYaml<WorkflowDoc>(".github/workflows/ocp-release.yml")
    const steps = doc.jobs?.publish?.steps ?? []

    for (const step of steps) {
      if (step.uses) {
        expect(step.uses).not.toContain("actions/checkout")
        expect(step.uses).not.toContain("setup-ocp")
        expect(step.uses).not.toContain("setup-bun")
      }
      if (step.run) {
        expect(step.run).not.toContain("bun install")
        expect(step.run).not.toContain("npm install")
        expect(step.run).not.toContain("./bin/opencodeplus")
        expect(step.run).not.toContain("./bin/opencode2")
      }
    }
  })

  test("consumes recorded asset set and verifies all hashes before upload", async () => {
    const doc = await loadYaml<WorkflowDoc>(".github/workflows/ocp-release.yml")
    const steps = doc.jobs?.publish?.steps ?? []

    const downloadStep = steps.find((s) => s.uses?.includes("download-artifact"))
    expect(downloadStep).toBeDefined()
    expect(downloadStep?.with?.name).toBe("ocp-release-assets")

    const verifyStep = steps.find((s) => s.name?.includes("Verify checksums"))
    expect(verifyStep).toBeDefined()
    expect(verifyStep?.run).toContain("sha256sum -c SHA256SUMS")
  })

  test("publishes as a non-Latest immutable prerelease and never modifies assets", async () => {
    const doc = await loadYaml<WorkflowDoc>(".github/workflows/ocp-release.yml")
    const steps = doc.jobs?.publish?.steps ?? []

    const publishStep = steps.find((s) => s.name?.includes("Publish immutable prerelease"))
    expect(publishStep).toBeDefined()
    expect(publishStep?.run).toContain("--prerelease")
    expect(publishStep?.run).toContain("--latest=false")
    // Publication cannot invent a tag: --verify-tag aborts unless the tag
    // already exists in the remote repository.
    expect(publishStep?.run).toContain("--verify-tag")

    // Must not recompile, recompress, or re-sign
    for (const step of steps) {
      if (step.run) {
        expect(step.run).not.toContain("tar -")
        expect(step.run).not.toContain("gzip")
        expect(step.run).not.toContain("codesign")
        expect(step.run).not.toContain("git tag -f")
        expect(step.run).not.toContain("git push")
      }
    }
  })

  test("fetches the recorded release assets from the named build run, not this run", async () => {
    const doc = await loadYaml<WorkflowDoc>(".github/workflows/ocp-release.yml")

    // This workflow builds nothing, so the bundle can only come from another run.
    // The run id is a required dispatch input instead of a value defaulted by the
    // action, which would look in this run and never find the bundle.
    const dispatch = doc.on?.workflow_dispatch as
      | { inputs?: Record<string, { required?: boolean }> }
      | undefined
    expect(dispatch?.inputs?.run_id).toBeDefined()
    expect(dispatch?.inputs?.run_id?.required).toBe(true)

    const steps = doc.jobs?.publish?.steps ?? []
    const downloadStep = steps.find((s) => s.uses?.includes("download-artifact"))
    expect(downloadStep).toBeDefined()
    expect(downloadStep?.with?.name).toBe("ocp-release-assets")

    // `actions/download-artifact` defaults `run-id` to the current run when the
    // input is absent. Binding it to the dispatch input is what keeps this a
    // cross-run download; the token carries the actions: read permission it needs.
    expect(downloadStep?.with?.["run-id"]).toBe("${{ inputs.run_id }}")
    expect(String(downloadStep?.with?.["github-token"])).toMatch(
      /\$\{\{\s*(github\.token|secrets\.GITHUB_TOKEN)\s*\}\}/,
    )
  })

  test("verifies the named build run's repository, workflow, conclusion, and commit before downloading", async () => {
    const doc = await loadYaml<WorkflowDoc>(".github/workflows/ocp-release.yml")
    const steps = doc.jobs?.publish?.steps ?? []

    const guardIndex = steps.findIndex((s) => s.name === "Verify build run identity for tag")
    const downloadIndex = steps.findIndex((s) => s.uses?.includes("download-artifact"))
    expect(guardIndex).toBeGreaterThan(-1)
    expect(downloadIndex).toBeGreaterThan(-1)
    expect(guardIndex).toBeLessThan(downloadIndex)

    const guard = steps[guardIndex]
    expect(guard.shell).toBe("bash")
    expect(guard.env?.RELEASE_TAG).toBe("${{ inputs.tag }}")
    expect(guard.env?.BUILD_RUN_ID).toBe("${{ inputs.run_id }}")

    const run = guard.run ?? ""

    // The tag's commit is resolved from refs/tags only, rather than trusted
    // from the dispatch input or resolved through the ambiguous `commits/{ref}`
    // endpoint that also answers for branches and raw SHAs.
    expect(run).toContain("gh api")
    expect(run).toContain("git/ref/tags/${RELEASE_TAG}")
    expect(run).not.toContain("commits/${RELEASE_TAG}")
    expect(run).toContain(".ref")
    expect(run).toContain("git/tags/${tag_sha}")
    expect(run).toContain("tag_sha")

    // The named run is queried and checked for repository, workflow, conclusion,
    // and head commit; a run started from the tag's own ref is required too, so a
    // branch build of the same commit cannot supply a differently versioned bundle.
    expect(run).toContain("actions/runs/${BUILD_RUN_ID}")
    expect(run).toContain("run_repository")
    expect(run).toContain("ocp-build")
    expect(run).toContain("conclusion")
    expect(run).toContain("head_sha")
    expect(run).toContain("head_branch")
    expect(run).toContain("success")

    // Each rejected condition is an annotated failure, and the step stops there.
    const errorAnnotations = run.match(/::error::/g) ?? []
    expect(errorAnnotations.length).toBeGreaterThanOrEqual(5)
    expect(run).toContain("exit 1")
  })

  test("refuses a dispatch naming a branch that has a successful ocp-build push run", async () => {
    const doc = await loadYaml<WorkflowDoc>(".github/workflows/ocp-release.yml")
    const guard = doc.jobs?.publish?.steps?.find((step) => step.name === "Verify build run identity for tag")
    expect(guard?.run).toBeDefined()
    const run = guard?.run ?? ""

    // The endpoint that made the spoof possible must be gone; this assertion
    // fails against the pre-fix guard, which resolved `commits/${RELEASE_TAG}`.
    expect(run).toContain("git/ref/tags/${RELEASE_TAG}")
    expect(run).not.toContain("commits/${RELEASE_TAG}")

    // The dispatcher names the v2 branch. Its successful ocp-build push run
    // satisfies repository, workflow, conclusion, event, head_branch and
    // head_sha, and the old endpoint resolved the branch to the same commit; the
    // only thing missing is refs/tags/v2. The guard must therefore refuse.
    const branchSha = "b".repeat(40)
    const result = await runVerificationGuard(run, {
      tagName: "v2",
      tagRef: null,
      ambiguousRefSha: branchSha,
      run: {
        repository: "acme/opencodeplus",
        name: "ocp-build",
        path: ".github/workflows/ocp-build.yml",
        conclusion: "success",
        head_sha: branchSha,
        head_branch: "v2",
        event: "push",
      },
    })

    expect(result.exitCode).not.toBe(0)
    expect(result.output).toContain("does not exist as a tag")
  })

  test("accepts a push run for an annotated tag and records the peeled tag identity", async () => {
    const doc = await loadYaml<WorkflowDoc>(".github/workflows/ocp-release.yml")
    const guard = doc.jobs?.publish?.steps?.find((step) => step.name === "Verify build run identity for tag")
    const run = guard?.run ?? ""

    // An annotated tag points at a tag object, not at a commit: the guard has to
    // peel it before comparing with the run's head_sha.
    const tagObjectSha = "1".repeat(40)
    const commitSha = "2".repeat(40)
    const result = await runVerificationGuard(run, {
      tagName: "v0.0.0-plus-r4.1",
      tagRef: { ref: "refs/tags/v0.0.0-plus-r4.1", type: "tag", sha: tagObjectSha },
      tagObject: { type: "commit", sha: commitSha },
      ambiguousRefSha: commitSha,
      run: {
        repository: "acme/opencodeplus",
        name: "ocp-build",
        path: ".github/workflows/ocp-build.yml",
        conclusion: "success",
        head_sha: commitSha,
        head_branch: "v0.0.0-plus-r4.1",
        event: "push",
      },
    })

    expect(result.exitCode).toBe(0)
    // The tag-derived version and the tag's commit are what the downloaded
    // release.json is later checked against.
    expect(result.githubEnv).toContain("EXPECTED_VERSION=0.0.0-plus-r4.1")
    expect(result.githubEnv).toContain(`EXPECTED_TAG_SHA=${commitSha}`)
  })

  test("binds the downloaded bundle to the tag-derived version and commit before publishing", async () => {
    const doc = await loadYaml<WorkflowDoc>(".github/workflows/ocp-release.yml")
    const steps = doc.jobs?.publish?.steps ?? []

    const checksumIndex = steps.findIndex((step) => step.name?.includes("Verify checksums"))
    const identityIndex = steps.findIndex((step) => step.name === "Verify recorded release matches tag identity")
    const publishIndex = steps.findIndex((step) => step.name?.includes("Publish immutable prerelease"))
    expect(checksumIndex).toBeGreaterThan(-1)
    expect(identityIndex).toBeGreaterThan(checksumIndex)
    expect(identityIndex).toBeLessThan(publishIndex)

    // The run object carries no ref type, so the guard cannot by itself separate
    // a tag push from a branch push of the same name. The bundle can: only a
    // tag-triggered build embeds the tag-derived version and hashes the tag's
    // commit, and that is asserted here after the checksums were verified.
    const identity = steps[identityIndex]
    expect(identity.run).toContain(".release.version")
    expect(identity.run).toContain(".release.sourceSha")
    expect(identity.run).toContain("EXPECTED_VERSION")
    expect(identity.run).toContain("EXPECTED_TAG_SHA")
    expect(identity.run).toContain("exit 1")

    const publish = steps[publishIndex]
    expect(publish.run).toContain("--verify-tag")
  })

  test("gives gh an explicit repository for publication and still performs no checkout", async () => {
    const doc = await loadYaml<WorkflowDoc>(".github/workflows/ocp-release.yml")
    const steps = doc.jobs?.publish?.steps ?? []

    const publishIndex = steps.findIndex((step) => step.name?.includes("Publish immutable prerelease"))
    expect(publishIndex).toBeGreaterThan(-1)
    const publish = steps[publishIndex]

    // The publish step runs from the downloaded artifact directory, which has no
    // .git, so gh cannot discover a repository and would fail at the last step.
    // GH_REPO is the documented override for commands that otherwise operate on
    // a local repository; GITHUB_REPOSITORY is not read by gh.
    expect(publish.env?.GH_REPO).toBe("${{ github.repository }}")
    expect(publish.run).toContain("gh release create")
    expect(publish.env?.GITHUB_REPOSITORY).toBeUndefined()
    expect(publish.run).not.toContain("GITHUB_REPOSITORY")

    // No checkout: GH_REPO is the only repository context the publish step gets.
    for (const step of steps) {
      expect(step.uses ?? "").not.toContain("actions/checkout")
    }

    // The guard's gh api calls pass literal repos/{owner}/{repo} paths built from
    // an explicit repository variable, so they need no repo discovery.
    const guard = steps.find((step) => step.name === "Verify build run identity for tag")
    expect(guard?.env?.REPOSITORY).toBe("${{ github.repository }}")
    expect(guard?.run).toContain("repos/${REPOSITORY}/")
  })

  test("grants contents: write and actions: read, and no other permission", async () => {
    const doc = await loadYaml<WorkflowDoc>(".github/workflows/ocp-release.yml")

    // contents: write publishes the release; actions: read resolves the build run
    // and lets download-artifact fetch that run's artifact. Nothing else is needed.
    expect(doc.permissions).toEqual({ contents: "write", actions: "read" })
  })
})

describe("upstream inventory workflow (ocp-upstream-inventory.yml)", () => {
  test("is read-only scheduled/manual workflow with contents: read permissions", async () => {
    const doc = await loadYaml<WorkflowDoc>(".github/workflows/ocp-upstream-inventory.yml")

    expect(doc.on?.schedule).toBeDefined()
    expect(doc.on?.workflow_dispatch).toBeDefined()
    expect(doc.on?.push).toBeUndefined()
    expect(doc.on?.pull_request).toBeUndefined()

    expect(doc.permissions).toEqual({ contents: "read" })
  })

  test("contains no mutating git operations, push, or PR creation", async () => {
    const doc = await loadYaml<WorkflowDoc>(".github/workflows/ocp-upstream-inventory.yml")
    const steps = doc.jobs?.inventory?.steps ?? []

    for (const step of steps) {
      if (step.run) {
        expect(step.run).not.toContain("git push")
        expect(step.run).not.toContain("git merge")
        expect(step.run).not.toContain("git pull")
        expect(step.run).not.toContain("git rebase")
        expect(step.run).not.toContain("git commit")
        expect(step.run).not.toContain("git tag")
        expect(step.run).not.toContain("git reset")
        expect(step.run).not.toContain("gh pr create")
      }
      if (step.uses) {
        expect(step.uses).not.toContain("create-pull-request")
      }
    }
  })

  test("runs upstream-inventory.ts script and uploads JSON report artifact", async () => {
    const doc = await loadYaml<WorkflowDoc>(".github/workflows/ocp-upstream-inventory.yml")
    const steps = doc.jobs?.inventory?.steps ?? []

    const runStep = steps.find((s) => s.run?.includes("upstream-inventory.ts"))
    expect(runStep).toBeDefined()
    expect(runStep?.run).toContain("--output=upstream-inventory-report.json")

    const uploadStep = steps.find((s) => s.uses?.includes("upload-artifact"))
    expect(uploadStep).toBeDefined()
    expect(uploadStep?.with?.path).toBe("upstream-inventory-report.json")
  })
})

describe("setup-ocp composite action (.github/actions/setup-ocp/action.yml)", () => {
  test("pins Bun version from toolchain.json, verifies SHA256, and installs frozen dependencies", async () => {
    const [actionDoc, toolchain] = await Promise.all([
      loadYaml<ActionDoc>(".github/actions/setup-ocp/action.yml"),
      loadJson<ToolchainJson>("release/toolchain.json"),
    ])

    expect(actionDoc.runs?.using).toBe("composite")
    expect(actionDoc.inputs?.["bun-version"]?.default).toBe(toolchain.bun.version)

    const steps = actionDoc.runs?.steps ?? []

    const setupBunStep = steps.find((s) => s.uses?.includes("setup-bun"))
    expect(setupBunStep).toBeDefined()
    expect(setupBunStep?.with?.["bun-version"]).toBeDefined()

    const verifyStep = steps.find((s) => s.name?.includes("Verify Bun executable SHA256"))
    expect(verifyStep).toBeDefined()
    expect(verifyStep?.run).toContain("sha256")
    expect(verifyStep?.run).toContain("exit 1")

    const installStep = steps.find((s) => s.name?.includes("Install dependencies"))
    expect(installStep).toBeDefined()
    expect(installStep?.run).toBe("bun install --frozen-lockfile")
  })

  test("fails closed when no expected Bun executable SHA256 is recorded", async () => {
    const actionDoc = await loadYaml<ActionDoc>(".github/actions/setup-ocp/action.yml")
    const verifyStep = (actionDoc.runs?.steps ?? []).find((step) =>
      step.name?.includes("Verify Bun executable SHA256"),
    )
    expect(verifyStep?.run).toBeDefined()
    const script = verifyStep?.run ?? ""

    // Fails against the previous action, which printed an "unmeasured" line and
    // continued, and against the linux-arm64 fallback, which silently
    // substituted a hash recorded for a different platform.
    const missing = await runBunShaVerification(script, "")
    expect(missing.exitCode).not.toBe(0)
    expect(missing.output).toContain("::error::")
    expect(missing.output).toMatch(/no expected bun executable sha256/i)
    expect(missing.output.toLowerCase()).toContain("unverified")
    expect(missing.output).not.toContain("unmeasured")

    // No built-in hash and no expected value read through the executable under
    // test: the pin must come from the caller.
    expect(script).not.toContain("616f267a34278ff5ac282df37ffdfba1d7141f4f6926bca99af2cd6ef3ad32b1")
    expect(script).not.toContain("toolchain.json")
    expect(script).not.toContain("bun -e")

    const sentinel = await runBunShaVerification(script, "null")
    expect(sentinel.exitCode).not.toBe(0)

    const match = await runBunShaVerification(script, missing.actualSha)
    expect(match.exitCode).toBe(0)
    expect(match.output).toContain("Verified Bun executable SHA256")

    const mismatch = await runBunShaVerification(script, "f".repeat(64))
    expect(mismatch.exitCode).not.toBe(0)
    expect(mismatch.output).toContain("::error::Bun executable SHA256 mismatch")
  })

  test("does not install Node or npm and touches no publication credentials", async () => {
    const actionDoc = await loadYaml<ActionDoc>(".github/actions/setup-ocp/action.yml")
    const rawText = await Bun.file(join(repoRoot, ".github/actions/setup-ocp/action.yml")).text()

    for (const step of actionDoc.runs?.steps ?? []) {
      if (step.uses) {
        expect(step.uses).not.toContain("setup-node")
        expect(step.uses).not.toContain("setup-npm")
      }
      if (step.run) {
        expect(step.run).not.toContain("npm install")
        expect(step.run).not.toContain("npm i")
      }
    }

    expect(rawText).not.toContain("secrets.")
  })
})

describe("cross-workflow security and safety invariants", () => {
  const workflowPaths = [
    ".github/actions/setup-ocp/action.yml",
    ".github/workflows/ocp-build.yml",
    ".github/workflows/ocp-ci.yml",
    ".github/workflows/ocp-release.yml",
    ".github/workflows/ocp-upstream-inventory.yml",
  ]

  test("no workflow references a Windows runner or Windows target", async () => {
    for (const relPath of workflowPaths) {
      const doc = await loadYaml<Record<string, unknown>>(relPath)
      const rawText = await Bun.file(join(repoRoot, relPath)).text()

      // Structured checks:
      if ("jobs" in doc && typeof doc.jobs === "object" && doc.jobs !== null) {
        for (const job of Object.values(doc.jobs as Record<string, WorkflowJob>)) {
          const runsOn = job["runs-on"]
          if (typeof runsOn === "string") {
            expect(runsOn.toLowerCase()).not.toContain("windows")
          }
          const matrixInclude = job.strategy?.matrix?.include
          if (matrixInclude) {
            for (const entry of matrixInclude) {
              const target = entry.target?.toLowerCase() ?? ""
              expect(target.startsWith("win")).toBe(false)
              expect(target).not.toContain("windows")
              expect(entry.runner?.toLowerCase()).not.toContain("windows")
            }
          }
        }
      }

      // Check no Windows runners or win32 targets are referenced
      expect(rawText).not.toMatch(/runs-on:\s*.*windows.*/i)
      expect(rawText).not.toMatch(/target:\s*win32.*/i)
    }
  })

  test("every third-party action is pinned to a 40-character commit SHA with version in comment", async () => {
    const sha40Regex = /^[0-9a-f]{40}$/i

    for (const relPath of workflowPaths) {
      const rawText = await Bun.file(join(repoRoot, relPath)).text()
      const lines = rawText.split("\n")

      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed.startsWith("uses:") || trimmed.startsWith("- uses:")) {
          const usesMatch = trimmed.match(/uses:\s*([^\s#]+)(?:\s*#\s*(.+))?/)
          if (!usesMatch) continue

          const actionRef = usesMatch[1]
          const comment = usesMatch[2]

          // Local composite actions (e.g. ./.github/actions/setup-ocp) do not require SHA pinning
          if (actionRef.startsWith("./")) continue

          const atIdx = actionRef.indexOf("@")
          expect(atIdx).toBeGreaterThan(0)

          const sha = actionRef.slice(atIdx + 1)
          expect(sha).toMatch(sha40Regex)
          expect(sha.length).toBe(40)

          // Must have a version comment after the SHA
          expect(comment).toBeDefined()
          expect(comment?.length).toBeGreaterThan(0)
        }
      }
    }
  })

  test("only release workflow references secrets, and only GITHUB_TOKEN", async () => {
    const [buildText, ciText, releaseText, inventoryText, actionText] = await Promise.all([
      Bun.file(join(repoRoot, ".github/workflows/ocp-build.yml")).text(),
      Bun.file(join(repoRoot, ".github/workflows/ocp-ci.yml")).text(),
      Bun.file(join(repoRoot, ".github/workflows/ocp-release.yml")).text(),
      Bun.file(join(repoRoot, ".github/workflows/ocp-upstream-inventory.yml")).text(),
      Bun.file(join(repoRoot, ".github/actions/setup-ocp/action.yml")).text(),
    ])

    expect(buildText).not.toContain("secrets.")
    expect(ciText).not.toContain("secrets.")
    expect(inventoryText).not.toContain("secrets.")
    expect(actionText).not.toContain("secrets.")

    // Release workflow references secrets.GITHUB_TOKEN
    const releaseSecretMatches = releaseText.match(/secrets\.([A-Z0-9_]+)/g) ?? []
    expect(releaseSecretMatches.length).toBe(1)
    expect(releaseSecretMatches[0]).toBe("secrets.GITHUB_TOKEN")
  })
})
