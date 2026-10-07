// Shared P1A/P8 adapter support. Keep the compact import graph repository-only; the full P1A snapshot/decoder is separate.
import { defineEvent, encodeCall, decodeResult } from '../../../../server/compact/abi.js';
import { keccak256 } from '../../../../server/compact/keccak.js';

export const LAUNCHPADS_DEFINITION_VERSION = 'arc-intelligence-launchpads-v1';
const WORD = /^0x[0-9a-f]{64}$/i;
const declarationOf = abi => `event ${abi.name}(${abi.inputs.map(input =>
  `${input.type}${input.indexed ? ' indexed' : ''} ${input.name}`).join(', ')})`;
const eventTopic = abi => defineEvent(declarationOf(abi)).topic;

// Same ABI-item shape as the original parsed declarations; do not expose compact decoder-only fields to P1A.
export function eventAbi(declaration) {
  const event = defineEvent(declaration);
  return { name: event.name, type: 'event', inputs: event.inputs.map(input => ({
    type: input.type, name: input.name, ...(input.indexed ? { indexed: true } : {}),
  })) };
}

// These four official adapters use only zero-argument, single-word uint256/address views.
// Preserve the existing view decoder's address result (last 20 bytes, EIP-55), including diagnostic casing.
async function readView(rpc, address, signature, functionName, args, blockTag) {
  const match = /^function (\w+)\(\) view returns \((uint256|address)\)$/.exec(signature);
  if (!match || match[1] !== functionName || args.length) return null;
  try {
    const result = await rpc.request('eth_call', [{ to: address, data: encodeCall(`${functionName}()`) }, blockTag]);
    if (!WORD.test(result ?? '')) return null;
    if (match[2] === 'uint256') return decodeResult(['uint256'], result)?.[0] ?? null;
    const lower = result.slice(-40).toLowerCase();
    const hash = keccak256(lower).slice(2);
    return `0x${[...lower].map((char, index) => parseInt(hash[index], 16) >= 8 ? char.toUpperCase() : char).join('')}`;
  } catch {
    return null;
  }
}

// Same code/topic/view decisions and result shape as the existing P1A verifier, shared rather than importing its snapshot.
export async function verifyFactory(candidate, adapter, rpc, blockTag) {
  const topic = eventTopic(adapter.abi);
  let codePresent = null;
  let eventTopicInBytecode = false;
  try {
    const code = await rpc.request('eth_getCode', [candidate.address, blockTag]);
    if (typeof code !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(code)) throw new Error('Malformed code response');
    codePresent = code.length > 2 && !/^0x0+$/.test(code.toLowerCase());
    eventTopicInBytecode = codePresent && code.toLowerCase().includes(topic.slice(2));
  } catch {
    // Transient RPC failures must stay unavailable, never rejected.
  }
  const viewValue = adapter.view && codePresent && eventTopicInBytecode
    ? await readView(rpc, candidate.address, adapter.view.signature, adapter.view.functionName, [], blockTag)
    : null;
  const viewVerified = !adapter.view || adapter.view.verify(viewValue);
  const verified = codePresent === true && eventTopicInBytecode && viewVerified;
  return {
    ...candidate, status: verified ? 'verified' : 'unavailable',
    codePresent, eventTopic: topic, eventTopicInBytecode,
    viewResult: typeof viewValue === 'bigint' ? viewValue.toString(10) : viewValue,
    viewVerified, eventScanComplete: false, malformedEventCount: 0,
    verificationReason: verified ? null : codePresent === null ? 'code_read_unavailable'
      : !codePresent ? 'code_absent_at_requested_end'
        : !eventTopicInBytecode ? 'official_event_topic_not_in_bytecode' : 'required_view_unavailable_or_mismatch',
  };
}
