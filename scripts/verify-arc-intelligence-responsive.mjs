// Node 24 + local Chromium, built frontend CSS and deterministic React fixtures only.
// No production requests, wallet access, database operations or third-party test packages.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = mkdtempSync(path.join(tmpdir(), 'machina-responsive-'));
const fixturePath = process.env.ARC_RESPONSIVE_EXISTING_FIXTURE ?? path.join(scratch, 'fixtures.json');
if (!process.env.ARC_RESPONSIVE_EXISTING_FIXTURE) execFileSync(process.execPath, ['scripts/verify-arc-intelligence-dashboard.mjs'], {
  cwd: root, env: { ...process.env, ARC_DASHBOARD_TEST_FILTER: 'Responsive fixture', ARC_DASHBOARD_RESPONSIVE_FIXTURE: fixturePath }, stdio: 'inherit',
});
const fixtures = JSON.parse(readFileSync(fixturePath, 'utf8'));
const cssPath = readdirSync(path.join(root, 'dist/assets')).find(name => /^index-.*\.css$/.test(name));
assert.ok(cssPath, 'run npm run build before responsive QA');
const css = readFileSync(path.join(root, 'dist/assets', cssPath));
const server = createServer((req, res) => {
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'self'; img-src data:");
  if (req.url === '/style.css') { res.setHeader('Content-Type', 'text/css'); res.end(css); return; }
  const name = new URL(req.url, 'http://localhost').searchParams.get('fixture');
  const fixture = fixtures.find(entry => entry.name === name);
  if (!fixture) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', 'text/html');
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body data-responsive-fixture="${fixture.name}"><main class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-10">${fixture.html}</main></body></html>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = spawn(process.env.CHROMIUM_BIN ?? 'chromium', ['--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars',
  '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${path.join(scratch, 'chrome')}`, 'about:blank'], { stdio: 'ignore' });
let socket;
const measurements = [];
try {
  let port;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { port = readFileSync(path.join(scratch, 'chrome/DevToolsActivePort'), 'utf8').split('\n')[0]; break; }
    catch { if (browser.exitCode !== null) throw new Error('Chromium exited before startup'); await delay(100); }
  }
  assert.ok(port, 'Chromium startup timed out');
  const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(entry => entry.type === 'page');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', ({ data }) => {
    const reply = JSON.parse(data), task = pending.get(reply.id);
    if (!task) return;
    pending.delete(reply.id); clearTimeout(task.timer);
    if (reply.error) task.reject(new Error(JSON.stringify(reply.error))); else task.resolve(reply.result);
  });
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 10000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await cdp('Page.enable');
  for (const width of [390, 430, 1280, 1440, 1920]) for (const fixture of fixtures) {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
    await cdp('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/?fixture=${fixture.name}` });
    await evaluate(`new Promise(resolve => { const ready = () => document.readyState === 'complete'
      ? document.fonts.ready.then(() => requestAnimationFrame(() => requestAnimationFrame(resolve))) : setTimeout(ready, 10); ready(); })`);
    const result = await evaluate(`(() => {
      const visible = node => {
        const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
        if (!rect.width || !rect.height || style.visibility === 'hidden' || style.clip !== 'auto') return false;
        const hidden = node.closest('.sr-only');
        if (hidden && getComputedStyle(hidden).clip !== 'auto') return false;
        const closed = node.closest('details:not([open])');
        return !closed || closed.querySelector('summary')?.contains(node);
      };
      const textRects = node => { const range = document.createRange(); range.selectNodeContents(node); return [...range.getClientRects()]; };
      const collisions = [];
      for (const amount of document.querySelectorAll('[data-usd-action]')) {
        const peers = [...amount.closest('dl').querySelectorAll('dt,dd')].filter(node => node !== amount);
        for (const peer of peers) for (const a of textRects(amount)) for (const b of textRects(peer)) {
          if (Math.min(a.right,b.right)-Math.max(a.left,b.left)>1 && Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1) collisions.push(amount.dataset.usdAction);
        }
      }
      const overflow = [];
      for (const node of document.querySelectorAll('[data-arc-intelligence] *')) {
        if (!visible(node)) continue;
        const rect = node.getBoundingClientRect();
        // Chart axis labels intentionally use zero-width absolute anchors; their bounds still must fit the viewport.
        if (node.scrollWidth > node.clientWidth + 1 && node.clientWidth && getComputedStyle(node).display !== 'inline'
          && getComputedStyle(node).position !== 'absolute'
          && !node.matches('span.relative.flex-1:has(> span.absolute.whitespace-nowrap)')
          && !node.classList.contains('truncate')) overflow.push({ tag:node.tagName, text:node.textContent.trim().slice(0,90), excess:node.scrollWidth-node.clientWidth });
        if (rect.right > innerWidth + 1 || rect.left < -1) overflow.push({ tag:node.tagName, text:node.textContent.trim().slice(0,90), outside:true });
      }
      for (const label of document.querySelectorAll('span.absolute.whitespace-nowrap')) {
        for (const peer of label.parentElement.parentElement.querySelectorAll('span.absolute.whitespace-nowrap')) {
          if (peer === label) continue;
          const a=label.getBoundingClientRect(),b=peer.getBoundingClientRect();
          if (Math.min(a.right,b.right)-Math.max(a.left,b.left)>1 && Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1)
            overflow.push({tag:'chart label',text:label.textContent,collision:true});
        }
      }
      const amounts = [...document.querySelectorAll('[data-usd-action]')].map(node => {
        const style = getComputedStyle(node);
        return {field:node.dataset.usdAction,micros:node.dataset.usdMicros,text:node.textContent,clipped:style.textOverflow==='ellipsis'||style.overflowX==='hidden',
          overflow:node.scrollWidth>node.clientWidth+1};
      });
      const headers = [];
      for (const heading of document.querySelectorAll('h4')) {
        const badge = heading.parentElement.parentElement.querySelector('[data-status-pill]');
        if (!badge || !visible(badge)) continue;
        const a=heading.getBoundingClientRect(),b=badge.getBoundingClientRect();
        if (Math.min(a.right,b.right)-Math.max(a.left,b.left)>1 && Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1) headers.push(heading.textContent);
      }
      return {renderedFixture:document.body.dataset.responsiveFixture,documentWidth:document.documentElement.scrollWidth,viewport:innerWidth,collisions,overflow,headers,amounts};
    })()`);
    const record = { width, fixture: fixture.name, ...result };
    assert.equal(record.renderedFixture, fixture.name, 'measure the newly navigated document');
    measurements.push(record);
    if (fixture.name === '30d') for (const section of ['lending', 'cross-chain', 'rwa-other']) {
      const clip = await evaluate(`(() => {const r=document.querySelector('[data-intel-section="${section}"]').getBoundingClientRect();return {x:r.x,y:r.y+scrollY,width:r.width,height:r.height,scale:1};})()`);
      const shot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip });
      writeFileSync(path.join(scratch, `${width}-${section}.png`), Buffer.from(shot.data, 'base64'));
    }
    const failures = record.collisions.length + record.overflow.length + record.headers.length + record.amounts.filter(row => row.clipped || row.overflow).length;
    console.log(`${failures ? 'FAIL' : 'PASS'} responsive ${fixture.name} ${width}px: ${record.collisions.length} USD collisions, ${record.overflow.length} overflow findings`);
    assert.deepEqual(record.amounts.map(({ field,micros,text }) => ({ field,micros,text })), fixture.usd, 'verified dollar values must remain exact');
  }
  writeFileSync(path.join(scratch, 'measurements.json'), JSON.stringify(measurements, null, 2));
  console.log(`Responsive artifacts: ${scratch}`);
  if (!process.env.ARC_RESPONSIVE_DIAGNOSTIC) for (const record of measurements) {
    assert.ok(record.documentWidth <= record.viewport, `${record.fixture} ${record.width}px document overflow`);
    assert.deepEqual(record.collisions, [], `${record.fixture} ${record.width}px USD text collisions`);
    assert.deepEqual(record.overflow, [], `${record.fixture} ${record.width}px overflowing elements`);
    assert.deepEqual(record.headers, [], `${record.fixture} ${record.width}px title/badge collisions`);
    assert.ok(record.amounts.every(row => !row.clipped && !row.overflow), 'amounts must never be clipped');
  }
} finally {
  socket?.close(); browser.kill('SIGTERM'); await new Promise(resolve => server.close(resolve));
}
