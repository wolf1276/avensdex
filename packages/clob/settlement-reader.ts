import { decodeEventLog, keccak256, TransactionReceiptNotFoundError, toEventSelector, type Hex, type PublicClient } from 'viem';
import { MATCHED_FILL_EVENT, MATCHED_FILL_SIGNATURE, type ReceiptReader, type SettlementIdentity } from './settlement-journal.ts';
import { trader, type Positions } from './engine.ts';
type RpcBlock = Awaited<ReturnType<PublicClient['getBlock']>>;

const identityAbi = [{ type: 'function', name: 'deploymentId', stateMutability: 'view', inputs: [],
  outputs: [{ name: '', type: 'bytes32' }] }] as const;
const positionAbi = [
  { type: 'function', name: 'vault', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'nextPairId', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint64' }] },
  { type: 'function', name: 'pairs', stateMutability: 'view', inputs: [{ type: 'uint64' }], outputs: [
    { type: 'uint128' }, { type: 'uint128' }, { type: 'int128' }, { type: 'int128' }, { type: 'bytes32' }, { type: 'bytes32' },
  ] },
] as const;
const vaultAbi = [...identityAbi,
  { type: 'function', name: 'settlementModule', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'usedPairIds', stateMutability: 'view', inputs: [{ type: 'uint64' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'pairMargins', stateMutability: 'view', inputs: [{ type: 'uint64' }], outputs: [{ type: 'tuple', components: [
    { name: 'longOwner', type: 'address' }, { name: 'shortOwner', type: 'address' },
    { name: 'longMargin6', type: 'uint128' }, { name: 'shortMargin6', type: 'uint128' },
  ] }] },
] as const;
const eventTopic = toEventSelector(MATCHED_FILL_SIGNATURE);
const hash = (value: unknown): Hex => {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value) || /^0x0+$/.test(value)) throw Error('INVALID_RPC_HASH');
  return value.toLowerCase() as Hex;
};
const number = (value: unknown): string => {
  if (typeof value === 'bigint') {
    if (value < 0n || value > (1n << 64n) - 1n) throw Error('INVALID_RPC_BLOCK_NUMBER');
    return value.toString();
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) throw Error('INVALID_RPC_BLOCK_NUMBER');
    return String(value);
  }
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) return value;
  throw Error('INVALID_RPC_BLOCK_NUMBER');
};

/** Read-only RPC adapter. Deployment verification cannot enable admission, signing or submission. */
export async function createSettlementReader(receiptClient: PublicClient, canonicalClient: PublicClient,
  input: SettlementIdentity): Promise<ReceiptReader> {
  const identity = Object.freeze(structuredClone(input));
  if (Object.keys(identity).sort().join(',') !== 'chainId,deploymentId,settlementContract'
    || ![31337, 43113].includes(identity.chainId)
    || !/^0x[0-9a-f]{40}$/.test(identity.settlementContract) || /^0x0+$/.test(identity.settlementContract)) {
    throw Error('INVALID_READER_IDENTITY');
  }
  const deploymentId = hash(identity.deploymentId);
  const address = identity.settlementContract as Hex;
  let pinnedCode: Hex | undefined;
  async function verify(client: PublicClient) {
    if (await client.getChainId() !== identity.chainId) throw Error('SETTLEMENT_RPC_CHAIN_MISMATCH');
    const code = await client.getCode({ address });
    if (!code || code === '0x') throw Error('SETTLEMENT_RPC_CODE_MISSING');
    const codeHash = keccak256(code);
    if (pinnedCode !== undefined && pinnedCode !== codeHash) throw Error('SETTLEMENT_RPC_CODE_CHANGED');
    pinnedCode = codeHash;
    if (hash(await client.readContract({ address, abi: identityAbi, functionName: 'deploymentId' })) !== deploymentId) {
      throw Error('SETTLEMENT_RPC_DEPLOYMENT_MISMATCH');
    }
  }
  await verify(receiptClient);
  await verify(canonicalClient);
  return Object.freeze({
    async getReceipt(transactionHash: string) {
      await verify(receiptClient);
      const txHash = hash(transactionHash);
      let receipt;
      try { receipt = await receiptClient.getTransactionReceipt({ hash: txHash }); }
      catch (error) { if (error instanceof TransactionReceiptNotFoundError) return null; throw error; }
      if (hash(receipt.transactionHash) !== txHash) throw Error('SETTLEMENT_RPC_RECEIPT_MISMATCH');
      const blockHash = hash(receipt.blockHash), blockNumber = number(receipt.blockNumber);
      if (!['success', 'reverted'].includes(receipt.status) || receipt.to?.toLowerCase() !== address) {
        throw Error('SETTLEMENT_RPC_RECEIPT_TARGET');
      }
      const transaction = await receiptClient.getTransaction({ hash: txHash });
      const sender = receipt.from.toLowerCase();
      if (hash(transaction.hash) !== txHash || transaction.from.toLowerCase() !== sender
        || transaction.to?.toLowerCase() !== address || !Number.isSafeInteger(transaction.nonce)
        || transaction.nonce < 0) throw Error('SETTLEMENT_RPC_TRANSACTION_IDENTITY');
      const nonce = String(transaction.nonce);
      const logs = [];
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== address || log.topics[0]?.toLowerCase() !== eventTopic) continue;
        if (log.removed || log.logIndex === null || !Number.isSafeInteger(log.logIndex) || log.logIndex < 0
          || hash(log.transactionHash) !== txHash || hash(log.blockHash) !== blockHash
          || number(log.blockNumber) !== blockNumber) throw Error('SETTLEMENT_RPC_LOG_IDENTITY');
        const decoded = decodeEventLog({ abi: [MATCHED_FILL_EVENT], topics: log.topics, data: log.data, strict: true });
        logs.push({ contract: address, pairId: decoded.args.pairId.toString(),
          longOrderHash: hash(decoded.args.longOrderHash), shortOrderHash: hash(decoded.args.shortOrderHash),
          size6: decoded.args.size6.toString(), price18: decoded.args.price18.toString(), txHash,
          blockNumber, blockHash, logIndex: log.logIndex });
      }
      return { txHash, status: receipt.status, blockNumber, blockHash, sender, nonce, logs };
    },
    async getCanonicalHead() {
      await verify(canonicalClient);
      const block = await canonicalClient.getBlock({ blockTag: 'latest' });
      return { number: number(block.number), hash: hash(block.hash) };
    },
    async getCanonicalBlockHash(blockNumber: string) {
      if (typeof blockNumber !== 'string' || blockNumber.length > 20 || !/^(0|[1-9][0-9]*)$/.test(blockNumber)
        || BigInt(blockNumber) > (1n << 64n) - 1n) throw Error('INVALID_READER_BLOCK');
      await verify(canonicalClient);
      const block = await canonicalClient.getBlock({ blockNumber: BigInt(blockNumber) });
      if (number(block.number) !== blockNumber) throw Error('SETTLEMENT_RPC_BLOCK_MISMATCH');
      return hash(block.hash);
    },
  });
}


async function verifiedPositionVault(receiptClient: PublicClient, identity: SettlementIdentity, blockNumber: bigint) {
  const address = identity.settlementContract as Hex;
  const vault = await receiptClient.readContract({ address, abi: positionAbi, functionName: 'vault', blockNumber });
  if (typeof vault !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(vault) || /^0x0+$/.test(vault) || vault.toLowerCase() === address) throw Error('POSITION_VAULT_IDENTITY');
  const id = await receiptClient.readContract({ address: vault as Hex, abi: vaultAbi, functionName: 'deploymentId', blockNumber });
  const module = await receiptClient.readContract({ address: vault as Hex, abi: vaultAbi, functionName: 'settlementModule', blockNumber });
  if (hash(id) !== hash(identity.deploymentId) || typeof module !== 'string' || module.toLowerCase() !== address) throw Error('POSITION_VAULT_IDENTITY');
  return vault;
}

/** Current position state is read from both canonical modules at one pinned block, never from matcher fills. */
async function readPinnedCanonicalPosition(receiptClient: PublicClient, identity: SettlementIdentity,
  pairId: string, blockNumber: bigint, blockHash: string) {
  const address = identity.settlementContract as Hex;
  const vault = await verifiedPositionVault(receiptClient, identity, blockNumber);
  const args = [BigInt(pairId)] as const;
  if (await receiptClient.readContract({ address: vault as Hex, abi: vaultAbi, functionName: 'usedPairIds', args, blockNumber }) !== true) {
    throw Error('UNKNOWN_CANONICAL_POSITION');
  }
  const [size6, entryPrice18, lastFundingIndex18, fundingRemainder, longHash, shortHash] =
    await receiptClient.readContract({ address, abi: positionAbi, functionName: 'pairs', args, blockNumber }) as readonly [bigint, bigint, bigint, bigint, Hex, Hex];
  const margins = await receiptClient.readContract({ address: vault as Hex, abi: vaultAbi, functionName: 'pairMargins', args, blockNumber }) as {
    longOwner: string; shortOwner: string; longMargin6: bigint; shortMargin6: bigint;
  };
  if (typeof size6 !== 'bigint' || size6 < 0n || size6 > 10n ** 15n
    || typeof entryPrice18 !== 'bigint' || typeof lastFundingIndex18 !== 'bigint' || typeof fundingRemainder !== 'bigint'
    || typeof margins.longOwner !== 'string' || typeof margins.shortOwner !== 'string'
    || !/^0x[0-9a-fA-F]{40}$/.test(margins.longOwner) || !/^0x[0-9a-fA-F]{40}$/.test(margins.shortOwner)
    || typeof margins.longMargin6 !== 'bigint' || typeof margins.shortMargin6 !== 'bigint'
    || margins.longMargin6 < 0n || margins.shortMargin6 < 0n
    || margins.longMargin6 >= (1n << 128n) || margins.shortMargin6 >= (1n << 128n)) throw Error('POSITION_LEDGER_MISMATCH');
  const closed = size6 === 0n, zeroOwner = '0x' + '0'.repeat(40);
  if (!closed) { hash(longHash); hash(shortHash); }
  if (closed) {
    if (margins.longOwner.toLowerCase() !== zeroOwner || margins.shortOwner.toLowerCase() !== zeroOwner
      || margins.longMargin6 !== 0n || margins.shortMargin6 !== 0n) throw Error('POSITION_LEDGER_MISMATCH');
  } else if (size6 > 10n ** 15n || entryPrice18 <= 0n || entryPrice18 > 10n ** 27n
    || margins.longOwner.toLowerCase() === zeroOwner || margins.shortOwner.toLowerCase() === zeroOwner
    || margins.longOwner.toLowerCase() === margins.shortOwner.toLowerCase()
    || margins.longMargin6 + margins.shortMargin6 <= 0n) throw Error('POSITION_LEDGER_MISMATCH');
  return Object.freeze({ ...identity, pairId, blockNumber: blockNumber.toString(), blockHash: blockHash.toLowerCase(),
    closed, size6: size6.toString(), entryPrice18: entryPrice18.toString(), lastFundingIndex18: lastFundingIndex18.toString(),
    fundingRemainder: fundingRemainder.toString(), longOrderHash: (longHash as string).toLowerCase(),
    shortOrderHash: (shortHash as string).toLowerCase(), longOwner: margins.longOwner.toLowerCase(),
    shortOwner: margins.shortOwner.toLowerCase(), longMargin6: margins.longMargin6.toString(),
    shortMargin6: margins.shortMargin6.toString() });
}

export async function readCanonicalPosition(receiptClient: PublicClient, canonicalClient: PublicClient,
  input: SettlementIdentity, pairId: string) {
  if (typeof pairId !== 'string' || pairId.length > 20 || !/^[1-9][0-9]*$/.test(pairId)
    || BigInt(pairId) > (1n << 64n) - 1n) throw Error('INVALID_POSITION_ID');
  const identity = Object.freeze(structuredClone(input));
  const reader = await createSettlementReader(receiptClient, canonicalClient, identity);
  const head = await reader.getCanonicalHead() as { number: string; hash: string };
  const blockNumber = BigInt(head.number);
  async function coherentBlock() {
    const receiptBlock = await receiptClient.getBlock({ blockNumber });
    if (number(receiptBlock.number) !== head.number || hash(receiptBlock.hash) !== head.hash
      || await reader.getCanonicalBlockHash(head.number) !== head.hash) throw Error('POSITION_BLOCK_REORGED');
  }
  await coherentBlock();
  const result = await readPinnedCanonicalPosition(receiptClient, identity, pairId, blockNumber, head.hash);
  await coherentBlock();
  return result;
}

function checkedPositionOptions(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('INVALID_POSITION_OPTIONS');
  const keys = Object.keys(input);
  if (keys.length !== 3 || !keys.includes('confirmations') || !keys.includes('now') || !keys.includes('maxPairs')) {
    throw Error('INVALID_POSITION_OPTIONS');
  }
  const value = input as Record<string, unknown>;
  if (!Number.isSafeInteger(value.confirmations) || (value.confirmations as number) < 1 || (value.confirmations as number) > 1000) {
    throw Error('INVALID_POSITION_CONFIRMATIONS INVALID_INTEGER');
  }
  if (!Number.isSafeInteger(value.maxPairs) || (value.maxPairs as number) < 1 || (value.maxPairs as number) > 256) {
    throw Error('INVALID_POSITION_MAX_PAIRS INVALID_INTEGER');
  }
  if (!Number.isSafeInteger(value.now) || (value.now as number) < 0 || (value.now as number) > 4_294_967_295) {
    throw Error('INVALID_POSITION_TIME INVALID_TIME');
  }
  return { confirmations: value.confirmations as number, now: value.now as number, maxPairs: value.maxPairs as number };
}

function toSafeUint32(value: unknown, label: string) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0 || value > 4_294_967_295) throw Error(label);
    return value;
  }
  if (typeof value === 'bigint') {
    if (value < 0n || value > (1n << 32n) - 1n) throw Error(label);
    return Number(value);
  }
  throw Error(label);
}

export async function readPolicyConfirmedPositions(receiptClient: PublicClient, canonicalClient: PublicClient,
  input: SettlementIdentity, options: unknown): Promise<Positions> {
  const identity = Object.freeze(structuredClone(input));
  const opts = checkedPositionOptions(options);
  const reader = await createSettlementReader(receiptClient, canonicalClient, identity);
  const head = await reader.getCanonicalHead() as { number: string; hash: string };
  if (typeof head.number !== 'string' || !/^(0|[1-9][0-9]*)$/.test(head.number)) throw Error('INVALID_POSITION_HEAD');
  const primaryHead = await receiptClient.getBlock({ blockTag: 'latest' });
  const primaryNumber = BigInt(number(primaryHead.number));
  if (primaryNumber === BigInt(head.number) && hash(primaryHead.hash) !== head.hash) throw Error('POSITION_HEAD_DISAGREEMENT');
  const headNumber = primaryNumber < BigInt(head.number) ? primaryNumber : BigInt(head.number);
  const selectedNumber = headNumber - BigInt(opts.confirmations) + 1n;
  if (selectedNumber < 0n || selectedNumber > (1n << 64n) - 1n) throw Error('POSITION_CONFIRMATION_DEPTH_ROLLBACK DEPTH_ROLLBACK');
  const selectedNumberString = selectedNumber.toString();
  // Selected block must agree across paired providers.
  let selectedBlockReceipt: RpcBlock;
  let selectedBlockCanonical: RpcBlock;
  try {
    selectedBlockReceipt = await receiptClient.getBlock({ blockNumber: selectedNumber });
    selectedBlockCanonical = await canonicalClient.getBlock({ blockNumber: selectedNumber });
  } catch {
    throw Error('POSITION_BLOCK_REORGED PROVIDER_BLOCK_DISAGREEMENT');
  }
  let receiptNumber: string, canonicalNumber: string;
  let receiptHash: string, canonicalHash: string;
  let receiptTime: number, canonicalTime: number;
  try {
    receiptNumber = number(selectedBlockReceipt.number);
    canonicalNumber = number(selectedBlockCanonical.number);
    receiptHash = hash(selectedBlockReceipt.hash);
    canonicalHash = hash(selectedBlockCanonical.hash);
    receiptTime = toSafeUint32(selectedBlockReceipt.timestamp, 'INVALID_POSITION_TIME INVALID_TIME');
    canonicalTime = toSafeUint32(selectedBlockCanonical.timestamp, 'INVALID_POSITION_TIME INVALID_TIME');
  } catch {
    throw Error('POSITION_BLOCK_REORGED PROVIDER_BLOCK_DISAGREEMENT');
  }
  if (receiptNumber !== selectedNumberString || canonicalNumber !== selectedNumberString) {
    throw Error('POSITION_BLOCK_REORGED PROVIDER_BLOCK_DISAGREEMENT');
  }
  if (receiptHash !== canonicalHash) {
    throw Error('POSITION_BLOCK_REORGED PROVIDER_BLOCK_DISAGREEMENT');
  }
  if (receiptTime !== canonicalTime) {
    throw Error('POSITION_BLOCK_REORGED PROVIDER_BLOCK_DISAGREEMENT');
  }
  const sourceTime = receiptTime;
  if (sourceTime > opts.now || opts.now - sourceTime > 60) {
    if (sourceTime > opts.now) throw Error('POSITION_SOURCE_FUTURE FUTURE_SOURCE');
    throw Error('POSITION_SOURCE_STALE STALE_SOURCE');
  }
  // Even an empty enumeration must prove canonical vault/module identity.
  await verifiedPositionVault(receiptClient, identity, selectedNumber);
  // Read nextPairId at selected block.
  const address = identity.settlementContract as Hex;
  let nextPairId: bigint;
  try {
    nextPairId = await receiptClient.readContract({ address, abi: positionAbi, functionName: 'nextPairId', blockNumber: selectedNumber });
    await verifiedPositionVault(canonicalClient, identity, selectedNumber);
    const secondaryNext = await canonicalClient.readContract({ address, abi: positionAbi, functionName: 'nextPairId', blockNumber: selectedNumber });
    if (nextPairId !== secondaryNext) throw Error('POSITION_PROVIDER_DISAGREEMENT');
  } catch {
    throw Error('POSITION_BLOCK_REORGED PROVIDER_BLOCK_DISAGREEMENT');
  }
  if (typeof nextPairId !== 'bigint' || nextPairId < 1n || nextPairId > BigInt(opts.maxPairs) + 1n) {
    throw Error('POSITION_PAIR_ENUMERATION_BOUNDS');
  }
  const pairCount = Number(nextPairId - 1n);
  if (!Number.isSafeInteger(pairCount) || pairCount > opts.maxPairs) {
    throw Error('POSITION_PAIR_ENUMERATION_BOUNDS MAX_PAIRS_EXCEEDED');
  }
  // shortcut: enumerate at most 256 historical pairs; add a verified complete index before supporting larger histories.
  const values: Record<string, bigint> = {};

  for (let i = 1; i <= pairCount; i++) {
    const pairId = String(i);
    const position = await readPinnedCanonicalPosition(receiptClient, identity, pairId, selectedNumber, receiptHash);
    const secondary = await readPinnedCanonicalPosition(canonicalClient, identity, pairId, selectedNumber, receiptHash);
    if (JSON.stringify(position) !== JSON.stringify(secondary)) throw Error('POSITION_PROVIDER_DISAGREEMENT');
    if (position.closed) continue;
    const size = BigInt(position.size6);
    const longOwner = position.longOwner;
    const shortOwner = position.shortOwner;
    values[longOwner] = (values[longOwner] ?? 0n) + size;
    values[shortOwner] = (values[shortOwner] ?? 0n) - size;
    trader(longOwner); trader(shortOwner);
  }
  // Validate aggregates.
  const finalValues: Record<string, string> = {};
  for (const [owner, net] of Object.entries(values)) {
    const abs = net < 0n ? -net : net;
    if (abs > 10n ** 15n) throw Error('POSITION_AGGREGATE_BOUNDS');
    if (net !== 0n) finalValues[owner] = net.toString();
  }
  if (Object.keys(finalValues).length > 1000) throw Error('POSITION_TRADER_LIMIT');
  // End rechecks.
  let endReceiptBlock: RpcBlock;
  let endCanonicalBlock: RpcBlock;
  let endHead: { number: string; hash: string };
  let endPrimaryHead: RpcBlock;
  try {
    endReceiptBlock = await receiptClient.getBlock({ blockNumber: selectedNumber });
    endCanonicalBlock = await canonicalClient.getBlock({ blockNumber: selectedNumber });
    endHead = await reader.getCanonicalHead() as { number: string; hash: string };
    endPrimaryHead = await receiptClient.getBlock({ blockTag: 'latest' });
  } catch {
    throw Error('POSITION_BLOCK_REORGED PROVIDER_BLOCK_DISAGREEMENT');
  }
  let endReceiptHash: string, endCanonicalHash: string;
  let endHeadNumber: bigint;
  try {
    endReceiptHash = hash(endReceiptBlock.hash);
    endCanonicalHash = hash(endCanonicalBlock.hash);
    const secondaryNumber = BigInt(endHead.number), primaryNumber = BigInt(number(endPrimaryHead.number));
    endHeadNumber = primaryNumber < secondaryNumber ? primaryNumber : secondaryNumber;
    if (primaryNumber === secondaryNumber && hash(endPrimaryHead.hash) !== endHead.hash) throw Error('POSITION_HEAD_DISAGREEMENT');
    if (number(endReceiptBlock.number) !== selectedNumberString || number(endCanonicalBlock.number) !== selectedNumberString
      || toSafeUint32(endReceiptBlock.timestamp, 'INVALID_POSITION_TIME') !== sourceTime
      || toSafeUint32(endCanonicalBlock.timestamp, 'INVALID_POSITION_TIME') !== sourceTime) throw Error('POSITION_BLOCK_REORGED');
  } catch {
    throw Error('POSITION_BLOCK_REORGED PROVIDER_BLOCK_DISAGREEMENT');
  }
  if (endReceiptHash !== receiptHash || endCanonicalHash !== canonicalHash || endReceiptHash !== endCanonicalHash) {
    throw Error('POSITION_BLOCK_REORGED PROVIDER_BLOCK_DISAGREEMENT');
  }
  if (await receiptClient.getChainId() !== identity.chainId) throw Error('SETTLEMENT_RPC_CHAIN_MISMATCH');
  const endDepth = endHeadNumber - selectedNumber + 1n;
  if (endDepth < BigInt(opts.confirmations)) {
    throw Error('POSITION_CONFIRMATION_DEPTH_ROLLBACK DEPTH_ROLLBACK');
  }
  return Object.freeze({
    blockNumber: selectedNumberString,
    blockHash: receiptHash,
    sourceTime,
    values: Object.freeze(finalValues),
  }) as { blockNumber: string; blockHash: string; sourceTime: number; values: Record<string, string> };
}
