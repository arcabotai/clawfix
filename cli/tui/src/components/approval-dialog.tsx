import type { DialogFocusApproval, RepairPlanView } from "../lib/models"
import { theme } from "../theme"

export function ApprovalDialog(props: {
  readonly plan: RepairPlanView
  readonly rationale: string
  readonly focus: DialogFocusApproval
}) {
  const lines = () => {
    const risk = String(props.plan.risk || "medium").toLowerCase()
    const high = risk === "high" || risk === "critical"
    const out: Array<{ text: string; color: string }> = []
    out.push({ text: "Repair approval", color: theme.heading })
    out.push({ text: props.plan.summary, color: theme.text })
    out.push({ text: `Why: ${props.rationale || props.plan.summary}`, color: theme.muted })
    out.push({
      text: `Changes: ${props.plan.previewText || (props.plan.unifiedDiff ? "config diff available" : "no configuration files will be changed.")}`,
      color: theme.muted,
    })
    out.push({
      text: props.plan.restartRequired
        ? "Interruption: OpenClaw may be briefly unavailable during restart."
        : "Interruption: no restart required.",
      color: theme.muted,
    })
    out.push({
      text: props.plan.backupRequired ? "Backup: required before mutation." : "Backup: not required for this repair.",
      color: theme.muted,
    })
    out.push({ text: "Verification: ClawFix will re-check local detectors afterward.", color: theme.muted })
    out.push({ text: `Risk: ${risk}`, color: high ? theme.danger : theme.warning })
    if (high) {
      out.push({ text: "High-risk repairs cannot be auto-approved. Use technical details / manual guidance.", color: theme.danger })
    }
    const mark = (key: string) => (props.focus === key ? ">" : " ")
    out.push({
      text: `${mark("cancel")}[ Cancel ]  ${mark("details")}[ Technical details ]  ${mark("approve")}[ Fix it ]`,
      color: theme.focus,
    })
    out.push({ text: "Default focus is Cancel. Enter alone never approves a destructive action from default focus.", color: theme.muted })
    return out
  }

  return (
    <box border borderColor={theme.warning} style={{ flexDirection: "column", padding: 1, width: "100%" }}>
      {lines().map((line) => <text fg={line.color}>{line.text}</text>)}
    </box>
  )
}
