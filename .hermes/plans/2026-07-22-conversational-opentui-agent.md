# ClawFix Conversational OpenTUI Agent Implementation Plan

> **Status:** implementation-ready plan, no production code changed
> **Date:** 2026-07-22
> **Repository:** `/root/clawfix`
> **Primary product decision:** after installation, running `clawfix` in an interactive terminal opens a full-screen conversational repair agent. No browser is involved.

## 1. Goal

Turn ClawFix from a 2,040-line mixed CLI into a safe conversational OpenClaw repair assistant for people who do not know how to debug services, configuration, logs, or terminals.

The default experience is:

```text
$ clawfix

┌────────────────────────────────────────────────────────────┐
│ 🦞 ClawFix                                                 │
│                                                            │
│ Tell me what is going wrong with your OpenClaw.            │
│                                                            │
│ > My Telegram bot stopped replying                         │
└────────────────────────────────────────────────────────────┘
```

ClawFix scans locally, discusses the problem in plain language, proposes only reviewed deterministic repairs, obtains explicit approval, applies the selected repair transactionally, and verifies the result.

## 2. Non-negotiable product rules

1. `clawfix` is the friendly conversational product.
2. The user should not need to learn issue IDs or command syntax.
3. The agent may explain and select repairs, but it may never author or execute arbitrary shell.
4. Executable actions must come from ClawFix's reviewed local repair catalog.
5. Diagnostics run locally before any consent dialog. Uploads never happen implicitly.
6. The first outbound AI action discloses the user message, diagnostic fields, recipient, and provider.
7. Every repair has a preview, approval, backup policy, verification, and rollback policy.
8. AI-only findings are advisory until a deterministic detector and reviewed repair map them to a catalog ID.
9. `--dry-run`, `--no-send`, and `--json` remain local-only.
10. The Node 18+ plain CLI remains available for automation and unsupported terminals.
11. `--help` and `--version` remain side-effect free.
12. A renderer crash must restore the terminal.

## 3. Research basis

### ClawFix repository audit

Audited current `main` at the start of planning:

- 70 tracked files.
- `cli/bin/clawfix.js` is 2,040 lines.
- 49 deterministic known-issue definitions.
- 63 Node tests passing.
- 7 remediation contract scenarios exist in the release gates.
- Root package is the private hosted service; `cli/package.json` is the public `clawfix` npm package.
- Public CLI currently has no runtime dependencies and supports Node 18+.
- Current default interaction uses `readline`, manual ANSI clearing, ad hoc paste buffering, and direct console output.
- Diagnostics, rendering, HTTP calls, repair definitions, mutation, restart, verification, argument parsing, and process exit all live in the same entry file.
- Current AI chat is advisory text over `/api/chat`; it cannot produce a validated repair proposal.
- Current server-generated repair scripts include only deterministic known-issue snippets, but the TUI must not execute server-returned shell.
- Current issue merge logic uses rough title text matching. That is not strong enough to authorize repairs.
- Current built-in repair entries have useful `risk`, `needsConfig`, `needsRestart`, and `informational` metadata, but lack explicit preconditions, scoped effects, structured previews, verifiers, and rollback handlers.
- Only 16 local built-in repairs exist for the 49 issue definitions. Repairs currently have three diverging representations: server shell snippets, local JavaScript functions, and generated combined shell scripts.
- `cli/index.js` is a stale 517-line implementation and is not the published entrypoint. Deprecate and delete it after proving no package or documented path uses it.
- The collector discovers both `~/.openclaw` and `~/.config/openclaw`, but repairs hardcode `~/.openclaw/openclaw.json`. The repair plan must use the config path discovered by the current scan.
- Current backups do not cover workspace files created by repairs, and atomic config replacement does not explicitly preserve permissions/ownership.
- A consented rescan rotates `diagnosticId` while retaining `conversationId`, which the current chat route rejects as a diagnostic mismatch.
- In deployments without PostgreSQL, diagnose and chat use different in-memory stores, so chat may not receive the promised diagnostic context.
- Current server validation is size-bounded but not a strict versioned field allowlist. Extra diagnostic properties can reach AI after redaction.
- Fix IDs act as bearer capabilities without explicit expiry, revocation, or ownership binding. Persisted diagnosis retention/deletion is also undefined.
- Existing security policy requires explicit upload consent, local-only dry runs, advisory AI, deterministic repairs, and no automatic destructive actions.
- Existing regression tests deliberately reject public `curl | sh` guidance. Preserve that rule.

### OpenTUI documentation audit

Reviewed the complete official OpenTUI documentation tree from `anomalyco/opentui` commit `34e78b2fbf18fd969efdf5f3e2589d17d1f536f1`:

- 46 MDX documentation pages.
- 10,269 documentation lines.
- Core renderer, lifecycle, layout, colors, keyboard, console, testing, scrollback, and environment behavior.
- Box, text, input, textarea, scrollbox, markdown, diff, select, tab-select, scrollbar, and code components.
- Solid and React bindings.
- Keymap core, hosts, addons, Solid bindings, and custom addon extension points.
- Standalone executable packaging and Linux libc behavior.

Relevant conclusions:

- OpenTUI is a Zig native renderer with TypeScript bindings.
- OpenTUI is pre-1.0 (`0.4.5`). Pin OpenTUI, Solid, native packages, and the exact `solid-js` peer version; verify metadata compatibility in CI before upgrades.
- Current native rendering under Node requires Node 26.4.0 plus experimental FFI permissions. That is incompatible with ClawFix's Node 18+ npm promise.
- Bun is the practical development and build runtime for this UI.
- `Bun.build({ compile: ... })` can produce standalone platform executables.
- Native target packages must be installed for every release OS/CPU target before cross-compilation.
- Linux glibc versus musl must be fixed at build time with `process.env.OPENTUI_LIBC` to avoid ambiguous packages.
- Solid provides `testRender()` for deterministic terminal rendering tests.
- `ScrollBox` supports sticky-bottom chat behavior and viewport culling.
- `Markdown` supports streaming updates and a stable block prefix.
- `Diff` supports unified and split views.
- `Textarea` provides cursor, selection, multiline editing, and submission hooks.
- Paste events expose raw bytes. Decode, normalize, control-character sanitize, and size-limit them; pasted text must never auto-submit.
- OpenTUI documents no accessibility tree, roles, live regions, screen-reader protocol, or contrast enforcement. The plain interface is therefore a permanent accessibility and compatibility path, not a temporary fallback.
- Tree-sitter assets must be bundled and version-pinned if syntax highlighting is enabled. Never download parser/query URLs from model or user content at runtime.
- `OTUI_STDIN_LOG` records exact raw input and can capture secrets. Release builds and support bundles must keep it disabled unless the user explicitly opts into a bounded diagnostic capture.
- Cleanup is explicit: every shutdown path must call `renderer.destroy()`.
- OpenTUI restores raw mode, cursor, alternate screen, timers, renderables, signal listeners, and native resources only when cleanup is performed correctly.

Official sources:

- <https://opentui.com/docs/getting-started/>
- <https://opentui.com/docs/bindings/solid>
- <https://opentui.com/docs/core-concepts/renderer>
- <https://opentui.com/docs/core-concepts/lifecycle>
- <https://opentui.com/docs/core-concepts/testing>
- <https://opentui.com/docs/reference/standalone-executables>

### OpenCode source audit

Inspected the current OpenCode TUI source from `anomalyco/opencode` commit `411eff73f026d4950c07947c4d983788cb615baa` and TUI package version `1.18.4`.

Patterns worth adopting:

- Keep the TUI in its own private package.
- Treat the TUI as a client of a typed service/session layer rather than placing business logic in components.
- Use Solid contexts for runtime services, session state, theme, dialogs, permissions, and exit handling.
- Centralize keybindings and modal modes with `@opentui/keymap`.
- Render permission requests as first-class cards/dialogs.
- Use a transcript event model for streaming assistant and tool updates.
- Use `ErrorBoundary`, explicit renderer cleanup, and terminal-specific handling.
- Test rendering, prompt submission races, lifecycle, keymaps, dialogs, event synchronization, and snapshots.

Patterns not to copy:

- OpenCode's broad arbitrary shell/edit permission system. ClawFix must expose only narrow reviewed repair tools.
- OpenCode's plugin and workspace complexity. It is unnecessary for the first ClawFix release.
- OpenCode's large provider/model/session navigation surface. ClawFix should hide provider plumbing by default.
- A 60 FPS target. ClawFix is text-first; 30 FPS is sufficient and cheaper.

## 4. Architecture decision

Use **Core + Adapters + Interfaces** while keeping all publishable client code under `cli/` so npm packaging does not import files outside the package boundary.

```text
cli/
├── bin/
│   └── clawfix.js                 # thin entrypoint and mode dispatch
├── core/
│   ├── contracts.js               # runtime validators and domain shapes
│   ├── diagnostics.js             # scan orchestration, no console output
│   ├── events.js                  # session event constructors/types
│   ├── findings.js                # stable ID merge and prioritization
│   ├── repair-catalog.js          # reviewed repair definitions
│   ├── repair-engine.js           # transactional execution
│   ├── session.js                 # conversational session state machine
│   └── privacy.js                 # outbound projection and disclosure
├── adapters/
│   ├── filesystem.js              # file reads, atomic writes, metadata
│   ├── openclaw.js                # argv-based OpenClaw subprocess adapter
│   ├── process.js                 # spawn without shell interpolation
│   ├── remote-analyzer.js         # ClawFix API v2 event stream
│   ├── offline-analyzer.js        # deterministic conversational fallback
│   └── local-analyzers/           # later provider-specific CLI adapters
├── interfaces/
│   └── plain.js                   # preserved Node 18+ interface
├── tui/
│   ├── package.json               # private Bun/OpenTUI package
│   ├── bun.lock
│   ├── bunfig.toml
│   ├── tsconfig.json
│   ├── scripts/build.ts
│   ├── src/
│   │   ├── main.tsx
│   │   ├── app.tsx
│   │   ├── theme.ts
│   │   ├── keymap.tsx
│   │   ├── context/session.tsx
│   │   ├── context/dialog.tsx
│   │   ├── components/transcript.tsx
│   │   ├── components/composer.tsx
│   │   ├── components/status.tsx
│   │   ├── components/activity-card.tsx
│   │   ├── components/finding-card.tsx
│   │   ├── components/repair-card.tsx
│   │   ├── components/approval-dialog.tsx
│   │   ├── components/privacy-dialog.tsx
│   │   ├── components/diff-dialog.tsx
│   │   └── components/error-boundary.tsx
│   └── test/
│       ├── fixtures/
│       ├── app.test.tsx
│       ├── composer.test.tsx
│       ├── approval.test.tsx
│       ├── privacy.test.tsx
│       ├── responsive.test.tsx
│       └── lifecycle.test.tsx
└── package.json
```

Server additions:

```text
src/
├── agent/
│   ├── contract.js                # strict assistant/tool event schemas
│   ├── prompt.js                  # untrusted-data boundaries
│   └── stream.js                  # provider stream to safe ClawFix events
└── routes/
    └── agent-v2.js                # versioned conversational API
```

Release additions:

```text
scripts/
├── build-tui-release.mjs
├── verify-tui-artifact.mjs
├── smoke-tui-binary.mjs
└── generate-release-manifest.mjs
.github/workflows/
└── release-tui.yml
```

Do not move `cli/` to a new package location in the same change. The current trusted publishing and package allowlist are valuable. Restructure internally first.

Keep OpenTUI imports and types entirely inside `cli/tui/`. The core consumes and emits plain validated domain events so a pre-1.0 renderer upgrade cannot infect diagnostic or repair contracts.

Diagnostics must be asynchronous and cancellable. Every scan gets an immutable revision ID, per-collector deadlines, an aggregate deadline, and an `AbortSignal`. Late results from an older revision are discarded instead of overwriting current state. If a collector cannot be made non-blocking, run it behind an isolated worker/process adapter so rendering and cancellation remain responsive.

Use one canonical session protocol for embedded-local and remote operation. The first implementation may call the local core directly, but the event shapes and controller API must be transport-neutral so a worker can be introduced without rewriting the TUI.

## 5. Domain contracts

### Finding

Every finding must have stable identity and provenance. Never authorize a repair from fuzzy title matching.

```ts
type Finding = {
  id: string
  source: "clawfix" | "openclaw-doctor" | "openclaw-config" | "openclaw-security" | "ai"
  severity: "critical" | "high" | "medium" | "low" | "info"
  kind: "failure" | "warning" | "optimization" | "unknown"
  title: string
  summary: string
  evidence: Evidence[]
  repairId?: string
  repairable: boolean
}
```

Rules:

- A local detector can attach `repairId` only through an explicit reviewed mapping.
- Native OpenClaw findings can attach `repairId` only through an exact `checkId` mapping.
- AI findings always start with `repairable: false`.
- Server data cannot add or replace `repairId`.
- Merge by stable IDs and provenance, not the current 20-character title heuristic.

### Repair definition

```ts
type RepairDefinition = {
  id: string
  title: string
  explanation: string
  risk: "none" | "low" | "medium" | "high"
  platforms: Array<"darwin" | "linux" | "win32">
  effects: Array<"read-config" | "write-config" | "restart-gateway" | "create-file" | "service-change">
  preflight(ctx): Promise<PreflightResult>
  preview(ctx): Promise<RepairPreview>
  apply(ctx): Promise<ApplyResult>
  verify(ctx): Promise<VerificationResult>
  rollback(ctx, receipt): Promise<RollbackResult>
}
```

A repair definition contains code maintained in the repository. The model sees only IDs and descriptions.

### Repair plan

```ts
type RepairPlan = {
  planId: string
  scanFingerprint: string
  repairIds: string[]
  risk: "none" | "low" | "medium" | "high"
  summary: string
  effects: RepairEffect[]
  preview: ConfigDiff | ActionPreview
  backupRequired: boolean
  restartRequired: boolean
  createdAt: string
}
```

The plan becomes invalid after a rescan or relevant filesystem change. Approval applies to one immutable `planId`, not a free-form request.

### Session events

The core emits UI-neutral events:

```ts
type SessionEvent =
  | { type: "scan.started" }
  | { type: "scan.step"; label: string }
  | { type: "scan.completed"; summary: HealthSummary; findings: Finding[] }
  | { type: "message.user"; id: string; text: string }
  | { type: "assistant.started"; id: string }
  | { type: "assistant.delta"; id: string; text: string }
  | { type: "assistant.completed"; id: string }
  | { type: "repair.proposed"; plan: RepairPlan; rationale: string }
  | { type: "repair.approval-required"; plan: RepairPlan }
  | { type: "repair.step"; step: RepairStep }
  | { type: "repair.completed"; result: RepairResult }
  | { type: "repair.failed"; error: SafeError; rollback?: RollbackResult }
  | { type: "privacy.approval-required"; disclosure: Disclosure }
  | { type: "warning"; message: string }
  | { type: "error"; error: SafeError }
```

The plain CLI and TUI consume the same events. No core module writes directly to stdout.

## 6. Conversational agent boundary

### What the model may do

- Explain findings.
- Ask clarifying questions.
- Recommend one or more existing repair IDs.
- Explain risk and expected outcome.
- Suggest a rescan.
- Say that no reviewed repair exists.

### What the model may not do

- Return shell for execution.
- Name arbitrary executables.
- Select filesystem paths.
- Provide config patches for automatic application.
- Invent repair IDs.
- Override risk, preconditions, effects, approval, or verification.
- Treat log/config text as instructions.

### API v2 tool protocol

Add a versioned endpoint instead of mutating `/api/chat` in place:

```http
POST /api/v2/agent/messages
Content-Type: application/json
Accept: text/event-stream
```

Request:

```json
{
  "conversationId": "uuid",
  "message": "My Telegram bot stopped replying",
  "diagnosticId": "optional",
  "availableRepairs": [
    {
      "id": "gateway-not-running",
      "title": "Restart the OpenClaw gateway",
      "risk": "low"
    }
  ]
}
```

The server dynamically gives the model one constrained tool:

```json
{
  "name": "propose_repair",
  "parameters": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "repairId": {
        "type": "string",
        "enum": ["gateway-not-running"]
      },
      "rationale": { "type": "string", "maxLength": 1000 }
    },
    "required": ["repairId", "rationale"]
  }
}
```

The server does not execute the tool. It validates and emits:

```text
event: assistant.delta
data: {"text":"I found..."}

event: repair.proposed
data: {"repairId":"gateway-not-running","rationale":"..."}
```

The client validates the ID again against its local catalog and current findings, creates the immutable local plan, and asks for approval.

If the provider does not support streamed tool calls, the endpoint remains advisory. Do not parse repair intent from prose.

The v2 server contract must also repair the current session/persistence boundary:

- Accept only a versioned, strict diagnostic schema and project an explicit allowlist before redaction, storage, or AI.
- Use one diagnosis/session repository shared by diagnose and chat, with matching in-memory and PostgreSQL implementations.
- Return an opaque, high-entropy, expiring session capability and require it for chat, diagnostic updates, result retrieval, and deletion.
- Bind conversation ID, diagnostic revision, and session capability. A rescan updates the session revision or starts a new session intentionally; it must not trigger the current `409` mismatch accidentally.
- Define retention, expiry, revocation, and deletion semantics. Do not describe records as temporary without enforcing deletion.
- Clear stale server findings when a new revision is accepted.
- Do not rerun paid AI diagnosis merely to refresh deterministic local state after a rescan or repair. Update evidence separately and invoke AI only for an explicit analysis/chat request.
- Inject AI configuration and repositories at server startup rather than freezing them at module import time.
- Keep v1 endpoints for a documented compatibility window, but never allow v1 server-returned shell to flow into the new repair engine.

### Analyzer interface

```ts
interface Analyzer {
  capabilities(): Promise<{
    chat: boolean
    repairProposals: boolean
    local: boolean
    providerLabel: string
  }>
  send(input: AnalyzerInput, signal: AbortSignal): AsyncIterable<AnalyzerEvent>
}
```

Initial adapters:

1. `OfflineAnalyzer`: deterministic explanations for scans and findings. Always available.
2. `RemoteAnalyzer`: current ClawFix/OpenRouter service through API v2.

Follow-up adapters, only after a conformance and sandbox audit:

3. Codex CLI.
4. Claude Code.
5. Kimi Code.
6. Grok CLI.

Local CLI adapters must run in advisory/no-tools mode where supported. If a provider cannot reliably disable filesystem, network, or shell tools, it must not be enabled as a ClawFix analyzer.

## 7. Repair transaction design

The repair engine owns the complete state machine:

```text
proposed
  → previewed
  → awaiting-approval
  → approved
  → preflight
  → backed-up
  → applied
  → config-validated
  → service-restarted
  → verified
  → succeeded
```

Failure paths:

```text
preflight failed           → no mutation
backup failed              → no mutation
apply failed               → rollback if mutation began
config validation failed   → automatic rollback
restart failed             → preserve backup, report exact state
verification failed        → offer rollback; auto-rollback only when repair policy marks it safe
rollback failed            → critical report with backup path and no invented success
```

Implementation requirements:

- Replace shell-string `execSync` calls with `spawn`/`spawnSync` argv arrays.
- Do not interpolate detected paths into shell commands.
- Resolve configuration and workspace paths from the current scan context. Never fall back silently to the hardcoded `~/.openclaw/openclaw.json` when another location was discovered.
- Track and back up every affected path, including workspace files created or changed by a repair, not only the main config.
- Preserve config permissions and ownership where supported.
- Write to a sibling temporary file, fsync, then atomically rename.
- Keep the backup until verification succeeds and retain it afterward for manual recovery.
- Run `openclaw config validate --json` after config mutation and before restart.
- Capture a receipt containing exact changes, backup path, process results, timestamps, and verification evidence.
- Redact receipts before display or export.
- Verify by stable detector/check IDs, not title fragments.
- Reject stale plans whose `scanFingerprint` no longer matches.
- Reject unknown, informational, incompatible-platform, or high-risk automatic repairs.
- Batch only low-risk repairs with compatible effects. Medium-risk repairs require separate approval.
- Plain-interface mutation prompts default to no (`[y/N]`). `--yes` continues to mean upload consent only and must never become blanket repair approval.
- Never make Enter alone approve a destructive/high-risk action. High risk remains manual guidance.

## 8. User experience specification

### Startup

1. Initialize renderer immediately.
2. Show `Starting ClawFix…` rather than a blank screen.
3. Run the local scan with semantic activity updates:
   - Finding OpenClaw
   - Checking configuration
   - Checking gateway
   - Reviewing recent errors
   - Running OpenClaw health checks
4. Focus the composer as soon as safe, even if optional slow checks continue.
5. Never block startup on AI availability.

### Main layout

At 100+ columns:

```text
┌ ClawFix ──────────────────────────────────────┬ System ─────────────┐
│ conversation                                  │ Gateway  Offline     │
│                                               │ Config   Valid       │
│                                               │ Issues   2           │
│                                               │ AI       Local only  │
├───────────────────────────────────────────────┴─────────────────────┤
│ Tell me what is wrong…                                              │
├─────────────────────────────────────────────────────────────────────┤
│ Enter send  Shift+Enter newline  Ctrl+C stop  ? help                │
└─────────────────────────────────────────────────────────────────────┘
```

At 60–99 columns, move status into a compact top row. Under 60 columns, show only essential transcript, composer, and one-line status.

### Transcript items

- User message.
- Assistant message rendered with streaming Markdown.
- Activity card with concise current operation.
- Finding card with severity text and evidence summary.
- Repair proposal card.
- Repair execution card with steps and final verification.
- Warning/error card with recovery action.

Do not rely on color alone. Always pair color with words or symbols.

### Composer behavior

- Enter submits.
- Shift+Enter inserts a newline when the terminal protocol supports it.
- Ctrl+J is the documented newline fallback.
- Ctrl+C once cancels the active AI/scan operation; twice exits when idle.
- Escape closes dialogs or returns focus to the composer.
- Pasted multiline content remains one message. Use OpenTUI paste events, not an 80 ms timing heuristic.
- Input remains editable during background scans unless a modal approval is active.
- While an assistant response is active, a new submission cancels or queues explicitly. Never silently drop input.

### Privacy approval

Before the first remote AI request:

```text
ClawFix can send this message and a redacted diagnostic to:
ClawFix service → OpenRouter → selected model

Included:
• Your message
• OS and OpenClaw versions
• Redacted configuration fields
• Matching error lines

Not included:
• Workspace document contents
• Top-level config env block
• Chat history outside this ClawFix session
• Real hostname

[ Continue ]  [ Inspect exact payload ]  [ Stay local ]
```

- Default focus is `Stay local` or neutral, not `Continue`.
- Approval is scoped to the current session unless the user explicitly asks to remember it.
- `Inspect exact payload` opens a scrollable redacted JSON view.
- A custom `--server` displays the exact destination hostname.

### Repair approval

```text
I can restart the OpenClaw gateway.

Why: the gateway service is installed but not responding.
Changes: no configuration files will be changed.
Interruption: OpenClaw will be unavailable for about 10 seconds.
Verification: ClawFix will check gateway reachability afterward.

[ Fix it ]  [ Technical details ]  [ Cancel ]
```

A config repair also shows a structured diff and backup path policy.

### Completion

Success requires verification evidence:

```text
✓ Gateway restarted
✓ Gateway is reachable
✓ Telegram connection recovered

Your bot should be working again.
```

If verification is incomplete, say `repair applied, outcome not verified`, not `fixed`.

### Accessibility and terminal compatibility

- Full keyboard operation is mandatory; mouse is optional.
- Show visible focus and pair every color with text or a symbol.
- Provide high-contrast/no-color and reduced-motion modes.
- Keep ASCII art decorative and never the only carrier of status.
- Strip unsafe terminal control characters from model output, pasted text, links, terminal titles, notifications, and subprocess output before rendering or passthrough.
- Clipboard writes and terminal notifications require explicit user action or setting. OSC output success is not proof that the host clipboard changed.
- Document `--plain` as the screen-reader and incompatible-terminal path. Do not claim the OpenTUI interface is screen-reader accessible until tested on named terminal/assistive-technology combinations.
- Support an animation-off setting and mutation-driven rendering; continuous rendering is unnecessary outside bounded spinners.
- Document `reset` as emergency terminal recovery after an uncatchable force-kill.

## 9. Runtime and command behavior

Mode selection in the thin entrypoint:

```text
--help / --version              side-effect-free text
--json                          local machine-readable scan
--scan / --no-interactive       one-shot plain interface
--plain                         force plain interface
--tui                           force rich TUI; error clearly without TTY/support
no flags + rich binary + TTY    rich TUI
no flags + Node fallback + TTY  current plain conversational interface
no TTY                          local one-shot/plain behavior; never hang awaiting input
```

The standalone executable is the primary rich product. Bun is a build dependency, not an end-user prerequisite.

Renderer defaults:

```ts
createCliRenderer({
  screenMode: "alternate-screen",
  targetFps: 30,
  exitOnCtrlC: false,
  useMouse: true,
  openConsoleOnError: false
})
```

Wrap startup and shutdown in `try/finally`; call `renderer.destroy()` on normal exit, signal, rejected promise, and top-level error. Add an epilogue only after the terminal is restored.

## 10. Distribution decision

### Primary

Publish standalone release artifacts:

- macOS arm64.
- macOS x64.
- Linux x64 glibc.
- Linux arm64 glibc.
- Windows x64 after a verified Windows smoke test.
- WSL uses the Linux build.

Musl/Alpine is a separate target because OpenTUI requires explicit libc selection and Alpine may require `libstdc++`/`libgcc`.

Each release must include:

- SHA-256 manifest.
- GitHub artifact attestations/provenance.
- Exact source commit.
- Build target and libc metadata.
- Automated smoke-test result.

Do not call binaries "signed" until actual platform code-signing certificates and notarization are in place.

### Install experience

Preserve the repository's no-remote-shell-pipe policy.

Offer:

1. OS download buttons with checksums/provenance.
2. A reviewable installer download, not public `curl | sh` copy.
3. Homebrew/Winget/Scoop only after the release lane is stable.
4. Existing npm package as the Node 18+ plain fallback.

Do not make the npm package silently download and execute a native binary. If npm later installs platform packages, use explicit optional dependencies with verified ownership and a documented package map.

### npm compatibility

Keep `cli/package.json` lightweight. The rich OpenTUI package remains private and is compiled during release. Update the npm file allowlist only for the extracted core/plain interface files it actually needs.

## 11. Implementation sequence

Every task starts with a failing test and ends with focused verification. Do not combine extraction, behavior changes, TUI, API protocol, and release machinery in one giant PR.

### Task 1: Freeze current CLI contracts

**Files**

- Modify: `test/cli-options.test.js`
- Create: `test/cli-mode-contracts.test.js`
- Create: `test/fixtures/cli/`

**Steps**

1. Add tests for `--help`, `--version`, `--json`, `--scan`, `--dry-run`, `--no-send`, custom server validation, and no-TTY behavior.
2. Capture semantic behavior, not ANSI byte-for-byte output.
3. Add a fake HOME and fake `openclaw` executable so tests cannot inspect or mutate the developer machine.
4. Assert no outbound request in local modes.
5. Assert no prompt waits in non-TTY mode.
6. Lock unknown/conflicting flag behavior and JSON stdout purity on both success and failure.
7. Add startup consent, decline, upload failure, rescan, chat, and clean-exit fixtures.
8. Run `node --test test/cli-mode-contracts.test.js test/cli-options.test.js`.

### Task 2: Extract argument parsing and mode dispatch

**Files**

- Create: `cli/core/contracts.js`
- Create: `cli/core/options.js`
- Modify: `cli/bin/clawfix.js`
- Test: `test/cli-mode-contracts.test.js`

**Steps**

1. Write tests for a pure `parseOptions(argv, env, io)` function.
2. Implement explicit mode resolution and stable option errors.
3. Keep help/version before scan or renderer startup.
4. Keep aliases and environment overrides compatible.
5. Mark stale `cli/index.js` deprecated, prove no package/documented path uses it, then delete it in a separate reviewed change.
6. Verify the current npm command surface.

### Task 3: Replace shell-string collection with adapters

**Files**

- Create: `cli/adapters/process.js`
- Create: `cli/adapters/openclaw.js`
- Modify: `cli/bin/native-diagnostics.js`
- Modify: `cli/bin/clawfix.js`
- Create: `test/process-adapter.test.js`
- Extend: `test/runtime-regressions.test.js`

**Steps**

1. Test argv construction for paths containing spaces, quotes, semicolons, and newlines.
2. Implement bounded `spawn`/`spawnSync` calls with no shell.
3. Move `which`, gateway status, process, service-manager, and log-tail operations behind adapters.
4. Replace shell `tail` with bounded filesystem reads.
5. Preserve redaction and timeout behavior.
6. Verify malformed/partial JSON still fails closed.

### Task 4: Extract the diagnostic core

**Files**

- Create: `cli/core/diagnostics.js`
- Create: `cli/core/events.js`
- Modify: `cli/bin/clawfix.js`
- Create: `test/diagnostic-core.test.js`

**Steps**

1. Test diagnostics with injected filesystem, process, OpenClaw, clock, OS, and hostname adapters.
2. Move `collectDiagnostics()` without console calls.
3. Emit semantic scan events through a callback/async iterator.
4. Add `AbortSignal`, per-collector deadlines, an aggregate scan deadline, and immutable revision IDs.
5. Discard late results from stale revisions.
6. Preserve the current redacted diagnostic envelope and local issue IDs during the compatibility phase.
7. Keep output rendering in the plain interface.
8. Run old and new diagnostic tests.

### Task 5: Normalize findings by stable identity

**Files**

- Create: `cli/core/findings.js`
- Modify: `cli/bin/security.js`
- Modify: `cli/bin/clawfix.js`
- Create: `test/finding-normalization.test.js`

**Steps**

1. Add tests proving fuzzy titles cannot acquire repairs.
2. Normalize local, OpenClaw native, server, and AI findings into one contract.
3. Map native check IDs and known issue IDs explicitly.
4. Remove title-fragment deduplication from authorization decisions.
5. Preserve display deduplication separately if useful.

### Task 6: Convert built-in fixes into a repair catalog

**Files**

- Create: `cli/core/repair-catalog.js`
- Create: `cli/core/repair-engine.js`
- Create: `cli/adapters/filesystem.js`
- Modify: `cli/bin/clawfix.js`
- Create: `test/repair-catalog.test.js`
- Create: `test/repair-engine.test.js`

**Steps**

1. Add contract tests requiring metadata, preflight, preview, apply, verify, and rollback for every automatic repair.
2. Port one low-risk repair first, preferably `gateway-not-running` because it does not mutate config.
3. Add immutable plan IDs and scan fingerprints.
4. Add one-time approval and stale-plan rejection.
5. Add config transaction helpers and automatic rollback after validation failure.
6. Port remaining repairable entries one by one with tests.
7. Test alternate discovered config locations, permission/ownership preservation, and every affected workspace path.
8. Test partial batch failure and require default-no confirmation.
9. Leave informational/high-risk cases non-executable.
10. Remove direct repair application from UI code only after parity is proven.

### Task 7: Build the session controller and offline assistant

**Files**

- Create: `cli/core/session.js`
- Create: `cli/adapters/offline-analyzer.js`
- Create: `test/session-state-machine.test.js`

**Steps**

1. Test startup scan, user message, explanation, proposal, cancellation, approval, execution, verification, and failure states.
2. Implement a single-writer event stream to avoid prompt/scan races.
3. Ensure submitted input is queued or explicitly cancels; never silently drop it.
4. Implement deterministic local responses for common actions and findings.
5. Ensure the product remains useful when AI is unavailable.

### Task 8: Add the safe server agent protocol

**Files**

- Create: `src/agent/contract.js`
- Create: `src/agent/prompt.js`
- Create: `src/agent/stream.js`
- Create: `src/routes/agent-v2.js`
- Modify: `src/server.js`
- Modify: `src/ai.js`
- Create: `test/agent-v2-security.test.js`
- Create: `test/agent-v2-stream.test.js`

**Steps**

1. Write strict request/event schema tests and practical size limits.
2. Add prompt-injection fixtures in logs/config/user text.
3. Add streamed text and constrained `propose_repair` tool parsing.
4. Validate repair IDs against the request enum.
5. Emit no executable shell or arbitrary patch fields.
6. Preserve authentication, spend, rate, and concurrency guards.
7. Add a strict versioned diagnostic projection and reject unknown fields.
8. Add shared in-memory/PostgreSQL session repositories with identical behavior.
9. Add expiring capability, ownership, retention, deletion, diagnostic-revision, and rescan integration tests.
10. Prove diagnose-to-chat context works without PostgreSQL and after a rescan.
11. Keep `/api/chat` unchanged until the new client is shipped.
12. Add disconnect and cancellation cleanup.

### Task 9: Implement the remote analyzer

**Files**

- Create: `cli/adapters/remote-analyzer.js`
- Extend: `cli/core/privacy.js`
- Create: `test/remote-analyzer.test.js`

**Steps**

1. Test fragmented SSE frames, malformed events, duplicate completion, timeouts, disconnects, and aborts.
2. Validate every inbound event.
3. Revalidate every proposed repair against local current state.
4. Project and redact outbound data at the final network boundary.
5. Include exact destination/provider disclosure.
6. Never downgrade to implicit upload after an error.

### Task 10: Scaffold the OpenTUI package

**Files**

- Create: `cli/tui/package.json`
- Create: `cli/tui/bunfig.toml`
- Create: `cli/tui/tsconfig.json`
- Create: `cli/tui/src/main.tsx`
- Create: `cli/tui/src/app.tsx`
- Create: `cli/tui/src/theme.ts`
- Create: `cli/tui/test/app.test.tsx`

**Steps**

1. Add exact pinned OpenTUI, keymap, Solid, native-package, and `solid-js` peer versions.
2. Configure `@opentui/solid/preload` and JSX import source.
3. Render a minimal app using an injected fake session.
4. Add explicit renderer lifecycle and top-level error handling.
5. Keep OpenTUI types behind the TUI package boundary and add a metadata/version compatibility check.
6. Bundle version-pinned Tree-sitter assets or disable syntax highlighting until bundled; never fetch parsers at runtime.
7. Add `testRender()` smoke tests at 40×12, 80×24, and 120×40.
8. Verify cleanup after normal exit, startup failure, thrown error, rejected promise, and signal.
9. Run this bounded build/test in Blaxel Tier 2 or CI, not as a heavy local control-plane build.

### Task 11: Implement transcript and composer

**Files**

- Create: `cli/tui/src/context/session.tsx`
- Create: `cli/tui/src/components/transcript.tsx`
- Create: `cli/tui/src/components/composer.tsx`
- Create: `cli/tui/src/components/activity-card.tsx`
- Create: `cli/tui/src/components/finding-card.tsx`
- Create: `cli/tui/src/keymap.tsx`
- Create: `cli/tui/test/composer.test.tsx`
- Create: `cli/tui/test/responsive.test.tsx`

**Steps**

1. Render the fake session event stream.
2. Use sticky-bottom scroll and pause stickiness when the user scrolls up.
3. Stream Markdown without rerendering the entire transcript.
4. Use native paste events with byte decoding, line-ending normalization, control-character stripping, size limits, and no automatic submission.
5. Implement submit/newline/cancel/help keybindings.
6. Test queued/cancelled submissions and no silent input loss.
7. Add explicit focus traversal and modal focus restoration.
8. Test narrow and wide layouts.

### Task 12: Implement privacy and repair interactions

**Files**

- Create: `cli/tui/src/components/privacy-dialog.tsx`
- Create: `cli/tui/src/components/repair-card.tsx`
- Create: `cli/tui/src/components/approval-dialog.tsx`
- Create: `cli/tui/src/components/diff-dialog.tsx`
- Create: `cli/tui/test/privacy.test.tsx`
- Create: `cli/tui/test/approval.test.tsx`

**Steps**

1. Test that remote chat cannot start before explicit consent.
2. Test exact payload inspection and custom server disclosure.
3. Render immutable repair plans, effects, risks, and verification goals.
4. Use OpenTUI `Diff` for config previews.
5. Test cancel, approve, stale plan, failed verification, and rollback paths.
6. Ensure default focus never makes a risky action accidental.

### Task 13: Rebuild the plain interface on the same core

**Files**

- Create: `cli/interfaces/plain.js`
- Modify: `cli/bin/clawfix.js`
- Remove migrated rendering/business logic from: `cli/bin/clawfix.js`
- Extend: `test/cli-mode-contracts.test.js`

**Steps**

1. Render session events as plain text.
2. Preserve existing one-shot JSON and local-only behavior.
3. Keep Node 18-compatible syntax and dependencies.
4. Verify `npm pack ./cli --dry-run --json` against the updated allowlist.
5. Confirm the entry file is thin and contains no detector or repair implementation.

### Task 14: Build standalone artifacts

**Files**

- Create: `cli/tui/scripts/build.ts`
- Create: `scripts/build-tui-release.mjs`
- Create: `scripts/verify-tui-artifact.mjs`
- Create: `scripts/smoke-tui-binary.mjs`
- Create: `.github/workflows/release-tui.yml`

**Steps**

1. Install all required OpenTUI native target packages in the release job.
2. Compile one target per matrix job with explicit libc.
3. Start with Linux x64 and prove the artifact contains the correct native renderer.
4. Run the binary in a PTY with a fake HOME/OpenClaw fixture.
5. Assert startup, message input, cancellation, clean exit, and restored terminal.
6. Add a Linux x64 baseline/non-AVX2 artifact if Bun's target is verified, so older OpenClaw hosts are not excluded silently.
7. Expand to macOS arm64/x64, Linux arm64, then Windows x64.
8. Generate checksums and artifact attestations.
9. Fail publication if any expected artifact, checksum, or smoke result is missing.

### Task 15: Installer and public documentation

**Files**

- Create: `src/routes/install.js`
- Modify: `src/server.js`
- Modify: `src/landing.js`
- Modify: `README.md`
- Modify: `SECURITY.md`
- Modify: `CONTRIBUTING.md`
- Extend: `test/tooling-regressions.test.js`

**Steps**

1. Document the standalone and npm/plain paths accurately.
2. Offer an inspectable installer download and checksum verification.
3. Keep public docs free of `curl | sh` examples.
4. Disclose that chat messages and redacted diagnostic fields are sent after consent.
5. Document offline behavior and provider availability without claiming AI is always enabled.
6. Document unsupported terminals and `--plain` fallback.
7. Add exact release artifact/version checks to public truthfulness tests.

### Task 16: Local analyzer adapters, separately

**Files**

- Create: `cli/adapters/local-analyzers/contract.js`
- Create: `cli/adapters/local-analyzers/codex.js`
- Later: `claude.js`, `kimi.js`, `grok.js`
- Create: `test/local-analyzer-conformance.test.js`

**Steps**

1. Research each CLI's current noninteractive, streaming, structured-output, and tool-disable flags from official docs.
2. Build one fixture-driven conformance suite.
3. Implement Codex first with no shell/filesystem authority.
4. Prove abort, timeout, malformed output, missing binary, unauthenticated state, and secret redaction.
5. Add other providers one at a time.
6. Hide provider setup from the default UI; expose it under Settings/Help.

## 12. Test and verification matrix

### Core

- Pure unit tests with injected adapters.
- Detector and finding normalization fixtures.
- Repair contract completeness for every catalog entry.
- Atomic write, metadata preservation, validation failure, and rollback.
- Stale plan and double-approval rejection.
- Abort and timeout behavior.

### Security

- Prompt injection embedded in logs and config.
- Strict schema rejection for unknown diagnostic fields.
- Model returns unknown repair ID.
- Model returns path, shell, or patch fields.
- Server sends malformed or oversized events.
- Custom server and bearer-token redaction.
- Consent cannot be bypassed by retry, rescan, restored session, or environment accident.
- Diagnose-to-chat context works with the in-memory repository, PostgreSQL repository, and rotated diagnostic revisions.
- Session capabilities expire, cannot cross sessions, and support deletion/revocation.
- No shell interpolation from paths or diagnostic values.
- No claim of success without verifier evidence.
- `OTUI_STDIN_LOG` is absent from release environments and default support bundles.

### TUI

- 40×12, 80×24, and 120×40 render snapshots.
- Light/dark terminal palette.
- No-color/limited-color behavior.
- Keyboard-only navigation.
- Mouse as optional enhancement.
- Visible focus, high-contrast/no-color, and reduced-motion modes.
- Multiline paste.
- Oversized/control-character paste and model-output sanitization.
- Streaming Markdown.
- Long transcript scrolling.
- Resize during scan, chat, dialog, and repair.
- Ctrl+C cancel versus exit.
- Terminal cleanup after exception and signal.

### Platforms

- macOS arm64 and x64.
- Linux x64 and arm64 glibc.
- WSL through the Linux artifact.
- Windows x64 only after native PTY smoke coverage.
- SSH and tmux.
- `TERM=dumb` plain fallback.
- CI/no-TTY behavior.
- Packed-and-installed npm CLI execution, not only manifest dry-run inspection.

### Existing gates

Run after each behavior-changing slice:

```bash
npm test
npm run prove:remediation
npm run validate:repairs
npm audit --omit=dev
npm pack ./cli --dry-run --json
```

TUI package gates:

```bash
bun test --timeout 30000
bun run typecheck
bun run build
```

Heavy cross-platform builds and full PTY suites belong in bounded Blaxel Tier 2 or GitHub Actions, not the Cad control plane.

## 13. Release gates

A release is not ready until all are true:

- Typing `clawfix` opens the TUI in a supported interactive installation.
- The user can describe a problem without learning commands.
- Local scanning works with AI disabled.
- Remote AI requires explicit informed consent.
- The agent can propose only locally available deterministic repair IDs.
- A repair cannot execute without a current immutable plan and explicit approval.
- Config mutation is backed up, validated, and verifiable.
- Failed validation rolls back automatically.
- Unknown/AI-only issues never become executable.
- `--plain`, `--scan`, `--json`, `--dry-run`, and `--no-send` pass compatibility tests.
- `--help` and `--version` remain side-effect free.
- Renderer cleanup passes PTY tests.
- Every distributed artifact has checksum, provenance, and a platform smoke result.
- Public documentation matches actual behavior.

## 14. Rollout strategy

1. Ship core extraction with no visible behavior change.
2. Ship repair transactions behind the current plain interface.
3. Ship the API v2 protocol behind a feature flag.
4. Publish a `clawfix tui` preview binary for fixture-only testing.
5. Dogfood on disposable/fake OpenClaw homes.
6. Dogfood on a real non-production OpenClaw instance with bounded repair cases.
7. Make rich TUI the default only after repair and lifecycle gates pass.
8. Keep `--plain` permanently.
9. Add local analyzer adapters after the core product is stable.

## 15. Explicit deferrals

Do not add these to the first release:

- Browser dashboard.
- Plugin system.
- General-purpose shell agent.
- Autonomous destructive repair.
- Remote control of another host.
- Persistent cloud conversation history.
- Automatic executable downloads from npm install hooks.
- Automatic update daemon.
- Multiple themes beyond a strong default plus terminal light/dark adaptation.
- Voice, audio, or desktop notifications.

## 16. Suggested review boundaries

Keep reviewable changes small:

1. Core extraction and parity tests.
2. Repair transaction engine.
3. API v2 protocol.
4. OpenTUI shell with fake session.
5. End-to-end conversational flow.
6. Release artifacts and installer.
7. Local analyzer adapters.

Do not commit, push, or publish any checkpoint without explicit user authorization. Suggested checkpoints are review boundaries, not automatic Git actions.

## 17. Definition of the product

ClawFix is not a prettier diagnostic list. It is a constrained repair conversation:

```text
user describes problem
  → local evidence is collected
  → agent explains evidence
  → agent selects a reviewed repair ID
  → local core builds an immutable plan
  → user approves the exact plan
  → deterministic engine applies it
  → ClawFix verifies the result
  → success or honest recovery state
```

That is the implementation target.