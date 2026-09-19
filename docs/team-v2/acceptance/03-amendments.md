# 03-tools.md amendments — accepted 2026-09-19

Four contract questions raised by review `w-dcf01407c9ec4610` and re-raised by
`w-a2081cf27925114c` were decided by the human on 2026-09-19. All four accept the
shipped behaviour, so no code changes. `docs/team-v2/03-tools.md` lives outside the
task worktree; the exact edits are recorded here for the human to apply.

Line numbers are against 03-tools.md as of this branch's base.

---

## 1. `integrate` — add `E_NOT_CHILD` to the gate table

**Accepted:** integrate rejecting a non-child with `E_NOT_CHILD` is correct and stays.

In `## integrate` (line 186), in the gate table that currently starts at line 196,
insert this row as the FIRST row of the table body, immediately after the
`|---|---|---|` separator and before the `E_NOT_DONE` row. It is listed first
because the handler checks ownership before every other gate.

```
| run is a direct child | `E_NOT_CHILD` | `Run w-x is not your direct child. Your children: [..]. Use status to read others.` |
```

The message is verbatim from `packages/plus/src/teams/api-integrate.ts`; `stop` and
`supersede` already emit the identical text through a shared helper.

---

## 2. `integrate` — add `conflict` and `red` to the output state enum

**Accepted as shipped for this merge:** a conflicting or red queue entry currently
leaves the tool returning `pending`, and no parent-inbox outcome is delivered,
because the sweeper is not implemented. The enum gains the two states as the
sweeper's target so the contract names where they surface.

Replace line 194, which currently reads:

```
Output: `{ entry: z.string(), state: "pending"|"landed", head: Head|null }`. If the queue is empty and the parent is clean, the tool processes synchronously and returns `landed` with the new HEAD (common case; one round-trip).
```

with:

```
Output: `{ entry: z.string(), state: "pending"|"landed"|"conflict"|"red", head: Head|null }`. If the queue is empty and the parent is clean, the tool processes synchronously and returns `landed` with the new HEAD (common case; one round-trip). `conflict` and `red` are the sweeper's target states: until the sweeper lands, an entry that conflicts on rebase or fails the parent's checks reaches that state in the queue while the tool returns `pending`, and the parent-inbox outcomes below are not delivered.
```

No change to the "Outcomes delivered by the sweeper into the parent inbox" line at
201 — it already describes the sweeper's job correctly.

---

## 3. `stop` — `E_BUSY` covers every state outside idle/stopped/dead

**Accepted:** returning `E_BUSY` for any non-stoppable state, not only `working`,
is correct. `ready` and `starting` take it too.

Replace line 257, which currently reads:

```
Owned child only; requires `idle`, `stopped` or `dead` (dead → cleans registration). On `working` → `E_BUSY: "Child is working; call shutdown_request then wait, or supersede."`. On already `stopped` → `{ state: "stopped" }` (no error).
```

with:

```
Owned child only; requires `idle`, `stopped` or `dead` (dead → cleans registration). Every other state — `working`, `ready`, `starting`, `stopping` — → `E_BUSY: "Child is working; call shutdown_request then wait, or supersede."`, one message for the whole non-stoppable set. On already `stopped` → `{ state: "stopped" }` (no error). A run that is not the caller's direct child → `E_NOT_CHILD`.
```

---

## 4. `list` — state the v1 visibility rule

**Accepted:** the planner-sees-all / everyone-else-sees-own-plus-direct-children
split is the v1 rule and stays.

In `## list` (line 301), after the closing ``` of the schema block at line 306, add
this paragraph:

```
Visibility (v1 rule): a planner sees every run in the namespace; every other role sees its own run plus its direct children. `all: false` additionally hides superseded and reaped runs. Read-only — `list` never writes a run record.
```

---

## Not amended

The absent merge sweeper itself is unchanged and still unimplemented: `integrate`
does not deliver `landed`/`conflict`/`red` into the parent inbox, and queued
followups are written to the child inbox but never consumed. Both are recorded in
`2026-09-18-human-test.md` and remain the next milestone's work.
