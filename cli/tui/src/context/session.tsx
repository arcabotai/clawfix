import { createContext, useContext, type ParentProps, createSignal, onCleanup } from "solid-js"

import {
  createFakeSession,
  type SessionBridge,
  type TuiSessionView,
} from "../session-bridge"

export interface SessionSource {
  getView(): TuiSessionView
  subscribe(listener: (view: TuiSessionView) => void): () => void
}

export interface SessionController extends SessionSource {
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

const SessionCtx = createContext<{
  view: () => TuiSessionView
  controller: SessionController | null
}>()

export function SessionProvider(props: ParentProps<{
  readonly session?: TuiSessionView
  readonly source?: SessionController | SessionSource
  readonly bridge?: SessionBridge
}>) {
  const initial = props.bridge?.getView()
    ?? props.source?.getView()
    ?? props.session
    ?? createFakeSession()

  const [view, setView] = createSignal<TuiSessionView>(initial)
  const controller: SessionController | null = (props.bridge as SessionController | undefined)
    ?? (props.source as SessionController | undefined)
    ?? null

  const source = props.bridge ?? props.source
  if (source) {
    const unsub = source.subscribe((next) => setView(next))
    onCleanup(unsub)
  }

  return (
    <SessionCtx.Provider value={{ view, controller }}>
      {props.children}
    </SessionCtx.Provider>
  )
}

export function useSession() {
  const ctx = useContext(SessionCtx)
  if (!ctx) {
    return {
      view: () => createFakeSession(),
      controller: null as SessionController | null,
    }
  }
  return ctx
}
