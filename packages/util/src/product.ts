declare const OPENCODE_PRODUCT: string | undefined

export interface Identity {
  readonly namespace: string
  readonly channel: string
  readonly displayName: string
  readonly binaryName: string
}

export type Product = Identity

export const upstream: Identity = {
  namespace: "opencode",
  channel: "latest",
  displayName: "OpenCode",
  binaryName: "opencode2",
}

export const plus: Identity = {
  namespace: "opencodeplus",
  channel: "plus",
  displayName: "OpenCodePlus",
  binaryName: "opencodeplus",
}

export function resolve(input?: string | Partial<Identity>): Identity {
  if (typeof input === "object" && input !== null) {
    const base = input.namespace === "opencodeplus" || input.channel === "plus" ? plus : upstream
    return { ...base, ...input }
  }
  const selection =
    typeof input === "string"
      ? input
      : typeof OPENCODE_PRODUCT === "string"
        ? OPENCODE_PRODUCT
        : (process.env.OPENCODE_PRODUCT ?? "")

  if (selection === "opencodeplus" || selection === "plus") {
    return plus
  }
  return {
    ...upstream,
    ...(process.env.OPENCODE_CHANNEL ? { channel: process.env.OPENCODE_CHANNEL } : {}),
  }
}

export const Product = {
  get namespace() {
    return resolve().namespace
  },
  get channel() {
    return resolve().channel
  },
  get displayName() {
    return resolve().displayName
  },
  get binaryName() {
    return resolve().binaryName
  },
  resolve,
  upstream,
  plus,
}
