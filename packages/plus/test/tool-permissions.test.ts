import { expect, test } from "bun:test"
// Real matcher, test-only: plus must not depend on @opencode/core (core
// depends on Plus), so this reads core's source by path the way
// apply.test.ts reads core's prompt sources. No src file may do this.
import { match } from "../../core/src/util/wildcard.js"
import {
  commandHeads,
  curatedRules,
  idRules,
  keywordsForPattern,
  mergeRules,
  type CuratedRule,
} from "../src/instructions/tool-permissions.js"

function rule(tool: string, id: string): CuratedRule {
  const found = curatedRules.find((entry) => entry.tool === tool && entry.id === id)
  if (found === undefined) throw new Error(`missing curated rule ${tool}:${id}`)
  return found
}

test("every curated entry has at least one pattern and non-empty keywords", () => {
  expect(curatedRules.length).toBeGreaterThan(0)
  for (const entry of curatedRules) {
    expect(entry.patterns.length).toBeGreaterThanOrEqual(1)
    expect(entry.keywords.length).toBeGreaterThanOrEqual(1)
    for (const keyword of entry.keywords) expect(keyword.length).toBeGreaterThan(0)
  }
  const keys = curatedRules.map((entry) => `${entry.tool}:${entry.id}`)
  expect(new Set(keys).size).toBe(keys.length)
})

test("curated registry covers the planned tool actions", () => {
  expect(rule("shell", "git-push").patterns).toEqual(["git push *"])
  expect(rule("shell", "git-push").keywords).toContain("git push")
  expect(rule("shell", "rm-rf").patterns).toEqual(["rm -rf *"])
  expect(rule("shell", "sudo").patterns).toContain("sudo")
  expect(rule("shell", "docker").patterns).toContain("docker")
  expect(rule("shell", "kubectl").patterns).toContain("kubectl")
  expect(rule("shell", "npm-publish").patterns).toEqual(["npm publish *"])
  expect(rule("shell", "kill").patterns).toContain("kill *")
  expect(rule("edit", "env").patterns).toEqual(["*.env*"])
  expect(rule("write", "lock").patterns).toEqual(["**/*.lock"])
  expect(rule("read", "ssh").patterns).toEqual(["~/.ssh/**"])
  expect(rule("webfetch", "github").patterns).toEqual(["*github.com*"])
  expect(rule("webfetch", "localhost").patterns).toEqual(["*localhost*"])
  expect(rule("glob", "node-modules").patterns).toEqual(["**/node_modules/**"])
  expect(rule("grep", "git").patterns).toEqual(["**/.git/**"])
})

test("keywordsForPattern keeps head plus subcommands, stopping at wildcards and flags", () => {
  expect(keywordsForPattern("git")).toEqual(["git"])
  expect(keywordsForPattern("git push *")).toEqual(["git push"])
  expect(keywordsForPattern("rm -rf")).toEqual(["rm"])
  expect(keywordsForPattern("**/*.lock")).toEqual([".lock"])
  expect(keywordsForPattern("http://*")).toEqual(["http"])
  expect(keywordsForPattern("**/.git/**")).toEqual([".git"])
})

test("head-only shell rules carry both bare and star patterns", () => {
  for (const id of ["git", "rm", "sudo", "docker", "kubectl"]) {
    const entry = rule("shell", id)
    const head = entry.patterns[0]
    if (head === undefined) throw new Error(`missing head pattern for ${id}`)
    expect(entry.patterns).toContain(head)
    expect(entry.patterns).toContain(`${head} *`)
  }
})

test("head-only patterns match bare and extended commands under the real matcher", () => {
  // Core's matcher rewrites a trailing " *" into an optional group, so
  // `git *` already matches a bare `git`; the bare pattern stays as the
  // explicit pin. Both assertions run the real Wildcard.match.
  expect(match("git", "git *")).toBe(true)
  expect(match("git", "git")).toBe(true)
  expect(match("git push origin", "git *")).toBe(true)
  expect(match("git push origin", "git push *")).toBe(true)
  expect(match("gitpush", "git *")).toBe(false)
  expect(match("rm -rf /tmp/x", "rm -rf *")).toBe(true)
  expect(match("docker compose up", "docker *")).toBe(true)
})

test("mergeRules lets the curated label win on a pattern-set collision", () => {
  const curated: CuratedRule[] = [
    { tool: "shell", id: "git-push", label: "Git push", patterns: ["git push *"], keywords: ["git push"] },
  ]
  const merged = mergeRules(curated, [
    { id: "mined", label: "Mined push", patterns: ["git push *"], keywords: ["git"], provenance: ["alpha", "beta"] },
  ])
  expect(merged).toEqual([
    { id: "git-push", label: "Git push", patterns: ["git push *"], keywords: ["git push"], provenance: ["alpha", "beta"] },
  ])
})

test("mergeRules matches pattern sets regardless of order and sorts most-mentioned first", () => {
  const curated: CuratedRule[] = [
    { tool: "shell", id: "pair", label: "Pair", patterns: ["a *", "b *"], keywords: ["a"] },
    { tool: "shell", id: "generic", label: "Generic", patterns: ["g *"], keywords: ["g"] },
  ]
  const merged = mergeRules(curated, [
    { id: "once", label: "Once", patterns: ["z *"], keywords: ["z"], provenance: ["alpha"] },
    { id: "often", label: "Often", patterns: ["b *", "a *"], keywords: ["b"], provenance: ["alpha", "beta", "gamma"] },
  ])
  expect(merged.map((entry) => entry.id)).toEqual(["pair", "once", "generic"])
  expect(merged[0]).toMatchObject({ label: "Pair", provenance: ["alpha", "beta", "gamma"] })
  expect(merged[2]).toMatchObject({ label: "Generic", provenance: [] })
})

test("command-head table has the planned heads at the planned depths", () => {
  expect(commandHeads["git"]).toBe(2)
  expect(commandHeads["bun"]).toBe(2)
  expect(commandHeads["npm"]).toBe(2)
  expect(commandHeads["pnpm"]).toBe(2)
  expect(commandHeads["yarn"]).toBe(2)
  expect(commandHeads["rm"]).toBe(1)
  expect(commandHeads["docker"]).toBe(2)
  expect(commandHeads["kubectl"]).toBe(2)
})

test("idRules builds one exact rule per discovered id", () => {
  expect(idRules("subagent", ["reviewer"])).toEqual([
    { tool: "subagent", id: "reviewer", label: "reviewer", patterns: ["reviewer"], keywords: ["reviewer"] },
  ])
  expect(idRules("skill", [])).toEqual([])
})
