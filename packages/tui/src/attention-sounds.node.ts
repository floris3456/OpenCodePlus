import { createRequire } from "node:module"
import path from "node:path"
import { BUILT_IN_SOUNDS, type BuiltInSound } from "@opencode/plus/attention-settings"

const require = createRequire(import.meta.url)
const resolve = (name: string) => {
  const key = `@opencode/ui/audio/${name}`
  return process.env.OPENCODE_NODE_ASSETS_DIR
    ? path.join(process.env.OPENCODE_NODE_ASSETS_DIR, key)
    : require.resolve(key)
}

/** Every sound that ships with OpenCodePlus, by its id in the notification settings. */
export const builtInSoundPaths = Object.fromEntries(
  BUILT_IN_SOUNDS.map((id) => [id, resolve(`${id}.mp3`)]),
) as Readonly<Record<BuiltInSound, string>>

export const defaultSoundPath = builtInSoundPaths["bip-bop-01"]
export const questionSoundPath = builtInSoundPaths["bip-bop-03"]
export const permissionSoundPath = builtInSoundPaths["staplebops-06"]
export const errorSoundPath = builtInSoundPaths["nope-03"]
export const subagentDoneSoundPath = builtInSoundPaths["yup-01"]
