import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hashTypedData, keccak256, stringToHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { JournaledMatcher } from './journal.ts';
import { admitSigned, verifyAdmission, orderTypedData, cancelTypedData, admissionDomain } from './admission.ts';
// Public deterministic test-only keys, never funded credentials or actual testnet actors.
const A = privateKeyToAccount(keccak256(stringToHex('avensdex public admission fixture A')));
const B = privateKeyToAccount(keccak256(stringToHex('avensdex public admission fixture B')));
const binding = { chainId: 43113, marketId: 1, settlementContract: `0x${'3'.repeat(40)}` };
const base = { trader: A.address.toLowerCase(), marketId: 1, side: 'sell', kind: 'limit', size6: '1000000',
  limitPrice18: '30000000000000000000', leverage: 2, maxFeeBps: 10, nonce: '1', expiry: 2000, reduceOnly: false, postOnly: false, ioc: false };
async function sign(order = base, account = A, mutate = v => v) {
  return { type: 'order', order: structuredClone(order), signature: await account.signTypedData(mutate(orderTypedData(binding, order, 1000))) };
}
async function cancel(orderHash, changes = {}, account = A) {
  const cancel = { trader: A.address.toLowerCase(), orderHash, nonce: '1', expiry: 2000, ...changes };
  return { type: 'cancel', cancel, signature: await account.signTypedData(cancelTypedData(binding, cancel, 1000)) };
}
function setup(t) {
  const path = mkdtempSync(join(tmpdir(), 'avensdex-signed-test-'));
  let journal = JournaledMatcher.open(path, binding, true);
  t.after(() => { journal.close(); rmSync(path, { recursive: true, force: true }); });
  return { path, get journal() { return journal; }, restart() { journal.close(); journal = JournaledMatcher.open(path, binding); } };
}
test('TypeScript hashes match the Solidity golden order and cancellation vectors', () => {
  const orderHash = hashTypedData(orderTypedData(binding, base, 1000));
  assert.equal(orderHash, '0xbb7468dc6ec96631349eed96a95f27a33efcfa05f1f261ee7a1006c00500a114');
  assert.equal(hashTypedData(cancelTypedData(binding, { trader: base.trader, orderHash, nonce: '1', expiry: 2000 }, 1000)),
    '0x9c4ebc9638e8b40ebc842b9823f06a0e13ed52794ebab0797742985ace0f4ce4');
});
test('signed orders get domain-specific IDs, durable proofs and provisional partial fills', async t => {
  const s = setup(t), a = await sign(); await admitSigned(s.journal, a, 1000);
  const b = await sign({ ...base, trader: B.address.toLowerCase(), side: 'buy', size6: '400000' }, B);
  await admitSigned(s.journal, b, 1000);
  const snapshot = s.journal.snapshot(); assert.equal(snapshot.trades.length, 1); assert.equal(snapshot.trades[0].settlement, 'blocked');
  assert.equal(snapshot.orders[0].remaining6, '600000'); assert.equal(snapshot.confirmedPositions, null);
  const records = readFileSync(join(s.path, 'commands.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(records[1].proof.envelope, a); assert.equal(records[1].proof.domain.chainId, 43113);
  assert.equal(records[1].command.order.id, hashTypedData(orderTypedData(binding, base, 1000)));
  assert.equal(records[1].proof.envelope.order.leverage, 2); assert.equal(records[1].proof.envelope.order.maxFeeBps, 10);
});
test('order/hash/nonce replay remains rejected after journal restart', async t => {
  const s = setup(t), a = await sign(); await admitSigned(s.journal, a, 1000); const before = s.journal.snapshot();
  s.restart(); assert.deepEqual(s.journal.snapshot(), before);
  await assert.rejects(admitSigned(s.journal, a, 1000), /REPLAY/);
  await assert.rejects(admitSigned(s.journal, await sign({ ...base, limitPrice18: '31000000000000000000' }), 1000), /REPLAY/);
  assert.deepEqual(s.journal.snapshot(), before);
});
test('every signed financial/behavioral field is bound, including leverage and fee cap', async t => {
  const s = setup(t), a = await sign(), before = s.journal.snapshot();
  for (const [key, value] of Object.entries({ trader: B.address.toLowerCase(), side: 'buy', size6: '999999', limitPrice18: '31000000000000000000',
    leverage: 3, maxFeeBps: 11, nonce: '2', expiry: 2001, reduceOnly: true, postOnly: true, ioc: true })) {
    const bad = structuredClone(a); bad.order[key] = value;
    await assert.rejects(admitSigned(s.journal, bad, 1000), /SIGNER_MISMATCH/, key);
  }
  const market = await sign({ ...base, kind: 'market', ioc: true }); market.order.kind = 'limit';
  await assert.rejects(admitSigned(s.journal, market, 1000), /SIGNER_MISMATCH/);
  assert.deepEqual(s.journal.snapshot(), before);
});
test('foreign signer, chain, deployment, domain name/version and market cannot enter the journal', async t => {
  const s = setup(t), before = s.journal.snapshot();
  await assert.rejects(admitSigned(s.journal, await sign(base, B), 1000), /SIGNER_MISMATCH/);
  for (const fields of [{ chainId: 1 }, { verifyingContract: `0x${'4'.repeat(40)}` }, { name: 'Other' }, { version: '2' }]) {
    const bad = await sign(base, A, v => ({ ...v, domain: { ...v.domain, ...fields } }));
    await assert.rejects(admitSigned(s.journal, bad, 1000), /SIGNER_MISMATCH/);
  }
  const bad = await sign(); bad.order.marketId = 2;
  await assert.rejects(admitSigned(s.journal, bad, 1000), /INVALID_SIGNED_ORDER/);
  assert.deepEqual(s.journal.snapshot(), before);
});
test('no target or domain override, malformed schema, noncanonical quantities and bad flags', async () => {
  const a = await sign();
  for (const bad of [{ ...a, rpc: 'http://evil' }, { ...a, domain: admissionDomain(binding) }, { ...a, id: 'chosen' },
    { ...a, type: 'positions' }, { ...a, order: { ...base, strategyId: '1' } }]) await assert.rejects(verifyAdmission(binding, bad, 1000));
  for (const change of [{ nonce: '01' }, { nonce: '0' }, { size6: '0' }, { limitPrice18: '0' }, { leverage: 0 },
    { maxFeeBps: 10001 }, { kind: 'market', ioc: false }, { postOnly: true, ioc: true }, { side: 'unknown' }, { expiry: 1000 }, { expiry: 87401 }]) {
    await assert.rejects(verifyAdmission(binding, { ...a, order: { ...base, ...change } }, 1000));
  }
  assert.throws(() => admissionDomain({ ...binding, chainId: 1 }), /FUJI_ONLY/);
  assert.throws(() => admissionDomain({ ...binding, settlementContract: null }), /UNAVAILABLE/);
});
test('strict low-s, nonzero scalar and 27/28 recovery-byte signatures only', async () => {
  const a = await sign(), N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const highS = (N - BigInt(`0x${a.signature.slice(66, 130)}`)).toString(16).padStart(64, '0');
  const malleable = a.signature.slice(0, 66) + highS + (a.signature.endsWith('1b') ? '1c' : '1b');
  for (const signature of ['0x', a.signature.slice(0, -2), `${a.signature.slice(0, -2)}00`, `0x${'0'.repeat(128)}1b`, malleable]) {
    await assert.rejects(verifyAdmission(binding, { ...a, signature }, 1000), /SIGNATURE/);
  }
});
test('signed cancellation binds exact owner, order digest and original nonce; replay fails', async t => {
  const s = setup(t), a = await sign(); await admitSigned(s.journal, a, 1000);
  const id = s.journal.snapshot().orders[0].id, before = s.journal.snapshot();
  await assert.rejects(admitSigned(s.journal, await cancel(id, { nonce: '2' }), 1000), /TARGET_MISMATCH/);
  await assert.rejects(admitSigned(s.journal, await cancel(id, { trader: B.address.toLowerCase() }, B), 1000), /TARGET_MISMATCH/);
  const c = await cancel(id); const tampered = structuredClone(c); tampered.cancel.orderHash = `0x${'a'.repeat(64)}`;
  await assert.rejects(admitSigned(s.journal, tampered, 1000), /SIGNER_MISMATCH/); assert.deepEqual(s.journal.snapshot(), before);
  await admitSigned(s.journal, c, 1000); assert.equal(s.journal.snapshot().orders[0].status, 'cancelled');
  s.restart(); await assert.rejects(admitSigned(s.journal, c, 1000), /NOT_CANCELLABLE/);
});
test('order signatures cannot be used as cancellation signatures', async t => {
  const s = setup(t), a = await sign(); await admitSigned(s.journal, a, 1000);
  const c = await cancel(s.journal.snapshot().orders[0].id); c.signature = a.signature;
  await assert.rejects(admitSigned(s.journal, c, 1000), /SIGNER_MISMATCH/);
});
test('stale signatures, unknown reduction capacity and self-trades never create confirmed positions', async t => {
  const s = setup(t); await assert.rejects(admitSigned(s.journal, await sign(), 2000), /BOUNDS/);
  await assert.rejects(admitSigned(s.journal, await sign({ ...base, reduceOnly: true }), 1000), /CONFIRMED_REDUCTION_UNAVAILABLE/);
  await admitSigned(s.journal, await sign(), 1000);
  await admitSigned(s.journal, await sign({ ...base, nonce: '2', side: 'buy' }), 1000);
  assert.equal(s.journal.snapshot().trades.length, 0); assert.equal(s.journal.snapshot().confirmedPositions, null);
});
test('concurrent same-nonce admissions serialize at the durable engine boundary', async t => {
  const s = setup(t), a = await sign(), b = await sign({ ...base, limitPrice18: '31000000000000000000' });
  const results = await Promise.allSettled([admitSigned(s.journal, a, 1000), admitSigned(s.journal, b, 1000)]);
  assert.equal(results.filter(v => v.status === 'fulfilled').length, 1); assert.equal(s.journal.snapshot().orders.length, 1);
});
test('caller mutation during async recovery cannot change authorized commands or stored proof', async () => {
  const a = await sign(), original = structuredClone(a), verified = verifyAdmission(binding, a, 1000);
  a.order.limitPrice18 = '1'; a.signature = '0x';
  const result = await verified; assert.equal(result.command.order.limitPrice18, base.limitPrice18);
  assert.deepEqual(result.proof.envelope, original);
});
