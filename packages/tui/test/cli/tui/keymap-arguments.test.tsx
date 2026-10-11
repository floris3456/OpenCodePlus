/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { ConfigProvider } from "../../../src/config"
import { Keymap } from "../../../src/context/keymap"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

test.each([true, "optional"] as const)(
  "dispatch passes slash input through the registered command (%s)",
  async (argumentsMode) => {
    const received: Array<string | undefined> = []
    let dispatch: ReturnType<typeof Keymap.use>["dispatch"]

    function Commands() {
      const keymap = Keymap.use()
      dispatch = keymap.dispatch
      Keymap.createLayer(() => ({
        mode: "global",
        commands: [
          {
            id: "project.cd",
            slash: { name: "cd", arguments: argumentsMode },
            run: (input) => {
              received.push(input)
            },
          },
        ],
      }))
      return <box />
    }

    const app = await testRender(() => (
      <ConfigProvider config={createTuiResolvedConfig()}>
        <Keymap.Provider>
          <Commands />
        </Keymap.Provider>
      </ConfigProvider>
    ))
    try {
      dispatch!("project.cd")
      dispatch!("project.cd", "")
      dispatch!("project.cd", "src/components with spaces")
      expect(received).toEqual([undefined, "", "src/components with spaces"])
    } finally {
      app.renderer.destroy()
    }
  },
)
