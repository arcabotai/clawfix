# ClawFix end-to-end review — v0.11.2 (main @ 6d51d7e)

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
