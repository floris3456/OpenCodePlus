import type { SessionImage } from "@opencode/plugin/effect/session"

// Instructions › a model › Images: how an image that arrives in a chat on that model is stored, and what happens
// when the chat's images fill what one request may carry. An image is stored once, when it arrives, and never changes
// afterwards (so the prompt cache holds): a choice applies to images that arrive after it.
//
// The descriptions rest on checks made on 2026-10-18 (run/evidence/cache-notices/2026-10-18/):
// - WebP 90/75: a blind test of Claude Opus 5.5, GPT-6 Astra and Gemini 3.8 Flash reading 48 codes of 8-18 px text
//   per image, 5 images; correct of 720: original 716, WebP 90 717, WebP 75 712 (its losses all in faint text that
//   had been a JPEG). Sizes on 80 real screenshots: PNG 124 MB, WebP 90 15 MB, WebP 75 8 MB, lossless WebP 66 MB.
// - 2,000 px: Anthropic refuses images over 2,000 px once a request holds more than 20 images; OpenAI and Google read
//   larger ones. 1,568 px: the long edge Claude models before Opus 4.7 scale images down to.

export type ImageField = "imageConvert" | "imageShrink" | "imagesFull"
export const IMAGE_FIELDS: readonly ImageField[] = ["imageConvert", "imageShrink", "imagesFull"]

export const IMAGE_FIELD_LABELS: Record<ImageField, string> = {
  imageConvert: "Convert large image",
  imageShrink: "Shrink large image",
  imagesFull: "When image context is full",
}

export type Choice = { readonly value: string; readonly title: string; readonly description: string }

export const IMAGE_CONVERT: readonly Choice[] = [
  { value: "webp-90", title: "WebP 90", description: "Indistinguishable for most agents." },
  { value: "webp-75", title: "WebP 75", description: "Half the size of WebP 90; faint text can suffer." },
  { value: "webp-lossless", title: "Lossless WebP", description: "Exact pixels; about 4x the size of WebP 90." },
  { value: "original", title: "Don't convert", description: "Keeps the file as it arrived; the largest." },
]

export const IMAGE_SHRINK: readonly Choice[] = [
  { value: "2000", title: "Max: 2,000 px", description: "The most every major provider accepts in long chats." },
  { value: "1568", title: "1,568 px", description: "The most Claude reads before Opus 4.7." },
  { value: "1000", title: "1,000 px", description: "About a quarter of the image tokens of 2,000 px." },
]

export const IMAGES_FULL: readonly Choice[] = [
  { value: "compact", title: "Compact the chat", description: "Summarise it; new images fit again." },
  { value: "leave-out", title: "Leave new images out", description: "Continue; the agent is told which it can't see." },
  { value: "error", title: "Stop with an error", description: "Stop until you compact or start a new chat." },
]

/** What a model without its own choice gets: the same as core does on its own. */
export const BUILT_IN_IMAGES: Record<ImageField, string> = { imageConvert: "webp-90", imageShrink: "2000", imagesFull: "compact" }

/** A custom size: smaller would not show text; larger than any provider reads. */
export const SHRINK_MIN = 256
export const SHRINK_MAX = 65_535

/** Shown when choosing your own size. */
export const CUSTOM_SHRINK_HELP =
  "Longest edge in pixels. Claude refuses images over 2,000 px once a request holds more than 20 images; GPT-6 and self-hosted models may read larger."

/** A stored value in canonical form, or undefined when it is not one. */
export function imageValueOf(field: ImageField, value: string): string | undefined {
  if (field === "imageShrink") {
    if (!/^\d+$/.test(value)) return undefined
    const pixels = Number(value)
    return pixels >= SHRINK_MIN && pixels <= SHRINK_MAX ? String(pixels) : undefined
  }
  return choicesOf(field).some((choice) => choice.value === value) ? value : undefined
}

/** Validates a typed or sent value: "" and null clear, a value outside the choices is refused. */
export function imageFieldOf(field: ImageField, text: string | null | undefined): string | null | undefined | { readonly error: string } {
  if (text === undefined || text === null) return text
  const value = text.trim().toLowerCase().replace(/[\s,]|px$/g, "")
  if (value.length === 0) return null
  const canonical = imageValueOf(field, value)
  if (canonical !== undefined) return canonical
  if (field === "imageShrink") return { error: `${IMAGE_FIELD_LABELS[field]} is a size in pixels from ${SHRINK_MIN} to ${SHRINK_MAX}, got "${text.trim()}"` }
  return { error: `${IMAGE_FIELD_LABELS[field]} must be ${choicesOf(field).map((choice) => choice.value).join(", ")}, got "${text.trim()}"` }
}

export function choicesOf(field: ImageField): readonly Choice[] {
  if (field === "imageConvert") return IMAGE_CONVERT
  if (field === "imageShrink") return IMAGE_SHRINK
  return IMAGES_FULL
}

/** A value as the Instructions rows show it. */
export function imageWord(field: ImageField, value: string): string {
  const choice = choicesOf(field).find((entry) => entry.value === value)
  if (choice !== undefined) return choice.title
  return field === "imageShrink" ? `${Number(value).toLocaleString("en-US")} px (custom)` : value
}

/**
 * Applies a model's image choices to an arriving image. A field no row sets (`undefined`) leaves core's own
 * configuration as it is.
 */
export function chooseImage(event: SessionImage, chosen: { readonly imageConvert?: string; readonly imageShrink?: string }): void {
  if (chosen.imageConvert === "webp-90" || chosen.imageConvert === "webp-75") {
    event.format = "webp"
    event.quality = chosen.imageConvert === "webp-90" ? 90 : 75
  }
  if (chosen.imageConvert === "webp-lossless" || chosen.imageConvert === "original") event.format = chosen.imageConvert
  if (chosen.imageShrink === undefined) return
  const pixels = Number(chosen.imageShrink)
  event.maxWidth = pixels
  event.maxHeight = pixels
  event.maxVisualTokens = visualTokensFor(pixels)
}

/**
 * The visual-token budget that goes with a size: at 2,000 px the most Claude 4.7+ reads (4,784), at 1,568 px what
 * earlier Claude models read (about 1,600); otherwise a square of that size, so the edge alone decides.
 */
export function visualTokensFor(pixels: number): number {
  if (pixels === 2_000) return 4_784
  if (pixels === 1_568) return 1_600
  return Math.ceil(pixels / 28) ** 2
}

/** What the inspector says about an Images field, beside the choices themselves. */
export const IMAGE_FIELD_NOTES: Record<ImageField, readonly string[]> = {
  imageConvert: [
    "Converts an image of 512 KB or more when that saves at least a quarter; smaller ones, and images WebP would not shrink (most JPEGs at WebP 90), stay as they are.",
    "Applies to images that arrive from now on: an image is stored once and never changes, so the prompt cache holds.",
  ],
  imageShrink: [
    "An image larger than this, in pixels or in image tokens, is shrunk when it arrives.",
    "Claude refuses images over 2,000 px once a request holds more than 20 images; GPT-6 reads up to 65,535 px.",
    "Applies to images that arrive from now on: an image is stored once and never changes, so the prompt cache holds.",
  ],
  imagesFull: [
    "One request carries at most 25 MB of images, and at most 600 for Claude (100 with a 200k context) or 500 for GPT.",
    "Leaving images out or stopping never changes what was sent, so the prompt cache holds; compacting starts a new history once.",
  ],
}
