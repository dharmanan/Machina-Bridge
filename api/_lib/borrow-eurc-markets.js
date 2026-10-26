// Arc Morpho EURC discovery is read-only. No live EURC Borrow execution is authorized.
import { ARC_VERIFIED_ASSETS } from './arc-intelligence/assets.js'
const known = symbol => ARC_VERIFIED_ASSETS.find(x => x.chainId === 5042 && x.symbol === symbol)
const EURC = known('EURC'), CIRBTC = known('cirBTC')
const QUERY = 'query MachinaArcEurc { markets(first: 100, where: { chainId_in: [5042] }) { items { marketId lltv loanAsset { address symbol decimals } collateralAsset { address symbol decimals } state { borrowApy utilization liquidityAssets } } } }'
const MARKET_ID = /^0x[0-9a-fA-F]{64}$/
const sameAsset = (asset, target) => Boolean(asset && target && asset.address?.toLowerCase() === target.address.toLowerCase() && asset.symbol === target.symbol && asset.decimals === target.decimals)
const unitRatio = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null
function liquidity(raw) {
  if (typeof raw !== 'number' && typeof raw !== 'string') return null
  const n = String(raw)
  if (!/^\d{1,78}$/.test(n)) return null
  const b = BigInt(n), d = BigInt(EURC.decimals), base = 10n ** d
  const fraction = (b % base).toString().padStart(EURC.decimals,'0').replace(/0+$/,'')
  return { token:EURC.symbol, tokenAddress:EURC.address, decimals:EURC.decimals, amount:(b/base).toString() + (fraction ? '.'+fraction : '') }
}
export function normalizeArcEurcMarkets(payload) {
  if (!EURC || !CIRBTC || payload?.errors?.length) throw new Error('morpho_invalid')
  const items = payload?.data?.markets?.items
  if (!Array.isArray(items) || items.length > 100) throw new Error('morpho_invalid')
  const result=[]
  for (const item of items) {
    if (!sameAsset(item?.collateralAsset,CIRBTC) || !sameAsset(item?.loanAsset,EURC)) continue
    if (!MARKET_ID.test(item.marketId) || typeof item.lltv !== 'number' || !Number.isFinite(item.lltv) || item.lltv <= 0 || item.lltv >= 1) throw new Error('morpho_invalid')
    result.push({
      marketId:item.marketId, protocol:'morpho',
      collateralAsset:{symbol:CIRBTC.symbol,address:CIRBTC.address,decimals:CIRBTC.decimals},
      loanAsset:{symbol:EURC.symbol,address:EURC.address,decimals:EURC.decimals},
      lltv:item.lltv,borrowApy:unitRatio(item.state?.borrowApy),utilization:unitRatio(item.state?.utilization),
      liquidity:liquidity(item.state?.liquidityAssets),borrowAssets:null,refreshedAt:null,
    })
  }
  const ids=result.map(m=>m.marketId.toLowerCase())
  if (new Set(ids).size!==ids.length) throw new Error('morpho_duplicate')
  return result.sort((a,b)=>a.marketId.toLowerCase().localeCompare(b.marketId.toLowerCase()))
}
const answer = (send,status,data) => send({status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':status===200?'public, s-maxage=60':'no-store'},body:JSON.stringify(data)})
export async function handleArcEurcMarkets({method,query={},send,fetchImpl=fetch}) {
  if(method!=='GET') return answer(send,405,{error:'Method not allowed'})
  if(query && Object.keys(query).length) return answer(send,400,{error:'Unsupported request'})
  const controller=new AbortController()
  const timer=setTimeout(()=>controller.abort(),8000)
  try{
    const response=await fetchImpl('https://api.morpho.org/graphql',{method:'POST',headers:{'accept':'application/json','content-type':'application/json'},redirect:'error',body:JSON.stringify({query:QUERY}),signal:controller.signal})
    if(response.status!==200) return answer(send,503,{error:'EURC market unavailable'})
    const raw=await response.text()
    if(raw.length>131072) return answer(send,503,{error:'EURC market unavailable'})
    const markets=normalizeArcEurcMarkets(JSON.parse(raw))
    if(!markets.length) return answer(send,503,{error:'EURC market unavailable'})
    return answer(send,200,{schema:'machina.borrow.eurc.v1',chain:'Arc',markets,executionAvailable:false})
  }catch{return answer(send,503,{error:'EURC market unavailable'})}
  finally{clearTimeout(timer)}
}
