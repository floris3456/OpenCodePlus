import { createMemo, onCleanup } from "solid-js"
import { useLocal } from "../context/local"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"

export function DialogVariant() {
  const local = useLocal()
  const dialog = useDialog()
  // The model was already set before this dialog opened, so a pick is
  // completed either by choosing a variant (or Default) or by leaving without
  // one. Emit exactly once, when the dialog goes away, reading the selection
  // it ends on: an explicit choice must not also fire the cleanup's emit.
  let picked = false
  const pick = () => {
    if (picked) return
    picked = true
    local.model.pick()
  }
  onCleanup(pick)

  const options = createMemo(() => [
    {
      value: "default",
      title: "Default",
      onSelect: () => {
        local.model.variant.set(undefined)
        pick()
        dialog.clear()
      },
    },
    ...local.model.variant
      .list()
      .filter((variant) => variant !== "default")
      .map((variant) => ({
        value: variant,
        title: variant,
        onSelect: () => {
          local.model.variant.set(variant)
          pick()
          dialog.clear()
        },
      })),
  ])

  return (
    <DialogSelect<string>
      options={options()}
      title={"Select variant"}
      current={local.model.variant.current() ?? "default"}
      flat={true}
    />
  )
}
