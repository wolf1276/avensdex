import test from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, stringToHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createFunction } from './index.ts';
import { initializeDatabaseJournal } from '../clob/database-journal.ts';
import { digest } from '../../packages/clob/journal.ts';
import { orderTypedData } from '../../packages/clob/admission.ts';
const identity = { binding: { chainId: 43113, marketId: 1, settlementContract: `0x${'3'.repeat(40)}` }, deploymentId: `0x${'4'.repeat(64)}`, configDigest: digest('function fixture') };
async function setup() {
  const rows = new Map();
  const store = { list: async () => [...rows.values()].sort((a,b)=>a.id.localeCompare(b.id)).map(v=>structuredClone(v)),
    get: async id => structuredClone(rows.get(id) ?? null), create: async row => { if(rows.has(row.id))throw Error('CONFLICT');rows.set(row.id,structuredClone(row)); } };
  await initializeDatabaseJournal(store, identity, 'function-test');
  let gateReady = true;
  const runtime = { store, identity, gate: { check: async () => { if(!gateReady)throw Error('PAUSED');return {sourceTime:1000}; } },
    realtime: { endpoint:'https://sgp.cloud.appwrite.io/v1', projectId:'fixture', channel:'databases.test.collections.journal.documents' } };
  const call = async (path, method='GET', bodyText='', headers={}) => {
    const handle=createFunction(()=>runtime,()=>1000);
    return handle({ req:{path,method,bodyText,headers},res:{json:(body,status,headers)=>({body,status,headers})} });
  };
  return { call, rows, pause:()=>{gateReady=false;} };
}
test('Function cold starts share storage, expose realtime metadata and never claim settlement readiness', async () => {
  const {call,rows}=await setup();
  assert.equal((await call('/health')).status,200); assert.equal((await call('/ready')).status,503);
  assert.equal((await call('/snapshot')).body.data.orders.length,0); assert.equal((await call('/realtime')).body.projectId,'fixture');
  assert.equal((await call('/snapshot','GET','',{origin:'https://evil.example'})).status,403); assert.equal(rows.size,1);
});
test('Function uses real EIP-712 authentication and durable cold-start order state without a signer', async () => {
  const {call,rows,pause}=await setup();
  const signer=privateKeyToAccount(keccak256(stringToHex('public function fixture key')));
  const order={trader:signer.address.toLowerCase(),marketId:1,side:'buy',kind:'limit',size6:'1000000',limitPrice18:'2000000000000000000',leverage:2,maxFeeBps:3,nonce:'1',expiry:2000,reduceOnly:false,postOnly:false,ioc:false};
  const signature=await signer.signTypedData(orderTypedData(identity.binding,order,1000));
  const headers={'content-type':'application/json',origin:'https://avensdex.vercel.app'};
  const accepted=await call('/orders','POST',JSON.stringify({type:'order',order,signature}),headers);
  assert.equal(accepted.status,202);assert.equal(accepted.body.filled,false);assert.equal(rows.size,2);
  assert.equal((await call('/snapshot')).body.data.orders.length,1);
  const unsigned=await call('/orders','POST',JSON.stringify({type:'order',order}),headers);assert.equal(unsigned.status,503);assert.equal(rows.size,2);
  pause();assert.equal((await call('/admission/ready')).status,503);
  assert.equal((await call('/orders','POST','x'.repeat(8193),headers)).status,413);
  assert.equal((await call('/orders','POST','{',headers)).status,400);assert.equal(rows.size,2);
});
