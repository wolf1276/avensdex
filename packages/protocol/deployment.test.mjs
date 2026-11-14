import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, appendFileSync, writeFileSync, existsSync, unlinkSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { encodeDeployData, encodeFunctionData, getContractAddress, keccak256 } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { DeploymentJournal, buildDeploymentPlan, validateDeploymentPlan } from './deployment.ts';

// Generated local test-only fixture keys. No environment, keystore, password or public wallet is read.
const account = privateKeyToAccount(generatePrivateKey());
const other = privateKeyToAccount(generatePrivateKey());
const addr = c => `0x${c.repeat(40)}`, hex = c => `0x${c.repeat(64)}`;
const BLOCK_HASH = hex('b'), OTHER_BLOCK_HASH = hex('c');
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
function planOf(changes = {}) { return buildDeploymentPlan(input(changes), artifacts(), NOW); }
function directory(t) {
  const dir = mkdtempSync(join(tmpdir(), 'avensdex-deployment-test-'));
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
async function sign(plan, seq, changes = {}) {
  const tx = plan.transactions[seq];
  const serialized = await (changes.account ?? account).signTransaction({
    chainId: changes.chainId ?? 43113, to: changes.to === undefined ? tx.to ?? undefined : changes.to,
    nonce: changes.nonce ?? Number(tx.nonce), value: changes.value ?? 0n, gas: changes.gas ?? BigInt(tx.gas),
    maxFeePerGas: changes.maxFeePerGas ?? BigInt(tx.maxFeePerGas),
    maxPriorityFeePerGas: changes.maxPriorityFeePerGas ?? BigInt(tx.maxPriorityFeePerGas),
    data: changes.data ?? dataFor(plan)[seq], accessList: changes.accessList,
  });
  return serialized;
}
function rpcTx(plan, entry) {
  const tx = plan.transactions[entry.seq];
  return { hash: entry.hash, chainId: 43113, from: plan.deployer, to: tx.to, nonce: tx.nonce, value: '0',
    input: entry.data, gas: tx.gas, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas };
}
function rpcReceipt(plan, entry, overrides) {
  const tx = plan.transactions[entry.seq];
  return { transactionHash: entry.hash, status: overrides.status?.[entry.seq] ?? 'success',
    blockNumber: overrides.blockNumber ?? '95', blockHash: overrides.blockHash ?? BLOCK_HASH,
    from: plan.deployer, to: tx.to, contractAddress: tx.kind === 'create' ? tx.expectedCreatedAddress : null, gasUsed: '21000' };
}
function localReader(plan, signed, overrides = {}) {
  const entry = hash => signed.find(value => value.hash === hash);
  return {
    async getTransaction(hash) {
      if (overrides.transactionError) throw Error('LOCAL_DOWN');
      const found = entry(hash);
      if (!found || overrides.transactionMissing) return null;
      const base = rpcTx(plan, found);
      return overrides.transaction ? overrides.transaction(base, found) : base;
    },
    async getReceipt(hash) {
      if (overrides.receiptError) throw Error('LOCAL_DOWN');
      const found = entry(hash);
      if (!found || overrides.receiptMissing) return null;
      const base = rpcReceipt(plan, found, overrides);
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
function open(dir, reader, overrides) { return DeploymentJournal.open(dir, options(reader, overrides), NOW); }
async function record(journal, plan, signed, seq, changes) {
  const serialized = await sign(plan, seq, changes);
  const hash = keccak256(serialized);
  signed.push({ seq, hash, data: changes?.data ?? dataFor(plan)[seq] });
  await journal.recordSigned(serialized);
  return hash;
}
function journalPath(dir) { return join(dir, 'deployment.jsonl'); }
const encode = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? { $bigint: v.toString() } : v);
const digest = value => createHash('sha256').update(encode(value)).digest('hex');

test('plan is deterministic, paused, capped, and uses consecutive predicted CREATE addresses', () => {
  const plan = planOf();
  assert.equal(plan.chainId, 43113);
  assert.equal(plan.mainnet, false);
  assert.equal(plan.approvalRequired, true);
  assert.equal(plan.executionEnabled, false);
  assert.equal(plan.depositsActive, false);
  assert.equal(plan.transactions.length, 4);
  assert.deepEqual(plan.transactions.map(tx => tx.nonce), ['0', '1', '2', '3']);
  assert.deepEqual(plan.transactions.map(tx => tx.kind), ['create', 'create', 'create', 'bindSettlement']);
  assert.equal(plan.addresses.vault, getContractAddress({ from: account.address, nonce: 0n }).toLowerCase());
  assert.equal(plan.addresses.feedOracle, getContractAddress({ from: account.address, nonce: 1n }).toLowerCase());
  assert.equal(plan.addresses.settlement, getContractAddress({ from: account.address, nonce: 2n }).toLowerCase());
  assert.equal(plan.transactions[3].to, plan.addresses.vault);
  assert.equal(plan.transactions[3].expectedCreatedAddress, null);
  assert.ok(plan.transactions.every(tx => tx.value === '0' && /^0x[0-9a-f]{64}$/.test(tx.dataHash)));
  assert.equal(plan.transactions[3].dataHash, keccak256(dataFor(plan)[3]));
  assert.deepEqual(plan.artifacts.AvensVault.initDataHash, keccak256(dataFor(plan)[0]));
  assert.match(plan.sourceFingerprint, /^0x[0-9a-f]{64}$/);
  assert.equal(planOf().planHash, plan.planHash);
  assert.equal(buildDeploymentPlan(input(), artifacts(), NOW + 10).planHash, plan.planHash);
  assert.throws(() => { plan.transactions.push({}); });
  assert.throws(() => { plan.addresses.vault = addr('9'); });
});

test('distinct feed addresses may legitimately use identical reviewed proxy runtime code', () => {
  const shared = hex('e');
  const plan = planOf({ baseUsdFeed: identity(addr('4'), shared), quoteUsdFeed: identity(addr('5'), shared) });
  assert.notEqual(plan.codeIdentities.baseUsdFeed.address, plan.codeIdentities.quoteUsdFeed.address);
  assert.equal(plan.codeIdentities.baseUsdFeed.codeHash, plan.codeIdentities.quoteUsdFeed.codeHash);
});

test('strict chain, roles, caps, expiry, gas and budget bounds', () => {
  const cases = [
    [{ chainId: 43114 }, /CHAIN/], [{ mainnet: true }, /MAINNET/], [{ deployer: addr('0') }, /ADDRESS/],
    [{ fundingPublisher: account.address }, /DUPLICATE/], [{ market: 2 }, /MARKET/],
    [{ depositCap6: 0 }, /INTEGER/], [{ depositCap6: 10_000_001 }, /INTEGER/],
    [{ baseMaxAge: 0 }, /INTEGER/], [{ quoteMaxAge: 86401 }, /INTEGER/],
    [{ maxOracleAge: 500 }, /ORACLE_AGE/], [{ startingNonce: '18446744073709551615' }, /NONCE/],
    [{ expiresAt: NOW }, /EXPIRY/], [{ expiresAt: NOW + 86401 }, /EXPIRY/],
    [{ budgetWei: '4899999999999999' }, /BUDGET/],
    [{ maxPriorityFeePerGas: '1000000001' }, /PRIORITY/], [{ gasLimits: { ...input().gasLimits, fresh: 21000 } }, /SCHEMA/],
    [{ gasLimits: { ...input().gasLimits, vault: 0 } }, /INTEGER/],
    [{ sourceRevision: '0'.repeat(40) }, /SOURCE_REVISION/],
    [{ collateral: identity(addr('4'), hex('a')) }, /DUPLICATE/],
  ];
  for (const [changes, pattern] of cases) assert.throws(() => planOf(changes), pattern);
  assert.throws(() => planOf({ extra: true }), /SCHEMA/);
  const { depositCap6, ...missing } = input();
  assert.throws(() => buildDeploymentPlan(missing, artifacts(), NOW), /SCHEMA/);
  assert.throws(() => buildDeploymentPlan(input(), { ...artifacts(), extra: {} }, NOW), /SCHEMA/);
  assert.throws(() => buildDeploymentPlan(input(), { ...artifacts(), AvensVault: { ...artifacts().AvensVault, bytecode: '0x' } }, NOW), /BYTECODE/);
  assert.equal(depositCap6, 10_000_000);
});

test('reviewed artifacts and the fixed constructor/bind surface are the only encodable actions', () => {
  const vaultWithoutBind = { ...artifacts(), AvensVault: { abi: [abis.AvensVault[0]], bytecode: code.AvensVault } };
  assert.throws(() => buildDeploymentPlan(input(), vaultWithoutBind, NOW), /BINDING/);
  const wrongConstructor = { ...artifacts(), AvensSettlement: { abi: [{ type: 'constructor', inputs: [], stateMutability: 'nonpayable' }], bytecode: code.AvensSettlement } };
  assert.throws(() => buildDeploymentPlan(input(), wrongConstructor, NOW), /CONSTRUCTOR/);
  for (const arbitrary of [{ data: '0xdeadbeef' }, { value: '1' }, { to: addr('9') }, { recipient: addr('9') }, { activate: true }]) {
    assert.throws(() => planOf(arbitrary), /SCHEMA/);
  }
  const plan = planOf();
  assert.ok(plan.transactions.every(tx => tx.kind === 'create' || tx.kind === 'bindSettlement'));
  assert.ok(plan.transactions.every(tx => tx.dataHash !== keccak256('0x')));
});

test('a plan is validated by rebuilding trusted input and artifacts, never by a supplied hash', () => {
  const plan = planOf();
  assert.equal(validateDeploymentPlan(plan, input(), artifacts(), NOW).planHash, plan.planHash);
  assert.throws(() => validateDeploymentPlan({ planHash: plan.planHash }, input(), artifacts(), NOW), /MISMATCH/);
  assert.throws(() => validateDeploymentPlan({ ...plan, planHash: hex('9') }, input(), artifacts(), NOW), /MISMATCH/);
  assert.throws(() => validateDeploymentPlan(plan, input({ depositCap6: 1 }), artifacts(), NOW), /MISMATCH/);
  assert.throws(() => validateDeploymentPlan(plan, input(), { ...artifacts(), AvensVault: { ...artifacts().AvensVault, bytecode: '0x6009' } }, NOW), /MISMATCH/);
  assert.throws(() => validateDeploymentPlan(plan, input(), artifacts(), plan.expiresAt), /EXPIRY/);
});

test('signed serialized transactions must match the planned chain, sender, nonce, target, value, data, gas and fees', async t => {
  const dir = directory(t), signed = [], plan = planOf();
  let reader = localReader(plan, signed), journal = open(dir, reader);
  const wrong = [
    [{ account: other }, /SENDER/], [{ chainId: 43114 }, /INVALID|CHAIN/], [{ nonce: 1 }, /NONCE/],
    [{ to: addr('9') }, /RECIPIENT/], [{ value: 1n }, /VALUE/], [{ data: '0xdeadbeef' }, /INPUT/],
    [{ gas: 21_001n }, /GAS/], [{ maxFeePerGas: 2_000_000_000n }, /MAX_FEE/],
    [{ maxPriorityFeePerGas: 200_000_000n }, /PRIORITY/],
    [{ accessList: [{ address: addr('9'), storageKeys: [] }] }, /ACCESS_LIST/],
  ];
  for (const [changes, pattern] of wrong) await assert.rejects(() => record(journal, plan, [], 0, changes), pattern);
  const serialized = await sign(plan, 0);
  const hash = keccak256(serialized);
  signed.push({ seq: 0, hash, data: dataFor(plan)[0] });
  await journal.recordSigned(serialized);
  const view = journal.view();
  assert.equal(view.transactions[0].status, 'signed');
  assert.equal(view.nextSignableSequence, null); // Submission is not completion; confirmation is required.
  const text = readFileSync(journalPath(dir), 'utf8');
  assert.match(text, new RegExp(hash.slice(2)));
  assert.equal(text.includes(serialized.slice(2)), false); // Signed raw bytes are not persisted.
  await assert.rejects(() => journal.recordSigned(serialized), /NOT_READY/);
  journal.close();
});

test('receipt reconciliation waits for canonical confirmations and cross-checks the actual transaction', async t => {
  const dir = directory(t), signed = [], plan = planOf();
  let reader = localReader(plan, signed, { head: { number: '96', hash: BLOCK_HASH } });
  const journal = open(dir, reader);
  await record(journal, plan, signed, 0);
  let view = await journal.reconcile(0);
  assert.equal(view.transactions[0].status, 'pending');
  assert.equal(view.transactions[0].reason, 'CONFIRMATIONS_PENDING');
  reader = localReader(plan, signed);
  // Re-open the journal against a reader with a later canonical head.
  journal.close();
  const restored = DeploymentJournal.open(dir, options(reader), NOW);
  view = await restored.reconcile(0);
  assert.equal(view.transactions[0].status, 'confirmed');
  assert.equal(view.transactions[0].runtimeCodeHash, runtimeHashes.AvensVault);
  assert.equal(view.nextSignableSequence, 1);
  restored.close();

  const badDir = directory(t), badSigned = [], badPlan = planOf();
  const badJournal = open(badDir, localReader(badPlan, badSigned, { transaction: tx => ({ ...tx, nonce: '9' }) }), { confirmations: 1 });
  await record(badJournal, badPlan, badSigned, 0);
  view = await badJournal.reconcile(0);
  assert.equal(view.transactions[0].status, 'unknown');
  assert.equal(view.transactions[0].reason, 'INVALID_TRANSACTION');
  assert.equal(view.nextSignableSequence, null);
  badJournal.close();
});

test('reverted, missing, reorged and runtime-mismatched receipts pause subsequent plans', async t => {
  const scenarios = [
    ['reverted', { status: { 0: 'reverted' } }, 'reverted', 'RECEIPT_REVERTED'],
    ['missing', { receiptMissing: true }, 'unknown', 'RECEIPT_NOT_FOUND'],
    ['reorged', { canonical: OTHER_BLOCK_HASH }, 'reorged', 'CANONICAL_BLOCK_HASH_CHANGED'],
    ['runtime', { code: () => '0x6009' }, 'unknown', 'RUNTIME_CODE_HASH_MISMATCH'],
    ['transaction sender', { transaction: tx => ({ ...tx, from: addr('9') }) }, 'unknown', 'INVALID_TRANSACTION'],
    ['receipt identity', { receipt: tx => ({ ...tx, from: addr('9') }) }, 'unknown', 'INVALID_RECEIPT'],
  ];
  for (const [name, overrides, status, reason] of scenarios) {
    const dir = directory(t), signed = [], plan = planOf();
    const journal = open(dir, localReader(plan, signed, { confirmations: 1, ...overrides }), { confirmations: 1 });
    await record(journal, plan, signed, 0);
    const view = await journal.reconcile(0);
    assert.equal(view.transactions[0].status, status, name);
    assert.equal(view.transactions[0].reason, reason, name);
    assert.equal(view.nextSignableSequence, null, name);
    // A failed/uncertain first transaction never permits signing the next nonce.
    await assert.rejects(() => record(journal, plan, signed, 1), /NOT_READY/);
    journal.close();
  }
});

test('reverted creation preserves a null contract address and blocks progression', async t => {
  const plan = planOf(), signed = [];
  const reader = localReader(plan, signed, { status: { 0: 'reverted' }, receipt: r => ({ ...r, contractAddress: null }) });
  let journal;
  t.after(() => journal?.close());
  journal = open(directory(t), reader);
  await record(journal, plan, signed, 0);
  const view = await journal.reconcile(0);
  assert.equal(view.transactions[0].status, 'reverted');
  assert.equal(view.transactions[0].receipt.contractAddress, null);
  assert.equal(view.nextSignableSequence, null);
});

test('receipt gas cannot exceed the signed transaction limit', async t => {
  const plan = planOf(), signed = [];
  const reader = localReader(plan, signed, { receipt: r => ({ ...r, gasUsed: String(plan.transactions[0].gas + 1) }) });
  let journal;
  t.after(() => journal?.close());
  journal = open(directory(t), reader);
  await record(journal, plan, signed, 0);
  const view = await journal.reconcile(0);
  assert.equal(view.transactions[0].reason, 'INVALID_RECEIPT');
  assert.equal(view.nextSignableSequence, null);
});

test('a reorg during the runtime read cannot confirm an old receipt', async t => {
  const plan = planOf(), signed = [], changes = {};
  changes.code = () => { changes.canonical = OTHER_BLOCK_HASH; return RUNTIME.AvensVault; };
  let journal;
  t.after(() => journal?.close());
  journal = open(directory(t), localReader(plan, signed, changes));
  await record(journal, plan, signed, 0);
  const view = await journal.reconcile(0);
  assert.equal(view.transactions[0].reason, 'CANONICAL_HEAD_CHANGED');
  assert.equal(view.nextSignableSequence, null);
});

test('serial progression confirms all three creations and then the settlement binding', async t => {
  const dir = directory(t), signed = [], plan = planOf();
  const journal = open(dir, localReader(plan, signed), { confirmations: 1 });
  for (let seq = 0; seq < 4; seq++) {
    await record(journal, plan, signed, seq);
    const view = await journal.reconcile(seq);
    assert.equal(view.transactions[seq].status, 'confirmed');
    assert.equal(view.nextSignableSequence, seq === 3 ? null : seq + 1);
  }
  const final = journal.view();
  assert.equal(final.transactions[3].tx.to, plan.addresses.vault);
  assert.equal(final.transactions[3].signed.dataHash, keccak256(dataFor(plan)[3]));
  journal.close();
});

test('restart downgrades persisted progress and requires fresh reconciliation before advancing', async t => {
  const dir = directory(t), signed = [], plan = planOf();
  let journal = open(dir, localReader(plan, signed), { confirmations: 1 });
  await record(journal, plan, signed, 0);
  let view = await journal.reconcile(0);
  assert.equal(view.transactions[0].status, 'confirmed');
  journal.close();

  journal = DeploymentJournal.open(dir, options(localReader(plan, signed), { confirmations: 1 }), NOW);
  view = journal.view();
  assert.equal(view.transactions[0].status, 'unknown');
  assert.equal(view.transactions[0].reason, 'RESTART_RECONCILIATION_REQUIRED');
  assert.equal(view.nextSignableSequence, null);
  view = await journal.reconcile(0);
  assert.equal(view.transactions[0].status, 'confirmed');
  assert.equal(view.nextSignableSequence, 1);
  journal.close();

  const missingDir = directory(t);
  assert.throws(() => DeploymentJournal.open(missingDir, options(localReader(plan, signed), { create: false }), NOW), /MISSING/);
  assert.equal(existsSync(journalPath(missingDir)), false);
});

test('single writer, crash lock retention, corruption and rehashed tampering fail closed', t => {
  const dir = directory(t), signed = [], plan = planOf();
  const journal = open(dir, localReader(plan, signed));
  assert.throws(() => open(dir, localReader(plan, signed)), /EEXIST/);
  journal.close();
  assert.equal(existsSync(join(dir, 'writer.lock')), false);

  const crashed = directory(t), moduleUrl = new URL('./deployment.ts', import.meta.url).href;
  const readerScript = `{getTransaction:async()=>null,getReceipt:async()=>null,getCanonicalHead:async()=>({number:'100',hash:${JSON.stringify(BLOCK_HASH)}}),getCanonicalBlockHash:async()=>${JSON.stringify(BLOCK_HASH)},getCode:async()=>${JSON.stringify(RUNTIME.AvensVault)}}`;
  const script = `import {DeploymentJournal} from ${JSON.stringify(moduleUrl)};
    const j=DeploymentJournal.open(${JSON.stringify(crashed)},{input:${JSON.stringify(input())},artifacts:${JSON.stringify(artifacts())},expectedRuntimeHashes:${JSON.stringify(runtimeHashes)},reader:${readerScript},confirmations:3,create:true},${NOW});
    process.exit(0);`;
  const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert(existsSync(join(crashed, 'writer.lock')));
  assert.throws(() => open(crashed, localReader(plan, [])), /EEXIST/);
  unlinkSync(join(crashed, 'writer.lock')); // Test-only operator action after confirming the child exited.
  open(crashed, localReader(plan, [])).close();

  for (const corruption of ['truncated', 'rewritten']) {
    const broken = directory(t), reader = localReader(plan, []);
    const local = open(broken, reader); local.close();
    const path = journalPath(broken);
    if (corruption === 'truncated') appendFileSync(path, '{"version":1');
    else {
      const lines = readFileSync(path, 'utf8').trim().split('\n');
      const record = JSON.parse(lines[0]); record.event.plan.addresses.vault = addr('9');
      const { digest: ignored, ...body } = record; lines[0] = JSON.stringify({ ...body, digest: digest(body) });
      writeFileSync(path, lines.join('\n') + '\n');
    }
    const before = readFileSync(path);
    assert.throws(() => open(broken, reader), /INCOMPLETE|HASH|PLAN|IDENTITY/);
    assert.deepEqual(readFileSync(path), before);
  }
});

test('an uncertain journal write poisons the writer and retains the operator lock', async t => {
  const dir = directory(t), signed = [], plan = planOf();
  const journal = open(dir, localReader(plan, signed));
  const serialized = await sign(plan, 0);
  closeSync(journal.fd); // Test-only descriptor fault injection; runtime has no reset shortcut.
  await assert.rejects(() => journal.recordSigned(serialized), /UNKNOWN_DEPLOYMENT_JOURNAL_WRITE/);
  assert.equal(journal.writable, false);
  await assert.rejects(() => journal.recordSigned(serialized), /UNAVAILABLE/);
  assert(existsSync(join(dir, 'writer.lock')));
});
