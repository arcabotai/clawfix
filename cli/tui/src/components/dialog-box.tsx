import { theme } from "../theme"
import type { DialogState } from "../lib/models"

function line(text: string, color: string) {
  return { text, color }
}

function privacyLines(dialog: Extract<DialogState, { readonly type: "privacy" }>) {
  // Order matters: visibleDialogLines() truncates from the end of the head, so the lines that
  // define what consent actually covers come before the ones that merely restate context.
  const lines = [
    line("Privacy approval", theme.heading),
    line("ClawFix can send this message and a redacted diagnostic to:", theme.text),
    line(dialog.disclosure.providerLabel, theme.accent),
    // The destination host is already in the endpoint URL; a separate line only costs a row
    // that the Included/Not-included disclosure needs on small terminals.
    line(`Endpoint: ${dialog.disclosure.endpointUrl}`, theme.muted),
  ]
  if (dialog.disclosure.diagnosticEndpointUrl) {
    lines.push(line(
      `Uploads the redacted diagnostic first: ${dialog.disclosure.diagnosticEndpointUrl}`,
      theme.muted,
    ))
  }
  lines.push(line(`Included: ${dialog.disclosure.included.join("; ")}`, theme.text))
  lines.push(line(`Not included: ${dialog.disclosure.excluded.join("; ")}`, theme.text))
  if (dialog.pendingMessage) {
    lines.push(line(`Message: ${dialog.pendingMessage.slice(0, 120)}`, theme.muted))
  }
  if (dialog.showPayload) {
    lines.push(line("Exact payload (redacted preview)", theme.heading))
    for (const payloadLine of dialog.payloadJson.split("\n").slice(0, 24)) {
      lines.push(line(payloadLine.length ? payloadLine : " ", theme.muted))
    }
  }
  const mark = (key: string) => (dialog.focus === key ? ">" : " ")
  lines.push(line(
    `${mark("stay-local")}[ Stay local ]  ${mark("inspect")}[ Inspect exact payload ]  ${mark("continue")}[ Continue ]`,
    theme.focus,
  ))
  lines.push(line("Default focus is Stay local. Enter confirms. Esc stays local.", theme.faint))
  return lines
}

function approvalLines(dialog: Extract<DialogState, { readonly type: "approval" }>) {
  const risk = String(dialog.plan.risk || "medium").toLowerCase()
  const high = risk === "high" || risk === "critical"
  const lines = [
    line("Repair approval", theme.heading),
    line(dialog.plan.summary, theme.text),
    line(`Why: ${dialog.rationale || dialog.plan.summary}`, theme.muted),
    line(
      `Changes: ${dialog.plan.previewText || (dialog.plan.unifiedDiff ? "config diff available" : "no configuration files will be changed.")}`,
      theme.muted,
    ),
    line(
      dialog.plan.restartRequired
        ? "Interruption: OpenClaw may be briefly unavailable during restart."
        : "Interruption: no restart required.",
      theme.muted,
    ),
    line(dialog.plan.backupRequired ? "Backup: required before mutation." : "Backup: not required for this repair.", theme.muted),
    line("Verification: ClawFix will re-check local detectors afterward.", theme.muted),
    line(`Risk: ${risk}`, high ? theme.danger : theme.warning),
  ]
  if (high) {
    lines.push(line("High-risk repairs cannot be auto-approved. Use technical details / manual guidance.", theme.danger))
  }
  const mark = (key: string) => (dialog.focus === key ? ">" : " ")
  lines.push(line(
    `${mark("cancel")}[ Cancel ]  ${mark("details")}[ Technical details ]  ${mark("approve")}[ Fix it ]`,
    theme.focus,
  ))
  lines.push(line("Default focus is Cancel. Enter alone never approves a destructive action from default focus.", theme.faint))
  return lines
}

function diffLines(dialog: Extract<DialogState, { readonly type: "diff" }>) {
  const lines = [line(dialog.title || "Diff preview", theme.heading)]
  for (const raw of (dialog.unifiedDiff || "(empty diff)").split("\n").slice(0, 40)) {
    let color = theme.text
    if (raw.startsWith("+") && !raw.startsWith("+++")) color = theme.added
    else if (raw.startsWith("-") && !raw.startsWith("---")) color = theme.removed
    else if (raw.startsWith("@@")) color = theme.info
    else if (raw.startsWith("diff ") || raw.startsWith("index ")) color = theme.muted
    lines.push(line(raw.length ? raw : " ", color))
  }
  lines.push(line("Esc returns to the previous dialog. No changes are applied from this view.", theme.faint))
  return lines
}

export interface DialogBoxProps {
  readonly dialog: DialogState
  readonly maxHeight?: number
  readonly width?: number
}

function wrappedRows(text: string, width: number): number {
  const cols = Math.max(8, Math.floor(width || 0))
  return Math.max(1, Math.ceil(text.length / cols))
}

/**
 * Keep dialog context and actions inside a hard row budget. OpenTUI wraps long
 * text after layout, so line-count-only truncation can still push the footer
 * off-screen on small terminals.
 */
export function visibleDialogLines<T extends { readonly text: string }>(
  all: readonly T[],
  maxRows: number,
  width: number,
): T[] {
  const contentRows = Math.max(3, maxRows - 2) // top/bottom border
  const innerWidth = Math.max(8, width - 4) // border + horizontal padding
  if (all.length === 0) return []

  const tailCount = Math.min(2, all.length)
  const tail = all.slice(all.length - tailCount)
  const tailRows = tail.reduce((sum, item) => sum + wrappedRows(item.text, innerWidth), 0)
  const headCandidates = all.slice(0, all.length - tailCount)
  const headBudget = Math.max(0, contentRows - tailRows)
  const head: T[] = []
  let headRows = 0

  for (let index = 0; index < headCandidates.length; index += 1) {
    const item = headCandidates[index]!
    const rows = wrappedRows(item.text, innerWidth)
    const remainingAfter = headCandidates.length - index - 1
    const markerReserve = remainingAfter > 0 ? 1 : 0
    if (headRows + rows + markerReserve > headBudget) break
    head.push(item)
    headRows += rows
  }

  const omitted = headCandidates.length - head.length
  if (omitted === 0) return [...head, ...tail]
  return [
    ...head,
    { ...all[0]!, text: `… ${omitted} more line${omitted === 1 ? "" : "s"} …` },
    ...tail,
  ]
}

/** Modal-styled dialog pane rendered between transcript and composer. */
export function DialogBox(props: DialogBoxProps) {
  const lines = () => {
    const dialog = props.dialog
    if (!dialog || dialog.type === "none") return []
    if (dialog.type === "privacy") return privacyLines(dialog)
    if (dialog.type === "approval") return approvalLines(dialog)
    return diffLines(dialog)
  }
  const borderColor = () => (props.dialog.type === "approval" ? theme.warning : theme.focus)

  if (!props.dialog || props.dialog.type === "none") return null

  const budget = props.maxHeight ?? 16
  const visible = () => visibleDialogLines(lines(), budget, props.width ?? 80)

  return (
    <box
      border
      borderColor={borderColor()}
      style={{
        flexDirection: "column",
        backgroundColor: theme.panel,
        paddingLeft: 1,
        paddingRight: 1,
        flexShrink: 0,
        maxHeight: budget,
        overflow: "hidden",
      }}
    >
      {visible().map((l) => <text fg={l.color}>{l.text}</text>)}
    </box>
  )
}
