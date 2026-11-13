import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, encodeEventTopics, TransactionReceiptNotFoundError } from 'viem';
import { createSettlementReader, readCanonicalPosition } from './settlement-reader.ts';
import { MATCHED_FILL_EVENT } from './settlement-journal.ts';

const h = x => `0x${x.repeat(64)}`;
const identity = { chainId: 31337, deploymentId: h('1'), settlementContract: `0x${'a'.repeat(40)}` };
const txHash = h('2'), blockHash = h('3'), longOrderHash = h('4'), shortOrderHash = h('5');
const sender = `0x${'d'.repeat(40)}`;
function fixture() {
  const state = { chainId: 31337, code: '0x1234', deploymentId: h('1'), missing: false };
  const log = { address: identity.settlementContract, data: encodeAbiParameters([{ type: 'uint128' }, { type: 'uint128' }], [1_000_000n, 100n * 10n ** 18n]),
    topics: encodeEventTopics({ abi: [MATCHED_FILL_EVENT], eventName: 'MatchedFill', args: { pairId: 1n, longOrderHash, shortOrderHash } }),
    removed: false, logIndex: 1, transactionHash: txHash, blockHash, blockNumber: 10n };
  state.receipt = { transactionHash: txHash, blockHash, blockNumber: 10n, from: sender,
    to: identity.settlementContract, status: 'success', logs: [log] };
  const client = {
    getChainId: async () => state.chainId, getCode: async () => state.code, readContract: async () => state.deploymentId,
    getTransaction: async () => ({ hash: txHash, from: sender, to: identity.settlementContract, nonce: 0 }),
    getTransactionReceipt: async () => {
      if (state.missing) throw new TransactionReceiptNotFoundError({ hash: txHash });
      return structuredClone(state.receipt);
    },
    getBlock: async ({ blockNumber }) => ({ number: blockNumber ?? 12n, hash: blockHash }),
  };
  return { state, client, log };
}

test('RPC adapter decodes actual ABI bytes and returns only bound settlement events', async () => {
  const { client, state } = fixture();
  state.receipt.logs.unshift({ ...state.receipt.logs[0], address: `0x${'b'.repeat(40)}` });
  const reader = await createSettlementReader(client, client, identity);
  const receipt = await reader.getReceipt(txHash);
  assert.equal(receipt.txHash, txHash);
  assert.equal(receipt.sender, sender);
  assert.equal(receipt.nonce, '0');
  assert.equal(receipt.logs.length, 1);
  assert.deepEqual(receipt.logs[0], { contract: identity.settlementContract, pairId: '1', longOrderHash, shortOrderHash,
    size6: '1000000', price18: '100000000000000000000', txHash, blockNumber: '10', blockHash, logIndex: 1 });
  assert.deepEqual(await reader.getCanonicalHead(), { number: '12', hash: blockHash });
  assert.equal(await reader.getCanonicalBlockHash('10'), blockHash);
  await assert.rejects(reader.getCanonicalBlockHash('01'), /INVALID_READER_BLOCK/);
});

test('RPC adapter verifies both chains, code and deployment identity, including after startup', async () => {
  const { client, state } = fixture();
  const reader = await createSettlementReader(client, client, identity);
  state.chainId = 43114;
  await assert.rejects(reader.getReceipt(txHash), /CHAIN_MISMATCH/);
  state.chainId = 31337;
  state.deploymentId = h('6');
  await assert.rejects(reader.getCanonicalHead(), /DEPLOYMENT_MISMATCH/);
  state.deploymentId = identity.deploymentId;
  state.code = '0x5678';
  await assert.rejects(reader.getCanonicalHead(), /CODE_CHANGED/);
  state.code = '0x';
  await assert.rejects(createSettlementReader(client, client, identity), /CODE_MISSING/);
  const other = fixture();
  state.code = '0x1234';
  other.state.chainId = 43113;
  await assert.rejects(createSettlementReader(client, other.client, identity), /CHAIN_MISMATCH/);
});

test('unknown receipt is unavailable, not a fabricated fill; other RPC errors propagate', async () => {
  const { client, state } = fixture();
  const reader = await createSettlementReader(client, client, identity);
  state.missing = true;
  assert.equal(await reader.getReceipt(txHash), null);
  client.getTransactionReceipt = async () => { throw Error('RPC_DOWN'); };
  await assert.rejects(reader.getReceipt(txHash), /RPC_DOWN/);
});

test('receipt target, transaction identity and malformed/removed settlement logs fail closed', async () => {
  for (const mutate of [
    x => { x.receipt.to = `0x${'b'.repeat(40)}`; },
    x => { x.receipt.transactionHash = h('6'); },
    x => { x.receipt.logs[0].removed = true; },
    x => { x.receipt.logs[0].blockHash = h('6'); },
    x => { x.receipt.logs[0].blockNumber = 9n; },
    x => { x.receipt.logs[0].transactionHash = h('6'); },
    x => { x.receipt.logs[0].data = '0x'; },
  ]) {
    const { client, state } = fixture();
    const reader = await createSettlementReader(client, client, identity);
    mutate(state);
    await assert.rejects(reader.getReceipt(txHash));
  }
});

test('reader pins immutable input and rejects canonical provider disagreement', async () => {
  const { client } = fixture();
  const input = { ...identity };
  const reader = await createSettlementReader(client, client, input);
  input.chainId = 1;
  assert.equal((await reader.getReceipt(txHash)).logs.length, 1);
  client.getBlock = async () => ({ number: 9n, hash: blockHash });
  await assert.rejects(reader.getCanonicalBlockHash('10'), /BLOCK_MISMATCH/);
  await assert.rejects(createSettlementReader(client, client, { ...identity, chainId: 1 }), /IDENTITY/);
});


function positionFixture() {
  const f = fixture(), calls = [];
  const state = { used: true, size: 1_000_000n, closed: false };
  f.client.readContract = async request => {
    calls.push(request);
    switch (request.functionName) {
      case 'deploymentId': return identity.deploymentId;
      case 'vault': return `0x${'c'.repeat(40)}`;
      case 'settlementModule': return identity.settlementContract;
      case 'usedPairIds': return state.used;
      case 'pairs': return [state.size, state.closed ? 0n : 100n * 10n ** 18n, 0n, 0n, longOrderHash, shortOrderHash];
      case 'pairMargins': return { longOwner: `0x${(state.closed ? '0' : 'd').repeat(40)}`,
        shortOwner: `0x${(state.closed ? '0' : 'e').repeat(40)}`, longMargin6: state.closed ? 0n : 10_000_000n,
        shortMargin6: state.closed ? 0n : 10_000_000n };
      default: throw Error('unexpected read');
    }
  };
  return { ...f, state, calls };
}

test('current positions use canonical contract metadata and vault margins at one pinned block', async () => {
  const { client, calls, state } = positionFixture();
  const position = await readCanonicalPosition(client, client, identity, '1');
  assert.equal(position.closed, false);
  assert.equal(position.blockNumber, '12');
  assert.equal(position.size6, '1000000');
  assert.equal(position.longMargin6, '10000000');
  assert(calls.filter(call => call.functionName !== 'deploymentId').every(call => call.blockNumber === 12n));
  state.size = 0n; state.closed = true;
  const closed = await readCanonicalPosition(client, client, identity, '1');
  assert.equal(closed.closed, true);
  assert.equal(closed.longMargin6, '0');
  state.used = false;
  await assert.rejects(readCanonicalPosition(client, client, identity, '1'), /UNKNOWN_CANONICAL_POSITION/);
  await assert.rejects(readCanonicalPosition(client, client, identity, '0'), /INVALID_POSITION_ID/);
});

test('position readers reject incoherent ledger state and reorg during pinned reads', async () => {
  const { client, state } = positionFixture();
  state.closed = true; // Active metadata with missing margin owners is inconsistent, not an empty position.
  await assert.rejects(readCanonicalPosition(client, client, identity, '1'), /LEDGER_MISMATCH/);
  state.closed = false;
  let reads = 0;
  client.getBlock = async ({ blockNumber }) => ({ number: blockNumber ?? 12n, hash: ++reads >= 4 ? h('6') : blockHash });
  await assert.rejects(readCanonicalPosition(client, client, identity, '1'), /POSITION_BLOCK_REORGED/);
});


test('receipt confirmation verifies immutable transaction sender and transport nonce, not only fill logs', async () => {
  const { client } = fixture();
  const reader = await createSettlementReader(client, client, identity);
  client.getTransaction = async () => ({ hash: txHash, from: `0x${'e'.repeat(40)}`, to: identity.settlementContract, nonce: 0 });
  await assert.rejects(reader.getReceipt(txHash), /TRANSACTION_IDENTITY/);
});
