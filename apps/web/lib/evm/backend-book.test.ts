import test from 'node:test';
import assert from 'node:assert/strict';
import { readBackendBook } from './backend-book';
const url='https://avensdex-api.sgp.appwrite.run';
const frame=()=>({type:'snapshot',streamId:'fixture',marketId:1,seq:3,observedAt:1000,data:{marketId:1,seq:3,streamId:'fixture',settlement:'unavailable',bids:[{price18:'7500000000000000000',size6:'1250000',orders:1}],asks:[],bestBid:'7500000000000000000',bestAsk:null}});
test('Appwrite depth converts actual integer units without claiming confirmed fills',async()=>{
 const data=await readBackendBook(url,async()=>Response.json(frame()),1000);
 assert.deepEqual(data.bids,[{price:'7.5',size:'1.25'}]);assert.equal(data.timestamp,1000000);assert.equal(data.provisional,true);
});
test('unconfigured, foreign, stale or malformed backend state is unavailable, not fabricated depth',async()=>{
 await assert.rejects(readBackendBook('https://evil.example',async()=>{throw Error('must not fetch');},1000),/TARGET/);
 await assert.rejects(readBackendBook(url,async()=>Response.json(frame()),1061),/SNAPSHOT/);
 const invalid=frame();invalid.data.bids[0]!.size6='0';await assert.rejects(readBackendBook(url,async()=>Response.json(invalid),1000),/LEVEL/);
 await assert.rejects(readBackendBook(url,async()=>new Response('unavailable',{status:503}),1000),/UNAVAILABLE/);
});
