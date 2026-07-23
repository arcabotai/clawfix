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

  return Object.freeze({
    destination: hostname,
    baseUrl: url.origin,
    endpointUrl: `${url.origin}/api/v2/agent/messages`,
    providerLabel: effectiveChain.join(" → "),
    providerChain: Object.freeze(effectiveChain),
    included: Object.freeze([...(input.included || DEFAULT_INCLUDED)].map(String)),
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
