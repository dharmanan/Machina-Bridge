// Compact engine: the protocol families after the Stage 1/2 ones, in result and storage order. Each definition is
// { name, version, streams, codeAddresses, fields, window, create }: targeted log streams (fixed official emitters, or
// topic-only with per-emitter proof), contracts whose code must exist at the hour's last block, the stored fields (all
// null when unavailable), what adds up across hours, and an accumulator factory.
// Launchpads are deliberately absent: see Stage 3 notes; no authoritative, bytecode-verified factory set exists yet.
import { ACROSS_FAMILY } from './across.js';
import { AAVE_V4_FAMILY } from './aave.js';
import { CCTP_FAMILY, GATEWAY_FAMILY } from './circle.js';
import { MORPHO_BLUE_FAMILY, MORPHO_VAULTS_V2_FAMILY } from './morpho.js';

export const PROTOCOL_FAMILIES = Object.freeze([CCTP_FAMILY, GATEWAY_FAMILY, ACROSS_FAMILY, AAVE_V4_FAMILY, MORPHO_BLUE_FAMILY,
  MORPHO_VAULTS_V2_FAMILY]);

const ADDRESS = /^0x[0-9a-f]{40}$/;
for (const family of PROTOCOL_FAMILIES) {
  const addresses = [...family.codeAddresses, ...family.streams.flatMap((stream) => stream.address ?? [])];
  if (!addresses.every((address) => ADDRESS.test(address)) || !family.streams.every((stream) => stream.topics.length > 0)) {
    throw new Error(`protocol_definition_invalid:${family.name}`);
  }
}
