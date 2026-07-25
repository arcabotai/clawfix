import { describe, expect, test } from "bun:test"

import { buildDisclosureView } from "../src/lib/disclosure"
import { createRemoteAnalyzer } from "../src/remote-analyzer"
import { createSessionBridge } from "../src/session-bridge"

const DIAGNOSTIC = Object.freeze({ os: "linux", ocVersion: "1.2.3" })

const FINDING = Object.freeze({
  id: "clawfix:gateway-is-not-running",
  title: "Gateway is not running",
  severity: "critical",
  repairable: true,
  repairId: "gateway-not-running",
})

function fakeSession(diagnostic: unknown = DIAGNOSTIC) {
  return {
    getState: () => Object.freeze({
      revision: "rev-1",
      diagnostic,
      issues: [],
      findings: [FINDING],
      scanning: false,
      scanError: null,
      transcript: [],
    }),
    scan: async () => ({}),
    appendMessage: () => {},
  }
}

describe("consent disclosure describes the real outbound traffic", () => {
  test("the dialog discloses the diagnostic upload as a separate endpoint", () => {
    const analyzer = createRemoteAnalyzer({ session: fakeSession() as any })
    const bridge = createSessionBridge({
      session: fakeSession() as any,
      remoteAnalyzer: analyzer as any,
      preferRemote: true,
    })

    bridge._testOpenPrivacy("why is my gateway down")
    const dialog = bridge.getView().dialog as any

    expect(dialog.type).toBe("privacy")
    expect(dialog.disclosure.diagnosticEndpointUrl).toBe("https://clawfix.dev/api/diagnose")
    expect(dialog.disclosure.endpointUrl).toBe("https://clawfix.dev/api/v2/agent/messages")
    // Focus still defaults to the non-uploading choice.
    expect(dialog.focus).toBe("stay-local")
  })

  test("the payload preview is the real request body, not a placeholder", () => {
    const analyzer = createRemoteAnalyzer({ session: fakeSession() as any })
    const bridge = createSessionBridge({
      session: fakeSession() as any,
      remoteAnalyzer: analyzer as any,
      preferRemote: true,
    })

    bridge._testOpenPrivacy("why is my gateway down")
    const preview = JSON.parse(
      (bridge.getView().dialog as any).payloadJson.replace(/^\{\n\s*">> first[^\n]*\n/, "{\n"),
    )

    // Real conversation id, not "pending-session".
    expect(preview.conversationId).toBe(analyzer.conversationId)
    expect(preview.conversationId).not.toBe("pending-session")
    expect(preview.message).toBe("why is my gateway down")
    expect(preview.availableRepairs).toEqual([
      { id: "gateway-not-running", title: "Gateway is not running", risk: "medium" },
    ])
  })

  test("the payload preview names the diagnostic upload that happens first", () => {
    const analyzer = createRemoteAnalyzer({ session: fakeSession() as any })
    const bridge = createSessionBridge({
      session: fakeSession() as any,
      remoteAnalyzer: analyzer as any,
      preferRemote: true,
    })

    bridge._testOpenPrivacy("hello")
    expect((bridge.getView().dialog as any).payloadJson).toContain("POST /api/diagnose")
  })

  test("no diagnostic, no diagnostic-upload disclosure", () => {
    const analyzer = createRemoteAnalyzer({ session: fakeSession(null) as any })
    const bridge = createSessionBridge({
      session: fakeSession(null) as any,
      remoteAnalyzer: analyzer as any,
      preferRemote: true,
    })

    bridge._testOpenPrivacy("hello")
    const dialog = bridge.getView().dialog as any
    expect(dialog.disclosure.diagnosticEndpointUrl).toBeNull()
    expect(dialog.payloadJson).not.toContain("POST /api/diagnose")
  })

  test("the included list drops the 'when present on a linked diagnostic' hedge on upload turns", () => {
    const hedged = buildDisclosureView({})
    const direct = buildDisclosureView({ uploadsDiagnostic: true })

    expect(hedged.included.join(" ")).toContain("when present on a linked diagnostic")
    expect(direct.included.join(" ")).not.toContain("when present on a linked diagnostic")
    expect(direct.included.join(" ")).toContain("OS and OpenClaw versions")
  })
})
