import type { Plugin } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"
import { IMAGE_FORMATS, IMAGE_SIZES, IMAGES_FULL } from "../image-settings.js"
import { Definition, type Plus } from "../rpc.js"

// Settings › Images: how new images are stored and what happens when a chat's images fill a request. The server
// applies the choice (../image-settings.ts), so every TUI of the server shows the same one.

const SETTINGS_MS = 30_000

type Choice<T> = { readonly value: T; readonly title: string; readonly description: string; readonly footer?: string }

export function createImageSettings(context: Plugin.Context) {
  const plus = context.client.rpc(Definition)
  const [settings, setSettings] = createSignal<Plus.PlusSettings>()
  const read = () => plus["settings.get"](undefined).then(setSettings, () => undefined)
  void read()
  const timer = setInterval(() => void read(), SETTINGS_MS)

  const row = <T extends string>(input: {
    readonly id: string
    readonly title: string
    readonly picker: string
    readonly keywords: readonly string[]
    readonly choices: readonly Choice<T>[]
    readonly current: (settings: Plus.PlusSettings) => T
    readonly patch: (value: T) => Plus.PlusSettingsInput
  }) => {
    const label = (choice: Choice<T>) => (choice.footer === undefined ? choice.title : `${choice.title}, ${choice.footer}`)
    return context.ui.settings.register({
      id: input.id,
      title: input.title,
      category: "Images",
      keywords: input.keywords,
      value: () => {
        const loaded = settings()
        const choice = loaded === undefined ? undefined : input.choices.find((entry) => entry.value === input.current(loaded))
        return choice === undefined ? undefined : label(choice)
      },
      run: async () => {
        await read()
        const loaded = settings()
        const pending = context.ui.dialog.select<T>({
          title: input.picker,
          ...(loaded === undefined ? {} : { current: input.current(loaded) }),
          options: input.choices.map((choice) => ({ title: label(choice), value: choice.value, description: choice.description })),
        })
        // Wide enough for each choice's description on one line.
        context.ui.dialog.set({ size: "large" })
        const picked = await pending
        context.ui.dialog.clear()
        if (picked === undefined) return
        const next = await plus["settings.set"](input.patch(picked)).catch((error: unknown) => {
          context.ui.toast.show({ variant: "error", message: error instanceof Error ? error.message : String(error) })
          return undefined
        })
        if (next !== undefined) setSettings(next)
      },
    })
  }

  const disposers = [
    row({
      id: "plus.images.format",
      title: "Image format",
      picker: "Store new images as",
      keywords: ["webp", "png", "lossless", "quality", "convert", "screenshots"],
      choices: IMAGE_FORMATS,
      current: (loaded) => loaded.imageFormat,
      patch: (imageFormat) => ({ imageFormat }),
    }),
    row({
      id: "plus.images.size",
      title: "Image size",
      picker: "Shrink new images to",
      keywords: ["resize", "shrink", "resolution", "pixels", "image tokens", "screenshots"],
      choices: IMAGE_SIZES,
      current: (loaded) => loaded.imageSize,
      patch: (imageSize) => ({ imageSize }),
    }),
    row({
      id: "plus.images.full",
      title: "When images fill a request",
      picker: "When a chat's images fill a request (25 MB)",
      keywords: ["compact", "compaction", "image limit", "full", "screenshots"],
      choices: IMAGES_FULL,
      current: (loaded) => loaded.imagesFull,
      patch: (imagesFull) => ({ imagesFull }),
    }),
  ]

  return {
    dispose: () => {
      clearInterval(timer)
      disposers.forEach((dispose) => dispose())
    },
  }
}
