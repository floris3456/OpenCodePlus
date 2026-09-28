# Upstream v2 merge r4.8 — conflict-pain report

Status: **merged locally, verified; not pushed, not released.**

- Worktree: `worktrees/r4-8/opencode`, branch `r4-8`.
- Pre-merge HEAD: `2cf098ce4e7ba366d5ab1c9de678fa6fbe1c9f40`
  (`feat(plus): merge instruction review results`).
- Upstream fetch: `upstream` = `https://github.com/anomalyco/opencode.git`,
  `upstream/v2` = `dd786c62af18b8f53c1eea1b30c5b53460ea9f6e`.
- Merge base: `96f23508bed1f36e758ad6eedd01024e1782d860`
  (the upstream tip merged by the previous local merge commit
  `9c29e5f28 chore: merge upstream v2`).
- Divergence before this merge: `1059` commits only on `r4-8`, `8` commits only
  on `upstream/v2`.

## 1. Procedure

1. `git fetch upstream v2` (fast-forwarded the remote-tracking ref
   `96f23508b..dd786c62a`).
2. `git merge --no-ff --no-commit upstream/v2` from the clean worktree.
   No rebase, no reset, no force, no push.
3. Git reported "Automatic merge went well" — **no literal conflicts**.
4. All `14` files changed by upstream were applied verbatim; each of the
   merged files is byte-identical to its `upstream/v2` version
   (`git diff --quiet upstream/v2 -- <file>` empty for all 14).
5. Focused verification (section 6) was run on the merged working tree, then
   this report was staged with the merge and the merge commit was created.

## 2. Literal conflicts

**Total literal conflicted files: 0.**

| File | Pain | Notes |
|---|---|---|
| _(none)_ | — | — |

Totals by level: **P0 0 · P1 0 · P2 0 · P3 0 · P4 0**.

Proof that this is complete rather than an omission: the set of paths changed
on the fork side since the merge base and the set of paths changed on the
upstream side are disjoint.

```
$ comm -12 <(git diff --name-only 96f23508b..HEAD | sort) \
           <(git diff --name-only 96f23508b..upstream/v2 | sort)
(empty)
```

Because no path is touched by both sides, a three-way merge cannot conflict;
`git merge --no-ff --no-commit upstream/v2` confirmed this. The list above is
therefore every literal conflicted file, exactly once (the empty list).

## 3. Integration changes that were not literal conflicts

Even with no textual conflict, each upstream change was reviewed against the
fork's behavior at its call sites. "Pain" below is the integration/risk class
(same scale, applied to integration rather than conflict resolution): it
records how much reasoning the change required, not conflict cost. All 14 files
required **no fork-side edit**: the fork had not modified any of them since the
merge base, so the upstream version is the correct merged version.

| # | File | Upstream commit | Pain | Ours intent | Upstream intent | Final resolution | Regression evidence |
|---|---|---|---|---|---|---|---|
| 1 | `flake.lock` | `0caae608a` | P0 | none (untouched since base) | nixpkgs bump for Bun 1.4 | upstream version verbatim | not exercised (Nix-only); typecheck/root check unaffected |
| 2 | `packages/ai/src/protocols/openai-chat.ts` | `d73396ab3` | P2 | none | preserve Gemini `extra_content.google.thought_signature` on OpenAI Chat tool calls; treat generativelanguage host as non-standard | upstream verbatim: `ExtraContent` schema, `extra_content` on tool calls/deltas, `isGemini` store detection | `packages/ai` `test/provider/openai-chat.test.ts`, `test/provider/gemini-openai-chat.recorded.test.ts` |
| 3 | `packages/ai/src/protocols/utils/tool-stream.ts` | `d73396ab3` | P1 | none | `appendOrStart` accepts optional `providerMetadata` fallback so streamed deltas can carry signatures | upstream verbatim; the parameter is additive, every existing caller compiles unchanged | `packages/ai` `test/tool-stream.test.ts`; `packages/ai` typecheck |
| 4 | `packages/ai/test/fixtures/recordings/openai-compatible-chat/gemini-parallel-tool-signatures.json` | `d73396ab3` | P0 | none | recorded provider fixture | upstream verbatim | replayed by the recorded test (row 5) |
| 5 | `packages/ai/test/provider/gemini-openai-chat.recorded.test.ts` | `d73396ab3` | P1 | none | regression test for parallel Gemini tool signatures | upstream verbatim | itself (recorded replay) |
| 6 | `packages/ai/test/provider/openai-chat.test.ts` | `d73396ab3` | P1 | none | unit coverage for `extra_content` lowering/delta handling | upstream verbatim | itself |
| 7 | `packages/core/src/models-dev/snapshot.txt` | `dd786c62a` | P0 | none | refresh bundled models.dev snapshot | upstream verbatim (single-line data file) | `packages/core` `test/models.test.ts` (bundled-snapshot fallback) |
| 8 | `packages/core/src/repository.ts` | `39e1ce55b` | P2 | none | reject relative path segments in repository hosts (`..:repo`, `https://%2e%2e/...`) | upstream verbatim: `safeHost` splits on `:` and validates every segment | `packages/core` `test/repository.test.ts`, `test/repository-cache.test.ts`, `test/reference.test.ts` |
| 9 | `packages/core/test/repository.test.ts` | `39e1ce55b` | P1 | none | port-per-host cache directory + rejection tests | upstream verbatim | itself |
| 10 | `packages/tui/src/routes/session/index.tsx` | `d9f54392b` | P1 | none | distinguish background shell from interrupted command: `background = completed && metadata.status === "running"` | upstream verbatim; the expression now matches the exported `isBackgroundSubagent` helper used elsewhere in the same file | `packages/tui` `test/cli/tui/inline-tool-wrap-snapshot.test.tsx` (helper) |
| 11 | `services/www/src/docs/components/DocsPage.astro` | `7076a878a` | P1 | none | Go Plus docs tabs | upstream verbatim | `services/www` `astro check` via root `bun run check` |
| 12 | `services/www/src/docs/components/PlanTabs.astro` | `7076a878a` | P1 | none | new plan-selection docs component | upstream verbatim | same as row 11 |
| 13 | `services/www/src/docs/content/console/go.mdx` | `87c402a12`, `7076a878a`, `45b91eed8` | P1 | none | v2 usage-limit wording + Go Plus docs + model list sync | upstream verbatim | same as row 11 |
| 14 | `services/www/src/docs/styles/global.css` | `7076a878a` | P1 | none | docs styling for the new tabs | upstream verbatim | same as row 11 |

Integration totals: **P0 3 · P1 9 · P2 2 · P3 0 · P4 0 · total 14**.

No integration edit by the fork was required: no fork call site consumes a
changed upstream API incompatibly. The one upstream API-shape change
(`appendOrStart` in row 3) is an optional-field extension and compiles against
all existing callers (`openai-chat.ts`, `mistral-chat.ts`, tests).

## 4. Fork features preserved

The fork-side path set since the merge base is disjoint from the upstream path
set, so none of the fork features could be displaced by this merge. They were
re-verified anyway as part of the focused matrix (section 6):

- `packages/plus` Instructions workspace: full-context three-way review diffs,
  merged Take result, level navigation, resizable panels / `W` resize mode,
  bulk expansion, help, agent controls, presets, TUI rule state
  (`test/route.test.tsx`, `test/agent-controls*.test.ts*`,
  `test/instructions-*.test.tsx`, `test/help.test.tsx`,
  `test/tui-rule-state.test.ts`, `test/presets.test.ts`,
  `test/perf.test.ts`, `test/diff-lines.test.ts`, `test/workspace*.test.ts*`).
- Provider/model warming and dynamic rescheduling
  (`packages/core` `test/config/warming.test.ts`,
  `test/plugin/warming.test.ts`).
- Patched OpenTUI ESC behavior / keymap fallthrough
  (`packages/tui` `test/escape-fallthrough.test.tsx`).
- Pane-resize controller shared through `@opencode/plugin/tui`
  (`packages/tui` `test/ui/pane-resize.test.ts`,
  `test/ui/pane-resize-handle.test.tsx`, `test/plugin-source.test.ts`).
- Release safety guards (`packages/core/test/release-admission.test.ts`;
  release code untouched by the merge).
- Generated public client surface unchanged by this merge; checked with
  `check:generated`.

## 5. Autonomous decisions

1. **Zero-conflict conclusion accepted without an invented conflict table.**
   The disjoint path sets prove no literal conflict; the report records the
   empty literal table plus the integration classification instead of
   reclassifying upstream-only files as conflicts. No external review was
   needed because no material ambiguity existed (no fork intent was in play in
   any of the 14 files).
2. **No `bun run generate`.** No Protocol/Server HttpApi or generated public
   config type changed in this merge (`git diff --cached --name-only` contains
   no `packages/protocol`, `packages/server`, `packages/schema`,
   `packages/client` path). `check:generated` was run anyway as a guard and
   passed, confirming the committed generated surface matches a fresh
   generation from the current Schema/Protocol.
3. **Verbatim upstream application.** For each of the 14 files the merged
   version equals `upstream/v2` byte-for-byte; no local edits were layered on
   top, so the merge is a clean upstream delta for those paths.
4. **Focused-only testing**, per workspace instructions; no whole suites.
5. **The report is committed inside the merge commit** so the delivered state
   (tree, parents, evidence) is one artifact; nothing is pushed.

## 6. Verification

All commands run in `/home/bliss/OpenCodePlus/worktrees/r4-8/opencode` (or the
stated package directory) on the merged working tree. Logs are outside Git
under `run/plus/tmp/opencodeplus/r4-8-upstream-merge/logs/`.

### Type and structure checks

- Package typechecks passed for `packages/ai`, `packages/core`,
  `packages/tui`, `packages/plus`, `packages/plugin`, `packages/cli`,
  `packages/client`, and `packages/schema`.
- Root `bun run check` passed: oxlint reported 0 warnings / 0 errors and
  Turbo completed 36/36 typecheck tasks. Turbo printed its existing warning
  that it cannot parse Bun lockfile format version 2; the checks still ran
  uncached and completed successfully.
- `packages/client` `bun run check:generated` passed byte-for-byte. Generation
  was not run because this upstream delta changes no Protocol, Server HttpApi,
  Schema config, or generated-client source.
- `git diff --check` passed and the staged-diff secret scan found zero
  credential-pattern matches.

### Focused behavioral checks

- Plus Instructions and route matrix: **277 passed, 2 intentional skips,
  0 failed** across 20 files. This covers merged Take result, complete review
  diffs, level navigation, panel resizing, bulk expansion, help, agent
  controls, presets, rule state, performance, workspace/tool counts, and route
  behavior.
- Core focused matrix: **103 passed, 0 failed** across repository safety,
  repository cache/reference behavior, provider/model warming resolution and
  dynamic rescheduling, and release admission.
- AI focused matrix: **91 passed, 0 failed** across OpenAI-compatible chat,
  Gemini recorded parallel-tool signatures, and tool-stream metadata.
- TUI focused selection: **83 passed, 4 baseline environment failures** across
  pane resize, plugin runtime exports, ESC fallthrough, and inline tool
  rendering. All four failures are confined to `test/plugin-source.test.ts`:
  one pre-existing filesystem-watcher deadline and three Node-hook cases that
  execute under Bun on this host and therefore cannot import Node's
  `registerHooks`. The changed upstream TUI path is covered by the passing
  inline-tool test. Neither `plugin-source.test.ts` nor its runtime support was
  changed by this upstream delta.

## 7. Known baseline failures

- `packages/tui/test/plugin-source.test.ts`: one package-install watcher did
  not observe a change within its 3-second deadline.
- The same file's three Node graph-reload variants ran with Bun as the child
  executable and failed because Bun's `node:module` does not export
  `registerHooks`. This environment limitation was already recorded during the
  pre-merge Instructions follow-up acceptance; it is unrelated to the 14
  upstream-only paths in this merge.
- No source regression was hidden or converted into a pass. These four tests
  remain visible as baseline limitations and are outside the mandatory r4.8
  release checks unless a later release gate explicitly adds them.

## 8. Residual risks

- **No live provider call.** The Gemini thought-signature path (rows 2–6) is
  covered by unit tests and a recorded fixture replay only; no provider traffic
  was generated. Provider smoke / live acceptance remain a separate authorized
  step.
- **`flake.lock` not evaluated.** The Nix inputs were not evaluated (no Nix
  toolchain invoked); the change is the upstream lockfile update for Bun 1.4.
- **models.dev snapshot refresh.** `packages/core/test/models.test.ts` covers
  the bundled-snapshot fallback; a live catalog fetch was not performed (it is
  remote traffic and not needed for the merge).
- **www docs.** `services/www` docs were not rendered/built in a browser; they
  are covered by the package typecheck included in the root check.
- **Earlier-merge surface unchanged.** This merge only carries the 8 upstream
  commits above the previous merge point; any residual divergence from
  upstream outside these paths predates this task and was not re-audited here.

## 9. Local-only statement

Everything described here is local to this worktree/branch. Nothing was
pushed, rebased, force-updated, tagged, released or promoted; no candidate was
activated; `agents/*.json` was not changed; no Cairn/Beads operation was
performed. Release remains a separate, authorized workflow.
