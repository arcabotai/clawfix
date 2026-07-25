/**
 * Frame-capture harness: renders key UI states at multiple terminal sizes
 * and dumps text frames for review.
 *
 * Run: bun run scripts/frames.tsx
 * Output: CLAWFIX_TUI_FRAMES_DIR or /tmp/clawfix-tui-frames
 */
import { mkdir, writeFile } from "node:fs/promises"
import { testRender } from "@opentui/solid"

import { App, createFakeSession } from "../src/app"
import type { TuiSessionView } from "../src/session-bridge"
import type { TranscriptItem, RepairPlanView, DialogState } from "../src/lib/models"

const OUT = process.env.CLAWFIX_TUI_FRAMES_DIR || "/tmp/clawfix-tui-frames"

const SIZES = [
  { name: "140x40", width: 140, height: 40 },
  { name: "120x35", width: 120, height: 35 },
  { name: "100x30", width: 100, height: 30 },
  { name: "80x24", width: 80, height: 24 },
  { name: "60x20", width: 60, height: 20 },
] as const

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
  { id: "f3", title: "Config file present but node version untested", severity: "warning", repairable: false, repairId: null },
  { id: "f4", title: "Memory files missing (MEMORY.md)", severity: "warning", repairable: false, repairId: null },
  { id: "f5", title: "Disk usage above 80% on data volume", severity: "optimization", repairable: false, repairId: null },
]

const base = createFakeSession()

function state(partial: Partial<TuiSessionView>): TuiSessionView {
  return Object.freeze({ ...base, ...partial }) as TuiSessionView
}

const chatItems: TranscriptItem[] = [
  { kind: "finding", id: "fc-f1", findingId: "f1", title: "Gateway service is not running", severity: "critical", repairable: true, repairId: "gateway-restart", evidence: "systemctl --user status openclaw-gateway → inactive (dead)" },
  { kind: "finding", id: "fc-f2", findingId: "f2", title: "Port 18789 is not listening", severity: "critical", repairable: true, repairId: "gateway-restart", evidence: null },
  { kind: "finding", id: "fc-f3", findingId: "f3", title: "Config file present but node version untested", severity: "warning", repairable: false, repairId: null, evidence: null },
  { kind: "message", id: "m1", role: "user", text: "why is my gateway not running" },
  { kind: "message", id: "m2", role: "assistant", text: "Your gateway service is registered but currently stopped. The most common cause after a reboot is the systemd user service failing to start because Node is not on its PATH.\n\nI can restart it with the reviewed gateway-restart repair. Want me to?" },
  { kind: "repair", id: "r1", plan, rationale: "Gateway is down and port 18789 is closed.", status: "proposed" },
]

const STATES: Array<{ name: string; view: TuiSessionView }> = [
  { name: "01-splash", view: state({}) },
  { name: "02-scanning", view: state({ scanning: true, status: "Scanning local OpenClaw setup…" }) },
  {
    name: "03-findings",
    view: state({
      findings,
      revision: "a1b2c3d",
      status: "Scan complete · 5 findings · AI local only",
    }),
  },
  {
    name: "04-chat",
    view: state({
      findings,
      items: chatItems,
      revision: "a1b2c3d",
      status: "AI local only",
    }),
  },
  {
    name: "05-approval",
    view: state({
      findings,
      items: chatItems,
      revision: "a1b2c3d",
      composerLocked: true,
      dialog: { type: "approval", plan, rationale: "Gateway is down and port 18789 is closed.", focus: "cancel" } as DialogState,
    }),
  },
  {
    name: "06-privacy",
    view: state({
      findings,
      items: chatItems,
      revision: "a1b2c3d",
      composerLocked: true,
      dialog: {
        type: "privacy",
        disclosure: {
          destination: "clawfix.dev hosted AI",
          baseUrl: "https://clawfix.dev",
          endpointUrl: "https://clawfix.dev/api/analyze",
          providerLabel: "ClawFix hosted AI (deepseek v4 flash)",
          providerChain: ["clawfix.dev"],
          included: ["Your message", "Redacted diagnostic summary", "Available repair IDs"],
          excluded: ["API keys", "Tokens", "File contents", "Env values", "Home directory paths"],
        },
        payloadJson: "{\n  \"message\": \"why is my gateway not running\"\n}",
        pendingMessage: "why is my gateway not running",
        focus: "stay-local",
        showPayload: false,
      } as DialogState,
    }),
  },
  {
    name: "07-locked",
    view: state({
      findings,
      items: chatItems,
      revision: "a1b2c3d",
      composerLocked: true,
      queueNote: "Hold on — finishing the current request.",
      dialog: { type: "approval", plan, rationale: "x", focus: "cancel" } as DialogState,
    }),
  },
  {
    name: "08-help",
    view: state({
      findings,
      items: chatItems,
      revision: "a1b2c3d",
      helpVisible: true,
    }),
  },
]

async function main() {
  for (const size of SIZES) {
    for (const s of STATES) {
      const setup = await testRender(() => <App session={s.view} />, size)
      await setup.renderOnce()
      const frame = setup.captureCharFrame()
      const dir = `${OUT}/${size.name}`
      await mkdir(dir, { recursive: true })
      await writeFile(`${dir}/${s.name}.txt`, frame)
      setup.renderer.destroy()
    }
  }
  console.log(`frames written under ${OUT}`)
}

await main()
