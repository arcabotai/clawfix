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
  readonly revision: string | null
  readonly scanning: boolean
  readonly error: string | null
}

export interface SessionLike {
  getState(): {
    readonly revision: string | null
    readonly findings?: readonly any[]
    readonly scanning?: boolean
    readonly scanError?: { readonly message?: string } | null
    readonly transcript?: readonly { readonly role?: string; readonly text?: string }[]
    readonly summary?: unknown
  }
  scan(): Promise<unknown>
  cancelScan?(): boolean
  appendMessage?(role: string, text: string): unknown
}

export interface OfflineAnalyzerLike {
  handle(input: string): Promise<{ readonly message?: string } | string> | { readonly message?: string } | string
}

type Listener = (view: TuiSessionView) => void

function asFinding(raw: any): TuiFinding | null {
  if (!raw || typeof raw !== "object") return null
  const id = typeof raw.id === "string" ? raw.id : null
  const title = typeof raw.title === "string"
    ? raw.title
    : (typeof raw.message === "string" ? raw.message : null)
  if (!id || !title) return null
  return Object.freeze({
    id,
    title,
    severity: typeof raw.severity === "string" ? raw.severity : "info",
    repairable: Boolean(raw.repairable),
    repairId: typeof raw.repairId === "string" ? raw.repairId : null,
  })
}

function formatMessage(entry: { readonly role?: string; readonly text?: string }): string {
  const role = entry.role || "system"
  const text = entry.text || ""
  return `${role}: ${text}`
}

function projectView(session: SessionLike, prompt: string): TuiSessionView {
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
  else if (error) status = `Scan error: ${error}`
  else if (state.revision) {
    const n = findings.length
    status = n === 0
      ? `Revision ${state.revision} · no findings`
      : `Revision ${state.revision} · ${n} finding${n === 1 ? "" : "s"}`
  }

  return Object.freeze({
    status,
    prompt,
    messages,
    findings,
    revision: state.revision ?? null,
    scanning,
    error,
  })
}

/**
 * Bridges a ClawFix session controller into a frozen TUI view model.
 * Pure projection + command surface — no OpenTUI imports, testable without Bun renderer.
 */
export function createSessionBridge(options: {
  readonly session: SessionLike
  readonly offlineAnalyzer?: OfflineAnalyzerLike
  readonly prompt?: string
  readonly onEvent?: (event: unknown) => void
}) {
  const session = options.session
  if (!session || typeof session.getState !== "function" || typeof session.scan !== "function") {
    throw new TypeError("session must provide getState and scan")
  }
  const prompt = options.prompt || "Tell me what is going wrong with your OpenClaw."
  const listeners = new Set<Listener>()
  let view = projectView(session, prompt)

  function publish() {
    view = projectView(session, prompt)
    for (const listener of listeners) listener(view)
  }

  function notifyExternal(event: unknown) {
    options.onEvent?.(event)
    publish()
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
    /** Call this from the session controller's onEvent hook. */
    handleSessionEvent(event: unknown) {
      notifyExternal(event)
    },
    async scan() {
      publish()
      try {
        await session.scan()
      } finally {
        publish()
      }
      return this.getView()
    },
    cancelScan() {
      const cancelled = session.cancelScan?.() ?? false
      publish()
      return cancelled
    },
    async send(input: string) {
      const text = String(input || "").trim()
      if (!text) return this.getView()
      session.appendMessage?.("user", text)
      publish()

      if (options.offlineAnalyzer) {
        const raw = await options.offlineAnalyzer.handle(text)
        const message = typeof raw === "string" ? raw : (raw?.message || "")
        if (message) session.appendMessage?.("assistant", message)
      }
      publish()
      return this.getView()
    },
  })
}

export function createFakeSession(): TuiSessionView {
  return Object.freeze({
    status: "Local session ready",
    prompt: "Tell me what is going wrong with your OpenClaw.",
    messages: Object.freeze([] as string[]),
    findings: Object.freeze([] as TuiFinding[]),
    revision: null,
    scanning: false,
    error: null,
  })
}
