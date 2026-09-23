import { describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { collectFiles } from "../script/files"
import { tmpdir } from "./fixture/tmpdir"

describe("collectFiles", () => {
  test("returns relative paths in sorted order regardless of creation order", async () => {
    await using directory = await tmpdir()
    const root = directory.path

    // Created out of order. "B.txt" pins code-unit ordering: locale-aware collation compares
    // base letters first, so it would place "B.txt" after the lowercase names. "alpha-beta.txt"
    // pins full-path order over the "alpha" directory contents rather than per-directory traversal.
    await mkdir(path.join(root, "zulu"))
    await mkdir(path.join(root, "alpha", "nested"), { recursive: true })
    await writeFile(path.join(root, "zulu", "b.txt"), "")
    await writeFile(path.join(root, "beta.txt"), "")
    await writeFile(path.join(root, "alpha", "inner.txt"), "")
    await writeFile(path.join(root, "B.txt"), "")
    await writeFile(path.join(root, "alpha-beta.txt"), "")
    await writeFile(path.join(root, "alpha", "nested", "deep.txt"), "")
    await writeFile(path.join(root, "zulu", "a.txt"), "")

    const expected = [
      "B.txt",
      "alpha-beta.txt",
      path.join("alpha", "inner.txt"),
      path.join("alpha", "nested", "deep.txt"),
      "beta.txt",
      path.join("zulu", "a.txt"),
      path.join("zulu", "b.txt"),
    ]

    const files = await collectFiles(root)
    expect(files).toEqual(expected)
    expect(await collectFiles(root)).toEqual(files)
  })
})
