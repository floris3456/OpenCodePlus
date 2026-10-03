// The Tools and rules row: instructions that belong to a tool, skill or rule
// rather than to a role. Each section depends on the row it belongs to
// (requires.ts), so it reaches an agent exactly while that row is on for it
// (`!` sections: while it is off), at whatever level that was decided. It is
// an ordinary System row: a level can turn a section off, rewrite it, or add
// its own section with its own `requires` line.
//
// What a tool does stays in its description and how a value must look in its
// schema; a section here says only when or why to reach for it, and only
// where that is not obvious from the description. Keep each to a line or two:
// it is sent on every request of every agent that has the row.
export const guidanceTitle = "Tools and rules"

export const guidanceContent = `# Tools and rules

## Code search
<!-- requires: tool:search_exa_code_search -->
For external APIs and libraries, check current usage with search_exa_code_search
instead of relying on memory.

## Documentation search
<!-- requires: tool:search_tavily_search -->
For current documentation, release notes and changelogs, search with
search_tavily_search.

## Reading web pages
<!-- requires: tool:search_tavily_extract -->
Read a page you found in full with search_tavily_extract.

## Terminal UIs
<!-- requires: skill:pilotty -->
After changing terminal UI code, check it in a real terminal with the pilotty
skill before you report it done.

## Questions
<!-- requires: tool:question -->
When only a person can make a decision, ask with the question tool instead of
guessing.

## Subagents
<!-- requires: tool:subagent -->
A subagent starts with no context: give it everything it needs, and use it for
self-contained work whose result you can check.

## Commits
<!-- requires: !perm:shell:git-commit, tool:team_checkpoint -->
You cannot commit through the shell here: commit with team_checkpoint.

## Pushing
<!-- requires: !perm:shell:git-push -->
You cannot push. Leave the push to whoever holds that permission, and say in
your report that it is still to do.
`
