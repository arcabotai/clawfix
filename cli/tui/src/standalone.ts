/**
 * Standalone entry for bun --compile.
 * Force-embed OpenTUI tree-sitter assets so loadBundledFile() works under $bunfs.
 */
import parserWorker from "../node_modules/@opentui/core/parser.worker.js" with { type: "file" }
import treeSitterWasm from "../node_modules/web-tree-sitter/tree-sitter.wasm" with { type: "file" }
import jsWasm from "../node_modules/@opentui/core/assets/javascript/tree-sitter-javascript.wasm" with {
  type: "file",
}
import tsWasm from "../node_modules/@opentui/core/assets/typescript/tree-sitter-typescript.wasm" with {
  type: "file",
}
import mdWasm from "../node_modules/@opentui/core/assets/markdown/tree-sitter-markdown.wasm" with {
  type: "file",
}
import mdInlineWasm from "../node_modules/@opentui/core/assets/markdown_inline/tree-sitter-markdown_inline.wasm" with {
  type: "file",
}
import zigWasm from "../node_modules/@opentui/core/assets/zig/tree-sitter-zig.wasm" with { type: "file" }

void [parserWorker, treeSitterWasm, jsWasm, tsWasm, mdWasm, mdInlineWasm, zigWasm]

await import("./main.tsx")
