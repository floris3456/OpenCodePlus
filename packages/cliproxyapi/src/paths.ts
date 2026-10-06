import os from "node:os"
import path from "node:path"
import { Product } from "@opencode/util/product"

// Resolves global config from the shared Product identity:
// an explicit OPENCODE_CONFIG_DIR override, else <XDG_CONFIG_HOME>/<Product.namespace>,
// else ~/.config/<Product.namespace>. The package keeps its own copy so it never
// imports Plus; the behavior matches plus/src/instructions/paths.ts.
export function globalConfigDir(): string {
  const override = process.env.OPENCODE_CONFIG_DIR
  if (override) return override
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  return path.join(base, Product.namespace)
}
