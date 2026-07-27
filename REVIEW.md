# ClawFix end-to-end review — v0.11.2 (main @ 6d51d7e)

> **Status: implementation pass complete on branch `review/upgrade-pass` (local only, never pushed).**
> All 20 planned items are done. Gates: 365 node tests, 87 TUI tests, tsc clean, 80 frames,
> binary built and smoked. See "Implementation outcome" at the end for what was fixed, what was
> verified, and the one item that is only partially fixed.
>
> **Two further blockers were found and fixed after the first pass: B-23 (the standalone
> binary accepted no keyboard input) and B-24 (the guarded repair reported success without
> the gateway running), the latter found only by running against a real OpenClaw install.**

Reviewed: CLI core, TUI, web service, install/release flow, website copy.
Method: source review + live server, live SSE, published-tarball inspection, frame captures,
a compiled standalone binary, and targeted repros. Every finding below has reproducible evidence.

## Scope note

The working directory was empty at session start; `/root/clawfix` did not exist. This review is of
`origin/main @ 6d51d7e` fetched from GitHub, so **`git ls-files --others` shows nothing — any
uncommitted local work on your machine was not reviewed.** Host is macOS/arm64, Bun 1.3.6,
Node 22.22.3 (not the pinned Bun 1.2.21).

## Gate results

| Gate | Result |
|---|---|
| `npm test` | **349/350 pass, 1 fail** — `test/install-script.test.js:70`, macOS-only (L-16) |
| `cd cli/tui && bun test` | **59/60 pass, 1 fail** — `test/app.test.tsx:27`, macOS-only (L-16) |
| `cd cli/tui && bunx tsc --noEmit` | **clean (exit 0)** |
| Frame sweep 60x20 → 140x40 | **rendered, no regression at swept sizes** — but the sweep misses the broken range (M-9) |
| `scripts/build-tui-release.mjs` + binary smoke | **binary builds and renders real UI** (see below); repo smoke script is a no-op gate (M-11) |

Binary smoke, rendered output (not exit code) from `clawfix-tui-darwin-arm64.bin`:

```
ClawFix v...
Tell me what is going wrong
Local only · Enter send · Shift+Enter newline · Ctrl+P help · Ctrl+C cancel
OpenClaw diagnostics and guarded repairs
Remote AI analysis always asks before anything leaves this machine.
```

It rendered — and then had to be killed with SIGTERM, because of B-2.

---

# Findings

## BLOCKER

### B-1 — Remote repair proposals are silently dropped; the remote repair flow is dead

`src/routes/agent-v2.js:163` emits exactly:

```js
sse.send('repair.proposed', { repairId: ..., rationale: ... });
```

`cli/tui/src/session-bridge.ts:468` handles it with `planFromRaw(event.plan || event)`, and
`planFromRaw` returns `null` unless the object carries `planId` or `id`
(`cli/tui/src/session-bridge.ts:137-138`). The server never sends either. `if (plan)` is false, so
**no repair card, no approval dialog, no error** — the user only sees the assistant prose.

Repro (real server event shape, real bridge):

```
dialog.type          : none
repair cards         : 0
session.proposeRepair: 0 call(s)
RESULT: NO approval dialog. Remote repair proposal was silently dropped.
```

This also violates invariant 2. The client is supposed to resolve a server repair ID **locally**;
`session.proposeRepair()` is never called on this path. Worse, the code as written would render a
**server-authored** plan — server-supplied `risk`, `summary`, and up to 20 000 chars of
`unifiedDiff` (`session-bridge.ts:164-178`) — inside an approval dialog the user reads as local.
Execution still fails closed (`repair-engine.js:86-88` rejects an unknown `planId`), so the impact
is UI deception plus a dead feature, not code execution.

**Fix:** in the `repair.proposed` branch, look up a local finding whose `repairId === event.repairId`,
call `session.proposeRepair(finding.id)`, and build the `RepairPlanView` from the **returned local
plan**. Surface an explicit error card when no local finding matches. Never let `planFromRaw`
consume a server payload.

This is exactly the flow named in your known-open-items as having no e2e coverage — that is why it
shipped broken.

### B-2 — There is no way to exit the TUI

`cli/tui/src/main.tsx:106-107` sets `exitOnCtrlC: false` and `exitSignals: []`. `cli/tui/src/app.tsx:128-130`
binds Ctrl+C to `cancelScan()` only. `cli/tui/src/keymap.tsx` documents no quit key — Ctrl+C is
labelled "Cancel active scan/remote request". Because stdin is in raw mode, Ctrl+C arrives as a key
event, so the `SIGINT` listener in `topLevelExit` (`main.tsx:65-69`) never fires.

Evidence: the compiled binary ran past a 120 s timeout, and a follow-up run survived 12 s of
repeated `0x03` — `STILL RUNNING after 12s of Ctrl+C — no quit path`. Only SIGTERM/SIGKILL ended it.

**Fix:** add an explicit quit binding (Ctrl+D, or `q` when the composer is empty, or double Ctrl+C
within ~1 s) that calls `renderer.destroy()`, and document it in `keymap.tsx` + `KEY_HINTS`.

---

## HIGH

### H-3 — The TUI is not in the published npm package, so `npx clawfix` can never launch it

`cli/package.json` `files` allowlists `bin/ adapters/ core/ interfaces/ README.md LICENSE` — no
`tui/`. `cli/bin/clawfix.js:93` resolves `../tui/src/main.tsx` and spawns Bun with
`cwd: join(cliDir, '../tui')` (`clawfix.js:109`), a directory that does not exist once installed.

Evidence — published tarball contents:

```
$ npm pack clawfix@0.11.2 && tar -tzf clawfix-0.11.2.tgz | grep -c tui
0
```

21 files, zero TUI files. `scripts/install.sh` installs that same registry tarball
(`install.sh:205-233`), so **both documented install paths lack the TUI.**

Worse, the failure message blames the wrong thing. On a machine with Bun on PATH:

```
$ node package/bin/clawfix.js --tui
Fatal error: spawn /Users/felirami/.bun/bin/bun ENOENT
```

Bun is installed; the missing thing is the `cwd`. Users will chase a Bun install that is already there.

**Fix:** decide and align. Either add `tui/` to `files` (and accept the install-size/Bun-dependency
cost), or keep it out and (a) make `runOpenTuiMode` detect a missing entry file *before* spawning and
say "the OpenTUI session is not included in the npm package — download the standalone binary from
<release URL>", and (b) reword the site so the TUI is presented as a separate binary download.

### H-4 — Stale `SCRIPT_HASH` breaks the documented verification ritual

`/fix/sha256` tells users to compare against a GitHub file that does not match. Live:

```
$ curl -s localhost:3111/fix/sha256
{"sha256":"c8f29823b1534fda1a26c4d95abaa9f17b5998c18077a3f5c1918d59317f37d8",
 "note":"...GitHub reference: https://github.com/arcabotai/clawfix/blob/main/SCRIPT_HASH"}

$ cat SCRIPT_HASH
4470a867f26e2c3e729c0a03c109270252e11e2973089984731e2c503b78d96b
```

`SCRIPT_HASH` was last touched in `6aa3908`; the served script (`src/routes/script.js:22-593`) has
changed across several releases since. A user who performs the verification honestly gets a
mismatch, and the only lesson available is "ignore the mismatch" — which is worse than no check.

(`/install/sha256` is fine: it hashes `scripts/install.sh` at runtime and points at the source file.
Verified matching: `21816fab…`.)

**Fix:** regenerate `SCRIPT_HASH` in CI on every change to `src/routes/script.js`, and add a test
asserting `sha256(DIAGNOSTIC_SCRIPT) === readFileSync('SCRIPT_HASH')`. Until then, point the note at
`/fix/sha256` itself rather than a stale repo file.

### H-5 — The consent dialog understates what leaves the machine

`cli/tui/src/remote-analyzer.ts:84-107` uploads the **entire redacted diagnostic** to `/api/diagnose`
inside `send()`, before the agent call. The privacy dialog the user approves
(`session-bridge.ts:351-373`) previews only the agent-v2 body, with `diagnosticId: null` and a
hardcoded `conversationId: "pending-session"`, and `risk: "medium"` for every repair
(`session-bridge.ts:359`). The disclosure text says fields are included "when present on a linked
diagnostic" — it never says *this action creates that linked diagnostic by uploading it*.

Consent is correctly gated (free text does open the dialog first; `session-bridge.ts:588-597`), and
`redactOutbound` is applied — the defect is that "Inspect payload" shows something other than what
is sent.

**Fix:** show both requests in the disclosure — the `/api/diagnose` upload and the
`/api/v2/agent/messages` body — and build the preview from the same `availableRepairs()` the client
actually sends.

### H-6 — A throwing scan leaves stale findings attached to the new revision

`cli/core/session.js:152-167`. The `result.error` branch (126-131) correctly clears `diagnostic`,
`issues`, `findings`, `summary`. The `catch` branch does not: it sets `revision = nextRevision` and
`scanError`, then emits `session.scan.committed` with `findingsCount: findings.length` — the **previous
scan's** findings, now labelled with the new revision.

So after a failed rescan the UI shows old findings as current, and those findings remain
`repairable` and can be proposed against a revision whose scan never produced them.

**Fix:** clear the same four fields in the `catch` branch before emitting.

---

## MEDIUM

### M-7 — An unhandled scan rejection tears down the whole TUI

`cli/tui/src/live-session.ts:115` does `void bridge.scan()`. `bridge.scan()` re-throws whatever
`session.scan()` throws (`session-bridge.ts:540-550`), and `session.scan()` re-throws on the catch
path (`session.js:166`). `main.tsx:60` maps `unhandledRejection` to `rejectFatal`, which kills the
renderer and prints `ClawFix TUI failed: …`. A first-scan exception — e.g. `plainSummary()` at
`live-session.ts:42-51` dereferencing `summary.gateway` when `summary` is undefined — takes the app
down at startup instead of showing a scan error.
**Fix:** `void bridge.scan().catch(() => {})` and let the committed `scanError` render.

### M-8 — Hint line wraps at widths 65–91, not 60

`cli/tui/src/app.tsx:164-168` switches to the short hint at `width <= 64`. The long hint is 62 chars;
with `aiLabel` it needs 75 ("Local only") to 89 ("Remote (pending consent)") columns, against a
content width of `width - 2`. Measured:

```
width 64 -> 1 line     width 65..90 -> WRAPS to 2 lines     width 92 -> 1 line
```

The status line is not pushed off screen (the composer column grows), but a transcript row is eaten
and the footer looks broken across the most common 80-column terminal band.
**Fix:** don't guess a threshold — compute `` `${aiLabel()} · ${LONG_HINTS}`.length <= dims().width - 2 ``
and fall back to the short hint otherwise. A constant bump to `<= 91` also works but re-breaks the
moment a hint or label changes.

### M-9 — The frame sweep structurally cannot catch M-8, and validates fake copy

`cli/tui/scripts/frames.tsx:17-23` samples 140/120/100/80/60 — it never samples 61–79 or 81–99, which
is exactly where M-8 lives. Every state comes from `createFakeSession()`, so `aiMode` is always
`"local"` (the shortest label, the least likely to wrap). And the privacy frame
(`frames.tsx:135-146`) hand-writes a disclosure — `endpointUrl: ".../api/analyze"`, provider
`"ClawFix hosted AI (deepseek v4 flash)"` — that does not match `buildDisclosureView`
(`lib/disclosure.ts:50-58`), which produces `/api/v2/agent/messages` and
`ClawFix service → OpenRouter → selected model`. The UX gate is reviewing copy that ships nowhere.
**Fix:** add 66/72/88 widths, sweep `aiMode` variants, and build the privacy frame from the real
`buildDisclosureView()`.

### M-10 — Transcript items get new keys on every render

`session-bridge.ts:190` uses `typeof entry.id === "string" ? entry.id : nextId("msg")`, but session
messages are `{ type, role, text, at }` (`session.js:177`) — no `id`, ever. So every `publish()`
re-keys every message, defeating Solid's keyed reconciliation during token streaming, and
`idCounter` grows without bound.
**Fix:** assign a stable id in `appendMessage()` and use it.

### M-11 — The binary smoke gate cannot fail

`scripts/smoke-tui-binary.mjs:57-61` falls back to `smokePlain` when `node-pty` is absent. It is
absent (not in `package.json`), and the CI step (`.github/workflows/release-tui.yml:101-107`) never
installs it. `smokePlain` asserts bytes-on-stdout and an exit code, not rendered UI. My run:

```json
{ "ok": true, "mode": "plain", "full": false, "exitCode": 0, "stdoutBytes": 5048 }
```

Note the interaction with B-2: the PTY path writes `\x03` and waits for exit (`:92-104`), so if
`node-pty` *were* installed the gate would fail with "timed out waiting for TUI startup". The gate is
green only because it is degrading.
**Fix:** add `node-pty` as a dev dependency, fail loudly instead of degrading, and assert rendered
strings ("ClawFix", the composer placeholder) rather than byte counts.

### M-12 — `conversations` is an unbounded in-process Map

`src/routes/agent-v2.js:23,72-78` stores up to 12 messages per conversation, keyed by a
client-supplied `conversationId`, with `createdAt` recorded and never read. Nothing evicts. On a
long-lived Railway instance any client can grow server memory with fresh conversation IDs, rate
limits notwithstanding (30/min/IP still allows ~43k conversations/day per IP).
**Fix:** TTL sweep on `createdAt` plus a hard cap with LRU eviction.

### M-13 — `nativeChecks` is a dead parameter

`session.js:137` passes `nativeChecks: result?.nativeChecks` into `normalizeFindings`, which does not
accept it (`findings.js:129-134`). Native checks only survive because `diagnostics.js` folds them into
`localIssues` with a `nativeCheckId`. The header comment on `findings.js:1-8` claims it normalizes
"native OpenClaw findings", implying a path that isn't there.
**Fix:** delete the argument, or implement the branch and cover it with a test.

### M-14 — High/critical refusal is enforced only in the TUI

`session-bridge.ts:690-701` refuses `high`/`critical` plans. `repair-engine.js:84-135` does not check
`plan.risk` at all, and the plain interface has no equivalent guard. Today the catalog holds exactly
one `low`-risk entry (`repair-catalog.js:74-76`), so this is latent — but the invariant is enforced at
the UI layer, which is the wrong layer.
**Fix:** reject high/critical inside `applyPlan` and return `{status:'blocked', reason:'risk_refused'}`.

### M-15 — `verify`/`rollback` exceptions escape `applyPlan`

`repair-engine.js:115-135` wraps `entry.apply` in try/catch but not `preflight`, `verify`, or
`rollback`. A throwing `verify` rejects the promise after the repair has already been applied, so the
caller reports a generic failure and loses the `applyResult` — the one case where truthful reporting
matters most.
**Fix:** wrap each stage; on a `verify` throw return `{status:'verify_failed', verifyError, applyResult}`.

---

## LOW / NIT

- **L-16 — Two tests are Linux-only, so the suite is not green on macOS.**
  `test/install-script.test.js:95` uses GNU `tar --transform`; BSD tar rejects it
  (`tar: Option --transform=... is not supported`), the helper ignores the failure, and the test dies
  later on `ENOENT … clawfix-0.10.0.tgz`. `cli/tui/test/app.test.tsx:27,39` hardcodes
  `@opentui/core-linux-x64`, absent on darwin. Fix: use `-s ,^,package/,` on BSD or `tar -C` with a
  pre-made `package/` dir; select the native package from `process.platform`/`arch`.
- **L-17 — Landing tense conflict.** `src/landing.js:564` "Chat-first TUI is now the default session."
  vs `:572` "The chat-first TUI ships in the next release." The "New on main" pill (`:504-507`) and the
  note are correctly labelled — only the H2 overclaims. Fix: "Chat-first TUI lands as the default session."
- **L-18 — Node engine drift.** `cli/package.json` `engines.node >= 18`, root `>= 22`,
  site says "Node.js 22+" (`landing.js:519`). The CLI uses `--env-file-if-exists` and Node 22 APIs
  elsewhere. Fix: raise the CLI floor to 22.
- **L-19 — `runOpenTuiMode` conflates "launched" with "exited 0"** (`cli/bin/clawfix.js:122-126`).
  A TUI that starts, runs, and exits non-zero returns `false`, so the default path drops the user into a
  *second*, full plain session. Fix: track "did the child start" separately from its exit code.
- **L-20 — `statusLine()` can split a surrogate pair** (`app.tsx:179`, `full.slice(0, budget - 1)`), and
  measures 🦞 by `.length` rather than display width.
- **L-21 — `records` Map in `repair-engine.js:43` is never pruned**; consumed plans live for the
  process lifetime.
- **L-22 — Disclosure defaults are duplicated** in `cli/core/privacy.js:15-29` and
  `cli/tui/src/lib/disclosure.ts:5-19`. They agree today; the frames harness (M-9) shows how quietly
  they drift. Fix: single source, imported by the TUI.

---

## Verified sound (no action)

Worth stating explicitly, since these are the load-bearing claims:

- **agent-v2 contract holds under live testing.** Banned field → `{"error":"Field \"shell\" is not allowed"}`;
  7-char `conversationId` → rejected; 33 repairs → `too many availableRepairs`; valid request streams
  `agent.meta → assistant.delta × N → agent.done`. `propose_repair` is a closed enum built from
  client-supplied IDs (`contract.js:122-150`) and re-validated against the allowlist
  (`contract.js:156-189`).
- **Consent gating for free text is correct.** Deterministic commands bypass
  (`session-bridge.ts:583`); everything else opens the dialog with focus defaulting to `stay-local`
  (`:368`), and `runRemote` re-checks consent (`:434-437`).
- **Offline analyzer is deterministic** — unmatched input returns "Unknown local command. Type help for
  the deterministic command list." (`offline-analyzer.js:106-108`), never a generated answer.
- **Approval defaults to Cancel** (`session-bridge.ts:381`) and success copy is gated on
  `status === "applied"` (`:718`); `rejected`/`blocked`/`verify_failed` all produce failure cards
  (`:731-751`). The bridge calls `applyRepair({planId, approvalToken, findingId, ctx})` — no
  `approveRepair` fallback anywhere in the tree.
- **Plan binding is sound**: single-use token consumed before any further check
  (`repair-engine.js:91-111`), revision + fingerprint checked, `verify` reads runtime evidence.
- **AI abuse gate is fail-closed.** `isPaidAIEnabled` (`security.js:76-79`) plus a timing-safe bearer
  check in `createAIRequestGuard` (`security.js:105-108`); concurrency + daily budget + per-IP limits.
- **Site claims that check out:** `npx clawfix@0.11.2` resolves (npm `latest` = 0.11.2); npm
  attestations exist (`dist.attestations`, SLSA provenance v1); "21-file allowlisted package" is exactly
  right; "49 known issue detectors" matches `KNOWN_ISSUES.length === 49`; TUI binaries + `TUI-SHA256SUMS`
  are attached to the v0.11.2 release; install copy is download → verify → bash throughout, with no
  `curl | bash` anywhere (enforced by `install-script.test.js:62`).

---

# Upgrade plan

Ordered by value-at-risk. Nothing here is started — awaiting your go.

## Fix (in this order)

| # | Item | Effort | Risk if done | Risk if skipped |
|---|---|---|---|---|
| 1 | **B-1** resolve `repair.proposed` locally via `session.proposeRepair` | M | Low — new code path, fully unit-testable | The product's headline flow does not work |
| 2 | **B-2** add a quit binding + document it | S | Low | Shipped binary traps users |
| 3 | **H-6** clear findings on the scan catch path | S | Low | Stale findings repairable under a new revision |
| 4 | **M-7** `.catch()` the autoscan | S | Very low | Startup scan error kills the TUI |
| 5 | **H-4** generate `SCRIPT_HASH` in CI + equality test | S | Low | Documented integrity check fails for honest users |
| 6 | **H-5** disclose the `/api/diagnose` upload in the privacy dialog | M | Low, copy + preview only | Consent UI understates the upload |
| 7 | **H-3** decide TUI packaging; fix the misleading Bun error either way | M | Medium — shipping `tui/` changes package size and adds a Bun dependency; **your call** | Site promises a TUI that `npx` cannot run |
| 8 | **M-14/M-15** enforce risk refusal and wrap stages in `repair-engine` | S | Low | Safety invariant enforced at the UI layer only |
| 9 | **M-8** measure the hint line instead of thresholding | S | Low | Footer wraps across the 65–91 column band |
| 10 | **M-12** TTL + cap on `conversations` | S | Low | Unbounded server memory |
| 11 | **L-16** make the two tests platform-agnostic | S | Low | Suite cannot go green on macOS |

## Improve

| # | Item | Effort | Risk |
|---|---|---|---|
| 12 | **M-11** add `node-pty`, fail instead of degrading, assert rendered strings | S | Low — will surface B-2 immediately, which is the point |
| 13 | **M-9** widen the frame sweep; drive the privacy frame from `buildDisclosureView` | S | Low |
| 14 | **New:** scripted PTY e2e — scan → consent → remote chat (stub SSE) → repair proposal → approval → apply → verify | L | Medium (fixture-heavy) — but this is the gap that let B-1 ship |
| 15 | **M-10** stable message ids | S | Low |
| 16 | **L-17/L-18** landing tense, Node engine floor | S | Very low |
| 17 | **L-19** separate "started" from "exit code" in mode dispatch | S | Low |
| 18 | **L-20/L-21** grapheme-safe truncation; prune consumed plans | S | Very low |

## Delete

| # | Item | Effort | Risk |
|---|---|---|---|
| 19 | **M-13** the dead `nativeChecks` argument (`session.js:137`) and the misleading `findings.js` header claim | S | Very low |
| 20 | **L-22** the duplicated disclosure constants in `lib/disclosure.ts`; import from `cli/core/privacy.js` | S | Low — only if TUI packaging (item 7) keeps `cli/core` reachable |

## Recommended first commit

Items 1–4 together: they are the two blockers plus the two one-line correctness fixes, they touch
`session-bridge.ts`, `session.js`, `app.tsx`, `live-session.ts` only, and each is covered by a test I
can add in the same commit. Item 14 (the PTY e2e) should follow immediately so B-1 cannot regress.

**Open decision for you (item 7):** ship `tui/` inside the npm package, or keep the TUI
binary-only and reword the site? I recommend binary-only — shipping the TUI would add a hard Bun
dependency to an `npx`-first tool — but it means editing the hero copy, so it's your call.

---

# Implementation outcome

Branch `review/upgrade-pass`, 9 commits, local only — nothing pushed, no Railway, no npm publish.

## Gates (final run)

| Gate | Before | After |
|---|---|---|
| `npm test` | 349/350 | **365/365** |
| `cd cli/tui && bun test` | 59/60 | **87/87** |
| `bunx tsc --noEmit` | clean | **clean** |
| Frame sweep | 40 frames, 5 widths | **80 frames, 8 widths**, zero footer wraps |
| Build + smoke | passed without asserting anything | **passes, asserting rendered UI** |

## Fixed and verified

| # | Finding | Evidence |
|---|---|---|
| B-1 | Remote repair proposals dropped | e2e test drives the real flow; confirmed to fail against the pre-fix bridge |
| H-3 | TUI absent from npm package | `--tui` on a staged published layout now names the standalone binary; test asserts it |
| H-4 | Stale `SCRIPT_HASH` | regenerated; guard test fails on drift (verified by corrupting it) |
| H-5 | Consent dialog understated the upload | preview built from the real request; `/api/diagnose` disclosed |
| H-6 | Stale findings after a thrown scan | test asserts the cleared state and that the repair can no longer be proposed |
| M-7 | Autoscan rejection killed the TUI | `.catch()` on the autoscan |
| M-8 | Footer wrapped at widths 65–91 | 303 renders across 3 aiModes × widths 40–140: single-row footer everywhere |
| M-9 | Frame sweep could not see M-8 | widths 66/72/88 and consent-pending/remote states added; real disclosure rendered |
| M-10 | Unstable transcript keys | ids assigned in `appendMessage` |
| M-11 | Smoke gate proved nothing | asserts rendered UI; regression test feeds it a non-rendering binary |
| M-12 | Unbounded conversation store | TTL + cap with oldest-first eviction, unit tested |
| M-13 | Dead `nativeChecks` argument | removed; comment corrected |
| M-14 | Risk refusal only in the TUI | enforced in `applyPlan`; nothing runs, not even preflight |
| M-15 | Stage exceptions escaped `applyPlan` | each stage returns a structured outcome; `applyResult` preserved |
| L-16 | Suite unrunnable on macOS | both tests fixed; suite green on macOS |
| L-17..L-22 | Copy, engines, mode dispatch, truncation, plan retention, disclosure drift | all addressed; parity test added |

## Partially fixed

**B-2 — TUI quit path.** Fixed and verified *from source*: Ctrl+D, and Ctrl+C when idle, exit in
~0.1s with exit code 0 and the terminal restored (`ICANON`/`ECHO` back on). Ctrl+C still cancels
while work is in flight. The decision is a pure `resolveGlobalKeyAction()`, unit tested, because
`bun test` swallows raw Ctrl+C.

It does **not** fix the standalone binary, for the reason below.

## New finding (not fixed)

### B-23 — BLOCKER: the standalone binary receives no keyboard input at all

Discovered while verifying B-2. The `bun --compile` build renders the UI correctly but never
receives a key. Driving both builds through a PTY with the pty buffer drained, typing `ZZTOP`:

```
compiled binary : typed text echoed into UI: False   bytes rendered after typing: 0
from source     : typed text echoed into UI: True    bytes rendered after typing: 132
```

So in the shipped binary the composer cannot be typed into, no dialog can be answered, no repair
can be approved, and — the symptom that led here — it cannot be quit. It renders a session that
cannot be used. Reproduced consistently across rebuilds; unaffected by the B-2 fix, which is why
that fix lands only for the source path.

Not fixed: the cause is below ClawFix, in how OpenTUI's input layer behaves under `bun --compile`
(`cli/tui/bunfig.toml` preloads `@opentui/solid/preload`, which a compiled binary cannot resolve
— the most likely culprit, unconfirmed). Fixing it means changing how the binary is built, which
is outside the approved plan.

**Suggested next step:** treat this as the top priority. Reproduce with a minimal OpenTUI
`bun --compile` app to isolate it from ClawFix, then either embed the preload plugin at build
time or raise it upstream. Until then the GitHub release binaries render but do not work, and
the site should not present them as a usable way to run ClawFix.

Note this was invisible to every existing gate: `verify-tui-artifact.mjs` checks the file, and the
smoke script only proved the process started — even after this pass hardened it to assert rendered
output, rendering is exactly what still works. Only driving real keys through a PTY catches it.

## Methodology note

An earlier round of this investigation reached wrong conclusions — that `renderer.destroy()`
blocks, that `process.exit()` does not fire — because the PTY harness was not draining the master,
so writes to fd 1 blocked on a full buffer. Once the harness drained continuously, the source
build exited cleanly and those conclusions dissolved. The findings above come from the corrected
harness.


---

# Real-machine review (Blaxel sandbox, OpenClaw 2026.6.11)

Everything below ran on a provisioned Linux sandbox with a real OpenClaw install, not a fixture.

| Check | Result |
|---|---|
| Node suite on Linux | **378 tests, 376 pass, 0 fail** (2 platform-skipped) |
| `clawfix --json` against real OpenClaw | found the binary, version, config, and **7 real issues** including native `openclaw doctor` and security-audit findings |
| Hostname privacy | `hostHash` 8 chars; real hostname, home path and `/root` absent from the diagnostic |
| Redaction of a real secret | a real 48-char `gateway.auth.token` appears **0 times**; the section renders as `"auth": "***REDACTED***"` |
| Guarded repair, full flow | plan built locally, wrong token → `invalid_token`, replay → `token_reused`, outcome truthful against a rescan |
| TUI on Alpine/musl | **cannot run** — see the limitation below |

## B-24 — BLOCKER (fixed): the guarded repair reported success without a running gateway

`checkGatewayRunning()` decided liveness from `pgrep -f 'openclaw.*gateway'`. On a real install
that pattern is wrong in both directions:

- a gateway started by `openclaw gateway run` re-execs with the bare argv `openclaw`, so it
  **never matched a real gateway**;
- ClawFix's own `openclaw gateway status` probe — launched concurrently with the pgrep in the
  same `Promise.all` — **always matched**.

Reproduced with nothing listening on 18789:

```
verify() -> {"ok":true,"evidence":{"running":true,"pid":"6911\n6926"}}
$ ss -ltn | grep 18789   # nothing listening
```

`verify.ok === true` makes `applyPlan` return `applied`, and the UI then prints "Repair applied
… Verification passed against local detectors." A repair that changed nothing would be reported
as a success. The mirror image also held: `preflight` returned `gateway_already_running` while
the gateway was down, so the only repair ClawFix ships could never be applied.

Fixed by making the listening port the verdict — the same evidence the diagnostics core already
reports as `portListening`. Status prose and PIDs remain evidence, never the verdict, and the PID
probe now excludes ClawFix's own sub-commands and the current process.

Verified against a real gateway, both states:

```
gateway down -> verify {"ok":false,"listening":false,"pid":""}   preflight {"ok":true}
gateway up   -> verify {"ok":true,"listening":true,"pid":"8855"} preflight {"ok":false,"reason":"gateway_already_running"}
```

A full repair run with the service unavailable now reports `verify_failed`, and a rescan agrees
with the reported outcome.

## Limitation found — NOW FIXED, see the second pass below: the TUI cannot run on Alpine/musl

`@opentui/core` resolves its native library as `@opentui/core-linux-x64` with no musl detection.
On Alpine the glibc `libopentui.so` fails to load (`ld-linux-x86-64.so.2` missing), `gcompat` does
not help, and installing `@opentui/core-linux-x64-musl` does not either — the loader asks for the
glibc package by name and fails with `Cannot find module '@opentui/core-linux-x64'`. All 23 TUI
render tests fail there for this one reason.

The CLI core is unaffected: the full node suite and the plain interface work on musl, which is
what `npx clawfix` uses. But an operator running OpenClaw in an Alpine container cannot use the
TUI from source or from the release binary. Worth deciding whether to ship a musl target or to
state the requirement on the site; it is an upstream OpenTUI limitation either way.


---

# Second pass — webhook security and musl support

## B-25 — HIGH (fixed): `/webhooks/resend` was an unauthenticated email relay

The route checked only that `svix-id`, `svix-timestamp` and `svix-signature` were **present** —
never that the signature was valid — and skipped even that when no secret was configured. It
sends mail from `arca@arcabot.ai` to a real inbox, so anyone who knew the URL could forge an
`email.received` event and choose the from, subject and body.

Verified against the running server before and after: a forged delivery with junk `svix-*`
headers now returns **401** (`Rejected Resend webhook: not_configured`), a correctly signed
delivery returns **200**, and a forged signature against a configured secret returns **401**.

Signatures are now verified as Svix specifies — HMAC-SHA256 over `id.timestamp.rawBody` keyed by
the base64 secret, constant-time compare, and a timestamp tolerance that bounds replay of a
captured delivery.

Two related issues in the same path: `email_id` came from the webhook body and was interpolated
into a Resend API path called with the **full-access** key (now constrained to an opaque id and
encoded), and inbound `from`/`to`/`subject` went unescaped into the forwarded HTML.

## B-26 — HIGH (fixed): the Lemon Squeezy webhook could not verify a real signature

It hashed `JSON.stringify(req.body)` — the parsed object re-serialized, not the bytes Lemon
Squeezy signed. Key order, spacing and unicode escaping all differ, so a genuine signature could
never match; the comparison was also `!==` rather than constant-time, and verification was
skipped entirely when no secret was set, accepting any POST as a payment notification.

The raw body is now captured in the json parser for `/webhook` routes and both endpoints fail
closed on an unset secret, a missing raw body, or a bad signature.

## Alpine/musl TUI — fixed

`@opentui/core` resolves its native library by a hardcoded package name per platform with no
musl detection, so on Alpine it asks for `@opentui/core-linux-x64` and fails to load. The new
`linux-x64-musl` target compiles with `bun-linux-x64-musl` and stages the **musl** library under
the asset key the runtime actually asks for.

Verified on a real Alpine 3.21 machine, driving the compiled binary through a PTY:

```
{ "ok": true, "mode": "pty", "rendered": true, "acceptsInput": true, "exitCode": "0" }
```

Added to the release matrix, so Alpine-based OpenClaw containers get a working binary.

## Resolved in the third pass

**Payments are received but never recorded** — the payment surface was removed entirely. Original finding: `src/routes/payment.js` handles `order_created`
with `// TODO: Mark fix as paid in database`. With Lemon Squeezy configured a user can be charged
$2 and nothing in the system records it or unlocks anything. The checkout path is otherwise
sound. This needs a product decision — record and gate on payment, or remove the paid path until
it is real — so it is flagged rather than guessed at.


---

# Third pass — payment removal and real break-fix scenarios

## Payment surface removed

`/api/checkout` created real Lemon Squeezy sessions while `order_created` was
`// TODO: Mark fix as paid in database`, so a configured store could charge $2 and record
nothing. Removed the checkout endpoint, the payment page, the payment webhook and the unused
Lemon Squeezy verifier. Svix verification stays — the Resend inbound-email webhook uses it.
`security-regressions` now asserts those routes stay 404.

## Five break-fix scenarios on a real OpenClaw 2026.6.11 install

Each scenario resets the box to a valid config, breaks one real thing, and scans.

| # | Broken | ClawFix reported | Detected |
|---|---|---|---|
| 1 | Gateway process killed | `[critical] Gateway is not running` | **yes** |
| 2 | Port 18789 held by an unrelated process | `[critical] Port conflict detected` + `Gateway port 18789 is occupied by python3 (PID 726), but OpenClaw cannot reach it` | **yes** |
| 3 | `openclaw.json` corrupted | `[high] JSON5 parse failed: SyntaxError: JSON5: invalid character 'i' at 1:8` | **yes** |
| 4 | Gateway auth set to `none` on loopback | `[critical] Gateway auth missing on loopback` + `[medium] Gateway HTTP APIs are reachable without auth` | **yes** |
| 5 | `update.auto.enabled = true` | `[medium] Auto-update enabled (risk of restart loops)` | **yes** |

**Detection: 5/5.** Scenario 2 is notably good — it names the squatting process and PID.

## Repairing: the honest picture

The guarded-repair pipeline ran end to end against the real install: plan built locally,
`invalid_token` rejected, single-use token enforced (`token_reused`), apply executed the real
`openclaw gateway restart`, verify re-checked the port, and the outcome was reported as
`verify_failed` — with a rescan agreeing the gateway was still down.

That is the correct behaviour, and it is the B-24 fix working: before this pass the same run
would have claimed `applied`.

But it is not a fix, and the reason matters:

**ClawFix ships exactly one executable repair, and it cannot work in a container.**
`gateway-not-running` invokes `openclaw gateway restart`, which needs systemd or launchd. On
this Alpine host OpenClaw answered *"Gateway service disabled … systemd user services are
unavailable"*, so the repair could not succeed no matter how correct the plumbing is. Nothing in
the catalog can repair scenarios 2–5 either: the four other real problems ClawFix detects have
no repair at all.

So today ClawFix is a strong **diagnostic** with one repair that only applies on service-managed
hosts. The site and README should say that plainly, and the catalog is the obvious place to
invest next — port-conflict and config-invalid are both detected precisely enough to repair.

## Two quality issues seen only in real output

- A finding surfaced as `[critical] timeout` with no other context — a native collector timing
  out is being presented to the user as a critical OpenClaw problem
  (`cli/core/diagnostics.js`, `text: finding.title || finding.message`).
- Raw parser output is used as a user-facing title: `JSON5 parse failed: SyntaxError: JSON5:
  invalid character 'i' at 1:8`. Accurate, but it is a stack-trace fragment where a sentence
  belongs.


---

# Fourth pass — the repair catalog, and driving the real UI

## Two repairs added: ClawFix now fixes what it finds

The catalog held one repair that needed a service manager. Two more were added, both using
OpenClaw's own supported commands and both verified against a real OpenClaw 2026.6.11 install:

| Repair | Does | Verified by | Risk |
|---|---|---|---|
| `auto-update-enabled-warning` | `openclaw config set update.auto.enabled false` | reads the key back through `config get` | low |
| `gateway-loopback-no-auth` | sets `gateway.auth.mode` to `token`, then `doctor --fix --generate-gateway-token` | reads the mode back; never reads the token itself | medium |

Repairable findings went from 1 to 3. On a real install, broken deliberately:

```
auto-update:  before "true"  → applied, verify {"ok":true,"current":"false"} → finding gone
gateway auth: before "none"  → applied, verify {"ok":true,"mode":"token"}    → finding gone
```

`gateway-loopback-no-auth` is deliberately medium risk, not low: existing clients stop working
until they carry the new token, and the preview says so.

Verification reads one config key through OpenClaw rather than parsing `openclaw.json`, so repair
evidence stays narrow — and the auth repair never pulls the token into a repair record.

## Driving the real UI found two defects

The compiled musl binary was driven through a PTY with a terminal emulator attached, on a real
broken install. Both of these were invisible to unit tests and frame captures.

**The sidebar's numbers did not match the numbers `fix <#>` accepts.** The sidebar sorted findings
by severity and renumbered its own view 1–4, while `fix <#>` and `explain <#>` index the unsorted
findings list. Reading *"3. Auto-update enabled"* and typing `fix 3` reached an advisory finding
and answered "This finding has no reviewed automatic repair." The sidebar now carries each
finding's real position — criticals still lead, but the numbers are the ones the commands take.

**The status line printed the revision twice**, which pushed the finding count off the end:

```
before: 🦞 ClawFix v0.11.2 · revision f3e9479b-… · Revision f3e9479b-…
after:  🦞 ClawFix v0.11.2 · Revision f3e9479b-b52c-456e-8d0f-f5f25ba3b2e4 · 6 findings · AI consent required
```

The bridge's status already begins with the revision; the extra prefix was redundant.

## End to end through the UI, on a real machine

Sidebar listed *"4. Gateway auth missing on loopback"* → typed `fix 4` → approval dialog showed
`Risk: medium · gateway-loopback-no-auth` with the composer locked and focus defaulting to
Cancel → approved → `openclaw config get gateway.auth.mode` returned **token**.

That is the whole chain — detect, propose, review, approve, apply, verify — fixing a real problem
on a real OpenClaw install through the shipped interface.


---

# Fifth pass — more repairs, and honest finding titles

## Repair catalog: 1 → 5

Three more config repairs, all built on `openclaw config set` with the read-back as verification,
all sharing one `configToggleRepair` contract so the guard rails cannot drift apart:

| Repair | Key | Verified on a real install |
|---|---|---|
| `auto-update-enabled-warning` | `update.auto.enabled` → false | applied, finding gone |
| `gateway-loopback-no-auth` | `gateway.auth.mode` → token | applied, finding gone |
| `no-hybrid-search` | `agents.defaults.memorySearch.query.hybrid.enabled` → true | applied, `current:"true"`, finding gone |
| `no-memory-flush` | `agents.defaults.compaction.memoryFlush.enabled` → true | applied, `current:"true"`, finding gone |

Four of the five now work without a service manager, so a containerised OpenClaw is no longer a
host where ClawFix can only look and shrug. `gateway-not-running` still needs systemd or launchd —
that is OpenClaw's restart path, not something ClawFix can route around.

Each toggle refuses an unreadable key (`config_state_unknown`) rather than treating "cannot read"
as "false", and rollback restores the previous value.

## Port conflict: deliberately still not repaired

The obvious next repair is the port conflict — ClawFix already knows the squatting PID. It was not
added, because every version of it ends in killing a process ClawFix does not own. A repair that
terminates an unrelated service is not a guarded repair, whatever the preview says. If this is
wanted later, the safe shape is: refuse unless the listener is itself a stale OpenClaw process,
and even then prefer OpenClaw's own `--force` restart over a kill.

## Two findings were shouting machine text at the user

`[critical] timeout` came from `nativeStatus.gateway.error` being used directly as an issue title.
A probe that gave up was presented as a critical OpenClaw fault named "timeout". The same pattern
turned a validator message into the title `JSON5 parse failed: SyntaxError: JSON5: invalid
character 'i' at 1:8`.

Both now carry an actionable headline with the upstream text as detail:

```
[high] OpenClaw config schema validation failed
       detail: JSON5 parse failed: SyntaxError: JSON5: invalid character 'i' at 1:8
```

Fixing the title broke the doctor-findings dedup, which had been matching on the raw message — so
the same problem briefly appeared twice, once well-titled and once raw. Caught on the real
machine, not in tests: the dedup now compares the detail as well as the headline.
