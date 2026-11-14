import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePausedApproval } from './deployment-approval.ts';
const now = 1800000000;
const plan = { chainId: 43113, planHash: '0x'+'a'.repeat(64), expiresAt: now+3600, budgetWei: '50000000000000000',
  transactions: [{ gas: 3000000, maxFeePerGas: '2000000000' }] };
const approval = { approved: true, chainId: 43113, planHash: plan.planHash, expiresAt: now+1800,
  budgetWei: plan.budgetWei, pausedOnly: true, authorizationReference: 'Explicit owner authorization for paused Fuji deployment only' };
test('bounded paused approval binds exact plan, expiry and maximum gas liability', () => {
  assert.equal(validatePausedApproval(approval, plan, now).planHash, plan.planHash);
  assert.equal(Object.isFrozen(validatePausedApproval(approval, plan, now)), true);
});
test('wrong, expired, unbounded or broader approval cannot authorize dispatch', () => {
  for (const change of [{ approved: false }, { chainId: 43114 }, { pausedOnly: false }, { planHash: 'other' },
    { expiresAt: now }, { expiresAt: now+3601 }, { budgetWei: '50000000000000001' },
    { budgetWei: '1' }, { budgetWei: '050000000000000000' }, { authorizationReference: '' }, { extra: true }]) {
    assert.throws(() => validatePausedApproval({ ...approval, ...change }, plan, now));
  }
  assert.throws(() => validatePausedApproval(approval, { ...plan, expiresAt: now }, now));
});
