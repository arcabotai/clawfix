import type { DialogFocusPrivacy, DisclosureView } from "../lib/models"
import { theme } from "../theme"

/** Line-oriented privacy dialog — only explicit <text> children (OpenTUI orphan-safe). */
export function PrivacyDialog(props: {
  readonly disclosure: DisclosureView
  readonly focus: DialogFocusPrivacy
  readonly showPayload: boolean
  readonly payloadJson: string
  readonly pendingMessage?: string
}) {
  const lines = () => {
    const out: Array<{ text: string; color: string }> = []
    out.push({ text: "Privacy approval", color: theme.heading })
    out.push({ text: "ClawFix can send this message and a redacted diagnostic to:", color: theme.text })
    out.push({ text: props.disclosure.providerLabel, color: theme.accent })
    out.push({ text: `Destination: ${props.disclosure.destination}`, color: theme.muted })
    out.push({ text: `Endpoint: ${props.disclosure.endpointUrl}`, color: theme.muted })
    if (props.pendingMessage) out.push({ text: `Message: ${String(props.pendingMessage).slice(0, 120)}`, color: theme.muted })
    out.push({ text: "Included", color: theme.heading })
    for (const item of props.disclosure.included) out.push({ text: `• ${item}`, color: theme.text })
    out.push({ text: "Not included", color: theme.heading })
    for (const item of props.disclosure.excluded) out.push({ text: `• ${item}`, color: theme.text })
    if (props.showPayload) {
      out.push({ text: "Exact payload (redacted preview)", color: theme.heading })
      for (const line of props.payloadJson.split("\n").slice(0, 24)) {
        out.push({ text: line.length ? line : " ", color: theme.muted })
      }
    }
    const mark = (key: string) => (props.focus === key ? ">" : " ")
    out.push({
      text: `${mark("stay-local")}[ Stay local ]  ${mark("inspect")}[ Inspect exact payload ]  ${mark("continue")}[ Continue ]`,
      color: theme.focus,
    })
    out.push({ text: "Default focus is Stay local. Enter confirms. Esc stays local.", color: theme.muted })
    return out
  }

  return (
    <box border borderColor={theme.accent} style={{ flexDirection: "column", padding: 1, width: "100%" }}>
      {lines().map((line) => <text fg={line.color}>{line.text}</text>)}
    </box>
  )
}
