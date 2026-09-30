CREATE TABLE IF NOT EXISTS arc_intelligence_state (
  id smallint PRIMARY KEY CHECK (id = 1),
  chain_id integer NOT NULL,
  source text NOT NULL,
  next_block bigint CHECK (next_block >= 0),
  last_indexed_block bigint,
  last_indexed_hash text,
  latest_arc_head bigint,
  safe_head bigint,
  last_success_at timestamptz,
  last_attempt_at timestamptz,
  last_error text,
  status text NOT NULL DEFAULT 'starting',
  engine_versions jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS arc_intelligence_chunks (
  start_block bigint NOT NULL CHECK (start_block >= 0),
  end_block bigint NOT NULL CHECK (end_block >= start_block),
  start_hash text NOT NULL,
  end_hash text NOT NULL,
  start_timestamp bigint NOT NULL,
  end_timestamp bigint NOT NULL,
  block_count integer NOT NULL CHECK (block_count = end_block - start_block + 1),
  transaction_count integer NOT NULL CHECK (transaction_count >= 0),
  receipt_count integer NOT NULL CHECK (receipt_count = transaction_count),
  protocol_coverage jsonb NOT NULL,
  compact_metrics jsonb NOT NULL,
  warnings jsonb NOT NULL,
  indexed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (start_block, end_block)
);

CREATE TABLE IF NOT EXISTS arc_intelligence_latest (
  id smallint PRIMARY KEY CHECK (id = 1),
  payload jsonb NOT NULL,
  block_number bigint NOT NULL,
  block_hash text NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS arc_intelligence_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  start_block bigint NOT NULL,
  end_block bigint NOT NULL,
  success boolean,
  error text
);
