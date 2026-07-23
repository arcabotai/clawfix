import { theme } from "./theme"

export interface TuiSession {
  readonly status: string
  readonly prompt: string
  readonly messages: readonly string[]
}

export interface AppProps {
  readonly session: TuiSession
}

export function createFakeSession(): TuiSession {
  return Object.freeze({
    status: "Local session ready",
    prompt: "Tell me what is going wrong with your OpenClaw.",
    messages: Object.freeze([]),
  })
}

export function App(props: AppProps) {
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
        <text fg={theme.text}>{props.session.prompt}</text>
        {props.session.messages.map((message) => <text fg={theme.text}>{message}</text>)}
        <text fg={theme.muted}>{props.session.status}</text>
      </box>
    </box>
  )
}
