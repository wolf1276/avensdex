import { decodeEventLog, keccak256, TransactionReceiptNotFoundError, toEventSelector, type Hex, type PublicClient } from 'viem';
import { MATCHED_FILL_EVENT, MATCHED_FILL_SIGNATURE, type ReceiptReader, type SettlementIdentity } from './settlement-journal.ts';

const identityAbi = [{ type: 'function', name: 'deploymentId', stateMutability: 'view', inputs: [],
  outputs: [{ name: '', type: 'bytes32' }] }] as const;
const positionAbi = [
  { type: 'function', name: 'vault', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
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
  if (typeof value !== 'bigint' || value < 0n || value > (1n << 64n) - 1n) throw Error('INVALID_RPC_BLOCK_NUMBER');
  return value.toString();
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


/** Current position state is read from both canonical modules at one pinned block, never from matcher fills. */
export async function readCanonicalPosition(receiptClient: PublicClient, canonicalClient: PublicClient,
  input: SettlementIdentity, pairId: string) {
  if (typeof pairId !== 'string' || pairId.length > 20 || !/^[1-9][0-9]*$/.test(pairId)
    || BigInt(pairId) > (1n << 64n) - 1n) throw Error('INVALID_POSITION_ID');
  const identity = Object.freeze(structuredClone(input));
  const reader = await createSettlementReader(receiptClient, canonicalClient, identity);
  const head = await reader.getCanonicalHead() as { number: string; hash: string };
  const blockNumber = BigInt(head.number), address = identity.settlementContract as Hex;
  async function coherentBlock() {
    const receiptBlock = await receiptClient.getBlock({ blockNumber });
    if (number(receiptBlock.number) !== head.number || hash(receiptBlock.hash) !== head.hash
      || await reader.getCanonicalBlockHash(head.number) !== head.hash) throw Error('POSITION_BLOCK_REORGED');
  }
  await coherentBlock();
  const vault = await receiptClient.readContract({ address, abi: positionAbi, functionName: 'vault', blockNumber });
  if (/^0x0+$/.test(vault) || vault.toLowerCase() === address) throw Error('POSITION_VAULT_IDENTITY');
  const id = await receiptClient.readContract({ address: vault, abi: vaultAbi, functionName: 'deploymentId', blockNumber });
  const module = await receiptClient.readContract({ address: vault, abi: vaultAbi, functionName: 'settlementModule', blockNumber });
  if (hash(id) !== hash(identity.deploymentId) || module.toLowerCase() !== address) throw Error('POSITION_VAULT_IDENTITY');
  const args = [BigInt(pairId)] as const;
  if (!await receiptClient.readContract({ address: vault, abi: vaultAbi, functionName: 'usedPairIds', args, blockNumber })) {
    throw Error('UNKNOWN_CANONICAL_POSITION');
  }
  const [size6, entryPrice18, lastFundingIndex18, fundingRemainder, longHash, shortHash] =
    await receiptClient.readContract({ address, abi: positionAbi, functionName: 'pairs', args, blockNumber });
  const margins = await receiptClient.readContract({ address: vault, abi: vaultAbi, functionName: 'pairMargins', args, blockNumber });
  const closed = size6 === 0n, zeroOwner = '0x' + '0'.repeat(40);
  if (closed) {
    if (margins.longOwner !== zeroOwner || margins.shortOwner !== zeroOwner || margins.longMargin6 !== 0n
      || margins.shortMargin6 !== 0n) throw Error('POSITION_LEDGER_MISMATCH');
  } else if (size6 > 10n ** 15n || entryPrice18 <= 0n || entryPrice18 > 10n ** 27n
    || margins.longOwner === zeroOwner || margins.shortOwner === zeroOwner || margins.longOwner === margins.shortOwner
    || margins.longMargin6 + margins.shortMargin6 <= 0n) throw Error('POSITION_LEDGER_MISMATCH');
  await coherentBlock();
  return Object.freeze({ ...identity, pairId, blockNumber: head.number, blockHash: head.hash, closed,
    size6: size6.toString(), entryPrice18: entryPrice18.toString(), lastFundingIndex18: lastFundingIndex18.toString(),
    fundingRemainder: fundingRemainder.toString(), longOrderHash: longHash.toLowerCase(), shortOrderHash: shortHash.toLowerCase(),
    longOwner: margins.longOwner.toLowerCase(), shortOwner: margins.shortOwner.toLowerCase(),
    longMargin6: margins.longMargin6.toString(), shortMargin6: margins.shortMargin6.toString() });
}
