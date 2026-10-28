import { controlItemFor, isControl } from "./agent-controls.js"
import { folderIdOfRef, folderRef, tabOfGroupId } from "./folders.js"
import { rowlinkView, sameOwnerView, writeRowlink, type RowlinkEndpoint, type RowlinkRecord } from "./rowlinks.js"
import { applies, merge, parseModelItemId, parsePermItemId, resolveModelFields, sameModelCandidate, scopedTo, type ModelRecord, type RuleRecord } from "./model.js"
import { ruleAt, ruleItem } from "./rules.js"
import { resolveModelCompactionFields } from "./model-settings.js"
import { isValueRow } from "./permission-catalog.js"
import { activateModelRow, addSection, planFolderCreate, planFolderDelete, planRowMove, removeModelRow, reset, rowToken, saveSplit, saveText, setEnabled, setPin, setRequires, type LayoutRecords, type OpResult } from "./ops.js"
import { correspondingRow } from "./reflection.js"
import { rowTeamOf, sectionResolveOf, splitOf, wholeOf } from "./resolve-memo.js"
import { buildTreeMemo, collectSkeleton, findLazy, lazyPath, materialize, tabLayout, type Lazy, type Memo, type MemoInput } from "./tree.js"

export interface Clipboard {
  readonly source: MemoInput
  readonly rows: readonly string[]
  readonly mode: "copy" | "cut"
}

export function captureRows(source: MemoInput, rows: readonly string[], mode: Clipboard["mode"]): Clipboard | { readonly refusal: string } {
  const memo = buildTreeMemo(source)
  const paths = [...new Set(rows)].map((id) => lazyPath(memo, id))
  if (paths.some((path) => path.length === 0)) return { refusal: "A selected row no longer exists" }
  const roots = paths.filter((path) => !path.slice(0, -1).some((node) => rows.includes(node.id))).map((path) => path.at(-1)!)
  if (roots.length === 0) return { refusal: "Select rows to copy or cut" }
  const fixed = roots.find((row) => row.address === undefined && folderIdOfRef(rowToken(materialize(row)) ?? "") === undefined && row.owner === undefined)
  if (fixed !== undefined) return { refusal: `"${fixed.label}" is a fixed navigation section; select its contents instead` }
  // Pasting a cut owner would refuse anyway (it cannot move): say so now.
  const owner = mode === "cut" ? roots.find((row) => (row.kind === "agent" || row.kind === "team") && row.owner !== undefined && row.address === undefined) : undefined
  if (owner !== undefined) return { refusal: `"${owner.label}" cannot be cut: copy it (ctrl+c) to give another one its configuration, or cut its rows` }
  return { source: structuredClone(source), rows: roots.map((row) => row.id), mode }
}

/** A paste is fully planned before the caller commits configuration and layout together. */
export function pasteRows(current: MemoInput, clipboard: Clipboard, destination: string): { readonly memo: MemoInput; readonly layout: LayoutRecords; readonly rows: readonly string[] } | { readonly refusal: string } {
  // Copy freezes values; cut relocates the current source at paste time. The
  // caller's revision guard prevents a concurrent edit from being overwritten.
  const source = buildTreeMemo(clipboard.mode === "cut" ? current : clipboard.source)
  const draft = { memo: current, layout: { folders: current.folders ?? [], orders: current.orders ?? [] }, rows: [] as string[] }
  const activatedOwners = new Set<string>()
  // Ops and row lookups share one memo per draft state: rebuilding it for
  // every pasted row made an agent's paste take most of a minute.
  const memos = new WeakMap<MemoInput, Memo>()
  const built = (): Memo => {
    const cached = memos.get(draft.memo)
    if (cached !== undefined) return cached
    const memo = buildTreeMemo(draft.memo)
    memos.set(draft.memo, memo)
    return memo
  }
  const apply = (result: OpResult): string | undefined => {
    if ("refusal" in result) return result.refusal
    // An op that wrote nothing keeps the draft (and its built memo) as it is.
    const kept = new Set(draft.memo.records)
    const count = (type: string) => draft.memo.records.filter((record) => record.type === type).length
    if (result.models === undefined && result.rowlinks === undefined && result.records.length === count("customization") && result.splits.length === count("split")
      && [...result.records, ...result.splits].every((record) => kept.has(record))) return undefined
    draft.memo = { ...draft.memo, records: [
      ...draft.memo.records.filter((record) => record.type !== "customization" && record.type !== "split" && (result.models === undefined || record.type !== "model") && (result.rowlinks === undefined || record.type !== "rowlink")),
      ...result.records, ...result.splits, ...(result.models ?? []), ...(result.rowlinks ?? []),
    ] }
    return undefined
  }
  const layout = (next: LayoutRecords) => {
    draft.layout = next
    draft.memo = { ...draft.memo, ...next }
  }
  const maskLinks = (memo: Memo, root: Lazy) => {
    const links = { rows: draft.memo.records.filter((record): record is RowlinkRecord => record.type === "rowlink"), changed: false }
    for (const row of collectSkeleton([root])) {
      if (row.address === undefined) continue
      for (const link of rowlinkView(memo.ctx.scopes.rowlinks ?? [], memo.ctx.scopes, row.address, row.address)) {
        links.rows = writeRowlink(links.rows, row.address, { item: link.item, section: link.section }, { item: link.target, section: link.targetSection }, link.type, false, new Date().toISOString())
        links.changed = true
      }
    }
    if (links.changed) draft.memo = { ...draft.memo, records: [...draft.memo.records.filter((record) => record.type !== "rowlink"), ...links.rows] }
  }
  const copyLinks = (origin: Lazy, destination: Lazy): string | undefined => {
    if (destination.address === undefined) return "The link destination has no owner"
    const memo = built()
    const rows = collectSkeleton([origin])
    const endpoint = (value: RowlinkEndpoint): RowlinkEndpoint | undefined => {
      const row = rows.find((row) => row.address?.item === value.item && row.address.section === value.section)
      if (row === undefined) return value
      const next = correspondingRow(source, origin, row, memo, destination)?.address
      return next === undefined ? undefined : { item: next.item, section: next.section }
    }
    const links = { rows: draft.memo.records.filter((record): record is RowlinkRecord => record.type === "rowlink"), changed: false }
    const seen = new Set<string>()
    for (const row of rows) {
      if (row.address === undefined) continue
      for (const link of rowlinkView(source.ctx.scopes.rowlinks ?? [], source.ctx.scopes, row.address, row.address)) {
        const key = JSON.stringify([link.item, link.section, link.target, link.targetSection])
        if (seen.has(key)) continue
        seen.add(key)
        const from = endpoint({ item: link.item, section: link.section })
        const to = endpoint({ item: link.target, section: link.targetSection })
        if (from === undefined || to === undefined) return "The destination lacks a linked setting"
        links.rows = writeRowlink(links.rows, destination.address, from, to, link.type, link.enabled, new Date().toISOString())
        links.changed = true
      }
    }
    if (links.changed) draft.memo = { ...draft.memo, records: [...draft.memo.records.filter((record) => record.type !== "rowlink"), ...links.rows] }
    return undefined
  }
  const transfer = (id: string, into: string): string | undefined => {
    const origin = findLazy(source, id)
    const memo = built()
    const path = lazyPath(memo, into)
    const target = path.at(-1)
    if (origin === undefined || target === undefined) return "A source or destination row no longer exists"
    if (clipboard.mode === "cut" && origin.address !== undefined && target.address !== undefined && sameOwnerView(origin.address, target.address) && origin.address.item === target.address.item && origin.address.section === target.address.section) return "Source and destination are the same row"
    if (clipboard.mode === "cut" && lazyPath(source, into).some((row) => row.id === id)) return "A row cannot be cut into itself or its descendants"
    const folder = folderIdOfRef(rowToken(materialize(origin)) ?? "")
    if (folder !== undefined) {
      const created = planFolderCreate(draft.memo, draft.layout, into, origin.label, new Date().toISOString())
      if ("refusal" in created) return created.refusal
      layout(created.layout)
      const added = created.layout.folders.find((entry) => folderRef(entry.id) === created.target)!
      const destination = `${added.owner}:folder:${added.id}`
      for (const child of origin.children()) {
        const refusal = transfer(child.id, destination)
        if (refusal !== undefined) return refusal
      }
      if (clipboard.mode === "cut") {
        const owner = origin.id.split(":folder:")[0]!
        const deleted = planFolderDelete(draft.layout, folder, new Date().toISOString(), owner, tabLayout(buildTreeMemo({ ...draft.memo, ...draft.layout }), owner).inherited)
        if ("refusal" in deleted) return deleted.refusal
        layout(deleted.layout)
      }
      draft.rows.push(destination)
      return undefined
    }
    if (origin.owner !== undefined && origin.address === undefined) {
      if (target.owner === undefined) return "Paste an owner onto another owner to transfer its configuration"
      if (clipboard.mode === "cut") return "Choose the owner's individual rows to relocate them"
      if (origin.id === target.id) return `You already have this owner: ${origin.label}`
      for (const child of origin.children()) {
        const refusal = transfer(child.id, into)
        if (refusal !== undefined) return refusal
      }
      return undefined
    }
    if (origin.kind === "section" && origin.address?.section === null) {
      const address = origin.address
      const item = source.ctx.items.find((item) => item.id === address.item && (address.agent === null || applies(item, address.agent)))
      if (item === undefined || target.address === undefined || !target.actions.edit) return "Paste Description text onto an editable text row"
      const resolved = wholeOf(source, address.level, address.agent, item, address.catalogue, rowTeamOf(address))
      const refusal = apply(saveText(draft.memo, target.id, resolved.fullText ?? resolved.text))
      if (refusal !== undefined) return refusal
      if (clipboard.mode === "cut") {
        const removed = apply(saveText(draft.memo, origin.id, ""))
        if (removed !== undefined) return removed
      }
      draft.rows.push(target.id)
      return undefined
    }
    if (origin.address?.section !== null && origin.address?.section !== undefined) {
      const item = source.ctx.items.find((item) => item.id === origin.address!.item && (origin.address!.agent === null || applies(item, origin.address!.agent)))
      if (item === undefined) return "The source section is unavailable"
      const resolved = sectionResolveOf(source, origin.address.level, origin.address.agent, item, origin.address.section, origin.address.catalogue, rowTeamOf(origin.address))
      const sourceSplit = splitOf(source, origin.address.level, origin.address.agent, item, origin.address.catalogue, rowTeamOf(origin.address))
      const existing = new Set(collectSkeleton([target]).map((row) => row.id))
      const refusal = apply(addSection(draft.memo, into, origin.label, resolved.fullText ?? resolved.text, undefined, sourceSplit.kind === "heading"))
      if (refusal !== undefined) return refusal
      const insertedMemo = built()
      const inserted = collectSkeleton([findLazy(insertedMemo, into)!]).find((row) => row.kind === "section" && row.address?.section !== null && !existing.has(row.id) && row.label === origin.label)
      if (inserted === undefined) return "The pasted section could not be identified"
      for (const row of collectSkeleton([origin])) {
        if (row.address?.section === null || row.address === undefined) continue
        const next = correspondingRow(source, origin, row, insertedMemo, inserted)
        if (next === undefined) return `The destination lacks section ${row.label}`
        const value = sectionResolveOf(source, row.address.level, row.address.agent, item, row.address.section, row.address.catalogue, rowTeamOf(row.address))
        if (next.actions.toggle) {
          const refusal = apply(setEnabled(draft.memo, next.id, value.enabled))
          if (refusal !== undefined) return refusal
        }
        if (next.actions.requires) {
          const refusal = apply(setRequires(draft.memo, next.id, value.requires?.ids ?? []))
          if (refusal !== undefined) return refusal
        }
      }
      if (clipboard.mode === "cut") {
        maskLinks(source, origin)
        const current = built()
        const root = lazyPath(current, id).find((row) => row.address?.item === origin.address!.item && row.address.section === null)
        if (root === undefined) return "The section's source document is unavailable"
        const whole = wholeOf(current, origin.address.level, origin.address.agent, item, origin.address.catalogue, rowTeamOf(origin.address))
        const split = splitOf(current, origin.address.level, origin.address.agent, item, origin.address.catalogue, rowTeamOf(origin.address))
        const section = split.sections.find((section) => section.id === origin.address!.section)
        const span = whole.spans?.get(origin.address.section) ?? section
        if (span === undefined) return "The source section changed; cut it again"
        const text = whole.fullText ?? whole.text
        const removed = apply(saveText(draft.memo, root.id, text.slice(0, span.start) + text.slice(span.end)))
        if (removed !== undefined) return removed
        draft.memo = { ...draft.memo, records: draft.memo.records.filter((record) => record.type !== "customization" || !scopedTo(record, origin.address!) || record.item !== origin.address!.item || record.section === null || record.section !== origin.address!.section && !record.section.startsWith(`${origin.address!.section}/`)) }
        if (split.kind === "manual") {
          const refusal = apply(saveSplit(draft.memo, root.id, split.sections.filter((entry) => entry.start < span.start || entry.start >= span.end).map((entry) => ({
            id: entry.id, name: entry.name, depth: entry.depth,
            start: entry.start >= span.end ? entry.start - (span.end - span.start) : entry.start,
          }))))
          if (refusal !== undefined) return refusal
        }
      }
      const linked = copyLinks(origin, inserted)
      if (linked !== undefined) return linked
      draft.rows.push(inserted.id)
      return undefined
    }
    const sourceTab = lazyPath(source, id).findLast((row) => categoryOf(row.id) !== undefined)
    const destinationTab = path.findLast((row) => categoryOf(row.id) !== undefined && categoryOf(row.id) === (sourceTab === undefined ? undefined : categoryOf(sourceTab.id)))
      ?? collectSkeleton([target]).find((row) => categoryOf(row.id) === (sourceTab === undefined ? undefined : categoryOf(sourceTab.id)))
    if (origin.address === undefined) {
      if (destinationTab === undefined) return `The destination does not have ${sourceTab?.label ?? origin.label}`
      for (const child of origin.children()) {
        const refusal = transfer(child.id, destinationTab.id)
        if (refusal !== undefined) return refusal
      }
      return undefined
    }
    if (destinationTab === undefined || sourceTab === undefined || categoryOf(sourceTab.id) !== categoryOf(destinationTab.id)) return `"${origin.label}" belongs in ${sourceTab?.label ?? "its own section"}`
    const destinationOwner = target.address ?? path.findLast((row) => row.owner !== undefined)?.owner
    if (destinationOwner !== undefined && !sameOwnerView(origin.address, { ...destinationOwner, item: origin.address.item, section: null })) {
      const rules = collectSkeleton([origin]).flatMap((row): RuleRecord[] => {
        if (row.address === undefined) return []
        const record = ruleAt(source.ctx.rules, source.ctx.scopes, row.address)
        if (record === undefined) return []
        return [{ ...record, level: destinationOwner.level, agent: destinationOwner.agent,
          team: destinationOwner.team, catalogue: destinationOwner.agent === null ? destinationOwner.catalogue : undefined,
          updated: new Date().toISOString(),
        }]
      })
      draft.memo = { ...draft.memo, records: [
        ...draft.memo.records.filter((record) => record.type !== "rule" || !rules.some((next) => next.tool === record.tool && next.id === record.id && scopedTo(record, next))),
        ...rules.filter((record, index) => rules.findIndex((other) => other.tool === record.tool && other.id === record.id) === index),
      ] }
    }
    const model = parseModelItemId(origin.address.item)
    if (model !== undefined) {
      const owner = path.findLast((row) => row.owner !== undefined)?.owner ?? target.address
      if (owner === undefined) return "Choose an agent or member's Models category"
      const address = { level: owner.level, agent: owner.agent, ...(owner.team === undefined ? {} : { team: owner.team }), ...(owner.catalogue === undefined ? {} : { catalogue: owner.catalogue }) }
      if (sameOwnerView(origin.address, { ...address, item: origin.address.item, section: null }) && clipboard.mode === "copy") return `You already have this model: ${origin.label}`
      if (sameOwnerView(origin.address, { ...address, item: origin.address.item, section: null }) && clipboard.mode === "cut") {
        const moved = planRowMove(draft.memo, draft.layout, origin.id, { into: target.id }, new Date().toISOString())
        if ("refusal" in moved) return moved.refusal
        layout(moved.layout)
        draft.rows.push(origin.id)
        return undefined
      }
      const chain = { ...origin.address, models: source.ctx.models, scopes: source.ctx.scopes }
      const fields = resolveModelFields(chain, model)
      const compact = resolveModelCompactionFields(chain, model)
      const record: ModelRecord = { type: "model", ...address, ...model,
        ...Object.fromEntries(Object.entries({ ...fields, ...compact }).map(([field, resolved]) => [field, resolved?.value])),
        updated: new Date().toISOString(),
      }
      draft.memo = { ...draft.memo, records: [...draft.memo.records.filter((row) => row.type !== "model" || !scopedTo(row, address) || !sameModelCandidate(row, model)), record] }
      const next = collectSkeleton([findLazy(built(), destinationTab.id)!]).find((row) => row.address?.item === origin.address!.item)
      if (next === undefined) return "The destination model could not be resolved"
      if (draft.rows.includes(next.id)) return `Several clipboard rows target the same model: ${origin.label}`
      if (origin.partial().active) {
        const key = JSON.stringify(address)
        if (activatedOwners.has(key)) return "Only one pasted model can be active per destination owner"
        activatedOwners.add(key)
        const activated = activateModelRow(draft.memo, next.id)
        if ("refusal" in activated) return activated.refusal
        draft.memo = { ...draft.memo, records: [...draft.memo.records.filter((row) => row.type !== "model"), ...activated.models] }
      }
      if (clipboard.mode === "cut" && !sameOwnerView(origin.address, { ...address, item: origin.address.item, section: null })) {
        const removed = removeModelRow(draft.memo, origin.id)
        if ("refusal" in removed) return removed.refusal
        draft.memo = { ...draft.memo, records: [...draft.memo.records.filter((row) => row.type !== "model"), ...removed.models] }
      }
      if (folderIdOfRef(rowToken(materialize(target)) ?? "") !== undefined || target.id === destinationTab.id) {
        const moved = planRowMove(draft.memo, draft.layout, next.id, { into: target.id }, new Date().toISOString())
        if ("refusal" in moved) return moved.refusal
        layout(moved.layout)
      }
      draft.rows.push(next.id)
      return undefined
    }
    const sourceItem = isControl(origin.address.item) ? controlItemFor(source.ctx.items, origin.address) : source.ctx.items.find((item) => item.id === origin.address!.item)
    const targetItem = target.address === undefined ? undefined : isControl(target.address.item) ? controlItemFor(memo.ctx.items, target.address) : memo.ctx.items.find((item) => item.id === target.address!.item)
    const updatedMemo = built()
    const addressed = collectSkeleton([findLazy(updatedMemo, targetItem?.kind === "tool" && sourceItem?.kind !== "tool" ? target.id : destinationTab.id)!]).filter((row) => row.address?.section === null)
    const destinationRow = target.address !== undefined && sourceItem !== undefined && sourceItem.kind !== "tool" && targetItem?.kind === sourceItem.kind
      ? target : addressed.find((row) => row.address?.item === origin.address!.item || sourceItem?.kind === "param" && targetItem?.kind === "tool" && memo.ctx.items.some((item) => item.id === row.address?.item && item.kind === "param" && item.title === sourceItem.title))
    if (destinationRow?.address === undefined) return `The destination does not have "${origin.label}"`
    if (draft.rows.includes(destinationRow.id)) return `Several clipboard rows target the same row: ${origin.label}`
    const same = sameOwnerView(origin.address, destinationRow.address)
    const relocating = same && origin.address.item === destinationRow.address.item
    if (same && clipboard.mode === "copy" && origin.address.item.startsWith("tool:")) return `You already have this tool: ${origin.label}. Cut it to change its category.`
    if (!relocating || clipboard.mode === "copy") {
      // Destination-only switches must not fire while the copied values are written.
      maskLinks(memo, destinationRow)
      // Exposure must arrive before pin settings: a previously direct tool
      // exposes its pin action only after it has moved into Code Mode.
      const sourceRows = collectSkeleton([origin]).toSorted((left, right) => Number(right.address?.item.startsWith("toolmode:") === true) - Number(left.address?.item.startsWith("toolmode:") === true))
      const replaced = new Set(sourceRows.flatMap((row) => {
        if (row.address?.section !== null) return []
        const target = correspondingRow(source, origin, row, memo, destinationRow)
        return target?.address === undefined ? [] : [target.address.item]
      }))
      draft.memo = { ...draft.memo, records: draft.memo.records.filter((record) =>
        !((record.type === "customization" || record.type === "split") && replaced.has(record.item) && scopedTo(record, destinationRow.address!)),
      ) }
      const seen = new Set<string>()
      for (const row of sourceRows) {
        const address = row.address
        if (address === undefined || seen.has(JSON.stringify(address))) continue
        seen.add(JSON.stringify(address))
        const upstream = isControl(address.item) ? controlItemFor(source.ctx.items, address) : source.ctx.items.find((item) => item.id === address.item && (address.agent === null || applies(item, address.agent)))
        const item = upstream === undefined ? undefined : ruleItem(upstream, source.ctx.rules, source.ctx.scopes, address)
        if (item === undefined) return `"${row.label}" needs a specialized configuration transfer`
        const nextMemo = built()
        const root = findLazy(nextMemo, destinationRow.id)!
        const next = correspondingRow(source, origin, row, nextMemo, root)
        if (next === undefined) return `The destination lacks ${row.label}`
        const resolved = address.section === null
          ? wholeOf(source, address.level, address.agent, item, address.catalogue, rowTeamOf(address))
          : sectionResolveOf(source, address.level, address.agent, item, address.section, address.catalogue, rowTeamOf(address))
        if ((item.kind !== "perm" || isValueRow(item)) && row.actions.edit && next.actions.edit) {
          const refusal = apply(saveText(draft.memo, next.id, resolved.fullText ?? resolved.text, built()))
          if (refusal !== undefined) return refusal
          if (address.section === null && next.address !== undefined) {
            const current = built()
            const upstream = isControl(next.address.item) ? controlItemFor(current.ctx.items, next.address) : current.ctx.items.find((entry) => entry.id === next.address!.item)
            if (upstream === undefined) return `The destination lacks ${row.label}`
            draft.memo = { ...draft.memo, records: [
              ...draft.memo.records.filter((record) => record.type !== "customization"),
              ...merge(current.ctx.customizations, next.address, { text: resolved.fullText ?? resolved.text }, upstream, current.ctx.scopes, current.ctx.splits),
            ] }
          }
        }
        if (address.section === null && row.actions.split && next.actions.split) {
          const split = splitOf(source, address.level, address.agent, item, address.catalogue, rowTeamOf(address))
          if (split.kind === "manual") {
            const refusal = apply(saveSplit(draft.memo, next.id, split.sections.map((section) => ({ id: section.id, name: section.name, start: section.start }))))
            if (refusal !== undefined) return refusal
          }
        }
        if (row.actions.toggle && next.actions.toggle) {
          const refusal = apply(setEnabled(draft.memo, next.id, resolved.enabled, built()))
          if (refusal !== undefined) return refusal
        }
        if (row.actions.pin && next.actions.pin) {
          const refusal = apply(setPin(draft.memo, next.id, resolved.pinned, built()))
          if (refusal !== undefined) return refusal
        }
        if (row.actions.requires && next.actions.requires) {
          const refusal = apply(setRequires(draft.memo, next.id, resolved.requires?.ids ?? [], built()))
          if (refusal !== undefined) return refusal
        }
      }
      const linked = copyLinks(origin, findLazy(built(), destinationRow.id)!)
      if (linked !== undefined) return linked
    }
    if (origin.address.item.startsWith("tool:") && (target.id.includes(":codemode") || target.id.endsWith(":native"))) {
      const exposure = collectSkeleton([findLazy(built(), destinationRow.id)!]).find((row) => row.address?.item.startsWith("toolmode:"))
      if (exposure === undefined) return `"${origin.label}" cannot change exposure`
      const refusal = apply(saveText(draft.memo, exposure.id, target.id.includes(":codemode") ? "codemode" : "direct"))
      if (refusal !== undefined) return refusal
    }
    // System (with its Base group) and Skills have no folders: a paste onto
    // them only transfers configuration.
    if (folderIdOfRef(rowToken(materialize(target)) ?? "") !== undefined || (target.id === destinationTab.id && !["system", "base", "skills"].includes(categoryOf(target.id)!))) {
      const moved = planRowMove(draft.memo, draft.layout, destinationRow.id, { into: target.id }, new Date().toISOString())
      if ("refusal" in moved) return moved.refusal
      layout(moved.layout)
    }
    if (!relocating && clipboard.mode === "cut") {
      const refusal = apply(origin.actions.toggle ? setEnabled(draft.memo, origin.id, false) : reset(draft.memo, origin.id))
      if (refusal !== undefined) return refusal
      const rule = parsePermItemId(origin.address.item)
      if (rule !== undefined) draft.memo = { ...draft.memo, records: draft.memo.records.filter((record) =>
        record.type !== "rule" || record.tool !== rule.tool || record.id !== rule.ruleId || !scopedTo(record, origin.address!),
      ) }
    }
    draft.rows.push(destinationRow.id)
    return undefined
  }
  for (const id of clipboard.rows) {
    const refusal = transfer(id, destination)
    if (refusal !== undefined) return { refusal }
  }
  return draft
}

// The category a group row is: a layout tab, or an owner's Skills list (which
// has no layout of its own, so tabOfGroupId does not name it). A folder named
// like a category ("…:folder:…:system") is not one.
function categoryOf(id: string): string | undefined {
  if (!id.startsWith("group:") || id.includes(":folder:")) return undefined
  return tabOfGroupId(id) ?? (id.endsWith(":skills") ? "skills" : undefined)
}
