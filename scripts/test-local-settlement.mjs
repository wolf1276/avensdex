// Fresh local Anvil integration only. No configurable public RPC, wallet, funded-state reset or deployment path.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { createPublicClient, createWalletClient, hashTypedData, http, keccak256, stringToHex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { ORDER_TYPES } from '../packages/clob/admission.ts';
import { Matcher } from '../packages/clob/engine.ts';
import { SettlementJournal } from '../packages/clob/settlement-journal.ts';
import { createSettlementReader, readCanonicalPosition } from '../packages/clob/settlement-reader.ts';
import { fixtureGasLimit } from './local-fixture-gas.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
execFileSync('forge', ['build', '--root', join(root, 'contracts/evm')], { cwd: root, stdio: 'pipe', timeout: 60_000 });
function artifact(file, name) {
  const a = JSON.parse(readFileSync(join(root, 'contracts/evm/out', file, `${name}.json`), 'utf8'));
  return { abi: a.abi, bytecode: a.bytecode.object };
}
const tokenArtifact = artifact('AvensVault.t.sol', 'MockVaultToken');
const vaultArtifact = artifact('AvensVault.sol', 'AvensVault');
const oracleArtifact = artifact('AvensOracle.sol', 'AvensOracle');
const settlementArtifact = artifact('AvensSettlement.sol', 'AvensSettlement');
const server = createServer();
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const { port } = server.address();
await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
const child = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337', '--timestamp', '1800000100', '--hardfork', 'paris', '--accounts', '0', '--silent'],
  { stdio: 'ignore' });
let startupError;
child.on('error', error => { startupError = error; });
const exited = new Promise(resolve => child.once('exit', resolve));
const directory = mkdtempSync(join(tmpdir(), 'avensdex-local-settlement-'));
let journal;
try {
  const transport = http(`http://127.0.0.1:${port}`, { retryCount: 0, timeout: 3000 });
  const client = createPublicClient({ chain: foundry, transport, cacheTime: 0 });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (startupError) throw startupError;
    if (child.exitCode !== null) throw Error('fresh local Anvil exited during startup');
    try { assert.equal(await client.getChainId(), 31337); ready = true; break; }
    catch { await delay(50); }
  }
  assert(ready && child.exitCode === null, 'fresh local Anvil did not start');
  assert.equal(await client.getBlockNumber({ cacheTime: 0 }), 0n, 'refuse an existing funded node');
  await client.request({ method: 'anvil_setBlockTimestampInterval', params: [0] });
  // Ephemeral generated keys and fixture gas exist only inside this new loopback test node.
  const wallets = Array.from({ length: 5 }, () => createWalletClient({ account: privateKeyToAccount(generatePrivateKey()), chain: foundry, transport }));
  const [deployer, alice, bob, pricePublisher, fundingPublisher] = wallets;
  for (const wallet of wallets) await client.request({ method: 'anvil_setBalance', params: [wallet.account.address, '0x3635c9adc5dea00000'] });
  const gas = [];
  let expectedGasReverts = 0;
  async function receipt(hash) {
    const r = await client.waitForTransactionReceipt({ hash, pollingInterval: 10, timeout: 10_000 });
    assert.equal(r.status, 'success'); gas.push(r.gasUsed); return r;
  }
  async function deploy(a, args) {
    const r = await receipt(await deployer.deployContract({ ...a, args }));
    assert(r.contractAddress); return r.contractAddress.toLowerCase();
  }
  async function write(wallet, address, a, functionName, args) {
    const request = { account: wallet.account, address, abi: a.abi, functionName, args };
    let estimate = await client.estimateContractGas({ ...request, blockTag: 'latest' });
    const regression = functionName === 'closePair' && args[1] === 400_000n;
    if (regression) {
      // Reproduce CI: funding advances after estimation, making the mined close more expensive.
      const block = await client.getBlock();
      await client.request({ method: 'evm_setNextBlockTimestamp', params: [Number(block.timestamp) + 1] });
      const before = await client.readContract({ address, abi: a.abi, functionName: 'pairs', args: [args[0]] });
      const hash = await wallet.writeContract({ ...request, gas: estimate });
      const reverted = await client.waitForTransactionReceipt({ hash, pollingInterval: 10, timeout: 10_000 });
      assert.equal(reverted.status, 'reverted', 'stale estimate must reproduce the CI failure');
      assert.deepEqual(await client.readContract({ address, abi: a.abi, functionName: 'pairs', args: [args[0]] }), before,
        'known reverted transaction must not partially close the position');
      gas.push(reverted.gasUsed); expectedGasReverts++;
      // Only this deliberate, canonically observed local revert is followed by the funded-gas test.
      estimate = await client.estimateContractGas(request);
    }
    return receipt(await wallet.writeContract({ ...request, gas: fixtureGasLimit(estimate) }));
  }
  const read = (address, a, functionName, args = []) => client.readContract({ address, abi: a.abi, functionName, args });
  const deploymentId = keccak256(stringToHex('avensdex-local-phase3-integration'));
  const token = await deploy(tokenArtifact, [6]);
  const vault = await deploy(vaultArtifact, [token, deploymentId, 1_000_000_000_000n]);
  const oracle = await deploy(oracleArtifact, [1, pricePublisher.account.address, fundingPublisher.account.address, 60n]);
  const settlement = await deploy(settlementArtifact, [vault, oracle, 1, 60n]);
  const runtime = await client.getCode({ address: settlement });
  assert((runtime.length - 2) / 2 <= 24_576, 'EIP-170 runtime limit');
  await write(deployer, vault, vaultArtifact, 'bindSettlement', [settlement]);
  await write(deployer, vault, vaultArtifact, 'activateDeposits', []);
  for (const wallet of [alice, bob]) {
    await write(deployer, token, tokenArtifact, 'mint', [wallet.account.address, 10_000_000_000n]);
    await write(wallet, token, tokenArtifact, 'approve', [vault, 10_000_000_000n]);
    await write(wallet, vault, vaultArtifact, 'deposit', [10_000_000_000n]);
  }
  const now = () => client.getBlock().then(block => block.timestamp);
  await write(pricePublisher, oracle, oracleArtifact, 'publishPrice', [1000n * 10n ** 18n, await now()]);
  await write(fundingPublisher, oracle, oracleArtifact, 'setFundingRate', [10n ** 12n, (await now()) + 3600n]);
  const domain = { name: 'Avensdex', version: '1', chainId: 31337, verifyingContract: settlement };
  const expiry = (await now()) + 3600n;
  const order = (wallet, side) => ({ trader: wallet.account.address, marketId: 1, side, kind: 0, size6: 2_000_000n,
    limitPrice18: 1000n * 10n ** 18n, leverage: 10, maxFeeBps: 3, nonce: 1n, expiry,
    reduceOnly: false, postOnly: false, ioc: false });
  const long = order(alice, 0), short = { ...order(bob, 1), size6: 1_000_000n };
  const typed = message => ({ domain, types: ORDER_TYPES, primaryType: 'Order', message });
  const longSignature = await alice.signTypedData(typed(long)), shortSignature = await bob.signTypedData(typed(short));
  const longHash = hashTypedData(typed(long)), shortHash = hashTypedData(typed(short));
  assert.equal(await read(settlement, settlementArtifact, 'orderHash', [long]), longHash);
  assert.equal(await read(settlement, settlementArtifact, 'orderHash', [short]), shortHash);
  // The pure matcher is chain-agnostic; this is a local fixture, not the Fuji-only network admission path.
  const matcher = new Matcher('phase3-local-signature-fixture', 1);
  const coreOrder = (o, hash) => ({ id: hash, trader: o.trader.toLowerCase(), nonce: o.nonce.toString(), marketId: 1,
    side: o.side === 0 ? 'buy' : 'sell', kind: 'limit', size6: o.size6.toString(), limitPrice18: o.limitPrice18.toString(),
    expiry: Number(o.expiry), reduceOnly: false, postOnly: false, ioc: false });
  const at = Number(await now());
  matcher.apply({ type: 'submit', at, order: coreOrder(long, longHash) });
  matcher.apply({ type: 'submit', at, order: coreOrder(short, shortHash) });
  const [matched] = matcher.snapshot().trades;
  assert.equal(matched.maker, longHash); assert.equal(matched.taker, shortHash);
  assert.equal(matched.size6, '1000000'); assert.equal(matched.price18, long.limitPrice18.toString());
  await write(alice, settlement, settlementArtifact, 'reserveOrder', [long, longSignature, 100_000_000n]);
  await write(bob, settlement, settlementArtifact, 'reserveOrder', [short, shortSignature, 100_000_000n]);
  const identity = { chainId: 31337, deploymentId, settlementContract: settlement };
  const reader = await createSettlementReader(client, client, identity);
  journal = SettlementJournal.open(directory, identity, { confirmations: 2, reader, create: true });
  const nonce = await client.getTransactionCount({ address: deployer.account.address });
  const pairId = await read(settlement, settlementArtifact, 'nextPairId');
  const intent = journal.recordIntent({ pairId: pairId.toString(), longOrderHash: longHash, shortOrderHash: shortHash,
    size6: matched.size6, price18: matched.price18, sender: deployer.account.address.toLowerCase(), nonce: String(nonce) });
  assert.equal(journal.intent(intent.intentId).status, 'intent');
  const txHash = await deployer.writeContract({ address: settlement, abi: settlementArtifact.abi, functionName: 'matchOrders',
    args: [long, longSignature, short, shortSignature, BigInt(matched.size6), BigInt(matched.price18)], nonce });
  journal.recordBroadcast(intent.intentId, { txHash, sender: deployer.account.address.toLowerCase(), nonce: String(nonce) });
  const fillReceipt = await receipt(txHash);
  assert.equal((await journal.reconcile(intent.intentId)).status, 'pending');
  assert.equal(journal.confirmedFills().length, 0);
  await client.request({ method: 'evm_mine', params: [] });
  assert.equal((await journal.reconcile(intent.intentId)).status, 'confirmed');
  assert.equal(journal.confirmedFills()[0].txHash, fillReceipt.transactionHash);
  assert.equal(matcher.snapshot().settlement, 'unavailable'); // Public feed activation/wiring is a later gate.
  journal.close();
  journal = SettlementJournal.open(directory, identity, { confirmations: 2, reader });
  assert.equal(journal.intent(intent.intentId).status, 'unknown');
  assert.equal(journal.confirmedFills().length, 0);
  assert.equal((await journal.reconcile(intent.intentId)).status, 'confirmed');
  assert.equal(await read(settlement, settlementArtifact, 'filledSize6', [longHash]), 1_000_000n);
  assert.equal((await read(settlement, settlementArtifact, 'pairs', [pairId]))[0], 1_000_000n);
  const openedPosition = await readCanonicalPosition(client, client, identity, pairId.toString());
  assert.equal(openedPosition.closed, false);
  assert.equal(openedPosition.size6, '1000000');
  assert.equal(openedPosition.longOwner, alice.account.address.toLowerCase());
  await write(alice, settlement, settlementArtifact, 'cancelOrder', [longHash, 1n]);
  await write(bob, settlement, settlementArtifact, 'cancelOrder', [shortHash, 1n]);
  await client.request({ method: 'evm_setNextBlockTimestamp', params: [Number(await now()) + 10] });
  await client.request({ method: 'evm_mine', params: [] });
  await write(deployer, settlement, settlementArtifact, 'settleFunding', [pairId]);
  const funded = await read(vault, vaultArtifact, 'pairMargins', [pairId]);
  assert(funded.longMargin6 < 100_000_000n && funded.shortMargin6 > 100_000_000n);
  assert.equal(funded.longMargin6 + funded.shortMargin6, 200_000_000n);
  await write(alice, settlement, settlementArtifact, 'closePair', [pairId, 400_000n]);
  const remaining = await read(vault, vaultArtifact, 'pairMargins', [pairId]);
  assert(remaining.longMargin6 < 60_000_000n && remaining.shortMargin6 > 60_000_000n, 'real positive funding moved pair collateral');
  assert.equal((await read(settlement, settlementArtifact, 'pairs', [pairId]))[0], 600_000n);
  assert.equal((await readCanonicalPosition(client, client, identity, pairId.toString())).size6, '600000');
  await write(bob, settlement, settlementArtifact, 'closePair', [pairId, 600_000n]);
  assert.equal((await read(settlement, settlementArtifact, 'pairs', [pairId]))[0], 0n);
  assert.equal((await readCanonicalPosition(client, client, identity, pairId.toString())).closed, true);
  assert.equal(await read(settlement, settlementArtifact, 'positionCount', [alice.account.address]), 0);
  assert.equal(await read(settlement, settlementArtifact, 'positionCount', [bob.account.address]), 0);
  for (const wallet of [alice, bob]) {
    const free = await read(vault, vaultArtifact, 'freeBalance', [wallet.account.address]);
    await write(wallet, vault, vaultArtifact, 'withdraw', [free]);
    assert.equal(await read(token, tokenArtifact, 'balanceOf', [wallet.account.address]), free);
  }
  const [custody, liabilities, surplus] = await read(vault, vaultArtifact, 'accounting');
  assert.equal(custody, 600_000n);
  assert.equal(liabilities, custody);
  assert.equal(surplus, 0n);
  assert.equal(await read(vault, vaultArtifact, 'feeBalance6'), custody);
  assert.equal(await read(vault, vaultArtifact, 'totalFree6'), 0n);
  assert.equal(await read(vault, vaultArtifact, 'totalEscrow6'), 0n);
  assert.equal(await read(vault, vaultArtifact, 'totalPairMargin6'), 0n);
  assert.equal(expectedGasReverts, 1);
  console.log(`Local Anvil Phase 3 lifecycle passed: signed partial fill, canonical receipt, restart, funding, partial/full close, owner withdrawals; ${gas.length} receipts checked, including one deliberate stale-estimate gas revert. No public execution.`);
} finally {
  journal?.close();
  child.kill('SIGTERM');
  await Promise.race([exited, delay(2000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
  rmSync(directory, { recursive: true, force: true });
}
