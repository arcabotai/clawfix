# ClawFix TUI "opencode-grade" UI/UX Rework + Verification Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Rework the ClawFix TUI (`cli/tui`) from a flat text-dump into a chat-first, opencode-grade OpenTUI experience — then prove with a structured verification matrix that it looks and feels great on real terminals before tagging 0.12.0.

**Architecture:** The repo already has the bones: `cli/tui/src/app.tsx` (Solid/OpenTUI), proper components (`Transcript`, `Composer`, `FindingCard`, `ApprovalDialog`, `PrivacyDialog`, `DiffDialog`), `theme.ts`, `keymap.ts`, responsive layout resolver (`resolveLayout`), and component tests. Current `app.tsx` render flattens everything into one bordered column of `<text>` lines — the sidebar is appended inline, the composer is a text line, no scrollback, no splash. The 0.11.2 release binary felirami ran on the MacBook showed an even simpler REPL-style UI (report + `clawfix>` prompt), so step 0 is confirming which entry the binary actually ships (`standalone.ts` → `main.tsx` → which session/composer mode).

**Tech Stack:** Bun, OpenTUI (`@opentui/solid`, `@opentui/core`), SolidJS, tree-sitter assets (embedded for `bun --compile`).

**Reference UX (opencode 1.18.5, screenshots provided by felirami 2026-07-25):**
- Splash: ASCII logo + version, then chat takes over
- Left/main: scrollable conversation (user messages in boxed cards, assistant free-flow, tool/todo blocks)
- Right sidebar: session title, context/tokens/cost, LSP, todos — hidden on narrow terminals
- Bottom: boxed composer with model indicator + key hints + cwd
- Status line: tokens used, cost, `ctrl+p commands`

---

## Part A — Baseline diagnosis (before touching UI)

### Task A1: Confirm what the release binary actually runs
**Objective:** Know exactly why felirami saw the plain REPL instead of the OpenTUI app.
**Files:**
- Read: `cli/tui/src/main.tsx`, `cli/tui/src/standalone.ts`, `cli/bin/*` (the `clawfix` entry), `cli/tui/scripts/build.ts`
**Steps:**
1. Trace the `clawfix` command path: `cli/bin` → interactive mode → which session source + which app (full vs `simpleComposer`).
2. Run the current binary locally on cad: `clawfix` (no args) in a PTY, capture startup frame.
3. Document in the plan notes: which render path fires by default, and what triggers the full OpenTUI app vs the plain REPL.
**Verification:** written answer to "why did 0.11.2 look plain on macOS" — no guessing.

### Task A2: Inventory existing components vs what app.tsx renders
**Objective:** List reusable pieces that already exist but aren't wired into the render.
**Files:**
- Read: `cli/tui/src/components/*.tsx` (transcript, composer, finding-card, repair-card, activity-card, dialogs)
**Steps:**
1. Table: component → exported? → rendered by app.tsx? → tested?
2. Identify dead/incomplete code paths (e.g. sidebar exists as `sidebarLines()` but is not a pane).
**Verification:** inventory table in the plan notes.

---

## Part B — UI rework (target design)

All layout work happens in `cli/tui/src/`, theme in `theme.ts`, keys in `keymap.ts`.

### Task B1: Splash screen
- ASCII ClawFix mark + version + one-line model/AI-mode indicator + tip line (opencode style: "Tip …")
- Disappears into chat after first scan/message; `?` brings help, never the splash back
- Verify: frame snapshot at 120×35 and 80×24 shows centered logo, no wrap, no color bleed

### Task B2: Chat-first transcript (scrollable)
- Scan findings render as the first assistant "report" message (severity-colored finding cards), not a static dump
- User messages in bordered cards (right-aligned accent, opencode pattern), assistant free-flow markdown (tree-sitter md already embedded)
- Scrollback: PgUp/PgDn + mouse wheel; auto-stick to bottom on new content unless user scrolled up
- Verify: 50-message session scrolls cleanly; no orphan whitespace nodes (app.tsx already documents this OpenTUI constraint)

### Task B3: Boxed composer
- Bordered input box pinned bottom, placeholder "Tell me what is going wrong…", model/AI-mode line under it ("Remote · deepseek v4 flash" / "Local only")
- Slash-command hints inside the box footer: `fix <#> · fix-all · scan · help · exit`
- Composer locks (visibly) while privacy/approval dialogs are open (existing `composerLocked` state)
- Verify: typing, multiline paste, submit, locked state, narrow-terminal fallback hints

### Task B4: Real right sidebar
- Pane (not inline lines): System status (gateway/config/node/os), Findings count by severity, Scan state, AI mode, Session revision
- Hidden below width threshold (follow existing `resolveLayout` modes; opencode hides it too)
- Verify: resizes live across 140 → 100 → 70 cols; no overlap, no truncation of finding counts

### Task B5: Status/footer line
- cwd (or target host), revision, AI mode, `? help` hint — single muted line under composer
- Verify: present in all states, never wraps on ≥80 cols

### Task B6: Dialogs stay modal
- Privacy + approval + diff dialogs render centered above the chat (existing logic, just confirm they survive the new layout), dim background
- Verify: keyboard-only flow (tab/arrows/enter/esc) completes approve, cancel, and diff-inspect paths

### Task B7: Theme pass
- One accent (claw amber/red), muted grays, severity colors consistent with `theme.ts`; dark terminal first
- Verify: no hardcoded colors outside `theme.ts`; readable on Apple Terminal default dark, iTerm dark, light mode sanity check

---

## Part C — Verification matrix (the "prove it looks great" part)

### C1: Automated component tests (extend existing suite)
**Files:** `cli/tui/test/*.test.tsx` (app, composer, approval, privacy, responsive exist)
- Add: splash render test, transcript scroll-state test, sidebar visibility-per-width test, composer locked-state test
- Command: `cd cli/tui && bun test` — Expected: all pass, 0 snapshot diffs unreviewed

### C2: Frame-capture review at 5 terminal sizes
Script a PTY harness (script/tmux capture) rendering each state below at **140×40, 120×35, 100×30, 80×24, 60×20**:
1. Splash
2. Scan running (spinner/activity)
3. Findings report (3 critical + 2 optional mix)
4. Chat mid-conversation (user card + assistant markdown with code block)
5. Approval dialog open
6. Privacy dialog open
7. Composer locked state
8. Narrow fallback (sidebar hidden)
- Save PNGs/text frames to `/root/cad/clawfix-e2e/tui-frames/<size>/<state>.txt`
- Gate: Cad reviews every frame for overflow, misalignment, color bugs, double borders

### C3: Interaction e2e (scripted PTY)
Drive a real session end-to-end: launch → splash → auto-scan → findings in chat → type a question → AI answer streams → `fix 1` → approval dialog → approve → repair result card → `scan` → exit clean (code 0).
- Verify: no stuck states, no invisible focus, every step keyboard-only

### C4: Real-device pass (felirami gate)
1. Local build on cad → scp binary to felirami's MacBook (or `bun run` checkout)
2. Run on MacBook (no OpenClaw): soft state renders beautifully, chat works
3. Run on Arca Mac mini (live OpenClaw): real findings, real fix flow
4. felirami rates: looks / feel / "would a first-time OpenClaw user get it" — screenshot sign-off

### C5: Regression guards
- `bun run build` compiles standalone binary with tree-sitter assets (existing `standalone.ts` embedding)
- Binary smoke on cad: launches, splash renders, `--version`, `--dry-run` unchanged
- npm package integrity check still passes (SCRIPT_HASH flow untouched)

---

## Files likely to change

- `cli/tui/src/app.tsx` (layout composition: splash, panes, composer, sidebar)
- `cli/tui/src/components/transcript.tsx`, `composer.tsx`, new `splash.tsx`, new `sidebar.tsx`
- `cli/tui/src/theme.ts`, `cli/tui/src/keymap.ts`
- `cli/tui/src/lib/models.ts` (view state: splashVisible, scrollOffset)
- `cli/tui/test/*` (new tests above)
- Possibly `cli/bin/*` default-mode wiring (depends on A1 finding)

## Risks / open questions

- **Binary default path:** if 0.11.2 ships the REPL by default, decide: full TUI default for `clawfix` (interactive), REPL stays for `--plain`/non-TTY. Recommend full TUI when TTY.
- **OpenTUI layout limits:** single-border-column constraint documented in app.tsx; two-pane needs careful box nesting — spike first if unsure.
- **Scope:** no new features (no new commands, no backend changes). Pure UI/UX + wiring.
- **Width floor:** below 60 cols we degrade to single-column, composer always visible. opencode does similar.

## Verification readout (2026-07-25)

- TypeScript: `cd cli/tui && bunx tsc --noEmit` passed.
- TUI suite: `bun test` passed, 59 tests / 0 failures.
- Root suite: `npm test` passed, 350 tests / 0 failures.
- Frame sweep: 40 frames across 140×40, 120×35, 100×30, 80×24, and 60×20 passed; no line overflow, brand/composer/modal actions present at the supported breakpoints.
- Linux standalone: built, artifact-verified, and smoke-rendered successfully (5,048 bytes, exit 0).
- Static security scan: 1,544 candidate lines across tracked diff and new files, clean.
- Independent review: passed with no security concerns or logic errors.
- Follow-up hardening applied after review: frame output is env-configurable, offline analyzer failures render as transcript errors instead of unhandled rejections, and ultra-narrow status truncation stays within budget.

## Done definition

C1–C3 green on cad, C4 sign-off from felirami on MacBook + Mac mini, C5 binary built and smoke-tested. Then version bump → 0.12.0, npm publish + GitHub release + installer hash update (standard ClawFix release flow).
