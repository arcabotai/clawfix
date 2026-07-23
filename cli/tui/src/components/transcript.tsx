import type { TranscriptItem } from "../lib/models"
import { severityColor, theme } from "../theme"

function itemLines(items: readonly TranscriptItem[], emptyPrompt?: string): Array<{ text: string; color: string }> {
  const lines: Array<{ text: string; color: string }> = []
  if (items.length === 0) {
    lines.push({ text: emptyPrompt || "No messages yet.", color: theme.muted })
    return lines
  }
  for (const item of items) {
    if (item.kind === "message") {
      const who = item.role === "user" ? "You" : item.role === "assistant" ? "ClawFix" : "System"
      lines.push({ text: who, color: item.role === "user" ? theme.accent : theme.heading })
      for (const line of item.text.split("\n")) lines.push({ text: line.length ? line : " ", color: theme.text })
      continue
    }
    if (item.kind === "activity") {
      lines.push({ text: `· ${item.label}`, color: theme.info })
      continue
    }
    if (item.kind === "finding") {
      lines.push({ text: `[${item.severity}] ${item.title}`, color: severityColor(item.severity) })
      lines.push({
        text: item.repairable ? "repairable · reviewed catalog only" : "advisory · no automatic repair",
        color: theme.muted,
      })
      continue
    }
    if (item.kind === "repair") {
      lines.push({ text: `Repair proposal · ${item.status}`, color: theme.warning })
      lines.push({ text: item.plan.summary, color: theme.text })
      continue
    }
    if (item.kind === "warning") lines.push({ text: `Warning: ${item.message}`, color: theme.warning })
    if (item.kind === "error") lines.push({ text: `Error: ${item.message}`, color: theme.danger })
  }
  return lines
}

export function Transcript(props: {
  readonly items: readonly TranscriptItem[]
  readonly emptyPrompt?: string
}) {
  return (
    <box style={{ flexDirection: "column", width: "100%", flexGrow: 1 }}>
      {itemLines(props.items, props.emptyPrompt).map((line) => <text fg={line.color}>{line.text}</text>)}
    </box>
  )
}
