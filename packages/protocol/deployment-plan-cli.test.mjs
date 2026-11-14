import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildDeploymentPlan } from './deployment.ts';
import {
  MAX_DEPLOYMENT_PLAN_FILE_BYTES, buildDeploymentPlanFromFiles, parseDeploymentPlanArgs,
} from './deployment-plan-cli.ts';

const NOW = 1_800_000_000;
const addr = c => `0x${c.repeat(40)}`, hex = c => `0x${c.repeat(64)}`;
const identity = (address, hash) => ({ address, codeHash: hash });
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
function input(changes = {}) {
  return {
    chainId: 43113, mainnet: false, deploymentId: hex('d'), sourceRevision: '1'.repeat(40),
    deployer: addr('1'), fundingPublisher: addr('2'),
    collateral: identity(addr('3'), hex('a')), baseUsdFeed: identity(addr('4'), hex('e')), quoteUsdFeed: identity(addr('5'), hex('f')),
    market: 1, depositCap6: 10_000_000, baseMaxAge: 300, quoteMaxAge: 600, maxOracleAge: 600,
    startingNonce: '0', expiresAt: NOW + 3600, budgetWei: '50000000000000000',
    gasLimits: { vault: 1_500_000, feedOracle: 1_200_000, settlement: 2_000_000, bindSettlement: 200_000 },
    maxFeePerGas: '1000000000', maxPriorityFeePerGas: '100000000',
    ...changes,
  };
}
function directory(t) {
  const dir = mkdtempSync(join(tmpdir(), 'avensdex-deployment-plan-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function writeJson(dir, name, value) {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

test('CLI arguments are exactly two bounded positional file paths', () => {
  assert.deepEqual(parseDeploymentPlanArgs(['input.json', 'artifacts.json']),
    { inputPath: 'input.json', artifactsPath: 'artifacts.json' });
  for (const args of [[], ['input.json'], ['a', 'b', 'c'], ['', 'artifacts.json'],
    ['input.json', ''], ['x'.repeat(4097), 'artifacts.json']]) {
    assert.throws(() => parseDeploymentPlanArgs(args), /INVALID_DEPLOYMENT_PLAN_ARGS/);
  }
});

test('plan files reuse the existing planner validation and deterministic plan hash', t => {
  const dir = directory(t), inputPath = writeJson(dir, 'input.json', input());
  const artifactsPath = writeJson(dir, 'artifacts.json', artifacts());
  const plan = buildDeploymentPlanFromFiles(inputPath, artifactsPath, NOW);
  assert.equal(plan.planHash, buildDeploymentPlan(input(), artifacts(), NOW).planHash);
  assert.equal(plan.chainId, 43113);
  assert.equal(plan.mainnet, false);
  assert.equal(plan.approvalRequired, true);
  assert.equal(plan.executionEnabled, false);
  assert.equal(plan.depositsActive, false);
  assert.equal(plan.transactions.length, 4);
  assert.equal(Object.isFrozen(plan), true);
});

test('CLI rejects missing, non-regular, empty, oversized and malformed JSON files', t => {
  const dir = directory(t), inputPath = writeJson(dir, 'input.json', input());
  const artifactsPath = writeJson(dir, 'artifacts.json', artifacts());
  assert.throws(() => buildDeploymentPlanFromFiles(join(dir, 'missing.json'), artifactsPath, NOW), /INPUT_UNAVAILABLE/);
  assert.throws(() => buildDeploymentPlanFromFiles(inputPath, join(dir, 'missing.json'), NOW), /ARTIFACTS_UNAVAILABLE/);
  mkdirSync(join(dir, 'directory'));
  assert.throws(() => buildDeploymentPlanFromFiles(join(dir, 'directory'), artifactsPath, NOW), /FILE_NOT_REGULAR/);
  const empty = join(dir, 'empty.json');
  writeFileSync(empty, '');
  assert.throws(() => buildDeploymentPlanFromFiles(empty, artifactsPath, NOW), /FILE_CAPACITY/);
  const large = join(dir, 'large.json');
  writeFileSync(large, Buffer.alloc(MAX_DEPLOYMENT_PLAN_FILE_BYTES + 1, 0x20));
  assert.throws(() => buildDeploymentPlanFromFiles(large, artifactsPath, NOW), /FILE_CAPACITY/);
  const malformed = join(dir, 'malformed.json');
  writeFileSync(malformed, '{');
  assert.throws(() => buildDeploymentPlanFromFiles(malformed, artifactsPath, NOW), /INVALID_DEPLOYMENT_PLAN_JSON/);
  const schema = writeJson(dir, 'schema.json', { ...input(), extra: true });
  assert.throws(() => buildDeploymentPlanFromFiles(schema, artifactsPath, NOW), /INVALID_DEPLOYMENT_SCHEMA/);
});

test('CLI rejects FIFOs as non-regular files without blocking', t => {
  const dir = directory(t), inputPath = writeJson(dir, 'input.json', input());
  const artifactsPath = writeJson(dir, 'artifacts.json', artifacts());
  const fifo = join(dir, 'input.fifo');
  execFileSync('mkfifo', [fifo]);
  const cli = fileURLToPath(new URL('./deployment-plan-cli.ts', import.meta.url));
  for (const args of [[fifo, artifactsPath], [inputPath, fifo]]) {
    const result = spawnSync(process.execPath, ['--experimental-strip-types', cli, ...args], {
      encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /FILE_NOT_REGULAR/);
  }
});

test('CLI accepts a JSON file exactly at the byte limit', t => {
  const dir = directory(t), json = JSON.stringify(input());
  const inputPath = join(dir, 'input.json');
  writeFileSync(inputPath, json + ' '.repeat(MAX_DEPLOYMENT_PLAN_FILE_BYTES - Buffer.byteLength(json)));
  const artifactsPath = writeJson(dir, 'artifacts.json', artifacts());
  assert.equal(buildDeploymentPlanFromFiles(inputPath, artifactsPath, NOW).chainId, 43113);
});

test('descriptor-safe reads remain usable after normal and error paths', t => {
  const dir = directory(t), inputPath = writeJson(dir, 'input.json', input());
  const artifactsPath = writeJson(dir, 'artifacts.json', artifacts());
  assert.equal(buildDeploymentPlanFromFiles(inputPath, artifactsPath, NOW).chainId, 43113);
  const malformed = join(dir, 'malformed.json');
  writeFileSync(malformed, '{');
  assert.throws(() => buildDeploymentPlanFromFiles(malformed, artifactsPath, NOW), /INVALID_DEPLOYMENT_PLAN_JSON/);
  assert.equal(buildDeploymentPlanFromFiles(inputPath, artifactsPath, NOW).chainId, 43113);
});

test('CLI prints the paused, approval-required plan and fails closed on bad arguments', t => {
  const dir = directory(t), now = Math.floor(Date.now() / 1000);
  const inputPath = writeJson(dir, 'input.json', input({ expiresAt: now + 3600 }));
  const artifactsPath = writeJson(dir, 'artifacts.json', artifacts());
  const cli = fileURLToPath(new URL('./deployment-plan-cli.ts', import.meta.url));
  const run = args => spawnSync(process.execPath, ['--experimental-strip-types', cli, ...args], { encoding: 'utf8' });

  const success = run([inputPath, artifactsPath]);
  assert.equal(success.status, 0, success.stderr);
  const plan = JSON.parse(success.stdout);
  assert.match(plan.planHash, /^0x[0-9a-f]{64}$/);
  assert.equal(plan.planHash, buildDeploymentPlan(input({ expiresAt: now + 3600 }), artifacts(), now).planHash);
  assert.equal(plan.approvalRequired, true);
  assert.equal(plan.executionEnabled, false);
  assert.equal(plan.depositsActive, false);

  const failure = run([inputPath]);
  assert.equal(failure.status, 1);
  assert.equal(failure.stdout, '');
  assert.match(failure.stderr, /INVALID_DEPLOYMENT_PLAN_ARGS/);
  assert.match(failure.stderr, /No transaction was signed or sent/);
});
