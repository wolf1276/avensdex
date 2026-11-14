// Local Anvil fixtures only: this is not a public deployment gas policy or retry mechanism.
export const MAX_FIXTURE_GAS = 3_000_000n;
export function fixtureGasLimit(estimate) {
  if (typeof estimate !== 'bigint' || estimate <= 0n || estimate > MAX_FIXTURE_GAS) throw Error('INVALID_FIXTURE_GAS_ESTIMATE');
  const limit = estimate + estimate / 5n + 50_000n;
  if (limit > MAX_FIXTURE_GAS) throw Error('FIXTURE_GAS_BUDGET_EXCEEDED');
  return limit;
}
