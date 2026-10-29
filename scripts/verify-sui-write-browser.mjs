import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
const require=createRequire(import.meta.url)
let chromium;try{({chromium}=require('playwright-core'))}catch{({chromium}=require('/opt/codex/runtimes/cua/lib/node_modules/playwright-core'))}
const root=fileURLToPath(new URL('..',import.meta.url))
const server=await createServer({root,configFile:false,cacheDir:'/tmp/machina-sui-write-browser',plugins:[{name:'controlled-write-browser',configureServer(s){s.middlewares.use('/__sui-write',async(_req,res)=>{res.setHeader('content-type','text/html');res.end(await s.transformIndexHtml('/__sui-write','<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><script type="module" src="/scripts/fixtures/sui-write-lifecycle.ts"></script></body></html>'))})}}],server:{host:'127.0.0.1',port:0}})
let browser,passed=0;const errors=[],external=[]
async function test(name,fn){await fn();passed++;console.log('PASS '+name)}
try{
 await server.listen();const url=`http://127.0.0.1:${server.httpServer.address().port}/__sui-write`
 browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']})
 const context=await browser.newContext();await context.route('**/*',route=>{if(new URL(route.request().url()).hostname==='127.0.0.1')return route.continue();external.push(route.request().url());return route.abort()})
 const page=await context.newPage(),peer=await context.newPage()
 for(const p of[page,peer]){p.on('pageerror',e=>errors.push(e.message));await p.goto(url);await p.waitForFunction(()=>Boolean(window.suiWriteHarness))}
 const reset=async()=>{await page.evaluate(()=>localStorage.clear());for(const p of[page,peer]){await p.goto(url);await p.waitForFunction(()=>Boolean(window.suiWriteHarness))}}
 await test('real Chromium Web Locks exists; the production write gate is open only for the capped live test',async()=>{assert.equal(await page.evaluate(()=>Boolean(navigator.locks)),true);assert.equal(await page.evaluate(()=>window.suiWriteHarness.productionGate()),true);assert.equal(await page.evaluate(()=>window.suiWriteHarness.state.signatures),0)})
 await test('two actual browser tabs cannot overlap wallet preparation/confirmation even before a journal write',async()=>{
  for(const p of[page,peer])await p.evaluate(()=>window.suiWriteHarness.prepare())
  await page.evaluate(()=>{const h=window.suiWriteHarness;h.state.holdCheck=true;window.ongoing=h.confirm().then(()=> 'ok',e=>e.message)})
  await page.waitForFunction(()=>window.suiWriteHarness.state.checks===1)
  const result=await peer.evaluate(()=>window.suiWriteHarness.confirm().then(()=> 'UNSAFE',e=>e.message));assert.match(result,/Another tab/)
  assert.equal(await peer.evaluate(()=>window.suiWriteHarness.state.signatures),0)
  await page.evaluate(()=>window.suiWriteHarness.releaseCheck());assert.equal(await page.evaluate(()=>window.ongoing),'ok')
  assert.equal(await page.evaluate(()=>window.suiWriteHarness.state.broadcasts),1)
 })
 await test('pending journal survives reload, never restores a signature and blocks a second transfer',async()=>{
  await page.reload();await page.waitForFunction(()=>Boolean(window.suiWriteHarness))
  assert.equal(await page.evaluate(()=>window.suiWriteHarness.load().state),'pending')
  assert.equal(await page.evaluate(()=>window.suiWriteHarness.state.signatures),0)
  assert.match(await page.evaluate(()=>window.suiWriteHarness.prepare().then(()=> 'UNSAFE',e=>e.message)),/unresolved/)
  assert.equal(await page.evaluate(()=>Object.values(localStorage).some(x=>/CONTROLLED-NEVER-PERSIST|signature/.test(x))),false)
 })
 await test('recovery is read-only and retains the verified record without a second send',async()=>{assert.equal(await page.evaluate(async()=> (await window.suiWriteHarness.recover()).state),'verified');assert.equal(await page.evaluate(()=>window.suiWriteHarness.state.broadcasts),0)})
 await test('closing/reloading a tab with an unresolved sign request releases the lock but not the safety journal',async()=>{
  await reset();await page.evaluate(async()=>{const h=window.suiWriteHarness;await h.prepare();h.state.holdSign=true;window.ongoing=h.confirm().catch(e=>e.message)})
  await page.waitForFunction(()=>window.suiWriteHarness.state.signatures===1)
  await page.reload();await page.waitForFunction(()=>Boolean(window.suiWriteHarness))
  assert.equal(await peer.evaluate(()=>window.suiWriteHarness.load().state),'signing')
  assert.match(await peer.evaluate(()=>window.suiWriteHarness.prepare().then(()=> 'UNSAFE',e=>e.message)),/unresolved/)
  assert.equal(await peer.evaluate(()=>window.suiWriteHarness.state.broadcasts),0)
 })
 await test('a real tab switch is not authority to sign or send; context invalidation rejects a held wallet response',async()=>{
  await reset();await page.evaluate(async()=>{const h=window.suiWriteHarness;await h.prepare();h.state.holdSign=true;window.ongoing=h.confirm().catch(e=>e.message)})
  await page.waitForFunction(()=>window.suiWriteHarness.state.signatures===1);await peer.bringToFront();await page.bringToFront()
  assert.equal(await page.evaluate(()=>window.suiWriteHarness.state.broadcasts),0)
  await page.evaluate(()=>{const h=window.suiWriteHarness;h.state.current=false;h.invalidate();h.releaseSign()})
  assert.match(await page.evaluate(()=>window.ongoing),/needs checking/);assert.equal(await page.evaluate(()=>window.suiWriteHarness.state.broadcasts),0)
 })
 await test('missing real browser lock API fails closed with no wallet interaction',async()=>{await reset();await page.evaluate(()=>Object.defineProperty(navigator,'locks',{value:undefined,configurable:true}));await page.evaluate(()=>window.suiWriteHarness.prepare());assert.match(await page.evaluate(()=>window.suiWriteHarness.confirm().then(()=> 'UNSAFE',e=>e.message)),/cannot safely/);assert.equal(await page.evaluate(()=>window.suiWriteHarness.state.signatures),0)})
 assert.deepEqual(external,[]);assert.deepEqual(errors,[])
 console.log(`RESULT ${passed}/${passed} real Chromium two-tab lifecycle groups PASS; controlled signing ports only; external network and real wallet calls=0.`)
}finally{await browser?.close();await server.close()}
