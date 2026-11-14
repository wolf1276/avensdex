import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeDatabaseJournal, DatabaseJournal } from './database-journal.ts';
import { digest } from '../../packages/clob/journal.ts';
export const identity = { binding: { chainId: 43113, marketId: 1, settlementContract: `0x${'3'.repeat(40)}` }, deploymentId: `0x${'4'.repeat(64)}`, configDigest: digest('public test fixture') };
export function memoryStore() {
  const rows = new Map();
  return { rows, list: async () => [...rows.values()].sort((a,b) => a.id.localeCompare(b.id)).map(row => structuredClone(row)),
    get: async id => structuredClone(rows.get(id) ?? null),
    create: async row => { if (rows.has(row.id)) throw Error('CONFLICT'); rows.set(row.id, structuredClone(row)); } };
}
const command = (id = 'a', nonce = '1') => ({ type: 'submit', at: 1000, order: { id, trader: `0x${'1'.repeat(40)}`, nonce, marketId: 1,
  side: 'buy', kind: 'limit', size6: '1000000', limitPrice18: '2000000000000000000', expiry: 2000, reduceOnly: false, postOnly: false, ioc: false } });
test('explicit initialization and cold replay preserve the same durable book and events', async () => {
  const store = memoryStore(); await assert.rejects(DatabaseJournal.load(store, identity), /MISSING_REFUSE_RESET/);
  await initializeDatabaseJournal(store, identity, 'appwrite-test');
  const journal = await DatabaseJournal.load(store, identity); const events = await journal.apply(command());
  assert(events.length > 0); assert.equal(store.rows.size, 2);
  const restarted = await DatabaseJournal.load(store, identity); assert.deepEqual(restarted.snapshot(), journal.snapshot());
  await assert.rejects(initializeDatabaseJournal(store, identity, 'reset'), /ALREADY_EXISTS/); assert.equal(store.rows.size, 2);
});
test('two cold workers racing for one sequence yield one immutable winner', async () => {
  const store = memoryStore(); await initializeDatabaseJournal(store, identity, 'race');
  const a = await DatabaseJournal.load(store, identity), b = await DatabaseJournal.load(store, identity);
  const results = await Promise.allSettled([a.apply(command('a','1')), b.apply(command('b','2'))]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length, 1); assert.equal(store.rows.size, 2);
  assert.equal((await DatabaseJournal.load(store, identity)).snapshot().orders.length, 1);
});
test('lost create acknowledgment is reconciled by identical immutable readback, without resubmission', async () => {
  const store = memoryStore(); await initializeDatabaseJournal(store, identity, 'ack');
  let attempts = 0;
  const uncertain = { ...store, create: async row => { attempts++; await store.create(row); throw Error('NETWORK_LOST'); } };
  const journal = await DatabaseJournal.load(uncertain, identity); await journal.apply(command());
  assert.equal(attempts, 1); assert.equal(journal.snapshot().orders.length, 1);
  assert.deepEqual((await DatabaseJournal.load(store, identity)).snapshot(), journal.snapshot());
});
test('unknown precommit failure, corrupt history and mismatched identity never reset storage', async () => {
  const store = memoryStore(); await initializeDatabaseJournal(store, identity, 'integrity');
  const unavailable = { ...store, create: async () => { throw Error('NETWORK_LOST'); } };
  const journal = await DatabaseJournal.load(unavailable, identity); await assert.rejects(journal.apply(command()), /UNKNOWN_OR_CONFLICT/);
  assert.equal(journal.snapshot().orders.length, 0); assert.equal(store.rows.size, 1);
  await assert.rejects(DatabaseJournal.load(store, { ...identity, configDigest: digest('other release') }), /IDENTITY/);
  await (await DatabaseJournal.load(store, identity)).apply(command());
  const row = store.rows.get('00000001'); row.payload = row.payload.replace('1000000','2000000');
  await assert.rejects(DatabaseJournal.load(store, identity), /INTEGRITY/); assert.equal(store.rows.size, 2);
});
