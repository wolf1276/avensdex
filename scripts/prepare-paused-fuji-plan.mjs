// Preparation only: public read-only probes and a new private loopback fork. No operator signer or public submission.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createPublicClient, createWalletClient, custom, http, keccak256 } from 'viem';
import { avalancheFuji } from 'viem/chains';
import { deploymentCalls } from '../packages/protocol/deployment-calldata.ts';
import { prepareFoundryArtifacts } from '../packages/protocol/foundry-artifacts-cli.ts';
import { readJson } from '../packages/protocol/deployment-plan-cli.ts';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
assert(args.length === 2 && args.every(p => isAbsolute(p) && p.length <= 4096), 'two absolute paths required: input JSON and NEW external output directory');
const output = resolve(args[1]);
assert(output !== root && !output.startsWith(root + '/'), 'generated operator packet must stay outside Git');
process.umask(0o077);
const input = readJson(args[0], 'DEPLOYMENT_INPUT_UNAVAILABLE');
execFileSync('forge', ['build', '--root', join(root, 'contracts/evm')], { cwd: root, timeout: 60000, stdio: 'pipe' });
const artifacts = prepareFoundryArtifacts(join(root, 'contracts/evm/out'));
const { plan, calls } = deploymentCalls(input, artifacts, Math.floor(Date.now() / 1000));
const methods = new Set(['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_getBalance', 'eth_getTransactionCount']);
const urls = ['https://api.avax-test.network/ext/bc/C/rpc', 'https://avalanche-fuji-c-chain-rpc.publicnode.com'];
const providers = urls.map(url => createPublicClient({ chain: avalancheFuji, cacheTime: 0, transport: custom({ request: async ({ method, params }) => {
  assert(methods.has(method), 'preparer public transport is read-only');
  return JSON.parse(execFileSync('cast', ['rpc', method, JSON.stringify(params ?? []), '--raw', '--rpc-url', url, '--rpc-timeout', '15'], {
    encoding: 'utf8', timeout: 20000, maxBuffer: 1048576, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NO_COLOR: '1' },
  }));
} }, { retryCount: 0 }) }));
assert((await Promise.all(providers.map(c => c.getChainId()))).every(id => id === 43113), 'Fuji identity');
const heads = await Promise.all(providers.map(c => c.getBlock({ blockTag: 'latest' })));
const height = heads.reduce((n, b) => n < b.number ? n : b.number, heads[0].number) - 2n;
const blocks = await Promise.all(providers.map(c => c.getBlock({ blockNumber: height })));
assert.equal(blocks[0].hash, blocks[1].hash); assert.equal(blocks[0].timestamp, blocks[1].timestamp);
assert(BigInt(Math.floor(Date.now() / 1000)) - blocks[0].timestamp >= 0n
  && BigInt(Math.floor(Date.now() / 1000)) - blocks[0].timestamp <= 120n, 'fresh preparation block');
const maxGas = plan.transactions.reduce((sum, tx) => sum + BigInt(tx.gas) * BigInt(tx.maxFeePerGas), 0n);
for (const provider of providers) {
  assert.equal(BigInt(await provider.getTransactionCount({ address: plan.deployer, blockNumber: height })), BigInt(plan.startingNonce));
  assert.equal(BigInt(await provider.getTransactionCount({ address: plan.deployer, blockTag: 'pending' })), BigInt(plan.startingNonce));
  assert(await provider.getBalance({ address: plan.deployer, blockNumber: height }) >= maxGas, 'worst-case native gas reserve');
  for (const identity of Object.values(plan.codeIdentities)) {
    const code = await provider.getCode({ address: identity.address, blockNumber: height });
    assert(code && code !== '0x'); assert.equal(keccak256(code), identity.codeHash);
  }
  assert.equal((await provider.getBlock({ blockNumber: height })).hash, blocks[0].hash);
}
mkdirSync(output, { mode: 0o700 }); chmodSync(output, 0o700);
const save = (name, value) => writeFileSync(join(output, name), JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n', { flag: 'wx', mode: 0o600 });
save('input.json', input); save('artifacts.json', artifacts); save('plan.json', plan); save('calls.json', calls);
const listener = createServer();
await new Promise((yes, no) => { listener.once('error', no); listener.listen(0, '127.0.0.1', yes); });
const port = listener.address().port;
await new Promise((yes, no) => listener.close(error => error ? no(error) : yes()));
const child = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '43113', '--fork-url', urls[0],
  '--fork-block-number', String(height), '--hardfork', 'paris', '--accounts', '0', '--silent'], { stdio: 'ignore' });
let startupError; child.on('error', error => { startupError = error; });
const exited = new Promise(yes => child.once('exit', yes));
try {
  const transport = http(`http://127.0.0.1:${port}`, { retryCount: 0, timeout: 15000 });
  const local = createPublicClient({ chain: avalancheFuji, transport, cacheTime: 0 });
  let ready = false;
  for (let n = 0; n < 100; n++) {
    if (startupError) throw startupError;
    assert(child.exitCode === null, 'private fork exited');
    try { ready = await local.getChainId() === 43113; if (ready) break; } catch { /* Wait for this newly spawned node only. */ }
    await delay(100);
  }
  assert(ready && child.exitCode === null, 'fresh private fork required');
  assert.equal(await local.getBlockNumber({ cacheTime: 0 }), height);
  await local.request({ method: 'anvil_setBlockTimestampInterval', params: [0] });
  assert.equal(BigInt(await local.getTransactionCount({ address: plan.deployer })), BigInt(plan.startingNonce));
  await local.request({ method: 'anvil_impersonateAccount', params: [plan.deployer] });
  const wallet = createWalletClient({ account: plan.deployer, chain: avalancheFuji, transport });
  const expectedRuntimeHashes = {}, receipts = [];
  for (const call of calls) {
    assert.equal(keccak256(call.data), call.dataHash);
    const estimate = await local.estimateGas({ account: plan.deployer, to: call.to ?? undefined, data: call.data, value: 0n,
      nonce: Number(call.nonce), maxFeePerGas: BigInt(call.maxFeePerGas), maxPriorityFeePerGas: BigInt(call.maxPriorityFeePerGas) });
    assert(estimate <= BigInt(call.gas), `fork sequence ${call.sequence} estimate ${estimate} exceeds frozen gas ${call.gas}`);
    const hash = await wallet.sendTransaction({ to: call.to ?? undefined, data: call.data, value: 0n,
      nonce: Number(call.nonce), gas: BigInt(call.gas), maxFeePerGas: BigInt(call.maxFeePerGas), maxPriorityFeePerGas: BigInt(call.maxPriorityFeePerGas) });
    const receipt = await local.waitForTransactionReceipt({ hash, pollingInterval: 50, timeout: 60000 });
    assert.equal(receipt.status, 'success', `fork sequence ${call.sequence}, gas used ${receipt.gasUsed}, limit ${call.gas}`);
    assert(receipt.gasUsed <= BigInt(call.gas));
    if (call.kind === 'create') {
      assert.equal(receipt.contractAddress.toLowerCase(), call.expectedCreatedAddress);
      const code = await local.getCode({ address: call.expectedCreatedAddress }); assert(code && code !== '0x');
      expectedRuntimeHashes[call.contract] = keccak256(code);
    }
    receipts.push({ sequence: call.sequence, hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash,
      gasUsed: receipt.gasUsed, environment: 'private-loopback-historical-fork-not-public-deployment' });
  }
  const readVault = name => local.readContract({ address: plan.addresses.vault, abi: artifacts.AvensVault.abi, functionName: name });
  assert.equal((await readVault('bootstrapOwner')).toLowerCase(), plan.deployer);
  assert.equal((await readVault('settlementModule')).toLowerCase(), plan.addresses.settlement);
  assert.equal(await readVault('deploymentId'), plan.deploymentId);
  assert.equal(await readVault('depositCap6'), 10000000n);
  assert.equal(await readVault('depositsActive'), false); assert.equal(await readVault('entriesPaused'), true);
  assert.equal(await readVault('totalFree6'), 0n); assert.equal(await readVault('totalPairMargin6'), 0n);
  const publisher = await local.readContract({ address: plan.addresses.feedOracle, abi: artifacts.AvensFeedOracle.abi, functionName: 'fundingPublisher' });
  assert.equal(publisher.toLowerCase(), plan.fundingPublisher);
  for (const provider of providers) assert.equal((await provider.getBlock({ blockNumber: height })).hash, blocks[0].hash);
  save('runtime-config.json', { expectedRuntimeHashes, confirmations: 3 });
  save('fork-evidence.json', { environment: 'private-loopback-fork', publicTransactionsSubmitted: 0,
    sourceBlock: { number: height, hash: blocks[0].hash, timestamp: blocks[0].timestamp }, planHash: plan.planHash,
    pausedStateVerified: true, expectedRuntimeHashes, receipts });
  console.log(JSON.stringify({ status: 'paused-plan-private-fork-verified', planHash: plan.planHash, output,
    addresses: plan.addresses, expectedRuntimeHashes, receipts: receipts.length, publicTransactionsSubmitted: 0,
    activationAuthorized: false, expiresAt: new Date(plan.expiresAt * 1000).toISOString() }, null, 2));
} finally {
  child.kill('SIGTERM'); await Promise.race([exited, delay(2000)]);
  if (child.exitCode === null) { child.kill('SIGKILL'); await exited; }
}
