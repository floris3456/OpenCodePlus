// --cwd is required so Bun picks up packages/cli/tsconfig.json for JSX resolution,
// but it must not leak into the directory the CLI and the Plus plugin treat as the project.
const target = process.env.OPENCODEPLUS_CALLER_CWD
if (target) process.chdir(target)
