import test from 'node:test';
import assert from 'node:assert/strict';
import { Matcher, LIMITS } from './engine.ts';
const A = `0x${'1'.repeat(40)}`, B = `0x${'2'.repeat(40)}`, C = `0x${'3'.repeat(40)}`;
const order = (id, changes = {}) => ({ id, trader: A, nonce: '1', marketId: 1, side: 'sell', kind: 'limit',
  size6: '10', limitPrice18: '100', expiry: 2000, reduceOnly: false, postOnly: false, ioc: false, ...changes });
const submit = (e, id, changes, at = 1000) => e.apply({ type: 'submit', at, order: order(id, changes) });
test('best price then FIFO, same-price aggregation, maker prices and partials', () => {
  const e = new Matcher('test');
  submit(e, 'a', { limitPrice18: '102' }); submit(e, 'b', { nonce: '2', limitPrice18: '100', size6: '4' });
  submit(e, 'c', { nonce: '3', limitPrice18: '100', size6: '8' });
  assert.deepEqual(e.snapshot().asks, [{ price18: '100', size6: '12', orders: 2 }, { price18: '102', size6: '10', orders: 1 }]);
  const events = submit(e, 'buy', { trader: B, side: 'buy', size6: '9', limitPrice18: '102' });
  assert.deepEqual(events.filter(v => v.type === 'trade').map(v => [v.data.maker, v.data.size6, v.data.price18]), [['b', '4', '100'], ['c', '5', '100']]);
  assert.equal(e.snapshot().bestAsk, '100'); assert.equal(e.snapshot().orders.find(v => v.id === 'c').remaining6, '3');
  assert(events.filter(v => v.type === 'trade').every(v => v.data.settlement === 'blocked'));
  assert.equal(e.snapshot().confirmedPositions, null);
});
test('market is price-bounded IOC and does not rest unfilled quantity', () => {
  const e = new Matcher('test'); submit(e, 'a', { size6: '4' });
  submit(e, 'b', { trader: B, side: 'buy', kind: 'market', size6: '10', limitPrice18: '100' });
  const o = e.snapshot().orders.find(v => v.id === 'b');
  assert.equal(o.matched6, '4'); assert.equal(o.cancelled6, '6'); assert.equal(o.remaining6, '0');
  assert.equal(e.snapshot().bestBid, null);
  submit(e, 'c', { trader: C, side: 'buy', kind: 'market', limitPrice18: '1' });
  assert.equal(e.snapshot().orders.find(v => v.id === 'c').matched6, '0');
});
test('owner cancel, expiry and nonce replay cannot mutate through rejection', () => {
  const e = new Matcher('test'); submit(e, 'a', { expiry: 1002 }); const before = e.snapshot();
  for (const command of [{ type: 'cancel', at: 1000, id: 'a', trader: B },
    { type: 'submit', at: 1000, order: order('a', { nonce: '2' }) },
    { type: 'submit', at: 1000, order: order('b') },
    { type: 'submit', at: 1000, order: order('b', { nonce: '2', expiry: 1000 }) }]) {
    assert.throws(() => e.apply(command)); assert.deepEqual(e.snapshot(), before);
  }
  e.apply({ type: 'tick', at: 1002 }); assert.equal(e.snapshot().orders[0].status, 'expired');
  submit(e, 'b', { nonce: '2', side: 'buy' }, 1002);
  e.apply({ type: 'cancel', at: 1002, id: 'b', trader: A }); assert.equal(e.snapshot().bestBid, null);
  assert.throws(() => e.apply({ type: 'cancel', at: 1002, id: 'b', trader: A }));
});
test('post-only and self-trade prevention, with contiguous global event sequence', () => {
  const e = new Matcher('test'); let all = submit(e, 'a', {});
  assert.throws(() => submit(e, 'bad', { trader: B, side: 'buy', postOnly: true }));
  all.push(...submit(e, 'self', { nonce: '2', side: 'buy' }));
  assert.equal(e.snapshot().trades.length, 0); assert.equal(e.snapshot().orders.find(v => v.id === 'self').status, 'cancelled');
  all.push(...e.apply({ type: 'tick', at: 1001 }));
  assert.deepEqual(all.map(v => v.seq), Array.from({ length: all.length }, (_, i) => i + 1));
});
test('reduce-only requires fresh position input and reserves open plus matched reductions', () => {
  const e = new Matcher('test');
  assert.throws(() => submit(e, 'none', { reduceOnly: true }), /REDUCTION/);
  e.apply({ type: 'positions', at: 1000, snapshot: { blockNumber: '1', blockHash: `0x${'a'.repeat(64)}`, sourceTime: 1000, values: { [A]: '10' } } });
  submit(e, 'a', { reduceOnly: true, size6: '6' });
  assert.throws(() => submit(e, 'b', { nonce: '2', reduceOnly: true, size6: '5' }), /REDUCTION/);
  submit(e, 'b', { nonce: '2', reduceOnly: true, size6: '4' });
  submit(e, 'buy', { trader: B, side: 'buy', size6: '20', kind: 'market' });
  assert.equal(e.snapshot().trades.reduce((sum, t) => sum + BigInt(t.size6), 0n), 10n);
  assert.throws(() => submit(e, 'more', { nonce: '3', reduceOnly: true, size6: '1' }), /REDUCTION/);
  assert.equal(e.snapshot().asks.length, 0);
  e.apply({ type: 'tick', at: 1061 }); assert.equal(e.snapshot().confirmedPositionsAvailable, false);
});
test('short reductions, fresh snapshot monotonicity and expiry-driven reduction cancellation', () => {
  const e = new Matcher('test');
  const p = { blockNumber: '5', blockHash: `0x${'b'.repeat(64)}`, sourceTime: 1000, values: { [A]: '-5' } };
  e.apply({ type: 'positions', at: 1000, snapshot: p });
  assert.throws(() => e.apply({ type: 'positions', at: 1000, snapshot: p }));
  submit(e, 'r', { side: 'buy', reduceOnly: true, size6: '5' });
  e.apply({ type: 'tick', at: 1061 }); assert.equal(e.snapshot().orders[0].status, 'cancelled');
});
test('deterministic replay and stale prepared plans cannot overwrite accepted commands', () => {
  const commands = [{ type: 'submit', at: 1000, order: order('a') },
    { type: 'submit', at: 1001, order: order('b', { trader: B, side: 'buy', size6: '3' }) },
    { type: 'cancel', at: 1002, id: 'a', trader: A }];
  const a = new Matcher('test'), b = new Matcher('test');
  assert.deepEqual(commands.flatMap(c => a.apply(c)), commands.flatMap(c => b.apply(c)));
  assert.deepEqual(a.snapshot(), b.snapshot());
  const plan = a.prepare({ type: 'tick', at: 1003 }); a.apply({ type: 'tick', at: 1003 });
  assert.throws(() => a.commit(plan), /STALE/);
});
test('bounded active book rejects atomically and invalid numbers/clock fail closed', () => {
  const e = new Matcher('test');
  for (let i = 1; i <= LIMITS.activeOrders; i++) submit(e, `a${i}`, { nonce: String(i) });
  const before = e.snapshot(); assert.throws(() => submit(e, 'overflow', { nonce: '1000' }), /CAPACITY/);
  assert.deepEqual(e.snapshot(), before);
  for (const patch of [{ size6: '01' }, { size6: 1 }, { limitPrice18: '0' }, { nonce: '18446744073709551616' },
    { trader: 'alice.testnet' }, { marketId: 2 }, { kind: 'unbounded' }, { postOnly: true, ioc: true }]) {
    assert.throws(() => submit(e, 'bad', { nonce: '1001', ...patch })); assert.deepEqual(e.snapshot(), before);
  }
  assert.throws(() => e.apply({ type: 'tick', at: 999 }));
});
