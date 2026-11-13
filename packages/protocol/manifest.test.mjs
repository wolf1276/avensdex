import test from 'node:test';
import assert from 'node:assert/strict';
import { parseManifest } from './manifest.ts';

// Synthetic identities for parser tests only: never a deployment or usable config.
const address = n => `0x${n.toString(16).padStart(40, '0')}`;
const hash = n => `0x${n.toString(16).padStart(64, '0')}`;
function fixture() {
  const identity = n => ({ address: address(n), codeHash: hash(n) });
  return { schemaVersion: 1, chainId: 43113, deploymentId: hash(20), sourceRevision: 'a'.repeat(40),
    sourceManifestSha256: 'b'.repeat(64), executionEnabled: false, mainnetEnabled: false,
    toolchain: { solidity: '0.8.30', evmVersion: 'paris', foundry: '1.8.3' },
    deployment: { blockNumber: '1', transactionHash: hash(21) },
    modules: { vault: identity(1), exchange: identity(2), executor: identity(3), oracle: identity(4), reader: identity(5) },
    assets: { collateral: { ...identity(6), symbol: 'USDC', decimals: 6 }, base: { ...identity(7), symbol: 'WAVAX', decimals: 18 } },
    roles: { owner: address(8), oraclePublisher: address(9), executor: address(10) },
    market: { id: 1, symbol: 'AVAX-PERP' }, limits: { depositCap6: '10000000000', maxOpenInterest6: '1000000', maxGasWei: '1000000' },
    evidence: { assets: null, oracle: null, spot: null, finality: null } };
}
test('only execution-disabled local/Fuji configurations parse; missing evidence remains explicit', () => {
  for (const chainId of [31337, 43113]) {
    const input = { ...fixture(), chainId }, parsed = parseManifest(input);
    assert.equal(parsed.executionEnabled, false); assert.equal(parsed.chainId, chainId);
    assert.equal(parsed.evidence.spot, null);
    input.limits.depositCap6 = '0'; assert.equal(parsed.limits.depositCap6, '10000000000');
  }
});
test('wrong chain, enabled execution, wrong schema and malformed roots fail closed', () => {
  for (const patch of [{ chainId: 43114 }, { chainId: 1 }, { chainId: '43113' }, { schemaVersion: 2 },
    { executionEnabled: true }, { mainnetEnabled: true }, { mainnetEnabled: null }, { extra: 'ignored?' }]) {
    assert.throws(() => parseManifest({ ...fixture(), ...patch }));
  }
  for (const root of [null, [], 'manifest', 1, {}]) assert.throws(() => parseManifest(root));
});
test('addresses, hashes, distinct modules/assets/roles and pinned toolchain are required', () => {
  const mutations = [m => m.modules.vault.address = address(0), m => m.modules.vault.codeHash = hash(0),
    m => m.modules.vault.address = 'owner.testnet', m => m.modules.vault.address = '0xUNSET',
    m => m.modules.exchange.address = m.modules.vault.address, m => m.roles.executor = m.roles.owner,
    m => m.assets.base.address = m.assets.collateral.address, m => m.assets.base.decimals = 24,
    m => m.assets.collateral.decimals = 18, m => m.modules.vault.rpcUrl = 'https://example.com',
    m => m.toolchain.solidity = '0.8.31', m => m.toolchain.evmVersion = 'cancun',
    m => delete m.modules.reader, m => m.sourceRevision = '0'.repeat(40),
    m => m.deployment.transactionHash = 'near-transaction', m => m.sourceManifestSha256 = 'bad'];
  for (const mutate of mutations) { const input = fixture(); mutate(input); assert.throws(() => parseManifest(input)); }
});
test('numeric bounds, canonical decimal strings, market schema and evidence hashes are enforced', () => {
  const mutations = [m => m.limits.depositCap6 = '10000000001', m => m.limits.maxGasWei = '0',
    m => m.limits.depositCap6 = 10, m => m.limits.maxOpenInterest6 = '01', m => m.limits.maxOpenInterest6 = '-1',
    m => m.limits.maxOpenInterest6 = (1n << 128n).toString(), m => m.deployment.blockNumber = '1e8',
    m => m.market.id = 0, m => m.market.id = 1.5, m => m.market.symbol = 'AVAX',
    m => m.evidence.spot = true, m => m.evidence.assets = '0'.repeat(64)];
  for (const mutate of mutations) { const input = fixture(); mutate(input); assert.throws(() => parseManifest(input)); }
  const input = fixture(); input.evidence.assets = 'c'.repeat(64);
  assert.equal(parseManifest(input).evidence.assets, 'c'.repeat(64));
});
