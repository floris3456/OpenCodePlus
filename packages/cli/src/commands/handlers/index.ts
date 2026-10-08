// Wiring point for the `instructions` command handler (Plus product only).
//
// `packages/cli/src/plus.ts` derives `plusCommands` from the shared `Commands`
// and adds `InstructionsCommand` together with `instructions: instructionsHandler`.
// The shared `Commands` and the upstream handler map in `packages/cli/src/index.ts`
// stay without it, so the command only runs under OpenCodePlus.
export const instructionsHandler = () => import("./instructions")