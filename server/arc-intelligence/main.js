import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { createPool, createRepository } from './db.js';
import { migrate } from './migrate.js';
import { createIndexer, readConfig } from './indexer.js';
import { createHttpServer, parseAllowedOrigins } from './http.js';

export async function start(env = process.env) {
  const config = readConfig(env);
  const allowedOrigins = parseAllowedOrigins(env.INTELLIGENCE_ALLOWED_ORIGINS);
  const pool = createPool(env.DATABASE_URL);
  const controller = new AbortController();
  let server;
  try {
    await migrate(pool);
    const repository = createRepository(pool);
    const indexer = createIndexer({ repository, config });
    server = createHttpServer({ repository, allowedOrigins });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, '0.0.0.0', resolve);
    });
    server.on('error', () => { console.error('Intelligence HTTP server unavailable'); controller.abort(); });
    console.log('Arc Intelligence backend listening');
    const loop = (async () => {
      while (!controller.signal.aborted) {
        const result = await indexer.tick();
        if (result.status === 'degraded') console.error('Arc Intelligence indexing degraded; checkpoint retained');
        if (controller.signal.aborted) break;
        try { await sleep(config.pollMs, undefined, { signal: controller.signal }); } catch { break; }
      }
    })();
    const stop = async () => {
      controller.abort();
      await new Promise((resolve) => server.close(resolve));
      await loop;
      await pool.end();
    };
    return { server, stop };
  } catch (error) {
    server?.close();
    await pool.end();
    throw error;
  }
}

// Import checks and deterministic tests never start a server or open a DB.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().then(({ stop }) => {
    let stopping = false;
    const shutdown = () => {
      if (stopping) return;
      stopping = true;
      stop().catch(() => { console.error('Intelligence shutdown failed'); process.exitCode = 1; });
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  }).catch(() => { console.error('Intelligence startup failed; check backend configuration and database availability'); process.exitCode = 1; });
}
