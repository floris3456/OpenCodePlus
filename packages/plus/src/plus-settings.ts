import { Product } from "@opencode/util/product"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// Plus's global switches: the server half of the Settings › OpenCodePlus rows
// that change what the server does. One file beside the other Plus state, read
// once and kept current by every write.

export interface PlusSettings {
  /** A message sent into a cold chat is summarized by its model's cold-cache models first. */
  readonly coldCompact: boolean
}

const DEFAULTS: PlusSettings = { coldCompact: false }

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
      .then((text): PlusSettings => {
        const parsed: unknown = JSON.parse(text)
        if (typeof parsed !== "object" || parsed === null || !("coldCompact" in parsed)) return DEFAULTS
        return { coldCompact: parsed.coldCompact === true }
      })
      .catch(() => DEFAULTS)
    return cache.loaded
  }
  return {
    read,
    async update(patch: Partial<PlusSettings>): Promise<PlusSettings> {
      const next = { ...(await read()), ...patch }
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
