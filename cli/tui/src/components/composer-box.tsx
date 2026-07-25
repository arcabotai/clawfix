import { createEffect, onMount } from "solid-js"
import type { KeyBinding, TextareaRenderable } from "@opentui/core"
import { theme } from "../theme"

const COMPOSER_BINDINGS: KeyBinding[] = [
  { name: "return", action: "submit" },
  { name: "return", shift: true, action: "newline" },
  { name: "j", ctrl: true, action: "newline" },
  { name: "return", ctrl: true, action: "newline" },
]

export interface ComposerBoxProps {
  readonly locked: boolean
  readonly note: string | null
  readonly modelLine: string
  readonly onSubmit: (text: string) => void
}

/** Bordered input box (opencode-style) with a hint line underneath. */
export function ComposerBox(props: ComposerBoxProps) {
  let area: TextareaRenderable | undefined

  const syncFocus = () => {
    if (!area) return
    if (props.locked) area.blur()
    else area.focus()
  }

  onMount(() => syncFocus())
  createEffect(() => {
    void props.locked
    syncFocus()
  })

  const handleSubmit = () => {
    if (!area || props.locked) return
    const value = area.plainText.replace(/\r/g, "").trim()
    if (!value) return
    props.onSubmit(value)
    area.editBuffer.setText("")
  }

  return (
    <box style={{ flexDirection: "column", flexShrink: 0 }}>
      {props.locked && props.note && <text fg={theme.warning}>{props.note}</text>}
      <box
        border
        borderColor={props.locked ? theme.borderSubtle : theme.border}
        style={{
          flexDirection: "column",
          backgroundColor: theme.panel,
          height: 3,
        }}
      >
        <textarea
          ref={(r: TextareaRenderable) => { area = r }}
          keyBindings={COMPOSER_BINDINGS}
          onSubmit={handleSubmit}
          placeholder={props.locked ? "Composer locked while a dialog is open." : "Tell me what is going wrong…"}
          placeholderColor={theme.faint}
          textColor={theme.text}
          focusedTextColor={theme.text}
          cursorColor={theme.brand}
          style={{
            flexGrow: 1,
            backgroundColor: theme.panel,
            focusedBackgroundColor: theme.panel,
            paddingLeft: 1,
          }}
        />
      </box>
      <text fg={theme.faint}>{props.modelLine}</text>
    </box>
  )
}
