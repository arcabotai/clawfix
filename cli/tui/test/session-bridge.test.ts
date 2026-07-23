import { describe, expect, test } from "bun:test"

import { createSessionBridge, createFakeSession } from "../src/session-bridge"

function fakeSession(initial: {
  revision?: string | null
  findings?: any[]
  scanning?: boolean
  scanError?: { message: string } | null
  transcript?: { role: string; text: string }[]
} = {}) {
  let state = {
    revision: initial.revision ?? null,
    findings: initial.findings ?? [],
    scanning: initial.scanning ?? false,
    scanError: initial.scanError ?? null,
    transcript: initial.transcript ?? [],
  }
  let scanCalls = 0
  let approved: string[] = []

  return {
    getState: () => state,
    scanCalls: () => scanCalls,
    approved: () => approved,
    async scan() {
      scanCalls += 1
      state = {
        ...state,
        scanning: false,
        revision: "rev-1",
        findings: [
          {
            id: "finding-gateway",
            title: "Gateway is not running",
            severity: "error",
            repairable: true,
            repairId: "gateway-not-running",
          },
        ],
        scanError: null,
      }
      return state
    },
    cancelScan() {
      state = { ...state, scanning: false }
      return true
    },
    appendMessage(role: string, text: string) {
      state = {
        ...state,
        transcript: [...state.transcript, { role, text }],
      }
    },
    proposeRepair(findingId: string) {
      const finding = state.findings.find((f) => f.id === findingId)
      if (!finding) return { status: "not_found" }
      return {
        status: "proposed",
        plan: {
          planId: "plan-1",
          scanFingerprint: state.revision || "rev-1",
          repairIds: [finding.repairId],
          risk: "low",
          summary: `Restart gateway for ${finding.title}`,
          effects: [{ kind: "process", summary: "restart gateway service" }],
          preview: { summary: "no configuration files will be changed" },
          backupRequired: false,
          restartRequired: true,
          createdAt: "2026-07-23T00:00:00.000Z",
        },
      }
    },
    async approveRepair(planId: string) {
      approved.push(planId)
      return { ok: true }
    },
    cancelRepair() {
      return true
    },
  }
}

describe("session bridge", () => {
  test("createFakeSession stays frozen and empty", () => {
    const view = createFakeSession()
    expect(Object.isFrozen(view)).toBe(true)
    expect(view.findings).toEqual([])
    expect(view.messages).toEqual([])
    expect(view.status).toContain("ready")
    expect(view.dialog.type).toBe("none")
    expect(view.remoteConsent).toBe(false)
  })

  test("projects findings and status from a live session", async () => {
    const session = fakeSession()
    const bridge = createSessionBridge({ session })
    expect(bridge.getView().findings).toEqual([])

    await bridge.scan()
    const view = bridge.getView()
    expect(session.scanCalls()).toBe(1)
    expect(view.revision).toBe("rev-1")
    expect(view.findings).toHaveLength(1)
    expect(view.findings[0]?.title).toContain("Gateway")
    expect(view.findings[0]?.repairable).toBe(true)
    expect(view.status).toContain("1 finding")
    expect(view.items.some((i) => i.kind === "finding")).toBe(true)
  })

  test("send appends user/assistant transcript via offline analyzer", async () => {
    const session = fakeSession()
    const bridge = createSessionBridge({
      session,
      offlineAnalyzer: {
        async handle(input: string) {
          return { message: `echo:${input}` }
        },
      },
    })

    await bridge.send("help")
    const view = bridge.getView()
    expect(view.messages).toEqual([
      "user: help",
      "assistant: echo:help",
    ])
  })

  test("subscribe receives updates after scan", async () => {
    const session = fakeSession()
    const bridge = createSessionBridge({ session })
    const seen: string[] = []
    const stop = bridge.subscribe(view => seen.push(view.status))
    await bridge.scan()
    stop()
    expect(seen.some(status => status.includes("finding"))).toBe(true)
  })

  test("preferRemote without consent opens privacy dialog and does not call remote", async () => {
    const session = fakeSession()
    let remoteCalls = 0
    const bridge = createSessionBridge({
      session,
      preferRemote: true,
      offlineAnalyzer: {
        async handle() {
          return { message: "local-ok" }
        },
      },
      remoteAnalyzer: {
        async send() {
          remoteCalls += 1
          return { message: "remote-should-not-run" }
        },
      },
    })

    await bridge.send("diagnose telegram")
    const view = bridge.getView()
    expect(view.dialog.type).toBe("privacy")
    if (view.dialog.type === "privacy") {
      expect(view.dialog.focus).toBe("stay-local")
      expect(view.dialog.disclosure.destination).toBeTruthy()
    }
    expect(remoteCalls).toBe(0)
    expect(view.remoteConsent).toBe(false)
  })

  test("privacy stay-local runs offline analyzer only", async () => {
    const session = fakeSession()
    let remoteCalls = 0
    const bridge = createSessionBridge({
      session,
      preferRemote: true,
      offlineAnalyzer: {
        async handle(input: string) {
          return { message: `local:${input}` }
        },
      },
      remoteAnalyzer: {
        async send() {
          remoteCalls += 1
          return { message: "remote" }
        },
      },
    })

    await bridge.send("help")
    expect(bridge.getView().dialog.type).toBe("privacy")
    // confirm with default stay-local
    await bridge.privacyConfirm()
    const view = bridge.getView()
    expect(view.dialog.type).toBe("none")
    expect(view.remoteConsent).toBe(false)
    expect(remoteCalls).toBe(0)
    expect(view.messages.some((m) => m.includes("local:help"))).toBe(true)
  })

  test("privacy continue grants consent and calls remote", async () => {
    const session = fakeSession()
    let remoteCalls = 0
    const bridge = createSessionBridge({
      session,
      preferRemote: true,
      remoteBaseUrl: "https://clawfix.dev",
      offlineAnalyzer: {
        async handle() {
          return { message: "local" }
        },
      },
      remoteAnalyzer: {
        async send(input) {
          remoteCalls += 1
          expect(input.consentGranted).toBe(true)
          return { message: "remote-ok" }
        },
      },
    })

    await bridge.send("hello remote")
    bridge.privacySetFocus("continue")
    await bridge.privacyConfirm()
    const view = bridge.getView()
    expect(remoteCalls).toBe(1)
    expect(view.remoteConsent).toBe(true)
    expect(view.aiMode).toBe("remote")
    expect(view.messages.some((m) => m.includes("remote-ok"))).toBe(true)
  })

  test("offline fix proposal opens approval with cancel default focus", async () => {
    const session = fakeSession()
    await session.scan()
    const bridge = createSessionBridge({
      session,
      offlineAnalyzer: {
        async handle(input: string) {
          if (input.startsWith("fix")) {
            const proposal = session.proposeRepair("finding-gateway")
            return {
              intent: "propose_repair",
              status: proposal.status,
              plan: proposal.plan,
              message: "Repair prepared.",
            }
          }
          return { message: "ok" }
        },
      },
    })

    await bridge.send("fix 1")
    const view = bridge.getView()
    expect(view.dialog.type).toBe("approval")
    if (view.dialog.type === "approval") {
      expect(view.dialog.focus).toBe("cancel")
      expect(view.dialog.plan.repairIds).toContain("gateway-not-running")
    }
  })

  test("approval cancel does not execute repair", async () => {
    const session = fakeSession()
    await session.scan()
    const bridge = createSessionBridge({ session })
    bridge._testOpenApproval({
      planId: "plan-x",
      scanFingerprint: "rev-1",
      repairIds: ["gateway-not-running"],
      risk: "low",
      summary: "Restart gateway",
      effects: [],
      previewText: "no config changes",
      unifiedDiff: null,
      backupRequired: false,
      restartRequired: true,
      createdAt: "2026-07-23T00:00:00.000Z",
    }, "test")
    await bridge.approvalConfirm() // default cancel
    expect(session.approved()).toEqual([])
    expect(bridge.getView().dialog.type).toBe("none")
  })

  test("approval approve executes session.approveRepair", async () => {
    const session = fakeSession()
    const bridge = createSessionBridge({ session })
    bridge._testOpenApproval({
      planId: "plan-ok",
      scanFingerprint: "rev-1",
      repairIds: ["gateway-not-running"],
      risk: "low",
      summary: "Restart gateway",
      effects: [],
      previewText: "no config changes",
      unifiedDiff: null,
      backupRequired: false,
      restartRequired: true,
      createdAt: "2026-07-23T00:00:00.000Z",
    })
    bridge.approvalSetFocus("approve")
    await bridge.approvalConfirm()
    expect(session.approved()).toEqual(["plan-ok"])
  })

  test("high-risk approval is refused", async () => {
    const session = fakeSession()
    const bridge = createSessionBridge({ session })
    bridge._testOpenApproval({
      planId: "plan-high",
      scanFingerprint: "rev-1",
      repairIds: ["dangerous"],
      risk: "high",
      summary: "Dangerous thing",
      effects: [],
      previewText: "",
      unifiedDiff: null,
      backupRequired: true,
      restartRequired: true,
      createdAt: "2026-07-23T00:00:00.000Z",
    })
    bridge.approvalSetFocus("approve")
    await bridge.approvalConfirm()
    expect(session.approved()).toEqual([])
    expect(bridge.getView().items.some((i) => i.kind === "warning")).toBe(true)
  })

  test("busy send does not silently drop input", async () => {
    const session = fakeSession()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const bridge = createSessionBridge({
      session,
      offlineAnalyzer: {
        async handle() {
          await gate
          return { message: "done" }
        },
      },
    })
    const first = bridge.send("one")
    // allow first to mark busy
    await Promise.resolve()
    await bridge.send("two")
    expect(bridge.getView().queueNote).toMatch(/in progress|cancel/i)
    release()
    await first
  })
})
