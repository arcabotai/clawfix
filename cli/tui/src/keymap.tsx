/** App keybinding table + help labels. Handlers are wired in App via useKeyboard. */

export type GlobalKeyAction = "quit" | "cancel" | "toggle-help" | "close-dialog" | "none"

/**
 * Decide what a global (non-dialog) key press means.
 *
 * Kept pure and separate from App so it is testable without a renderer — `bun test` consumes
 * raw Ctrl+C (0x03) before it reaches the mock keyboard, so the Ctrl+C branch cannot be covered
 * by an integration test.
 */
export function resolveGlobalKeyAction(
  key: { readonly name?: string; readonly ctrl?: boolean } | null | undefined,
  state: { readonly busy?: boolean; readonly scanning?: boolean } = {},
): GlobalKeyAction {
  const name = String(key?.name || "").toLowerCase()
  if (name === "escape") return "close-dialog"
  if (!key?.ctrl) return "none"
  if (name === "p") return "toggle-help"
  if (name === "d") return "quit"
  // Ctrl+C interrupts work when there is work; otherwise it is the conventional way out.
  // Without the quit fallback the renderer owns stdin in raw mode, so Ctrl+C never reaches
  // the process as SIGINT and the session cannot be exited at all.
  if (name === "c") return (state.busy || state.scanning) ? "cancel" : "quit"
  return "none"
}

export const KEY_HINTS = Object.freeze([
  "Enter send",
  "Shift+Enter newline",
  "Ctrl+P help",
  "Ctrl+C cancel",
  "Ctrl+D quit",
  "Esc close dialog",
] as const)

export const NARROW_KEY_HINTS = Object.freeze([
  "Enter send",
  "Ctrl+P help",
  "Ctrl+D quit",
] as const)

export const COMPOSER_KEY_BINDINGS = Object.freeze([
  { name: "return", action: "submit" as const },
  { name: "kpenter", action: "submit" as const },
  { name: "return", shift: true, action: "newline" as const },
  { name: "kpenter", shift: true, action: "newline" as const },
  { name: "j", ctrl: true, action: "newline" as const },
  { name: "linefeed", action: "newline" as const },
])

export function helpText(compact = false): string {
  if (compact) {
    return [
      "ClawFix keys",
      "  Enter send · Ctrl+J newline",
      "  Ctrl+P help · Ctrl+C cancel",
      "  Ctrl+D quit · Esc close · Tab/Arrows move",
      "  Local: help, issues, scan, explain <#|id>, fix <#|id>",
      "  Remote AI requires explicit privacy consent.",
    ].join("\n")
  }
  return [
    "ClawFix keys",
    "  Enter          Send message",
    "  Shift+Enter    Newline (when terminal supports modifiers)",
    "  Ctrl+J         Newline fallback",
    "  Ctrl+P         Toggle this help",
    "  Ctrl+C         Cancel active scan/remote request (quits when idle)",
    "  Ctrl+D         Quit ClawFix",
    "  Esc            Close dialog / return focus to composer",
    "  Tab/Arrows     Move dialog focus (default never on destructive action)",
    "",
    "Local commands: help, issues, scan, explain <#|id>, fix <#|id>",
    "Remote AI requires explicit privacy consent. Stay local is the default.",
  ].join("\n")
}

export function KeyHints(props: { readonly narrow?: boolean }) {
  const hints = (props.narrow ? NARROW_KEY_HINTS : KEY_HINTS).join("  ")
  return (
    <box style={{ flexDirection: "column" }}>
      <text fg="#9aa5bd">{hints}</text>
    </box>
  )
}
