// @ts-nocheck — imports plain-JS cli/ core modules without type declarations;
// the JS files resolve on disk so ambient d.ts declarations never apply (TS7016).
/**
 * Live session factory — wires the real ClawFix diagnostic/session core to the
 * OpenTUI session bridge (same wiring as interfaces/plain.js, minus ANSI output).
 *
 * Runs under Bun (cli/tui). No remote analyzer yet: the session starts in
 * local-only AI mode and works fully offline; remote streaming can be attached
 * later by passing a remoteAnalyzer to createSessionBridge.
 */
import { access, readFile, readdir, stat } from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import { arch, homedir, hostname, platform, release } from "node:os"

import {
  collectListeningPort,
  collectNativeConfigValidation,
  collectNativeDoctor,
  collectNativeSecurityAudit,
  collectNativeStatus,
  collectOpenClawVersion,
} from "../../bin/native-diagnostics.js"
import { redactOutbound } from "../../bin/security.js"
import { countMarkdownFiles } from "../../bin/workspace.js"
import { openClawAdapter } from "../../adapters/openclaw.js"
import { createDiagnosticsCore } from "../../core/diagnostics.js"
import { normalizeFindings } from "../../core/findings.js"
import { repairCatalog } from "../../core/repair-catalog.js"
import { createRepairEngine } from "../../core/repair-engine.js"
import { createSessionController } from "../../core/session.js"
import { createOfflineAnalyzer } from "../../core/offline-analyzer.js"
import { createRemoteAnalyzer } from "./remote-analyzer"
import { createSessionBridge, type SessionBridge } from "./session-bridge"

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true } catch { return false }
}

async function readJson(p: string): Promise<unknown> {
  try { return JSON.parse(await readFile(p, "utf8")) } catch { return null }
}

function plainSummary(summary: any) {
  return {
    gateway: { icon: summary.gateway.running ? "✓" : "✗", label: summary.gateway.label },
    config: { icon: summary.config.loaded ? "✓" : "⚠", label: summary.config.label },
    issues: { icon: summary.issues.actionable === 0 ? "✓" : "⚠", label: summary.issues.label },
    node: summary.node,
    os: summary.os,
    ocVersion: summary.ocVersion,
  }
}

export interface LiveSessionOptions {
  readonly version: string
  readonly autoScan?: boolean
}

export function createLiveSession(options: LiveSessionOptions): SessionBridge {
  const diagnosticsCore = createDiagnosticsCore({
    version: options.version,
    redact: redactOutbound,
    fs: { exists, readJson, stat, readdir, countMarkdownFiles },
    openclaw: openClawAdapter,
    os: {
      homedir,
      platform,
      release,
      arch,
      hostname,
      nodeVersion: () => process.version,
    },
    env: { ...process.env },
    clock: { now: () => new Date() },
    createHash,
    timers: {
      setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
      clearTimeout: (handle: any) => clearTimeout(handle),
    },
    nativeCollectors: {
      collectOpenClawVersion,
      collectListeningPort,
      collectNativeDoctor,
      collectNativeConfigValidation,
      collectNativeStatus,
      collectNativeSecurityAudit,
    },
  })

  const session = createSessionController({
    runDiagnostics: async (args: any) => {
      const result = await diagnosticsCore.runDiagnostics(args)
      if (result.error) return result
      return { ...result, summary: plainSummary(result.summary) }
    },
    repairEngine: createRepairEngine({ catalog: repairCatalog }),
    normalizeFindings,
    knownRepairIds: Object.values(repairCatalog).map((entry: any) => entry.id),
    makeRevisionId: randomUUID,
    onEvent: () => {},
  })

  const bridge = createSessionBridge({
    session: session as any,
    offlineAnalyzer: createOfflineAnalyzer({ session }) as any,
    remoteAnalyzer: createRemoteAnalyzer({ session }) as any,
    preferRemote: true,
    remoteBaseUrl: process.env.CLAWFIX_API_URL || "https://clawfix.dev",
  })

  if (options.autoScan !== false) {
    void bridge.scan()
  }
  return bridge
}
