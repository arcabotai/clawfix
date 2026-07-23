import { buildDisclosureView, formatPayloadPreview } from "./lib/disclosure"
import {
  emptyDialog,
  cycleFocus,
  type DialogFocusApproval,
  type DialogFocusPrivacy,
  type DialogState,
  type DisclosureView,
  type RepairPlanView,
  type TranscriptItem,
} from "./lib/models"
import { sanitizeDisplayText } from "./lib/paste"

export interface TuiFinding {
  readonly id: string
  readonly title: string
  readonly severity: string
  readonly repairable: boolean
  readonly repairId: string | null
}

export interface TuiSessionView {
  readonly status: string
  readonly prompt: string
  readonly messages: readonly string[]
  readonly findings: readonly TuiFinding[]
  readonly items: readonly TranscriptItem[]
  readonly revision: string | null
  readonly scanning: boolean
  readonly error: string | null
  readonly dialog: DialogState
  readonly remoteConsent: boolean
  readonly aiMode: "local" | "remote-pending" | "remote"
  readonly composerLocked: boolean
  readonly busy: boolean
  readonly helpVisible: boolean
  readonly draft: string
  readonly queueNote: string | null
}

export interface SessionLike {
  getState(): {
    readonly revision: string | null
    readonly findings?: readonly any[]
    readonly scanning?: boolean
    readonly scanError?: { readonly message?: string } | null
    readonly transcript?: readonly { readonly role?: string; readonly text?: string; readonly id?: string }[]
    readonly summary?: unknown
  }
  scan(): Promise<unknown>
  cancelScan?(): boolean
  appendMessage?(role: string, text: string): unknown
  proposeRepair?(findingId: string): {
    readonly status: string
    readonly plan?: any
  }
  approveRepair?(planId: string): Promise<unknown> | unknown
  cancelRepair?(): unknown
}

export interface OfflineAnalyzerLike {
  handle(input: string): Promise<{
    readonly message?: string
    readonly intent?: string
    readonly status?: string
    readonly plan?: any
    readonly finding?: any
  } | string> | {
    readonly message?: string
    readonly intent?: string
    readonly status?: string
    readonly plan?: any
    readonly finding?: any
  } | string
}

/** Optional remote analyzer — never called without consent. */
export interface RemoteAnalyzerLike {
  send(input: {
    readonly message: string
    readonly consentGranted: boolean
    readonly signal?: AbortSignal
  }): AsyncIterable<unknown> | Promise<{ readonly message?: string; readonly events?: readonly any[] }>
}

type Listener = (view: TuiSessionView) => void

let idCounter = 0
function nextId(prefix: string): string {
  idCounter += 1
  return `${prefix}-${idCounter}`
}

function asFinding(raw: any): TuiFinding | null {
  if (!raw || typeof raw !== "object") return null
  const id = typeof raw.id === "string" ? raw.id : null
  const title = typeof raw.title === "string"
    ? raw.title
    : (typeof raw.message === "string" ? raw.message : null)
  if (!id || !title) return null
  return Object.freeze({
    id,
    title: sanitizeDisplayText(title, 400),
    severity: typeof raw.severity === "string" ? raw.severity : "info",
    repairable: Boolean(raw.repairable),
    repairId: typeof raw.repairId === "string" ? raw.repairId : null,
  })
}

function formatMessage(entry: { readonly role?: string; readonly text?: string }): string {
  const role = entry.role || "system"
  const text = sanitizeDisplayText(entry.text || "", 32_000)
  return `${role}: ${text}`
}

function evidenceSummary(raw: any): string | null {
  if (!raw || typeof raw !== "object") return null
  if (typeof raw.summary === "string" && raw.summary.trim()) return sanitizeDisplayText(raw.summary, 400)
  if (Array.isArray(raw.evidence) && raw.evidence.length > 0) {
    const first = raw.evidence[0]
    if (typeof first === "string") return sanitizeDisplayText(first, 200)
    if (first && typeof first === "object") {
      const detail = first.detail || first.label || ""
      return sanitizeDisplayText(String(detail), 200) || null
    }
  }
  return null
}

function planFromRaw(raw: any): RepairPlanView | null {
  if (!raw || typeof raw !== "object") return null
  const planId = typeof raw.planId === "string" ? raw.planId : (typeof raw.id === "string" ? raw.id : null)
  if (!planId) return null
  const repairIds = Array.isArray(raw.repairIds)
    ? raw.repairIds.map(String)
    : (typeof raw.repairId === "string" ? [raw.repairId] : [])
  const effects = Array.isArray(raw.effects)
    ? raw.effects.map((e: any) => Object.freeze({
      kind: String(e?.kind || e?.type || "effect"),
      summary: sanitizeDisplayText(String(e?.summary || e?.description || e || ""), 300),
    }))
    : []

  let unifiedDiff: string | null = null
  let previewText = ""
  if (raw.preview && typeof raw.preview === "object") {
    if (typeof raw.preview.unifiedDiff === "string") unifiedDiff = raw.preview.unifiedDiff
    else if (typeof raw.preview.diff === "string") unifiedDiff = raw.preview.diff
    if (typeof raw.preview.summary === "string") previewText = raw.preview.summary
    else if (typeof raw.preview.text === "string") previewText = raw.preview.text
  } else if (typeof raw.preview === "string") {
    previewText = raw.preview
    if (raw.preview.includes("\n") && (raw.preview.includes("+++") || raw.preview.includes("@@"))) {
      unifiedDiff = raw.preview
    }
  }
  if (typeof raw.unifiedDiff === "string") unifiedDiff = raw.unifiedDiff

  return Object.freeze({
    planId,
    scanFingerprint: String(raw.scanFingerprint || raw.revision || ""),
    repairIds: Object.freeze(repairIds),
    risk: String(raw.risk || "medium"),
    summary: sanitizeDisplayText(String(raw.summary || raw.title || planId), 500),
    effects: Object.freeze(effects),
    previewText: sanitizeDisplayText(previewText, 800),
    unifiedDiff: unifiedDiff ? sanitizeDisplayText(unifiedDiff, 20_000) : null,
    backupRequired: Boolean(raw.backupRequired),
    restartRequired: Boolean(raw.restartRequired ?? raw.needsRestart),
    createdAt: String(raw.createdAt || new Date().toISOString()),
  })
}

function projectItems(session: SessionLike, extras: readonly TranscriptItem[]): TranscriptItem[] {
  const state = session.getState()
  const items: TranscriptItem[] = []

  for (const entry of Array.isArray(state.transcript) ? state.transcript : []) {
    const roleRaw = String(entry.role || "system")
    const role = roleRaw === "user" || roleRaw === "assistant" ? roleRaw : "system"
    items.push(Object.freeze({
      kind: "message",
      id: typeof entry.id === "string" ? entry.id : nextId("msg"),
      role,
      text: sanitizeDisplayText(entry.text || "", 32_000),
    }))
  }

  for (const finding of (Array.isArray(state.findings) ? state.findings : []).map(asFinding).filter(Boolean) as TuiFinding[]) {
    // Only inject findings once if not already represented via extras repair flow cards
    items.push(Object.freeze({
      kind: "finding",
      id: `finding-card-${finding.id}`,
      findingId: finding.id,
      title: finding.title,
      severity: finding.severity,
      repairable: finding.repairable,
      repairId: finding.repairId,
      evidence: null,
    }))
  }

  for (const extra of extras) items.push(extra)
  return items
}

function projectView(
  session: SessionLike,
  prompt: string,
  ui: {
    extras: TranscriptItem[]
    dialog: DialogState
    remoteConsent: boolean
    aiMode: TuiSessionView["aiMode"]
    busy: boolean
    helpVisible: boolean
    draft: string
    queueNote: string | null
    activityLabel: string | null
  },
): TuiSessionView {
  const state = session.getState()
  const findings = Object.freeze(
    (Array.isArray(state.findings) ? state.findings : [])
      .map(asFinding)
      .filter((item): item is TuiFinding => item !== null),
  )
  const messages = Object.freeze(
    (Array.isArray(state.transcript) ? state.transcript : []).map(formatMessage),
  )
  const scanning = Boolean(state.scanning)
  const error = state.scanError?.message ? String(state.scanError.message) : null

  let status = "Local session ready"
  if (scanning) status = "Scanning OpenClaw…"
  else if (ui.busy) status = "Working…"
  else if (error) status = `Scan error: ${error}`
  else if (state.revision) {
    const n = findings.length
    status = n === 0
      ? `Revision ${state.revision} · no findings`
      : `Revision ${state.revision} · ${n} finding${n === 1 ? "" : "s"}`
  }
  if (ui.aiMode === "local") status = `${status} · AI local only`
  else if (ui.aiMode === "remote") status = `${status} · AI remote (consented)`
  else if (ui.aiMode === "remote-pending") status = `${status} · AI consent required`

  const extras = [...ui.extras]
  if (ui.activityLabel) {
    extras.unshift(Object.freeze({
      kind: "activity" as const,
      id: "activity-current",
      label: ui.activityLabel,
    }))
  }

  const dialogOpen = ui.dialog.type !== "none"
  return Object.freeze({
    status,
    prompt,
    messages,
    findings,
    items: Object.freeze(projectItems(session, extras)),
    revision: state.revision ?? null,
    scanning,
    error,
    dialog: ui.dialog,
    remoteConsent: ui.remoteConsent,
    aiMode: ui.aiMode,
    composerLocked: dialogOpen,
    busy: ui.busy || scanning,
    helpVisible: ui.helpVisible,
    draft: ui.draft,
    queueNote: ui.queueNote,
  })
}

/**
 * Bridges a ClawFix session controller into a frozen TUI view model.
 * Pure projection + command surface — no OpenTUI imports, testable without Bun renderer.
 */
export function createSessionBridge(options: {
  readonly session: SessionLike
  readonly offlineAnalyzer?: OfflineAnalyzerLike
  readonly remoteAnalyzer?: RemoteAnalyzerLike
  readonly prompt?: string
  readonly onEvent?: (event: unknown) => void
  readonly remoteBaseUrl?: string
  readonly preferRemote?: boolean
}) {
  const session = options.session
  if (!session || typeof session.getState !== "function" || typeof session.scan !== "function") {
    throw new TypeError("session must provide getState and scan")
  }
  const prompt = options.prompt || "Tell me what is going wrong with your OpenClaw."
  const listeners = new Set<Listener>()

  let extras: TranscriptItem[] = []
  let dialog: DialogState = emptyDialog()
  let remoteConsent = false
  let aiMode: TuiSessionView["aiMode"] = options.preferRemote && options.remoteAnalyzer
    ? "remote-pending"
    : "local"
  let busy = false
  let helpVisible = false
  let draft = ""
  let queueNote: string | null = null
  let activityLabel: string | null = null
  let pendingRemoteMessage: string | null = null
  let abortActive: AbortController | null = null
  let disclosureCache: DisclosureView = buildDisclosureView({ baseUrl: options.remoteBaseUrl })

  function snapshot(): TuiSessionView {
    return projectView(session, prompt, {
      extras,
      dialog,
      remoteConsent,
      aiMode,
      busy,
      helpVisible,
      draft,
      queueNote,
      activityLabel,
    })
  }

  let view = snapshot()

  function publish() {
    view = snapshot()
    for (const listener of listeners) listener(view)
  }

  function notifyExternal(event: unknown) {
    options.onEvent?.(event)
    publish()
  }

  function pushExtra(item: TranscriptItem) {
    extras = [...extras, item]
  }

  function openPrivacyDialog(message: string) {
    const payload = {
      conversationId: "pending-session",
      message,
      diagnosticId: null,
      availableRepairs: view.findings
        .filter((f) => f.repairable && f.repairId)
        .slice(0, 32)
        .map((f) => ({ id: f.repairId, title: f.title, risk: "medium" })),
    }
    disclosureCache = buildDisclosureView({ baseUrl: options.remoteBaseUrl })
    dialog = Object.freeze({
      type: "privacy",
      disclosure: disclosureCache,
      payloadJson: formatPayloadPreview(payload),
      pendingMessage: message,
      // Default focus is Stay local — never Continue
      focus: "stay-local" as DialogFocusPrivacy,
      showPayload: false,
    })
    pendingRemoteMessage = message
    publish()
  }

  function openApprovalDialog(plan: RepairPlanView, rationale: string) {
    dialog = Object.freeze({
      type: "approval",
      plan,
      rationale: sanitizeDisplayText(rationale, 800),
      // Default focus Cancel — never Fix it
      focus: "cancel" as DialogFocusApproval,
    })
    publish()
  }

  async function runOffline(text: string) {
    if (!options.offlineAnalyzer) {
      session.appendMessage?.("assistant", "Local analyzer is not configured.")
      return
    }
    activityLabel = "Thinking locally…"
    busy = true
    publish()
    try {
      const raw = await options.offlineAnalyzer.handle(text)
      const result = typeof raw === "string" ? { message: raw } : (raw || {})
      const message = typeof result.message === "string" ? result.message : ""
      if (message) session.appendMessage?.("assistant", sanitizeDisplayText(message))

      if (result.intent === "propose_repair" && result.plan) {
        const plan = planFromRaw(result.plan)
        if (plan) {
          pushExtra(Object.freeze({
            kind: "repair",
            id: nextId("repair"),
            plan,
            rationale: message || plan.summary,
            status: result.status === "proposed" ? "proposed" : "failed",
          }))
          if (result.status === "proposed") {
            openApprovalDialog(plan, message || plan.summary)
          }
        }
      }
    } finally {
      activityLabel = null
      busy = false
      publish()
    }
  }

  async function runRemote(text: string) {
    if (!options.remoteAnalyzer) {
      await runOffline(text)
      return
    }
    if (!remoteConsent) {
      openPrivacyDialog(text)
      return
    }
    activityLabel = "Contacting ClawFix service…"
    busy = true
    abortActive = new AbortController()
    publish()
    try {
      const stream = options.remoteAnalyzer.send({
        message: text,
        consentGranted: true,
        signal: abortActive.signal,
      })
      let assistant = ""
      const assistantId = nextId("asst")

      if (stream && typeof (stream as any)[Symbol.asyncIterator] === "function") {
        for await (const event of stream as AsyncIterable<any>) {
          const type = event?.type || event?.event
          if (type === "assistant.delta") {
            const delta = sanitizeDisplayText(String(event.text || event.delta || ""), 4000)
            assistant += delta
            // Replace streaming card
            extras = extras.filter((i) => i.id !== assistantId)
            pushExtra(Object.freeze({
              kind: "message",
              id: assistantId,
              role: "assistant" as const,
              text: assistant,
              streaming: true,
            }))
            publish()
          } else if (type === "repair.proposed") {
            const plan = planFromRaw(event.plan || event)
            if (plan) {
              pushExtra(Object.freeze({
                kind: "repair",
                id: nextId("repair"),
                plan,
                rationale: sanitizeDisplayText(String(event.rationale || ""), 800),
                status: "proposed" as const,
              }))
              openApprovalDialog(plan, String(event.rationale || plan.summary))
            }
          } else if (type === "agent.error") {
            pushExtra(Object.freeze({
              kind: "error",
              id: nextId("err"),
              message: sanitizeDisplayText(String(event.message || event.error || "Remote analyzer error"), 500),
            }))
          }
        }
        if (assistant) {
          extras = extras.filter((i) => i.id !== assistantId)
          session.appendMessage?.("assistant", assistant)
        }
      } else {
        const result = await (stream as Promise<any>)
        const message = typeof result?.message === "string" ? result.message : ""
        if (message) session.appendMessage?.("assistant", sanitizeDisplayText(message))
        for (const event of Array.isArray(result?.events) ? result.events : []) {
          if (event?.type === "repair.proposed") {
            const plan = planFromRaw(event.plan || event)
            if (plan) openApprovalDialog(plan, String(event.rationale || plan.summary))
          }
        }
      }
    } catch (error: any) {
      const msg = sanitizeDisplayText(error?.message || String(error), 500)
      pushExtra(Object.freeze({
        kind: "error",
        id: nextId("err"),
        message: `Remote request failed: ${msg}. Staying local; nothing was uploaded after the error.`,
      }))
      // Never silently fall back to upload; offline is explicit recovery.
      aiMode = remoteConsent ? "remote" : "local"
    } finally {
      activityLabel = null
      busy = false
      abortActive = null
      publish()
    }
  }

  return Object.freeze({
    getView(): TuiSessionView {
      return view
    },
    subscribe(listener: Listener): () => void {
      if (typeof listener !== "function") throw new TypeError("listener must be a function")
      listeners.add(listener)
      listener(view)
      return () => { listeners.delete(listener) }
    },
    handleSessionEvent(event: unknown) {
      notifyExternal(event)
    },
    setDraft(value: string) {
      draft = String(value ?? "")
      publish()
    },
    toggleHelp() {
      helpVisible = !helpVisible
      publish()
    },
    async scan() {
      activityLabel = "Finding OpenClaw…"
      publish()
      try {
        await session.scan()
      } finally {
        activityLabel = null
        publish()
      }
      return this.getView()
    },
    cancelScan() {
      const cancelled = session.cancelScan?.() ?? false
      if (abortActive) {
        abortActive.abort()
        abortActive = null
      }
      busy = false
      activityLabel = null
      queueNote = cancelled ? "Cancelled." : queueNote
      publish()
      return cancelled
    },
    async send(input: string) {
      const text = String(input || "").trim()
      if (!text) return this.getView()
      if (dialog.type !== "none") {
        queueNote = "Finish or dismiss the open dialog before sending."
        publish()
        return this.getView()
      }
      if (busy) {
        queueNote = "A response is already in progress. Press Ctrl+C to cancel, then resend."
        publish()
        return this.getView()
      }

      draft = ""
      queueNote = null
      session.appendMessage?.("user", text)
      publish()

      if (options.preferRemote && options.remoteAnalyzer && !remoteConsent) {
        openPrivacyDialog(text)
        return this.getView()
      }

      if (remoteConsent && options.remoteAnalyzer && options.preferRemote) {
        await runRemote(text)
      } else {
        await runOffline(text)
      }
      return this.getView()
    },

    /** Privacy dialog controls */
    privacyMoveFocus(delta: number) {
      if (dialog.type !== "privacy") return
      const order: DialogFocusPrivacy[] = ["stay-local", "inspect", "continue"]
      dialog = Object.freeze({ ...dialog, focus: cycleFocus(order, dialog.focus, delta) })
      publish()
    },
    privacySetFocus(focus: DialogFocusPrivacy) {
      if (dialog.type !== "privacy") return
      dialog = Object.freeze({ ...dialog, focus })
      publish()
    },
    privacyToggleInspect() {
      if (dialog.type !== "privacy") return
      dialog = Object.freeze({ ...dialog, showPayload: !dialog.showPayload, focus: "inspect" })
      publish()
    },
    async privacyConfirm() {
      if (dialog.type !== "privacy") return this.getView()
      const focus = dialog.focus
      const pending = dialog.pendingMessage || pendingRemoteMessage || ""
      if (focus === "inspect") {
        this.privacyToggleInspect()
        return this.getView()
      }
      if (focus === "continue") {
        remoteConsent = true
        aiMode = "remote"
        dialog = emptyDialog()
        pendingRemoteMessage = null
        publish()
        if (pending) await runRemote(pending)
        return this.getView()
      }
      // stay-local
      remoteConsent = false
      aiMode = "local"
      dialog = emptyDialog()
      pendingRemoteMessage = null
      publish()
      if (pending) await runOffline(pending)
      return this.getView()
    },
    privacyDismissStayLocal() {
      if (dialog.type !== "privacy") return
      const pending = dialog.pendingMessage || pendingRemoteMessage || ""
      remoteConsent = false
      aiMode = "local"
      dialog = emptyDialog()
      pendingRemoteMessage = null
      publish()
      if (pending) void runOffline(pending)
    },

    /** Approval dialog controls */
    approvalMoveFocus(delta: number) {
      if (dialog.type !== "approval") return
      const order: DialogFocusApproval[] = ["cancel", "details", "approve"]
      dialog = Object.freeze({ ...dialog, focus: cycleFocus(order, dialog.focus, delta) })
      publish()
    },
    approvalSetFocus(focus: DialogFocusApproval) {
      if (dialog.type !== "approval") return
      dialog = Object.freeze({ ...dialog, focus })
      publish()
    },
    approvalShowDiff() {
      if (dialog.type !== "approval") return
      const plan = dialog.plan
      const diff = plan.unifiedDiff || plan.previewText || "(no config diff for this repair)"
      dialog = Object.freeze({
        type: "diff",
        title: `Preview · ${plan.summary}`,
        unifiedDiff: diff,
        returnTo: "approval" as const,
        plan,
        rationale: dialog.rationale,
      })
      publish()
    },
    async approvalConfirm() {
      if (dialog.type !== "approval") return this.getView()
      const focus = dialog.focus
      const plan = dialog.plan
      if (focus === "details") {
        this.approvalShowDiff()
        return this.getView()
      }
      if (focus === "approve") {
        // High risk: never approve with a single Enter from default focus (default is cancel).
        if (String(plan.risk).toLowerCase() === "high") {
          pushExtra(Object.freeze({
            kind: "warning",
            id: nextId("warn"),
            message: "High-risk repairs require manual guidance and cannot be auto-approved here.",
          }))
          dialog = emptyDialog()
          publish()
          return this.getView()
        }
        dialog = emptyDialog()
        busy = true
        activityLabel = "Applying repair…"
        publish()
        try {
          if (typeof session.approveRepair === "function") {
            await session.approveRepair(plan.planId)
          }
          extras = extras.map((item) => {
            if (item.kind === "repair" && item.plan.planId === plan.planId) {
              return Object.freeze({ ...item, status: "completed" as const })
            }
            return item
          })
          pushExtra(Object.freeze({
            kind: "message",
            id: nextId("msg"),
            role: "assistant" as const,
            text: `Repair applied for plan ${plan.planId}. Verification runs against local detectors.`,
          }))
        } catch (error: any) {
          extras = extras.map((item) => {
            if (item.kind === "repair" && item.plan.planId === plan.planId) {
              return Object.freeze({ ...item, status: "failed" as const })
            }
            return item
          })
          pushExtra(Object.freeze({
            kind: "error",
            id: nextId("err"),
            message: sanitizeDisplayText(error?.message || "Repair failed", 500),
          }))
        } finally {
          busy = false
          activityLabel = null
          publish()
        }
        return this.getView()
      }
      // cancel
      session.cancelRepair?.()
      extras = extras.map((item) => {
        if (item.kind === "repair" && item.plan.planId === plan.planId) {
          return Object.freeze({ ...item, status: "cancelled" as const })
        }
        return item
      })
      dialog = emptyDialog()
      publish()
      return this.getView()
    },
    closeDialog() {
      if (dialog.type === "diff" && dialog.returnTo === "approval" && dialog.plan) {
        dialog = Object.freeze({
          type: "approval",
          plan: dialog.plan,
          rationale: dialog.rationale || dialog.plan.summary,
          focus: "cancel" as DialogFocusApproval,
        })
        publish()
        return
      }
      if (dialog.type === "privacy") {
        this.privacyDismissStayLocal()
        return
      }
      if (dialog.type === "approval") {
        const plan = dialog.plan
        extras = extras.map((item) => {
          if (item.kind === "repair" && item.plan.planId === plan.planId) {
            return Object.freeze({ ...item, status: "cancelled" as const })
          }
          return item
        })
      }
      dialog = emptyDialog()
      publish()
    },

    /** Test helpers */
    _testOpenPrivacy(message = "help me") {
      openPrivacyDialog(message)
    },
    _testOpenApproval(plan: RepairPlanView, rationale = plan.summary) {
      openApprovalDialog(plan, rationale)
    },
  })
}

export function createFakeSession(): TuiSessionView {
  return Object.freeze({
    status: "Local session ready · AI local only",
    prompt: "Tell me what is going wrong with your OpenClaw.",
    messages: Object.freeze([] as string[]),
    findings: Object.freeze([] as TuiFinding[]),
    items: Object.freeze([] as TranscriptItem[]),
    revision: null,
    scanning: false,
    error: null,
    dialog: emptyDialog(),
    remoteConsent: false,
    aiMode: "local",
    composerLocked: false,
    busy: false,
    helpVisible: false,
    draft: "",
    queueNote: null,
  })
}

export type SessionBridge = ReturnType<typeof createSessionBridge>
