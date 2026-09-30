import { readFile } from 'node:fs/promises';

export async function migrate(pool) {
  const sql = await readFile(new URL('./sql/001_init.sql', import.meta.url), 'utf8');
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(5042, 177002)');
    await client.query(sql);
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { broken = true; }
    throw error;
  } finally {
    client.release(broken);
  }
}
