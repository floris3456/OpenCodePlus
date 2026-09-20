import { createMemo } from "solid-js"
import { useLocal } from "../context/local"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"

export interface DialogAgentProps {
  filter?: string
  title?: string
}

export function DialogAgent(props: DialogAgentProps = {}) {
  const local = useLocal()
  const dialog = useDialog()

  const allOptions = createMemo(() => {
    const all = local.agent.all()
    const groups = local.agent.groups()
    const groupedIds = new Set(groups.flatMap((g) => g.agents))
    const byId = new Map(all.map((a) => [a.id, a]))

    const result: DialogSelectOption<string>[] = []

    for (const agent of all) {
      if (!groupedIds.has(agent.id)) {
        result.push({
          value: agent.id,
          title: agent.id,
          description: agent.description,
          category: "Agents",
        })
      }
    }

    for (const group of groups) {
      for (const agentId of group.agents) {
        const agent = byId.get(agentId)
        if (agent) {
          result.push({
            value: agent.id,
            title: agent.id,
            description: agent.description,
            category: group.label,
          })
        }
      }
    }

    return result
  })

  const options = createMemo(() => {
    const all = allOptions()
    if (!props.filter) return all
    const needle = props.filter.toLowerCase()
    return all.filter(
      (item) => item.category?.toLowerCase().includes(needle) || item.title.toLowerCase().includes(needle),
    )
  })

  return (
    <DialogSelect
      title={props.title ?? "Select agent or team"}
      current={local.agent.current()?.id}
      options={options()}
      onSelect={(option) => {
        local.agent.set(option.value)
        dialog.clear()
      }}
    />
  )
}
