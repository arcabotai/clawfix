#!/usr/bin/env node
/**
 * Interactive smoke for the standalone TUI binary.
 *
 * Drives the real binary through a PTY: renders, accepts typed input, and quits on Ctrl+D.
 *
 * This exists because a binary can render a perfect first frame and still be completely dead
 * to input — which is exactly what shipped when `bun build --compile` was run without Solid's
 * JSX transform. Every other gate passed: the file existed, the process started, the UI was
 * painted. Only typing at it catches this.
 *
 * Usage: node scripts/smoke-tui-interactive.mjs <binary>
 *
 * Needs python3 for the PTY (present on GitHub runners and macOS). Without it the check is
 * skipped unless CLAWFIX_TUI_REQUIRE_PTY=1, which turns the skip into a failure.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const DRIVER = String.raw`
import os, pty, re, subprocess, sys, threading, time

binary = sys.argv[1]
master, slave = pty.openpty()
proc = subprocess.Popen([binary, "--fake-session"], stdin=slave, stdout=slave, stderr=slave,
                        env={**os.environ, "TERM": "xterm-256color", "CLAWFIX_TUI_SMOKE": "1"})
os.close(slave)

buf = bytearray()
stop = threading.Event()

def drain():
    # The pty buffer must be drained continuously: once it fills, the child blocks writing to
    # fd 1 and every observation after that point is an artifact of the harness.
    while not stop.is_set():
        try:
            chunk = os.read(master, 65536)
            if not chunk:
                break
            buf.extend(chunk)
        except OSError:
            break

threading.Thread(target=drain, daemon=True).start()

time.sleep(3.0)
rendered = bytes(buf)
mark = len(buf)

os.write(master, b"ZZTOP")          # typed input must reach the composer
time.sleep(2.0)
echoed = bytes(buf[mark:])

os.write(master, b"\x04")           # Ctrl+D must quit
deadline = time.time() + 8
exited = None
while time.time() < deadline:
    if proc.poll() is not None:
        exited = proc.returncode
        break
    time.sleep(0.1)
stop.set()
if exited is None:
    proc.kill()

print("RENDERED:", b"ClawFix" in rendered)
ansi = re.compile(rb'\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])')
plain_echoed = ansi.sub(b"", echoed)
print("ACCEPTS_INPUT:", b"ZZTOP" in plain_echoed)
print("EXIT_CODE:", "none" if exited is None else exited)
`

function fail(message) {
  console.error(`smoke-tui-interactive: ${message}`)
  process.exit(1)
}

const binary = process.argv[2]
if (!binary || !existsSync(binary)) fail(`binary not found: ${binary ?? '<missing>'}`)

const python = ['python3', 'python'].find(
  (candidate) => spawnSync(candidate, ['-c', 'import pty'], { stdio: 'ignore' }).status === 0,
)

if (!python) {
  if (process.env.CLAWFIX_TUI_REQUIRE_PTY === '1') {
    fail('python3 with the pty module is required (CLAWFIX_TUI_REQUIRE_PTY=1) but was not found')
  }
  console.log('python3 with pty not available; skipping the interactive smoke')
  process.exit(0)
}

const result = spawnSync(python, ['-c', DRIVER, binary], { encoding: 'utf8', timeout: 60_000 })
if (result.error) fail(`pty driver failed: ${result.error.message}`)

const output = `${result.stdout}${result.stderr}`
const read = (key) => (output.match(new RegExp(`^${key}: (.*)$`, 'm')) || [])[1]

const rendered = read('RENDERED') === 'True'
const acceptsInput = read('ACCEPTS_INPUT') === 'True'
const exitCode = read('EXIT_CODE')

if (!rendered) fail(`binary never rendered the session UI\n--- driver output ---\n${output}`)
if (!acceptsInput) {
  fail(
    'binary rendered but ignored typed input — it is not interactive.\n'
    + 'This is what a compile without the Solid JSX transform looks like: a correct first\n'
    + 'frame and a session nobody can use. Check cli/tui/scripts/build.ts still passes\n'
    + `createSolidTransformPlugin() to Bun.build.\n--- driver output ---\n${output}`,
  )
}
if (exitCode !== '0') {
  const reason = exitCode === 'none'
    ? 'binary did not exit on Ctrl+D — there is no way out of the session'
    : `binary exited with nonzero status ${exitCode}`
  fail(`${reason}\n--- driver output ---\n${output}`)
}

console.log(JSON.stringify({ ok: true, mode: 'pty', rendered, acceptsInput, exitCode }, null, 2))
