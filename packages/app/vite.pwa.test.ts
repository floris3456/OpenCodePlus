import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { integrityManifest } from "./vite.pwa"

test("the precache manifest is ordered by URL whatever order the files are listed in", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pwa-manifest-"))
  try {
    const files = { "index.html": "<html></html>", "a.png": "png", "_assets/x.js": "js", "site.webmanifest": "{}" }
    for (const [name, body] of Object.entries(files)) {
      await Bun.write(join(directory, name), body)
    }
    const entry = (url: string) => ({ url, revision: null, size: files[url as keyof typeof files].length })
    const transform = integrityManifest(directory)
    // Two hosts list the same files in different orders; both must yield one manifest.
    const first = await transform(["index.html", "site.webmanifest", "a.png", "_assets/x.js"].map(entry))
    const second = await transform(["a.png", "_assets/x.js", "index.html", "site.webmanifest"].map(entry))

    expect(first).toEqual(second)
    expect(first.manifest.map((item) => item.url)).toEqual(["_assets/x.js", "a.png", "index.html", "site.webmanifest"])
    expect(first.manifest[2].integrity).toBe(
      `sha256-${createHash("sha256").update(files["index.html"]).digest("base64")}`,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
