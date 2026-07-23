/** App keybinding table + help labels. Handlers are wired in App via useKeyboard. */

export const KEY_HINTS = Object.freeze([
  "Enter send",
  "Shift+Enter newline",
  "Ctrl+J newline",
  "Ctrl+C cancel",
  "? help",
  "Esc close dialog",
] as const)

export const NARROW_KEY_HINTS = Object.freeze([
  "Enter send",
  "Ctrl+C cancel",
  "Esc dialog",
] as const)

export const COMPOSER_KEY_BINDINGS = Object.freeze([
  { name: "return", action: "submit" as const },
  { name: "kpenter", action: "submit" as const },
  { name: "return", shift: true, action: "newline" as const },
  { name: "kpenter", shift: true, action: "newline" as const },
  { name: "j", ctrl: true, action: "newline" as const },
  { name: "linefeed", action: "newline" as const },
])

export function helpText(): string {
  return [
    "ClawFix keys",
    "  Enter          Send message",
    "  Shift+Enter    Newline (when terminal supports modifiers)",
    "  Ctrl+J         Newline fallback",
    "  Ctrl+C         Cancel active scan/remote request",
    "  Esc            Close dialog / return focus to composer",
    "  ?              Toggle this help",
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
