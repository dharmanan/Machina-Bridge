import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { createPool, createRepository } from './db.js';
import { migrate } from './migrate.js';
import { createIndexer, readConfig } from './indexer.js';
import { createHttpServer, parseAllowedOrigins } from './http.js';
import { sanitizedErrorCode } from './read-model.js';
import { readRuntimeConfig } from './runtime-config.js';
import { createA2Runtime } from './a2-runtime.js';
import { createArcRpcClient } from '../../api/_lib/arc-intelligence/rpc.js';

export function tickDelayMs(result, pollMs) {
  return result.status === 'indexing' ? 500 : pollMs;
}

export function indexingFailureMessage(result) {
  const range = Number.isSafeInteger(result.startBlock) && Number.isSafeInteger(result.endBlock)
    && result.startBlock >= 0 && result.endBlock >= result.startBlock
    ? `${result.startBlock}..${result.endBlock} ` : '';
  return `Arc Intelligence indexing degraded: ${range}${sanitizedErrorCode(result.error) ?? 'core_incomplete'}`;
}

export async function runIndexerLoop({ indexer, pollMs, signal, sleepImpl = sleep, log = console.error }) {
  while (!signal.aborted) {
    const result = await indexer.tick();
    if (signal.aborted) break;
    if (result.status === 'degraded') log(indexingFailureMessage(result));
    try { await sleepImpl(tickDelayMs(result, pollMs), undefined, { signal }); } catch { break; }
  }
}

export async function start(env = process.env, dependencies = {}) {
  const config = readConfig(env);
  const runtimeConfig = readRuntimeConfig(env);
  const deps = {createPool,createRepository,migrate,createIndexer,createHttpServer,createA2Runtime,
    log:console.log,fetchImpl:globalThis.fetch,...dependencies};
  const allowedOrigins = parseAllowedOrigins(env.INTELLIGENCE_ALLOWED_ORIGINS);
  const pool = deps.createPool(env.DATABASE_URL);
  const controller = new AbortController();
  let server;
  try {
    await deps.migrate(pool);
    const repository = deps.createRepository(pool);
    server = deps.createHttpServer({ repository, allowedOrigins, runtimeMode: runtimeConfig.mode });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, '0.0.0.0', resolve);
    });
    server.on('error', () => { console.error('Intelligence HTTP server unavailable'); controller.abort(); });
    deps.log(`Arc Intelligence runtime mode: ${runtimeConfig.mode}`);
    let loop;
    if (runtimeConfig.mode === 'a1') {
      // Preserve A1 retries/data semantics, but stop active transport and future starts on shutdown.
      const rpc = createArcRpcClient({fetchImpl:(url,init) => {
        if (controller.signal.aborted) throw new Error('operation_aborted');
        return deps.fetchImpl(url,{...init,signal:AbortSignal.any([controller.signal,init.signal])});
      }});
      const indexer = deps.createIndexer({repository,config,rpc});
      loop = runIndexerLoop({indexer,pollMs:config.pollMs,signal:controller.signal});
    } else {
      const runtime = deps.createA2Runtime({pool,config:runtimeConfig,finalityBlocks:config.finalityBlocks});
      loop = runtime.run({signal:controller.signal});
    }
    let stopping;
    const stop = () => stopping ??= (async () => {
      controller.abort();
      await new Promise((resolve) => server.close(resolve));
      try { await loop; } finally { await pool.end(); }
    })();
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
