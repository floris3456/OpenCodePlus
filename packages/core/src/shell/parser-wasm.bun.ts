// The CLI bundle also reaches tree-sitter.wasm through @opentui/core, which imports it
// `with { type: "wasm" }`. The bundler records one loader per embedded file and takes
// whichever import it parses first, so a different type here made two builds of one
// commit differ. Both types yield the file's path, from source and in the compiled binary.
// @ts-ignore Bun embeds static file imports when compiling the CLI.
import runtime from "web-tree-sitter/tree-sitter.wasm" with { type: "wasm" }
// @ts-ignore Bun embeds static file imports when compiling the CLI.
import bash from "tree-sitter-bash/tree-sitter-bash.wasm" with { type: "file" }
// @ts-ignore Bun embeds static file imports when compiling the CLI.
import powershell from "tree-sitter-powershell/tree-sitter-powershell.wasm" with { type: "file" }

export const shellParserWasm = { runtime, bash, powershell }
