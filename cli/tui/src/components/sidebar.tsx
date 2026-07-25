import { theme, severityColor } from "../theme"

const Spacer = () => <box style={{ height: 1 }} />
import type { TuiFinding } from "../session-bridge"

export interface SidebarProps {
  readonly width: number
  readonly revision: string | null
  readonly aiMode: string
  readonly scanning: boolean
  readonly findings: readonly TuiFinding[]
  readonly status: string
}

function severityRank(sev: string): number {
  const s = String(sev || "").toLowerCase()
  if (s === "critical" || s === "error") return 0
  if (s === "warning") return 1
  return 2
}

/**
 * Right-hand context pane (opencode pattern): session state, findings
 * summary, key reminders. Rendered only in wide layout.
 */
export function Sidebar(props: SidebarProps) {
  const counts = () => {
    const bySeverity = new Map<string, number>()
    for (const f of props.findings || []) {
      const key = String(f.severity || "info").toLowerCase()
      bySeverity.set(key, (bySeverity.get(key) || 0) + 1)
    }
    return [...bySeverity.entries()].sort((a, b) => severityRank(a[0]) - severityRank(b[0]))
  }
  const top = () =>
    [...(props.findings || [])]
      .sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
      .slice(0, 4)
  const aiLabel = () =>
    props.aiMode === "remote" ? "Remote" : props.aiMode === "remote-pending" ? "Remote (pending)" : "Local only"

  return (
    <box
      border={["left"]}
      borderColor={theme.borderSubtle}
      style={{
        width: props.width,
        height: "100%",
        minHeight: 0,
        flexShrink: 1,
        flexDirection: "column",
        backgroundColor: theme.panel,
        paddingLeft: 2,
        paddingRight: 1,
        paddingTop: 1,
        overflow: "hidden",
      }}
    >
      <text fg={theme.brand}>Session</text>
      <text fg={theme.muted}>{`Revision  ${props.revision || "none"}`}</text>
      <text fg={theme.muted}>{`AI        ${aiLabel()}`}</text>
      <text fg={props.scanning ? theme.info : theme.muted}>{props.scanning ? "Scan      running…" : "Scan      idle"}</text>
      <Spacer />

      <text fg={theme.brand}>{`Findings (${(props.findings || []).length})`}</text>
      {counts().length === 0
        ? <text fg={theme.faint}>none yet — run a scan</text>
        : counts().map(([sev, n]) => <text fg={severityColor(sev)}>{`${sev.padEnd(13)}${n}`}</text>)}
      <Spacer />

      {top().length > 0 && <text fg={theme.brand}>Top issues</text>}
      {top().map((f, i) => (
        <text fg={severityColor(f.severity)}>{`${i + 1}. ${f.title}`}</text>
      ))}
      {top().length > 0 && <Spacer />}

      <text fg={theme.brand}>Commands</text>
      <text fg={theme.muted}>scan · issues</text>
      <text fg={theme.muted}>explain &lt;#&gt; · fix &lt;#&gt;</text>
      <text fg={theme.muted}>help · exit</text>
    </box>
  )
}
