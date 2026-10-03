// The Project checks command: confirm which commands a team run may be given
// as checks in this project (.opencodeplus/checks.json in the main checkout).
// Plus suggests what the project's own manifests already name; nothing is
// written until the person saves. A select dialog that reopens after each pick
// is the checklist: picking a row switches it, Save writes.
import type { Plugin } from "@opencode/plugin/tui"
import { Definition } from "../rpc.js"

type Entry = {
  readonly id: string
  readonly argv: readonly string[]
  readonly cwd?: string
  readonly description?: string
  readonly source?: string
}

const SAVE = "\u0000save"
const CANCEL = "\u0000cancel"
const SETUP = "\u0000setup"

function line(entry: Entry): string {
  return `${entry.argv.join(" ")}${entry.cwd === undefined ? "" : `  (in ${entry.cwd})`}`
}

export async function openProjectChecks(context: Plugin.Context): Promise<void> {
  const plus = context.client.rpc(Definition)
  // The project is the one this screen shows: RPC calls go to that
  // directory's Plus instance (as the Instructions screen's do).
  const current = context.location ?? context.data.location.default()
  const location = current === undefined ? undefined : { directory: current.directory, workspace: current.workspaceID }
  const options = location === undefined ? undefined : { location }
  const found = await plus["checks.suggest"](undefined, options).catch((error: unknown) => {
    context.ui.toast.show({ variant: "error", message: error instanceof Error ? error.message : String(error) })
    return undefined
  })
  if (found === undefined) return
  if (found.root === undefined) {
    context.ui.toast.show({ variant: "warning", message: "Project checks need a git repository; open the chat in one" })
    return
  }
  const entries: Entry[] = [...found.current, ...found.suggested]
  const chosen = new Set(found.current.map((entry) => entry.id))
  const setupEntry: Entry | undefined = found.setup ?? found.suggestedSetup
  let setup = found.setup !== undefined
  let cursor: string | undefined
  for (;;) {
    const picked = await context.ui.dialog.select<string>({
      title: "Project checks",
      placeholder: "Pick to switch; Save writes .opencodeplus/checks.json",
      ...(cursor === undefined ? {} : { current: cursor }),
      options: [
        ...entries.map((entry) => ({
          title: `${chosen.has(entry.id) ? "[x]" : "[ ]"} ${entry.id}`,
          value: entry.id,
          description: `${line(entry)}${entry.description === undefined ? "" : ` — ${entry.description}`}`,
          category: found.current.some((current) => current.id === entry.id) ? "In the file" : "Suggested",
        })),
        ...(setupEntry === undefined
          ? []
          : [
              {
                title: `${setup ? "[x]" : "[ ]"} setup (before the first check in a fresh worktree)`,
                value: SETUP,
                description: line(setupEntry),
                category: "Worktree setup",
              },
            ]),
        { title: `Save ${chosen.size} check${chosen.size === 1 ? "" : "s"}`, value: SAVE, category: "Done" },
        { title: "Cancel", value: CANCEL, category: "Done" },
      ],
    })
    if (picked === undefined || picked === CANCEL) return
    if (picked === SAVE) break
    cursor = picked
    if (picked === SETUP) setup = !setup
    else if (chosen.has(picked)) chosen.delete(picked)
    else chosen.add(picked)
  }
  const saved = await plus["checks.save"](
    {
      checks: entries.filter((entry) => chosen.has(entry.id)).map(({ source: _source, ...entry }) => entry),
      ...(setup && setupEntry !== undefined ? { setup: (({ source: _source, ...entry }) => entry)(setupEntry) } : {}),
    },
    options,
  ).catch((error: unknown) => {
    context.ui.toast.show({ variant: "error", message: error instanceof Error ? error.message : String(error) })
    return undefined
  })
  if (saved === undefined) return
  context.ui.toast.show({
    variant: "success",
    message: `Saved ${saved.checks.length} project check${saved.checks.length === 1 ? "" : "s"} to ${saved.path}`,
  })
}
