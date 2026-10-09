// Only transient failures are retried automatically. The durable family reason is the circuit breaker:
// service restarts do not erase deterministic failures, and no hour/family evidence is deleted.
const TRANSIENT = new Set(['rpc_error', 'transport', 'invalid_response', 'contract_code_unavailable', 'family_not_processed']);
export function familyRetryPolicy(reason) {
  if (reason === 'rate_limited' || reason === 'provider_rate_limited') return { eligible: true, cooldownMs: 4 * 3_600_000 };
  if (TRANSIENT.has(reason)) return { eligible: true, cooldownMs: 3_600_000 };
  return { eligible: false, reason: reason ?? 'unclassified_failure', requires: 'verified_dependency_or_explicit_operator_repair' };
}
