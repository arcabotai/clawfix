import { theme } from "../theme"

const LOGO_WIDE = [
  " ██████╗██╗      █████╗ ██╗    ██╗███████╗██╗██╗  ██╗",
  "██╔════╝██║     ██╔══██╗██║    ██║██╔════╝██║╚██╗██╔╝",
  "██║     ██║     ███████║██║ █╗ ██║█████╗  ██║ ╚███╔╝ ",
  "██║     ██║     ██╔══██║██║███╗██║██╔══╝  ██║ ██╔██╗ ",
  "╚██████╗███████╗██║  ██║╚███╔███╔╝██║     ██║██╔╝ ██╗",
  " ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝ ╚═╝     ╚═╝╚═╝  ╚═╝",
] as const

const LOGO_NARROW = "🦞 ClawFix"

export interface SplashProps {
  readonly version: string
  readonly aiLabel: string
  readonly scanning: boolean
  readonly narrow: boolean
}

/**
 * Welcome / loading screen shown while the transcript is empty.
 * Once real content exists, the chat transcript replaces it.
 */
export function Splash(props: SplashProps) {
  const tips = [
    "Describe what is going wrong — ClawFix scans locally first.",
    "fix <#> applies reviewed repairs only, after your approval.",
    "Remote AI analysis always asks before anything leaves this machine.",
  ]
  return (
    <box
      style={{
        flexDirection: "column",
        flexGrow: 1,
        justifyContent: "center",
        alignItems: "center",
        backgroundColor: theme.background,
      }}
    >
      {props.narrow
        ? <text fg={theme.brand}>{LOGO_NARROW}</text>
        : LOGO_WIDE.map((line) => <text fg={theme.brand}>{line}</text>)}
      <text fg={theme.muted}>{" "}</text>
      <text fg={theme.heading}>OpenClaw diagnostics and guarded repairs</text>
      <text fg={theme.faint}>{`v${props.version} · ${props.aiLabel}`}</text>
      <text fg={theme.muted}>{" "}</text>
      {props.scanning
        ? <text fg={theme.info}>Scanning your OpenClaw setup…</text>
        : tips.map((tip) => <text fg={theme.muted}>{tip}</text>)}
    </box>
  )
}
