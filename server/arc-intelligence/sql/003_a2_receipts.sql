ALTER TABLE arc_intelligence_blocks ADD COLUMN IF NOT EXISTS transactions_complete boolean NOT NULL DEFAULT false;
ALTER TABLE arc_intelligence_blocks ADD COLUMN IF NOT EXISTS receipt_bulk_attempted boolean NOT NULL DEFAULT false;
ALTER TABLE arc_intelligence_blocks ADD COLUMN IF NOT EXISTS receipt_evidence_conflict boolean NOT NULL DEFAULT false;
ALTER TABLE arc_intelligence_blocks ADD CONSTRAINT arc_receipts_require_transactions
  CHECK (NOT receipt_complete OR (transactions_complete AND NOT receipt_evidence_conflict));
CREATE UNIQUE INDEX IF NOT EXISTS arc_blocks_identity_idx ON arc_intelligence_blocks (chain_id,block_number,block_hash);

CREATE TABLE IF NOT EXISTS arc_intelligence_transactions (
  chain_id integer NOT NULL,
  block_number bigint NOT NULL,
  block_hash text NOT NULL,
  transaction_index integer NOT NULL CHECK (transaction_index >= 0),
  transaction_hash text NOT NULL CHECK (transaction_hash ~ '^0x[0-9a-f]{64}$'),
  from_address text NOT NULL CHECK (from_address ~ '^0x[0-9a-f]{40}$'),
  to_address text CHECK (to_address IS NULL OR to_address ~ '^0x[0-9a-f]{40}$'),
  value_raw text NOT NULL CHECK (value_raw ~ '^(0|[1-9][0-9]*)$'),
  input_selector text CHECK (input_selector IS NULL OR input_selector ~ '^0x[0-9a-f]{8}$'),
  PRIMARY KEY (chain_id,transaction_hash),
  UNIQUE (chain_id,block_number,transaction_index),
  UNIQUE (chain_id,block_number,block_hash,transaction_index,transaction_hash),
  FOREIGN KEY (chain_id,block_number,block_hash) REFERENCES arc_intelligence_blocks (chain_id,block_number,block_hash)
);

CREATE TABLE IF NOT EXISTS arc_intelligence_receipts (
  chain_id integer NOT NULL,
  block_number bigint NOT NULL,
  block_hash text NOT NULL,
  transaction_index integer NOT NULL,
  transaction_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('success','failed')),
  gas_used_raw text NOT NULL CHECK (gas_used_raw ~ '^(0|[1-9][0-9]*)$'),
  effective_gas_price_raw text CHECK (effective_gas_price_raw IS NULL OR effective_gas_price_raw ~ '^(0|[1-9][0-9]*)$'),
  contract_address text CHECK (contract_address IS NULL OR contract_address ~ '^0x[0-9a-f]{40}$'),
  PRIMARY KEY (chain_id,transaction_hash),
  UNIQUE (chain_id,block_number,block_hash,transaction_index,transaction_hash),
  FOREIGN KEY (chain_id,block_number,block_hash,transaction_index,transaction_hash)
    REFERENCES arc_intelligence_transactions (chain_id,block_number,block_hash,transaction_index,transaction_hash)
);
CREATE INDEX IF NOT EXISTS arc_receipts_block_idx ON arc_intelligence_receipts (chain_id,block_number,transaction_index);

CREATE TABLE IF NOT EXISTS arc_intelligence_logs (
  chain_id integer NOT NULL,
  block_number bigint NOT NULL,
  block_hash text NOT NULL,
  transaction_index integer NOT NULL,
  transaction_hash text NOT NULL,
  log_index integer NOT NULL CHECK (log_index >= 0),
  address text NOT NULL CHECK (address ~ '^0x[0-9a-f]{40}$'),
  topics text[] NOT NULL,
  data text NOT NULL CHECK (data ~ '^0x([0-9a-f]{2})*$'),
  removed boolean NOT NULL DEFAULT false CHECK (NOT removed),
  PRIMARY KEY (chain_id,block_number,log_index),
  FOREIGN KEY (chain_id,block_number,block_hash,transaction_index,transaction_hash)
    REFERENCES arc_intelligence_receipts (chain_id,block_number,block_hash,transaction_index,transaction_hash)
);
CREATE INDEX IF NOT EXISTS arc_logs_tx_idx ON arc_intelligence_logs (chain_id,transaction_hash,log_index);

CREATE TABLE IF NOT EXISTS arc_intelligence_reconciliation (
  chain_id integer NOT NULL,
  block_number bigint NOT NULL,
  block_hash text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('all_logs','transfer_logs')),
  definition_version text NOT NULL,
  receipt_log_count integer NOT NULL CHECK (receipt_log_count >= 0),
  queried_log_count integer CHECK (queried_log_count >= 0),
  missing_count integer CHECK (missing_count >= 0),
  extra_count integer CHECK (extra_count >= 0),
  duplicate_receipt_count integer NOT NULL CHECK (duplicate_receipt_count >= 0),
  duplicate_query_count integer NOT NULL CHECK (duplicate_query_count >= 0),
  identityless_receipt_count integer NOT NULL CHECK (identityless_receipt_count >= 0),
  identityless_query_count integer NOT NULL CHECK (identityless_query_count >= 0),
  payload_mismatch_count integer CHECK (payload_mismatch_count >= 0),
  query_complete boolean NOT NULL,
  complete boolean NOT NULL,
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^[0-9a-f]{64}$'),
  reason_code text CHECK (reason_code IS NULL OR reason_code IN ('query_unavailable','log_reconciliation_incomplete')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id,block_number,kind,definition_version),
  FOREIGN KEY (chain_id,block_number,block_hash) REFERENCES arc_intelligence_blocks (chain_id,block_number,block_hash),
  CHECK (NOT complete OR (query_complete AND queried_log_count IS NOT NULL AND queried_log_count=receipt_log_count
    AND missing_count IS NOT NULL AND missing_count=0 AND extra_count IS NOT NULL AND extra_count=0
    AND duplicate_receipt_count=0 AND duplicate_query_count=0 AND identityless_receipt_count=0 AND identityless_query_count=0
    AND payload_mismatch_count IS NOT NULL AND payload_mismatch_count=0 AND reason_code IS NULL))
);
CREATE INDEX IF NOT EXISTS arc_blocks_missing_receipts_idx ON arc_intelligence_blocks (chain_id,block_number)
  WHERE transactions_complete AND NOT receipt_complete AND NOT receipt_evidence_conflict;

CREATE INDEX IF NOT EXISTS arc_work_complete_retention_idx ON arc_intelligence_work (id DESC) WHERE state='complete';
