// @ts-nocheck — imports plain-JS cli/ modules without type declarations (TS7016).
/**
 * Remote analyzer — client for the ClawFix hosted agent v2 endpoint.
 *
 * Contract (src/routes/agent-v2.js + src/agent/contract.js):
 *   POST {baseUrl}/api/v2/agent/messages
 *   Body: { conversationId, message, diagnosticId?, availableRepairs: [{id,title,risk}] }
 *   SSE events: agent.meta, assistant.delta {text}, repair.proposed {repairId, rationale},
 *               agent.error {error, fatal}, agent.done
 *
 * The session bridge only calls send() after explicit user consent (privacy dialog).
 * Diagnostic upload goes through /api/diagnose with redactOutbound applied — nothing
 * leaves the machine until consent, and even then only redacted fields.
 */
import { randomUUID } from "node:crypto"

import { projectLocalIssuesForUpload, redactOutbound, redactText } from "../../bin/security.js"

const MAX_REPAIRS = 32
const DEFAULT_TIMEOUT_MS = 90_000
const MAX_SSE_BYTES = 1_000_000
const MAX_SSE_BUFFER_BYTES = 256_000
const MAX_ASSISTANT_CHARS = 64_000
const CONV_RE = /^[A-Za-z0-9_-]{8,128}$/

export interface RemoteAnalyzerOptions {
  readonly session: {
    getState(): {
      readonly diagnostic?: unknown
      readonly issues?: readonly any[]
      readonly findings?: readonly any[]
    }
  }
  readonly baseUrl?: string
  readonly fetchImpl?: typeof fetch
  readonly timeoutMs?: number
}

function normalizeBaseUrl(raw?: string): string {
  const value = (raw || process.env.CLAWFIX_API || "https://clawfix.dev").trim()
  try {
    return new URL(value).origin
  } catch {
    return "https://clawfix.dev"
  }
}

function combineSignals(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  if (!signal) return timeout
  return AbortSignal.any([signal, timeout])
}

function safeMessage(value: unknown): string {
  return redactText(String(value || "")).slice(0, 4000)
}

/** Parse `event: X\ndata: {...}\n\n` frames from an SSE byte stream. */
async function* readSseEvents(body: ReadableStream<Uint8Array>, signal?: AbortSignal) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let totalBytes = 0
  let assistantChars = 0
  try {
    for (;;) {
      if (signal?.aborted) return
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > MAX_SSE_BYTES) throw new Error("ClawFix SSE response exceeded the byte limit")
      buffer += decoder.decode(value, { stream: true })
      if (buffer.length > MAX_SSE_BUFFER_BYTES) {
        throw new Error("ClawFix SSE frame exceeded the buffer limit")
      }
      let idx: number
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        let event = "message"
        let data = ""
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim()
          else if (line.startsWith("data:")) data += line.slice(5).trim()
        }
        if (!data) continue
        try {
          const parsed = JSON.parse(data)
          if (event === "assistant.delta") {
            assistantChars += String(parsed?.text || parsed?.delta || "").length
            if (assistantChars > MAX_ASSISTANT_CHARS) {
              throw new Error("ClawFix assistant response exceeded the character limit")
            }
          }
          yield { type: event, ...parsed }
        } catch (error) {
          if (error instanceof Error && error.message.startsWith("ClawFix ")) throw error
          // ignore malformed frames
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

export function createRemoteAnalyzer(options: RemoteAnalyzerOptions) {
  const baseUrl = normalizeBaseUrl(options.baseUrl)
  const fetchImpl = options.fetchImpl ?? fetch
  const requestedTimeout = Number(options.timeoutMs)
  const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
    ? requestedTimeout
    : DEFAULT_TIMEOUT_MS
  const conversationId = randomUUID()
  const headers = Object.freeze({
    "Content-Type": "application/json",
    ...(process.env.CLAWFIX_API_TOKEN
      ? { Authorization: `Bearer ${process.env.CLAWFIX_API_TOKEN}` }
      : {}),
  })
  let diagnosticId: string | null = null

  async function ensureDiagnosticId(signal?: AbortSignal): Promise<string | null> {
    if (diagnosticId) return diagnosticId
    const state = options.session.getState()
    if (!state.diagnostic) return null
    try {
      const payload = redactOutbound({
        ...(state.diagnostic as Record<string, unknown>),
        _localIssues: projectLocalIssuesForUpload(state.issues || []),
      })
      const resp = await fetchImpl(`${baseUrl}/api/diagnose`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: signal ?? null,
      } as RequestInit)
      if (!resp.ok) return null
      const data: any = await resp.json()
      const id = typeof data?.fixId === "string" && CONV_RE.test(data.fixId) ? data.fixId : null
      diagnosticId = id
      return id
    } catch (error) {
      if (signal?.aborted) throw error
      return null
    }
  }

  function availableRepairs() {
    const state = options.session.getState()
    const seen = new Set<string>()
    const repairs: { id: string; title: string; risk: string }[] = []
    for (const finding of state.findings || []) {
      const id = typeof finding?.repairId === "string" ? finding.repairId : null
      if (!id || seen.has(id)) continue
      seen.add(id)
      const title = typeof finding?.title === "string" ? finding.title : id
      const risk = ["low", "medium", "high"].includes(String(finding?.risk))
        ? String(finding.risk)
        : "medium"
      repairs.push({ id, title: title.slice(0, 200), risk })
      if (repairs.length >= MAX_REPAIRS) break
    }
    return repairs
  }

  return Object.freeze({
    conversationId,
    baseUrl,
    endpointUrl: `${baseUrl}/api/v2/agent/messages`,

    /**
     * Describe exactly what send() would transmit for `message`, for the consent dialog.
     * Built from the same conversationId and availableRepairs() the request uses, so the
     * "Inspect exact payload" view cannot drift from the real body.
     */
    describeOutbound(message: string) {
      const state = options.session.getState()
      const uploadsDiagnostic = Boolean(state.diagnostic) && !diagnosticId
      return Object.freeze({
        uploadsDiagnostic,
        diagnosticEndpointUrl: uploadsDiagnostic ? `${baseUrl}/api/diagnose` : null,
        payload: {
          ...(uploadsDiagnostic
            ? { ">> first, POST /api/diagnose": "the redacted diagnostic below is uploaded and returns the diagnosticId used here" }
            : {}),
          conversationId,
          message: safeMessage(message),
          ...(diagnosticId ? { diagnosticId } : {}),
          availableRepairs: availableRepairs(),
        },
      })
    },
    async *send(input: { readonly message: string; readonly consentGranted: boolean; readonly signal?: AbortSignal }) {
      if (input.consentGranted !== true) {
        yield {
          type: "agent.error",
          error: "Remote analysis requires explicit consent.",
          fatal: true,
        }
        return
      }
      const signal = combineSignals(input.signal, timeoutMs)
      let diagId: string | null = null
      try {
        diagId = await ensureDiagnosticId(signal)
        const resp = await fetchImpl(`${baseUrl}/api/v2/agent/messages`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            conversationId,
            message: safeMessage(input.message),
            ...(diagId ? { diagnosticId: diagId } : {}),
            availableRepairs: availableRepairs(),
          }),
          signal: signal ?? null,
        } as RequestInit)
        if (!resp.ok || !resp.body) {
          yield { type: "agent.error", error: `ClawFix service returned HTTP ${resp.status}`, fatal: true }
          return
        }
        for await (const event of readSseEvents(resp.body, signal)) {
          yield event
        }
      } catch (error: any) {
        if (input.signal?.aborted) return
        const detail = signal.aborted
          ? "request timed out"
          : String(error?.message || error).slice(0, 200)
        yield {
          type: "agent.error",
          error: `ClawFix service unreachable (${detail})`,
          fatal: true,
        }
      }
    },
  })
}

export type RemoteAnalyzer = ReturnType<typeof createRemoteAnalyzer>
