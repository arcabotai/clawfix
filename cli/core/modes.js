const VERSION_MODE = Object.freeze({ kind: 'version' });
const HELP_MODE = Object.freeze({ kind: 'help' });
const ONE_SHOT_MODE = Object.freeze({ kind: 'one-shot' });
const INTERACTIVE_MODE = Object.freeze({ kind: 'interactive' });

export function resolveCliMode(parsed) {
  if (parsed.showVersion) return VERSION_MODE;
  if (parsed.showHelp) return HELP_MODE;
  if (!parsed.validation.ok) {
    return Object.freeze({ kind: 'error', error: parsed.validation });
  }
  if (parsed.oneShot) return ONE_SHOT_MODE;
  return INTERACTIVE_MODE;
}
