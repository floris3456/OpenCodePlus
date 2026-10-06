import { expect, test } from "bun:test"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")

const FORBIDDEN = ["@opencode/plus", "@opencode/core", "@opencode/tui", "@opencode/server"]

/**
 * Returns the imports that break the package boundary: forbidden
 * `@opencode/*` hosts, or a relative import that resolves outside the package.
 * `sourcePath` is absolute so relative imports resolve against the file.
 */
export function boundaryViolations(sourcePath: string, source: string): string[] {
  const scan = new Bun.Transpiler({ loader: "tsx" }).scanImports(source)
  const violations: string[] = []
  for (const item of scan) {
    const specifier = item.path
    if (FORBIDDEN.some((name) => specifier === name || specifier.startsWith(`${name}/`))) {
      violations.push(specifier)
      continue
    }
    if (!specifier.startsWith(".")) continue
    const resolved = path.resolve(path.dirname(sourcePath), specifier)
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) violations.push(specifier)
  }
  return violations
}

test("package source never imports a host package or a path outside the package", async () => {
  const glob = new Bun.Glob("src/**/*.{ts,tsx}")
  const violations: string[] = []
  for await (const file of glob.scan(root)) {
    const sourcePath = path.join(root, file)
    violations.push(...boundaryViolations(sourcePath, await Bun.file(sourcePath).text()).map((item) => `${file}: ${item}`))
  }
  expect(violations).toEqual([])
})

test("control: the checker flags a forbidden host import and an escaping relative import", () => {
  const source = 'import a from "@opencode/plus"\nimport b from "../../plus/src/x.js"\n'
  const violations = boundaryViolations(path.join(root, "src", "fixture.ts"), source)
  expect(violations).toContain("@opencode/plus")
  expect(violations).toContain("../../plus/src/x.js")
})
