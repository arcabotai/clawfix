// Ambient declarations for the plain-JS ClawFix core modules consumed by the TUI.
// The cli/ package is ESM JavaScript without type definitions; these keep the
// TypeScript build quiet without changing runtime behavior.

declare module "../../bin/native-diagnostics.js" {
  export const collectListeningPort: any
  export const collectNativeConfigValidation: any
  export const collectNativeDoctor: any
  export const collectNativeSecurityAudit: any
  export const collectNativeStatus: any
  export const collectOpenClawVersion: any
}

declare module "../../bin/security.js" {
  export const redactOutbound: any
  export const projectLocalIssuesForUpload: any
}

declare module "../../bin/workspace.js" {
  export const countMarkdownFiles: any
}

declare module "../../adapters/openclaw.js" {
  export const openClawAdapter: any
}

declare module "../../core/diagnostics.js" {
  export const createDiagnosticsCore: any
}

declare module "../../core/findings.js" {
  export const normalizeFindings: any
  export const dedupeFindingsForDisplay: any
}

declare module "../../core/repair-catalog.js" {
  export const repairCatalog: any
}

declare module "../../core/repair-engine.js" {
  export const createRepairEngine: any
}

declare module "../../core/session.js" {
  export const createSessionController: any
}

declare module "../../core/offline-analyzer.js" {
  export const createOfflineAnalyzer: any
}

// Bun-only standalone entry embeds native renderer assets with `with { type: "file" }`.
// These are opaque binary/runtime assets, not TypeScript modules.
declare module "../node_modules/@opentui/core/parser.worker.js" {
  const path: string
  export default path
}

declare module "*.wasm" {
  const path: string
  export default path
}
