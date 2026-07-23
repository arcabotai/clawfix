import { theme } from "../theme"

/**
 * Config preview dialog.
 * Renders unified diff as colored text lines (no tree-sitter runtime fetch).
 */
export function DiffDialog(props: {
  readonly title: string
  readonly unifiedDiff: string
}) {
  const lines = () => {
    const out: Array<{ text: string; color: string }> = []
    out.push({ text: props.title || "Diff preview", color: theme.heading })
    for (const line of (props.unifiedDiff || "(empty diff)").split("\n").slice(0, 40)) {
      let color = theme.text
      if (line.startsWith("+") && !line.startsWith("+++")) color = theme.added
      else if (line.startsWith("-") && !line.startsWith("---")) color = theme.removed
      else if (line.startsWith("@@")) color = theme.info
      else if (line.startsWith("diff ") || line.startsWith("index ")) color = theme.muted
      out.push({ text: line.length ? line : " ", color })
    }
    out.push({ text: "Esc returns to the previous dialog. No changes are applied from this view.", color: theme.muted })
    return out
  }

  return (
    <box border borderColor={theme.border} style={{ flexDirection: "column", padding: 1, width: "100%" }}>
      {lines().map((line) => <text fg={line.color}>{line.text}</text>)}
    </box>
  )
}

/** Build a minimal unified diff string for tests / previews. */
export function buildUnifiedDiff(path: string, before: string, after: string): string {
  const a = before.split("\n")
  const b = after.split("\n")
  const lines = [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${a.length} +1,${b.length} @@`,
  ]
  for (const line of a) lines.push(`-${line}`)
  for (const line of b) lines.push(`+${line}`)
  return lines.join("\n")
}
