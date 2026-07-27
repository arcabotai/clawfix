import { afterEach, describe, expect, test } from "bun:test"

import { testRender } from "@opentui/solid"

import { App, createFakeSession } from "../src/app"
import type { TuiSessionView } from "../src/session-bridge"

const renderers: Array<{ destroy(): void }> = []
afterEach(() => { while (renderers.length) renderers.pop()?.destroy() })

/** Findings in the order the session produces them — which is what `fix <#>` indexes. */
const FINDINGS = [
  { id: "f1", title: "Gateway is not running", severity: "critical", repairable: true, repairId: "gateway-not-running" },
  { id: "f2", title: "Auto-update enabled", severity: "medium", repairable: true, repairId: "auto-update-enabled-warning" },
  { id: "f3", title: "Reverse proxy headers are not trusted", severity: "medium", repairable: false, repairId: null },
  { id: "f4", title: "Gateway auth missing on loopback", severity: "critical", repairable: true, repairId: "gateway-loopback-no-auth" },
]

async function frame(partial: Partial<TuiSessionView>, width = 110, height = 34) {
  const view = Object.freeze({ ...createFakeSession(), ...partial }) as TuiSessionView
  const setup = await testRender(() => <App session={view} />, { width, height })
  renderers.push(setup.renderer)
  await setup.renderOnce()
  return setup.captureCharFrame()
}

describe("sidebar numbering matches the fix/explain selectors", () => {
  test("each listed issue carries its position in the findings list, not its sorted rank", async () => {
    const out = await frame({ findings: FINDINGS as any, revision: "rev-1" })

    // Sorted by severity for prominence: the two criticals lead. But the numbers must stay
    // the finding's real index, because `fix 4` has to reach "Gateway auth missing".
    // The sidebar wraps, so match the numbered prefix rather than the full title.
    expect(out).toContain("1. Gateway is not")
    expect(out).toContain("4. Gateway auth")
    expect(out).toContain("2. Auto-update enabled")
    expect(out).toContain("3. Reverse proxy")

    // The old bug: severity-sorted renumbering labelled the auth finding "2".
    expect(out).not.toContain("2. Gateway auth")
    expect(out).not.toContain("3. Auto-update enabled")
  })

  test("severity ordering still puts criticals first", async () => {
    const out = await frame({ findings: FINDINGS as any, revision: "rev-1" })
    const rows = out.split("\n")
    const idx = (needle: string) => rows.findIndex((r) => r.includes(needle))
    expect(idx("4. Gateway auth")).toBeLessThan(idx("2. Auto-update enabled"))
  })
})

describe("status line", () => {
  test("does not print the revision twice", async () => {
    const out = await frame({
      findings: FINDINGS as any,
      revision: "aee53dec-5ed0-46e0-a300-c44bf5b0aa28",
      status: "Revision aee53dec-5ed0-46e0-a300-c44bf5b0aa28 · 4 findings",
    })
    const status = out.split("\n").find((r) => r.includes("ClawFix v")) || ""
    const occurrences = (status.match(/aee53dec/g) || []).length
    expect(occurrences).toBe(1)
  })

  test("keeps the finding count visible instead of truncating it away", async () => {
    const out = await frame({
      findings: FINDINGS as any,
      revision: "aee53dec-5ed0-46e0-a300-c44bf5b0aa28",
      status: "Revision aee53dec-5ed0-46e0-a300-c44bf5b0aa28 · 4 findings",
    })
    const status = out.split("\n").find((r) => r.includes("ClawFix v")) || ""
    expect(status).toContain("4 findings")
  })
})
