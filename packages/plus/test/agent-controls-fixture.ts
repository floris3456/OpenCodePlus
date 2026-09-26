import { controlItems } from "../src/instructions/agent-controls.js"
import type { CustomizationRecord } from "../src/instructions/model.js"
import type { Snapshot } from "../src/rpc.js"
import { createSnapshot } from "./tui.js"

export { controlItems }

export function controlRecord(item: string, fields: Partial<CustomizationRecord> = {}): CustomizationRecord {
  const upstream = controlItems().find((entry) => entry.id === item)
  if (upstream === undefined) throw new Error(`Unknown fixture control ${item}`)
  return {
    type: "customization",
    level: "project",
    agent: "build",
    item,
    section: null,
    basedOn: upstream.fingerprint,
    basedOnText: upstream.text,
    updated: "2026-09-26T00:00:00.000Z",
    ...fields,
  }
}

export function controlSnapshot(records: readonly CustomizationRecord[] = [], overrides: Partial<Snapshot> = {}): Snapshot {
  return createSnapshot({
    agents: [{ id: "build", scope: "defaults", fileBacked: false, origin: "native" }],
    items: controlItems(),
    records,
    ...overrides,
  })
}
