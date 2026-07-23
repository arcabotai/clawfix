import { theme } from "../theme"

export function ActivityCard(props: { readonly label: string }) {
  return (
    <box style={{ flexDirection: "column" }}>
      <text fg={theme.info}>{`· ${props.label}`}</text>
    </box>
  )
}
