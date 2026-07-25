import type { DisclosureView } from "./models"

/** Local mirror of cli/core/privacy.js defaults so TUI stays package-isolated. */

export const DEFAULT_INCLUDED = Object.freeze([
  "Your message",
  "OS and OpenClaw versions (when present on a linked diagnostic)",
  "Redacted configuration fields (when present on a linked diagnostic)",
  "Matching error lines (when present on a linked diagnostic)",
  "Client-supplied reviewed repair IDs (id, title, risk only)",
])

export const DEFAULT_EXCLUDED = Object.freeze([
  "Workspace document contents",
  "Top-level config env block",
  "Chat history outside this ClawFix session",
  "Real hostname",
  "Shell commands, patches, or executable repair payloads",
])

export const DEFAULT_PROVIDER_CHAIN = Object.freeze([
  "ClawFix service",
  "OpenRouter",
  "selected model",
])

export function buildDisclosureView(input: {
  readonly baseUrl?: string
  readonly customServer?: boolean
  readonly providerChain?: readonly string[]
  readonly included?: readonly string[]
  readonly excluded?: readonly string[]
  /** True when this turn will also POST the redacted diagnostic to /api/diagnose. */
  readonly uploadsDiagnostic?: boolean
} = {}): DisclosureView {
  const raw = (input.baseUrl || "https://clawfix.dev").trim() || "https://clawfix.dev"
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    url = new URL("https://clawfix.dev")
  }
  const hostname = url.hostname || "clawfix.dev"
  const custom = Boolean(input.customServer) || hostname !== "clawfix.dev"
  const chain = input.providerChain && input.providerChain.length > 0
    ? [...input.providerChain]
    : [...DEFAULT_PROVIDER_CHAIN]
  const effectiveChain = custom
    ? [`Custom ClawFix server (${hostname})`, ...chain.filter((p) => !/clawfix service/i.test(p))]
    : chain

  // Agreeing to a remote turn also uploads the redacted diagnostic, as a separate request to a
  // separate endpoint. Say so up front rather than describing it as something that merely might
  // already be "linked".
  const included = input.included
    ? [...input.included]
    : input.uploadsDiagnostic
      ? ["Your message", ...DEFAULT_INCLUDED.slice(1).map((line) => line.replace(" (when present on a linked diagnostic)", ""))]
      : [...DEFAULT_INCLUDED]

  return Object.freeze({
    destination: hostname,
    baseUrl: url.origin,
    endpointUrl: `${url.origin}/api/v2/agent/messages`,
    diagnosticEndpointUrl: input.uploadsDiagnostic ? `${url.origin}/api/diagnose` : null,
    providerLabel: effectiveChain.join(" → "),
    providerChain: Object.freeze(effectiveChain),
    included: Object.freeze(included.map(String)),
    excluded: Object.freeze([...(input.excluded || DEFAULT_EXCLUDED)].map(String)),
  })
}

export function formatPayloadPreview(payload: unknown): string {
  try {
    return JSON.stringify(payload, null, 2)
  } catch {
    return String(payload)
  }
}
