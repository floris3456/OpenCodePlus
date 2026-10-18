import type { Plugin } from "@opencode/plugin/tui"
import { keywordsForPattern } from "../../instructions/tool-permissions.js"
import { Definition, type Level, type Plus, type PresetRef } from "../../rpc.js"
import { parsePermItemId } from "../../instructions/model.js"
import {
  cacheLifetimeOf,
  COMPACTION_STRATEGIES,
  CUSTOM_CHOICE,
  fromWords,
  imageFieldChoices,
  isDefaultSwitchField,
  isEvery,
  isModelSettingRowId,
  modelFieldChoices,
  modelSettingEffective,
  MODEL_FIELD_LABELS,
  MODEL_SETTING_LABELS,
  parseModelFieldItemId,
  parseModelSettingItemId,
  sourceWord,
  type ModelDefaultField,
  type ModelFieldChoice,
  type ModelSettingsField,
} from "../../instructions/model-settings.js"
import { skillScopeOfNode, type AddKind, type RowOwner, type TreeNode } from "../../instructions/tree.js"
import { parseModelText } from "../../instructions/ops.js"
import { renameCandidateOf, validateRenameName } from "./rename.js"
import { pickAgentPreset, pickTeamPreset, presetName } from "../preset-picker.js"
import { createSnapshotCache, type SnapshotCache } from "../snapshot-cache.js"
import type { InstructionsState } from "./state.js"
import { sameEndpoint, type RowlinkEndpoint, type RowlinkType } from "../../instructions/rowlinks.js"
import { parseModelPatterns } from "../../instructions/model-patterns.js"
import { isModelPrompt } from "../../instructions/system-order.js"
import { folderSlug } from "../../instructions/folders.js"
import { CUSTOM_SHRINK_HELP, IMAGE_FIELDS, type ImageField } from "../../image-settings.js"

const MODEL_PATTERN_HELP =
  "Separate patterns with commas. * or % stands for any text (*opus-5-5*, %qwen%). Each is checked against provider/model, the model id and its name, ignoring case."

export interface InstructionsDialogsOptions {
  /** The row a node hangs under; defaults to the flat tree's nearest shallower row. */
  readonly parentOf?: (node: TreeNode) => TreeNode | undefined
}

export function createInstructionsDialogs(
  context: Plugin.Context,
  state: InstructionsState,
  options: InstructionsDialogsOptions = {},
  cache: SnapshotCache = createSnapshotCache(),
) {
  const plus = context.client.rpc(Definition)
  let disposed = false

  async function addFor(node: TreeNode | undefined): Promise<void> {
    if (disposed) return
    if (
      node !== undefined &&
      (node.id.match(/^team:(project|global|defaults):[^:]+:special$/) !== null ||
        node.id.match(/^team:(project|global|defaults):[^:]+:special:[^:]+$/) !== null)
    ) {
      state.setStatus("Special agents are built in; add is not available here")
      return
    }
    // A tool row that hosts both sections and rules carries no direct add:
    // `a` offers the Section / Permission rule choice. Every other row keeps
    // today's direct add or the generic picker.
    if (node?.kind === "item" && node.address !== undefined && node.add === undefined && node.actions?.split === true && node.address.item.startsWith("tool:")) {
      const picked = await context.ui.dialog.select<"section" | "rule">({
        title: "Add",
        placeholder: "Select what to add",
        options: [
          { title: "Section", value: "section" },
          { title: "Permission rule", value: "rule" },
        ],
      })
      if (disposed) return
      if (picked === undefined) return
      await addKind(picked, node)
      return
    }
    const kind = node?.add
    if (kind === undefined) {
      const picked = await context.ui.dialog.select<AddKind>({
        title: "Add",
        placeholder: "Select what to add",
        options: [
          { title: "Agent", value: "agent" },
          { title: "Base prompt", value: "base" },
          { title: "System row", value: "system" },
          { title: "Model prompt", value: "modelprompt" },
          { title: "Skill", value: "skill" },
          // OpenCodePlus: creating AGENTS.md files is off pending the Context catalogue.
          // { title: "Instruction", value: "instruction" },
          { title: "MCP server", value: "mcp" },
          { title: "Team", value: "team" },
          { title: "Model", value: "model" },
          { title: "Permission rule", value: "rule" },
          { title: "Folder", value: "folder" },
        ],
      })
      if (disposed) return
      if (picked === undefined) return
      await addKind(picked, node)
      return
    }
    // Models carries a direct add (`add: "model"`): `a` there keeps the group
    // context but first offers Model or Folder. The generic picker above
    // stays the fallback for rows with no direct add.
    if (kind === "model") {
      const picked = await context.ui.dialog.select<"model" | "folder">({
        title: "Add",
        placeholder: "Select what to add",
        options: [
          { title: "Model", value: "model" },
          { title: "Folder", value: "folder" },
        ],
      })
      if (disposed) return
      if (picked === undefined) return
      await addKind(picked, node)
      return
    }
    await addKind(kind, node)
  }

  async function addKind(kind: AddKind, node?: TreeNode): Promise<void> {
    if (kind === "preset") return addPreset()
    if (kind === "team-preset") return addTeamPreset()
    if (kind === "agent") {
      // A user team preset takes member presets.
      if (node?.owner?.preset?.ref.kind === "team") return addPresetMember(node.owner.preset.ref.id)
      // Team rows and member rows carry `add: "agent"` (kind "team"); both
      // route to addTeamAgent, which resolves the enclosing team (at
      // Defaults: a member entry of the team pattern).
      if (node?.kind === "team" && node.add === "agent" && node.id.match(/^team:(project|global|defaults):(.+)$/s) !== null)
        return addTeamAgent(node)
      // Defaults → Agents takes entries (names or patterns), not files.
      if (node?.id.startsWith("group:defaults:agents") === true) return addEntry()
      return addAgent(node)
    }
    if (kind === "base") return addBase()
    if (kind === "system") return addSystem()
    if (kind === "modelprompt") return addModelPrompt()
    if (kind === "skill") return addSkill(node)
    if (kind === "instruction") return addInstruction()
    // Defaults → Teams takes team entries: a team pattern with a member entry.
    if (kind === "team" && node?.id === "group:defaults:teams") return addTeamEntry()
    if (kind === "team") return addTeam(node)
    if (kind === "section") return addSection(node)
    if (kind === "model") return addModel(node)
    if (kind === "rule") return addRule(node)
    if (kind === "folder") return addFolder(node)
    return addMcp()
  }

  // Enter on a Defaults › Models field row: a switch toggles, Strategy cycles,
  // the compaction model and instructions prompt, and the warming fields prompt
  // for one value. Empty inherits; the effective value shows as the placeholder.
  async function editModelSetting(node: TreeNode): Promise<void> {
    if (disposed) return
    const parsed = node.address === undefined ? undefined : parseModelSettingItemId(node.address.item)
    if (parsed === undefined || !isModelSettingRowId(node.id)) {
      context.ui.toast.show({ variant: "error", message: "This row cannot be edited" })
      return
    }
    const field = parsed.field
    if (isDefaultSwitchField(field)) {
      await state.toggleModelSwitch(node)
      return
    }
    if (field === "compactionStrategy") {
      const current = state.modelCompactionView(node)
      const at = current === undefined ? -1 : (COMPACTION_STRATEGIES as readonly string[]).indexOf(current)
      const next = COMPACTION_STRATEGIES[(at + 1) % COMPACTION_STRATEGIES.length]!
      await state.editModelSettings(node, { compactionStrategy: next })
      return
    }
    if (isImageField(field)) {
      const picked = await pickImageField(field, `${MODEL_SETTING_LABELS[field]} · ${isEvery(parsed.key) ? "Every model" : `${parsed.key.providerID}/${parsed.key.modelID}`}`, node)
      if (disposed || picked === undefined) return
      await state.editModelSettings(node, { [field]: picked.length === 0 ? null : picked })
      return
    }
    if (field === "compactionInput" || field === "compactionOutput") {
      const raw = await context.ui.dialog.prompt({
        title: `${MODEL_SETTING_LABELS[field]} · ${isEvery(parsed.key) ? "Every model" : `${parsed.key.providerID}/${parsed.key.modelID}`}`,
        description: `${fieldHelp(field, [])} Empty inherits. Now: ${node.badges.value ?? "off"}.`,
        value: state.modelDefaultsView(node)?.record?.[field] ?? "",
        placeholder: node.badges.value ?? "off",
      })
      if (disposed || raw === undefined) return
      await state.editModelSettings(node, { [field]: raw.trim().length === 0 ? null : raw.trim() })
      return
    }
    const current = await currentSnapshot()
    if (disposed || current === undefined) return
    const effective = state.modelDefaultsView(node)
    if (effective === undefined) return
    const label = isEvery(parsed.key) ? "Every model" : `${parsed.key.providerID}/${parsed.key.modelID}`
    const title = `${MODEL_SETTING_LABELS[field]} · ${label}`
    const now = modelSettingEffective(effective, field as ModelSettingsField)
    const variants = isEvery(parsed.key)
      ? []
      : ((current.hostModels ?? []).find((entry) => entry.providerID === parsed.key.providerID && entry.modelID === parsed.key.modelID)?.variants ?? [])
    const own = effective.record?.[field]
    if (field === "compactionModel") {
      const model = await pickCompactionModel(current)
      if (disposed || model === undefined) return
      await state.editModelSettings(node, { compactionModel: model })
      return
    }
    if (field === "warming" || field === "interval" || field === "effort") {
      const nowText = now === undefined ? "" : `${now.text} · ${sourceWord(now.from)}`
      const picked = await pickModelField(
        title,
        nowText === "" ? "" : `Now: ${nowText}`,
        modelFieldChoices(field, { now: nowText, lifetime: cacheLifetimeOf(parsed.key), variants, everyModel: isEvery(parsed.key) }),
        () =>
          context.ui.dialog.prompt({
            title,
            description: `${fieldHelp(field, variants)} Empty inherits.${now === undefined ? "" : ` Now: ${now.text} (${fromWords(now.from)}).`}`,
            value: typeof own === "string" ? own : "",
            placeholder: now?.text ?? "",
          }),
      )
      if (disposed || picked === undefined) return
      await state.editModelSettings(node, { [field]: picked.length === 0 ? null : picked } as never)
      return
    }
    const raw = await context.ui.dialog.prompt({
      title,
      description: `${fieldHelp(field, variants)} Empty inherits.${now === undefined ? "" : ` Now: ${now.text} (${fromWords(now.from)}).`}`,
      value: typeof own === "string" ? own : "",
      placeholder: now?.text ?? "",
    })
    if (disposed || raw === undefined) return
    const text = raw.trim()
    if (field === "compactionInstructions") {
      await state.editModelSettings(node, { compactionInstructions: text })
      return
    }
    await state.editModelSettings(node, { [field]: text.length === 0 ? null : text } as never)
  }

  // Warming, Ping every and Effort open one dropdown on every model row. Inherit
  // (an empty value) clears the field; Custom… asks for the text, as the field
  // always did. Resolves to the text to store ("" clears), or undefined on cancel.
  async function pickModelField(
    title: string,
    placeholder: string,
    options: readonly ModelFieldChoice[],
    ask: () => Promise<string | undefined>,
  ): Promise<string | undefined> {
    const picked = await context.ui.dialog.select<string>({ title, placeholder, options: [...options] })
    if (disposed || picked === undefined) return undefined
    const text = picked === CUSTOM_CHOICE ? await ask() : picked
    if (disposed || text === undefined) return undefined
    return text.trim()
  }

  // An Images field opens one dropdown on every model row: Inherit (clears), the choices with what each does, and for
  // the size Custom…, which asks for pixels. Resolves to the text to store ("" clears), or undefined on cancel.
  async function pickImageField(field: ImageField, title: string, node: TreeNode): Promise<string | undefined> {
    const now = node.badges.value ?? ""
    const pending = context.ui.dialog.select<string>({ title, placeholder: now === "" ? "" : `Now: ${now}`, options: imageFieldChoices(field, now) })
    // Wide enough for each choice's description on one line.
    context.ui.dialog.set({ size: "large" })
    const picked = await pending
    if (disposed || picked === undefined) return undefined
    if (picked !== CUSTOM_CHOICE) return picked
    const raw = await context.ui.dialog.prompt({ title, description: CUSTOM_SHRINK_HELP, value: "", placeholder: "e.g. 2576" })
    return disposed || raw === undefined ? undefined : raw.trim()
  }

  // Enter on one field row under an agent/member/preset model row: edit that
  // one value. Model and Effort pick from the host catalogue (the field row's
  // variants); the warming fields prompt like a Defaults › Models field. Empty
  // inherits; the effective value shows as the placeholder.
  async function editModelField(node: TreeNode): Promise<void> {
    if (disposed) return
    const parsed = node.address === undefined ? undefined : parseModelFieldItemId(node.address.item)
    if (parsed === undefined) {
      context.ui.toast.show({ variant: "error", message: "This row cannot be edited" })
      return
    }
    const current = await currentSnapshot()
    if (disposed || current === undefined) return
    const field = parsed.field
    if (field === "compactWarm" || field === "coldCompact") {
      await state.toggleModelSwitch(node)
      return
    }
    if (isImageField(field)) {
      const picked = await pickImageField(field, `${MODEL_FIELD_LABELS[field]} · ${parsed.target.providerID}/${parsed.target.modelID}`, node)
      if (disposed || picked === undefined) return
      await state.setModelCompaction(node, { [field]: picked.length === 0 ? null : picked })
      return
    }
    if (field === "compactionStrategy") {
      const value = (node.badges.value ?? "").split(" ")[0]?.toLowerCase() ?? "auto"
      const at = (COMPACTION_STRATEGIES as readonly string[]).indexOf(value)
      const next = COMPACTION_STRATEGIES[(at + 1) % COMPACTION_STRATEGIES.length]!
      await state.setModelCompaction(node, { compactionStrategy: next })
      return
    }
    if (field === "compactionModel") {
      const model = await pickCompactionModel(current)
      if (disposed || model === undefined) return
      await state.setModelCompaction(node, { compactionModel: model })
      return
    }
    if (field === "compactionInstructions") {
      const target = `${parsed.target.providerID}/${parsed.target.modelID}`
      const raw = await context.ui.dialog.prompt({
        title: `${MODEL_FIELD_LABELS[field]} · ${target}`,
        description: `${fieldHelp(field, [])} Empty is an empty prompt.`,
        value: "",
        placeholder: node.badges.value ?? "",
      })
      if (disposed || raw === undefined) return
      await state.setModelCompaction(node, { compactionInstructions: raw.trim() })
      return
    }
    if (field === "model") {
      const raw = await pickCatalogModel()
      if (disposed || raw === undefined) return
      await state.editModelField(node, raw)
      return
    }
    const variants =
      (current.hostModels ?? []).find((entry) => entry.providerID === parsed.target.providerID && entry.modelID === parsed.target.modelID)?.variants ?? []
    const now = node.badges.value ?? ""
    const target = `${parsed.target.providerID}/${parsed.target.modelID}`
    if (field === "warming" || field === "interval" || field === "effort") {
      const picked = await pickModelField(
        `${MODEL_FIELD_LABELS[field]} · ${target}`,
        now === "" ? "" : `Now: ${now}`,
        modelFieldChoices(field, { now, lifetime: cacheLifetimeOf(parsed.target), variants, everyModel: false }),
        () =>
          context.ui.dialog.prompt({
            title: `${MODEL_FIELD_LABELS[field]} · ${target}`,
            description: `${fieldHelp(field, variants)} Empty inherits.${now === "" ? "" : ` Now: ${now}.`}`,
            value: "",
            placeholder: now,
          }),
      )
      if (disposed || picked === undefined) return
      await state.editModelField(node, picked)
      return
    }
    const raw = await context.ui.dialog.prompt({
      title: `${MODEL_FIELD_LABELS[field]} · ${target}`,
      description: `${fieldHelp(field, variants)} Empty inherits.${now === "" ? "" : ` Now: ${now}.`}`,
      value: "",
      placeholder: now,
    })
    if (disposed || raw === undefined) return
    await state.editModelField(node, raw.trim())
  }

  // The compaction model: the catalogue picker with Inherit first (null clears
  // the field), then the model's variant when the catalogue lists any.
  async function pickCompactionModel(current: Plus.Snapshot): Promise<string | null | undefined> {
    const picked = await pickCatalogModel({ inherit: true })
    if (disposed || picked === undefined) return undefined
    if (picked.length === 0) return null
    return pickVariant(picked, current, "The variant the summary runs with")
  }

  // A picked model with the variants its catalogue entry lists: "(none)" keeps
  // the bare model. Without variants the model is returned as picked.
  async function pickVariant(picked: string, current: Plus.Snapshot, placeholder: string): Promise<string | undefined> {
    const target = parseModelText(picked)
    const variants =
      target === undefined
        ? []
        : ((current.hostModels ?? []).find((entry) => entry.providerID === target.providerID && entry.modelID === target.modelID)?.variants ?? [])
    if (variants.length === 0) return picked
    const variant = await context.ui.dialog.select<string>({
      title: "Variant",
      placeholder,
      options: [
        { title: "(none)", value: "", description: "The model without a variant" },
        ...variants.toSorted().map((entry) => ({ title: entry, value: entry })),
      ],
    })
    if (disposed || variant === undefined) return undefined
    return variant.length === 0 ? picked : `${picked}#${variant}`
  }

  // The catalogue picker for a model field: provider, then model. With
  // `inherit`, the provider list leads with Inherit, which resolves to "".
  async function pickCatalogModel(options: { readonly inherit?: boolean } = {}): Promise<string | undefined> {
    let catalog: { providerID: string; modelID: string; name: string }[]
    try {
      const output = await plus["catalog.models"](undefined, { location: context.location })
      if (disposed) return undefined
      catalog = [...output.models]
    } catch (error: unknown) {
      if (disposed) return undefined
      context.ui.toast.show({ variant: "error", message: errorMessage(error) })
      return undefined
    }
    if (catalog.length === 0) {
      context.ui.toast.show({ variant: "error", message: "No models in the host catalog" })
      return undefined
    }
    const providers = [...new Set(catalog.map((entry) => entry.providerID))].toSorted()
    const provider = await context.ui.dialog.select<string>({
      title: "Model provider",
      placeholder: "Select a provider",
      options: [
        ...(options.inherit === true ? [{ title: "Inherit", value: "", description: "Use the model this level inherits" }] : []),
        ...providers.map((entry) => ({ title: entry, value: entry })),
      ],
    })
    if (disposed || provider === undefined) return undefined
    if (provider.length === 0) return ""
    const forProvider = catalog.filter((entry) => entry.providerID === provider)
    const modelIds = [...new Set(forProvider.map((entry) => entry.modelID))].toSorted()
    const modelID = await context.ui.dialog.select<string>({
      title: "Model",
      placeholder: "Select a model",
      options: modelIds.map((id) => {
        const name = forProvider.find((entry) => entry.modelID === id)?.name ?? id
        return { title: name === id ? id : `${name} (${id})`, value: id }
      }),
    })
    if (disposed || modelID === undefined) return undefined
    return `${provider}/${modelID}`
  }

// a on a cold-cache list: the catalogue picker (provider → model → variant),
// then append. An inherited list is copied to this level first.
  async function addColdModel(node: TreeNode): Promise<void> {
    if (disposed) return
    const current = await currentSnapshot()
    if (disposed || current === undefined) return
    const picked = await pickCatalogModel()
    if (disposed || picked === undefined) return
    if (parseModelText(picked) === undefined) {
      context.ui.toast.show({ variant: "error", message: `"${picked}" is not a model` })
      return
    }
    const model = await pickVariant(picked, current, "The variant this model compacts with")
    if (disposed || model === undefined) return
    await state.addColdModel(node, model)
  }

  // a on an item row appends a section to that item: prompt for the name and
  // body, reuse the manual splitter boundary path in state.addSection, then
  // persist both halves of the boundary contract (the SplitRecord boundary
  // and the CustomizationRecord text) in one mutate.
  async function addSection(node: TreeNode | undefined): Promise<void> {
    if (disposed) return
    if (!node || (node.kind !== "item" && node.kind !== "section") || node.address === undefined || (node.kind === "item" && node.actions?.split !== true)) {
      context.ui.toast.show({ variant: "error", message: "This row does not support sections" })
      return
    }
    const raw = await context.ui.dialog.prompt({ title: "Section name", placeholder: "New section" })
    if (disposed) return
    if (raw === undefined) return
    const name = raw.trim()
    if (name.length === 0) {
      context.ui.toast.show({ variant: "error", message: "Section name cannot be empty" })
      return
    }
    const text = await context.ui.dialog.prompt({ title: "Section text", placeholder: "Section content" })
    if (disposed) return
    if (text === undefined) return
    await state.addSection(node, name, text)
  }

  async function currentSnapshot(): Promise<Plus.Snapshot | undefined> {
    const cached = cache.fresh(context.location?.directory)
    if (cached !== undefined) return cached
    try {
      const snapshot = await plus["instructions.snapshot"](undefined, { location: context.location })
      if (disposed) return undefined
      cache.put(context.location?.directory, snapshot)
      return snapshot
    } catch (error: unknown) {
      if (disposed) return undefined
      context.ui.toast.show({ variant: "error", message: errorMessage(error) })
      return undefined
    }
  }

  async function promptName(title: string, description: string, placeholder: string): Promise<string | undefined> {
    const raw = await context.ui.dialog.prompt({ title, description, placeholder })
    if (disposed || raw === undefined) return undefined
    const name = raw.trim()
    if (name.length === 0) {
      context.ui.toast.show({ variant: "error", message: `${title} cannot be empty` })
      return undefined
    }
    return name
  }

  // DESIGN §5: a → name → preset → done. The cursor's Project or Global root
  // decides where; a row outside both asks for the scope last.
  async function addAgent(node?: TreeNode): Promise<void> {
    if (disposed) return
    const id = await promptName("Create agent", "Agent name; use / for nesting (team/lead). .. is not allowed.", "my-agent")
    if (id === undefined) return
    const snapshot = await currentSnapshot()
    if (snapshot === undefined) return
    const preset = await pickAgentPreset(context, snapshot)
    if (disposed) return
    if (preset === undefined) return
    if (node !== undefined && state.selectionContains(node)) {
      await state.batchOperation(node, "create", { kind: "agent", id, ...(preset === null ? {} : { preset }) })
      return
    }
    const scope = levelOfRow(node) ?? (await pickScope("Agent scope"))
    if (disposed) return
    if (scope === undefined) return
    try {
      const ref = await plus["agent.create"](
        { scope, id, ...(preset === null ? {} : { preset }) },
        { location: context.location },
      )
      if (disposed) return
      context.ui.toast.show({ variant: "success", message: `Created agent ${id} at ${ref.path}` })
      context.ui.dialog.clear()
      // Core reloads agents on a debounce, so the row may appear a snapshot
      // later: the state selects it as soon as it is there.
      state.reveal([`root:${scope}`, `group:${scope}:agents`, `group:${scope}:agents:user`], `agent:${scope}:${id}`)
      await state.refresh()
    } catch (error: unknown) {
      if (disposed) return
      context.ui.toast.show({ variant: "error", message: errorMessage(error) })
    }
  }

  async function pickScope(title: string): Promise<"project" | "global" | undefined> {
    return context.ui.dialog.select<"project" | "global">({
      title,
      options: [
        { title: "Project", value: "project", description: "Stored with this project" },
        { title: "Global", value: "global", description: "Stored in your global config" },
      ],
    })
  }

  async function addTeamAgent(node: TreeNode): Promise<void> {
    if (disposed) return
    // Team rows and member rows (add: "agent") take this path. The team name
    // is resolved against known teams in the snapshot, choosing the longest
    // match so colon team names win.
    if (node.add !== "agent") {
      context.ui.toast.show({ variant: "error", message: "This row does not support adding agents" })
      return
    }
    const match = node.id.match(/^team:(project|global|defaults):(.+)$/s)
    if (match === null) {
      context.ui.toast.show({ variant: "error", message: "This row does not support adding agents" })
      return
    }
    const level = match[1] as "project" | "global" | "defaults"
    const teams = (state.snapshot()?.teams ?? [])
      .filter((entry) => entry.level === level)
      .toSorted((left, right) => right.team.length - left.team.length)
    const exactTeam = teams.find((entry) => node.id === `team:${level}:${entry.team}`)
    const memberTeam = teams.find(
      (entry) =>
        entry.team !== exactTeam?.team &&
        entry.agents.some((member) => node.id === `team:${level}:${entry.team}:${member}`),
    )
    if (exactTeam !== undefined && memberTeam !== undefined) {
      context.ui.toast.show({
        variant: "error",
        message: `"${exactTeam.team}" is ambiguous: it matches both a team and a member of team "${memberTeam.team}". Rename one to continue.`,
      })
      return
    }
    const matchEntry = teams.find(
      (entry) =>
        node.id === `team:${level}:${entry.team}` ||
        entry.agents.some((member) => node.id === `team:${level}:${entry.team}:${member}`) ||
        node.id.startsWith(`team:${level}:${entry.team}:`),
    )
    // The row names its team: a team or member row its team, a Defaults team
    // entry or member entry row its team PATTERN (entry rows carry no team in
    // the snapshot, so the row's owner is the only source for them).
    const team = node.owner?.team?.team ?? (matchEntry !== undefined ? matchEntry.team : (match[2] as string))
    const id =
      level === "defaults"
        ? await promptName("Member name or pattern", `A member entry of ${team}; ${wildcards} (e.g. *orchestrator*)`, "*orchestrator*")
        : await promptName("Member name", `A new member of team ${team}; use / for nesting. .. is not allowed.`, "my-agent")
    if (id === undefined) return
    await addMember(level, team, id, node)
  }

  // Defaults → Teams: a team entry is a team pattern with at least one member
  // entry (the entry record is the member), so both patterns are asked.
  async function addTeamEntry(): Promise<void> {
    if (disposed) return
    const team = await promptName("Team name or pattern", `The teams this entry matches; ${wildcards} (e.g. *review*)`, "*review*")
    if (team === undefined) return
    const id = await promptName("Member name or pattern", `The members it matches in ${team}; ${wildcards} (e.g. *orchestrator*)`, "*orchestrator*")
    if (id === undefined) return
    await addMember("defaults", team, id)
  }

  async function addMember(level: "project" | "global" | "defaults", team: string, id: string, node?: TreeNode): Promise<void> {
    const snapshot = await currentSnapshot()
    if (snapshot === undefined) return
    const preset = await pickAgentPreset(context, snapshot)
    if (disposed) return
    if (preset === undefined) return
    if (node !== undefined && state.selectionContains(node)) {
      await state.batchOperation(node, "create", { kind: "member", id, ...(preset === null ? {} : { preset }) })
      return
    }
    try {
      const ref = await plus["team.addAgent"](
        { level, team, id, ...(preset === null ? {} : { preset }) },
        { location: context.location },
      )
      if (disposed) return
      context.ui.toast.show({
        variant: "success",
        message: level === "defaults" ? `Created Defaults entry ${id} in ${team}` : `Created agent ${id} in team ${team} at ${ref.path}`,
      })
      context.ui.dialog.clear()
      state.reveal([`root:${level}`, `group:${level}:teams`, `team:${level}:${team}`], `team:${level}:${team}:${id}`)
      await state.refresh()
    } catch (error: unknown) {
      if (disposed) return
      context.ui.toast.show({ variant: "error", message: errorMessage(error) })
    }
  }

  async function addBase(): Promise<void> {
    if (disposed) return
    const id = await context.ui.dialog.prompt({ title: "Base id", placeholder: "custom" })
    if (disposed) return
    if (id === undefined) return
    const title = await context.ui.dialog.prompt({ title: "Base title", placeholder: "custom.txt" })
    if (disposed) return
    if (title === undefined) return
    const text = await context.ui.dialog.prompt({ title: "Base text", placeholder: "Base prompt text" })
    if (disposed) return
    if (text === undefined) return
    try {
      await plus["base.create"]({ id, title, text }, { location: context.location })
      if (disposed) return
      context.ui.toast.show({ variant: "success", message: `Created base ${id}` })
      await state.refresh()
    } catch (error: unknown) {
      if (disposed) return
      context.ui.toast.show({ variant: "error", message: errorMessage(error) })
    }
  }

  async function addSystem(): Promise<void> {
    if (disposed) return
    const id = await context.ui.dialog.prompt({ title: "System row id", placeholder: "working-rules" })
    if (disposed) return
    if (id === undefined) return
    const title = await context.ui.dialog.prompt({ title: "System row title", placeholder: "Working rules" })
    if (disposed) return
    if (title === undefined) return
    const text = await context.ui.dialog.prompt({ title: "System row text", placeholder: "Instructions every agent with this row receives" })
    if (disposed) return
    if (text === undefined) return
    try {
      await plus["system.create"]({ id, title, text }, { location: context.location })
      if (disposed) return
      context.ui.toast.show({ variant: "success", message: `Created System row ${title.trim() || id}` })
      await state.refresh()
    } catch (error: unknown) {
      if (disposed) return
      context.ui.toast.show({ variant: "error", message: errorMessage(error) })
    }
  }

  // A model prompt: the models first (what it is for), then its title and
  // text. The file name comes from the title.
  async function addModelPrompt(): Promise<void> {
    if (disposed) return
    const models = await context.ui.dialog.prompt({
      title: "Model prompt for which models",
      description: MODEL_PATTERN_HELP,
      placeholder: "*opus-5-5*, *opus-5.5*",
    })
    if (disposed || models === undefined) return
    const title = await context.ui.dialog.prompt({ title: "Model prompt title", placeholder: "Opus 5.5" })
    if (disposed || title === undefined) return
    const text = await context.ui.dialog.prompt({ title: "Model prompt text", placeholder: "Instructions only these models receive, right after the base prompt" })
    if (disposed || text === undefined) return
    try {
      await plus["system.create"]({ id: folderSlug(title.trim() || models), title, text, models: parseModelPatterns(models) }, { location: context.location })
      if (disposed) return
      context.ui.toast.show({ variant: "success", message: `Created model prompt ${title.trim() || models.trim()}` })
      await state.refresh()
    } catch (error: unknown) {
      if (disposed) return
      context.ui.toast.show({ variant: "error", message: errorMessage(error) })
    }
  }

  async function editModels(node: TreeNode): Promise<void> {
    const item = node.address?.item
    if (disposed || item === undefined || !isModelPrompt(item)) return
    const raw = await context.ui.dialog.prompt({
      title: `Models · ${node.label}`,
      description: MODEL_PATTERN_HELP,
      value: (node.badges.models ?? []).join(", "),
      placeholder: "*opus-5-5*",
    })
    if (disposed || raw === undefined) return
    const models = parseModelPatterns(raw)
    try {
      await plus["system.models"]({ id: item.slice("system:".length), models }, { location: context.location })
      if (disposed) return
      state.setStatus(`"${node.label}" is sent for ${models.join(", ")}`)
      await state.refresh()
    } catch (error: unknown) {
      if (disposed) return
      context.ui.toast.show({ variant: "error", message: errorMessage(error) })
    }
  }

  async function addSkill(node: TreeNode | undefined): Promise<void> {
    if (disposed) return
    // The node the user invoked Add on decides the scope: a Skills group under
    // the Project root authors a project skill, under Global a global one, and
    // under Defaults/Presets respectively. The subgroup (OpenCode, Project, …)
    // is a skill's origin, not the target, so only the level is read.
    const target = skillScopeOfNode(node)
    const scopeLabel = target.scope === "preset" ? `preset ${target.preset ?? ""}`.trim() : target.scope
    const mode = await context.ui.dialog.select<"create" | "import">({
      title: `Add ${scopeLabel} skill`,
      options: [
        { title: "Create", value: "create", description: "Create a new skill from name and body" },
        { title: "Import", value: "import", description: "Import from a path to SKILL.md" },
      ],
    })
    if (disposed) return
    if (mode === undefined) return
    const scope = { scope: target.scope, ...(target.preset === undefined ? {} : { preset: target.preset }) }
    if (mode === "import") {
      const path = await context.ui.dialog.prompt({ title: "Import skill", placeholder: "path/to/SKILL.md" })
      if (disposed) return
      if (path === undefined) return
      try {
        const ref = await plus["skill.import"]({ path, ...scope }, { location: context.location })
        if (disposed) return
        context.ui.toast.show({ variant: "success", message: `Imported ${scopeLabel} skill ${ref.id}` })
        await state.refresh()
      } catch (error: unknown) {
        if (disposed) return
        context.ui.toast.show({ variant: "error", message: errorMessage(error) })
      }
      return
    }
    const name = await context.ui.dialog.prompt({ title: "Skill name", placeholder: "my-skill" })
    if (disposed) return
    if (name === undefined) return
    const body = await context.ui.dialog.prompt({ title: "Skill body", placeholder: "Skill instructions" })
    if (disposed) return
    if (body === undefined) return
    try {
      const ref = await plus["skill.create"]({ name, body, ...scope }, { location: context.location })
      if (disposed) return
      context.ui.toast.show({ variant: "success", message: `Created ${scopeLabel} skill ${ref.id}` })
      await state.refresh()
    } catch (error: unknown) {
      if (disposed) return
      context.ui.toast.show({ variant: "error", message: errorMessage(error) })
    }
  }

  async function addInstruction(): Promise<void> {
    if (disposed) return
    const name = await context.ui.dialog.prompt({ title: "Instruction name", placeholder: "AGENTS.md" })
    if (disposed) return
    if (name === undefined) return
    const text = await context.ui.dialog.prompt({ title: "Instruction text", placeholder: "Instruction text" })
    if (disposed) return
    if (text === undefined) return
    try {
      const ref = await plus["instruction.create"]({ name, text }, { location: context.location })
      if (disposed) return
      context.ui.toast.show({ variant: "success", message: `Created instruction ${ref.id}` })
      await state.refresh()
    } catch (error: unknown) {
      if (disposed) return
      context.ui.toast.show({ variant: "error", message: errorMessage(error) })
    }
  }

  async function addMcp(): Promise<void> {
    if (disposed) return
    const name = await context.ui.dialog.prompt({ title: "MCP server name", placeholder: "my-server" })
    if (disposed) return
    if (name === undefined) return
    const raw = await context.ui.dialog.prompt({ title: "MCP config JSON", placeholder: '{"type":"local","command":["npx"]}' })
    if (disposed) return
    if (raw === undefined) return
    let config: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object")
      config = parsed as Record<string, unknown>
    } catch {
      context.ui.toast.show({ variant: "error", message: "MCP config must be a JSON object" })
      return
    }
    try {
      await plus["mcp.add"]({ name, config }, { location: context.location })
      if (disposed) return
      context.ui.toast.show({ variant: "success", message: `Added MCP server ${name}` })
      await state.refresh()
    } catch (error: unknown) {
      if (disposed) return
      context.ui.toast.show({ variant: "error", message: errorMessage(error) })
    }
  }

  // DESIGN §5: a → team name → team preset (or an empty team) → done. The
  // cursor's Project or Global root decides where.
  async function addTeam(node?: TreeNode): Promise<void> {
    if (disposed) return
    const team = await promptName("Team name", "A new team; no slashes or ..", "my-team")
    if (team === undefined) return
    const snapshot = await currentSnapshot()
    if (snapshot === undefined) return
    const preset = await pickTeamPreset(context, snapshot)
    if (disposed) return
    if (preset === undefined) return
    const level = levelOfRow(node) ?? (await pickScope("Team scope"))
    if (disposed) return
    if (level === undefined) return
    try {
      const ref = await plus["team.create"]({ level, team, ...(preset === "" ? {} : { preset }) }, { location: context.location })
      if (disposed) return
      context.ui.toast.show({ variant: "success", message: `Created team ${ref.team}` })
      state.reveal([`root:${level}`, `group:${level}:teams`], `team:${level}:${ref.team}`)
      await state.refresh()
    } catch (error: unknown) {
      if (disposed) return
      context.ui.toast.show({ variant: "error", message: errorMessage(error) })
    }
  }

  // Defaults → Agents: an entry named by a name or pattern, from a preset.
  async function addEntry(): Promise<void> {
    if (disposed) return
    const name = await promptName("Agent name or pattern", `The agents this entry matches; ${wildcards} (e.g. *orchestrator*)`, "*orchestrator*")
    if (name === undefined) return
    const snapshot = await currentSnapshot()
    if (snapshot === undefined) return
    const preset = await pickAgentPreset(context, snapshot)
    if (disposed || preset === undefined) return
    await run(
      () => plus["entry.create"]({ catalogue: "agents", name, ...(preset === null ? {} : { preset }) }, { location: context.location }),
      `Created Defaults entry ${name}`,
      [["root:defaults", "group:defaults:agents", "group:defaults:agents:user"], `agent:defaults:${name}`],
    )
  }

  // Presets → Agents → User: a user preset from a base preset (or none).
  async function addPreset(): Promise<void> {
    if (disposed) return
    const id = await promptName("Preset name", "A new User agent preset", "my-preset")
    if (id === undefined) return
    const snapshot = await currentSnapshot()
    if (snapshot === undefined) return
    const from = await pickAgentPreset(context, snapshot, { title: "Base preset" })
    if (disposed || from === undefined) return
    await run(
      () => plus["preset.create"]({ kind: "agent", id, ...(from === null ? {} : { from }) }, { location: context.location }),
      `Created preset ${id}`,
      [["root:preset", "group:preset:agents", "group:preset:agents:user"], `agent:preset:${id}`],
    )
  }

  // Presets → Teams → User: a user team preset, its members copied from a team preset.
  async function addTeamPreset(): Promise<void> {
    if (disposed) return
    const id = await promptName("Team preset name", "A new User team preset", "my-team")
    if (id === undefined) return
    const snapshot = await currentSnapshot()
    if (snapshot === undefined) return
    const from = await pickTeamPreset(context, snapshot)
    if (disposed || from === undefined) return
    await run(
      () => plus["preset.create"]({ kind: "team", id, ...(from === "" ? {} : { from }) }, { location: context.location }),
      `Created team preset ${id}`,
      [["root:preset", "group:preset:teams", "group:preset:teams:user"], `team:preset:${id}`],
    )
  }

  async function addPresetMember(team: string): Promise<void> {
    if (disposed) return
    const id = await promptName("Member name", `A new member of team preset ${team}`, "my-member")
    if (id === undefined) return
    const snapshot = await currentSnapshot()
    if (snapshot === undefined) return
    const from = await pickAgentPreset(context, snapshot)
    if (disposed || from === undefined) return
    await run(
      () => plus["preset.addMember"]({ team, id, ...(from === null ? {} : { from }) }, { location: context.location }),
      `Added member preset ${id} to ${team}`,
      [["root:preset", "group:preset:teams", "group:preset:teams:user", `team:preset:${team}`], `team:preset:${team}:${id}`],
    )
  }

  // l: relink the row's owner (an agent, member, team, Defaults entry or User
  // preset) to another preset, or unlink it. The current link is preselected;
  // refusals (a cycle, a protected agent, a read-only preset) toast the
  // server's message.
  async function relink(node: TreeNode | undefined): Promise<void> {
    if (disposed) return
    const owner = node?.owner
    if (node === undefined || !isLinkable(owner)) {
      state.setStatus(`"${node?.label ?? "This row"}" takes no preset link`)
      return
    }
    const snapshot = await currentSnapshot()
    if (snapshot === undefined) return
    const preset = owner.agent === null ? await pickTeamLink(snapshot, owner.link) : await pickAgentPreset(context, snapshot, {
      title: "Link to preset",
      none: "None — unlink",
      ...(owner.link === undefined ? {} : { current: owner.link }),
    })
    if (disposed || preset === undefined) return
    if (state.selectionContains(node)) {
      await state.batchOperation(node, "set", { preset })
      return
    }
    const said = preset === null ? `Unlinked ${node.label}` : `Linked ${node.label} to ${presetName(snapshot, preset)}`
    await run(
      () =>
        plus["link.set"](
          {
            level: owner.level,
            agent: owner.agent,
            ...(owner.team === undefined ? {} : { team: owner.team }),
            ...(owner.catalogue === undefined ? {} : { catalogue: owner.catalogue }),
            preset,
          },
          { location: context.location },
        ),
      // A team relink also relinks the members the team preset has.
      (result) => (result.members === undefined || result.members.length === 0 ? said : `${said}; relinked ${result.members.map((member) => member.agent).join(", ")}`),
    )
  }

  async function pickTeamLink(snapshot: Plus.Snapshot, link: PresetRef | undefined): Promise<PresetRef | null | undefined> {
    const picked = await pickTeamPreset(context, snapshot, {
      title: "Link to team preset",
      none: "None — unlink",
      ...(link?.kind === "team" ? { current: link.id } : {}),
    })
    if (picked === undefined) return undefined
    if (picked === "") return null
    return { kind: "team", id: picked }
  }

  async function run<Result>(
    call: () => Promise<Result>,
    success: string | ((result: Result) => string),
    reveal?: readonly [readonly string[], string],
  ): Promise<void> {
    try {
      const result = await call()
      if (disposed) return
      context.ui.toast.show({ variant: "success", message: typeof success === "string" ? success : success(result) })
      if (reveal !== undefined) state.reveal(reveal[0], reveal[1])
      await state.refresh()
    } catch (error: unknown) {
      if (disposed) return
      context.ui.toast.show({ variant: "error", message: errorMessage(error) })
    }
  }

  function dispose(): void {
    disposed = true
  }

  // The row a group hangs under: the workspace passes its own parent map, so
  // there is no flat-tree fallback to walk.
  function parentOf(node: TreeNode): TreeNode | undefined {
    return options.parentOf?.(node)
  }

  function scopeFromModelsGroup(
    node: TreeNode | undefined,
  ): { level: "project" | "global" | "defaults" | "preset"; agent: string | null; team?: { level: Level; team: string } } | undefined {
    if (node === undefined) return undefined
    const match = node.id.match(/^group:(project|global|defaults|preset):(.*):models$/)
    if (match === null) return undefined
    const level = match[1]
    if (level !== "project" && level !== "global" && level !== "defaults" && level !== "preset") return undefined
    const owner = match[2] ?? ""
    if (owner === "") {
      if (level !== "defaults") return undefined
      return { level, agent: null }
    }
    // Team-member groups carry `/:` between team and member (agent ids forbid
    // `:`, team names allow it), so an owner containing `/:` is a team group
    // and never a nested agent id like `crew/alpha`. Team names never contain
    // `/`, so the member is everything after the first `/` with the leading
    // `:` stripped, even for colon team names and nested member ids.
    const slash = owner.indexOf("/")
    if (slash !== -1 && owner[slash + 1] === ":") {
      const rest = owner.slice(slash + 2)
      const special = rest.startsWith("special:")
      const member = special ? rest.slice("special:".length) : rest
      if (member.length === 0) return undefined
      // Member presets, Teams entries and a team's Special agents keep
      // team-scoped records; a discovered member's are its own (tree.ts
      // lazyTeamMember).
      const parent = special ? undefined : parentOf(node)?.owner
      const scoped = special || parent?.preset !== undefined || parent?.entry !== undefined
      return { level, agent: member, ...(scoped ? { team: { level, team: owner.slice(0, slash) } } : {}) }
    }
    return { level, agent: owner }
  }

  // a on a Models group: provider/model → variant → scope (scope comes from
  // the group when invoked there, otherwise prompt for level then agent).
  // Candidates come from the host model catalog, so only real models can be
  // added. Adding stores an inactive row; activate with space afterwards.
  async function addModel(node?: TreeNode): Promise<void> {
    if (disposed) return
    const scoped = scopeFromModelsGroup(node)
    let level: "project" | "global" | "defaults" | "preset" | undefined = scoped?.level
    let agent: string | null | undefined = scoped?.agent
    const team = scoped?.team
    let catalog: { providerID: string; modelID: string; variant?: string; name: string }[]
    try {
      const output = await plus["catalog.models"](undefined, { location: context.location })
      if (disposed) return
      catalog = [...output.models]
    } catch (error: unknown) {
      if (disposed) return
      context.ui.toast.show({ variant: "error", message: errorMessage(error) })
      return
    }
    if (catalog.length === 0) {
      context.ui.toast.show({ variant: "error", message: "No models in the host catalog" })
      return
    }
    const providers = [...new Set(catalog.map((entry) => entry.providerID))].toSorted()
    const provider = await context.ui.dialog.select<string>({
      title: "Model provider",
      placeholder: "Select a provider",
      options: providers.map((entry) => ({ title: entry, value: entry })),
    })
    if (disposed) return
    if (provider === undefined) return
    const forProvider = catalog.filter((entry) => entry.providerID === provider)
    const modelIds = [...new Set(forProvider.map((entry) => entry.modelID))].toSorted()
    const modelID = await context.ui.dialog.select<string>({
      title: "Model",
      placeholder: "Select a model",
      options: modelIds.map((id) => {
        const name = forProvider.find((entry) => entry.modelID === id)?.name ?? id
        return { title: name === id ? id : `${name} (${id})`, value: id }
      }),
    })
    if (disposed) return
    if (modelID === undefined) return
    const variants = forProvider.filter((entry) => entry.modelID === modelID).flatMap((entry) => (entry.variant === undefined ? [] : [entry.variant]))
    let variant: string | undefined
    if (variants.length > 0) {
      const picked = await context.ui.dialog.select<string>({
        title: "Variant",
        placeholder: "Select a reasoning variant",
        options: [{ title: "(no variant)", value: "" }, ...variants.toSorted().map((entry) => ({ title: entry, value: entry }))],
      })
      if (disposed) return
      if (picked === undefined) return
      variant = picked === "" ? undefined : picked
    }
    if (node !== undefined && state.selectionContains(node)) {
      await state.batchOperation(node, "create", { kind: "model", providerID: provider, modelID, ...(variant === undefined ? {} : { variant }) })
      return
    }
    if (level === undefined) {
      const pickedLevel = await context.ui.dialog.select<"project" | "global" | "defaults">({
        title: "Model scope",
        options: [
          { title: "Project", value: "project", description: "Stored with this project" },
          { title: "Global", value: "global", description: "Stored in your global config" },
          { title: "Defaults", value: "defaults", description: "Shared default for every agent" },
        ],
      })
      if (disposed) return
      if (pickedLevel === undefined) return
      level = pickedLevel
    }
    if (agent === undefined) {
      if (level === "defaults") {
        const shared = await context.ui.dialog.select<string>({
          title: "Model agent",
          placeholder: "Shared or per-agent?",
          options: [
            { title: "Shared (every agent)", value: "" },
            { title: "Per-agent…", value: "__agent__" },
          ],
        })
        if (disposed) return
        if (shared === undefined) return
        if (shared === "") {
          agent = null
        } else {
          const raw = await context.ui.dialog.prompt({ title: "Agent id", placeholder: "my-agent" })
          if (disposed) return
          if (raw === undefined) return
          const trimmed = raw.trim()
          if (trimmed.length === 0) {
            context.ui.toast.show({ variant: "error", message: "Agent id cannot be empty" })
            return
          }
          agent = trimmed
        }
      } else {
        const raw = await context.ui.dialog.prompt({ title: "Agent id", placeholder: "my-agent" })
        if (disposed) return
        if (raw === undefined) return
        const trimmed = raw.trim()
        if (trimmed.length === 0) {
          context.ui.toast.show({ variant: "error", message: "Agent id cannot be empty" })
          return
        }
        agent = trimmed
      }
    }
    if (level === undefined || agent === undefined) return
    try {
      const ref = await plus["model.add"](
        { level, agent, ...(team === undefined ? {} : { team }), providerID: provider, modelID, ...(variant === undefined ? {} : { variant }) },
        { location: context.location },
      )
      if (disposed) return
      context.ui.toast.show({ variant: "success", message: `Added model ${ref.providerID}/${ref.modelID}` })
      await state.refresh()
    } catch (error: unknown) {
      if (disposed) return
      context.ui.toast.show({ variant: "error", message: errorMessage(error) })
    }
  }

  // Level/agent/catalogue come from the tool item row or the perm row itself
  // (their own address); otherwise undefined so the caller prompts. Tool rows
  // address tool:<id>, perm rows address perm:<tool>:<rule>. A shared row
  // inherits its address catalogue so adding from a Teams row writes a Teams
  // rule; an agent-qualified row never gains one (catalogueField semantics),
  // so only the `agent === null` form forwards it.
  function scopeFromToolOrPermRow(node: TreeNode | undefined) {
    if (node === undefined || node.kind !== "item" || node.address === undefined) return undefined
    if (!node.address.item.startsWith("tool:") && !node.address.item.startsWith("perm:") && !node.address.item.startsWith("param:")) return undefined
    const catalogue = node.address.agent === null ? node.address.catalogue : undefined
    return { level: node.address.level, agent: node.address.agent, ...(catalogue === undefined ? {} : { catalogue }), ...(node.address.team === undefined ? {} : { team: node.address.team }) }
  }

  function toolFromToolOrPermRow(node: TreeNode | undefined): string | undefined {
    if (node === undefined || node.address === undefined) return undefined
    const item = node.address.item
    const parameter = state.snapshot()?.items.find((entry) => entry.id === item)?.paramTool
    if (parameter !== undefined) return parameter
    if (item.startsWith("tool:")) {
      const tool = item.slice("tool:".length)
      return tool.length > 0 ? tool : undefined
    }
    if (item.startsWith("perm:")) return parsePermItemId(item)?.tool
    return undefined
  }

  // a on a tool row: label → patterns → keywords (defaulting through
  // keywordsForPattern) → scope. Patterns are core wildcards, not regex.
  // The parent tool and scope come from the tool row when invoked there,
  // otherwise prompt. Scope prompts mirror addModel.
  async function addRule(node?: TreeNode): Promise<void> {
    if (disposed) return
    const scoped = scopeFromToolOrPermRow(node)
    let level: "project" | "global" | "defaults" | "preset" | undefined = scoped?.level
    let agent: string | null | undefined = scoped?.agent
    const catalogue = scoped?.catalogue
    let tool = toolFromToolOrPermRow(node)
    if (tool === undefined) {
      const rawTool = await context.ui.dialog.prompt({ title: "Rule tool", placeholder: "shell" })
      if (disposed) return
      if (rawTool === undefined) return
      const trimmed = rawTool.trim()
      if (trimmed.length === 0) {
        context.ui.toast.show({ variant: "error", message: "Rule tool cannot be empty" })
        return
      }
      tool = trimmed
    }
    const rawLabel = await context.ui.dialog.prompt({ title: "Rule label", placeholder: "No force pushes" })
    if (disposed) return
    if (rawLabel === undefined) return
    const label = rawLabel.trim()
    if (label.length === 0) {
      context.ui.toast.show({ variant: "error", message: "Rule label cannot be empty" })
      return
    }
    const rawPatterns = await context.ui.dialog.prompt({ title: "Rule patterns", placeholder: "git push --force *, separated by commas" })
    if (disposed) return
    if (rawPatterns === undefined) return
    const patterns = rawPatterns
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
    if (patterns.length === 0) {
      context.ui.toast.show({ variant: "error", message: "Rule patterns cannot be empty" })
      return
    }
    const rawKeywords = await context.ui.dialog.prompt({ title: "Rule keywords", placeholder: "blank for defaults" })
    if (disposed) return
    if (rawKeywords === undefined) return
    const keywords = rawKeywords.trim().length === 0 ? undefined : rawKeywords.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0)
    const rawMessage = await context.ui.dialog.prompt({
      title: "Message shown on refusal (optional)",
      placeholder: "force pushes are not allowed here",
    })
    if (disposed) return
    if (rawMessage === undefined) return
    const message = rawMessage.trim()
    if (node !== undefined && state.selectionContains(node)) {
      await state.batchOperation(node, "create", { kind: "rule", id: slugify(label), label, patterns, ...(keywords === undefined ? {} : { keywords }), ...(message.length === 0 ? {} : { message }) })
      return
    }
    if (level === undefined) {
      const pickedLevel = await context.ui.dialog.select<"project" | "global" | "defaults">({
        title: "Rule scope",
        options: [
          { title: "Project", value: "project", description: "Stored with this project" },
          { title: "Global", value: "global", description: "Stored in your global config" },
          { title: "Defaults", value: "defaults", description: "Shared default for every agent" },
        ],
      })
      if (disposed) return
      if (pickedLevel === undefined) return
      level = pickedLevel
    }
    if (level === "defaults" && agent === undefined) {
      const shared = await context.ui.dialog.select<string>({
        title: "Rule agent",
        placeholder: "Shared or per-agent?",
        options: [
          { title: "Shared (every agent)", value: "" },
          { title: "Per-agent…", value: "__agent__" },
        ],
      })
      if (disposed) return
      if (shared === undefined) return
      if (shared === "") {
        agent = null
      }
      if (shared !== "") {
        const raw = await context.ui.dialog.prompt({ title: "Agent id", placeholder: "my-agent" })
        if (disposed) return
        if (raw === undefined) return
        const trimmed = raw.trim()
        if (trimmed.length === 0) {
          context.ui.toast.show({ variant: "error", message: "Agent id cannot be empty" })
          return
        }
        agent = trimmed
      }
    }
    if (agent === undefined) {
      const raw = await context.ui.dialog.prompt({ title: "Agent id", placeholder: "my-agent" })
      if (disposed) return
      if (raw === undefined) return
      const trimmed = raw.trim()
      if (trimmed.length === 0) {
        context.ui.toast.show({ variant: "error", message: "Agent id cannot be empty" })
        return
      }
      agent = trimmed
    }
    if (level === undefined || agent === undefined) return
    try {
      const ref = await plus["rule.add"](
        { level, agent, ...(catalogue === undefined ? {} : { catalogue }), ...(scoped?.team === undefined ? {} : { team: scoped.team }), tool, id: slugify(label), label, patterns, ...(keywords === undefined ? {} : { keywords }), ...(message.length === 0 ? {} : { message }) },
        { location: context.location },
      )
      if (disposed) return
      context.ui.toast.show({ variant: "success", message: `Added rule ${ref.tool}:${ref.id}` })
      await state.refresh()
    } catch (error: unknown) {
      if (disposed) return
      context.ui.toast.show({ variant: "error", message: errorMessage(error) })
    }
  }

  // enter on a perm row: label → patterns → keywords, each prefilled with the
  // row's current values. Tool and rule id reuse the snapshot item's permTool
  // and ruleId; level/agent come from the row's own address, so no tool or
  // scope prompts. Blank keywords request defaults explicitly; omission on an
  // update preserves the inherited definition's keywords.
  async function editRule(node: TreeNode): Promise<void> {
    if (disposed) return
    const address = node.address
    if (address === undefined) {
      context.ui.toast.show({ variant: "error", message: "This row cannot be edited" })
      return
    }
    const parsed = parsePermItemId(address.item)
    if (parsed === undefined) {
      context.ui.toast.show({ variant: "error", message: "This row cannot be edited" })
      return
    }
    // The row's own catalogue rides along for the upsert path: editing a
    // curated or mined Teams row materialises its override in the Teams
    // catalogue. A matched record keeps its stored identity server-side, and
    // an agent-qualified row never gains a catalogue.
    const catalogue = address.agent === null ? address.catalogue : undefined
    const current = state.effectiveItem(node)
    const tool = current?.permTool ?? parsed.tool
    const ruleId = current?.ruleId ?? parsed.ruleId
    const rawLabel = await context.ui.dialog.prompt({
      title: "Rule label",
      placeholder: "No force pushes",
      value: current?.title ?? node.label,
    })
    if (disposed) return
    if (rawLabel === undefined) return
    const label = rawLabel.trim()
    if (label.length === 0) {
      context.ui.toast.show({ variant: "error", message: "Rule label cannot be empty" })
      return
    }
    const rawPatterns = await context.ui.dialog.prompt({
      title: "Rule patterns",
      placeholder: "git push --force *, separated by commas",
      value: (current?.patterns ?? []).join(", "),
    })
    if (disposed) return
    if (rawPatterns === undefined) return
    const patterns = rawPatterns
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
    if (patterns.length === 0) {
      context.ui.toast.show({ variant: "error", message: "Rule patterns cannot be empty" })
      return
    }
    const rawKeywords = await context.ui.dialog.prompt({
      title: "Rule keywords",
      placeholder: "blank for defaults",
      value: (current?.keywords ?? []).join(", "),
    })
    if (disposed) return
    if (rawKeywords === undefined) return
    const keywords =
      rawKeywords.trim().length === 0
        ? [...new Set(patterns.flatMap(keywordsForPattern))]
        : rawKeywords
            .split(",")
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0)
    const rawMessage = await context.ui.dialog.prompt({
      title: "Message shown on refusal (optional)",
      placeholder: "force pushes are not allowed here",
      value: current?.message ?? "",
    })
    if (disposed) return
    if (rawMessage === undefined) return
    const message = rawMessage.trim()
    if (state.selectionContains(node)) {
      await state.batchOperation(node, "set", { label, patterns, keywords, message })
      return
    }
    try {
      const ref = await plus["rule.update"](
        { level: address.level, agent: address.agent, ...(catalogue === undefined ? {} : { catalogue }), ...(address.team === undefined ? {} : { team: address.team }), tool, id: ruleId, label, patterns, keywords, message },
        { location: context.location },
      )
      if (disposed) return
      context.ui.toast.show({ variant: "success", message: `Updated rule ${ref.tool}:${ref.id}` })
      await state.refresh()
    } catch (error: unknown) {
      if (disposed) return
      context.ui.toast.show({ variant: "error", message: errorMessage(error) })
    }
  }

  function slugify(name: string): string {
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
    return slug.length > 0 ? slug : "rule"
  }

  // `w`: when a system row or section is sent. A checklist that reopens after
  // each pick: a row cycles "must be on" → "must be off" → gone; Add picks a
  // tool, skill, MCP server or rule; Save writes this level's condition.
  async function when(node: TreeNode | undefined): Promise<void> {
    if (disposed || node === undefined) return
    if (node.actions?.requires !== true) {
      state.setStatus(`"${node.label}" cannot be sent conditionally: only system rows and their sections can`)
      return
    }
    const SAVE = "\u0000save"
    const MODELS = "\u0000models"
    const ADD = "\u0000add"
    const ALWAYS = "\u0000always"
    const FOLLOW = "\u0000follow"
    const CANCEL = "\u0000cancel"
    const choices = state.conditionChoices()
    const labelOf = (id: string) => choices.find((choice) => choice.id === id)?.label ?? id
    let ids = (node.badges.requires ?? []).map((requirement) => (requirement.on ? requirement.id : `!${requirement.id}`))
    const own = node.badges.requiresHere === true
    let cursor: string | undefined
    for (;;) {
      const describe = ids.length === 0 ? "always" : ids.map((id) => `${id.replace(/^!/, "")} ${id.startsWith("!") ? "off" : "on"}`).join(" and ")
      const picked = await context.ui.dialog.select<string>({
        title: `Shown when — ${node.label}`,
        placeholder: node.badges.requiresFrom === undefined ? "Sent always now" : `Now from ${node.badges.requiresFrom}`,
        ...(cursor === undefined ? {} : { current: cursor }),
        options: [
          // A model prompt is first of all sent for its models.
          ...(node.address !== undefined && isModelPrompt(node.address.item)
            ? [{ title: `For models: ${(node.badges.models ?? []).join(", ") || "none"}`, value: MODELS, description: "pick to change which models receive it", category: "Sent for these models" }]
            : []),
          ...ids.map((id) => ({
            title: `${labelOf(id.replace(/^!/, ""))} must be ${id.startsWith("!") ? "off" : "on"}`,
            value: `row:${id}`,
            description: `${id.replace(/^!/, "")} · pick to switch on/off, then to remove`,
            category: "Shown when every row is as listed",
          })),
          { title: "Add a tool, skill, server or rule…", value: ADD, category: "Shown when every row is as listed" },
          { title: `Save: ${describe}`, value: SAVE, category: "Done" },
          { title: "Always send it (no condition at this level)", value: ALWAYS, category: "Done" },
          ...(own ? [{ title: "Drop this level's condition (the level above or its text decides)", value: FOLLOW, category: "Done" }] : []),
          { title: "Cancel", value: CANCEL, category: "Done" },
        ],
      })
      if (disposed || picked === undefined || picked === CANCEL) return
      if (picked === MODELS) return void (await editModels(node))
      if (picked === SAVE) return void (await state.setRequires(node, ids))
      if (picked === ALWAYS) return void (await state.setRequires(node, []))
      if (picked === FOLLOW) return void (await state.setRequires(node, null))
      if (picked === ADD) {
        const added = await context.ui.dialog.select<string>({
          title: "Shown while this row is on",
          placeholder: "Search tools, skills, MCP servers and rules",
          options: choices
            .filter((choice) => !ids.some((id) => id.replace(/^!/, "") === choice.id))
            .map((choice) => ({
              title: choice.label,
              value: choice.id,
              description: choice.id,
              category: choice.group === "Rules" ? `Rules · ${choice.tool ?? ""}` : choice.group,
            })),
        })
        if (disposed) return
        if (added !== undefined) {
          ids = [...ids, added]
          cursor = `row:${added}`
        }
        continue
      }
      // must be on → must be off → removed
      const id = picked.slice("row:".length)
      const off = id.startsWith("!")
      ids = off ? ids.filter((entry) => entry !== id) : ids.map((entry) => (entry === id ? `!${id}` : entry))
      cursor = off ? undefined : `row:!${id}`
    }
  }

  // a on a tab or folder row: a folder listed last there, holding rows of that
  // tab. Empty names are refused here; the planner refuses an empty name too.
  async function addFolder(node: TreeNode | undefined): Promise<void> {
    if (disposed) return
    if (node === undefined) {
      context.ui.toast.show({ variant: "error", message: "Select a tab or a folder to add a folder in" })
      return
    }
    const raw = await context.ui.dialog.prompt({
      title: "Folder name",
      description: "A folder groups rows inside this tab; move rows into it with m.",
      placeholder: "Mine",
    })
    if (disposed || raw === undefined) return
    const name = raw.trim()
    if (name.length === 0) {
      context.ui.toast.show({ variant: "error", message: "Folder name cannot be empty" })
      return
    }
    await state.createFolder(node, name)
  }

  // R on a folder: rename it (its rows and its place stay).
  async function renameFolder(node: TreeNode | undefined): Promise<void> {
    if (disposed || node === undefined) return
    const raw = await context.ui.dialog.prompt({
      title: "Rename folder",
      description: "The folder's rows and its place stay.",
      value: node.label,
    })
    if (disposed || raw === undefined) return
    const name = raw.trim()
    if (name.length === 0) {
      context.ui.toast.show({ variant: "error", message: "Folder name cannot be empty" })
      return
    }
    if (name === node.label) return
    await state.renameFolder(node, name)
  }

  // R on an agent, member or team row: rename it (prefilled, validated like
  // creation). Everything that names it follows in one store revision; the
  // caller puts the tree selection on the renamed row.
  async function renameRow(node: TreeNode | undefined): Promise<{ readonly row: string; readonly expand: readonly string[] } | undefined> {
    if (disposed || node === undefined) return undefined
    const candidate = renameCandidateOf(node, state.snapshot())
    if (candidate === undefined) {
      context.ui.toast.show({ variant: "error", message: `"${node.label}" is not a renamable row` })
      return undefined
    }
    if (candidate.target === undefined) {
      context.ui.toast.show({ variant: "error", message: candidate.refusal ?? `"${node.label}" cannot be renamed` })
      return undefined
    }
    const target = candidate.target
    const raw = await context.ui.dialog.prompt({
      title: `Rename ${node.label}`,
      description: target.kind === "team" ? "New team name; members and records follow." : "New id; use / for nesting. .. is not allowed.",
      value: node.label,
    })
    if (disposed || raw === undefined) return undefined
    const validated = validateRenameName(target, raw)
    if (!validated.ok) {
      context.ui.toast.show({ variant: "error", message: validated.reason })
      return undefined
    }
    if (validated.name === target.from) return undefined
    if (state.selectionContains(node)) {
      await state.batchOperation(node, "set", { rename: validated.name })
      return undefined
    }
    const row = await state.renameRow(
      target.kind === "member"
        ? { kind: "member", level: target.level, team: target.team, from: target.from, to: validated.name }
        : target.kind === "team"
          ? { kind: "team", level: target.level, from: target.from, to: validated.name }
          : { kind: "agent", level: target.level, from: target.from, to: validated.name },
    )
    if (disposed || row === undefined) return undefined
    const expand =
      target.kind === "agent"
        ? [`root:${target.level}`, `group:${target.level}:agents`, `group:${target.level}:agents:user`]
        : target.kind === "member"
          ? [`root:${target.level}`, `group:${target.level}:teams`, `team:${target.level}:${target.team}`]
          : [`root:${target.level}`, `group:${target.level}:teams`]
    return { row, expand }
  }

  // d on a folder: delete it after confirmation; its rows return to its place.
  async function deleteFolder(node: TreeNode | undefined): Promise<void> {
    if (disposed || node === undefined) return
    const confirmed = await context.ui.dialog.confirm({
      title: `Delete folder "${node.label}"?`,
      message: `Delete folder "${node.label}"? Its rows return to the place it held in its tab. This cannot be undone.`,
    })
    if (disposed || confirmed !== true) {
      if (!disposed) state.setStatus(`Delete of folder "${node.label}" cancelled`)
      return
    }
    await state.deleteFolder(node)
  }

  async function editRowlink(node: TreeNode, primary: Pick<TreeNode, "address" | "label">, target: RowlinkEndpoint, current: RowlinkType = "either", enabled = true) {
    const type = await context.ui.dialog.select<Exclude<RowlinkType, "shownAlways">>({
      title: `Link · ${primary.label} → ${target.item}${target.section === null ? "" : ` / ${target.section}`}`,
      placeholder: `Type (now ${current})`,
      current: current === "shownAlways" ? undefined : current,
      options: [
        { title: "either · turning either on turns the other off", value: "either" },
        { title: "shownWhenOn · linked row sent while primary is on", value: "shownWhenOn" },
        { title: "shownWhenOff · linked row sent while primary is off", value: "shownWhenOff" },
      ],
    })
    if (disposed) return
    if (type === undefined) {
      state.setStatus("Row link cancelled")
      return
    }
    await state.saveSelectedRowlink(node, primary, target, type, enabled)
  }

  async function rowlink(node: TreeNode | undefined) {
    if (disposed || node?.address === undefined) return
    const primary = state.linkPrimary()
    if (primary !== undefined) {
      if (!state.rowlinkTarget(node)) return
      state.cancelRowlink()
      await editRowlink(primary, primary, node.address)
      return
    }
    if (state.linksFor(node).length === 0) { state.beginRowlink(node); return }
    let selected = 0
    while (!disposed) {
      const links = state.linksFor(node)
      let action: { kind: "toggle" | "delete"; index: number } | undefined
      const picked = await context.ui.dialog.select<number>({
        title: `Row links · ${node.label}`,
        placeholder: "Primary → linked row (incoming / outgoing)",
        current: links.length === 0 ? -1 : Math.min(selected, links.length - 1),
        options: [
          ...links.map((link, value) => ({ title: `${link.enabled ? "enabled" : "disabled"} · ${link.direction}: ${link.item}${link.section === null ? "" : ` / ${link.section}`} → ${link.target}${link.targetSection === null ? "" : ` / ${link.targetSection}`} · ${link.type} (${link.level})`, value })),
          { title: "Link another row", value: -1 },
        ],
        actions: [
          { bind: "space", title: "Enable / disable", onTrigger: (index) => {
            if (index < 0) return
            action = { kind: "toggle", index }
            context.ui.dialog.clear()
          } },
          { bind: "d", title: "Delete local link", onTrigger: (index) => {
            if (index < 0) return
            action = { kind: "delete", index }
            context.ui.dialog.clear()
          } },
        ],
      })
      if (disposed || (picked === undefined && action === undefined)) return
      if (picked === -1) { state.beginRowlink(node); return }
      selected = action?.index ?? picked!
      const link = links[selected]
      if (link === undefined) return
      // The link already identifies its primary. Do not resolve every row in
      // every owner just to reopen this editor, including for incoming links.
      const owner = {
        address: { ...node.address, item: link.item, section: link.section },
        label: sameEndpoint(node.address, link.item, link.section) ? node.label : link.item,
      }
      const target = { item: link.target, section: link.targetSection }
      if (action?.kind === "toggle") {
        void state.saveSelectedRowlink(node, owner, target, link.type, !link.enabled)
        continue
      }
      if (action?.kind === "delete") {
        void state.deleteSelectedRowlink(node, owner, target)
        continue
      }
      await editRowlink(node, owner, target, link.type, link.enabled)
      return
    }
  }

  return { rowlink, addFor, addAgent, addTeamAgent, addBase, addSkill, addInstruction, addMcp, addTeam, addModel, addColdModel, editModelField, editModelSetting, addRule, editRule, relink, when, renameFolder, renameRow, deleteFolder, dispose }
}

export type InstructionsDialogs = ReturnType<typeof createInstructionsDialogs>

const wildcards = "* and % match any text, case-insensitive"

/**
 * Whether `l` can relink this row: an agent, member or team at Project or
 * Global, a Defaults entry, or a User preset. A Teams entry pattern row takes
 * no link (its member entries do), Native and Plus presets are read-only.
 */
export function isLinkable(owner: RowOwner | undefined): owner is RowOwner {
  if (owner === undefined) return false
  if (owner.level === "defaults" && owner.agent === null) return false
  if (owner.preset !== undefined && owner.preset.origin !== "user") return false
  return true
}

// The Project or Global root a row sits under, read from its id's level segment.
function levelOfRow(node: TreeNode | undefined): "project" | "global" | undefined {
  const level = node?.id.match(/^[a-z]+:(project|global)(?::|$)/)?.[1]
  return level === "project" || level === "global" ? level : undefined
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error !== "object" || error === null) return String(error)
  if (!("message" in error)) return String(error)
  if (typeof error.message !== "string") return String(error)
  return error.message
}

// What one Defaults › Models field means, for its prompt.
function fieldHelp(field: ModelDefaultField, variants: readonly string[]): string {
  if (field === "warming")
    return "off, on, or the total time to keep the cache warm after the last reply (1m to 24h). A time rounds up to whole pings: 30m with a 4m ping is 32m."
  if (field === "interval")
    return "Time between keep-alive requests while the cache is warm (30s to 24h, e.g. 4m or 3m30s). Keep it under the provider's cache lifetime: 5m for a default Anthropic cache, 30m for GPT."
  if (field === "prompt") return "The text of the keep-alive request."
  if (field === "compactionInstructions") return "The summary request's instructions; an empty prompt is a value of its own."
  if (field === "compactionInput") return "Early compaction at this estimated input token count. Positive whole number or off; off overrides inherited triggers. Context safety still applies."
  if (field === "compactionOutput") return "Early compaction after this many assistant output + reasoning tokens since the last compaction. Positive whole number or off; off overrides inherited triggers."
  if (field === "compactionStrategy") return "auto follows the model's policy; local writes a text summary; remote uses the provider."
  return `The variant a model row without one runs with${variants.length === 0 ? "" : ` (${variants.join(", ")})`}.`
}

function isImageField(field: string): field is ImageField {
  return IMAGE_FIELDS.some((entry) => entry === field)
}
