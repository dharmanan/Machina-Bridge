// Build the real Lambda with @vercel/node, then cold-load its standalone output in native Node ESM.
// No Vercel account, deployment, environment pull, live API/RPC, wallet or new app dependency.
// Supply an independently installed builder using VERCEL_NODE_BUILDER_PATH (module path).
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { cpSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('..', import.meta.url)), require = createRequire(import.meta.url)
const builderPath = process.env.VERCEL_NODE_BUILDER_PATH ?? require.resolve('@vercel/node')
const builderRequire = createRequire(resolve(builderPath))
const { build } = builderRequire(builderPath)
const { FileFsRef, FileBlob } = builderRequire('@vercel/build-utils')
const builderVersion = builderRequire('@vercel/node/package.json').version
const temporary = mkdtempSync(join(tmpdir(), 'machina-serverless-'))
const work = join(temporary, 'work'), bundle = join(temporary, 'lambda.func')
const dependencies = realpathSync(join(root, 'node_modules')), copied = new Set()
let count = 0
// Copy the installed runtime dependency closure, preserving nested versions. No install occurs.
// Avoid symlinks to the original checkout: missing bundle files must really fail at startup.
function copyPackage(directory) {
  directory = realpathSync(directory)
  if (copied.has(directory)) return
  copied.add(directory)
  const name = relative(dependencies, directory)
  assert.ok(name && !name.startsWith('..'), 'Dependency must belong to this installation')
  const destination = join(work, 'node_modules', name)
  mkdirSync(dirname(destination), { recursive: true }); cpSync(directory, destination, { recursive: true })
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'))), from = createRequire(join(directory, 'package.json'))
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    let entry
    try { entry = from.resolve(dependency + '/package.json') } catch { entry = from.resolve(dependency) }
    let base = dirname(entry)
    while (!existsSync(join(base, 'package.json')) || JSON.parse(readFileSync(join(base, 'package.json'))).name !== dependency) {
      const parent = dirname(base); assert.notEqual(parent, base, `Cannot resolve ${dependency}`); base = parent
    }
    copyPackage(base)
  }
}
const probe = `
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
let external = 0;
globalThis.fetch = async () => { external++; throw Error('external_network_forbidden'); };
const { default: handler } = await import('./api/uniswap-arc-preview.js');
const service = await import('./api/_lib/uniswap-arc-preview.js');
const policy = await import('./src/lib/uniswapArcPolicy.js');
const mode = process.argv[2];
if (mode === 'archive') {
  for (const symbol of ['EURC', 'cirBTC']) {
    const raw = JSON.parse(readFileSync('./USDC-' + symbol + '.json', 'utf8'));
    const request = { chainId: 5042, tokenIn: 'USDC', tokenOut: symbol, amount: '1', owner: raw.swapTransaction.from,
      recipient: raw.swapTransaction.from, slippageBps: 50, minimumOutput: '1', maxNetworkFee: '100000000000000000' };
    const evidence = service.inspectCapturedArcQuote(raw, request);
    assert.equal(evidence.evidenceStatus, 'ECONOMICS_VERIFIED_ARCHIVE');
    assert.equal(evidence.liveEligible, false); assert.equal(evidence.executionBound, false);
  }
} else {
  const result = { headers: {} };
  const res = { setHeader(k, v) { result.headers[k] = v; }, status(n) { result.status = n; return res; }, json(body) { result.body = body; } };
  const raw = JSON.parse(readFileSync('./USDC-EURC.json', 'utf8'));
  const body = { chainId: 5042, tokenIn: 'USDC', tokenOut: 'EURC', amount: '1', owner: raw.swapTransaction.from,
    recipient: raw.swapTransaction.from, slippageBps: 50, minimumOutput: '1', maxNetworkFee: '100000000000000000' };
  await handler({ method: mode === 'method' ? 'GET' : 'POST', headers: { origin: mode === 'origin' ? 'https://other.test' : 'https://machinabridge.xyz', 'content-type': 'application/json' }, body }, res);
  if (mode === 'origin') { assert.equal(result.status, 403); assert.equal(result.body.error, 'preview_origin_blocked'); }
  else if (mode === 'method') assert.equal(result.status, 405);
  else if (mode === 'missing-key') { assert.equal(result.status, 503); assert.equal(result.body.error, 'uniswap_arc_review_blocked'); }
  else {
    assert.equal(result.status, 503); assert.equal(result.body.error, 'uniswap_arc_public_preview_disabled');
    assert.equal(result.headers['X-Uniswap-Preview-Status'], 'public-disabled'); assert.equal(result.body.executionBound, false);
  }
}
assert.equal(policy.UNISWAP_ARC_WRITES_ENABLED, true);
await assert.rejects(policy.submitUniswapArcSwap(), /writes_disabled/);
assert.equal(external, 0);
console.log('PASS native ESM cold start: ' + mode + '; zero external calls');
`
try {
  const names = ['package.json', 'tsconfig.json', 'tsconfig.node.json', 'tsconfig.uniswap-arc.json', 'api/tsconfig.json',
    'api/uniswap-arc-preview.ts', 'api/_lib/uniswap-arc-preview.ts', 'src/lib/uniswapArcPolicy.ts']
  const files = {}
  for (const name of names) {
    const target = join(work, name); mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(root, name), target)
    files[name] = new FileFsRef({ fsPath: target })
  }
  for (const name of ['viem', 'typescript', '@types/node']) copyPackage(join(dependencies, name))
  const { output } = await build({ files, entrypoint: 'api/uniswap-arc-preview.ts', workPath: work,
    meta: { skipDownload: true }, config: { zeroConfig: true, functions: { 'api/uniswap-arc-preview.ts': { installCommand: '' } } } })
  assert.equal(output.type, 'Lambda'); assert.equal(output.handler, 'api/uniswap-arc-preview.js')
  for (const name of ['api/uniswap-arc-preview.js', 'api/_lib/uniswap-arc-preview.js', 'src/lib/uniswapArcPolicy.js']) assert.ok(output.files[name], `Missing Lambda file: ${name}`)
  for (const [name, file] of Object.entries(output.files)) {
    assert.ok(!name.startsWith('/') && !name.split('/').includes('..'))
    const target = join(bundle, name); mkdirSync(dirname(target), { recursive: true })
    const blob = await FileBlob.fromStream({ stream: file.toStream() }); writeFileSync(target, blob.data)
  }
  for (const name of ['api/uniswap-arc-preview.js', 'api/_lib/uniswap-arc-preview.js']) {
    const source = readFileSync(join(bundle, name), 'utf8')
    for (const match of source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      assert.ok(match[1].endsWith('.js'), `Not a fully specified ESM import: ${match[1]}`)
      assert.ok(existsSync(resolve(dirname(join(bundle, name)), match[1])), `Untraced import: ${match[1]}`)
    }
  }
  assert.equal(JSON.parse(readFileSync(join(bundle, 'package.json'))).type, 'module')
  writeFileSync(join(bundle, '.vc-config.json'), JSON.stringify({ runtime: output.runtime, handler: output.handler }))
  writeFileSync(join(bundle, 'probe.mjs'), probe)
  for (const symbol of ['EURC', 'cirBTC']) copyFileSync(join(root, 'scripts/fixtures/uniswap-arc/USDC-' + symbol + '.json'), join(bundle, 'USDC-' + symbol + '.json'))
  count++; console.log(`PASS real @vercel/node ${builderVersion} traces and emits complete ESM Lambda graph (${Object.keys(output.files).length} files)`)
  for (const [mode, target, enabled] of [['preview', 'preview', 'true'], ['default', 'production', ''], ['disabled', 'production', 'false'],
    ['origin', 'production', 'true'], ['missing-key', 'production', 'true'], ['method', 'preview', 'true'], ['archive', 'preview', 'true']]) {
    const result = spawnSync(process.execPath, [join(bundle, 'probe.mjs'), mode], { cwd: bundle, encoding: 'utf8', timeout: 30000,
      env: { ...process.env, NODE_ENV: 'production', VERCEL: '1', VERCEL_ENV: target, UNISWAP_ARC_PREVIEW_ENABLED: enabled,
        UNISWAP_ARC_ALLOWED_ORIGIN: 'https://machinabridge.xyz', UNISWAP_TRADING_API_KEY: '' } })
    assert.equal(result.status, 0, `${mode} cold start failed:\n${result.stdout}\n${result.stderr}`)
    process.stdout.write(result.stdout); count++
  }
  console.log(`${count} serverless packaging/native ESM checks PASS on ${process.version}. Local Lambda artifact, not a live Vercel deployment.`)
} finally { rmSync(temporary, { recursive: true, force: true }) }
