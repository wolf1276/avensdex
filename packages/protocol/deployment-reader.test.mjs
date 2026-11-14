import test from 'node:test';
import assert from 'node:assert/strict';
import { TransactionNotFoundError, TransactionReceiptNotFoundError } from 'viem';
import { createDeploymentReader } from './deployment-reader.ts';
import { parseDeploymentReaderArgs, runDeploymentReaderCommand } from './deployment-reader-cli.ts';

const hex = c => `0x${c.repeat(64)}`;
const addr = c => `0x${c.repeat(40)}`;
const NOW = 1_800_000_000;
const TX_HASH = hex('1'), BLOCK_100 = hex('b'), BLOCK_101 = hex('c'), BLOCK_102 = hex('d');
const FROM = addr('a'), TO = addr('d'), CREATED = addr('e');

function block(number, hash, timestamp) {
  return { number, hash, timestamp: BigInt(timestamp) };
}
function tx(overrides = {}) {
  return {
    hash: TX_HASH, chainId: 43113, type: 'eip1559', from: FROM, to: TO,
    nonce: 0, value: 0n, input: '0x1234', gas: 21000n,
    maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 100_000_000n, ...overrides,
  };
}
function receipt(overrides = {}) {
  return {
    transactionHash: TX_HASH, status: 'success', blockNumber: 100n, blockHash: BLOCK_100,
    from: FROM, to: TO, contractAddress: null, gasUsed: 21000n, ...overrides,
  };
}
function client(overrides = {}) {
  const state = {
    chainId: 43113, latest: 101n,
    blocks: new Map([
      [100n, block(100n, BLOCK_100, NOW - 10)],
      [101n, block(101n, BLOCK_101, NOW - 5)],
      [102n, block(102n, BLOCK_102, NOW - 2)],
    ]),
    transaction: tx(), receipt: receipt(), code: '0x60016001',
    txMode: 'ok', receiptMode: 'ok',
    ...overrides,
  };
  const calls = { blocks: [], codes: [] };
  return {
    state, calls,
    async getChainId() { return state.chainId; },
    async getTransaction({ hash }) {
      if (state.txMode === 'missing') throw new TransactionNotFoundError({ hash });
      if (state.txMode === 'error') throw new Error('RPC_DOWN');
      return structuredClone(state.transaction);
    },
    async getTransactionReceipt({ hash }) {
      if (state.receiptMode === 'missing') throw new TransactionReceiptNotFoundError({ hash });
      if (state.receiptMode === 'error') throw new Error('RPC_DOWN');
      return structuredClone(state.receipt);
    },
    async getBlock({ blockTag, blockNumber }) {
      calls.blocks.push(blockTag ?? blockNumber);
      if (typeof state.getBlock === 'function') return state.getBlock({ blockTag, blockNumber, calls });
      const number = blockTag === 'latest' ? state.latest : blockNumber;
      const value = state.blocks.get(number);
      if (!value) throw new Error('BLOCK_NOT_FOUND');
      return structuredClone(value);
    },
    async getCode({ address, blockNumber }) {
      calls.codes.push({ address, blockNumber });
      if (typeof state.getCode === 'function') return state.getCode({ address, blockNumber, calls });
      if (state.codeMode === 'error') throw new Error('RPC_DOWN');
      return state.code;
    },
  };
}
const reader = (left, right, options = { now: () => NOW }) => createDeploymentReader(left, right, options);

test('creation requires both providers on Fuji 43113', async () => {
  const a = client(), b = client();
  assert.ok(await createDeploymentReader(a, b));
  const wrong = client({ chainId: 43114 });
  await assert.rejects(createDeploymentReader(wrong, b), /CHAIN_MISMATCH/);
  await assert.rejects(createDeploymentReader(a, wrong), /CHAIN_MISMATCH/);
});

test('getTransaction returns the exact DeploymentJournal schema from both providers', async () => {
  const a = client(), b = client();
  a.state.transaction = tx({ input: '0xAB', from: `0x${'A'.repeat(40)}`, to: `0x${'D'.repeat(40)}` });
  b.state.transaction = tx({ input: '0xAB', from: `0x${'A'.repeat(40)}`, to: `0x${'D'.repeat(40)}` });
  const value = await (await reader(a, b)).getTransaction(TX_HASH);
  assert.deepEqual(value, {
    hash: TX_HASH, chainId: 43113, from: FROM, to: TO, nonce: '0',
    value: '0', input: '0xab', gas: 21000,
    maxFeePerGas: '1000000000', maxPriorityFeePerGas: '100000000',
  });
  assert.deepEqual(Object.keys(value), ['hash', 'chainId', 'from', 'to', 'nonce', 'value', 'input',
    'gas', 'maxFeePerGas', 'maxPriorityFeePerGas']);
});

test('getTransaction rejects malformed, unbounded and non-EIP1559 fields', async () => {
  const cases = [
    [{ nonce: -1 }, /QUANTITY|BOUNDS/], [{ nonce: 1.5 }, /QUANTITY/],
    [{ nonce: Number.MAX_SAFE_INTEGER + 1 }, /QUANTITY/],
    [{ gas: 0n }, /QUANTITY|BOUNDS/], [{ gas: 30_000_001n }, /BOUNDS/],
    [{ maxFeePerGas: 0n }, /QUANTITY|BOUNDS/], [{ maxPriorityFeePerGas: -1n }, /QUANTITY|BOUNDS/],
    [{ value: 1n << 128n }, /BOUNDS/], [{ chainId: 43114 }, /CHAIN/], [{ type: 'legacy' }, /TYPE/],
    [{ input: '0x1' }, /INPUT/], [{ input: '0xzz' }, /INPUT/], [{ hash: hex('9') }, /HASH/],
    [{ from: addr('0') }, /ADDRESS/], [{ to: addr('0') }, /ADDRESS/],
  ];
  for (const [changes, pattern] of cases) {
    const a = client(), b = client();
    a.state.transaction = tx(changes); b.state.transaction = tx(changes);
    await assert.rejects((await reader(a, b)).getTransaction(TX_HASH), pattern);
  }
  const a = client(), b = client(), r = await reader(a, b);
  await assert.rejects(r.getTransaction('0x01'), /HASH/);
  await assert.rejects(r.getTransaction(hex('0')), /HASH/);
});

test('getTransaction rejects provider disagreement', async () => {
  for (const changes of [{ gas: 22000n }, { from: addr('f') }, { input: '0x5678' }, { nonce: 1 }]) {
    const a = client(), b = client();
    b.state.transaction = tx(changes);
    await assert.rejects((await reader(a, b)).getTransaction(TX_HASH), /DISAGREEMENT/);
  }
});

test('getTransaction returns null only when both providers report not found', async () => {
  let a = client({ txMode: 'missing' }), b = client({ txMode: 'missing' });
  assert.equal(await (await reader(a, b)).getTransaction(TX_HASH), null);
  a = client({ txMode: 'missing' }); b = client();
  await assert.rejects((await reader(a, b)).getTransaction(TX_HASH), /DISAGREEMENT/);
  a = client({ txMode: 'missing' }); b = client({ txMode: 'error' });
  await assert.rejects((await reader(a, b)).getTransaction(TX_HASH), /RPC_DOWN/);
  a = client({ txMode: 'error' }); b = client({ txMode: 'error' });
  await assert.rejects((await reader(a, b)).getTransaction(TX_HASH), /RPC_DOWN/);
});

test('getReceipt returns the exact DeploymentJournal schema from both providers', async () => {
  const a = client(), b = client(), r = await reader(a, b);
  const value = await r.getReceipt(TX_HASH);
  assert.deepEqual(value, {
    transactionHash: TX_HASH, status: 'success', blockNumber: '100', blockHash: BLOCK_100,
    from: FROM, to: TO, contractAddress: null, gasUsed: '21000',
  });
  assert.deepEqual(Object.keys(value), ['transactionHash', 'status', 'blockNumber', 'blockHash',
    'from', 'to', 'contractAddress', 'gasUsed']);
  a.state.receipt = receipt({ to: null, contractAddress: CREATED });
  b.state.receipt = receipt({ to: null, contractAddress: CREATED });
  assert.deepEqual(await r.getReceipt(TX_HASH), {
    transactionHash: TX_HASH, status: 'success', blockNumber: '100', blockHash: BLOCK_100,
    from: FROM, to: null, contractAddress: CREATED, gasUsed: '21000',
  });
});

test('getReceipt rejects malformed status, block identity, gas and addresses', async () => {
  const cases = [
    [{ status: 'unknown' }, /STATUS/], [{ transactionHash: hex('9') }, /HASH/],
    [{ blockNumber: -1n }, /QUANTITY|BOUNDS/], [{ blockNumber: 1.5 }, /QUANTITY/],
    [{ blockHash: hex('0') }, /HASH/], [{ gasUsed: 30_000_001n }, /BOUNDS/],
    [{ gasUsed: -1n }, /QUANTITY|BOUNDS/], [{ from: addr('0') }, /ADDRESS/],
    [{ contractAddress: CREATED }, /CONTRACT/], [{ to: '0x1' }, /ADDRESS/],
  ];
  for (const [changes, pattern] of cases) {
    const a = client(), b = client();
    a.state.receipt = receipt(changes); b.state.receipt = receipt(changes);
    await assert.rejects((await reader(a, b)).getReceipt(TX_HASH), pattern);
  }
});

test('getReceipt rejects disagreement and one-sided not found', async () => {
  let a = client(), b = client();
  b.state.receipt = receipt({ gasUsed: 22000n });
  await assert.rejects((await reader(a, b)).getReceipt(TX_HASH), /DISAGREEMENT/);
  a = client({ receiptMode: 'missing' }); b = client({ receiptMode: 'missing' });
  assert.equal(await (await reader(a, b)).getReceipt(TX_HASH), null);
  a = client({ receiptMode: 'missing' }); b = client();
  await assert.rejects((await reader(a, b)).getReceipt(TX_HASH), /DISAGREEMENT/);
  a = client({ receiptMode: 'missing' }); b = client({ receiptMode: 'error' });
  await assert.rejects((await reader(a, b)).getReceipt(TX_HASH), /RPC_DOWN/);
});

test('getCanonicalHead chooses the lower latest height and matches that exact block from both', async () => {
  const a = client(), b = client();
  b.state.latest = 102n;
  assert.deepEqual(await (await reader(a, b)).getCanonicalHead(), { number: '101', hash: BLOCK_101 });
  assert.deepEqual(a.calls.blocks.filter(value => value === 101n), [101n, 101n]);
  assert.deepEqual(b.calls.blocks.filter(value => value === 101n), [101n, 101n]);
  const c = client(), d = client();
  d.state.latest = 100n;
  assert.deepEqual(await (await reader(c, d)).getCanonicalHead(), { number: '100', hash: BLOCK_100 });
});

test('getCanonicalHead rejects future and stale source timestamps', async () => {
  let a = client(), b = client();
  a.state.blocks.set(101n, block(101n, BLOCK_101, NOW + 1));
  b.state.blocks.set(101n, block(101n, BLOCK_101, NOW + 1));
  await assert.rejects((await reader(a, b)).getCanonicalHead(), /FUTURE/);
  a = client(); b = client();
  a.state.blocks.set(101n, block(101n, BLOCK_101, NOW - 121));
  b.state.blocks.set(101n, block(101n, BLOCK_101, NOW - 121));
  await assert.rejects((await reader(a, b)).getCanonicalHead(), /STALE/);
  a = client(); b = client();
  a.state.blocks.set(101n, block(101n, BLOCK_101, NOW - 120));
  b.state.blocks.set(101n, block(101n, BLOCK_101, NOW - 120));
  assert.equal((await (await reader(a, b)).getCanonicalHead()).number, '101');
});

test('getCanonicalHead rejects provider disagreement and a reorg after reads', async () => {
  let a = client(), b = client();
  b.state.blocks.set(101n, block(101n, hex('f'), NOW - 5));
  await assert.rejects((await reader(a, b)).getCanonicalHead(), /DISAGREEMENT/);
  a = client(); b = client();
  let reads = 0;
  a.state.getBlock = ({ blockTag, blockNumber }) => blockTag === 'latest'
    ? block(101n, BLOCK_101, NOW - 5)
    : block(blockNumber, ++reads >= 2 ? hex('f') : BLOCK_101, NOW - 5);
  await assert.rejects((await reader(a, b)).getCanonicalHead(), /CHANGED|DISAGREEMENT/);
});

test('getCanonicalBlockHash validates decimal bounds and matches both providers', async () => {
  const a = client(), b = client(), r = await reader(a, b);
  assert.equal(await r.getCanonicalBlockHash('100'), BLOCK_100);
  for (const bad of ['01', '-1', '1.0', '', '18446744073709551616', 100, null]) {
    await assert.rejects(r.getCanonicalBlockHash(bad), /INVALID_READER_BLOCK/);
  }
  b.state.blocks.set(100n, block(100n, hex('f'), NOW - 10));
  await assert.rejects(r.getCanonicalBlockHash('100'), /DISAGREEMENT/);
  b.state.blocks.set(100n, block(101n, BLOCK_100, NOW - 10));
  await assert.rejects(r.getCanonicalBlockHash('100'), /DISAGREEMENT/);
});

test('getCode pins the same canonical block before and after paired reads', async () => {
  const a = client(), b = client(), r = await reader(a, b);
  assert.equal(await r.getCode(TO, '100'), '0x60016001');
  assert.deepEqual(a.calls.codes, [{ address: TO, blockNumber: 100n }]);
  assert.deepEqual(b.calls.codes, [{ address: TO, blockNumber: 100n }]);
  assert.deepEqual(a.calls.blocks, [100n, 100n]);
  const c = client(), d = client();
  let reads = 0;
  const next = ({ blockNumber }) => block(blockNumber, ++reads > 2 ? hex('f') : BLOCK_100, NOW - 10);
  c.state.getBlock = next; d.state.getBlock = next;
  await assert.rejects((await reader(c, d)).getCode(TO, '100'), /REORG/);
});

test('getCode returns 0x for undeployed code and rejects provider disagreement', async () => {
  let a = client({ code: '0x' }), b = client({ code: '0x' });
  assert.equal(await (await reader(a, b)).getCode(TO, '100'), '0x');
  a = client({ code: undefined }); b = client({ code: undefined });
  assert.equal(await (await reader(a, b)).getCode(TO, '100'), '0x');
  a = client({ code: '0x' }); b = client({ code: '0x6001' });
  await assert.rejects((await reader(a, b)).getCode(TO, '100'), /DISAGREEMENT/);
  a = client({ code: '0x1' }); b = client({ code: '0x1' });
  await assert.rejects((await reader(a, b)).getCode(TO, '100'), /INVALID_RPC_CODE/);
  a = client(); b = client();
  await assert.rejects((await reader(a, b)).getCode(addr('0'), '100'), /ADDRESS/);
  await assert.rejects((await reader(a, b)).getCode(TO, '01'), /INVALID_READER_BLOCK/);
});

test('every reader method re-verifies both Fuji chain IDs', async () => {
  const a = client(), b = client(), r = await reader(a, b);
  const methods = [
    () => r.getTransaction(TX_HASH), () => r.getReceipt(TX_HASH), () => r.getCanonicalHead(),
    () => r.getCanonicalBlockHash('100'), () => r.getCode(TO, '100'),
  ];
  for (const call of methods) {
    a.state.chainId = 43113; b.state.chainId = 43113;
    assert.ok(await call());
    b.state.chainId = 43114;
    await assert.rejects(call(), /CHAIN_MISMATCH/);
  }
});

test('CLI parses only read-only commands with exact operands', () => {
  assert.deepEqual(parseDeploymentReaderArgs(['head']), { method: 'getCanonicalHead' });
  assert.deepEqual(parseDeploymentReaderArgs(['block', '100']), { method: 'getCanonicalBlockHash', block: '100' });
  assert.deepEqual(parseDeploymentReaderArgs(['transaction', TX_HASH]), { method: 'getTransaction', hash: TX_HASH });
  assert.deepEqual(parseDeploymentReaderArgs(['receipt', TX_HASH]), { method: 'getReceipt', hash: TX_HASH });
  assert.deepEqual(parseDeploymentReaderArgs(['code', TO, '100']), { method: 'getCode', address: TO, block: '100' });
  for (const args of [[], ['send'], ['head', 'extra'], ['block'], ['transaction', TX_HASH, 'extra'], ['code', TO]]) {
    assert.throws(() => parseDeploymentReaderArgs(args), /INVALID_DEPLOYMENT_READER_ARGS/);
  }
});

test('CLI routes commands to the reader without adding write authority', async () => {
  const calls = [];
  const fake = {
    async getTransaction(hash) { calls.push(['getTransaction', hash]); return { hash }; },
    async getReceipt(hash) { calls.push(['getReceipt', hash]); return { hash }; },
    async getCanonicalHead() { calls.push(['getCanonicalHead']); return { number: '101' }; },
    async getCanonicalBlockHash(block) { calls.push(['getCanonicalBlockHash', block]); return BLOCK_100; },
    async getCode(address, block) { calls.push(['getCode', address, block]); return '0x60016001'; },
  };
  assert.deepEqual(await runDeploymentReaderCommand(fake, parseDeploymentReaderArgs(['head'])), { number: '101' });
  assert.equal(await runDeploymentReaderCommand(fake, parseDeploymentReaderArgs(['block', '100'])), BLOCK_100);
  assert.deepEqual(await runDeploymentReaderCommand(fake, parseDeploymentReaderArgs(['transaction', TX_HASH])), { hash: TX_HASH });
  assert.deepEqual(await runDeploymentReaderCommand(fake, parseDeploymentReaderArgs(['receipt', TX_HASH])), { hash: TX_HASH });
  assert.equal(await runDeploymentReaderCommand(fake, parseDeploymentReaderArgs(['code', TO, '100'])), '0x60016001');
  assert.deepEqual(calls, [
    ['getCanonicalHead'], ['getCanonicalBlockHash', '100'], ['getTransaction', TX_HASH],
    ['getReceipt', TX_HASH], ['getCode', TO, '100'],
  ]);
});
