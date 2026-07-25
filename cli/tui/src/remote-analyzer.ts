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

import { projectLocalIssuesForUpload, redactOutbound } from "../../bin/security.js"

const MAX_REPAIRS = 32
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
}

function normalizeBaseUrl(raw?: string): string {
  const value = (raw || process.env.CLAWFIX_API_URL || "https://clawfix.dev").trim()
  try {
    return new URL(value).origin
  } catch {
    return "https://clawfix.dev"
  }
}

/** Parse `event: X\ndata: {...}\n\n` frames from an SSE byte stream. */
async function* readSseEvents(body: ReadableStream<Uint8Array>, signal?: AbortSignal) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    for (;;) {
      if (signal?.aborted) return
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
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
          yield { type: event, ...JSON.parse(data) }
        } catch {
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
  const conversationId = randomUUID()
  const headers = Object.freeze({ "Content-Type": "application/json" })
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
    } catch {
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
    async *send(input: { readonly message: string; readonly consentGranted: boolean; readonly signal?: AbortSignal }) {
      const signal = input.signal
      let diagId: string | null = null
      try {
        diagId = await ensureDiagnosticId(signal)
        const resp = await fetchImpl(`${baseUrl}/api/v2/agent/messages`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            conversationId,
            message: input.message.slice(0, 4000),
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
        if (signal?.aborted) return
        yield {
          type: "agent.error",
          error: `ClawFix service unreachable (${String(error?.message || error).slice(0, 200)})`,
          fatal: true,
        }
      }
    },
  })
}

export type RemoteAnalyzer = ReturnType<typeof createRemoteAnalyzer>
