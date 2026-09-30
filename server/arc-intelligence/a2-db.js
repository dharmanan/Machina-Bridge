export async function withTransaction(pool, work) {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { broken = true; }
    throw error;
  } finally { client.release(broken); }
}

export async function requireWorkLease(client, lease) {
  if (!lease || !/^\d+$/.test(String(lease.id)) || !/^\d+$/.test(String(lease.fencing_token))
    || typeof lease.lease_owner !== 'string' || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(lease.lease_owner)) throw new Error('stale_lease');
  const row = (await client.query(`/* a2:lease_guard */ SELECT * FROM arc_intelligence_work
    WHERE id=$1 AND state='leased' AND lease_owner=$2 AND fencing_token=$3 AND lease_until > now() FOR UPDATE`,
  [lease.id,lease.lease_owner,lease.fencing_token])).rows[0];
  if (!row) throw new Error('stale_lease');
  return row;
}
