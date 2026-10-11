# Plus 1.3.5 usage-marker integration

The `usage-parity` branch is based on Plus 1.3.5 at `7c5bb3ed1d`.
The marker backport is `d288050efa`; the following dependency update includes
the stock-TUI Solid runtime fix in Pacer `a032f4220a8704e653711bccc9be22a6652c704f`.

## Behavior

- The sidebar follows the selected model's catalogue providers, even before
  its first request. Popup all-credentials scope does not widen the sidebar.
- Primary response headers push quota percentages and IN USE immediately.
  IN USE replaces LAST USED until execution ends; auxiliary requests do not
  change that identity. Activity is not restored from persisted snapshots.
- NEXT USE comes from Pacer's read-only per-chat preview. Plus uses its own
  existing claim capability, coalesces reads for 15 seconds, and labels dry-run
  proposals. Missing, expired and model-mismatched proposals are hidden.
- Neither the popup nor the sidebar calls provider quota endpoints.

## Integration notes

The original 1.3.5 worktree had concurrent uncommitted edits in quota UI/store/
server files and unrelated keymap/autocomplete work. Those edits were preserved.
Integrate this branch after preserving that work; retain its Antigravity ordering
and optional slash-argument support when resolving overlapping hunks.

Pacer's explicit `opencode-pacer/v2/server` entrypoint keeps V1-only types out of
the Plus build. The dependency includes the new `PacerRpc.usage` cached catalogue
scope and live meter activity. Plus's separate `quota/next-use.ts` uses the Plus
controller's capability; stock account-switch handling remains disabled in Plus.

## Verification

- Standalone: typecheck and 40 tests, including real OpenTUI rendering at narrow
  and wide sizes, selection changes, popup controls and live marker updates.
- Stock OpenCode 2.0.26 fake-CPA host: response percentages, IN USE during the
  stream, clearing after execution, provider scope, preview, and switch recovery.
- Stock OpenCode 2.0.26 real TUI: reproduced the missing sidebar caused by the
  source-loaded store using a different Solid runtime. Keeping that store in a
  TSX module restored the live quota bar. Verified `/usage`, all scope and Escape.
- Plus cliproxyapi: typecheck and focused usage-view, next-use, usage and pacer
  tests (18 tests).
- Plus core: the real plugin-host pacer test verifies zero extra network calls
  from response handling, capability-scoped preview and cached repeated reads.

This is a source integration branch, not a promoted Plus release. NEXT USE also
requires the corresponding Pacer server update to be deployed.
