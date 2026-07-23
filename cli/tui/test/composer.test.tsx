import { afterEach, describe, expect, test } from "bun:test"

import { testRender } from "@opentui/solid"

import { Composer, resolveComposerSubmit } from "../src/components/composer"
import { sanitizePasteBytes } from "../src/lib/paste"

const renderers: Array<{ destroy(): void }> = []

afterEach(() => {
  for (const renderer of renderers.splice(0)) renderer.destroy()
})

describe("paste sanitization", () => {
  test("decodes bytes, normalizes CRLF, strips controls, and never claims auto-submit", () => {
    const raw = "hello\r\nworld\u0000\u0007\u001b[31mred\u001b[0m"
    const result = sanitizePasteBytes(new TextEncoder().encode(raw))
    expect(result.text).toBe("hello\nworldred")
    expect(result.truncated).toBe(false)
  })

  test("enforces size limits", () => {
    const big = "a".repeat(20_000)
    const result = sanitizePasteBytes(big, { maxChars: 100 })
    expect(result.text.length).toBe(100)
    expect(result.truncated).toBe(true)
  })
})

describe("composer submit rules", () => {
  test("ignores empty draft", () => {
    expect(resolveComposerSubmit({ draft: "  ", locked: false, busy: false }).action).toBe("ignore")
  })

  test("blocks while dialog locked without dropping the draft text", () => {
    const result = resolveComposerSubmit({ draft: "fix it", locked: true, busy: false })
    expect(result.action).toBe("blocked")
    expect(result.text).toBe("fix it")
    expect(result.reason).toBe("dialog-open")
  })

  test("blocks while busy so input is not silently lost", () => {
    const result = resolveComposerSubmit({ draft: "hello", locked: false, busy: true })
    expect(result.action).toBe("blocked")
    expect(result.reason).toBe("busy")
  })

  test("submits trimmed text when idle", () => {
    const result = resolveComposerSubmit({ draft: "  scan  ", locked: false, busy: false })
    expect(result).toEqual({ action: "submit", text: "scan" })
  })
})

describe("composer render", () => {
  test("renders placeholder and lock note", async () => {
    const setup = await testRender(
      () => (
        <Composer
          simple
          locked
          note="Finish or dismiss the open dialog before sending."
          value="draft"
          placeholder="Tell me what is going wrong…"
        />
      ),
      { width: 80, height: 10 },
    )
    renderers.push(setup.renderer)
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toMatch(/locked|dialog/i)
    expect(frame).toMatch(/Finish|dismiss/i)
  })
})
