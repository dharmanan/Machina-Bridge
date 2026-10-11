// Read verified log pieces once to produce the existing UI's exact pool, price-path, fee and activity inputs.
// No raw log persistence; incomplete units cannot publish. Activity is the existing capped projection, not full activity.
import { randomBytes } from 'node:crypto';
import { createProjectionSink, PROJECTION_VERSIONS, sha256Of, validPoolRow, validActivityRow, validV4Record,
  reconcilePoolRows, ACTIVITY_KINDS, ACTIVITY_ROWS_PER_KIND } from '../compact/projections.js';
import { validateLogs } from '../compact/logs.js';
import { LOG_STREAMS, logFilter } from '../compact/sources.js';
import { decodeV3Swap, decodeV3Mint, decodeV3Burn, decodeV4Swap, decodeV4Initialize, decodeV4ModifyLiquidity,
  UNISWAP_EVENT_TOPICS as T } from '../../api/_lib/arc-intelligence/uniswap.js';
import { mergePricePathRanges } from './price-path-merge.js';
import { hash, json, fail, readDefinition, assertHeapBudget } from './storage.js';
import {readDexUiHour} from './dex-ui-hour-store.js';
const MAX_SCRATCH = 32 * 1024 * 1024;
export function dexProjectionSource(protocol) {
  if (!['uniswap_v3','uniswap_v4'].includes(protocol)) fail('projection_protocol_invalid');
  return { id: protocol + '_ui_projection', definition: 'verified-dex-ui-projection-pieces-v1', chainId: 5042,
    protocol, projectionVersions: PROJECTION_VERSIONS, stream: LOG_STREAMS.find(s => s.key === (protocol === 'uniswap_v3' ? 'v3Pools' : 'v4')) };
}
export function createDexProjectionProcessor({ protocol, loadVerifiedBlock, isOfficialV3 } = {}) {
  const source = dexProjectionSource(protocol);
  if (typeof loadVerifiedBlock !== 'function' || protocol === 'uniswap_v3' && typeof isOfficialV3 !== 'function') fail('projection_verification_dependencies_missing');
  return async (job, provider) => {
    assertHeapBudget(); if (hash(job.spec.source) !== hash(source)) fail('projection_source_conflict');
    let cached;
    const window = { get(n) { if (cached?.number !== n) cached = loadVerifiedBlock(n); return cached; } };
    const raw = await provider.request('eth_getLogs',[logFilter(source.stream,job.first_block,job.last_block)]);
    if (!Array.isArray(raw) || raw.length >= 10000) fail('suspect_log_result_count');
    const logs = validateLogs(raw,source.stream,{fromBlock:job.first_block,toBlock:job.last_block,window,seen:new Set()});
    const sink = createProjectionSink({activity:true,activityLimit:ACTIVITY_ROWS_PER_KIND});
    const family = {status:'available',swapCount:0,mintCount:0,burnCount:0,initializeCount:0,modifyLiquidityCount:0}; let foreign = 0;
    const decode = protocol === 'uniswap_v3' ? new Map([[T.v3Swap,['swap',decodeV3Swap]],[T.v3Mint,['mint',decodeV3Mint]],[T.v3Burn,['burn',decodeV3Burn]]])
      : new Map([[T.v4Swap,['swap',decodeV4Swap]],[T.v4Initialize,['initialize',decodeV4Initialize]],[T.v4ModifyLiquidity,['modify',decodeV4ModifyLiquidity]]]);
    for (const log of logs) {
      if (protocol === 'uniswap_v3' && !isOfficialV3(log)) { foreign++; continue; }
      const [kind,decoder] = decode.get(log.topics[0]) ?? [], event = decoder?.(log);
      if (!event) fail('projection_event_unverified');
      family[kind === 'swap' ? 'swapCount' : kind === 'mint' ? 'mintCount' : kind === 'burn' ? 'burnCount' : kind === 'initialize' ? 'initializeCount' : 'modifyLiquidityCount']++;
      sink[protocol === 'uniswap_v3' ? 'v3' : 'v4'](kind,log,event,window);
    }
    // The sink reconciles both ledgers for activity. Its unused ledger is empty in this single-source reducer;
    // no unused protocol status escapes this piece and full API activity requires both source units later.
    const empty={status:'available',swapCount:0,mintCount:0,burnCount:0,initializeCount:0,modifyLiquidityCount:0};
    const finished = sink.finish({hourStart:job.spec.hourStart,firstBlock:job.first_block,lastBlock:job.last_block,
      families:{uniswapV3:protocol==='uniswap_v3'?family:empty,uniswapV4:protocol==='uniswap_v4'?family:empty}});
    const names = [protocol + '_pools',protocol + '_price_paths','dex_activity',...(protocol === 'uniswap_v4' ? ['uniswap_v4_swap_fees'] : [])];
    const projections = Object.fromEntries(names.map(name => [name,finished[name]]));
    if (Object.values(projections).some(value => value?.status !== 'available')) fail('projection_piece_unverified');
    return {summary:{format:'arc-reduced-source-v1',first:job.first_block,last:job.last_block,sourceKey:hash(source),anchorHash:job.spec.anchorHash,
      inputSha256:hash(logs),status:'verified',reason:null,counts:{received:logs.length,foreign,...Object.fromEntries(Object.entries(family).filter(([k])=>k!=='status'))},
      rows:[{kind:'verified_dex_ui_piece',protocol,family,projections,activityPolicy:{perKind:ACTIVITY_ROWS_PER_KIND,capped:true}}]}};
  };
}
export function deriveDexUiProjections(p, unitId) {
  assertHeapBudget(); if (p.coverage(unitId).status !== 'complete') fail('projection_hour_incomplete');
  if(p.getSeal(unitId)?.summary.format==='arc-dex-ui-hour-v1')return readDexUiHour(p,unitId);
  const unit = p.db.prepare('SELECT * FROM arc_pipeline_units WHERE unit_id=?').get(unitId), source = JSON.parse(readDefinition(unit.unit_json)).source;
  if (json(source) !== json(dexProjectionSource(source.protocol))) fail('projection_source_conflict');
  const protocol = source.protocol, prefix = 'ui_merge_' + randomBytes(8).toString('hex');
  p.db.exec(`CREATE TEMP TABLE ${prefix}_pools(pool TEXT PRIMARY KEY,row_json TEXT NOT NULL) STRICT,WITHOUT ROWID;
    CREATE TEMP TABLE ${prefix}_fees(pool TEXT PRIMARY KEY,row_json TEXT NOT NULL) STRICT,WITHOUT ROWID;
    CREATE TEMP TABLE ${prefix}_activity(block INTEGER,idx INTEGER,kind TEXT,row_json TEXT,PRIMARY KEY(block,idx)) STRICT,WITHOUT ROWID;
    CREATE TEMP TABLE ${prefix}_registry(pool TEXT PRIMARY KEY,row_json TEXT NOT NULL) STRICT,WITHOUT ROWID;`);
  const family={status:'available',swapCount:0,mintCount:0,burnCount:0,initializeCount:0,modifyLiquidityCount:0}; let scratch=0;
  const check = bytes => { scratch += bytes; if (scratch > MAX_SCRATCH) fail('projection_scratch_budget'); p.guard(scratch + 65536); };
  try {
    for (const summary of p.summaries(unitId)) {
      const piece = summary.rows[0];
      if (summary.rows.length !== 1 || piece?.kind !== 'verified_dex_ui_piece' || piece.protocol !== protocol
        || piece.activityPolicy?.perKind !== ACTIVITY_ROWS_PER_KIND || piece.activityPolicy.capped !== true) fail('projection_piece_invalid');
      for (const key of Object.keys(family).filter(k => k !== 'status')) {
        if (!Number.isSafeInteger(piece.family[key]) || piece.family[key] < 0) fail('projection_counts_invalid');
        family[key] += piece.family[key]; if (!Number.isSafeInteger(family[key])) fail('projection_counts_invalid');
      }
      const flows = piece.projections[protocol+'_pools'];
      if (flows.status !== 'available' || flows.rowsSha256 !== sha256Of(flows.registry ? {rows:flows.rows,registry:flows.registry} : {rows:flows.rows})
        || reconcilePoolRows(protocol+'_pools',flows.rows,piece.family,{initializeCount:flows.registry?.length ?? null})) fail('projection_piece_invalid');
      for (const row of flows.rows) {
        if (!validPoolRow(row,protocol)) fail('projection_piece_invalid');
        const old=p.db.prepare(`SELECT row_json FROM ${prefix}_pools WHERE pool=?`).get(row.pool); let value={...row};
        if (old) {value=JSON.parse(old.row_json);for(const [key,n]of Object.entries(row)) {
          if(key.endsWith('Count')) {value[key]+=n;if(!Number.isSafeInteger(value[key]))fail('projection_counts_invalid');}
          else if(key.endsWith('Raw')&&n!==null) {if(value[key]===null)fail('projection_piece_invalid');value[key]=(BigInt(value[key])+BigInt(n)).toString();}
          else if(key!=='pool'&&value[key]!==n)fail('projection_piece_invalid');
        }}
        const text=json(value); check(old ? Math.max(0,Buffer.byteLength(text)-Buffer.byteLength(old.row_json)) : Buffer.byteLength(text)+128);
        p.db.prepare(`INSERT INTO ${prefix}_pools VALUES(?,?) ON CONFLICT(pool) DO UPDATE SET row_json=excluded.row_json`).run(row.pool,text);
      }
      for(const row of flows.registry??[]) {
        if(!validV4Record(row))fail('projection_registry_invalid');const old=p.db.prepare(`SELECT row_json FROM ${prefix}_registry WHERE pool=?`).get(row.poolId);
        if(old&&old.row_json!==json(row))fail('projection_registry_conflict');if(!old)check(Buffer.byteLength(json(row))+128);
        p.db.prepare(`INSERT OR IGNORE INTO ${prefix}_registry VALUES(?,?)`).run(row.poolId,json(row));
      }
      const activity=piece.projections.dex_activity;
      if(activity.status!=='available'||activity.rowsSha256!==sha256Of({rows:activity.rows}))fail('projection_activity_invalid');
      for(const row of activity.rows) {
        if(!validActivityRow(row)||row.blockNumber<summary.first||row.blockNumber>summary.last)fail('projection_activity_invalid');
        const old=p.db.prepare(`SELECT row_json FROM ${prefix}_activity WHERE block=? AND idx=?`).get(row.blockNumber,row.logIndex);
        if(old&&old.row_json!==json(row))fail('projection_activity_conflict');
        p.db.prepare(`INSERT OR IGNORE INTO ${prefix}_activity VALUES(?,?,?,?)`).run(row.blockNumber,row.logIndex,row.kind,json(row));
      }
      for(const kind of ACTIVITY_KINDS)p.db.prepare(`DELETE FROM ${prefix}_activity WHERE kind=? AND (block,idx) NOT IN
        (SELECT block,idx FROM ${prefix}_activity WHERE kind=? ORDER BY block DESC,idx DESC LIMIT ?)`).run(kind,kind,ACTIVITY_ROWS_PER_KIND);
      if(protocol==='uniswap_v4')for(const row of piece.projections.uniswap_v4_swap_fees.rows) {
        if(row.swapCount<1||!Number.isSafeInteger(row.swapCount))fail('projection_fees_invalid');
        const old=p.db.prepare(`SELECT row_json FROM ${prefix}_fees WHERE pool=?`).get(row.pool);let value={...row};
        if(old){value=JSON.parse(old.row_json);value.swapCount+=row.swapCount;for(const key of ['feeIn0E6','feeIn1E6','feeOut0E12','feeOut1E12'])value[key]=(BigInt(value[key])+BigInt(row[key])).toString();}
        const text=json(value);check(old?Math.max(0,Buffer.byteLength(text)-Buffer.byteLength(old.row_json)):Buffer.byteLength(text)+128);
        p.db.prepare(`INSERT INTO ${prefix}_fees VALUES(?,?) ON CONFLICT(pool) DO UPDATE SET row_json=excluded.row_json`).run(row.pool,text);
      }
    }
    const rows=table=>p.db.prepare(`SELECT row_json FROM ${prefix}_${table} ORDER BY ${table==='activity'?'block DESC,idx DESC':'pool'}`).all().map(r=>JSON.parse(r.row_json));
    const wrap=values=>({status:'available',rows:values,rowsSha256:sha256Of({rows:values})});
    const poolRows=rows('pools'),registry=rows('registry');
    if(reconcilePoolRows(protocol+'_pools',poolRows,family,{initializeCount:protocol==='uniswap_v4'?registry.length:null}))fail('projection_hour_reconciliation_failed');
    const paths=[...mergePricePathRanges(p,(function*(){for(const summary of p.summaries(unitId)){
      const piece=summary.rows[0],value=piece.projections[protocol+'_price_paths'];
      if(value.status!=='available'||value.rowsSha256!==sha256Of({rows:value.rows}))fail('projection_price_path_invalid');
      yield {status:'available',firstBlock:summary.first,lastBlock:summary.last,swapCount:piece.family.swapCount,rows:value.rows};
    }})(),{protocol,firstBlock:unit.first_block,lastBlock:unit.last_block})];
    const projections={[protocol+'_pools']:{...wrap(poolRows),...(protocol==='uniswap_v4'?{registry,rowsSha256:sha256Of({rows:poolRows,registry})}:{})},[protocol+'_price_paths']:wrap(paths),dex_activity:wrap(rows('activity'))};
    if(protocol==='uniswap_v4')projections.uniswap_v4_swap_fees=wrap(rows('fees'));
    return {projections,family,unitId,activityCap:ACTIVITY_ROWS_PER_KIND,sourceKey:unit.source_key,canonical:{hour:unit.hour_start,first:unit.first_block,last:unit.last_block,hash:unit.anchor_hash}};
  } finally {for(const suffix of ['pools','fees','activity','registry'])p.db.exec(`DROP TABLE ${prefix}_${suffix}`);}
}
