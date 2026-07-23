import { afterEach, describe, expect, test } from "bun:test"

import { testRender } from "@opentui/solid"

import { App } from "../src/app"
import { buildDisclosureView } from "../src/lib/disclosure"
import { createFakeSession, createSessionBridge } from "../src/session-bridge"

const renderers: Array<{ destroy(): void }> = []

afterEach(() => {
  for (const renderer of renderers.splice(0)) renderer.destroy()
})

function sourceFromBridge(bridge: ReturnType<typeof createSessionBridge>) {
  return {
    getView: () => bridge.getView(),
    subscribe: (listener: (view: any) => void) => bridge.subscribe(listener),
    send: (input: string) => bridge.send(input),
    setDraft: (v: string) => bridge.setDraft(v),
    privacyMoveFocus: (d: number) => bridge.privacyMoveFocus(d),
    privacySetFocus: (f: any) => bridge.privacySetFocus(f),
    privacyConfirm: () => bridge.privacyConfirm(),
    privacyDismissStayLocal: () => bridge.privacyDismissStayLocal(),
    closeDialog: () => bridge.closeDialog(),
  }
}

describe("privacy dialog", () => {
  test("disclosure lists destination and defaults stay-local focus", () => {
    const d = buildDisclosureView({ baseUrl: "https://clawfix.dev" })
    expect(d.destination).toBe("clawfix.dev")
    expect(d.providerLabel).toContain("ClawFix service")
    expect(d.included.length).toBeGreaterThan(0)
    expect(d.excluded.some((x) => /hostname/i.test(x))).toBe(true)
  })

  test("custom server discloses exact hostname", () => {
    const d = buildDisclosureView({ baseUrl: "https://fix.example.com", customServer: true })
    expect(d.destination).toBe("fix.example.com")
    expect(d.providerLabel).toContain("fix.example.com")
    expect(d.endpointUrl).toContain("https://fix.example.com/api/v2/agent/messages")
  })

  test("remote chat cannot start before explicit consent", async () => {
    let remote = 0
    const session = {
      getState: () => ({ revision: null, findings: [], transcript: [], scanning: false, scanError: null }),
      scan: async () => ({}),
      appendMessage() {},
    }
    const bridge = createSessionBridge({
      session,
      preferRemote: true,
      remoteAnalyzer: {
        async send() {
          remote += 1
          return { message: "nope" }
        },
      },
      offlineAnalyzer: {
        async handle() {
          return { message: "local" }
        },
      },
    })
    await bridge.send("please use cloud")
    expect(bridge.getView().dialog.type).toBe("privacy")
    expect(remote).toBe(0)

    const setup = await testRender(
      () => <App source={sourceFromBridge(bridge) as any} simpleComposer />,
      { width: 100, height: 40 },
    )
    renderers.push(setup.renderer)
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toMatch(/Privacy approval/i)
    expect(frame).toMatch(/Stay local/i)
    expect(frame).toMatch(/Continue/i)
    // Payload inspect action is present (may wrap in medium widths)
    expect(frame).toMatch(/Inspect/i)
    // Default focus marker on Stay local
    expect(frame).toMatch(/>\[\s*Stay local\s*\]/)
  })

  test("inspect toggles payload preview without granting consent", async () => {
    const session = {
      getState: () => ({ revision: null, findings: [], transcript: [], scanning: false, scanError: null }),
      scan: async () => ({}),
      appendMessage() {},
    }
    const bridge = createSessionBridge({
      session,
      preferRemote: true,
      remoteAnalyzer: { async send() { return { message: "x" } } },
    })
    bridge._testOpenPrivacy("inspect me")
    bridge.privacySetFocus("inspect")
    await bridge.privacyConfirm()
    const view = bridge.getView()
    expect(view.dialog.type).toBe("privacy")
    if (view.dialog.type === "privacy") {
      expect(view.dialog.showPayload).toBe(true)
      expect(view.dialog.payloadJson).toContain("inspect me")
    }
    expect(view.remoteConsent).toBe(false)
  })
})

describe("privacy static session render", () => {
  test("renders disclosure from a frozen session view", async () => {
    const disclosure = buildDisclosureView()
    const session = Object.freeze({
      ...createFakeSession(),
      composerLocked: true,
      dialog: Object.freeze({
        type: "privacy" as const,
        disclosure,
        payloadJson: '{\n  "message": "hi"\n}',
        pendingMessage: "hi",
        focus: "stay-local" as const,
        showPayload: false,
      }),
    })
    const setup = await testRender(
      () => <App session={session} simpleComposer />,
      { width: 100, height: 34 },
    )
    renderers.push(setup.renderer)
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Privacy approval")
    expect(frame).toContain("clawfix.dev")
    expect(frame).toContain("Not included")
  })
})
