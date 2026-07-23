import type { RepairPlanView } from "../lib/models"
import { theme } from "../theme"

export function RepairCard(props: {
  readonly plan: RepairPlanView
  readonly rationale: string
  readonly status: string
}) {
  const lines = () => {
    const risk = String(props.plan.risk || "medium").toLowerCase()
    return [
      { text: "Repair proposal", color: theme.heading },
      { text: props.plan.summary, color: theme.text },
      { text: props.rationale ? `Why: ${props.rationale}` : " ", color: theme.muted },
      { text: `Risk: ${risk}`, color: theme.warning },
      { text: `Repairs: ${props.plan.repairIds.join(", ") || "(none)"}`, color: theme.muted },
      {
        text: `${props.plan.restartRequired ? "Restart required. " : "No restart. "}${props.plan.backupRequired ? "Backup required." : "No backup required."}`,
        color: theme.muted,
      },
      { text: `Status: ${props.status}`, color: theme.muted },
    ]
  }
  return (
    <box border borderColor={theme.warning} style={{ flexDirection: "column", padding: 1 }}>
      {lines().map((line) => <text fg={line.color}>{line.text}</text>)}
    </box>
  )
}
