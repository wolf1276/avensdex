// Structural configuration boundary only. Syntax/code hashes are not deployment or liquidity evidence.
export type Address = `0x${string}`;
export interface ModuleIdentity { address: Address; codeHash: string }
export interface AssetIdentity extends ModuleIdentity { symbol: string; decimals: number }
export interface DeploymentManifest {
  schemaVersion: 1; chainId: 31337 | 43113; deploymentId: string; sourceRevision: string; sourceManifestSha256: string;
  executionEnabled: false; mainnetEnabled: false;
  toolchain: { solidity: '0.8.30'; evmVersion: 'paris'; foundry: '1.8.3' };
  deployment: { blockNumber: string; transactionHash: string };
  modules: { vault: ModuleIdentity; exchange: ModuleIdentity; executor: ModuleIdentity; oracle: ModuleIdentity; reader: ModuleIdentity };
  assets: { collateral: AssetIdentity; base: AssetIdentity };
  roles: { owner: Address; oraclePublisher: Address; executor: Address };
  market: { id: number; symbol: string };
  limits: { depositCap6: string; maxOpenInterest6: string; maxGasWei: string };
  evidence: { assets: string | null; oracle: string | null; spot: string | null; finality: string | null };
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('expected object');
  const result = value as Record<string, unknown>;
  if (Object.keys(result).length !== keys.length || keys.some(key => !Object.hasOwn(result, key))) throw Error('unexpected/missing fields');
  return result;
}
function matches(value: unknown, pattern: RegExp): asserts value is string {
  if (typeof value !== 'string' || !pattern.test(value)) throw Error('invalid format');
}
function hash(value: unknown) {
  matches(value, /^0x[0-9a-f]{64}$/);
  if (/^0x0+$/.test(value)) throw Error('zero hash');
}
function digest(value: unknown) { matches(value, /^[0-9a-f]{64}$/); if (/^0+$/.test(value)) throw Error('zero digest'); }
function address(value: unknown) {
  matches(value, /^0x[0-9a-f]{40}$/);
  if (/^0x0+$/.test(value)) throw Error('zero address');
}
function quantity(value: unknown, maximum: bigint, zeroAllowed = false) {
  matches(value, /^(0|[1-9][0-9]{0,77})$/);
  const amount = BigInt(value);
  if (amount > maximum || amount < (zeroAllowed ? 0n : 1n)) throw Error('quantity outside bounds');
}
function moduleIdentity(value: unknown) {
  const identity = record(value, ['address', 'codeHash']);
  address(identity.address); hash(identity.codeHash); return identity.address as string;
}
function assetIdentity(value: unknown, decimals: number) {
  const identity = record(value, ['address', 'codeHash', 'symbol', 'decimals']);
  address(identity.address); hash(identity.codeHash); matches(identity.symbol, /^[A-Z][A-Z0-9]{1,11}$/);
  if (identity.decimals !== decimals) throw Error('unsupported asset precision');
  return identity.address as string;
}
export function parseManifest(input: unknown): DeploymentManifest {
  const m = record(input, ['schemaVersion', 'chainId', 'deploymentId', 'sourceRevision', 'sourceManifestSha256',
    'executionEnabled', 'mainnetEnabled', 'toolchain', 'deployment', 'modules', 'assets', 'roles', 'market', 'limits', 'evidence']);
  if (m.schemaVersion !== 1 || (m.chainId !== 31337 && m.chainId !== 43113)
    || m.executionEnabled !== false || m.mainnetEnabled !== false) throw Error('unsupported chain, schema or activation');
  hash(m.deploymentId); matches(m.sourceRevision, /^[0-9a-f]{40}$/);
  if (/^0+$/.test(m.sourceRevision)) throw Error('zero source revision');
  digest(m.sourceManifestSha256);
  const tools = record(m.toolchain, ['solidity', 'evmVersion', 'foundry']);
  if (tools.solidity !== '0.8.30' || tools.evmVersion !== 'paris' || tools.foundry !== '1.8.3') throw Error('toolchain mismatch');
  const deployment = record(m.deployment, ['blockNumber', 'transactionHash']);
  quantity(deployment.blockNumber, (1n << 64n) - 1n, true); hash(deployment.transactionHash);
  const modules = record(m.modules, ['vault', 'exchange', 'executor', 'oracle', 'reader']);
  const identities = Object.values(modules).map(moduleIdentity);
  const assets = record(m.assets, ['collateral', 'base']);
  identities.push(assetIdentity(assets.collateral, 6), assetIdentity(assets.base, 18));
  const roles = record(m.roles, ['owner', 'oraclePublisher', 'executor']);
  for (const value of Object.values(roles)) { address(value); identities.push(value as string); }
  if (new Set(identities).size !== identities.length) throw Error('module/asset/role identities must be distinct');
  const market = record(m.market, ['id', 'symbol']);
  if (!Number.isInteger(market.id) || (market.id as number) < 1 || (market.id as number) > 8) throw Error('invalid market id');
  matches(market.symbol, /^[A-Z][A-Z0-9]{1,11}-PERP$/);
  const limits = record(m.limits, ['depositCap6', 'maxOpenInterest6', 'maxGasWei']);
  quantity(limits.depositCap6, 10_000_000_000n);
  quantity(limits.maxOpenInterest6, (1n << 128n) - 1n);
  quantity(limits.maxGasWei, (1n << 128n) - 1n);
  const evidence = record(m.evidence, ['assets', 'oracle', 'spot', 'finality']);
  for (const value of Object.values(evidence)) if (value !== null) digest(value);
  // Detach accepted configuration from subsequent mutation of the untrusted input.
  return structuredClone(input) as DeploymentManifest;
}
