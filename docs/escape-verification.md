# Escape verification (F5.6 acceptance)

No key was pressed in a real terminal for this report, and no Mac
terminal is reachable from this container. Everything below comes from
automated tests and source measurement in this worktree, not from
interactive observation.

## Verified

1. ESC in the Instructions tree reaches Back rather than arming the
   interrupt. Source: `packages/tui/test/escape-fallthrough.test.tsx`
   test "escape reaches a newer back layer instead of arming interrupt
   when running" — pass in the `tui-esc-fallthrough` run (4 pass, 0 fail).
2. A dialog is open; ESC closes it. Source:
   `packages/tui/test/escape-fallthrough.test.tsx` test "escape closes a
   dialog instead of arming interrupt when running" — pass in the same
   `tui-esc-fallthrough` run (4 pass, 0 fail).
3. A session is running with the prompt focused; ESC in the Instructions
   route reaches Back, not the interrupt. Source: same back-layer test as
   (1) — it blurs the prompt to model the Instructions route, then asserts
   the spy fires and `interruptCalls` stays empty — plus the control test
   "esc esc interrupts a running session when the prompt is focused",
   which proves the prompt-focused path still arms the interrupt (first
   ESC shows "again to interrupt", second ESC calls `session.interrupt`
   exactly once). Both pass in the `tui-esc-fallthrough` run.
4. ESC then Up are seen as two distinct keys. Source:
   `packages/tui/test/stdin-esc.test.ts` test "lone ESC inside the 20 ms
   window is swallowed by a following arrow", which pushes `0x1b`, then
   `0x1b 0x5b 0x41`, and asserts `["escape", "up"]` — pass in the
   `tui-stdin-esc` run (5 pass, 0 fail).
5. Kitty is OFF for a `docker exec -t` style pty. Source: measurement of
   `patches/@opentui%2Fcore@0.5.10.patch` plus grep. The patched parser
   starts with `useKittyKeyboard: false` and
   `protocolContext.kittyKeyboardEnabled: false`, and flips true only on
   an observed `CSI ? <flags> u` reply. Nothing in the main TUI sends
   `CSI ? u` or `CSI c`: `enableKittyKeyboard` is called only at
   `packages/tui/src/mini/runtime.lifecycle.ts:238` (with `disable` at
   :235), there is no `setupTerminal` call and no kitty-query string in
   `packages/tui/src`. So no reply arrives, kitty stays OFF — correct for
   a docker-exec pty — and kitty parsing is never used in the main TUI.

## What is NOT verified

- No interactive keypress from a Mac was observed.
- The keymap debug overlay was never rendered to a human eye.
- Whether the native `setupTerminal` in `core-linux-x64` solicits the
  query is unverified (that binary is not in this container).
- The kitty negotiation gap is upstream `anomalyco/opencode` #37692.
