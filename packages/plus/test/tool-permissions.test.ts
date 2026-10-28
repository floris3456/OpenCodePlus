import { expect, test } from "bun:test"
// Real matcher, test-only: plus must not depend on @opencode/core (core
// depends on Plus), so this reads core's source by path the way
// apply.test.ts reads core's prompt sources. No src file may do this.
import { match } from "../../core/src/util/wildcard.js"
import {
  curatedRuleMessage,
  curatedRules,
  idRules,
  keywordsForPattern,
  validateRuleInput,
  type CuratedRule,
} from "../src/instructions/tool-permissions.js"

function rule(tool: string, id: string): CuratedRule {
  const found = curatedRules.find((entry) => entry.tool === tool && entry.id === id)
  if (found === undefined) throw new Error(`missing curated rule ${tool}:${id}`)
  return found
}

test("every curated entry has at least one pattern and safe keywords", () => {
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
  expect(rule("shell", "git-push").message).toBe("pushing is not allowed here")
  expect(rule("shell", "rm-rf").patterns).toEqual(["rm -rf *"])
  expect(rule("shell", "sudo").patterns).toContain("sudo")
  expect(rule("shell", "docker").patterns).toContain("docker")
  expect(rule("shell", "kubectl").patterns).toContain("kubectl")
  expect(rule("shell", "npm-publish").patterns).toEqual(["npm publish *"])
  expect(rule("shell", "kill").patterns).toContain("kill *")
  expect(rule("edit", "env").patterns).toEqual(["*.env*"])
  expect(rule("write", "lock").patterns).toEqual(["*.lock", "**/*.lock"])
  expect(rule("read", "ssh").patterns).toEqual(["*/.ssh/*", "*/.ssh", ".ssh/*", ".ssh"])
  expect(rule("read", "git").patterns).toEqual([".git/*", "**/.git/**"])
  expect(rule("read", "package-json").patterns).toEqual(["package.json", "*/package.json"])
  expect(rule("web_opencode_fetch", "github").patterns).toEqual(["*github.com*"])
  expect(rule("web_opencode_fetch", "localhost").patterns).toEqual(["*localhost*"])
  expect(rule("glob", "node-modules").patterns).toEqual(["*node_modules*"])
  expect(rule("grep", "git").patterns).toEqual(["*.git*"])
})

test("every curated rule ships a one-line refusal message", () => {
  for (const entry of curatedRules) {
    expect(`${entry.tool}:${entry.id} message`).toBeDefined()
    const message = entry.message
    if (message === undefined) throw new Error(`missing curated message for ${entry.tool}:${entry.id}`)
    expect(message.trim().length).toBeGreaterThan(0)
    expect(message.includes("\n")).toBe(false)
  }
  expect(curatedRuleMessage("shell", "git-push")).toBe("pushing is not allowed here")
  expect(curatedRuleMessage("shell", "not-shipped")).toBeUndefined()
})

test("keywordsForPattern keeps head plus subcommands, stopping at wildcards and flags", () => {
  expect(keywordsForPattern("git")).toEqual(["git"])
  expect(keywordsForPattern("git push *")).toEqual(["git push"])
  expect(keywordsForPattern("rm -rf")).toEqual(["rm"])
  expect(keywordsForPattern("**/*.lock")).toEqual([".lock"])
  expect(keywordsForPattern("http://*")).toEqual(["http"])
  expect(keywordsForPattern("**/.git/**")).toEqual([".git"])
  expect(keywordsForPattern("*")).toEqual([])
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

test("validateRuleInput trims a message and drops a blank one", () => {
  const withMessage = validateRuleInput({
    tool: "shell",
    id: "no-push",
    label: "No pushes",
    patterns: ["git push --force *"],
    message: "  force pushes are not allowed here  ",
  })
  if (!withMessage.ok) throw new Error(withMessage.reason)
  expect(withMessage.message).toBe("force pushes are not allowed here")
  const blank = validateRuleInput({ tool: "shell", id: "no-push", label: "No pushes", patterns: ["git push --force *"], message: "   " })
  if (!blank.ok) throw new Error(blank.reason)
  expect(blank.message).toBeUndefined()
  const absent = validateRuleInput({ tool: "shell", id: "no-push", label: "No pushes", patterns: ["git push --force *"] })
  if (!absent.ok) throw new Error(absent.reason)
  expect(absent.message).toBeUndefined()
})

test("idRules builds one exact rule per discovered id, with no scrub keywords", () => {
  expect(idRules("subagent", ["reviewer"])).toEqual([
    { tool: "subagent", id: "reviewer", label: "reviewer", patterns: ["reviewer"], keywords: [] },
  ])
  expect(idRules("skill", [])).toEqual([])
})

test("glob/grep rows match the real search-pattern resource, not the search path", () => {
  // Core authorizes `input.pattern`, not the search path
  // (core/src/tool/plugin/grep.ts:87-89, glob.ts:68-70). A grep for HEAD
  // inside .git therefore evaluates resource "HEAD": no search-pattern deny
  // can stop it, and the rows must not promise otherwise.
  const git = rule("grep", "git")
  expect(git.label).toMatch(/search pattern/i)
  expect(match("HEAD", git.patterns[0] as string)).toBe(false)
  // A search pattern that actually mentions .git IS denied.
  expect(match(".git", git.patterns[0] as string)).toBe(true)
  expect(match("**/.git/**", git.patterns[0] as string)).toBe(true)
  const modules = rule("grep", "node-modules")
  expect(modules.label).toMatch(/search pattern/i)
  expect(match("node_modules", modules.patterns[0] as string)).toBe(true)
  expect(match("HEAD", modules.patterns[0] as string)).toBe(false)
})

test("curated file patterns match what core FileAccess actually emits, root and nested", () => {
  // Core FileAccess.resolve emits project-relative resources like
  // `.git/config` and `bun.lock`; Wildcard turns `**` into `.*` with no
  // glob-directory semantics, so nested-only patterns miss root files.
  const git = rule("read", "git")
  const gitDenied = (resource: string): boolean =>
    git.patterns.some((pattern) => match(resource, pattern))
  expect(gitDenied(".git/config")).toBe(true)
  expect(gitDenied("sub/.git/config")).toBe(true)
  const lock = rule("read", "lock")
  const lockDenied = (resource: string): boolean =>
    lock.patterns.some((pattern) => match(resource, pattern))
  expect(lockDenied("bun.lock")).toBe(true)
  expect(lockDenied("sub/bun.lock")).toBe(true)
  const pkg = rule("read", "package-json")
  const pkgDenied = (resource: string): boolean =>
    pkg.patterns.some((pattern) => match(resource, pattern))
  expect(pkgDenied("package.json")).toBe(true)
  expect(pkgDenied("sub/package.json")).toBe(true)
  // Core FileAccess.resolve emits LOCATION-RELATIVE resources for internal
  // paths (core/src/file-access.ts:99-109): with the Location at the home
  // directory, `read("~/.ssh/id_ed25519")` authorizes `.ssh/id_ed25519`, and
  // a `.ssh` directory at a project root authorizes `.ssh/id_ed25519` too.
  // Absolute external paths still emit absolute resources.
  const ssh = rule("read", "ssh")
  const sshDenied = (resource: string): boolean =>
    ssh.patterns.some((pattern) => match(resource, pattern))
  expect(sshDenied("/home/user/.ssh/id_rsa")).toBe(true)
  expect(sshDenied(".ssh/id_ed25519")).toBe(true)
  expect(sshDenied(".ssh")).toBe(true)
  expect(sshDenied("sub/.ssh/id_ed25519")).toBe(true)
  expect(match("/home/user/.ssh/id_rsa", "~/.ssh/**")).toBe(false)
})
