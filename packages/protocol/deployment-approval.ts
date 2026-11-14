import type { DeploymentPlan } from './deployment.ts';

export function validatePausedApproval(input: unknown, plan: DeploymentPlan, now: number) {
  const keys = ['approved', 'chainId', 'planHash', 'expiresAt', 'budgetWei', 'pausedOnly', 'authorizationReference'];
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).length !== keys.length || keys.some(key => !Object.hasOwn(input, key))) throw Error('INVALID_DEPLOYMENT_APPROVAL');
  const value = input as Record<string, unknown>;
  if (value.approved !== true || value.pausedOnly !== true || value.chainId !== 43113 || plan.chainId !== 43113
    || value.planHash !== plan.planHash || !Number.isSafeInteger(now) || now < 0
    || !Number.isSafeInteger(value.expiresAt) || (value.expiresAt as number) <= now
    || (value.expiresAt as number) > plan.expiresAt || plan.expiresAt <= now
    || typeof value.authorizationReference !== 'string' || !/^[\x20-\x7e]{1,200}$/.test(value.authorizationReference)
    || typeof value.budgetWei !== 'string' || !/^[1-9][0-9]{0,16}$/.test(value.budgetWei)) throw Error('DEPLOYMENT_APPROVAL_MISMATCH');
  const budget = BigInt(value.budgetWei);
  const liability = plan.transactions.reduce((sum, tx) => sum + BigInt(tx.gas) * BigInt(tx.maxFeePerGas), 0n);
  if (budget > 50_000_000_000_000_000n || budget > BigInt(plan.budgetWei) || liability > budget) throw Error('DEPLOYMENT_APPROVAL_BUDGET');
  return Object.freeze({ expiresAt: value.expiresAt as number, budgetWei: budget.toString(), planHash: plan.planHash });
}
