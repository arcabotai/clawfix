export const theme: Readonly<Record<string, string>> = Object.freeze({
  background: "#0b1020",
  border: "#5f6b8a",
  heading: "#f2f5ff",
  text: "#d9deea",
  muted: "#9aa5bd",
  accent: "#5eead4",
  danger: "#f87171",
  warning: "#fbbf24",
  info: "#60a5fa",
  success: "#4ade80",
  focus: "#c4b5fd",
  panel: "#121a2f",
  added: "#4ade80",
  removed: "#f87171",
})

export function severityColor(severity: string): string {
  switch (String(severity || "").toLowerCase()) {
    case "critical":
    case "error":
      return theme.danger
    case "warning":
      return theme.warning
    case "optimization":
    case "info":
      return theme.info
    default:
      return theme.muted
  }
}
