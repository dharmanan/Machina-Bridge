import assert from 'node:assert/strict'
import { handleArcEurcMarkets, normalizeArcEurcMarkets } from '../api/_lib/borrow-eurc-markets.js'
import { ARC_VERIFIED_ASSETS } from '../api/_lib/arc-intelligence/assets.js'
const asset = symbol => ARC_VERIFIED_ASSETS.find(x=>x.symbol===symbol&&x.chainId===5042)
const loan=asset('EURC'),collateral=asset('cirBTC')
const id='0x'+'ab'.repeat(32)
const payload={data:{markets:{items:[{
  marketId:id,loanAsset:{symbol:loan.symbol,address:loan.address,decimals:loan.decimals},
  collateralAsset:{symbol:collateral.symbol,address:collateral.address,decimals:collateral.decimals},
  lltv:0.86,state:{borrowApy:0.021,utilization:0.9,liquidityAssets:'123456789'}
}]}}}
const markets=normalizeArcEurcMarkets(payload)
assert.equal(markets.length,1)
assert.equal(markets[0].loanAsset.symbol,'EURC')
assert.equal(markets[0].liquidity.amount,'123.456789')
assert.equal(markets[0].protocol,'morpho')
assert.throws(()=>normalizeArcEurcMarkets({data:{markets:{items:[...payload.data.markets.items,...payload.data.markets.items]}}}))
const fake=structuredClone(payload)
fake.data.markets.items[0].loanAsset.address='0x'+'cd'.repeat(20)
assert.equal(normalizeArcEurcMarkets(fake).length,0)
const calls=[]
const send=value=>value
const response=await handleArcEurcMarkets({method:'GET',send,fetchImpl:async (url,opts)=>{
  calls.push({url,method:opts.method,body:opts.body})
  return {status:200,text:async()=>JSON.stringify(payload)}
}})
assert.equal(response.status,200)
assert.equal(JSON.parse(response.body).executionAvailable,false)
assert.match(calls[0].url,/api.morpho.org/)
assert.match(calls[0].body,/5042/)
assert.equal((await handleArcEurcMarkets({method:'POST',send})).status,405)
assert.equal((await handleArcEurcMarkets({method:'GET',query:{url:'evil'},send})).status,400)
const fail=await handleArcEurcMarkets({method:'GET',send,fetchImpl:async()=>({status:502})})
assert.equal(fail.status,503)
const source=await import('node:fs').then(fs=>fs.readFileSync(new URL('../src/components/MainnetBorrow.tsx',import.meta.url),'utf8'))
assert.match(source,/<EurcMarkets state=\{eurcMarkets\}/)
assert.match(source,/<MarketOwnership market=\{market\}/)
assert.match(source,/EURC loan execution in Machina remains disabled/)
console.log('EURC Morpho read-only discovery and owner/curator labeling PASS')
