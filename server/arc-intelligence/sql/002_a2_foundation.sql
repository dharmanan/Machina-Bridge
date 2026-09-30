CREATE TABLE IF NOT EXISTS arc_intelligence_lanes (
  chain_id integer NOT NULL CHECK (chain_id = 5042),
  lane text NOT NULL,
  scope_id text NOT NULL,
  epoch text NOT NULL,
  definition_version text NOT NULL,
  origin_block bigint NOT NULL CHECK (origin_block >= 0),
  anchor_block bigint,
  anchor_hash text,
  anchor_next_block bigint NOT NULL,
  processed_through bigint,
  contiguous_complete_through bigint,
  checkpoint_hash text,
  observed_head bigint,
  status text NOT NULL DEFAULT 'starting' CHECK (status IN ('starting','indexing','caught_up','retrying','persistent_partial','continuity_error')),
  current_error_code text,
  last_success_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, lane, scope_id, epoch, definition_version),
  CHECK ((anchor_block IS NULL AND anchor_hash IS NULL) OR
    (anchor_block IS NOT NULL AND anchor_block >= 0 AND anchor_hash IS NOT NULL AND anchor_hash ~ '^0x[0-9a-f]{64}$')),
  CHECK (origin_block = anchor_next_block),
  CHECK (anchor_block IS NULL OR anchor_next_block = anchor_block + 1),
  CHECK (contiguous_complete_through IS NULL OR contiguous_complete_through >= origin_block),
  CHECK (processed_through IS NULL OR processed_through >= origin_block),
  CHECK (contiguous_complete_through IS NULL OR (processed_through IS NOT NULL AND processed_through >= contiguous_complete_through)),
  CHECK ((contiguous_complete_through IS NULL AND checkpoint_hash IS NULL) OR
    (contiguous_complete_through IS NOT NULL AND checkpoint_hash IS NOT NULL AND checkpoint_hash ~ '^0x[0-9a-f]{64}$')),
  CHECK (current_error_code IS NULL OR current_error_code IN ('rpc_head_unavailable','block_unavailable',
    'checkpoint_parent_hash_mismatch','manifest_conflict','database_unavailable','required_read_unavailable','unsupported_scope'))
);

CREATE TABLE IF NOT EXISTS arc_intelligence_blocks (
  chain_id integer NOT NULL CHECK (chain_id = 5042),
  block_number bigint NOT NULL CHECK (block_number >= 0),
  block_hash text NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
  parent_hash text NOT NULL CHECK (parent_hash ~ '^0x[0-9a-f]{64}$'),
  timestamp bigint NOT NULL CHECK (timestamp >= 0),
  transaction_count integer NOT NULL CHECK (transaction_count >= 0),
  receipt_count integer CHECK (receipt_count IS NULL OR (receipt_count >= 0 AND receipt_count <= transaction_count)),
  receipt_complete boolean NOT NULL DEFAULT false,
  all_log_reconciliation_complete boolean NOT NULL DEFAULT false,
  transfer_log_reconciliation_complete boolean NOT NULL DEFAULT false,
  core_complete boolean NOT NULL DEFAULT false,
  inserted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, block_number),
  CHECK (NOT receipt_complete OR (receipt_count IS NOT NULL AND receipt_count = transaction_count)),
  CHECK (NOT all_log_reconciliation_complete OR receipt_complete),
  CHECK (NOT transfer_log_reconciliation_complete OR receipt_complete),
  CHECK (NOT core_complete OR (receipt_complete AND all_log_reconciliation_complete AND transfer_log_reconciliation_complete))
);
CREATE INDEX IF NOT EXISTS arc_intelligence_blocks_time_idx ON arc_intelligence_blocks (chain_id, timestamp, block_number);

CREATE TABLE IF NOT EXISTS arc_intelligence_work (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chain_id integer NOT NULL,
  lane text NOT NULL,
  scope_id text NOT NULL,
  epoch text NOT NULL,
  definition_version text NOT NULL,
  component text NOT NULL CHECK (length(component) BETWEEN 1 AND 100),
  logical_key text NOT NULL CHECK (length(logical_key) BETWEEN 1 AND 200),
  start_block bigint NOT NULL CHECK (start_block >= 0),
  end_block bigint NOT NULL CHECK (end_block >= start_block AND end_block - start_block < 50),
  block_hash text CHECK (block_hash IS NULL OR block_hash ~ '^0x[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','leased','retrying','complete','failed','persistent_partial')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  not_before timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_until timestamptz,
  fencing_token bigint NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  reason_code text CHECK (reason_code IS NULL OR reason_code IN ('rpc_head_unavailable','block_unavailable',
    'checkpoint_parent_hash_mismatch','manifest_conflict','database_unavailable','required_read_unavailable','unsupported_scope')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain_id, lane, scope_id, epoch, definition_version, component, logical_key),
  FOREIGN KEY (chain_id, lane, scope_id, epoch, definition_version)
    REFERENCES arc_intelligence_lanes (chain_id, lane, scope_id, epoch, definition_version),
  CHECK (block_hash IS NULL OR start_block = end_block),
  CHECK ((state = 'leased' AND lease_owner IS NOT NULL AND lease_until IS NOT NULL) OR
    (state <> 'leased' AND lease_owner IS NULL AND lease_until IS NULL))
);
CREATE INDEX IF NOT EXISTS arc_intelligence_work_ready_idx ON arc_intelligence_work (not_before, id)
  WHERE state IN ('pending','retrying','leased');

CREATE TABLE IF NOT EXISTS arc_intelligence_coverage (
  chain_id integer NOT NULL,
  lane text NOT NULL,
  scope_id text NOT NULL,
  epoch text NOT NULL,
  definition_version text NOT NULL,
  start_block bigint NOT NULL CHECK (start_block >= 0),
  end_block bigint NOT NULL CHECK (end_block >= start_block AND end_block - start_block < 50),
  start_hash text NOT NULL CHECK (start_hash ~ '^0x[0-9a-f]{64}$'),
  end_hash text NOT NULL CHECK (end_hash ~ '^0x[0-9a-f]{64}$'),
  coverage_dimension text NOT NULL,
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN ('complete','partial')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, lane, scope_id, epoch, definition_version, coverage_dimension, start_block, end_block),
  FOREIGN KEY (chain_id, lane, scope_id, epoch, definition_version)
    REFERENCES arc_intelligence_lanes (chain_id, lane, scope_id, epoch, definition_version)
);
CREATE INDEX IF NOT EXISTS arc_intelligence_coverage_range_idx ON arc_intelligence_coverage
  (chain_id, lane, scope_id, epoch, definition_version, start_block, end_block);
