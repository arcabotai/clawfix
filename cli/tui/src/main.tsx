import { createCliRenderer, type CliRenderer, type CliRendererConfig } from "@opentui/core"
import { render } from "@opentui/solid"

import { App, createFakeSession, type SessionSource, type TuiSessionView } from "./app"
import type { SessionBridge } from "./session-bridge"

const EXIT_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const

type ExitSignal = (typeof EXIT_SIGNALS)[number]

const SIGNAL_EXIT_CODES: Readonly<Record<ExitSignal, number>> = Object.freeze({
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
})

export function exitCodeForSignal(signal: ExitSignal): number {
  return SIGNAL_EXIT_CODES[signal]
}

interface RendererOwner {
  destroy(): void
}

interface ProcessTarget {
  on(event: "uncaughtException", listener: (error: unknown) => void): this
  on(event: "unhandledRejection", listener: (reason: unknown) => void): this
  on(event: ExitSignal, listener: () => void): this
  off(event: "uncaughtException", listener: (error: unknown) => void): this
  off(event: "unhandledRejection", listener: (reason: unknown) => void): this
  off(event: ExitSignal, listener: () => void): this
}

export type LifecycleResult =
  | { readonly reason: "exit" }
  | { readonly reason: "signal"; readonly signal: ExitSignal }

export interface RendererLifecycleOptions<Renderer extends RendererOwner> {
  readonly createRenderer: () => Promise<Renderer>
  readonly mount: (renderer: Renderer) => void | Promise<void>
  readonly run: (renderer: Renderer) => Promise<LifecycleResult | void>
  readonly processTarget?: ProcessTarget
}

function toError(reason: unknown): Error {
  if (reason instanceof Error) return reason
  return new Error(String(reason))
}

function topLevelExit(processTarget: ProcessTarget) {
  let rejectFatal!: (error: Error) => void
  let resolveSignal!: (result: LifecycleResult) => void
  const fatal = new Promise<never>((_resolve, reject) => { rejectFatal = reject })
  const signal = new Promise<LifecycleResult>((resolve) => { resolveSignal = resolve })

  const onUncaughtException = (error: unknown) => rejectFatal(toError(error))
  const onUnhandledRejection = (reason: unknown) => rejectFatal(toError(reason))
  const signalListeners = new Map<ExitSignal, () => void>()

  processTarget.on("uncaughtException", onUncaughtException)
  processTarget.on("unhandledRejection", onUnhandledRejection)
  for (const exitSignal of EXIT_SIGNALS) {
    const listener = () => resolveSignal({ reason: "signal", signal: exitSignal })
    signalListeners.set(exitSignal, listener)
    processTarget.on(exitSignal, listener)
  }

  return {
    outcome: Promise.race([fatal, signal]),
    cleanup() {
      processTarget.off("uncaughtException", onUncaughtException)
      processTarget.off("unhandledRejection", onUnhandledRejection)
      for (const [exitSignal, listener] of signalListeners) {
        processTarget.off(exitSignal, listener)
      }
    },
  }
}

export async function ownRendererLifecycle<Renderer extends RendererOwner>({
  createRenderer,
  mount,
  run,
  processTarget = process,
}: RendererLifecycleOptions<Renderer>): Promise<LifecycleResult | void> {
  const renderer = await createRenderer()
  const topLevel = topLevelExit(processTarget)

  try {
    const application = Promise.resolve()
      .then(() => mount(renderer))
      .then(() => run(renderer))
    return await Promise.race([application, topLevel.outcome])
  } finally {
    topLevel.cleanup()
    renderer.destroy()
  }
}

export const rendererConfig = Object.freeze({
  screenMode: "alternate-screen",
  targetFps: 30,
  exitOnCtrlC: false,
  exitSignals: [],
  useMouse: true,
  openConsoleOnError: false,
} satisfies CliRendererConfig)

function waitForRendererExit(renderer: CliRenderer): Promise<LifecycleResult> {
  return new Promise(resolve => {
    renderer.once("destroy", () => resolve({ reason: "exit" }))
  })
}

export function startTui(input?: TuiSessionView | SessionSource | SessionBridge): Promise<LifecycleResult | void> {
  const isSource = Boolean(input && typeof (input as SessionSource).subscribe === "function")
  return ownRendererLifecycle({
    createRenderer: () => createCliRenderer(rendererConfig),
    mount: renderer => render(
      () => isSource
        ? <App source={input as SessionSource} />
        : <App session={(input as TuiSessionView) ?? createFakeSession()} />,
      renderer,
    ),
    run: waitForRendererExit,
  })
}

if (import.meta.main) {
  startTui(createFakeSession())
    .then(result => {
      if (result?.reason === "signal") {
        process.exitCode = exitCodeForSignal(result.signal)
      }
    })
    .catch(error => {
      process.stderr.write(`ClawFix TUI failed: ${toError(error).message}\n`)
      process.exitCode = 1
    })
}
