import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeDeployData, encodeFunctionData, keccak256 } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { DeploymentJournal, buildDeploymentPlan } from './deployment.ts';
import {
  parseDeploymentReconcileArgs, readRuntimeConfig, reconcileExistingDeploymentJournal, deploymentReconcileExitCode,
} from './deployment-reconcile-cli.ts';

const account = privateKeyToAccount(generatePrivateKey());
const addr = c => `0x${c.repeat(40)}`, hex = c => `0x${c.repeat(64)}`;
const BLOCK_HASH = hex('b');
const NOW = 1_800_000_000;
const RUNTIME = { AvensVault: '0x60016001', AvensFeedOracle: '0x60026002', AvensSettlement: '0x60036003' };
const runtimeHashes = Object.fromEntries(Object.entries(RUNTIME).map(([name, code]) => [name, keccak256(code)]));
const abis = {
  AvensVault: [
    { type: 'constructor', inputs: [{ name: 'collateral', type: 'address' }, { name: 'deploymentId', type: 'bytes32' }, { name: 'cap', type: 'uint128' }], stateMutability: 'nonpayable' },
    { type: 'function', name: 'bindSettlement', inputs: [{ name: 'settlement', type: 'address' }], outputs: [], stateMutability: 'nonpayable' },
  ],
  AvensFeedOracle: [
    { type: 'constructor', inputs: [{ name: 'marketId', type: 'uint32' }, { name: 'baseUsdFeed', type: 'address' }, { name: 'collateralUsdFeed', type: 'address' }, { name: 'fundingPublisher', type: 'address' }, { name: 'baseMaxAge', type: 'uint64' }, { name: 'quoteMaxAge', type: 'uint64' }], stateMutability: 'nonpayable' },
  ],
  AvensSettlement: [
    { type: 'constructor', inputs: [{ name: 'vault', type: 'address' }, { name: 'oracle', type: 'address' }, { name: 'marketId', type: 'uint32' }, { name: 'maxOracleAge', type: 'uint64' }], stateMutability: 'nonpayable' },
  ],
};
const code = { AvensVault: '0x6001600055', AvensFeedOracle: '0x6002600055', AvensSettlement: '0x6003600055' };
const artifacts = () => ({
  AvensVault: { abi: abis.AvensVault, bytecode: code.AvensVault },
  AvensFeedOracle: { abi: abis.AvensFeedOracle, bytecode: code.AvensFeedOracle },
  AvensSettlement: { abi: abis.AvensSettlement, bytecode: code.AvensSettlement },
});
const identity = (address, hash) => ({ address, codeHash: hash });
function input(changes = {}) {
  return {
    chainId: 43113, mainnet: false, deploymentId: hex('d'), sourceRevision: '1'.repeat(40),
    deployer: account.address, fundingPublisher: addr('2'),
    collateral: identity(addr('3'), hex('a')), baseUsdFeed: identity(addr('4'), hex('e')), quoteUsdFeed: identity(addr('5'), hex('f')),
    market: 1, depositCap6: 10_000_000, baseMaxAge: 300, quoteMaxAge: 600, maxOracleAge: 600,
    startingNonce: '0', expiresAt: NOW + 3600, budgetWei: '50000000000000000',
    gasLimits: { vault: 1_500_000, feedOracle: 1_200_000, settlement: 2_000_000, bindSettlement: 200_000 },
    maxFeePerGas: '1000000000', maxPriorityFeePerGas: '100000000',
    ...changes,
  };
}
function directory(t) {
  const dir = mkdtempSync(join(tmpdir(), 'avensdex-deployment-reconcile-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function dataFor(plan) {
  return [
    encodeDeployData({ abi: abis.AvensVault, bytecode: code.AvensVault, args: [plan.codeIdentities.collateral.address, plan.deploymentId, BigInt(plan.depositCap6)] }),
    encodeDeployData({ abi: abis.AvensFeedOracle, bytecode: code.AvensFeedOracle, args: [1, plan.codeIdentities.baseUsdFeed.address, plan.codeIdentities.quoteUsdFeed.address, plan.fundingPublisher, plan.baseMaxAge, plan.quoteMaxAge] }),
    encodeDeployData({ abi: abis.AvensSettlement, bytecode: code.AvensSettlement, args: [plan.addresses.vault, plan.addresses.feedOracle, 1, plan.maxOracleAge] }),
    encodeFunctionData({ abi: abis.AvensVault, functionName: 'bindSettlement', args: [plan.addresses.settlement] }),
  ];
}
async function sign(plan, seq) {
  const tx = plan.transactions[seq];
  return account.signTransaction({
    chainId: 43113, to: tx.to ?? undefined, nonce: Number(tx.nonce), value: 0n, gas: BigInt(tx.gas),
    maxFeePerGas: BigInt(tx.maxFeePerGas), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas),
    data: dataFor(plan)[seq],
  });
}
function localReader(plan, signed, overrides = {}) {
  const entry = hash => signed.find(value => value.hash === hash);
  return {
    async getTransaction(hash) {
      if (overrides.transactionError) throw Error('LOCAL_DOWN');
      const found = entry(hash);
      if (!found || overrides.transactionMissing) return null;
      const tx = plan.transactions[found.seq];
      return overrides.transaction ? overrides.transaction({
        hash: found.hash, chainId: 43113, from: plan.deployer, to: tx.to, nonce: tx.nonce, value: '0',
        input: found.data, gas: tx.gas, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      }) : {
        hash: found.hash, chainId: 43113, from: plan.deployer, to: tx.to, nonce: tx.nonce, value: '0',
        input: found.data, gas: tx.gas, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      };
    },
    async getReceipt(hash) {
      if (overrides.receiptError) throw Error('LOCAL_DOWN');
      const found = entry(hash);
      if (!found || overrides.receiptMissing) return null;
      const tx = plan.transactions[found.seq];
      const base = {
        transactionHash: found.hash, status: overrides.status?.[found.seq] ?? 'success',
        blockNumber: overrides.blockNumber ?? '95', blockHash: overrides.blockHash ?? BLOCK_HASH,
        from: plan.deployer, to: tx.to, contractAddress: tx.kind === 'create' ? tx.expectedCreatedAddress : null,
        gasUsed: '21000',
      };
      return overrides.receipt ? overrides.receipt(base, found) : base;
    },
    async getCanonicalHead() {
      if (overrides.headError) throw Error('LOCAL_DOWN');
      return overrides.head ?? { number: '100', hash: BLOCK_HASH };
    },
    async getCanonicalBlockHash() {
      if (overrides.canonicalError) throw Error('LOCAL_DOWN');
      return overrides.canonical ?? BLOCK_HASH;
    },
    async getCode(address) {
      if (overrides.codeError) throw Error('LOCAL_DOWN');
      if (overrides.code) return overrides.code(address);
      const created = plan.transactions.find(tx => tx.expectedCreatedAddress === address);
      return created ? RUNTIME[created.contract] : '0x6001';
    },
  };
}
function options(reader, overrides = {}) {
  return { input: overrides.input ?? input(), artifacts: overrides.artifacts ?? artifacts(),
    expectedRuntimeHashes: overrides.expectedRuntimeHashes ?? runtimeHashes, reader,
    confirmations: overrides.confirmations ?? 3, create: overrides.create ?? true };
}
async function createFixture(dir, count = 1) {
  const plan = buildDeploymentPlan(input(), artifacts(), NOW);
  const signed = [];
  let journal = DeploymentJournal.open(dir, options(localReader(plan, signed), { create: true }), NOW);
  for (let seq = 0; seq < count; seq++) {
    const serialized = await sign(plan, seq);
    const hash = keccak256(serialized);
    signed.push({ seq, hash, data: dataFor(plan)[seq] });
    await journal.recordSigned(serialized);
    await journal.reconcile(seq);
  }
  journal.close();
  return { plan, signed };
}

test('reconcile CLI arguments are exactly four bounded positional paths', () => {
  assert.deepEqual(parseDeploymentReconcileArgs(['dir', 'input.json', 'artifacts.json', 'runtime.json']),
    { journalDir: 'dir', inputPath: 'input.json', artifactsPath: 'artifacts.json', runtimeConfigPath: 'runtime.json' });
  for (const args of [[], ['dir'], ['a', 'b', 'c'], ['dir', 'a', 'b', 'c', 'd'], ['', 'a', 'b', 'c'], ['x'.repeat(4097), 'a', 'b', 'c']]) {
    assert.throws(() => parseDeploymentReconcileArgs(args), /INVALID_DEPLOYMENT_RECONCILE_ARGS/);
  }
});

test('runtime config must contain exactly runtime hashes and confirmations', t => {
  const dir = directory(t);
  const good = join(dir, 'runtime.json');
  writeFileSync(good, JSON.stringify({ expectedRuntimeHashes: runtimeHashes, confirmations: 3 }));
  assert.deepEqual(readRuntimeConfig(good), { expectedRuntimeHashes: runtimeHashes, confirmations: 3 });
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, JSON.stringify({ expectedRuntimeHashes: runtimeHashes }));
  assert.throws(() => readRuntimeConfig(bad), /INVALID_DEPLOYMENT_RECONCILE_CONFIG/);
  const missing = join(dir, 'missing.json');
  assert.throws(() => readRuntimeConfig(missing), /CONFIG_UNAVAILABLE/);
});

test('reconciling an existing journal confirms signed transactions and writes local evidence', async t => {
  const dir = directory(t);
  const { plan, signed } = await createFixture(dir, 1);
  const reader = localReader(plan, signed);
  const view = await reconcileExistingDeploymentJournal({
    directory: dir, input: input(), artifacts: artifacts(),
    expectedRuntimeHashes: runtimeHashes, confirmations: 3, reader, now: NOW,
  });
  assert.equal(view.transactions[0].status, 'confirmed');
  assert.equal(view.transactions[0].runtimeCodeHash, runtimeHashes.AvensVault);
  assert.equal(deploymentReconcileExitCode(view), 0);
  assert.equal(existsSync(join(dir, 'writer.lock')), false);
  assert.match(readFileSync(join(dir, 'deployment.jsonl'), 'utf8'), /confirmed/);
});

test('reconciling an existing journal can advance a second serial transaction', async t => {
  const dir = directory(t);
  const { plan, signed } = await createFixture(dir, 2);
  const reader = localReader(plan, signed);
  const view = await reconcileExistingDeploymentJournal({
    directory: dir, input: input(), artifacts: artifacts(),
    expectedRuntimeHashes: runtimeHashes, confirmations: 3, reader, now: NOW,
  });
  assert.equal(view.transactions[1].status, 'confirmed');
  assert.equal(view.nextSignableSequence, 2);
});

test('reconciling missing evidence downgrades and reports unknown without creating a journal', async t => {
  const dir = directory(t);
  const { plan, signed } = await createFixture(dir, 1);
  const reader = localReader(plan, signed, { transactionMissing: true });
  const view = await reconcileExistingDeploymentJournal({
    directory: dir, input: input(), artifacts: artifacts(),
    expectedRuntimeHashes: runtimeHashes, confirmations: 3, reader, now: NOW,
  });
  assert.equal(view.transactions[0].status, 'unknown');
  assert.equal(view.transactions[0].reason, 'TRANSACTION_NOT_FOUND');
  assert.equal(deploymentReconcileExitCode(view), 2);
  assert.equal(existsSync(join(dir, 'writer.lock')), false);
});

test('an existing-journal reconcile refuses to create or reset a missing journal', async t => {
  const dir = directory(t);
  const plan = buildDeploymentPlan(input(), artifacts(), NOW);
  const reader = localReader(plan, []);
  await assert.rejects(() => reconcileExistingDeploymentJournal({
    directory: dir, input: input(), artifacts: artifacts(),
    expectedRuntimeHashes: runtimeHashes, confirmations: 3, reader, now: NOW,
  }), /MISSING/);
  assert.equal(existsSync(join(dir, 'deployment.jsonl')), false);
});

for (const [name, overrides, expected] of [
  ['provider failure', { transactionError: true }, 'unknown'],
  ['insufficient confirmations', { blockNumber: '100' }, 'pending'],
  ['reorg', { canonical: hex('c') }, 'reorged'],
  ['runtime mismatch', { code: () => '0x6000' }, 'unknown'],
]) {
  test(`reconcile stops before later signed transactions on ${name}`, async t => {
    const dir = directory(t);
    const { plan, signed } = await createFixture(dir, 2);
    const reader = localReader(plan, signed, overrides);
    let laterReads = 0;
    const getTransaction = reader.getTransaction;
    reader.getTransaction = hash => {
      if (hash === signed[1].hash) laterReads++;
      return getTransaction(hash);
    };
    const view = await reconcileExistingDeploymentJournal({
      directory: dir, input: input(), artifacts: artifacts(),
      expectedRuntimeHashes: runtimeHashes, confirmations: 3, reader, now: NOW,
    });
    assert.equal(view.transactions[0].status, expected);
    assert.equal(view.transactions[1].status, 'unknown');
    assert.equal(laterReads, 0);
    assert.equal(deploymentReconcileExitCode(view), 2);
    assert.equal(existsSync(join(dir, 'writer.lock')), false);
  });
}

test('expired plan can reconcile existing evidence but changed runtime policy is refused', async t => {
  const dir = directory(t);
  const { plan, signed } = await createFixture(dir, 1);
  const reader = localReader(plan, signed);
  const options = { directory: dir, input: input(), artifacts: artifacts(),
    expectedRuntimeHashes: runtimeHashes, confirmations: 3, reader, now: NOW + 7200 };
  assert.equal((await reconcileExistingDeploymentJournal(options)).transactions[0].status, 'confirmed');
  await assert.rejects(() => reconcileExistingDeploymentJournal({ ...options,
    expectedRuntimeHashes: { ...runtimeHashes, AvensVault: hex('9') } }), /RUNTIME_MISMATCH/);
  assert.equal(existsSync(join(dir, 'writer.lock')), false);
});
