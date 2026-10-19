export * as ConfigVariable from "./variable.js"

import path from "path"
import { Effect } from "effect"
import { type ParseError, parse } from "jsonc-parser"
import { InvalidError } from "../v1/config/error.js"

type ParseSource =
  | {
      type: "path"
      path: string
    }
  | {
      type: "virtual"
      source: string
      dir: string
    }

/** Why a `{file:}` target could not be read, in terms the token parser can report. */
export interface ReadFailure {
  /** The target is absent, rather than the read itself having failed. */
  readonly missing: boolean
  readonly cause: unknown
}

/**
 * Where `{file:}` targets are read from. Substitution has no default reader: a placed config must
 * resolve its references inside the workspace it came from, and a host-backed fallback would splice
 * host bytes into a placed document.
 */
export interface Reader {
  readonly read: (path: string) => Effect.Effect<string, ReadFailure>
  /**
   * Directory `~/` expands to. Omit it when this process knows no home for the reader's placement:
   * `~` then stays a literal segment under the config directory, where the read fails closed.
   */
  readonly home?: string
}

type SubstituteInput = ParseSource & {
  text: string
  reader: Reader
  missing?: "error" | "empty"
  env?: Record<string, string>
}

/** Apply {env:VAR} and {file:path} substitutions to config text. */
export const substitute = Effect.fn("ConfigVariable.substitute")(function* (input: SubstituteInput) {
  const env = (escape: boolean) =>
    input.text.replace(/\{env:([^}]+)\}/g, (_, name: string) => {
      const value = (input.env?.[name] ?? process.env[name]) || ""
      return escape ? JSON.stringify(value).slice(1, -1) : value
    })
  // Escape only when raw values break the JSON (e.g. Windows paths), so configs that parse today keep their meaning.
  const raw = yield* substituteFiles(input, env(false))
  const errors: ParseError[] = []
  if (input.text.includes("{env:")) parse(raw, errors, { allowTrailingComma: true })
  if (!errors.length) return raw
  return yield* substituteFiles(input, env(true))
})

/**
 * One pass over the original text: resolved content is appended to the output and never rescanned,
 * so a `{file:}` reference contained in a target's own content stays literal instead of resolving a
 * second target chosen by that content.
 */
const substituteFiles = Effect.fnUntraced(function* (input: SubstituteInput, text: string) {
  const configDir = input.type === "path" ? path.dirname(input.path) : input.dir
  const configSource = input.type === "path" ? input.path : input.source
  let out = ""
  let cursor = 0

  for (const match of text.matchAll(/\{file:[^}]+\}/g)) {
    const token = match[0]
    const index = match.index
    out += text.slice(cursor, index)

    const lineStart = text.lastIndexOf("\n", index - 1) + 1
    const prefix = text.slice(lineStart, index).trimStart()
    if (prefix.startsWith("//")) {
      out += token
      cursor = index + token.length
      continue
    }

    const filePath = token.slice("{file:".length, -1)
    const expandedPath =
      input.reader.home !== undefined && filePath.startsWith("~/")
        ? path.join(input.reader.home, filePath.slice(2))
        : filePath
    const resolvedPath = path.isAbsolute(expandedPath) ? expandedPath : path.resolve(configDir, expandedPath)
    const fileContent = yield* input.reader.read(resolvedPath).pipe(
      Effect.catch((error) => {
        // Like a missing {env:VAR}, a missing or unreadable local file substitutes empty so one stale
        // secret reference cannot take down every Location that loads this config.
        if (input.missing === "empty")
          return Effect.logWarning("config file reference is missing or unreadable", {
            source: configSource,
            reference: token,
            path: resolvedPath,
            cause: error.cause,
          }).pipe(Effect.as(""))

        const message = `bad file reference: "${token}"`
        return Effect.fail(
          new InvalidError(
            {
              path: configSource,
              message: error.missing ? `${message} ${resolvedPath} does not exist` : message,
            },
            { cause: error.cause },
          ),
        )
      }),
    )

    out += JSON.stringify(fileContent.trim()).slice(1, -1)
    cursor = index + token.length
  }

  return out + text.slice(cursor)
})
