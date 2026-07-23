import { sanitizePasteBytes } from "../lib/paste"
import { theme } from "../theme"
import { COMPOSER_KEY_BINDINGS } from "../keymap"

export interface ComposerProps {
  readonly value?: string
  readonly placeholder?: string
  readonly locked?: boolean
  readonly focused?: boolean
  readonly note?: string | null
  readonly onChange?: (value: string) => void
  readonly onSubmit?: (value: string) => void
  readonly simple?: boolean
}

/**
 * Composer chrome for tests / standalone use.
 * Main App renders a line-oriented draft to avoid OpenTUI orphan text issues.
 */
export function Composer(props: ComposerProps) {
  const lines = () => {
    const out: Array<{ text: string; color: string }> = []
    if (props.note) out.push({ text: props.note, color: theme.warning })
    if (props.locked) out.push({ text: "Composer locked while a dialog is open.", color: theme.muted })
    const draft = props.value || ""
    out.push({
      text: draft ? `> ${draft}` : `> ${props.placeholder || "Tell me what is going wrong…"}`,
      color: draft ? theme.text : theme.muted,
    })
    return out
  }

  return (
    <box style={{ flexDirection: "column", width: "100%" }}>
      {lines().map((line) => <text fg={line.color}>{line.text}</text>)}
    </box>
  )
}

export function resolveComposerSubmit(input: {
  readonly draft: string
  readonly locked: boolean
  readonly busy: boolean
}): { readonly action: "submit" | "ignore" | "blocked"; readonly text: string; readonly reason?: string } {
  const text = String(input.draft || "").trim()
  if (!text) return { action: "ignore", text: "" }
  if (input.locked) return { action: "blocked", text, reason: "dialog-open" }
  if (input.busy) return { action: "blocked", text, reason: "busy" }
  return { action: "submit", text }
}

export function applyPasteToDraft(draft: string, bytes: Uint8Array): string {
  return draft + sanitizePasteBytes(bytes).text
}

// Re-export binding table for documentation/tests.
export { COMPOSER_KEY_BINDINGS }
