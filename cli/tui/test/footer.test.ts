import { describe, expect, test } from "bun:test"

import { HINT_TIERS, resolveModelLine } from "../src/keymap"

const LABELS = ["Local only", "Remote · clawfix.dev", "Remote (pending consent)"]

describe("footer hint line", () => {
  test("never exceeds the content width for any label at any width", () => {
    for (const label of LABELS) {
      for (let width = 20; width <= 200; width += 1) {
        const line = resolveModelLine(label, width)
        expect(line.length).toBeLessThanOrEqual(Math.max(0, width - 2))
      }
    }
  })

  test("the 65..91 band that used to wrap now keeps the full label and a quit hint", () => {
    for (let width = 65; width <= 91; width += 1) {
      const line = resolveModelLine("Remote (pending consent)", width)
      expect(line.length).toBeLessThanOrEqual(width - 2)
      expect(line).toContain("Remote (pending consent)")
      expect(line).toContain("Ctrl+D quit")
    }
  })

  test("wide terminals get the richest tier", () => {
    expect(resolveModelLine("Local only", 140)).toBe(`Local only · ${HINT_TIERS[0]}`)
  })

  test("narrow terminals degrade instead of overflowing", () => {
    const narrow = resolveModelLine("Remote (pending consent)", 40)
    expect(narrow.length).toBeLessThanOrEqual(38)
    expect(narrow).toContain("Ctrl+D quit")
  })

  test("an impossibly narrow terminal truncates rather than wrapping", () => {
    expect(resolveModelLine("Local only", 6).length).toBeLessThanOrEqual(4)
    expect(resolveModelLine("Local only", 0)).toBe("")
  })

  test("every tier advertises the quit key", () => {
    for (const tier of HINT_TIERS) expect(tier).toContain("Ctrl+D quit")
  })
})
