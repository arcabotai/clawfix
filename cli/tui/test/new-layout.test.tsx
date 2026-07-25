import { describe, expect, test, afterEach } from "bun:test"
import { testRender } from "@opentui/solid"

import { App, createFakeSession } from "../src/app"
import type { TuiSessionView } from "../src/session-bridge"
import type { RepairPlanView, DialogState } from "../src/lib/models"
import { buildDisclosureView } from "../src/lib/disclosure"

const renderers: Array<{ destroy(): void }> = []
afterEach(() => {
  while (renderers.length) renderers.pop()?.destroy()
})

const plan: RepairPlanView = {
  planId: "plan-1",
  scanFingerprint: "fp",
  repairIds: ["gateway-restart"],
  risk: "medium",
  summary: "Restart the OpenClaw gateway service",
  effects: [{ kind: "service", summary: "systemctl --user restart openclaw-gateway" }],
  previewText: "~/.openclaw/openclaw.json (model)",
  unifiedDiff: null,
  backupRequired: true,
  restartRequired: true,
  createdAt: new Date().toISOString(),
}

const findings = [
  { id: "f1", title: "Gateway service is not running", severity: "critical", repairable: true, repairId: "gateway-restart" },
  { id: "f2", title: "Port 18789 is not listening", severity: "critical", repairable: true, repairId: "gateway-restart" },
]

function state(partial: Partial<TuiSessionView>): TuiSessionView {
  return Object.freeze({ ...createFakeSession(), ...partial }) as TuiSessionView
}

async function frameOf(view: TuiSessionView, width: number, height: number) {
  const setup = await testRender(() => <App session={view} />, { width, height })
  renderers.push(setup.renderer)
  await setup.renderOnce()
  return setup.captureCharFrame()
}

describe("new layout", () => {
  test("splash hides once transcript content exists", async () => {
    const splash = await frameOf(state({}), 120, 35)
    expect(splash).toContain("OpenClaw diagnostics and guarded repairs")

    const withContent = await frameOf(state({ findings }), 120, 35)
    expect(withContent).not.toContain("OpenClaw diagnostics and guarded repairs")
    expect(withContent).toContain("[critical] Gateway service is not running")
  })

  test("chat transcript renders assistant paragraphs and repair block", async () => {
    const frame = await frameOf(state({
      findings,
      items: [
        { kind: "message", id: "m1", role: "user", text: "why is my gateway not running" },
        { kind: "message", id: "m2", role: "assistant", text: "First paragraph.\n\nSecond paragraph." },
        { kind: "repair", id: "r1", plan, rationale: "because", status: "proposed" },
      ],
      revision: "a1b2c3d",
    }), 120, 35)
    expect(frame).toContain("First paragraph.")
    expect(frame).toContain("Second paragraph.")
    expect(frame).toContain("Repair proposal · proposed")
    expect(frame).toContain("Restart the OpenClaw gateway service")
  })

  test("approval dialog keeps action buttons visible on small terminals", async () => {
    const frame = await frameOf(state({
      findings,
      composerLocked: true,
      dialog: { type: "approval", plan, rationale: "r", focus: "cancel" } as DialogState,
    }), 60, 20)
    expect(frame).toContain("Cancel")
    expect(frame).toContain("Fix it")
  })

  test("privacy dialog keeps Stay local action visible on small terminals", async () => {
    const frame = await frameOf(state({
      findings,
      composerLocked: true,
      dialog: {
        type: "privacy",
        // Built from the real builder so the dialog under test renders shipping copy.
        disclosure: buildDisclosureView({ uploadsDiagnostic: true }),
        payloadJson: "{}",
        pendingMessage: "hello",
        focus: "stay-local",
        showPayload: false,
      } as DialogState,
    }), 60, 20)
    expect(frame).toContain("Stay local")
  })

  test("footer status line is always present", async () => {
    for (const [w, h] of [[120, 35], [80, 24], [60, 20]] as const) {
      const frame = await frameOf(state({
        findings,
        revision: "a1b2c3d",
        composerLocked: true,
        dialog: { type: "approval", plan, rationale: "r", focus: "cancel" } as DialogState,
      }), w, h)
      expect(frame).toContain("Enter send")
      expect(frame).toContain("🦞 ClawFix")
    }
  })

  test("help view keeps its heading visible on small terminals", async () => {
    const frame = await frameOf(state({
      findings,
      revision: "a1b2c3d",
      helpVisible: true,
    }), 60, 20)

    expect(frame).toContain("ClawFix keys")
    expect(frame).toContain("Ctrl+P")
    expect(frame).toContain("Remote AI requires explicit privacy consent")
  })
})
