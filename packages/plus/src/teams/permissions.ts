// Retired. The per-run edit scope this module used to enforce through a
// `permission.evaluate` hook is now an instructions row: the producer in
// `instructions/team-policy-rows.ts` derives `perm:edit:run:<runID>` from the
// run record while the run is live, and `instructions/apply.ts` installs it
// through the same pushRule path as every other rule. No file under
// `src/teams` registers a permission hook or writes permissions onto an agent.
export {}
