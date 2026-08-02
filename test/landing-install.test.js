import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const landingPath = new URL('../src/landing.js', import.meta.url);

async function readLandingSource() {
  return readFile(landingPath, 'utf8');
}

function installCommandFrom(source) {
  const match = source.match(/<code id="cmd-install">([\s\S]*?)<\/code>/);
  assert.ok(match, 'install command exists');
  return match[1]
    .replace(/<[^>]+>/g, '')
    .replaceAll('&amp;', '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function copyScriptFrom(source) {
  const scripts = [...source.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length > 0, 'copy script exists');
  return scripts.at(-1)[1];
}

test('primary website command downloads and runs the installer', async () => {
  const landing = await readLandingSource();
  const command = installCommandFrom(landing);

  assert.equal(
    command,
    'curl -fsSL https://clawfix.dev/install -o install.sh && bash install.sh',
  );
  assert.doesNotMatch(command, /curl[^\n]*\|\s*(?:ba)?sh/);
  assert.doesNotMatch(landing, /onclick="copyCommand/);
});

async function createCopyHarness({ clipboard, execCommand = () => true } = {}) {
  const landing = await readLandingSource();
  const command = { textContent: installCommandFrom(landing) };
  let clickHandler;
  const button = {
    dataset: { copyCommand: 'install' },
    textContent: 'Copy',
    addEventListener(event, handler) {
      assert.equal(event, 'click');
      clickHandler = handler;
    },
  };
  const textarea = {
    style: {},
    value: '',
    selected: false,
    setAttribute() {},
    select() { this.selected = true; },
    setSelectionRange() {},
  };
  let appended = false;
  let removed = false;
  let resetButton;

  const document = {
    body: {
      appendChild(node) {
        assert.equal(node, textarea);
        appended = true;
      },
      removeChild(node) {
        assert.equal(node, textarea);
        removed = true;
      },
    },
    createElement(tag) {
      assert.equal(tag, 'textarea');
      return textarea;
    },
    execCommand(commandName) {
      assert.equal(commandName, 'copy');
      return execCommand(commandName);
    },
    querySelectorAll(selector) {
      assert.equal(selector, '[data-copy-command]');
      return [button];
    },
    getElementById(id) {
      if (id === 'cmd-install') return command;
      if (id === 'copyBtn-install') return button;
      return null;
    },
  };

  const context = vm.createContext({
    document,
    navigator: clipboard ? { clipboard } : {},
    setTimeout(callback) {
      resetButton = callback;
      return 1;
    },
  });
  vm.runInContext(copyScriptFrom(landing), context);

  assert.equal(typeof clickHandler, 'function');
  return {
    button,
    click: clickHandler,
    command,
    get appended() { return appended; },
    get removed() { return removed; },
    get resetButton() { return resetButton; },
    textarea,
  };
}

test('copy button falls back when the Clipboard API is unavailable', async () => {
  const harness = await createCopyHarness();
  const copied = await harness.click();

  assert.equal(copied, true);
  assert.equal(harness.textarea.value, harness.command.textContent);
  assert.equal(harness.textarea.selected, true);
  assert.equal(harness.appended, true);
  assert.equal(harness.removed, true);
  assert.equal(harness.button.textContent, 'Copied!');
  harness.resetButton();
  assert.equal(harness.button.textContent, 'Copy');
});

test('copy button falls back when Clipboard API permission is rejected', async () => {
  let attemptedText;
  const harness = await createCopyHarness({
    clipboard: {
      async writeText(text) {
        attemptedText = text;
        throw new Error('clipboard permission denied');
      },
    },
  });

  const copied = await harness.click();

  assert.equal(attemptedText, harness.command.textContent);
  assert.equal(copied, true);
  assert.equal(harness.textarea.value, harness.command.textContent);
  assert.equal(harness.removed, true);
  assert.equal(harness.button.textContent, 'Copied!');
});

test('copy button reports failure when both clipboard paths fail', async () => {
  const harness = await createCopyHarness({
    execCommand() {
      throw new Error('legacy copy denied');
    },
  });

  const copied = await harness.click();

  assert.equal(copied, false);
  assert.equal(harness.removed, true);
  assert.equal(harness.button.textContent, 'Copy failed');
  harness.resetButton();
  assert.equal(harness.button.textContent, 'Copy');
});
