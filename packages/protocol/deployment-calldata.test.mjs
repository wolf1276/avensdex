import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, keccak256 } from 'viem';
import { deploymentCalls } from './deployment-calldata.ts';
const hash = c => `0x${c.repeat(64)}`, address = c => `0x${c.repeat(40)}`;
const constructor = types => ({ type: 'constructor', stateMutability: 'nonpayable', inputs: types.map(type => ({ type })) });
const artifacts = {
  AvensVault: { bytecode: '0x60016000', abi: [constructor(['address','bytes32','uint128']),
    { type: 'function', name: 'bindSettlement', stateMutability: 'nonpayable', inputs: [{ type: 'address' }], outputs: [] }] },
  AvensFeedOracle: { bytecode: '0x60026000', abi: [constructor(['uint32','address','address','address','uint64','uint64'])] },
  AvensSettlement: { bytecode: '0x60036000', abi: [constructor(['address','address','uint32','uint64'])] },
};
const now = 1800000000;
const input = { chainId: 43113, mainnet: false, deploymentId: hash('d'), sourceRevision: '1'.repeat(40),
  deployer: address('1'), fundingPublisher: address('2'),
  collateral: { address: address('3'), codeHash: hash('a') }, baseUsdFeed: { address: address('4'), codeHash: hash('b') },
  quoteUsdFeed: { address: address('5'), codeHash: hash('c') }, market: 1, depositCap6: 10000000,
  baseMaxAge: 600, quoteMaxAge: 86400, maxOracleAge: 86400, startingNonce: '0', expiresAt: now + 3600,
  budgetWei: '50000000000000000', gasLimits: { vault: 2000000, feedOracle: 1800000, settlement: 4000000, bindSettlement: 200000 },
  maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000' };

test('exact four calldata payloads bind to the validated paused plan and predicted addresses', () => {
  const result = deploymentCalls(input, artifacts, now);
  assert.equal(result.calls.length, 4);
  for (const call of result.calls) {
    assert.equal(keccak256(call.data), call.dataHash);
    assert.equal(call.value, '0');
    assert.equal(Object.isFrozen(call), true);
  }
  assert.equal(result.calls.slice(0, 3).every(call => call.to === null), true);
  const binding = decodeFunctionData({ abi: artifacts.AvensVault.abi, data: result.calls[3].data });
  assert.equal(binding.functionName, 'bindSettlement');
  assert.equal(binding.args[0].toLowerCase(), result.plan.addresses.settlement);
  assert.equal(result.calls[3].to, result.plan.addresses.vault);
  assert.equal(result.plan.executionEnabled, false);
  assert.equal(result.plan.depositsActive, false);
});

test('calldata construction cannot bypass planner chain, expiry or policy guards', () => {
  for (const change of [{ chainId: 43114 }, { expiresAt: now }, { maxOracleAge: 3600 }]) {
    assert.throws(() => deploymentCalls({ ...input, ...change }, artifacts, now));
  }
});
