import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keccak256, stringToHex, hashTypedData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { orderTypedData } from '../../packages/clob/admission.ts';
import { JournaledMatcher } from '../../packages/clob/journal.ts';
import { createAdmissionGate } from './admission-gate.ts';
import { startMarketData } from './market-data.ts';
const hash = n => `0x${n.repeat(64)}`;
const addr = n => `0x${n.repeat(40)}`;
const config = { chainId: 43113, marketId: 1, deploymentId: hash('4'), vault: addr('1'), settlement: addr('2'), oracle: addr('3'),
  vaultCodeHash: keccak256('0x6001'), settlementCodeHash: keccak256('0x6001'), oracleCodeHash: keccak256('0x6001'), confirmations: 3 };
const account = privateKeyToAccount(keccak256(stringToHex('public admission transport test-only fixture')));
async function fixture(overrides = {}) {
  const binding = { chainId: 43113, marketId: 1, settlementContract: config.settlement };
  const order = { trader: account.address.toLowerCase(), marketId: 1, side: 'buy', kind: 'limit', size6: '1000000',
    limitPrice18: '2000000000000000000', leverage: 2, maxFeeBps: 3, nonce: '1', expiry: 2000, reduceOnly: false, postOnly: false, ioc: false };
  const typed = orderTypedData(binding, order, 1000), orderHash = hashTypedData(typed);
  const envelope = { type: 'order', order, signature: await account.signTypedData(typed) };
  const state = { deploymentId: config.deploymentId, settlementModule: config.settlement, vault: config.vault, oracle: config.oracle,
    marketId: 1, depositCap6: 10000000n, accounting: [2000000n, 2000000n, 0n], depositsActive: true, entriesPaused: false,
    activationReady: true, cancelled: false, filledSize6: 0n, minimumNonce: 0n, nonceHash: orderHash,
    reservation: { owner: order.trader, amount6: 1000600n }, ...overrides };
  const client = { getChainId: async () => 43113, getBlockNumber: async () => 100n,
    getBlock: async () => ({ hash: hash('a'), timestamp: 1000n, number: 98n }), getCode: async () => '0x6001',
    readContract: async ({ functionName, blockNumber }) => { assert.equal(blockNumber, 98n); assert(functionName in state); return state[functionName]; } };
  return { gate: createAdmissionGate(client, client, config, () => 1000), state, client, envelope, binding };
}
test('canonical gate accepts only pinned fully escrowed supported signed orders', async () => {
  const { gate, envelope } = await fixture();
  const result = await gate.check(envelope);
  assert.equal(result.blockNumber, '98'); assert.equal(result.settlement, 'unavailable');
});
test('paused, unescrowed, replayed, underfunded and foreign deployment orders fail closed', async () => {
  for (const overrides of [{ entriesPaused: true }, { activationReady: false }, { depositsActive: false },
    { filledSize6: 1n }, { cancelled: true }, { minimumNonce: 2n }, { nonceHash: hash('0') },
    { reservation: { owner: addr('9'), amount6: 1000600n } }, { reservation: { owner: account.address.toLowerCase(), amount6: 1000599n } },
    { deploymentId: hash('5') }, { depositCap6: 10000001n }]) {
    const { gate, envelope } = await fixture(overrides); await assert.rejects(gate.check(envelope));
  }
});
test('chain, runtime, stale/reorged header and provider disagreement cannot authorize admission', async () => {
  const { client, envelope } = await fixture();
  for (const broken of [{ getChainId: async () => 43114 }, { getCode: async () => '0x6002' },
    { getBlock: async () => ({ hash: hash('b'), timestamp: 1000n, number: 98n }) }, { getBlock: async () => ({ hash: hash('a'), timestamp: 900n, number: 98n }) },
    { readContract: async () => null }]) {
    const gate = createAdmissionGate(client, { ...client, ...broken }, config, () => 1000); await assert.rejects(gate.check(envelope));
  }
  let calls = 0;
  const reorg = { ...client, getBlock: async () => ({ hash: ++calls > 2 ? hash('b') : hash('a'), timestamp: 1000n, number: 98n }) };
  await assert.rejects(createAdmissionGate(reorg, reorg, config, () => 1000).check(envelope), /SOURCE_CHANGED/);
});
test('HTTP ingress acknowledges durable provisional orders, never a filled order or globally ready exchange', async t => {
  const f = await fixture(), dir = mkdtempSync(join(tmpdir(), 'avensdex-ingress-test-'));
  const journal = JournaledMatcher.open(dir, f.binding, true);
  const service = await startMarketData(journal, 0, () => 1000, { admission: f.gate, origins: ['https://avensdex.vercel.app'] });
  t.after(async () => { await service.close(); journal.close(); rmSync(dir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${service.port}`;
  const ready = await fetch(url + '/admission/ready'); assert.equal(ready.status, 200); assert.equal((await ready.json()).ready, false);
  const response = await fetch(url + '/orders', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://avensdex.vercel.app' }, body: JSON.stringify(f.envelope) });
  assert.equal(response.status, 202); assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://avensdex.vercel.app');
  const result = await response.json(); assert.equal(result.filled, false); assert.equal(result.status, 'accepted_provisional');
  assert.equal(journal.snapshot().orders.length, 1); assert.equal((await fetch(url + '/ready')).status, 503);
  const before = journal.snapshot();
  const duplicate = await fetch(url + '/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(f.envelope) });
  assert.equal(duplicate.status, 503); assert.deepEqual(journal.snapshot(), before);
  const wrongOrigin = await fetch(url + '/orders', { method: 'POST', headers: { Origin: 'https://avensdex.vercel.app.evil.example' } });
  assert.equal(wrongOrigin.status, 403);
  const huge = await fetch(url + '/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(8193) }); assert.equal(huge.status, 413);
  const malformed = await fetch(url + '/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' }); assert.equal(malformed.status, 400);
  assert.deepEqual(journal.snapshot(), before);
});
