import test from 'node:test';
import assert from 'node:assert/strict';
import { Matcher, MAX_FEED_BYTES } from './engine.ts';
import { MarketDataFeed } from './feed.ts';
const A = `0x${'1'.repeat(40)}`, B = `0x${'2'.repeat(40)}`;
const frame = e => { const data = e.snapshot(); return { type: 'snapshot', streamId: data.streamId, marketId: data.marketId, seq: data.seq, at: data.clock, data }; };
const command = (id, changes = {}) => ({ type: 'submit', at: 1000, order: { id, trader: A, nonce: '1', marketId: 1, side: 'sell', kind: 'limit',
  size6: '10', limitPrice18: '100', expiry: 2000, reduceOnly: false, postOnly: false, ioc: false, ...changes } });
test('snapshot plus absolute deltas, provisional trades and status reproduces the authoritative book', () => {
  const e = new Matcher('test'), f = new MarketDataFeed(); assert.equal(f.receive(frame(e)), 'applied');
  const events = [...e.apply(command('a')), ...e.apply(command('b', { trader: B, side: 'buy', size6: '4' }))];
  for (const event of events) assert.equal(f.receive(event), 'applied', event.type);
  assert.deepEqual(f.view(), { stale: false, snapshot: e.snapshot() });
  assert.equal(f.view().snapshot.confirmedPositions, null);
  assert.equal(f.view().snapshot.settlement, 'unavailable');
});
test('dropped event freezes state and requests only one resync until a snapshot arrives', () => {
  const e = new Matcher('test'), f = new MarketDataFeed(); const old = frame(e); f.receive(old);
  const events = e.apply(command('a'));
  assert.equal(f.receive(events[1]), 'resync'); assert.equal(f.receive(events[2]), 'waiting');
  assert.equal(f.receive(events[0]), 'waiting'); assert.equal(f.view().stale, true);
  assert.equal(f.view().snapshot.seq, 0);
  assert.equal(f.receive(frame(e)), 'applied'); assert.deepEqual(f.view().snapshot, e.snapshot());
  assert.equal(f.receive(events[0]), 'duplicate'); assert.equal(f.view().stale, false);
});
test('disconnect/reconnect and changed stream require authoritative snapshot, not guessed sequence reset', () => {
  const a = new Matcher('a'), b = new Matcher('b'), f = new MarketDataFeed(); f.receive(frame(a));
  for (const event of a.apply(command('a'))) f.receive(event);
  f.disconnected(); assert.equal(f.view().stale, true);
  assert.equal(f.receive(b.apply(command('b'))[0]), 'resync'); assert.equal(f.view().snapshot.streamId, 'a');
  assert.equal(f.receive(frame(b)), 'applied'); assert.equal(f.view().snapshot.streamId, 'b');
});
test('same-stream rollback during resync stays unavailable', () => {
  const e = new Matcher('test'), f = new MarketDataFeed(), old = frame(e); f.receive(old);
  for (const event of e.apply(command('a'))) f.receive(event);
  f.disconnected(); assert.notEqual(f.receive(old), 'applied'); assert.equal(f.view().stale, true);
  assert.equal(f.receive(frame(e)), 'applied');
});
test('malformed/foreign/oversized payloads cannot mutate or make data look current', () => {
  for (const mutate of [v => v.data.bids.push({ price18: 'NaN', size6: '1', orders: 1 }),
    v => v.marketId = 2, v => v.data.seq = '0', v => v.data.confirmedPositionsAvailable = true,
    v => v.data.extra = true, v => v.seq = -1]) {
    const e = new Matcher('test'), f = new MarketDataFeed(), bad = frame(e); mutate(bad);
    assert.equal(f.receive(bad), 'resync'); assert.equal(f.view().snapshot, null);
  }
  const f = new MarketDataFeed(); assert.equal(f.receiveText('bad json'), 'resync');
  assert.equal(new MarketDataFeed().receiveText(' '.repeat(MAX_FEED_BYTES + 1)), 'resync');
});
test('position source/freshness is explicit and unknown settlement confirmation is rejected', () => {
  const e = new Matcher('test'), f = new MarketDataFeed(); f.receive(frame(e));
  for (const event of e.apply({ type: 'positions', at: 1000, snapshot: { blockNumber: '1', blockHash: `0x${'a'.repeat(64)}`, sourceTime: 1000, values: { [A]: '5' } } })) f.receive(event);
  assert.equal(f.view().snapshot.confirmedPositionsAvailable, true);
  for (const event of e.apply({ type: 'tick', at: 1061 })) f.receive(event);
  assert.equal(f.view().snapshot.confirmedPositionsAvailable, false);
  const before = f.view().snapshot;
  assert.equal(f.receive({ streamId: 'test', marketId: 1, seq: before.seq + 1, at: 1061, type: 'settlement',
    data: { tradeId: 'test:1', status: 'confirmed', transactionHash: 'invented' } }), 'resync');
  assert.deepEqual(f.view().snapshot, before);
});
