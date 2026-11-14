import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readPolicyConfirmedPositions } from './settlement-reader.ts';
import { JournaledMatcher } from './journal.ts';
import { MarketDataFeed } from './feed.ts';
import { startMarketData } from '../../services/clob/market-data.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const h = x => `0x${x.repeat(64)}`;
const identity = { chainId: 31337, deploymentId: h('1'), settlementContract: `0x${'a'.repeat(40)}` };
const vaultAddr = `0x${'c'.repeat(40)}`;
const longOwner = `0x${'d'.repeat(40)}`;
const shortOwner = `0x${'e'.repeat(40)}`;
const longOrderHash = h('4'), shortOrderHash = h('5');

function makeClient(state) {
  const client = {
    getChainId: async () => state.chainId,
    getCode: async () => state.code,
    readContract: async (req) => {
      (state.reads ??= []).push(req);
      switch (req.functionName) {
        case 'deploymentId': return state.deploymentId;
        case 'vault': return vaultAddr;
        case 'settlementModule': return identity.settlementContract;
        case 'usedPairIds': return state.used;
        case 'nextPairId': return state.nextPairId;
        case 'pairs': {
          const id = Number(req.args[0]);
          const pcfg = (state.pairs && state.pairs[id]) || {};
          const size = pcfg.size ?? state.size;
          const closed = pcfg.closed ?? state.closed;
          const entryPrice = pcfg.entryPrice ?? state.entryPrice;
          const lo = pcfg.longOwner ?? state.longOwner;
          const so = pcfg.shortOwner ?? state.shortOwner;
          state._lastPair = { longOwner: lo, shortOwner: so };
          return [size, closed ? 0n : entryPrice, 0n, 0n, longOrderHash, shortOrderHash];
        }
        case 'pairMargins': {
          const id = Number(req.args[0]);
          const pcfg = (state.pairs && state.pairs[id]) || {};
          const closed = pcfg.closed ?? state.closed;
          const lo = pcfg.longOwner ?? state.longOwner;
          const so = pcfg.shortOwner ?? state.shortOwner;
          const lm = pcfg.longMargin ?? state.longMargin;
          const sm = pcfg.shortMargin ?? state.shortMargin;
          if (closed) return { longOwner: `0x${'0'.repeat(40)}`, shortOwner: `0x${'0'.repeat(40)}`, longMargin6: 0n, shortMargin6: 0n };
          return { longOwner: lo, shortOwner: so, longMargin6: lm, shortMargin6: sm };
        }
        default: throw Error('unexpected read ' + req.functionName);
      }
    },
    getBlock: async ({ blockNumber, blockTag } = {}) => {
      if (blockTag === 'latest') {
        const n = typeof state.headFn === 'function' ? state.headFn() : state.headNumber;
        return { number: n, hash: state.blockHash, timestamp: state.timestamp };
      }
      const bn = blockNumber ?? state.headNumber;
      return { number: bn, hash: state.blockHash, timestamp: state.timestamp };
    },
  };
  return client;
}

function fixture(overrides = {}) {
  const state = {
    chainId: 31337, code: '0x1234', deploymentId: h('1'),
    headNumber: 100n, blockHash: h('3'), timestamp: 1000n,
    nextPairId: 2n, used: true, size: 1_000_000n, closed: false,
    longOwner, shortOwner, longMargin: 10_000_000n, shortMargin: 10_000_000n,
    entryPrice: 100n * 10n ** 18n,
    pairs: null, headFn: null,
    ...overrides,
  };
  const client = makeClient(state);
  return { state, client };
}

test('policy selects confirmed block and returns aggregated positions', async () => {
  const { client, state } = fixture();
  const positions = await readPolicyConfirmedPositions(client, client, identity, { confirmations: 2, now: 1000, maxPairs: 256 });
  assert(state.reads.filter(r => r.functionName !== 'deploymentId' || r.blockNumber !== undefined).every(r => r.blockNumber === 99n));
  assert.throws(() => { positions.values[longOwner] = '0'; }, TypeError);
  assert.equal(positions.blockNumber, '99');
  assert.equal(positions.blockHash, h('3'));
  assert.equal(positions.sourceTime, 1000);
  assert.deepEqual(positions.values, { [longOwner]: '1000000', [shortOwner]: '-1000000' });
});

test('complete enumeration aggregates multiple pairs', async () => {
  const { client } = fixture({ nextPairId: 4n });
  const positions = await readPolicyConfirmedPositions(client, client, identity, { confirmations: 1, now: 1000, maxPairs: 256 });
  assert.equal(positions.blockNumber, '100');
  assert.deepEqual(positions.values, { [longOwner]: '3000000', [shortOwner]: '-3000000' });
});

test('closed pairs contribute zero', async () => {
  const { client } = fixture({ closed: true, size: 0n });
  const positions = await readPolicyConfirmedPositions(client, client, identity, { confirmations: 1, now: 1000, maxPairs: 256 });
  assert.deepEqual(positions.values, {});
});

test('stale source rejected', async () => {
  const { client } = fixture({ timestamp: 900n });
  await assert.rejects(readPolicyConfirmedPositions(client, client, identity, { confirmations: 1, now: 1000, maxPairs: 256 }), /STALE/);
});

test('future source rejected', async () => {
  const { client } = fixture({ timestamp: 1001n });
  await assert.rejects(readPolicyConfirmedPositions(client, client, identity, { confirmations: 1, now: 1000, maxPairs: 256 }), /FUTURE/);
});

test('pair bounds rejected', async () => {
  const { client } = fixture({ nextPairId: 3n });
  await assert.rejects(readPolicyConfirmedPositions(client, client, identity, { confirmations: 1, now: 1000, maxPairs: 1 }), /MAX_PAIRS|BOUNDS/);
});

test('provider disagreement rejected', async () => {
  const { client } = fixture();
  const other = fixture();
  other.state.blockHash = h('6');
  await assert.rejects(readPolicyConfirmedPositions(client, other.client, identity, { confirmations: 1, now: 1000, maxPairs: 256 }), /DISAGREEMENT|REORGED|PROVIDER/);
});

test('depth rollback rejected', async () => {
  const { client, state } = fixture();
  let calls = 0;
  const origHead = state.headNumber;
  state.headFn = () => {
    calls++;
    // Both initial provider heads are sampled before the final confirmation-depth recheck.
    return calls <= 2 ? origHead : origHead - 5n;
  };
  await assert.rejects(readPolicyConfirmedPositions(client, client, identity, { confirmations: 2, now: 1000, maxPairs: 256 }), /ROLLBACK|DEPTH/);
});

test('invalid options rejected', async () => {
  const { client } = fixture();
  await assert.rejects(readPolicyConfirmedPositions(client, client, identity, { confirmations: 0, now: 1000, maxPairs: 1 }), /CONFIRMATIONS|INVALID/);
  await assert.rejects(readPolicyConfirmedPositions(client, client, identity, { confirmations: 1, now: 1000, maxPairs: 0 }), /MAX_PAIRS|INVALID/);
  await assert.rejects(readPolicyConfirmedPositions(client, client, identity, { confirmations: 1, now: 4_294_967_296, maxPairs: 1 }), /TIME|INVALID/);
  await assert.rejects(readPolicyConfirmedPositions(client, client, identity, { confirmations: 1, now: 1000 }), /OPTIONS/);
});

test('unknown usedPairId rejected', async () => {
  const { client } = fixture({ used: false });
  await assert.rejects(readPolicyConfirmedPositions(client, client, identity, { confirmations: 1, now: 1000, maxPairs: 256 }), /UNKNOWN_CANONICAL_POSITION/);
});

test('uses the slower provider head rather than overstating confirmation depth', async () => {
  const primary = fixture({ headNumber: 98n }), secondary = fixture({ headNumber: 100n });
  const snapshot = await readPolicyConfirmedPositions(primary.client, secondary.client, identity,
    { confirmations: 2, now: 1000, maxPairs: 256 });
  assert.equal(snapshot.blockNumber, '97');
});

test('pair counter and ledger state must agree between providers', async () => {
  const primary = fixture(), secondary = fixture({ nextPairId: 3n });
  await assert.rejects(readPolicyConfirmedPositions(primary.client, secondary.client, identity,
    { confirmations: 1, now: 1000, maxPairs: 256 }), /DISAGREEMENT/);
  secondary.state.nextPairId = 2n;
  secondary.state.longMargin += 1n;
  await assert.rejects(readPolicyConfirmedPositions(primary.client, secondary.client, identity,
    { confirmations: 1, now: 1000, maxPairs: 256 }), /DISAGREEMENT/);
});

test('empty enumeration still verifies vault binding and rejects malformed counters', async () => {
  const { client, state } = fixture({ nextPairId: 1n });
  const snapshot = await readPolicyConfirmedPositions(client, client, identity,
    { confirmations: 1, now: 1000, maxPairs: 256 });
  assert.deepEqual(snapshot.values, {});
  assert(state.reads.some(r => r.functionName === 'settlementModule' && r.blockNumber === 100n));
  for (const counter of [0n, -1n, 258n, 2, '2']) {
    state.nextPairId = counter;
    await assert.rejects(readPolicyConfirmedPositions(client, client, identity,
      { confirmations: 1, now: 1000, maxPairs: 256 }), /BOUNDS/);
  }
});

test('invalid owners, negative size/margins and aggregate exposure are refused', async () => {
  for (const overrides of [{ longOwner: 'garbage' }, { size: -1n }, { longMargin: -1n },
    { nextPairId: 3n, size: 10n ** 15n }]) {
    const { client } = fixture(overrides);
    await assert.rejects(readPolicyConfirmedPositions(client, client, identity,
      { confirmations: 1, now: 1000, maxPairs: 256 }), /MISMATCH|BOUNDS/);
  }
});

test('selected block timestamp/number rechecks detect provider mutation', async () => {
  const { client } = fixture();
  const getBlock = client.getBlock;
  let pinnedCalls = 0;
  client.getBlock = async request => {
    const block = await getBlock(request);
    if (request.blockNumber !== undefined && ++pinnedCalls > 2) block.timestamp += 1n;
    return block;
  };
  await assert.rejects(readPolicyConfirmedPositions(client, client, identity,
    { confirmations: 1, now: 1000, maxPairs: 256 }), /REORGED|DISAGREEMENT/);
});

test('trusted service publishes policy-confirmed positions and invalidates them on failed/slow refresh', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'avensdex-position-service-'));
  const binding = { chainId: 43113, marketId: 1, settlementContract: identity.settlementContract };
  const journal = JournaledMatcher.open(dir, binding, true);
  const liveIdentity = { ...identity, chainId: 43113 };
  const { client, state } = fixture({ chainId: 43113 });
  let now = 1000;
  let service = await startMarketData(journal, 0, () => now);
  const snapshot = () => journal.snapshot();
  const feed = new MarketDataFeed();
  const initial = snapshot();
  feed.receive({ streamId: initial.streamId, marketId: 1, seq: initial.seq, at: initial.clock, type: 'snapshot', data: initial });
  try {
    await service.refreshPositions(client, client, liveIdentity, { confirmations: 2, maxPairs: 256 });
    assert.equal(snapshot().confirmedPositionsAvailable, true);
    assert.equal(snapshot().confirmedPositions.sourceTime, 1000);
    // Repeated same-block polling is valid because the old observation is explicitly invalidated first.
    await service.refreshPositions(client, client, liveIdentity, { confirmations: 2, maxPairs: 256 });
    const frame = await (await fetch(`http://127.0.0.1:${service.port}/snapshot`)).json();
    assert.equal(feed.receive(frame), 'applied');
    assert.deepEqual(feed.view().snapshot, snapshot());
    await service.close();
    service = await startMarketData(journal, 0, () => now);
    assert.equal(snapshot().confirmedPositions, null, 'restart must not reuse historical position freshness');
    await service.refreshPositions(client, client, liveIdentity, { confirmations: 2, maxPairs: 256 });
    assert.equal(snapshot().confirmedPositionsAvailable, true);
    state.timestamp = 900n;
    await assert.rejects(service.refreshPositions(client, client, liveIdentity, { confirmations: 2, maxPairs: 256 }), /STALE/);
    assert.equal(snapshot().confirmedPositions, null);
    assert.equal(snapshot().confirmedPositionsAvailable, false);
    state.timestamp = 1000n;
    const getBlock = client.getBlock;
    client.getBlock = async request => { const result = await getBlock(request); now = 1061; return result; };
    await assert.rejects(service.refreshPositions(client, client, liveIdentity, { confirmations: 2, maxPairs: 256 }), /POSITION_SOURCE/);
    assert.equal(snapshot().confirmedPositionsAvailable, false);
    assert.equal((await fetch(`http://127.0.0.1:${service.port}/ready`)).status, 503);
  } finally { await service.close(); journal.close(); rmSync(dir, { recursive: true, force: true }); }
});
