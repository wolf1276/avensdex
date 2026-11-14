// Explicit operator CLI, Fuji only. Never import this into a server or frontend.
// No activation, collateral approvals/deposits, funding publication, trades, replacements or automatic resubmission.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, openSync, writeSync, closeSync, fsyncSync, unlinkSync, lstatSync } from 'node:fs';
import { join, resolve, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createPublicClient, custom, keccak256 } from 'viem';
import { avalancheFuji } from 'viem/chains';
import { DeploymentJournal } from '../packages/protocol/deployment.ts';
import { deploymentCalls } from '../packages/protocol/deployment-calldata.ts';
import { validatePausedApproval } from '../packages/protocol/deployment-approval.ts';
import { createDeploymentReader } from '../packages/protocol/deployment-reader.ts';
import { readJson } from '../packages/protocol/deployment-plan-cli.ts';

const args = process.argv.slice(2);
assert(args.length === 4 && args.every(p => isAbsolute(p) && p.length <= 4096),
  'required absolute paths: verified packet directory, encrypted keystore, password file, approval JSON');
process.umask(0o077);
const [packet, keystore, passwordFile, approvalFile] = args;
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
assert(packet !== root && !packet.startsWith(root + '/'), 'operator evidence must remain outside Git');
const packetInfo = lstatSync(packet);
assert(packetInfo.isDirectory() && !packetInfo.isSymbolicLink() && (packetInfo.mode & 0o077) === 0, 'packet must be an owner-only real directory');
for (const file of [keystore, passwordFile]) {
  const info = lstatSync(file);
  assert(info.isFile() && !info.isSymbolicLink() && (info.mode & 0o077) === 0, 'signer files must be owner-only regular files');
}
const input = readJson(join(packet, 'input.json'), 'DEPLOYMENT_INPUT_UNAVAILABLE');
const artifacts = readJson(join(packet, 'artifacts.json'), 'DEPLOYMENT_ARTIFACTS_UNAVAILABLE');
const storedPlan = readJson(join(packet, 'plan.json'), 'DEPLOYMENT_PLAN_UNAVAILABLE');
const runtime = readJson(join(packet, 'runtime-config.json'), 'DEPLOYMENT_RUNTIME_UNAVAILABLE');
const fork = readJson(join(packet, 'fork-evidence.json'), 'DEPLOYMENT_FORK_EVIDENCE_UNAVAILABLE');
const approval = readJson(approvalFile, 'DEPLOYMENT_APPROVAL_UNAVAILABLE');
const now = () => Math.floor(Date.now() / 1000);
const { plan, calls } = deploymentCalls(input, artifacts, now());
assert.equal(JSON.stringify(plan), JSON.stringify(storedPlan), 'packet plan must rebuild exactly');
assert.equal(fork.planHash, plan.planHash); assert.equal(fork.pausedStateVerified, true);
assert.equal(fork.publicTransactionsSubmitted, 0); assert.equal(fork.receipts.length, 4);
assert.equal(JSON.stringify(fork.expectedRuntimeHashes), JSON.stringify(runtime.expectedRuntimeHashes));
validatePausedApproval(approval, plan, now());
execFileSync('git', ['diff', '--exit-code', plan.sourceRevision, '--', 'contracts/evm/src', 'contracts/evm/foundry.toml'], {
  cwd: root, stdio: 'pipe', timeout: 15000,
});
const urls = ['https://api.avax-test.network/ext/bc/C/rpc', 'https://avalanche-fuji-c-chain-rpc.publicnode.com'];
const env = { PATH: process.env.PATH, HOME: homedir(), NO_COLOR: '1' };
const allowed = new Set(['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call', 'eth_getTransactionReceipt',
  'eth_getTransactionByHash', 'eth_getTransactionCount', 'eth_getBalance']);
const rpc = (url, method, params) => JSON.parse(execFileSync('cast', ['rpc', method, JSON.stringify(params), '--raw', '--rpc-url', url, '--rpc-timeout', '15'], {
  env, encoding: 'utf8', timeout: 20000, maxBuffer: 1048576, stdio: ['ignore', 'pipe', 'pipe'],
}));
const clients = urls.map(url => createPublicClient({ chain: avalancheFuji, cacheTime: 0, transport: custom({ request: async ({ method, params }) => {
  assert(allowed.has(method), 'reader cannot submit transactions'); return rpc(url, method, params ?? []);
} }, { retryCount: 0 }) }));
const reader = await createDeploymentReader(clients[0], clients[1]);
const lockPath = join(dirname(packet), 'active-paused-deployment.lock');
let lockFd, journal, eventsFd, completed = false;
function writeAll(fd, text) { const bytes = Buffer.from(text); let offset = 0; while (offset < bytes.length) { const n = writeSync(fd, bytes, offset, bytes.length - offset); assert(n > 0); offset += n; } fsyncSync(fd); }
function record(value) { writeAll(eventsFd, JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n'); }
async function preflight(call) {
  validatePausedApproval(approval, plan, now());
  for (const client of clients) {
    assert.equal(await client.getChainId(), 43113);
    assert.equal(BigInt(await client.getTransactionCount({ address: plan.deployer, blockTag: 'latest' })), BigInt(call.nonce));
    assert.equal(BigInt(await client.getTransactionCount({ address: plan.deployer, blockTag: 'pending' })), BigInt(call.nonce));
    const reserve = calls.slice(call.sequence).reduce((sum, tx) => sum + BigInt(tx.gas) * BigInt(tx.maxFeePerGas), 0n);
    assert(await client.getBalance({ address: plan.deployer }) >= reserve, 'remaining worst-case gas reserve');
    for (const identity of Object.values(plan.codeIdentities)) {
      const code = await client.getCode({ address: identity.address }); assert(code && code !== '0x'); assert.equal(keccak256(code), identity.codeHash);
    }
  }
}
try {
  lockFd = openSync(lockPath, 'wx', 0o600); writeAll(lockFd, JSON.stringify({ packet, planHash: plan.planHash, pid: process.pid }));
  closeSync(lockFd); lockFd = undefined;
  eventsFd = openSync(join(packet, 'submissions.jsonl'), 'wx', 0o600);
  const derived = execFileSync('cast', ['wallet', 'address', '--keystore', keystore, '--password-file', passwordFile], {
    env, encoding: 'utf8', timeout: 90000, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim().toLowerCase();
  assert.equal(derived, plan.deployer, 'exact bootstrap signer');
  const journalPath = join(packet, 'journal');
  assert(!existsSync(journalPath), 'existing journal requires explicit read-only recovery before any new operator run');
  journal = DeploymentJournal.open(journalPath, { input, artifacts, expectedRuntimeHashes: runtime.expectedRuntimeHashes,
    reader, confirmations: runtime.confirmations, create: true }, now());
  for (const call of calls) {
    assert.equal(journal.view().nextSignableSequence, call.sequence, 'predecessor must be canonically confirmed');
    await preflight(call);
    const options = ['mktx', '--value', '0', '--chain', '43113', '--nonce', call.nonce, '--gas-limit', String(call.gas),
      '--gas-price', call.maxFeePerGas, '--priority-gas-price', call.maxPriorityFeePerGas, '--from', plan.deployer,
      '--keystore', keystore, '--password-file', passwordFile, '--rpc-url', urls[0], '--rpc-timeout', '15'];
    if (call.kind === 'create') options.push('--create', call.data);
    else options.push(call.to, 'bindSettlement(address)', plan.addresses.settlement);
    const raw = execFileSync('cast', options, { env, encoding: 'utf8', timeout: 90000, maxBuffer: 1048576, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    assert(/^0x02[0-9a-fA-F]+$/.test(raw), 'EIP-1559 signed material only');
    const fd = openSync(join(packet, `signed-${call.sequence}.hex`), 'wx', 0o600);
    try { writeAll(fd, raw + '\n'); } finally { closeSync(fd); }
    const dir = openSync(packet, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
    await journal.recordSigned(raw); // Recovers and binds actual signer, nonce, target, value, calldata, gas and fees.
    const txHash = keccak256(raw);
    await preflight(call);
    record({ type: 'dispatch-intent', sequence: call.sequence, txHash, planHash: plan.planHash });
    try { assert.equal(rpc(urls[0], 'eth_sendRawTransaction', [raw]), txHash); record({ type: 'submission-ack', sequence: call.sequence, txHash }); }
    catch { record({ type: 'submission-unknown', sequence: call.sequence, txHash }); }
    const deadline = Date.now() + 180000;
    let view;
    do {
      view = await journal.reconcile(call.sequence);
      const status = view.transactions[call.sequence].status;
      if (status === 'confirmed') break;
      assert(status !== 'reverted' && status !== 'reorged', 'canonical deployment failure; stop without retry');
      await delay(1500);
    } while (Date.now() < deadline);
    assert.equal(view.transactions[call.sequence].status, 'confirmed', 'unknown submission outcome: stop and reconcile, never resubmit');
    record({ type: 'confirmed', sequence: call.sequence, txHash, receipt: view.transactions[call.sequence].receipt });
    console.log(JSON.stringify({ sequence: call.sequence, contract: call.contract, status: 'confirmed', txHash }));
  }
  for (const client of clients) {
    const read = name => client.readContract({ address: plan.addresses.vault, abi: artifacts.AvensVault.abi, functionName: name });
    assert.equal((await read('bootstrapOwner')).toLowerCase(), plan.deployer);
    assert.equal((await read('settlementModule')).toLowerCase(), plan.addresses.settlement);
    assert.equal(await read('depositsActive'), false); assert.equal(await read('entriesPaused'), true);
    assert.equal(await read('depositCap6'), 10000000n); assert.equal(await read('deploymentId'), plan.deploymentId);
    assert.equal(await read('totalFree6'), 0n); assert.equal(await read('totalPairMargin6'), 0n);
    const publisher = await client.readContract({ address: plan.addresses.feedOracle, abi: artifacts.AvensFeedOracle.abi, functionName: 'fundingPublisher' });
    assert.equal(publisher.toLowerCase(), plan.fundingPublisher);
  }
  const result = { status: 'public-fuji-paused-deployment-verified', chainId: 43113, planHash: plan.planHash, deploymentId: plan.deploymentId,
    sourceRevision: plan.sourceRevision, addresses: plan.addresses, expectedRuntimeHashes: runtime.expectedRuntimeHashes,
    transactions: journal.view().transactions.map(tx => ({ sequence: tx.sequence, contract: tx.tx.contract, txHash: tx.signed.txHash, receipt: tx.receipt })),
    depositsActive: false, entriesPaused: true, publicTrades: 0, publicHedges: 0 };
  const fd = openSync(join(packet, 'public-deployment.json'), 'wx', 0o600);
  try { writeAll(fd, JSON.stringify(result, null, 2) + '\n'); } finally { closeSync(fd); }
  record({ type: 'completed', planHash: plan.planHash }); completed = true;
  console.log(JSON.stringify(result, null, 2));
} catch {
  console.error(JSON.stringify({ status: 'STOPPED_NO_RETRY', packet, recovery: 'Preserve all evidence and signed material. Use read-only deployment reconciliation before any further signing or submission.' }));
  process.exitCode = 1;
} finally {
  try { journal?.close(); } catch { /* Preserve crash evidence. */ }
  if (eventsFd !== undefined) closeSync(eventsFd);
  if (lockFd !== undefined) closeSync(lockFd);
  if (completed) unlinkSync(lockPath); // Unknown/error operations retain their global recovery marker.
}
