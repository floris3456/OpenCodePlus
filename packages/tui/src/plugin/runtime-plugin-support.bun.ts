import { createPaneResize, Plugin, PluginContextProvider, usePlugin } from "@opencode/plugin/tui"
import { ensurePluginRuntime, provides } from "@opencode/plugin/runtime"
import { ensureRuntimePluginSupport } from "@opentui/solid/runtime-plugin-support/configure"

ensurePluginRuntime()
ensureRuntimePluginSupport({
  additional: {
    "@opencode/plugin/tui": { Plugin, PluginContextProvider, usePlugin, createPaneResize },
  },
  preserve: provides,
})
