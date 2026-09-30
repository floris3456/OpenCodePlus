#!/usr/bin/env bun
// Checks a release version before a tag build produces anything:
//   bun packages/plus/script/release/version.ts <version>
// The version is the tag without its leading "v". Ordering against earlier
// releases is checked where they are known, when ocp-release.yml publishes.

import { join } from "node:path"
import { PlusVersion } from "@opencode/util/plus-version"

/** Why `version` cannot be released from source containing opencode `opencode`, or undefined. */
export function refuseReleaseVersion(version: string, opencode: string) {
  const parsed = PlusVersion.parse(version)
  if (!parsed)
    return `release version '${version}' must look like ${opencode}-plus-1.0.0: the opencode version this source contains, then the OpenCodePlus version, both three numbers`
  if (parsed.opencode.join(".") !== opencode)
    return `release version '${version}' names opencode ${parsed.opencode.join(".")}, but this source contains opencode ${opencode} (packages/cli/package.json)`
}

if (import.meta.main) {
  const version = process.argv[2] ?? ""
  const pkg = await Bun.file(join(import.meta.dir, "../../../cli/package.json")).json()
  const refusal = refuseReleaseVersion(version, pkg.version)
  if (refusal) {
    console.error(`::error::${refusal}`)
    process.exit(1)
  }
  const parsed = PlusVersion.parse(version)
  if (parsed) console.log(`Release version ${version}: ${PlusVersion.display(parsed)}`)
}
