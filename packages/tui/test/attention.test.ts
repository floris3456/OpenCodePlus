import { expect, test } from "bun:test"
import { builtInSoundPaths, defaultSoundPath } from "#attention-sounds"
import { createTuiAttention } from "../src/attention"

function host() {
  const loaded: string[] = []
  const attention = createTuiAttention({
    renderer: { isDestroyed: false, on: () => undefined, off: () => undefined, triggerNotification: () => true },
    config: {
      attention: { notifications: true, sound: true, volume: 0.5, sound_pack: "opencode.default", sounds: {}, protocol: "auto" },
    },
    audio: {
      loadSoundFile: async (file: string) => {
        loaded.push(file)
        return {} as never
      },
      play: () => 1 as never,
    },
  })
  return { attention, loaded }
}

test("a chosen sound plays a built-in OpenCodePlus sound by id or a file by path", async () => {
  const lab = host()
  await lab.attention.notify({ message: "Done", notification: false, sound: { file: "staplebops-02", when: "always" } })
  await lab.attention.notify({ message: "Done", notification: false, sound: { file: "/sounds/ding.wav", when: "always" } })
  await lab.attention.notify({ message: "Done", notification: false, sound: { name: "done", when: "always" } })
  expect(lab.loaded).toEqual([builtInSoundPaths["staplebops-02"], "/sounds/ding.wav", defaultSoundPath])
  expect(Object.keys(builtInSoundPaths)).toHaveLength(45)
})
