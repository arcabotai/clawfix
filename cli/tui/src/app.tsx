import { createSignal, onCleanup } from "solid-js"

import { theme } from "./theme"
import {
  createFakeSession,
  type TuiFinding,
  type TuiSessionView,
} from "./session-bridge"

export type { TuiFinding, TuiSessionView }
export { createFakeSession }

export interface SessionSource {
  getView(): TuiSessionView
  subscribe(listener: (view: TuiSessionView) => void): () => void
}

export interface AppProps {
  readonly session?: TuiSessionView
  readonly source?: SessionSource
}

function severityColor(severity: string): string {
  switch (severity) {
    case "critical":
    case "error":
      return "#f87171"
    case "warning":
      return "#fbbf24"
    case "optimization":
      return "#60a5fa"
    default:
      return theme.muted
  }
}

function findingColor(line: string): string {
  if (line.startsWith("No findings")) return theme.muted
  if (line.includes("[error]") || line.includes("[critical]")) return severityColor("error")
  if (line.includes("[warning]")) return severityColor("warning")
  if (line.includes("[optimization]")) return severityColor("optimization")
  return theme.text
}

function formatFinding(finding: TuiFinding, index: number): string {
  return `${index + 1}. [${finding.severity}] ${finding.title}${finding.repairable ? " · repairable" : ""}`
}

export function App(props: AppProps) {
  const initial = props.source?.getView() ?? props.session ?? createFakeSession()
  const [view, setView] = createSignal<TuiSessionView>(initial)

  if (props.source) {
    const unsubscribe = props.source.subscribe(next => setView(next))
    onCleanup(unsubscribe)
  }

  // OpenTUI Solid rejects orphan whitespace/empty text nodes outside <text>.
  // Mirror the original scaffold: one bordered column, only explicit <text> children.
  const current = () => view()
  const findingLines = () => {
    const findings = current().findings
    if (findings.length === 0) return ["No findings yet. Run a scan."]
    return findings.map(formatFinding)
  }
  const messageLines = () => {
    const messages = current().messages
    if (messages.length === 0) return ["No messages yet."]
    return [...messages]
  }

  return (
    <box
      style={{
        width: "100%",
        height: "100%",
        flexDirection: "column",
        backgroundColor: theme.background,
        padding: 1,
      }}
    >
      <box border borderColor={theme.border} style={{ flexDirection: "column", padding: 1 }}>
        <text fg={theme.heading}><strong>ClawFix</strong></text>
        <text fg={theme.text}>{current().prompt}</text>
        <text fg={theme.muted}>{current().status}</text>
        <text fg={theme.muted}>{current().revision ? `revision ${current().revision}` : "revision none"}</text>
        <text fg={theme.heading}><strong>Findings</strong></text>
        {findingLines().map((line) => <text fg={findingColor(line)}>{line}</text>)}
        <text fg={theme.heading}><strong>Transcript</strong></text>
        {messageLines().map((line) => <text fg={line === "No messages yet." ? theme.muted : theme.text}>{line}</text>)}
        <text fg={theme.muted}>{current().scanning ? "Scan in progress…" : "Local-first session · OpenTUI bound to ClawFix controller"}</text>
      </box>
    </box>
  )
}
