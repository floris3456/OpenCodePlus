import { deflateRawSync, crc32, gunzipSync } from "node:zlib"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

export const CONTRACT_ARCHIVE_MEMBERS: readonly string[] = [
  "bin/opencodeplus",
  "metadata.json",
  "LICENSE",
  "NOTICE",
]

export const BINARY_MEMBER_NAME = "bin/opencodeplus"
export const BINARY_MODE = 0o755
export const DEFAULT_FILE_MODE = 0o644
export const MAX_BINARY_SIZE_BYTES = 500 * 1024 * 1024 // 500 MB
export const MAX_TEXT_SIZE_BYTES = 10 * 1024 * 1024 // 10 MB

export class ArchiveSafetyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ArchiveSafetyError"
  }
}

export interface ArchiveMemberInput {
  readonly name: string
  readonly content: Uint8Array | Buffer | string
  readonly mode?: number
  readonly mtime?: number
  readonly uid?: number
  readonly gid?: number
}

export interface ParsedArchiveEntry {
  readonly name: string
  readonly mode: number
  readonly uid: number
  readonly gid: number
  readonly size: number
  readonly mtime: number
  readonly typeflag: string
  readonly linkname: string
  readonly content: Buffer
}

export function parseSourceDateEpoch(explicitEpoch?: number): number {
  if (explicitEpoch !== undefined) return explicitEpoch
  const envEpoch = process.env.SOURCE_DATE_EPOCH
  if (envEpoch !== undefined && envEpoch !== "") {
    const parsed = parseInt(envEpoch, 10)
    if (!Number.isNaN(parsed)) return parsed
  }
  return 0
}

export function createTarHeader(
  name: string,
  size: number,
  mode: number,
  mtime: number,
  uid: number,
  gid: number,
  typeflag = "0",
  linkname = "",
): Buffer {
  const header = Buffer.alloc(512, 0)

  // Name (0..100)
  header.write(name, 0, 100, "utf8")

  // Mode (100..108): 6 octal digits + NUL + space
  const octalMode = mode.toString(8).padStart(6, "0")
  header.write(`${octalMode}\0 `, 100, 8, "utf8")

  // UID (108..116)
  const octalUid = uid.toString(8).padStart(6, "0")
  header.write(`${octalUid}\0 `, 108, 8, "utf8")

  // GID (116..124)
  const octalGid = gid.toString(8).padStart(6, "0")
  header.write(`${octalGid}\0 `, 116, 8, "utf8")

  // Size (124..136): 11 octal digits + NUL
  const octalSize = size.toString(8).padStart(11, "0")
  header.write(`${octalSize}\0`, 124, 12, "utf8")

  // Mtime (136..148): 11 octal digits + NUL
  const octalMtime = mtime.toString(8).padStart(11, "0")
  header.write(`${octalMtime}\0`, 136, 12, "utf8")

  // Checksum placeholder (148..156): 8 spaces
  for (let i = 148; i < 156; i += 1) {
    header[i] = 32
  }

  // Typeflag (156..157)
  header.write(typeflag, 156, 1, "utf8")

  // Linkname (157..257)
  if (linkname.length > 0) {
    header.write(linkname, 157, 100, "utf8")
  }

  // Magic & Version (257..265): USTAR format
  header.write("ustar\0", 257, 6, "utf8")
  header.write("00", 263, 2, "utf8")

  // Compute checksum
  let checksum = 0
  for (let i = 0; i < 512; i += 1) {
    checksum += header[i]
  }
  const octalChecksum = checksum.toString(8).padStart(6, "0")
  header.write(`${octalChecksum}\0 `, 148, 8, "utf8")

  return header
}

export function createDeterministicTar(
  members: readonly ArchiveMemberInput[],
  options?: { sourceDateEpoch?: number },
): Buffer {
  const epoch = parseSourceDateEpoch(options?.sourceDateEpoch)

  // Sort members strictly alphabetically by name for deterministic order
  const sortedMembers = [...members].sort((a, b) => {
    if (a.name < b.name) return -1
    if (a.name > b.name) return 1
    return 0
  })

  const blocks: Buffer[] = []

  for (const member of sortedMembers) {
    const rawContent =
      typeof member.content === "string"
        ? Buffer.from(member.content, "utf8")
        : Buffer.from(member.content)

    const mode =
      member.mode !== undefined
        ? member.mode
        : member.name === BINARY_MEMBER_NAME
          ? BINARY_MODE
          : DEFAULT_FILE_MODE

    const uid = member.uid ?? 0
    const gid = member.gid ?? 0
    const mtime = member.mtime ?? epoch

    const header = createTarHeader(member.name, rawContent.length, mode, mtime, uid, gid)
    blocks.push(header)
    blocks.push(rawContent)

    // Pad file content to multiple of 512 bytes
    const padSize = (512 - (rawContent.length % 512)) % 512
    if (padSize > 0) {
      blocks.push(Buffer.alloc(padSize, 0))
    }
  }

  // Tar EOF marker: at least two 512-byte blocks of zeroes
  blocks.push(Buffer.alloc(1024, 0))

  return Buffer.concat(blocks)
}

export function compressGzip(
  data: Buffer,
  options?: { sourceDateEpoch?: number },
): Buffer {
  const epoch = parseSourceDateEpoch(options?.sourceDateEpoch)

  const header = Buffer.alloc(10, 0)
  header[0] = 0x1f
  header[1] = 0x8b
  header[2] = 0x08 // CM = deflate
  header[3] = 0x00 // FLG = 0
  header.writeUInt32LE(epoch >>> 0, 4) // MTIME
  header[8] = 0x02 // XFL = maximum compression
  header[9] = 0xff // OS = unknown / generic

  const deflated = deflateRawSync(data, { level: 9 })

  const footer = Buffer.alloc(8, 0)
  footer.writeUInt32LE(crc32(data) >>> 0, 0)
  footer.writeUInt32LE((data.length % 0x100000000) >>> 0, 4)

  return Buffer.concat([header, deflated, footer])
}

export function createDeterministicArchive(
  members: readonly ArchiveMemberInput[],
  options?: { sourceDateEpoch?: number },
): Buffer {
  const tar = createDeterministicTar(members, options)
  return compressGzip(tar, options)
}

export function parseTar(tarBuffer: Buffer): ParsedArchiveEntry[] {
  const entries: ParsedArchiveEntry[] = []
  let offset = 0

  while (offset + 512 <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + 512)
    // Check for EOF (all zero block)
    const isZero = header.every((b) => b === 0)
    if (isZero) break

    const nameRaw = header.subarray(0, 100).toString("utf8")
    const nullIdx = nameRaw.indexOf("\0")
    const name = (nullIdx >= 0 ? nameRaw.slice(0, nullIdx) : nameRaw).trim()

    const modeStr = header.subarray(100, 108).toString("utf8").replace(/\0.*$/, "").trim()
    const mode = parseInt(modeStr, 8) || 0

    const uidStr = header.subarray(108, 116).toString("utf8").replace(/\0.*$/, "").trim()
    const uid = parseInt(uidStr, 8) || 0

    const gidStr = header.subarray(116, 124).toString("utf8").replace(/\0.*$/, "").trim()
    const gid = parseInt(gidStr, 8) || 0

    const sizeStr = header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim()
    const size = parseInt(sizeStr, 8) || 0

    const mtimeStr = header.subarray(136, 148).toString("utf8").replace(/\0.*$/, "").trim()
    const mtime = parseInt(mtimeStr, 8) || 0

    const typeflagByte = header[156]
    const typeflag = typeflagByte === 0 ? "0" : String.fromCharCode(typeflagByte)

    const linknameRaw = header.subarray(157, 257).toString("utf8")
    const linkNullIdx = linknameRaw.indexOf("\0")
    const linkname = (linkNullIdx >= 0 ? linknameRaw.slice(0, linkNullIdx) : linknameRaw).trim()

    offset += 512
    const content = tarBuffer.subarray(offset, offset + size)
    const padSize = (512 - (size % 512)) % 512
    offset += size + padSize

    entries.push({
      name,
      mode,
      uid,
      gid,
      size,
      mtime,
      typeflag,
      linkname,
      content: Buffer.from(content),
    })
  }

  return entries
}

export function parseArchive(archiveBuffer: Buffer): ParsedArchiveEntry[] {
  const tarBuffer = gunzipSync(archiveBuffer)
  return parseTar(tarBuffer)
}

export function validateArchiveSafety(
  entries: readonly ParsedArchiveEntry[],
  options?: {
    whitelist?: readonly string[]
    maxBinaryBytes?: number
    maxTextBytes?: number
  },
): void {
  const whitelist = options?.whitelist ?? CONTRACT_ARCHIVE_MEMBERS
  const maxBinaryBytes = options?.maxBinaryBytes ?? MAX_BINARY_SIZE_BYTES
  const maxTextBytes = options?.maxTextBytes ?? MAX_TEXT_SIZE_BYTES
  const seenNames = new Set<string>()

  for (const entry of entries) {
    // 1. Whitelist member check
    if (!whitelist.includes(entry.name)) {
      throw new ArchiveSafetyError(
        `Archive member '${entry.name}' is not in contract whitelist: [${whitelist.join(", ")}]`,
      )
    }

    // 2. Path traversal checks
    if (
      entry.name.startsWith("/") ||
      entry.name.startsWith("\\") ||
      entry.name.includes("..") ||
      entry.name.startsWith("./")
    ) {
      throw new ArchiveSafetyError(
        `Path traversal detected in archive member '${entry.name}'`,
      )
    }

    // 3. Reject symlinks and hardlinks
    if (entry.typeflag === "1" || entry.typeflag === "2" || entry.linkname.length > 0) {
      throw new ArchiveSafetyError(
        `Link member detected in archive: '${entry.name}' (type: ${entry.typeflag}, link: ${entry.linkname})`,
      )
    }

    // 4. Reject non-regular member types (directories, devices, FIFOs)
    if (entry.typeflag !== "0" && entry.typeflag !== "\0" && entry.typeflag !== "") {
      throw new ArchiveSafetyError(
        `Non-regular file type '${entry.typeflag}' detected for member '${entry.name}'`,
      )
    }

    // 5. Reject duplicate members
    if (seenNames.has(entry.name)) {
      throw new ArchiveSafetyError(`Duplicate archive member detected: '${entry.name}'`)
    }
    seenNames.add(entry.name)

    // 6. Size bounds
    const isBinary = entry.name === BINARY_MEMBER_NAME
    const maxBound = isBinary ? maxBinaryBytes : maxTextBytes
    if (entry.size > maxBound || entry.content.length > maxBound) {
      throw new ArchiveSafetyError(
        `Archive member '${entry.name}' exceeds maximum size bound (${entry.size} > ${maxBound})`,
      )
    }
  }

  // Ensure all required contract members are present
  for (const required of whitelist) {
    if (!seenNames.has(required)) {
      throw new ArchiveSafetyError(`Required archive member '${required}' is missing from archive`)
    }
  }
}

export async function extractArchiveSafely(
  archiveBuffer: Buffer,
  destinationDir: string,
  options?: {
    whitelist?: readonly string[]
    maxBinaryBytes?: number
    maxTextBytes?: number
  },
): Promise<void> {
  const entries = parseArchive(archiveBuffer)
  validateArchiveSafety(entries, options)

  for (const entry of entries) {
    const fullPath = join(destinationDir, entry.name)
    await mkdir(dirname(fullPath), { recursive: true })
    await writeFile(fullPath, entry.content, { mode: entry.mode })
  }
}
