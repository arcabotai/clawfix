// @ts-nocheck — imports plain-JS cli/ and src/ modules without type declarations (TS7016).
/**
 * Scripted end-to-end session: scan -> consent -> remote chat -> repair proposal ->
 * approval -> apply -> verify.
 *
 * Everything on the client is real: the session controller, findings normalization, the
 * repair catalog and engine, the offline analyzer, the SSE client, and the TUI bridge.
 *
 * The server is a local HTTP server that validates request bodies with the *real*
 * validateAgentV2Request and writes frames with the *real* formatSseEvent, so the wire
 * contract cannot drift from src/routes/agent-v2.js without this failing. A live server is
 * not used because emitting repair.proposed requires a configured AI provider.
 *
 * Only the OpenClaw process boundary is faked — that is the one thing a test must not
 * actually do.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createServer, type Server } from "node:http"

import { normalizeFindings } from "../../core/findings.js"
import { repairCatalog } from "../../core/repair-catalog.js"
import { createRepairEngine } from "../../core/repair-engine.js"
import { createSessionController } from "../../core/session.js"
import { createOfflineAnalyzer } from "../../core/offline-analyzer.js"
import { formatSseEvent, validateAgentV2Request } from "../../../src/agent/contract.js"
import { createRemoteAnalyzer } from "../src/remote-analyzer"
import { createSessionBridge } from "../src/session-bridge"

interface Recorded {
  readonly path: string
  readonly body: any
}

let server: Server
let baseUrl = ""
const requests: Recorded[] = []
let rejectAgentBody: string | null = null

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ""
    req.on("data", (chunk) => { raw += chunk })
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null
      requests.push({ path: req.url || "", body })

      if (req.url === "/api/diagnose") {
        res.setHeader("content-type", "application/json")
        res.end(JSON.stringify({ fixId: "diag12345678" }))
        return
      }

      if (req.url === "/api/v2/agent/messages") {
        // The real server-side validator: if the client's payload would be rejected in
        // production, it is rejected here too.
        const validated = validateAgentV2Request(body)
        if (!validated.ok) {
          rejectAgentBody = validated.error
          res.statusCode = 400
          res.end(JSON.stringify({ error: validated.error }))
          return
        }

        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        })
        res.write(formatSseEvent("agent.meta", {
          conversationId: validated.value.conversationId,
          diagnosticId: validated.value.diagnosticId,
          protocol: "clawfix.agent.v2",
        }))
        res.write(formatSseEvent("assistant.delta", { text: "Your gateway is not running. " }))
        res.write(formatSseEvent("assistant.delta", { text: "I can restart it." }))
        // Exactly what src/routes/agent-v2.js emits: an id and a rationale, never a plan.
        res.write(formatSseEvent("repair.proposed", {
          repairId: "gateway-not-running",
          rationale: "The gateway process is absent and the port is closed.",
        }))
        res.write(formatSseEvent("agent.done", { conversationId: validated.value.conversationId, repairProposed: true }))
        res.end()
        return
      }

      res.statusCode = 404
      res.end("{}")
    })
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as { port: number }
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

/** OpenClaw process boundary: down until `gateway restart` is invoked, up afterwards. */
function fakeOpenClaw() {
  const invocations: string[][] = []
  let running = false
  return {
    invocations,
    isRunning: () => running,
    adapter: {
      async gatewayStatusText() { return running ? "running (pid 4242)" : "inactive (dead)" },
      async gatewayProcesses() { return running ? "4242" : "" },
      async invoke(argv: string[]) {
        invocations.push(argv)
        if (argv[0] === "gateway" && argv[1] === "restart") running = true
        return { status: 0, timedOut: false, errorSummary: "", stdout: "restarted" }
      },
    },
  }
}

function buildSession(openclaw: ReturnType<typeof fakeOpenClaw>) {
  let revisionCounter = 0
  return createSessionController({
    runDiagnostics: async ({ revision }) => ({
      revision,
      diagnostic: { revision, os: "linux", ocVersion: "1.2.3" },
      issues: openclaw.isRunning() ? [] : [{ severity: "critical", text: "Gateway is not running" }],
      summary: { gateway: { running: openclaw.isRunning() } },
    }),
    repairEngine: createRepairEngine({ catalog: repairCatalog }),
    normalizeFindings,
    knownRepairIds: Object.keys(repairCatalog),
    makeRevisionId: () => `rev-${(revisionCounter += 1)}`,
    onEvent: () => {},
  })
}

describe("end-to-end session", () => {
  test("scan -> consent -> remote chat -> proposal -> approval -> apply -> verify", async () => {
    requests.length = 0
    rejectAgentBody = null

    const openclaw = fakeOpenClaw()
    const session = buildSession(openclaw)
    const bridge = createSessionBridge({
      session: session as any,
      offlineAnalyzer: createOfflineAnalyzer({ session }) as any,
      remoteAnalyzer: createRemoteAnalyzer({ session: session as any, baseUrl }) as any,
      preferRemote: true,
      remoteBaseUrl: baseUrl,
      repairContext: {
        openclaw: openclaw.adapter,
        // No real timers: apply -> verify must be drivable deterministically.
        wait: async () => {},
      },
    })

    // 1. Scan finds a repairable gateway failure.
    await bridge.scan()
    const scanned = bridge.getView()
    expect(scanned.findings).toHaveLength(1)
    expect(scanned.findings[0]!.repairable).toBe(true)
    expect(scanned.findings[0]!.repairId).toBe("gateway-not-running")

    // 2. A deterministic local command must not touch the network.
    await bridge.send("issues")
    expect(requests).toHaveLength(0)

    // 3. Free text opens the privacy dialog and still sends nothing.
    await bridge.send("why is my gateway not running")
    expect(bridge.getView().dialog.type).toBe("privacy")
    expect((bridge.getView().dialog as any).focus).toBe("stay-local")
    expect(requests).toHaveLength(0)

    // 4. Consent released the turn: diagnostic upload, then the agent call.
    bridge.privacySetFocus("continue")
    await bridge.privacyConfirm()

    expect(rejectAgentBody).toBeNull()
    expect(requests.map((r) => r.path)).toEqual(["/api/diagnose", "/api/v2/agent/messages"])
    const agentBody = requests[1]!.body
    expect(agentBody.diagnosticId).toBe("diag12345678")
    expect(agentBody.availableRepairs).toEqual([
      { id: "gateway-not-running", title: "Gateway is not running", risk: "medium" },
    ])
    for (const banned of ["shell", "command", "script", "patch", "exec", "commands", "files"]) {
      expect(Object.prototype.hasOwnProperty.call(agentBody, banned)).toBe(false)
    }

    // 5. The server's repairId became a locally-built plan and an approval dialog.
    const proposed = bridge.getView()
    expect(proposed.dialog.type).toBe("approval")
    const dialog = proposed.dialog as any
    expect(dialog.focus).toBe("cancel")
    expect(dialog.plan.findingId).toBe(scanned.findings[0]!.id)
    expect(typeof dialog.plan.approvalToken).toBe("string")
    expect(dialog.plan.approvalToken.length).toBeGreaterThan(0)
    expect(dialog.plan.risk).toBe("low")

    // Nothing has run yet.
    expect(openclaw.invocations).toEqual([])

    // 6. Approve: plan -> apply -> verify, through the real engine and catalog.
    bridge.approvalSetFocus("approve")
    await bridge.approvalConfirm()

    expect(openclaw.invocations).toEqual([["gateway", "restart"]])
    expect(openclaw.isRunning()).toBe(true)

    const done = bridge.getView()
    expect(done.dialog.type).toBe("none")
    const repairCards = done.items.filter((i: any) => i.kind === "repair")
    expect(repairCards).toHaveLength(1)
    expect((repairCards[0] as any).status).toBe("completed")
    expect(done.items.some((i: any) => i.kind === "error")).toBe(false)

    // Success copy exists only because applyRepair returned `applied`.
    const messages = done.items.filter((i: any) => i.kind === "message" && i.role === "assistant")
    expect(messages.some((m: any) => /Repair applied/.test(m.text))).toBe(true)

    // 7. A rescan confirms the world actually changed.
    await bridge.scan()
    expect(bridge.getView().findings).toHaveLength(0)
  })

  test("declining consent keeps the turn local and uploads nothing", async () => {
    requests.length = 0

    const openclaw = fakeOpenClaw()
    const session = buildSession(openclaw)
    const bridge = createSessionBridge({
      session: session as any,
      offlineAnalyzer: createOfflineAnalyzer({ session }) as any,
      remoteAnalyzer: createRemoteAnalyzer({ session: session as any, baseUrl }) as any,
      preferRemote: true,
      remoteBaseUrl: baseUrl,
      repairContext: { openclaw: openclaw.adapter, wait: async () => {} },
    })

    await bridge.scan()
    await bridge.send("why is my gateway not running")
    expect(bridge.getView().dialog.type).toBe("privacy")

    // Stay local is the default action; confirming it must not reach the network.
    await bridge.privacyConfirm()

    expect(requests).toHaveLength(0)
    const view = bridge.getView()
    expect(view.dialog.type).toBe("none")
    expect(view.aiMode).toBe("local")
    expect(view.remoteConsent).toBe(false)
    // The offline analyzer answered instead, deterministically.
    expect(view.messages.some((m) => /Unknown local command/.test(m))).toBe(true)
  })

  test("a repair the local catalog does not know is refused, not executed", async () => {
    requests.length = 0

    const openclaw = fakeOpenClaw()
    const session = buildSession(openclaw)
    const bridge = createSessionBridge({
      session: session as any,
      offlineAnalyzer: createOfflineAnalyzer({ session }) as any,
      remoteAnalyzer: {
        async *send() {
          yield { type: "repair.proposed", repairId: "rm-rf-slash", rationale: "trust me" }
        },
      } as any,
      preferRemote: true,
      remoteBaseUrl: baseUrl,
      repairContext: { openclaw: openclaw.adapter, wait: async () => {} },
    })

    await bridge.scan()
    bridge._testOpenPrivacy("do the thing")
    bridge.privacySetFocus("continue")
    await bridge.privacyConfirm()

    const view = bridge.getView()
    expect(view.dialog.type).toBe("none")
    expect(openclaw.invocations).toEqual([])
    const errors = view.items.filter((i: any) => i.kind === "error")
    expect(errors).toHaveLength(1)
    expect((errors[0] as any).message).toContain("no matching repairable finding")
  })
})
