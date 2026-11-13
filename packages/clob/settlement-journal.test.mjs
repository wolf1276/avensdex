import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, appendFileSync, writeFileSync, existsSync, unlinkSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { SettlementJournal, MATCHED_FILL_SIGNATURE, MATCHED_FILL_EVENT } from './settlement-journal.ts';

const hex32 = c => `0x${c.repeat(64)}`, addr = c => `0x${c.repeat(40)}`;
const identity = { chainId: 43113, deploymentId: hex32('d'), settlementContract: addr('a') };
const sender = addr('1'), txHash = hex32('4'), otherTx = hex32('5');
const blockHash = hex32('b'), otherBlockHash = hex32('c');
const longOrderHash = hex32('2'), shortOrderHash = hex32('3');
const intent = (changes = {}) => ({ pairId: '1', longOrderHash, shortOrderHash, size6: '10', price18: '100',
  sender, nonce: '7', ...changes });
const fillLog = (order, changes = {}) => ({ contract: identity.settlementContract, pairId: order.pairId,
  longOrderHash: order.longOrderHash, shortOrderHash: order.shortOrderHash, size6: order.size6, price18: order.price18,
  txHash, blockNumber: '5', blockHash, logIndex: 0, ...changes });
function successReceipt(order, options = {}) {
  const tx = options.txHash ?? txHash, number = options.blockNumber ?? '5', hash = options.blockHash ?? blockHash;
  const logs = options.logs ?? [fillLog(order, { txHash: tx, blockNumber: number, blockHash: hash })];
  return { txHash: tx, status: 'success', blockNumber: number, blockHash: hash, logs };
}
// Deterministic local-only reader mock. No RPC, fixture, signing or broadcast is involved.
function localMockReader(initial = {}) {
  const state = {
    receipt: initial.receipt ?? null, head: initial.head ?? { number: '10', hash: blockHash },
    canonical: initial.canonical ?? blockHash, receiptError: initial.receiptError ?? false,
    headError: initial.headError ?? false, canonicalError: initial.canonicalError ?? false,
    receiptCalls: 0, active: 0, maxActive: 0, gate: null,
  };
  return {
    state,
    async getReceipt(hash) {
      state.receiptCalls++; state.active++; state.maxActive = Math.max(state.maxActive, state.active);
      try {
        if (state.gate) await state.gate;
        if (state.receiptError) throw Error('LOCAL_RPC_DOWN');
        return typeof state.receipt === 'function' ? state.receipt(hash) : state.receipt;
      } finally { state.active--; }
    },
    async getCanonicalHead() {
      if (state.headError) throw Error('LOCAL_RPC_DOWN');
      return state.head;
    },
    async getCanonicalBlockHash(number) {
      if (state.canonicalError) throw Error('LOCAL_RPC_DOWN');
      return typeof state.canonical === 'function' ? state.canonical(number) : state.canonical;
    },
  };
}
function directory(t) {
  const dir = mkdtempSync(join(tmpdir(), 'avensdex-settlement-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function open(dir, reader, options = {}) {
  return SettlementJournal.open(dir, identity, { confirmations: options.confirmations ?? 1, reader, create: options.create ?? true });
}
const lines = dir => readFileSync(join(dir, 'settlements.jsonl'), 'utf8').trim().split('\n');

test('settlement identity and confirmation policy are strict, including local and Fuji chains', t => {
  const reader = localMockReader();
  assert.throws(() => SettlementJournal.open(directory(t), { ...identity, chainId: 43114 },
    { confirmations: 1, reader }), /CHAIN/);
  assert.throws(() => SettlementJournal.open(directory(t), { ...identity, deploymentId: hex32('0') },
    { confirmations: 1, reader }), /HASH/);
  assert.throws(() => SettlementJournal.open(directory(t), { ...identity, settlementContract: addr('0') },
    { confirmations: 1, reader }), /ADDRESS/);
  assert.throws(() => SettlementJournal.open(directory(t), identity, { confirmations: 0, reader }), /INTEGER/);
  assert.throws(() => SettlementJournal.open(directory(t), identity, { confirmations: 1 }), /OPTIONS/);
  const local = SettlementJournal.open(directory(t), { ...identity, chainId: 31337 }, { confirmations: 1, reader, create: true });
  assert.equal(local.recordIntent(intent()).chainId, 31337); local.close();
  assert.equal(MATCHED_FILL_SIGNATURE, 'MatchedFill(uint64,bytes32,bytes32,uint128,uint128)');
  assert.equal(MATCHED_FILL_EVENT.name, 'MatchedFill');
});

test('intent is durable before acknowledgment, deterministic and isolated from caller mutation', t => {
  const dir = directory(t), j = open(dir, localMockReader());
  const input = intent();
  const first = j.recordIntent(input);
  assert.equal(lines(dir).length, 2); // header + intent are already fsynced before the ack.
  assert.equal(first.intentId.length, 64);
  input.size6 = '11';
  const stored = j.intent(first.intentId);
  assert.equal(stored.intent.size6, '10');
  const again = j.recordIntent(intent());
  assert.equal(again.intentId, first.intentId);
  assert.equal(lines(dir).length, 2);
  assert.throws(() => { first.size6 = '9'; });
  assert.throws(() => { stored.status = 'confirmed'; });
  j.close();
});

test('broadcast identity is separate from intents and a tx hash alone never confirms a fill', t => {
  const dir = directory(t), j = open(dir, localMockReader());
  const i = j.recordIntent(intent());
  assert.throws(() => j.recordBroadcast(i.intentId, { txHash, sender, nonce: '8' }), /IDENTITY/);
  assert.throws(() => j.recordBroadcast(i.intentId, { txHash, sender: addr('9'), nonce: '7' }), /IDENTITY/);
  const view = j.recordBroadcast(i.intentId, { txHash, sender, nonce: '7' });
  assert.equal(view.status, 'broadcast');
  assert.equal(view.receipt, null);
  assert.deepEqual(j.confirmedFills(), []);
  assert.equal(lines(dir).length, 3); // header + intent + broadcast only
  j.close();
});

test('single writer lock and crash recovery never steal a held lock', t => {
  const dir = directory(t), reader = localMockReader();
  const j = open(dir, reader);
  assert.throws(() => SettlementJournal.open(dir, identity, { confirmations: 1, reader }), /EEXIST/);
  j.close();
  assert.equal(existsSync(join(dir, 'writer.lock')), false);

  const crashed = directory(t), moduleUrl = new URL('./settlement-journal.ts', import.meta.url).href;
  const script = `import {SettlementJournal} from ${JSON.stringify(moduleUrl)};
    const j=SettlementJournal.open(${JSON.stringify(crashed)},${JSON.stringify(identity)},{confirmations:1,create:true,reader:{
      getReceipt:async()=>null,getCanonicalHead:async()=>({number:'1',hash:${JSON.stringify(blockHash)}}),
      getCanonicalBlockHash:async()=>${JSON.stringify(blockHash)}}});
    j.recordIntent(${JSON.stringify(intent())}); process.exit(0);`;
  const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert(existsSync(join(crashed, 'writer.lock')));
  assert.throws(() => open(crashed, localMockReader()), /EEXIST/);
  unlinkSync(join(crashed, 'writer.lock')); // Test-only operator action after confirming the child exited.
  const restored = open(crashed, localMockReader());
  assert.equal(restored.intents().length, 1);
  assert.equal(restored.intents()[0].status, 'unknown');
  assert.equal(restored.intents()[0].reason, 'RESTART_RECONCILIATION_REQUIRED');
  restored.close();
});

test('missing, corrupt, truncated, rebound and policy-changed journals fail closed', t => {
  const dir = directory(t), reader = localMockReader();
  assert.throws(() => SettlementJournal.open(dir, identity, { confirmations: 1, reader }), /MISSING/);
  let j = open(dir, reader);
  const i = j.recordIntent(intent());
  j.recordBroadcast(i.intentId, { txHash, sender, nonce: '7' });
  j.close();
  const path = join(dir, 'settlements.jsonl'), original = readFileSync(path);
  writeFileSync(path, original.toString().replace('"size6":"10"', '"size6":"11"'));
  const corrupted = readFileSync(path);
  assert.throws(() => open(dir, reader), /HASH|INVALID/);
  assert.deepEqual(readFileSync(path), corrupted);
  writeFileSync(path, original);
  appendFileSync(path, '{"version":1');
  assert.throws(() => open(dir, reader), /INCOMPLETE/);
  writeFileSync(path, original);
  assert.throws(() => SettlementJournal.open(dir, { ...identity, deploymentId: hex32('e') }, { confirmations: 1, reader }), /IDENTITY/);
  assert.throws(() => SettlementJournal.open(dir, identity, { confirmations: 2, reader }), /IDENTITY/);
  j = open(dir, reader);
  assert.equal(j.intents().length, 1);
  j.close();
});

test('restart replays confirmed, replacement, reverted and unknown transitions', async t => {
  const dir = directory(t), reader = localMockReader();
  const a = intent({ nonce: '1', longOrderHash: hex32('6'), shortOrderHash: hex32('7') });
  const b = intent({ pairId: '2', nonce: '2', longOrderHash: hex32('8'), shortOrderHash: hex32('9') });
  const c = intent({ pairId: '3', nonce: '3', longOrderHash: hex32('a'), shortOrderHash: hex32('b') });
  const d = intent({ pairId: '4', nonce: '4', longOrderHash: hex32('c'), shortOrderHash: hex32('e') });
  const txA = hex32('f'), txB1 = hex32('1'), txB2 = hex32('2'), txC = hex32('3'), txD = hex32('6');
  reader.state.receipt = tx => tx === txA ? successReceipt(a, { txHash: txA })
    : tx === txC ? { ...successReceipt(c, { txHash: txC }), status: 'reverted', logs: [] } : null;
  let j = open(dir, reader);
  const ia = j.recordIntent(a); j.recordBroadcast(ia.intentId, { txHash: txA, sender, nonce: '1' });
  const ib = j.recordIntent(b); j.recordBroadcast(ib.intentId, { txHash: txB1, sender, nonce: '2' });
  j.recordBroadcast(ib.intentId, { txHash: txB2, sender, nonce: '2' });
  const ic = j.recordIntent(c); j.recordBroadcast(ic.intentId, { txHash: txC, sender, nonce: '3' });
  const id = j.recordIntent(d); j.recordBroadcast(id.intentId, { txHash: txD, sender, nonce: '4' });
  await j.reconcile(ia.intentId);
  await j.reconcile(ib.intentId);
  await j.reconcile(ic.intentId);
  await j.reconcile(id.intentId);
  const beforeIntents = j.intents(), beforeFills = j.confirmedFills();
  assert.equal(j.intent(ia.intentId).status, 'confirmed');
  assert.equal(j.intent(ib.intentId).status, 'unknown');
  assert.equal(j.intent(ib.intentId).broadcasts.length, 2);
  assert.equal(j.intent(ic.intentId).status, 'reverted');
  assert.equal(j.intent(id.intentId).status, 'unknown');
  assert.equal(beforeFills.length, 1);
  j.close();
  j = open(dir, reader);
  assert.equal(j.intent(ia.intentId).status, 'unknown');
  assert.equal(j.intent(ic.intentId).status, 'unknown');
  assert.deepEqual(j.confirmedFills(), []);
  await j.reconcile(ia.intentId);
  await j.reconcile(ic.intentId);
  assert.deepEqual(j.intents(), beforeIntents);
  assert.deepEqual(j.confirmedFills(), beforeFills);
  j.close();
});

test('replacement requires the same sender, nonce and intent and stays explicit', t => {
  const dir = directory(t), j = open(dir, localMockReader());
  const i = j.recordIntent(intent());
  j.recordBroadcast(i.intentId, { txHash, sender, nonce: '7' });
  assert.equal(lines(dir).length, 3);
  assert.equal(j.recordBroadcast(i.intentId, { txHash, sender, nonce: '7' }).broadcast.txHash, txHash);
  assert.equal(lines(dir).length, 3);
  assert.throws(() => j.recordBroadcast(i.intentId, { txHash: otherTx, sender, nonce: '8' }), /IDENTITY/);
  const replaced = j.recordBroadcast(i.intentId, { txHash: otherTx, sender, nonce: '7' });
  assert.equal(replaced.broadcast.txHash, otherTx);
  assert.equal(replaced.broadcasts.length, 2);
  assert.equal(j.recordBroadcast(i.intentId, { txHash: otherTx, sender, nonce: '7' }).broadcast.txHash, otherTx);
  assert.equal(lines(dir).length, 4);
  assert.throws(() => j.recordBroadcast(i.intentId, { txHash, sender, nonce: '7' }), /REUSED/);
  j.close();
});

test('confirmation delay requires independent canonical verification and enough confirmations', async t => {
  const i = intent(), reader = localMockReader({ receipt: successReceipt(i), head: { number: '5', hash: blockHash } });
  const j = open(directory(t), reader, { confirmations: 2 });
  const r = j.recordIntent(i); j.recordBroadcast(r.intentId, { txHash, sender, nonce: '7' });
  const pending = await j.reconcile(r.intentId);
  assert.equal(pending.status, 'pending');
  assert.equal(pending.reason, 'CONFIRMATIONS_PENDING');
  assert.deepEqual(j.confirmedFills(), []);
  reader.state.head = { number: '6', hash: blockHash };
  const confirmed = await j.reconcile(r.intentId);
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.receipt.blockHash, blockHash);
  assert.equal(confirmed.event.size6, '10');
  assert.equal(j.confirmedFills().length, 1);
  j.close();
});

test('reverted receipt status is distinct and never exposes a fill', async t => {
  const i = intent(), receipt = { ...successReceipt(i), status: 'reverted', logs: [] };
  const reader = localMockReader({ receipt }), j = open(directory(t), reader);
  const r = j.recordIntent(i); j.recordBroadcast(r.intentId, { txHash, sender, nonce: '7' });
  const view = await j.reconcile(r.intentId);
  assert.equal(view.status, 'reverted');
  assert.equal(view.reason, 'RECEIPT_REVERTED');
  assert.equal(view.receipt.status, 'reverted');
  assert.equal(view.event, null);
  assert.deepEqual(j.confirmedFills(), []);
  j.close();
});

test('unknown or dropped receipts pause without auto-retry; only canonical reconciliation clears them', async t => {
  const i = intent(), reader = localMockReader({ receipt: null }), j = open(directory(t), reader);
  const r = j.recordIntent(i); j.recordBroadcast(r.intentId, { txHash, sender, nonce: '7' });
  const unknown = await j.reconcile(r.intentId);
  assert.equal(unknown.status, 'unknown');
  assert.equal(unknown.reason, 'RECEIPT_NOT_FOUND');
  assert.equal(typeof j.markSuccess, 'undefined');
  assert.equal(typeof j.retry, 'undefined');
  assert.equal(typeof j.transition, 'undefined');
  assert.equal(j.records, undefined);
  const calls = reader.state.receiptCalls;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reader.state.receiptCalls, calls);
  const repeated = await j.reconcile(r.intentId);
  assert.equal(repeated.status, 'unknown');
  assert.equal(repeated.reason, 'RECEIPT_NOT_FOUND');
  reader.state.receiptError = true;
  const unavailable = await j.reconcile(r.intentId);
  assert.equal(unavailable.status, 'unknown');
  assert.equal(unavailable.reason, 'RECEIPT_UNAVAILABLE');
  assert.deepEqual(j.confirmedFills(), []);
  reader.state.receiptError = false;
  reader.state.receipt = successReceipt(i);
  const confirmed = await j.reconcile(r.intentId);
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(j.confirmedFills().length, 1);
  j.close();
});

test('forged, foreign or mismatched settlement logs never confirm a fill', async t => {
  const cases = [
    { log: { contract: addr('f') }, reason: 'SETTLEMENT_LOG_MISSING' },
    { log: { longOrderHash: hex32('9') }, reason: 'SETTLEMENT_LOG_MISSING' },
    { log: { size6: '11' }, reason: 'SETTLEMENT_LOG_FIELD_MISMATCH' },
    { log: { price18: '101' }, reason: 'SETTLEMENT_LOG_FIELD_MISMATCH' },
    { log: { txHash: hex32('f') }, reason: 'INVALID_RECEIPT' },
    { log: { blockHash: otherBlockHash }, reason: 'INVALID_RECEIPT' },
  ];
  for (const item of cases) {
    const dir = directory(t), i = intent(), receipt = successReceipt(i, { logs: [fillLog(i, item.log)] });
    const j = open(dir, localMockReader({ receipt }));
    const r = j.recordIntent(i); j.recordBroadcast(r.intentId, { txHash, sender, nonce: '7' });
    const view = await j.reconcile(r.intentId);
    assert.equal(view.status, 'unknown', item.reason);
    assert.equal(view.reason, item.reason);
    assert.deepEqual(j.confirmedFills(), []);
    j.close();
  }
  const dir = directory(t), i = intent();
  const receipt = successReceipt(i, { logs: [fillLog(i), fillLog(i, { logIndex: 1 })] });
  const j = open(dir, localMockReader({ receipt }));
  const r = j.recordIntent(i); j.recordBroadcast(r.intentId, { txHash, sender, nonce: '7' });
  const view = await j.reconcile(r.intentId);
  assert.equal(view.status, 'unknown');
  assert.equal(view.reason, 'SETTLEMENT_LOG_DUPLICATE');
  assert.deepEqual(j.confirmedFills(), []);
  j.close();
});

test('reorg freezes confirmed state for resync instead of silently retaining positions', async t => {
  const i = intent(), reader = localMockReader({ receipt: successReceipt(i) });
  const j = open(directory(t), reader);
  const r = j.recordIntent(i); j.recordBroadcast(r.intentId, { txHash, sender, nonce: '7' });
  assert.equal((await j.reconcile(r.intentId)).status, 'confirmed');
  assert.equal(j.confirmedFills().length, 1);
  reader.state.canonical = otherBlockHash;
  const reorged = await j.reconcile(r.intentId);
  assert.equal(reorged.status, 'reorged');
  assert.equal(reorged.reason, 'CANONICAL_BLOCK_HASH_CHANGED');
  assert.equal(reorged.event, null);
  assert.deepEqual(j.confirmedFills(), []);
  reader.state.receipt = successReceipt(i, { blockNumber: '6', blockHash: otherBlockHash });
  reader.state.head.hash = otherBlockHash;
  const resynced = await j.reconcile(r.intentId);
  assert.equal(resynced.status, 'confirmed');
  assert.equal(resynced.receipt.blockHash, otherBlockHash);
  assert.equal(j.confirmedFills().length, 1);
  assert.equal(j.confirmedFills()[0].blockHash, otherBlockHash);
  j.close();
});

test('untrusted reader payloads are copied across later awaits', async t => {
  const i = intent(), raw = successReceipt(i), reader = localMockReader({ receipt: raw });
  reader.getCanonicalHead = async () => {
    raw.status = 'reverted'; raw.logs[0].size6 = '999'; raw.logs[0].price18 = '999';
    return { number: '10', hash: blockHash };
  };
  const j = open(directory(t), reader);
  const r = j.recordIntent(i); j.recordBroadcast(r.intentId, { txHash, sender, nonce: '7' });
  const view = await j.reconcile(r.intentId);
  assert.equal(view.status, 'confirmed');
  assert.equal(j.confirmedFills()[0].size6, '10');
  assert.equal(j.confirmedFills()[0].price18, '100');
  j.close();
});

test('concurrent reconciliation is serialized and does not duplicate transitions', async t => {
  const i = intent(), reader = localMockReader({ receipt: successReceipt(i) });
  let release; reader.state.gate = new Promise(resolve => { release = resolve; });
  const dir = directory(t), j = open(dir, reader);
  const r = j.recordIntent(i); j.recordBroadcast(r.intentId, { txHash, sender, nonce: '7' });
  const first = j.reconcile(r.intentId), second = j.reconcile(r.intentId);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reader.state.maxActive, 1);
  release(); reader.state.gate = null;
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, 'confirmed');
  assert.equal(b.status, 'confirmed');
  assert.equal(reader.state.maxActive, 1);
  assert.equal(lines(dir).length, 4); // header + intent + broadcast + one confirmed transition
  j.close();
});

test('an uncertain append poisons the writer and retains the operator lock', t => {
  const dir = directory(t), j = open(dir, localMockReader());
  const i = j.recordIntent(intent());
  closeSync(j.fd); // Test-only descriptor fault injection; no production reset/recovery shortcut.
  assert.throws(() => j.recordBroadcast(i.intentId, { txHash, sender, nonce: '7' }),
    /UNKNOWN_SETTLEMENT_JOURNAL_WRITE/);
  assert.equal(j.writable, false);
  assert.equal(j.intent(i.intentId).broadcast, null);
  assert.equal(j.intent(i.intentId).status, 'intent');
  assert.throws(() => j.recordIntent(intent({ nonce: '8' })), /UNAVAILABLE/);
  assert(existsSync(join(dir, 'writer.lock')));
});


test('nonce zero is valid; conflicting payloads cannot reuse a reserved sender nonce or transaction', t => {
  const dir = directory(t), reader = localMockReader(), j = open(dir, reader);
  const first = j.recordIntent(intent({ nonce: '0' }));
  j.recordBroadcast(first.intentId, { txHash, sender, nonce: '0' });
  const before = lines(dir).length;
  assert.throws(() => j.recordIntent(intent({ nonce: '0', size6: '11' })), /NONCE_ALREADY_RESERVED/);
  assert.equal(lines(dir).length, before);
  assert.throws(() => j.recordIntent(intent({ nonce: '1' })), /PAIR_ALREADY_RESERVED/);
  const second = j.recordIntent(intent({ pairId: '2', nonce: '1', longOrderHash: hex32('6'), shortOrderHash: hex32('7') }));
  assert.throws(() => j.recordBroadcast(second.intentId, { txHash, sender, nonce: '1' }), /TX_ALREADY_RESERVED/);
  j.close();
  const restored = open(dir, reader);
  assert.equal(restored.intent(first.intentId).intent.nonce, '0');
  restored.close();
});

test('confirmed receipts can be revalidated as head advances and freeze if confirmations roll back', async t => {
  const i = intent(), reader = localMockReader({ receipt: successReceipt(i), head: { number: '6', hash: blockHash } });
  const j = open(directory(t), reader, { confirmations: 2 });
  const r = j.recordIntent(i); j.recordBroadcast(r.intentId, { txHash, sender, nonce: '7' });
  assert.equal((await j.reconcile(r.intentId)).status, 'confirmed');
  reader.state.head.number = '7';
  assert.equal((await j.reconcile(r.intentId)).confirmations, 3);
  reader.state.head.number = '5';
  assert.equal((await j.reconcile(r.intentId)).status, 'pending');
  assert.deepEqual(j.confirmedFills(), []);
  j.close();
});

test('restart never exposes historical confirmed fills before current canonical reconciliation', async t => {
  const i = intent(), reader = localMockReader({ receipt: successReceipt(i) }), dir = directory(t);
  let j = open(dir, reader);
  const r = j.recordIntent(i); j.recordBroadcast(r.intentId, { txHash, sender, nonce: '7' });
  await j.reconcile(r.intentId);
  j.close();
  reader.state.canonical = otherBlockHash;
  j = open(dir, reader);
  assert.equal(j.intent(r.intentId).reason, 'RESTART_RECONCILIATION_REQUIRED');
  assert.deepEqual(j.confirmedFills(), []);
  assert.equal((await j.reconcile(r.intentId)).status, 'reorged');
  assert.deepEqual(j.confirmedFills(), []);
  j.close();
});

test('an original transaction mined after replacement is reconciled, never assumed dropped', async t => {
  const i = intent(), reader = localMockReader({ receipt: hash => hash === txHash ? successReceipt(i) : null });
  const j = open(directory(t), reader), r = j.recordIntent(i);
  j.recordBroadcast(r.intentId, { txHash, sender, nonce: '7' });
  j.recordBroadcast(r.intentId, { txHash: otherTx, sender, nonce: '7' });
  const result = await j.reconcile(r.intentId);
  assert.equal(result.status, 'confirmed');
  assert.equal(result.receipt.txHash, txHash);
  assert.equal(result.broadcast.txHash, otherTx);
  assert.equal(j.confirmedFills().length, 1);
  j.close();
});

test('head hash changing during receipt verification prevents confirmation', async t => {
  const i = intent(), reader = localMockReader({ receipt: successReceipt(i) });
  reader.state.canonical = number => number === '10' ? otherBlockHash : blockHash;
  const j = open(directory(t), reader), r = j.recordIntent(i);
  j.recordBroadcast(r.intentId, { txHash, sender, nonce: '7' });
  const result = await j.reconcile(r.intentId);
  assert.equal(result.status, 'unknown');
  assert.equal(result.reason, 'CANONICAL_HEAD_CHANGED');
  assert.deepEqual(j.confirmedFills(), []);
  j.close();
});


test('restart pauses intents even when the crash may have occurred before recording a submission hash', async t => {
  const dir = directory(t), reader = localMockReader();
  let j = open(dir, reader);
  const r = j.recordIntent(intent());
  j.close(); // Represents crash-after-dispatch/before-hash ambiguity; no transaction is fabricated.
  j = open(dir, reader);
  assert.equal(j.intent(r.intentId).status, 'unknown');
  assert.equal(j.intent(r.intentId).reason, 'RESTART_RECONCILIATION_REQUIRED');
  assert.equal(j.recordIntent(intent()).intentId, r.intentId);
  assert.equal(j.intent(r.intentId).status, 'unknown');
  await assert.rejects(j.reconcile(r.intentId), /INTENT_NOT_BROADCAST/);
  assert.equal(reader.state.receiptCalls, 0);
  assert.deepEqual(j.confirmedFills(), []);
  j.close();
});


test('unknown outcomes block order retries even with a new nonce or predicted pair ID', async t => {
  const i = intent(), reader = localMockReader(), j = open(directory(t), reader);
  const r = j.recordIntent(i);
  j.recordBroadcast(r.intentId, { txHash, sender, nonce: '7' });
  await j.reconcile(r.intentId);
  assert.equal(j.intent(r.intentId).status, 'unknown');
  assert.throws(() => j.recordIntent(intent({ nonce: '8' })), /PAIR_ALREADY_RESERVED/);
  assert.throws(() => j.recordIntent(intent({ nonce: '8', pairId: '2' })), /RECONCILE_ORDER_FIRST/);
  reader.state.receipt = successReceipt(i);
  await j.reconcile(r.intentId);
  assert.equal(j.intent(r.intentId).status, 'confirmed');
  assert.equal(j.recordIntent(intent({ nonce: '8', pairId: '2' })).pairId, '2');
  j.close();
});


test('an uncertain startup reconciliation checkpoint retains the crash lock', async t => {
  const dir = directory(t), i = intent(), reader = localMockReader({ receipt: successReceipt(i) });
  const j = open(dir, reader), r = j.recordIntent(i);
  j.recordBroadcast(r.intentId, { txHash, sender, nonce: '7' });
  await j.reconcile(r.intentId);
  j.close();
  const moduleUrl = new URL('./settlement-journal.ts', import.meta.url).href;
  const script = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    import assert from 'node:assert/strict'; import {SettlementJournal} from ${JSON.stringify(moduleUrl)};
    const original=fs.fsyncSync;let calls=0;fs.fsyncSync=fd=>{if(++calls===2)throw Error('FAULT');return original(fd)};
    syncBuiltinESMExports();
    assert.throws(()=>SettlementJournal.open(${JSON.stringify(dir)},${JSON.stringify(identity)},{confirmations:1,reader:{
      getReceipt:async()=>null,getCanonicalHead:async()=>null,getCanonicalBlockHash:async()=>null}}),/UNKNOWN_SETTLEMENT_JOURNAL_WRITE/);`;
  const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert(existsSync(join(dir, 'writer.lock')));
  assert.throws(() => open(dir, reader), /EEXIST/);
});
