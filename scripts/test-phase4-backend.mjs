// Fresh local Anvil integration only. No configurable public RPC, wallet, funded-state reset or deployment path.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { createPublicClient, createWalletClient, http, keccak256, stringToHex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { avalancheFuji } from 'viem/chains';
import { WebSocket } from 'ws';
import { orderTypedData, cancelTypedData } from '../packages/clob/admission.ts';
import { JournaledMatcher } from '../packages/clob/journal.ts';
import { MarketDataFeed } from '../packages/clob/feed.ts';
import { SettlementJournal } from '../packages/clob/settlement-journal.ts';
import { createSettlementReader } from '../packages/clob/settlement-reader.ts';
import { SettlementOutcomeBridge } from '../packages/clob/settlement-bridge.ts';
import { startMarketData } from '../services/clob/market-data.ts';
import { readFundingSnapshot, buildFundingPublication } from '../packages/clob/funding-reader.ts';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
execFileSync('forge', ['build', '--root', join(root, 'contracts/evm')], { cwd: root, stdio: 'pipe', timeout: 60_000 });
function artifact(file, name) {
  const a = JSON.parse(readFileSync(join(root, 'contracts/evm/out', file, `${name}.json`), 'utf8'));
  return { abi: a.abi, bytecode: a.bytecode.object };
}
const tokenArtifact = artifact('AvensVault.t.sol', 'MockVaultToken');
const controllerArtifact = artifact('AvensFundingOracle.t.sol', 'ControllerSource');
const vaultArtifact = artifact('AvensVault.sol', 'AvensVault');
const fundingOracleArtifact = artifact('AvensFundingOracle.sol', 'AvensFundingOracle');
const settlementArtifact = artifact('AvensSettlement.sol', 'AvensSettlement');

const server = createServer();
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const { port } = server.address();
await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
const child = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '43113', '--timestamp', '1800000100', '--hardfork', 'paris', '--accounts', '0', '--silent'],
  { stdio: 'ignore' });
let startupError;
child.on('error', error => { startupError = error; });
const exited = new Promise(resolve => child.once('exit', resolve));

const transport = http(`http://127.0.0.1:${port}`, { retryCount: 0, timeout: 3000 });
const client = createPublicClient({ chain: avalancheFuji, transport, cacheTime: 0 });
let service;
let journalMatcher;
let settlementJournal;
let ws;
let matcherDir;
let settlementDir;
const gas = [];
let gasCostWei = 0n;
let deployer;
let clock = 1_800_000_100;
const feed = new MarketDataFeed();
let feedFailure;
const frames = [];
async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (feedFailure) throw feedFailure;
    assert(Date.now() < deadline, 'timed out waiting for loopback feed');
    await delay(10);
  }
}

async function receipt(hash) {
  const r = await client.waitForTransactionReceipt({ hash, pollingInterval: 10, timeout: 10_000 });
  assert.equal(r.status, 'success'); gas.push(r.gasUsed);
  assert.equal(typeof r.effectiveGasPrice, 'bigint');
  gasCostWei += r.gasUsed * r.effectiveGasPrice;
  clock = Number((await client.getBlock()).timestamp);
  return r;
}
async function deploy(a, args = []) {
  const r = await receipt(await deployer.deployContract({ ...a, args }));
  assert(r.contractAddress); return r.contractAddress.toLowerCase();
}
async function write(wallet, address, a, functionName, args = []) {
  return receipt(await wallet.writeContract({ address, abi: a.abi, functionName, args }));
}
const read = (address, a, functionName, args = []) => client.readContract({ address, abi: a.abi, functionName, args });
async function mine() {
  await client.request({ method: 'evm_mine', params: [] });
  clock = Number((await client.getBlock()).timestamp);
}

try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (startupError) throw startupError;
    if (child.exitCode !== null) throw Error('fresh local Anvil exited during startup');
    try { assert.equal(await client.getChainId(), 43113); ready = true; break; }
    catch { await delay(50); }
  }
  assert(ready && child.exitCode === null, 'fresh local Anvil did not start');
  assert.equal(await client.getBlockNumber({ cacheTime: 0 }), 0n, 'refuse an existing funded node');

  const wallets = Array.from({ length: 4 }, () => createWalletClient({ account: privateKeyToAccount(generatePrivateKey()), chain: avalancheFuji, transport }));
  deployer = wallets[0];
  const alice = wallets[1];
  const bob = wallets[2];
  const fundingPublisher = wallets[3];
  for (const wallet of wallets) await client.request({ method: 'anvil_setBalance', params: [wallet.account.address, '0x3635c9adc5dea00000'] });

  // Deploy ControllerSource fixtures and set distinct fresh prices.
  const indexSource = await deploy(controllerArtifact);
  const markSource = await deploy(controllerArtifact);
  const nowBlock = () => client.getBlock().then(b => b.timestamp);
  await write(deployer, indexSource, controllerArtifact, 'set', [10n ** 18n, await nowBlock()]);
  await write(deployer, markSource, controllerArtifact, 'set', [10012n * 10n ** 14n, await nowBlock()]);

  const deploymentId = keccak256(stringToHex('avensdex-phase4-backend'));
  const token = await deploy(tokenArtifact, [6]);
  const vault = await deploy(vaultArtifact, [token, deploymentId, 10_000_000n]);
  const oracle = await deploy(fundingOracleArtifact, [indexSource, markSource, 1, fundingPublisher.account.address]);
  const settlement = await deploy(settlementArtifact, [vault, oracle, 1, 60n]);
  await write(deployer, vault, vaultArtifact, 'bindSettlement', [settlement]);

  // Paired same-node funding read (local, not independence evidence).
  const primary = createPublicClient({ chain: avalancheFuji, transport, cacheTime: 0 });
  const secondary = createPublicClient({ chain: avalancheFuji, transport, cacheTime: 0 });
  const oracleCode = await client.getCode({ address: oracle });
  const oracleCodeHash = keccak256(oracleCode);
  const now = Number((await client.getBlock()).timestamp);
  const snapshot = await readFundingSnapshot(primary, secondary, {
    chainId: 43113, confirmations: 1, deploymentId, marketId: 1, now,
    oracleCodeHash, oracleContract: oracle, settlementContract: settlement,
  });
  const publication = buildFundingPublication(snapshot, now);
  assert.equal(publication.from, fundingPublisher.account.address.toLowerCase());
  await receipt(await fundingPublisher.sendTransaction({ to: publication.to, data: publication.data, value: 0n }));

  const evidenceHash = keccak256(stringToHex('LOCAL FIXTURE ONLY - not public qualification'));
  await write(deployer, vault, vaultArtifact, 'activateFuji', [evidenceHash]);

  for (const wallet of [alice, bob]) {
    await write(wallet, token, tokenArtifact, 'mint', [wallet.account.address, 2_000_000n]);
    await write(wallet, token, tokenArtifact, 'approve', [vault, 2_000_000n]);
    await write(wallet, vault, vaultArtifact, 'deposit', [2_000_000n]);
  }

  // Real signed admission via service.applySigned with Fuji EIP-712.
  matcherDir = mkdtempSync(join(tmpdir(), 'avensdex-phase4-matcher-'));
  settlementDir = mkdtempSync(join(tmpdir(), 'avensdex-phase4-settlement-'));
  const matcherBinding = { chainId: 43113, marketId: 1, settlementContract: settlement };
  journalMatcher = JournaledMatcher.open(matcherDir, matcherBinding, true);
  const settlementIdentity = { chainId: 43113, deploymentId, settlementContract: settlement };
  const reader = await createSettlementReader(client, client, settlementIdentity);
  settlementJournal = SettlementJournal.open(settlementDir, settlementIdentity, { confirmations: 2, reader, create: true });
  const bridge = new SettlementOutcomeBridge(journalMatcher, settlementJournal, deploymentId);
  service = await startMarketData(journalMatcher, 0, () => clock);

  ws = new WebSocket(`ws://127.0.0.1:${service.port}/stream`);
  ws.on('message', text => {
    try {
      const frame = JSON.parse(text.toString());
      assert.equal(feed.receive(frame), 'applied');
      frames.push(frame);
    } catch (error) { feedFailure = error; }
  });
  await waitFor(() => frames.length > 0);

  const oraclePriceRead = await read(oracle, fundingOracleArtifact, 'price', [1]);
  const price18 = oraclePriceRead.price18 ?? oraclePriceRead[0];
  const nowSec = Number((await client.getBlock()).timestamp);
  const expiry = nowSec + 3600;
  const longInput = { trader: alice.account.address.toLowerCase(), marketId: 1, side: 'buy', kind: 'limit', size6: '3000000',
    limitPrice18: price18.toString(), leverage: 10, maxFeeBps: 3, nonce: '1', expiry, reduceOnly: false, postOnly: false, ioc: false };
  const shortInput = { trader: bob.account.address.toLowerCase(), marketId: 1, side: 'sell', kind: 'limit', size6: '2000000',
    limitPrice18: price18.toString(), leverage: 10, maxFeeBps: 3, nonce: '1', expiry, reduceOnly: false, postOnly: false, ioc: false };

  const longTyped = orderTypedData(journalMatcher.binding, longInput, nowSec);
  const shortTyped = orderTypedData(journalMatcher.binding, shortInput, nowSec);
  const longSig = await alice.signTypedData(longTyped);
  const shortSig = await bob.signTypedData(shortTyped);

  await service.applySigned({ type: 'order', order: longInput, signature: longSig });
  await service.applySigned({ type: 'order', order: shortInput, signature: shortSig });

  const trade = journalMatcher.snapshot().trades.at(-1);
  assert(trade, 'expected matched trade');
  const longOrderHash = trade.side === 'buy' ? trade.taker : trade.maker;
  const shortOrderHash = trade.side === 'buy' ? trade.maker : trade.taker;

  const nextPairId = await read(settlement, settlementArtifact, 'nextPairId');
  const txNonce = await client.getTransactionCount({ address: deployer.account.address });
  const intent = settlementJournal.recordIntent({
    pairId: nextPairId.toString(), longOrderHash, shortOrderHash, size6: trade.size6, price18: trade.price18,
    sender: deployer.account.address.toLowerCase(), nonce: String(txNonce),
  });
  assert.equal(settlementJournal.intent(intent.intentId).status, 'intent');

  const toOnchainOrder = (input) => ({
    trader: input.trader, marketId: input.marketId, side: input.side === 'buy' ? 0 : 1, kind: 0,
    size6: BigInt(input.size6), limitPrice18: BigInt(input.limitPrice18), leverage: input.leverage,
    maxFeeBps: input.maxFeeBps, nonce: BigInt(input.nonce), expiry: BigInt(input.expiry),
    reduceOnly: input.reduceOnly, postOnly: input.postOnly, ioc: input.ioc,
  });
  const txHash = await deployer.writeContract({
    address: settlement, abi: settlementArtifact.abi, functionName: 'matchOrders',
    args: [toOnchainOrder(longInput), longSig, toOnchainOrder(shortInput), shortSig, BigInt(trade.size6), BigInt(trade.price18)],
    nonce: txNonce,
  });
  settlementJournal.recordBroadcast(intent.intentId, { txHash, sender: deployer.account.address.toLowerCase(), nonce: String(txNonce) });
  await receipt(txHash);
  assert.equal((await settlementJournal.reconcile(intent.intentId)).status, 'pending');
  assert.equal(settlementJournal.confirmedFills().length, 0);
  await mine();
  assert.equal((await settlementJournal.reconcile(intent.intentId)).status, 'confirmed');
  await service.reconcileSettlement(bridge, trade.id, intent.intentId);
  assert.equal(journalMatcher.trade(trade.id).settlement, 'confirmed');
  assert.equal(journalMatcher.trade(trade.id).settlementIntentId, intent.intentId);
  await waitFor(() => feed.view().snapshot?.trades.at(-1)?.settlement === 'confirmed');
  assert.equal(journalMatcher.snapshot().pendingSettlements, 0);

  // HTTP snapshot shows confirmed matcher/feed outcome.
  const httpSnapshot = await (await fetch(`http://127.0.0.1:${service.port}/snapshot`)).json();
  assert.equal(httpSnapshot.data.trades.at(-1).settlement, 'confirmed');
  assert.equal(journalMatcher.snapshot().orders.find(o => o.id === longOrderHash).remaining6, '1000000');
  const cancel = { trader: longInput.trader, orderHash: longOrderHash, nonce: '1', expiry: clock + 600 };
  const cancelTyped = cancelTypedData(journalMatcher.binding, cancel, clock);
  const cancelSignature = await alice.signTypedData(cancelTyped);
  await service.applySigned({ type: 'cancel', cancel, signature: cancelSignature });
  assert.equal(journalMatcher.snapshot().orders.find(o => o.id === longOrderHash).resting, false);
  // An offchain cancellation acknowledgment is not an onchain cancellation receipt.
  await write(alice, settlement, settlementArtifact, 'cancelOrder', [cancelTyped.message, cancelSignature]);
  assert.equal(await read(settlement, settlementArtifact, 'filledSize6', [longOrderHash]), 2_000_000n);

  // refreshPositions verifies real exact +/-size at policy-confirmed block.
  await service.refreshPositions(primary, secondary, settlementIdentity, { confirmations: 2, maxPairs: 4 });
  const positions = journalMatcher.snapshot().confirmedPositions;
  assert.equal(positions.values[alice.account.address.toLowerCase()], '2000000');
  assert.equal(positions.values[bob.account.address.toLowerCase()], '-2000000');

  // refreshFunding exposes distinct index and mark; ready/mutations stay 503.
  await service.refreshFunding(primary, secondary, {
    chainId: 43113, marketId: 1, deploymentId, settlementContract: settlement,
    oracleContract: oracle, oracleCodeHash, confirmations: 1,
  });
  const fundingResponse = await fetch(`http://127.0.0.1:${service.port}/funding`);
  assert.equal(fundingResponse.status, 200);
  const fundingBody = await fundingResponse.json();
  assert.notEqual(fundingBody.funding.indexPrice18, fundingBody.funding.markPrice18);
  assert.equal((await fetch(`http://127.0.0.1:${service.port}/ready`)).status, 503);
  const mutationResponse = await fetch(`http://127.0.0.1:${service.port}/snapshot`, { method: 'POST' });
  assert.equal(mutationResponse.status, 503);

  // Advance 10 seconds, settle funding.
  await client.request({ method: 'evm_increaseTime', params: [10] });
  await mine();
  const pairId = BigInt(intent.pairId);
  const marginsBefore = await read(vault, vaultArtifact, 'pairMargins', [pairId]);
  await write(deployer, settlement, settlementArtifact, 'settleFunding', [pairId]);
  const marginsAfter = await read(vault, vaultArtifact, 'pairMargins', [pairId]);
  assert(marginsAfter.longMargin6 < marginsBefore.longMargin6, 'positive funding charges long');
  assert(marginsAfter.shortMargin6 > marginsBefore.shortMargin6, 'positive funding credits short');
  assert.equal(marginsAfter.longMargin6 + marginsAfter.shortMargin6, marginsBefore.longMargin6 + marginsBefore.shortMargin6);

  // Derive the terminal index independently from the stored rate/price/checkpoint before advancing time.
  const capturedPrice = await read(oracle, fundingOracleArtifact, 'observedIndexPrice18');
  const capturedRate = await read(oracle, fundingOracleArtifact, 'fundingRatePpm');
  const capturedUntil = await read(oracle, fundingOracleArtifact, 'rateValidUntil');
  const capturedAt = await read(oracle, fundingOracleArtifact, 'fundingUpdatedAt');
  const capturedRemainder = await read(oracle, fundingOracleArtifact, 'fundingRemainder');
  const storedIndex = await read(oracle, fundingOracleArtifact, 'checkpointIndex18');
  const expectedTerminal = storedIndex + (capturedPrice * capturedRate * (capturedUntil - capturedAt) + capturedRemainder) / 3_600_000_000n;
  // Force expiry, then refresh only the independent source fixtures, not the funding rate.
  await client.request({ method: 'evm_increaseTime', params: [3700] });
  await mine();
  const refreshTime = await nowBlock();
  await write(deployer, indexSource, controllerArtifact, 'set', [10n ** 18n, refreshTime]);
  await write(deployer, markSource, controllerArtifact, 'set', [10012n * 10n ** 14n, refreshTime]);
  const [terminalAtExpiry, oldExpiry] = await read(oracle, fundingOracleArtifact, 'fundingIndex', [1]);
  assert.equal(terminalAtExpiry, expectedTerminal, 'fresh source quotes must not backfill expired funding');
  assert.equal(oldExpiry, capturedUntil);
  await service.refreshFunding(primary, secondary, {
    chainId: 43113, marketId: 1, deploymentId, settlementContract: settlement,
    oracleContract: oracle, oracleCodeHash, confirmations: 1,
  });
  assert.equal((await (await fetch(`http://127.0.0.1:${service.port}/funding`)).json()).funding.fundingAvailable, false);

  // Owners can exit against the terminal index while funding is expired, before any renewal.
  await write(bob, settlement, settlementArtifact, 'closePair', [nextPairId, 2_000_000n]);
  const closedPair = await read(settlement, settlementArtifact, 'pairs', [nextPairId]);
  assert.equal(closedPair[0], 0n);
  assert.equal(await read(settlement, settlementArtifact, 'positionCount', [alice.account.address]), 0);
  assert.equal(await read(settlement, settlementArtifact, 'positionCount', [bob.account.address]), 0);

  // Publish a renewed rate; checkpoint must not backfill the gap.
  const now2 = Number((await client.getBlock()).timestamp);
  const snapshot2 = await readFundingSnapshot(primary, secondary, {
    chainId: 43113, confirmations: 1, deploymentId, marketId: 1, now: now2,
    oracleCodeHash, oracleContract: oracle, settlementContract: settlement,
  });
  const publication2 = buildFundingPublication(snapshot2, now2);
  await receipt(await fundingPublisher.sendTransaction({ to: publication2.to, data: publication2.data, value: 0n }));
  const checkpointIndex = await read(oracle, fundingOracleArtifact, 'checkpointIndex18');
  assert.equal(checkpointIndex, terminalAtExpiry);

  for (const wallet of [alice, bob]) {
    const free = await read(vault, vaultArtifact, 'freeBalance', [wallet.account.address]);
    await write(wallet, vault, vaultArtifact, 'withdraw', [free]);
    assert.equal(await read(token, tokenArtifact, 'balanceOf', [wallet.account.address]), free);
  }
  const [custody, liabilities, surplus] = await read(vault, vaultArtifact, 'accounting');
  const feeBalance = await read(vault, vaultArtifact, 'feeBalance6');
  assert.equal(liabilities, feeBalance);
  assert.equal(custody, liabilities);
  assert.equal(surplus, 0n);
  assert.equal(await read(vault, vaultArtifact, 'totalFree6'), 0n);
  assert.equal(await read(vault, vaultArtifact, 'totalEscrow6'), 0n);
  assert.equal(await read(vault, vaultArtifact, 'totalPairMargin6'), 0n);

  await mine();
  await service.refreshPositions(primary, secondary, settlementIdentity, { confirmations: 2, maxPairs: 4 });
  assert.deepEqual(journalMatcher.snapshot().confirmedPositions.values, {});
  await waitFor(() => feed.view().snapshot?.confirmedPositionsAvailable
    && Object.keys(feed.view().snapshot.confirmedPositions.values).length === 0);
  if (feedFailure) throw feedFailure;
  ws.terminate(); ws = undefined;
  await service.close(); service = undefined;
  // Restart both journals. A historical fill remains valid evidence but must not recreate a closed position.
  journalMatcher.close();
  journalMatcher = JournaledMatcher.open(matcherDir, matcherBinding);
  settlementJournal.close();
  settlementJournal = SettlementJournal.open(settlementDir, settlementIdentity, { confirmations: 2, reader });
  assert.equal(settlementJournal.intent(intent.intentId).status, 'unknown');
  assert.equal(settlementJournal.confirmedFills().length, 0);
  const restartedBridge = new SettlementOutcomeBridge(journalMatcher, settlementJournal, deploymentId);
  assert.equal((await restartedBridge.reconcileTrade(trade.id, intent.intentId, clock)).view.status, 'confirmed');
  assert.deepEqual(journalMatcher.snapshot().confirmedPositions.values, {});

  assert(gas.length >= 25 && gasCostWei > 0n);
  console.log(`Local Phase 4 backend E2E passed: funding publication, activation, signed admission, confirmed fill, signed cancellation, positions, expiry, owner close, withdrawals and restart; ${gas.length} receipts, ${gas.reduce((a, b) => a + b, 0n)} gas, ${gasCostWei} fixture AVAX wei. Fresh loopback Anvil with chain ID 43113; no public Fuji execution.`);
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  try { await service?.close(); } catch { /* ignore */ }
  try { journalMatcher?.close(); } catch { /* ignore */ }
  try { settlementJournal?.close(); } catch { /* ignore */ }
  child.kill('SIGTERM');
  await Promise.race([exited, delay(2000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
  if (matcherDir) rmSync(matcherDir, { recursive: true, force: true });
  if (settlementDir) rmSync(settlementDir, { recursive: true, force: true });
}
