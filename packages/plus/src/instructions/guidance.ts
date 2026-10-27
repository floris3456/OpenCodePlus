// The Tools and rules row: instructions that belong to a tool, skill or rule
// rather than to a role. Each section depends on the row it belongs to
// (requires.ts), so it reaches an agent exactly while that row is on for it
// (`!` sections: while it is off), at whatever level that was decided. It is
// an ordinary System row: a level can turn a section off, rewrite it, or add
// its own section with its own `requires` line.
//
// It ships empty: an agent receives nothing from it until a level adds a
// section. What a tool does stays in its description and how a value must
// look in its schema; a section here says only when or why to reach for it,
// and only where that is not obvious from the description. Keep each to a
// line or two: it is sent on every request of every agent that has the row.
export const guidanceTitle = "Tools and rules"

export const guidanceContent = ""
