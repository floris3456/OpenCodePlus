import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { render } from "@opentui/solid"
import { createSignal } from "solid-js"
import { TeamMonitorTab } from "../src/tui/active-team.js"

const white = RGBA.fromHex("#ffffff")
const gray = RGBA.fromHex("#888888")
const black = RGBA.fromHex("#000000")
const theme = {
  text: { base: white, muted: gray, action: { primary: { base: white, selected: white, focused: white } } },
  background: { base: black, action: { primary: { base: black, selected: black, focused: black } } },
}

const run = (id: string, state: string) => ({
  id,
  role: "r",
  state,
  task: null,
  head: "abcdef",
  worktree: "present",
  lastUsed: "2026-09-10T12:00:00.000Z",
  sessionID: "ses_run",
  parent: "main-01",
})

/** A Team tab whose run list answers only when the test lets each request through. */
async function held() {
  const requests: { input: { all?: boolean }; answer: (runs: ReturnType<typeof run>[]) => void }[] = []
  const teamListeners = new Set<() => void>()
  const [showInactive, setShowInactive] = createSignal(false)
  const context: any = {
    location: { directory: "/my/project" },
    theme,
    data: { location: { default: () => ({ directory: "/my/project" }) }, listen: () => () => {} },
    client: {
      rpc: () => ({
        "team.runs.list": (input: { all?: boolean }) =>
          new Promise((resolve) => requests.push({ input, answer: (runs) => resolve({ runs }) })),
        events: {
          on: (event: string, handler: () => void) => {
            if (event === "teams.changed") teamListeners.add(handler)
            return () => teamListeners.delete(handler)
          },
        },
      }),
    },
    keymap: { layer: () => {} },
    ui: { toast: { show: () => {} }, router: { navigate: () => {} } },
  }
  const output = await createTestRenderer({ width: 100, height: 20 })
  // Inactive, so the 2 s poll stays out of the counts; teams.changed asks at once.
  render(
    () => (
      <TeamMonitorTab
        sessionID="ses_root"
        active={() => false}
        open={() => {}}
        context={context}
        showInactive={showInactive}
        setShowInactive={setShowInactive}
      />
    ),
    output.renderer,
  )
  await output.renderOnce()
  const changed = () => teamListeners.forEach((handler) => handler())
  // Answers land through promise callbacks; let them run before rendering.
  const frame = async () => {
    await Bun.sleep(0)
    await output.renderOnce()
    return output.captureCharFrame()
  }
  return { requests, changed, setShowInactive, frame, output }
}

test("the Team tab sends one run list request at a time and asks once more for what came meanwhile", async () => {
  const tab = await held()
  try {
    expect(tab.requests).toHaveLength(1)
    // A burst of team changes while the mount request is out sends nothing yet.
    for (let i = 0; i < 5; i++) tab.changed()
    expect(tab.requests).toHaveLength(1)
    tab.requests[0]!.answer([run("w-run-first", "working")])
    expect(await tab.frame()).toContain("w-run-first")
    // The burst is one more request, sent as soon as the first answered.
    expect(tab.requests).toHaveLength(2)
    tab.requests[1]!.answer([run("w-run-second", "working")])
    const frame = await tab.frame()
    expect(frame).toContain("w-run-second")
    expect(frame).not.toContain("w-run-first")
    expect(tab.requests).toHaveLength(2)
  } finally {
    tab.output.renderer.destroy()
  }
})

test("a run list answer for a filter that changed while it was out is not shown", async () => {
  const tab = await held()
  try {
    tab.setShowInactive(true)
    await tab.output.renderOnce()
    expect(tab.requests).toHaveLength(1)
    // The active runs answer after the filter switched to inactive ones.
    tab.requests[0]!.answer([run("w-run-active", "working")])
    expect(await tab.frame()).not.toContain("w-run-active")
    expect(tab.requests.map((request) => request.input.all)).toEqual([false, true])
    tab.requests[1]!.answer([run("w-run-stopped", "stopped")])
    expect(await tab.frame()).toContain("w-run-stopped")
  } finally {
    tab.output.renderer.destroy()
  }
})
