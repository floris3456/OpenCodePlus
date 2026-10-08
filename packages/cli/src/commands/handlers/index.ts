// Wiring point for the `instructions` command handler (Plus product only).
//
// Part 2 attaches `InstructionsCommand` (in ../commands) to Root.commands and
// adds `instructions: instructionsHandler` to the handlers map in
// `packages/cli/src/plus.ts`. The upstream map in `packages/cli/src/index.ts`
// stays without it, so the command only runs under OpenCodePlus
// (plus-build.test.ts's handler literals follow the maps). Both maps live
// outside the cli-part-1 scope, hence the indirection here.

export const instructionsHandler = () => import("./instructions")
