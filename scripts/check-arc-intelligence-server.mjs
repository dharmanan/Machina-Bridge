import { readdir, readFile } from 'node:fs/promises';
import { MIGRATIONS } from '../server/arc-intelligence/migrate.js';

// ESM imports parse the backend and its engine dependencies without startup side effects.
for (const file of await readdir(new URL('../server/arc-intelligence/', import.meta.url))) {
  if (file.endsWith('.js')) await import(new URL(`../server/arc-intelligence/${file}`, import.meta.url));
}
for (const migration of MIGRATIONS) await readFile(new URL(`../server/arc-intelligence/sql/${migration}.sql`, import.meta.url), 'utf8');
console.log('INTELLIGENCE_BACKEND_IMPORT_CHECK: PASS');
