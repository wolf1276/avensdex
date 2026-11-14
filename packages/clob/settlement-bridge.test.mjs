import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JournaledMatcher, digest } from './journal.ts';
import { Matcher } from './engine.ts';
import { startMarketData } from '../../services/clob/market-data.ts';
import { WebSocket } from 'ws';
import { SettlementJournal } from './settlement-journal.ts';
import { SettlementOutcomeBridge } from './settlement-bridge.ts';
import { MarketDataFeed } from './feed.ts';
import { admitSigned, orderTypedData } from './admission.ts';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const hash = c => `0x${c.repeat(64)}`, address = c => `0x${c.repeat(40)}`;
const identity = { chainId: 43113, settlementContract: address('a'), deploymentId: hash('d') };
const binding = { chainId: 43113, settlementContract: identity.settlementContract, marketId: 1 };
const blockHash = hash('b'), txHash = hash('4'), sender = address('9');
const alice = privateKeyToAccount(generatePrivateKey()), bob = privateKeyToAccount(generatePrivateKey());
const order = (account, side, extra = {}) => ({ trader: account.address.toLowerCase(), side, nonce: '1', marketId: 1,
  kind: 'limit', size6: '10', limitPrice18: '100', leverage: 10, maxFeeBps: 10,
  expiry: 1000, reduceOnly: false, postOnly: false, ioc: false, ...extra });
async function fixture(t, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'avensdex-bridge-'));
  let matcher = JournaledMatcher.open(join(root, 'matcher'), binding, true);
  const state = { receipt: null, canonical: blockHash, head: { number: '10', hash: blockHash }, gate: null };
  const reader = {
    async getReceipt() { if (state.gate) await state.gate; return state.receipt; },
    async getCanonicalHead() { return state.head; },
    async getCanonicalBlockHash() { return state.canonical; },
  };
  let journal = SettlementJournal.open(join(root, 'settlement'), identity, { confirmations: 2, reader, create: true });
  t.after(() => { matcher.close(); journal.close(); rmSync(root, { recursive: true, force: true }); });
  for (const [account, side] of [[alice, 'sell'], [bob, 'buy']]) {
    const value = order(account, side, side === 'buy' ? extra : {});
    const signature = await account.signTypedData(orderTypedData(binding, value, 100));
    await admitSigned(matcher, { type: 'order', order: value, signature }, 100);
  }
  const trade = matcher.snapshot().trades[0];
  const intent = journal.recordIntent({ pairId: '1', longOrderHash: trade.taker, shortOrderHash: trade.maker,
    size6: trade.size6, price18: trade.price18, sender, nonce: '7' });
  journal.recordBroadcast(intent.intentId, { txHash, sender, nonce: '7' });
  const receipt = { txHash, status: 'success', blockNumber: '5', blockHash, sender, nonce: '7', logs: [{
    contract: identity.settlementContract, pairId: '1', longOrderHash: trade.taker, shortOrderHash: trade.maker,
    size6: trade.size6, price18: trade.price18, txHash, blockNumber: '5', blockHash, logIndex: 0,
  }] };
  state.receipt = receipt;
  const bridge = () => new SettlementOutcomeBridge(matcher, journal, identity.deploymentId);
  return { get matcher() { return matcher; }, get journal() { return journal; }, state, trade, intent, receipt, bridge, root,
    reopen() { matcher.close(); journal.close(); matcher = JournaledMatcher.open(join(root, 'matcher'), binding);
      journal = SettlementJournal.open(join(root, 'settlement'), identity, { confirmations: 2, reader }); } };
}
function feedFor(matcher) {
  const snapshot = matcher.snapshot(), feed = new MarketDataFeed();
  assert.equal(feed.receive({ type: 'snapshot', streamId: snapshot.streamId, marketId: 1, seq: snapshot.seq,
    at: snapshot.clock, data: snapshot }), 'applied');
  return feed;
}

test('canonical signed-admission match confirms only after receipt reconciliation and durable writes', async t => {
  const f = await fixture(t), feed = feedFor(f.matcher);
  const result = await f.bridge().reconcileTrade(f.trade.id, f.intent.intentId, 101);
  assert.equal(result.view.status, 'confirmed');
  assert.equal(f.matcher.trade(f.trade.id).settlement, 'confirmed');
  assert.equal(f.matcher.snapshot().pendingSettlements, 0);
  assert.equal(f.matcher.snapshot().confirmedPositions, null);
  assert.match(readFileSync(join(f.root, 'matcher', 'commands.jsonl'), 'utf8'), /settlementOutcome/);
  for (const event of result.events) assert.equal(feed.receive(event), 'applied');
  assert.deepEqual(feed.view().snapshot, f.matcher.snapshot());
  const again = await f.bridge().reconcileTrade(f.trade.id, f.intent.intentId, 102);
  for (const event of again.events) assert.equal(feed.receive(event), 'applied');
  assert.equal(f.matcher.snapshot().pendingSettlements, 0);
  assert.deepEqual(feed.view().snapshot, f.matcher.snapshot());
});

test('pending, unknown and reorged observations retain capacity; a reorg restores terminal capacity', async t => {
  const f = await fixture(t), bridge = f.bridge();
  await bridge.reconcileTrade(f.trade.id, f.intent.intentId, 101);
  f.state.canonical = hash('c');
  const result = await bridge.reconcileTrade(f.trade.id, f.intent.intentId, 102);
  assert.equal(result.view.status, 'reorged');
  assert.equal(f.matcher.snapshot().pendingSettlements, 1);
  f.state.canonical = blockHash;
  f.state.head = { number: '5', hash: blockHash };
  assert.equal((await bridge.reconcileTrade(f.trade.id, f.intent.intentId, 103)).view.status, 'pending');
  f.state.receipt = null;
  assert.equal((await bridge.reconcileTrade(f.trade.id, f.intent.intentId, 104)).view.status, 'unknown');
  assert.equal(f.matcher.snapshot().pendingSettlements, 1);
});

test('canonical revert releases capacity without rematching or inventing a position', async t => {
  const f = await fixture(t);
  f.state.receipt = { ...f.receipt, status: 'reverted', logs: [] };
  const result = await f.bridge().reconcileTrade(f.trade.id, f.intent.intentId, 101);
  assert.equal(result.view.status, 'reverted');
  assert.equal(f.matcher.snapshot().pendingSettlements, 0);
  assert.equal(f.matcher.snapshot().orders.every(o => !o.resting && o.remaining6 === '0'), true);
  assert.equal(f.matcher.snapshot().confirmedPositions, null);
});

test('restart replays outcomes then invalidates terminal matcher evidence before awaiting chain reads', async t => {
  const f = await fixture(t);
  await f.bridge().reconcileTrade(f.trade.id, f.intent.intentId, 101);
  const original = f.matcher.snapshot();
  f.reopen();
  assert.deepEqual(f.matcher.snapshot(), original);
  assert.equal(f.journal.intent(f.intent.intentId).status, 'unknown');
  let release;
  f.state.gate = new Promise(resolve => { release = resolve; });
  const pending = f.bridge().reconcileTrade(f.trade.id, f.intent.intentId, 102);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.matcher.trade(f.trade.id).settlement, 'unknown');
  assert.equal(f.matcher.snapshot().pendingSettlements, 1);
  release();
  assert.equal((await pending).view.status, 'confirmed');
});

test('bridge rejects forged binding, mismatched intent, and outcome rebinding', async t => {
  const f = await fixture(t);
  assert.throws(() => new SettlementOutcomeBridge({}, {}, identity.deploymentId), /ARGUMENTS/);
  assert.throws(() => new SettlementOutcomeBridge(f.matcher, f.journal, hash('e')), /BINDING/);
  const wrong = f.journal.recordIntent({ pairId: '2', longOrderHash: hash('2'), shortOrderHash: hash('3'),
    size6: '10', price18: '100', sender, nonce: '8' });
  await assert.rejects(() => f.bridge().reconcileTrade(f.trade.id, wrong.intentId, 101), /MISMATCH/);
  await f.bridge().reconcileTrade(f.trade.id, f.intent.intentId, 101);
  assert.throws(() => f.matcher.apply({ type: 'settlementOutcome', at: 102, tradeId: f.trade.id,
    intentId: 'f'.repeat(64), status: 'unknown', reason: 'REORG' }), /CONFLICT/);
});

test('unsupported IOC cannot be reconciled or release pending capacity', async t => {
  const f = await fixture(t, { ioc: true });
  await assert.rejects(() => f.bridge().reconcileTrade(f.trade.id, f.intent.intentId, 101), /UNSUPPORTED_SETTLEMENT_ORDER/);
  assert.equal(f.matcher.snapshot().pendingSettlements, 1);
  assert.equal(f.matcher.trade(f.trade.id).settlement, 'blocked');
});

test('feed rejects forged pending counts and conflicting terminal outcomes', async t => {
  const f = await fixture(t), feed = feedFor(f.matcher);
  const { events } = await f.bridge().reconcileTrade(f.trade.id, f.intent.intentId, 101);
  const bad = structuredClone(events[0]);
  bad.data.pendingSettlements = 0;
  assert.equal(feed.receive(bad), 'resync');
  const fresh = feedFor(f.matcher), snapshot = f.matcher.snapshot();
  assert.equal(fresh.receive({ type: 'settlementOutcome', streamId: snapshot.streamId, marketId: 1, seq: snapshot.seq + 1,
    at: 102, data: { tradeId: f.trade.id, intentId: f.intent.intentId, previousStatus: 'confirmed', status: 'reverted',
      reason: 'REVERTED', pendingSettlements: 0 } }), 'resync');
});

test('legacy command result hashes are unchanged for existing journal replay', () => {
  const matcher = new Matcher('legacy-replay');
  const expected = ['5d788d378749acf7465d450f38780c01617a3701f0f1522bcaf9c4fab0ab81b5',
    '39a88ba92adc087c49f7ace654a99d729128ee378b300df5103053b7ac736371'];
  let index = 0;
  for (const [id, owner, side] of [['old-maker', '1', 'sell'], ['old-taker', '2', 'buy']]) {
    const prepared = matcher.prepare({ type: 'submit', at: 100, order: { id, trader: address(owner), nonce: '1', marketId: 1,
      side, kind: 'limit', size6: '10', limitPrice18: '100', expiry: 1000, reduceOnly: false, postOnly: false, ioc: false } });
    assert.equal(digest({ state: prepared.state, events: prepared.events }), expected[index++]);
    matcher.commit(prepared);
  }
});

test('outcomes for trades outside the recent window remain addressable and reducer counts stay coherent', async t => {
  const f = await fixture(t);
  for (let nonce = 2; nonce <= 130; nonce++) {
    for (const [owner, side] of [['1', 'sell'], ['2', 'buy']]) {
      f.matcher.apply({ type: 'submit', at: 100, order: { id: `older-${owner}-${nonce}`, trader: address(owner), nonce: String(nonce),
        marketId: 1, side, kind: 'limit', size6: '10', limitPrice18: '100', expiry: 1000,
        reduceOnly: false, postOnly: false, ioc: false } });
    }
  }
  assert.equal(f.matcher.snapshot().trades.length, 128);
  assert.equal(f.matcher.snapshot().trades.some(t => t.id === f.trade.id), false);
  const feed = feedFor(f.matcher);
  const result = await f.bridge().reconcileTrade(f.trade.id, f.intent.intentId, 101);
  for (const event of result.events) assert.equal(feed.receive(event), 'applied');
  assert.equal(f.matcher.snapshot().pendingSettlements, 129);
  assert.deepEqual(feed.view().snapshot, f.matcher.snapshot());
});

test('real loopback WebSocket receives canonical outcomes while public mutation/readiness stay unavailable', async t => {
  const f = await fixture(t);
  const server = await startMarketData(f.matcher, 0, () => 101);
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/stream`);
  const frames = [];
  socket.on('message', text => frames.push(JSON.parse(text.toString())));
  async function waitFor(predicate) {
    const end = Date.now() + 5000;
    while (!predicate()) {
      if (Date.now() > end) throw Error('WEBSOCKET_TEST_TIMEOUT');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  try {
    await waitFor(() => frames.length > 0);
    await server.reconcileSettlement(f.bridge(), f.trade.id, f.intent.intentId);
    await waitFor(() => frames.some(frame => frame.data.trades[0]?.settlement === 'confirmed'));
    const feed = new MarketDataFeed();
    for (const frame of frames) assert.equal(feed.receive(frame), 'applied');
    assert.deepEqual(feed.view().snapshot, f.matcher.snapshot());
    const base = `http://127.0.0.1:${server.port}`;
    assert.equal((await fetch(`${base}/ready`)).status, 503);
    assert.equal((await fetch(`${base}/orders`, { method: 'POST', body: '{}' })).status, 503);
    f.state.receipt = null;
    await server.reconcileSettlement(f.bridge(), f.trade.id, f.intent.intentId);
    await waitFor(() => frames.at(-1)?.data.trades[0]?.settlement === 'unknown');
    assert.equal(frames.at(-1).data.pendingSettlements, 1);
  } finally { socket.terminate(); await server.close(); }
});
