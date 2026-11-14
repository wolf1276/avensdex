import test from 'node:test';
import assert from 'node:assert/strict';
import { connectWallet, disconnectWallet, getWalletAccount, isOnExpectedNetwork, subscribeWallet, injectedWalletClient, writeWithWallet } from './wallet';
const A=`0x${'1'.repeat(40)}`,B=`0x${'2'.repeat(40)}`;
function fixture(t: { after(fn: () => Promise<void>): void }) {
  const storage=new Map<string,string>(),listeners=new Map<string,(value:unknown)=>void>(),methods:string[]=[];
  let current=[A],chain='0x1';
  const provider={request:async({method}:{method:string})=>{methods.push(method);if(method==='eth_requestAccounts'||method==='eth_accounts')return [...current];if(method==='eth_chainId')return chain;throw Error('Unexpected wallet request: '+method);},
    on:(name:string,listener:(v:unknown)=>void)=>listeners.set(name,listener),removeListener:(name:string)=>listeners.delete(name)};
  Object.defineProperty(globalThis,'window',{configurable:true,value:{ethereum:provider,sessionStorage:{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>storage.set(k,v),removeItem:(k:string)=>storage.delete(k)}}});
  t.after(async()=>{await disconnectWallet();Reflect.deleteProperty(globalThis,'window');});
  return{provider,methods,listeners,setAccounts:(v:string[])=>{current=v;},setChain:(v:string)=>{chain=v;}};
}
test('explicit connection requests account access only, never switches chain or signs',async t=>{
 const f=fixture(t);assert.equal(await getWalletAccount(),null);assert.equal(f.methods.length,0);
 assert.equal(await connectWallet(),A);assert.equal(await isOnExpectedNetwork(),false);assert.equal(await getWalletAccount(),A);
 assert(f.methods.every(m=>['eth_requestAccounts','eth_accounts','eth_chainId'].includes(m)));
 const count=f.methods.length;await disconnectWallet();assert.equal(await getWalletAccount(),null);assert.equal(f.methods.length,count);
 assert.throws(()=>injectedWalletClient(),/signing is disabled/);
 await assert.rejects(writeWithWallet({expectedOwner:A,address:B as `0x${string}`,abi:[],functionName:'approve'}),/read-only release/);
 assert.equal(f.methods.length,count);
});
test('account/chain events invalidate the session and disconnect cannot auto-reconnect',async t=>{
 const f=fixture(t);let selected:string[]=[];let network='';
 const off=subscribeWallet({onAccountsChanged:v=>{selected=v;},onChainChanged:v=>{network=v;}});
 f.listeners.get('accountsChanged')!([B]);assert.deepEqual(selected,[]);
 await connectWallet();f.setAccounts([B]);f.listeners.get('accountsChanged')!([B]);assert.equal(selected[0],B);assert.equal(await getWalletAccount(),B);
 f.setChain('0xa869');f.listeners.get('chainChanged')!('0xa869');assert.equal(network,'0xa869');assert.equal(await isOnExpectedNetwork(),true);
 await disconnectWallet();f.setAccounts([A]);f.listeners.get('accountsChanged')!([A]);assert.equal(await getWalletAccount(),null);assert.equal(selected[0],B);
 off();assert.equal(f.listeners.size,0);
});
test('disconnect cancels an outstanding connection request',async t=>{
 const f=fixture(t);let resolve!: (v:string[])=>void;
 f.provider.request=async({method})=>{f.methods.push(method);if(method==='eth_requestAccounts')return new Promise<string[]>(r=>{resolve=r;});return [A];};
 const pending=connectWallet();await disconnectWallet();resolve([A]);await assert.rejects(pending,/cancelled/);assert.equal(await getWalletAccount(),null);
});
