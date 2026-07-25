import { afterEach, describe, expect, test } from "bun:test"


import { testRender } from "@opentui/solid"

import { App, createFakeSession } from "../src/app"
import { KEY_HINTS, NARROW_KEY_HINTS, helpText, resolveGlobalKeyAction } from "../src/keymap"
import type { TuiSessionView } from "../src/session-bridge"

const renderers: Array<{ destroy(): void }> = []

afterEach(() => {
  for (const renderer of renderers.splice(0)) {
    try { renderer.destroy() } catch { /* already destroyed */ }
  }
})

const IDLE = { busy: false, scanning: false }
const WORKING = { busy: true, scanning: false }
const SCANNING = { busy: false, scanning: true }

describe("global key actions", () => {
  test("Ctrl+D always quits", () => {
    expect(resolveGlobalKeyAction({ name: "d", ctrl: true }, IDLE)).toBe("quit")
    expect(resolveGlobalKeyAction({ name: "d", ctrl: true }, WORKING)).toBe("quit")
  })

  test("Ctrl+C quits when idle and cancels when work is in flight", () => {
    expect(resolveGlobalKeyAction({ name: "c", ctrl: true }, IDLE)).toBe("quit")
    expect(resolveGlobalKeyAction({ name: "c", ctrl: true }, WORKING)).toBe("cancel")
    expect(resolveGlobalKeyAction({ name: "c", ctrl: true }, SCANNING)).toBe("cancel")
  })

  test("plain letters and unmodified keys do nothing", () => {
    expect(resolveGlobalKeyAction({ name: "d" }, IDLE)).toBe("none")
    expect(resolveGlobalKeyAction({ name: "c" }, IDLE)).toBe("none")
    expect(resolveGlobalKeyAction({ name: "q" }, IDLE)).toBe("none")
    expect(resolveGlobalKeyAction(null, IDLE)).toBe("none")
  })

  test("Ctrl+P toggles help and Escape closes dialogs", () => {
    expect(resolveGlobalKeyAction({ name: "p", ctrl: true }, IDLE)).toBe("toggle-help")
    expect(resolveGlobalKeyAction({ name: "escape" }, IDLE)).toBe("close-dialog")
  })

  test("the quit key is advertised in hints and help", () => {
    expect(KEY_HINTS.join(" ")).toContain("Ctrl+D quit")
    expect(NARROW_KEY_HINTS.join(" ")).toContain("Ctrl+D quit")
    expect(helpText(false)).toContain("Ctrl+D")
    expect(helpText(true)).toContain("Ctrl+D")
  })
})

describe("App wiring", () => {
  // Raw control-key delivery is not reliable under `bun test` — the runner consumes 0x03 and
  // mock key dispatch is order-dependent across renderer instances. The dispatch itself is a
  // one-line switch over resolveGlobalKeyAction (covered above); what is asserted here is that
  // App still mounts with an onQuit handler attached.
  test("App accepts and mounts with an onQuit handler", async () => {
    const session = Object.freeze({ ...createFakeSession() }) as TuiSessionView
    const setup = await testRender(
      () => <App session={session} onQuit={() => {}} />,
      { width: 100, height: 30 },
    )
    await setup.renderOnce()
    renderers.push(setup.renderer)
    expect(setup.captureCharFrame()).toContain("ClawFix")
  })
})
