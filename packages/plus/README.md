# @opencode/plus

An OpenCode V2 plugin adding an Instructions screen for viewing and customizing what each agent sees: tools, base prompts, skills, and system instructions. Plus is active in every directory; project-scoped customizations come from the nearest `.opencodeplus/project.json` upward. The server plugin (`src/index.ts`, RPC id `opencode.plus`) discovers inventory, persists customizations across two stores, and applies them through the public plugin API; the TUI plugin (`src/tui`) renders the tree, detail, diff, and splitter panes.

## Running it

`opencodeplus` runs the Instructions TUI for a directory: run it without arguments for the current directory, or pass flags and an optional project directory. Subcommands are refused; they must be run from the repository with `bun run dev <subcommand>`, because running them through the launcher would misdirect cwd-sensitive handlers. In the narrow case where a flag value happens to match a subcommand name (for example `--prompt run`), the launcher fails safe and also refuses the invocation.

Symlink the launcher onto PATH to use it from anywhere:

```sh
ln -s /path/to/repo/packages/plus/bin/opencodeplus ~/.local/bin/opencodeplus
```

The launcher executes this fork directly from source (the installed `opencode2` binary does not include Plus) and sets `OPENCODE_TUI_CHANNEL=plus` so client-local state such as open tabs remains isolated from installed `opencode2` sessions.

## Layout

The scope trees are `Project`, `Global`, and `Defaults`, followed by the `Presets` catalogue. Each scope root holds exactly **two catalogues**, `Agents` (`group:<level>:agents`) and `Teams` (`group:<level>:teams`). A catalogue owns its own population and, at `Defaults`, its own shared Settings, Compaction, and six inventory groups. A row resolved through one catalogue never reads the other's:

```
Defaults
  Agents                                             group:defaults:agents
    OpenCode / Special / Plus / User                 (unchanged agent subtrees)
    Settings · Models · Compaction · Tools · Base · Skills · System · MCP
                                                     group:defaults::<category>
  Teams                                              group:defaults:teams
    <team> > <member>                                (unchanged team subtrees)
    Settings · Models · Compaction · Tools · Base · Skills · System · MCP
                                                     group:defaults:/teams:<category>
```

A stand-alone agent inherits only the Agents catalogue's "everyone" rows; an agent launched as a team member inherits only the Teams catalogue's, then its team, then itself. The same agent can therefore resolve differently depending on which it was launched as, and the inspector names the catalogue (`catalogue: agents|teams`) on every addressed row. `Project` and `Global` carry the same two catalogue roots holding their own agents and teams; only `Defaults` carries shared inventories, because `{ level: "defaults", agent: null }` is the one address the chain falls through to.

Absent always means `agents`, so every row id and record written before the split keeps its exact meaning: `item:<level>::<itemId>` is the Agents inventory, `item:<level>:/teams:<itemId>` the Teams one, and a team member's rows carry the member's own owner path (`item:<level>:<team>/:<member>:<itemId>`) while the flat `item:<level>:<member>:<itemId>` stays the stand-alone Agents-catalogue row for the same agent. Both address the same records — only the chain they resolve through differs. On the first load after the split, every shared Defaults record is copied into the Teams catalogue so everything that applied to everyone still applies to everyone, persisted as one revision and recorded by one `migrate.catalogues` log line.

Each scope's `Agents` group has origin subgroups (`OpenCode`, `Plus`, `User`, with `Special` nested under `OpenCode`: `group:<level>:agents:native`, `group:<level>:agents:native:special`, `group:<level>:agents:plus`, `group:<level>:agents:user`, all always emitted even when empty). Agent rows keep `agent:<level>:<id>`; `add: "agent"` sits on the `Agents` group and the `User` subgroup.

The `Teams` group (`[a: add team]`) holds team rows (`team:<level>:<team>`) and member rows (`team:<level>:<team>:<member>`). Each member expands to Settings, Models, Compaction, Tools, Base, Skills, and System with working toggle/edit/reset, whether or not the team is enabled or the host registered the agent. A team's `Special` group (`team:<level>:<team>:special`) contains only the maintenance agents `compaction`, `title`, and `summary` (`team:<level>:<team>:special:<id>`). Their groups persist overrides carrying `team: { level, team }`. Group ids carry the team prefix (`group:<level>:<team>/:<member>:<group>`, or `group:<level>:<team>/:special:<id>:<group>`) so they never collide with stand-alone agent groups.

Origin is computed server-side (`special` for `title|summary|compaction`, `native` for `build|plan|general|explore`, else `user`; file-backed is always `user`, team output upgrades to `plus`) and crosses the RPC boundary on `AgentEntry.origin`. Ancestor-backed project agents are discovered through core's upward `.opencode` walk and carry `AgentEntry.ancestor: true` to suppress deletion (`actions.remove === false`, because deletion is confined to the local project). Built-in OpenCode and Special agents project under every root with row id `agent:<level>:<id>` and are not removable.

Team and member rows carry `add: "agent"`. On-disk members (project/global, or a Defaults overlay file) are removable through `team.removeAgent`; shipped Defaults members are not. Team creation asks for a name, then a team preset or an empty team. Project/Global uses the selected scope; Defaults prompts for scope.

Hidden is a visibility setting, not an origin: `general` and `explore` stay ordinary OpenCode agents. The displayed OpenCode origin keeps stored `native` row ids, API discriminators, and `group:native` filters compatible. Presets → Agents retains OpenCode and User presets (the Plus agent group stays emitted but ships empty); Presets → Teams has only Plus and User, because OpenCode ships no teams, and Plus ships exactly one team preset, `basic` (planner, orchestrator, implementer, reviewer, scout, build-seat), whose self-contained member presets are the six former Plus agent presets. A member preset names only itself: "from preset Basic › planner", never a hidden agent preset.

```
<Agent>
  Settings                   Enabled · Mode · Description · Hidden · Color · Steps
  Models                     union down the chain plus the agent's upstream model (`source` badge, the effective row `active`)
    <model>
  Compaction                 Strategy · Model · Instructions
  Tools                      OpenCode / OpenCodePlus / MCP > <server>, each with a `Code Mode` subgroup when it has Code Mode rows (namespaced below OpenCode/OpenCodePlus, flat below an MCP server)
    <tool>
      Description              (the tool's text: one section, or a group of its sections)
      Permissions              (one group per category, each holding on/off rows; see Permissions below)
        <category>
          <row>
    Other permissions        (team members only: role rows whose tool is not in this inventory)
  Base                       [a: add base prompt]
    <template>.txt           (the one matching the agent's Plus-active model is marked "active")
      <section>
  Skills                     OpenCode / OpenCodePlus / MCP > <server> / Project [a: add skill]
    <skill>
      <section>
  System                     [a: add instruction]
    Role/persona             (always first)
    <instruction>
      <section>
```

`Defaults` holds `Agents` (template agents in the same origin subgroups, then that catalogue's shared inventories: `Models` `[a]`, `Tools`, `Base` `[a]`, `Skills`, `System` `[a]`, `MCP` `[a: add MCP server]`) and `Teams` (built-in shipped teams with working toggles, whose team rows carry `add: "agent"` and whose member rows carry `add: "agent"` and expand to full agent subtrees — `add` creates at project or global scope — then the Teams catalogue's own six inventories under `group:defaults:/teams:<category>`). `a` on an Agents group or User subgroup adds an agent at that level; `a` on a team row or team member row adds an agent to that team (opening the Defaults agent template picker). `d` delete is offered only on rows whose `actions.remove === true`: project/global agents (`agent.delete`, excluding ancestor-backed agents), on-disk teams (`team.delete`, unlinking project/global team directories and removing their records, while built-in Defaults teams cannot be deleted), on-disk team members (`team.removeAgent`, unlinking project/global team member files or Defaults overlay files, while shipped Defaults members refuse deletion), shared MCP servers (`mcp.remove`), project-owned skills (`skill.delete`), user base templates (`base.delete`), project instruction files (`instruction.delete`), model candidates (`removeModelRecord` or, for an inherited or upstream row, a local tombstone), and user-created permission rules (`rule.remove`); rows without remove actions (such as tool rows, built-in agents, and ancestor-backed agents) do not bind `d` or offer it in footer hints.

Code Mode tool rows support toggle, edit, split, reset and a new **pin** (`p` toggles it, the `pinned` badge reads the resolved pin); pinning keeps a tool's full listing inline in the catalog even when the inline budget is tight. The synthetic `execute` row is an OpenCode toggle-only row whose only child is its Permissions (Limits → Tool calls per run). Code Mode and MCP tools list Permissions like any tool, but you cannot add your own rules to them: their core deny is whole-tool (Code Mode) or their resource is always `"*"` (MCP), so a rule could never match.

## Agent settings and compaction

Alongside the inventory groups above, every agent/member, Defaults entry, and
agent/member preset has **Settings** and **Compaction** categories. Shared
Defaults exposes both categories as well. See [Agent controls](docs/agent-controls.md)
for inheritance, reset behavior, and Instructions Tool examples.

- **Space** on an agent/member toggles Enabled; **Ctrl+Space** selects an
  eligible primary agent. Disabled agents stay editable in Instructions.
- **Enter** on Mode cycles **Primary → Subagent → All**. Description, Hidden,
  Color, and Steps use OpenCode's existing agent fields.
- Compaction supports **Auto**, **Local**, and **Remote**, with per-agent model
  and instruction overrides. Remote grays and locks the local fields without
  discarding their values. Unsupported provider compaction fails explicitly.
- Local compaction inherits a configured maintenance compaction model, otherwise
  the current session model. Project, Global, Defaults, and Presets use the same
  scope chain as the rest of Instructions.

## Model selection

Each agent subtree has a `Models` group after Settings (`[a: add model]` from the host catalog). Rows are the union of stored candidates down the existing chain (most-specific source wins) plus the agent's upstream model, each with a `source` badge (`project`/`global`/`defaults`/`upstream`). At most one stored row per (level, agent) carries `active`. Precedence is Project > Global > Defaults > upstream (the host configuration): a level with its own active candidate always wins over less specific levels, activating at Global never changes a Project that has its own active choice and never writes a Project record, and a candidate added at Global is listed at Project with `source: global`. The effective model resolves on the agent's runtime chain — a native built-in's Defaults row runs at Project — so the active row reads `active` when this level chose it and `active (global)` (or `active (defaults)`, `active (preset)`) when a level below chose it; the inspector's `from` fact adds `(inherited)`. When the effective model is not one of this level's listed rows, nothing here reads active and the Models group and its rows carry an `effective` fact naming the model and the level that chose it; a level never claims a model that is not the one in force. Space (or `set` with or without `active: true`) activates one candidate exclusively at that level, creating the local row when the candidate is inherited; `r` clears only that level's active flag so the chain falls through; `d` removes the candidate at that level only: a local record is deleted, while an inherited or upstream row is hidden at this level by a tombstone (`removed: true`) that also hides it from levels resolving through that node, never touching the source level — re-adding the model there clears the tombstone. The row that is currently the effective model refuses (`is the active model here: activate another model first`), because replacing it must be an explicit choice; the Models group note says that with nothing active OpenCode falls back to its host configuration, a hidden upstream row included. Enter (`editModelRow`) opens the row editor: model (`provider/model`, validated against the host catalog), variant/effort (empty = none), cache warming (`off`, `on`, a total time, or empty = inherit), the keep-alive interval (`4m`, `3m30s`; empty inherits) and the keep-alive prompt, saving at the row's level — an inherited or upstream row plants a local record like activation, and editing the effective model keeps it effective. Adding stores an inactive row and never steals the effective model. The active model reaches the host in one `ctx.agent.transform` (`applyModels` in `src/instructions/apply.ts`, which skips tombstones) and reaches sessions through `switchModel` on `session.created` / `session.agent.selected` only when the session's current model differs; manual mid-session picks (`session.model.selected`) are never subscribed to and never overridden. The per-agent base badge follows the Plus-active model rather than the upstream model, with `PromptTemplate.active` classifying `claude` and `gemini` model ids to their own base template ids (`claude` and `gemini`). The base template follows the model family automatically: the context hook classifies each request's model through `ctx.prompt.active` and applies only the template active for that request.

## Permissions

Every tool row in `/instructions` — OpenCode, OpenCodePlus, MCP and Code Mode alike — expands into two children (the host-owned `execute` row has only Permissions, and a tool that lists no permission row has no Permissions group):

- **Description** is the tool's text, what the model reads about the tool. A text with one section is a single `Description` row (enter edits it, space includes or excludes it like any section); a text with several sections puts them under a `Description` group whose inspector shows them combined.
- **Permissions** says what the tool may do: one group per category (`Commands`, `Files`, `Where`, `Parameters`, `Limits`, `Approval`, …), each holding rows you switch with space. Select the `Permissions` group or a category for a one-line summary in the inspector; select a row to read `enforced by …`, which says how that row takes effect — a core rule, a check on the tool's input, a limit, an approval, the shell environment, or the team tools themselves.

The kinds of row:

- **On/off rows.** On means permitted. Off refuses what the row names, and the model reads the row's message instead of a bare denial (`Permission denied: reading PDFs is not allowed here`). Nearly every row ships on; the ones that ship off are the tool limits, the approvals, `question` → When → In delegated team runs, `subagent` → Team members (without a team run), `team_finish` → A commit deliverable has at least one commit, and `team_followup` → Followups per child.
- **Everything else.** The first row of some categories stands for everything the other rows do not name: `Every other command` (shell), `Every other file` (read, grep), `Every other site`, and `Outside this checkout` under read's and edit's `Where`. On leaves the agent's normal answer; off refuses everything an allow row does not let through (`Outside this checkout` only concerns paths outside the checkout). These rows are checked on each call, so switching one off can never be undone by another row or a team role.
- **Allow rows.** `Temporary directories` (`/tmp`, `run/plus/tmp`) under read's and edit's `Where` matters only once `Outside this checkout` is off: while on, it keeps those directories open for that check. It opens nothing any other row or a team role keeps closed.
- **Switches.** A row with no patterns — a parameter (`Background (background: true)`), a value (a `Formats` or `Effort` row), an approval, a team setting — flips with space; enter only tells you it is a switch. An off parameter or value also leaves the schema the model is offered (direct tools; a Code Mode tool refuses it when called). An off value is refused even when the call leaves the field to the tool's default (webfetch's `Markdown`, `Medium` effort, `queue` delivery, …).
- **Limits.** A number, such as `Lines per read` 2000, `Longest timeout (ms)` 600000 or `Tool calls per run` 50. Enter asks for the number; space switches the cap on and off and keeps the number while it is off. Tool limits ship off (no cap). While on, a larger value is lowered to the cap or the call is refused, as the row's `enforced by` line says; a call that leaves a capped field to the tool's own (higher) default is capped too. The team bounds on `team_delegate` ship on (below).
- **Approvals.** `Ask me before each call` (under `Approval`, off) makes the TUI ask you before every call of that tool, and the call waits until you answer it — even when you answer another question "always" meanwhile. Answering "always" stops asking for that agent and that tool (not for other tools) until the server restarts. A delegated team run has nobody to ask, so there the call is refused instead. Browser tools and OpenCode's session tools (`session_move`, `session_rename`) have no `Approval`: no permission check reaches them.
- **Rows with patterns** (commands, paths, sites, queries) open the rule editor on enter, as below.

Rows come from the per-tool catalog (every tool's categories), the curated rules, rules mined from instruction text (listed apart, under `Mentioned in instructions`), your own rules, and a team member's own rows (see **Team rules are rows**). `edit`'s `Protected files` and `Where` also list under `write` and `patch`, which change files through the same permission; it is one row and one record whichever tool you change it under, and it keeps edit's label there. `SPEC.md` (Permission rules) lists every tool's categories.

`a` on an OpenCode or OpenCodePlus tool row that is neither Code Mode nor `execute` offers Section or Permission rule (other rows keep their direct add); a new rule lists in its tool's category (`Commands`, `Files`, `Sites`, `Search patterns`, `Agents`, `Skills`), else under `Rules`, and scope and tool derive from the tool or rule row address. `enter` on a rule row opens the rule editor (label → patterns → keywords → message, each prefilled; blank keywords derive server-side via `keywordsForPattern`, blank message clears it); saving upserts a `RuleRecord` by tool+id through `rule.update`, so editing a curated, mined or catalog row materialises a custom override of the same identity (a catalog row keeps what it is — its category, how it is enforced, its Everything else or allow role — and takes your label, patterns, keywords and message): a first write lands in the addressed row's catalogue (a Teams row makes a Teams rule; an agent-qualified row stays keyless), while a matched record keeps its stored catalogue and team, so editing a Teams rule's message never moves it into the Agents catalogue. Curated-identity policy: a stored `RuleRecord` whose `tool` + `id` matches a curated rule is treated as an override of that curated rule. This is accepted reserved-identity semantics, not an unconditional compatibility guarantee. Turning a rule OFF installs one core deny per pattern (`{ action, resource, effect: "deny" }`) for that agent and scrubs lines matching its keywords from tool descriptions, system parts, and catalog descriptions (catalog rows ship no keywords, so turning one off scrubs nothing; saving one in the rule editor derives keywords like any rule's). Every Plus rule lands in one order — a team role's defaults, then what the role lets through, then the role's refusals, and last every row that is off (even one whose pattern is `*`) — and core evaluates last-match-wins, so an off row always refuses what it matches: a team role's `allow shell *` can no longer undo a `git push` row that is off, as it could before. Rows that are not core rules (tool-input checks, limits, approvals, environment, team rows) are applied by Plus's tool hooks instead; their `enforced by` line says which. Every curated rule ships a short one-line refusal message, and a user `RuleRecord` may carry its own `message`; the deny installs it as core's `Permission.Rule.message`, so the model reads that text instead of `Permission denied: <action>`. A user rule's message wins for a custom row, a curated or catalog row falls back to the shipped one, and a mined row with no message keeps the generic refusal. `show` on a perm row returns the message and the TUI inspector prints it as `message` under `provenance`. A state-only write (`set` with `state` alone) resubmits the whole record set through the tool serializer, and every TUI write resubmits it through `toRpcRecords` (`tui/instructions/state.ts`); both preserve every rule's `message` and the `catalogue` of shared Defaults records, so toggling one row leaves unrelated rules and their catalogue identity intact. Patterns are CORE RESOURCE WILDCARDS, not regex (`*` spans any run, `?` one character); for shell the resource is the parsed command text, so `git *` also matches a bare `git`. The action comes from the per-rule `permAction` carried on the perm item by discovery (the tool's own `options.permission`), falling back to the tool id map (`edit`/`write`/`patch` share core's `edit` action, everything else uses its own id). `patch` gets no operation-scoped core rules: core's permission resource for patch is the file path only (core/src/tool/plugin/patch.ts asserts `action: "edit"`), and the hunk type never reaches the permission layer. Carrying it as an extra resource or an extra action both change decisions for existing configurations that never enabled Plus, and a targeted opt-in cannot be defined reliably against the wildcard matcher. The `edit`-action path rules still apply to patch, and patch's `Operations` rows (add, delete, move) read the patch text at the tool hook instead. Scrub keywords come only from the single `keywordsForPattern` (head plus subcommands, stopping at wildcards/flags, so `git push *` scrubs `git push` lines, not every `git` line). Generic-path mining only keeps a token that is a glob containing `/` or an extension, or a path whose last segment carries a file extension, stripping trailing sentence punctuation and source-location references. Mined candidates and catalog rows are view-time only: never persisted and never part of the publish fingerprint (only a stored state, a number or a `RuleRecord` enters it via `records`).

A host built-in agent (`build`, `plan`, `explore`, …) has Defaults scope but shows its rows under Project, Global and Defaults alike, and turning a rule off writes at the row you pressed — so the saved record carries that row's level. Every row of such an agent — tools, skills, base, system, permissions — and its active model therefore resolve at runtime the way its Project row shows them, `project → global → preset link → Defaults entries → defaults → shared`, rather than from Defaults alone: a rule turned off from the Project view installs a real host deny and its refusal message, and a Defaults entry `*` that turns shell off shows off and removes shell alike. A host agent listed under Defaults only resolves at Defaults, and an agent launched as a team member keeps its own chain and the Teams catalogue.

## Inheritance

Resolution runs Defaults → Global → Project, most specific first: `project/A → global/A → defaults/A → shared → upstream` (the global and template steps apply only when that agent exists at that level). Text and state resolve independently: the first level supplying each field wins. Pin resolves down the same chain as `enabled`: the nearest record carrying `pin` wins, else the registry default. `r` removes the override at the current level only. A state-only override never marks a node modified and never raises review, so a disabled-but-unmodified copy keeps taking upstream text silently. Unmodified nodes store nothing, so they re-resolve on every read and upstream edits propagate live with no user action.

## Review and diff

A modified copy whose upstream moved turns yellow, rolls up to collapsed ancestors as "N to review", and resolves through a three-way diff (original upstream / mine / merged result): `k` keep mine, `t` take the merged result, `e` edit the merged proposal (a clean merge is persisted as merged text; a clean fast-forward follows upstream; a conflict opens the merged editor and cannot save until the markers are gone). Sections warn independently without raising siblings.

## Sections

Derived from markdown headings, else XML-style blocks, else the whole text. A lone top-level heading that wraps the whole document (the usual `# Title` of a skill or instruction) is not repeated as an extra row: its children list directly under the item and its own body, when it has one, lists first as `Introduction` (toggling it excludes the wrapper and its children, exactly as before; it keeps the wrapper's section id, so stored records and tool addresses do not change). `s` cuts a manual split (arrows move, `b` boundary, `e` rename, `x` remove, `ctrl+s` save). A split belongs to the item at the level where it was made and resolves down the same chain; include/exclude belongs to the agent.

## Keys

Up/down move, left collapse/parent, right expand, Enter edit text (or diff on yellow review rows; on permission rows the rule editor, a number prompt on a limit or bound row — hint `enter edit number` — and on a row without patterns only a reminder that it is a switch — hint `space switch`; on a Models row the row editor — hint `enter edit model`: model from the host catalog, variant/effort, and cache warming; on a Defaults › Models row it opens the row's fields — warming time, ping interval, keep-alive prompt and default effort — and Enter on a field edits that field alone), Space toggle include/exclude (on a Models row: activate exclusively at that level; on a permission row: turn it on or off), `p` pin (Code Mode tool rows), `a` add (`a` on an Agents group or User subgroup adds an agent; `a` on a Models group adds a catalog candidate; `a` on a Teams group creates a team, taking the cursor level for project/global and prefilling the template name if chosen; `a` on a team row or member row opens the agent template flow to add an agent to that team; `a` on an eligible tool row offers Section or Permission rule scoped to that row, prompting otherwise), `d` delete (offered only on rows with `actions.remove === true`: deletes project/global agents except ancestor-backed ones, on-disk team members in project/global or Defaults overlay, shared MCP servers, project skills, user base templates, project instructions, model candidates — a local record is deleted, an inherited or upstream row is hidden at this level with a tombstone that re-adding clears, and the currently effective model refuses — and user-created permission rules; prompts for confirmation; tool rows, built-in agents, and ancestor-backed agents offer no delete), `r` reset override (`r` on a model row clears only that level's active flag), `s` split, `/` filter, `?` help, esc back. Inside the diff: `k` keep mine, `t` take merged, `e` edit merged.

## Storage

Two stores: project scope in `<project>/.opencodeplus/instructions/records.jsonl` (`level === "project"` only), global scope and Defaults in `<configDir>/opencodeplus/instructions/records.jsonl` (global and defaults levels). Each store tracks its own revision from its file header. Saves supply separate expected project and global revisions and serialize under a process-wide global gate plus the per-project gate in a fixed order, so concurrent projects cannot clobber the shared global file. Stale saves identify the conflicting store (`project` or `global`), and a save only writes and bumps the store whose routed records actually changed (a project-only save leaves the global revision untouched and vice versa). Format is v2 JSONL: a `{"version":2,"revision":n}` header line, then one canonical record per line. Customization, split, model, and rule records support an optional `team: { level, team }` field scoping the override to that team so it applies only while the team is enabled, and an optional `catalogue: "agents" | "teams"` on shared (`agent: null`) rows — absent means `agents`, so pre-split records are byte-identical. On the first load of a store where no record carries a catalogue, every shared Defaults record is copied into the Teams catalogue, persisted as one revision and recorded by one `migrate.catalogues` log line; the copies make the check false, so the migration never repeats. On load, every link naming a retired Plus agent preset (planner, orchestrator, implementer, reviewer, scout, build-seat) or a member of a retired team preset (`opencodeplus-team`, `starter`, `review`) moves to the Basic member preset the old member carried, and a preset-level customization of a retired agent preset moves onto its Basic member preset; that is persisted in the same revision and recorded by one `migrate.presets` log line. Teams already created from a retired team preset are ordinary on-disk teams and keep loading. A v1 `records.jsonl` header (no `version`) is migrated on load and the first save writes v2 to both stores, so v1 is never written and the two formats never sit side by side.

Teams: project teams in `<project>/.opencodeplus/teams/<team>/<id>.md`, global teams in `<configDir>/opencodeplus/teams/<team>/<id>.md`, Defaults overlay in `<configDir>/opencodeplus/teams-defaults/<team>/<id>.md` (same-id overlay files replace built-in members, new ids append; still `level: "defaults"`).

RPC (`src/rpc.ts`, id `opencode.plus`): `instructions.snapshot/refresh/mutate/assembled`, `agent.create/rename/delete`, `skill.create/import/delete`, `base.create/delete`, `instruction.create/delete`, `mcp.add/remove`, `model.add/remove`, `catalog.models`, `rule.add/remove/update`, `team.create/setEnabled/addAgent/removeAgent/delete/list`, `team.runs.list/stop`, `modelSettings.set`, `warming.status/set` (`team.create` accepts optional `template`; `team.addAgent` adds a member at any tier with optional `template` and optional `fields` overriding template defaults, writing `<teamdir>/<id>.md` or the Defaults overlay; `team.removeAgent` deletes a member at any tier, unlinking `<teamdir>/<id>.md` or the Defaults overlay; `team.delete` deletes a team at project or global scope, removing its directory and record; `team.list` lists discovered teams and member modes; `team.runs.list` returns runs in this namespace sorted by `lastUsed` desc; `team.runs.stop` stops any run in the namespace without ownership checks, returning `E_BUSY` when working); events `instructions.changed`, `teams.changed`, `warming.changed`. The binding contract is `SPEC.md`.

## Team tab

Arrow-down in the composer switches to the `Team` tab, which lists runs in the current namespace (not members):
- One row per run showing `id`, `role`, `state`, and `task`, newest first.
- Default view shows active runs (`working`, `idle`, `starting`, `blocked_input`, `stopping`).
- `ctrl+a` toggles between active runs and inactive runs (`stopped`, `dead`, `superseded`, `reaped`); hint bar indicates which view is active.
- `Enter` attaches by navigating to that run's session (`sessionID`).
- `ctrl+d`: stops an `idle` run, resumes a `stopped` or `dead` run by attaching to its session (the resume consumes any retained stop intent, so the run's next successful turn settles `idle`), or displays a warning message that a `working` run must be interrupted first.
- Hint bar: `move ↑↓  attach ⏎  active ctrl+a  stop|resume ctrl+d  tabs ←/→`; the `ctrl+a` hint reads `inactive ctrl+a` while inactive runs are shown, and `tabs ←/→` is the composer's own hint.

## Tools

Agent-facing Code Mode namespace `instructions` (`src/instructions/teaching.ts` pins the contract, `instructions-tools` skill carries the details). Agents call `tools.instructions.list({...})` inside `execute`, never as native tools. The tools exist in every directory; a project-scoped write creates `.opencodeplus` on demand and no tool toggles it.

| tool | input |
| --- | --- |
| `list` | `{ where?, fields?, sort?, limit?, offset? }` (`limit` defaults to 40 — every tool lists its Permissions rows, so pass a larger `limit` for an agent's perm rows; `where` accepts `item:model\|perm`, `active`, and `tool:<id>`; a tool's Description, Permissions and category groups list as `kind:group` rows after it) |
| `show` | `{ id, view? }` (`view` defaults to `resolved`; on a perm row every view but `record` returns `patterns`, `keywords`, `provenance`, `category`, `kind` (how the row is enforced: `rule`, `input`, `value`, `param`, `limit`, `approval`, `env` or `team`), `field` and `value` when the row has them, `limit` (its number) on a limit or bound row, `message` when the rule carries one, and a scrub preview; on a team or member row `resolved` returns the entity — `kind`, `level`, `team`, `enabled` + `members` for a team, or `member` + `registered` for a member — and `record` nests that entity under `record`, while every other view is refused with `view.unsupported`) |
| `set` | `{ id, text?, state?, resolve?, pin?, active?, label?, patterns?, keywords?, message?, warming? }` (`state` is `on`\|`off`; `resolve` is `keep`\|`take`\|`edit`; `pin` keeps the tool's full listing inline in the catalog; `active: true` activates a model row exclusively at that level — a bare `set` on a model row activates too; on a model row `text` replaces the candidate as `provider/model` or `provider/model#variant` (the enter editor) and `warming` sets cache warming: `off`, `on`, a total time like `45m`, or empty to inherit, while `interval`, `prompt` and `effort` set the other keep-alive fields on a model row — a Defaults › Models row (`item:defaults:/models:modeldefault:*` or `…:<provider>/<model>`) accepts all four plus `state` as its warming switch; perm rows accept `state`, or `label` + `patterns` (`keywords` optional) or `message` alone to update the rule through `rule.update` — a first override lands in the row's catalogue and a matched record keeps its stored catalogue and team — and a limit or bound row takes `text` as its number: `set({ id, text: "8" })`; text without a number is refused) |
| `reset` | `{ id }` (deletes the override at that row; on a model row clears only that level's active flag) |
| `split` | `{ id, boundaries?, add? }` (`boundaries` is `[{ id, name, start }]` with character offsets; `add: { name, text }` appends a trailing section; perm and model rows cannot be split) |
| `create` | `{ kind, ...fields }`, one row per call, returns `{ id, item, ...fields }` where `id` is the row id `show`/`set`/`delete` accept and `item` is the created thing's own id (`skill:…`, `model:…`, `perm:…`, or the agent/team/member id). Agent needs `id` + `prompt` (optional `scope`, `template`, `fields`); skill needs `name` + `body`; base needs `id` + `title` + `text`; instruction is refused pending the Context catalogue (`instruction.disabled`); mcp needs `name` + `config`; team needs `team` + `level` (optional `template` seeds members from a Defaults team); member needs `team` + `level` + `id` + `prompt` (optional `template`, `fields` — the agent fields `kind:"agent"` takes; the team name is trimmed like `team.addAgent`; `level: "defaults"` writes the Defaults overlay the TUI writes); model needs `providerID` + `modelID` (optional `variant`, `level`/`agent`; `level` defaults to `project` and project/global need an `agent`, while `level: "defaults"` with no agent is the shared Defaults row); rule needs `tool` + `id` + `label` + `patterns` (optional `keywords`, `message` — the refusal text the model reads — `level`/`agent`; `level` defaults to `project` and a rule with no `agent` is stored at that requested level but resolves through its canonical shared Defaults row). Optional `catalogue` (`agents|teams`, default `agents`) picks which catalogue a shared `model`/`rule` lands in; `base`/`mcp`/`skill` write one file both catalogues list. A project/global create returns that level's own row, never the identical Defaults row. A create whose written row cannot be found in the tree fails with `create.failed` instead of inventing an id |
| `delete` | `{ id, confirm: true }` (refused without `confirm: true`; on a model row deletes the candidate at that level — a local record is removed, an inherited or upstream row is hidden with a tombstone, and the effective model refuses with `activate another model first`; only user-created rules can be deleted) |
| `log` | `{ where?, limit?, offset? }` → `{ entries, total }`, both log files merged newest-first |

`show` views: `resolved` (default), `upstream` (text above the override), `mine` (stored text), `record` (raw override), `sections` (section ids), `diff` (original→mine and original→upstream unified diffs plus a one-line summary), `assembled` (full effective prompt, agent row ids only). `set` with `resolve: "keep"` acks upstream keeping text, `"take"` drops stored text and follows upstream, `"edit"` stores `text` against current upstream.

Row ids name one row everywhere: the TUI filter, tool calls, log targets, and error messages all use the same string:

- `item:<level>:<owner>:<itemId>` — a whole row. `<owner>` is the agent id, `''` for the Agents-catalogue shared Defaults row, `/teams` for the Teams-catalogue one, `<team>/:<member>` for a team member's row and `<team>/:special:<id>` for a team special agent's. Filter with `catalogue:agents|teams`.
- `section:<level>:<agent|''>:<itemId>:<sectionId>` — one section inside a row
- `agent:<level>:<id>` — one agent's subtree (only these accept `view: "assembled"`)
- `team:<level>:<name>` — one team
- `team:<level>:<name>:<member>` — one team member
- `team:<level>:<name>:special` — a team's Special group
- `team:<level>:<name>:special:<id>` — a team-scoped special agent
- `group:<level>:<team>/:special:<id>:<group>` — one of the five groups under a team-scoped special agent
- `model:<providerID>/<modelID>` (optionally `@<variant>`) — the `<itemId>` of a model row
- `perm:<toolId>:<ruleId>` (the rule id keeps any extra `:` it contains) — the `<itemId>` of a permission row; a catalog row's rule id is `<category>.<row>` (`perm:shell:commands.git-changes`, `perm:read:limits.lines`)
- `group:<level>:<owner>:tool:<id>:description` — a tool's Description group (only when its text has several sections); `group:<level>:<owner>:tool:<id>:permissions` and `…:permissions:<category>` — its Permissions group and one category
- `item:<level>:<owner>:perm:<tool>:<rule>@<other tool>` — a shared row listed under another tool (edit's `Protected files` and `Where` under write and patch); the same row and record as its plain id
- `perm:team_delegate:to.<member>`, `perm:team_delegate:to.other-teams`, `perm:edit:run:<runID>` — the `<itemId>`s of a team member's own rows (see **Team rules are rows**). Filter the run-scoped one with `run:<id>`. Every other team rule is a shared catalog row such as `perm:team_get_context:accepts.reason` or `perm:team_status:runs.others`.

`<level>` is `project`, `global`, or `defaults`.

Guards: a write whose actor is a tool cannot change a row belonging to an agent listed in `.opencodeplus/project.json` `protectedAgents` — through the tools, the RPC, or `instructions.mutate` — and fails with `agent.protected`; the TUI writes those rows normally. The guard covers the item-record cascade as well: deleting a rule, skill, base template or MCP server as a tool actor is refused when any protected agent holds a customization or split for that item, and the refusal is decided before anything is written. `delete` needs `confirm: true`; every successful write is logged with actor `tool`.

Log format is `Plus.LogEntry` (`src/rpc.ts`): `{ ts, actor: { type: tui|tool, agent?, sessionID?, messageID? }, op, target, summary, revision }`. Project writes append to `<project>/.opencodeplus/instructions/log.jsonl`, global/defaults writes to `<configDir>/opencodeplus/instructions/log.jsonl`. The log's own `where` grammar is small: a bare word matches over op, target, summary, and actor agent; keyed tokens are `actor:tui|tool`, `agent:<text>`, `op:<text>`, `target:<prefix>`, `session:<text>`, `since:<instant>` / `before:<instant>` (ISO date or `<n><s|m|h|d|w>` age).

## Team rules are rows

What a team member may do is not written onto the agent by the team code, and
nothing is read from its name: it is a set of instructions rows, so you can see
it, edit it and override it like anything else in the tree. A team member is
any agent of an enabled team. Every team rule is a row every agent has (the
tool's Permissions); an agent nothing sets reads it **off**, and a **preset**
sets it. Create a member from a Basic member preset (planner, orchestrator,
implementer, reviewer, scout, build seat) and it behaves like that role; name
it anything.

What the Basic member presets set (on = permitted):

| | planner | orchestrator | implementer | reviewer | scout | build seat |
| --- | --- | --- | --- | --- | --- | --- |
| `shell` tool | off | on, except changing files, commits or refs | off | off | off | on |
| `question` tool | on | off | off | off | off | on |
| paths outside the checkout (read/edit Where, `external_directory`) | on | on | off | off | off | on |
| `subagent` tool | off | off | off | off | off | on |
| read or grep secret files ¹ | off | off | off | off | off | on |
| Tavily search and extract tools | on | on | off | off | off | on |
| edit files | plan files only ² | yes | yes | yes | yes | yes |
| asks you before each delegation (Approval) | yes | no | no | no | no | no |
| start a team run from a chat | yes | yes | no | no | no | yes |
| delegate from a delegated run | no | yes | no | no | no | yes |
| `status` beyond its own run and children | on | on | off | off | off | on |
| `list` beyond its own run and children | on | off | off | off | off | on |
| `done` needs a committed worktree | no | no | yes | no | no | no |
| briefs it accepts | plan files only | need a reason | commits need scope.paths | no corrections by followup | | |

¹ keys, `.env` files, credential stores, OpenCode provider config and service
passwords, frozen team run configs and session databases.
² edit → Files it may change: `docs/plans/` and `docs/handoffs/`.

Team tools are tool rows: a planner lacks `integrate`, `set_checks` and
`check` (it keeps `checkpoint` to commit its plan file when delegated); an
orchestrator lacks `checkpoint`; an implementer keeps only `checkpoint`,
`finish`, `diff`, `get_context` and `check`; a reviewer only `finish`, `diff`
and `get_context`; a scout only `finish` and `get_context`; a build seat has
every team tool but `finish` (nobody delegates to it). A chat run (no Brief)
checkpoints what its agent may edit: its edit rows (Where, Files it may
change, Protected files) decide, never protected state such as `.git` or
`.opencodeplus`; so a build seat commits anywhere in its checkout and a
planner in the chat only its plan files. Workers have no `status`: they address
only their own run, which `get_context` describes. `followup`, `stop`,
`supersede` and `diff` never reach past a member's own run and direct children
until you turn its `Runs` rows on.

**Where a Basic member's instructions live.** Each kind of guidance has one
home, so nothing is said twice or contradicts itself:

- *Role/persona* (`builtin-teams.ts`): who does what and when. The body is
  markdown in three parts — `# Team member` (every member), `# Delegating`
  (members who delegate; it names exactly its targets' Brief rules) and
  `# <Role>` — each split into `##` sections, so the Instructions tree shows
  one section row per part that a level can turn off or rewrite alone.
- *Tool descriptions*: what a tool does and when to call it; the first line
  stands alone, because a Code Mode catalog shows only that line.
- *Input schema field descriptions* (`teams/schema.ts`): how each value must
  look — check commands, the HEAD `checkpoint` and `integrate` expect, commit
  message types, summary limits, what each report status requires — so a call
  is right the first time instead of learning from a refusal. A test keeps
  every field of every team tool described.
- *The rendered Brief and each settlement*: the facts of one run (below).

"Briefs it accepts" and "Brief limits" (under `team_get_context`) are read for
the member a brief **names**, not for the one delegating: A reason, A check,
Scope paths for a commit, Plan files only, Corrections by followup, Paths per
brief and Checks per brief. A member preset or a user edit sets them; the
shipped Basic roles keep their old answers (a planner's target accepts plan
files only, an orchestrator's target needs a reason, and so on).

Every agent also has `team_delegate` bounds that ship on — 4 children working
at once, depth 3, briefs of up to 6000 characters, 12 live team runs; in a
delegated run, which nobody watches, questions and approvals are refused
rather than left waiting. Each delegated Session's edits and checkpoints are
limited to its saved brief's `scope.paths`; `scope.forbidden` wins. Same-role
runs do not share scope. These boundaries only narrow existing permissions,
never override denial or approval, and protect Git, paused-tool and Plus state.
The listable `perm:edit:run:<runID>` row describes the individual boundary;
editing that display row does not widen the admitted brief.
Landing on a protected branch (`main`, `master`, `v2`, `ocp-main`, `release*`)
is allowed until you turn that `team_integrate` row off.

Status reports `attemptsUsed`, not a count of model calls. `turnsUsed` remains
a compatibility alias for attempts, and the existing `turns` budget likewise
counts attempts. `tokensUsed` is the public Session's cumulative total (input,
output, reasoning and cache), or `null` if unavailable, not per-attempt usage.
Status uses these totals for advisory budgets; no hard interrupt is
implied. Replayed admissions label the original `receipt` and expose a fresh
`current` observation without submitting the work again.

**Changing who may delegate to whom.** Open a member of an enabled team under
`Teams → <team> → <member> → Tools → OpenCodePlus → team_delegate →
Permissions → Delegate to`. It holds one row per other member of the same
team, named by its id and shipped off, plus `Members of other teams` (off). A
member created from the shipped Basic preset has its teammate rows on by role
(planner → orchestrator; orchestrator → implementer, reviewer, scout); a build
seat has every teammate's row on. Space turns a row on
or off. The member's `team_delegate` then offers exactly the teammates that
are on as its `role`, and a refused delegation (`E_ROLE`) names who is open.
Like any row, the change can be made at Project, Global or Defaults level.

A rule may carry a **message**, and a refused agent reads it instead of the
generic `Permission denied: <action>`. The edit-scope rows carry the two texts
the old permission hook sent — `"<pattern>" is outside your scope.paths
[…]. Report it in needs=[{kind:"path"...}].` and `"<pattern>" is
version-control or paused-tool state and is never editable, even inside
scope.paths […]. …` — every curated and catalog row carries its own (`pushing
is not allowed here`, `Private keys cannot be read here`), and a team row's
refusal quotes it after the member's id (`astra-reviewer takes no corrections
by followup: …`). A rule answers for a
pattern rather than for one call, so the quoted subject is the rule's own
resource. An `ask` rule's message arrives as `metadata.message` on the
permission request, which is what the TUI shows when it asks.

Team tools appear only under the Teams catalogue. An agent that is not a
member of an enabled team gets a `team.*` wildcard deny, so it sees no
`team_*` tool and no `tools.team.*` catalog entry in any chat — the answer to
"why can't build call this" is that build never had it, not `E_NOT_ACTOR`
(the host's own `build` agent, that is; a team member whose id ends in
`-build` is a build seat with every team tool).

## Team runs

Team tools live in `src/teams` and are registered for every Plus instance. The namespace holds thirteen tools that all work —
`delegate`, `finish`, `followup`, `integrate`, `checkpoint`, `set_checks`,
`supersede`, `stop`, `status`, `get_context`, `diff`, `list` and
`check`. There is no `wait`: a parent ends its turn and each child's
settlement wakes it (below). Nothing advertised returns `E_NOT_IMPLEMENTED`. `team_diff` is a
read-only `git diff` of your own run or one of your children (further only
when your `Runs` rows on `team_diff` allow it), truncated to `maxBytes`
(default 200000) with `truncated: true`.

A planner, orchestrator or build member opening a fresh chat and calling any
team tool creates a root `main` run bound to that session automatically. There
is no `prepare`. A session with no location / no repository directory calling any team tool gets
`E_NOT_ACTOR: This session has no repository directory; open the chat in a git repository to use team tools.`
and writes no run record. Root-run bootstrap executes only when `git rev-parse --show-toplevel` succeeds.

A run's state follows its host session rather than the
agent's good manners: `index.ts` subscribes to `session.execution.succeeded`,
`session.execution.failed`, `session.execution.interrupted` and `session.execution.started`, maps the
session to its run, and `teams/lifecycle.ts` settles the attempt, moves the run
to `idle`, notifies the parent once and hands the pending inbox to the session
as one new attempt. `session.execution.succeeded` is the host's canonical
success event (`SessionEvent.Execution.Succeeded`); `session.idle` is a
deprecated compatibility alias that settles identically. On
`session.execution.started`, a run in `idle`, `starting`, `stopped` or `dead`
transitions to `working` (`prompt` for idle, `resume` for others), following the session into its execution turn.
Resuming a `stopped` or `dead` run consumes the `stopRequested` intent its own stop already
satisfied, so the resumed turn settles `idle` instead of stopping again; a stop intent on a run that
has not stopped yet is still honoured at settlement. A `working` run is a no-op; `superseded`/`reaped` runs remain unchanged.

- A child whose model turn ends is `idle` whether or not it called
  `team_finish`. Without a report, its attempt is `no_report` — unless the run
  still has an open child (one that holds a slot: `starting`, `working`,
  `blocked_input`, or itself idle and waiting) or an undelivered settlement
  from one. Then the run is *waiting*: the attempt stays open, nothing is
  announced to its parent, `team_status` lists the open children in
  `waitingOn`, and the next child settlement is delivered into the same
  attempt. A run therefore ends an attempt without a report only when it has
  no children left to hear from.
- `stop` and `supersede` are the only ways to halt a child. `team_stop` on a
  working child asks it to stop after its turn (setting `stopRequested` and
  returning `state: "stopping"`), completed by `onSessionIdle`; `team_stop` on
  an idle child stops it now; both are idempotent. Stopping a waiting run ends
  its open attempt `interrupted`; its parent is told once, unless the parent is
  the run that stopped it. Resuming a stopped or dead
  run through its session consumes the retained `stopRequested`, so the first
  successful turn after the resume stays `idle` instead of stopping again.
- `team_followup delivery:"now"` works with no tool call from the child.
- `team_get_context` on a root run returns `brief: null` rather than failing
  `E_NO_BRIEF`. The `conventions` field has been removed.
- `team_followup` with the default `delivery:"queue"` against a working child
  is delivered when that child next goes idle, as a new attempt.
  `delivery:"now"` against a working child refuses with `E_BUSY` and
  `accepted: {"delivery":"queue"}`.
- A settled child puts one `child.settled` item in its parent's inbox: the
  run, the attempt and the status, then the whole report (summary, commits,
  checks, uncommitted files, needs, concerns, deferred, findings) and one
  `next:` line for what that outcome calls for (land a commit, weigh concerns,
  answer needs, re-scope a rejection, inspect a run that ended without a
  report). The parent needs no call to read the report file. It is sent once
  (`notified` on the attempt). An idle parent is prompted with it now; a
  working parent gets it through its own idle handoff.
- The Brief a child receives (`brief.ts`) has no empty sections; says what
  done means for its deliverable; marks a read-only task as such; states the
  budget as a guide, not a limit (tokens and time; Plus never stops a run over
  budget); and attaches a `briefFile` inline up to 40 KB — the only way an
  uncommitted file reaches a child, whose worktree starts at the parent's last
  commit. A `findings` Brief gains a Review section: the exact `team_diff`
  call that shows the change (from the delegating run's base to the
  reviewer's own start) and the delegating run's check results there, since a
  reviewer can neither run checks nor read another run.
- `team_integrate` that does not land returns the real state: `conflict`
  (with `conflictFiles`) or `red` (with `redChecks`), the `reworkTask` id a
  fresh child's Brief claims in `task`, and a `next` line; `paused` when the
  queue waits for a clean parent.
- `team_get_context` reports the worktree's live `head`, the value
  `checkpoint` and `integrate` compare against.
- A `finish` finding's severity is `error`, `warning` or `note` (a located
  fact, how a scout answers).
- One sweep tick (`lifecycle.startSweep`, `policy.sweep.tickMs`, default
  2000 ms) carries dead-run reconciliation and worktree garbage collection (`gc`),
  forked on the plugin scope so it stops with the plugin.
- Child worktrees are removed on landing via `team_integrate`, keeping the branch ref,
  run record, reports and receipts intact while marking `worktree: "removed"`.
- Tool inputs accept explicit `null` for optional fields (`task: null`, `scope.forbidden: null`, `findings: null`, etc.) as equivalent to omission at every depth: array elements (`checks: [{ id, argv, cwd: null }]`) and fields behind optional/default wrappers (`context: { interfaces: null }`, `followup({ budget: { turns: null } })`) included; `null` on required fields strictly produces a schema validation error.
- In-flight bounds (`E_BOUNDS`) count only live runs in `starting|working|idle|blocked_input` whose `sessionID` is not null. A run superseded because session creation failed never counts against bounds. The bounds themselves are the member's `team_delegate` → `Limits` rows, and the refusal says to end the turn and delegate after a settling child wakes the caller.
- Runs in `stopped` or `superseded` state past `policy.gc.reapAfter` (e.g. `7d`) without
  open merge entries or promoted runs are transitioned to `reaped` and their worktrees removed.
  Superseded worktrees are removed with `--force`; dirty stopped worktrees are skipped and
  marked `worktree: "dirty"`.
- A run is reported `reaped` only when its worktree is really gone. A removal that fails — a
  git-locked worktree is the usual case — leaves the run's state and `worktree` value alone,
  keeps it claimed so the orphan scan skips it, and names it in the pass's `removeFailed`
  instead of `reaped`; a later tick reaps it once removal works. One GC pass returns
  `{ reaped, skippedDirty, orphansRemoved, removeFailed }`, and `sweep` returns it as
  `{ dead, gc }`.
- Orphan worktrees are pruned on the same sweep tick, but only **inside the team's own
  worktree root for that repository** (`<teams data dir>/worktrees/<repoKey>`, where
  `team_delegate` creates them). Any other worktree of the same repository — your own
  checkout of it — is never a candidate and is never removed.
- Provisioning a child and the orphan scan are mutually exclusive on the repository lock.
  `team_delegate` runs `worktree.provision`, which holds that lock across `worktree.create`
  **and** the write of the starting run record, and `gc`'s orphan step takes the same lock
  while it re-lists run records and removes candidates — so no sweep decision can be made
  from a stale record snapshot, and no worktree can be swept between its creation and its
  registration. As a second bound, `worktree.orphans(..., { minAgeMs })` treats any candidate
  younger than `policy.timeouts.startMs` (default 60000 ms) as owned: a directory that may be
  mid-provision is left for a later pass instead of force-removed, and an abandoned one is
  swept once it is older than that bound.
- `team_list` and `team_status` indicate worktree state (`present`, `removed`, or `dirty`)
  for each run; `team_status` reports it beside its live `dirty` read.
- A run's `worktree` state belongs to whoever removes the directory, and a
  stored `removed` is final: `saveRun` keeps it against any later full-record
  write (`present`, `dirty` or an omitted field) while still applying every
  other field that write supplied; `team_integrate` marks a landed child's
  directory removed, and the settle passes (`reconcile`,
  `session.execution.started`, `onSessionIdle`) and inbox delivery
  (`deliverInbox`) read and write the record through `run.updateRun` in one
  `state` lock hold. This is a field-level guard for `worktree` only; other
  fields written from a stale copy can still be overwritten.
- Every gated team tool invocation writes an HMAC-SHA256 authenticated `tool.call` record
  to `<teams data dir>/audit.log` (key at `audit.key`, mode `0600`).
  Records contain `seq`, `at`, `kind: "tool.call"`, `run`, `actor`, `sessionID`, `tool`, `ok`,
  `code`, `durationMs`, and `outcome`.
  - `outcome` values: `"allowed"` (call permitted without human intervention), `"asked:allow"`
    (call asked human approval and was approved in TUI), `"denied"` (call refused at call time
    by rule with `code: "E_PERMISSION"`), and `"asked:deny"` (call asked human approval and the
    human rejected it in the TUI, with or without feedback, with `code: "E_PERMISSION"`).
  - Who writes which: `"allowed"` and `"asked:allow"` come from `runGated`, which only runs once
    a call is authorized. `"asked:deny"` comes from the `permission.replied` observer on a
    `reject` reply, covering both human rejections — a rejection without feedback leaves no other
    trace, because core answers it with `DeclinedError`, a deliberate defect that fires no
    `tool.execute.after` hook. `"denied"` comes from the `tool.execute.after` observer, and only
    for refusals that are not `Permission.CorrectedError`, i.e. rule denials, for which no
    permission request ever existed. The split writes exactly one line per refused call.
  - State is per invocation, never per CallID: under Code Mode one `execute` runs every inner team
    tool against the same `Tool.Context`, so two calls can share one CallID and messageID. In-flight
    state is a FIFO queue keyed by `(sessionID, messageID, CallID)`, each call claims its own entry,
    and the reply observer writes the line for the invocation its request named — so a sibling that
    completes first cannot consume a pending call's refusal line.
- Project customizations resolve **upward**: `project.read(directory)` walks parent directories to the
  nearest `.opencodeplus/project.json` and answers the defaults when there is none, so every session is
  always active. A legacy config carrying `enabled: false` is just the nearest config: it stops the walk
  and supplies whatever it holds. `project.ensure` writes the defaults only when no config exists at or
  above the directory, so an inherited `protectedAgents` is never shadowed by a child write. The
  `.opencodeplus` directory itself appears only when a project-scoped write happens there: a project
  store change, a project log line, or a project-level team create/add.
- Team worktrees are not Plus projects: `team_delegate` writes no `.opencodeplus/project.json` into a
  child worktree, and removal is a plain `git worktree remove`. The child's run records the parent's
  project directory as `projectDirectory` **before the host creates the session**, and Plus activation
  for the child session resolves the project through that directory (the worktree itself sits outside
  the parent's tree). Registering the starting run first also keeps the periodic GC from collecting the
  new worktree as an orphan in the window before the record would otherwise be written, and `snapshot`,
  `mutate` and the other RPC methods resolve the same directory as activation, so a child chat sees and
  edits the project it inherited.
- `worktree.create` returns the canonical directory and creates its parent chain before `git worktree
  add`, so the first delegate in a brand-new data root hands the host a directory it can `realpath`.

The binding contract for the tool surface is `SPEC.md`.

## Fork touch surface

Every place core changed for this feature, and why the plugin API could not do it:

- `packages/schema/src/tool.ts` — `Tool.Info.origin?: { type: "mcp" | "plugin"; name }`. Registration keeps only whitelisted fields and the namespace sanitizes the server name irreversibly, so no plugin could recover the real server for grouping. (`packages/core/test/tool-origin.test.ts`)
- `packages/core/src/tool/mcp.ts` — passes the real server name as `origin` at registration. (same test)
- `packages/core/src/instruction-discovery.ts` + `packages/core/src/session/context.ts` — one `Instructions.Source` per file keyed by path and one system part per file, instead of every file merged into a single part with no source identity. The plugin editor alone could not restore boundaries core had already erased. (`packages/core/test/instruction-source-parts.test.ts`)
- `packages/core/src/prompt-template.ts` + `packages/core/src/plugin/*` — a `PromptTemplate` registry (templates plus active-for-model) exposed as `ctx.prompt`, so the active base prompt is knowable and selectable; it used to live only inside core internals. `PromptTemplate.raw(model)` owns the per-model raw-text selection (including gpt-6 → `gpt-astra.txt`), shared by the OpenAI optimize plugin and exposed as `ctx.prompt.raw`, so Plus aligns tool guidance against the template core actually rendered rather than the classification's canonical template — otherwise a customized gpt base silently wipes astra-rendered guidance on gpt-6 requests. (`packages/core/test/prompt-template.test.ts`)
- `packages/plugin/src/effect/instruction.ts`, `prompt.ts` — the public plugin surface for the two above (`ctx.instruction.transform`, `ctx.prompt`).
- `packages/cli/src/util/process.ts` + `packages/cli/src/services/standalone.ts` — a real bug fix, not a feature seam: a background server inherited the caller's working directory, breaking `opencodeplus` and `bun run dev <dir>`; `serviceDirectory()` returns the package root holding `tsconfig.json`. (`packages/cli/test/self-command.test.ts`, `packages/client/test/service-contender.test.ts`)
- `packages/client/src/effect/service.ts` + `packages/client/src/promise/service.ts` — `ensure()` records a non-zero contender exit as a pending failure and stops spawning replacements until live contenders drain, so a real startup error (for example a port conflict) surfaces instead of being outrun by its own replacement. A zero exit, the legitimately elected loser, keeps the previous backoff. Both implementations were changed identically without touching Protocol, HttpApi, or generated client surfaces. (`packages/client/test/service.test.ts`, `packages/client/test/promise-service.test.ts`)
- `packages/cli/src/server-process.ts` — `recognizeIncumbent` probes `/api/health` once before its retry loop and fails fast when the port answers 200 with a body that provably fails to decode as the health shape, so a foreign occupant no longer costs 15 seconds of silence. (`packages/cli/test/service.test.ts`)
- `packages/core/src/tool.ts`: `Tool.snapshot` now drops a tool when its own id is wholly denied, not only its permission group, so a single Code Mode tool can be excluded for one agent. (`packages/core/test/tool-origin.test.ts`)
- `packages/plugin/src/effect/session.ts` + `packages/core/src/session/context.ts`: a `session.catalog` hook fired inside `SessionContext.select`, letting a plugin rewrite each agent's Code Mode catalog descriptions and pins. The registry editor is global, so `editor.update` would change one description for every agent and, because discovery reads the host back, would flip the publish fingerprint into a dispose/reinstall loop. (`packages/core/test/session-catalog.test.ts`)
- `packages/core/test/tool-patch.test.ts` — test fixture only (a `.git` marker inside the fixture's own temp directory so `Project.root` resolves deterministically); no core source change.
- `packages/plus/test/team2-contract.test.ts` — team2 agent-file contract: pins the agent-file format produced by an external repository's team2 agent writer.
- Loading wiring only: `PlusPlugin` appended last in `post` (`packages/core/src/plugin/internal.ts`), `Plus` in the TUI `builtins`, workspace deps in `core`/`tui` `package.json`.
- `patches/@opentui%2Fcore@0.5.10.patch` — the stdin parser must decode in the keyboard protocol the terminal was actually put in. opentui's native side writes the kitty query `CSI ? u` in its capability block and answers *any* reply (`CSI ? <flags> u`, measured for flags 0, 1 and 31) by pushing kitty on (`CSI > 5 u`); the reply's flags report the state *before* that push, so a fresh kitty terminal answers `0`. The patch therefore keeps the parser in the pushed protocol, follows the native `kitty_keyboard` capability up after capability replies that arrive inside the 5 s capability window (`followKittyKeyboardPush`; `capabilityTimeoutId` unregisters `capabilityHandler` after that, so a later reply is dispatched to no handler and never re-pushes — the test `a kitty answer after the downgrade re-pushes kitty, so parsing follows it back up` only exercises the inside-the-window case because its `ManualClock` advances 300 ms and never reaches 5 s), and downgrades to legacy only when the query goes unanswered for 300 ms — clearing the pushed flags with `disableKittyKeyboard()` so push and parse stay equal. It also holds a lone ESC for `stdinParserEscTimeoutMs` (default 50 ms, set by the TUI), flushes ESC-ESC immediately, and clears the ESC-recovery flag once escape dispatches. `resumePendingTimeout` unpauses unless the pending bytes are genuinely a pixel-resolution prefix (`hasPendingPixelResolutionResponse()`), instead of only when nothing is pending. This is hardening against an unguarded pause/resume: both renderer pause sites are already guarded by the same predicate and every consumption path clears the flag, so the old asymmetry is not renderer-reachable — it is not the cause of the reported lone-ESC tap failure, which remains open. Reading a zero flags reply as "no kitty" decodes every key into an empty name and takes all keyboard input away (reverted in `39cb2ade5`). Legacy parsing also accepts the kitty Escape encoding (`CSI 27 u` and `CSI 27 ; <mods> : <event> u`, press/repeat deliver, release does not), because a terminal left in kitty mode while the parser downgraded would otherwise lose Escape entirely — measured in a live pty, where the mismatch swallowed every Escape with no key event and no text leak. Upstream: `anomalyco/opencode#37692`, `anomalyco/opentui#818` / PR `#819`. (`packages/tui/test/stdin-esc.test.ts`)

## Boundaries and known limits

Only what is provably impossible, with what was tried:

- **The `execute` row is host-owned.** Core synthesizes the tool, so there is no upstream description to edit and the row is toggle-only; turning it off installs a deny for `execute`, which removes Code Mode (and its catalog instruction) for that agent.
- **Token counts on Code Mode rows are approximate.** Only the first description line, truncated at 120 characters, is counted, and the host-generated signature part of the catalog line is not counted — that is why the number is an approximation of the real cost rather than the whole stored text.
- **User-created base templates can never become active.** `ctx.prompt.active` only ever answers with host template ids (`packages/core/src/prompt-template.ts`). Because `applyBasePlan` matches candidates strictly against `activeByAgent` (`packages/plus/src/instructions/apply.ts`), custom user base templates never reach `system[0]`; in the tree, user base templates are marked `inactive` (`packages/plus/src/instructions/tree.ts`).
- **Discovery unmasks Plus's own output.** Discovery reads the host after Plus's transforms are installed, so reporting that text as upstream flips the publish fingerprint every pass into a dispose/reinstall loop. Plus retains per-item applied/upstream baselines (`src/instructions/inventory.ts`, captured in `src/index.ts`) and rereads file-backed agent bodies instead.
- **Every client-facing RPC error must be declared** in the `Definition`, because core's `encodeError` dies on undeclared ones (`packages/core/src/rpc.ts`).
- **Never send an optional key whose value is `undefined` across the RPC boundary.** Results are validated as JSON, so the whole call fails with HTTP 400. Omit the key instead. `expectRpcBody` in `test/rpc.test.ts` guards this.
- **Upstream permission denials are invisible.** `ctx.skill.list()` and the tool editor list return the full inventory without agent permission evaluation (core filters later in `packages/core/src/skill.ts` and `packages/core/src/tool.ts`), and `Item.available` is one boolean per item, not per agent. A denied row shows `[enabled]` and toggling it is a no-op upstream. Threading per-agent availability through discover, model, tree, and RPC was cut as disproportionate. No test currently pins this.
- **Async MCP tools regain customizations at the next publish, not on reappearance.** Core reconciles MCP tools behind a 100 ms debounce plus `tools.reload()` (`packages/core/src/tool/mcp.ts`), which emits none of the events Plus watches (`agent.updated`, `skill.updated`, `config.updated`). Closing it needs a public post-reconciliation inventory notification.
- **Custom rules are globally unique by tool+id, not per level/agent.** `rule.add`/`rule.remove`/`rule.update` match existing records by `(tool, id)` only, so a second level or agent cannot define its own rule with the same tool+id.
- **The TUI add-rule flow prompts for scope.** `a` on an eligible tool row or a permission row defaults to that row's level/agent and otherwise prompts for level then agent (mirroring add-model); the dialog calls `rule.add` with the chosen scope, shared (`agent: null`) or per-agent.
- **A rule's message is the model-visible refusal.** Curated rules ship one; user rules may set one through `rule.add`/`rule.update`, `create kind:"rule"`, or `set` with `message`. `apply.ts` installs it on the core deny, so the model reads it instead of `Permission denied: <action>`; blank clears it, and a `rule.update` that omits `message` preserves the stored text.
- **MCP and Code Mode tools take no user rules.** An MCP tool's resource is always `"*"` and a Code Mode deny is whole-tool, so a per-resource core rule would never match; `a` offers no Permission rule there. Their Permissions list the catalog's rows, which Plus's tool hook checks against each call's input, and the row toggle still turns the whole tool off.
- **`write`/`edit`/`patch` share one enforcement action.** Core asserts `action: "edit"` for write/edit/patch (core/src/tool/plugin/edit.ts, write.ts, patch.ts); Plus carries the tool's `options.permission` as `permAction` and falls back to that map. That is why edit's `Protected files` and `Where` rows list under write and patch too.
- **Path-scoped search is a tool-input check, not a core rule.** Core authorizes `input.pattern`, not the search path (core/src/tool/plugin/grep.ts:87-89, glob.ts:68-70), so a core rule (the `Search patterns` rows) can only match search text mentioning a string (e.g. `*node_modules*`), never a directory walk like `grep({ pattern: "HEAD", path: ".git" })`. The `Search roots` rows of glob and grep, and grep's `Files` and `Include filters` rows, read the call's `path` and `include` in Plus's tool hook instead, and grep drops the files its `Files` rows hide from its results. glob has no `Files` rows: it lists names only.
- **Operation-scoped patch restriction is not expressible as a core rule.** Core's permission resource for patch is the file path only (core/src/tool/plugin/patch.ts asserts `action: "edit"`), and the hunk type never reaches the permission layer. Carrying it as an extra resource or an extra action both change decisions for existing configurations that never enabled Plus, and a targeted opt-in cannot be defined reliably against the wildcard matcher. The `edit`-action path rules still apply to patch; patch's `Operations` rows (add, delete, move) read the patch text in the tool hook, and a plain update has no row of its own.
- **Browser tools and OpenCode's session tools cannot ask first.** No permission check reaches them (they carry no plugin origin), so they list no `Approval`; their other rows are still refused in the tool hook. A browser tool acting on a tab judges the page the browser last reported for that tab, and a tab whose page is not known yet passes unless `Every other site` is off.
- **Shell file writes and network use are best effort.** The shell rows match each parsed command's text, so `>`, `tee`, `cp`, `nc`, `rsync` and the other forms a row names are refused while that row is off, but a script, an interpreter running a file, or a program no row names can still write files or connect.

## Shortcut

- `ctrl+x p` (`<leader>p`) opens the Instructions screen (the `plus.instructions.open` command).
- Commands live in the `Project` group and are reachable from the command palette:
  - `plus.instructions.open` ("Instructions", `<leader>p`, slash `/instructions`): opens the Instructions screen; pressed while it is already open it is a no-op.
  - `plus.agent.create` / `plus.agent.rename` / `plus.agent.delete`: agent file actions.
  - `plus.team.select`: opens the agent picker filtered to teams.
- `ctrl+x k` (`<leader>k`, `plus.warming.toggle`, group `Session`) switches cache warming on or off for the current chat; `plus.warming.follow` (palette only) returns the chat to its model settings.
- `ctrl+x j` (`<leader>j`, `plus.compact.cold`, slash `/compact-warm`) switches compact before cold on or off for the current chat.

## Cache warming

Core can keep a chat's provider prompt cache warm with keep-alive requests after each reply (the `warming` configuration). "Warm" means the cache window after the chat's latest real reply; "ping every" is the idle time between two keep-alive requests. Plus decides both per chat:

- **Defaults › Models**: a category next to Agents and Teams with one **Every model** row and one row per model Plus knows (stored rows, agent models, and models opencode.json configures). Each row opens with `→` (or Enter) into four field rows, each stored per row and inherited field by field: **Warming** (`off`, `on`, or the total time such as `45m`, `2h`, `1h30m`; 1m to 24h), **Ping every** (30s to 24h, e.g. `4m` or `3m30s`), **Keep-alive prompt** (the text pinged), and **Effort** (the variant a model row without one runs with). Enter on a field edits only that field; blank clears it and `r` resets it. A field row shows its effective value and, when inherited, where it comes from (`every model`, `opencode.json`, `built-in`); the model row shows `warm 32m · every 4m`. The every-model row is the base for models that do not set a field themselves.
- **Whole pings**: a warming time is always a whole number of ping intervals, rounded up: `30m` with a `4m` ping is saved and run as `32m`, so the window ends on a keep-alive rather than part-way to the next one. Saving a Defaults › Models row rounds its own time against the interval it resolves to; where the time and the interval come from different rows (or opencode.json), resolution rounds the same way.
- **Per agent and model, per level**: Instructions → an agent → Models also carries the same fields on each model row (`off`/`on`/total time, plus ping interval and prompt), stored at the level you are on, so a project can keep one agent warm for 3h on a model while another agent on the same model gets 20m, and another project keeps the global value. The row shows `warm 2h`.
- **Per chat**: `ctrl+x k` switches warming on or off for the current chat, overriding every row above; the switch survives restarts.
- **Countdown**: under the prompt, `cache warm · 23:41 left` counts down to when warming stops (the total time after the latest reply). When it runs out the footer stays and shows `cache cold` in the warning colour until the next reply starts a new window.
- **Compact before cold**: `ctrl+x j` (`<leader>j`, `plus.compact.cold`) or `/compact-warm` switches it per chat; it is off in every new chat. While on, `compact before cold` shows at the left of the prompt footer, and an idle chat compacts right before its cache goes cold — at the end of its warming window, or one ping interval after the last request when warming is off — so the summary request still reads a warm cache and the next message starts from the compacted context. That compaction's own request neither starts a new warming window nor schedules another compaction; the next real request does. A running chat is never compacted from here, and the switch survives restarts.
- **Sending into a cold cache**: while the footer shows `cache cold`, the first Enter holds the message and the footer asks `cache cold · enter again to send`; a second Enter within 5 seconds sends it, since the reply rebuilds the whole prompt cache.

One field resolves down, most specific first: the agent's model row → Defaults › Models › that model → Defaults › Models › Every model → opencode.json for that model or its provider → the built-in defaults (off). The chat switch wins over all of them. Nothing Plus-side set leaves opencode.json unchanged; `25m`/`90m` there still applies, and a Plus row setting only the interval keeps the configured total time.

### The interval and the provider's cache lifetime

A keep-alive only helps while the provider's cache still holds the prefix, so the interval has to stay under the provider's cache lifetime — otherwise every ping pays for a fresh cache write. The providers this workspace talks to differ:

| Provider | Cache lifetime (idle) | Sensible ping interval |
| --- | --- | --- |
| Anthropic (Messages API) | 5 minutes by default; refreshed when the cached prefix is read (at extra cost, 1 hour with `cache_control`'s 1h TTL) | ~3–4 minutes, refreshed on every reply |
| OpenAI (GPT-5.6 and later) | `prompt_cache_options.ttl`, at least 30 minutes after the latest write or reuse; earlier models: `prompt_cache_retention` `in_memory` (~5–10 min) or `24h` extended | ~25 minutes for the 30-minute TTL, ~4 minutes for `in_memory` |
| OpenAI-compatible gateways (CLIProxyAPI, and the GPT variants routed through it here) | whatever the upstream applies; frequently the 5–10 minute in-memory window | keep it as short as the Anthropic row unless the gateway documents more |
| Google Gemini | implicit caching per request; explicit `cachedContents` carry their own TTL | explicit caches: under the TTL; implicit: a few minutes |
| DeepSeek (and this workspace's DeepSeek routes) | disk prefix cache, enabled by default and automatic; best-effort, and entries not seen for hours to days are cleared. There is no cache-control call and nothing to refresh | none — leave warming off. A ping every few minutes cannot extend a cache that already lives for hours, and each ping is a paid read. If a very large context must survive a known short gap, an interval of tens of minutes is plenty |
| Zai, Mistral, others | no server-side prefix cache to keep warm | warming adds cost without a cache benefit; leave it off |

Anthropic refreshes a 5-minute cache on read, which is why the round trips here work with 3.5-minute pings; OpenAI's 30-minute TTL needs no faster ping than ~25 minutes; DeepSeek's disk cache lasts for hours to days on its own, so it needs no keep-alive at all — warming it mostly pays for reads that would have hit anyway, and a cold prefix is simply re-cached by the next real request at cache-miss input rates (no separate write fee, no TTL to refresh). A per-model row in Defaults › Models (or the model's own opencode.json `settings.warming`) is the way to give one model a different interval from the rest.

Keep-alive requests are real provider requests and cost tokens (cache reads are cheap, cache writes are not).

## Tools

What tools each agent uses and what they cost in tokens, live and kept for later comparison.

- **Where**: a `Tools` tab in the session composer, next to Subagents, Shell, Terminals and Team (open the composer, `←`/`→` to the tab; it is taller than the native tabs, so selecting it grows the composer), scoped to the chat and every session it delegated to; and a full-screen `/tools` (palette: "Tools: calls and tokens", or `M` in the tab) for history, grouping and comparisons.
- **What it shows**: totals (steps, calls, failures, running, input/cache/output tokens, cost when the provider reports it), the top groups and the latest calls with what each touched (a shell command's program and subcommand, a file path, a pattern, a host; never contents or full commands).
- **Tokens per call** are attributed, because providers bill per step (one LLM call), never per tool:
  - `call` — the step's visible output tokens, split across its text and each call's input by size.
  - `result` — what the result added to the next prompt: the next step's prompt growth minus this step's own output, split across its results by size. When no clean next step exists (a user message, compaction or instruction update in between, or the last step) it is estimated at 2.5 characters per token and marked `~`; on this workspace's real sessions 96 % of results are measured.
  - `carried` — the result re-read by every later step until the next compaction. This is where most tokens go: a large `read` result is paid for again on every step after it.
  - `+n` counts Code Mode calls made inside an `execute` call (their tokens belong to the execute call); `*` marks a call still running.
- **Keys**: `g` group by tool / agent / model / target / session / config (the project and global instruction revisions in force), `s` scope (this chat + delegated / this project / everywhere), `t` window (all, 15m, 1h, 24h, 7d, 30d), `o` order, `a` / `f` / `F` filter by agent / tool / model, `x` failed calls only, `c` compare (off / previous window / before and after the latest mark), `m` mark this moment, `↑↓` + `⏎` drill into a row (a tool into its targets, an agent or model into its tools, a session into its own tree), `⌫` back. Settings persist; drill-downs do not.
- **Tools**: `monitor.query` (scope defaults to the calling chat; `window: "24h"`, filters, `group`, `compare: { window }` for the previous period) and `monitor.mark`, in Code Mode.
- **Storage**: `monitor.db` (SQLite) next to the teams data in the XDG data directory, shared by every directory's Plus instance. It keeps facts only — steps with token usage, calls with sizes, attributed tokens and targets, session parent links (subagents from the host, team runs from the run records), compaction epochs, marks — plus an hourly rollup kept by triggers so wide windows stay fast. Rows older than 90 days are dropped at startup. It records from the moment this release runs; earlier sessions are not imported.
- **Limits**: title-generation usage is not a step and is not counted; a result's tokens are measured against the next prompt of the same session, so parallel results of one step share that growth by size.

## Development notes

- **Portable RPC schemas**: The TUI promise client requires `Rpc.PortableDefinition`; bare Effect schemas do not structurally satisfy it, so `src/rpc.ts` wraps its schemas with `Schema.toStandardSchemaV1`. Note that the Effect `RpcApi` used elsewhere (e.g. `packages/desktop`) accepts a plain `Definition`, which is why the two clients differ.
- **Agent markdown body and frontmatter**: Agent markdown files put the prompt in the **body** (core decodes `{ ...frontmatter, system: body }`); any frontmatter key outside `ConfigAgent.Info` plus `variant` silently routes the file through the legacy V1 migration path. Prompts must not be serialized into a `system` frontmatter property.

## Tests

Tests must be run from `packages/plus`, never from the repository root (a root execution guard prevents running tests from the root):

```sh
# Run focused tests
bun test test/model.test.ts test/tree.test.ts
bun test test/store.test.ts test/sections.test.ts
bun test test/agents.test.ts test/rpc.test.ts test/rpc-contract.test.ts
bun test test/apply.test.ts test/discover.test.ts
bun test test/route.test.tsx test/instructions-panes.test.tsx test/instructions-diff-split.test.tsx

# Run package typecheck
bun run typecheck
```

## Search MCP server

Plus ships a built-in local MCP server providing code and web search tools (`src/search/mcp.ts`, `src/search/bin.ts`, `src/search/register.ts`):

- **Activation**: If the host has no MCP server named `search`, Plus registers its local stdio server command (`[process.execPath, <path to bin.ts|bin.js>]`) and reloads MCP. If an MCP server named `search` is already present, Plus leaves it alone and logs `search MCP already configured; not replacing`. The registration disposes cleanly on deactivation.
- **Tools**:
  - `exa_code_search`: code search over GitHub repos, docs, Stack Overflow, and blogs via Exa.
  - `tavily_search`: web search via Tavily.
  - `tavily_extract`: clean web content extraction from URLs via Tavily.
  Under the `search` server name, core exposes them as `search_exa_code_search`, `search_tavily_search`, and `search_tavily_extract`.
- **Keys & authentication**: Keys are read at call time from key files under the Plus data directory (`<XDG_DATA_HOME>/opencode/opencodeplus/search/{exa,tavily}.key`, file mode `0600` strictly enforced, value trimmed), falling back to `EXA_API_KEY` and `TAVILY_API_KEY` in the process environment. No key is ever written to a config file, a row, a log, a report, or a commit. If a key file has insecure permissions (mode not `0600`), the tool call returns an error. A missing key returns a tool error result `{ error: "<KEY> is not set in the host environment" }` with `isError: true`.
  For `bin/opencodeplus`, place the key files in `<XDG_DATA_HOME>/opencode/opencodeplus/search/` (e.g. `$HOME/.local/share/opencode/opencodeplus/search/exa.key` and `tavily.key`, or `run/plus/data/opencode/opencodeplus/search/{exa,tavily}.key` if `XDG_DATA_HOME` is set to `run/plus/data`) and ensure permissions are restricted (`chmod 600 <file>`).
- **Query & filtering**: `instructions.list where:"server:<name>"` (and TUI filter `server:<name>`) matches both the `mcp:<name>` server configuration row and all tool rows exposed by that server (for example, `instructions.list where:"server:search"` returns the `mcp:search` server row alongside its tool rows).
- **Team prompts & policy**: Built-in prompts name `search_exa_code_search` in the shared team body and `search_tavily_search` / `search_tavily_extract` in the planner body. The `perm:search:team-tavily` policy row disables Tavily search for implementer, reviewer, and scout roles while keeping code search enabled; it lists under `search_tavily_search` → Permissions → `Access`, beside the search tools' own rows (queries that carry keys or local paths, depths, topics, result limits, Approval).
