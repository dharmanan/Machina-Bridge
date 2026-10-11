// API-only acceptance worker. Isolated lab marker required; never an arbitrary production SQLite path.
import {openPipeline,assertHeapBudget} from '../server/intelligence-pipeline/storage.js';
import {createPipelineApiPublication} from '../server/intelligence-pipeline/api-publication.js';
import {createIntelligenceServer} from '../server/compact/http.js';
const [path,clock]=process.argv.slice(2);
if(!path?.startsWith('/tmp/arc-api-real-')||!/^\d+$/.test(clock??''))throw Error('isolated_api_lab_required');
const p=openPipeline({path}),api=createPipelineApiPublication(p),model=api.readModel({now:()=>Number(clock)});
let peakHeap=process.memoryUsage().heapUsed;
const timer=setInterval(()=>{peakHeap=Math.max(peakHeap,process.memoryUsage().heapUsed);},5);timer.unref();
const server=createIntelligenceServer({readModel:model});
server.on('request',(_,res)=>res.on('finish',()=>{peakHeap=Math.max(peakHeap,process.memoryUsage().heapUsed);}));
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
console.log(JSON.stringify({origin:`http://127.0.0.1:${server.address().port}`,heapBudget:assertHeapBudget()}));
await new Promise(resolve=>{process.stdin.once('data',resolve);process.stdin.once('end',resolve);});
server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));model.close();clearInterval(timer);p.close();
console.log(JSON.stringify({apiOnly:true,sampledHeapHighWaterBytes:peakHeap,maxRSSBytes:process.resourceUsage().maxRSS*1024,
 heapBudget:assertHeapBudget(),productionAccess:false}));
