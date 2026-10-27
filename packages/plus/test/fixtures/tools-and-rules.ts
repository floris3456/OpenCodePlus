// A Tools and rules text with sections, for tests of how its sections follow
// the rows they name. Plus ships the row empty (guidance.ts), so a test that
// needs sections brings this text, as a level that adds them would.
export const toolsAndRulesSample = `# Tools and rules

## Code search
<!-- requires: tool:web_exa_code_search -->
Check current API usage with web.exa_code_search.

## Terminal UIs
<!-- requires: skill:pilotty -->
Check terminal UI changes with the pilotty skill.

## Questions
<!-- requires: tool:question -->
Ask with the question tool when only a person can decide.

## Commands
<!-- requires: tool:shell -->
Run long commands in the background.
`
