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

  return {
    getState: () => state,
    scanCalls: () => scanCalls,
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
  }
}

describe("session bridge", () => {
  test("createFakeSession stays frozen and empty", () => {
    const view = createFakeSession()
    expect(Object.isFrozen(view)).toBe(true)
    expect(view.findings).toEqual([])
    expect(view.messages).toEqual([])
    expect(view.status).toContain("ready")
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
})
