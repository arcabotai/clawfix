#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_BASE_URL = 'https://clawfix.dev';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const PACKAGE_VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

function invariant(value, message) {
  if (!value) throw new Error(message);
}

function safeMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, ' ').slice(0, 500);
}

async function requestText(fetchImpl, url, options, { label, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(url, { ...options, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`${label} timed out after ${timeoutMs}ms`);
      }
      throw new Error(`${label} request failed: ${safeMessage(error)}`);
    }
    invariant(response && typeof response.text === 'function', `${label} returned an invalid response`);
    invariant(response.ok, `${label} returned HTTP ${response.status}`);
    const text = await response.text();
    invariant(Buffer.byteLength(text, 'utf8') <= MAX_RESPONSE_BYTES, `${label} response was too large`);
    return { response, text };
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

export function parseSseEvents(raw) {
  const events = [];
  const frames = String(raw).replace(/\r\n/g, '\n').split(/\n\n+/);
  for (const frame of frames) {
    if (!frame.trim()) continue;
    let event = 'message';
    const data = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (data.length === 0) continue;
    const payload = data.join('\n');
    try {
      events.push({ event, data: JSON.parse(payload) });
    } catch {
      throw new Error(`invalid SSE JSON for ${event}`);
    }
  }
  return events;
}

export function parseVerifierArgs(argv) {
  const parsed = {
    baseUrl: DEFAULT_BASE_URL,
    expectedVersion: PACKAGE_VERSION,
    meteredMode: 'none',
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  let agent = false;
  let diagnose = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--base-url') parsed.baseUrl = argv[++index];
    else if (arg === '--expected-version') parsed.expectedVersion = argv[++index];
    else if (arg === '--timeout-ms') parsed.timeoutMs = Number.parseInt(argv[++index], 10);
    else if (arg === '--agent-canary') agent = true;
    else if (arg === '--diagnose-canary') diagnose = true;
    else if (arg === '--help' || arg === '-h') {
      throw new Error(
        'usage: verify-production [--base-url URL] [--expected-version X.Y.Z] '
        + '[--timeout-ms N] [--agent-canary | --diagnose-canary]',
      );
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  invariant(typeof parsed.baseUrl === 'string' && parsed.baseUrl.length > 0, '--base-url requires a value');
  invariant(
    typeof parsed.expectedVersion === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(parsed.expectedVersion),
    '--expected-version requires a semantic version',
  );
  invariant(Number.isSafeInteger(parsed.timeoutMs) && parsed.timeoutMs > 0, '--timeout-ms must be a positive integer');
  invariant(!(agent && diagnose), '--agent-canary and --diagnose-canary are mutually exclusive');
  if (agent) parsed.meteredMode = 'agent';
  if (diagnose) parsed.meteredMode = 'diagnose';
  return parsed;
}

async function verifyFreeSurface({ baseUrl, expectedVersion, fetchImpl, timeoutMs }) {
  const requestOptions = { label: '', timeoutMs };
  const [rootResult, healthResult, statsResult, installerResult, installerHashResult] = await Promise.all([
    requestText(fetchImpl, `${baseUrl}/`, { headers: { accept: 'text/html' } }, {
      ...requestOptions,
      label: 'root',
    }),
    requestText(fetchImpl, `${baseUrl}/api/health`, { headers: { accept: 'application/json' } }, {
      ...requestOptions,
      label: 'health',
    }),
    requestText(fetchImpl, `${baseUrl}/api/stats`, { headers: { accept: 'application/json' } }, {
      ...requestOptions,
      label: 'stats',
    }),
    requestText(fetchImpl, `${baseUrl}/install`, { headers: { accept: 'text/plain' } }, {
      ...requestOptions,
      label: 'installer',
    }),
    requestText(fetchImpl, `${baseUrl}/install/sha256`, { headers: { accept: 'application/json' } }, {
      ...requestOptions,
      label: 'installer hash',
    }),
  ]);

  invariant(/ClawFix/i.test(rootResult.text), 'root did not contain the ClawFix product marker');

  const health = parseJson(healthResult.text, 'health');
  invariant(health?.status === 'ok', `health status was ${String(health?.status)}`);
  invariant(Number.isFinite(Date.parse(health?.timestamp)), 'health timestamp was invalid');

  const stats = parseJson(statsResult.text, 'stats');
  invariant(
    stats?.version === expectedVersion,
    `expected version ${expectedVersion}, received ${String(stats?.version)}`,
  );
  invariant(Number.isFinite(Number(stats?.totalDiagnoses)), 'stats totalDiagnoses was invalid');

  const hashDocument = parseJson(installerHashResult.text, 'installer hash');
  const advertisedHash = hashDocument?.sha256;
  invariant(typeof advertisedHash === 'string' && /^[a-f0-9]{64}$/i.test(advertisedHash), 'installer hash was invalid');
  const calculatedHash = createHash('sha256').update(installerResult.text).digest('hex');
  invariant(calculatedHash === advertisedHash, 'installer SHA-256 mismatch');
  const headerHash = installerResult.response.headers?.get?.('x-script-sha256');
  invariant(headerHash === advertisedHash, 'installer response header SHA-256 mismatch');

  return [
    { name: 'root', ok: true },
    { name: 'health', ok: true, status: health.status },
    { name: 'stats', ok: true, version: stats.version },
    { name: 'installer', ok: true, sha256: calculatedHash },
  ];
}

async function verifyAgentCanary({ baseUrl, fetchImpl, timeoutMs, apiToken }) {
  const conversationId = randomUUID();
  const headers = { accept: 'text/event-stream', 'content-type': 'application/json' };
  if (apiToken) headers.authorization = `Bearer ${apiToken}`;
  const result = await requestText(fetchImpl, `${baseUrl}/api/v2/agent/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      conversationId,
      message: 'ClawFix continuity canary. Reply with one short sentence and do not propose a repair.',
      availableRepairs: [],
    }),
  }, { label: 'agent canary', timeoutMs });
  invariant(
    result.response.headers?.get?.('content-type')?.includes('text/event-stream'),
    'agent canary did not return SSE',
  );
  const events = parseSseEvents(result.text);
  const meta = events.find((event) => event.event === 'agent.meta');
  const deltas = events.filter((event) => event.event === 'assistant.delta');
  const done = events.find((event) => event.event === 'agent.done');
  invariant(meta?.data?.conversationId === conversationId, 'agent canary metadata did not match the conversation');
  invariant(deltas.some((event) => typeof event.data?.text === 'string' && event.data.text.length > 0), 'agent canary returned no assistant text');
  invariant(done?.data?.conversationId === conversationId, 'agent canary did not complete');
  return { name: 'agent-canary', ok: true, sseEvents: events.length };
}

async function verifyDiagnosisCanary({ baseUrl, fetchImpl, timeoutMs, apiToken, canaryToken }) {
  invariant(canaryToken, 'CLAWFIX_CANARY_TOKEN is required for --diagnose-canary');
  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
    'x-clawfix-canary': canaryToken,
  };
  if (apiToken) headers.authorization = `Bearer ${apiToken}`;
  const result = await requestText(fetchImpl, `${baseUrl}/api/diagnose`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      system: { os: 'clawfix-continuity-canary', arch: 'x64' },
      openclaw: { version: 'canary', processExists: true, portListening: true },
      service: { manager: 'synthetic', state: 'running', exitCode: 0 },
      logs: { errors: '', sigtermCount: 0, errLogSizeMB: 0 },
      _localIssues: [],
    }),
  }, { label: 'diagnosis canary', timeoutMs });
  const diagnostic = parseJson(result.text, 'diagnosis canary');
  invariant(typeof diagnostic?.fixId === 'string' && diagnostic.fixId.length >= 10, 'diagnosis canary returned no fix ID');
  invariant(typeof diagnostic?.analysis === 'string' && diagnostic.analysis.length > 0, 'diagnosis canary returned no analysis');
  return { name: 'diagnosis-canary', ok: true, fixIdPresent: true };
}

export async function runProductionVerification({
  baseUrl = DEFAULT_BASE_URL,
  expectedVersion = PACKAGE_VERSION,
  meteredMode = 'none',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  apiToken = '',
  canaryToken = '',
  fetchImpl = globalThis.fetch,
} = {}) {
  invariant(typeof fetchImpl === 'function', 'fetch is unavailable');
  invariant(['none', 'agent', 'diagnose'].includes(meteredMode), `invalid metered mode: ${meteredMode}`);
  if (meteredMode === 'diagnose') {
    invariant(canaryToken, 'CLAWFIX_CANARY_TOKEN is required for --diagnose-canary');
  }

  const normalizedBaseUrl = new URL(baseUrl);
  invariant(['http:', 'https:'].includes(normalizedBaseUrl.protocol), 'base URL must use HTTP or HTTPS');
  normalizedBaseUrl.pathname = normalizedBaseUrl.pathname.replace(/\/$/, '');
  normalizedBaseUrl.search = '';
  normalizedBaseUrl.hash = '';
  const startedAt = new Date().toISOString();
  const checks = await verifyFreeSurface({
    baseUrl: normalizedBaseUrl.toString().replace(/\/$/, ''),
    expectedVersion,
    fetchImpl,
    timeoutMs,
  });

  if (meteredMode === 'agent') {
    checks.push(await verifyAgentCanary({
      baseUrl: normalizedBaseUrl.toString().replace(/\/$/, ''),
      fetchImpl,
      timeoutMs,
      apiToken,
    }));
  } else if (meteredMode === 'diagnose') {
    checks.push(await verifyDiagnosisCanary({
      baseUrl: normalizedBaseUrl.toString().replace(/\/$/, ''),
      fetchImpl,
      timeoutMs,
      apiToken,
      canaryToken,
    }));
  }

  return {
    ok: true,
    baseUrl: normalizedBaseUrl.origin,
    expectedVersion,
    meteredMode,
    startedAt,
    finishedAt: new Date().toISOString(),
    checks,
  };
}

async function main() {
  try {
    const options = parseVerifierArgs(process.argv.slice(2));
    const report = await runProductionVerification({
      ...options,
      apiToken: process.env.CLAWFIX_API_TOKEN || '',
      canaryToken: process.env.CLAWFIX_CANARY_TOKEN || '',
    });
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      error: safeMessage(error),
      finishedAt: new Date().toISOString(),
    }, null, 2));
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) await main();
