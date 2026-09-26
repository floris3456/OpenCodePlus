// Per-tool permissions: the categories every tool lists under its Permissions
// node and the rows each category ships with.
//
// A category is one thing a tool can be asked to do differently (which files,
// which commands, which members, which parameters, how much). Its rows are
// ordinary `perm:` instructions rows, so each one is listable, showable,
// logged and overridable at project, global and team level like every other
// row. `permKind` says who enforces a row (model.ts PermKind); this module is
// data plus the two pure helpers every enforcer shares (wildcardMatch and
// valuesAt). It must not import from core.
//
// Row semantics, the same in every category:
// - A category's "Everything else" row (fallback) is its default. On leaves
//   the agent's own answer in place; off refuses everything the other rows do
//   not allow.
// - A deny-list row (the default) refuses what it matches while it is off.
// - An allow-list row (`allow: true`) lets through what it matches while it is
//   on, and only matters once the fallback is off.
import { fingerprint, permItemId, type Item, type PermKind } from "./model.js"

export interface RowSpec {
  readonly id: string
  readonly label: string
  /** Shipped state. Deny-list rows ship on (nothing refused) unless the thing they guard is never wanted. */
  readonly on: boolean
  readonly patterns?: readonly string[]
  /** An allow-list row: on lets its patterns through a closed fallback. */
  readonly allow?: boolean
  readonly value?: string | number | boolean | null
  /** limit rows: the default number, kept in the row's text. */
  readonly limit?: number
  /** limit rows: the tool's own default for the field, so a call that omits it is capped too. */
  readonly toolDefault?: number
  readonly message?: string
  /** param rows: the input field when the category reads several. */
  readonly field?: string
  /** The row's own kind when it differs from its category's (a rule category's fallback is checked on the call's input). */
  readonly kind?: PermKind
  /** rule rows: the core permission action the row denies when it differs from its tool's own. */
  readonly action?: string
}

export interface CategorySpec {
  readonly id: string
  readonly label: string
  readonly kind: PermKind
  /** One line the detail pane shows for the category. */
  readonly summary: string
  readonly field?: string
  readonly measure?: "value" | "length" | "count"
  readonly mode?: "clamp" | "refuse"
  readonly fallback?: RowSpec
  readonly rows: readonly RowSpec[]
  /** Other tools that share this category's rows (edit, write and patch change files through one permission). */
  readonly alsoUnder?: readonly string[]
  /** value categories: the literal the tool uses when a call omits the field, checked like a supplied one. */
  readonly default?: string | number | boolean
}

// Core's wildcard (core/src/util/wildcard.ts): `*` spans any run including
// `/`, `?` is one character, and a trailing ` *` also matches the bare head so
// `git push *` covers `git push`. Plus cannot import core, so this is the copy
// every Plus enforcer uses; permission-catalog.test.ts pins it to core's.
export function wildcardMatch(input: string, pattern: string): boolean {
  const normalized = input.replaceAll("\\", "/")
  const escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  const tail = escaped.endsWith(" .*") ? `${escaped.slice(0, -3)}( .*)?` : escaped
  return new RegExp(`^${tail}$`, "s").test(normalized)
}

// Every value an input field holds: a dotted path whose `[]` segments walk
// arrays, so `scope.paths[]` yields each scope path and `questions[].multiple`
// each question's flag. Missing fields yield nothing.
export function valuesAt(input: unknown, field: string): unknown[] {
  const segments = field.split(".")
  const walk = (value: unknown, index: number): unknown[] => {
    if (index === segments.length) return value === undefined ? [] : [value]
    if (value === null || typeof value !== "object") return []
    const segment = segments[index] ?? ""
    const many = segment.endsWith("[]")
    const key = many ? segment.slice(0, -2) : segment
    const next = (value as Record<string, unknown>)[key]
    if (!many) return walk(next, index + 1)
    if (!Array.isArray(next)) return []
    return next.flatMap((entry) => walk(entry, index + 1))
  }
  return walk(input, 0)
}

// ── shared pattern sets ─────────────────────────────────────────────────────

const secretFiles: readonly RowSpec[] = [
  { id: "env", label: ".env files", on: true, patterns: [".env", ".env.*", "*/.env", "*/.env.*", "*.env"] },
  {
    id: "keys",
    label: "Private keys",
    on: true,
    patterns: ["*.key", "*.pem", "*.p12", "*.pfx", "id_rsa", "id_rsa.*", "*/id_rsa", "*/id_rsa.*", "id_ed25519", "*/id_ed25519", "*/id_ed25519.*", "*/id_ecdsa", "*/id_ecdsa.*"],
  },
  {
    id: "credentials",
    label: "Credential stores",
    on: true,
    patterns: [
      "auth.json",
      "*/auth.json",
      ".netrc",
      "*/.netrc",
      ".npmrc",
      "*/.npmrc",
      ".pypirc",
      "*/.pypirc",
      "*/.git-credentials",
      "*/.docker/config.json",
      "*/.aws/credentials",
      "*/.aws/config",
      "*/.kube/config",
      "*/.config/gh/hosts.yml",
      "*/.config/gcloud/*",
    ],
  },
  {
    id: "opencode-config",
    label: "Provider config and service passwords",
    on: true,
    patterns: [
      "*/.config/opencodeplus/opencode.json",
      "*/.config/opencodeplus/opencode.jsonc",
      "*/.config/opencodeplus/service.json",
      "*/.config/opencode/opencode.json",
      "*/.config/opencode/opencode.jsonc",
      "*/.config/opencode/service*.json",
      "*/.local/state/opencode*/service.json",
      "*/.local/share/opencode*/auth.json",
    ],
  },
  {
    id: "run-configs",
    label: "Frozen team run configs",
    on: true,
    patterns: ["*/run/team/*/runs/*/config/*", "*/run/controller/*"],
  },
  { id: "databases", label: "Session databases (*.db, *.sqlite)", on: true, patterns: ["*.db", "*.db-wal", "*.db-shm", "*.sqlite", "*.sqlite3"] },
]

// The secret-file patterns every "Files" category shares, for rows other
// modules build (a team member's search ban).
export function secretFilePatterns(): string[] {
  return [...new Set(secretFiles.flatMap((row) => row.patterns ?? []))]
}

// Paths a tool may change that are either never the task (version control and
// team state) or high blast radius (CI, releases, agent and team definitions).
const protectedEdits: readonly RowSpec[] = [
  { id: "keys", label: "Private keys (*.key, *.pem)", on: true, patterns: ["*.key", "*.pem", "*.p12", "*.pfx", "*/id_rsa*", "*/id_ed25519*"] },
  { id: "credentials", label: "Credential stores", on: true, patterns: ["auth.json", "*/auth.json", ".netrc", "*/.netrc", ".npmrc", "*/.npmrc", "*/.git-credentials"] },
  { id: "team-state", label: "Team and Plus state (.opencodeplus/)", on: true, patterns: [".opencodeplus/*", "*/.opencodeplus/*"] },
  { id: "ci", label: "CI workflows (.github/)", on: true, patterns: [".github/*", "*/.github/*"] },
  {
    id: "agent-definitions",
    label: "Agent and team definitions",
    on: true,
    patterns: ["agents/*", ".opencode/agent/*", ".opencode/agents/*", "*/.opencode/agent/*", "*/.opencode/agents/*", "*/teams/*.md", "*/.config/opencodeplus/*"],
  },
  { id: "instruction-files", label: "Instruction files (AGENTS.md)", on: true, patterns: ["AGENTS.md", "*/AGENTS.md", "CLAUDE.md", "*/CLAUDE.md"] },
  { id: "release", label: "Release configuration (release/)", on: true, patterns: ["release/*", "*/release/*"] },
  { id: "tests", label: "Test files (*.test.*, test/)", on: true, patterns: ["*.test.*", "*.spec.*", "test/*", "*/test/*", "tests/*", "*/tests/*"] },
]

const localSites: readonly RowSpec[] = [
  {
    id: "localhost",
    label: "Localhost (this machine)",
    on: true,
    patterns: ["http://localhost*", "https://localhost*", "http://127.*", "https://127.*", "http://[::1]*", "https://[::1]*", "http://0.0.0.0*", "https://0.0.0.0*"],
  },
  {
    id: "private",
    label: "Private networks",
    on: true,
    patterns: [
      "http://10.*",
      "https://10.*",
      "http://192.168.*",
      "https://192.168.*",
      ...Array.from({ length: 16 }, (_, index) => [`http://172.${16 + index}.*`, `https://172.${16 + index}.*`]).flat(),
    ],
  },
  {
    id: "metadata",
    label: "Cloud metadata endpoints",
    on: true,
    patterns: ["http://169.254.*", "https://169.254.*", "http://metadata.google.internal*", "http://metadata*"],
  },
  { id: "http", label: "Plain HTTP (unencrypted)", on: true, patterns: ["http://*"] },
  {
    id: "paste",
    label: "Paste and file-drop sites",
    on: true,
    patterns: [
      "*://pastebin.com*",
      "*://*.pastebin.com*",
      "*://paste.ee*",
      "*://hastebin.com*",
      "*://transfer.sh*",
      "*://0x0.st*",
      "*://file.io*",
      "*://webhook.site*",
      "*://*.ngrok.io*",
      "*://*.ngrok-free.app*",
      "*://requestbin.*",
      "*://*.pipedream.net*",
    ],
  },
]

const leakyQueries: readonly RowSpec[] = [
  {
    id: "secrets",
    label: "Queries with keys or tokens",
    on: true,
    patterns: ["*sk-*", "*sk_live_*", "*ghp_*", "*github_pat_*", "*xoxb-*", "*xoxp-*", "*AKIA*", "*-----BEGIN*", "*api_key=*", "*apikey=*", "*password=*", "*token=*"],
    message: "search queries must not contain keys, tokens or passwords",
  },
  {
    id: "paths",
    label: "Queries with local paths",
    on: true,
    patterns: ["*/home/*", "*/Users/*", "*/root/*"],
    message: "search queries must not contain local paths",
  },
]

// ── builders ────────────────────────────────────────────────────────────────

function approval(): CategorySpec {
  return {
    id: "approval",
    label: "Approval",
    kind: "approval",
    summary: "Ask the human before a call runs. A delegated team run has nobody to ask, so there the call is refused.",
    rows: [{ id: "every", label: "Ask me before each call", on: false }],
  }
}

function parameters(rows: readonly RowSpec[]): CategorySpec {
  return {
    id: "parameters",
    label: "Parameters",
    kind: "param",
    summary: "Optional parameters. Off removes the parameter from the tool's schema and refuses a call that uses it.",
    rows,
  }
}

function values(field: string, id: string, label: string, summary: string, rows: readonly RowSpec[], fallback?: string | number | boolean): CategorySpec {
  return { id, label, kind: "value", field, summary, rows, ...(fallback === undefined ? {} : { default: fallback }) }
}

function limits(rows: readonly (RowSpec & { readonly field: string })[], mode: "clamp" | "refuse", measure: "value" | "length" | "count" = "value"): CategorySpec {
  return {
    id: "limits",
    label: "Limits",
    kind: "limit",
    mode,
    measure,
    summary:
      mode === "clamp"
        ? "Caps on numeric parameters. On lowers a larger value to the cap; off removes the cap. Edit the row to change the number."
        : "Caps on how much one call may carry. On refuses a call above the cap; off removes the cap. Edit the row to change the number.",
    rows,
  }
}

function files(field: string, summary: string, extra: readonly RowSpec[] = []): CategorySpec {
  return {
    id: "files",
    label: "Files",
    kind: "input",
    field,
    summary,
    fallback: { id: "*", label: "Every other file", on: true, patterns: ["*"], message: "this file is not available here" },
    rows: [...secretFiles, ...extra],
  }
}

function sites(field: string, summary: string): CategorySpec {
  return {
    id: "sites",
    label: "Sites",
    kind: "input",
    field,
    summary,
    fallback: { id: "*", label: "Every other site", on: true, patterns: ["*"], message: "this site is not available here" },
    rows: localSites,
  }
}

function queries(field: string): CategorySpec {
  return {
    id: "queries",
    label: "Queries",
    kind: "input",
    field,
    summary: "What a search query may contain. A query is sent to a third party, so keys and local paths stay out.",
    rows: leakyQueries,
  }
}

// ── the catalog ─────────────────────────────────────────────────────────────

const outsideCheckout = ["/*", "~", "~/*", "..", "../*"]

const nativeCatalog: Record<string, readonly CategorySpec[]> = {
  read: [
    {
      id: "files",
      label: "Files",
      kind: "rule",
      summary: "Files read may open. Paths inside the checkout are relative, paths outside it absolute.",
      // The fallback is checked on the call itself: as a core rule its
      // closing deny would order against the role's own rules instead of
      // standing on its own.
      fallback: { id: "*", label: "Every other file", on: true, patterns: ["*"], kind: "input", field: "path", message: "reading this file is not allowed here" },
      // .env files already have their curated row (perm:read:env) here.
      rows: secretFiles.filter((row) => row.id !== "env").map((row) => ({ ...row, message: `${row.label} cannot be read here` })),
    },
    {
      id: "where",
      label: "Where",
      kind: "input",
      field: "path",
      summary: "Files outside this checkout. Off keeps read inside the checkout except the rows allowed below.",
      fallback: {
        id: "outside",
        label: "Outside this checkout",
        on: true,
        patterns: ["/*"],
        message: "reading outside this checkout is not allowed here",
      },
      rows: [
        { id: "tmp", label: "Temporary directories", on: true, allow: true, patterns: ["/tmp/*", "*/run/plus/tmp/*"] },
        // Core asks `external_directory` before any tool (read, edit, the
        // shell) touches a path outside the checkout; a delegated run has
        // nobody to answer, so this row refuses instead of asking.
        {
          id: "external",
          label: "Outside this checkout, for every tool (external_directory)",
          on: true,
          kind: "rule",
          action: "external_directory",
          patterns: ["*"],
          message: "paths outside this checkout are not available here",
        },
      ],
    },
    {
      id: "content",
      label: "Content",
      kind: "input",
      field: "path",
      summary: "Kinds of files read turns into model input. Images and PDFs cost many tokens and need a vision model.",
      rows: [
        { id: "images", label: "Images (png, jpg, gif, webp)", on: true, patterns: ["*.png", "*.jpg", "*.jpeg", "*.gif", "*.webp", "*.PNG", "*.JPG", "*.JPEG"], message: "reading images is not allowed here" },
        { id: "pdf", label: "PDF documents", on: true, patterns: ["*.pdf", "*.PDF"], message: "reading PDFs is not allowed here" },
      ],
    },
    limits([{ id: "lines", label: "Lines per read", on: false, limit: 2000, field: "limit", toolDefault: 2000 }], "clamp"),
    approval(),
  ],
  glob: [
    {
      id: "roots",
      label: "Search roots",
      kind: "input",
      field: "path",
      summary: "Directories glob may walk. Off keeps the search inside this checkout.",
      rows: [{ id: "outside", label: "Outside this checkout", on: true, patterns: outsideCheckout, message: "searching outside this checkout is not allowed here" }],
    },
    parameters([{ id: "hidden", label: "Hidden files (hidden: true)", on: true, field: "hidden", value: true }]),
    limits([{ id: "results", label: "Results per call", on: false, limit: 100, field: "limit", toolDefault: 100 }], "clamp"),
    approval(),
  ],
  grep: [
    files(
      "path",
      "Files grep may search and return. A file off here is refused as a path and dropped from results, so grep cannot read what read may not.",
    ),
    {
      id: "include",
      label: "Include filters",
      kind: "input",
      field: "include",
      summary: "The include glob, which can aim a search at secret files.",
      rows: [
        { id: "env", label: ".env files", on: true, patterns: ["*.env*", ".env*", "*/.env*"], message: "searching .env files is not allowed here" },
        { id: "keys", label: "Private keys", on: true, patterns: ["*.key*", "*.pem*", "*id_rsa*", "*id_ed25519*"], message: "searching private keys is not allowed here" },
      ],
    },
    {
      id: "roots",
      label: "Search roots",
      kind: "input",
      field: "path",
      summary: "Directories grep may walk. Off keeps the search inside this checkout.",
      rows: [{ id: "outside", label: "Outside this checkout", on: true, patterns: outsideCheckout, message: "searching outside this checkout is not allowed here" }],
    },
    limits([{ id: "results", label: "Matches per call", on: false, limit: 100, field: "limit", toolDefault: 100 }], "clamp"),
    approval(),
  ],
  edit: [
    {
      id: "protected",
      label: "Protected files",
      kind: "rule",
      summary: "Files edit, write and patch may change: one permission for all three. A file off here cannot be changed by any of them.",
      alsoUnder: ["write", "patch"],
      rows: protectedEdits.map((row) => ({ ...row, message: `${row.label} cannot be changed here` })),
    },
    {
      id: "where",
      label: "Where",
      kind: "input",
      field: "path",
      summary: "Changing files outside this checkout (edit, write and patch).",
      alsoUnder: ["write", "patch"],
      fallback: { id: "outside", label: "Outside this checkout", on: true, patterns: ["/*"], message: "changing files outside this checkout is not allowed here" },
      rows: [{ id: "tmp", label: "Temporary directories", on: true, allow: true, patterns: ["/tmp/*", "*/run/plus/tmp/*"] }],
    },
    {
      id: "allowed",
      label: "Files it may change",
      kind: "input",
      field: "path",
      summary: "Which files edit, write and patch may change at all. Off on the first row keeps them to the files allowed below.",
      alsoUnder: ["write", "patch"],
      fallback: {
        id: "*",
        label: "Every other file",
        on: true,
        patterns: ["*"],
        message: "this file is not one you may change here; only the allowed files (Files it may change) are",
      },
      rows: [
        {
          id: "plans",
          label: "Plan files (docs/plans/, docs/handoffs/)",
          on: true,
          allow: true,
          patterns: ["*docs/plans/*", "docs/handoffs/*", "*/docs/handoffs/*"],
        },
      ],
    },
    parameters([{ id: "replace-all", label: "Replace all (replaceAll: true)", on: true, field: "replaceAll", value: true }]),
    approval(),
  ],
  write: [
    {
      id: "operations",
      label: "Operations",
      kind: "input",
      field: "path",
      summary: "Whether write may create new files or replace existing ones wholesale.",
      rows: [
        { id: "create", label: "Create new files", on: true, message: "creating new files is not allowed here" },
        { id: "overwrite", label: "Overwrite an existing file", on: true, message: "overwriting an existing file is not allowed here; use edit" },
      ],
    },
    limits([{ id: "size", label: "Largest file written (characters)", on: false, limit: 200_000, field: "content" }], "refuse", "length"),
    approval(),
  ],
  patch: [
    {
      id: "operations",
      label: "Operations",
      kind: "input",
      field: "patchText",
      summary: "Which patch operations may run. Deleting and moving files are the ones that lose work.",
      rows: [
        { id: "add", label: "Add files (*** Add File)", on: true, message: "adding files is not allowed here" },
        { id: "delete", label: "Delete files (*** Delete File)", on: true, message: "deleting files is not allowed here" },
        { id: "move", label: "Move or rename files (*** Move to)", on: true, message: "moving files is not allowed here" },
      ],
    },
    limits([{ id: "files", label: "Files per patch", on: false, limit: 20, field: "patchText" }], "refuse", "count"),
    approval(),
  ],
  shell: [
    {
      id: "commands",
      label: "Commands",
      kind: "rule",
      summary: "Command families. The shell's permission resource is each parsed command's text, so these are wildcard patterns over it.",
      fallback: { id: "*", label: "Every other command", on: true, patterns: ["*"], kind: "input", field: "command", message: "shell commands are not allowed here" },
      rows: [
        {
          id: "git-changes",
          label: "Git working-tree changes",
          on: true,
          patterns: ["git add *", "git stash", "git stash *", "git clean *", "git restore *", "git switch *", "git merge *", "git cherry-pick *", "git revert *", "git rm *", "git mv *", "git apply *", "git am *", "git pull", "git pull *"],
          message: "changing the git working tree is not allowed here",
        },
        {
          id: "git-refs",
          label: "Git branches, tags and worktrees",
          on: true,
          patterns: ["git branch -d *", "git branch -D *", "git branch -m *", "git branch -M *", "git branch -f *", "git tag *", "git update-ref *", "git worktree add *", "git worktree remove *", "git worktree prune *", "git worktree move *"],
          message: "changing git refs or worktrees is not allowed here",
        },
        {
          id: "file-writes",
          label: "Writing files from the shell",
          on: true,
          patterns: ["* > *", "* >> *", "* 1> *", "* &> *", "* >| *", "tee", "tee *", "sed -i*", "sed * -i*", "perl -pi*", "cp *", "mv *", "touch *", "mkdir *", "ln *", "install *", "truncate *"],
          message: "writing files from the shell is not allowed here",
        },
        { id: "kill-by-name", label: "Stopping processes by name", on: true, patterns: ["pkill", "pkill *", "killall", "killall *"], message: "stopping processes by name is not allowed here" },
        {
          id: "interpreters",
          label: "Inline interpreter code",
          on: true,
          patterns: ["python -c *", "python3 -c *", "node -e *", "node --eval *", "node -p *", "bun -e *", "bun --eval *", "bun -p *", "deno eval *", "bash -c *", "sh -c *", "zsh -c *", "eval *", "perl -e *", "ruby -e *", "php -r *"],
          message: "running inline interpreter code is not allowed here",
        },
        { id: "registry-run", label: "Running packages from a registry", on: true, patterns: ["npx *", "bunx *", "pnpx *", "pnpm dlx *", "yarn dlx *"], message: "running packages from a registry is not allowed here" },
        { id: "network-tools", label: "Other network tools", on: true, patterns: ["nc *", "ncat *", "netcat *", "telnet *", "ftp *", "sftp *", "rsync *", "socat *"], message: "network tools are not allowed here" },
        {
          id: "service-control",
          label: "Service control",
          on: true,
          patterns: ["systemctl *", "service *", "launchctl *", "opencode service *", "opencode2 service *", "opencodeplus service *", "*/opencodeplus service *"],
          message: "controlling services is not allowed here",
        },
        { id: "databases", label: "Database shells", on: true, patterns: ["sqlite3", "sqlite3 *", "psql *", "mysql *", "redis-cli *", "mongosh *"], message: "database shells are not allowed here" },
        { id: "github-cli", label: "GitHub CLI (gh)", on: true, patterns: ["gh", "gh *"], message: "the GitHub CLI is not allowed here" },
        {
          id: "secret-reads",
          label: "Printing secret files",
          on: true,
          patterns: ["cat *.env*", "cat *.key*", "cat *.pem*", "cat *id_rsa*", "cat *id_ed25519*", "cat *auth.json*", "cat */.ssh/*", "head *.env*", "tail *.env*", "less *.env*", "more *.env*", "bat *.env*"],
          message: "printing secret files is not allowed here",
        },
        {
          id: "workspace-scripts",
          label: "Workspace team and service scripts",
          on: true,
          patterns: ["./bin/team *", "bin/team *", "*/bin/team *", "./bin/opencodeplus*", "bin/opencodeplus*", "*/bin/opencodeplus*"],
          message: "workspace team and service scripts are not allowed here",
        },
      ],
    },
    {
      id: "directories",
      label: "Working directories",
      kind: "input",
      field: "workdir",
      summary: "Where a command may run. Off keeps workdir inside this checkout.",
      rows: [{ id: "outside", label: "Outside this checkout", on: true, patterns: outsideCheckout, message: "running commands outside this checkout is not allowed here" }],
    },
    parameters([
      { id: "background", label: "Background (background: true)", on: true, field: "background", value: true },
      { id: "no-timeout", label: "Commands with no timeout (timeout: 0)", on: true, field: "timeout", value: 0 },
      { id: "workdir", label: "Working directory (workdir)", on: true, field: "workdir" },
    ]),
    {
      id: "environment",
      label: "Environment",
      kind: "env",
      summary: "Variables a command inherits from the server. Off strips the matching variables before the command starts.",
      rows: [
        {
          id: "secrets",
          label: "Keys, tokens and passwords",
          on: true,
          patterns: ["*_KEY", "*_API_KEY", "*_TOKEN", "*_SECRET", "*SECRET*", "*PASSWORD*", "*_CREDENTIALS", "AWS_*", "GITHUB_TOKEN", "GH_TOKEN", "NPM_TOKEN", "OPENCODE_SERVER_PASSWORD"],
        },
      ],
    },
    limits([{ id: "timeout", label: "Longest timeout (ms)", on: false, limit: 600_000, field: "timeout", toolDefault: 120_000 }], "clamp"),
    approval(),
  ],
  question: [
    parameters([{ id: "multiple", label: "Multiple choice (multiple: true)", on: true, field: "questions[].multiple", value: true }]),
    limits([{ id: "questions", label: "Questions per call", on: false, limit: 4, field: "questions" }], "refuse", "count"),
    {
      id: "when",
      label: "When",
      kind: "approval",
      summary: "Whether a question may be asked where no human is watching.",
      rows: [{ id: "delegated", label: "In delegated team runs", on: false, message: "no human watches a delegated run; finish with needs_context instead of asking" }],
    },
  ],
  subagent: [
    {
      id: "team-members",
      label: "Team members",
      kind: "input",
      field: "agent",
      summary: "Starting a team member as a plain subagent gives it no team run, so its team tools fail. Delegate with team_delegate instead.",
      rows: [{ id: "team-members", label: "Team members (without a team run)", on: false, message: "team members start through team_delegate, not the subagent tool" }],
    },
    parameters([
      { id: "background", label: "Background (background: true)", on: true, field: "background", value: true },
      { id: "resume", label: "Resume a subagent (sessionID)", on: true, field: "sessionID" },
    ]),
    approval(),
  ],
  skill: [approval()],
  webfetch: [
    {
      id: "more-sites",
      label: "More sites",
      kind: "rule",
      summary: "More site families for webfetch, on top of the curated Sites rows.",
      rows: localSites
        .filter((row) => row.id !== "localhost" && row.id !== "http")
        .map((row) => ({ ...row, message: `${row.label} cannot be fetched here` })),
    },
    values("format", "format", "Formats", "Formats webfetch may return.", [
      { id: "markdown", label: "Markdown", on: true, value: "markdown" },
      { id: "text", label: "Plain text", on: true, value: "text" },
      { id: "html", label: "Raw HTML", on: true, value: "html" },
    ], "markdown"),
    limits([{ id: "timeout", label: "Longest timeout (seconds)", on: false, limit: 60, field: "timeout", toolDefault: 30 }], "clamp"),
    approval(),
  ],
  websearch: [
    {
      id: "queries",
      label: "Queries",
      kind: "rule",
      summary: "What a search query may contain. A query is sent to a third party, so keys and local paths stay out.",
      rows: leakyQueries,
    },
    approval(),
  ],
  execute: [limits([{ id: "calls", label: "Tool calls per run", on: false, limit: 50, field: "code" }], "refuse", "count")],
  opencode_session_move: [
    {
      id: "sessions",
      label: "Sessions",
      kind: "param",
      summary: "Which sessions this tool may move.",
      rows: [{ id: "other", label: "Other sessions", on: true, field: "sessionID", message: "only this session may be moved here" }],
    },
    {
      id: "destinations",
      label: "Destinations",
      kind: "input",
      field: "directory",
      summary: "Where a session may move.",
      rows: [
        { id: "absolute", label: "Absolute paths (anywhere on disk)", on: true, patterns: ["/*", "~", "~/*"], message: "moving a session to an absolute path is not allowed here" },
        { id: "up", label: "Directories above this one (../)", on: true, patterns: ["..", "../*"], message: "moving a session above this directory is not allowed here" },
      ],
    },
  ],
  opencode_session_rename: [
    {
      id: "sessions",
      label: "Sessions",
      kind: "param",
      summary: "Which sessions this tool may rename.",
      rows: [{ id: "other", label: "Other sessions", on: true, field: "sessionID", message: "only this session may be renamed here" }],
    },
    limits([{ id: "title", label: "Longest title (characters)", on: false, limit: 80, field: "title" }], "refuse", "length"),
  ],
}

const teamStatuses = ["done", "done_with_concerns", "blocked", "needs_context", "rejected"]

// Which runs a member may address with a tool that takes a run id, besides
// its own run and its direct children. Read for the calling member.
function runs(tool: string): CategorySpec {
  return {
    id: "runs",
    label: "Runs",
    kind: "team",
    summary: "Which runs this member may address with this tool, besides its own run and its direct children.",
    rows: [
      {
        id: "descendants",
        label: "Deeper descendants (grandchildren and below)",
        on: false,
        message: `${tool} reaches only your own run and your direct children`,
      },
      {
        id: "others",
        label: "Any other run (other members, teams and projects)",
        on: false,
        message: `${tool} reaches only your own run and your runs' descendants`,
      },
    ],
  }
}

const teamCatalog: Record<string, readonly CategorySpec[]> = {
  team_delegate: [
    {
      id: "access",
      label: "Access",
      kind: "team",
      summary: "When this member may delegate at all. Read for the member that calls team_delegate.",
      rows: [
        {
          id: "delegated",
          label: "Delegate from a delegated run",
          on: true,
          message: `a delegated run of yours may not delegate further; finish with needs=[{kind:"decision",...}] instead`,
        },
      ],
    },
    values("deliverable.kind", "deliverables", "Deliverables", "What a delegated run may be asked to produce.", [
      { id: "commit", label: "Commits (commit)", on: true, value: "commit" },
      { id: "report", label: "Reports (report)", on: true, value: "report" },
      { id: "plan", label: "Plans (plan)", on: true, value: "plan" },
      { id: "findings", label: "Review findings (findings)", on: true, value: "findings" },
    ]),
    values("effort", "effort", "Effort", "How large a delegated task may be. Effort sets the child's turn, token and time budget.", [
      { id: "small", label: "Small", on: true, value: "small" },
      { id: "medium", label: "Medium", on: true, value: "medium" },
      { id: "large", label: "Large", on: true, value: "large" },
    ], "medium"),
    {
      id: "scope",
      label: "Scope it may grant",
      kind: "input",
      field: "scope.paths[]",
      summary: "Paths a child may be told to edit (scope.paths). A path off here cannot be handed to any child.",
      rows: protectedEdits.map((row) => ({ ...row, message: `${row.label} cannot be granted to a child here` })),
    },
    {
      id: "checks",
      label: "Checks it may assign",
      kind: "input",
      field: "checks[].argv",
      summary: "Commands a child may be given as checks. Checks are always explicit bun test files or bun run scripts.",
      rows: [
        { id: "tests", label: "Test files (bun test FILE)", on: true, patterns: ["bun test *"], message: "assigning test checks is not allowed here" },
        { id: "scripts", label: "Package scripts (bun run SCRIPT)", on: true, patterns: ["bun run *"], message: "assigning package-script checks is not allowed here" },
      ],
    },
    parameters([
      { id: "repo", label: "Another repository (repo)", on: true, field: "repo" },
      { id: "base", label: "Another starting commit (base)", on: true, field: "base" },
      { id: "brief-file", label: "Attaching a brief file (briefFile)", on: true, field: "briefFile" },
      { id: "prompt", label: "Free-text prompt (prompt)", on: true, field: "prompt" },
      { id: "task", label: "Claiming a plan task (task)", on: true, field: "task" },
    ]),
    {
      id: "limits",
      label: "Limits",
      kind: "team",
      summary: "Team bounds for this member's delegations. Edit a row to change the number; off removes the bound.",
      rows: [
        { id: "inflight", label: "Children working at once", on: true, limit: 4 },
        { id: "depth", label: "Delegation depth", on: true, limit: 3 },
        { id: "brief", label: "Brief size (characters)", on: true, limit: 6000 },
        { id: "members", label: "Live team runs in total", on: true, limit: 12 },
      ],
    },
    approval(),
  ],
  team_followup: [
    runs("team_followup"),
    values("delivery", "delivery", "Delivery", "How a correction may reach a child.", [
      { id: "queue", label: "Queued for the next turn (queue)", on: true, value: "queue" },
      { id: "now", label: "Delivered now to an idle child (now)", on: true, value: "now" },
    ], "queue"),
    parameters([{ id: "budget", label: "Changing a child's budget (budget)", on: true, field: "budget" }]),
    {
      id: "limits",
      label: "Limits",
      kind: "team",
      summary: "How many corrections one child may get before it should be replaced.",
      rows: [{ id: "rounds", label: "Followups per child", on: false, limit: 5 }],
    },
    approval(),
  ],
  team_integrate: [
    {
      id: "outcomes",
      label: "Outcomes it lands",
      kind: "team",
      summary: "Child outcomes that may be landed.",
      rows: [
        { id: "done", label: "done", on: true },
        { id: "concerns", label: "done_with_concerns", on: true },
      ],
    },
    {
      id: "branches",
      label: "Branches it lands on",
      kind: "team",
      summary: "The parent's branch a child's commits land on. A root run lands on the checkout's current branch.",
      rows: [
        {
          id: "protected",
          label: "Protected branches",
          on: true,
          patterns: ["main", "master", "v2", "ocp-main", "release", "release*", "release/*"],
          message: "landing on a protected branch is not allowed here; land on a task branch",
        },
      ],
    },
    approval(),
  ],
  team_checkpoint: [
    {
      id: "commit-types",
      label: "Commit types",
      kind: "input",
      field: "message",
      summary: "Conventional commit types a checkpoint message may use.",
      rows: ["feat", "fix", "docs", "chore", "refactor", "test"].map((type) => ({
        id: type,
        label: type,
        on: true,
        patterns: [`${type}:*`, `${type}(*`],
        message: `"${type}" commits are not allowed here`,
      })),
    },
    limits([{ id: "files", label: "Files per checkpoint", on: false, limit: 50, field: "files" }], "refuse", "count"),
    approval(),
  ],
  team_finish: [
    values(
      "status",
      "outcomes",
      "Outcomes",
      "Outcomes a report may declare.",
      teamStatuses.map((status) => ({ id: status, label: status, on: true, value: status })),
    ),
    values("needs[].kind", "needs", "Needs", "Kinds of help a report may ask for.", [
      { id: "path", label: "A path outside scope (path)", on: true, value: "path" },
      { id: "check", label: "A failing or missing check (check)", on: true, value: "check" },
      { id: "info", label: "Information (info)", on: true, value: "info" },
      { id: "decision", label: "A decision (decision)", on: true, value: "decision" },
    ]),
    {
      id: "requirements",
      label: "Requirements for done",
      kind: "team",
      summary: "What must hold before done or done_with_concerns is accepted.",
      rows: [
        { id: "checks", label: "Assigned checks pass at HEAD", on: true },
        { id: "commit", label: "A commit deliverable has a commit", on: false },
        { id: "clean", label: "Worktree committed before done", on: false },
      ],
    },
  ],
  team_set_checks: [
    {
      id: "checks",
      label: "Check commands",
      kind: "input",
      field: "checks[].argv",
      summary: "Commands this member may record as integration checks.",
      rows: [
        { id: "tests", label: "Test files (bun test FILE)", on: true, patterns: ["bun test *"], message: "recording test checks is not allowed here" },
        { id: "scripts", label: "Package scripts (bun run SCRIPT)", on: true, patterns: ["bun run *"], message: "recording package-script checks is not allowed here" },
      ],
    },
    approval(),
  ],
  team_supersede: [runs("team_supersede"), approval()],
  team_stop: [runs("team_stop"), approval()],
  team_status: [runs("team_status")],
  team_wait: [
    runs("team_wait"),
    values("until", "until", "Wait until", "What a wait may wait for.", [
      { id: "settled", label: "Settled (settled)", on: true, value: "settled" },
      { id: "idle", label: "Idle (idle)", on: true, value: "idle" },
    ], "settled"),
    parameters([{ id: "no-ack", label: "Unacknowledged waits (ack: false)", on: true, field: "ack", value: false }]),
    limits([{ id: "timeout", label: "Longest wait (ms)", on: false, limit: 600_000, field: "timeoutMs", toolDefault: 60_000 }], "clamp"),
  ],
  team_diff: [
    runs("team_diff"),
    values("from", "from", "Compare against", "What a diff may compare against.", [
      { id: "base", label: "The run's base (base)", on: true, value: "base" },
      { id: "parent", label: "The parent's HEAD (parent)", on: true, value: "parent" },
    ], "base"),
    limits([{ id: "bytes", label: "Largest diff (bytes)", on: false, limit: 200_000, field: "maxBytes", toolDefault: 200_000 }], "clamp"),
  ],
  team_list: [runs("team_list"), parameters([{ id: "all", label: "Superseded and reaped (all: true)", on: true, field: "all", value: true }])],
  team_get_context: [
    {
      id: "bootstrap",
      label: "Team runs",
      kind: "team",
      summary: "Whether a chat of this member becomes a team run of its own the first time it calls a team tool.",
      rows: [
        {
          id: "chat",
          label: "Start a team run from a chat",
          on: true,
          message: "you do not start a team run from a chat; team tools work only inside a run delegated to you",
        },
      ],
    },
    {
      id: "contents",
      label: "Contents",
      kind: "team",
      summary: "What get_context returns besides the run's own brief, checks, inbox and budget.",
      rows: [{ id: "siblings", label: "Sibling runs of the same task", on: true }],
    },
    // Read by team_delegate and team_followup for the member a brief or a
    // correction is addressed to, never for the caller.
    {
      id: "accepts",
      label: "Briefs it accepts",
      kind: "team",
      summary:
        "What a brief delegated to this member must carry, and whether it takes corrections. Read for the member a brief names, not for the member that delegates.",
      rows: [
        { id: "scope-paths", label: "Scope paths for a commit", on: false, message: "needs scope.paths (files or dir/* it may edit) for a commit deliverable" },
        {
          id: "plan-files",
          label: "Plan files only",
          on: false,
          allow: true,
          patterns: ["docs/plans/*", "docs/handoffs/*"],
          message: "accepts plan files only: every scope path must match one of its patterns",
        },
        { id: "reason", label: "A reason", on: false, message: "needs a reason: say why this member and not another" },
        { id: "check", label: "A check", on: false, message: "needs at least one check" },
        {
          id: "followup",
          label: "Corrections by followup",
          on: true,
          message: "takes no corrections by followup: delegate a fresh run with team_delegate and point it at the previous report",
        },
      ],
    },
    {
      id: "limits",
      label: "Brief limits",
      kind: "team",
      summary: "Caps on a brief delegated to this member. On refuses a brief above the cap; off removes it. Edit the row to change the number.",
      rows: [
        { id: "paths", label: "Paths per brief", on: false, limit: 5 },
        { id: "checks", label: "Checks per brief", on: false, limit: 1 },
      ],
    },
  ],
  team_check: [
    {
      id: "checks",
      label: "Checks it may run",
      kind: "team",
      summary: "Kinds of assigned checks this member may run itself.",
      rows: [
        { id: "tests", label: "Test files (bun test FILE)", on: true, patterns: ["bun test *"], message: "running test checks is not allowed here" },
        { id: "scripts", label: "Package scripts (bun run SCRIPT)", on: true, patterns: ["bun run *"], message: "running package-script checks is not allowed here" },
      ],
    },
  ],
}

const instructionReads = ["instructions_list", "instructions_show", "instructions_log"]
const instructionWrites = ["instructions_set", "instructions_reset", "instructions_split", "instructions_create", "instructions_delete"]

function instructionTargets(): CategorySpec {
  return {
    id: "targets",
    label: "Rows it may change",
    kind: "input",
    field: "id",
    summary: "Whose rows a change may address, read from the row id. An agent that may change its own rows can widen its own permissions.",
    rows: [
      { id: "self", label: "Its own rows", on: true, message: "an agent may not change its own rows here" },
      { id: "permissions", label: "Permission rows (perm:)", on: true, patterns: ["*:perm:*", "perm:*"], message: "changing permission rows is not allowed here" },
      { id: "models", label: "Model rows (model:)", on: true, patterns: ["*:model:*", "model:*", "*:compaction:model"], message: "changing model rows is not allowed here" },
      { id: "teams", label: "Teams and members (team:)", on: true, patterns: ["team:*"], message: "changing teams is not allowed here" },
      { id: "global", label: "Global rows (level global)", on: true, patterns: ["*:global:*"], message: "changing global rows is not allowed here" },
      { id: "defaults", label: "Defaults rows (level defaults)", on: true, patterns: ["*:defaults:*"], message: "changing Defaults rows is not allowed here" },
    ],
  }
}

const instructionsCatalog: Record<string, readonly CategorySpec[]> = {
  ...Object.fromEntries(
    instructionReads.map((tool) => [
      tool,
      [
        {
          id: "secrets",
          label: "Secrets in rows",
          kind: "input",
          field: "*",
          summary: "Values of keys, tokens, passwords and headers inside rows (MCP and provider config). Off masks them in every result.",
          rows: [{ id: "values", label: "Show secret values", on: true }],
        },
        approval(),
      ] satisfies CategorySpec[],
    ]),
  ),
  instructions_set: [
    instructionTargets(),
    {
      id: "changes",
      label: "Changes",
      kind: "param",
      summary: "What a set may do to a row.",
      rows: [
        { id: "text", label: "Override text (text)", on: true, field: "text" },
        { id: "state", label: "Switch rows on or off (state)", on: true, field: "state" },
        { id: "mode", label: "Change agent mode (mode)", on: true, field: "mode" },
        { id: "pin", label: "Pin Code Mode tools (pin)", on: true, field: "pin" },
        { id: "active", label: "Activate models (active)", on: true, field: "active" },
        { id: "resolve", label: "Resolve reviews (resolve)", on: true, field: "resolve" },
        { id: "rule", label: "Rewrite permission rules", on: true, field: "patterns" },
      ],
    },
    approval(),
  ],
  instructions_reset: [instructionTargets(), approval()],
  instructions_split: [instructionTargets(), approval()],
  instructions_create: [
    values("kind", "kinds", "Kinds", "What create may add. An MCP server runs a program on this machine.", [
      { id: "agent", label: "Agents", on: true, value: "agent" },
      { id: "skill", label: "Skills", on: true, value: "skill" },
      { id: "base", label: "Base prompts", on: true, value: "base" },
      { id: "instruction", label: "Instruction files", on: true, value: "instruction" },
      { id: "mcp", label: "MCP servers (run a program)", on: true, value: "mcp" },
      { id: "team", label: "Teams", on: true, value: "team" },
      { id: "member", label: "Team members", on: true, value: "member" },
      { id: "model", label: "Model candidates", on: true, value: "model" },
      { id: "rule", label: "Permission rules", on: true, value: "rule" },
    ]),
    values("level", "levels", "Levels", "Where create may write.", [
      { id: "project", label: "Project", on: true, value: "project" },
      { id: "global", label: "Global", on: true, value: "global" },
      { id: "defaults", label: "Defaults", on: true, value: "defaults" },
    ]),
    approval(),
  ],
  instructions_delete: [instructionTargets(), approval()],
}

const releaseCatalog: Record<string, readonly CategorySpec[]> = {
  release_request: [
    values("kind", "kinds", "Kinds", "What a release request may ask the controller for.", [
      { id: "build", label: "Build a release (build)", on: true, value: "build" },
      { id: "promote", label: "Promote a release (promote)", on: true, value: "promote" },
    ]),
    values("artifact.target", "targets", "Targets", "Platforms a promotion may target.", [
      { id: "linux-x64", label: "linux-x64", on: true, value: "linux-x64" },
      { id: "linux-arm64", label: "linux-arm64", on: true, value: "linux-arm64" },
      { id: "darwin-arm64", label: "darwin-arm64", on: true, value: "darwin-arm64" },
      { id: "darwin-x64", label: "darwin-x64", on: true, value: "darwin-x64" },
    ]),
    parameters([{ id: "no-approval", label: "Without an approval reference", on: true, field: "approvalRef", value: null }]),
    approval(),
  ],
  release_status: [approval()],
}

const searchCatalog: Record<string, readonly CategorySpec[]> = {
  search_tavily_search: [
    queries("query"),
    values("search_depth", "depth", "Search depth", "Depths a search may use. advanced costs two credits.", [
      { id: "ultra-fast", label: "ultra-fast", on: true, value: "ultra-fast" },
      { id: "fast", label: "fast", on: true, value: "fast" },
      { id: "basic", label: "basic", on: true, value: "basic" },
      { id: "advanced", label: "advanced (two credits)", on: true, value: "advanced" },
    ], "basic"),
    values("topic", "topics", "Topics", "Topics a search may use.", [
      { id: "general", label: "general", on: true, value: "general" },
      { id: "news", label: "news", on: true, value: "news" },
      { id: "finance", label: "finance", on: true, value: "finance" },
    ], "general"),
    limits([{ id: "results", label: "Results per search", on: false, limit: 10, field: "max_results", toolDefault: 5 }], "clamp"),
    approval(),
  ],
  search_tavily_extract: [
    sites("urls[]", "Pages extract may fetch. Extraction runs on Tavily's side, so local and private addresses only leak their names."),
    values("extract_depth", "depth", "Extract depth", "Depths an extraction may use. advanced costs more.", [
      { id: "basic", label: "basic", on: true, value: "basic" },
      { id: "advanced", label: "advanced", on: true, value: "advanced" },
    ], "basic"),
    limits([{ id: "urls", label: "Pages per call", on: false, limit: 5, field: "urls" }], "refuse", "count"),
    approval(),
  ],
  search_exa_code_search: [
    queries("query"),
    values("type", "types", "Search types", "Search types a code search may use.", [
      { id: "fast", label: "fast", on: true, value: "fast" },
      { id: "auto", label: "auto", on: true, value: "auto" },
      { id: "neural", label: "neural", on: true, value: "neural" },
      { id: "keyword", label: "keyword", on: true, value: "keyword" },
    ], "fast"),
    parameters([
      { id: "text", label: "Full page text (contents.text)", on: true, field: "contents.text" },
      { id: "summary", label: "Summaries (contents.summary)", on: true, field: "contents.summary", value: true },
    ]),
    limits([{ id: "results", label: "Results per search", on: false, limit: 10, field: "numResults", toolDefault: 10 }], "clamp"),
    approval(),
  ],
}

// Browser tools come from the desktop plugin; their catalog follows what each
// tool does to a page rather than listing 44 tables by hand. Neither they nor
// core's opencode session tools pass through a permission check (they carry
// no plugin origin), so no human can be asked before one runs: they list no
// Approval category, and their other rows are refused at the tool hook.
function browserCatalog(tool: string): readonly CategorySpec[] {
  return withoutApproval(browserCategories(tool))
}

function withoutApproval(categories: readonly CategorySpec[]): readonly CategorySpec[] {
  return categories.filter((category) => category.kind !== "approval")
}

function browserCategories(tool: string): readonly CategorySpec[] {
  const name = tool.slice("browser_".length)
  if (name === "navigate" || name === "tabs_open")
    return [sites("url", "Pages the browser may open. Website traffic uses this server's network, so localhost is this machine.")]
  if (name === "tabs_list")
    return [
      {
        id: "use",
        label: "Use",
        kind: "input",
        field: "*",
        summary: "Whether the browser's tab list may be read at all. Off refuses every call.",
        rows: [{ id: "list", label: "List this session's tabs", on: true, message: "listing browser tabs is not allowed here" }],
      },
    ]
  const page = pageSites()
  if (name === "files_upload" || name === "files_drop")
    return [
      page,
      files("paths[]", "Server files this tool may hand to a web page. A page can send anything it receives anywhere."),
      limits([{ id: "files", label: "Files per call", on: false, limit: 2, field: "paths" }], "refuse", "count"),
    ]
  if (name === "network_get")
    return [
      page,
      parameters([{ id: "body", label: "Request and response bodies", on: true, field: "includeBody", value: true }]),
      limits([{ id: "body", label: "Largest body (characters)", on: false, limit: 5000, field: "maxBodyChars" }], "clamp"),
    ]
  if (name === "dialog")
    return [
      page,
      values("action", "actions", "Actions", "What the tool may do with a dialog.", [
        { id: "get", label: "Read it (get)", on: true, value: "get" },
        { id: "accept", label: "Accept it (accept)", on: true, value: "accept" },
        { id: "dismiss", label: "Dismiss it (dismiss)", on: true, value: "dismiss" },
      ]),
    ]
  if (name === "evaluate")
    return [
      page,
      parameters([{ id: "frames", label: "Running in a sub-frame (frameID)", on: true, field: "frameID" }]),
      limits([{ id: "script", label: "Longest script (characters)", on: false, limit: 4000, field: "script" }], "refuse", "length"),
    ]
  if (name === "screenshot")
    return [page, parameters([{ id: "full-page", label: "Full-page captures (fullPage: true)", on: true, field: "fullPage", value: true }])]
  if (name === "fill" || name === "fill_form")
    return [page, limits([{ id: "text", label: "Longest text typed (characters)", on: false, limit: 2000, field: name === "fill" ? "text" : "fields[].value" }], "refuse", "length")]
  if (name === "trace_start") return [page, limits([{ id: "duration", label: "Longest trace (ms)", on: false, limit: 10_000, field: "durationMs" }], "clamp")]
  return [page]
}

// The page a tab-scoped browser tool acts on is its tab's current page: the
// tool hook remembers each tab's URL from the browser tools' own results, so
// the same site rows as navigation decide which pages a click, a fill or a
// screenshot may touch. A tab whose page is not known yet passes, unless the
// fallback is closed.
function pageSites(): CategorySpec {
  return {
    ...sites("tabID", "Pages this tool may act on: the tab's current page, as the browser last reported it."),
    summary: "Pages this tool may act on: the tab's current page, as the browser last reported it.",
  }
}

// The categories one tool lists. An unknown tool from another MCP server or a
// plugin still gets the approval category: both reach a permission check
// (an MCP leaf, the plugin gate), which is where the human is asked. A tool
// with neither gets nothing it could not honour.
export function catalogFor(tool: string, group?: Item["group"]): readonly CategorySpec[] {
  const native = nativeCatalog[tool]
  if (native !== undefined) return native
  const team = teamCatalog[tool]
  if (team !== undefined) return team
  const instructions = instructionsCatalog[tool]
  if (instructions !== undefined) return instructions
  const release = releaseCatalog[tool]
  if (release !== undefined) return release
  const search = searchCatalog[tool]
  if (search !== undefined) return search
  if (tool.startsWith("browser_")) return browserCatalog(tool)
  if (group === "mcp" || group === "plus") return [approval()]
  return []
}

// Categories of rows that predate the catalog (curated, mined, user rules and
// team role rows), keyed by the tool they belong to. Their ids never change,
// so stored overrides keep resolving; only where they are listed moved.
const legacyCategories: Record<string, { readonly id: string; readonly label: string }> = {
  shell: { id: "commands", label: "Commands" },
  edit: { id: "files", label: "Files" },
  write: { id: "files", label: "Files" },
  patch: { id: "files", label: "Files" },
  read: { id: "files", label: "Files" },
  webfetch: { id: "sites", label: "Sites" },
  glob: { id: "patterns", label: "Search patterns" },
  grep: { id: "patterns", label: "Search patterns" },
  subagent: { id: "agents", label: "Agents" },
  skill: { id: "skills", label: "Skills" },
}

export const suggestedCategory = { id: "suggested", label: "Mentioned in instructions" } as const
export const roleCategory = { id: "role", label: "Team role" } as const

// Which category a row is listed under, whether or not it came from the
// catalog: a catalog or team row carries its own, a mined row (with
// provenance and no curated message) goes to "Mentioned in instructions",
// and every other legacy row takes its tool's category.
export function categoryOfRow(item: Pick<Item, "category" | "permTool" | "provenance" | "custom" | "policy" | "ruleId">, curated: boolean): string {
  if (item.category !== undefined) return item.category
  if (item.policy !== undefined) return roleCategory.id
  if (!curated && item.custom !== true && (item.provenance?.length ?? 0) > 0) return suggestedCategory.id
  return legacyCategories[item.permTool ?? ""]?.id ?? "rules"
}

// Categories another tool shares into this one (edit's Protected files and
// Where under write and patch).
function sharedInto(tool: string): readonly CategorySpec[] {
  return Object.values(nativeCatalog).flatMap((categories) => categories.filter((category) => (category.alsoUnder ?? []).includes(tool)))
}

// Display label of a category of a tool: the catalog's label (its own or one
// shared into it), else a legacy or fixed one.
export function categoryLabel(tool: string, category: string): string {
  const spec =
    catalogFor(tool).find((entry) => entry.id === category) ??
    sharedInto(tool).find((entry) => entry.id === category) ??
    catalogFor(hostOf(tool)).find((entry) => entry.id === category)
  if (spec !== undefined) return spec.label
  if (category === suggestedCategory.id) return suggestedCategory.label
  if (category === roleCategory.id) return roleCategory.label
  const legacy = Object.values(legacyCategories).find((entry) => entry.id === category)
  if (legacy !== undefined) return legacy.label
  if (category === "access") return "Access"
  if (category === "to") return "Delegate to"
  if (category === "runs") return "Runs"
  if (category === "scopes") return "Run edit scopes"
  if (category === "rules") return "Rules"
  return category.charAt(0).toUpperCase() + category.slice(1)
}

// One line about a category for the detail pane.
export function categorySummary(tool: string, category: string): string | undefined {
  const spec =
    catalogFor(tool).find((entry) => entry.id === category) ??
    sharedInto(tool).find((entry) => entry.id === category) ??
    catalogFor(hostOf(tool)).find((entry) => entry.id === category)
  if (spec !== undefined) return spec.summary
  if (category === suggestedCategory.id)
    return "Rules suggested by paths, commands and sites the instructions mention. They refuse what they match while off."
  if (category === roleCategory.id) return "Rows that install their own core rules for this member. Changing a row here changes the rules."
  if (category === "to") return "Members this member may delegate to. Each row is one member of the team."
  if (category === "runs") return "Which runs this member may address with this tool, besides its own run and its direct children."
  if (category === "access") return "Whether this member may call the tool at all."
  if (category === "scopes") return "What each live delegated run of this member may edit: its scope.paths, never version-control or team state."
  return undefined
}

// Categories listed first to last for a tool: catalog order, then the legacy
// category of its curated rows, then role and suggestions.
export function categoryOrder(tool: string): readonly string[] {
  const legacy = legacyCategories[tool]?.id
  const shared = sharedInto(tool).map((entry) => entry.id)
  const catalog = catalogFor(tool).map((entry) => entry.id)
  const head = ["to", "runs", "access", roleCategory.id]
  return [...new Set([...head, ...(legacy === undefined ? [] : [legacy]), ...shared, ...catalog, "approval", "rules", suggestedCategory.id])]
}

// Rows with no tool of their own list under the tool they govern:
// `external_directory` gates every file tool and the shell, and read is where a
// human looks for it; the legacy `task` action is the subagent tool; the
// `search` server rows are Tavily's.
export function hostOf(permTool: string): string {
  if (permTool === "external_directory") return "read"
  if (permTool === "task") return "subagent"
  if (permTool === "search") return "search_tavily_search"
  return permTool
}

// Every catalog row of every tool in the inventory. `actionOf` is the tool's
// core permission action, needed by rule rows.
export function catalogItems(tools: readonly Item[], actionOf: (tool: string) => string | undefined): Item[] {
  return tools.flatMap((tool) => {
    if (tool.kind !== "tool" || !tool.id.startsWith("tool:")) return []
    const toolId = tool.id.slice("tool:".length)
    return catalogFor(toolId, tool.group).flatMap((category, categoryIndex) => {
      const action = actionOf(toolId) ?? toolId
      const fallback = category.fallback === undefined ? [] : [{ ...category.fallback, fallback: true }]
      return [...fallback, ...category.rows.map((row) => ({ ...row, fallback: false }))].map((row, rowIndex): Item => {
        const patterns = row.patterns ?? []
        const text = catalogText(row, patterns)
        return {
          id: permItemId(toolId, `${category.id}.${row.id}`),
          kind: "perm",
          group: "none",
          title: row.label,
          text,
          enabled: row.on,
          fingerprint: fingerprint(text),
          order: 1000 + categoryIndex * 100 + rowIndex,
          permTool: toolId,
          permAction: row.action ?? action,
          ruleId: `${category.id}.${row.id}`,
          patterns: [...patterns],
          // Catalog rows never scrub prompt lines: their patterns name common
          // words (cp, touch, tee) that a derived keyword would strip from
          // unrelated guidance. A user who wants a scrub adds keywords.
          keywords: [],
          provenance: [],
          category: category.id,
          permKind: row.kind ?? category.kind,
          ...(row.field !== undefined ? { field: row.field } : category.field !== undefined ? { field: category.field } : {}),
          ...(row.value === undefined ? {} : { value: row.value }),
          ...(row.toolDefault === undefined ? {} : { value: row.toolDefault }),
          ...(category.measure === undefined ? {} : { measure: category.measure }),
          ...(category.mode === undefined ? {} : { mode: category.mode }),
          ...(row.message === undefined ? {} : { message: row.message }),
          ...(row.fallback ? { fallback: true } : {}),
          ...(row.allow === true ? { allow: true } : {}),
          ...(category.alsoUnder === undefined ? {} : { alsoUnder: [...category.alsoUnder] }),
        }
      })
    })
  })
}

// A limit row's text is its number; every other row's text is its label and
// patterns, like the curated rows.
function catalogText(row: RowSpec, patterns: readonly string[]): string {
  if (row.limit !== undefined) return String(row.limit)
  return [row.label, ...patterns].join("\n")
}

// A row whose text is a number the user edits: a limit, or a team bound.
export function isValueRow(item: Pick<Item, "permKind" | "category" | "text">): boolean {
  if (item.permKind === "limit") return true
  return item.permKind === "team" && item.category === "limits" && limitOf(item.text) !== undefined
}

// The number a limit row carries: the first integer in its resolved text.
export function limitOf(text: string): number | undefined {
  const match = /-?\d[\d_]*/.exec(text)
  if (match === null) return undefined
  const value = Number(match[0].replaceAll("_", ""))
  return Number.isFinite(value) ? value : undefined
}
