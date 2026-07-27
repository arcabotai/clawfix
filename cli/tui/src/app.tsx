import { createSignal, onCleanup } from "solid-js"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"

import { resolveComposerSubmit } from "./components/composer"
import { ComposerBox } from "./components/composer-box"
import { ChatTranscript } from "./components/chat"
import { DialogBox } from "./components/dialog-box"
import { Sidebar } from "./components/sidebar"
import { Splash } from "./components/splash"
import { buildUnifiedDiff } from "./components/diff-dialog"
import { helpText, resolveGlobalKeyAction, resolveModelLine } from "./keymap"
import { resolveLayout, type TranscriptItem } from "./lib/models"
import {
  createFakeSession,
  type TuiFinding,
  type TuiSessionView,
} from "./session-bridge"
import { theme } from "./theme"

import cliPackage from "../../package.json"

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
  /** Tear down the renderer and leave the app. Wired to renderer.destroy() in main.tsx. */
  readonly onQuit?: () => void
}

const SIDEBAR_WIDTH = 34

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

    const state = view()
    switch (resolveGlobalKeyAction(key, { busy: state.busy, scanning: state.scanning })) {
      case "toggle-help":
        controller?.toggleHelp?.()
        key.preventDefault?.()
        return
      case "quit":
        props.onQuit?.()
        key.preventDefault?.()
        return
      case "cancel":
        controller?.cancelScan?.()
        key.preventDefault?.()
        return
      default:
    }
  })

  /** Transcript items, with the findings fallback and help block appended. */
  const transcriptItems = (): readonly TranscriptItem[] => {
    const state = current()
    let items: TranscriptItem[] = state.items?.length
      ? [...state.items]
      : (state.findings || []).map((f) => ({
          kind: "finding" as const,
          id: `finding-card-${f.id}`,
          findingId: f.id,
          title: f.title,
          severity: f.severity,
          repairable: f.repairable,
          repairId: f.repairId,
          evidence: null,
        }))
    if (state.helpVisible) {
      return [{ kind: "message", id: "help", role: "system", text: helpText(dims().width <= 64) }]
    }
    return items
  }

  const showSplash = () =>
    transcriptItems().length === 0 && !(current().findings?.length)

  const aiLabel = () =>
    current().aiMode === "remote"
      ? "Remote · clawfix.dev"
      : current().aiMode === "remote-pending"
        ? "Remote (pending consent)"
        : "Local only"

  const modelLine = () => resolveModelLine(aiLabel(), dims().width)

  const statusLine = () => {
    const state = current()
    // The bridge's status already begins with "Revision <id> · N findings", so adding the
    // revision here printed it twice and pushed the finding count off the end of the line.
    const full = `🦞 ClawFix v${cliPackage.version} · ${state.status}`
    const budget = dims().width - 4
    if (budget <= 0) return ""
    if (full.length <= budget) return full
    if (budget === 1) return "…"
    // Slice by code point: the 🦞 in the banner is a surrogate pair, and cutting between its
    // halves paints a replacement glyph.
    return `${[...full].slice(0, budget - 1).join("")}…`
  }

  const handleSubmit = (text: string) => {
    const decision = resolveComposerSubmit({
      draft: text,
      locked: current().composerLocked || current().dialog.type !== "none",
      busy: current().busy,
    })
    if (decision.action !== "submit") return
    void controller?.send?.(decision.text)
  }

  return (
    <box
      style={{
        width: "100%",
        height: "100%",
        flexDirection: "column",
        backgroundColor: theme.background,
      }}
    >
      {showSplash()
        ? (
          <Splash
            version={cliPackage.version}
            aiLabel={aiLabel()}
            scanning={current().scanning}
            narrow={layout().mode === "narrow"}
          />
        )
        : (
          <box style={{ flexDirection: "row", flexGrow: 1, flexShrink: 1, minHeight: 0 }}>
            <box style={{ flexDirection: "column", flexGrow: 1, flexShrink: 1, minHeight: 0 }}>
              <ChatTranscript items={transcriptItems()} topAligned={current().helpVisible} />
            </box>
            {layout().showSidebar && (
              <Sidebar
                width={SIDEBAR_WIDTH}
                revision={current().revision}
                aiMode={current().aiMode}
                scanning={current().scanning}
                findings={current().findings || []}
                status={current().status}
              />
            )}
          </box>
        )}

      <DialogBox
        dialog={current().dialog}
        // The consent dialog gets a larger share: at 50% its Included/Not-included lines were
        // truncated away on an 80x24 terminal, hiding the very disclosure being consented to.
        maxHeight={Math.max(8, Math.floor(dims().height * (current().dialog.type === "privacy" ? 0.72 : 0.5)))}
        width={dims().width}
      />

      <box style={{ flexDirection: "column", flexShrink: 0, paddingLeft: 1, paddingRight: 1, paddingBottom: 0 }}>
        <ComposerBox
          locked={current().composerLocked || current().dialog.type !== "none"}
          note={current().queueNote}
          modelLine={modelLine()}
          onSubmit={handleSubmit}
        />
        <text fg={theme.faint}>{statusLine()}</text>
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
