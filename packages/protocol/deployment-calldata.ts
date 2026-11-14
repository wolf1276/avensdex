// Exact calldata for the existing paused-only plan. No signer, approval or submission authority.
import { encodeDeployData, encodeFunctionData, keccak256, type Abi, type Hex } from 'viem';
import { buildDeploymentPlan } from './deployment.ts';

export function deploymentCalls(input: unknown, reviewedArtifacts: unknown, now: number) {
  const plan = buildDeploymentPlan(input, reviewedArtifacts, now);
  const artifacts = structuredClone(reviewedArtifacts) as Record<string, { abi: Abi; bytecode: Hex }>;
  const data = [
    encodeDeployData({ ...artifacts.AvensVault!, args: [plan.codeIdentities.collateral.address, plan.deploymentId, BigInt(plan.depositCap6)] }),
    encodeDeployData({ ...artifacts.AvensFeedOracle!, args: [1, plan.codeIdentities.baseUsdFeed.address,
      plan.codeIdentities.quoteUsdFeed.address, plan.fundingPublisher, BigInt(plan.baseMaxAge), BigInt(plan.quoteMaxAge)] }),
    encodeDeployData({ ...artifacts.AvensSettlement!, args: [plan.addresses.vault, plan.addresses.feedOracle, 1, BigInt(plan.maxOracleAge)] }),
    encodeFunctionData({ abi: artifacts.AvensVault!.abi, functionName: 'bindSettlement', args: [plan.addresses.settlement] }),
  ];
  const calls = plan.transactions.map((tx, index) => {
    const calldata = data[index]!;
    if (keccak256(calldata) !== tx.dataHash) throw Error('DEPLOYMENT_CALLDATA_MISMATCH');
    return Object.freeze({ ...tx, data: calldata });
  });
  return Object.freeze({ plan, calls: Object.freeze(calls) });
}
