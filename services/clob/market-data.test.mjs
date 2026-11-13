import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { JournaledMatcher } from '../../packages/clob/journal.ts';
import { MarketDataFeed } from '../../packages/clob/feed.ts';
import { startMarketData, sendBounded, MAX_BUFFERED_BYTES, MAX_CLIENTS } from './market-data.ts';
const A = `0x${'1'.repeat(40)}`;
const command = { type: 'submit', at: 1000, order: { id: 'a', trader: A, nonce: '1', marketId: 1, side: 'sell', kind: 'limit',
  size6: '10', limitPrice18: '100', expiry: 2000, reduceOnly: false, postOnly: false, ioc: false } };
async function setup(t, clock = () => 1000) {
  const dir = mkdtempSync(join(tmpdir(), 'avensdex-feed-test-'));
  const journal = JournaledMatcher.open(dir, { chainId: 43113, marketId: 1, settlementContract: null }, true);
  const service = await startMarketData(journal, 0, clock), sockets = [];
  t.after(async () => { for (const socket of sockets) socket.terminate(); await service.close(); journal.close(); rmSync(dir, { recursive: true, force: true }); });
  const http = `http://127.0.0.1:${service.port}`, url = `ws://127.0.0.1:${service.port}/stream`;
  async function connect(options = {}) {
    const ws = new WebSocket(url, options); sockets.push(ws); ws.on('error', () => {});
    const messages = [], waiters = [];
    ws.on('message', text => { const value = JSON.parse(text.toString()); const waiter = waiters.shift(); if (waiter) waiter(value); else messages.push(value); });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const next = () => messages.length ? Promise.resolve(messages.shift()) : new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { const index = waiters.indexOf(done); if (index >= 0) waiters.splice(index, 1); reject(Error('message timeout')); }, 5000);
      const done = value => { clearTimeout(timeout); resolve(value); }; waiters.push(done);
    });
    return { ws, next };
  }
  return { journal, service, http, connect };
}
test('HTTP readiness is unavailable; unsigned writes cannot change the book', async t => {
  const { http, journal } = await setup(t);
  const health = await (await fetch(`${http}/health`)).json();
  assert.equal(health.chainId, 43113); assert.equal(health.ready, false); assert.equal(health.settlement, 'unavailable');
  assert.equal((await fetch(`${http}/ready`)).status, 503);
  const before = journal.snapshot();
  const write = await fetch(`${http}/orders`, { method: 'POST', body: JSON.stringify(command), headers: { 'Content-Type': 'application/json' } });
  assert.equal(write.status, 503); assert.deepEqual(journal.snapshot(), before);
  const snapshot = await (await fetch(`${http}/snapshot`)).json(); assert.equal(snapshot.type, 'snapshot'); assert.equal(snapshot.seq, 0);
  assert.equal((await fetch(`${http}/snapshot`, { headers: { Origin: 'https://evil.example' } })).status, 403);
});
test('real WebSocket snapshots and durable sequenced updates reproduce authoritative state', async t => {
  const { connect, service, journal } = await setup(t), peer = await connect(), feed = new MarketDataFeed();
  assert.equal(feed.receive(await peer.next()), 'applied');
  const { events } = service.apply(command);
  for (const expected of events) { const event = await peer.next(); assert.deepEqual(event, expected); assert.equal(feed.receive(event), 'applied'); }
  assert.deepEqual(feed.view().snapshot, journal.snapshot()); assert.equal(feed.view().snapshot.confirmedPositions, null);
});
test('dropped frame resync and reconnect get a current snapshot without sequence guessing', async t => {
  const { connect, service, journal } = await setup(t), peer = await connect(), feed = new MarketDataFeed(); feed.receive(await peer.next());
  const { events } = service.apply(command);
  const received = []; for (let i = 0; i < events.length; i++) received.push(await peer.next());
  assert.equal(feed.receive(received[1]), 'resync');
  peer.ws.send(JSON.stringify({ type: 'resync' })); assert.equal(feed.receive(await peer.next()), 'applied');
  assert.deepEqual(feed.view().snapshot, journal.snapshot());
  peer.ws.terminate(); feed.disconnected();
  service.apply({ type: 'cancel', at: 1000, id: 'a', trader: A });
  const next = await connect(); assert.equal(feed.receive(await next.next()), 'applied');
  assert.equal(feed.view().snapshot.bestAsk, null); assert.equal(feed.view().stale, false);
});
test('expiry ticker emits sequenced removal rather than letting an expired order rest', async t => {
  let now = 1000; const { connect, service } = await setup(t, () => now), peer = await connect(); await peer.next();
  const { events } = service.apply({ ...command, order: { ...command.order, expiry: 1001 } });
  for (let i = 0; i < events.length; i++) await peer.next();
  now = 1001; const expired = await peer.next(); assert.equal(expired.type, 'order'); assert.equal(expired.data.status, 'expired');
});
test('nonlocal origins, excessive connections and oversized frames are refused', async t => {
  const { connect } = await setup(t);
  await assert.rejects(connect({ origin: 'https://evil.example' }));
  const peers = []; for (let i = 0; i < MAX_CLIENTS; i++) peers.push(await connect());
  await assert.rejects(connect());
  const closed = new Promise(resolve => peers[0].ws.once('close', resolve));
  peers[0].ws.send('x'.repeat(2048)); assert.equal(await closed, 1009);
});
test('invalid resync messages cannot inject book/position state', async t => {
  const { connect, journal } = await setup(t), peer = await connect(); await peer.next();
  const before = journal.snapshot(), closed = new Promise(resolve => peer.ws.once('close', resolve));
  peer.ws.send(JSON.stringify({ type: 'positions', values: { [A]: '1000000' } }));
  assert.equal(await closed, 1008); assert.deepEqual(journal.snapshot(), before);
});
test('slow or failed consumers cannot block producer acknowledgments', () => {
  let closed = false, terminated = false;
  const slow = { readyState: 1, bufferedAmount: MAX_BUFFERED_BYTES, close: () => { closed = true; }, terminate: () => {}, send: () => assert.fail('must not send') };
  assert.equal(sendBounded(slow, 'x'), false); assert.equal(closed, true);
  const failed = { ...slow, bufferedAmount: 0, close: () => {}, terminate: () => { terminated = true; }, send: () => { throw Error('closed'); } };
  assert.equal(sendBounded(failed, 'x'), false); assert.equal(terminated, true);
});
