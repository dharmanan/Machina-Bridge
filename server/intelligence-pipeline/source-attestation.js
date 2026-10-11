// Explicit public-chain source inspection only; this never activates a registry or indexer.
import { keccak256, Interface } from 'ethers';
import { hash, fail, assertHeapBudget } from './storage.js';
const ADDRESS = /^0x[0-9a-f]{40}$/;
const HASH = /^0x[0-9a-f]{64}$/;
const tag = n => '0x' + n.toString(16);
export async function attestPublishedDeployment(provider, { contract, abi, provenance, observationBlock }) {
  assertHeapBudget();
  const a = contract?.address?.toLowerCase(), n = contract?.blockNumber;
  if (!ADDRESS.test(a ?? '') || !Number.isSafeInteger(n) || n < 1
    || !Number.isSafeInteger(observationBlock) || observationBlock < n
    || !HASH.test(contract.transactionHash ?? '') || !Array.isArray(abi)
    || hash(JSON.stringify(abi)) !== contract.abiSha256
    || !provenance?.officialUrl?.startsWith('https://')
    || !/^[0-9a-f]{64}$/.test(provenance?.manifestSha256 ?? '')) fail('published_source_invalid');
  const request = async (method, params) => {
    if (!provider.canContinue()) fail('bounded_run_yield');
    return provider.request(method, params);
  };
  const receipt = await request('eth_getTransactionReceipt', [contract.transactionHash]);
  if (!receipt || receipt.transactionHash?.toLowerCase() !== contract.transactionHash
    || receipt.status !== '0x1' || Number(receipt.blockNumber) !== n || !HASH.test(receipt.blockHash ?? '')) {
    const actualBlock = Number(receipt?.blockNumber);
    throw Object.assign(new Error('published_deployment_receipt_mismatch'), { code: 'published_deployment_receipt_mismatch',
      diagnostics: { expectedBlock: n, actualBlock: Number.isSafeInteger(actualBlock) ? actualBlock : null,
        receiptPresent: !!receipt, receiptSucceeded: receipt?.status === '0x1' } });
  }
  const block = await request('eth_getBlockByNumber', [tag(n), false]);
  if (block?.hash !== receipt.blockHash || Number(block.number) !== n || !block.transactions?.includes(contract.transactionHash))
    fail('published_deployment_canonical_mismatch');
  const before = await request('eth_getCode', [a, tag(n - 1)]);
  const first = await request('eth_getCode', [a, tag(n)]);
  const observed = await request('eth_getCode', [a, tag(observationBlock)]);
  if (before !== '0x') fail('published_validity_start_not_proven');
  if (![first, observed].every(v => typeof v === 'string' && /^0x(?:[0-9a-f]{2})+$/i.test(v))) fail('published_contract_absent');
  if (contract.runtimeCodeHash && keccak256(first) !== contract.runtimeCodeHash) fail('published_runtime_code_mismatch');
  const iface = new Interface(abi), views = {};
  // Metadata is identity evidence only, never an invented USD price or an issuer classification.
  for (const name of ['symbol', 'decimals']) if (iface.hasFunction(name)) {
    const data = iface.encodeFunctionData(name, []);
    const response = await request('eth_call', [{ to: a, data }, tag(observationBlock)]);
    const value = iface.decodeFunctionResult(name, response)[0];
    if (name === 'decimals' && (!Number.isInteger(Number(value)) || Number(value) < 0 || Number(value) > 36)) fail('published_metadata_invalid');
    if (name === 'symbol' && (typeof value !== 'string' || !value.trim() || value.length > 64)) fail('published_metadata_invalid');
    views[name] = { value: typeof value === 'bigint' ? value.toString() : value,
      block: observationBlock, responseSha256: hash(response) };
  }
  return { address: a, chainId: 5042, provenance, abiSha256: contract.abiSha256,
    status: 'historical_code_presence_verified', validFromBlock: n, validFromTimestamp: Number(block.timestamp),
    deploymentTransaction: contract.transactionHash, deploymentBlockHash: block.hash,
    deploymentTransactionAddressLink: receipt.contractAddress?.toLowerCase() === a ? 'direct_creation' : 'official_manifest_only',
    deploymentCodeHash: keccak256(first), observationCodeHash: keccak256(observed), views,
    events: iface.fragments.filter(f => f.type === 'event').map(f => ({ signature: f.format('sighash'), topic: f.topicHash })),
    // ABI publication and on-chain presence do not prove implementation/source equivalence or proxy immutability.
    registryActivated: false, unresolved: contract.runtimeCodeHash ? ['proxy_or_upgrade_history_not_audited']
      : ['runtime_source_equivalence_not_proven', 'proxy_or_upgrade_history_not_audited'] };
}
