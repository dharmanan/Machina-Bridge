import { normalizeBlock, normalizeAddress } from '../../api/_lib/arc-intelligence/normalize.js';
import { ARC_CHAIN_ID } from '../../api/_lib/arc-intelligence/rpc.js';
import { hash, manifestBlock, position } from './foundation.js';

export function transactionFacts(transaction, block) {
  const fact = { chain_id:ARC_CHAIN_ID,block_number:position(transaction.blockNumber),block_hash:hash(block.block_hash),
    transaction_index:position(transaction.transactionIndex),transaction_hash:hash(transaction.hash),
    from_address:normalizeAddress(transaction.from),to_address:normalizeAddress(transaction.to,{nullable:true}),
    value_raw:transaction.valueRaw,input_selector:transaction.inputSelector };
  if (fact.block_number !== block.block_number || fact.transaction_index > 2147483647
    || typeof fact.value_raw !== 'string' || !/^(0|[1-9][0-9]*)$/.test(fact.value_raw)
    || (fact.input_selector !== null && !/^0x[0-9a-f]{8}$/.test(fact.input_selector))) throw new Error('transaction_identity_conflict');
  return fact;
}

export function blockTransactions(input, block) {
  if (!Array.isArray(input.transactions) || input.transactions.length !== block.transaction_count) throw new Error('transaction_set_incomplete');
  const facts = input.transactions.map((transaction) => transactionFacts(transaction,block)).sort((a,b) => a.transaction_index-b.transaction_index);
  if (new Set(facts.map((t) => t.transaction_hash)).size !== facts.length
    || facts.some((t,i) => t.transaction_index !== i)) throw new Error('transaction_identity_conflict');
  return facts;
}

export function normalizeChainBlock(raw, requestedBlock) {
  const normalized = normalizeBlock(raw,ARC_CHAIN_ID);
  if (normalized.number !== requestedBlock) throw new Error('block_unavailable');
  const block = manifestBlock({ block_number:normalized.number,block_hash:normalized.hash,parent_hash:normalized.parentHash,
    timestamp:normalized.timestamp,transaction_count:normalized.transactionCount });
  if (raw.transactions.some((t) => t.blockHash != null && hash(t.blockHash) !== block.block_hash)) throw new Error('transaction_identity_conflict');
  const result = { ...block,transactions:normalized.transactions };
  blockTransactions(result,block);
  return result;
}

export async function persistTransactions(client, block, facts) {
  const old = (await client.query(`/* a2:transactions */ SELECT * FROM arc_intelligence_transactions
    WHERE chain_id=$1 AND (block_number=$2 OR transaction_hash=ANY($3::text[])) ORDER BY transaction_index`,
  [ARC_CHAIN_ID,block.block_number,facts.map((t) => t.transaction_hash)])).rows;
  for (const previous of old) {
    const next = facts.find((t) => t.transaction_hash === previous.transaction_hash);
    if (!next || Object.entries(next).some(([key,value]) => String(previous[key]) !== String(value))) throw new Error('transaction_identity_conflict');
  }
  for (const t of facts) {
    await client.query(`/* a2:transaction */ INSERT INTO arc_intelligence_transactions
      (chain_id,block_number,block_hash,transaction_index,transaction_hash,from_address,to_address,value_raw,input_selector)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (chain_id,transaction_hash) DO NOTHING`,Object.values(t));
  }
  const count = (await client.query(`/* a2:transaction_count */ SELECT count(*) AS count FROM arc_intelligence_transactions
    WHERE chain_id=$1 AND block_number=$2`,[ARC_CHAIN_ID,block.block_number])).rows[0].count;
  if (position(count) !== block.transaction_count) throw new Error('transaction_set_incomplete');
  await client.query(`/* a2:transactions_complete */ UPDATE arc_intelligence_blocks SET transactions_complete=true
    WHERE chain_id=$1 AND block_number=$2`,[ARC_CHAIN_ID,block.block_number]);
}
