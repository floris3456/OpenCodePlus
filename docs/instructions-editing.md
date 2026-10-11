# Shared Instructions editing

This work extends the Instructions editor and agent tools together. The saved
model, the runtime consumers, tool queries, and the TUI must agree.

## Interaction contract

- Selection is independent of keyboard focus. Keep selected rows while moving
  between agents, categories, and levels; expose the selected count and a clear
  selection command. Range selection follows the visible list.
- An action on a selected row, or on a setting beneath a selected row, applies
  the same resulting value to the corresponding setting of every compatible
  selected row. Match structural identities, never a coincidentally equal label.
  Report incompatible or refused targets instead of silently treating them as
  changed. An action outside the selection remains a single-row action.
- Copy is a snapshot of configuration, not a live link. Pasting into a different
  agent updates its existing corresponding row without duplicating a tool. An
  attempted duplicate of a tool within its current agent reports that the agent
  already has that tool. Rows that can meaningfully be duplicated, such as text
  sections, can receive new identities.
- Cut does not write immediately. Keep the source dimmed until paste succeeds;
  cancelling cut leaves its data and placement intact. Paste moves both the
  configuration and its semantic placement, not just the visible label.
- Placement changes that affect execution must change execution. Moving a tool
  into or out of Code Mode changes its exposure for the destination owner;
  permission checks and the same underlying executor still apply.
- Fixed roots and sections remain fixed: Presets, Defaults, Global, Project,
  Models, Tools, System, Settings. Custom containers are editable where their
  contents make sense. Base moves from the top-level category strip to a tab
  inside System.
- Categories and placements are saved, owner-scoped structure visible through
  the same agent-tool query and mutation surface as the TUI. Existing global
  display-folder records require compatibility handling, not deletion.
- Successful mutations from either surface update an open TUI and produce
  short-lived stacked change notifications. Saved changes, pending edits, and
  failures remain distinguishable; one underlying change must not generate
  duplicate local/remote notifications.

## Implementation boundaries

Use shared row addressing, compatibility, and operation planning rather than
implementing a separate clipboard or bulk-edit policy in the TUI. Keep temporary
selection and clipboard ownership in the client; keep committed configuration,
category membership, tool exposure, and mutation receipts in the shared service.

The existing plugin tool registry is Location-wide. Per-agent direct/Code Mode
placement therefore needs a request-scoped exposure seam in the host, not a
global registry rewrite. Request-specific exposure must preserve permission
filtering, catalog schemas and execution dispatch.

Verification must cover real row mutations and queries, supplied/absent compatible
settings, duplicate-tool refusal, cancelled and failed cuts, destination runtime
exposure, external-change refresh and notification deduplication, and keyboard
operation in wide and narrow terminals.
