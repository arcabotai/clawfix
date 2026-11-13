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

async function createCopyHarness({ clipboard, execCommand = () => true, selection = null } = {}) {
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
  const selectionRange = {
    selected: null,
    selectNodeContents(node) {
      this.selected = node;
    },
  };

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
    querySelector() {
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '[data-copy-command]') return [button];
      return [];
    },
    getElementById(id) {
      if (id === 'cmd-install') return command;
      if (id === 'copyBtn-install') return button;
      return null;
    },
    createRange() {
      return selectionRange;
    },
  };

  const context = vm.createContext({
    document,
    navigator: clipboard ? { clipboard } : {},
    setTimeout(callback) {
      resetButton = callback;
      return 1;
    },
    window: selection ? { getSelection: () => selection } : {},
  });
  vm.runInContext(copyScriptFrom(landing), context);

  assert.equal(typeof clickHandler, 'function');
  return {
    button,
    click: clickHandler,
    command,
    selectionRange,
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

test('copy button selects the command when both clipboard paths fail', async () => {
  const selection = {
    rangeCount: 0,
    isCollapsed: true,
    removeAllRanges() {
      this.rangeCount = 0;
      this.isCollapsed = true;
    },
    addRange() {
      this.rangeCount = 1;
      this.isCollapsed = false;
    },
  };
  const harness = await createCopyHarness({
    execCommand() {
      throw new Error('legacy copy denied');
    },
    selection,
  });

  const copied = await harness.click();

  assert.equal(copied, false);
  assert.equal(harness.removed, true);
  assert.equal(harness.selectionRange.selected, harness.command);
  assert.equal(selection.rangeCount, 1);
  assert.equal(selection.isCollapsed, false);
  assert.equal(harness.button.textContent, 'Command selected');
  assert.notEqual(harness.button.textContent, 'Copy failed');
  harness.resetButton();
  assert.equal(harness.button.textContent, 'Copy');
});

test('copy button says copy is unavailable when the command cannot be selected', async () => {
  const harness = await createCopyHarness({
    clipboard: {
      async writeText() {
        throw new Error('clipboard permission denied');
      },
    },
    execCommand() {
      return false;
    },
  });

  const copied = await harness.click();

  assert.equal(copied, false);
  assert.equal(harness.removed, true);
  assert.equal(harness.button.textContent, 'Copy unavailable');
  assert.notEqual(harness.button.textContent, 'Copy failed');
});

test('landing page exposes a skip link and accessible mobile navigation', async () => {
  const landing = await readLandingSource();
  const scripts = [...landing.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  const focusRule = landing.match(/#main-content:focus\s*\{([^}]+)\}/)?.[1];

  assert.equal(scripts.length, 1);
  assert.match(landing, /class="skip-link" href="#main-content">Skip to main content</);
  assert.match(landing, /<main id="main-content" tabindex="-1">/);
  assert.match(landing, /class="nav-toggle" aria-expanded="false" aria-controls="site-nav">Menu</);
  assert.match(landing, /<nav class="nav-links" id="site-nav" aria-label="Primary navigation">/);
  assert.match(landing, /href="#how">How It Works</);
  assert.match(landing, /href="#pricing">Hosted Service</);
  assert.match(landing, /href="https:\/\/github.com\/arcabotai\/clawfix">GitHub</);
  assert.match(landing, /@media \(max-width: 720px\)/);
  assert.match(landing, /\.nav-links\.is-open \{ display: grid; \}/);
  assert.match(landing, /@media \(prefers-reduced-motion: reduce\)/);
  assert.ok(focusRule, 'main content needs an explicit focus rule');
  assert.match(focusRule, /outline:\s*3px solid var\(--blue\)/);
  assert.match(focusRule, /outline-offset:\s*-3px/);
  assert.doesNotMatch(focusRule, /outline:\s*none/);
  assert.doesNotMatch(landing, /onclick=/);
  assert.doesNotMatch(landing, /\.nav-optional \{ display: none; \}/);
  assert.doesNotMatch(landing, /Copy failed/);
});

test('landing skip link focuses main and the menu toggles from the keyboard control', async () => {
  const landing = await readLandingSource();
  const script = copyScriptFrom(landing);
  const listeners = new Map();
  const classes = new Set();
  const main = {
    focused: false,
    focus() {
      this.focused = true;
    },
  };
  const nav = {
    classList: {
      toggle(name, force) {
        if (force) classes.add(name);
        else classes.delete(name);
      },
    },
  };
  const button = {
    expanded: 'false',
    textContent: 'Menu',
    focused: false,
    getAttribute(name) {
      assert.equal(name, 'aria-expanded');
      return this.expanded;
    },
    setAttribute(name, value) {
      assert.equal(name, 'aria-expanded');
      this.expanded = value;
    },
    addEventListener(type, listener) {
      listeners.set(`toggle:${type}`, listener);
    },
    focus() {
      this.focused = true;
    },
  };
  const skipLink = {
    addEventListener(type, listener) {
      listeners.set(`skip:${type}`, listener);
    },
  };
  let keydown;
  const link = {
    addEventListener(type, listener) {
      listeners.set(`link:${type}`, listener);
    },
  };

  vm.runInContext(script, vm.createContext({
    document: {
      createRange() {
        return { selectNodeContents() {} };
      },
      getElementById(id) {
        return { 'main-content': main, 'site-nav': nav }[id] ?? null;
      },
      querySelector(selector) {
        return { '.skip-link': skipLink, '.nav-toggle': button }[selector] ?? null;
      },
      querySelectorAll(selector) {
        if (selector === '#site-nav a') return [link];
        return [];
      },
      addEventListener(type, listener) {
        assert.equal(type, 'keydown');
        keydown = listener;
      },
    },
    navigator: { clipboard: { writeText: async () => {} } },
    setTimeout() {},
    window: { getSelection: () => null },
  }));

  assert.equal(typeof listeners.get('skip:click'), 'function');
  listeners.get('skip:click')();
  assert.equal(main.focused, true);

  listeners.get('toggle:click')();
  assert.equal(button.expanded, 'true');
  assert.equal(button.textContent, 'Close');
  assert.equal(classes.has('is-open'), true);

  keydown({ key: 'Escape' });
  assert.equal(button.expanded, 'false');
  assert.equal(button.textContent, 'Menu');
  assert.equal(classes.has('is-open'), false);
  assert.equal(button.focused, true);

  listeners.get('toggle:click')();
  listeners.get('link:click')();
  assert.equal(button.expanded, 'false');
  assert.equal(classes.has('is-open'), false);
});
