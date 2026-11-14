import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureGasLimit, MAX_FIXTURE_GAS } from '../../scripts/local-fixture-gas.mjs';

test('local gas estimate receives bounded headroom without silently raising the cap', () => {
  assert.equal(fixtureGasLimit(137_213n), 214_655n);
  assert.equal(fixtureGasLimit(2_458_334n), MAX_FIXTURE_GAS);
  assert.throws(() => fixtureGasLimit(2_458_335n), /BUDGET_EXCEEDED/);
});

test('invalid estimates and estimates above the local cap fail closed', () => {
  for (const value of [0n, -1n, 137213, '137213', null, MAX_FIXTURE_GAS + 1n]) {
    assert.throws(() => fixtureGasLimit(value), /INVALID_FIXTURE_GAS_ESTIMATE/);
  }
});
