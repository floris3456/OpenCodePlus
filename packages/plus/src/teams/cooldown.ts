import path from "node:path"
import { atomicJson, lock, readJson } from "./store.js"
import type { ModelIdentity } from "./schema.js"
import { quotaResetText } from "@opencodeplus/cliproxyapi/server"

/**
 * One provider that answered out of quota, until it serves again. `<teams
 * root>/cooldowns.json` keeps one entry per provider key, so a second run that
 * meets the same quota reuses the reset the first one read instead of starting.
 */
export interface Cooldown {
  untilMs: number
  /** The UTC line the answer's reset time reads as. */
  text: string
  /** The failure that ended the run, as the settlement prints it. */
  error: string
  /** When the failure was seen (ISO). */
  at: string
  /** The run whose step failed on it. */
  run: string
}

export type Cooldowns = Record<string, Cooldown>

/**
 * The provider a model is billed to: `provider/model`, or `provider/vendor`
 * when the model id names a vendor first. Cliproxyapi routes one account to
 * many upstream models (`cliproxyapi/commandcode/deepseek/…`), and the quota
 * belongs to the account, so only its first segment identifies the cooldown.
 */
export function providerKey(model: ModelIdentity | null | undefined): string | undefined {
  if (model === null || model === undefined || model.providerID === "" || model.modelID === "") return undefined
  const models = model.modelID.split("/")
  return `${model.providerID}/${models.length > 1 ? models[0] : model.modelID}`
}

/** A run's provider key, from the model it loaded, else the one it asked for. */
export function providerKeyOfRun(run: { loadedModel?: ModelIdentity | null; requestedModel?: ModelIdentity | null }): string | undefined {
  return providerKey(run.loadedModel ?? run.requestedModel)
}

function cooldownsPath(root: string): string {
  return path.join(root, "cooldowns.json")
}

/** Every cooldown still running at `now`; entries past their reset are ignored. */
export async function readCooldowns(root: string, now: number): Promise<Cooldowns> {
  const stored = await readJson<Cooldowns>(cooldownsPath(root)).catch(() => undefined)
  if (stored === undefined || typeof stored !== "object" || stored === null) return {}
  const live = Object.entries(stored).filter(([, entry]) => typeof entry?.untilMs === "number" && entry.untilMs > now)
  return Object.fromEntries(live)
}

/** The cooldown of one provider key, when it is still running. */
export async function activeCooldown(root: string, key: string, now: number): Promise<Cooldown | undefined> {
  return (await readCooldowns(root, now))[key]
}

/** Writes one cooldown, dropping every entry that has already reset. */
export async function saveCooldown(root: string, key: string, cooldown: Cooldown, now: number): Promise<void> {
  await lock(root, "state", "cooldowns", async () => {
    const live = await readCooldowns(root, now)
    await atomicJson(cooldownsPath(root), { ...live, [key]: cooldown })
  })
}

/** "15:45 UTC (in 3 h 12 min)": the reset as it reads now, not when it was seen. */
export function cooldownText(cooldown: Cooldown, now: number): string {
  return quotaResetText(cooldown.untilMs, now)
}

/** The refusal for a member whose provider is out of quota. */
export function cooldownRefusal(role: string, key: string, cooldown: Cooldown, now: number): string {
  return `${role} runs on ${key}, which is out of quota until ${cooldownText(cooldown, now)} (cooldown from run ${cooldown.run}). Delegate to a member on another provider, or wait.`
}
