import { afterEach, describe, expect, test } from "bun:test"

import { testRender } from "@opentui/solid"

import { App, createFakeSession } from "../src/app"
import { resolveLayout } from "../src/lib/models"

const renderers: Array<{ destroy(): void }> = []

afterEach(() => {
  for (const renderer of renderers.splice(0)) renderer.destroy()
})

describe("layout breakpoints", () => {
  test("wide shows sidebar", () => {
    const layout = resolveLayout(120, 40)
    expect(layout.mode).toBe("wide")
    expect(layout.showSidebar).toBe(true)
    expect(layout.showKeyHints).toBe(true)
  })

  test("medium hides sidebar keeps hints", () => {
    const layout = resolveLayout(80, 24)
    expect(layout.mode).toBe("medium")
    expect(layout.showSidebar).toBe(false)
    expect(layout.showKeyHints).toBe(true)
  })

  test("narrow is minimal", () => {
    const layout = resolveLayout(40, 12)
    expect(layout.mode).toBe("narrow")
    expect(layout.showSidebar).toBe(false)
    expect(layout.showKeyHints).toBe(false)
  })
})

describe("responsive frames", () => {
  test("wide frame includes System sidebar", async () => {
    const setup = await testRender(
      () => <App session={createFakeSession()} simpleComposer />,
      { width: 120, height: 40 },
    )
    renderers.push(setup.renderer)
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("ClawFix")
    expect(frame).toContain("System")
    expect(frame).toMatch(/Local only|AI/)
  })

  test("medium frame keeps brand without requiring sidebar", async () => {
    const setup = await testRender(
      () => <App session={createFakeSession()} simpleComposer />,
      { width: 80, height: 24 },
    )
    renderers.push(setup.renderer)
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("ClawFix")
    expect(frame).toContain("Tell me what is going wrong")
  })

  test("narrow frame still shows brand", async () => {
    const setup = await testRender(
      () => <App session={createFakeSession()} simpleComposer />,
      { width: 40, height: 12 },
    )
    renderers.push(setup.renderer)
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toMatch(/ClawFix|OpenClaw|Local/i)
  })
})
