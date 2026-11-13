import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, encodeEventTopics, TransactionReceiptNotFoundError } from 'viem';
import { createSettlementReader } from './settlement-reader.ts';
import { MATCHED_FILL_EVENT } from './settlement-journal.ts';

const h = x => `0x${x.repeat(64)}`;
const identity = { chainId: 31337, deploymentId: h('1'), settlementContract: `0x${'a'.repeat(40)}` };
const txHash = h('2'), blockHash = h('3'), longOrderHash = h('4'), shortOrderHash = h('5');
function fixture() {
  const state = { chainId: 31337, code: '0x1234', deploymentId: h('1'), missing: false };
  const log = { address: identity.settlementContract, data: encodeAbiParameters([{ type: 'uint128' }, { type: 'uint128' }], [1_000_000n, 100n * 10n ** 18n]),
    topics: encodeEventTopics({ abi: [MATCHED_FILL_EVENT], eventName: 'MatchedFill', args: { pairId: 1n, longOrderHash, shortOrderHash } }),
    removed: false, logIndex: 1, transactionHash: txHash, blockHash, blockNumber: 10n };
  state.receipt = { transactionHash: txHash, blockHash, blockNumber: 10n, to: identity.settlementContract, status: 'success', logs: [log] };
  const client = {
    getChainId: async () => state.chainId, getCode: async () => state.code, readContract: async () => state.deploymentId,
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
