// Wiring point for the Plus-only `instructions` and `notify` command handlers.
//
// `packages/cli/src/plus.ts` derives `plusCommands` from the shared `Commands`
// and adds `InstructionsCommand` and `NotifyCommand` together with their handlers.
// The shared `Commands` and the upstream handler map in `packages/cli/src/index.ts`
// stay without them, so the commands only run under OpenCodePlus.
export const instructionsHandler = () => import("./instructions")
export const notifyHandler = () => import("./notify")
