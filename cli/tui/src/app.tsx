import { createSignal, onCleanup } from "solid-js"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"

import { resolveComposerSubmit } from "./components/composer"
import { buildUnifiedDiff } from "./components/diff-dialog"
import { helpText, KEY_HINTS, NARROW_KEY_HINTS } from "./keymap"
import { resolveLayout, type DialogState, type TranscriptItem } from "./lib/models"
import {
  createFakeSession,
  type TuiFinding,
  type TuiSessionView,
} from "./session-bridge"
import { severityColor, theme } from "./theme"

export type { TuiFinding, TuiSessionView }
export { createFakeSession, buildUnifiedDiff, resolveComposerSubmit }

export interface SessionSource {
  getView(): TuiSessionView
  subscribe(listener: (view: TuiSessionView) => void): () => void
  send?(input: string): Promise<TuiSessionView> | TuiSessionView
  setDraft?(value: string): void
  toggleHelp?(): void
  cancelScan?(): boolean
  privacyMoveFocus?(delta: number): void
  privacySetFocus?(focus: "stay-local" | "inspect" | "continue"): void
  privacyConfirm?(): Promise<TuiSessionView> | TuiSessionView
  privacyDismissStayLocal?(): void
  approvalMoveFocus?(delta: number): void
  approvalSetFocus?(focus: "cancel" | "details" | "approve"): void
  approvalConfirm?(): Promise<TuiSessionView> | TuiSessionView
  approvalShowDiff?(): void
  closeDialog?(): void
  scan?(): Promise<TuiSessionView> | TuiSessionView
}

export interface AppProps {
  readonly session?: TuiSessionView
  readonly source?: SessionSource
  readonly simpleComposer?: boolean
}

function itemLines(items: readonly TranscriptItem[]): Array<{ text: string; color: string }> {
  const lines: Array<{ text: string; color: string }> = []
  if (!items || items.length === 0) {
    lines.push({ text: "No messages yet.", color: theme.muted })
    return lines
  }
  for (const item of items) {
    if (item.kind === "message") {
      const who = item.role === "user" ? "You" : item.role === "assistant" ? (item.streaming ? "ClawFix …" : "ClawFix") : "System"
      lines.push({ text: who, color: item.role === "user" ? theme.accent : theme.heading })
      for (const line of item.text.split("\n")) {
        lines.push({ text: line.length ? line : " ", color: theme.text })
      }
      lines.push({ text: " ", color: theme.muted })
      continue
    }
    if (item.kind === "activity") {
      lines.push({ text: `· ${item.label}`, color: theme.info })
      continue
    }
    if (item.kind === "finding") {
      const sev = String(item.severity || "info").toLowerCase()
      lines.push({ text: `[${sev}] ${item.title}`, color: severityColor(sev) })
      lines.push({
        text: item.repairable ? "repairable · reviewed catalog only" : "advisory · no automatic repair",
        color: theme.muted,
      })
      if (item.evidence) lines.push({ text: item.evidence, color: theme.muted })
      lines.push({ text: " ", color: theme.muted })
      continue
    }
    if (item.kind === "repair") {
      lines.push({ text: `Repair proposal · ${item.status}`, color: theme.warning })
      lines.push({ text: item.plan.summary, color: theme.text })
      if (item.rationale) lines.push({ text: `Why: ${item.rationale}`, color: theme.muted })
      lines.push({ text: `Risk: ${item.plan.risk} · ${item.plan.repairIds.join(", ")}`, color: theme.muted })
      lines.push({ text: " ", color: theme.muted })
      continue
    }
    if (item.kind === "warning") {
      lines.push({ text: `Warning: ${item.message}`, color: theme.warning })
      continue
    }
    if (item.kind === "error") {
      lines.push({ text: `Error: ${item.message}`, color: theme.danger })
    }
  }
  return lines
}

function dialogLines(dialog: DialogState | undefined): Array<{ text: string; color: string }> {
  const lines: Array<{ text: string; color: string }> = []
  if (!dialog || dialog.type === "none") return lines

  if (dialog.type === "privacy") {
    lines.push({ text: "Privacy approval", color: theme.heading })
    lines.push({ text: "ClawFix can send this message and a redacted diagnostic to:", color: theme.text })
    lines.push({ text: dialog.disclosure.providerLabel, color: theme.accent })
    lines.push({ text: `Destination: ${dialog.disclosure.destination}`, color: theme.muted })
    lines.push({ text: `Endpoint: ${dialog.disclosure.endpointUrl}`, color: theme.muted })
    if (dialog.pendingMessage) {
      lines.push({ text: `Message: ${dialog.pendingMessage.slice(0, 120)}`, color: theme.muted })
    }
    lines.push({ text: "Included", color: theme.heading })
    for (const item of dialog.disclosure.included) lines.push({ text: `• ${item}`, color: theme.text })
    lines.push({ text: "Not included", color: theme.heading })
    for (const item of dialog.disclosure.excluded) lines.push({ text: `• ${item}`, color: theme.text })
    if (dialog.showPayload) {
      lines.push({ text: "Exact payload (redacted preview)", color: theme.heading })
      for (const line of dialog.payloadJson.split("\n").slice(0, 24)) {
        lines.push({ text: line.length ? line : " ", color: theme.muted })
      }
    }
    const mark = (key: string) => (dialog.focus === key ? ">" : " ")
    lines.push({
      text: `${mark("stay-local")}[ Stay local ]  ${mark("inspect")}[ Inspect exact payload ]  ${mark("continue")}[ Continue ]`,
      color: theme.focus,
    })
    lines.push({ text: "Default focus is Stay local. Enter confirms. Esc stays local.", color: theme.muted })
    return lines
  }

  if (dialog.type === "approval") {
    const risk = String(dialog.plan.risk || "medium").toLowerCase()
    const high = risk === "high" || risk === "critical"
    lines.push({ text: "Repair approval", color: theme.heading })
    lines.push({ text: dialog.plan.summary, color: theme.text })
    lines.push({ text: `Why: ${dialog.rationale || dialog.plan.summary}`, color: theme.muted })
    lines.push({
      text: `Changes: ${dialog.plan.previewText || (dialog.plan.unifiedDiff ? "config diff available" : "no configuration files will be changed.")}`,
      color: theme.muted,
    })
    lines.push({
      text: dialog.plan.restartRequired
        ? "Interruption: OpenClaw may be briefly unavailable during restart."
        : "Interruption: no restart required.",
      color: theme.muted,
    })
    lines.push({
      text: dialog.plan.backupRequired ? "Backup: required before mutation." : "Backup: not required for this repair.",
      color: theme.muted,
    })
    lines.push({ text: "Verification: ClawFix will re-check local detectors afterward.", color: theme.muted })
    lines.push({ text: `Risk: ${risk}`, color: high ? theme.danger : theme.warning })
    if (high) {
      lines.push({ text: "High-risk repairs cannot be auto-approved. Use technical details / manual guidance.", color: theme.danger })
    }
    const mark = (key: string) => (dialog.focus === key ? ">" : " ")
    lines.push({
      text: `${mark("cancel")}[ Cancel ]  ${mark("details")}[ Technical details ]  ${mark("approve")}[ Fix it ]`,
      color: theme.focus,
    })
    lines.push({ text: "Default focus is Cancel. Enter alone never approves a destructive action from default focus.", color: theme.muted })
    return lines
  }

  if (dialog.type === "diff") {
    lines.push({ text: dialog.title || "Diff preview", color: theme.heading })
    for (const line of (dialog.unifiedDiff || "(empty diff)").split("\n").slice(0, 40)) {
      let color = theme.text
      if (line.startsWith("+") && !line.startsWith("+++")) color = theme.added
      else if (line.startsWith("-") && !line.startsWith("---")) color = theme.removed
      else if (line.startsWith("@@")) color = theme.info
      else if (line.startsWith("diff ") || line.startsWith("index ")) color = theme.muted
      lines.push({ text: line.length ? line : " ", color })
    }
    lines.push({ text: "Esc returns to the previous dialog. No changes are applied from this view.", color: theme.muted })
  }
  return lines
}

export function App(props: AppProps) {
  const initial = props.source?.getView() ?? props.session ?? createFakeSession()
  const [view, setView] = createSignal<TuiSessionView>(initial)
  const controller = props.source ?? null

  if (props.source) {
    const unsubscribe = props.source.subscribe((next) => setView(next))
    onCleanup(unsubscribe)
  }

  const dims = useTerminalDimensions()
  const layout = () => resolveLayout(dims().width, dims().height)
  const current = () => view()

  useKeyboard((key: any) => {
    const name = String(key?.name || "").toLowerCase()
    const currentDialog = view().dialog

    if (name === "escape") {
      controller?.closeDialog?.()
      key.preventDefault?.()
      return
    }

    if (currentDialog?.type === "privacy") {
      if (name === "tab" || name === "right" || name === "down") {
        controller?.privacyMoveFocus?.(key.shift ? -1 : 1)
        key.preventDefault?.()
        return
      }
      if (name === "left" || name === "up") {
        controller?.privacyMoveFocus?.(-1)
        key.preventDefault?.()
        return
      }
      if (name === "return" || name === "enter") {
        void controller?.privacyConfirm?.()
        key.preventDefault?.()
        return
      }
      return
    }

    if (currentDialog?.type === "approval") {
      if (name === "tab" || name === "right" || name === "down") {
        controller?.approvalMoveFocus?.(key.shift ? -1 : 1)
        key.preventDefault?.()
        return
      }
      if (name === "left" || name === "up") {
        controller?.approvalMoveFocus?.(-1)
        key.preventDefault?.()
        return
      }
      if (name === "return" || name === "enter") {
        void controller?.approvalConfirm?.()
        key.preventDefault?.()
        return
      }
      return
    }

    if (currentDialog?.type === "diff") {
      if (name === "return" || name === "enter" || name === "escape") {
        controller?.closeDialog?.()
        key.preventDefault?.()
      }
      return
    }

    if (name === "?" && !key.ctrl && !key.meta) {
      controller?.toggleHelp?.()
      key.preventDefault?.()
      return
    }

    if (name === "c" && key.ctrl) {
      controller?.cancelScan?.()
    }
  })

  const bodyLines = () => {
    const lines: Array<{ text: string; color: string }> = []
    // Prefer explicit transcript items; also surface findings if items empty but findings exist.
    const items = current().items?.length
      ? current().items
      : (current().findings || []).map((f) => ({
          kind: "finding" as const,
          id: `finding-card-${f.id}`,
          findingId: f.id,
          title: f.title,
          severity: f.severity,
          repairable: f.repairable,
          repairId: f.repairId,
          evidence: null,
        }))
    lines.push(...itemLines(items))
    if (current().helpVisible) {
      lines.push({ text: "— help —", color: theme.heading })
      for (const line of helpText().split("\n")) {
        lines.push({ text: line.length ? line : " ", color: theme.muted })
      }
    }
    lines.push(...dialogLines(current().dialog))
    return lines
  }

  const sidebarLines = () => {
    if (!layout().showSidebar) return [] as Array<{ text: string; color: string }>
    return [
      { text: "System", color: theme.heading },
      { text: `Revision ${current().revision || "none"}`, color: theme.muted },
      { text: `Issues   ${current().findings?.length || 0}`, color: theme.muted },
      { text: current().aiMode === "remote" ? "AI       Remote" : "AI       Local only", color: theme.muted },
      { text: current().scanning ? "Scan     running" : "Scan     idle", color: theme.muted },
    ]
  }

  const footerLines = () => {
    const lines: Array<{ text: string; color: string }> = []
    if (current().queueNote) lines.push({ text: current().queueNote, color: theme.warning })
    if (current().composerLocked) lines.push({ text: "Composer locked while a dialog is open.", color: theme.muted })
    const draft = current().draft || ""
    lines.push({ text: draft ? `> ${draft}` : "> Tell me what is going wrong…", color: draft ? theme.text : theme.muted })
    if (layout().showKeyHints) {
      const hints = layout().mode === "wide" ? KEY_HINTS : NARROW_KEY_HINTS
      lines.push({ text: hints.join("  "), color: theme.muted })
    }
    return lines
  }

  // OpenTUI Solid rejects orphan whitespace/empty text nodes outside <text>.
  // One bordered column, only explicit <text> children via .map().
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
        <text fg={theme.heading}>ClawFix</text>
        <text fg={theme.text}>{current().prompt}</text>
        <text fg={theme.muted}>{current().status}</text>
        <text fg={theme.muted}>{current().revision ? `revision ${current().revision}` : "revision none"}</text>
        {bodyLines().map((line) => <text fg={line.color}>{line.text}</text>)}
        {sidebarLines().map((line) => <text fg={line.color}>{line.text}</text>)}
        {footerLines().map((line) => <text fg={line.color}>{line.text}</text>)}
      </box>
    </box>
  )
}

// Component re-exports for direct unit tests.
export { Composer } from "./components/composer"
export { PrivacyDialog } from "./components/privacy-dialog"
export { ApprovalDialog } from "./components/approval-dialog"
export { DiffDialog } from "./components/diff-dialog"
export { Transcript } from "./components/transcript"
export { FindingCard } from "./components/finding-card"
export { RepairCard } from "./components/repair-card"
export { ActivityCard } from "./components/activity-card"
export type { SessionController } from "./context/session"
