import type { StorageDomain } from "@opencode/plugin/effect/storage"
import { Effect } from "effect"

type Reader = (key: string) => Promise<unknown>

let provide: (reader: Reader) => void = () => {}
const reader = new Promise<Reader>((resolve) => {
  provide = resolve
})

/**
 * Earlier versions stored quota bindings (installation identity, chat
 * capabilities) under the opencode.plus plugin's storage. The Plus plugin lends
 * a reader for that storage so the CLIProxyAPI plugin can migrate entries on
 * first use. Only the first provider counts; all instances share one store.
 */
export function provideLegacyQuotaStorage(read: Reader) {
  provide(read)
}

/** Reads a legacy entry, waiting a bounded time for the Plus plugin to start (it may be disabled). */
export async function legacyRead(key: string, timeout = 20_000): Promise<unknown> {
  const timer = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), timeout).unref?.())
  const read = await Promise.race([reader, timer])
  return read ? read(key).catch(() => undefined) : undefined
}

/**
 * Plugin storage that copies missing `quota/` entries from the legacy store on
 * first read. Writes and other keys go to this plugin's own storage only.
 */
export function migratingStorage(
  own: StorageDomain,
  legacy: (key: string) => Promise<unknown> = legacyRead,
): StorageDomain {
  return {
    ...own,
    get: (key) =>
      Effect.gen(function* () {
        const value = yield* own.get(key)
        if (value !== undefined || !key.startsWith("quota/")) return value
        const migrated = yield* Effect.promise(() => legacy(key))
        if (migrated === undefined || migrated === null) return undefined
        yield* own.set(key, migrated as never)
        return migrated as never
      }),
  }
}
