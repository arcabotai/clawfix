/** Shared TUI view-model types (UI-neutral, frozen at the edges). */

export type Severity = string

export interface DisclosureView {
  readonly destination: string
  readonly baseUrl: string
  readonly endpointUrl: string
  readonly providerLabel: string
  readonly providerChain: readonly string[]
  readonly included: readonly string[]
  readonly excluded: readonly string[]
}

export interface RepairEffectView {
  readonly kind: string
  readonly summary: string
}

export interface RepairPlanView {
  readonly planId: string
  readonly scanFingerprint: string
  readonly repairIds: readonly string[]
  readonly risk: string
  readonly summary: string
  readonly effects: readonly RepairEffectView[]
  readonly previewText: string
  readonly unifiedDiff: string | null
  readonly backupRequired: boolean
  readonly restartRequired: boolean
  readonly createdAt: string
}

export type TranscriptItem =
  | {
      readonly kind: "message"
      readonly id: string
      readonly role: "user" | "assistant" | "system"
      readonly text: string
      readonly streaming?: boolean
    }
  | {
      readonly kind: "activity"
      readonly id: string
      readonly label: string
    }
  | {
      readonly kind: "finding"
      readonly id: string
      readonly findingId: string
      readonly title: string
      readonly severity: Severity
      readonly repairable: boolean
      readonly repairId: string | null
      readonly evidence: string | null
    }
  | {
      readonly kind: "repair"
      readonly id: string
      readonly plan: RepairPlanView
      readonly rationale: string
      readonly status: "proposed" | "approved" | "running" | "completed" | "failed" | "cancelled" | "stale"
    }
  | {
      readonly kind: "warning"
      readonly id: string
      readonly message: string
    }
  | {
      readonly kind: "error"
      readonly id: string
      readonly message: string
    }

export type DialogFocusPrivacy = "stay-local" | "inspect" | "continue"
export type DialogFocusApproval = "cancel" | "details" | "approve"

export type DialogState =
  | { readonly type: "none" }
  | {
      readonly type: "privacy"
      readonly disclosure: DisclosureView
      readonly payloadJson: string
      readonly pendingMessage: string
      readonly focus: DialogFocusPrivacy
      readonly showPayload: boolean
    }
  | {
      readonly type: "approval"
      readonly plan: RepairPlanView
      readonly rationale: string
      readonly focus: DialogFocusApproval
    }
  | {
      readonly type: "diff"
      readonly title: string
      readonly unifiedDiff: string
      readonly returnTo: "approval" | "none"
      readonly plan?: RepairPlanView
      readonly rationale?: string
    }

export interface LayoutMode {
  readonly width: number
  readonly height: number
  readonly mode: "wide" | "medium" | "narrow"
  readonly showSidebar: boolean
  readonly showKeyHints: boolean
}

export function resolveLayout(width: number, height: number): LayoutMode {
  const w = Math.max(0, Math.floor(width || 0))
  const h = Math.max(0, Math.floor(height || 0))
  if (w >= 100) {
    return Object.freeze({ width: w, height: h, mode: "wide", showSidebar: true, showKeyHints: true })
  }
  if (w >= 60) {
    return Object.freeze({ width: w, height: h, mode: "medium", showSidebar: false, showKeyHints: true })
  }
  return Object.freeze({ width: w, height: h, mode: "narrow", showSidebar: false, showKeyHints: false })
}

export function emptyDialog(): DialogState {
  return Object.freeze({ type: "none" })
}

export function cycleFocus<T extends string>(options: readonly T[], current: T, delta: number): T {
  if (options.length === 0) return current
  const idx = Math.max(0, options.indexOf(current))
  const next = (idx + delta + options.length * 8) % options.length
  return options[next]!
}
