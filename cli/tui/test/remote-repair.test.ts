import { describe, expect, test } from "bun:test"

import { createSessionBridge } from "../src/session-bridge"

const FINDING = Object.freeze({
  id: "clawfix:gateway-is-not-running",
  title: "Gateway is not running",
  severity: "critical",
  repairable: true,
  repairId: "gateway-not-running",
})

/** The exact events remote-analyzer.ts yields for src/routes/agent-v2.js SSE frames. */
function serverEvents(repairId = "gateway-not-running") {
  return [
    { type: "assistant.delta", text: "Your gateway is down." },
    { type: "repair.proposed", repairId, rationale: "Gateway process is absent." },
    { type: "agent.done", conversationId: "c", repairProposed: true },
  ]
}

function makeSession(overrides: Record<string, unknown> = {}) {
  const calls: string[] = []
  const session = {
    calls,
    getState: () => Object.freeze({
      revision: "rev-1",
      findings: [FINDING],
      scanning: false,
      scanError: null,
      transcript: [],
    }),
    scan: async () => ({}),
    appendMessage: () => {},
    proposeRepair: (id: string) => {
      calls.push(id)
      return {
        status: "proposed",
        plan: {
          planId: "plan-local-1",
          approvalToken: "token-local-1",
          findingId: id,
          repairId: "gateway-not-running",
          revision: "rev-1",
          title: "Restart the OpenClaw gateway",
          risk: "low",
        },
      }
    },
    applyRepair: async () => ({ status: "applied" }),
    ...overrides,
  }
  return session
}

async function consentAndRun(session: any, events: any[]) {
  const bridge = createSessionBridge({
    session: session as any,
    remoteAnalyzer: {
      async *send() {
        for (const event of events) yield event
      },
    } as any,
    offlineAnalyzer: { handle: async () => ({ message: "offline" }) } as any,
    preferRemote: true,
  })
  bridge._testOpenPrivacy("my gateway is down")
  bridge.privacySetFocus("continue")
  await bridge.privacyConfirm()
  return bridge
}

describe("remote repair proposals resolve locally", () => {
  test("a server repairId opens an approval dialog built from the local plan", async () => {
    const session = makeSession()
    const bridge = await consentAndRun(session, serverEvents())
    const view = bridge.getView()

    // The repair id was resolved through the local session controller, not trusted from the wire.
    expect(session.calls).toEqual([FINDING.id])

    expect(view.dialog.type).toBe("approval")
    const dialog = view.dialog as any
    expect(dialog.plan.planId).toBe("plan-local-1")
    expect(dialog.plan.approvalToken).toBe("token-local-1")
    expect(dialog.plan.findingId).toBe(FINDING.id)
    // Default focus stays on the non-destructive action.
    expect(dialog.focus).toBe("cancel")

    const repairCards = view.items.filter((i: any) => i.kind === "repair")
    expect(repairCards).toHaveLength(1)
    expect((repairCards[0] as any).status).toBe("proposed")
  })

  test("a server-authored plan cannot reach the approval dialog", async () => {
    const session = makeSession()
    const hostile = [{
      type: "repair.proposed",
      repairId: "gateway-not-running",
      rationale: "trust me",
      // A malicious/compromised server trying to author its own plan:
      plan: {
        planId: "server-plan",
        approvalToken: "server-token",
        findingId: FINDING.id,
        risk: "low",
        unifiedDiff: "--- a\n+++ b\n@@ -1 +1 @@\n-safe\n+pwned",
      },
    }]
    const bridge = await consentAndRun(session, hostile)
    const dialog = bridge.getView().dialog as any

    expect(dialog.type).toBe("approval")
    expect(dialog.plan.planId).toBe("plan-local-1")
    expect(dialog.plan.approvalToken).toBe("token-local-1")
    expect(dialog.plan.unifiedDiff).toBeNull()
  })

  test("an unknown repairId surfaces an error instead of a silent drop", async () => {
    const session = makeSession()
    const bridge = await consentAndRun(session, serverEvents("no-such-repair"))
    const view = bridge.getView()

    expect(session.calls).toEqual([])
    expect(view.dialog.type).toBe("none")
    const errors = view.items.filter((i: any) => i.kind === "error")
    expect(errors).toHaveLength(1)
    expect((errors[0] as any).message).toContain("no matching repairable finding")
  })

  test("a refused local proposal surfaces an error and offers no approval", async () => {
    const session = makeSession({
      proposeRepair: () => ({ status: "not_repairable" }),
    })
    const bridge = await consentAndRun(session, serverEvents())
    const view = bridge.getView()

    expect(view.dialog.type).toBe("none")
    const errors = view.items.filter((i: any) => i.kind === "error")
    expect(errors).toHaveLength(1)
    expect((errors[0] as any).message).toContain("not_repairable")
  })
})
