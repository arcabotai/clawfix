import assert from 'node:assert/strict';
import test from 'node:test';

import { requestAI } from '../src/ai.js';

const CONFIG = Object.freeze({
  provider: 'test',
  model: 'test-model',
  apiKey: 'test-key',
  baseUrl: 'https://provider.test/v1',
  maxTokens: 10,
  timeoutMs: 30_000,
});

test('requestAI composes caller cancellation with the provider timeout', async () => {
  const controller = new AbortController();
  let observedSignal = null;
  const request = requestAI({
    config: CONFIG,
    messages: [{ role: 'user', content: 'hello' }],
    signal: controller.signal,
    fetchImpl: async (_url, init) => {
      observedSignal = init.signal;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }, { once: true });
      });
    },
  });

  controller.abort();

  await assert.rejects(request, error => error?.name === 'AbortError');
  assert.equal(observedSignal?.aborted, true);
});
