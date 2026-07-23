import { severityColor, theme } from "../theme"

export function FindingCard(props: {
  readonly title: string
  readonly severity: string
  readonly repairable: boolean
  readonly evidence?: string | null
}) {
  const lines = () => {
    const sev = String(props.severity || "info").toLowerCase()
    const out: Array<{ text: string; color: string }> = [
      { text: `[${sev}] ${props.title}`, color: severityColor(sev) },
      {
        text: props.repairable ? "repairable · reviewed catalog only" : "advisory · no automatic repair",
        color: theme.muted,
      },
    ]
    if (props.evidence) out.push({ text: props.evidence, color: theme.muted })
    return out
  }
  return (
    <box border borderColor={severityColor(props.severity)} style={{ flexDirection: "column", padding: 1 }}>
      {lines().map((line) => <text fg={line.color}>{line.text}</text>)}
    </box>
  )
}
