import { afterEach, describe, expect, test } from "bun:test"

import { testRender } from "@opentui/solid"

import { App } from "../src/app"
import { ApprovalDialog } from "../src/components/approval-dialog"
import { DiffDialog, buildUnifiedDiff } from "../src/components/diff-dialog"
import { createFakeSession, createSessionBridge } from "../src/session-bridge"
import type { RepairPlanView } from "../src/lib/models"

const renderers: Array<{ destroy(): void }> = []

afterEach(() => {
  for (const renderer of renderers.splice(0)) renderer.destroy()
})

const samplePlan: RepairPlanView = Object.freeze({
  planId: "plan-1",
  scanFingerprint: "rev-1",
  repairIds: Object.freeze(["gateway-not-running"]),
  risk: "low",
  summary: "Restart the OpenClaw gateway",
  effects: Object.freeze([{ kind: "process", summary: "restart gateway" }]),
  previewText: "no configuration files will be changed",
  unifiedDiff: buildUnifiedDiff(
    "openclaw.json",
    '{\n  "gateway": { "port": 18789 }\n}',
    '{\n  "gateway": { "port": 18789, "mode": "local" }\n}',
  ),
  backupRequired: false,
  restartRequired: true,
  createdAt: "2026-07-23T00:00:00.000Z",
})

describe("approval dialog", () => {
  test("default focus is cancel not fix-it", async () => {
    const setup = await testRender(
      () => <ApprovalDialog plan={samplePlan} rationale="gateway offline" focus="cancel" />,
      { width: 90, height: 20 },
    )
    renderers.push(setup.renderer)
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toMatch(/Repair approval/i)
    expect(frame).toMatch(/>\[\s*Cancel\s*\]/)
    expect(frame).toContain("Restart the OpenClaw gateway")
    expect(frame).toContain("Risk: low")
  })

  test("high risk shows hard stop copy", async () => {
    const high = Object.freeze({ ...samplePlan, risk: "high", summary: "Dangerous repair" })
    const setup = await testRender(
      () => <ApprovalDialog plan={high} rationale="manual only" focus="cancel" />,
      { width: 90, height: 22 },
    )
    renderers.push(setup.renderer)
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toMatch(/High-risk/i)
    expect(frame).toMatch(/cannot be auto-approved/i)
  })

  test("diff dialog renders unified markers", async () => {
    const setup = await testRender(
      () => <DiffDialog title="Preview" unifiedDiff={samplePlan.unifiedDiff || ""} />,
      { width: 90, height: 20 },
    )
    renderers.push(setup.renderer)
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Preview")
    expect(frame).toContain("openclaw.json")
    expect(frame).toMatch(/\+|\-/)
  })

  test("stale/cancel/approve paths via bridge", async () => {
    const approved: string[] = []
    const session = {
      getState: () => ({ revision: "rev-1", findings: [], transcript: [], scanning: false, scanError: null }),
      scan: async () => ({}),
      appendMessage() {},
      async approveRepair(id: string) { approved.push(id) },
      cancelRepair() { return true },
    }
    const bridge = createSessionBridge({ session })
    bridge._testOpenApproval(samplePlan, "why")
    expect(bridge.getView().dialog.type).toBe("approval")

    // details -> diff
    bridge.approvalSetFocus("details")
    await bridge.approvalConfirm()
    expect(bridge.getView().dialog.type).toBe("diff")
    bridge.closeDialog()
    expect(bridge.getView().dialog.type).toBe("approval")

    // cancel
    bridge.approvalSetFocus("cancel")
    await bridge.approvalConfirm()
    expect(approved).toEqual([])
    expect(bridge.getView().dialog.type).toBe("none")

    // approve
    bridge._testOpenApproval(samplePlan, "why")
    bridge.approvalSetFocus("approve")
    await bridge.approvalConfirm()
    expect(approved).toEqual(["plan-1"])
  })

  test("app shell shows approval dialog from session view", async () => {
    const session = Object.freeze({
      ...createFakeSession(),
      composerLocked: true,
      dialog: Object.freeze({
        type: "approval" as const,
        plan: samplePlan,
        rationale: "gateway offline",
        focus: "cancel" as const,
      }),
    })
    const setup = await testRender(
      () => <App session={session} simpleComposer />,
      { width: 100, height: 30 },
    )
    renderers.push(setup.renderer)
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toMatch(/Repair approval/i)
    expect(frame).toContain("Cancel")
    expect(frame).toContain("Fix it")
  })
})
