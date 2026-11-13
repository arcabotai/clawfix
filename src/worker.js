import { httpServerHandler } from 'cloudflare:node';

import { ensureDBReady, getPool } from './db.js';
import { setRuntimeEnv } from './runtime-env.js';
import { cleanupSharedState } from './shared-state.js';
import { app } from './server.js';

const WORKER_PORT = 3000;
app.listen(WORKER_PORT);
const expressHandler = httpServerHandler({ port: WORKER_PORT });

export default {
  async fetch(request, env, context) {
    setRuntimeEnv(env);
    const initialized = await ensureDBReady();
    let response = initialized
      ? await expressHandler.fetch(request, env, context)
      : Response.json(
          { error: 'Database unavailable' },
          { status: 503, headers: { 'Cache-Control': 'no-store' } },
        );
    const versionId = env.CF_VERSION_METADATA?.id;
    if (typeof versionId === 'string' && versionId) {
      // Reuse the untouched stream and response init, including status/headers.
      // Cloning the response headers also supports immutable upstream responses.
      response = new Response(response.body, response);
      response.headers.set('X-ClawFix-Version-ID', versionId);
    }
    return response;
  },
  async scheduled(_controller, env, _context) {
    setRuntimeEnv(env);
    if (!await ensureDBReady()) throw new Error('Database unavailable during shared-state cleanup');
    await cleanupSharedState({ db: getPool() });
  },
};
