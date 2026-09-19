import type { Context } from "@opencode/plugin/effect/plugin"
import type { PermissionEvaluation } from "@opencode/plugin/effect/permission"
import type { Registration } from "@opencode/plugin/effect/registration"
import { Effect, Exit, Scope } from "effect"
import path from "node:path"
import { teamsDataDir } from "../instructions/paths.js"
import { bySession } from "./run.js"

export async function registerTeamPermissions(ctx: Context, root?: string): Promise<Registration> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      return yield* Effect.suspend(() => ctx.permission.hook("evaluate", (event) => handleEvent(event, root))).pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause)).pipe(Effect.ignoreCause)),
      )
    }),
  )
}

function handleEvent(event: PermissionEvaluation, root?: string): Effect.Effect<void> {
  return Effect.gen(function* () {
    if (event.action !== "edit") return
    const base = root ?? teamsDataDir()
    const run = yield* Effect.promise(() => bySession(base, event.sessionID).catch(() => undefined))
    if (run === undefined) return
    const paths = run.paths ?? []
    const directory = run.directory ?? ""
    const decision = decideEdit(directory, paths, event.resources)
    event.effect = decision.effect
    if (decision.effect === "deny" && decision.message !== undefined) event.message = decision.message
  })
}

interface EditDecision {
  readonly effect: "allow" | "deny"
  readonly message?: string
}

function decideEdit(
  directory: string,
  paths: readonly string[],
  resources: ReadonlyArray<string>,
): EditDecision {
  const scope = paths.join(", ")
  if (resources.length === 0)
    return { effect: "deny", message: `Edit request named no file; nothing to check against scope.paths [${scope}].` }
  const relatives = resources.map((resource) => toRelative(directory, resource))
  for (const relative of relatives) {
    if (isForbidden(relative))
      return {
        effect: "deny",
        message: `"${relative}" is version-control or paused-tool state and is never editable, even inside scope.paths [${scope}]. Report it in needs=[{kind:"path"...}].`,
      }
  }
  for (const relative of relatives) {
    if (!matchesScope(relative, paths))
      return {
        effect: "deny",
        message: `"${relative}" is outside your scope.paths [${scope}]. Report it in needs=[{kind:"path"...}].`,
      }
  }
  return { effect: "allow" }
}

// Absolute resources resolve against the run directory so a relative scope
// entry matches the same file whether the tool reports it relative or
// absolute. Absolute paths outside the directory stay absolute and miss
// every relative scope entry.
function toRelative(directory: string, resource: string): string {
  const normResource = resource.replaceAll("\\", "/")
  const normDir = directory.replaceAll("\\", "/").replace(/\/+$/, "")
  if (normDir.length > 0) {
    if (normResource === normDir) return "."
    if (normResource.startsWith(`${normDir}/`)) {
      const rel = normResource.slice(normDir.length + 1)
      return path.posix.normalize(rel.length === 0 ? "." : rel)
    }
  }
  if (normResource.startsWith("/")) return path.posix.normalize(normResource)
  return path.posix.normalize(normResource.length === 0 ? "." : normResource)
}

// Version-control and paused-tool state is never editable, even when a run's
// scope would otherwise allow it.
function isForbidden(relative: string): boolean {
  const segments = relative.split("/")
  return segments.includes(".git") || segments.includes(".cairn") || segments.includes(".beads")
}

function matchesScope(relative: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => wildcardMatch(relative, pattern))
}

// Core resource wildcards (not regex): `*` spans any run of characters,
// `?` one character.
function wildcardMatch(input: string, pattern: string): boolean {
  const normalized = input.replaceAll("\\", "/")
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?"
  return new RegExp("^" + escaped + "$", process.platform === "win32" ? "si" : "s").test(normalized)
}
