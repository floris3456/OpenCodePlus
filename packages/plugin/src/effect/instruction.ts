import type { Effect } from "effect"
import type { Transform } from "./registration.js"

export interface InstructionEditor {
  list(): readonly { path: string; content: string }[]
  add(file: { path: string; content: string }): void
  update(path: string, update: (file: { path: string; content: string }) => void): void
  remove(path: string): void
}

export interface InstructionDomain {
  readonly transform: Transform<InstructionEditor>
  readonly reload: () => Effect.Effect<void>
}
