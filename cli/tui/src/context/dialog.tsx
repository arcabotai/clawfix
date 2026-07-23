import { createContext, useContext, type ParentProps, createSignal } from "solid-js"

import { emptyDialog, type DialogState } from "../lib/models"

const DialogCtx = createContext<{
  dialog: () => DialogState
  setDialog: (next: DialogState) => void
  close: () => void
}>()

/** Optional local dialog override layer; primary dialog state lives on the session bridge. */
export function DialogProvider(props: ParentProps<{ readonly initial?: DialogState }>) {
  const [dialog, setDialog] = createSignal<DialogState>(props.initial ?? emptyDialog())
  return (
    <DialogCtx.Provider
      value={{
        dialog,
        setDialog,
        close: () => setDialog(emptyDialog()),
      }}
    >
      {props.children}
    </DialogCtx.Provider>
  )
}

export function useDialog() {
  const ctx = useContext(DialogCtx)
  if (!ctx) {
    return {
      dialog: () => emptyDialog() as DialogState,
      setDialog: (_: DialogState) => undefined,
      close: () => undefined,
    }
  }
  return ctx
}
