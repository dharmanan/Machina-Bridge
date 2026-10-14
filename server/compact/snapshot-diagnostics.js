// Internal, finite diagnostic vocabulary. Never return arbitrary messages, stacks, paths, SQL, or stderr text.
import { constants } from 'node:os';
const CODES = new Set([
  'snapshot_prepare_failed','snapshot_disk_budget','snapshot_size_limit','snapshot_invalid','snapshot_window_mismatch',
  'snapshot_inputs_changed','snapshot_write_failed','snapshot_checkpoint_changed','snapshot_already_started','snapshot_not_started',
  'snapshot_stage_timeout','snapshot_cancelled','snapshot_child_failed','snapshot_already_running','snapshot_read_timeout',
  'read_failed','not_ready','incompatible','inconsistent_state','invalid_path','sqlite_unavailable','invalid_busy_timeout',
  'unsupported_window','unsupported_protocol','invalid_range','invalid_time',
  'packed_value_type_invalid','packed_address_invalid','packed_piece_corrupt','packed_dataset_invalid',
  'packed_definition_mismatch','packed_binding_mismatch','packed_proof_mismatch','packed_pieces_corrupt',
  'packed_payload_corrupt','packed_rows_corrupt','packed_piece_too_large','packed_scope_mismatch','packed_set_conflict',
  'packed_payload_conflict','packed_readback_mismatch','packed_storage_blocked',
  'ERR_SQLITE_ERROR','ERR_STRING_TOO_LONG','ERR_BUFFER_TOO_LARGE','ERR_OUT_OF_RANGE','ERR_MEMORY_ALLOCATION_FAILED',
  'ENOMEM','EACCES','EPERM','ENOENT','EIO','EMFILE','ENFILE','EBUSY','EROFS','EDQUOT','ENOTDIR','EISDIR',
  'snapshot_range_error','snapshot_type_error','snapshot_syntax_error',
]);
const LEGACY_MESSAGES = new Set(['snapshot_inputs_changed','invalid_stage']);
const DETAILS = new Set([
  ...CODES, 'ENOSPC','invalid_stage','database_missing','database_empty','no_checkpoint','query_only_unavailable',
  'schema_tables_mismatch','schema_version_mismatch','family_unknown','family_definition_mismatch','family_version_missing',
  'checkpoint_not_contiguous','pool_registry_missing','pool_registry_metadata_malformed','pool_projection_malformed',
  'pool_tvl_malformed','packed_set_missing','packed_pool_swaps_inconsistent','token_price_malformed',
  'dex_volume_malformed','dex_volume_missing','dex_fee_malformed','dex_fee_missing','network_gas_malformed',
  'daily_active_addresses_malformed','map_size_limit','array_length_invalid','call_stack_limit',
  'SQLITE_ERROR','SQLITE_BUSY','SQLITE_LOCKED','SQLITE_NOMEM','SQLITE_READONLY','SQLITE_IOERR','SQLITE_CORRUPT',
  'SQLITE_FULL','SQLITE_CANTOPEN','SQLITE_SCHEMA','SQLITE_TOOBIG','SQLITE_CONSTRAINT','SQLITE_NOTADB',
]);
const SQLITE_DETAILS = new Map([[1,'SQLITE_ERROR'],[5,'SQLITE_BUSY'],[6,'SQLITE_LOCKED'],[7,'SQLITE_NOMEM'],
  [8,'SQLITE_READONLY'],[10,'SQLITE_IOERR'],[11,'SQLITE_CORRUPT'],[13,'SQLITE_FULL'],[14,'SQLITE_CANTOPEN'],
  [17,'SQLITE_SCHEMA'],[18,'SQLITE_TOOBIG'],[19,'SQLITE_CONSTRAINT'],[26,'SQLITE_NOTADB']]);
const RANGE_DETAILS = new Map([['Map maximum size exceeded','map_size_limit'],['Invalid array length','array_length_invalid'],
  ['Maximum call stack size exceeded','call_stack_limit']]);

export function safeSnapshotError(error) {
  let code = CODES.has(error?.code) ? error.code : LEGACY_MESSAGES.has(error?.message)
    ? error.message === 'invalid_stage' ? 'snapshot_prepare_failed' : error.message : 'snapshot_prepare_failed';
  let detail = DETAILS.has(error?.detail) ? error.detail : undefined;
  if (error?.code === 'ENOSPC') { code = 'snapshot_disk_budget'; detail ??= 'ENOSPC'; }
  if (code === 'snapshot_prepare_failed') {
    if (error?.name === 'RangeError') { code = 'snapshot_range_error'; detail ??= RANGE_DETAILS.get(error.message); }
    else if (error?.name === 'TypeError') code = 'snapshot_type_error';
    else if (error?.name === 'SyntaxError') code = 'snapshot_syntax_error';
  }
  if (!detail && error?.code === 'ERR_SQLITE_ERROR' && Number.isSafeInteger(error.errcode) && error.errcode >= 0)
    detail = SQLITE_DETAILS.get(error.errcode & 255);
  return { code, ...(detail ? { detail } : {}) };
}
export const safeExitCode = value => Number.isInteger(value) && value >= -255 && value <= 255 ? value : null;
export const safeExitSignal = value => value == null ? null : typeof value === 'string' && Object.hasOwn(constants.signals,value) ? value : 'unknown';

export const FATAL_TAIL_BYTES = 256;
const SCAN_CHUNK_BYTES = 4096;
export function createSnapshotFatalScanner() {
  let tail = '', marker = 'none';
  return {
    write(chunk) {
      if (marker === 'v8_heap_oom' || marker === 'v8_process_oom') return; // The pipe still drains via its data listener.
      const data = Buffer.isBuffer(chunk) ? chunk : typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.alloc(0);
      for (let offset=0;offset<data.length;offset+=SCAN_CHUNK_BYTES) {
        const text = tail + data.subarray(offset,offset+SCAN_CHUNK_BYTES).toString('latin1');
        if (/^FATAL ERROR:[^\r\n]{0,200}(?:heap out of memory|heap limit)/m.test(text)) marker='v8_heap_oom';
        else if (/^FATAL ERROR:[^\r\n]{0,200}process out of memory/m.test(text)) marker='v8_process_oom';
        else if (/^FATAL ERROR:/m.test(text)) marker='v8_fatal';
        tail = marker === 'v8_heap_oom' || marker === 'v8_process_oom' ? '' : text.slice(-FATAL_TAIL_BYTES);
        if (!tail) break;
      }
    },
    marker: () => marker,
    retainedBytes: () => tail.length,
  };
}
