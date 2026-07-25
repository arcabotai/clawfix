import type { JSX } from "solid-js"
import { theme, severityColor } from "../theme"
import type { TranscriptItem } from "../lib/models"

const Spacer = () => <box style={{ height: 1 }} />

function textLines(text: string, color: string): JSX.Element[] {
  return text.split("\n").map((line) => (
    <text fg={color}>{line.length ? line : "·"}</text>
  ))
}

function userMessageBlocks(text: string): JSX.Element[] {
  const paragraphs = text.split(/\n{2,}/)
  const inner: JSX.Element[] = []
  paragraphs.forEach((para, i) => {
    inner.push(...textLines(para, theme.text))
    if (i < paragraphs.length - 1) inner.push(<Spacer />)
  })
  return [
    <box
      border
      borderColor={theme.borderSubtle}
      style={{
        flexDirection: "column",
        backgroundColor: theme.panelRaised,
        paddingLeft: 1,
        paddingRight: 1,
      }}
    >
      {inner}
    </box>,
    <Spacer />,
  ]
}

function assistantBlocks(text: string, streaming?: boolean): JSX.Element[] {
  const out: JSX.Element[] = [
    <text fg={theme.brand}>{streaming ? "ClawFix …" : "ClawFix"}</text>,
  ]
  const paragraphs = text.split(/\n{2,}/)
  paragraphs.forEach((para, i) => {
    out.push(...textLines(para, theme.text))
    if (i < paragraphs.length - 1) out.push(<Spacer />)
  })
  out.push(<Spacer />)
  return out
}

function findingBlocks(item: Extract<TranscriptItem, { readonly kind: "finding" }>): JSX.Element[] {
  const rows: JSX.Element[] = [
    <text fg={severityColor(item.severity)}>{`[${String(item.severity || "info").toLowerCase()}] ${item.title}`}</text>,
    <text fg={theme.muted}>
      {item.repairable ? "repairable · reviewed catalog only" : "advisory · no automatic repair"}
    </text>,
  ]
  if (item.evidence) rows.push(<text fg={theme.faint}>{item.evidence}</text>)
  return [
    <box
      border={["left"]}
      borderColor={severityColor(item.severity)}
      style={{ flexDirection: "column", paddingLeft: 1 }}
    >
      {rows}
    </box>,
    <Spacer />,
  ]
}

function repairBlocks(item: Extract<TranscriptItem, { readonly kind: "repair" }>): JSX.Element[] {
  const statusColor =
    item.status === "completed" ? theme.success
    : item.status === "failed" ? theme.danger
    : item.status === "running" ? theme.info
    : theme.warning
  const rows: JSX.Element[] = [
    <text fg={statusColor}>{`Repair proposal · ${item.status}`}</text>,
    <text fg={theme.text}>{item.plan.summary}</text>,
  ]
  if (item.rationale) rows.push(<text fg={theme.muted}>{`Why: ${item.rationale}`}</text>)
  rows.push(<text fg={theme.faint}>{`Risk: ${item.plan.risk} · ${item.plan.repairIds.join(", ")}`}</text>)
  return [
    <box
      border={["left"]}
      borderColor={statusColor}
      style={{ flexDirection: "column", paddingLeft: 1 }}
    >
      {rows}
    </box>,
    <Spacer />,
  ]
}

function blocksForItem(item: TranscriptItem): JSX.Element[] {
  if (item.kind === "message") {
    if (item.role === "user") return userMessageBlocks(item.text)
    if (item.role === "system") return [...textLines(item.text, theme.faint), <Spacer />]
    return assistantBlocks(item.text, item.streaming)
  }
  if (item.kind === "activity") return [<text fg={theme.info}>{`· ${item.label}`}</text>]
  if (item.kind === "finding") return findingBlocks(item)
  if (item.kind === "repair") return repairBlocks(item)
  if (item.kind === "warning") return [<text fg={theme.warning}>{`Warning: ${item.message}`}</text>]
  return [<text fg={theme.danger}>{`Error: ${item.message}`}</text>]
}

export interface ChatTranscriptProps {
  readonly items: readonly TranscriptItem[]
  readonly topAligned?: boolean
}

/** Scrollback transcript: flat block list inside a sticky scrollbox. */
export function ChatTranscript(props: ChatTranscriptProps) {
  const blocks = () => (props.items || []).flatMap((item) => blocksForItem(item))
  return (
    <scrollbox
      stickyScroll
      stickyStart={props.topAligned ? "top" : "bottom"}
      style={{
        flexGrow: 1,
        flexShrink: 1,
        minHeight: 0,
        flexDirection: "column",
        paddingLeft: 1,
        paddingRight: 1,
        paddingTop: 1,
        backgroundColor: theme.background,
      }}
    >
      {blocks()}
    </scrollbox>
  )
}
