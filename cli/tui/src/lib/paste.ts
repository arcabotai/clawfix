/** Paste sanitization for the composer — decode, normalize, strip controls, size-limit. */

export const DEFAULT_MAX_PASTE_CHARS = 16_384
export const DEFAULT_MAX_PASTE_BYTES = 64 * 1024

const CONTROL_EXCEPT_TAB_LF_CR = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g
const ANSI_CSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g
const ANSI_OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g

export interface SanitizePasteOptions {
  readonly maxChars?: number
  readonly maxBytes?: number
}

export interface SanitizePasteResult {
  readonly text: string
  readonly truncated: boolean
  readonly bytesAccepted: number
  readonly originalBytes: number
}

function decodeUtf8(bytes: Uint8Array): string {
  // TextDecoder replaces invalid sequences; never throw on binary paste.
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes)
}

/**
 * Sanitize raw paste bytes into a single composer message body.
 * Never auto-submits — caller decides when to submit.
 */
export function sanitizePasteBytes(
  bytes: Uint8Array | ArrayBuffer | string,
  options: SanitizePasteOptions = {},
): SanitizePasteResult {
  const maxChars = options.maxChars ?? DEFAULT_MAX_PASTE_CHARS
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_PASTE_BYTES

  let raw: Uint8Array
  if (typeof bytes === "string") {
    raw = new TextEncoder().encode(bytes)
  } else if (bytes instanceof ArrayBuffer) {
    raw = new Uint8Array(bytes)
  } else {
    raw = bytes
  }

  const originalBytes = raw.byteLength
  let accepted = raw
  let truncated = false
  if (accepted.byteLength > maxBytes) {
    accepted = accepted.subarray(0, maxBytes)
    truncated = true
  }

  let text = decodeUtf8(accepted)
  text = text.replace(ANSI_OSC, "").replace(ANSI_CSI, "")
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
  text = text.replace(CONTROL_EXCEPT_TAB_LF_CR, "")

  if (text.length > maxChars) {
    text = text.slice(0, maxChars)
    truncated = true
  }

  return Object.freeze({
    text,
    truncated,
    bytesAccepted: accepted.byteLength,
    originalBytes,
  })
}

/** Sanitize model/assistant text before rendering (strip control sequences). */
export function sanitizeDisplayText(value: unknown, maxChars = 32_000): string {
  if (typeof value !== "string") return ""
  let text = value
    .replace(ANSI_OSC, "")
    .replace(ANSI_CSI, "")
    .replace(CONTROL_EXCEPT_TAB_LF_CR, "")
  if (text.length > maxChars) text = text.slice(0, maxChars)
  return text
}
