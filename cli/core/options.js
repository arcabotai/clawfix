export function parseCliOptions(argv, env) {
  const args = [...argv];
  const serverArgIndex = args.indexOf('--server');
  const inlineServerArg = args.find(arg => arg.startsWith('--server='));
  const serverArg = inlineServerArg?.slice('--server='.length)
    || (serverArgIndex >= 0 && !args[serverArgIndex + 1]?.startsWith('-') ? args[serverArgIndex + 1] : '');
  const rawApiUrl = serverArg || env.CLAWFIX_API || 'https://clawfix.dev';
  let apiUrl = rawApiUrl;
  let apiUrlError = '';
  try {
    const parsedApiUrl = new URL(rawApiUrl);
    if (!['http:', 'https:'].includes(parsedApiUrl.protocol)) throw new Error('must use http or https');
    apiUrl = parsedApiUrl.href.replace(/\/$/, '');
  } catch (error) {
    apiUrlError = `Invalid ClawFix API URL: ${error.message}`;
  }

  const serverValueMissing = (serverArgIndex >= 0 || inlineServerArg) && !serverArg;
  let validation = Object.freeze({ ok: true });
  if (serverValueMissing) {
    validation = Object.freeze({
      ok: false,
      type: 'missing-server',
      message: 'Missing value for --server',
      exitCode: 2,
    });
  } else if (apiUrlError) {
    validation = Object.freeze({
      ok: false,
      type: 'invalid-server',
      message: apiUrlError,
      exitCode: 2,
    });
  }

  const dryRun = args.includes('--dry-run') || args.includes('-n');
  const noSend = args.includes('--no-send') || args.includes('--local-only');
  const showData = args.includes('--show-data') || args.includes('-d');
  const autoSend = env.CLAWFIX_AUTO === '1' || args.includes('--yes') || args.includes('-y');
  const showHelp = args.includes('--help') || args.includes('-h');
  const showVersion = args.includes('--version') || args.includes('-v') || args.includes('-V');
  const jsonOnly = args.includes('--json');
  const localOnly = dryRun || noSend || jsonOnly;
  const oneShot = args.includes('--scan') || args.includes('--no-interactive') || showData || localOnly;

  return Object.freeze({
    apiUrl,
    apiToken: env.CLAWFIX_API_TOKEN || '',
    validation,
    dryRun,
    noSend,
    showData,
    autoSend,
    showHelp,
    showVersion,
    jsonOnly,
    localOnly,
    oneShot,
  });
}
