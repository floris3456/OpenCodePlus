import { mkdtemp, readdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { generate } from "./generate"

async function collectFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true })
  const files: string[] = []
  for (const entry of entries) {
    const fullPath = join(directory, entry)
    const fileStat = await stat(fullPath)
    if (fileStat.isFile()) {
      files.push(entry)
    }
  }
  return files.sort()
}

const clientRoot = resolve(import.meta.dir, "..")
const tempDir = await mkdtemp(join(tmpdir(), "check-generated-"))

const targets = [
  {
    name: "src/promise/generated",
    committedDir: resolve(clientRoot, "src/promise/generated"),
    tempDir: join(tempDir, "src/promise/generated"),
  },
  {
    name: "src/effect/generated",
    committedDir: resolve(clientRoot, "src/effect/generated"),
    tempDir: join(tempDir, "src/effect/generated"),
  },
  {
    name: "src/effect/api",
    committedDir: resolve(clientRoot, "src/effect/api"),
    tempDir: join(tempDir, "src/effect/api"),
  },
]

try {
  await generate(tempDir)

  const differences: string[] = []

  for (const target of targets) {
    const committedFiles = await collectFiles(target.committedDir)
    const generatedFiles = await collectFiles(target.tempDir)
    const allFiles = Array.from(new Set([...committedFiles, ...generatedFiles])).sort()

    for (const file of allFiles) {
      const relPath = `${target.name}/${file}`
      const inCommitted = committedFiles.includes(file)
      const inGenerated = generatedFiles.includes(file)

      if (!inCommitted) {
        differences.push(`Missing in committed client: ${relPath}`)
        continue
      }
      if (!inGenerated) {
        differences.push(`Extra in committed client (removed by generator): ${relPath}`)
        continue
      }

      const committedBytes = await Bun.file(join(target.committedDir, file)).bytes()
      const generatedBytes = await Bun.file(join(target.tempDir, file)).bytes()

      if (Buffer.compare(committedBytes, generatedBytes) !== 0) {
        differences.push(`Differing content: ${relPath}`)
      }
    }
  }

  if (differences.length > 0) {
    console.error("Generated client check failed. The following files differ or are missing:")
    for (const diff of differences) {
      console.error(`  - ${diff}`)
    }
    console.error("\nPlease run `bun run generate` from packages/client to regenerate client files.")
    process.exit(1)
  }

  console.log("Generated client check passed: committed generated files match fresh generation byte-for-byte.")
} finally {
  await rm(tempDir, { recursive: true, force: true })
}
