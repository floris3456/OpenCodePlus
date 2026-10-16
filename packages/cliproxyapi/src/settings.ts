import type { Plugin } from "@opencode/plugin/tui"

/**
 * The Settings window rows this plugin owns: the pinned Pacer plugin's own
 * options in `opencode.json` (`plugins: [{ package: "opencode-pacer", options }]`).
 * The server half is handed those options; the TUI builtin is not, so both
 * reading and writing go through the resolved config.
 */

/** The config entry package name that configures this plugin. */
const TARGET = "opencode-pacer"

function options(context: Plugin.Context): Record<string, unknown> {
  const plugins = context.config.data.plugins
  if (!Array.isArray(plugins)) return {}
  for (const entry of plugins) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    if (record.package === TARGET && record.options && typeof record.options === "object") {
      return record.options as Record<string, unknown>
    }
  }
  return {}
}

/** Sets or clears one option on this plugin's config entry, creating the entry when needed. */
async function setOption(context: Plugin.Context, key: string, value: unknown) {
  await context.config.update((draft: { plugins?: unknown[] }) => {
    const list = Array.isArray(draft.plugins) ? draft.plugins : (draft.plugins = [])
    let entry = list.find(
      (item) => item && typeof item === "object" && !Array.isArray(item) && (item as Record<string, unknown>).package === TARGET,
    ) as Record<string, unknown> | undefined
    if (!entry) {
      const bare = list.indexOf(TARGET)
      entry = { package: TARGET }
      if (bare >= 0) list[bare] = entry
      else list.push(entry)
    }
    const current = entry.options
    const next = current && typeof current === "object" ? { ...(current as Record<string, unknown>) } : {}
    if (value === undefined) delete next[key]
    else next[key] = value
    entry.options = next
  })
}

/** Picks a `provider/model` from the host catalogue; "" clears the option, undefined cancels. */
async function pickModel(context: Plugin.Context): Promise<string | undefined> {
  const models = context.data.location.model.list()
  if (!models || models.length === 0) {
    context.ui.toast.show({ variant: "warning", message: "No models are available to pick" })
    return undefined
  }
  const providers = [...new Set(models.map((model) => model.providerID))].sort()
  const provider = await context.ui.dialog.select<string>({
    title: "Model provider",
    placeholder: "Select a provider",
    options: [
      { title: "Follow the model settings", value: "", description: "Clear this option" },
      ...providers.map((value) => ({ title: value, value })),
    ],
  })
  if (provider === undefined) return undefined
  if (provider.length === 0) return ""
  const forProvider = models.filter((model) => model.providerID === provider)
  const modelID = await context.ui.dialog.select<string>({
    title: "Model",
    placeholder: "Select a model",
    options: forProvider.map((model) => ({
      title: model.name === model.modelID ? model.modelID : `${model.name} (${model.modelID})`,
      value: model.modelID,
    })),
  })
  if (modelID === undefined) return undefined
  return `${provider}/${modelID}`
}

export function createSettings(context: Plugin.Context) {
  const model = (key: string) => options(context)[key] as string | undefined
  async function pick(key: string) {
    const picked = await pickModel(context)
    if (picked === undefined) return
    await setOption(context, key, picked === "" ? undefined : picked)
  }
  const disposers = [
    context.ui.settings.register({
      id: "pacer.account-switch",
      title: "Account switch",
      category: "Pacer",
      keywords: ["account switch", "handoff", "compact on switch"],
      value: () => (options(context).accountSwitch === false ? "off" : "on"),
      run: () => setOption(context, "accountSwitch", options(context).accountSwitch === false),
    }),
    context.ui.settings.register({
      id: "pacer.compaction-model",
      title: "Compaction model",
      category: "Pacer",
      keywords: ["summary model", "compaction", "account switch"],
      value: () => model("compactionModel") ?? "agent default",
      run: () => pick("compactionModel"),
    }),
    context.ui.settings.register({
      id: "pacer.compaction-fallback",
      title: "Compaction fallback",
      category: "Pacer",
      keywords: ["summary fallback", "compaction", "account switch"],
      value: () => model("compactionFallback") ?? "none",
      run: () => pick("compactionFallback"),
    }),
  ]
  return () => disposers.forEach((dispose) => dispose())
}
