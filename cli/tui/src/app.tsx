import { createSignal, For, onCleanup, Show } from "solid-js"

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

export function App(props: AppProps) {
  const initial = props.source?.getView() ?? props.session ?? createFakeSession()
  const [view, setView] = createSignal<TuiSessionView>(initial)

  if (props.source) {
    const unsubscribe = props.source.subscribe(next => setView(next))
    onCleanup(unsubscribe)
  }

  // OpenTUI Solid rejects orphan whitespace text nodes. Keep one bordered column
  // and only emit explicit <text> children (same pattern as the original scaffold).
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
        <text fg={theme.text}>{view().prompt}</text>
        <text fg={theme.muted}>{view().status}</text>
        <text fg={theme.muted}>{view().revision ? `revision ${view().revision}` : "revision none"}</text>
        <text fg={theme.heading}><strong>Findings</strong></text>
        <Show when={view().findings.length === 0}>
          <text fg={theme.muted}>No findings yet. Run a scan.</text>
        </Show>
        <For each={view().findings}>
          {(finding: TuiFinding, index) => (
            <text fg={severityColor(finding.severity)}>
              {`${index() + 1}. [${finding.severity}] ${finding.title}${finding.repairable ? " · repairable" : ""}`}
            </text>
          )}
        </For>
        <text fg={theme.heading}><strong>Transcript</strong></text>
        <Show when={view().messages.length === 0}>
          <text fg={theme.muted}>No messages yet.</text>
        </Show>
        <For each={view().messages}>
          {(message: string) => <text fg={theme.text}>{message}</text>}
        </For>
        <text fg={theme.muted}>
          {view().scanning
            ? "Scan in progress…"
            : "Local-first session · OpenTUI bound to ClawFix controller"}
        </text>
      </box>
    </box>
  )
}
