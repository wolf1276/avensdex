import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, decodeFunctionData } from 'viem';
import { readFundingSnapshot, buildFundingPublication } from './funding-reader.ts';
import { defaults } from '../funding/preview.ts';
import { JournaledMatcher } from './journal.ts';
import { startMarketData } from '../../services/clob/market-data.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const h = x => `0x${x.repeat(64)}`;
const addr = c => `0x${c.repeat(40)}`;
const settlement = addr('a');
const oracle = addr('b');
const indexSource = addr('c');
const markSource = addr('d');
const publisher = addr('e');
const code = '0x1234';
const codeHash = keccak256(code);
const identity = {
  chainId: 31337,
  deploymentId: h('1'),
  settlementContract: settlement,
  oracleContract: oracle,
  oracleCodeHash: codeHash,
  marketId: 1,
  confirmations: 2,
  now: 1000,
};

function makeClient(state) {
  const client = {
    getChainId: async () => state.chainId,
    getCode: async ({ address, blockNumber }) => {
      state.codeCalls = state.codeCalls || [];
      state.codeCalls.push({ address, blockNumber });
      if (state.codeByAddress && state.codeByAddress[address]) return state.codeByAddress[address];
      return state.code;
    },
    readContract: async (req) => {
      if (req.address === settlement) {
        switch (req.functionName) {
          case 'deploymentId': return state.deploymentId;
          case 'oracle': return oracle;
          case 'marketId': return state.marketId;
          case 'deploymentChainId': return BigInt(state.chainId);
          default: throw new Error('unexpected settlement read ' + req.functionName);
        }
      }
      if (req.address === oracle) {
        switch (req.functionName) {
          case 'marketId': return state.marketId;
          case 'deploymentChainId': return BigInt(state.chainId);
          case 'fundingPublisher': return publisher;
          case 'indexSource': return indexSource;
          case 'markSource': return markSource;
          case 'indexSourceCodeHash': return state.indexCodeHash;
          case 'markSourceCodeHash': return state.markCodeHash;
          case 'params': return state.params;
          case 'mode': return state.mode;
          case 'revision': return state.revision;
          case 'hasLastEpoch': return state.hasLastEpoch;
          case 'lastEpoch': return state.lastEpoch;
          case 'fundingRatePpm': return state.fundingRatePpm;
          case 'premiumEma': return state.premiumEma;
          case 'rateValidUntil': return state.rateValidUntil;
          case 'price': return { price18: state.oraclePrice, sourceTimestamp: state.oracleSourceTime };
          case 'fundingIndex': return [state.fundingIndex, state.fundingValidUntil];
          default: throw new Error('unexpected oracle read ' + req.functionName);
        }
      }
      if (req.address === indexSource && req.functionName === 'price') {
        return { price18: state.indexPrice, sourceTimestamp: state.indexSourceTime };
      }
      if (req.address === markSource && req.functionName === 'price') {
        return { price18: state.markPrice, sourceTimestamp: state.markSourceTime };
      }
      throw new Error('unexpected read ' + req.functionName + ' ' + req.address);
    },
    getBlock: async ({ blockTag, blockNumber }) => {
      if (blockTag === 'latest') {
        return { number: state.headNumber, hash: state.blockHash, timestamp: state.blockTime };
      }
      return { number: blockNumber, hash: state.blockHash, timestamp: state.blockTime };
    },
  };
  return client;
}

function baseState(overrides = {}) {
  return {
    chainId: 31337,
    code,
    codeByAddress: null,
    deploymentId: h('1'),
    marketId: 1,
    headNumber: 101n,
    blockHash: h('3'),
    blockTime: 1000,
    mode: 1,
    params: Object.values(defaults).map(BigInt),
    revision: 2n,
    hasLastEpoch: true,
    lastEpoch: 0n,
    fundingRatePpm: 220n,
    premiumEma: 1200n,
    rateValidUntil: 1060,
    oraclePrice: 100n * 10n ** 18n,
    oracleSourceTime: 990,
    fundingIndex: 123n,
    fundingValidUntil: 1060,
    indexCodeHash: codeHash,
    markCodeHash: codeHash,
    indexPrice: 100n * 10n ** 18n,
    indexSourceTime: 990,
    markPrice: 10012n * 10n ** 16n,
    markSourceTime: 900,
    ...overrides,
  };
}

test('readFundingSnapshot returns policy-confirmed funding data', async () => {
  const state = baseState();
  const client = makeClient(state);
  const snap = await readFundingSnapshot(client, client, identity);
  assert.equal(snap.blockNumber, '100');
  assert.equal(snap.blockHash, h('3'));
  assert.equal(snap.sourceTime, 1000);
  assert.equal(snap.fundingAvailable, true);
  assert.equal(snap.indexPrice18, (100n * 10n ** 18n).toString());
  assert.equal(snap.markSourceTime, 900);
  assert.equal(snap.fundingRatePpm, '220');
  assert.equal(snap.revision, '2');
});

test('provider block disagreement rejects', async () => {
  const a = baseState();
  const b = baseState();
  b.blockHash = h('6');
  await assert.rejects(readFundingSnapshot(makeClient(a), makeClient(b), identity), /DISAGREEMENT|REORGED|PROVIDER/);
});

test('stale source block rejects', async () => {
  const state = baseState({ blockTime: 900 });
  // now 1000, block 900 => 100 sec > 60
  await assert.rejects(readFundingSnapshot(makeClient(state), makeClient(state), identity), /STALE/);
});

test('wrong oracle identity rejects', async () => {
  const state = baseState();
  const badIdentity = { ...identity, oracleContract: addr('f') };
  await assert.rejects(readFundingSnapshot(makeClient(state), makeClient(state), badIdentity), /unexpected|IDENTITY|MISMATCH|CODE/);
});

test('stale index price rejects', async () => {
  const state = baseState({ indexSourceTime: 900 }); // 100 sec > 60
  await assert.rejects(readFundingSnapshot(makeClient(state), makeClient(state), identity), /STALE/);
});

test('stale mark price rejects', async () => {
  const state = baseState({ markSourceTime: 600 }); // 400 sec > 300
  await assert.rejects(readFundingSnapshot(makeClient(state), makeClient(state), identity), /STALE/);
});

test('epoch replay rejects publication', async () => {
  const state = baseState({ lastEpoch: 0n });
  const client = makeClient(state);
  const snap = await readFundingSnapshot(client, client, identity);
  const replaySnap = { ...snap, lastEpoch: '0' };
  assert.throws(() => buildFundingPublication(replaySnap, 1000), /REPLAY|EPOCH/);
});

test('buildFundingPublication encodes publish(revision,currentEpoch) and is approval-only', async () => {
  const state = baseState({ blockTime: 7200, indexSourceTime: 7190, oracleSourceTime: 7190,
    markSourceTime: 7190, lastEpoch: 1n, rateValidUntil: 7250, fundingValidUntil: 7250 });
  const client = makeClient(state);
  const snap = await readFundingSnapshot(client, client, { ...identity, now: 7200 });
  const now = 7200;
  const pub = buildFundingPublication(snap, now);
  assert.equal(pub.approvalRequired, true);
  assert.equal(pub.executionEnabled, false);
  const decoded = decodeFunctionData({ abi: [{ type: 'function', name: 'publish', inputs: [{ type: 'uint256' }, { type: 'uint256' }] }], data: pub.data });
  assert.equal(decoded.functionName, 'publish');
  assert.equal(decoded.args[0].toString(), snap.revision);
  assert.equal(decoded.args[1].toString(), String(Math.floor(now / 3600)));
  assert.equal(pub.expiresAt, Math.floor(now / 3600) * 3600 + 3600);
  assert.equal(pub.from, publisher);
  assert.equal(pub.to, oracle);
});

test('fresh block cannot mask an index stale at read time or a narrower configured source age', async () => {
  const state = baseState({ blockTime: 950, oracleSourceTime: 900, indexSourceTime: 900 });
  await assert.rejects(readFundingSnapshot(makeClient(state), makeClient(state), identity), /STALE/);
  const tight = baseState();
  tight.params[8] = 1n;
  await assert.rejects(readFundingSnapshot(makeClient(tight), makeClient(tight), identity), /STALE/);
});

test('funding availability uses caller time, not historical selected-block time', async () => {
  const state = baseState({ blockTime: 980, oracleSourceTime: 970, indexSourceTime: 970,
    rateValidUntil: 990, fundingValidUntil: 990 });
  const snap = await readFundingSnapshot(makeClient(state), makeClient(state), identity);
  assert.equal(snap.fundingAvailable, false);
});

test('first publication in epoch zero is allowed only when no epoch has been consumed', async () => {
  const state = baseState({ hasLastEpoch: false, fundingRatePpm: 0n, premiumEma: 0n,
    rateValidUntil: 1000, fundingValidUntil: 1000 });
  const snap = await readFundingSnapshot(makeClient(state), makeClient(state), identity);
  const proposal = buildFundingPublication(snap, 1000);
  assert.equal(proposal.expectedEpoch, '0');
  assert.throws(() => buildFundingPublication({ ...snap, hasLastEpoch: true }, 1000), /REPLAY/);
});

test('invalid parameters, source expiry disagreement and paired state disagreement reject', async () => {
  const wrongParams = baseState(); wrongParams.params[1] = 2001n;
  await assert.rejects(readFundingSnapshot(makeClient(wrongParams), makeClient(wrongParams), identity), /parameters/);
  const expiry = baseState({ fundingValidUntil: 1059 });
  await assert.rejects(readFundingSnapshot(makeClient(expiry), makeClient(expiry), identity), /EXPIRY/);
  await assert.rejects(readFundingSnapshot(makeClient(baseState()), makeClient(baseState({ revision: 3n })), identity), /DISAGREEMENT/);
});

test('proposal cannot restamp stale source observations or accept an unbounded/forged partial snapshot', async () => {
  const state = baseState();
  const snap = await readFundingSnapshot(makeClient(state), makeClient(state), identity);
  assert.throws(() => buildFundingPublication({ ...snap, sourceTime: 7200 }, 7200), /stale/);
  assert.throws(() => buildFundingPublication({ ...snap, extra: true }, 1000), /SCHEMA/);
  assert.throws(() => buildFundingPublication({ ...snap, chainId: 43114 }, 1000), /IDENTITY/);
  assert.throws(() => buildFundingPublication({ ...snap, revision: '9'.repeat(79) }, 1000), /QUANTITY/);
});

test('loopback funding endpoint exposes distinct real observations and fails closed as sources age', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'avensdex-funding-service-'));
  const journal = JournaledMatcher.open(dir, { chainId: 43113, marketId: 1, settlementContract: settlement }, true);
  let now = 1000;
  const service = await startMarketData(journal, 0, () => now);
  const state = baseState({ chainId: 43113 });
  const client = makeClient(state);
  const input = { ...identity, chainId: 43113 };
  const base = `http://127.0.0.1:${service.port}`;
  try {
    assert.equal((await fetch(`${base}/funding`)).status, 503);
    await service.refreshFunding(client, client, input);
    let response = await fetch(`${base}/funding`);
    assert.equal(response.status, 200);
    const dto = await response.json();
    assert.equal(dto.funding.indexPrice18, String(state.indexPrice));
    assert.equal(dto.funding.markPrice18, String(state.markPrice));
    assert.equal(dto.funding.sourceTime, 1000);
    assert.equal(dto.lastProvisionalTradePrice18, null);
    assert.equal((await fetch(`${base}/ready`)).status, 503);
    assert.equal((await fetch(`${base}/funding`, { method: 'POST' })).status, 503);
    now = 1051; // Block is only 51 seconds old, but its actual index observation is 61 seconds old.
    assert.equal((await fetch(`${base}/funding`)).status, 503);
    await assert.rejects(service.refreshFunding(client, client, input), /STALE/);
    Object.assign(state, { blockTime: 1051, oracleSourceTime: 1050, indexSourceTime: 1050, markSourceTime: 1050,
      rateValidUntil: 1080, fundingValidUntil: 1080 });
    await service.refreshFunding(client, client, input);
    assert.equal((await fetch(`${base}/funding`)).status, 200);
    await assert.rejects(service.refreshFunding(client, client, { ...input, oracleCodeHash: h('9') }), /CODE/);
    assert.equal((await fetch(`${base}/funding`)).status, 503);
  } finally { await service.close(); journal.close(); rmSync(dir, { recursive: true, force: true }); }
});
