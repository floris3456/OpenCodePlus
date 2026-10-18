import type { SessionImage } from "@opencode/plugin/effect/session"
import type { PlusSettings } from "./rpc.js"

// Settings › Images: how new images are stored, and what happens when a chat's images fill a request. An image is
// stored once, when it arrives, and never changes afterwards (so the prompt cache holds): a choice here applies to
// images that arrive after it. The figures in the descriptions were measured on real chats on 2026-10-18 (80
// screenshots and renders, 124 MB as PNG; one image at a time).

export const IMAGE_FORMATS = [
  {
    value: "webp",
    title: "WebP, looks the same",
    description: "About 1/9 of the PNG size; looks the same. The default.",
  },
  {
    value: "webp-small",
    title: "WebP, smaller",
    description: "About 1/17 of the PNG size; small text stayed sharp in a test.",
  },
  {
    value: "webp-lossless",
    title: "WebP, lossless",
    description: "Every pixel exact; about half the PNG size, 0.4 s per image.",
  },
  {
    value: "original",
    title: "Keep as PNG",
    description: "Not converted; about 9x the default. Each image is kept under 5 MB.",
  },
] as const satisfies ReadonlyArray<{ value: PlusSettings["imageFormat"]; title: string; description: string }>

export const IMAGE_SIZES = [
  {
    value: "full",
    title: "Full detail",
    footer: "up to 2,000 px",
    description: "The most current models read. The default.",
  },
  {
    value: "medium",
    title: "Medium",
    footer: "up to 1,568 px",
    description: "About 30% fewer bytes and image tokens.",
  },
  {
    value: "small",
    title: "Small",
    footer: "up to 1,092 px",
    description: "About half the bytes and tokens; small text may blur.",
  },
] as const satisfies ReadonlyArray<{ value: PlusSettings["imageSize"]; title: string; footer: string; description: string }>

export const IMAGES_FULL = [
  {
    value: "compact",
    title: "Compact the chat",
    description: "Summarise the chat, then attach new images again. The default.",
  },
  {
    value: "leave-out",
    title: "Leave new images out",
    description: "Keep the chat as it is; the agent is told which image is missing.",
  },
] as const satisfies ReadonlyArray<{ value: PlusSettings["imagesFull"]; title: string; description: string }>

/** The edges and visual tokens of the smaller sizes; full detail keeps what core is configured with. */
const SIZE_LIMITS = {
  medium: { edge: 1_568, visualTokens: 1_600 },
  small: { edge: 1_092, visualTokens: 800 },
} as const

/** Applies the chosen format and size to an arriving image. The defaults leave core's own configuration as it is. */
export function chooseImage(event: SessionImage, settings: Pick<PlusSettings, "imageFormat" | "imageSize">): void {
  if (settings.imageFormat === "webp-small") {
    event.format = "webp"
    event.quality = 75
  }
  if (settings.imageFormat === "webp-lossless" || settings.imageFormat === "original") event.format = settings.imageFormat
  if (settings.imageSize === "full") return
  const limits = SIZE_LIMITS[settings.imageSize]
  event.maxWidth = Math.min(event.maxWidth, limits.edge)
  event.maxHeight = Math.min(event.maxHeight, limits.edge)
  event.maxVisualTokens = Math.min(event.maxVisualTokens, limits.visualTokens)
}
