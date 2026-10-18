import { Product } from "@opencode/util/product"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ImageFormat, ImagesFull, ImageSize, type PlusSettings } from "./rpc.js"

// Plus's global switches: the server half of the Settings › OpenCodePlus rows
// that change what the server does. One file beside the other Plus state, read
// once and kept current by every write.

export type { PlusSettings }

/** The choices the Settings rows offer; a value outside them falls back to the default. */
export const NOTICE_MINUTES = [15, 30, 60, 120] as const
export const NOTICE_MIN_TOKENS = [0, 1_000, 10_000, 50_000, 100_000] as const

const DEFAULTS: PlusSettings = {
  coldCompact: false,
  noticeMinutes: 15,
  noticeMinTokens: 0,
  noticeKinds: "misses-and-partials",
  noticeDismiss: "everywhere",
  imageFormat: "webp",
  imageSize: "full",
  imagesFull: "compact",
}

export function plusSettingsPath(): string {
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
  if (Product.namespace === "opencodeplus") return path.join(base, Product.namespace, "settings.json")
  return path.join(base, Product.namespace, "opencodeplus", "settings.json")
}

export function createPlusSettings(file: string = plusSettingsPath()) {
  const cache = { loaded: undefined as Promise<PlusSettings> | undefined }
  const read = () => {
    cache.loaded ??= fs
      .readFile(file, "utf8")
      .then((text) => settingsOf(JSON.parse(text)))
      .catch(() => DEFAULTS)
    return cache.loaded
  }
  return {
    read,
    async update(patch: Partial<PlusSettings>): Promise<PlusSettings> {
      const next = settingsOf({ ...(await read()), ...patch })
      await fs.mkdir(path.dirname(file), { recursive: true })
      const temp = `${file}.${process.pid}.tmp`
      await fs.writeFile(temp, JSON.stringify(next, null, 2) + "\n")
      await fs.rename(temp, file)
      cache.loaded = Promise.resolve(next)
      return next
    },
  }
}

export const plusSettings = createPlusSettings()

function settingsOf(value: unknown): PlusSettings {
  if (typeof value !== "object" || value === null) return DEFAULTS
  const record = value as Record<string, unknown>
  const pick = <T>(choices: readonly T[], key: keyof PlusSettings) =>
    choices.find((choice) => choice === record[key]) ?? (DEFAULTS[key] as T)
  return {
    coldCompact: record.coldCompact === true,
    noticeMinutes: pick(NOTICE_MINUTES, "noticeMinutes"),
    noticeMinTokens: pick(NOTICE_MIN_TOKENS, "noticeMinTokens"),
    noticeKinds: pick(["misses-and-partials", "misses"] as const, "noticeKinds"),
    noticeDismiss: pick(["everywhere", "this-tui"] as const, "noticeDismiss"),
    imageFormat: pick(ImageFormat.literals, "imageFormat"),
    imageSize: pick(ImageSize.literals, "imageSize"),
    imagesFull: pick(ImagesFull.literals, "imagesFull"),
  }
}
