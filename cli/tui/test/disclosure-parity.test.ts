// @ts-nocheck — imports plain-JS cli/core modules without type declarations (TS7016).
import { describe, expect, test } from "bun:test"

import {
  DEFAULT_EXCLUDED_FIELDS,
  DEFAULT_INCLUDED_FIELDS,
  DEFAULT_PROVIDER_CHAIN,
  buildDisclosure,
} from "../../core/privacy.js"
import {
  DEFAULT_EXCLUDED,
  DEFAULT_INCLUDED,
  DEFAULT_PROVIDER_CHAIN as TUI_PROVIDER_CHAIN,
  buildDisclosureView,
} from "../src/lib/disclosure"

/**
 * lib/disclosure.ts mirrors cli/core/privacy.js so the TUI package stays self-contained.
 * Two copies of the text a user consents to is exactly the kind of thing that drifts
 * silently, so assert they agree.
 */
describe("disclosure parity with cli/core/privacy.js", () => {
  test("the included, excluded and provider lists match", () => {
    expect([...DEFAULT_INCLUDED]).toEqual([...DEFAULT_INCLUDED_FIELDS])
    expect([...DEFAULT_EXCLUDED]).toEqual([...DEFAULT_EXCLUDED_FIELDS])
    expect([...TUI_PROVIDER_CHAIN]).toEqual([...DEFAULT_PROVIDER_CHAIN])
  })

  test("both builders describe the same destination and endpoint", () => {
    const core = buildDisclosure({ baseUrl: "https://clawfix.dev" })
    const tui = buildDisclosureView({ baseUrl: "https://clawfix.dev" })

    expect(tui.destination).toBe(core.destination)
    expect(tui.baseUrl).toBe(core.baseUrl)
    expect(tui.endpointUrl).toBe(core.endpointUrl)
    expect(tui.providerLabel).toBe(core.providerLabel)
  })

  test("both builders treat a custom server the same way", () => {
    const core = buildDisclosure({ baseUrl: "https://fix.internal.example" })
    const tui = buildDisclosureView({ baseUrl: "https://fix.internal.example" })

    expect(tui.providerLabel).toBe(core.providerLabel)
    expect(tui.providerLabel).toContain("fix.internal.example")
    // A custom host must not be described as going through the hosted ClawFix service.
    expect(tui.providerLabel).not.toContain("ClawFix service")
  })
})
