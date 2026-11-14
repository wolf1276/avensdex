// Qualification only: public RPC reads + a fresh private loopback fork. No operator-wallet key loading or public submission.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { setDefaultResultOrder } from 'node:dns';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createPublicClient, createWalletClient, custom, encodeFunctionData, http, keccak256, parseAbi, stringToHex, TransactionReceiptNotFoundError } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { avalancheFuji } from 'viem/chains';
import { ORDER_TYPES } from '../packages/clob/admission.ts';

setDefaultResultOrder('ipv4first'); // This host has no IPv6 route; keep the same fixed TLS-verified providers.
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OWNER = '0xee5656873609373fF0224A1D3e5F03a8fB16B6F4';
const FUNDING = '0xEcf1b55DF0CF87e5de6e999174DC4Dc492c98DbF';
const TOKEN = '0x5425890298aed601595a70AB815c96711a31Bc65';
const BASE = '0x5498BB86BC934c8D34FDA08E81D444153d0D06aD';
const QUOTE = '0x97FE42a7E96640D932bbc0e1580c73E705A8EB73';
const RPCS = ['https://api.avax-test.network/ext/bc/C/rpc', 'https://avalanche-fuji-c-chain-rpc.publicnode.com'];
const snapshotRun = spawnSync('python3', ['-m', 'scripts.preflight_fuji', '--deployer', OWNER], { cwd: ROOT, encoding: 'utf8', timeout: 180_000 });
assert.equal(snapshotRun.status, 2, 'pinned two-provider read-only preflight must succeed (blocked exit 2)');
const accountSnapshot = JSON.parse(snapshotRun.stdout);
assert.equal(accountSnapshot.chainId, 43113);
assert.equal(accountSnapshot.deploymentReady, false);
assert(Number.isSafeInteger(accountSnapshot.nonce) && accountSnapshot.nonce >= 0);
// Reproducible historical qualification point from the independently recorded feed observation.
// This is separate from the current account preflight and cannot authorize a current deployment.
const snapshot = { blockNumber: 61048431, blockHash: '0xcaa872f12ead6bb50acd4669a2f4843befae6809f51ac228fbbe51c63f863c2f', blockTimestamp: 1794639862 };
const blockNumber = BigInt(snapshot.blockNumber), blockHash = snapshot.blockHash;
const readMethods = new Set(['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_getStorageAt', 'eth_call']);
// Use the installed pinned Foundry HTTP stack; this host's Node fetch cannot reliably connect. No endpoint failover.
const clients = RPCS.map(url => createPublicClient({ chain: avalancheFuji, cacheTime: 0,
  transport: custom({ request: async ({ method, params }) => {
    assert(RPCS.includes(url) && readMethods.has(method), 'fixed read-only qualification transport');
    const raw = execFileSync('cast', ['rpc', method, JSON.stringify(params ?? []), '--raw', '--rpc-url', url,
      '--rpc-timeout', '20'], { timeout: 25_000, maxBuffer: 1_048_576, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', NO_COLOR: '1' } });
    return JSON.parse(raw.toString());
  } }, { retryCount: 0 }),
}));
const tokenAbi = parseAbi([
  'function decimals() view returns(uint8)', 'function paused() view returns(bool)', 'function masterMinter() view returns(address)',
  'function pauser() view returns(address)', 'function blacklister() view returns(address)', 'function owner() view returns(address)',
  'function balanceOf(address) view returns(uint256)', 'function approve(address,uint256) returns(bool)',
  'function transfer(address,uint256) returns(bool)', 'function configureMinter(address,uint256) returns(bool)',
  'function mint(address,uint256) returns(bool)', 'function pause()', 'function unpause()',
  'function blacklist(address)', 'function unBlacklist(address)',
]);
const feedAbi = parseAbi(['function decimals() view returns(uint8)', 'function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)',
  'function aggregator() view returns(address)', 'function description() view returns(string)']);
const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);
const observations = [];
for (const client of clients) {
  assert.equal(await client.getChainId(), 43113);
  const pinned = await client.getBlock({ blockNumber });
  assert.equal(pinned.hash, blockHash);
  assert.equal(Number(pinned.timestamp), snapshot.blockTimestamp);
  const code = await client.getCode({ address: TOKEN, blockNumber }); assert(code && code !== '0x');
  const roles = {};
  for (const name of ['masterMinter', 'pauser', 'blacklister', 'owner']) roles[name] = await client.readContract({ address: TOKEN, abi: tokenAbi, functionName: name, blockNumber });
  const implementationSlot = keccak256(stringToHex('org.zeppelinos.proxy.implementation'));
  const adminSlot = keccak256(stringToHex('org.zeppelinos.proxy.admin'));
  const implementationWord = await client.getStorageAt({ address: TOKEN, slot: implementationSlot, blockNumber });
  const adminWord = await client.getStorageAt({ address: TOKEN, slot: adminSlot, blockNumber });
  const implementation = `0x${implementationWord.slice(-40)}`, admin = `0x${adminWord.slice(-40)}`;
  const implementationCode = await client.getCode({ address: implementation, blockNumber }); assert(implementationCode && implementationCode !== '0x');
  const feeds = [];
  for (const address of [BASE, QUOTE]) {
    const feedCode = await client.getCode({ address, blockNumber }); assert(feedCode && feedCode !== '0x');
    feeds.push({ address, codeHash: keccak256(feedCode), decimals: await client.readContract({ address, abi: feedAbi, functionName: 'decimals', blockNumber }),
      description: await client.readContract({ address, abi: feedAbi, functionName: 'description', blockNumber }),
      round: await client.readContract({ address, abi: feedAbi, functionName: 'latestRoundData', blockNumber }) });
  }
  assert.equal(await client.readContract({ address: TOKEN, abi: tokenAbi, functionName: 'decimals', blockNumber }), 6);
  assert.equal(await client.readContract({ address: TOKEN, abi: tokenAbi, functionName: 'paused', blockNumber }), false);
  assert.equal((await client.getBlock({ blockNumber })).hash, blockHash);
  observations.push({ collateral: TOKEN, codeHash: keccak256(code), implementation, implementationCodeHash: keccak256(implementationCode), admin, roles, feeds });
}
assert.equal(json(observations[0]), json(observations[1]), 'provider state disagreement');
const observationDirectory = mkdtempSync(join(tmpdir(), 'avensdex-fuji-fork-observations-'));
writeFileSync(join(observationDirectory, 'public-reads.json'), json({ observedAt: new Date().toISOString(),
  environment: 'public-read-only-historical-point', publicTransactionsSubmitted: 0, snapshot, currentAccountObservation: accountSnapshot, candidateObservations: observations[0] }), { mode: 0o600, flag: 'wx' });
console.error(`[read-only observations, not approval] ${observationDirectory}`);
// Select a valid historical fork point with room for the test. This does not approve current/live freshness.
// Actual oracle calls enforce their original timestamps throughout the private run; nothing is restamped.
const forkTimestamp = snapshot.blockTimestamp;
for (const [i, maximumAge] of [[0, 600], [1, 86400]]) {
  const age = forkTimestamp - Number(observations[0].feeds[i].round[3]);
  assert(age >= 0 && age <= maximumAge - 180, 'historical fixture source exceeds its reserved age bound');
}
execFileSync('forge', ['build', '--root', join(ROOT, 'contracts/evm')], { cwd: ROOT, stdio: 'pipe', timeout: 60_000 });
const artifact = name => {
  const a = JSON.parse(readFileSync(join(ROOT, 'contracts/evm/out', `${name}.sol`, `${name}.json`), 'utf8'));
  return { abi: a.abi, bytecode: a.bytecode.object };
};
const vaultArtifact = artifact('AvensVault'), oracleArtifact = artifact('AvensFeedOracle'), settlementArtifact = artifact('AvensSettlement');
const server = createServer();
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const { port } = server.address(); await new Promise(resolve => server.close(resolve));
const child = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '43113', '--accounts', '0',
  '--hardfork', 'paris', '--fork-url', RPCS[0], '--fork-block-number', blockNumber.toString(), '--silent'], { stdio: 'ignore' });
let startupError; child.on('error', error => { startupError = error; });
const exited = new Promise(resolve => child.once('exit', resolve));
try {
  const transport = http(`http://127.0.0.1:${port}`, { retryCount: 0, timeout: 60_000 });
  const local = createPublicClient({ chain: avalancheFuji, transport, cacheTime: 0 });
  let ready = false;
  for (let i = 0; i < 120; i++) {
    if (startupError) throw startupError;
    if (child.exitCode !== null) throw Error('private fork exited during startup');
    try { assert.equal(await local.getChainId(), 43113); ready = true; break; } catch { await delay(100); }
  }
  assert(ready && child.exitCode === null);
  assert((await local.request({ method: 'web3_clientVersion' })).toLowerCase().includes('anvil'));
  assert.equal(await local.getBlockNumber({ cacheTime: 0 }), blockNumber, 'refuse an existing modified node');
  assert.equal((await local.getBlock({ blockNumber })).hash, blockHash);
  assert.equal(keccak256(await local.getCode({ address: TOKEN })), observations[0].codeHash);
  // These RPC privileges exist ONLY on the self-spawned local fork. Public clients above never write.
  const unlocked = new Set(); let receiptCount = 0;
  async function impersonate(address) {
    if (unlocked.has(address.toLowerCase())) return;
    await local.request({ method: 'anvil_impersonateAccount', params: [address] });
    await local.request({ method: 'anvil_setBalance', params: [address, '0x3635c9adc5dea00000'] });
    unlocked.add(address.toLowerCase());
  }
  async function mined(hash) {
    // Read the exact local receipt, without replacement/block-watcher caches across public and fork clients.
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      try {
        const receipt = await local.getTransactionReceipt({ hash });
        assert.equal(receipt.transactionHash, hash);
        assert.equal((await local.getBlock({ blockNumber: receipt.blockNumber })).hash, receipt.blockHash);
        return receipt;
      } catch (error) {
        if (!(error instanceof TransactionReceiptNotFoundError)) throw error;
        await delay(100);
      }
    }
    throw Error('PRIVATE_FORK_RECEIPT_UNRESOLVED_STOP');
  }
  async function send(address, to, abi, functionName, args = [], expectedSuccess = true) {
    await impersonate(address);
    console.error(`[private fork only] ${functionName}`);
    const hash = await local.request({ method: 'eth_sendTransaction', params: [{ from: address, to,
      data: encodeFunctionData({ abi, functionName, args }), gas: '0x2dc6c0', gasPrice: '0x3b9aca00' }] });
    const receipt = await mined(hash);
    assert.equal(receipt.from.toLowerCase(), address.toLowerCase());
    assert.equal(receipt.to?.toLowerCase(), to.toLowerCase());
    receiptCount++; assert.equal(receipt.status, expectedSuccess ? 'success' : 'reverted'); return receipt;
  }
  async function rejectedDeposit(address, vault) {
    // Negative qualification is an eth_call with an exact decoded contract error, not a fabricated receipt.
    await assert.rejects(local.simulateContract({ account: address, address: vault, abi: vaultArtifact.abi,
      functionName: 'deposit', args: [2_000_000n] }), error => {
      const cause = typeof error.walk === 'function' && error.walk(e => e.name === 'ContractFunctionRevertedError');
      return cause?.data?.errorName === 'TokenTransferFailed';
    });
  }
  const owner = createWalletClient({ account: OWNER, chain: avalancheFuji, transport });
  await impersonate(OWNER);
  assert.equal(await local.getTransactionCount({ address: OWNER }), accountSnapshot.nonce, 'current owner nonce no longer matches shadow construction; stop, do not reset');
  const deploymentId = keccak256(stringToHex('avensdex-fuji-functional-paused-release-1'));
  async function deploy(a, args) {
    console.error('[private fork only] deploy next module');
    const hash = await owner.deployContract({ ...a, args, gas: 8_000_000n, gasPrice: 1_000_000_000n });
    const receipt = await mined(hash);
    assert.equal(receipt.from.toLowerCase(), OWNER.toLowerCase());
    assert.equal(receipt.to, null);
    receiptCount++; assert.equal(receipt.status, 'success'); assert(receipt.contractAddress); return receipt.contractAddress;
  }
  const vault = await deploy(vaultArtifact, [TOKEN, deploymentId, 10_000_000n]);
  const oracle = await deploy(oracleArtifact, [1, BASE, QUOTE, FUNDING, 600n, 86400n]);
  const settlement = await deploy(settlementArtifact, [vault, oracle, 1, 86400n]);
  await send(OWNER, vault, vaultArtifact.abi, 'bindSettlement', [settlement]);
  const read = (address, abi, functionName, args = []) => local.readContract({ address, abi, functionName, args });
  assert.equal(await read(vault, vaultArtifact.abi, 'depositsActive'), false);
  assert.equal(await read(vault, vaultArtifact.abi, 'entriesPaused'), true);
  const runtime = {};
  for (const [name, address] of Object.entries({ vault, oracle, settlement })) {
    const code = await local.getCode({ address }); assert(code && code !== '0x'); assert((code.length - 2) / 2 <= 24_576);
    runtime[name] = { address: address.toLowerCase(), codeHash: keccak256(code), bytes: (code.length - 2) / 2 };
  }
  const price = await read(oracle, oracleArtifact.abi, 'price', [1]); assert(price.price18 > 0n);
  const time = async () => (await local.getBlock()).timestamp;
  await send(FUNDING, oracle, oracleArtifact.abi, 'setFundingRate', [0n, (await time()) + 3600n]);
  const evidence = keccak256(stringToHex('LOCAL FORK FIXTURE ONLY - not public qualification approval'));
  await send(OWNER, vault, vaultArtifact.abi, 'activateFuji', [evidence]);
  // Exact live collateral bytecode with privileged FIXTURE provisioning; not public token acquisition.
  const alice = createWalletClient({ account: privateKeyToAccount(generatePrivateKey()), chain: avalancheFuji, transport });
  const bob = createWalletClient({ account: privateKeyToAccount(generatePrivateKey()), chain: avalancheFuji, transport });
  const a = alice.account.address, b = bob.account.address;
  await send(observations[0].roles.masterMinter, TOKEN, tokenAbi, 'configureMinter', [a, 4_000_017n]);
  await send(a, TOKEN, tokenAbi, 'mint', [a, 2_000_017n]);
  await send(a, TOKEN, tokenAbi, 'mint', [b, 2_000_000n]);
  await send(a, TOKEN, tokenAbi, 'approve', [vault, 2_000_000n]);
  await send(b, TOKEN, tokenAbi, 'approve', [vault, 2_000_000n]);
  await send(observations[0].roles.pauser, TOKEN, tokenAbi, 'pause');
  await rejectedDeposit(a, vault);
  await send(a, vault, vaultArtifact.abi, 'deposit', [2_000_000n], false);
  assert.equal(await read(vault, vaultArtifact.abi, 'totalLiabilities6'), 0n);
  await send(observations[0].roles.pauser, TOKEN, tokenAbi, 'unpause');
  await send(observations[0].roles.blacklister, TOKEN, tokenAbi, 'blacklist', [a]);
  await rejectedDeposit(a, vault);
  await send(a, vault, vaultArtifact.abi, 'deposit', [2_000_000n], false);
  assert.equal(await read(vault, vaultArtifact.abi, 'totalLiabilities6'), 0n);
  await send(observations[0].roles.blacklister, TOKEN, tokenAbi, 'unBlacklist', [a]);
  await send(a, vault, vaultArtifact.abi, 'deposit', [2_000_000n]);
  await send(b, vault, vaultArtifact.abi, 'deposit', [2_000_000n]);
  await send(a, TOKEN, tokenAbi, 'transfer', [vault, 17n]);
  assert.equal((await read(vault, vaultArtifact.abi, 'accounting'))[2], 17n);
  const p = await read(oracle, oracleArtifact.abi, 'price', [1]);
  const domain = { name: 'Avensdex', version: '1', chainId: 43113, verifyingContract: settlement };
  const expiry = (await time()) + 3600n;
  const order = (trader, side) => ({ trader, marketId: 1, side, kind: 0, size6: 1_000_000n, limitPrice18: p.price18,
    leverage: 10, maxFeeBps: 3, nonce: 1n, expiry, reduceOnly: false, postOnly: false, ioc: false });
  const long = order(a, 0), short = order(b, 1), typed = message => ({ domain, types: ORDER_TYPES, primaryType: 'Order', message });
  const longSig = await alice.signTypedData(typed(long)), shortSig = await bob.signTypedData(typed(short));
  await send(FUNDING, oracle, oracleArtifact.abi, 'setFundingRate', [0n, (await time()) + 30n]);
  await send(OWNER, settlement, settlementArtifact.abi, 'matchOrders', [long, longSig, short, shortSig, 1_000_000n, p.price18]);
  const fees = await read(vault, vaultArtifact.abi, 'feeBalance6'); assert(fees > 0n);
  await send(OWNER, vault, vaultArtifact.abi, 'setEntriesPaused', [true]);
  await local.request({ method: 'evm_increaseTime', params: [40] });
  await local.request({ method: 'evm_mine', params: [] });
  await send(a, settlement, settlementArtifact.abi, 'closePair', [1n, 400_000n]);
  await send(b, settlement, settlementArtifact.abi, 'closePair', [1n, 600_000n]);
  for (const address of [a, b]) {
    const free = await read(vault, vaultArtifact.abi, 'freeBalance', [address]);
    await send(address, vault, vaultArtifact.abi, 'withdraw', [free]);
    assert.equal(await read(TOKEN, tokenAbi, 'balanceOf', [address]), free);
  }
  const [custody, liabilities, surplus] = await read(vault, vaultArtifact.abi, 'accounting');
  assert.equal(custody, fees + 17n); assert.equal(liabilities, fees); assert.equal(surplus, 17n);
  assert.equal(await read(vault, vaultArtifact.abi, 'totalPairMargin6'), 0n);
  console.log(json({ environment: 'local-pinned-fuji-fork', publicTransactionsSubmitted: 0,
    publicDeploymentAuthorized: false, qualificationComplete: false, forkChecksPassed: true,
    pinnedBlock: { number: snapshot.blockNumber, hash: blockHash }, deploymentId, deployer: OWNER, fundingPublisher: FUNDING,
    startingNonce: accountSnapshot.nonce, currentAccountObservation: accountSnapshot, constructorPolicy: { market: 1, depositCap6: '10000000', baseMaxAge: 600, quoteMaxAge: 86400 },
    candidateObservations: observations[0], expectedRuntime: runtime, localReceiptsChecked: receiptCount,
    checks: ['real proxy transfer deltas', 'issuer pause/blacklist exact-revert eth_call checks', 'donation isolation', 'paused Fuji activation',
      'genuine two-feed ratio', 'signed funded fill', 'paused partial/full close after funding expiry', 'fixed-owner token exits'],
    limitations: ['Fork-only fixture minter/issuer impersonation; no public acquisition or token movement',
      'Issuer proxy/admin/freeze and feed governance remain external trust', 'No public trading or economic admission authorization'] }));
} finally {
  child.kill('SIGTERM'); await Promise.race([exited, delay(2000)]); if (child.exitCode === null) child.kill('SIGKILL');
}
