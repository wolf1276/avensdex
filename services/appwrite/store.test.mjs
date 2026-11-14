import test from 'node:test';
import assert from 'node:assert/strict';
import { appwriteStore } from './store.ts';
const config={endpoint:'https://sgp.cloud.appwrite.io/v1',projectId:'fixture',databaseId:'db',collectionId:'journal',apiKey:'public-test-placeholder'};
test('REST storage paginates deterministically and only creates immutable IDs', async()=>{
 const rows=Array.from({length:101},(_,i)=>({$id:String(i).padStart(8,'0'),payload:'{}'})); let posts=0,pages=0;
 const store=appwriteStore(config,async(url,options)=>{
  assert.equal(options.redirect,'error'); assert.equal(options.headers['X-Appwrite-Project'],'fixture');
  const u=new URL(url);
  if(options.method==='POST'){posts++;const b=JSON.parse(options.body);assert.equal(b.documentId,'00000101');assert.deepEqual(b.permissions,[]);return Response.json({$id:b.documentId,...b.data},{status:201});}
  if(u.search){pages++;const queries=u.searchParams.getAll('queries[]').map(JSON.parse);assert.equal(queries[0].attribute,'$id');const after=queries.find(q=>q.method==='cursorAfter');const start=after?Number(after.values[0])+1:0;return Response.json({total:101,documents:rows.slice(start,start+100)});}
  const found=rows.find(r=>r.$id===u.pathname.split('/').at(-1));return found?Response.json(found):Response.json({error:'missing'},{status:404});
 });
 assert.equal((await store.list()).length,101);assert.equal(pages,2);assert.equal((await store.get('00000000')).id,'00000000');assert.equal(await store.get('00000999'),null);
 await store.create({id:'00000101',payload:'{}'});assert.equal(posts,1);
});
test('REST storage refuses arbitrary credential endpoints, failed requests and oversized writes without retries',async()=>{
 assert.throws(()=>appwriteStore({...config,endpoint:'https://evil.example/v1'}),/ENDPOINT/);
 let calls=0;const store=appwriteStore(config,async()=>{calls++;return Response.json({error:'conflict'},{status:409});});
 await assert.rejects(store.create({id:'00000001',payload:'{}'}),/CONFLICT/);assert.equal(calls,1);
 await assert.rejects(store.create({id:'00000001',payload:'x'.repeat(32769)}));assert.equal(calls,1);
 const denied=appwriteStore(config,async()=>Response.json({documents:[{$id:'00000000',payload:'{}'},{$id:'00000000',payload:'{}'}],total:2}));
 await assert.rejects(denied.list(),/SEQUENCE/);
});
